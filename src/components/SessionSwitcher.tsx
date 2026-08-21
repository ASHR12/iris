import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";

function timeAgo(ts: number): string {
  if (!ts) return "new";
  const minutes = Math.floor((Date.now() - ts) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Human name for a session, matching how the Hermes app lists chats:
// title first, then a snippet of the first prompt, and "New chat" until the
// first task names the thread.
function sessionLabel(
  session: Pick<HermesSessionInfo, "id" | "title" | "preview" | "messageCount">,
): string {
  if (session.title?.trim()) return session.title.trim();
  const preview = session.preview?.trim().replace(/\s+/g, " ") ?? "";
  if (preview) return preview.length > 44 ? `${preview.slice(0, 44)}…` : preview;
  return session.messageCount > 0 ? session.id : "New chat";
}

/**
 * Main-page Hermes chat switcher (top of the Work Stream): shows the thread
 * Iris is talking in, opens a picker of past Iris sessions (api_server only),
 * and starts a fresh Hermes-named thread with the + button — like picking a
 * chat in Hermes desktop, without opening Settings.
 */
export default function SessionSwitcher({
  current,
  refreshKey = 0,
  onSwitch,
  onNew,
}: {
  current: string;
  /** Bump to re-resolve labels (e.g. after a task lands and names a new thread). */
  refreshKey?: number;
  onSwitch: (id: string) => void;
  onNew: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<HermesSessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  async function refresh() {
    try {
      const result = await window.iris.listHermesSessions();
      setSessions(result.ok ? result.sessions : []);
    } catch {
      setSessions([]);
    } finally {
      setHasFetched(true);
    }
  }

  // Keep the chip label resolvable: refresh when the pinned session changes
  // (right after + creates a thread) and when new work lands (the first task
  // gives a fresh "New chat" its real name).
  useEffect(() => {
    refresh();
  }, [current, refreshKey]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setLoading(true);
    await refresh();
    setLoading(false);
  }

  const currentSession = sessions.find((session) => session.id === current);

  // Nothing real to switch between (Hermes not installed/reachable) — hide
  // entirely rather than exposing an internal default session id like
  // "iris-voice" to the user. Functionality is unchanged: as soon as a real
  // session exists, this renders exactly as before.
  if (hasFetched && sessions.length === 0 && !currentSession) return null;

  const chipLabel = currentSession ? sessionLabel(currentSession) : current;

  // A thread can be missing from the list briefly (e.g. Hermes unreachable);
  // pin the current id on top so the selection is always visible.
  const items = !current || currentSession
    ? sessions
    : [
        { id: current, source: "api_server", title: "", preview: "", messageCount: 0, lastActive: 0 },
        ...sessions,
      ];

  return (
    <div className="session-bar" ref={rootRef}>
      <button
        type="button"
        className={`session-chip ${open ? "open" : ""}`}
        onClick={toggle}
        title={`Hermes chat: ${current || "iris-voice"} — click to switch`}
      >
        <span className="session-dot" />
        <span className="session-id">{chipLabel}</span>
        <ChevronDown size={12} className="chev" />
      </button>
      <button
        type="button"
        className="session-new"
        onClick={onNew}
        title="Start a new Hermes chat session"
      >
        <Plus size={13} />
      </button>

      {open ? (
        <div className="session-menu">
          <div className="session-menu-head">Iris chat sessions</div>
          {loading ? (
            <div className="session-empty">Loading…</div>
          ) : items.length === 0 ? (
            <div className="session-empty">No Iris sessions yet — send Hermes a task to start one.</div>
          ) : (
            items.map((session) => (
              <button
                key={session.id}
                type="button"
                className={`session-item ${session.id === current ? "sel" : ""}`}
                onClick={() => {
                  setOpen(false);
                  if (session.id !== current) onSwitch(session.id);
                }}
              >
                <span className="session-item-main">
                  <strong>{sessionLabel(session)}</strong>
                  <em>
                    {session.id}
                    {session.messageCount > 0
                      ? ` · ${session.messageCount} msgs · ${timeAgo(session.lastActive)}`
                      : " · new thread"}
                  </em>
                </span>
                {session.id === current ? <Check size={13} /> : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
