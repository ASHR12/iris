import electron from "electron";
import { GoogleGenAI } from "@google/genai";
import {
  proposeHermesTask as gatePropose,
  claimConfirmedProposal,
  markModelTurnComplete,
  markUserSpoke,
  resetHermesGate,
} from "./hermesGate.mjs";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const { app, BrowserWindow, ipcMain, session, nativeImage, Menu, Tray, screen, globalShortcut } = electron;

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
    userName: process.env.IRIS_USER_NAME || "",
    loadTestData: envFlag("IRIS_LOAD_TEST_DATA", false),
    wakeWord: envFlag("IRIS_WAKE_WORD", false),
    sounds: envFlag("IRIS_SOUNDS", true),
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
      "You are invoked from Iris voice. Work autonomously. Do not ask Iris for clarification unless absolutely impossible. Use sensible defaults and report concise final results.",
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
    "- Do not say you personally did the work; Hermes did.",
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
    liveSession.sendRealtimeInput({ text: eventText });
  } else {
    pendingHermesAnnouncements.push(eventText);
  }
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
            "STEP 1 of dispatching work to Hermes (deals, shopping, research, coding, file work, terminal tasks, summaries, automations — anything requiring tools). Stages the task brief WITHOUT sending it. After calling this, read the brief back to the user, ask for confirmation, and end your turn. IMPORTANT: Hermes cannot see this voice conversation — the 'task' string is the ONLY context it gets, so write a complete, self-contained brief, not a short paraphrase.",
          parameters: {
            type: "object",
            properties: {
              task: {
                type: "string",
                description:
                  "A complete, self-contained task brief for Hermes written in clear English. Expand the user's spoken request into a precise instruction: include the goal, every concrete detail the user gave (names, numbers, URLs, dates, budgets, preferences, constraints), any sensible defaults you assumed, and the expected output/format. Write it as if Hermes has no prior context.",
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
          name: "control_iris_ui",
          description:
            "Control the Iris UI directly for UI-only requests. Use this instead of Hermes when the user asks to open/show/close the current result, latest Hermes result, task history, or overlays.",
          parameters: {
            type: "object",
            properties: {
              action: {
                type: "string",
                description:
                  "One of: open_latest_hermes_result, open_current_hermes_result, open_task, open_task_by_query, open_hermes_history, close_reader, close_history, close_all_overlays, show_task_steps, hide_task_steps. Use show_task_steps/hide_task_steps to expand or collapse the tool-step timeline for a Hermes task; when the user names a specific card, pass its words in `query` (or its exact id in `target_id`). With no target, steps default to the card the user is currently viewing (open reader / focused), then the running task.",
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

function buildLiveConfig() {
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
    contextWindowCompression: {
      triggerTokens: 104857,
      slidingWindow: { targetTokens: 52428 },
    },
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
            "Also handle these UI-only commands with control_iris_ui (never Hermes): 'show the steps' / 'what is it doing' / 'show what tools it used' -> show_task_steps; 'hide the steps' -> hide_task_steps. If they name a specific card ('steps for the deals one', 'steps for the second card'), pass those words in query. With no target named, steps apply to the card they are viewing (open reader first), else the running task.",
            "If the user refers to a task by partial words from the task header, like 'open the failed one', 'open Hermes API', 'open package Iris', or 'open two hand design', call control_iris_ui with action open_task_by_query and put those words in query. Do not require an exact title match.",
            "If Iris shows a task chooser because multiple cards matched, the user can click a choice or say first/second/third; use get_iris_ui_context to inspect pendingTaskMatches before opening a specific task.",
            "When a UI command is ambiguous, prefer the expanded task first, then the focused task, then the latest Hermes result. Keep the spoken acknowledgement short.",
            `When you call propose_hermes_task, write the 'task' as a COMPLETE, self-contained brief. Hermes cannot hear this conversation, so do not send a short paraphrase. Expand what ${userDisplayName()} said into a precise, detailed instruction that captures the goal, every concrete detail mentioned (names, numbers, URLs, dates, budgets, preferences, constraints), any reasonable defaults you are assuming, and the expected result/format. Write it as if Hermes has zero prior context.`,
            `After submit_hermes_task returns "started", say one short acknowledgement like: On it, Hermes is handling that now. (Keep what you SAY to ${userDisplayName()} short, even though the task you SENT to Hermes is detailed.) If it returns "blocked", follow its instructions instead — do not claim the task was sent.`,
            `When you receive SYSTEM_EVENT_SESSION_START, immediately speak a warm welcome-back greeting to ${userDisplayName()} as instructed, without waiting for the user to talk first.`,
            `When you receive SYSTEM_EVENT_HERMES_COMPLETE, treat it as a high-priority background result from Hermes. Proactively announce it even if ${userDisplayName()} was chatting with you. Keep it polite and short: say Hermes is back, summarize the result, and ask whether they want to go through it before continuing.`,
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
        "Use it to resolve vague or shorthand requests and, most importantly, to write COMPLETE and ACCURATE Hermes briefs (for example, infer what 'deals' or 'the usual' means for this user, and fill in concrete details they did not say out loud).",
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
  if (liveSession) return liveStatus;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    emitEvent({ type: "fatal", message: "GEMINI_API_KEY is not set." });
    throw new Error("GEMINI_API_KEY is not set");
  }

  const model = process.env.GEMINI_LIVE_MODEL || "models/gemini-3.1-flash-live-preview";
  resetHermesGate();
  ai = new GoogleGenAI({ apiKey });
  emitEvent({ type: "sidecar_status", status: { running: true, model, mode: "webrtc-aec" } });
  emitEvent({ type: "gemini_status", status: "connecting", model });

  liveSession = await ai.live.connect({
    model,
    config: buildLiveConfig(),
    callbacks: {
      onopen() {
        liveStatus = { running: true, pid: process.pid };
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
        flushTranscripts();
        liveSession = null;
        liveStatus = { running: false, pid: null };
        emitEvent({ type: "gemini_status", status: "offline" });
        emitEvent({ type: "audio_state", state: "idle" });
        emitEvent({ type: "sidecar_status", status: liveStatus, reason: event?.reason || "closed" });
      },
    },
  });

  // Send AFTER connect resolves: onopen can fire before liveSession is assigned,
  // which would otherwise skip the queued announcements.
  while (pendingHermesAnnouncements.length > 0 && liveSession) {
    liveSession.sendRealtimeInput({ text: pendingHermesAnnouncements.shift() });
  }

  // Defer the welcome greeting until the renderer's boot screen finishes
  // (iris:boot-done) so Iris doesn't start talking over the loading animation.
  // Safety net: greet anyway if that signal never arrives.
  welcomeGreeted = false;
  if (welcomeFallbackTimer) clearTimeout(welcomeFallbackTimer);
  welcomeFallbackTimer = setTimeout(() => sendWelcomeGreeting(), 8000);

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
    handleToolCall(message.toolCall).catch((error) => {
      emitEvent({ type: "fatal", message: "Tool call failed", error: error.message });
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
    if (userTranscriptBuffer.trim()) markUserSpoke();
  }

  // The first sign of Iris responding means the user's turn is over, so push
  // their transcript to Comms right away instead of waiting for turnComplete.
  const hasModelOutput =
    Boolean(content.outputTranscription?.text) ||
    (content.modelTurn?.parts || []).some((part) => part.text || part.inlineData?.data);
  if (hasModelOutput) flushUserTranscript();

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
    emitEvent({ type: "audio_state", state: "listening" });
  }
}

async function stopLive() {
  welcomeGreeted = true;
  resetHermesGate();
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
  return liveStatus;
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
    liveSession.sendRealtimeInput({ text: command.text });
  }
  if (command?.type === "submit_hermes_task" && command.task) {
    submitHermesTask({ task: command.task }).catch((error) => {
      emitEvent({ type: "hermes_task_update", status: "error", task: command.task, error: error.message });
    });
  }
}

function createWindow() {
  // Frameless + transparent from birth so the same window can morph into the
  // Glass HUD overlay. The deck paints its own rounded background in CSS, and
  // the top bar provides custom window controls (native traffic lights don't
  // exist on transparent windows).
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 1120,
    minHeight: 820,
    show: false,
    frame: false,
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
  return process.env.IRIS_HUD_HOTKEY || "Alt+Space";
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

  ipcMain.handle("sidecar:start", () => startLive());
  ipcMain.handle("sidecar:stop", () => stopLive());
  ipcMain.handle("sidecar:status", () => liveStatus);
  ipcMain.handle("app:config", () => appConfig());
  ipcMain.handle("config:get", () => getFullConfig());
  ipcMain.handle("config:save", (_event, updates) => writeUserConfig(updates));
  ipcMain.handle("config:test-gemini", (_event, payload) => testGeminiKey(payload?.key));
  ipcMain.handle("config:test-hermes", (_event, payload) => testHermesConnection(payload || {}));
  ipcMain.handle("config:preview-voice", (_event, payload) => previewVoice(payload || {}));
  ipcMain.handle("hermes:history", () => fetchHermesHistory());
  ipcMain.handle("hermes:sessions", () => listHermesSessions());
  ipcMain.handle("hermes:create-session", () => createHermesSession());
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
  ipcMain.on("win:control", (_event, action) => {
    if (!mainWindow) return;
    if (action === "close") mainWindow.close();
    else if (action === "minimize") mainWindow.minimize();
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
