import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactorState, TaskCard, LogLine, TranscriptLine } from "./types";
import {
  TERMINAL,
  eventTime,
  findTaskMatches,
  readString,
  readStatusObject,
  taskKeyFor,
} from "./lib/tasks";
import { makeUiTestData } from "./lib/uiTestData";
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

const MAX_LOGS = 80;
// Point-and-hold duration before the finger pointer "clicks" what it's over.
const DWELL_MS = 300;

export default function App() {
  const [sidecarRunning, setSidecarRunning] = useState(false);
  const [sidecarPid, setSidecarPid] = useState<number | null>(null);
  const [geminiStatus, setGeminiStatus] = useState("offline");
  const [hermesStatus, setHermesStatus] = useState("offline");
  const [audioState, setAudioState] = useState("idle");
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
  const [hermesSession, setHermesSession] = useState<string | null>(null);
  const [uiMode, setUiMode] = useState<"deck" | "hud">("deck");
  const [bootActive, setBootActive] = useState(false);
  const [bootClosing, setBootClosing] = useState(false);
  const bootStartRef = useRef(0);

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

  const audio = useAudioPipeline(hasBridge, pushLog);
  const { pulses, removePulse, orbFlash, clearOrbFlash, acceptedIds } = useHandoffFx(
    tasks,
    orbStageRef,
    workScrollRef,
  );

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
      const restoredTasks = history.tasks;
      setTasks((current) => {
        const seen = new Set(current.map((task) => task.task.toLowerCase().trim()));
        const restored = restoredTasks.filter((task) => !seen.has(task.task.toLowerCase().trim()));
        if (!restored.length) return current;
        return [...current, ...restored].slice(0, 20);
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
    return () => {
      offMode();
      offWake();
      offSleep();
    };
  }, [hasBridge, sidecarRunning]);

  useEffect(() => {
    document.documentElement.classList.toggle("hud-mode", uiMode === "hud");
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
        const next = Boolean(
          el?.closest?.(
            ".hud-hit, .reader-backdrop, .history-backdrop, .match-backdrop, .setup-backdrop, .boot",
          ),
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
  // exactly like pressing W. Fully on-device, opt-in via Settings.
  useWakeWord(
    hasBridge && wakeWordEnabled && !sidecarRunning,
    () => {
      if (!sidecarRunning) start();
    },
    (message) => pushLog("error", `Wake word: ${message}`),
  );

  async function openSettings() {
    if (!hasBridge) return;
    const config = await window.iris.getConfig();
    setFullConfig(config);
    setSetup({ mode: "settings" });
  }

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

  // Scoped autoscroll: scrollIntoView would also scroll every scrollable
  // ancestor (the rounded deck clips with overflow:hidden), shifting the whole
  // layout up. Scroll the comms panel directly instead.
  useEffect(() => {
    const el = commsScrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [transcript]);

  const working = useMemo(
    () => tasks.some((task) => !TERMINAL.has(task.status.toLowerCase())) && tasks.length > 0,
    [tasks],
  );

  const booting = sidecarRunning && geminiStatus !== "connected";

  // Keep the boot sequence on screen for a minimum time so it plays as an
  // intentional intro instead of a sub-second flicker (Gemini connects fast).
  useEffect(() => {
    if (!booting) return;
    bootStartRef.current = Date.now();
    setBootClosing(false);
    setBootActive(true);
  }, [booting]);

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
    if (audioState === "listening") return "listening";
    if (working) return "working";
    if (geminiStatus === "connected") return "online";
    return "idle";
  }, [audioState, geminiStatus, sidecarRunning, working]);

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
    await audio.startCapture();
    setHandControl(true);
  }

  async function stop() {
    if (!hasBridge) return;
    await audio.stopCapture();
    audio.flushPlayback();
    await window.iris.stopSidecar();
    setGeminiStatus("offline");
    setHermesStatus("offline");
    setAudioState("idle");
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
  const dwellRef = useRef<{ el: HTMLElement; startedAt: number; fired: boolean } | null>(null);

  const { state: hand, error: handError, stream: handStream } = useHandControl(handControl);
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
      : el?.closest<HTMLElement>('button, a, [data-task-id], [role="button"]') ?? null;
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
  }, [handControl, hand.present, hand.point?.x, hand.point?.y, hand.pointing, tasks]);

  // Open-palm hold-to-scroll: scrolls whichever scrollable region is under the
  // hand — an expanded steps timeline inside a card, the Comms/Work columns
  // (deck or HUD), or the history grid. Innermost region wins, so palm over a
  // card's step list scrolls the steps, not the column behind it. The open
  // reader runs its own loop.
  useEffect(() => {
    let raf = 0;
    const SCROLLABLES =
      ".activity-timeline, .hud-comms, .comms-scroll, .work-scroll, .hud-work, .history-grid";
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
        // Priority: explicit id -> spoken query words -> the card the user is
        // looking at (expanded reader, then focused) -> the running task ->
        // latest result. The old order preferred the running task over the
        // card being viewed, which targeted the wrong card by voice.
        const byQuery = !taskById && query ? findTaskMatches(sortedTasks, query)[0]?.task ?? null : null;
        const activeTask = tasks.find((task) => !TERMINAL.has(task.status.toLowerCase()));
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
  }, [hasBridge, tasks, sortedTasks, expandedTaskId, focusedTaskId, latestResultTask]);

  const caption = useMemo(() => {
    if (!sidecarRunning)
      return {
        text: wakeWordEnabled ? "Say “Hey Iris” or press W to wake" : "Press W to wake Iris",
        dim: true,
      };
    if (audioState === "speaking") return { text: "Speaking…", dim: false };
    if (audioState === "listening") return { text: "Listening…", dim: false };
    if (working) return { text: "Working on it…", dim: false };
    const last = transcript[transcript.length - 1];
    if (last) return { text: last.text, dim: false };
    if (geminiStatus === "connected") return { text: "How can I help?", dim: true };
    return { text: "Connecting…", dim: true };
  }, [sidecarRunning, audioState, working, transcript, geminiStatus, wakeWordEnabled]);

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
          audioLevelRef={audio.audioLevelRef}
          orbStageRef={orbStageRef}
          orbFlash={orbFlash}
          onOrbFlashEnd={clearOrbFlash}
          awake={sidecarRunning}
          caption={caption.text}
          captionDim={caption.dim}
          wakeWordEnabled={wakeWordEnabled}
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
          transcript={transcript}
          commsScrollRef={commsScrollRef}
          handControl={handControl}
          onToggleHand={() => setHandControl((current) => !current)}
          hand={hand}
          handStream={handStream}
          handActionLabel={handAction.label}
          handActionTone={handAction.tone}
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
              actionLabel={handAction.label}
              actionTone={handAction.tone}
            />
          </div>

          {/* CENTER — Iris */}
          <CenterStage
            reactorState={reactorState}
            audioLevelRef={audio.audioLevelRef}
            orbStageRef={orbStageRef}
            orbFlash={orbFlash}
            onOrbFlashEnd={clearOrbFlash}
            awake={sidecarRunning}
            geminiStatus={geminiStatus}
            hermesStatus={hermesStatus}
            runs={tasks.length}
            sessionStartRef={sessionStartRef}
            caption={caption.text}
            captionDim={caption.dim}
            muted={audio.muted}
            onToggleMute={audio.toggleMute}
            onSleep={stop}
            wakeWordEnabled={wakeWordEnabled}
          />

          {/* RIGHT — Work */}
          <WorkStream
            tasks={tasks}
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
          }}
          onStart={() => {
            if (!sidecarRunning) start();
          }}
          onRunWizard={() => setSetup({ mode: "onboarding" })}
        />
      ) : null}

      <HandoffLayer pulses={pulses} onPulseEnd={removePulse} />

      {handControl && hand.present ? (
        <HandReticles hand={hand} dwelling={Boolean(dwellRef.current && !dwellRef.current.fired)} />
      ) : null}
    </>
  );
}
