import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Cpu,
  FileText,
  Globe,
  Hand,
  History,
  MessageSquare,
  Mic,
  MicOff,
  Power,
  Radio,
  Search,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ReactorCore from "./ReactorCore";
import BootSequence from "./BootSequence";
import { useHandControl, type HandState } from "./useHandControl";
import { makeUiTestData } from "./uiTestData";

type ReactorState = "idle" | "online" | "listening" | "speaking" | "working";

// One Hermes tool invocation, surfaced live from the SSE event stream.
type TaskStep = {
  id: string;
  tool: string;
  preview?: string;
  status: "running" | "done" | "error";
  duration?: number;
  ts: number;
};

type TaskCard = {
  id: string;
  task: string;
  status: string;
  output?: string;
  error?: string;
  updatedAt: number;
  steps?: TaskStep[];
  notes?: string;
};

type LogLine = {
  id: string;
  level: string;
  message: string;
  timestamp: number;
};

type TranscriptLine = {
  id: string;
  speaker: string;
  text: string;
};

// Purely-visual delegation handoff effects (orb <-> Work Stream). These never
// touch task/voice logic; they only react to changes in the tasks array.
type HandoffTone = "amber" | "success" | "error";

type Pulse = {
  id: string;
  kind: "out" | "in";
  tone: HandoffTone;
  fromX: number;
  fromY: number;
  dx: number;
  dy: number;
  lift: number;
  angle: number;
};

const MAX_LOGS = 80;
const TERMINAL = new Set(["completed", "failed", "cancelled", "canceled", "error"]);

// Arc-reactor accent color per state (matches ReactorCore palettes) — drives the
// surrounding ring/radar so it stays the same color as the orb.
const ORB_ACCENT: Record<ReactorState, string> = {
  idle: "120, 170, 150",
  online: "18, 163, 148",
  listening: "40, 205, 170",
  speaking: "238, 122, 92",
  working: "120, 180, 120",
};

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
] as const;

function eventTime(event: SidecarEvent): number {
  return typeof event.timestamp === "number" ? event.timestamp * 1000 : Date.now();
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readStatusObject(value: unknown): {
  running?: boolean;
  pid?: number | null;
  model?: string;
  mode?: string;
} {
  if (!value || typeof value !== "object") return {};
  return value as { running?: boolean; pid?: number | null; model?: string; mode?: string };
}

function taskKeyFor(task: string): string {
  return `starting:${task.toLowerCase().trim()}`;
}

// Stable key for the transient "mission accepted" stamp. Keyed by task text so it
// survives Hermes swapping the placeholder card for the real run_id card.
function acceptedKey(task: string): string {
  return task.toLowerCase().trim();
}

function shortRunId(id: string): string {
  if (!id || id === "pending") return "pending";
  if (id.startsWith("starting:")) return "starting";
  if (id.length <= 14) return id;
  return `${id.slice(0, 7)}…${id.slice(-5)}`;
}

function downsampleTo16k(input: Float32Array, inputRate: number): Int16Array {
  const outputRate = 16000;
  if (inputRate === outputRate) {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const sample = Math.max(-1, Math.min(1, input[i]));
      output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return output;
  }

  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function parsePcmRate(mimeType?: string): number {
  const match = /rate=(\d+)/i.exec(mimeType ?? "");
  return match ? Number(match[1]) : 24000;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function normalizeMarkdown(text?: string): string {
  if (!text) return "";
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "  ");
}

type ToolCategory = "browser" | "search" | "code" | "file" | "tool";

function toolCategory(tool: string): ToolCategory {
  const t = tool.toLowerCase();
  if (t.includes("search")) return "search";
  if (t.includes("browser") || t.includes("navigate") || t.includes("fetch") || t.includes("web") || t.includes("url"))
    return "browser";
  if (
    t.includes("code") ||
    t.includes("python") ||
    t.includes("shell") ||
    t.includes("bash") ||
    t.includes("exec") ||
    t.includes("terminal") ||
    t.includes("command") ||
    t.includes("run")
  )
    return "code";
  if (t.includes("file") || t.includes("read") || t.includes("write") || t.includes("edit") || t.includes("patch"))
    return "file";
  return "tool";
}

function prettyToolName(tool: string): string {
  return tool.replace(/[_.]+/g, " ").trim();
}

function hostFromUrl(value?: string): string {
  if (!value) return "";
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function baseName(value?: string): string {
  if (!value) return "";
  const cleaned = value.split(/[?#]/)[0].replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

// Short secondary detail for a tool step: a host for URLs, a filename for file
// tools, or a trimmed single-line snippet for code/other tools.
function stepDetail(step: TaskStep): string {
  if (!step.preview) return "";
  const category = toolCategory(step.tool);
  if (category === "browser" || category === "search") {
    return hostFromUrl(step.preview) || step.preview.slice(0, 60);
  }
  if (category === "file") {
    return baseName(step.preview) || step.preview.slice(0, 48);
  }
  const oneLine = step.preview.replace(/\s+/g, " ").trim();
  return oneLine.length > 64 ? `${oneLine.slice(0, 64)}…` : oneLine;
}

// One-line "what Hermes is doing right now" headline for an active step.
function stepHeadline(step: TaskStep): string {
  const category = toolCategory(step.tool);
  const detail = stepDetail(step);
  if (category === "browser") return detail ? `Browsing ${detail}` : "Browsing the web";
  if (category === "search") return detail ? `Searching ${detail}` : "Searching the web";
  if (category === "code") return "Running code";
  if (category === "file") return detail ? `Working on ${detail}` : "Working with files";
  return `Using ${prettyToolName(step.tool)}`;
}

function StepIcon({ tool }: { tool: string }) {
  const category = toolCategory(tool);
  if (category === "browser") return <Globe size={13} />;
  if (category === "search") return <Search size={13} />;
  if (category === "code") return <Code2 size={13} />;
  if (category === "file") return <FileText size={13} />;
  return <Cpu size={13} />;
}

const QUERY_STOP_WORDS = new Set([
  "open",
  "show",
  "me",
  "the",
  "a",
  "an",
  "one",
  "task",
  "card",
  "result",
  "latest",
  "current",
]);

const QUERY_SYNONYMS: Record<string, string> = {
  herems: "hermes",
  herme: "hermes",
  pakage: "package",
  pkg: "package",
  fialed: "failed",
  fail: "failed",
  errored: "failed",
  error: "failed",
  hands: "hand",
  hadn: "hand",
  deisgn: "design",
  desing: "design",
};

function normalizeQuery(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => QUERY_SYNONYMS[token] ?? token)
    .filter((token) => !QUERY_STOP_WORDS.has(token));
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function fuzzyTokenMatch(queryToken: string, candidateToken: string): boolean {
  if (candidateToken.includes(queryToken) || queryToken.includes(candidateToken)) return true;
  if (queryToken.length < 4 || candidateToken.length < 4) return false;
  const maxDistance = Math.min(queryToken.length, candidateToken.length) >= 6 ? 2 : 1;
  return editDistance(queryToken, candidateToken) <= maxDistance;
}

export default function App() {
  const [sidecarRunning, setSidecarRunning] = useState(false);
  const [sidecarPid, setSidecarPid] = useState<number | null>(null);
  const [geminiStatus, setGeminiStatus] = useState("offline");
  const [hermesStatus, setHermesStatus] = useState("offline");
  const [audioState, setAudioState] = useState("idle");
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [tasks, setTasks] = useState<TaskCard[]>([]);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [taskChooser, setTaskChooser] = useState<{ query: string; matches: TaskCard[] } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [stepsOpenIds, setStepsOpenIds] = useState<Record<string, boolean>>({});
  const [muted, setMuted] = useState(false);
  const [handControl, setHandControl] = useState(false);
  const [testDataEnabled, setTestDataEnabled] = useState(false);

  // Visual handoff (Gemini -> Hermes -> back). Purely decorative.
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const [orbFlash, setOrbFlash] = useState<{ id: string; tone: HandoffTone } | null>(null);
  const [acceptedIds, setAcceptedIds] = useState<Record<string, number>>({});
  const orbStageRef = useRef<HTMLDivElement | null>(null);
  const taskStatusRef = useRef<Map<string, string>>(new Map());
  const lastDelegationRef = useRef<Map<string, number>>(new Map());

  const hasBridge = typeof window.iris !== "undefined";
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const inputContextRef = useRef<AudioContext | null>(null);
  const inputStreamRef = useRef<MediaStream | null>(null);
  const inputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const inputProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const outputContextRef = useRef<AudioContext | null>(null);
  const playbackTimeRef = useRef(0);
  const playbackSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const inputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const audioLevelRef = useRef(0);
  const sessionStartRef = useRef<number | null>(null);

  useEffect(() => {
    if (!hasBridge) return;
    window.iris.getSidecarStatus().then((status) => {
      setSidecarRunning(status.running);
      setSidecarPid(status.pid);
    });
    return window.iris.onSidecarEvent((event) => handleSidecarEvent(event));
  }, [hasBridge]);

  useEffect(() => {
    if (!hasBridge) return;
    window.iris.getAppConfig().then((config) => {
      setTestDataEnabled(Boolean(config.loadTestData));
      if (config.loadTestData) loadUiTestData();
    });
  }, [hasBridge]);

  useEffect(() => {
    if (!hasBridge) return;
    const offAudio = window.iris.onAudioChunk((chunk) => playGeminiAudio(chunk));
    const offInterrupt = window.iris.onAudioInterrupt(() => flushPlayback());
    return () => {
      offAudio();
      offInterrupt();
    };
  }, [hasBridge]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

      const key = event.key.toLowerCase();
      if (key === "w" && !sidecarRunning) {
        event.preventDefault();
        start();
      } else if (key === "s" && sidecarRunning) {
        event.preventDefault();
        stop();
      } else if (key === "d" && testDataEnabled) {
        event.preventDefault();
        loadUiTestData();
      } else if (key === "g" && testDataEnabled) {
        event.preventDefault();
        simulateHandoff();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidecarRunning, hasBridge, testDataEnabled]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  // Passive audio level meter (mic in / Gemini out) for the reactive HUD.
  useEffect(() => {
    let raf = 0;
    const buf = new Uint8Array(256);
    const rms = (analyser: AnalyserNode | null) => {
      if (!analyser) return 0;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / buf.length);
    };
    const tick = () => {
      const level = Math.max(rms(inputAnalyserRef.current), rms(outputAnalyserRef.current));
      const boosted = Math.min(1, level * 2.6);
      audioLevelRef.current += (boosted - audioLevelRef.current) * 0.4;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const working = useMemo(
    () => tasks.some((task) => !TERMINAL.has(task.status.toLowerCase())) && tasks.length > 0,
    [tasks],
  );

  const booting = sidecarRunning && geminiStatus !== "connected";

  const reactorState: ReactorState = useMemo(() => {
    if (!sidecarRunning) return "idle";
    if (audioState === "speaking") return "speaking";
    if (audioState === "listening") return "listening";
    if (working) return "working";
    if (geminiStatus === "connected") return "online";
    return "idle";
  }, [audioState, geminiStatus, sidecarRunning, working]);

  function pushLog(level: string, message: string, timestamp = Date.now()) {
    setLogs((current) =>
      [{ id: crypto.randomUUID(), level, message, timestamp }, ...current].slice(0, MAX_LOGS),
    );
  }

  function centerOf(el: HTMLElement | null): { x: number; y: number } | null {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  // Where a Hermes card lives in the Work Stream: prefer the actual card, fall
  // back to the top of the work column for brand-new (not yet expandable) runs.
  function workStreamPoint(taskId: string): { x: number; y: number } | null {
    const card = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`);
    if (card) return centerOf(card);
    const panel = workScrollRef.current;
    if (!panel) return null;
    const r = panel.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 46 };
  }

  function flashOrb(tone: HandoffTone) {
    setOrbFlash({ id: crypto.randomUUID(), tone });
  }

  function spawnPulse(
    from: { x: number; y: number } | null,
    to: { x: number; y: number } | null,
    kind: "out" | "in",
    tone: HandoffTone,
  ) {
    if (!from || !to) return;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    const lift = Math.min(150, Math.max(40, dist * 0.22));
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    setPulses((current) => [
      ...current,
      { id: crypto.randomUUID(), kind, tone, fromX: from.x, fromY: from.y, dx, dy, lift, angle },
    ]);
  }

  // Gemini delegates -> orb flashes amber, a comet flies to the Work Stream, and
  // the card stamps "mission accepted" as the comet lands.
  function handoffOut(task: TaskCard) {
    flashOrb("amber");
    spawnPulse(centerOf(orbStageRef.current), workStreamPoint(task.id), "out", "amber");
    // Key the "mission accepted" stamp by task TEXT, not id: Hermes swaps the
    // placeholder ("starting:…") card for the real run_id card right after submit,
    // so an id-keyed flag would land on a card that no longer exists. The text
    // survives that swap, so the stamp reliably shows on the real card.
    const key = acceptedKey(task.task);
    window.setTimeout(() => {
      setAcceptedIds((current) => ({ ...current, [key]: Date.now() }));
      window.setTimeout(() => {
        setAcceptedIds((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }, 3200);
    }, 560);
  }

  // Hermes finishes -> a comet flies from the card back to the orb, then the orb
  // flashes (teal for success, coral for failure) as it arrives.
  function handoffIn(task: TaskCard) {
    const tone: HandoffTone = TERMINAL.has(task.status.toLowerCase())
      ? task.error || task.status.toLowerCase().includes("fail") || task.status.toLowerCase().includes("error")
        ? "error"
        : "success"
      : "success";
    spawnPulse(workStreamPoint(task.id), centerOf(orbStageRef.current), "in", tone);
    window.setTimeout(() => flashOrb(tone), 680);
  }

  async function startAudioCapture() {
    if (!hasBridge || inputContextRef.current) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });

    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(1024, 1, 1);

    // Passive meter tap for the reactive HUD (does not affect what is sent).
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    inputAnalyserRef.current = analyser;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const output = event.outputBuffer.getChannelData(0);
      output.fill(0);

      const pcm = downsampleTo16k(input, context.sampleRate);
      if (pcm.byteLength > 0) {
        const chunk = new ArrayBuffer(pcm.byteLength);
        new Uint8Array(chunk).set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
        window.iris.sendAudioChunk(chunk);
      }
    };

    source.connect(processor);
    processor.connect(context.destination);

    inputContextRef.current = context;
    inputStreamRef.current = stream;
    inputSourceRef.current = source;
    inputProcessorRef.current = processor;
    pushLog("info", "WebRTC echo cancellation enabled for microphone.");
  }

  async function stopAudioCapture() {
    inputProcessorRef.current?.disconnect();
    inputSourceRef.current?.disconnect();
    inputStreamRef.current?.getTracks().forEach((track) => track.stop());
    await inputContextRef.current?.close().catch(() => undefined);

    inputProcessorRef.current = null;
    inputSourceRef.current = null;
    inputStreamRef.current = null;
    inputContextRef.current = null;
    inputAnalyserRef.current = null;
  }

  function flushPlayback() {
    for (const source of playbackSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    playbackSourcesRef.current = [];
    if (outputContextRef.current) {
      playbackTimeRef.current = outputContextRef.current.currentTime;
    }
  }

  async function playGeminiAudio(chunk: LiveAudioChunk) {
    const rate = parsePcmRate(chunk.mimeType);
    const bytes = base64ToBytes(chunk.data);
    const sampleCount = Math.floor(bytes.byteLength / 2);
    if (!sampleCount) return;

    const context = outputContextRef.current ?? new AudioContext();
    outputContextRef.current = context;
    if (context.state === "suspended") await context.resume();

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const buffer = context.createBuffer(1, sampleCount, rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      channel[i] = view.getInt16(i * 2, true) / 32768;
    }

    let analyser = outputAnalyserRef.current;
    if (!analyser || analyser.context !== context) {
      analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.connect(context.destination);
      outputAnalyserRef.current = analyser;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    source.onended = () => {
      playbackSourcesRef.current = playbackSourcesRef.current.filter((item) => item !== source);
    };

    const startAt = Math.max(context.currentTime + 0.03, playbackTimeRef.current || 0);
    source.start(startAt);
    playbackTimeRef.current = startAt + buffer.duration;
    playbackSourcesRef.current.push(source);
  }

  function handleSidecarEvent(event: SidecarEvent) {
    if (event.type === "sidecar_status") {
      const status = readStatusObject(event.status);
      setSidecarRunning(Boolean(status.running));
      setSidecarPid(typeof status.pid === "number" ? status.pid : null);
      return;
    }

    if (event.type === "gemini_status") {
      setGeminiStatus(readString(event.status, "unknown"));
      return;
    }

    if (event.type === "hermes_status") {
      const status = readString(event.status, "unknown");
      setHermesStatus(status);
      pushLog(
        status === "error" ? "error" : "info",
        `Hermes ${status}${event.error ? `: ${readString(event.error)}` : ""}`,
        eventTime(event),
      );
      return;
    }

    if (event.type === "audio_state") {
      setAudioState(readString(event.state, "idle"));
      return;
    }

    if (event.type === "transcript") {
      const speaker = readString(event.speaker, "unknown");
      const text = readString(event.text);
      if (text.trim()) {
        setTranscript((current) =>
          [...current, { id: crypto.randomUUID(), speaker, text }].slice(-40),
        );
      }
      return;
    }

    if (event.type === "hermes_task_update") {
      const task = readString(event.task, "Hermes task");
      const rawRunId = readString(event.run_id);
      const runId = rawRunId || taskKeyFor(task);
      const status = readString(event.status, "unknown");
      const output = readString(event.output);
      const error = readString(event.error);

      setTasks((current) => {
        const existing = current.find((item) => item.id === runId);
        const placeholderId = taskKeyFor(task);
        const next: TaskCard = {
          id: runId,
          task,
          status,
          output: output || existing?.output,
          error: error || existing?.error,
          updatedAt: eventTime(event),
          steps: existing?.steps,
          notes: existing?.notes,
        };
        return [
          next,
          ...current.filter((item) => item.id !== runId && item.id !== placeholderId),
        ].slice(0, 20);
      });
      return;
    }

    if (event.type === "hermes_task_event") {
      const runId = readString(event.run_id);
      if (!runId) return;
      const kind = readString(event.event);
      const tool = readString(event.tool);
      const preview = readString(event.preview);
      const delta = readString(event.delta);
      const text = readString(event.text);
      const isError = event.is_error === true;
      const duration = typeof event.duration === "number" ? event.duration : undefined;
      const ts = typeof event.ts === "number" ? event.ts * 1000 : Date.now();

      setTasks((current) => {
        const index = current.findIndex((item) => item.id === runId);
        if (index === -1) return current;
        const task = current[index];
        let steps = task.steps ? [...task.steps] : [];
        let notes = task.notes ?? "";

        if (kind === "tool.started" && tool) {
          steps = [
            ...steps,
            { id: crypto.randomUUID(), tool, preview: preview || undefined, status: "running" as const, ts },
          ].slice(-40);
        } else if (kind === "tool.completed" && tool) {
          for (let i = steps.length - 1; i >= 0; i--) {
            if (steps[i].tool === tool && steps[i].status === "running") {
              steps[i] = { ...steps[i], status: isError ? "error" : "done", duration };
              break;
            }
          }
        } else if (kind === "message.delta" && delta) {
          notes = (notes + delta).slice(-600);
        } else if (kind === "reasoning.available" && text) {
          notes = text.slice(-600);
        } else {
          return current;
        }

        const next = [...current];
        next[index] = { ...task, steps, notes };
        return next;
      });
      return;
    }

    if (event.type === "hermes_completion") {
      pushLog("info", `Hermes returned: ${readString(event.task, "task complete")}`, eventTime(event));
      return;
    }

    if (event.type === "tool_call") {
      pushLog("info", `Gemini invoked ${readString(event.name, "tool")}`, eventTime(event));
      return;
    }

    if (event.type === "fatal") {
      pushLog("error", readString(event.message, "Fatal sidecar error"), eventTime(event));
      return;
    }

    if (event.type === "log") {
      pushLog(readString(event.level, "info"), readString(event.message), eventTime(event));
    }
  }

  async function start() {
    if (!hasBridge) {
      pushLog("error", "Electron bridge unavailable. Launch with `npm run dev`.");
      return;
    }
    const status = await window.iris.startSidecar({ mode: "none" });
    setSidecarRunning(status.running);
    setSidecarPid(status.pid);
    sessionStartRef.current = Date.now();
    await startAudioCapture();
    setHandControl(true);
  }

  async function stop() {
    if (!hasBridge) return;
    await stopAudioCapture();
    flushPlayback();
    await window.iris.stopSidecar();
    setGeminiStatus("offline");
    setHermesStatus("offline");
    setAudioState("idle");
    setMuted(false);
    setHandControl(false);
    sessionStartRef.current = null;
  }

  function dotState(value: string, goodValues: string[]) {
    if (!sidecarRunning) return "off";
    if (value === "error") return "err";
    return goodValues.includes(value) ? "on" : "warn";
  }

  const expandedTask = useMemo(
    () => tasks.find((task) => task.id === expandedTaskId) ?? null,
    [tasks, expandedTaskId],
  );
  const dwellRef = useRef<{ id: string; startedAt: number } | null>(null);

  const { state: hand, error: handError, stream: handStream } = useHandControl(handControl);
  const handCamRef = useRef<HTMLVideoElement | null>(null);
  const workScrollRef = useRef<HTMLDivElement | null>(null);
  const commsScrollRef = useRef<HTMLDivElement | null>(null);
  const liveHandRef = useRef<HandState | null>(hand);
  liveHandRef.current = hand;

  // Visual handoff detector: diff the tasks array to know when Gemini delegated a
  // new run (one card appears) and when a run completes (active -> terminal). A
  // bulk load (e.g. demo/history fixture) adds many cards at once, so we only
  // animate single-card deltas. This reads task state but never mutates it.
  useEffect(() => {
    const prev = taskStatusRef.current;
    const added = tasks.filter((task) => !prev.has(task.id));

    for (const task of tasks) {
      const before = prev.get(task.id);
      const now = task.status.toLowerCase();
      if (before && !TERMINAL.has(before) && TERMINAL.has(now)) {
        handoffIn(task);
      }
    }

    if (added.length === 1) {
      const task = added[0];
      if (!TERMINAL.has(task.status.toLowerCase())) {
        const key = task.task.toLowerCase().trim();
        const last = lastDelegationRef.current.get(key) ?? 0;
        // Dedupe the "starting:" placeholder -> real run_id swap.
        if (Date.now() - last > 5000) {
          lastDelegationRef.current.set(key, Date.now());
          handoffOut(task);
        }
      }
    }

    const next = new Map<string, string>();
    for (const task of tasks) next.set(task.id, task.status.toLowerCase());
    taskStatusRef.current = next;
  }, [tasks]);

  useEffect(() => {
    if (handError) pushLog("error", `Hand control: ${handError}`);
  }, [handError]);

  useEffect(() => {
    if (handCamRef.current) {
      handCamRef.current.srcObject = handStream;
    }
  }, [handStream]);

  useEffect(() => {
    if (!handControl || !hand.present || !hand.point || !hand.pointing || expandedTaskId) {
      dwellRef.current = null;
      return;
    }

    const el = document.elementFromPoint(hand.point.x, hand.point.y);
    const card = el?.closest<HTMLElement>("[data-task-id]");
    const taskId = card?.dataset.taskId;
    if (!taskId || !card) {
      dwellRef.current = null;
      return;
    }
    setFocusedTaskId(taskId);

    const now = performance.now();
    if (dwellRef.current?.id !== taskId) {
      dwellRef.current = { id: taskId, startedAt: now };
      return;
    }

    if (now - dwellRef.current.startedAt > 300) {
      const task = tasks.find((item) => item.id === taskId);
      if (task) openTask(task);
      dwellRef.current = null;
    }
  }, [handControl, hand.present, hand.point?.x, hand.point?.y, expandedTaskId, tasks]);

  // Open-palm hold-to-scroll for whichever scrollable section the hand is over
  // (Comms or Work Stream): hold the hand high to scroll up, low to scroll down.
  useEffect(() => {
    let raf = 0;
    const isInside = (el: HTMLElement | null, x: number, y: number) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    const loop = () => {
      const h = liveHandRef.current;
      if (handControl && h?.openPalm && h.point && !expandedTaskId && !showHistory) {
        const { x, y } = h.point;
        const body =
          [commsScrollRef.current, workScrollRef.current].find((el) => isInside(el, x, y)) ?? null;
        if (body) {
          const rect = body.getBoundingClientRect();
          const center = rect.top + rect.height / 2;
          const deadZone = Math.max(40, rect.height * 0.12);
          const delta = y - center;
          if (Math.abs(delta) > deadZone) {
            const reach = rect.height / 2 - deadZone;
            const norm = Math.max(-1, Math.min(1, (delta - Math.sign(delta) * deadZone) / reach));
            body.scrollTop += norm * 26;
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [handControl, expandedTaskId, showHistory]);

  const handAction = useMemo(() => {
    if (!hand.present) return { label: "Show your hand", tone: "idle" };
    if (hand.hands.filter((item) => item.openPalm).length >= 2) return { label: "Two palms · resize", tone: "open" };
    if (hand.fist) return { label: "Closed_Fist · close", tone: "fist" };
    if (hand.openPalm) return { label: "Open_Palm · scroll", tone: "open" };
    if (!hand.pointing) return { label: `${hand.gesture} · idle`, tone: "idle" };
    if (dwellRef.current) return { label: "Hold · opening", tone: "move" };
    return { label: "Pointing_Up · hover", tone: "move" };
  }, [hand.present, hand.hands, hand.fist, hand.openPalm, hand.pointing, hand.gesture, hand.point?.x, hand.point?.y]);

  function toggleMute() {
    const stream = inputStreamRef.current;
    const next = !muted;
    stream?.getAudioTracks().forEach((track) => (track.enabled = !next));
    setMuted(next);
  }

  function setTaskStepsOpen(id: string, open: boolean) {
    setStepsOpenIds((current) => ({ ...current, [id]: open }));
  }

  function toggleTaskSteps(id: string) {
    setStepsOpenIds((current) => ({ ...current, [id]: !current[id] }));
  }

  const sortedTasks = useMemo(() => {
    const isActive = (task: TaskCard) => !TERMINAL.has(task.status.toLowerCase());
    return [...tasks].sort((a, b) => {
      const activeDelta = Number(isActive(b)) - Number(isActive(a));
      if (activeDelta !== 0) return activeDelta;
      return b.updatedAt - a.updatedAt;
    });
  }, [tasks]);

  const latestResultTask = useMemo(
    () => sortedTasks.find((task) => Boolean(task.output || task.error)) ?? null,
    [sortedTasks],
  );

  function findTaskMatches(query?: string): Array<{ task: TaskCard; score: number }> {
    const queryTokens = normalizeQuery(query ?? "");
    if (!queryTokens.length) return [];

    const scored: Array<{ task: TaskCard; score: number }> = [];
    for (const task of sortedTasks) {
      const haystack = `${task.task} ${task.status} ${task.id}`;
      const candidateTokens = normalizeQuery(haystack);
      let score = 0;

      for (const token of queryTokens) {
        const exact = candidateTokens.includes(token);
        const fuzzy = exact || candidateTokens.some((candidate) => fuzzyTokenMatch(token, candidate));
        if (exact) score += 4;
        else if (fuzzy) score += 2;
      }

      if ((task.output || task.error) && score > 0) score += 2;
      if (task.status.toLowerCase() === "failed" && queryTokens.includes("failed")) score += 6;
      if (!TERMINAL.has(task.status.toLowerCase())) score -= 1;

      if (score > 0) scored.push({ task, score });
    }

    return scored
      .sort((a, b) => b.score - a.score || b.task.updatedAt - a.task.updatedAt)
      .slice(0, 3);
  }

  function openTaskByQuery(query?: string) {
    const matches = findTaskMatches(query);
    if (matches.length === 0) return;

    const [best, second] = matches;
    const clearWinner = !second || best.score - second.score >= 3;
    if (clearWinner) {
      openTask(best.task);
      return;
    }

    setTaskChooser({ query: query || "task", matches: matches.map((match) => match.task) });
  }

  useEffect(() => {
    if (!hasBridge) return;
    window.iris.sendUiContext({
      expandedTaskId,
      focusedTaskId,
      latestResultTaskId: latestResultTask?.id ?? null,
      pendingTaskMatches: taskChooser?.matches.map((task, index) => ({
        index: index + 1,
        id: task.id,
        task: task.task,
        status: task.status,
      })) ?? [],
      showHistory,
      tasks: sortedTasks.map((task) => ({
        id: task.id,
        task: task.task,
        status: task.status,
        hasResult: Boolean(task.output || task.error),
        stepCount: task.steps?.length ?? 0,
        stepsOpen: Boolean(stepsOpenIds[task.id]),
        updatedAt: task.updatedAt,
      })),
    });
  }, [hasBridge, expandedTaskId, focusedTaskId, latestResultTask?.id, showHistory, sortedTasks, stepsOpenIds, taskChooser]);

  useEffect(() => {
    if (!hasBridge) return;
    return window.iris.onUiAction(({ action, target_id, query }) => {
      const taskById = target_id ? tasks.find((task) => task.id === target_id) : null;
      const currentTask = expandedTaskId ? tasks.find((task) => task.id === expandedTaskId) : null;
      const focusedTask = focusedTaskId ? tasks.find((task) => task.id === focusedTaskId) : null;
      const fallbackTask = currentTask || focusedTask || latestResultTask;

      if (action === "open_task") {
        if (taskById) openTask(taskById);
        return;
      }
      if (action === "open_task_by_query") {
        openTaskByQuery(query);
        return;
      }
      if (action === "open_current_hermes_result") {
        if (fallbackTask) openTask(fallbackTask);
        return;
      }
      if (action === "open_latest_hermes_result") {
        if (latestResultTask) openTask(latestResultTask);
        return;
      }
      if (action === "open_hermes_history") {
        setShowHistory(true);
        return;
      }
      if (action === "close_reader") {
        closeReader();
        return;
      }
      if (action === "close_history") {
        setShowHistory(false);
        return;
      }
      if (action === "close_all_overlays") {
        closeReader();
        setShowHistory(false);
        setTaskChooser(null);
        return;
      }
      if (action === "show_task_steps" || action === "hide_task_steps") {
        // Default to the running task ("the hub that's going on"), then fall back
        // to whatever the user is focused on / the latest result.
        const activeTask = tasks.find((task) => !TERMINAL.has(task.status.toLowerCase()));
        const target = taskById || activeTask || focusedTask || fallbackTask;
        if (target) setTaskStepsOpen(target.id, action === "show_task_steps");
        return;
      }
    });
  }, [hasBridge, tasks, expandedTaskId, focusedTaskId, latestResultTask]);

  const caption = useMemo(() => {
    if (!sidecarRunning) return { text: "Press W to wake Iris", dim: true };
    if (audioState === "speaking") return { text: "Speaking…", dim: false };
    if (audioState === "listening") return { text: "Listening…", dim: false };
    if (working) return { text: "Working on it…", dim: false };
    const last = transcript[transcript.length - 1];
    if (last) return { text: last.text, dim: false };
    if (geminiStatus === "connected") return { text: "How can I help?", dim: true };
    return { text: "Connecting…", dim: true };
  }, [sidecarRunning, audioState, working, transcript, geminiStatus]);

  function openTask(task: TaskCard) {
    if (!(task.output || task.error)) return;
    setTaskChooser(null);
    setExpandedTaskId(task.id);
    setShowHistory(false);
  }

  function closeReader() {
    setExpandedTaskId(null);
  }

  // Dev-only (testDataEnabled): drive a full delegation -> completion through the
  // real setTasks path so the visual handoff can be previewed end to end.
  function simulateHandoff() {
    const id = `demo-${crypto.randomUUID().slice(0, 8)}`;
    const task = `Research the latest AI agent frameworks (${new Date().toLocaleTimeString()}).`;
    setTasks((current) =>
      [{ id, task, status: "working", updatedAt: Date.now() }, ...current].slice(0, 20),
    );
    window.setTimeout(() => {
      setTasks((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                status: "completed",
                output:
                  "## Demo handoff complete\n\nHermes finished the simulated research run and sent the result back to Iris.",
                updatedAt: Date.now(),
              }
            : item,
        ),
      );
    }, 2800);
  }

  function loadUiTestData() {
    const fixture = makeUiTestData();
    setTasks(fixture.tasks);
    setTranscript(fixture.transcript);
    setLogs((current) =>
      [
        {
          id: crypto.randomUUID(),
          level: "info",
          message: "Loaded UI test fixture data.",
          timestamp: Date.now(),
        },
        ...current,
      ].slice(0, MAX_LOGS),
    );
  }

  return (
    <>
    <div className={`deck ${sidecarRunning ? "awake" : "asleep"}`}>
      <div className="hud-aurora" />
      <div className="hud-vignette" />
      <div className="hud-scanlines" />

      <header className="deck-top">
        <div className="deck-top-left">
          <div className="deck-status">
            <StatusDot tone="gemini" state={dotState(geminiStatus, ["connected"])} label="Gemini" />
            <StatusDot tone="hermes" state={dotState(hermesStatus, ["ready"])} label="Hermes" />
            <StatusDot
              tone="audio"
              state={
                !sidecarRunning
                  ? "off"
                  : muted
                    ? "warn"
                    : audioState === "speaking"
                      ? "speaking"
                      : audioState === "idle"
                        ? "warn"
                        : "on"
              }
              label="Audio"
            />
          </div>
        </div>
        <div className="deck-brand">
          <span className="brand-mark">I.R.I.S</span>
        </div>
        <div className="deck-top-right">
          <button
            className={`theme-toggle ${handControl ? "active" : ""}`}
            onClick={() => setHandControl((current) => !current)}
            title={handControl ? "Disable hand control" : "Enable hand control (camera)"}
          >
            <Hand size={16} />
          </button>
          <span
            className={`link-indicator ${sidecarRunning ? "on" : "off"}`}
            title={sidecarRunning ? `Linked${sidecarPid ? ` · ${sidecarPid}` : ""}` : "Offline"}
          >
            <Radio size={16} />
          </span>
        </div>
      </header>

      <div className="deck-body">
        {/* LEFT — You */}
        <div className="deck-left">
          <section className="deck-panel comms">
            <div className="col-head">
              <MessageSquare size={14} />
              <span>Comms</span>
            </div>
            <div className="comms-scroll" ref={commsScrollRef}>
              {transcript.length === 0 ? (
                <div className="empty">
                  <p>No conversation yet. Wake Iris and start talking.</p>
                  {testDataEnabled ? (
                    <button className="demo-load" onClick={loadUiTestData}>
                      Load demo comms
                    </button>
                  ) : null}
                </div>
              ) : (
                transcript.map((line) => {
                  const self = /you|user/i.test(line.speaker);
                  return (
                    <div className={`bubble ${self ? "self" : "iris"}`} key={line.id}>
                      <span className="who">{self ? "You" : "Iris"}</span>
                      {line.text}
                    </div>
                  );
                })
              )}
              <div ref={transcriptEndRef} />
            </div>
          </section>

          <section className="deck-panel camera-dock">
            <div className="col-head">
              <Camera size={14} />
              <span>Camera / Gesture</span>
            </div>
            {handControl ? (
              <div className="camera-frame">
                <video ref={handCamRef} autoPlay playsInline muted />
                <div className="cam-scan" />
                <HandSkeleton hands={hand.hands} />
                <span className="cam-status">
                  <i />
                  {hand.present ? "tracking" : "no hand"}
                </span>
                <span className={`gesture-chip ${handAction.tone}`}>
                  <span className="dot" />
                  {handAction.label}
                </span>
              </div>
            ) : (
              <div className="camera-off">
                Gesture control is off. Tap the hand icon to enable the camera.
              </div>
            )}
          </section>
        </div>

        {/* CENTER — Iris */}
        <div className="deck-center">
          <div
            className="orb-stage"
            ref={orbStageRef}
            style={{ "--orb-accent": ORB_ACCENT[reactorState] } as CSSProperties}
          >
            <span className="orb-ring" />
            <span className="orb-radar" />
            <ReactorCore state={reactorState} levelRef={audioLevelRef} />
            {orbFlash ? (
              <span
                key={orbFlash.id}
                className={`orb-flash ${orbFlash.tone}`}
                onAnimationEnd={() => setOrbFlash(null)}
              />
            ) : null}
          </div>
          <Telemetry
            awake={sidecarRunning}
            gemini={geminiStatus}
            hermes={hermesStatus}
            runs={tasks.length}
            sessionStartRef={sessionStartRef}
          />
          <div className={`caption ${caption.dim ? "dim" : ""}`}>
            {caption.text}
            {sidecarRunning ? <span className="caption-caret" /> : null}
          </div>
          {sidecarRunning ? (
            <div className="transport">
              <button
                className={`t-btn small ${muted ? "muted" : ""}`}
                onClick={toggleMute}
                title={muted ? "Unmute microphone" : "Mute microphone"}
              >
                {muted ? <MicOff size={18} /> : <Mic size={18} />}
              </button>
              <button className="t-btn small danger" onClick={stop} title="Sleep (S)">
                <Power size={18} />
              </button>
            </div>
          ) : (
            <div className="transport-hint">
              <span className="key">W</span> wake · <span className="key">S</span> sleep
            </div>
          )}
        </div>

        {/* RIGHT — Work */}
        <aside className="deck-panel deck-right">
          <div className="col-head">
            <Terminal size={14} />
            <span>Work Stream</span>
            {tasks.length > 0 ? <span className="count">{tasks.length}</span> : null}
            {testDataEnabled ? (
              <button className="view-all" onClick={loadUiTestData} title="Load UI test fixture data">
                Load demo
              </button>
            ) : null}
            {tasks.length > 3 ? (
              <button className="view-all" onClick={() => setShowHistory(true)}>
                View all <ChevronRight size={12} />
              </button>
            ) : null}
          </div>
          <div className="work-scroll" ref={workScrollRef}>
            {tasks.length === 0 ? (
              <div className="empty">
                <p>No Hermes runs yet. Ask Iris to take on a task.</p>
                {testDataEnabled ? (
                  <button className="demo-load" onClick={loadUiTestData}>
                    Load demo tasks
                  </button>
                ) : null}
              </div>
            ) : (
              sortedTasks.map((task) => (
                <WorkCard
                  key={task.id}
                  task={task}
                  accepted={Boolean(acceptedIds[acceptedKey(task.task)])}
                  stepsOpen={Boolean(stepsOpenIds[task.id])}
                  onToggleSteps={() => toggleTaskSteps(task.id)}
                  onFocus={() => setFocusedTaskId(task.id)}
                  onOpen={() => openTask(task)}
                />
              ))
            )}
          </div>
        </aside>
      </div>

      <footer className="deck-foot">
        <span className="build-meta">
          IRIS · build 0.1.0 · by Ashutosh Shrivastava ·{" "}
          <a href="https://x.com/ai_for_success" target="_blank" rel="noreferrer">
            X
          </a>{" "}
          ·{" "}
          <a href="https://github.com/ASHR12/iris" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </span>
      </footer>

      {booting && <BootSequence visible={booting} />}
    </div>

    {expandedTask ? (
      <ExpandedReader
        task={expandedTask}
        hand={handControl ? hand : null}
        onClose={closeReader}
      />
    ) : null}

    {showHistory ? (
      <HistoryDrawer
        tasks={sortedTasks}
        onOpen={openTask}
        onClose={() => setShowHistory(false)}
      />
    ) : null}

    {taskChooser ? (
      <TaskMatchChooser
        query={taskChooser.query}
        matches={taskChooser.matches}
        onOpen={openTask}
        onClose={() => setTaskChooser(null)}
      />
    ) : null}

    <div className="handoff-layer" aria-hidden="true">
      {pulses.map((pulse) => (
        <span
          key={pulse.id}
          className={`handoff-pulse ${pulse.kind} ${pulse.tone}`}
          style={
            {
              "--fx": `${pulse.fromX}px`,
              "--fy": `${pulse.fromY}px`,
              "--dx": `${pulse.dx}px`,
              "--dy": `${pulse.dy}px`,
              "--lift": `${pulse.lift}px`,
              "--angle": `${pulse.angle}deg`,
            } as CSSProperties
          }
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) {
              setPulses((current) => current.filter((item) => item.id !== pulse.id));
            }
          }}
        >
          <span className="comet-tail" />
          <span className="comet-head" />
        </span>
      ))}
    </div>

    {handControl && hand.present
      ? (hand.hands.length ? hand.hands : hand.point ? [{ ...hand, id: "hand-0", point: hand.point }] : []).map(
          (item, index) => (
            <div
              key={item.id}
              className={`hand-reticle ${index > 0 ? "secondary" : ""} ${
                index === 0 && dwellRef.current ? "dwell" : ""
              } ${item.pointing ? "pointing" : ""} ${item.openPalm ? "open" : ""} ${item.fist ? "fist" : ""}`}
              style={{ transform: `translate(${item.point.x}px, ${item.point.y}px)` }}
            >
              <span className="hand-ring" />
              <span className="hand-dot" />
            </div>
          ),
        )
      : null}
    </>
  );
}

function StatusDot({ tone, state, label }: { tone: string; state: string; label: string }) {
  return (
    <span className={`status-dot ${tone} ${state}`}>
      <i />
      {label}
    </span>
  );
}

function HandSkeleton({ hands }: { hands: HandState["hands"] }) {
  if (!hands.length) return null;
  return (
    <svg className="hand-skeleton" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {hands.map((hand, handIndex) => (
        <g key={hand.id} className={handIndex > 0 ? "secondary" : ""}>
          {HAND_CONNECTIONS.map(([from, to]) => {
            const a = hand.landmarks[from];
            const b = hand.landmarks[to];
            if (!a || !b) return null;
            return (
              <line
                key={`${from}-${to}`}
                x1={a.x * 100}
                y1={a.y * 100}
                x2={b.x * 100}
                y2={b.y * 100}
              />
            );
          })}
          {hand.landmarks.map((landmark, index) => (
            <circle key={index} cx={landmark.x * 100} cy={landmark.y * 100} r={index === 8 ? 1.45 : 1.05} />
          ))}
        </g>
      ))}
    </svg>
  );
}

function Telemetry({
  awake,
  gemini,
  hermes,
  runs,
  sessionStartRef,
}: {
  awake: boolean;
  gemini: string;
  hermes: string;
  runs: number;
  sessionStartRef: { current: number | null };
}) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const elapsed = awake && sessionStartRef.current ? Date.now() - sessionStartRef.current : 0;
  const mm = String(Math.floor(elapsed / 60000)).padStart(2, "0");
  const ss = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, "0");

  return (
    <div className={`telemetry ${awake ? "live" : ""}`} aria-hidden="true">
      <span>
        <i>UPLINK</i>
        {gemini === "connected" ? "LIVE" : awake ? "SYNC" : "OFFLINE"}
      </span>
      <span className="sep">/</span>
      <span>
        <i>HERMES</i>
        {hermes === "ready" ? "READY" : awake ? "···" : "—"}
      </span>
      <span className="sep">/</span>
      <span>
        <i>RUNS</i>
        {String(runs).padStart(2, "0")}
      </span>
      <span className="sep">/</span>
      <span>
        <i>SESSION</i>
        {mm}:{ss}
      </span>
    </div>
  );
}

function WorkCard({
  task,
  accepted = false,
  stepsOpen = false,
  onToggleSteps,
  onFocus,
  onOpen,
}: {
  task: TaskCard;
  accepted?: boolean;
  stepsOpen?: boolean;
  onToggleSteps?: () => void;
  onFocus: () => void;
  onOpen: () => void;
}) {
  const [localStepsOpen, setLocalStepsOpen] = useState(false);
  const showSteps = onToggleSteps ? stepsOpen : localStepsOpen;
  const expandable = Boolean(task.output || task.error);
  const status = task.status.toLowerCase();
  const active = !TERMINAL.has(status);
  const steps = task.steps ?? [];
  const runningStep = [...steps].reverse().find((step) => step.status === "running");

  return (
    <article
      className={`wcard ${active ? "working" : ""} ${expandable ? "expandable" : ""} ${
        accepted ? "accepted" : ""
      }`}
      data-task-id={expandable ? task.id : undefined}
      onPointerEnter={onFocus}
      onFocus={onFocus}
      onClick={onOpen}
      tabIndex={expandable ? 0 : -1}
    >
      {accepted ? <span className="wcard-accepted">Mission accepted</span> : null}
      <div className="wcard-top">
        <span className={`badge ${status}`}>{task.status}</span>
        <code title={task.id}>{shortRunId(task.id)}</code>
      </div>
      <p className="wcard-task">{task.task}</p>
      {expandable ? (
        <div className="wcard-preview">{normalizeMarkdown(task.error || task.output)}</div>
      ) : null}

      {active && (runningStep || steps.length > 0) ? (
        <div className="activity-now">
          <span className="activity-spark" />
          <span className="activity-now-text">
            {runningStep ? stepHeadline(runningStep) : "Thinking…"}
          </span>
        </div>
      ) : null}

      {active && task.notes ? <p className="activity-notes">{task.notes.slice(-180)}</p> : null}

      {steps.length > 0 ? (
        <div className="activity" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className={`activity-toggle ${showSteps ? "open" : ""}`}
            onClick={() => (onToggleSteps ? onToggleSteps() : setLocalStepsOpen((current) => !current))}
          >
            <Wrench size={11} />
            {steps.length} step{steps.length === 1 ? "" : "s"}
            <ChevronDown size={12} className="chev" />
          </button>
          {showSteps ? (
            <ul className="activity-timeline">
              {steps.map((step) => {
                const detail = stepDetail(step);
                return (
                  <li key={step.id} className={`activity-step ${step.status} ${toolCategory(step.tool)}`}>
                    <span className="step-icon">
                      <StepIcon tool={step.tool} />
                    </span>
                    <span className="step-main">
                      <span className="step-tool">{prettyToolName(step.tool)}</span>
                      {detail ? <span className="step-detail">{detail}</span> : null}
                    </span>
                    <span className="step-meta">
                      {step.duration !== undefined ? <em>{step.duration.toFixed(1)}s</em> : null}
                      {step.status === "running" ? (
                        <span className="step-run" />
                      ) : step.status === "error" ? (
                        <X size={12} className="step-x" />
                      ) : (
                        <Check size={12} className="step-ok" />
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}

      {active ? (
        <div className="wcard-progress">
          <i />
        </div>
      ) : null}
    </article>
  );
}

function HistoryDrawer({
  tasks,
  onOpen,
  onClose,
}: {
  tasks: TaskCard[];
  onOpen: (task: TaskCard) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="history-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="history-card">
        <div className="history-head">
          <History size={15} />
          <span>Hermes History · {tasks.length}</span>
          <button className="reader-close" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>
        <div className="history-grid">
          {tasks.map((task) => (
            <WorkCard key={task.id} task={task} onFocus={() => undefined} onOpen={() => onOpen(task)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function TaskMatchChooser({
  query,
  matches,
  onOpen,
  onClose,
}: {
  query: string;
  matches: TaskCard[];
  onOpen: (task: TaskCard) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      const index = Number(event.key);
      if (index >= 1 && index <= matches.length) {
        onOpen(matches[index - 1]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [matches, onClose, onOpen]);

  return (
    <div
      className="match-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="match-card">
        <div className="match-head">
          <span>Which task did you mean?</span>
          <button className="reader-close" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>
        <p className="match-query">Matched voice query: “{query || "task"}”</p>
        <div className="match-list">
          {matches.map((task, index) => (
            <button key={task.id} className="match-option" onClick={() => onOpen(task)}>
              <span className="match-number">{index + 1}</span>
              <span className="match-copy">
                <strong>{task.task}</strong>
                <em>{task.status} · {shortRunId(task.id)}</em>
              </span>
            </button>
          ))}
        </div>
        <div className="match-hint">Press 1-{matches.length}, click a result, or press Esc.</div>
      </section>
    </div>
  );
}

function ExpandedReader({
  task,
  hand,
  onClose,
}: {
  task: TaskCard;
  hand: HandState | null;
  onClose: () => void;
}) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [readerScale, setReaderScale] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [closing, setClosing] = useState(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const handRef = useRef<HandState | null>(hand);
  const readerScaleRef = useRef(1);
  const zoomRef = useRef<{ distance: number; scale: number } | null>(null);
  handRef.current = hand;

  const CLOSE_DISTANCE = 160;

  function closeWithSnap() {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, 180);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeWithSnap();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closing, onClose]);

  useEffect(() => {
    if (hand?.fist) closeWithSnap();
  }, [hand?.fist]);

  // Joystick-style hold-to-scroll: with an open palm, holding the hand above the
  // card's center scrolls up, below scrolls down, and the middle is a dead zone.
  // Speed is proportional to the distance from center and continues while held.
  useEffect(() => {
    let raf = 0;
    const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y);
    const loop = () => {
      const h = handRef.current;
      const body = bodyRef.current;
      const openHands = h?.hands.filter((item) => item.openPalm && item.point) ?? [];
      if (openHands.length >= 2) {
        const currentDistance = distance(openHands[0].point, openHands[1].point);
        if (!zoomRef.current) {
          zoomRef.current = { distance: currentDistance, scale: readerScaleRef.current };
        }
        const ratio = currentDistance / Math.max(80, zoomRef.current.distance);
        const next = Math.max(0.72, Math.min(1.28, zoomRef.current.scale * ratio));
        if (Math.abs(next - readerScaleRef.current) > 0.004) {
          readerScaleRef.current = next;
          setReaderScale(next);
        }
      } else {
        zoomRef.current = null;
      }

      if (openHands.length < 2 && h?.openPalm && h.point && body) {
        const rect = body.getBoundingClientRect();
        const center = rect.top + rect.height / 2;
        const deadZone = Math.max(40, rect.height * 0.12);
        const delta = h.point.y - center;
        if (Math.abs(delta) > deadZone) {
          const reach = rect.height / 2 - deadZone;
          const norm = Math.max(-1, Math.min(1, (delta - Math.sign(delta) * deadZone) / reach));
          body.scrollTop += norm * 26;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  function beginDrag(clientX: number, clientY: number, target: HTMLElement, pointerId: number) {
    startRef.current = { x: clientX, y: clientY };
    setDragging(true);
    try {
      target.setPointerCapture?.(pointerId);
    } catch {
      // Pointer capture is best-effort; dragging still works without it.
    }
  }

  function moveDrag(clientX: number, clientY: number) {
    if (!startRef.current) return;
    setOffset({ x: clientX - startRef.current.x, y: clientY - startRef.current.y });
  }

  function endDrag() {
    if (!startRef.current) return;
    const distance = Math.hypot(offset.x, offset.y);
    startRef.current = null;
    setDragging(false);
    if (distance > CLOSE_DISTANCE) {
      closeWithSnap();
    } else {
      setOffset({ x: 0, y: 0 });
    }
  }

  const dim = Math.min(1, Math.hypot(offset.x, offset.y) / (CLOSE_DISTANCE * 2));

  return (
    <div
      className={`reader-backdrop ${closing ? "closing" : ""}`}
      style={{ opacity: 1 - dim * 0.6 }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeWithSnap();
      }}
    >
      <article
        className={`reader-card ${dragging ? "dragging" : ""} ${closing ? "closing" : ""}`}
        style={{
          "--reader-transform": `translate(${offset.x}px, ${offset.y}px) scale(${readerScale * (1 - dim * 0.08)})`,
        } as CSSProperties}
      >
        <header
          className="reader-grab"
          onPointerDown={(event) =>
            beginDrag(event.clientX, event.clientY, event.currentTarget, event.pointerId)
          }
          onPointerMove={(event) => dragging && moveDrag(event.clientX, event.clientY)}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="reader-grip" />
          <span className={`badge ${task.status.toLowerCase()}`}>{task.status}</span>
          <code title={task.id}>{shortRunId(task.id)}</code>
          <button
            className="reader-close"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={closeWithSnap}
            title="Close"
          >
            <X size={16} />
          </button>
        </header>
        <h2 className="reader-title">{task.task}</h2>
        <div className="reader-body" ref={bodyRef}>
          <div className={`markdown-body ${task.error ? "error" : ""}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {normalizeMarkdown(task.error || task.output)}
            </ReactMarkdown>
          </div>
        </div>
        <div className="reader-hint">
          {hand
            ? "Open palm — hold high/low to scroll · Two open palms resize · Fist to close"
            : "Scroll to read · Esc or × to close"}
        </div>
      </article>
    </div>
  );
}
