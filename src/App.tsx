import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Activity, Hand, Moon, Radio, Sun, Terminal, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import html2canvas from "html2canvas";
import ReactorCore from "./ReactorCore";
import BootSequence from "./BootSequence";
import { useHandControl, type HandState } from "./useHandControl";

type ReactorState = "idle" | "online" | "listening" | "speaking" | "working";
type Theme = "light" | "dark";

type TaskCard = {
  id: string;
  task: string;
  status: string;
  output?: string;
  error?: string;
  updatedAt: number;
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

const MAX_LOGS = 80;
const TERMINAL = new Set(["completed", "failed", "cancelled", "canceled", "error"]);

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

function shortRunId(id: string): string {
  if (!id || id === "pending") return "pending";
  if (id.startsWith("starting:")) return "starting";
  if (id.length <= 14) return id;
  return `${id.slice(0, 7)}…${id.slice(-5)}`;
}

function pickWeightedCanvas(peak: number, count: number): number {
  let total = 0;
  const probs = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const p = Math.pow(count - Math.abs(peak - i), 3);
    probs[i] = p > 0 ? p : 0;
    total += probs[i];
  }
  let r = Math.random() * total;
  for (let i = 0; i < count; i++) {
    r -= probs[i];
    if (r <= 0) return i;
  }
  return count - 1;
}

// Thanos-style disintegration: rasterize the element, scatter its pixels across
// many canvases (weighted top-to-bottom), then drift + fade each slice into dust.
async function disintegrate(el: HTMLElement, onDone: () => void): Promise<void> {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onDone();
  };

  let snapshot: HTMLCanvasElement;
  try {
    snapshot = await html2canvas(el, {
      backgroundColor: null,
      scale: 0.7,
      logging: false,
      useCORS: true,
    });
  } catch {
    finish();
    return;
  }

  const w = snapshot.width;
  const h = snapshot.height;
  const ctx = snapshot.getContext("2d");
  if (!ctx || w === 0 || h === 0) {
    finish();
    return;
  }

  const rect = el.getBoundingClientRect();
  const raw = ctx.getImageData(0, 0, w, h).data;
  const canvasCount = 26;

  const slices: ImageData[] = [];
  for (let i = 0; i < canvasCount; i++) slices.push(new ImageData(w, h));

  for (let i = 0; i < raw.length; i += 4) {
    if (raw[i + 3] === 0) continue;
    const peak = Math.floor((i / raw.length) * canvasCount);
    const slice = slices[pickWeightedCanvas(peak, canvasCount)].data;
    slice[i] = raw[i];
    slice[i + 1] = raw[i + 1];
    slice[i + 2] = raw[i + 2];
    slice[i + 3] = raw[i + 3];
  }

  const layer = document.createElement("div");
  layer.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;pointer-events:none;z-index:60;`;
  document.body.appendChild(layer);

  el.style.visibility = "hidden";

  let maxLifetime = 0;
  for (let i = 0; i < canvasCount; i++) {
    const slice = document.createElement("canvas");
    slice.width = w;
    slice.height = h;
    const sctx = slice.getContext("2d");
    if (sctx) sctx.putImageData(slices[i], 0, 0);
    slice.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;will-change:transform,opacity;";
    layer.appendChild(slice);

    const dx = 40 + Math.random() * 90;
    const dy = -60 - Math.random() * 110;
    const rot = (Math.random() * 2 - 1) * 26;
    const duration = 360 + 50 * i;
    const delay = 11 * i;
    maxLifetime = Math.max(maxLifetime, duration + delay);

    slice.animate(
      [
        { transform: "translate(0,0) rotate(0deg)", opacity: 1, filter: "blur(0px)" },
        {
          transform: `translate(${dx}px, ${dy}px) rotate(${rot}deg)`,
          opacity: 0,
          filter: "blur(2px)",
        },
      ],
      { duration, delay, easing: "cubic-bezier(0.4, 0, 0.6, 1)", fill: "forwards" },
    );
  }

  window.setTimeout(() => {
    layer.remove();
    finish();
  }, maxLifetime + 80);
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

export default function App() {
  const [sidecarRunning, setSidecarRunning] = useState(false);
  const [sidecarPid, setSidecarPid] = useState<number | null>(null);
  const [geminiStatus, setGeminiStatus] = useState("offline");
  const [hermesStatus, setHermesStatus] = useState("offline");
  const [audioState, setAudioState] = useState("idle");
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [tasks, setTasks] = useState<TaskCard[]>([]);
  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(() => new Set());
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [handControl, setHandControl] = useState(true);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("iris-theme") as Theme) || "light",
  );

  const hasBridge = typeof window.iris !== "undefined";
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const inputContextRef = useRef<AudioContext | null>(null);
  const inputStreamRef = useRef<MediaStream | null>(null);
  const inputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const inputProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const outputContextRef = useRef<AudioContext | null>(null);
  const playbackTimeRef = useRef(0);
  const playbackSourcesRef = useRef<AudioBufferSourceNode[]>([]);

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
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidecarRunning, hasBridge]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("iris-theme", theme);
  }, [theme]);

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

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
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
        };
        return [
          next,
          ...current.filter((item) => item.id !== runId && item.id !== placeholderId),
        ].slice(0, 20);
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
    await startAudioCapture();
  }

  async function stop() {
    if (!hasBridge) return;
    await stopAudioCapture();
    flushPlayback();
    await window.iris.stopSidecar();
    setGeminiStatus("offline");
    setHermesStatus("offline");
    setAudioState("idle");
  }

  function dotState(value: string, goodValues: string[]) {
    if (!sidecarRunning) return "off";
    if (value === "error") return "err";
    return goodValues.includes(value) ? "on" : "warn";
  }

  function toggleTaskCollapsed(taskId: string) {
    setCollapsedTasks((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  const expandedTask = useMemo(
    () => tasks.find((task) => task.id === expandedTaskId) ?? null,
    [tasks, expandedTaskId],
  );
  const dwellRef = useRef<{ id: string; startedAt: number } | null>(null);

  const { state: hand, error: handError, stream: handStream } = useHandControl(handControl);
  const handCamRef = useRef<HTMLVideoElement | null>(null);

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
    if (!taskId) {
      dwellRef.current = null;
      return;
    }

    const now = performance.now();
    if (dwellRef.current?.id !== taskId) {
      dwellRef.current = { id: taskId, startedAt: now };
      return;
    }

    if (now - dwellRef.current.startedAt > 850) {
      setExpandedTaskId(taskId);
      dwellRef.current = null;
    }
  }, [handControl, hand.present, hand.point?.x, hand.point?.y, expandedTaskId]);

  const handAction = useMemo(() => {
    if (!hand.present) return { label: "Show your hand", tone: "idle" };
    if (hand.fist) return { label: "Closed_Fist · close", tone: "fist" };
    if (hand.openPalm) return { label: "Open_Palm · scroll", tone: "open" };
    if (!hand.pointing) return { label: `${hand.gesture} · idle`, tone: "idle" };
    if (dwellRef.current) return { label: "Hold · opening", tone: "move" };
    return { label: "Pointing_Up · hover", tone: "move" };
  }, [hand.present, hand.fist, hand.openPalm, hand.pointing, hand.gesture, hand.point?.x, hand.point?.y]);

  return (
    <>
    <div className="hud">
      <div className="hud-aurora" />
      <div className="hud-vignette" />

      <header className="topbar">
        <span className="topbar-side titlebar-spacer" />
        <div className="brand">
          <span className="brand-mark">I.R.I.S</span>
        </div>
        <div className="topbar-side right">
          <button
            className={`theme-toggle ${handControl ? "active" : ""}`}
            onClick={() => setHandControl((current) => !current)}
            title={handControl ? "Disable hand control" : "Enable hand control (camera)"}
          >
            <Hand size={16} />
          </button>
          <button
            className="theme-toggle"
            onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
            title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
          >
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          </button>
          <span
            className={`link-indicator ${sidecarRunning ? "on" : "off"}`}
            title={sidecarRunning ? `Linked${sidecarPid ? ` · ${sidecarPid}` : ""}` : "Offline"}
          >
            <Radio size={16} />
          </span>
        </div>
      </header>

      <main className="hud-body">
        <aside className="control-rail">
          <div className="reactor-mini">
            <ReactorCore state={reactorState} />
          </div>

          <div className={`control-instruction ${sidecarRunning ? "live" : ""}`}>
            <span className="key">{sidecarRunning ? "S" : "W"}</span>
            {sidecarRunning ? "Press S to stop" : "Press W to wake"}
          </div>

          {handControl ? (
            <div className="rail-hand">
              <div className="rail-cam">
                <video ref={handCamRef} className="hand-cam" autoPlay playsInline muted />
                <span className={`hand-action ${handAction.tone}`}>{handAction.label}</span>
              </div>
              <ul className="hand-legend">
                <li className={handAction.tone === "move" ? "active" : ""}>
                  <span className="legend-key move">Pointing_Up</span>
                  Point over a Hermes card
                </li>
                <li className={handAction.label.includes("opening") ? "active" : ""}>
                  <span className="legend-key open">Dwell</span>
                  Hold over a card briefly to open it
                </li>
                <li className={handAction.tone === "open" ? "active" : ""}>
                  <span className="legend-key scroll">Open_Palm</span>
                  Move slowly to scroll, flick up/down to page
                </li>
                <li className={handAction.tone === "fist" ? "active" : ""}>
                  <span className="legend-key close">Closed_Fist</span>
                  Make a fist, press Esc, click outside, or use ×
                </li>
              </ul>
            </div>
          ) : null}

          <div className="rail-dots row">
            <StatusDot tone="gemini" state={dotState(geminiStatus, ["connected"])} label="Gemini" />
            <StatusDot tone="hermes" state={dotState(hermesStatus, ["ready"])} label="Hermes" />
            <StatusDot
              tone="audio"
              state={
                !sidecarRunning
                  ? "off"
                  : audioState === "speaking"
                    ? "speaking"
                    : audioState === "idle"
                      ? "warn"
                      : "on"
              }
              label="Audio"
            />
          </div>
        </aside>

        <section className="panel comms-main">
          <div className="panel-head">
            <Activity size={15} />
            <span>Comms</span>
          </div>
          <div className="scroll">
            {transcript.length === 0 ? (
              <p className="muted">Awaiting transmission.</p>
            ) : (
              transcript.map((line) => (
                <p className={`line ${line.speaker}`} key={line.id}>
                  <span className="who">{line.speaker}</span>
                  {line.text}
                </p>
              ))
            )}
            <div ref={transcriptEndRef} />
          </div>
          {booting && <BootSequence visible={booting} />}
        </section>

        <aside className="panel tasks-col">
          <div className="panel-head">
            <Terminal size={15} />
            <span>Hermes Tasks</span>
          </div>
          <div className="scroll">
            {tasks.length === 0 ? (
              <p className="muted">No active runs.</p>
            ) : (
              tasks.map((task) => {
                const expandable = Boolean(task.output || task.error);
                return (
                  <article
                    className={`task ${task.error ? "err" : ""} ${expandable ? "expandable" : ""}`}
                    key={task.id}
                    data-task-id={expandable ? task.id : undefined}
                    onClick={() => expandable && setExpandedTaskId(task.id)}
                  >
                    <div className="task-top">
                      <span className={`badge ${task.status.toLowerCase()}`}>{task.status}</span>
                      <code title={task.id}>{shortRunId(task.id)}</code>
                    </div>
                    <p>{task.task}</p>
                    {expandable ? (
                      <div className="task-preview">
                        {normalizeMarkdown(task.error || task.output)}
                      </div>
                    ) : null}
                  </article>
                );
              })
            )}
          </div>
        </aside>
      </main>

      <footer className="statusbar">
        <div className="log-ticker">
          {logs[0] ? (
            <span className={`log ${logs[0].level}`}>
              <em>{new Date(logs[0].timestamp).toLocaleTimeString([], { hour12: false })}</em>
              {logs[0].message}
            </span>
          ) : (
            <span className="muted">system feed idle</span>
          )}
        </div>
      </footer>
    </div>

    {expandedTask ? (
      <ExpandedReader
        task={expandedTask}
        hand={handControl ? hand : null}
        onClose={() => setExpandedTaskId(null)}
      />
    ) : null}

    {handControl && hand.present && hand.point ? (
      <div
        className={`hand-reticle ${dwellRef.current ? "dwell" : ""} ${hand.openPalm ? "open" : ""} ${hand.fist ? "fist" : ""}`}
        style={{ transform: `translate(${hand.point.x}px, ${hand.point.y}px)` }}
      >
        <span className="hand-ring" />
        <span className="hand-dot" />
      </div>
    ) : null}
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
  const [dragging, setDragging] = useState(false);
  const [closing, setClosing] = useState(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const handRef = useRef<HandState | null>(hand);
  handRef.current = hand;

  const CLOSE_DISTANCE = 160;

  function closeWithSnap() {
    if (closing) return;
    setClosing(true);
    const card = cardRef.current;
    if (!card) {
      onClose();
      return;
    }
    void disintegrate(card, onClose);
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
    const loop = () => {
      const h = handRef.current;
      const body = bodyRef.current;
      if (h?.openPalm && h.point && body) {
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

  function beginDrag(clientX: number, clientY: number, target: HTMLElement) {
    startRef.current = { x: clientX, y: clientY };
    setDragging(true);
    target.setPointerCapture?.(0);
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
        ref={cardRef}
        className={`reader-card ${dragging ? "dragging" : ""} ${closing ? "closing" : ""}`}
        style={{
          "--reader-transform": `translate(${offset.x}px, ${offset.y}px) scale(${1 - dim * 0.08})`,
        } as CSSProperties}
      >
        <header
          className="reader-grab"
          onPointerDown={(event) => beginDrag(event.clientX, event.clientY, event.currentTarget)}
          onPointerMove={(event) => dragging && moveDrag(event.clientX, event.clientY)}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="reader-grip" />
          <span className={`badge ${task.status.toLowerCase()}`}>{task.status}</span>
          <code title={task.id}>{shortRunId(task.id)}</code>
          <button className="reader-close" onClick={closeWithSnap} title="Close">
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
            ? "Open palm — hold high to scroll up, low to scroll down · Fist to close"
            : "Scroll to read · Esc or × to close"}
        </div>
      </article>
    </div>
  );
}
