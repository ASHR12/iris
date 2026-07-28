import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionLog } from "../electron/sessionLog.mjs";

function tempLog(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-sessionlog-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new SessionLog({ dir, ...options });
}

test("events are appended as one JSON object per line with a timestamp", (t) => {
  const log = tempLog(t);
  log.record("fresh_start", { model: "models/test" });
  log.record("resume_rejected", { where: "setup" });

  const entries = log.read();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].event, "fresh_start");
  assert.equal(entries[0].model, "models/test");
  assert.equal(entries[1].where, "setup");
  assert.match(entries[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test("the file is capped and keeps whole lines from the tail", (t) => {
  const log = tempLog(t);
  for (let index = 0; index < 6000; index += 1) {
    log.record("connect", { index, filler: "x".repeat(120) });
  }
  const size = fs.statSync(log.file).size;
  assert.ok(size <= 512 * 1024, `log grew to ${size} bytes`);

  const entries = log.read({ limit: 10 });
  assert.ok(entries.length > 0);
  for (const entry of entries) assert.notEqual(entry.event, "unparseable");
  assert.equal(entries.at(-1).index, 5999);
});

test("summary counts events, and a disabled log stays silent", (t) => {
  const log = tempLog(t);
  log.record("resume_ok");
  log.record("resume_ok");
  log.record("resume_rejected");
  assert.deepEqual(log.summary(), { resume_ok: 2, resume_rejected: 1 });

  const off = tempLog(t, { enabled: false });
  off.record("resume_ok");
  assert.equal(off.read().length, 0);
  assert.deepEqual(off.summary(), {});
});

test("reading a log that does not exist yet returns nothing", (t) => {
  const log = tempLog(t);
  assert.deepEqual(log.read(), []);
});
