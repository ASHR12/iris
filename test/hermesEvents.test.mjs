import test from "node:test";
import assert from "node:assert/strict";
import {
  approvalRequestFromRunStatus,
  formatHermesCompletionEvent,
  normalizeHermesEvent,
} from "../electron/hermesEvents.mjs";

test("normalizes the current Hermes approval.request contract", () => {
  const event = normalizeHermesEvent(
    {
      event: "approval.request",
      run_id: "run-7",
      command: "rm -rf build-cache",
      reason: "destructive command",
      choices: ["once", "session", "always", "deny", "invalid"],
      timestamp: 123,
    },
    { task: "Clean build cache" },
  );
  assert.equal(event.approvalRequested, true);
  assert.equal(event.runId, "run-7");
  assert.equal(event.command, "rm -rf build-cache");
  assert.deepEqual(event.choices, ["once", "session", "always", "deny"]);
});

test("supports legacy approval names but ignores unknown events", () => {
  assert.equal(
    normalizeHermesEvent({ event: "approval.required" }, { runId: "r" }).approvalRequested,
    true,
  );
  assert.equal(
    normalizeHermesEvent({ event: "approval.responded", choice: "deny" }, { runId: "r" })
      .approvalResolved,
    true,
  );
  assert.equal(normalizeHermesEvent({ event: "debug.noise" }, { runId: "r" }), null);
});

test("creates an actionable fallback from waiting run status", () => {
  const detailed = approvalRequestFromRunStatus({
    status: "waiting_for_approval",
    pending_approval: {
      command: "send_email --to client@example.com",
      reason: "External side effect",
      choices: ["once", "deny"],
    },
  });
  assert.equal(detailed.event, "approval.request");
  assert.match(detailed.command, /send_email/);
  assert.deepEqual(detailed.choices, ["once", "deny"]);

  const generic = approvalRequestFromRunStatus({ status: "waiting_for_approval" });
  assert.equal(generic.details_available, false);
  assert.match(generic.reason, /did not include command details/i);
  assert.equal(approvalRequestFromRunStatus({ status: "running" }), null);
});

test("completion events include the entire Hermes result", () => {
  const output = Array.from(
    { length: 5000 },
    (_, index) => `${index + 1}. Personal skill and complete description`,
  ).join("\n");
  const event = formatHermesCompletionEvent({
    runId: "run-long",
    task: "List every personal skill",
    status: "completed",
    output,
    userName: "Ashutosh",
  });
  assert.equal(
    event.slice(
      event.indexOf("authoritative_hermes_result:") +
        "authoritative_hermes_result:\n".length,
    ),
    output,
  );
  assert.match(event, /5000\. Personal skill and complete description$/);
});
