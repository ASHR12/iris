import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  shouldAskJarvis,
  defaultJarvisBridgePath,
  loadJarvisBridge,
  askJarvisForTurn,
  describeSmokeTranscript,
  getTasksForRenderer,
  getTopFocusForRenderer,
  getCurrentContextForRenderer,
  getConnectionsStatusForRenderer,
} from "../electron/jarvisBridgeClient.mjs";

function withEnv(key, value, fn) {
  const original = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

test("shouldAskJarvis: only the existing 'memory' route reaches Jarvis (reuses routingPolicy classification, no new rule)", () => {
  assert.equal(shouldAskJarvis("memory"), true);
  assert.equal(shouldAskJarvis("direct"), false);
  assert.equal(shouldAskJarvis("ui"), false);
  assert.equal(shouldAskJarvis("web"), false);
  assert.equal(shouldAskJarvis("hermes"), false);
  assert.equal(shouldAskJarvis(undefined), false);
});

test("defaultJarvisBridgePath: honors a JARVIS_BRIDGE_PATH override", () => {
  withEnv("JARVIS_BRIDGE_PATH", "/tmp/custom-bridge.cjs", () => {
    assert.equal(defaultJarvisBridgePath("/whatever/repo"), "/tmp/custom-bridge.cjs");
  });
});

test("defaultJarvisBridgePath: defaults to the sibling Jarvis-Desktop adapter path", () => {
  withEnv("JARVIS_BRIDGE_PATH", undefined, () => {
    const resolved = defaultJarvisBridgePath("/Users/x/Development/iris-test");
    assert.equal(
      resolved,
      path.resolve("/Users/x/Development/Jarvis-Desktop/app/adapter/iris-bridge.cjs"),
    );
  });
});

test("loadJarvisBridge: never throws and returns null when the bridge file does not exist", () => {
  const bridge = loadJarvisBridge("/does/not/exist", {
    existsFn: () => false,
    requireFn: () => { throw new Error("must not be called when the file is missing"); },
  });
  assert.equal(bridge, null);
});

test("loadJarvisBridge: requires the resolved path and returns createIrisBridge()'s instance", () => {
  let seenPath = null;
  const fakeInstance = { askJarvis: async () => ({}) };
  const bridge = loadJarvisBridge("/whatever/repo", {
    existsFn: () => true,
    requireFn: (resolvedPath) => {
      seenPath = resolvedPath;
      return { createIrisBridge: () => fakeInstance };
    },
  });
  assert.equal(seenPath, path.resolve("/whatever/repo", "..", "Jarvis-Desktop", "app", "adapter", "iris-bridge.cjs"));
  assert.equal(bridge, fakeInstance);
});

test("loadJarvisBridge: never throws, returns null if require() itself throws", () => {
  const bridge = loadJarvisBridge("/whatever/repo", {
    existsFn: () => true,
    requireFn: () => { throw new Error("module not found"); },
  });
  assert.equal(bridge, null);
});

// Gap 2 ROT: loadJarvisBridge() currently swallows a require() failure
// silently — no diagnostics, no reason code. The approved fix adds a 3rd
// optional `onUnavailable(reasonCode)` option, called with exactly
// "require-error" here (never the resolved path, the raw Error, its
// message, or a stack trace — those can leak local absolute paths).
test("loadJarvisBridge: calls onUnavailable('require-error') when require() throws, without leaking the path/error", () => {
  const seen = [];
  const bridge = loadJarvisBridge("/fake/repo", {
    existsFn: () => true,
    requireFn: () => {
      throw new Error("/Users/cd/Development/Jarvis-Desktop/app/adapter/iris-bridge.cjs: boom");
    },
    onUnavailable: (reason) => seen.push(reason),
  });
  assert.equal(bridge, null);
  assert.deepEqual(seen, ["require-error"]);
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
