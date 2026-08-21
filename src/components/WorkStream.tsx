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

export default function WorkStream({
  personalTasks,
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
}: {
  personalTasks: JarvisTasksResult | null;
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
}) {
  return (
    <aside className="deck-panel deck-right">
      <div className="col-head">
        <Terminal size={13} />
        <span>Work Stream</span>
        {tasks.length > 0 ? <span className="count">{tasks.length}</span> : null}
        {testDataEnabled ? (
          <button className="view-all" onClick={onLoadDemo} title="Load UI test fixture data">
            Load demo
          </button>
        ) : null}
        {tasks.length > 3 ? (
          <button className="view-all" onClick={onShowHistory}>
            View all <ChevronRight size={12} />
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
        {tasks.length === 0 ? (
          <div className="empty">
            <span className="empty-icon">
              <Terminal size={19} />
            </span>
            <p>No Hermes runs yet</p>
            <small>Ask Iris to take on a task and it will stream in here.</small>
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
            />
          ))
        )}
      </div>
    </aside>
  );
}
