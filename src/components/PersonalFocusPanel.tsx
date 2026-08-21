import { Target } from "lucide-react";

// Compact left-column readout of real Jarvis Bridge Personal OS data: Top
// Focus, Current Context, Next. No demo data, no invented fallback — a
// null result (not yet loaded) or {ok:false} (bridge/reader unavailable)
// both render as an honest, distinct state, never a fabricated placeholder.
export default function PersonalFocusPanel({
  topFocus,
  context,
  activeGoal,
}: {
  topFocus: JarvisTopFocusResult | null;
  context: JarvisCurrentContextResult | null;
  activeGoal: JarvisActiveGoalResult | null;
}) {
  const focusItem = topFocus?.ok ? topFocus.data?.top?.[0] ?? null : null;
  const focusError = topFocus && !topFocus.ok ? topFocus.error : null;

  const ctx = context?.ok ? context.data ?? null : null;
  const contextError = context && !context.ok ? context.error : null;
  const recommended = ctx?.recommended ?? null;

  const goal = activeGoal?.ok ? activeGoal.data ?? null : null;
  const goalError = activeGoal && !activeGoal.ok ? activeGoal.error : null;

  return (
    <aside className="deck-panel focus-panel">
      <div className="col-head">
        <Target size={13} />
        <span>Focus</span>
      </div>
      <div className="focus-body">
        <section className="focus-section">
          <span className="focus-label">Mission</span>
          {goal ? (
            <>
              <p className="focus-title">{goal.title}</p>
              {goal.nextAction ? <p className="focus-sub">{goal.nextAction}</p> : null}
            </>
          ) : (
            <p className="focus-empty">
              {goalError || (activeGoal ? "Kein Ziel definiert." : "…")}
            </p>
          )}
        </section>

        <section className="focus-section">
          <span className="focus-label">Top Focus</span>
          {focusItem ? (
            <>
              <p className="focus-title">{focusItem.title}</p>
              {focusItem.whyNow ? <p className="focus-sub">{focusItem.whyNow}</p> : null}
            </>
          ) : (
            <p className="focus-empty">
              {focusError || (topFocus ? "Kein Top Focus." : "…")}
            </p>
          )}
        </section>

        <section className="focus-section">
          <span className="focus-label">Current Context</span>
          {ctx ? (
            <>
              <p className="focus-title">
                {ctx.today} · {ctx.status}
              </p>
              <p className="focus-sub">
                {ctx.summary.tasksOverdue} überfällig · {ctx.summary.tasksDueToday} heute fällig ·{" "}
                {ctx.summary.waitingFollowUpDue} wartend
              </p>
            </>
          ) : (
            <p className="focus-empty">
              {contextError || (context ? "Kein Kontext." : "…")}
            </p>
          )}
        </section>

        <section className="focus-section">
          <span className="focus-label">Next</span>
          {recommended ? (
            <>
              <p className="focus-title">{recommended.title}</p>
              {recommended.reason ? <p className="focus-sub">{recommended.reason}</p> : null}
            </>
          ) : (
            <p className="focus-empty">
              {context ? (context.ok ? "Keine nächste Aktion." : contextError) : "…"}
            </p>
          )}
        </section>
      </div>
    </aside>
  );
}
