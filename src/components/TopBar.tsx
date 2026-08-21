import { Hand, PictureInPicture2, Radio, Settings } from "lucide-react";

function StatusDot({ tone, state, label }: { tone: string; state: string; label: string }) {
  return (
    <span className={`status-dot ${tone} ${state}`}>
      <i />
      {label}
    </span>
  );
}

export default function TopBar({
  geminiDot,
  hermesDot,
  hermesAvailable,
  audioDot,
  linked,
  pid,
  handControl,
  onToggleHand,
  onOpenSettings,
}: {
  geminiDot: string;
  hermesDot: string;
  hermesAvailable: boolean;
  audioDot: string;
  linked: boolean;
  pid: number | null;
  handControl: boolean;
  onToggleHand: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <header className="deck-top">
      <div className="deck-top-left">
        {/* The real macOS traffic lights render here (titleBarStyle:
            hiddenInset) — padding in .deck-top-left clears their footprint. */}
        <div className="deck-status">
          <StatusDot tone="gemini" state={geminiDot} label="Gemini" />
          {/* Never shown until Hermes has actually reported a real status at
              least once — an unconfigured/not-installed Hermes must not sit
              next to Gemini implying equal, always-expected availability. */}
          {hermesAvailable ? <StatusDot tone="hermes" state={hermesDot} label="Hermes" /> : null}
          <StatusDot tone="audio" state={audioDot} label="Audio" />
        </div>
      </div>
      <div className="deck-brand">
        <span className="brand-mark">I.R.I.S</span>
      </div>
      <div className="deck-top-right">
        <button
          className="theme-toggle"
          onClick={() => window.iris?.toggleHud()}
          title="Glass HUD — float Iris over your screen (⌥H)"
        >
          <PictureInPicture2 size={15} />
        </button>
        <button className="theme-toggle" onClick={onOpenSettings} title="Settings">
          <Settings size={15} />
        </button>
        <button
          className={`theme-toggle ${handControl ? "active" : ""}`}
          onClick={onToggleHand}
          title={handControl ? "Disable hand control" : "Enable hand control (camera)"}
        >
          <Hand size={15} />
        </button>
        <span
          className={`link-indicator ${linked ? "on" : "off"}`}
          title={linked ? `Linked${pid ? ` · ${pid}` : ""}` : "Offline"}
        >
          <Radio size={15} />
        </span>
      </div>
    </header>
  );
}
