import { ShieldAlert } from "lucide-react";
import type { TaskCard } from "../types";

export default function ApprovalPrompt({
  task,
  onResolve,
}: {
  task: TaskCard;
  onResolve: (choice: "once" | "session" | "always" | "deny") => void;
}) {
  const approval = task.approval;
  if (!approval) return null;
  return (
    <section
      className="approval-prompt hud-hit"
      role="alertdialog"
      aria-live="assertive"
      aria-labelledby="approval-prompt-title"
    >
      <header>
        <ShieldAlert size={17} />
        <div>
          <strong id="approval-prompt-title">Hermes needs approval</strong>
          <span>{task.task}</span>
        </div>
      </header>
      {approval.command ? (
        <code>{approval.command}</code>
      ) : (
        <p className="approval-missing">
          Command details were not present in the status response. Approve only if you recognize
          this action; otherwise deny it and retry.
        </p>
      )}
      {approval.reason ? <p>{approval.reason}</p> : null}
      <div className="approval-prompt-actions">
        {approval.choices.map((choice) => (
          <button
            key={choice}
            type="button"
            className={choice}
            disabled={approval.resolving}
            onClick={() => onResolve(choice)}
          >
            {choice === "once"
              ? "Allow once"
              : choice === "session"
                ? "Allow this session"
                : choice === "always"
                  ? "Always allow"
                  : "Deny"}
          </button>
        ))}
      </div>
      {approval.error ? <small>{approval.error}</small> : null}
    </section>
  );
}
