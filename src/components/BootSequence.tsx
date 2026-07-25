import { useEffect, useState, type CSSProperties } from "react";
import ReactorCore, { ORB_ACCENT } from "./ReactorCore";

const BOOT_LINES = [
  "initializing neural core",
  "linking gemini live uplink",
  "calibrating audio bus",
  "spinning up hermes brain",
  "loading skill matrix",
  "synchronizing memory lattice",
  "establishing secure channel",
];

export default function BootSequence({
  visible,
  closing = false,
  compact = false,
}: {
  visible: boolean;
  closing?: boolean;
  compact?: boolean;
}) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!visible) {
      setStep(0);
      return;
    }
    const id = window.setInterval(() => {
      setStep((s) => (s + 1) % (BOOT_LINES.length + 1));
    }, 380);
    return () => window.clearInterval(id);
  }, [visible]);

  if (!visible) return null;

  // Compact variant for HUD mode: a small glass card near the orb instead of
  // taking over the whole (transparent) screen.
  return (
    <div className={`boot ${compact ? "compact" : ""} ${closing ? "closing" : ""}`}>
      {!compact ? (
        <div
          className="orb-stage boot-orb"
          style={{ "--orb-accent": ORB_ACCENT.online } as CSSProperties}
        >
          <span className="orb-ring" />
          <span className="orb-radar" />
          <ReactorCore state="online" />
        </div>
      ) : null}
      <div className="boot-title">I.R.I.S</div>
      <div className="boot-sub">SYSTEM INITIALIZATION</div>

      <div className="boot-log">
        {BOOT_LINES.map((line, i) => (
          <div key={line} className={`boot-line ${i < step ? "done" : ""} ${i === step ? "active" : ""}`}>
            <span className="boot-dot" />
            {line}
            <span className="boot-state">{i < step ? "OK" : i === step ? "··" : ""}</span>
          </div>
        ))}
      </div>

      <div className="boot-bar">
        <div
          className="boot-bar-fill"
          style={{ width: `${Math.min(100, (step / BOOT_LINES.length) * 100)}%` }}
        />
      </div>
    </div>
  );
}
