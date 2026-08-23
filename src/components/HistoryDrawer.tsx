import { useEffect } from "react";
import { History, X } from "lucide-react";
import type { TaskCard } from "../types";
import WorkCard from "./WorkCard";

export default function HistoryDrawer({
  tasks,
  onOpen,
  onClose,
  pendingApprovalTaskId,
}: {
  tasks: TaskCard[];
  onOpen: (task: TaskCard) => void;
  onClose: () => void;
  pendingApprovalTaskId: string | null;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="history-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="history-card">
        <div className="history-head">
          <History size={15} />
          <span>Hermes History · {tasks.length}</span>
          <button className="reader-close" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>
        <div className="history-grid">
          {tasks.map((task) => (
            <WorkCard key={task.id} task={task} onFocus={() => undefined} onOpen={() => onOpen(task)} pendingApprovalTaskId={pendingApprovalTaskId} />
          ))}
        </div>
      </div>
    </div>
  );
}
