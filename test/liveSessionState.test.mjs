import test from "node:test";
import assert from "node:assert/strict";
import {
  AnnouncementLedger,
  ResumeHandleStore,
} from "../electron/liveSessionState.mjs";

test("resume handles expire deterministically", () => {
  const store = new ResumeHandleStore({ ttlMs: 100 });
  store.update("handle-a", 1000);
  assert.equal(store.fresh(1099), "handle-a");
  assert.equal(store.fresh(1100), null);
  store.clear();
  assert.equal(store.fresh(1001), null);
});

test("announcement delivery requeues interrupted turns", () => {
  const ledger = new AnnouncementLedger({ maxPending: 3 });
  ledger.enqueue("one");
  ledger.enqueue("two");
  const sent = [];
  ledger.drain((text) => sent.push(text));
  assert.deepEqual(sent, ["one", "two"]);
  assert.equal(ledger.pendingCount, 0);
  assert.equal(ledger.requeueInFlight(), 2);
  assert.equal(ledger.pendingCount, 2);
  ledger.drain(() => undefined);
  assert.deepEqual(ledger.completeTurn(), ["one", "two"]);
});
