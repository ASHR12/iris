import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConversationJournal, dayKey } from "../electron/conversationJournal.mjs";
import { buildDigest, heuristicDigest } from "../electron/conversationDigest.mjs";

function tempJournal(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-journal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ConversationJournal({ dir, flushMs: 60_000, ...options });
}

function shiftDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() - days);
  return next;
}

test("turns land in the day's file under a session heading", (t) => {
  const journal = tempJournal(t);
  const id = journal.beginSession();
  journal.addTurn("you", "remind me about the Q3 pricing deck");
  journal.addTurn("iris", "Opening it now.");
  assert.equal(journal.flush(), 2);

  const text = fs.readFileSync(journal.filePath(dayKey()), "utf8");
  assert.match(text, new RegExp(`## Session 1 — \\d{2}:\\d{2} \\(id: ${id}\\)`));
  assert.match(text, /- \d{2}:\d{2} you: remind me about the Q3 pricing deck/);
  assert.match(text, /- \d{2}:\d{2} iris: Opening it now\./);
});

test("the day's file names the weekday and full date, not just the key", (t) => {
  const journal = tempJournal(t, { now: () => new Date(2026, 6, 29, 9, 15) });
  journal.beginSession();
  journal.addTurn("you", "what's on today?");
  journal.flush();

  const text = fs.readFileSync(journal.filePath("2026-07-29"), "utf8");
  assert.match(text, /^# Conversation journal — Wednesday, 29 July 2026$/m);
  assert.match(text, /Every conversation held on Wednesday, 29 July 2026/);
});

test("sessions are numbered in order and stamped with when they started and ended", (t) => {
  let clock = new Date(2026, 6, 29, 9, 15);
  const journal = tempJournal(t, { now: () => clock });

  journal.beginSession();
  journal.addTurn("you", "first conversation");
  clock = new Date(2026, 6, 29, 9, 42);
  journal.endSession("Talked about the first thing.");

  clock = new Date(2026, 6, 29, 14, 3);
  journal.beginSession();
  journal.addTurn("you", "second conversation");
  clock = new Date(2026, 6, 29, 14, 30);
  journal.endSession("Talked about the second thing.");

  const text = fs.readFileSync(journal.filePath("2026-07-29"), "utf8");
  assert.match(text, /## Session 1 — 09:15–09:42 /);
  assert.match(text, /## Session 2 — 14:03–14:30 /);
  // The digest introduces its session rather than trailing the raw lines.
  assert.match(text, /## Session 1 — [^\n]*\n\*\*Digest:\*\* Talked about the first thing\./);
});

test("session numbering continues across a relaunch on the same day", (t) => {
  const clock = () => new Date(2026, 6, 29, 16, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-journal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const before = new ConversationJournal({ dir, flushMs: 60_000, now: clock });
  before.beginSession();
  before.addTurn("you", "before the restart");
  before.endSession("Before.");

  const after = new ConversationJournal({ dir, flushMs: 60_000, now: clock });
  after.beginSession();
  after.addTurn("you", "after the restart");
  after.flush();

  assert.match(fs.readFileSync(after.filePath("2026-07-29"), "utf8"), /## Session 2 — 16:00 /);
});

test("search matches the weekday and month people actually say", (t) => {
  const journal = tempJournal(t, { now: () => new Date(2026, 6, 29, 11, 0) });
  journal.beginSession();
  journal.addTurn("you", "the pricing deck");
  journal.endSession("Reviewed the pricing deck with you.");

  assert.equal(journal.search("what did we do on Wednesday")[0].when, "Wednesday, 29 July 2026");
  assert.equal(journal.search("that thing back in July").length, 1);
});

test("multiple sessions in one day stay separate and both digests are kept", (t) => {
  const journal = tempJournal(t);
  journal.beginSession();
  journal.addTurn("you", "morning topic");
  journal.endSession("Talked about the morning topic.");
  journal.beginSession();
  journal.addTurn("you", "afternoon topic");
  journal.endSession("Talked about the afternoon topic.");

  const preload = journal.todayDigest();
  assert.match(preload, /morning topic/);
  assert.match(preload, /afternoon topic/);
  assert.equal(preload.split("\n").length, 2);
});

test("newlines in a turn cannot break the one-line-per-turn format", (t) => {
  const journal = tempJournal(t);
  journal.beginSession();
  journal.addTurn("iris", "line one\nline two\n\nline three");
  journal.flush();
  const lines = fs
    .readFileSync(journal.filePath(dayKey()), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("- "));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /line one line two line three/);
});

test("search ranks by matching terms and finds older days", (t) => {
  const journal = tempJournal(t);
  const today = new Date();
  const days = [shiftDays(today, 3), shiftDays(today, 1), today];
  for (const [index, when] of days.entries()) {
    journal.now = () => when;
    journal.beginSession();
    journal.addTurn("you", `topic ${index}`);
    journal.endSession(
      index === 0 ? "Reviewed the Vercel billing spike." : `Session ${index} about something else.`,
    );
  }
  journal.now = () => today;

  const hits = journal.search("vercel billing");
  assert.equal(hits[0].day, dayKey(days[0]));
  assert.match(hits[0].digest, /billing spike/);

  assert.equal(journal.search("nothing matches this at all").length, 0);
});

test("today's preload stays bounded and keeps the most recent sessions", (t) => {
  const journal = tempJournal(t);
  for (let index = 0; index < 12; index += 1) {
    journal.beginSession();
    journal.addTurn("you", `session ${index}`);
    journal.endSession(`Session ${index}: ${"detail ".repeat(40)}`);
  }
  const preload = journal.todayDigest({ maxChars: 600 });
  assert.ok(preload.length <= 601, `preload was ${preload.length} chars`);
  assert.match(preload, /Session 11/);
  assert.doesNotMatch(preload, /Session 0:/);
});

test("pruning strips old raw turns but keeps their digests, and drops ancient days", (t) => {
  const today = new Date();
  const journal = tempJournal(t, { rawRetentionDays: 7, digestRetentionDays: 30 });
  const write = (daysAgo, digest) => {
    const when = shiftDays(today, daysAgo);
    journal.now = () => when;
    journal.beginSession();
    journal.addTurn("you", `spoken ${daysAgo} days ago`);
    journal.endSession(digest);
  };
  write(40, "Ancient session.");
  write(10, "Ten days ago we scoped the migration.");
  write(1, "Yesterday we fixed the wake latency.");
  journal.now = () => today;

  const result = journal.prune();
  assert.equal(result.removedDays, 1);
  assert.equal(result.strippedRaw, 1);

  assert.equal(fs.existsSync(journal.filePath(dayKey(shiftDays(today, 40)))), false);

  const old = fs.readFileSync(journal.filePath(dayKey(shiftDays(today, 10))), "utf8");
  assert.match(old, /scoped the migration/);
  assert.doesNotMatch(old, /spoken 10 days ago/);

  const recent = fs.readFileSync(journal.filePath(dayKey(shiftDays(today, 1))), "utf8");
  assert.match(recent, /spoken 1 days ago/);

  assert.equal(journal.search("migration").length, 1);
});

test("a digest that arrives after the next session started lands in its own section", (t) => {
  const journal = tempJournal(t);
  journal.beginSession();
  journal.addTurn("you", "first session work");
  const first = journal.closeSession();

  // The wake happens before the digest call returns.
  journal.beginSession();
  journal.addTurn("you", "second session work");
  journal.flush();

  journal.writeDigest(first, "We went through the first session work.");
  journal.endSession("We went through the second session work.");

  const digests = journal.search("session work", { limit: 5 });
  assert.equal(digests.length, 2);
  const text = fs.readFileSync(journal.filePath(dayKey()), "utf8");
  const firstHeadingAt = text.indexOf(first.id);
  const firstDigestAt = text.indexOf("first session work.");
  const secondHeadingAt = text.indexOf("## Session", firstHeadingAt + 1);
  assert.ok(
    firstHeadingAt < firstDigestAt && firstDigestAt < secondHeadingAt,
    "the late digest must sit inside its own session section",
  );
});

test("recent turns are the tail of what was said, newest last", (t) => {
  const journal = tempJournal(t);
  journal.beginSession();
  for (let index = 0; index < 20; index += 1) {
    journal.addTurn(index % 2 ? "iris" : "you", `line ${index}`);
  }
  const recent = journal.recentTurns({ limit: 6 });
  assert.equal(recent.length, 6);
  assert.match(recent.at(-1), /line 19/);
  assert.match(recent[0], /line 14/);
  assert.doesNotMatch(recent.join("\n"), /line 13/);
});

test("recent turns cross the session boundary a nap creates", (t) => {
  const journal = tempJournal(t);
  journal.beginSession();
  journal.addTurn("you", "before the nap");
  journal.endSession("First half.");
  journal.beginSession();
  journal.addTurn("you", "after the nap");
  const recent = journal.recentTurns({ limit: 4 });
  assert.match(recent.join("\n"), /before the nap/);
  assert.match(recent.join("\n"), /after the nap/);
  assert.doesNotMatch(recent.join("\n"), /First half/);
});

test("recent turns stay bounded by character budget, keeping the newest", (t) => {
  const journal = tempJournal(t);
  journal.beginSession();
  for (let index = 0; index < 10; index += 1) {
    journal.addTurn("you", `turn ${index} ${"padding ".repeat(40)}`);
  }
  const recent = journal.recentTurns({ limit: 10, maxChars: 600 });
  assert.ok(recent.join("\n").length <= 600, `context was ${recent.join("\n").length} chars`);
  assert.match(recent.at(-1), /turn 9/);
});

test("a disabled journal has no recent turns to offer", (t) => {
  const journal = tempJournal(t, { enabled: false });
  journal.beginSession();
  journal.addTurn("you", "nothing is stored");
  assert.deepEqual(journal.recentTurns(), []);
});

test("a disabled journal records nothing and reports nothing", (t) => {
  const journal = tempJournal(t, { enabled: false });
  journal.beginSession();
  journal.addTurn("you", "this must not be written");
  journal.flush();
  assert.equal(fs.existsSync(journal.filePath(dayKey())), false);
  assert.equal(journal.todayDigest(), "");
  assert.equal(journal.activeSessionId, null);
});

test("purge removes the whole journal tree", (t) => {
  const journal = tempJournal(t);
  journal.beginSession();
  journal.addTurn("you", "something private");
  journal.flush();
  assert.equal(journal.purgeAll(), true);
  assert.equal(fs.existsSync(journal.dir), false);
  assert.equal(journal.todayDigest(), "");
});

test("transcript for the active session excludes other sessions", (t) => {
  const journal = tempJournal(t);
  journal.beginSession();
  journal.addTurn("you", "first session line");
  journal.endSession("First.");
  journal.beginSession();
  journal.addTurn("you", "second session line");
  const transcript = journal.sessionTranscript();
  assert.equal(transcript.length, 1);
  assert.match(transcript[0], /second session line/);
});

test("digest generation falls back to the heuristic when the model call fails", async () => {
  const lines = ["09:15 you: hello", "09:15 iris: hey", "09:16 you: draft the pricing email for Acme"];
  const digest = await buildDigest(lines, {
    generate: async () => {
      throw new Error("model unavailable");
    },
  });
  assert.match(digest, /pricing email for Acme/);
  assert.doesNotMatch(digest, /hello/);
});

test("digest generation prefers the model's summary and bounds its length", async () => {
  const lines = ["09:15 you: what about the invoice", "09:15 iris: sent"];
  const digest = await buildDigest(lines, { generate: async () => "  Discussed the invoice\nand sent it.  " });
  assert.equal(digest, "Discussed the invoice and sent it.");

  const long = await buildDigest(lines, {
    generate: async () => "x".repeat(900),
    maxChars: 100,
  });
  assert.equal(long.length, 100);
  assert.match(long, /…$/);
});

test("an empty conversation produces no digest", async () => {
  assert.equal(await buildDigest([], { generate: async () => "should not be called" }), "");
  assert.equal(heuristicDigest(["09:15 iris: hey there"]), "");
});
