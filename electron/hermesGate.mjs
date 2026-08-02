// ===== Hermes dispatch gate =====
//
// A submit is bound to one immutable proposal, one Hermes transcript, and an
// actual user turn after the read-back. Gemini interprets the meaning of that
// turn and expresses affirmative intent by calling submit_hermes_task; this
// gate enforces ordering and identity, not a hard-coded confirmation vocabulary.

import crypto from "node:crypto";

export const PROPOSAL_TTL_MS = 5 * 60 * 1000;

/** Enough read-back for a reply landing on its tail to be a confirmation. */
export const MIN_AUDIBLE_READBACK_CHARS = 48;

const VALID_URGENCY = new Set(["low", "normal", "high"]);

let proposal = null;

function expire(now = Date.now()) {
  if (proposal && now - proposal.proposedAt > PROPOSAL_TTL_MS) proposal = null;
}

function replaceProposal(updates) {
  proposal = Object.freeze({ ...proposal, ...updates });
  return proposal;
}

export function proposeHermesTask(task, urgency = "normal", options = {}) {
  const cleanTask = String(task || "").trim();
  if (!cleanTask) return { ok: false, reason: "empty_task" };
  const cleanUrgency = VALID_URGENCY.has(String(urgency)) ? String(urgency) : "normal";
  const sessionId = String(options.sessionId || "").trim();
  proposal = Object.freeze({
    id: crypto.randomUUID(),
    task: cleanTask,
    urgency: cleanUrgency,
    sessionId,
    stage: "awaiting_readback",
    proposedAt: Number(options.now) || Date.now(),
    userResponse: "",
    userTurnObserved: false,
    spokenChars: 0,
    idDelivered: false,
  });
  return { ok: true, proposal };
}

/**
 * The staging result actually reached the model, so it can quote the id back.
 * Until it does, the model has no way of knowing what to quote.
 */
export function noteProposalIdDelivered(proposalId) {
  if (!proposal || !proposalId || proposalId !== proposal.id) return;
  if (!proposal.idDelivered) replaceProposal({ idDelivered: true });
}

/** Advance only after the model completed the read-back turn. */
export function markModelTurnComplete() {
  if (proposal?.stage !== "awaiting_readback") return;
  replaceProposal({ stage: "awaiting_user" });
}

/**
 * Model speech produced since this proposal was staged. The gate keeps its own
 * count because the transcript buffers it used to be measured against are
 * flushed on a UI schedule, so their length answers "how much has arrived since
 * the last flush", not "how much of the brief was read aloud".
 */
export function recordModelSpeech(text) {
  if (proposal?.stage !== "awaiting_readback") return;
  const chars = typeof text === "number" ? text : String(text || "").length;
  if (chars > 0) replaceProposal({ spokenChars: proposal.spokenChars + chars });
}

/** Has enough of the brief been read aloud to interpret a reply as an answer? */
export function readbackAudible() {
  return Boolean(proposal && proposal.spokenChars >= MIN_AUDIBLE_READBACK_CHARS);
}

/**
 * A barge-in does not prove that the complete brief was heard. The next model
 * turn must stage/read a fresh proposal before submission can succeed.
 */
export function markModelTurnInterrupted() {
  if (proposal?.stage !== "awaiting_readback") return;
  // Not a word of the brief has been read yet, so this interruption belongs to
  // a turn that ended before the read-back began. It is evidence about that
  // turn, not this proposal: leave the proposal waiting for a read-back, which
  // still cannot be submitted until one completes.
  if (proposal.spokenChars === 0) return;
  // Natural replies often land on the tail of a read-back the user has already
  // heard in full. That is an answer, not a barge-in.
  if (proposal.spokenChars >= MIN_AUDIBLE_READBACK_CHARS) {
    replaceProposal({ stage: "awaiting_user" });
    return;
  }
  replaceProposal({ stage: "readback_interrupted" });
}

/**
 * Record that a real user turn followed the read-back. The transcript is kept
 * for observability only; Gemini owns the semantic affirmative/decline/revise
 * decision through its next tool call.
 */
export function recordUserResponse(text, options = {}) {
  if (!proposal || !["awaiting_readback", "awaiting_user"].includes(proposal.stage)) {
    return { ok: false, reason: "not_awaiting_user" };
  }
  if (proposal.stage === "awaiting_readback" && !options.allowDuringReadback) {
    return { ok: false, reason: "readback_in_progress" };
  }
  const userResponse = String(text || "").trim();
  if (!userResponse) return { ok: false, reason: "empty_response" };
  replaceProposal({ userResponse, userTurnObserved: true });
  return { ok: true, userTurnObserved: true, stage: proposal.stage };
}

// Backward-compatible name for the live-transcription caller.
export function markUserSpoke(text, options = {}) {
  return recordUserResponse(text, options);
}

export function resetHermesGate() {
  proposal = null;
}

/** A proposal is staged and still waiting for a secure terminal decision. */
export function hasPendingProposal(now = Date.now()) {
  expire(now);
  return Boolean(
    proposal &&
      ["awaiting_readback", "awaiting_user"].includes(proposal.stage),
  );
}

export function getHermesProposal(now = Date.now()) {
  expire(now);
  return proposal ? { ...proposal } : null;
}

/** Discard a staged proposal after Gemini interprets the user's intent as decline. */
export function discardHermesProposal(options = {}) {
  const now = options.now ?? Date.now();
  expire(now);
  if (!proposal) return { ok: false, reason: "no_proposal" };
  if (proposal.idDelivered && options.proposalId !== proposal.id) {
    return { ok: false, reason: "proposal_mismatch" };
  }
  if (proposal.sessionId && options.sessionId !== proposal.sessionId) {
    return { ok: false, reason: "session_mismatch" };
  }
  const discarded = proposal;
  proposal = null;
  return { ok: true, proposal: discarded };
}

/**
 * Consume the exact staged proposal. `proposalId` and `sessionId` bind the
 * model's submit call to what the user heard and to the selected Hermes thread.
 */
export function claimConfirmedProposal(options = {}) {
  const now = typeof options === "number" ? options : options.now ?? Date.now();
  expire(now);
  if (!proposal) return { ok: false, reason: "no_proposal" };
  // The id binds the submit to the brief the user heard. When the staging
  // result never reached the model — a barge-in cancelled it — the model cannot
  // quote an id it was never given, and holding out for one leaves a brief the
  // user has already approved permanently unsendable. The substantive
  // guarantees below are unchanged: one proposal is staged at a time, it was
  // read out in full, and the user answered it.
  if (proposal.idDelivered && options.proposalId !== proposal.id) {
    return { ok: false, reason: "proposal_mismatch" };
  }
  if (proposal.sessionId && options.sessionId !== proposal.sessionId) {
    return { ok: false, reason: "session_mismatch" };
  }
  if (proposal.stage === "readback_interrupted") {
    return { ok: false, reason: "readback_interrupted" };
  }
  if (proposal.stage !== "awaiting_user" || !proposal.userTurnObserved) {
    return { ok: false, reason: "no_user_turn" };
  }
  const claimed = proposal;
  proposal = null;
  return { ok: true, proposal: claimed };
}
