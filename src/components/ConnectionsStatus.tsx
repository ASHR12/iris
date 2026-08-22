import { useEffect, useRef, useState } from "react";
import { Plug } from "lucide-react";

// Jarvis Integrations/Connections readout (P2.4) — a compact, read-only
// popover over the real getJarvisConnectionsStatus() bridge result (see
// Jarvis-Desktop/app/adapter/iris-bridge.cjs getConnectionsStatus()). No
// reconnect/retry control lives here — this only shows what Jarvis already
// knows about its own integrations, exactly like PersonalFocusPanel already
// does for Top Focus/Current Context: null = not yet loaded, {ok:false} =
// bridge unavailable, both rendered as an honest, distinct state, never a
// fabricated placeholder.
const STATE_LABEL: Record<JarvisConnectionStatusValue, string> = {
  connected: "VERBUNDEN",
  not_connected: "NICHT VERBUNDEN",
  unavailable: "NICHT ERREICHBAR",
};

export default function ConnectionsStatus({
  result,
}: {
  result: JarvisConnectionsStatusResult | null;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const connections = result?.ok ? (result.data?.connections ?? []) : [];
  const connectedCount = connections.filter((entry) => entry.status === "connected").length;
  const summary = result === null ? "…" : `${connectedCount}/${connections.length}`;

  return (
    <div className="connections-status" ref={rootRef}>
      <button
        type="button"
        className={`theme-toggle connections-trigger ${open ? "active" : ""}`}
        onClick={() => setOpen((value) => !value)}
        title="Jarvis-Verbindungen"
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Plug size={15} />
      </button>
      {open ? (
        <div className="connections-popover deck-panel" role="dialog" aria-label="Jarvis-Verbindungen">
          <div className="col-head">
            <Plug size={14} />
            <span>Jarvis-Verbindungen</span>
            <span className="count">{summary}</span>
          </div>
          {result && !result.ok ? (
            <p className="connections-empty">{result.error || "Verbindungsstatus nicht verfügbar."}</p>
          ) : connections.length ? (
            <ul className="connections-list">
              {connections.map((entry) => (
                <li key={entry.id} className={`connections-row status-${entry.status}`}>
                  <span className="connection-dot" aria-hidden="true" />
                  <span className="connections-label">{entry.label}</span>
                  <span className="connections-state" title={entry.detail || undefined}>
                    {STATE_LABEL[entry.status]}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="connections-empty">Wird geprüft …</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
