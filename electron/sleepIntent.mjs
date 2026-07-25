const LEADING_FILLERS = [
  "okay",
  "ok",
  "alright",
  "all right",
  "well",
  "cool",
  "great",
  "thanks",
  "thank you",
  "thanks iris",
  "thank you iris",
  "iris",
];

const SLEEP_PHRASES = new Set([
  "bye",
  "bye bye",
  "goodbye",
  "good bye",
  "go to sleep",
  "go back to sleep",
  "sleep",
  "sleep now",
  "take care",
  "see you",
  "see you later",
  "catch you later",
  "goodnight",
  "good night",
  "that's all",
  "that's all for now",
  "that is all",
  "that is all for now",
  "we're done",
  "we are done",
  "i'm done",
  "i am done",
]);

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[-–—]+/g, " ")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSleepIntent(value) {
  let text = normalize(value);
  if (!text) return false;
  let changed = true;
  while (changed) {
    changed = false;
    for (const filler of LEADING_FILLERS) {
      if (text === filler) return false;
      if (text.startsWith(`${filler} `)) {
        text = text.slice(filler.length + 1).trim();
        changed = true;
        break;
      }
    }
  }
  if (SLEEP_PHRASES.has(text)) return true;
  return /^(?:bye(?: bye)?|good ?bye|see you(?: later)?|catch you later)(?: (?:iris|for now|then|take care|bye(?: bye)?))*$/.test(
    text,
  );
}
