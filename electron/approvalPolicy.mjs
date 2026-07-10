export const APPROVAL_CHOICES = new Set(["once", "session", "always", "deny"]);

export function approvalChoiceFromTranscript(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'’]+/gu, " ")
    .trim();
  if (!normalized) return "other";
  if (/^(no|nope|deny|denied|reject|cancel|stop|do not|don't)\b/.test(normalized)) return "deny";
  if (/\b(always|from now on|every time)\b/.test(normalized)) return "always";
  if (/\b(session|this conversation|until i quit)\b/.test(normalized)) return "session";
  if (
    /^(allow|approve)( it| this| that)? (once|this time)$/.test(normalized) ||
    /^(once|just once)$/.test(normalized)
  ) {
    return "once";
  }
  if (/^(yes|yeah|yep|ok|okay|sure|approve|approved|allow|go ahead|do it)( please)?$/.test(normalized)) {
    return "once";
  }
  return "other";
}

export function approvalAuthorized(pending, requestedChoice) {
  const choice = String(requestedChoice || "").toLowerCase();
  return Boolean(
    pending &&
      pending.stage === "awaiting_user" &&
      APPROVAL_CHOICES.has(choice) &&
      approvalChoiceFromTranscript(pending.userResponse) === choice,
  );
}
