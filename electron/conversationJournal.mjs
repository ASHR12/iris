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
//     ## Session 14:02 – 14:31  (id: 20260728-140215-a1b2)
//     **Digest:** two or three lines describing what happened
//     - 14:02 you: ...
//     - 14:02 iris: ...
//
// Turns are buffered in memory and flushed on a timer so the audio path never
// waits on disk. Digests are what gets preloaded and searched; raw turns exist
// to build digests from and to debug, and are pruned much sooner.

const DEFAULT_FLUSH_MS = 5000;
const DIGEST_MARKER = "**Digest:**";

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
  } = {}) {
    this.dir = dir;
    this.flushMs = flushMs;
    this.rawRetentionDays = rawRetentionDays;
    this.digestRetentionDays = digestRetentionDays;
    this.enabled = enabled;
    this.now = now;
    this.pending = [];
    this.flushTimer = null;
    this.session = null;
  }

  filePath(key) {
    return path.join(this.dir, `${key}.md`);
  }

  // ===== Session lifecycle =====

  beginSession(sessionId = makeSessionId(this.now())) {
    if (!this.enabled) return null;
    const at = this.now();
    this.session = { id: sessionId, startedAt: at, dayKey: dayKey(at), turns: 0 };
    return sessionId;
  }

  get activeSessionId() {
    return this.session?.id ?? null;
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
      if (!fs.existsSync(file)) out += `# Conversation journal — ${key}\n`;
      if (this.session && !this.session.headerWritten) {
        out += `\n## Session ${clockTime(this.session.startedAt)} (id: ${this.session.id})\n`;
        this.session.headerWritten = true;
      }
      out += `${turns.map(formatTurn).join("\n")}\n`;
      fs.appendFileSync(file, out);
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
    return session;
  }

  // The digest is the durable part: it is what gets preloaded at the next wake
  // and what search looks through. Inserted at the end of its own section rather
  // than appended to the file, because by the time a model-generated digest
  // arrives a newer session may already have written turns below it.
  writeDigest(session, digest) {
    if (!this.enabled || !session || !digest) return null;
    const line = `${DIGEST_MARKER} ${String(digest).replace(/\s+/g, " ").trim()}`;
    try {
      const file = this.filePath(session.dayKey);
      const text = fs.readFileSync(file, "utf8");
      const headingAt = text.indexOf(`(id: ${session.id})`);
      if (headingAt < 0) return null;
      const nextHeadingAt = text.indexOf("\n## ", headingAt);
      if (nextHeadingAt < 0) {
        fs.appendFileSync(file, text.endsWith("\n") ? `${line}\n` : `\n${line}\n`);
      } else {
        fs.writeFileSync(file, `${text.slice(0, nextHeadingAt)}\n${line}${text.slice(nextHeadingAt)}`);
      }
      return line.slice(DIGEST_MARKER.length).trim();
    } catch {
      return null;
    }
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

  #days() {
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
      let heading = "";
      for (const line of text.split("\n")) {
        // The session id is bookkeeping for sessionTranscript(); strip it so it
        // never reaches the model as noise.
        if (line.startsWith("## ")) heading = line.slice(3).replace(/\s*\(id:[^)]*\)\s*$/, "").trim();
        else if (line.startsWith(DIGEST_MARKER)) {
          out.push({ day: key, session: heading, digest: line.slice(DIGEST_MARKER.length).trim() });
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

  // Keyword search across digests. Deliberately local and index-free: digests
  // are a few KB per day, so scanning even a year costs milliseconds and adds
  // no network round trip.
  search(query, { limit = 6, days = 120 } = {}) {
    const tokens = String(query || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2);
    const candidates = [];
    for (const key of this.#days().slice(0, days)) {
      for (const entry of this.#digestsFor(key)) candidates.push(entry);
    }
    if (!tokens.length) return candidates.slice(0, limit);

    const scored = [];
    for (const entry of candidates) {
      const haystack = `${entry.day} ${entry.session} ${entry.digest}`.toLowerCase();
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

    for (const key of this.#days()) {
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
