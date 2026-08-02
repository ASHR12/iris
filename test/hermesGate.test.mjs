import test from "node:test";
import assert from "node:assert/strict";
import {
  PROPOSAL_TTL_MS,
  claimConfirmedProposal,
  discardHermesProposal,
  getHermesProposal,
  markModelTurnComplete,
  markModelTurnInterrupted,
  noteProposalIdDelivered,
  proposeHermesTask,
  readbackAudible,
  recordModelSpeech,
  recordUserResponse,
  resetHermesGate,
} from "../electron/hermesGate.mjs";
import { LiveToolCoordinator } from "../electron/liveToolCoordinator.mjs";

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
  noteProposalIdDelivered(staged.proposal.id);

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
  noteProposalIdDelivered(staged.id);
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

test("a brief staged behind a barge-in can still be sent and declined", () => {
  // The staging result never reached the model, so it has no id to quote. The
  // user still heard the brief and answered it, which is what the gate is for.
  resetHermesGate();
  const staged = proposeHermesTask("Email the client", "normal", { sessionId: "s" }).proposal;
  assert.equal(staged.idDelivered, false);
  for (const chunk of FULL_READBACK.match(/.{1,12}/g)) recordModelSpeech(chunk);
  markModelTurnComplete();
  recordUserResponse("Yes, send it.");

  assert.equal(discardHermesProposal({ proposalId: "guessed", sessionId: "s" }).ok, true);

  resetHermesGate();
  proposeHermesTask("Email the client", "normal", { sessionId: "s" });
  markModelTurnComplete();
  recordUserResponse("Yes, send it.");
  const claimed = claimConfirmedProposal({ proposalId: undefined, sessionId: "s" });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.proposal.task, "Email the client");
});

test("a delivered id must still match, and the session always must", () => {
  resetHermesGate();
  const staged = proposeHermesTask("Task", "normal", { sessionId: "s" }).proposal;
  noteProposalIdDelivered(staged.id);
  markModelTurnComplete();
  recordUserResponse("Yes.");
  assert.equal(
    claimConfirmedProposal({ proposalId: "stale", sessionId: "s" }).reason,
    "proposal_mismatch",
  );
  assert.equal(
    claimConfirmedProposal({ proposalId: staged.id, sessionId: "other" }).reason,
    "session_mismatch",
  );
  assert.equal(claimConfirmedProposal({ proposalId: staged.id, sessionId: "s" }).ok, true);
});

test("delivery is only noted for the proposal actually sent to the model", () => {
  resetHermesGate();
  const first = proposeHermesTask("First", "normal", { sessionId: "s" }).proposal;
  const second = proposeHermesTask("Second", "normal", { sessionId: "s" }).proposal;
  noteProposalIdDelivered(first.id);
  assert.equal(getHermesProposal().idDelivered, false);
  noteProposalIdDelivered(second.id);
  assert.equal(getHermesProposal().idDelivered, true);
});

test("speaking over Gemini while it stages a brief does not strand the brief", async () => {
  // Aug 2: five submits in a row were refused with "no active proposal" and no
  // task ever reached Hermes. Answering early cancelled the staging call, so
  // nothing was recorded, and every restage met the same eager confirmation.
  resetHermesGate();
  const coordinator = new LiveToolCoordinator();
  const sent = [];
  const runCall = (call) =>
    coordinator.enqueue(
      { functionCalls: [call] },
      {
        execute: async (name, args) =>
          name === "propose_hermes_task"
            ? proposeHermesTask(args.goal, "normal", { sessionId: "s" })
            : { status: "ok" },
        send: async (batch) => {
          sent.push(batch);
          for (const response of batch) {
            if (response.name !== "propose_hermes_task") continue;
            noteProposalIdDelivered(response.response.result.proposal?.id);
          }
        },
        survivesCancellation: (name) => name === "propose_hermes_task",
      },
    );

  coordinator.cancel(["staging"]);
  await runCall({ id: "staging", name: "propose_hermes_task", args: { goal: "Email Glean" } });
  assert.deepEqual(sent, [], "a cancelled call gets no response");
  assert.equal(getHermesProposal().task, "Email Glean", "but the brief is recorded");

  for (const chunk of FULL_READBACK.match(/.{1,12}/g)) recordModelSpeech(chunk);
  markModelTurnComplete();
  recordUserResponse("Yes, send it.");

  const claimed = claimConfirmedProposal({ proposalId: undefined, sessionId: "s" });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.proposal.task, "Email Glean");
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
