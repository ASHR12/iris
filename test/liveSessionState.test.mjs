import test from "node:test";
import assert from "node:assert/strict";
import {
  AnnouncementLedger,
  LiveTurnState,
  ResumeHandleStore,
  autoSleepDecision,
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

test("auto-sleep never closes an active server-side search", () => {
  const base = {
    idleMs: 30000,
    lastActivityAt: 1000,
    responseStartedAt: 1000,
  };
  assert.equal(
    autoSleepDecision({
      ...base,
      now: 32000,
      responseInFlight: true,
    }).responseProtected,
    true,
  );
  const timedOut = autoSleepDecision({
    ...base,
    now: 121001,
    responseInFlight: true,
  });
  assert.equal(timedOut.responseTimedOut, true);
  assert.equal(timedOut.sleep, true);
});

test("normal idle and pending-confirmation budgets remain bounded", () => {
  const base = { idleMs: 30000, lastActivityAt: 1000, now: 32000 };
  assert.equal(autoSleepDecision(base).sleep, true);
  assert.equal(autoSleepDecision({ ...base, pendingProposal: true }).sleep, false);
  assert.equal(
    autoSleepDecision({ ...base, pendingProposal: true, now: 91001 }).sleep,
    true,
  );
});

test("an interrupted greeting cannot complete a newer user question", () => {
  let now = 1000;
  const state = new LiveTurnState({ now: () => now });
  state.beginInput("welcome");
  state.modelActivity();
  now = 2000;
  state.beginInput("audio");
  state.interrupted();
  const oldTurn = state.turnComplete();
  assert.equal(oldTurn.busy, true);
  assert.equal(oldTurn.pendingEpoch, 2);
  state.modelActivity();
  state.generationComplete();
  assert.equal(state.turnComplete().busy, false);
});

test("tool cancellation prevents stale calls from remaining active", () => {
  const state = new LiveTurnState();
  state.beginInput("audio");
  state.toolCalls([{ id: "call-a" }, { id: "call-b" }]);
  state.cancelTools(["call-a"]);
  assert.equal(state.isToolCancelled("call-a"), true);
  assert.deepEqual(state.snapshot().pendingToolIds, ["call-b"]);
  state.toolResponse(["call-b"]);
  state.modelActivity();
  state.generationComplete();
  assert.equal(state.turnComplete().busy, false);
});

test("a dispatched Hermes run does not keep the Live turn busy", () => {
  const state = new LiveTurnState();
  state.beginInput("audio");
  state.toolCalls([{ id: "submit", name: "submit_hermes_task" }]);
  state.toolResponse(["submit"]);
  state.modelActivity();
  state.generationComplete();
  assert.equal(state.turnComplete().busy, false);
  assert.equal(
    autoSleepDecision({
      idleMs: 30000,
      lastActivityAt: 1000,
      now: 31001,
      responseInFlight: state.busy,
      responseStartedAt: state.startedAt,
    }).sleep,
    true,
  );
});
