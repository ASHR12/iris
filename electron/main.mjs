import electron from "electron";
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const { app, BrowserWindow, ipcMain, session, nativeImage, Menu } = electron;

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

function flushTranscripts() {
  if (userTranscriptBuffer.trim()) {
    emitEvent({ type: "transcript", speaker: "you", text: userTranscriptBuffer.trim() });
  }
  if (modelTranscriptBuffer.trim()) {
    emitEvent({ type: "transcript", speaker: "gemini", text: modelTranscriptBuffer.trim() });
  }
  userTranscriptBuffer = "";
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

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function appConfig() {
  return {
    loadTestData: envFlag("IRIS_LOAD_TEST_DATA", false),
    userName: userDisplayName(),
  };
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

async function submitHermesTask({ task, session_id = "iris-voice", urgency = "normal" }) {
  if (!task || !String(task).trim()) {
    return { status: "error", error: "Task is required." };
  }
  const cleanTask = String(task).trim();
  emitEvent({ type: "hermes_task_update", status: "starting", task: cleanTask });
  const run = await hermesRequest("POST", "/v1/runs", {
    input: cleanTask,
    session_id,
    instructions:
      "You are invoked from Iris voice. Work autonomously. Do not ask Iris for clarification unless absolutely impossible. Use sensible defaults and report concise final results.",
  });
  const runId = run.run_id || run.id;
  emitEvent({ type: "hermes_task_update", status: "started", task: cleanTask, run_id: runId, urgency });
  if (runId) watchHermesRun(runId, cleanTask);
  return { status: "started", run_id: runId, message: "Hermes has started the task." };
}

async function getHermesTaskStatus({ run_id }) {
  return hermesRequest("GET", `/v1/runs/${run_id}`);
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
    case "submit_hermes_task":
      return submitHermesTask(args);
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
          name: "submit_hermes_task",
          description:
            "Immediately hand actionable work to Hermes. Invoke for deals, shopping, research, coding, file work, terminal tasks, summaries, automations, or anything requiring tools. Do not ask the user clarifying questions first. IMPORTANT: Hermes cannot see this voice conversation — the 'task' string is the ONLY context it gets. So you must write a complete, self-contained brief, not a short paraphrase.",
          parameters: {
            type: "object",
            properties: {
              task: {
                type: "string",
                description:
                  "A complete, self-contained task brief for Hermes written in clear English. Expand the user's spoken request into a precise instruction: include the goal, every concrete detail the user gave (names, numbers, URLs, dates, budgets, preferences, constraints), any sensible defaults you assumed, and the expected output/format. Do NOT compress it into a few words; write the full task as if Hermes has no prior context.",
              },
              session_id: { type: "string", description: "Stable session id. Default iris-voice." },
              urgency: { type: "string", description: "low, normal, or high." },
            },
            required: ["task"],
          },
        },
        {
          name: "get_hermes_task_status",
          description: "Fetch the latest status for a Hermes run.",
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
                  "One of: open_latest_hermes_result, open_current_hermes_result, open_task, open_task_by_query, open_hermes_history, close_reader, close_history, close_all_overlays, show_task_steps, hide_task_steps. Use show_task_steps/hide_task_steps to expand or collapse the live tool-step timeline on a Hermes card (defaults to the currently running task).",
              },
              target_id: {
                type: "string",
                description:
                  "Optional Hermes task id for open_task, show_task_steps, or hide_task_steps. If omitted for steps, Iris uses the currently running task.",
              },
              query: {
                type: "string",
                description:
                  "Loose words from the user for open_task_by_query, e.g. 'failed one', 'Hermes API', 'package Iris', 'two hand design'. The renderer will fuzzy-match this against visible task titles/status. If several cards match closely, Iris will show a chooser overlay with the top matches instead of guessing.",
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
            `CRITICAL: Be decisive. Do not ask clarifying questions for actionable tasks. If ${userDisplayName()} asks for a deal, research, coding, checking something, building something, or any work, immediately call submit_hermes_task with the request.`,
            "Routing rule: quick answer or fact lookup -> Google Search; multi-step work, monitoring, files, email, deals, coding, automation, or anything that should continue in the background -> Hermes.",
            "UI control rule: If the user says things like 'open it', 'open that result', 'show latest Hermes result', 'show history', 'close it', 'go back', or 'open the current task', use get_iris_ui_context and control_iris_ui. Do not send those UI-only commands to Hermes.",
            "Also handle these UI-only commands with control_iris_ui (never Hermes): 'show the steps' / 'what is it doing' / 'show what tools it used' -> show_task_steps (defaults to the running task; pass target_id only if they name a specific card); 'hide the steps' -> hide_task_steps.",
            "If the user refers to a task by partial words from the task header, like 'open the failed one', 'open Hermes API', 'open package Iris', or 'open two hand design', call control_iris_ui with action open_task_by_query and put those words in query. Do not require an exact title match.",
            "If Iris shows a task chooser because multiple cards matched, the user can click a choice or say first/second/third; use get_iris_ui_context to inspect pendingTaskMatches before opening a specific task.",
            "When a UI command is ambiguous, prefer the expanded task first, then the focused task, then the latest Hermes result. Keep the spoken acknowledgement short.",
            `When you call submit_hermes_task, write the 'task' as a COMPLETE, self-contained brief. Hermes cannot hear this conversation, so do not send a short paraphrase. Expand what ${userDisplayName()} said into a precise, detailed instruction that captures the goal, every concrete detail mentioned (names, numbers, URLs, dates, budgets, preferences, constraints), any reasonable defaults you are assuming, and the expected result/format. Write it as if Hermes has zero prior context.`,
            `After submit_hermes_task returns, say one short acknowledgement like: On it, Hermes is handling that now. (Keep what you SAY to ${userDisplayName()} short, even though the task you SENT to Hermes is detailed.)`,
            `When you receive SYSTEM_EVENT_SESSION_START, immediately speak a warm welcome-back greeting to ${userDisplayName()} as instructed, without waiting for the user to talk first.`,
            `When you receive SYSTEM_EVENT_HERMES_COMPLETE, treat it as a high-priority background result from Hermes. Proactively announce it even if ${userDisplayName()} was chatting with you. Keep it polite and short: say Hermes is back, summarize the result, and ask whether they want to go through it before continuing.`,
            "Only answer directly for greetings, quick chat, or status questions.",
            "Keep voice responses natural and short.",
          ].join("\n"),
        },
      ],
    },
  };
}

function sendWelcomeGreeting() {
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
        while (pendingHermesAnnouncements.length > 0 && liveSession) {
          liveSession.sendRealtimeInput({ text: pendingHermesAnnouncements.shift() });
        }
        sendWelcomeGreeting();
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
    emitToRenderer("live:interrupt", {});
    emitEvent({ type: "audio_state", state: "listening" });
    return;
  }

  if (content.inputTranscription?.text) userTranscriptBuffer += content.inputTranscription.text;
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
    emitEvent({ type: "audio_state", state: "listening" });
  }
}

async function stopLive() {
  if (liveSession) {
    try { liveSession.close(); } catch { /* ignore close races */ }
  }
  liveSession = null;
  liveStatus = { running: false, pid: null };
  emitToRenderer("live:interrupt", {});
  emitEvent({ type: "gemini_status", status: "offline" });
  emitEvent({ type: "audio_state", state: "idle" });
  emitEvent({ type: "sidecar_status", status: liveStatus });
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
    submitHermesTask({ task: command.task, session_id: command.session_id || "iris-voice" }).catch((error) => {
      emitEvent({ type: "hermes_task_update", status: "error", task: command.task, error: error.message });
    });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 980,
    minHeight: 800,
    backgroundColor: "#050712",
    ...(appIcon ? { icon: appIcon } : {}),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    vibrancy: "under-window",
    webPreferences: {
      preload: path.join(repoRoot, "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173";
  const useProd = app.isPackaged || process.env.IRIS_START_PROD === "1";
  if (useProd) mainWindow.loadFile(path.join(repoRoot, "dist", "index.html"));
  else mainWindow.loadURL(devUrl);
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
  ipcMain.handle("sidecar:command", (_event, command) => sendCommand(command));
  ipcMain.on("live:audio", (_event, chunk) => sendAudioChunk(chunk));
  ipcMain.on("iris:ui-context", (_event, context) => {
    if (context && typeof context === "object") {
      irisUiContext = context;
    }
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => stopLive());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
