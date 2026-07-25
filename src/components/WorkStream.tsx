import { type RefObject } from "react";
import { ChevronRight, Terminal } from "lucide-react";
import type { TaskCard } from "../types";
import { acceptedKey } from "../lib/tasks";
import WorkCard from "./WorkCard";
import SessionSwitcher from "./SessionSwitcher";

export default function WorkStream({
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
        {tasks.length === 0 ? (
          <div className="empty">
            <p>No Hermes runs yet. Ask Iris to take on a task.</p>
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
