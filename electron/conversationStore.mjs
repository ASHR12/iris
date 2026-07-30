import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Queryable index over the conversation journal.
//
// The Markdown journal stays the artifact you own and can grep, but it is a
// poor thing to query: restoring "this Hermes thread's conversation" or paging
// back through it would mean parsing every day file and filtering, on every
// scroll. A day is already ~275 turns, and a thread can run for weeks.
//
// So turns are mirrored here as they are flushed, keyed by the Hermes thread
// they were spoken in. That thread id is the join between the two halves of a
// conversation: the Work Stream restores from Hermes by it, and the Comms panel
// now restores from here by the same id, so closing the app and opening it
// tomorrow brings back both sides of the same conversation.
//
// node:sqlite ships inside Electron and Node, so this costs no native module
// and nothing to rebuild at package time.

// Conversations recorded before threads were tracked, and anything spoken
// before Hermes has named a thread. Kept visible rather than dropped: it is
// still Iris's memory, it just cannot be attributed to a thread.
export const UNATTRIBUTED = "unknown";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    thread     TEXT NOT NULL,
    day        TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER,
    digest     TEXT
  );
  CREATE TABLE IF NOT EXISTS turns (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    thread     TEXT NOT NULL,
    at         INTEGER NOT NULL,
    speaker    TEXT NOT NULL,
    text       TEXT NOT NULL
  );
  -- The hot query is "the tail of this thread", so thread lives on the turn
  -- itself: restoring a panel must not join.
  CREATE INDEX IF NOT EXISTS turns_thread_at ON turns(thread, at);
  CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id, at);
  CREATE INDEX IF NOT EXISTS sessions_thread ON sessions(thread, started_at);
  CREATE INDEX IF NOT EXISTS sessions_day ON sessions(day);
`;

function defaultFile() {
  return path.join(os.homedir(), ".iris", "conversations.db");
}

export class ConversationStore {
  constructor({ file = defaultFile(), enabled = true } = {}) {
    this.file = file;
    this.enabled = enabled;
    this.db = null;
  }

  // Opened on first use so that switching memory off never creates a database,
  // and so a failure to open degrades to "no recall" instead of no voice.
  #open() {
    if (!this.enabled) return null;
    if (this.db) return this.db;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const db = new DatabaseSync(this.file);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec(SCHEMA);
      this.db = db;
    } catch {
      this.enabled = false;
      this.db = null;
    }
    return this.db;
  }

  #run(fn, fallback) {
    const db = this.#open();
    if (!db) return fallback;
    try {
      return fn(db);
    } catch {
      return fallback;
    }
  }

  // ===== Writing =====

  beginSession({ id, thread, day, startedAt }) {
    if (!id) return false;
    return this.#run((db) => {
      db.prepare(
        `INSERT INTO sessions (id, thread, day, started_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET thread = excluded.thread`,
      ).run(id, thread || UNATTRIBUTED, day, startedAt);
      return true;
    }, false);
  }

  // Mirrors one journal flush. Batched in a transaction because a flush is a
  // handful of turns and three separate fsyncs would be three too many.
  addTurns(sessionId, thread, turns) {
    if (!sessionId || !turns?.length) return 0;
    return this.#run((db) => {
      const insert = db.prepare(
        "INSERT INTO turns (session_id, thread, at, speaker, text) VALUES (?, ?, ?, ?, ?)",
      );
      db.exec("BEGIN");
      try {
        for (const turn of turns) {
          insert.run(sessionId, thread || UNATTRIBUTED, turn.at, turn.speaker, turn.text);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return turns.length;
    }, 0);
  }

  endSession({ id, endedAt, digest }) {
    if (!id) return false;
    return this.#run((db) => {
      db.prepare(
        `UPDATE sessions SET ended_at = COALESCE(?, ended_at), digest = COALESCE(?, digest)
         WHERE id = ?`,
      ).run(endedAt ?? null, digest ?? null, id);
      return true;
    }, false);
  }

  // ===== Reading =====

  // Oldest first, so the caller can render it straight into a transcript.
  recentTurns({ thread, limit = 60 } = {}) {
    return this.#run((db) => {
      const rows = db
        .prepare(
          `SELECT id, at, speaker, text FROM turns
           WHERE thread = ? ORDER BY at DESC, id DESC LIMIT ?`,
        )
        .all(thread || UNATTRIBUTED, limit);
      return rows.reverse();
    }, []);
  }

  // The page above what is already on screen. The cursor is (at, id), not id
  // alone: row ids follow insertion, and a backfill inserts whole days out of
  // order, so an id-only cursor would page sideways into the wrong day. The id
  // breaks ties, because imported turns are only accurate to the minute and a
  // burst of them shares a timestamp.
  turnsBefore({ thread, beforeAt, beforeId, limit = 60 } = {}) {
    if (!Number.isFinite(beforeAt)) return this.recentTurns({ thread, limit });
    return this.#run((db) => {
      const rows = db
        .prepare(
          `SELECT id, at, speaker, text FROM turns
           WHERE thread = ? AND (at < ? OR (at = ? AND id < ?))
           ORDER BY at DESC, id DESC LIMIT ?`,
        )
        .all(thread || UNATTRIBUTED, beforeAt, beforeAt, beforeId ?? 0, limit);
      return rows.reverse();
    }, []);
  }

  countTurns({ thread } = {}) {
    return this.#run(
      (db) => db.prepare("SELECT COUNT(*) AS n FROM turns WHERE thread = ?").get(thread || UNATTRIBUTED)?.n ?? 0,
      0,
    );
  }

  // Threads that actually hold conversation, newest first. Used to decide
  // whether a thread has history of its own to wake into.
  threads({ limit = 20 } = {}) {
    return this.#run(
      (db) =>
        db
          .prepare(
            `SELECT thread, COUNT(*) AS turns, MAX(at) AS last_at FROM turns
             GROUP BY thread ORDER BY last_at DESC LIMIT ?`,
          )
          .all(limit),
      [],
    );
  }

  digests({ thread, day, limit = 20 } = {}) {
    return this.#run((db) => {
      const where = ["digest IS NOT NULL", "digest <> ''"];
      const args = [];
      if (thread) {
        where.push("thread = ?");
        args.push(thread);
      }
      if (day) {
        where.push("day = ?");
        args.push(day);
      }
      args.push(limit);
      const rows = db
        .prepare(
          `SELECT id, thread, day, started_at, ended_at, digest FROM sessions
           WHERE ${where.join(" AND ")} ORDER BY started_at DESC LIMIT ?`,
        )
        .all(...args);
      return rows.reverse();
    }, []);
  }

  // Ranked the same way the file-backed search was: one point per distinct term
  // found. Kept as a scan because even a year of digests is a few thousand rows.
  search(query, { limit = 6 } = {}) {
    const tokens = String(query || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2);
    const rows = this.digests({ limit: 2000 });
    if (!tokens.length) return rows.slice(-limit).reverse();

    const scored = [];
    for (const row of rows) {
      const haystack = `${row.day} ${row.digest}`.toLowerCase();
      let score = 0;
      for (const token of tokens) if (haystack.includes(token)) score += 1;
      if (score) scored.push({ ...row, score });
    }
    return scored.sort((a, b) => b.score - a.score || b.started_at - a.started_at).slice(0, limit);
  }

  // ===== Retention =====

  // Mirrors the journal's policy: the raw lines are bulky and mostly feed the
  // digest, the digests are the memory. Sessions survive their turns.
  prune({ rawBefore, digestBefore } = {}) {
    return this.#run((db) => {
      let turns = 0;
      let sessions = 0;
      if (rawBefore) {
        turns = db.prepare("DELETE FROM turns WHERE at < ?").run(rawBefore).changes ?? 0;
      }
      if (digestBefore) {
        sessions = db.prepare("DELETE FROM sessions WHERE started_at < ?").run(digestBefore).changes ?? 0;
        db.prepare("DELETE FROM turns WHERE session_id NOT IN (SELECT id FROM sessions)").run();
      }
      return { turns, sessions };
    }, { turns: 0, sessions: 0 });
  }

  purge() {
    this.close();
    try {
      for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${this.file}${suffix}`, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  close() {
    try {
      this.db?.close();
    } catch {
      // Closing a database that never opened is not an error worth raising.
    }
    this.db = null;
  }

  // ===== Backfill =====

  // One-time import of journals written before this index existed. Those
  // conversations predate thread tracking, so they land unattributed: still
  // searchable, still Iris's memory, just not tied to a Hermes thread.
  importFromJournal(journal, { thread = UNATTRIBUTED } = {}) {
    const imported = { sessions: 0, turns: 0 };
    const db = this.#open();
    if (!db || !journal?.days) return imported;
    // Oldest day first, so row ids still broadly follow the clock afterwards.
    for (const day of [...journal.days()].reverse()) {
      for (const session of journal.readDay(day)) {
        const exists = this.#run(
          (handle) => handle.prepare("SELECT 1 AS found FROM sessions WHERE id = ?").get(session.id),
          null,
        );
        if (exists) continue;
        this.beginSession({ id: session.id, thread, day, startedAt: session.startedAt });
        if (session.digest) this.endSession({ id: session.id, endedAt: session.endedAt, digest: session.digest });
        imported.turns += this.addTurns(session.id, thread, session.turns);
        imported.sessions += 1;
      }
    }
    return imported;
  }
}
