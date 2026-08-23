import { type RefObject } from "react";
import { ChevronRight, Terminal } from "lucide-react";
import type { TaskCard } from "../types";
import { acceptedKey } from "../lib/tasks";
import WorkCard from "./WorkCard";
import SessionSwitcher from "./SessionSwitcher";

const POS_GROUPS: Array<{ key: "now" | "next" | "waiting" | "overdue"; label: string }> = [
  { key: "now", label: "NOW" },
  { key: "next", label: "NEXT" },
  { key: "waiting", label: "WAITING" },
  { key: "overdue", label: "OVERDUE" },
];

// Real Personal OS NOW/NEXT/WAITING/OVERDUE tasks, from the same
// window.iris.getJarvisTasks() bridge call — never demo data. `result` is
// null before the first load, {ok:false} when the bridge/reader is
// unavailable, or {ok:true, data} with the four real groups (possibly all
// empty, which is itself a real, honest state).
function PersonalOsTasks({ result }: { result: JarvisTasksResult | null }) {
  if (!result) return null;
  if (!result.ok) {
    return (
      <div className="pos-block">
        <span className="pos-block-head">Personal OS</span>
        <p className="pos-empty-text">{result.error || "Personal OS Daten nicht verfügbar."}</p>
      </div>
    );
  }
  const data = result.data ?? { now: [], next: [], waiting: [], overdue: [] };
  const total = data.now.length + data.next.length + data.waiting.length + data.overdue.length;
  if (total === 0) {
    return (
      <div className="pos-block">
        <span className="pos-block-head">Personal OS</span>
        <p className="pos-empty-text">Keine offenen Aufgaben.</p>
      </div>
    );
  }
  return (
    <div className="pos-block">
      <span className="pos-block-head">Personal OS</span>
      {POS_GROUPS.map(({ key, label }) => {
        const items = data[key];
        if (!items.length) return null;
        return (
          <div className="pos-group" key={key}>
            <span className={`pos-group-label pos-${key}`}>
              {label} <span className="pos-group-count">{items.length}</span>
            </span>
            {items.map((item) => (
              <div className="pos-row" key={item.path}>
                <span className="pos-title">{item.title}</span>
                <span className="pos-meta">
                  {key === "waiting" ? (item as JarvisWaitingItem).waitingFor : (item as JarvisTaskItem).due}
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// German labels reused verbatim from Jarvis-Desktop's own
// CommandCenter.jsx AutonomyView (JOB_STATUS_LABELS) — same source of
// truth, same wording, no re-derivation.
const JOB_STATUS_LABELS: Record<string, string> = {
  pending: "AUSSTEHEND",
  scheduled: "GEPLANT",
  preparing: "WIRD VORBEREITET",
  running: "LÄUFT",
  verifying: "WIRD VERIFIZIERT",
  ready_for_approval: "BEREIT ZUR FREIGABE",
  needs_human: "MENSCHLICHE ENTSCHEIDUNG NÖTIG",
  completed: "ABGESCHLOSSEN",
  partial: "TEILWEISE",
  failed: "FEHLGESCHLAGEN",
  timeout: "ZEITÜBERSCHREITUNG",
  cancelled: "ABGEBROCHEN",
  not_configured: "NICHT KONFIGURIERT",
};
function jobStatusLabel(status: string): string {
  return JOB_STATUS_LABELS[status] || status?.toUpperCase() || "UNBEKANNT";
}
function jobStatusTone(status: string): "pos-ready" | "pos-human" | "pos-progress" | "" {
  if (status === "ready_for_approval") return "pos-ready";
  if (status === "needs_human" || ["failed", "timeout", "cancelled", "not_configured"].includes(status)) return "pos-human";
  if (["running", "preparing", "verifying", "pending", "scheduled"].includes(status)) return "pos-progress";
  return "";
}

// Real autonomous engineering job state (window.iris.getJarvisEngineeringJob
// -> jarvisBridge.getLatestEngineeringJob() -> job-store.cjs/job-events.cjs,
// see Jarvis-Desktop/app/adapter/iris-bridge.cjs). Read-only, same boundary
// as Jarvis's own CommandCenter.jsx AutonomyView: shows lifecycle, worker,
// attempts, verification and approval state, never a merge/push/promote
// control. `result` is null before the first load, {ok:false} when the
// bridge/store is unavailable, or {ok:true,data:null} when no job exists
// yet — each a distinct, honest state, never fabricated.
function EngineeringJobBlock({ result }: { result: JarvisEngineeringJobResult | null }) {
  if (!result) return null;
  if (!result.ok) {
    return (
      <div className="pos-block">
        <span className="pos-block-head">Autonomie</span>
        <p className="pos-empty-text">{result.error || "Engineering-Job-Daten nicht verfügbar."}</p>
      </div>
    );
  }
  const job = result.data;
  if (!job) {
    return (
      <div className="pos-block">
        <span className="pos-block-head">Autonomie</span>
        <p className="pos-empty-text">Kein autonomer Engineering-Job vorhanden.</p>
      </div>
    );
  }
  const verification = job.verification?.result;
  const changedFileCount =
    job.promotion?.actualChangedFiles?.length ?? verification?.actualChangedFiles?.length ?? null;
  const warnings = [...(verification?.warnings || []), ...(verification?.reasons || [])];
  const approvalReason =
    job.budgetState?.reason || verification?.reasons?.join("; ") || job.error?.message || null;

  return (
    <div className="pos-block">
      <span className="pos-block-head">Autonomie</span>
      <div className="pos-group">
        <span className={`pos-group-label ${jobStatusTone(job.status)}`}>{jobStatusLabel(job.status)}</span>
        <div className="pos-row">
          <span className="pos-title">{job.task?.length > 72 ? `${job.task.slice(0, 72)}…` : job.task}</span>
          <span className="pos-meta">{job.id.slice(0, 8)}</span>
        </div>
        <div className="pos-row">
          <span className="pos-title">Worker: {job.workerKind || "nicht zugewiesen"}</span>
          <span className="pos-meta">
            {job.attemptCount ?? 0} / {job.budgetState?.maxAttempts ?? 3} Versuche
          </span>
        </div>
        {job.status === "ready_for_approval" ? (
          <div className="pos-row">
            <span className="pos-title">
              {job.promotion?.commitHash ? `Commit ${job.promotion.commitHash.slice(0, 10)}` : "Verifiziert"} · kein
              automatisches Merge/Push
            </span>
            {changedFileCount !== null ? <span className="pos-meta">{changedFileCount} Dateien</span> : null}
          </div>
        ) : null}
        {job.status === "needs_human" && approvalReason ? (
          <div className="pos-row">
            <span className="pos-title">{approvalReason}</span>
          </div>
        ) : null}
        {warnings.map((warning, index) => (
          <div className="pos-row" key={`warn-${index}`}>
            <span className="pos-title">{warning}</span>
          </div>
        ))}
      </div>
      {job.result?.text ? (
        <div className="pos-group">
          <span className="pos-group-label">Ergebnis</span>
          <p className="pos-result-text">{job.result.text}</p>
        </div>
      ) : null}
      {job.events?.length ? (
        <div className="pos-group">
          <span className="pos-group-label">Ereignisverlauf</span>
          {job.events.slice(-5).map((event, index) => (
            <div className="pos-row" key={`${event.type}-${index}`}>
              <span className="pos-title">{event.message}</span>
              <span className="pos-meta">
                {new Date(event.timestamp).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function WorkStream({
  personalTasks,
  engineeringJob,
  tasks,
  sortedTasks,
  scrollRef,
  acceptedIds,
  stepsOpenIds,
  testDataEnabled,
  session,
  onSwitchSession,
  onNewSession,
  onLoadDemo,
  onShowHistory,
  onToggleSteps,
  onFocusTask,
  onOpenTask,
  onApproveTask,
  pendingApprovalTaskId,
}: {
  personalTasks: JarvisTasksResult | null;
  engineeringJob: JarvisEngineeringJobResult | null;
  tasks: TaskCard[];
  sortedTasks: TaskCard[];
  scrollRef: RefObject<HTMLDivElement | null>;
  acceptedIds: Record<string, number>;
  stepsOpenIds: Record<string, boolean>;
  testDataEnabled: boolean;
  session: string | null;
  onSwitchSession: (id: string) => void;
  onNewSession: () => void;
  onLoadDemo: () => void;
  onShowHistory: () => void;
  onToggleSteps: (id: string) => void;
  onFocusTask: (id: string) => void;
  onOpenTask: (task: TaskCard) => void;
  onApproveTask: (
    task: TaskCard,
    choice: "once" | "session" | "always" | "deny",
  ) => void;
  pendingApprovalTaskId: string | null;
}) {
  return (
    <aside className="deck-panel deck-right">
      <div className="col-head">
        <Terminal size={13} />
        <span>Ereignisverlauf</span>
        {tasks.length > 0 ? <span className="count">{tasks.length}</span> : null}
        {testDataEnabled ? (
          <button className="view-all" onClick={onLoadDemo} title="Load UI test fixture data">
            Load demo
          </button>
        ) : null}
        {tasks.length > 3 ? (
          <button className="view-all" onClick={onShowHistory}>
            Alle anzeigen <ChevronRight size={12} />
          </button>
        ) : null}
      </div>
      {session !== null ? (
        <SessionSwitcher
          current={session}
          refreshKey={tasks.length}
          onSwitch={onSwitchSession}
          onNew={onNewSession}
        />
      ) : null}
      <div className="work-scroll" ref={scrollRef}>
        <PersonalOsTasks result={personalTasks} />
        <EngineeringJobBlock result={engineeringJob} />
        {tasks.length === 0 ? (
          <div className="empty">
            <span className="empty-icon">
              <Terminal size={19} />
            </span>
            <p>Noch keine Aktivität</p>
            <small>Gib Jarvis eine Aufgabe – sie erscheint hier.</small>
            {testDataEnabled ? (
              <button className="demo-load" onClick={onLoadDemo}>
                Load demo tasks
              </button>
            ) : null}
          </div>
        ) : (
          sortedTasks.map((task) => (
            <WorkCard
              key={task.id}
              task={task}
              accepted={Boolean(acceptedIds[acceptedKey(task.task)])}
              stepsOpen={Boolean(stepsOpenIds[task.id])}
              onToggleSteps={() => onToggleSteps(task.id)}
              onFocus={() => onFocusTask(task.id)}
              onOpen={() => onOpenTask(task)}
              onApprove={(choice) => onApproveTask(task, choice)}
              pendingApprovalTaskId={pendingApprovalTaskId}
            />
          ))
        )}
      </div>
    </aside>
  );
}
