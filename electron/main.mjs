import electron from "electron";
import { GoogleGenAI } from "@google/genai";
import {
  proposeHermesTask as gatePropose,
  claimConfirmedProposal,
  markModelTurnComplete,
  markUserSpoke,
  resetHermesGate,
  hasPendingProposal,
} from "./hermesGate.mjs";
import {
  readVaultRecords,
  buildLexicon,
  loadIndexFromDisk,
  syncBrainIndex,
  embedQuery,
  hybridSearch,
  lexicalFilter,
  indexDirFor,
  COSINE_CONFIDENT,
  COVERAGE_CONFIDENT,
} from "./brainIndex.mjs";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const { app, BrowserWindow, ipcMain, session, nativeImage, Menu, Tray, screen, globalShortcut, shell, powerMonitor } = electron;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Name the app "Iris" (menu bar / about panel). The Dock tile fully reflects this
// only in a packaged build; in dev the generic Electron bundle name is used.
app.setName("Iris");

const iconPath = path.join(repoRoot, "build", "icon.png");
const appIcon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : null;

function parseEnvFile(envPath) {
  if (!envPath || !fs.existsSync(envPath)) return;
  const contents = fs.readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (!key || process.env[key]) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

// Look for .env in several places so both the dev repo run and a packaged
// Iris.app can find credentials. First match for a given key wins.
function loadEnvFile() {
  const candidates = [
    path.join(repoRoot, ".env"),
    path.join(os.homedir(), ".iris", ".env"),
    process.resourcesPath ? path.join(process.resourcesPath, ".env") : null,
  ];
  for (const candidate of candidates) parseEnvFile(candidate);
}

loadEnvFile();

let mainWindow = null;
let liveSession = null;
let ai = null;
let liveStatus = { running: false, pid: null };
let userTranscriptBuffer = "";
let modelTranscriptBuffer = "";
const hermesRuns = new Map();
const pendingHermesAnnouncements = [];
let welcomeGreeted = false;
let welcomeFallbackTimer = null;

// ===== Auto-sleep / auto-wake / session resumption state =====
// The Live API bills the whole accumulated context on every turn, and an open
// mic streams 25 tokens/sec even in silence — so an idle-but-connected session
// bleeds money. Iris closes the session after a quiet spell and resumes it
// (with full context, via the resumption handle) when you speak or when a
// Hermes task completes.
let lastVoiceActivityAt = Date.now();
let autoSleepTimer = null;
let autoSlept = false; // last sleep was the idle timer, not the user
let resumeHandle = null; // latest Live API session resumption token
let resumeHandleAt = 0; // handles are valid ~2h after disconnect
let intentionalClose = false; // distinguishes stopLive() from server drops
let reconnectAttempts = 0;
let connectInFlight = false; // dedupe racing startLive() calls (wake + safety net)
let closedDuringConnect = false; // server hung up while connect() was resolving
let sessionConnectedAt = 0; // when the current connection opened
let sessionUsedHandle = false; // current connection tried to resume
let announcementsInFlight = []; // Hermes results sent but possibly not yet spoken
// Google expires resumption handles 2h (120 min) after disconnect — far too
// short for all-day standby. While napping, a silent micro-reconnect rotates
// the handle when it turns 110 minutes old (no audio, no turns, ~zero cost,
// never wakes the UI), so the conversation survives naps of any length.
// TTL sits between the two: refresh fires at 110, anything older than 118 is
// treated as dead, 120 is Google's hard cutoff.
const RESUME_HANDLE_TTL_MS = 118 * 60 * 1000;
const HANDLE_REFRESH_AGE_MS = 110 * 60 * 1000;
const HANDLE_REFRESH_RETRY_MS = 3 * 60 * 1000; // failed renewals retry quickly
let handleRefreshTimer = null;
let handleRefreshPromise = null;

function autoSleepMs() {
  const raw = Number(process.env.IRIS_AUTO_SLEEP_SECONDS ?? 30);
  if (!Number.isFinite(raw) || raw <= 0) return 0; // 0 disables auto-sleep
  return Math.max(15, raw) * 1000;
}

function autoWakeOnHermes() {
  return envFlag("IRIS_AUTO_WAKE_ON_HERMES", true);
}

function bumpVoiceActivity() {
  lastVoiceActivityAt = Date.now();
}

function freshResumeHandle() {
  return resumeHandle && Date.now() - resumeHandleAt < RESUME_HANDLE_TTL_MS ? resumeHandle : null;
}
let irisUiContext = {
  tasks: [],
  expandedTaskId: null,
  focusedTaskId: null,
  latestResultTaskId: null,
  showHistory: false,
};

function emitToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function emitEvent(event) {
  emitToRenderer("sidecar:event", { timestamp: Date.now() / 1000, ...event });
}

// Emit the user's line on its own. Called as soon as Iris starts responding so
// "You: …" shows up immediately, instead of waiting for the whole turn to end.
function flushUserTranscript() {
  if (userTranscriptBuffer.trim()) {
    emitEvent({ type: "transcript", speaker: "you", text: userTranscriptBuffer.trim() });
  }
  userTranscriptBuffer = "";
}

function flushTranscripts() {
  flushUserTranscript();
  if (modelTranscriptBuffer.trim()) {
    emitEvent({ type: "transcript", speaker: "gemini", text: modelTranscriptBuffer.trim() });
  }
  modelTranscriptBuffer = "";
}

function hermesBaseUrl() {
  return process.env.HERMES_API_URL || "http://127.0.0.1:8642";
}

function hermesHeaders() {
  return {
    Authorization: `Bearer ${process.env.API_SERVER_KEY || "iris-local-dev"}`,
    "Content-Type": "application/json",
  };
}

function userDisplayName() {
  return (process.env.IRIS_USER_NAME || process.env.USER || process.env.USERNAME || "there").trim();
}

function resolveContextPath(value) {
  if (!value) return null;
  let resolved = value.trim();
  if (!resolved) return null;
  if (resolved.startsWith("~")) resolved = path.join(os.homedir(), resolved.slice(1));
  if (!path.isAbsolute(resolved)) resolved = path.join(repoRoot, resolved);
  return resolved;
}

// Load the user's personal context (the SOUL.md / USER.md / MEMORY.md pattern):
// concise, authoritative facts about who the user is and what they want, so Gemini
// can resolve vague requests and write complete Hermes briefs. Configure explicit
// files with IRIS_CONTEXT_FILE (comma-separated); otherwise auto-discover the
// conventional files in ~/.iris and the repo root. Best-effort and capped.
function loadUserContext() {
  const MAX_CHARS = 12000;
  // Single source of truth: Hermes's own learned context (USER.md + MEMORY.md), so
  // Iris and Hermes stay in sync — no copying, no override files. We do NOT load
  // Hermes's SOUL.md (that's Hermes's persona and would fight Iris's identity).
  // Override the location with HERMES_HOME if Hermes lives somewhere else.
  const hermesHome = process.env.HERMES_HOME
    ? resolveContextPath(process.env.HERMES_HOME)
    : path.join(os.homedir(), ".hermes");
  const candidates = [
    path.join(hermesHome, "memories", "USER.md"),
    path.join(hermesHome, "memories", "MEMORY.md"),
  ];

  const seen = new Set();
  const blocks = [];
  const files = [];
  for (const file of candidates) {
    if (!file) continue;
    let realKey;
    try {
      if (!fs.existsSync(file)) continue;
      realKey = fs.realpathSync(file);
    } catch {
      continue;
    }
    if (seen.has(realKey)) continue;
    seen.add(realKey);
    try {
      const text = fs.readFileSync(file, "utf8").trim();
      if (!text) continue;
      const label = path.join(path.basename(path.dirname(file)), path.basename(file));
      blocks.push(`# ${label}\n${text}`);
      files.push(label);
    } catch {
      // Skip unreadable context files.
    }
  }

  let text = blocks.join("\n\n");
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n…(user context truncated)`;
  return { text, files };
}

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function appConfig() {
  return {
    loadTestData: envFlag("IRIS_LOAD_TEST_DATA", false),
    sounds: envFlag("IRIS_SOUNDS", true),
    userName: userDisplayName(),
    configured: Boolean((process.env.GEMINI_API_KEY || "").trim()),
  };
}

// ===== Onboarding / Settings =====
const GEMINI_VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Aoede",
  "Leda", "Orus", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus",
];
const GEMINI_LIVE_MODELS = ["models/gemini-3.1-flash-live-preview"];
const ALLOWED_CONFIG_KEYS = new Set([
  "GEMINI_API_KEY",
  "GEMINI_LIVE_MODEL",
  "GEMINI_LIVE_VOICE",
  "HERMES_API_URL",
  "API_SERVER_KEY",
  "HERMES_BIN",
  "HERMES_HOME",
  "IRIS_USER_NAME",
  "IRIS_LOAD_TEST_DATA",
  "IRIS_WAKE_WORD",
  "IRIS_HERMES_SESSION",
  "IRIS_SOUNDS",
  "IRIS_WAKE_SENSITIVITY",
  "IRIS_BRAIN_PATH",
  "IRIS_BRAIN_SEMANTIC",
  "IRIS_BRAIN_AUTO_INDEX",
  "IRIS_HERMES_AUTOSTART",
  "IRIS_AUTO_SLEEP_SECONDS",
  "IRIS_AUTO_WAKE_ON_HERMES",
]);

function userConfigPath() {
  return path.join(os.homedir(), ".iris", ".env");
}

function ensureIncludes(list, value) {
  if (value && !list.includes(value)) return [value, ...list];
  return list;
}

// Full settings snapshot for the onboarding/settings UI. Values come from
// process.env (populated from .env at boot and updated live on save).
function getFullConfig() {
  return {
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    geminiModel: process.env.GEMINI_LIVE_MODEL || "models/gemini-3.1-flash-live-preview",
    geminiVoice: process.env.GEMINI_LIVE_VOICE || "Zephyr",
    hermesUrl: process.env.HERMES_API_URL || "http://127.0.0.1:8642",
    hermesKey: process.env.API_SERVER_KEY || "iris-local-dev",
    hermesBin: process.env.HERMES_BIN || "",
    hermesHome: process.env.HERMES_HOME || "",
    hermesSession: hermesSessionId(),
    brainPath: process.env.IRIS_BRAIN_PATH || "",
    brainSemantic: envFlag("IRIS_BRAIN_SEMANTIC", true),
    brainAutoIndex: envFlag("IRIS_BRAIN_AUTO_INDEX", false),
    userName: process.env.IRIS_USER_NAME || "",
    loadTestData: envFlag("IRIS_LOAD_TEST_DATA", false),
    wakeWord: envFlag("IRIS_WAKE_WORD", false),
    wakeSensitivity: process.env.IRIS_WAKE_SENSITIVITY || "balanced",
    sounds: envFlag("IRIS_SOUNDS", true),
    autoSleepSeconds: String(process.env.IRIS_AUTO_SLEEP_SECONDS ?? "30"),
    autoWakeOnHermes: envFlag("IRIS_AUTO_WAKE_ON_HERMES", true),
    configured: Boolean((process.env.GEMINI_API_KEY || "").trim()),
    voices: GEMINI_VOICES,
    models: ensureIncludes(GEMINI_LIVE_MODELS, process.env.GEMINI_LIVE_MODEL),
    configPath: userConfigPath(),
    // Read-only defaults surfaced in the UI (not editable from settings).
    voiceDuplexMode: process.env.VOICE_DUPLEX_MODE || "speaker",
    speakerEchoGuard: process.env.SPEAKER_ECHO_GUARD_SECONDS || "0.9",
  };
}

function serializeConfigValue(value) {
  const str = String(value ?? "").trim();
  return /[\s"#]/.test(str) ? `"${str.replace(/"/g, '\\"')}"` : str;
}

// Merge updates into ~/.iris/.env (preserving comments/other keys) and apply them
// to process.env so they take effect on the next wake without a full restart.
function writeUserConfig(rawUpdates) {
  const updates = {};
  for (const [key, value] of Object.entries(rawUpdates || {})) {
    if (ALLOWED_CONFIG_KEYS.has(key)) updates[key] = value;
  }
  if (!Object.keys(updates).length) return getFullConfig();

  const file = userConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const remaining = new Set(Object.keys(updates));
  const out = [];
  for (const line of existing) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    const eq = trimmed.indexOf("=");
    const key = eq === -1 ? trimmed : trimmed.slice(0, eq).trim();
    if (remaining.has(key)) {
      out.push(`${key}=${serializeConfigValue(updates[key])}`);
      remaining.delete(key);
    } else {
      out.push(line);
    }
  }
  for (const key of remaining) out.push(`${key}=${serializeConfigValue(updates[key])}`);

  fs.writeFileSync(file, `${out.join("\n").replace(/\n+$/, "")}\n`, "utf8");
  for (const [key, value] of Object.entries(updates)) process.env[key] = String(value ?? "").trim();
  return getFullConfig();
}

// Validate a Gemini key by forcing one authenticated round-trip (ListModels).
async function testGeminiKey(candidateKey) {
  const key = (candidateKey || process.env.GEMINI_API_KEY || "").trim();
  if (!key) return { ok: false, error: "No API key provided." };
  try {
    const testAi = new GoogleGenAI({ apiKey: key });
    const pager = await testAi.models.list();
    for await (const _model of pager) break;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function testHermesConnection(payload = {}) {
  const base = (payload.url || hermesBaseUrl()).replace(/\/$/, "");
  const apiKey = payload.key || process.env.API_SERVER_KEY || "iris-local-dev";
  try {
    const res = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
    let health = {};
    try { health = JSON.parse(text); } catch { /* non-JSON health */ }
    return { ok: true, health };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

// ===== Hermes auto-start =====
// Iris only TALKS to the Hermes gateway's API server — it never owned its
// lifecycle. But a dead gateway (or one whose API platform refused to start,
// e.g. after a key rotation) means every dispatch fails, so: if the API is
// unreachable at launch, start/restart the gateway automatically. Opt out
// with IRIS_HERMES_AUTOSTART=false.
let hermesAutostartBusy = false;

function runCommand(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, out: String(error?.message || error) });
      return;
    }
    let out = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      resolve({ ok: false, out: `${out}\n(timed out)` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { out += chunk; });
    child.stderr?.on("data", (chunk) => { out += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, out: String(error?.message || error) });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out });
    });
  });
}

function hermesCliCandidates() {
  const home = process.env.HERMES_HOME
    ? resolveContextPath(process.env.HERMES_HOME)
    : path.join(os.homedir(), ".hermes");
  const candidates = [];
  if ((process.env.HERMES_BIN || "").trim()) {
    candidates.push({ cmd: resolveContextPath(process.env.HERMES_BIN.trim()), args: [] });
  }
  candidates.push({ cmd: "hermes", args: [] }); // PATH
  const venvPython = path.join(
    home, "hermes-agent", "venv", "bin", process.platform === "win32" ? "python.exe" : "python",
  );
  if (fs.existsSync(venvPython)) candidates.push({ cmd: venvPython, args: ["-m", "hermes_cli.main"] });
  return candidates;
}

async function ensureHermesRunning() {
  if (!envFlag("IRIS_HERMES_AUTOSTART", true) || hermesAutostartBusy) return;
  hermesAutostartBusy = true;
  try {
    const first = await testHermesConnection();
    if (first.ok) return;
    emitEvent({
      type: "log",
      level: "warn",
      message: `Hermes API not reachable (${first.error}) — starting the Hermes gateway…`,
    });

    // The Hermes desktop app manages the gateway through launchd on macOS —
    // restarting the service also makes it re-read ~/.hermes/.env (fresh
    // API_SERVER_KEY etc.). Fall back to the Hermes CLI wherever it lives.
    const attempts = [];
    if (process.platform === "darwin") {
      const service = `gui/${process.getuid?.() ?? 501}/ai.hermes.gateway`;
      const probe = await runCommand("launchctl", ["print", service], 4000);
      if (probe.ok) {
        attempts.push({ label: "launchctl kickstart", cmd: "launchctl", args: ["kickstart", "-k", service] });
      }
    }
    for (const cli of hermesCliCandidates()) {
      attempts.push({
        label: `${path.basename(cli.cmd)} gateway restart`,
        cmd: cli.cmd,
        args: [...cli.args, "gateway", "restart"],
      });
    }

    for (const attempt of attempts) {
      const run = await runCommand(attempt.cmd, attempt.args, 30000);
      if (!run.ok) {
        emitEvent({
          type: "log",
          level: "warn",
          message: `Hermes autostart: ${attempt.label} failed — ${run.out.trim().slice(0, 180) || "unknown error"}`,
        });
        continue;
      }
      // The gateway takes a few seconds to bring its platforms up.
      for (let poll = 0; poll < 22; poll += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const check = await testHermesConnection();
        if (check.ok) {
          emitEvent({ type: "log", level: "info", message: `Hermes gateway is up (via ${attempt.label}).` });
          emitEvent({ type: "hermes_status", status: "ready", detail: check.health });
          return;
        }
      }
      emitEvent({
        type: "log",
        level: "warn",
        message: `Hermes autostart: ${attempt.label} ran but the API did not come up.`,
      });
    }
    emitEvent({
      type: "log",
      level: "error",
      message:
        "Could not start Hermes automatically. Run `hermes gateway restart` yourself, and check API_SERVER_KEY (16+ chars, identical in ~/.hermes/.env and ~/.iris/.env).",
    });
  } finally {
    hermesAutostartBusy = false;
  }
}

// Speak a short sample with the chosen voice via a throwaway Live session. Audio
// streams to the renderer over the existing live:audio channel.
let previewSession = null;
async function previewVoice(payload = {}) {
  if (liveSession) return { ok: false, error: "Sleep Iris before previewing a voice." };
  const apiKey = (payload.key || process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) return { ok: false, error: "Save your Gemini key first." };
  const voiceName = payload.voice || process.env.GEMINI_LIVE_VOICE || "Zephyr";
  const model = process.env.GEMINI_LIVE_MODEL || "models/gemini-3.1-flash-live-preview";
  try {
    if (previewSession) {
      try { previewSession.close(); } catch { /* ignore */ }
      previewSession = null;
    }
    const previewAi = new GoogleGenAI({ apiKey });
    previewSession = await previewAi.live.connect({
      model,
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        systemInstruction: {
          parts: [{ text: "You are a short voice sample. Say exactly the line you are asked to say, nothing more." }],
        },
      },
      callbacks: {
        onmessage(message) {
          const content = message.serverContent;
          if (!content) return;
          for (const part of content.modelTurn?.parts || []) {
            const inlineData = part.inlineData;
            if (inlineData?.data && (inlineData.mimeType || "").startsWith("audio/")) {
              emitToRenderer("live:audio", { data: inlineData.data, mimeType: inlineData.mimeType });
            }
          }
          if (content.turnComplete) {
            try { previewSession?.close(); } catch { /* ignore */ }
            previewSession = null;
          }
        },
        onerror() { previewSession = null; },
        onclose() { previewSession = null; },
      },
    });
    // Send AFTER connect resolves: onopen can fire before the session variable is
    // assigned, so triggering inside onopen would no-op (silent preview).
    previewSession.sendRealtimeInput({
      text: `Say exactly: Hi, I'm Iris. This is the ${voiceName} voice.`,
    });
    return { ok: true };
  } catch (error) {
    previewSession = null;
    return { ok: false, error: error?.message || String(error) };
  }
}

async function hermesRequest(method, pathName, body = undefined) {
  const response = await fetch(`${hermesBaseUrl()}${pathName}`, {
    method,
    headers: hermesHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { text };
    }
  }
  if (!response.ok) {
    throw new Error(`Hermes ${response.status}: ${text || response.statusText}`);
  }
  return json;
}

async function checkHermesStatus() {
  try {
    const health = await hermesRequest("GET", "/health");
    emitEvent({ type: "hermes_status", status: "ready", detail: health });
    return { reachable: true, health };
  } catch (error) {
    emitEvent({ type: "hermes_status", status: "error", error: error.message });
    return { reachable: false, error: error.message };
  }
}

// All Iris work lands in ONE pinned Hermes session. Gemini used to be allowed to
// pass its own session_id, which quietly fragmented history across multiple
// Hermes chat threads — so the model no longer gets a say.
function hermesSessionId() {
  return (process.env.IRIS_HERMES_SESSION || "iris-voice").trim() || "iris-voice";
}

async function submitHermesTask({ task, urgency = "normal" }) {
  if (!task || !String(task).trim()) {
    return { status: "error", error: "Task is required." };
  }
  const cleanTask = String(task).trim();
  emitEvent({ type: "hermes_task_update", status: "starting", task: cleanTask });
  const run = await hermesRequest("POST", "/v1/runs", {
    input: cleanTask,
    session_id: hermesSessionId(),
    instructions:
      "You are invoked from Iris voice. Work autonomously. Do not ask Iris for clarification unless absolutely impossible. Use sensible defaults and report concise final results. " +
      "This session may contain your own earlier runs: when the task repeats or extends previous work in this conversation, REUSE those results, scripts, and resolved IDs instead of re-deriving everything — re-check only what could have changed since.",
  });
  const runId = run.run_id || run.id;
  emitEvent({ type: "hermes_task_update", status: "started", task: cleanTask, run_id: runId, urgency });
  if (runId) watchHermesRun(runId, cleanTask);
  return {
    status: "started",
    run_id: runId,
    message: "Hermes has started the task.",
    instructions:
      "Say ONE short acknowledgement (e.g. 'On it — Hermes is handling that now.'). The task has only STARTED: you have NO result yet. Do not describe, predict, or summarize any outcome until SYSTEM_EVENT_HERMES_COMPLETE arrives or get_hermes_task_status returns a terminal status.",
  };
}

// Stage a Hermes task without sending it (STEP 1 of the enforced dispatch flow;
// the state machine lives in hermesGate.mjs).
function proposeHermesTask({ task, urgency = "normal" }) {
  const staged = gatePropose(task, urgency);
  if (!staged.ok) return { status: "error", error: "A complete task brief is required." };
  return {
    status: "proposed",
    task: staged.task,
    instructions: [
      `Now read this brief back to ${userDisplayName()} in one or two short sentences, ask "Should I send this to Hermes?", and END YOUR TURN.`,
      "Do NOT call submit_hermes_task yet — it will be rejected until they answer.",
      `If ${userDisplayName()} declines, drop it. If they change any detail, call propose_hermes_task again with the updated brief.`,
    ].join(" "),
  };
}

async function getHermesTaskStatus({ run_id }) {
  const terminal = new Set(["completed", "failed", "cancelled", "canceled", "error"]);
  try {
    const run = await hermesRequest("GET", `/v1/runs/${run_id}`);
    const status = String(run.status || "unknown");
    if (terminal.has(status)) {
      return {
        status,
        run_id,
        output: String(run.output || run.final_response || "").slice(0, 2500),
        instructions: "The run is finished. Report ONLY what is in `output` above — nothing else.",
      };
    }
    return {
      status,
      run_id,
      instructions:
        "The run is STILL IN PROGRESS. There is NO result yet. Tell the user it is still working and stop there — do not guess, predict, or invent any findings. You will receive SYSTEM_EVENT_HERMES_COMPLETE when it finishes.",
    };
  } catch (error) {
    return {
      status: "error",
      run_id,
      error: error?.message || String(error),
      instructions:
        "You could not fetch the status. Say exactly that. Do not make up a status or a result.",
    };
  }
}

// ===== Hermes sessions & history restore =====
// Hermes semantics: a session is created lazily the first time any client
// references its id (POST /v1/runs with an unknown session_id creates it), and
// the Hermes TUI/desktop creates its own `tui`-source sessions per chat. Hermes
// never spawns extra sessions for API clients on its own — the old strays came
// from Gemini choosing session ids, which is now pinned to hermesSessionId().
//
// The Work Stream mirrors ONE selected session (like picking a chat in Hermes
// desktop): submissions go to it, and history is restored from it alone — no
// mix and match. Hermes has no "list runs" endpoint, but it persists the full
// transcript, so past completed work is rebuilt from user/assistant messages.
const HERMES_HISTORY_LIMIT = 12;

// Create a brand-new chat thread and let HERMES name it: native `api_…` id and
// NO custom title — like every chat tool, the thread takes its name from the
// first prompt sent into it (Hermes exposes that as the session preview).
async function createHermesSession() {
  try {
    const json = await hermesRequest("POST", "/api/sessions", {});
    const id = json?.session?.id || json?.id;
    if (!id) throw new Error("Hermes did not return a session id.");
    return { ok: true, id: String(id) };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

// Iris-born sessions for the main-page session switcher: `api_server` source
// only (Iris is the API client) — the user's own Hermes TUI/desktop chats are
// intentionally excluded. Newest first.
async function listHermesSessions() {
  try {
    const json = await hermesRequest("GET", "/api/sessions");
    const sessions = (Array.isArray(json.data) ? json.data : [])
      .filter((session) => session?.id && session.source === "api_server")
      .sort((a, b) => (b.last_active || 0) - (a.last_active || 0))
      .slice(0, 25)
      .map((session) => ({
        id: String(session.id),
        source: String(session.source || ""),
        title: typeof session.title === "string" ? session.title : "",
        preview: typeof session.preview === "string" ? session.preview : "",
        messageCount: typeof session.message_count === "number" ? session.message_count : 0,
        lastActive: typeof session.last_active === "number" ? session.last_active * 1000 : 0,
      }));
    return { ok: true, sessions };
  } catch (error) {
    return { ok: false, error: error?.message || String(error), sessions: [] };
  }
}

function historyStepsFromToolCalls(message) {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const ts = (typeof message.timestamp === "number" ? message.timestamp : 0) * 1000;
  const steps = [];
  calls.forEach((call, index) => {
    const name = call?.function?.name;
    if (!name) return;
    let preview;
    try {
      const args = JSON.parse(call.function.arguments || "{}");
      const firstString = Object.values(args).find(
        (value) => typeof value === "string" && value.trim(),
      );
      if (firstString) preview = String(firstString).slice(0, 80);
    } catch {
      // Arguments are best-effort preview material only.
    }
    steps.push({ id: `hist-${message.id}-${index}`, tool: name, preview, status: "done", ts });
  });
  return steps;
}

async function sessionRunsFromTranscript(sessionId) {
  const json = await hermesRequest(
    "GET",
    `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
  const messages = Array.isArray(json.data) ? json.data : [];
  const runs = [];
  let current = null;

  for (const message of messages) {
    const ts = (typeof message.timestamp === "number" ? message.timestamp : 0) * 1000;
    if (
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.trim() &&
      !message.content.startsWith("SYSTEM_EVENT")
    ) {
      // Runs that never produced a final response (stopped/interrupted) are
      // skipped — there is no result to restore for them.
      if (current?.output) runs.push(current);
      current = {
        id: `history:${sessionId}:${message.id}`,
        task: message.content.trim(),
        status: "completed",
        output: "",
        updatedAt: ts,
        steps: [],
      };
      continue;
    }
    if (!current || message.role !== "assistant") continue;

    current.steps = [...current.steps, ...historyStepsFromToolCalls(message)].slice(-40);
    if (typeof message.content === "string" && message.content.trim()) {
      current.output = message.content.trim().slice(0, 8000);
      if (ts) current.updatedAt = ts;
    }
  }
  if (current?.output) runs.push(current);
  return runs;
}

async function fetchHermesHistory() {
  try {
    const sessionId = hermesSessionId();
    const runs = await sessionRunsFromTranscript(sessionId).catch(() => []);
    const tasks = runs.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, HERMES_HISTORY_LIMIT);
    return { ok: true, tasks, sessions: [sessionId] };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function stopHermesTask({ run_id }) {
  return hermesRequest("POST", `/v1/runs/${run_id}/stop`, {});
}

async function approveHermesAction({ run_id, choice }) {
  return hermesRequest("POST", `/v1/runs/${run_id}/approval`, { choice });
}

// ===== Hermes Brain (Obsidian vault -> knowledge graph) =====
// The brain is a plain Obsidian vault: markdown notes + [[wikilinks]]. The
// indexer builds { nodes, links } for the HUD's Neural Map. Read-only, always.
function brainRoot() {
  const raw = (process.env.IRIS_BRAIN_PATH || "").trim();
  return raw ? resolveContextPath(raw) : null;
}

function walkVault(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // .obsidian, .git, .tmp.*
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkVault(full, files);
    else if (entry.name.endsWith(".md")) files.push(full);
  }
}

function loadBrainGraph() {
  const root = brainRoot();
  if (!root) return { ok: false, error: "No brain vault configured. Set it in Settings → Hermes." };
  if (!fs.existsSync(root)) return { ok: false, error: `Brain vault not found: ${root}` };
  // Refresh search alongside the visual graph: lexicon rebuild is instant,
  // embedding delta-sync runs in the background.
  setTimeout(() => refreshBrainSearch(), 0);
  try {
    const files = [];
    walkVault(root, files);

    const nodes = [];
    const byTitle = new Map();
    const contents = new Map();
    for (const file of files) {
      const id = path.relative(root, file);
      const title = path.basename(file, ".md");
      const segments = id.split(path.sep);
      nodes.push({ id, title, folder: segments.length > 1 ? segments[0] : "root", degree: 0 });
      byTitle.set(title.toLowerCase(), id);
      contents.set(id, fs.readFileSync(file, "utf8"));
    }

    // Obsidian links resolve by note name; [[note|alias]] and [[note#heading]]
    // both point at "note".
    const links = [];
    const seen = new Set();
    const degree = new Map();
    for (const node of nodes) {
      for (const match of (contents.get(node.id) ?? "").matchAll(/\[\[([^\]]+)\]\]/g)) {
        const targetId = byTitle.get(match[1].split(/[|#]/)[0].trim().toLowerCase());
        if (!targetId || targetId === node.id) continue;
        const key = `${node.id}->${targetId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ source: node.id, target: targetId });
        degree.set(node.id, (degree.get(node.id) ?? 0) + 1);
        degree.set(targetId, (degree.get(targetId) ?? 0) + 1);
      }
    }
    for (const node of nodes) node.degree = degree.get(node.id) ?? 0;
    return { ok: true, root, nodes, links };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function readBrainNote(relPath) {
  const root = brainRoot();
  if (!root) return { ok: false, error: "No brain vault configured." };
  const resolved = path.resolve(root, relPath || "");
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return { ok: false, error: "Path is outside the brain vault." };
  }
  if (!resolved.endsWith(".md") || !fs.existsSync(resolved)) {
    return { ok: false, error: "Note not found." };
  }
  try {
    const raw = fs.readFileSync(resolved, "utf8");
    let body = raw;
    const meta = {};
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
    if (frontmatter) {
      body = raw.slice(frontmatter[0].length);
      for (const line of frontmatter[1].split(/\r?\n/)) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const value = line
          .slice(idx + 1)
          .trim()
          .replace(/^["'[]|["'\]]$/g, "")
          .trim();
        if (key && value) meta[key] = value;
      }
    }
    return { ok: true, meta, body: body.slice(0, 20000) };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

// ===== Brain search — BM25F + Gemini embeddings, fused =====
// The lexicon (lexical index) rebuilds from the vault on every refresh; the
// vector index lives at ~/.iris/brain-index and is delta-synced in the
// background (content-hash cache — see electron/brainIndex.mjs). Searches
// serve whatever is ready: hybrid when possible, lexical-only otherwise.
let brainSearch = { root: null, lexicon: null, index: null, syncing: false };

function brainSemanticEnabled() {
  return envFlag("IRIS_BRAIN_SEMANTIC", true);
}

function refreshBrainSearch() {
  const root = brainRoot();
  if (!root || !fs.existsSync(root)) {
    brainSearch = { root: null, lexicon: null, index: null, syncing: false };
    return;
  }
  try {
    brainSearch.root = root;
    brainSearch.lexicon = buildLexicon(readVaultRecords(root));
    brainSearch.index = loadIndexFromDisk(root); // possibly stale — refreshed below
  } catch (error) {
    emitEvent({ type: "log", level: "warn", message: `Brain lexicon failed: ${error?.message || error}` });
    return;
  }

  // Embedding maintenance is OPT-IN (it makes Gemini API calls with no user
  // action). Off by default: the on-disk index still loads and searches work;
  // new/edited notes join the index only via the Settings button or an
  // external run of the indexer (e.g. the Hermes brain-sync skill).
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!envFlag("IRIS_BRAIN_AUTO_INDEX", false)) return;
  if (!brainSemanticEnabled() || !apiKey || brainSearch.syncing) return;
  brainSearch.syncing = true;
  syncBrainIndex({ vaultRoot: root, apiKey })
    .then((result) => {
      brainSearch.index = result.index;
      if (result.embedded > 0 || result.pruned > 0) {
        emitEvent({
          type: "log",
          level: "info",
          message: `Brain index synced: ${result.embedded} embedded, ${result.reused} reused, ${result.pruned} pruned (${result.ms}ms).`,
        });
      }
    })
    .catch((error) => {
      emitEvent({ type: "log", level: "warn", message: `Brain index sync failed: ${error?.message || error}` });
    })
    .finally(() => {
      brainSearch.syncing = false;
    });
}

// ---- Hot reload: watch the vault + its index so a Hermes sync (or an
// Obsidian edit, or a manual re-index) lands in the app live — search state
// refreshes and any open Neural Map re-blooms. No restart, no reopen.
let brainWatchers = [];
let brainChangeTimer = null;

function scheduleBrainChanged() {
  if (brainChangeTimer) clearTimeout(brainChangeTimer);
  // The sync writes many files in a burst; let it finish, then refresh once.
  brainChangeTimer = setTimeout(() => {
    brainChangeTimer = null;
    refreshBrainSearch();
    emitToRenderer("brain:changed", {});
  }, 1200);
}

function watchBrainVault() {
  for (const watcher of brainWatchers) {
    try { watcher.close(); } catch { /* ignore */ }
  }
  brainWatchers = [];
  const root = brainRoot();
  if (!root || !fs.existsSync(root)) return;

  const targets = [
    { dir: root, accept: (name) => name.endsWith(".md") && !name.split(path.sep).some((seg) => seg.startsWith(".")) },
    // The skill / CLI re-embeds without necessarily touching the vault.
    { dir: indexDirFor(root), accept: (name) => name.startsWith("manifest.json") || name.startsWith("vectors.f32") },
  ];
  for (const { dir, accept } of targets) {
    if (!fs.existsSync(dir)) continue;
    try {
      const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
        if (filename && !accept(String(filename))) return;
        scheduleBrainChanged();
      });
      brainWatchers.push(watcher);
    } catch (error) {
      emitEvent({ type: "log", level: "warn", message: `Brain watcher failed for ${dir}: ${error?.message || error}` });
    }
  }
}

async function searchBrain(query, topK = 6) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "Empty query." };
  const root = brainRoot();
  if (!root) return { ok: false, error: "No brain vault configured. Set it in Settings → Hermes." };
  if (!brainSearch.lexicon || brainSearch.root !== root) refreshBrainSearch();
  if (!brainSearch.lexicon) return { ok: false, error: "Brain vault could not be read." };

  let queryVector = null;
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (brainSearch.index && apiKey && brainSemanticEnabled()) {
    try {
      queryVector = await embedQuery({ apiKey, model: brainSearch.index.manifest.model, text: q });
    } catch (error) {
      emitEvent({ type: "log", level: "warn", message: `Query embedding failed (lexical only): ${error?.message || error}` });
    }
  }

  const results = hybridSearch({
    lexicon: brainSearch.lexicon,
    index: brainSearch.index,
    queryVector,
    query: q,
    topK: Math.max(1, Math.min(12, Number(topK) || 6)),
  });
  return {
    ok: true,
    mode: queryVector ? "hybrid" : "lexical",
    results: results.map((hit) => ({
      path: hit.rel,
      title: hit.title,
      folder: hit.folder,
      snippet: hit.snippet,
      sources: hit.sources,
      // A hit is trustworthy when the meaning clearly matches (cosine) or the
      // note really contains the query's content words (coverage). Nonsense
      // queries produce hits with neither — callers treat those as misses.
      confident: hit.cosScore >= COSINE_CONFIDENT || hit.coverage >= COVERAGE_CONFIDENT,
    })),
  };
}

// Obsidian-equivalent graph filter: the COMPLETE set of notes whose text
// mentions the query (instant, fully local), optionally widened by confident
// semantic hits so paraphrased voice queries still land.
async function filterBrainNotes(query) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "Empty query." };
  const root = brainRoot();
  if (!root) return { ok: false, error: "No brain vault configured." };
  if (!brainSearch.lexicon || brainSearch.root !== root) refreshBrainSearch();
  if (!brainSearch.lexicon) return { ok: false, error: "Brain vault could not be read." };

  const matches = new Map();
  for (const hit of lexicalFilter(brainSearch.lexicon, q)) {
    matches.set(hit.rel, { path: hit.rel, title: hit.title, folder: hit.folder });
  }
  let mode = "lexical";
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (brainSearch.index && apiKey && brainSemanticEnabled()) {
    try {
      const queryVector = await embedQuery({ apiKey, model: brainSearch.index.manifest.model, text: q });
      const ranked = hybridSearch({
        lexicon: brainSearch.lexicon,
        index: brainSearch.index,
        queryVector,
        query: q,
        topK: 12,
      });
      for (const hit of ranked) {
        if (hit.cosScore >= COSINE_CONFIDENT || hit.coverage >= COVERAGE_CONFIDENT) {
          if (!matches.has(hit.rel)) matches.set(hit.rel, { path: hit.rel, title: hit.title, folder: hit.folder });
        }
      }
      mode = "hybrid";
    } catch {
      /* lexical set already complete for literal queries */
    }
  }
  return { ok: true, mode, results: [...matches.values()] };
}

function getIrisUiContext() {
  return irisUiContext;
}

function controlIrisUi({ action, target_id = undefined, query = undefined }) {
  const allowed = new Set([
    "open_latest_hermes_result",
    "open_current_hermes_result",
    "open_task",
    "open_task_by_query",
    "open_hermes_history",
    "close_reader",
    "close_history",
    "close_all_overlays",
    "show_task_steps",
    "hide_task_steps",
    "open_brain_graph",
    "close_brain_graph",
    "focus_brain_node",
    "filter_brain_graph",
    "open_brain_note",
    "close_brain_note",
    "show_full_brain_graph",
    "enter_hud_mode",
    "exit_hud_mode",
  ]);
  if (!allowed.has(action)) {
    return { status: "error", error: `Unknown UI action: ${action}` };
  }
  emitToRenderer("iris:ui-action", { action, target_id, query });
  return { status: "sent", action, target_id, query };
}

async function executeTool(name, args = {}) {
  switch (name) {
    case "check_hermes_status":
      return checkHermesStatus();
    case "propose_hermes_task":
      return proposeHermesTask(args);
    case "submit_hermes_task": {
      const claim = claimConfirmedProposal();
      if (!claim.ok) {
        return claim.reason === "no_proposal"
          ? {
              status: "blocked",
              error:
                "REJECTED: no proposed task. First call propose_hermes_task with the complete brief, read it back to the user, and wait for their explicit yes.",
            }
          : {
              status: "blocked",
              error: `REJECTED: ${userDisplayName()} has not confirmed yet. Read the proposed brief aloud, ask "Should I send this to Hermes?", END your turn, and submit only after they explicitly say yes.`,
            };
      }
      // Submit the confirmed brief; a task arg is only honored as a refinement
      // of the proposal (e.g. the user corrected a detail while confirming).
      return submitHermesTask({
        task: typeof args.task === "string" && args.task.trim() ? args.task : claim.proposal.task,
        urgency: args.urgency || claim.proposal.urgency,
      });
    }
    case "get_hermes_task_status":
      return getHermesTaskStatus(args);
    case "stop_hermes_task":
      return stopHermesTask(args);
    case "approve_hermes_action":
      return approveHermesAction(args);
    case "get_iris_ui_context":
      return getIrisUiContext();
    case "search_brain":
      return searchBrain(args.query, args.top_k);
    case "go_to_sleep":
      // Give the goodbye a moment to play before the renderer tears down
      // audio (its stop() flushes playback immediately).
      setTimeout(() => emitToRenderer("iris:sleep", {}), 3000);
      return {
        status: "sleeping",
        instructions:
          "Say a one-line goodbye right now (nothing else, no new topics). Iris goes to sleep in about 3 seconds.",
      };
    case "control_iris_ui":
      return controlIrisUi(args);
    default:
      return { status: "error", error: `Unknown tool: ${name}` };
  }
}

// Forward only the granular events the Work Stream surfaces. The top-level API
// error block has no `event` field, so checking for it also filters errors out.
function forwardHermesEvent(runId, task, parsed) {
  const kind = typeof parsed.event === "string" ? parsed.event : "";
  if (!kind) return;
  const relevant = new Set([
    "tool.started",
    "tool.completed",
    "message.delta",
    "reasoning.available",
    "approval.requested",
    "approval.required",
    "approval.resolved",
    "run.completed",
    "run.failed",
  ]);
  if (!relevant.has(kind)) return;
  emitEvent({
    type: "hermes_task_event",
    run_id: runId,
    task,
    event: kind,
    ts: typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now() / 1000,
    tool: typeof parsed.tool === "string" ? parsed.tool : undefined,
    preview: typeof parsed.preview === "string" ? parsed.preview : undefined,
    duration: typeof parsed.duration === "number" ? parsed.duration : undefined,
    is_error: parsed.error === true,
    delta: typeof parsed.delta === "string" ? parsed.delta : undefined,
    text: typeof parsed.text === "string" ? parsed.text : undefined,
  });
}

// Connect once to the one-shot SSE event stream and stream granular activity
// (tool use, browser/file actions, partial notes) to the renderer. This is
// additive telemetry only; run status/output/completion stay driven by the
// polling loop in watchHermesRun, so this can never regress the core flow.
async function streamHermesEvents(runId, task) {
  try {
    const response = await fetch(`${hermesBaseUrl()}/v1/runs/${runId}/events`, {
      method: "GET",
      headers: hermesHeaders(),
    });
    if (!response.ok || !response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (hermesRuns.has(runId)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (!payload) continue;
        try {
          forwardHermesEvent(runId, task, JSON.parse(payload));
        } catch {
          // Skip malformed SSE chunks.
        }
      }
    }
    try {
      await reader.cancel();
    } catch {
      // Best-effort cleanup.
    }
  } catch {
    // Event stream is best-effort; the polling loop remains the source of truth.
  }
}

async function watchHermesRun(runId, task) {
  if (hermesRuns.has(runId)) return;
  hermesRuns.set(runId, true);
  // Fire-and-forget granular activity stream alongside the status poll below.
  streamHermesEvents(runId, task);
  const terminal = new Set(["completed", "failed", "cancelled", "canceled", "error"]);
  let lastStatus = "";
  try {
    while (hermesRuns.has(runId)) {
      const run = await hermesRequest("GET", `/v1/runs/${runId}`);
      const status = String(run.status || "unknown");
      if (status !== lastStatus) {
        emitEvent({ type: "hermes_task_update", status, run_id: runId, task, run });
        lastStatus = status;
      }
      if (terminal.has(status)) {
        const output = run.output || run.final_response || "";
        emitEvent({ type: "hermes_task_update", status, run_id: runId, task, output });
        announceHermesCompletion({
          runId,
          task,
          status,
          output: String(output || "").slice(0, 2500),
        });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } catch (error) {
    emitEvent({ type: "hermes_task_update", status: "error", run_id: runId, task, error: error.message });
  } finally {
    hermesRuns.delete(runId);
  }
}

function announceHermesCompletion({ runId, task, status, output }) {
  const wakingFromSleep = !liveSession;
  const eventText = [
    "SYSTEM_EVENT_HERMES_COMPLETE",
    `run_id: ${runId}`,
    `status: ${status}`,
    `original_task: ${task}`,
    "instructions_to_iris:",
    `- Proactively tell ${userDisplayName()} Hermes has returned.`,
    "- If another conversation is in progress, politely pause it with a short bridge like: Quick update, Hermes is back with a result.",
    "- Give a concise spoken summary in 1-3 sentences.",
    "- Ask whether he wants to go through the details before continuing the current conversation.",
    "- If (and ONLY if) this update interrupted a discussion that was actively in progress, return to it afterwards by naming the topic yourself (e.g. \"Anyway, back to <topic> — you were saying...\"). If there was no ongoing discussion, or it had naturally finished, just end after the summary. NEVER ask \"what were we discussing\" — if you cannot name the interrupted topic yourself, there is nothing to resume.",
    "- Do not say you personally did the work; Hermes did.",
    ...(wakingFromSleep
      ? [
          `- You were WOKEN FROM SLEEP specifically to deliver this. Open with the update directly (no greeting), then ask if ${userDisplayName()} needs anything else. If they stay quiet you will simply doze off again — do not mention sleeping, tokens, or costs; keep it natural.`,
        ]
      : []),
    "hermes_result:",
    output || "(Hermes returned no text output.)",
  ].join("\n");

  emitEvent({
    type: "hermes_completion",
    run_id: runId,
    task,
    status,
    output,
  });

  if (liveSession) {
    // Tracked until a turn completes: if the connection dies before Iris
    // speaks this result, the reconnect path re-sends it.
    announcementsInFlight.push(eventText);
    liveSession.sendRealtimeInput({ text: eventText });
  } else {
    pendingHermesAnnouncements.push(eventText);
    requestAutoWake(`Hermes finished "${String(task).slice(0, 80)}" while Iris was asleep.`);
  }
}

// Test hooks (only with IRIS_TEST_HOOKS=1): let the verification scripts
// simulate a Hermes completion and inspect the sleep machinery without a
// real 10-minute agent run.
if (process.env.IRIS_TEST_HOOKS === "1") {
  globalThis.__irisTest = {
    simulateHermesComplete: (task = "Test task", output = "Test output.") =>
      announceHermesCompletion({ runId: `test-${Date.now()}`, task, status: "completed", output }),
    isLive: () => Boolean(liveSession),
    idleForMs: () => Date.now() - lastVoiceActivityAt,
    hasResumeHandle: () => Boolean(freshResumeHandle()),
    // Simulates the 9-hour nap: the handle exists but its 2h validity is gone,
    // so the next wake MUST fall back to a fresh session.
    expireResumeHandle: () => {
      resumeHandleAt = 0;
    },
    // Simulates the server refusing a handle (invalidated on their side).
    corruptResumeHandle: () => {
      if (resumeHandle) resumeHandle = `${String(resumeHandle).slice(0, 8)}-corrupted-by-test`;
    },
    pendingAnnouncements: () => pendingHermesAnnouncements.length,
  };
}

function buildHermesTools() {
  return [
    {
      functionDeclarations: [
        {
          name: "check_hermes_status",
          description: "Check if Hermes local API is reachable. Use this for questions about Hermes status.",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "propose_hermes_task",
          description:
            "STEP 1 of dispatching work to Hermes (deals, shopping, research, coding, file work, terminal tasks, summaries, automations — anything requiring tools). Stages the task brief WITHOUT sending it. After calling this, read the brief back to the user, ask for confirmation, and end your turn. IMPORTANT: Hermes cannot see this voice conversation — the 'task' string is the ONLY context it gets, so write a complete, self-contained brief for NEW tasks. For re-runs/follow-ups of a task already dispatched this session, write a SHORT continuation brief instead that tells Hermes to reuse its earlier work (it shares the session transcript) — this runs much faster.",
          parameters: {
            type: "object",
            properties: {
              task: {
                type: "string",
                description:
                  "A clear, self-contained brief of WHAT the user wants: the goal, every concrete detail they actually said (names, numbers, dates, budgets, constraints), and the expected output/format. Do NOT include implementation details — no tools, file paths, Notion pages/databases, scripts, or workflow internals. Hermes's own skills and memory cover the how.",
              },
              urgency: { type: "string", description: "low, normal, or high." },
            },
            required: ["task"],
          },
        },
        {
          name: "submit_hermes_task",
          description:
            "STEP 2: actually send the proposed task to Hermes. Only call this AFTER propose_hermes_task AND after the user explicitly said yes in their own turn. Calls made without a confirmed proposal are automatically REJECTED by the system.",
          parameters: {
            type: "object",
            properties: {
              task: {
                type: "string",
                description:
                  "Optional: only pass this to refine the proposed brief with corrections the user gave while confirming. Omit it to send the proposal as staged.",
              },
              urgency: { type: "string", description: "low, normal, or high." },
            },
          },
        },
        {
          name: "get_hermes_task_status",
          description:
            "Fetch the REAL status of a Hermes run. You MUST call this before saying anything about how a run is going — never guess or answer from memory. If it returns a non-terminal status, the result does not exist yet.",
          parameters: {
            type: "object",
            properties: { run_id: { type: "string" } },
            required: ["run_id"],
          },
        },
        {
          name: "stop_hermes_task",
          description: "Stop an active Hermes run.",
          parameters: {
            type: "object",
            properties: { run_id: { type: "string" } },
            required: ["run_id"],
          },
        },
        {
          name: "approve_hermes_action",
          description: "Resolve a Hermes approval request.",
          parameters: {
            type: "object",
            properties: {
              run_id: { type: "string" },
              choice: { type: "string", description: "once, session, always, or deny" },
            },
            required: ["run_id", "choice"],
          },
        },
      ],
    },
  ];
}

function buildIrisUiTools() {
  return [
    {
      functionDeclarations: [
        {
          name: "get_iris_ui_context",
          description:
            "Get the current Iris UI context: visible Hermes tasks, latest result task, focused task, expanded task, and whether history is open. Use before UI-only voice commands like 'open that', 'show latest result', 'close it', or 'show history'.",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "go_to_sleep",
          description:
            "Put Iris to sleep (end this voice session). Call it whenever the user says ANY parting phrase — 'go to sleep', 'sleep now', 'bye', 'bye bye', 'goodbye', 'good bye', 'take care', 'see you', 'see you later', 'that's all', 'that's all for now', 'goodnight', 'catch you later' — these ALWAYS mean sleep, never small talk. Say a very short TIME-NEUTRAL farewell BEFORE calling this ('Take care, bye!' / 'Bye, I'm here when you need me.') — NEVER 'goodnight' or 'good morning': you don't know the user's actual local time. The session ends about 3 seconds later. The wake word keeps working, so they can wake Iris again by voice.",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "search_brain",
          description:
            "Search the shared memory vault (the brain) by meaning and keywords. Returns the top notes with title, folder, a matching snippet, and a `confident` flag. Use for questions about accumulated knowledge — clients, deals, drafts, decisions, people, style ('what do we know about X', 'which note mentions Y', 'do I have anything on Z'). Read-only and instant; NOT for live/current data (that is Hermes work). Treat results with confident=false as weak leads: mention them only as a guess, or say the vault has nothing solid. After answering, you may offer to show a note on the Neural Map (focus_brain_node with its title).",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "What to look for — natural language or keywords, e.g. 'discount code for readers', 'atomic chat referral'.",
              },
              top_k: {
                type: "number",
                description: "How many notes to return (1-12, default 6).",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "control_iris_ui",
          description:
            "Control the Iris UI directly for UI-only requests. Use this instead of Hermes when the user asks to open/show/close the current result, latest Hermes result, task history, or overlays.",
          parameters: {
            type: "object",
            properties: {
              action: {
                type: "string",
                description:
                  "One of: open_latest_hermes_result, open_current_hermes_result, open_task, open_task_by_query, open_hermes_history, close_reader, close_history, close_all_overlays, show_task_steps, hide_task_steps, open_brain_graph, close_brain_graph, focus_brain_node, open_brain_note, close_brain_note. Use show_task_steps/hide_task_steps to expand or collapse the tool-step timeline for a Hermes task; when the user names a specific card, pass its words in `query` (or its exact id in `target_id`). With no target, steps default to the card the user is currently viewing (open reader / focused), then the running task. open_brain_graph shows the Neural Map — a visual graph of the shared memory vault (Iris enters HUD mode automatically); close_brain_graph dismisses it. enter_hud_mode switches Iris into the Glass HUD (transparent overlay floating over the desktop); exit_hud_mode returns to the normal deck window. focus_brain_node flies the map camera to the ONE note best matching `query`, highlights it, and shows just that note plus its direct connections (its local graph); filter_brain_graph instead keeps EVERY note matching `query` visible (title matches plus content matches — like typing in Obsidian's graph filter box) and hides the rest; show_full_brain_graph removes either filter and shows the whole constellation again (idempotent — ALWAYS call it when the user asks for the full map, even if you think no filter is active); open_brain_note opens the note card (pass `query` to name one, or omit it to open the focused node); close_brain_note closes the note card and returns to the map.",
              },
              target_id: {
                type: "string",
                description:
                  "Optional Hermes task id for open_task, show_task_steps, or hide_task_steps.",
              },
              query: {
                type: "string",
                description:
                  "Loose words from the user identifying a card, usable with open_task_by_query, show_task_steps, and hide_task_steps — e.g. 'failed one', 'Hermes API', 'the deals card', 'second one'. The renderer fuzzy-matches this against visible task titles/status. For open_task_by_query, close matches show a chooser overlay instead of guessing.",
              },
            },
            required: ["action"],
          },
        },
      ],
    },
  ];
}

function buildLiveConfig(resumeHandleForSession = null) {
  return {
    responseModalities: ["AUDIO"],
    mediaResolution: "MEDIA_RESOLUTION_MEDIUM",
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: process.env.GEMINI_LIVE_VOICE || "Zephyr",
        },
      },
    },
    // Aggressive compression is the single biggest cost lever: the Live API
    // re-bills the WHOLE context window (raw audio history, 25 tok/s) on
    // every turn. A small sliding window caps that compounding re-bill —
    // long-term memory lives in Hermes memory + the brain vault, not here.
    contextWindowCompression: {
      triggerTokens: 16384,
      slidingWindow: { targetTokens: 8192 },
    },
    // Lets us disconnect (auto-sleep, server GoAway resets) and reconnect
    // into the SAME conversation. Handles stay valid ~2h after disconnect.
    sessionResumption: resumeHandleForSession ? { handle: resumeHandleForSession } : {},
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    tools: [
      { googleSearch: {} },
      ...buildHermesTools(),
      ...buildIrisUiTools(),
    ],
    systemInstruction: {
      parts: [
        {
          text: [
            `You are Iris, the realtime voice front-end for ${userDisplayName()}.`,
            "Hermes is your worker brain for tools, terminal, files, web, deals, coding, research, and automations.",
            "You also have built-in Google Search. Use Google Search directly for quick current facts, simple web lookups, and lightweight questions that do not need Hermes to do work.",
            `CRITICAL Hermes dispatch flow — two steps, enforced by the system: (1) call propose_hermes_task with the complete brief, then read it back to ${userDisplayName()} in one or two sentences, ask "Should I send this to Hermes?", and END your turn. (2) Only after ${userDisplayName()} explicitly answers yes ("yes", "go", "do it", "send it") in their OWN turn, call submit_hermes_task. Any submit without a confirmed proposal is automatically rejected. Never dispatch on your own initiative. If they decline or stay silent, drop it. If they change details, call propose_hermes_task again with the updated brief and re-confirm.`,
            "CRITICAL truthfulness rule — you have NO knowledge of what Hermes is doing or has found. NEVER invent, guess, predict, or summarize a Hermes result from your own imagination. Facts about a run come ONLY from: a SYSTEM_EVENT_HERMES_COMPLETE message, or the exact `output` field of a get_hermes_task_status response with a terminal status. Until one of those exists, the ONLY honest answer is that Hermes is still working.",
            "When asked how a task is going or what Hermes found: FIRST call get_hermes_task_status (or check_hermes_status for connectivity), THEN speak strictly from its response. If the status is not terminal, say it is still in progress and stop — do not speculate about partial findings, likely outcomes, or timing.",
            "After submitting a task, your only statement is a short acknowledgement that Hermes has started. Never phrase it as if any result exists yet.",
            "Routing rule: quick answer, fact lookup, or general chat -> answer directly or use Google Search; dispatch to Hermes ONLY when explicitly requested as described above.",
            "UI control rule: If the user says things like 'open it', 'open that result', 'show latest Hermes result', 'show history', 'close it', 'go back', or 'open the current task', use get_iris_ui_context and control_iris_ui. Do not send those UI-only commands to Hermes.",
            `Sleep rule: ANY parting phrase from ${userDisplayName()} means sleep — 'go to sleep', 'sleep now', 'bye', 'bye bye', 'goodbye', 'good bye', 'take care', 'see you', 'see you later', 'catch you later', 'that's all', 'that's all for now', 'goodnight'. Treat these as a command, not chit-chat: say ONE short warm farewell and IMMEDIATELY call go_to_sleep — never reply to a goodbye without calling it, and never call it without being asked. Your farewell must be TIME-NEUTRAL ('Take care, bye!' / 'Bye for now!') — NEVER say 'goodnight', 'good morning', or anything time-of-day based, because you do not know ${userDisplayName()}'s actual local time.`,
            `HUD rule: when ${userDisplayName()} asks for the overlay mode — 'enter HUD mode', 'HUD mode', 'glass mode', 'float over my screen', 'overlay mode' — call control_iris_ui with action enter_hud_mode. 'exit HUD', 'back to the deck', 'normal window' -> exit_hud_mode. UI-only; never send to Hermes.`,
            `Neural Map rule: when ${userDisplayName()} says 'load the brain', 'show your brain', 'open the neural map', or 'show the knowledge graph', call control_iris_ui with action open_brain_graph — it renders the shared memory vault as a living graph over the screen. 'close the brain' / 'hide the map' -> close_brain_graph. These are UI-only commands; never send them to Hermes.`,
            `Neural Map traversal rule: when ${userDisplayName()} asks to find, point to, focus, or zoom to ONE note ('where is X', 'focus on the EvoMap draft'), call control_iris_ui with action focus_brain_node and their words in query — the camera flies to the single best match and shows its local graph (the note + its direct connections). When they ask to FILTER or SEARCH the map — 'filter the map to hash', 'show all Kimi notes', 'show everything about deals from June' — call filter_brain_graph with the query instead: EVERY matching note stays visible (like Obsidian's graph filter), the rest hide, and the pill shows the match count. STRICT show-all rule: when they ask to see the whole map ('show everything', 'show all notes', 'show the full map', 'remove the filter', 'unfilter', 'zoom out to the full map'), ALWAYS call control_iris_ui with action show_full_brain_graph IMMEDIATELY — never skip it because you believe the map is already full or no filter is active; your belief may be stale, the action is idempotent and harmless, and Iris confirms with an on-screen toast either way. Never reply 'it is already showing everything' INSTEAD of calling the action. Then 'open it' / 'read it' -> open_brain_note with no query; 'open X' -> open_brain_note with X in query. 'close the note' / 'go back to the map' -> close_brain_note. While the map is open, get_iris_ui_context includes brainNodes (all note titles), brainFocusedNote, brainOpenNote, brainIsolatedNote + brainIsolationNeighbors (local-graph view), and brainFilterQuery + brainFilterMatches (query-filter view) — use these lists to answer 'what is it connected to?', 'what matched?', or resolve 'open the second one'. If Iris shows a "No note matched" toast, say so and suggest close titles from brainNodes. These are UI-only commands; never send them to Hermes.`,
            `Brain search rule: for questions about accumulated knowledge — clients, deals, drafts, people, decisions, style ('what do we know about X', 'which note mentions Y', 'have I worked with Z') — call search_brain first and answer from its snippets, citing note titles. It searches by meaning, not just keywords. Prefer it over Google Search for anything personal, and over Hermes for simple recall (dispatch Hermes only when the user wants live data or real work done). If a result deserves a look, offer to open it on the map (focus_brain_node with the note title). If search_brain returns no strong match, say so honestly — never invent vault content.`,
            "Also handle these UI-only commands with control_iris_ui (never Hermes): 'show the steps' / 'what is it doing' / 'show what tools it used' -> show_task_steps; 'hide the steps' -> hide_task_steps. If they name a specific card ('steps for the deals one', 'steps for the second card'), pass those words in query. With no target named, steps apply to the card they are viewing (open reader first), else the running task.",
            "If the user refers to a task by partial words from the task header, like 'open the failed one', 'open Hermes API', 'open package Iris', or 'open two hand design', call control_iris_ui with action open_task_by_query and put those words in query. Do not require an exact title match.",
            "If Iris shows a task chooser because multiple cards matched, the user can click a choice or say first/second/third; use get_iris_ui_context to inspect pendingTaskMatches before opening a specific task.",
            "When a UI command is ambiguous, prefer the expanded task first, then the focused task, then the latest Hermes result. Keep the spoken acknowledgement short.",
            `When you call propose_hermes_task, write the 'task' as a clear brief about ${userDisplayName()}'s INTENT: the goal, the concrete details they actually said (names, numbers, dates, budgets, constraints), and the expected output/format. Hermes cannot hear this conversation, so the brief must stand alone — but NEVER tell Hermes HOW to do the work. Do not mention tools, skills, scripts, file paths, Notion pages, databases, planner pages, or any workflow mechanics, even if you know them from the user context: Hermes has its own skills and shares the same memory, and your guesses about mechanics can be stale and send it down the wrong path. Example: "Check this month's deals and summarize payment status" — NOT "Check the deals database linked from the active planner page".`,
            `EXCEPTION — repeats and follow-ups: if ${userDisplayName()} asks to re-run, refresh, or slightly tweak a task you ALREADY dispatched in this session, do NOT re-specify the whole task. Write a short continuation brief that names the previous task and tells Hermes to reuse its earlier work, e.g. "Re-run the July 2026 Notion deals analysis from earlier in this session and report the updated numbers — reuse your previous approach and results, re-checking only what may have changed." Hermes shares this session's transcript, so short continuation briefs run dramatically faster.`,
            `After submit_hermes_task returns "started", say one short acknowledgement like: On it, Hermes is handling that now. (Keep what you SAY to ${userDisplayName()} short, even though the task you SENT to Hermes is detailed.) If it returns "blocked", follow its instructions instead — do not claim the task was sent.`,
            `When you receive SYSTEM_EVENT_SESSION_START, immediately speak a warm welcome-back greeting to ${userDisplayName()} as instructed, without waiting for the user to talk first.`,
            `Power-saving behavior (never mention costs or tokens): if ${userDisplayName()} goes quiet for a while, the system may put you to sleep automatically — that is normal and needs no comment. When a Hermes result wakes you from sleep, the completion event will say so: deliver the update directly without a greeting, ask if anything else is needed, and if they stay silent just let the conversation rest.`,
            `When you receive SYSTEM_EVENT_HERMES_COMPLETE, treat it as a high-priority background result from Hermes. Proactively announce it even if ${userDisplayName()} was chatting with you. Keep it polite and short: say Hermes is back, summarize the result, and ask whether they want to go through it before continuing. If — and only if — the update interrupted a discussion that was genuinely mid-flow, pick it back up afterwards by naming the topic yourself. If there was no active discussion, simply stop after handling the result. Never ask "what were we discussing" — if you can't name the topic yourself, there is nothing to resume.`,
            "Only answer directly for greetings, quick chat, or status questions.",
            "Keep voice responses natural and short.",
          ].join("\n"),
        },
        ...userContextParts(),
      ],
    },
  };
}

// Personal context injected as its own system-instruction part. Kept separate so
// it is easy to see and so the brief-writing rules above can lean on it.
function userContextParts() {
  const { text, files } = loadUserContext();
  if (!text) return [];
  emitEvent({
    type: "log",
    level: "info",
    message: `Loaded user context (${text.length} chars) from ${files.join(", ")}.`,
  });
  return [
    {
      text: [
        `USER CONTEXT — personal profile and memory provided by ${userDisplayName()}.`,
        "Treat it as authoritative about who they are, their preferences, locations, budgets, tools, and recurring projects.",
        "Use it to resolve vague or shorthand requests (for example, understand what 'deals' or 'the usual' means for this user) and to speak to them naturally.",
        "Do NOT copy operational details from this context into Hermes briefs — no page names, database structure, script names, or workflow mechanics. Hermes shares this same memory and its skills own those mechanics; briefs carry the user's intent only.",
        "Never read this context aloud verbatim; just use it to act correctly.",
        "----- BEGIN USER CONTEXT -----",
        text,
        "----- END USER CONTEXT -----",
      ].join("\n"),
    },
  ];
}

function sendWelcomeGreeting() {
  if (welcomeGreeted || !liveSession) return;
  welcomeGreeted = true;
  if (welcomeFallbackTimer) {
    clearTimeout(welcomeFallbackTimer);
    welcomeFallbackTimer = null;
  }
  (async () => {
    let reachable = false;
    try {
      const status = await checkHermesStatus();
      reachable = Boolean(status.reachable);
    } catch {
      reachable = false;
    }
    if (!liveSession) return;

    const hermesLine = reachable
      ? "Hermes is online and all channels are connected, so we're good to go."
      : "I'm still bringing Hermes online, channels are connecting now.";

    const greeting =
      `SYSTEM_EVENT_SESSION_START: The session just started. Proactively greet ${userDisplayName()} out loud right now in a warm, concise way (1-2 sentences). ` +
      `Say something like: Hi ${userDisplayName()}, welcome back. ${hermesLine} Then ask what they have in mind. ` +
      "Speak this greeting immediately without waiting for the user to talk first.";

    liveSession.sendRealtimeInput({ text: greeting });
  })();
}

async function startLive() {
  // connectInFlight dedupes racing wake paths (renderer wake + the auto-wake
  // safety net can both call this within the same few seconds).
  if (liveSession || connectInFlight) return liveStatus;
  // A standby handle-refresh may be mid-rotation; let it finish so we resume
  // with the newest handle instead of racing it with a second connection.
  stopHandleRefresh();
  if (handleRefreshPromise) {
    try { await handleRefreshPromise; } catch { /* refresh failures are non-fatal */ }
    if (liveSession || connectInFlight) return liveStatus;
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    emitEvent({ type: "fatal", message: "GEMINI_API_KEY is not set." });
    throw new Error("GEMINI_API_KEY is not set");
  }

  const model = process.env.GEMINI_LIVE_MODEL || "models/gemini-3.1-flash-live-preview";
  // Resuming (handle < ~2h old) reconnects to the SAME conversation — full
  // context, no cold-start greeting. Otherwise it's a fresh session (after a
  // long nap the handle has expired server-side; Google's validity is 2h).
  const handle = freshResumeHandle();
  const resuming = Boolean(handle);
  resetHermesGate();
  intentionalClose = false;
  autoSlept = false;
  ai = new GoogleGenAI({ apiKey });
  // `resuming` rides along so the renderer can skip the boot ceremony when
  // the conversation is merely continuing (auto-wake, quick re-wake). A
  // Hermes-driven wake also skips it even on a fresh session — Iris starts
  // announcing immediately and must not talk over the boot animation.
  const resumingUi = resuming || pendingHermesAnnouncements.length > 0;
  emitEvent({ type: "sidecar_status", status: { running: true, model, mode: "webrtc-aec" }, resuming: resumingUi });
  emitEvent({ type: "gemini_status", status: "connecting", model, resuming: resumingUi });
  if (resuming) {
    emitEvent({ type: "log", level: "info", message: "Resuming the previous Gemini session (context preserved)." });
  }

  connectInFlight = true;
  closedDuringConnect = false;
  sessionUsedHandle = resuming;
  sessionConnectedAt = Date.now();
  try {
    liveSession = await ai.live.connect({
      model,
      config: buildLiveConfig(handle),
      callbacks: {
        onopen() {
          liveStatus = { running: true, pid: process.pid };
          sessionConnectedAt = Date.now();
          emitEvent({ type: "sidecar_status", status: { running: true, pid: process.pid, model, mode: "webrtc-aec" } });
          emitEvent({ type: "gemini_status", status: "connected", model });
          emitEvent({ type: "audio_state", state: "listening" });
          updateTrayMenu();
        },
        onmessage(message) {
          handleLiveMessage(message);
        },
        onerror(error) {
          emitEvent({ type: "fatal", message: "Gemini Live error", error: error?.message || String(error) });
        },
        onclose(event) {
          // The server can hang up while connect() is still resolving (e.g.
          // it rejects a resume handle at setup). Flag it; the main flow's
          // post-connect guard owns the retry in that case.
          if (connectInFlight) {
            closedDuringConnect = true;
            return;
          }
          flushTranscripts();
          liveSession = null;
          liveStatus = { running: false, pid: null };
          if (!intentionalClose) {
            const livedMs = Date.now() - sessionConnectedAt;
            // A connection that survived a while was healthy — its close is a
            // routine server reset (~10-min GoAway), not a failure streak.
            if (livedMs > 60000) reconnectAttempts = 0;
            // Hermes results that were sent but not yet confirmed spoken must
            // survive the drop — requeue them for the next connection.
            if (announcementsInFlight.length > 0) {
              pendingHermesAnnouncements.unshift(...announcementsInFlight);
              announcementsInFlight = [];
            }
            // A resumed connection dying within seconds means the server
            // rejected the handle (expired or invalidated). Drop it: a fresh
            // conversation beats a dead assistant.
            if (sessionUsedHandle && livedMs < 15000) {
              resumeHandle = null;
              emitEvent({
                type: "log",
                level: "warn",
                message: "The resume handle was rejected — reconnecting with a fresh session.",
              });
            }
            // Reconnect with backoff (0.5s, 2s, 8s, 32s): rides out GoAway
            // resets AND brief network blips during all-day sessions.
            if (reconnectAttempts < 4) {
              const delay = 500 * 4 ** reconnectAttempts;
              reconnectAttempts += 1;
              emitEvent({
                type: "log",
                level: "info",
                message: `Gemini connection dropped (${event?.reason || "server reset"}) — reconnecting in ${Math.round(delay / 1000) || 0.5}s…`,
              });
              setTimeout(() => {
                if (!liveSession && !intentionalClose && !connectInFlight) {
                  startLive().catch((error) => {
                    emitEvent({ type: "fatal", message: "Gemini reconnect failed", error: error?.message || String(error) });
                  });
                }
              }, delay);
              return;
            }
          }
          emitEvent({ type: "gemini_status", status: "offline" });
          emitEvent({ type: "audio_state", state: "idle" });
          emitEvent({ type: "sidecar_status", status: liveStatus, reason: event?.reason || "closed" });
        },
      },
    });
  } catch (error) {
    connectInFlight = false;
    if (handle) {
      // The stale resume token was refused at the door — retry fresh once.
      resumeHandle = null;
      emitEvent({
        type: "log",
        level: "warn",
        message: "Couldn't resume the previous session — starting a fresh one.",
      });
      return startLive();
    }
    emitEvent({ type: "gemini_status", status: "offline" });
    emitEvent({ type: "fatal", message: "Gemini Live connect failed", error: error?.message || String(error) });
    throw error;
  }
  connectInFlight = false;
  if (intentionalClose) {
    // stopLive() ran while we were still connecting — honor it, don't leak a
    // live session behind a sleeping UI.
    try { liveSession?.close(); } catch { /* ignore */ }
    liveSession = null;
    return liveStatus;
  }
  if (closedDuringConnect) {
    // connect() resolved but the server had already hung up — with a resume
    // handle in play that means it was rejected. Retry once without it.
    liveSession = null;
    closedDuringConnect = false;
    if (handle) {
      resumeHandle = null;
      emitEvent({
        type: "log",
        level: "warn",
        message: "The resume handle was rejected during setup — starting a fresh session.",
      });
      return startLive();
    }
    emitEvent({ type: "gemini_status", status: "offline" });
    throw new Error("Gemini Live closed during setup");
  }

  // Send AFTER connect resolves: onopen can fire before liveSession is assigned,
  // which would otherwise skip the queued announcements. Track what we send
  // until a turn completes, so a dying connection can't swallow results.
  const hadAnnouncements = pendingHermesAnnouncements.length > 0;
  while (pendingHermesAnnouncements.length > 0 && liveSession) {
    const text = pendingHermesAnnouncements.shift();
    announcementsInFlight.push(text);
    liveSession.sendRealtimeInput({ text });
  }

  if (resuming) {
    // The conversation never ended — no welcome ceremony on resume. If a
    // queued Hermes result is driving this wake, that announcement speaks;
    // otherwise (the user woke her) just a one-line "back with you".
    welcomeGreeted = true;
    if (welcomeFallbackTimer) {
      clearTimeout(welcomeFallbackTimer);
      welcomeFallbackTimer = null;
    }
    if (!hadAnnouncements && liveSession) {
      liveSession.sendRealtimeInput({
        text: "SYSTEM_EVENT_SESSION_RESUMED: Same conversation, context intact — the user is back. Say ONE very short line acknowledging you're here (no re-introduction, no recap unless asked).",
      });
    }
  } else if (hadAnnouncements) {
    // Fresh session (the handle aged out during a long nap) but a Hermes
    // result drove this wake: the announcement IS the greeting — a separate
    // welcome ceremony on top would talk over it.
    welcomeGreeted = true;
    if (welcomeFallbackTimer) {
      clearTimeout(welcomeFallbackTimer);
      welcomeFallbackTimer = null;
    }
  } else {
    // Defer the welcome greeting until the renderer's boot screen finishes
    // (iris:boot-done) so Iris doesn't start talking over the loading animation.
    // Safety net: greet anyway if that signal never arrives.
    welcomeGreeted = false;
    if (welcomeFallbackTimer) clearTimeout(welcomeFallbackTimer);
    welcomeFallbackTimer = setTimeout(() => sendWelcomeGreeting(), 8000);
  }

  // The cost meter: silence auto-closes the session (results auto-wake it).
  startAutoSleepTimer();

  return { running: true, pid: process.pid };
}

async function handleToolCall(toolCall) {
  const functionResponses = [];
  for (const call of toolCall.functionCalls || []) {
    emitEvent({ type: "tool_call", name: call.name, args: call.args || {} });
    try {
      const result = await executeTool(call.name, call.args || {});
      functionResponses.push({ id: call.id, name: call.name, response: { result } });
    } catch (error) {
      functionResponses.push({
        id: call.id,
        name: call.name,
        response: { status: "error", error: error.message },
      });
    }
  }
  if (functionResponses.length && liveSession) {
    liveSession.sendToolResponse({ functionResponses });
  }
}

function handleLiveMessage(message) {
  if (message.toolCall) {
    bumpVoiceActivity();
    handleToolCall(message.toolCall).catch((error) => {
      emitEvent({ type: "fatal", message: "Tool call failed", error: error.message });
    });
  }

  // Session resumption tokens: keep the newest resumable handle so sleep /
  // server resets can reconnect into the same conversation.
  if (message.sessionResumptionUpdate) {
    const update = message.sessionResumptionUpdate;
    if (update.resumable && update.newHandle) {
      resumeHandle = update.newHandle;
      resumeHandleAt = Date.now();
    }
  }

  if (message.goAway) {
    emitEvent({
      type: "log",
      level: "info",
      message: `Gemini server rotating the connection (${message.goAway.timeLeft || "soon"}) — will resume transparently.`,
    });
  }

  const content = message.serverContent;
  if (!content) return;

  if (content.interrupted) {
    flushTranscripts();
    // Barge-in counts as the read-back turn ending: the user is reacting to it.
    markModelTurnComplete();
    emitToRenderer("live:interrupt", {});
    emitEvent({ type: "audio_state", state: "listening" });
    return;
  }

  if (content.inputTranscription?.text) {
    userTranscriptBuffer += content.inputTranscription.text;
    if (userTranscriptBuffer.trim()) {
      markUserSpoke();
      bumpVoiceActivity(); // real recognized speech, not raw mic noise
    }
  }

  // The first sign of Iris responding means the user's turn is over, so push
  // their transcript to Comms right away instead of waiting for turnComplete.
  const hasModelOutput =
    Boolean(content.outputTranscription?.text) ||
    (content.modelTurn?.parts || []).some((part) => part.text || part.inlineData?.data);
  if (hasModelOutput) {
    flushUserTranscript();
    bumpVoiceActivity(); // Iris speaking resets the idle clock too
  }

  if (content.outputTranscription?.text) modelTranscriptBuffer += content.outputTranscription.text;

  for (const part of content.modelTurn?.parts || []) {
    if (part.text) modelTranscriptBuffer += part.text;
    const inlineData = part.inlineData;
    if (!inlineData?.data) continue;
    const mimeType = inlineData.mimeType || "audio/pcm;rate=24000";
    if (!mimeType.startsWith("audio/")) continue;
    emitToRenderer("live:audio", { data: inlineData.data, mimeType });
    emitEvent({ type: "audio_state", state: "speaking" });
  }

  if (content.turnComplete) {
    flushTranscripts();
    markModelTurnComplete();
    bumpVoiceActivity();
    // A finished spoken turn confirms any queued Hermes announcements were
    // actually delivered — stop protecting them against connection loss.
    // It also proves the session is healthy, so the reconnect budget refills.
    announcementsInFlight = [];
    reconnectAttempts = 0;
    emitEvent({ type: "audio_state", state: "listening" });
  }
}

async function stopLive() {
  welcomeGreeted = true;
  resetHermesGate();
  stopAutoSleepTimer();
  intentionalClose = true;
  if (welcomeFallbackTimer) {
    clearTimeout(welcomeFallbackTimer);
    welcomeFallbackTimer = null;
  }
  if (liveSession) {
    try { liveSession.close(); } catch { /* ignore close races */ }
  }
  liveSession = null;
  liveStatus = { running: false, pid: null };
  emitToRenderer("live:interrupt", {});
  emitEvent({ type: "gemini_status", status: "offline" });
  emitEvent({ type: "audio_state", state: "idle" });
  emitEvent({ type: "sidecar_status", status: liveStatus });
  updateTrayMenu();
  // Sleep of either kind (manual or standby) keeps the conversation resumable:
  // rotate the handle in the background so even an overnight nap wakes into
  // the same conversation.
  scheduleHandleRefresh();
  return liveStatus;
}

// ===== Standby handle keep-alive =====
// Google invalidates resumption handles 2h after disconnect. During long naps
// (overnight standby) we briefly reconnect — headless, no UI wake, no audio,
// no tokens billed — purely to be issued a fresh handle, then hang up. The
// conversation stays resumable indefinitely.
function stopHandleRefresh() {
  if (handleRefreshTimer) {
    clearTimeout(handleRefreshTimer);
    handleRefreshTimer = null;
  }
}

function runHandleRefreshNow() {
  if (handleRefreshPromise || liveSession || connectInFlight) return;
  handleRefreshPromise = refreshResumeHandle().finally(() => {
    handleRefreshPromise = null;
    // Keep rotating for as long as the nap lasts.
    if (!liveSession && !connectInFlight) scheduleHandleRefresh();
  });
}

function scheduleHandleRefresh() {
  stopHandleRefresh();
  if (!freshResumeHandle()) return;
  // Fire when the handle turns HANDLE_REFRESH_AGE_MS old (scheduled off the
  // handle's own timestamp, so late timers and reschedules stay correct). A
  // past-due handle (failed attempt, timer drift, system sleep) retries on
  // the short interval instead — freshResumeHandle() ends the loop once the
  // handle truly expires, and the fresh-session fallback covers the wake.
  const age = Date.now() - resumeHandleAt;
  const delay = Math.max(age >= HANDLE_REFRESH_AGE_MS ? HANDLE_REFRESH_RETRY_MS : HANDLE_REFRESH_AGE_MS - age, 15000);
  handleRefreshTimer = setTimeout(() => {
    handleRefreshTimer = null;
    runHandleRefreshNow();
  }, delay);
}

async function refreshResumeHandle() {
  if (liveSession || connectInFlight) return false;
  const handle = freshResumeHandle();
  const apiKey = process.env.GEMINI_API_KEY;
  if (!handle || !apiKey) return false;
  const model = process.env.GEMINI_LIVE_MODEL || "models/gemini-3.1-flash-live-preview";
  let gotNewHandle = false;
  try {
    const client = ai || new GoogleGenAI({ apiKey });
    // Deliberately NOT startLive(): no tools, no renderer events, no greeting.
    // The server sends a sessionResumptionUpdate shortly after setup; we take
    // the new handle and leave.
    const session = await client.live.connect({
      model,
      config: {
        responseModalities: ["AUDIO"],
        sessionResumption: { handle },
      },
      callbacks: {
        onopen() {},
        onmessage(message) {
          const update = message.sessionResumptionUpdate;
          if (update?.resumable && update.newHandle) {
            resumeHandle = update.newHandle;
            resumeHandleAt = Date.now();
            gotNewHandle = true;
          }
        },
        onerror() {},
        onclose() {},
      },
    });
    let waited = 0;
    while (!gotNewHandle && waited < 12000) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      waited += 250;
      // Nudge: a sliver of silent PCM counts as activity and prompts an
      // update, without triggering any model response (VAD hears nothing).
      if (waited === 4000) {
        try {
          session.sendRealtimeInput({
            audio: { data: Buffer.alloc(3200).toString("base64"), mimeType: "audio/pcm;rate=16000" },
          });
        } catch { /* connection may already be gone */ }
      }
    }
    try { session.close(); } catch { /* ignore close races */ }
    emitEvent({
      type: "log",
      level: gotNewHandle ? "info" : "warn",
      message: gotNewHandle
        ? "Standby: renewed the session handle — the conversation stays resumable."
        : "Standby: handle renewal got no update; if it expires, the next wake starts fresh.",
    });
  } catch (error) {
    emitEvent({ type: "log", level: "warn", message: `Standby handle renewal failed: ${error?.message || error}` });
  }
  return gotNewHandle;
}

// ===== Auto-sleep (idle) =====
function stopAutoSleepTimer() {
  if (autoSleepTimer) {
    clearInterval(autoSleepTimer);
    autoSleepTimer = null;
  }
}

function startAutoSleepTimer() {
  stopAutoSleepTimer();
  const ms = autoSleepMs();
  if (!ms) return;
  bumpVoiceActivity();
  autoSleepTimer = setInterval(() => {
    if (!liveSession) return;
    // A proposal awaiting the user's yes/no gets triple the patience — they
    // may be thinking it over.
    const limit = hasPendingProposal() ? ms * 3 : ms;
    const idleFor = Date.now() - lastVoiceActivityAt;
    if (idleFor >= limit) void autoVoiceSleep(idleFor);
  }, 5000);
}

async function autoVoiceSleep(idleForMs) {
  if (!liveSession) return;
  autoSlept = true;
  emitEvent({
    type: "log",
    level: "info",
    message: `Standby: quiet for ${Math.round(idleForMs / 1000)}s — closing the Gemini session (context kept for resume; Hermes results wake Iris).`,
  });
  // The renderer tears down mic/audio but keeps the camera and HUD alive.
  emitToRenderer("iris:auto-sleep", { reason: "idle" });
  await stopLive();
}

// ===== Auto-wake (Hermes completions while asleep) =====
let autoWakePending = false;

function requestAutoWake(reason) {
  if (liveSession || autoWakePending || !autoWakeOnHermes()) return;
  autoWakePending = true;
  emitEvent({ type: "log", level: "info", message: `Auto-wake: ${reason}` });
  // Normal path: the renderer runs its full wake flow (mic capture + live
  // session). Safety net: if it didn't come up, start the session directly —
  // the announcement must not be lost.
  emitToRenderer("iris:wake", {});
  setTimeout(() => {
    autoWakePending = false;
    if (!liveSession) {
      startLive().catch((error) => {
        emitEvent({ type: "log", level: "warn", message: `Auto-wake failed: ${error?.message || error}` });
      });
    }
  }, 4000);
}

function sendAudioChunk(arrayBuffer) {
  if (!liveSession || !arrayBuffer) return;
  const buffer = Buffer.from(new Uint8Array(arrayBuffer));
  if (!buffer.byteLength) return;
  liveSession.sendRealtimeInput({
    audio: { data: buffer.toString("base64"), mimeType: "audio/pcm;rate=16000" },
  });
}

function sendCommand(command) {
  if (command?.type === "text" && command.text) {
    if (!liveSession) throw new Error("Gemini Live is not running");
    bumpVoiceActivity();
    liveSession.sendRealtimeInput({ text: command.text });
  }
  if (command?.type === "submit_hermes_task" && command.task) {
    submitHermesTask({ task: command.task }).catch((error) => {
      emitEvent({ type: "hermes_task_update", status: "error", task: command.task, error: error.message });
    });
  }
}

function createWindow() {
  // Transparent from birth so the same window can morph into the Glass HUD
  // overlay. The deck paints its own rounded background in CSS. Instead of a
  // frame we use titleBarStyle:hiddenInset — macOS renders its REAL traffic
  // lights (native hover glyphs, tiling menu, focus dimming) over our content;
  // they're hidden while in HUD mode.
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 1120,
    minHeight: 820,
    show: false,
    titleBarStyle: "hiddenInset",
    // Vertically centered on the 42px top bar (12px deck padding + 21 - 6).
    trafficLightPosition: { x: 22, y: 27 },
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    fullscreenable: false,
    ...(appIcon ? { icon: appIcon } : {}),
    webPreferences: {
      preload: path.join(repoRoot, "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Audio capture/playback and the HUD must keep running when occluded.
      backgroundThrottling: false,
    },
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173";
  const useProd = app.isPackaged || process.env.IRIS_START_PROD === "1";
  if (useProd) mainWindow.loadFile(path.join(repoRoot, "dist", "index.html"));
  else mainWindow.loadURL(devUrl);
  // Avoid a translucent first-paint flash on the transparent window.
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
    uiMode = "deck";
  });
}

// ===== Glass HUD =====
// One window, two shapes. Deck: a normal rounded app window. HUD: the same
// window stretched over the whole screen, transparent, always on top, and
// click-through except where the renderer marks interactive elements — Iris
// floats over everything while you keep working underneath.
let uiMode = "deck";
let deckBounds = null;

function enterHud() {
  if (!mainWindow || uiMode === "hud") return;
  uiMode = "hud";
  deckBounds = mainWindow.getBounds();
  // Let the renderer fade the deck out before the window jumps to full screen.
  emitToRenderer("hud:mode", { mode: "hud" });
  // The OS traffic lights must not float over the fullscreen overlay.
  try { mainWindow.setWindowButtonVisibility(false); } catch { /* non-mac */ }
  setTimeout(() => {
    if (!mainWindow || uiMode !== "hud") return;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    mainWindow.setHasShadow(false);
    mainWindow.setMinimumSize(1, 1);
    mainWindow.setBounds(display.bounds);
    mainWindow.setAlwaysOnTop(true, "screen-saver");
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
    mainWindow.show();
  }, 170);
}

function exitHud() {
  if (!mainWindow || uiMode === "deck") return;
  uiMode = "deck";
  mainWindow.setIgnoreMouseEvents(false);
  // Tell the renderer first (the deck mounts invisible and fades in), then
  // restore the window while it's still transparent — no stretched flash.
  emitToRenderer("hud:mode", { mode: "deck" });
  setTimeout(() => {
    if (!mainWindow || uiMode !== "deck") return;
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setVisibleOnAllWorkspaces(false);
    mainWindow.setHasShadow(true);
    mainWindow.setMinimumSize(1120, 820);
    if (deckBounds) mainWindow.setBounds(deckBounds);
    try {
      mainWindow.setWindowButtonVisibility(true);
      // Bounds changes can reset the native buttons to the default corner
      // (Electron quirk) — re-pin them to the deck's top-bar position.
      mainWindow.setWindowButtonPosition({ x: 22, y: 27 });
    } catch { /* non-mac */ }
    mainWindow.show();
    mainWindow.focus();
  }, 170);
}

function toggleHud() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (uiMode === "hud") exitHud();
  else enterHud();
}

// ===== Tray (menu-bar presence) =====
let tray = null;

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: liveStatus.running ? "Sleep Iris" : "Wake Iris",
        click: () => emitToRenderer(liveStatus.running ? "iris:sleep" : "iris:wake", {}),
      },
      { label: uiMode === "hud" ? "Exit Glass HUD" : "Enter Glass HUD", click: () => toggleHud() },
      { type: "separator" },
      {
        label: "Show Deck",
        click: () => {
          if (!mainWindow) createWindow();
          else {
            exitHud();
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      { type: "separator" },
      { label: "Quit Iris", role: "quit" },
    ]),
  );
}

function createTray() {
  const trayIconPath = path.join(repoRoot, "build", "trayTemplate.png");
  if (!fs.existsSync(trayIconPath)) return;
  tray = new Tray(trayIconPath);
  tray.setToolTip("Iris");
  updateTrayMenu();
}

function hudHotkey() {
  return process.env.IRIS_HUD_HOTKEY || "Alt+H";
}

function installAppMenu() {
  if (process.platform !== "darwin") return;
  app.setAboutPanelOptions({
    applicationName: "Iris",
    applicationVersion: app.getVersion(),
    ...(appIcon ? { iconPath } : {}),
  });
  const menu = Menu.buildFromTemplate([
    {
      label: "Iris",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  if (appIcon && process.platform === "darwin" && app.dock) {
    app.dock.setIcon(appIcon);
  }
  installAppMenu();

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media" || permission === "audioCapture" || permission === "videoCapture");
  });

  // macOS system sleep freezes all timers, so a scheduled handle renewal may
  // have been missed entirely. The moment the Mac wakes, renew immediately if
  // Iris is napping and the handle survived; if it already expired, the
  // fresh-session fallback covers the next wake.
  powerMonitor.on("resume", () => {
    if (!liveSession && !connectInFlight && freshResumeHandle()) {
      stopHandleRefresh();
      runHandleRefreshNow();
    }
  });

  ipcMain.handle("sidecar:start", () => startLive());
  ipcMain.handle("sidecar:stop", () => stopLive());
  ipcMain.handle("sidecar:status", () => liveStatus);
  ipcMain.handle("app:config", () => appConfig());
  ipcMain.handle("config:get", () => getFullConfig());
  ipcMain.handle("config:save", (_event, updates) => {
    const config = writeUserConfig(updates);
    watchBrainVault(); // vault path may have changed
    return config;
  });
  ipcMain.handle("config:test-gemini", (_event, payload) => testGeminiKey(payload?.key));
  ipcMain.handle("config:test-hermes", (_event, payload) => testHermesConnection(payload || {}));
  ipcMain.handle("config:preview-voice", (_event, payload) => previewVoice(payload || {}));
  ipcMain.handle("hermes:history", () => fetchHermesHistory());
  ipcMain.handle("hermes:sessions", () => listHermesSessions());
  ipcMain.handle("hermes:create-session", () => createHermesSession());
  ipcMain.handle("brain:load", () => loadBrainGraph());
  ipcMain.handle("brain:read", (_event, relPath) => readBrainNote(String(relPath || "")));
  ipcMain.handle("brain:search", (_event, query, topK) => searchBrain(query, topK));
  ipcMain.handle("brain:filter", (_event, query) => filterBrainNotes(query));
  // Settings button: build/refresh the semantic index on demand. Accepts
  // unsaved draft values so it works before the user hits Save. Incremental
  // by nature — the first run embeds everything, later runs only the delta.
  ipcMain.handle("brain:sync-index", async (_event, payload = {}) => {
    const rawVault = String(payload?.vault || "").trim() || (process.env.IRIS_BRAIN_PATH || "").trim();
    const apiKey = String(payload?.key || "").trim() || (process.env.GEMINI_API_KEY || "").trim();
    if (!rawVault) return { ok: false, error: "Set the brain vault path first." };
    if (!apiKey) return { ok: false, error: "Enter your Gemini API key first." };
    const vaultRoot = resolveContextPath(rawVault);
    if (!fs.existsSync(vaultRoot)) return { ok: false, error: `Vault not found: ${vaultRoot}` };
    try {
      const result = await syncBrainIndex({ vaultRoot, apiKey });
      if (vaultRoot === brainRoot()) {
        brainSearch.index = result.index;
        if (!brainSearch.lexicon || brainSearch.root !== vaultRoot) refreshBrainSearch();
        watchBrainVault(); // first sync creates the index dir — start watching it
        scheduleBrainChanged(); // live-refresh an open map
      }
      return {
        ok: true,
        total: result.total,
        embedded: result.embedded,
        reused: result.reused,
        pruned: result.pruned,
        ms: result.ms,
        model: result.model,
        location: indexDirFor(vaultRoot),
      };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  });
  ipcMain.handle("app:open-external", (_event, url) => {
    const target = String(url || "");
    if (/^https?:\/\//i.test(target)) shell.openExternal(target);
  });
  ipcMain.handle("hud:toggle", () => {
    toggleHud();
    updateTrayMenu();
    return { mode: uiMode };
  });
  ipcMain.on("hud:interactive", (_event, on) => {
    if (mainWindow && uiMode === "hud") {
      mainWindow.setIgnoreMouseEvents(!on, { forward: true });
    }
  });
  ipcMain.handle("sidecar:command", (_event, command) => sendCommand(command));
  ipcMain.on("live:audio", (_event, chunk) => sendAudioChunk(chunk));
  ipcMain.on("iris:boot-done", () => sendWelcomeGreeting());
  ipcMain.on("iris:ui-context", (_event, context) => {
    if (context && typeof context === "object") {
      irisUiContext = context;
    }
  });
  createWindow();
  createTray();
  // Warm the brain search shortly after launch so the first voice recall
  // answers instantly, even before the Neural Map is ever opened. This is
  // always free (lexicon rebuild + loading cached vectors); it embeds new
  // notes only when IRIS_BRAIN_AUTO_INDEX is enabled.
  setTimeout(() => refreshBrainSearch(), 4000);
  // If the Hermes API is down, bring the gateway up so dispatches just work.
  setTimeout(() => void ensureHermesRunning(), 1500);
  // Hot reload: vault or index changes (Hermes sync, Obsidian edits, manual
  // re-index) refresh the app live — no restart needed.
  watchBrainVault();
  const registered = globalShortcut.register(hudHotkey(), () => {
    toggleHud();
    updateTrayMenu();
  });
  if (!registered) {
    emitEvent({ type: "log", level: "error", message: `Could not register HUD hotkey ${hudHotkey()}.` });
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("before-quit", () => stopLive());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
