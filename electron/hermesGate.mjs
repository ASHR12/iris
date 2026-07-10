// ===== Hermes dispatch gate =====
//
// A submit is bound to one immutable proposal, one Hermes transcript, and an
// explicit affirmative user turn. The model cannot alter the brief at submit
// time and "the user said anything" is deliberately not confirmation.

import crypto from "node:crypto";

export const PROPOSAL_TTL_MS = 5 * 60 * 1000;

const VALID_URGENCY = new Set(["low", "normal", "high"]);
const AFFIRMATIVE = new Set([
  "yes",
  "yeah",
  "yep",
  "sure",
  "ok",
  "okay",
  "approved",
  "confirm",
  "go",
  "go ahead",
  "please do",
  "do it",
  "do it now",
  "just do it",
  "send it",
  "send it now",
  "just send it",
  "submit it",
  "submit it now",
  "yes please",
  "yes do it",
  "yes do it now",
  "yes send it",
  "yes send it now",
  "yes submit it",
  "okay send it",
  "ok send it",
]);
const REJECTION_PREFIXES = [
  "no",
  "nope",
  "do not",
  "don't",
  "dont",
  "cancel",
  "stop",
  "wait",
  "hold on",
  "not yet",
  "never mind",
  "nevermind",
];
const REVISION_WORDS = new Set([
  "but",
  "change",
  "instead",
  "add",
  "remove",
  "update",
  "correction",
  "actually",
  "except",
]);

let proposal = null;

function normalizedWords(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'’]+/gu, " ")
    .replace(/[’]/g, "'")
    .trim()
    .replace(/\s+/g, " ");
}

export function classifyConfirmation(value) {
  const normalized = normalizedWords(value);
  if (!normalized) return "other";
  if (REJECTION_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `))) {
    return "reject";
  }
  if (
    /\b(?:do not|don't|dont) (?:send|submit|do)\b/.test(normalized) ||
    /\bnot (?:now|yet)\b/.test(normalized)
  ) {
    return "reject";
  }
  const words = normalized.split(" ");
  if (words.some((word) => REVISION_WORDS.has(word))) return "revise";
  const repeatsExplicitYes =
    /\b(?:i (?:already )?said yes|i am saying yes|i am giving you(?: that)? yes)\b/.test(
      normalized,
    );
  const givesDispatchCommand =
    /\b(?:(?:send|submit) it|do it)(?: now)?\b/.test(normalized);
  if (repeatsExplicitYes && givesDispatchCommand) return "affirm";
  return AFFIRMATIVE.has(normalized) ? "affirm" : "other";
}

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
    responseKind: "other",
  });
  return { ok: true, proposal };
}

/** Advance only after the model completed the read-back turn. */
export function markModelTurnComplete() {
  if (proposal?.stage !== "awaiting_readback") return;
  const stage =
    proposal.responseKind === "reject"
      ? "rejected"
      : proposal.responseKind === "revise"
        ? "needs_revision"
        : "awaiting_user";
  replaceProposal({ stage });
}

/**
 * A barge-in does not prove that the complete brief was heard. The next model
 * turn must stage/read a fresh proposal before submission can succeed.
 */
export function markModelTurnInterrupted() {
  if (proposal?.stage === "awaiting_readback") replaceProposal({ stage: "readback_interrupted" });
}

/** Record the complete transcript accumulated for the latest user response. */
export function recordUserResponse(text, options = {}) {
  if (!proposal || !["awaiting_readback", "awaiting_user"].includes(proposal.stage)) {
    return { ok: false, reason: "not_awaiting_user" };
  }
  if (proposal.stage === "awaiting_readback" && !options.allowDuringReadback) {
    return { ok: false, reason: "readback_in_progress" };
  }
  const userResponse = String(text || "").trim();
  const responseKind = classifyConfirmation(userResponse);
  const stage =
    proposal.stage === "awaiting_readback"
      ? "awaiting_readback"
      : responseKind === "reject"
        ? "rejected"
        : responseKind === "revise"
          ? "needs_revision"
          : "awaiting_user";
  replaceProposal({ userResponse, responseKind, stage });
  return { ok: true, responseKind, stage };
}

// Backward-compatible name for callers; unlike the old implementation it
// requires the transcript and never treats arbitrary speech as confirmation.
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

/**
 * Consume the exact staged proposal. `proposalId` and `sessionId` bind the
 * model's submit call to what the user heard and to the selected Hermes thread.
 */
export function claimConfirmedProposal(options = {}) {
  const now = typeof options === "number" ? options : options.now ?? Date.now();
  expire(now);
  if (!proposal) return { ok: false, reason: "no_proposal" };
  if (!options.proposalId || options.proposalId !== proposal.id) {
    return { ok: false, reason: "proposal_mismatch" };
  }
  if (proposal.sessionId && options.sessionId !== proposal.sessionId) {
    return { ok: false, reason: "session_mismatch" };
  }
  if (proposal.stage === "rejected") return { ok: false, reason: "rejected" };
  if (proposal.stage === "needs_revision") return { ok: false, reason: "needs_revision" };
  if (proposal.stage === "readback_interrupted") {
    return { ok: false, reason: "readback_interrupted" };
  }
  if (proposal.stage !== "awaiting_user" || proposal.responseKind !== "affirm") {
    return { ok: false, reason: "not_confirmed" };
  }
  const claimed = proposal;
  proposal = null;
  return { ok: true, proposal: claimed };
}
