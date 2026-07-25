import { useEffect, useState, type CSSProperties, type RefObject } from "react";
import { Mic, MicOff, Power } from "lucide-react";
import ReactorCore, { ORB_ACCENT } from "./ReactorCore";
import DevicePicker from "./DevicePicker";
import type { HandoffTone, ReactorState } from "../types";

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
  autoSlept,
  hermesWorking,
  micDevice,
  onPickMicDevice,
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
  autoSlept: boolean;
  hermesWorking: boolean;
  micDevice: string;
  onPickMicDevice: (id: string) => void;
}) {
  return (
    <div className="deck-center">
      <div
        className={`orb-stage ${autoSlept && !awake ? "napping" : ""}`}
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
        {autoSlept && !awake ? (
          <span className="nap-zzz" aria-hidden="true">
            <i>z</i>
            <i>z</i>
            <i>z</i>
          </span>
        ) : null}
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
            {/* Zoom-style split control: mute toggles, the caret picks the mic. */}
            <span className="t-split">
              <button
                className={`t-btn small ${muted ? "muted" : "primary"}`}
                onClick={onToggleMute}
                title={muted ? "Unmute microphone" : "Mute microphone"}
              >
                {muted ? <MicOff size={18} /> : <Mic size={18} />}
              </button>
              <DevicePicker
                kind="audioinput"
                value={micDevice}
                onSelect={onPickMicDevice}
                title="Select a microphone"
              />
            </span>
            <button className="t-btn small danger" onClick={onSleep} title="Sleep (S)">
              <Power size={18} />
            </button>
          </div>
        </>
      ) : (
        <div className="wake-prompt">
          {autoSlept ? (
            <div className="wake-say">
              {hermesWorking
                ? "On standby — Hermes is working; I'll wake when it's done"
                : wakeWordEnabled
                  ? "On standby, saving tokens — say “Hey Iris”"
                  : "On standby, saving tokens"}
            </div>
          ) : wakeWordEnabled ? (
            <div className="wake-say">
              <Mic size={15} />
              Say <b>“Hey Iris”</b>
            </div>
          ) : (
            <div className="wake-say">Iris is asleep</div>
          )}
          <div className="wake-keys">
            <span>{wakeWordEnabled ? "or press" : "press"}</span>
            <span className="combo">
              <span className="key">⌥</span>
              <span className="key">W</span>
            </span>
            <span>wake</span>
            <span className="wake-sep">·</span>
            <span className="combo">
              <span className="key">⌥</span>
              <span className="key">S</span>
            </span>
            <span>sleep</span>
          </div>
        </div>
      )}
    </div>
  );
}
