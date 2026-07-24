import test from "node:test";
import assert from "node:assert/strict";
import {
  PROPOSAL_TTL_MS,
  claimConfirmedProposal,
  discardHermesProposal,
  getHermesProposal,
  markModelTurnComplete,
  markModelTurnInterrupted,
  proposeHermesTask,
  recordUserResponse,
  resetHermesGate,
} from "../electron/hermesGate.mjs";

test("records a real user turn without hard-coding its wording", () => {
  for (const response of [
    "Okay, yes, yes, yes.",
    "That sounds good to me.",
    "हाँ, भेज दो",
  ]) {
    resetHermesGate();
    const staged = proposeHermesTask("Task", "normal", { sessionId: "s" }).proposal;
    markModelTurnComplete();
    const recorded = recordUserResponse(response);
    assert.equal(recorded.userTurnObserved, true, response);
    assert.equal(
      claimConfirmedProposal({ proposalId: staged.id, sessionId: "s" }).ok,
      true,
      response,
    );
  }
});

test("requires completed readback, a real user turn, exact proposal id, and session", () => {
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
    "no_user_turn",
  );

  markModelTurnComplete();
  assert.equal(
    claimConfirmedProposal({
      proposalId: staged.proposal.id,
      sessionId: "session-a",
    }).reason,
    "no_user_turn",
  );

  recordUserResponse("Okay, yes, yes, yes.");
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

test("Gemini can discard the exact staged proposal when it interprets a decline", () => {
  resetHermesGate();
  const staged = proposeHermesTask("Task A", "normal", { sessionId: "s" }).proposal;
  markModelTurnComplete();
  recordUserResponse("No, let's leave it.");
  assert.equal(
    discardHermesProposal({ proposalId: "different", sessionId: "s" }).reason,
    "proposal_mismatch",
  );
  assert.equal(
    discardHermesProposal({ proposalId: staged.id, sessionId: "other" }).reason,
    "session_mismatch",
  );
  const discarded = discardHermesProposal({ proposalId: staged.id, sessionId: "s" });
  assert.equal(discarded.ok, true);
  assert.equal(discarded.proposal.task, "Task A");
  assert.equal(getHermesProposal(), null);
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

test("captures a quick response that arrives just before readback completion", () => {
  resetHermesGate();
  const staged = proposeHermesTask("Task", "normal", { sessionId: "s" }).proposal;
  assert.equal(
    recordUserResponse("Mm-hmm, go ahead.", { allowDuringReadback: true }).userTurnObserved,
    true,
  );
  markModelTurnComplete();
  const claimed = claimConfirmedProposal({
    proposalId: staged.id,
    sessionId: "s",
  });
  assert.equal(claimed.ok, true);
});

test("does not mistake a pre-readback transcript tail for confirmation", () => {
  resetHermesGate();
  const staged = proposeHermesTask("Task", "normal", { sessionId: "s" }).proposal;
  assert.equal(recordUserResponse("yes").reason, "readback_in_progress");
  markModelTurnComplete();
  assert.equal(
    claimConfirmedProposal({ proposalId: staged.id, sessionId: "s" }).reason,
    "no_user_turn",
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
