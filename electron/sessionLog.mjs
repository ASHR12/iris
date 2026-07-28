import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Append-only record of Live session lifecycle events. Runtime logs only reach
// the renderer's log panel, so before this there was no way to answer questions
// like "how often is a resume handle actually rejected?" after the fact.
//
// Every write is best-effort: this is diagnostics, and it must never be able to
// interfere with a voice session.

const MAX_BYTES = 512 * 1024;
const KEEP_BYTES = 256 * 1024;

function defaultDir() {
  return path.join(os.homedir(), ".iris");
}

export class SessionLog {
  constructor({ dir = defaultDir(), fileName = "session-log.jsonl", enabled = true } = {}) {
    this.dir = dir;
    this.file = path.join(dir, fileName);
    this.enabled = enabled;
  }

  record(event, fields = {}) {
    if (!this.enabled || !event) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields });
      fs.appendFileSync(this.file, `${line}\n`);
      this.#trimIfLarge();
    } catch {
      // Diagnostics must never break a session.
    }
  }

  // Keep the tail rather than rotating into extra files — this is a debugging
  // aid, and old lifecycle events stop being interesting quickly.
  #trimIfLarge() {
    try {
      if (fs.statSync(this.file).size <= MAX_BYTES) return;
      const text = fs.readFileSync(this.file, "utf8");
      const tail = text.slice(-KEEP_BYTES);
      const from = tail.indexOf("\n");
      fs.writeFileSync(this.file, from >= 0 ? tail.slice(from + 1) : tail);
    } catch {
      // A failed trim just means the file stays large for now.
    }
  }

  read({ limit = 200 } = {}) {
    try {
      const lines = fs.readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean);
      return lines.slice(-limit).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { event: "unparseable", raw: line };
        }
      });
    } catch {
      return [];
    }
  }

  // Rollup used to answer "is the all-day conversation actually surviving?".
  summary() {
    const counts = new Map();
    for (const entry of this.read({ limit: 5000 })) {
      counts.set(entry.event, (counts.get(entry.event) ?? 0) + 1);
    }
    return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
  }
}
