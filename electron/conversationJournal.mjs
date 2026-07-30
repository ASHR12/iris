import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Durable conversation memory. The Live context window is deliberately short —
// it holds minutes of speech and then discards the oldest turns — so anything
// worth remembering past that has to live somewhere searchable. This is the
// local equivalent of Google's Session/MemoryService split: the Live session is
// short-term state, this file tree is the long-term archive.
//
// Layout is one Markdown file per calendar day, sectioned per Iris session:
//
//   ~/.iris/journal/2026-07-28.md
//     # Conversation journal — Tuesday, 28 July 2026
//     ## Session 3 — 14:02–14:31 (id: 20260728-140215-a1b2)
//     **Digest:** two or three lines describing what happened
//     - 14:02 you: ...
//     - 14:02 iris: ...
//
// File names stay machine-sortable because retention compares them as strings,
// but everything written inside is for a person reading it months later: the
// weekday spelled out, sessions numbered in the order they happened, and each
// one stamped with the minute it started and the minute it ended.
//
// Turns are buffered in memory and flushed on a timer so the audio path never
// waits on disk. Digests are what gets preloaded and searched; raw turns exist
// to build digests from and to debug, and are pruned much sooner.

const DEFAULT_FLUSH_MS = 5000;
const DIGEST_MARKER = "**Digest:**";

// Fixed English names rather than Intl, so a journal reads and greps the same
// way on every machine regardless of system locale.
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function defaultDir() {
  return path.join(os.homedir(), ".iris", "journal");
}

function two(value) {
  return String(value).padStart(2, "0");
}

export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

function clockTime(date) {
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function dateFromKey(key) {
  const [year, month, day] = String(key).split("-").map(Number);
  return new Date(year, month - 1, day);
}

// "Wednesday, 29 July 2026" — the weekday earns its place because a person
// asking about a past conversation reaches for "Monday" far sooner than a date.
export function longDate(date) {
  return `${WEEKDAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function fileHeader(key) {
  const day = longDate(dateFromKey(key));
  return [
    `# Conversation journal — ${day}`,
    "",
    `Every conversation held on ${day}, oldest first — one section per session,`,
    "from the moment Iris woke to the moment she slept, summarised under its heading.",
    "",
  ].join("\n");
}

// Older files were written as "## Session 08:26"; both shapes reduce to the
// time span, which is all a reader or the model needs from the heading.
function sessionLabel(heading) {
  return heading
    .replace(/^Session\s+\d+\s+—\s*/, "")
    .replace(/^Session\s+/, "")
    .trim();
}

export function makeSessionId(date = new Date()) {
  const stamp = `${dayKey(date).replace(/-/g, "")}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

// One line per turn, collapsed to a single line so the file stays greppable.
function formatTurn(turn) {
  const when = clockTime(new Date(turn.at));
  const text = String(turn.text).replace(/\s+/g, " ").trim();
  return `- ${when} ${turn.speaker}: ${text}`;
}

export class ConversationJournal {
  constructor({
    dir = defaultDir(),
    flushMs = DEFAULT_FLUSH_MS,
    rawRetentionDays = 7,
    digestRetentionDays = 90,
    enabled = true,
    now = () => new Date(),
    // Optional passive mirror (the SQLite index). The journal stays in charge
    // of the conversation's lifecycle; the mirror only gets told about it, so
    // there is one write path and no chance of the two disagreeing about where
    // a session starts and ends.
    mirror = null,
  } = {}) {
    this.dir = dir;
    this.flushMs = flushMs;
    this.rawRetentionDays = rawRetentionDays;
    this.digestRetentionDays = digestRetentionDays;
    this.enabled = enabled;
    this.now = now;
    this.mirror = mirror;
    this.pending = [];
    this.flushTimer = null;
    this.session = null;
  }

  filePath(key) {
    return path.join(this.dir, `${key}.md`);
  }

  // ===== Session lifecycle =====

  // `thread` is the Hermes chat this conversation belongs to. It is the join
  // between the two halves of a conversation — the Work Stream restores its
  // tasks from Hermes by it, the Comms panel restores its turns by it — so a
  // session is closed and reopened when the thread changes rather than
  // straddling two.
  beginSession(sessionId = makeSessionId(this.now()), { thread = "" } = {}) {
    if (!this.enabled) return null;
    const at = this.now();
    this.session = { id: sessionId, startedAt: at, dayKey: dayKey(at), thread, turns: 0 };
    this.mirror?.sessionStarted?.({
      id: sessionId,
      thread,
      day: this.session.dayKey,
      startedAt: at.getTime(),
    });
    return sessionId;
  }

  get activeSessionId() {
    return this.session?.id ?? null;
  }

  get activeThread() {
    return this.session?.thread ?? "";
  }

  addTurn(speaker, text) {
    if (!this.enabled || !text) return;
    const clean = String(text).trim();
    if (!clean) return;
    if (!this.session) this.beginSession();
    this.pending.push({ speaker, text: clean, at: this.now().getTime() });
    this.session.turns += 1;
    this.#scheduleFlush();
  }

  // Sessions are numbered within their day so "the third conversation on
  // Monday" is a thing you can point at. Counted from the file rather than
  // tracked in memory, because a relaunch mid-day must continue the sequence.
  #nextSessionNumber(file) {
    try {
      const headings = fs.readFileSync(file, "utf8").match(/^## Session\b/gm);
      return (headings?.length ?? 0) + 1;
    } catch {
      return 1;
    }
  }

  #headingLine(session) {
    const span = session.endedAt
      ? `${clockTime(session.startedAt)}–${clockTime(session.endedAt)}`
      : clockTime(session.startedAt);
    return `## Session ${session.number} — ${span} (id: ${session.id})`;
  }

  // The end time and the digest are both only knowable once the session is
  // over, so each is patched into the section already sitting on disk. The id
  // is the anchor: by then a newer session may have appended below it.
  #patchSection(session, { digest } = {}) {
    if (!session?.headerWritten) return false;
    try {
      const file = this.filePath(session.dayKey);
      const lines = fs.readFileSync(file, "utf8").split("\n");
      const at = lines.findIndex((line) => line.startsWith("## ") && line.includes(`(id: ${session.id})`));
      if (at < 0) return false;
      lines[at] = this.#headingLine(session);
      if (digest) {
        const line = `${DIGEST_MARKER} ${digest}`;
        if (lines[at + 1]?.startsWith(DIGEST_MARKER)) lines[at + 1] = line;
        else lines.splice(at + 1, 0, line);
      }
      fs.writeFileSync(file, lines.join("\n"));
      return true;
    } catch {
      return false;
    }
  }

  #scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.flushMs);
    this.flushTimer.unref?.();
  }

  // Written synchronously, but only ever from a timer or at sleep — never from
  // inside a message handler.
  flush() {
    if (!this.pending.length) return 0;
    const turns = this.pending;
    this.pending = [];
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const key = this.session?.dayKey ?? dayKey(this.now());
      const file = this.filePath(key);
      let out = "";
      if (!fs.existsSync(file)) out += fileHeader(key);
      if (this.session && !this.session.headerWritten) {
        this.session.number = this.#nextSessionNumber(file);
        out += `\n${this.#headingLine(this.session)}\n`;
        this.session.headerWritten = true;
      }
      out += `${turns.map(formatTurn).join("\n")}\n`;
      fs.appendFileSync(file, out);
      if (this.session) this.mirror?.turnsFlushed?.(this.session, turns);
      return turns.length;
    } catch {
      // Losing journal lines must never surface as a voice error.
      return 0;
    }
  }

  // Detaches the current session synchronously, so a wake that arrives while a
  // digest is still being generated starts a clean section instead of having the
  // late digest attributed to it.
  closeSession() {
    if (!this.enabled || !this.session) return null;
    this.flush();
    const session = this.session;
    this.session = null;
    session.endedAt = this.now();
    this.#patchSection(session);
    this.mirror?.sessionEnded?.({ id: session.id, endedAt: session.endedAt.getTime() });
    return session;
  }

  // The digest is the durable part: it is what gets preloaded at the next wake
  // and what search looks through. It sits directly under its heading rather
  // than at the foot of the section, so scrolling a day reads as a list of
  // summaries with the raw lines available underneath each.
  writeDigest(session, digest) {
    if (!this.enabled || !session || !digest) return null;
    const clean = String(digest).replace(/\s+/g, " ").trim();
    if (!clean) return null;
    this.mirror?.sessionEnded?.({ id: session.id, digest: clean });
    return this.#patchSection(session, { digest: clean }) ? clean : null;
  }

  endSession(digest) {
    const session = this.closeSession();
    if (!session) return null;
    return this.writeDigest(session, digest);
  }

  // Raw turns for the active session, used as digest source material.
  sessionTranscript() {
    if (!this.session) return [];
    this.flush();
    try {
      const text = fs.readFileSync(this.filePath(this.session.dayKey), "utf8");
      const marker = `(id: ${this.session.id})`;
      const from = text.indexOf(marker);
      if (from < 0) return [];
      const rest = text.slice(from);
      const end = rest.indexOf("\n## ", 1);
      return (end < 0 ? rest : rest.slice(0, end))
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2));
    } catch {
      return [];
    }
  }

  // ===== Retrieval =====

  // Newest first. Public because the SQLite index backfills through it.
  days() {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
        .map((name) => name.replace(/\.md$/, ""))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  #digestsFor(key) {
    try {
      const text = fs.readFileSync(this.filePath(key), "utf8");
      const out = [];
      const when = longDate(dateFromKey(key));
      let heading = "";
      for (const line of text.split("\n")) {
        // The session id is bookkeeping for sessionTranscript(); strip it so it
        // never reaches the model as noise.
        if (line.startsWith("## ")) {
          heading = sessionLabel(line.slice(3).replace(/\s*\(id:[^)]*\)\s*$/, "").trim());
        } else if (line.startsWith(DIGEST_MARKER)) {
          out.push({ day: key, when, session: heading, digest: line.slice(DIGEST_MARKER.length).trim() });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  // Preloaded into the system instruction at connect, so "what did we do this
  // morning?" needs no tool call. Kept small on purpose.
  todayDigest({ maxChars = 1200 } = {}) {
    const entries = this.#digestsFor(dayKey(this.now()));
    if (!entries.length) return "";
    const lines = entries.map((entry) => `- ${entry.session}: ${entry.digest}`);
    let text = lines.join("\n");
    if (text.length > maxChars) {
      // Keep the most recent sessions when trimming.
      while (lines.length > 1 && text.length > maxChars) {
        lines.shift();
        text = lines.join("\n");
      }
      if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
    }
    return text;
  }

  // The tail of today's spoken lines, newest last. This is what lets a fresh
  // session pick up mid-conversation: the digests say what the day was about,
  // these say what was just said. Cheap to carry as text, unlike replaying the
  // conversation server-side.
  recentTurns({ limit = 8, maxChars = 1400 } = {}) {
    if (!this.enabled) return [];
    this.flush();
    let lines = [];
    // Yesterday's tail still matters for an overnight wake mid-thought.
    for (const key of this.days().slice(0, 2)) {
      try {
        const dayLines = fs
          .readFileSync(this.filePath(key), "utf8")
          .split("\n")
          .filter((line) => line.startsWith("- "))
          .map((line) => line.slice(2));
        lines = [...dayLines, ...lines];
      } catch {
        // Skip an unreadable day.
      }
      if (lines.length >= limit) break;
    }
    lines = lines.slice(-limit);
    while (lines.length > 1 && lines.join("\n").length > maxChars) lines.shift();
    return lines;
  }

  // Keyword search across digests. Deliberately local and index-free: digests
  // are a few KB per day, so scanning even a year costs milliseconds and adds
  // no network round trip.
  search(query, { limit = 6, days = 120 } = {}) {
    const tokens = String(query || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2);
    const candidates = [];
    for (const key of this.days().slice(0, days)) {
      for (const entry of this.#digestsFor(key)) candidates.push(entry);
    }
    if (!tokens.length) return candidates.slice(0, limit);

    const scored = [];
    for (const entry of candidates) {
      // The spelled-out date is part of the haystack so "what did we decide on
      // Monday?" and "back in July" match on the words people actually use.
      const haystack = `${entry.day} ${entry.when} ${entry.session} ${entry.digest}`.toLowerCase();
      let score = 0;
      for (const token of tokens) if (haystack.includes(token)) score += 1;
      if (score) scored.push({ ...entry, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || (a.day < b.day ? 1 : -1))
      .slice(0, limit);
  }

  // ===== Retention =====

  // Raw turns age out quickly (they are bulky and only useful for building the
  // digest); digests stay far longer because they are the actual memory.
  prune() {
    if (!this.enabled) return { strippedRaw: 0, removedDays: 0 };
    const today = this.now();
    const cutoff = (days) => {
      const date = new Date(today);
      date.setDate(date.getDate() - days);
      return dayKey(date);
    };
    const rawCutoff = cutoff(this.rawRetentionDays);
    const digestCutoff = cutoff(this.digestRetentionDays);
    let strippedRaw = 0;
    let removedDays = 0;

    for (const key of this.days()) {
      const file = this.filePath(key);
      try {
        if (key < digestCutoff) {
          fs.rmSync(file);
          removedDays += 1;
          continue;
        }
        if (key >= rawCutoff) continue;
        const text = fs.readFileSync(file, "utf8");
        const kept = text.split("\n").filter((line) => !line.startsWith("- "));
        if (kept.length !== text.split("\n").length) {
          fs.writeFileSync(file, kept.join("\n"));
          strippedRaw += 1;
        }
      } catch {
        // A single unreadable day must not stop the sweep.
      }
    }
    return { strippedRaw, removedDays };
  }

  purgeAll() {
    this.pending = [];
    this.session = null;
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}
