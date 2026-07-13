import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactorState, TaskCard, LogLine, TranscriptLine } from "./types";
import {
  TERMINAL,
  eventTime,
  findTaskMatches,
  readString,
  readStatusObject,
  tasksForSession,
  taskKeyFor,
} from "./lib/tasks";
import { makeUiTestData } from "./lib/uiTestData";
import { uiSounds } from "./lib/sounds";
import { useAudioPipeline } from "./hooks/useAudioPipeline";
import { useHandoffFx } from "./hooks/useHandoffFx";
import { useHandControl, type HandState } from "./hooks/useHandControl";
import { useWakeWord } from "./hooks/useWakeWord";
import TopBar from "./components/TopBar";
import CommsPanel from "./components/CommsPanel";
import CameraDock from "./components/CameraDock";
import CenterStage from "./components/CenterStage";
import WorkStream from "./components/WorkStream";
import ReaderOverlay from "./components/ReaderOverlay";
import HistoryDrawer from "./components/HistoryDrawer";
import TaskChooser from "./components/TaskChooser";
import HandoffLayer from "./components/HandoffLayer";
import HandReticles from "./components/HandReticles";
import BootSequence from "./components/BootSequence";
import SetupPanel from "./components/SetupPanel";
import HudShell from "./components/HudShell";
import BrainGraph, { type BrainGraphState, type BrainVoiceCommand } from "./components/BrainGraph";
import ApprovalPrompt from "./components/ApprovalPrompt";
import HermesInteractionPrompt from "./components/HermesInteractionPrompt";

const MAX_LOGS = 80;
const MAX_TASKS_TOTAL = 100;
// Point-and-hold duration before the finger pointer "clicks" what it's over.
const DWELL_MS = 300;

export default function App() {
  const [sidecarRunning, setSidecarRunning] = useState(false);
  const [sidecarPid, setSidecarPid] = useState<number | null>(null);
  const [geminiStatus, setGeminiStatus] = useState("offline");
  const [hermesStatus, setHermesStatus] = useState("offline");
  const [audioState, setAudioState] = useState("idle");
  const [webSearching, setWebSearching] = useState(false);
  const [hermesSummarizing, setHermesSummarizing] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [, setLogs] = useState<LogLine[]>([]);
  const [tasks, setTasks] = useState<TaskCard[]>([]);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  // The reader's steps section is independent from the card's steps toggle —
  // opening steps while reading must not also expand the card behind it.
  const [readerStepsOpen, setReaderStepsOpen] = useState(false);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [taskChooser, setTaskChooser] = useState<{ query: string; matches: TaskCard[] } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [stepsOpenIds, setStepsOpenIds] = useState<Record<string, boolean>>({});
  const [handControl, setHandControl] = useState(false);
  const [testDataEnabled, setTestDataEnabled] = useState(false);
  const [fullConfig, setFullConfig] = useState<IrisConfig | null>(null);
  const [setup, setSetup] = useState<{ mode: "onboarding" | "settings" } | null>(null);
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
  const [wakeSensitivity, setWakeSensitivity] = useState("balanced");
  const [wakeStarting, setWakeStarting] = useState(false);
  const startPromiseRef = useRef<Promise<void> | null>(null);
  // True when the idle timer (not the user) put Iris to sleep.
  const [autoSlept, setAutoSlept] = useState(false);
  const [hermesSession, setHermesSession] = useState<string | null>(null);
  const hermesSessionRef = useRef<string | null>(null);
  hermesSessionRef.current = hermesSession;
  const sessionTasks = useMemo(
    () => tasksForSession(tasks, hermesSession, testDataEnabled),
    [hermesSession, tasks, testDataEnabled],
  );
  const [uiMode, setUiMode] = useState<"deck" | "hud">("deck");
  const uiModeRef = useRef<"deck" | "hud">("deck");
  uiModeRef.current = uiMode;
  // Neural Map (the brain graph) — HUD-only overlay.
  const [brainOpen, setBrainOpen] = useState(false);
  const brainOpenRef = useRef(false);
  brainOpenRef.current = brainOpen;
  const prevBrainOpenRef = useRef(false);
  const [brainCommand, setBrainCommand] = useState<BrainVoiceCommand | null>(null);
  const brainSeqRef = useRef(0);
  const [brainState, setBrainState] = useState<BrainGraphState | null>(null);
  const [bootActive, setBootActive] = useState(false);
  const [bootClosing, setBootClosing] = useState(false);
  const bootStartRef = useRef(0);
  const demoTimersRef = useRef<Set<number>>(new Set());
  // True while the current session is a RESUME of a previous conversation.
  const resumingRef = useRef(false);

  useEffect(
    () => () => {
      demoTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      demoTimersRef.current.clear();
    },
    [],
  );

  // Orb micro-expressions + sound cues.
  const [orbThinking, setOrbThinking] = useState(false);
  const [wakeKey, setWakeKey] = useState(0);
  const [rippleKey, setRippleKey] = useState(0);
  const [soundsEnabled, setSoundsEnabled] = useState(true);
  const soundsRef = useRef(true);
  soundsRef.current = soundsEnabled;
  const audioStateRef = useRef(audioState);
  audioStateRef.current = audioState;

  const hasBridge = typeof window.iris !== "undefined";
  const sessionStartRef = useRef<number | null>(null);
  const orbStageRef = useRef<HTMLDivElement | null>(null);
  const workScrollRef = useRef<HTMLDivElement | null>(null);
  const commsScrollRef = useRef<HTMLDivElement | null>(null);

  function pushLog(level: string, message: string, timestamp = Date.now()) {
    setLogs((current) =>
      [{ id: crypto.randomUUID(), level, message, timestamp }, ...current].slice(0, MAX_LOGS),
    );
  }

  const audio = useAudioPipeline(hasBridge, pushLog, fullConfig?.micDevice || "");
  const { pulses, removePulse, orbFlash, clearOrbFlash, acceptedIds } = useHandoffFx(
    sessionTasks,
    orbStageRef,
    workScrollRef,
    {
      onDelegate: () => {
        if (soundsRef.current) uiSounds.taskSent();
      },
      onComplete: (tone) => {
        if (soundsRef.current) (tone === "error" ? uiSounds.taskFailed : uiSounds.taskDone)();
      },
    },
  );

  // Wake/sleep edges: fire the orb's double-pulse and the audio cues.
  const prevRunningRef = useRef(false);
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = sidecarRunning;
    if (!wasRunning && sidecarRunning) {
      setWakeKey((key) => key + 1);
      if (soundsRef.current) uiSounds.wake();
    } else if (wasRunning && !sidecarRunning) {
      setOrbThinking(false);
      if (soundsRef.current) uiSounds.sleep();
    }
  }, [sidecarRunning]);

  // "Thinking" detector: you stopped talking but Iris hasn't started speaking
  // yet — that gap gets the orbiting swirl. Driven by the real mic level, so
  // it needs no extra events from the model.
  useEffect(() => {
    if (!sidecarRunning) return;
    let talking = false;
    let lastLoudAt = 0;
    let thinkingSince = 0;
    let thinking = false;

    const id = window.setInterval(() => {
      const now = performance.now();
      const level = audio.inputLevelRef.current;
      const speaking = audioStateRef.current === "speaking";
      let next = thinking;

      if (speaking) {
        next = false;
        talking = false;
      } else if (level > 0.13) {
        talking = true;
        lastLoudAt = now;
        next = false;
      } else if (talking && now - lastLoudAt > 420) {
        talking = false;
        thinkingSince = now;
        next = true;
      }
      if (next && now - thinkingSince > 6000) next = false;

      if (next !== thinking) {
        thinking = next;
        setOrbThinking(next);
      }
    }, 120);

    return () => {
      window.clearInterval(id);
      setOrbThinking(false);
    };
  }, [sidecarRunning]);

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
      setSoundsEnabled(config.sounds !== false);
      if (config.loadTestData) loadUiTestData();
      else initHermesSession();
    });
  }, [hasBridge]);

  // Resolve which Hermes chat thread to mirror on boot: the last one used
  // (persisted on every switch). If that thread was deleted in Hermes, fall
  // back to the most recently active Iris session.
  async function initHermesSession() {
    try {
      const [config, list] = await Promise.all([
        window.iris.getConfig(),
        window.iris.listHermesSessions(),
      ]);
      let session = config.hermesSession;
      if (list.ok && list.sessions.length && !list.sessions.some((item) => item.id === session)) {
        session = list.sessions[0].id; // newest first
        await window.iris.saveConfig({ IRIS_HERMES_SESSION: session });
        pushLog("info", `Configured Hermes session was deleted; now using ${session}.`);
      }
      setHermesSession(session);
    } catch {
      // Chip stays hidden if config can't load; history restore still runs.
    }
    restoreHermesHistory();
  }

  // Switch the pinned Hermes chat thread: persists the choice, drops cards
  // restored from the old thread, and hydrates from the new one. Live runs keep
  // updating until they finish regardless of thread.
  async function switchHermesSession(id: string) {
    const clean = id.trim();
    if (!hasBridge || !clean || clean === hermesSession) return;
    const config = await window.iris.saveConfig({ IRIS_HERMES_SESSION: clean });
    setFullConfig(config);
    setHermesSession(config.hermesSession);
    setExpandedTaskId(null);
    setReaderStepsOpen(false);
    setFocusedTaskId(null);
    setTaskChooser(null);
    setShowHistory(false);
    setTasks((current) => current.filter((task) => !task.id.startsWith("history:")));
    pushLog("info", `Hermes chat session: ${config.hermesSession}`);
    await restoreHermesHistory();
  }

  // New thread ids come from Hermes itself (native `api_…` format + an
  // "Iris Voice — <date>" title) so sessions look the same in the Hermes app.
  async function newHermesSession() {
    if (!hasBridge) return;
    const created = await window.iris.createHermesSession();
    if (created.ok && created.id) {
      await switchHermesSession(created.id);
    } else {
      pushLog("error", `Could not create a new Hermes session: ${created.error ?? "Hermes unreachable"}`);
    }
  }

  // Rebuild past completed work from Hermes's own session transcript so results
  // survive an app restart. Live cards always take precedence over restored ones.
  async function restoreHermesHistory() {
    try {
      const history = await window.iris.getHermesHistory();
      if (!history.ok || !history.tasks?.length) return;
      const targetSession = history.sessions?.[0] || hermesSessionRef.current || undefined;
      const restoredTasks = history.tasks.map((task) => ({
        ...task,
        sessionId: task.sessionId || targetSession,
      }));
      setTasks((current) => {
        const seen = new Set(
          current
            .filter((task) => task.sessionId === targetSession)
            .map((task) => task.task.toLowerCase().trim()),
        );
        const restored = restoredTasks.filter((task) => !seen.has(task.task.toLowerCase().trim()));
        if (!restored.length) return current;
        return [...current, ...restored].slice(0, MAX_TASKS_TOTAL);
      });
      pushLog("info", `Restored ${restoredTasks.length} past Hermes runs from this session.`);
    } catch {
      // History restore is best-effort; a fresh stream is not an error.
    }
  }

  useEffect(() => {
    if (!hasBridge) return;
    window.iris.getConfig().then((config) => {
      setFullConfig(config);
      setWakeWordEnabled(config.wakeWord);
      setWakeSensitivity(config.wakeSensitivity || "balanced");
      if (!config.configured) setSetup({ mode: "onboarding" });
    });
  }, [hasBridge]);

  // Glass HUD mode: main process drives the window shape; we mirror it in a
  // root class and re-layout. Tray/hotkey wake+sleep requests run the same
  // renderer flows as W/S so mic capture stays renderer-owned.
  // Choreography: entering HUD, the deck plays a 170ms collapse while the
  // window is still deck-sized, THEN the layout swaps as main goes fullscreen
  // (HUD elements enter with a matching delay). Exiting, the deck mounts
  // invisible and fades in right as main restores the window bounds.
  const [modeTransition, setModeTransition] = useState<"to-hud" | "to-deck" | null>(null);
  const modeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!hasBridge) return;
    const offMode = window.iris.onHudMode(({ mode }) => {
      if (modeTimerRef.current) window.clearTimeout(modeTimerRef.current);
      if (mode === "hud") {
        setModeTransition("to-hud");
        modeTimerRef.current = window.setTimeout(() => {
          setUiMode("hud");
          setModeTransition(null);
        }, 170);
      } else {
        setUiMode("deck");
        setModeTransition("to-deck");
        modeTimerRef.current = window.setTimeout(() => setModeTransition(null), 600);
      }
    });
    const offWake = window.iris.onWakeRequest(() => {
      if (!sidecarRunning) start();
    });
    const offSleep = window.iris.onSleepRequest(() => {
      if (sidecarRunning) stop();
    });
    // Idle auto-sleep: main closed the Gemini session; tear down the mic and
    // playback here but KEEP the camera/hand-control — you may be silently
    // reading the map or the HUD while Iris naps. She auto-wakes for Hermes.
    const offAutoSleep = window.iris.onAutoSleep(() => {
      setAutoSlept(true);
      sessionStartRef.current = null;
      void audio.stopCapture();
      audio.flushPlayback();
      // In the normal deck, release the GPU/camera during standby. HUD and an
      // open Neural Map intentionally retain gesture control.
      if (uiModeRef.current === "deck" && !brainOpenRef.current) setHandControl(false);
    });
    return () => {
      if (modeTimerRef.current) {
        window.clearTimeout(modeTimerRef.current);
        modeTimerRef.current = null;
      }
      offMode();
      offWake();
      offSleep();
      offAutoSleep();
    };
  }, [hasBridge, sidecarRunning]);

  useEffect(() => {
    document.documentElement.classList.toggle("hud-mode", uiMode === "hud");
    // The Neural Map is HUD-only; leaving HUD dismisses it.
    if (uiMode !== "hud") setBrainOpen(false);
  }, [uiMode]);

  // Click-through management: in HUD mode the window ignores the mouse except
  // when the pointer is over a `.hud-hit` element. elementFromPoint respects
  // pointer-events, so it only returns elements that opted in.
  useEffect(() => {
    if (!hasBridge || uiMode !== "hud") return;
    let interactive = false;
    let raf = 0;
    window.iris.setHudInteractive(false);

    const onMove = (event: MouseEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const el = document.elementFromPoint(event.clientX, event.clientY);
        const brainNodeAt = (
          window as unknown as { __brainNodeAt?: (x: number, y: number) => boolean }
        ).__brainNodeAt;
        const next = Boolean(
          el?.closest?.(
            ".hud-hit, .reader-backdrop, .history-backdrop, .match-backdrop, .setup-backdrop, .boot",
          ) ||
            // Neural Map: the canvas is click-through except directly over a
            // node — the desktop stays usable while the map is up.
            brainNodeAt?.(event.clientX, event.clientY),
        );
        if (next !== interactive) {
          interactive = next;
          window.iris.setHudInteractive(next);
        }
      });
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      if (raf) cancelAnimationFrame(raf);
      window.iris.setHudInteractive(false);
    };
  }, [hasBridge, uiMode]);

  // Local "Hey Iris" wake word: only listens while asleep; a detection wakes Iris
  // exactly like pressing ⌥W. Fully on-device, opt-in via Settings.
  // Sensitivity -> score threshold: relaxed wakes easily (quiet rooms / soft
  // voices), strict needs a loud clear phrase. The adaptive noise floor in
  // the hook handles noisy rooms automatically at every level.
  const wakeThreshold = wakeSensitivity === "relaxed" ? 0.08 : wakeSensitivity === "strict" ? 0.2 : 0.12;
  useWakeWord(
    hasBridge && wakeWordEnabled && !sidecarRunning && !wakeStarting,
    () => {
      if (!sidecarRunning) start();
    },
    (message) => pushLog("error", `Wake word: ${message}`),
    wakeThreshold,
    fullConfig?.micDevice || "",
  );

  async function openSettings() {
    if (!hasBridge) return;
    const config = await window.iris.getConfig();
    setFullConfig(config);
    setSetup({ mode: "settings" });
  }

  // Quick device switch (the Zoom-style carets on the main screen). Persists
  // immediately; the live mic hot-swaps without touching the Gemini session,
  // and the camera/wake-word listeners restart on their own via hook deps.
  async function pickDevice(key: "IRIS_MIC_DEVICE" | "IRIS_CAMERA_DEVICE", id: string) {
    if (!hasBridge) return;
    const updated = await window.iris.saveConfig({ [key]: id });
    setFullConfig(updated);
    if (key === "IRIS_MIC_DEVICE" && sidecarRunning) {
      await audio.stopCapture();
      await audio.startCapture(id);
      pushLog("info", "Microphone switched — live.");
    }
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // Alt is OUR modifier (⌥W wake, ⌥S sleep) — only reject meta/ctrl
      // chords and key repeat here.
      if (event.metaKey || event.ctrlKey || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

      // Wake/sleep require the Option modifier so ordinary typing can never
      // toggle Iris. Match on event.code — on macOS Option+letter mutates
      // event.key into a special character (⌥W -> "∑").
      if (event.altKey && event.code === "KeyW" && !sidecarRunning) {
        event.preventDefault();
        start();
        return;
      }
      if (event.altKey && event.code === "KeyS" && sidecarRunning) {
        event.preventDefault();
        stop();
        return;
      }
      if (event.altKey) return; // other ⌥ chords are not ours

      const key = event.key.toLowerCase();
      if (key === "d" && testDataEnabled) {
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

  // Scoped autoscroll: scrollIntoView would also scroll every scrollable
  // ancestor (the rounded deck clips with overflow:hidden), shifting the whole
  // layout up. Scroll the comms panel directly instead.
  useEffect(() => {
    const el = commsScrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [transcript]);

  const working = useMemo(
    () =>
      sessionTasks.some((task) => !TERMINAL.has(task.status.toLowerCase())) &&
      sessionTasks.length > 0,
    [sessionTasks],
  );

  const booting = sidecarRunning && geminiStatus !== "connected";

  // Keep the boot sequence on screen for a minimum time so it plays as an
  // intentional intro instead of a sub-second flicker (Gemini connects fast).
  // Trigger it ONLY on the power-ON edge: during power-off the connection
  // status drops before the sidecar flag does, and that gap used to re-arm
  // the boot screen right as Iris was shutting down.
  const wasRunningRef = useRef(false);
  useEffect(() => {
    const wasRunning = wasRunningRef.current;
    wasRunningRef.current = sidecarRunning;
    if (!sidecarRunning || wasRunning) return;
    if (geminiStatus === "connected") return; // instant resume — skip the intro
    // Resumed conversations (auto-wake for Hermes, quick re-wakes) continue
    // where they left off — the boot ceremony is for cold starts only.
    if (resumingRef.current) return;
    bootStartRef.current = Date.now();
    setBootClosing(false);
    setBootActive(true);
  }, [sidecarRunning, geminiStatus]);

  useEffect(() => {
    if (booting || !bootActive) return;
    const MIN_VISIBLE_MS = 2400;
    const FADE_MS = 450;
    const elapsed = Date.now() - bootStartRef.current;
    let doneTimer: number | undefined;
    const closeTimer = window.setTimeout(() => {
      setBootClosing(true);
      doneTimer = window.setTimeout(() => {
        setBootActive(false);
        setBootClosing(false);
        // Tell main the boot screen is gone so Iris can speak its welcome now.
        if (hasBridge) window.iris.notifyBootDone();
      }, FADE_MS);
    }, Math.max(0, MIN_VISIBLE_MS - elapsed));
    return () => {
      window.clearTimeout(closeTimer);
      if (doneTimer) window.clearTimeout(doneTimer);
    };
  }, [booting, bootActive]);

  const reactorState: ReactorState = useMemo(() => {
    if (!sidecarRunning) return "idle";
    if (audioState === "speaking") return "speaking";
    if (webSearching || hermesSummarizing) return "working";
    if (audioState === "listening") return "listening";
    if (working) return "working";
    if (geminiStatus === "connected") return "online";
    return "idle";
  }, [audioState, geminiStatus, sidecarRunning, webSearching, hermesSummarizing, working]);

  function handleSidecarEvent(event: SidecarEvent) {
    if (event.type === "sidecar_status") {
      // Main flags resumed sessions (context intact) so the boot ceremony
      // only plays for genuine cold starts. Read BEFORE flipping running.
      if ("resuming" in event) resumingRef.current = Boolean((event as { resuming?: unknown }).resuming);
      const status = readStatusObject(event.status);
      setSidecarRunning(Boolean(status.running));
      setSidecarPid(typeof status.pid === "number" ? status.pid : null);
      if (!status.running) {
        setWebSearching(false);
        setHermesSummarizing(false);
      }
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
      const state = readString(event.state, "idle");
      setAudioState(state);
      if (state === "speaking") setHermesSummarizing(false);
      return;
    }

    if (event.type === "google_search") {
      setWebSearching(readString(event.state) === "searching");
      return;
    }

    if (event.type === "transcript") {
      const speaker = readString(event.speaker, "unknown");
      const text = readString(event.text);
      if (text.trim()) {
        // Your words just got locked in — the orb answers with a soft ripple.
        if (/you|user/i.test(speaker)) setRippleKey((key) => key + 1);
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
          sessionId:
            readString(event.session_id) ||
            existing?.sessionId ||
            hermesSessionRef.current ||
            undefined,
          task,
          status,
          output: output || existing?.output,
          error: error || existing?.error,
          updatedAt: eventTime(event),
          steps: existing?.steps,
          notes: existing?.notes,
          approval: existing?.approval,
          interaction: existing?.interaction,
        };
        return [
          next,
          ...current.filter((item) => item.id !== runId && item.id !== placeholderId),
        ].slice(0, MAX_TASKS_TOTAL);
      });
      return;
    }

    if (event.type === "hermes_task_event") {
      const runId = readString(event.run_id);
      if (!runId) return;
      const kind = readString(event.event);
      const approvalRequested =
        kind === "approval.request" || kind === "approval.requested" || kind === "approval.required";
      const approvalResolved = kind === "approval.responded" || kind === "approval.resolved";
      if (approvalRequested && soundsRef.current) {
        uiSounds.approval();
      }
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

        let approval = task.approval;
        if (approvalRequested) {
          const rawChoices = Array.isArray(event.choices) ? event.choices : [];
          const choices = rawChoices.filter(
            (choice): choice is "once" | "session" | "always" | "deny" =>
              choice === "once" || choice === "session" || choice === "always" || choice === "deny",
          );
          approval = {
            command: readString(event.command) || tool || undefined,
            reason: readString(event.reason) || preview || undefined,
            choices: choices.length ? choices : ["once", "session", "always", "deny"],
            requestedAt: ts,
          };
        } else if (approvalResolved) {
          approval = null;
        } else if (kind === "tool.started" && tool) {
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
        } else if (!approvalRequested && !approvalResolved) {
          return current;
        }

        const next = [...current];
        next[index] = { ...task, steps, notes, approval };
        return next;
      });
      return;
    }

    if (event.type === "hermes_completion") {
      setHermesSummarizing(true);
      const task = readString(event.task, "Hermes task");
      const runId = readString(event.run_id) || taskKeyFor(task);
      const output = readString(event.output);
      const status = readString(event.status, "completed");
      const updatedAt = eventTime(event);
      setTasks((current) => {
        const existing = current.find((item) => item.id === runId);
        const completed: TaskCard = {
          id: runId,
          sessionId:
            readString(event.session_id) ||
            existing?.sessionId ||
            hermesSessionRef.current ||
            undefined,
          task,
          status,
          output: output || existing?.output,
          error: existing?.error,
          updatedAt,
          steps: existing?.steps,
          notes: existing?.notes,
          approval: null,
          interaction: null,
        };
        return [
          completed,
          ...current.filter(
            (item) =>
              item.id !== runId &&
              item.id !== taskKeyFor(task),
          ),
        ].slice(0, MAX_TASKS_TOTAL);
      });
      pushLog("info", `Hermes returned: ${task}`, updatedAt);
      return;
    }

    if (event.type === "hermes_interaction") {
      const runId = readString(event.run_id);
      if (!runId) return;
      const action = readString(event.action);
      if (action === "request") {
        const raw =
          event.interaction && typeof event.interaction === "object"
            ? (event.interaction as Record<string, unknown>)
            : {};
        const type = readString(raw.type);
        if (type !== "clarify" && type !== "approval" && type !== "sudo" && type !== "secret") {
          return;
        }
        const interaction = {
          id: readString(raw.id),
          type,
          question: readString(raw.question, "Hermes needs your input."),
          choices: Array.isArray(raw.choices) ? raw.choices.map(String).slice(0, 8) : [],
          command: readString(raw.command) || undefined,
          envVar: readString(raw.envVar) || undefined,
          allowCustom: raw.allowCustom !== false,
          secret: raw.secret === true,
        } as const;
        if (soundsRef.current) uiSounds.approval();
        setTasks((current) =>
          current.map((task) =>
            task.id === runId ? { ...task, status: type === "approval" ? "waiting_for_approval" : "waiting_for_input", interaction } : task,
          ),
        );
      } else if (action === "resolved") {
        setTasks((current) =>
          current.map((task) =>
            task.id === runId ? { ...task, interaction: null, status: "running" } : task,
          ),
        );
      } else if (action === "voice_preview") {
        const value = readString(event.value);
        setTasks((current) =>
          current.map((task) =>
            task.id === runId && task.interaction
              ? {
                  ...task,
                  interaction: {
                    ...task.interaction,
                    voiceValue: value,
                    voiceSubmitting: true,
                    resolving: true,
                    error: undefined,
                  },
                }
              : task,
          ),
        );
      } else if (action === "response_error") {
        setTasks((current) =>
          current.map((task) =>
            task.id === runId && task.interaction
              ? {
                  ...task,
                  interaction: {
                    ...task.interaction,
                    voiceSubmitting: false,
                    resolving: false,
                    error: readString(event.error, "Could not send the voice response."),
                  },
                }
              : task,
          ),
        );
      }
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
    if (startPromiseRef.current) return startPromiseRef.current;
    const operation = (async () => {
      if (!hasBridge) {
        pushLog("error", "Electron bridge unavailable. Launch with `npm run dev`.");
        return;
      }
      setWakeStarting(true);
      setAutoSlept(false);
      try {
        const status = await window.iris.startSidecar({ mode: "none" });
        if (!status.running) throw new Error("Gemini Live did not start.");
        setSidecarRunning(true);
        setSidecarPid(status.pid);
        sessionStartRef.current = Date.now();
        await audio.startCapture();
        setHandControl(true);
      } catch (error) {
        await audio.stopCapture();
        setSidecarRunning(false);
        setSidecarPid(null);
        sessionStartRef.current = null;
        pushLog("error", `Wake failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setWakeStarting(false);
      }
    })();
    startPromiseRef.current = operation;
    try {
      await operation;
    } finally {
      if (startPromiseRef.current === operation) startPromiseRef.current = null;
    }
  }

  async function stop() {
    if (!hasBridge) return;
    setAutoSlept(false);
    await audio.stopCapture();
    audio.flushPlayback();
    await window.iris.stopSidecar();
    setGeminiStatus("offline");
    setHermesStatus("offline");
    setAudioState("idle");
    setHandControl(false);
    sessionStartRef.current = null;
  }

  async function resolveTaskApproval(
    task: TaskCard,
    choice: "once" | "session" | "always" | "deny",
  ) {
    if (!hasBridge || !task.approval || task.approval.resolving) return;
    setTasks((current) =>
      current.map((item) =>
        item.id === task.id && item.approval
          ? { ...item, approval: { ...item.approval, resolving: true, error: undefined } }
          : item,
      ),
    );
    try {
      const result = await window.iris.approveHermesAction(task.id, choice);
      if (result.status === "resolved") {
        setTasks((current) =>
          current.map((item) => (item.id === task.id ? { ...item, approval: null } : item)),
        );
      } else {
        throw new Error(result.error || "Hermes did not accept the approval response.");
      }
    } catch (error) {
      setTasks((current) =>
        current.map((item) =>
          item.id === task.id && item.approval
            ? {
                ...item,
                approval: {
                  ...item.approval,
                  resolving: false,
                  error: error instanceof Error ? error.message : String(error),
                },
              }
            : item,
        ),
      );
    }
  }

  async function resolveHermesInteraction(
    task: TaskCard,
    value: string,
    choice?: "once" | "session" | "always" | "deny",
  ) {
    const interaction = task.interaction;
    if (!hasBridge || !interaction || interaction.resolving) return;
    setTasks((current) =>
      current.map((item) =>
        item.id === task.id && item.interaction
          ? {
              ...item,
              interaction: { ...item.interaction, resolving: true, error: undefined },
            }
          : item,
      ),
    );
    try {
      const result = await window.iris.respondHermesInteraction({
        run_id: task.id,
        interaction_id: interaction.id,
        interaction_type: interaction.type,
        value,
        choice,
      });
      if (result.status !== "resolved") {
        throw new Error(result.error || "Hermes did not accept the response.");
      }
      setTasks((current) =>
        current.map((item) =>
          item.id === task.id ? { ...item, interaction: null, status: "running" } : item,
        ),
      );
    } catch (error) {
      setTasks((current) =>
        current.map((item) =>
          item.id === task.id && item.interaction
            ? {
                ...item,
                interaction: {
                  ...item.interaction,
                  resolving: false,
                  error: error instanceof Error ? error.message : String(error),
                },
              }
            : item,
        ),
      );
    }
  }

  function dotState(value: string, goodValues: string[]) {
    if (!sidecarRunning) return "off";
    if (value === "error") return "err";
    return goodValues.includes(value) ? "on" : "warn";
  }

  const expandedTask = useMemo(
    () => sessionTasks.find((task) => task.id === expandedTaskId) ?? null,
    [sessionTasks, expandedTaskId],
  );
  const dwellRef = useRef<{ el: HTMLElement; startedAt: number; fired: boolean } | null>(null);

  const { state: hand, error: handError, stream: handStream } = useHandControl(
    handControl,
    fullConfig?.cameraDevice || "",
  );
  const liveHandRef = useRef<HandState | null>(hand);
  liveHandRef.current = hand;

  useEffect(() => {
    if (handError) pushLog("error", `Hand control: ${handError}`);
  }, [handError]);

  // Universal point-and-hold: the finger pointer can activate ANY clickable
  // element — task cards, step toggles, the comms chip, close buttons, HUD
  // controls. Holding over a target for DWELL_MS fires a real click; the
  // target must be left and re-entered before it can fire again.
  useEffect(() => {
    if (!handControl || !hand.present || !hand.point || !hand.pointing) {
      dwellRef.current = null;
      return;
    }

    const el = document.elementFromPoint(hand.point.x, hand.point.y);
    // A steps region (strip + expanded timeline, on cards or in the reader) is
    // one big toggle target: pointing anywhere inside it opens/closes steps —
    // it must never fall through to the card underneath.
    const stepsArea = el?.closest<HTMLElement>(".activity, .reader-steps");
    const actionable = stepsArea
      ? stepsArea.querySelector<HTMLElement>(".activity-toggle")
      : el?.closest<HTMLElement>(
          'button, a, input, textarea, [data-task-id], [role="button"]',
        ) ?? null;
    if (!actionable) {
      dwellRef.current = null;
      return;
    }

    const taskId = actionable.closest<HTMLElement>("[data-task-id]")?.dataset.taskId;
    if (taskId) setFocusedTaskId(taskId);

    const now = performance.now();
    if (dwellRef.current?.el !== actionable) {
      dwellRef.current = { el: actionable, startedAt: now, fired: false };
      return;
    }

    if (!dwellRef.current.fired && now - dwellRef.current.startedAt > DWELL_MS) {
      dwellRef.current.fired = true;
      actionable.click();
    }
  }, [handControl, hand.present, hand.point?.x, hand.point?.y, hand.pointing, sessionTasks]);

  // Open-palm hold-to-scroll: scrolls whichever scrollable region is under the
  // hand — an expanded steps timeline inside a card, the Comms/Work columns
  // (deck or HUD), or the history grid. Innermost region wins, so palm over a
  // card's step list scrolls the steps, not the column behind it. The open
  // reader runs its own loop.
  useEffect(() => {
    let raf = 0;
    const SCROLLABLES =
      ".activity-timeline, .hud-comms, .comms-scroll, .work-scroll, .hud-work, .history-grid, .brain-note-body, .brain-links-list, .hermes-interaction-prompt";
    const loop = () => {
      const h = liveHandRef.current;
      if (handControl && h?.openPalm && h.point && !expandedTaskId) {
        const el = document.elementFromPoint(h.point.x, h.point.y);
        const target = el?.closest<HTMLElement>(SCROLLABLES) ?? null;
        if (target) {
          const rect = target.getBoundingClientRect();
          const center = rect.top + rect.height / 2;
          const deadZone = Math.max(24, rect.height * 0.12);
          const delta = h.point.y - center;
          if (Math.abs(delta) > deadZone) {
            const reach = rect.height / 2 - deadZone;
            const norm = Math.max(-1, Math.min(1, (delta - Math.sign(delta) * deadZone) / reach));
            target.scrollTop += norm * 26;
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [handControl, expandedTaskId]);

  const handAction = useMemo(() => {
    if (!hand.present) return { label: "Show your hand", tone: "idle" };
    if (hand.hands.some((item) => item.pinch)) return { label: "PINCH · grab", tone: "pinch" };
    if (hand.hands.filter((item) => item.openPalm).length >= 2) return { label: "Two palms · resize", tone: "open" };
    if (hand.fist) return { label: "Closed_Fist · close", tone: "fist" };
    if (hand.openPalm) return { label: "Open_Palm · scroll", tone: "open" };
    if (!hand.pointing) return { label: `${hand.gesture} · idle`, tone: "idle" };
    if (dwellRef.current) return { label: "Hold · opening", tone: "move" };
    return { label: "Pointing_Up · hover", tone: "move" };
  }, [hand.present, hand.hands, hand.fist, hand.openPalm, hand.pointing, hand.gesture, hand.point?.x, hand.point?.y]);

  function setTaskStepsOpen(id: string, open: boolean) {
    setStepsOpenIds((current) => ({ ...current, [id]: open }));
  }

  function toggleTaskSteps(id: string) {
    setStepsOpenIds((current) => ({ ...current, [id]: !current[id] }));
  }

  const sortedTasks = useMemo(() => {
    const isActive = (task: TaskCard) => !TERMINAL.has(task.status.toLowerCase());
    return [...sessionTasks].sort((a, b) => {
      const activeDelta = Number(isActive(b)) - Number(isActive(a));
      if (activeDelta !== 0) return activeDelta;
      return b.updatedAt - a.updatedAt;
    });
  }, [sessionTasks]);

  const pendingApprovalTask = useMemo(
    () =>
      sortedTasks.find((task) => Boolean(task.approval) && !task.interaction) ?? null,
    [sortedTasks],
  );
  const pendingInteractionTask = useMemo(
    () => sortedTasks.find((task) => Boolean(task.interaction)) ?? null,
    [sortedTasks],
  );

  const latestResultTask = useMemo(
    () => sortedTasks.find((task) => Boolean(task.output || task.error)) ?? null,
    [sortedTasks],
  );

  function openTaskByQuery(query?: string) {
    const matches = findTaskMatches(sortedTasks, query);
    if (matches.length === 0) return;

    const [best, second] = matches;
    const clearWinner = !second || best.score - second.score >= 3;
    if (clearWinner) {
      openTask(best.task);
      return;
    }

    setTaskChooser({ query: query || "task", matches: matches.map((match) => match.task) });
  }

  // The Neural Map is voice + gesture native: opening it brings up the mic
  // (wake) and the gesture camera automatically when they're not already on.
  useEffect(() => {
    const wasOpen = prevBrainOpenRef.current;
    prevBrainOpenRef.current = brainOpen;
    if (!brainOpen || wasOpen) return;
    if (!sidecarRunning) void start(); // start() also enables the camera
    else if (!handControl) setHandControl(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brainOpen]);

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
      brainOpen,
      // While the map is open Gemini can see what exists and what's in focus,
      // so "focus on X" / "open it" resolve against real titles.
      brainNodes: brainOpen ? brainState?.nodeTitles ?? [] : undefined,
      brainFocusedNote: brainOpen ? brainState?.focusedTitle ?? null : null,
      brainOpenNote: brainOpen ? brainState?.openNoteTitle ?? null : null,
      // Isolation ("local graph") filter: which note the map is filtered to
      // and the connected notes currently visible around it.
      brainIsolatedNote: brainOpen ? brainState?.isolatedTitle ?? null : null,
      brainIsolationNeighbors: brainOpen ? brainState?.isolationNeighbors ?? null : null,
      brainFilterQuery: brainOpen ? brainState?.filterQuery ?? null : null,
      brainFilterMatches: brainOpen ? brainState?.filterMatches ?? null : null,
      tasks: sortedTasks.map((task) => ({
        id: task.id,
        task: task.task,
        status: task.status,
        hasResult: Boolean(task.output || task.error),
        stepCount: task.steps?.length ?? 0,
        stepsOpen: Boolean(stepsOpenIds[task.id]),
        interactionType: task.interaction?.secret ? "secure_ui" : task.interaction?.type ?? null,
        waitingForInput: Boolean(task.interaction || task.approval),
        updatedAt: task.updatedAt,
      })),
    });
  }, [hasBridge, expandedTaskId, focusedTaskId, latestResultTask?.id, showHistory, brainOpen, brainState, sortedTasks, stepsOpenIds, taskChooser]);

  useEffect(() => {
    if (!hasBridge) return;
    return window.iris.onUiAction(({ action, target_id, query }) => {
      const taskById = target_id ? sessionTasks.find((task) => task.id === target_id) : null;
      const currentTask = expandedTaskId
        ? sessionTasks.find((task) => task.id === expandedTaskId)
        : null;
      const focusedTask = focusedTaskId
        ? sessionTasks.find((task) => task.id === focusedTaskId)
        : null;
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
        setBrainOpen(false);
        return;
      }
      if (action === "enter_hud_mode") {
        if (uiMode !== "hud") window.iris.toggleHud();
        return;
      }
      if (action === "exit_hud_mode") {
        if (uiMode === "hud") window.iris.toggleHud();
        return;
      }
      if (action === "open_brain_graph") {
        // HUD-only feature: entering HUD automatically is part of the wow.
        if (uiMode !== "hud") window.iris.toggleHud();
        setBrainOpen(true);
        return;
      }
      if (action === "close_brain_graph") {
        setBrainOpen(false);
        return;
      }
      if (
        action === "focus_brain_node" ||
        action === "filter_brain_graph" ||
        action === "open_brain_note" ||
        action === "close_brain_note" ||
        action === "show_full_brain_graph"
      ) {
        // Focus/filter/open auto-open the map; the command executes once the
        // graph is mounted and its data is ready (BrainGraph tracks the seq).
        if (action === "focus_brain_node" || action === "filter_brain_graph" || action === "open_brain_note") {
          if (uiMode !== "hud") window.iris.toggleHud();
          setBrainOpen(true);
        }
        brainSeqRef.current += 1;
        setBrainCommand({
          seq: brainSeqRef.current,
          kind:
            action === "focus_brain_node"
              ? "focus"
              : action === "filter_brain_graph"
                ? "filter"
                : action === "open_brain_note"
                  ? "open"
                  : action === "close_brain_note"
                    ? "close"
                    : "showAll",
          query: query || undefined,
        });
        return;
      }
      if (action === "show_task_steps" || action === "hide_task_steps") {
        // Priority: explicit id -> spoken query words -> the card the user is
        // looking at (expanded reader, then focused) -> the running task ->
        // latest result. The old order preferred the running task over the
        // card being viewed, which targeted the wrong card by voice.
        const byQuery = !taskById && query ? findTaskMatches(sortedTasks, query)[0]?.task ?? null : null;
        const activeTask = sessionTasks.find(
          (task) => !TERMINAL.has(task.status.toLowerCase()),
        );
        const target = taskById || byQuery || currentTask || focusedTask || activeTask || latestResultTask;
        if (!target) return;
        // Steps for the card being read open INSIDE the reader, not on the
        // card hidden behind it.
        if (expandedTaskId && target.id === expandedTaskId) {
          setReaderStepsOpen(action === "show_task_steps");
        } else {
          setTaskStepsOpen(target.id, action === "show_task_steps");
        }
        return;
      }
    });
  }, [
    hasBridge,
    sessionTasks,
    sortedTasks,
    expandedTaskId,
    focusedTaskId,
    latestResultTask,
    uiMode,
  ]);

  // `compact` marks short status pills (Listening…, Speaking…) that render
  // whisper-sized in the HUD; real conversation captions stay full size.
  const caption = useMemo(() => {
    if (!sidecarRunning)
      return {
        // Mention Hermes waking her ONLY when a task is actually running —
        // otherwise it's just a quiet nap.
        text: autoSlept
          ? working
            ? "On standby — Hermes is working; I'll wake when it's done"
            : wakeWordEnabled
              ? "On standby, saving tokens — say “Hey Iris”"
              : "On standby, saving tokens — press ⌥W to wake"
          : wakeWordEnabled
            ? "Say “Hey Iris” or press ⌥W to wake"
            : "Press ⌥W to wake Iris",
        dim: true,
        compact: true,
      };
    if (webSearching) return { text: "Searching Google…", dim: false, compact: true };
    if (hermesSummarizing)
      return { text: "Hermes is back — Iris is summarizing…", dim: false, compact: true };
    if (audioState === "speaking") return { text: "Speaking…", dim: false, compact: true };
    if (audioState === "listening") return { text: "Listening…", dim: false, compact: true };
    if (working) return { text: "Working on it…", dim: false, compact: true };
    const last = transcript[transcript.length - 1];
    if (last) return { text: last.text, dim: false, compact: false };
    if (geminiStatus === "connected") return { text: "How can I help?", dim: true, compact: true };
    return { text: "Connecting…", dim: true, compact: true };
  }, [sidecarRunning, webSearching, hermesSummarizing, audioState, working, transcript, geminiStatus, wakeWordEnabled, autoSlept]);

  function openTask(task: TaskCard) {
    if (!(task.output || task.error)) return;
    setTaskChooser(null);
    setExpandedTaskId(task.id);
    setReaderStepsOpen(false);
    setShowHistory(false);
  }

  function closeReader() {
    setExpandedTaskId(null);
    setReaderStepsOpen(false);
  }

  // Dev-only (testDataEnabled): drive a full delegation -> completion through the
  // real setTasks path so the visual handoff can be previewed end to end.
  function simulateHandoff() {
    const id = `demo-${crypto.randomUUID().slice(0, 8)}`;
    const task = `Research the latest AI agent frameworks (${new Date().toLocaleTimeString()}).`;
    setTasks((current) =>
      [{ id, task, status: "working", updatedAt: Date.now() }, ...current].slice(
        0,
        MAX_TASKS_TOTAL,
      ),
    );
    const timer = window.setTimeout(() => {
      demoTimersRef.current.delete(timer);
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
    demoTimersRef.current.add(timer);
  }

  function loadUiTestData() {
    const fixture = makeUiTestData();
    setTasks(fixture.tasks);
    setTranscript(fixture.transcript);
    pushLog("info", "Loaded UI test fixture data.");
  }

  const audioDot = !sidecarRunning
    ? "off"
    : audio.muted
      ? "warn"
      : audioState === "speaking"
        ? "speaking"
        : audioState === "idle"
          ? "warn"
          : "on";

  return (
    <>
      {uiMode === "hud" ? (
        <HudShell
          reactorState={reactorState}
          inputLevelRef={audio.inputLevelRef}
          outputLevelRef={audio.outputLevelRef}
          thinking={orbThinking}
          wakeKey={wakeKey}
          rippleKey={rippleKey}
          orbStageRef={orbStageRef}
          orbFlash={orbFlash}
          onOrbFlashEnd={clearOrbFlash}
          awake={sidecarRunning}
          caption={caption.text}
          captionDim={caption.dim}
          captionCompact={caption.compact}
          muted={audio.muted}
          onToggleMute={audio.toggleMute}
          onWake={start}
          onSleep={stop}
          onExitHud={() => window.iris.toggleHud()}
          tasks={sortedTasks}
          acceptedIds={acceptedIds}
          stepsOpenIds={stepsOpenIds}
          workScrollRef={workScrollRef}
          onToggleSteps={toggleTaskSteps}
          onFocusTask={setFocusedTaskId}
          onOpenTask={openTask}
          onApproveTask={(task, choice) => void resolveTaskApproval(task, choice)}
          transcript={transcript}
          commsScrollRef={commsScrollRef}
          handControl={handControl}
          onToggleHand={() => setHandControl((current) => !current)}
          hand={hand}
          handStream={handStream}
          handError={handError}
          handActionLabel={handAction.label}
          handActionTone={handAction.tone}
          brainAvailable={Boolean(fullConfig?.brainPath)}
          brainOpen={brainOpen}
          onOpenBrain={() => setBrainOpen((current) => !current)}
          autoSlept={autoSlept}
        />
      ) : (
      <div
        className={`deck ${sidecarRunning ? "awake" : "asleep"} ${
          modeTransition === "to-hud" ? "deck-leaving" : ""
        } ${modeTransition === "to-deck" ? "deck-entering" : ""}`}
      >
        <div className="hud-nebula" />
        <div className="hud-glow" />
        <div className="hud-vignette" />

        <TopBar
          geminiDot={dotState(geminiStatus, ["connected"])}
          hermesDot={dotState(hermesStatus, ["ready"])}
          audioDot={audioDot}
          linked={sidecarRunning}
          pid={sidecarPid}
          handControl={handControl}
          onToggleHand={() => setHandControl((current) => !current)}
          onOpenSettings={openSettings}
        />

        <div className="deck-body">
          {/* LEFT — You */}
          <div className="deck-left">
            <CommsPanel
              transcript={transcript}
              scrollRef={commsScrollRef}
              testDataEnabled={testDataEnabled}
              onLoadDemo={loadUiTestData}
            />
            <CameraDock
              handControl={handControl}
              hand={hand}
              stream={handStream}
              error={handError}
              actionLabel={handAction.label}
              actionTone={handAction.tone}
              cameraDevice={fullConfig?.cameraDevice || ""}
              onPickCameraDevice={(id) => void pickDevice("IRIS_CAMERA_DEVICE", id)}
            />
          </div>

          {/* CENTER — Iris */}
          <CenterStage
            reactorState={reactorState}
            inputLevelRef={audio.inputLevelRef}
            outputLevelRef={audio.outputLevelRef}
            thinking={orbThinking}
            wakeKey={wakeKey}
            rippleKey={rippleKey}
            orbStageRef={orbStageRef}
            orbFlash={orbFlash}
            onOrbFlashEnd={clearOrbFlash}
            awake={sidecarRunning}
            geminiStatus={geminiStatus}
            hermesStatus={hermesStatus}
            runs={sessionTasks.length}
            sessionStartRef={sessionStartRef}
            caption={caption.text}
            captionDim={caption.dim}
            muted={audio.muted}
            onToggleMute={audio.toggleMute}
            onSleep={stop}
            wakeWordEnabled={wakeWordEnabled}
            autoSlept={autoSlept}
            hermesWorking={working}
            micDevice={fullConfig?.micDevice || ""}
            onPickMicDevice={(id) => void pickDevice("IRIS_MIC_DEVICE", id)}
          />

          {/* RIGHT — Work */}
          <WorkStream
            tasks={sessionTasks}
            sortedTasks={sortedTasks}
            scrollRef={workScrollRef}
            acceptedIds={acceptedIds}
            stepsOpenIds={stepsOpenIds}
            testDataEnabled={testDataEnabled}
            session={testDataEnabled ? null : hermesSession}
            onSwitchSession={switchHermesSession}
            onNewSession={newHermesSession}
            onLoadDemo={loadUiTestData}
            onShowHistory={() => setShowHistory(true)}
            onToggleSteps={toggleTaskSteps}
            onFocusTask={setFocusedTaskId}
            onOpenTask={openTask}
            onApproveTask={(task, choice) => void resolveTaskApproval(task, choice)}
          />
        </div>

        <footer className="deck-foot">
          <span className="build-meta">
            IRIS · build 0.2.0 · by Ashutosh Shrivastava ·{" "}
            <a href="https://x.com/ai_for_success" target="_blank" rel="noreferrer">
              X
            </a>{" "}
            ·{" "}
            <a href="https://github.com/ASHR12/iris" target="_blank" rel="noreferrer">
              GitHub
            </a>
          </span>
        </footer>
      </div>
      )}

      {uiMode === "hud" && brainOpen ? (
        <BrainGraph
          hand={handControl ? hand : null}
          active={!expandedTask}
          onClose={() => setBrainOpen(false)}
          voiceCommand={brainCommand}
          onGraphState={setBrainState}
        />
      ) : null}

      {expandedTask ? (
        <ReaderOverlay
          task={expandedTask}
          hand={handControl ? hand : null}
          stepsOpen={readerStepsOpen}
          onToggleSteps={() => setReaderStepsOpen((current) => !current)}
          onClose={closeReader}
        />
      ) : null}

      {showHistory ? (
        <HistoryDrawer tasks={sortedTasks} onOpen={openTask} onClose={() => setShowHistory(false)} />
      ) : null}

      {taskChooser ? (
        <TaskChooser
          query={taskChooser.query}
          matches={taskChooser.matches}
          onOpen={openTask}
          onClose={() => setTaskChooser(null)}
        />
      ) : null}

      {bootActive ? <BootSequence visible closing={bootClosing} compact={uiMode === "hud"} /> : null}

      {setup && fullConfig ? (
        <SetupPanel
          mode={setup.mode}
          config={fullConfig}
          onClose={() => setSetup(null)}
          onSaved={(config) => {
            setFullConfig(config);
            setTestDataEnabled(config.loadTestData);
            setWakeWordEnabled(config.wakeWord);
            setWakeSensitivity(config.wakeSensitivity || "balanced");
            setSoundsEnabled(config.sounds);
          }}
          onStart={() => {
            if (!sidecarRunning) start();
          }}
          onRunWizard={() => setSetup({ mode: "onboarding" })}
        />
      ) : null}

      {pendingApprovalTask ? (
        <ApprovalPrompt
          task={pendingApprovalTask}
          onResolve={(choice) => void resolveTaskApproval(pendingApprovalTask, choice)}
        />
      ) : null}

      {pendingInteractionTask ? (
        <HermesInteractionPrompt
          task={pendingInteractionTask}
          onResolve={(value, choice) =>
            void resolveHermesInteraction(pendingInteractionTask, value, choice)
          }
        />
      ) : null}

      <HandoffLayer pulses={pulses} onPulseEnd={removePulse} />

      {handControl && hand.present ? (
        <HandReticles hand={hand} dwelling={Boolean(dwellRef.current && !dwellRef.current.fired)} />
      ) : null}
    </>
  );
}
