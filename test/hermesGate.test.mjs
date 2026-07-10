import test from "node:test";
import assert from "node:assert/strict";
import {
  PROPOSAL_TTL_MS,
  claimConfirmedProposal,
  classifyConfirmation,
  getHermesProposal,
  markModelTurnComplete,
  markModelTurnInterrupted,
  proposeHermesTask,
  recordUserResponse,
  resetHermesGate,
} from "../electron/hermesGate.mjs";

test("classifies only standalone affirmative responses", () => {
  resetHermesGate();
  assert.equal(classifyConfirmation("yes"), "affirm");
  assert.equal(classifyConfirmation("Okay, send it."), "affirm");
  assert.equal(classifyConfirmation("yes but change the date"), "revise");
  assert.equal(classifyConfirmation("no, do not send it"), "reject");
  assert.equal(classifyConfirmation("I was thinking about it"), "other");
});

test("requires completed readback, exact proposal id, session, and affirmative turn", () => {
  resetHermesGate();
  const staged = proposeHermesTask("Goal:\nPrepare the report", "high", {
    sessionId: "session-a",
  });
  assert.equal(staged.ok, true);
  assert.equal(Object.isFrozen(staged.proposal), true);

  assert.equal(
    claimConfirmedProposal({
      proposalId: staged.proposal.id,
      sessionId: "session-a",
    }).reason,
    "not_confirmed",
  );

  markModelTurnComplete();
  recordUserResponse("I have another thought");
  assert.equal(
    claimConfirmedProposal({
      proposalId: staged.proposal.id,
      sessionId: "session-a",
    }).reason,
    "not_confirmed",
  );

  recordUserResponse("yes");
  assert.equal(
    claimConfirmedProposal({
      proposalId: "different",
      sessionId: "session-a",
    }).reason,
    "proposal_mismatch",
  );
  assert.equal(
    claimConfirmedProposal({
      proposalId: staged.proposal.id,
      sessionId: "session-b",
    }).reason,
    "session_mismatch",
  );

  const claimed = claimConfirmedProposal({
    proposalId: staged.proposal.id,
    sessionId: "session-a",
  });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.proposal.task, "Goal:\nPrepare the report");
  assert.equal(getHermesProposal(), null);
});

test("a rejection or requested revision cannot be submitted", () => {
  resetHermesGate();
  const rejected = proposeHermesTask("Task A", "normal", { sessionId: "s" }).proposal;
  markModelTurnComplete();
  recordUserResponse("no");
  assert.equal(
    claimConfirmedProposal({ proposalId: rejected.id, sessionId: "s" }).reason,
    "rejected",
  );

  resetHermesGate();
  const revised = proposeHermesTask("Task B", "normal", { sessionId: "s" }).proposal;
  markModelTurnComplete();
  recordUserResponse("yes but add the July numbers");
  assert.equal(
    claimConfirmedProposal({ proposalId: revised.id, sessionId: "s" }).reason,
    "needs_revision",
  );
});

test("an interrupted readback never unlocks submission", () => {
  resetHermesGate();
  const staged = proposeHermesTask("Task", "normal", { sessionId: "s" }).proposal;
  markModelTurnInterrupted();
  assert.equal(recordUserResponse("yes").reason, "not_awaiting_user");
  assert.equal(
    claimConfirmedProposal({ proposalId: staged.id, sessionId: "s" }).reason,
    "readback_interrupted",
  );
});

test("expired proposals are discarded", () => {
  resetHermesGate();
  const proposedAt = 1000;
  const staged = proposeHermesTask("Task", "normal", {
    sessionId: "s",
    now: proposedAt,
  }).proposal;
  assert.equal(
    claimConfirmedProposal({
      proposalId: staged.id,
      sessionId: "s",
      now: proposedAt + PROPOSAL_TTL_MS + 1,
    }).reason,
    "no_proposal",
  );
});
