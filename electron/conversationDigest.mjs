// Condenses one Iris session into the two or three lines that get remembered.
//
// Storing raw turns verbatim is what makes long-term memory noisy and slow to
// search, so the durable record is a digest instead. A cheap one-shot text call
// does this far better than string heuristics, but it must never be load-bearing
// — if the call fails or is disabled, the heuristic still produces something
// useful rather than losing the session entirely.

const MAX_SOURCE_CHARS = 12000;
const MAX_DIGEST_CHARS = 400;

// Written in the assistant's own voice because the result is injected back into
// its context as memory — third-person summaries read like someone else's notes.
const PROMPT = [
  "Summarise this voice conversation, which is between you (the assistant) and the user.",
  "Write two or three short sentences in past tense, addressing the user as 'you' and yourself as 'I'.",
  "Name concrete things: topics covered, decisions made, tasks dispatched, and anything left unresolved.",
  "Do not use bullet points, headings, or Markdown. Do not add a preamble.",
  "Skip pleasantries, greetings, and farewells entirely.",
].join(" ");

// Short acknowledgements and greetings dominate a spoken transcript by count
// while carrying none of its meaning, so the fallback ignores them.
const PLEASANTRY =
  /^(hi|hey|hello|yo|yes|yeah|yep|no|nope|ok|okay|sure|thanks|thank you|cheers|bye|goodbye|good night|good morning|good afternoon|good evening|see you|talk soon)\b[\s.!,]*$/i;

function userTurns(lines) {
  return lines
    .filter((line) => /\byou:/.test(line))
    .map((line) => line.replace(/^\d{1,2}:\d{2}\s*/, "").replace(/^you:\s*/, "").trim())
    .filter(Boolean);
}

// Fallback: the longest user turns carry the intent of a session, so lead with
// those rather than the chronological first line (usually a greeting).
export function heuristicDigest(lines, { maxChars = MAX_DIGEST_CHARS } = {}) {
  const all = userTurns(lines);
  const substantive = all.filter((turn) => turn.length > 8 && !PLEASANTRY.test(turn));
  const turns = substantive.length ? substantive : all;
  if (!turns.length) return "";
  const ranked = [...new Set(turns)].sort((a, b) => b.length - a.length).slice(0, 3);
  const ordered = turns.filter((turn) => ranked.includes(turn));
  let text = `Discussed: ${ordered.join("; ")}`;
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
  return text;
}

function tail(lines) {
  const joined = lines.join("\n");
  return joined.length > MAX_SOURCE_CHARS ? joined.slice(-MAX_SOURCE_CHARS) : joined;
}

export async function buildDigest(lines, { generate, maxChars = MAX_DIGEST_CHARS } = {}) {
  const source = Array.isArray(lines) ? lines.filter(Boolean) : [];
  if (!source.length) return "";
  if (typeof generate === "function") {
    try {
      const text = await generate(`${PROMPT}\n\n---\n${tail(source)}\n---`);
      const clean = String(text || "").replace(/\s+/g, " ").trim();
      if (clean) return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}…` : clean;
    } catch {
      // Fall through to the heuristic below.
    }
  }
  return heuristicDigest(source, { maxChars });
}
