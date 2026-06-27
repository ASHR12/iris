import { useEffect, useState } from "react";

const BOOT_LINES = [
  "initializing neural core",
  "linking gemini live uplink",
  "calibrating audio bus",
  "spinning up hermes brain",
  "loading skill matrix",
  "synchronizing memory lattice",
  "establishing secure channel",
];

export default function BootSequence({ visible }: { visible: boolean }) {
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

  return (
    <div className="boot">
      <div className="boot-rings">
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="boot-core" />
      <div className="boot-title">J.A.R.V.I.S</div>
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
