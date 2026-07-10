export const HERMES_RELEVANT_EVENTS = new Set([
  "tool.started",
  "tool.completed",
  "message.delta",
  "reasoning.available",
  "approval.request",
  "approval.responded",
  "approval.requested",
  "approval.required",
  "approval.resolved",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

const APPROVAL_REQUEST_EVENTS = new Set([
  "approval.request",
  "approval.requested",
  "approval.required",
]);
const APPROVAL_RESPONSE_EVENTS = new Set(["approval.responded", "approval.resolved"]);
const APPROVAL_CHOICES = new Set(["once", "session", "always", "deny"]);
const WAITING_APPROVAL_STATUSES = new Set([
  "waiting_for_approval",
  "awaiting_approval",
  "approval_required",
]);

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim();
}

/**
 * Polling fallback for a missed/restarted SSE approval stream. Hermes may only
 * expose the waiting status here; buttons can still resolve the run even when
 * command details are unavailable.
 */
export function approvalRequestFromRunStatus(run) {
  if (!run || typeof run !== "object") return null;
  const status = String(run.status || "").toLowerCase();
  if (!WAITING_APPROVAL_STATUSES.has(status)) return null;
  const details =
    run.approval_request ||
    run.pending_approval ||
    run.approval ||
    run.pending_action ||
    {};
  const command = firstString(
    details.command,
    details.tool_input?.command,
    details.action,
    run.command,
  );
  const reason = firstString(
    details.reason,
    details.message,
    details.description,
    run.approval_reason,
  );
  const choices = Array.isArray(details.choices)
    ? details.choices.map(String).filter((choice) => APPROVAL_CHOICES.has(choice))
    : ["once", "session", "always", "deny"];
  return {
    event: "approval.request",
    command,
    reason:
      reason ||
      "Hermes is paused for approval. The run-status response did not include command details; choose a scope only if you recognize and trust the requested action.",
    choices: choices.length ? choices : ["once", "session", "always", "deny"],
    source: "status_poll",
    details_available: Boolean(command || reason),
  };
}

export function normalizeHermesEvent(parsed, { runId, task, now = Date.now() } = {}) {
  if (!parsed || typeof parsed !== "object") return null;
  const kind = typeof parsed.event === "string" ? parsed.event : "";
  if (!HERMES_RELEVANT_EVENTS.has(kind)) return null;
  const choices = Array.isArray(parsed.choices)
    ? parsed.choices.map(String).filter((choice) => APPROVAL_CHOICES.has(choice))
    : ["once", "session", "always", "deny"];
  return {
    kind,
    runId: String(runId || parsed.run_id || ""),
    task: String(task || ""),
    ts: typeof parsed.timestamp === "number" ? parsed.timestamp : now / 1000,
    tool: typeof parsed.tool === "string" ? parsed.tool : undefined,
    preview: typeof parsed.preview === "string" ? parsed.preview : undefined,
    duration: typeof parsed.duration === "number" ? parsed.duration : undefined,
    isError: parsed.error === true,
    delta: typeof parsed.delta === "string" ? parsed.delta : undefined,
    text: typeof parsed.text === "string" ? parsed.text : undefined,
    command: typeof parsed.command === "string" ? parsed.command : undefined,
    reason:
      typeof parsed.reason === "string"
        ? parsed.reason
        : typeof parsed.message === "string"
          ? parsed.message
          : undefined,
    choices: choices.length ? choices : ["once", "session", "always", "deny"],
    choice: typeof parsed.choice === "string" ? parsed.choice : undefined,
    approvalRequested: APPROVAL_REQUEST_EVENTS.has(kind),
    approvalResolved: APPROVAL_RESPONSE_EVENTS.has(kind),
  };
}
