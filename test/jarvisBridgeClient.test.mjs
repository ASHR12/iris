import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldAskJarvis,
  createJarvisBridge,
  JARVIS_READ_ROUTES,
  ASK_TIMEOUT_MS,
  askJarvisForTurn,
  describeSmokeTranscript,
  getTasksForRenderer,
  getTopFocusForRenderer,
  getCurrentContextForRenderer,
  getConnectionsStatusForRenderer,
} from "../electron/jarvisBridgeClient.mjs";

test("shouldAskJarvis: only the existing 'memory' route reaches Jarvis (reuses routingPolicy classification, no new rule)", () => {
  assert.equal(shouldAskJarvis("memory"), true);
  assert.equal(shouldAskJarvis("direct"), false);
  assert.equal(shouldAskJarvis("ui"), false);
  assert.equal(shouldAskJarvis("web"), false);
  assert.equal(shouldAskJarvis("hermes"), false);
  assert.equal(shouldAskJarvis(undefined), false);
});

/* ------------------------------------------------------------------ *
 * P2.6 — createJarvisBridge()
 *
 * REPLACES loadJarvisBridge(), which require()d Jarvis's adapter out of a
 * sibling SOURCE CHECKOUT and ran it in the Iris process. A packaged
 * Iris.app has no such checkout, so every read failed there. Reads now go
 * to the one running Jarvis backend over the same loopback endpoint the
 * write actions already use.
 *
 * These tests inject `request`, so they assert the ROUTE and the PAYLOAD
 * that actually go on the wire — not a stub method name.
 * ------------------------------------------------------------------ */

function recordingBridge(reply = { ok: true, data: {} }) {
  const sent = [];
  const bridge = createJarvisBridge({
    request: async (route, payload, options) => {
      sent.push({ route, payload, options });
      return typeof reply === "function" ? reply(route) : reply;
    },
  });
  return { bridge, sent };
}

test("createJarvisBridge: needs no repo root, no filesystem and no Jarvis source file to be constructed", () => {
  const bridge = createJarvisBridge({ readEndpoint: () => null });
  assert.equal(typeof bridge.askJarvis, "function");
  assert.equal(typeof bridge.getConnectionsStatus, "function");
});

test("createJarvisBridge: askJarvis posts the question to /read/ask with a model-sized timeout", async () => {
  const { bridge, sent } = recordingBridge({ ok: true, answer: "Heute: 2 Termine." });
  const result = await bridge.askJarvis("was steht heute an");
  assert.deepEqual(result, { ok: true, answer: "Heute: 2 Termine." });
  assert.equal(sent[0].route, JARVIS_READ_ROUTES.ask);
  assert.deepEqual(sent[0].payload, { question: "was steht heute an" });
  assert.equal(sent[0].options.timeoutMs, ASK_TIMEOUT_MS);
  assert.ok(ASK_TIMEOUT_MS >= 60_000, "a real retrieval + model call must not be cut off by an approval-sized timeout");
});

test("createJarvisBridge: every read method hits its own documented route", async () => {
  const expected = [
    ["getConnectionsStatus", JARVIS_READ_ROUTES.connectionsStatus],
    ["getTasks", JARVIS_READ_ROUTES.tasks],
    ["getTopFocus", JARVIS_READ_ROUTES.topFocus],
    ["getCurrentContext", JARVIS_READ_ROUTES.currentContext],
    ["getLatestEngineeringJob", JARVIS_READ_ROUTES.latestEngineeringJob],
    ["getActiveGoal", JARVIS_READ_ROUTES.activeGoal],
  ];
  for (const [method, route] of expected) {
    const { bridge, sent } = recordingBridge({ ok: true, data: { marker: method } });
    // eslint-disable-next-line no-await-in-loop
    const result = await bridge[method]();
    assert.equal(sent[0].route, route, `${method} must call ${route}`);
    assert.deepEqual(result, { ok: true, data: { marker: method } });
  }
});

test("createJarvisBridge: a backend error is forwarded untouched, never turned into empty data", async () => {
  const { bridge } = recordingBridge({ ok: false, error: "Jarvis-Backend läuft nicht — keine Verbindung möglich." });
  const result = await bridge.getConnectionsStatus();
  assert.equal(result.ok, false);
  assert.match(result.error, /Jarvis-Backend/);
});

// The whole point of the *ForRenderer contract still holding after the
// transport swap: the bridge object is duck-typed, so a remote bridge and
// the old in-process one are indistinguishable to everything downstream.
test("createJarvisBridge: the remote bridge satisfies the existing *ForRenderer contract unchanged", async () => {
  const { bridge } = recordingBridge((route) =>
    (route === JARVIS_READ_ROUTES.tasks
      ? { ok: true, data: { now: [{ title: "A" }], next: [], waiting: [], overdue: [] } }
      : { ok: true, data: {} }));
  const result = await getTasksForRenderer(bridge);
  assert.deepEqual(result, { ok: true, data: { now: [{ title: "A" }], next: [], waiting: [], overdue: [] } });
});

test("askJarvisForTurn: returns ok+answer when the bridge resolves a real answer (mocked final transcript -> bridge -> answer)", async () => {
  const bridge = {
    askJarvis: async (text) => {
      assert.equal(text, "was steht heute an");
      return { ok: true, answer: "Heute: 2 Termine, 1 überfällige Aufgabe." };
    },
  };
  const result = await askJarvisForTurn(bridge, "was steht heute an");
  assert.deepEqual(result, { ok: true, answer: "Heute: 2 Termine, 1 überfällige Aufgabe." });
});

test("askJarvisForTurn: returns ok:false without crashing when no bridge is connected", async () => {
  const result = await askJarvisForTurn(null, "was steht heute an");
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("askJarvisForTurn: surfaces {ok:false, error} from the bridge as-is", async () => {
  const bridge = { askJarvis: async () => ({ ok: false, error: "ASK_FAILED" }) };
  const result = await askJarvisForTurn(bridge, "x");
  assert.equal(result.ok, false);
  assert.equal(result.error, "ASK_FAILED");
});

test("askJarvisForTurn: catches a thrown error from the bridge and returns ok:false", async () => {
  const bridge = { askJarvis: async () => { throw new Error("boom"); } };
  const result = await askJarvisForTurn(bridge, "x");
  assert.equal(result.ok, false);
  assert.match(result.error, /boom/);
});

test("askJarvisForTurn: treats a missing/empty answer as a failure, never a silent empty Comms bubble", async () => {
  const bridge = { askJarvis: async () => ({ ok: true, answer: "" }) };
  const result = await askJarvisForTurn(bridge, "x");
  assert.equal(result.ok, false);
});

test("askJarvisForTurn: never leaks internal askJarvis() fields (sources/timings/mail/...) across the IPC contract", async () => {
  const bridge = {
    askJarvis: async () => ({
      ok: true,
      answer: "Ich bin Jarvis.",
      intent: "SMALL_TALK",
      sources: [{ type: "obsidian", id: "x" }],
      mail: { kind: "results", resultCount: 3 },
      drive: { kind: "results", resultCount: 1 },
      timings: { totalMs: 42 },
      model: "anthropic/claude-sonnet-5",
    }),
  };
  const result = await askJarvisForTurn(bridge, "wie heißt du");
  assert.deepEqual(Object.keys(result).sort(), ["answer", "ok"]);
});

test("describeSmokeTranscript: success -> [you, jarvis] pair with the real answer, visible in the existing Comms transcript shape", () => {
  const lines = describeSmokeTranscript("Wie heißt du?", { ok: true, answer: "Ich bin Jarvis." });
  assert.deepEqual(lines, [
    { speaker: "you", text: "Wie heißt du?" },
    { speaker: "jarvis", text: "Ich bin Jarvis." },
  ]);
});

test("describeSmokeTranscript: failure -> [you, jarvis-error] pair, error text never silently dropped", () => {
  const lines = describeSmokeTranscript("Wie heißt du?", { ok: false, error: "Jarvis Bridge nicht verfügbar." });
  assert.deepEqual(lines, [
    { speaker: "you", text: "Wie heißt du?" },
    { speaker: "jarvis-error", text: "Jarvis-Anfrage fehlgeschlagen: Jarvis Bridge nicht verfügbar." },
  ]);
});

// Work Stream / left panel live data — real getTasks()/getTopFocus()/
// getCurrentContext(), never demo data or an invented fallback shape.

test("getTasksForRenderer: forwards the bridge's real {ok, data} result as-is", async () => {
  const bridge = {
    getTasks: () => ({
      ok: true,
      data: { now: [{ title: "A" }], next: [], waiting: [], overdue: [] },
    }),
  };
  const result = await getTasksForRenderer(bridge);
  assert.deepEqual(result, {
    ok: true,
    data: { now: [{ title: "A" }], next: [], waiting: [], overdue: [] },
  });
});

test("getTasksForRenderer: returns ok:false without crashing when no bridge is connected", async () => {
  const result = await getTasksForRenderer(null);
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("getTasksForRenderer: catches a thrown error from the bridge and returns ok:false", async () => {
  const bridge = { getTasks: () => { throw new Error("boom"); } };
  const result = await getTasksForRenderer(bridge);
  assert.equal(result.ok, false);
  assert.match(result.error, /boom/);
});

test("getTopFocusForRenderer: forwards the bridge's real async {ok, data} result as-is", async () => {
  const bridge = { getTopFocus: async () => ({ ok: true, data: { top: [{ title: "Ship X" }] } }) };
  const result = await getTopFocusForRenderer(bridge);
  assert.deepEqual(result, { ok: true, data: { top: [{ title: "Ship X" }] } });
});

test("getTopFocusForRenderer: surfaces {ok:false, error} from the bridge as-is (e.g. reader not configured)", async () => {
  const bridge = { getTopFocus: async () => ({ ok: false, error: "Top Focus nicht verfügbar." }) };
  const result = await getTopFocusForRenderer(bridge);
  assert.deepEqual(result, { ok: false, error: "Top Focus nicht verfügbar." });
});

test("getTopFocusForRenderer: returns ok:false without crashing when no bridge is connected", async () => {
  const result = await getTopFocusForRenderer(null);
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("getTopFocusForRenderer: catches a thrown error from the bridge and returns ok:false", async () => {
  const bridge = { getTopFocus: async () => { throw new Error("boom"); } };
  const result = await getTopFocusForRenderer(bridge);
  assert.equal(result.ok, false);
  assert.match(result.error, /boom/);
});

test("getCurrentContextForRenderer: forwards the bridge's real async {ok, data} result as-is", async () => {
  const bridge = {
    getCurrentContext: async () => ({ ok: true, data: { today: "2026-08-20", recommended: { title: "Follow up" } } }),
  };
  const result = await getCurrentContextForRenderer(bridge);
  assert.deepEqual(result, { ok: true, data: { today: "2026-08-20", recommended: { title: "Follow up" } } });
});

test("getCurrentContextForRenderer: returns ok:false without crashing when no bridge is connected", async () => {
  const result = await getCurrentContextForRenderer(null);
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("getCurrentContextForRenderer: catches a thrown error from the bridge and returns ok:false", async () => {
  const bridge = { getCurrentContext: async () => { throw new Error("boom"); } };
  const result = await getCurrentContextForRenderer(bridge);
  assert.equal(result.ok, false);
  assert.match(result.error, /boom/);
});

// Connections Status (P2.4) — same never-throws, forward-as-is contract as
// the other *ForRenderer functions above.

test("getConnectionsStatusForRenderer: forwards the bridge's real {ok, data} result as-is", async () => {
  const connections = [{ id: "personalOS", label: "Personal OS", status: "connected", detail: "" }];
  const bridge = { getConnectionsStatus: async () => ({ ok: true, data: { connections, checkedAt: "2026-08-22T00:00:00.000Z" } }) };
  const result = await getConnectionsStatusForRenderer(bridge);
  assert.deepEqual(result, { ok: true, data: { connections, checkedAt: "2026-08-22T00:00:00.000Z" } });
});

test("getConnectionsStatusForRenderer: returns ok:false without crashing when no bridge is connected", async () => {
  const result = await getConnectionsStatusForRenderer(null);
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("getConnectionsStatusForRenderer: catches a thrown error from the bridge and returns ok:false", async () => {
  const bridge = { getConnectionsStatus: async () => { throw new Error("boom"); } };
  const result = await getConnectionsStatusForRenderer(bridge);
  assert.equal(result.ok, false);
  assert.match(result.error, /boom/);
});
