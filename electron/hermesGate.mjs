// ===== Hermes dispatch gate =====
// Gemini sometimes dispatched without asking, or "confirmed" itself in the same
// breath. This state machine makes that impossible at the tool level: a submit
// only succeeds after (1) propose staged the brief, (2) the model finished the
// turn where it read the brief back, and (3) the USER actually spoke again.
//
// Stages: awaiting_readback -> (model turn ends) -> awaiting_user
//         awaiting_user     -> (user speaks)     -> confirmable

const PROPOSAL_TTL_MS = 5 * 60 * 1000;

let proposal = null; // { task, urgency, stage, proposedAt }

export function proposeHermesTask(task, urgency = "normal") {
  const cleanTask = String(task || "").trim();
  if (!cleanTask) return { ok: false };
  proposal = { task: cleanTask, urgency, stage: "awaiting_readback", proposedAt: Date.now() };
  return { ok: true, task: cleanTask };
}

// The model finished speaking (turnComplete) or was interrupted mid-speech —
// either way the read-back reached the user.
export function markModelTurnComplete() {
  if (proposal?.stage === "awaiting_readback") proposal.stage = "awaiting_user";
}

export function markUserSpoke() {
  if (proposal?.stage === "awaiting_user") proposal.stage = "confirmable";
}

export function resetHermesGate() {
  proposal = null;
}

/** A proposal is staged and still waiting for the user's yes/no. */
export function hasPendingProposal(now = Date.now()) {
  if (proposal && now - proposal.proposedAt > PROPOSAL_TTL_MS) proposal = null;
  return Boolean(proposal);
}

/**
 * Try to consume the staged proposal for an actual submit.
 * Returns { ok: true, proposal } and clears the stage on success, or
 * { ok: false, reason: "no_proposal" | "not_confirmed" }.
 */
export function claimConfirmedProposal(now = Date.now()) {
  if (proposal && now - proposal.proposedAt > PROPOSAL_TTL_MS) proposal = null;
  if (!proposal) return { ok: false, reason: "no_proposal" };
  if (proposal.stage !== "confirmable") return { ok: false, reason: "not_confirmed" };
  const claimed = proposal;
  proposal = null;
  return { ok: true, proposal: claimed };
}
