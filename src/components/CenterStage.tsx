import { useEffect, useState, type CSSProperties, type RefObject } from "react";
import { Mic, MicOff, Power } from "lucide-react";
import ReactorCore from "./ReactorCore";
import type { HandoffTone, ReactorState } from "../types";

// Arc-reactor accent color per state (matches ReactorCore palettes) — drives the
// surrounding ring/radar so it stays the same color as the orb.
const ORB_ACCENT: Record<ReactorState, string> = {
  idle: "120, 170, 150",
  online: "18, 163, 148",
  listening: "40, 205, 170",
  speaking: "238, 122, 92",
  working: "120, 180, 120",
};

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

export default function CenterStage({
  reactorState,
  inputLevelRef,
  outputLevelRef,
  thinking,
  wakeKey,
  rippleKey,
  orbStageRef,
  orbFlash,
  onOrbFlashEnd,
  awake,
  geminiStatus,
  hermesStatus,
  runs,
  sessionStartRef,
  caption,
  captionDim,
  muted,
  onToggleMute,
  onSleep,
  wakeWordEnabled,
}: {
  reactorState: ReactorState;
  inputLevelRef: { current: number };
  outputLevelRef: { current: number };
  thinking: boolean;
  wakeKey: number;
  rippleKey: number;
  orbStageRef: RefObject<HTMLDivElement | null>;
  orbFlash: { id: string; tone: HandoffTone } | null;
  onOrbFlashEnd: () => void;
  awake: boolean;
  geminiStatus: string;
  hermesStatus: string;
  runs: number;
  sessionStartRef: { current: number | null };
  caption: string;
  captionDim: boolean;
  muted: boolean;
  onToggleMute: () => void;
  onSleep: () => void;
  wakeWordEnabled: boolean;
}) {
  return (
    <div className="deck-center">
      <div
        className="orb-stage"
        ref={orbStageRef}
        style={{ "--orb-accent": ORB_ACCENT[reactorState] } as CSSProperties}
      >
        <span className="orb-ring" />
        <span className="orb-radar" />
        <ReactorCore
          state={reactorState}
          inputLevelRef={inputLevelRef}
          outputLevelRef={outputLevelRef}
          thinking={thinking}
          wakeKey={wakeKey}
          rippleKey={rippleKey}
        />
        {orbFlash ? (
          <span key={orbFlash.id} className={`orb-flash ${orbFlash.tone}`} onAnimationEnd={onOrbFlashEnd} />
        ) : null}
      </div>
      {awake ? (
        <>
          <Telemetry
            awake={awake}
            gemini={geminiStatus}
            hermes={hermesStatus}
            runs={runs}
            sessionStartRef={sessionStartRef}
          />
          <div className={`caption ${captionDim ? "dim" : ""}`}>
            {caption}
            <span className="caption-caret" />
          </div>
          <div className="transport">
            <button
              className={`t-btn small ${muted ? "muted" : ""}`}
              onClick={onToggleMute}
              title={muted ? "Unmute microphone" : "Mute microphone"}
            >
              {muted ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
            <button className="t-btn small danger" onClick={onSleep} title="Sleep (S)">
              <Power size={18} />
            </button>
          </div>
        </>
      ) : (
        <div className="wake-prompt">
          {wakeWordEnabled ? (
            <div className="wake-say">
              <Mic size={15} />
              Say <b>“Hey Iris”</b>
            </div>
          ) : (
            <div className="wake-say">Iris is asleep</div>
          )}
          <div className="wake-keys">
            {wakeWordEnabled ? "or press " : "press "}
            <span className="key">W</span> wake
            <span className="wake-sep">·</span>
            <span className="key">S</span> sleep
          </div>
        </div>
      )}
    </div>
  );
}
