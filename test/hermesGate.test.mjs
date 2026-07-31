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
  readbackAudible,
  recordModelSpeech,
  recordUserResponse,
  resetHermesGate,
} from "../electron/hermesGate.mjs";

const FULL_READBACK =
  "Hermes should check the Fetra brief and draft two posts. Should I send this to Hermes?";

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

test("a readback cut off early never unlocks submission", () => {
  resetHermesGate();
  const staged = proposeHermesTask("Task", "normal", { sessionId: "s" }).proposal;
  recordModelSpeech("Here is the brief:");
  markModelTurnInterrupted();
  assert.equal(recordUserResponse("yes").reason, "not_awaiting_user");
  assert.equal(
    claimConfirmedProposal({ proposalId: staged.id, sessionId: "s" }).reason,
    "readback_interrupted",
  );
});

test("answering the tail of a full readback confirms it instead of voiding it", () => {
  resetHermesGate();
  const staged = proposeHermesTask("Task", "normal", { sessionId: "s" }).proposal;
  // Gemini streams the read-back in chunks; the user answers on its last word.
  for (const chunk of FULL_READBACK.match(/.{1,12}/g)) recordModelSpeech(chunk);
  assert.equal(readbackAudible(), true);
  markModelTurnInterrupted();
  assert.equal(recordUserResponse("Yes.").userTurnObserved, true);
  assert.equal(
    claimConfirmedProposal({ proposalId: staged.id, sessionId: "s" }).ok,
    true,
  );
});

test("an interruption from before the readback leaves the proposal intact", () => {
  // Nothing has been read aloud yet, so the cut-short turn was not the
  // read-back. Voiding the proposal here forces a restage, and the restage
  // meets the same stale interruption: the loop the user could not escape.
  resetHermesGate();
  const staged = proposeHermesTask("Task", "normal", { sessionId: "s" }).proposal;
  markModelTurnInterrupted();
  assert.equal(getHermesProposal().stage, "awaiting_readback");

  for (const chunk of FULL_READBACK.match(/.{1,12}/g)) recordModelSpeech(chunk);
  markModelTurnComplete();
  recordUserResponse("Yes.");
  assert.equal(
    claimConfirmedProposal({ proposalId: staged.id, sessionId: "s" }).ok,
    true,
  );
});

test("a proposal nobody has heard cannot be submitted, however often it is asked", () => {
  resetHermesGate();
  const staged = proposeHermesTask("Task", "normal", { sessionId: "s" }).proposal;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    markModelTurnInterrupted();
    assert.equal(recordUserResponse("Yes, send it.").reason, "readback_in_progress");
    assert.equal(
      claimConfirmedProposal({ proposalId: staged.id, sessionId: "s" }).reason,
      "no_user_turn",
    );
  }
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
