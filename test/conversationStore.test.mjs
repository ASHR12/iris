import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConversationStore, UNATTRIBUTED } from "../electron/conversationStore.mjs";
import { ConversationJournal } from "../electron/conversationJournal.mjs";

function tempStore(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ConversationStore({ file: path.join(dir, "conversations.db"), ...options });
}

// A journal wired to its mirror, which is how the two run in the app.
function tempPair(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-pair-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ConversationStore({ file: path.join(dir, "conversations.db") });
  const journal = new ConversationJournal({
    dir: path.join(dir, "journal"),
    flushMs: 60_000,
    mirror: {
      sessionStarted: (session) => store.beginSession(session),
      turnsFlushed: (session, turns) => store.addTurns(session.id, session.thread, turns),
      sessionEnded: (session) => store.endSession(session),
    },
    ...options,
  });
  return { journal, store };
}

test("turns come back for the thread they were spoken in", (t) => {
  const store = tempStore(t);
  store.beginSession({ id: "s1", thread: "hermes-a", day: "2026-07-30", startedAt: 1000 });
  store.beginSession({ id: "s2", thread: "hermes-b", day: "2026-07-30", startedAt: 2000 });
  store.addTurns("s1", "hermes-a", [
    { at: 1001, speaker: "you", text: "about the pricing deck" },
    { at: 1002, speaker: "iris", text: "Opening it." },
  ]);
  store.addTurns("s2", "hermes-b", [{ at: 2001, speaker: "you", text: "unrelated project" }]);

  const a = store.recentTurns({ thread: "hermes-a" });
  assert.deepEqual(
    a.map((row) => row.text),
    ["about the pricing deck", "Opening it."],
  );
  assert.equal(store.recentTurns({ thread: "hermes-b" }).length, 1);
  assert.equal(store.countTurns({ thread: "hermes-a" }), 2);
});

test("a thread pages backwards without repeating or skipping a turn", (t) => {
  const store = tempStore(t);
  store.beginSession({ id: "s1", thread: "t", day: "2026-07-30", startedAt: 0 });
  store.addTurns(
    "s1",
    "t",
    Array.from({ length: 25 }, (_, index) => ({
      at: index,
      speaker: index % 2 ? "iris" : "you",
      text: `turn ${index}`,
    })),
  );

  const cursor = (page) => ({ beforeAt: page[0].at, beforeId: page[0].id });
  const newest = store.recentTurns({ thread: "t", limit: 10 });
  assert.deepEqual(newest.at(-1).text, "turn 24");
  const older = store.turnsBefore({ thread: "t", ...cursor(newest), limit: 10 });
  assert.deepEqual(older.at(-1).text, "turn 14");
  const oldest = store.turnsBefore({ thread: "t", ...cursor(older), limit: 10 });
  assert.deepEqual(oldest.map((row) => row.text), Array.from({ length: 5 }, (_, i) => `turn ${i}`));

  const seen = [...oldest, ...older, ...newest].map((row) => row.text);
  assert.equal(new Set(seen).size, 25);
});

// A backfill inserts whole days at once, so row ids stop following the clock.
// Paging on ids alone silently walked sideways into the wrong day.
test("paging follows the clock even when row ids do not", (t) => {
  const store = tempStore(t);
  const day = 24 * 60 * 60 * 1000;
  store.beginSession({ id: "s", thread: "t", day: "2026-07-30", startedAt: 0 });
  // Today written first (low ids), yesterday imported afterwards (high ids).
  store.addTurns("s", "t", [
    { at: 2 * day, speaker: "you", text: "today first" },
    { at: 2 * day + 1, speaker: "iris", text: "today second" },
  ]);
  store.addTurns("s", "t", [
    { at: day, speaker: "you", text: "yesterday first" },
    { at: day + 1, speaker: "iris", text: "yesterday second" },
  ]);

  const newest = store.recentTurns({ thread: "t", limit: 2 });
  assert.deepEqual(newest.map((row) => row.text), ["today first", "today second"]);
  const older = store.turnsBefore({
    thread: "t",
    beforeAt: newest[0].at,
    beforeId: newest[0].id,
    limit: 2,
  });
  assert.deepEqual(older.map((row) => row.text), ["yesterday first", "yesterday second"]);
});

test("turns sharing a timestamp page without repeating", (t) => {
  const store = tempStore(t);
  store.beginSession({ id: "s", thread: "t", day: "2026-07-30", startedAt: 0 });
  // Imported turns are only accurate to the minute, so ties are the norm.
  store.addTurns(
    "s",
    "t",
    Array.from({ length: 6 }, (_, index) => ({ at: 1000, speaker: "you", text: `same ${index}` })),
  );

  const newest = store.recentTurns({ thread: "t", limit: 3 });
  const older = store.turnsBefore({
    thread: "t",
    beforeAt: newest[0].at,
    beforeId: newest[0].id,
    limit: 3,
  });
  assert.deepEqual(older.map((row) => row.text), ["same 0", "same 1", "same 2"]);
  assert.equal(new Set([...older, ...newest].map((row) => row.id)).size, 6);
});

test("digests are scoped by thread and day, and searchable", (t) => {
  const store = tempStore(t);
  store.beginSession({ id: "s1", thread: "t", day: "2026-07-29", startedAt: 1 });
  store.endSession({ id: "s1", endedAt: 2, digest: "Reviewed the Vercel bill." });
  store.beginSession({ id: "s2", thread: "t", day: "2026-07-30", startedAt: 3 });
  store.endSession({ id: "s2", endedAt: 4, digest: "Dispatched the pricing deck to Hermes." });
  store.beginSession({ id: "s3", thread: "other", day: "2026-07-30", startedAt: 5 });
  store.endSession({ id: "s3", endedAt: 6, digest: "A different project entirely." });

  assert.equal(store.digests({ thread: "t", day: "2026-07-30" }).length, 1);
  assert.equal(store.digests({ thread: "t" }).length, 2);
  assert.match(store.search("vercel bill")[0].digest, /Vercel/);
  assert.equal(store.search("nothing like this here").length, 0);
});

test("a journal flush mirrors into the store under the same session", (t) => {
  const { journal, store } = tempPair(t);
  journal.beginSession("sess-1", { thread: "hermes-x" });
  journal.addTurn("you", "remind me about the deck");
  journal.addTurn("iris", "Noted.");
  journal.flush();

  const turns = store.recentTurns({ thread: "hermes-x" });
  assert.deepEqual(turns.map((row) => row.speaker), ["you", "iris"]);

  journal.endSession("You asked about the deck.");
  assert.match(store.digests({ thread: "hermes-x" })[0].digest, /deck/);
});

test("a disabled journal writes to neither the file nor the store", (t) => {
  const { journal, store } = tempPair(t, { enabled: false });
  journal.beginSession("sess-1", { thread: "hermes-x" });
  journal.addTurn("you", "this should not be recorded");
  journal.flush();
  assert.equal(store.recentTurns({ thread: "hermes-x" }).length, 0);
});

test("importing a journal is idempotent and lands unattributed", (t) => {
  const { journal } = tempPair(t);
  journal.beginSession("sess-1", { thread: "hermes-x" });
  journal.addTurn("you", "the first thing");
  journal.addTurn("iris", "Understood.");
  journal.endSession("Talked about the first thing.");

  const store = tempStore(t);
  const first = store.importFromJournal(journal);
  assert.equal(first.sessions, 1);
  assert.equal(first.turns, 2);

  const second = store.importFromJournal(journal);
  assert.equal(second.sessions, 0, "re-importing must not duplicate");
  assert.equal(store.countTurns({ thread: UNATTRIBUTED }), 2);
  assert.match(store.digests({ thread: UNATTRIBUTED })[0].digest, /first thing/);
});

test("pruning drops old turns but keeps the digests that remember them", (t) => {
  const store = tempStore(t);
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  store.beginSession({ id: "old", thread: "t", day: "2026-01-01", startedAt: now - 60 * day });
  store.endSession({ id: "old", digest: "An old conversation." });
  store.addTurns("old", "t", [{ at: now - 60 * day, speaker: "you", text: "ancient" }]);
  store.beginSession({ id: "new", thread: "t", day: "2026-07-30", startedAt: now });
  store.addTurns("new", "t", [{ at: now, speaker: "you", text: "recent" }]);

  const dropped = store.prune({ rawBefore: now - 30 * day, digestBefore: now - 90 * day });
  assert.equal(dropped.turns, 1);
  assert.deepEqual(store.recentTurns({ thread: "t" }).map((row) => row.text), ["recent"]);
  assert.equal(store.digests({ thread: "t" }).length, 1, "the old digest survives its turns");
});

test("a store that cannot open degrades to empty instead of throwing", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-store-bad-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A directory where the database file should be: open must fail.
  const file = path.join(dir, "conversations.db");
  fs.mkdirSync(file);

  const store = new ConversationStore({ file });
  assert.equal(store.beginSession({ id: "s", thread: "t", day: "d", startedAt: 0 }), false);
  assert.deepEqual(store.recentTurns({ thread: "t" }), []);
  assert.equal(store.countTurns({ thread: "t" }), 0);
});
