/*
 * jarvisEndpoint.test.mjs — P2.6, the packaged-runtime resolver.
 *
 * THE BUG THIS PINS. Both Jarvis clients used to reach Jarvis through a
 * SOURCE CHECKOUT: path.resolve(repoRoot, "..", "Jarvis-Desktop", "app", ...).
 * In a packaged Iris.app repoRoot is <Iris.app>/Contents/Resources/app.asar,
 * so that path resolves to <Iris.app>/Contents/Resources/Jarvis-Desktop —
 * which does not exist. Ask Jarvis, Connections Status and every approval
 * therefore failed in the packaged app while working perfectly in dev.
 *
 * The descriptor path below is a cross-process FILE CONTRACT (the same one
 * Jarvis's engineering-runtime-paths.cjs computes), not a code dependency:
 * it is derived from the OS Application Support dir, so it is identical
 * whether either side runs from source or from a bundle.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultActionEndpointPath,
  readJarvisEndpoint,
  createJarvisEndpointReader,
  createEndpointRequest,
} from "../electron/jarvisEndpoint.mjs";

const LOOPBACK = { url: "http://127.0.0.1:51234", token: "test-token-0123456789abcdef", pid: 4242, publishedAt: "2026-08-22T10:00:00.000Z" };

function withTempDir(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-endpoint-test-"));
  try {
    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("defaultActionEndpointPath: resolves without ANY reference to a Jarvis source checkout", () => {
  const resolved = defaultActionEndpointPath({});
  assert.ok(!resolved.includes("Jarvis-Desktop"), "the packaged app has no Jarvis-Desktop checkout to point at");
  assert.ok(!resolved.includes("app.asar"), "the descriptor must never be looked for inside Iris's own bundle");
  assert.equal(path.basename(resolved), "action-endpoint.json");
});

test("defaultActionEndpointPath: matches Jarvis's own engineering runtime dir contract on macOS", () => {
  const resolved = defaultActionEndpointPath({}, "darwin", "/Users/x");
  assert.equal(resolved, path.join("/Users/x", "Library", "Application Support", "Jarvis", "jarvis-engineering", "action-endpoint.json"));
});

test("defaultActionEndpointPath: honors JARVIS_ENGINEERING_DIR, the SAME override Jarvis honors", () => {
  const resolved = defaultActionEndpointPath({ JARVIS_ENGINEERING_DIR: "/tmp/throwaway-runtime" });
  assert.equal(resolved, path.join("/tmp/throwaway-runtime", "action-endpoint.json"));
});

test("defaultActionEndpointPath: honors an explicit JARVIS_ACTION_ENDPOINT descriptor path", () => {
  const resolved = defaultActionEndpointPath({ JARVIS_ACTION_ENDPOINT: "/tmp/other/endpoint.json", JARVIS_ENGINEERING_DIR: "/tmp/ignored" });
  assert.equal(resolved, "/tmp/other/endpoint.json");
});

test("readJarvisEndpoint: reads the descriptor Jarvis actually published", () => {
  withTempDir((dir) => {
    const storePath = path.join(dir, "action-endpoint.json");
    fs.writeFileSync(storePath, JSON.stringify(LOOPBACK), "utf8");
    assert.deepEqual(readJarvisEndpoint({ storePath }), LOOPBACK);
  });
});

test("readJarvisEndpoint: a missing descriptor means 'no Jarvis running' — null, never a throw and never a guess", () => {
  withTempDir((dir) => {
    assert.equal(readJarvisEndpoint({ storePath: path.join(dir, "nope.json") }), null);
  });
});

test("readJarvisEndpoint: malformed JSON degrades to null instead of crashing Iris's main process", () => {
  withTempDir((dir) => {
    const storePath = path.join(dir, "action-endpoint.json");
    fs.writeFileSync(storePath, "{not json", "utf8");
    assert.equal(readJarvisEndpoint({ storePath }), null);
  });
});

// Iris must not POST a bearer token wherever a file tells it to. Jarvis
// refuses to PUBLISH a non-loopback descriptor; Iris independently refuses
// to USE one. Both checks are load-bearing — neither trusts the other side.
test("readJarvisEndpoint: refuses a descriptor pointing off-machine, so the bearer token never leaves loopback", () => {
  withTempDir((dir) => {
    const storePath = path.join(dir, "action-endpoint.json");
    fs.writeFileSync(storePath, JSON.stringify({ ...LOOPBACK, url: "http://evil.example.com:80" }), "utf8");
    assert.equal(readJarvisEndpoint({ storePath }), null);
  });
});

test("readJarvisEndpoint: refuses a descriptor without a token", () => {
  withTempDir((dir) => {
    const storePath = path.join(dir, "action-endpoint.json");
    fs.writeFileSync(storePath, JSON.stringify({ url: LOOPBACK.url }), "utf8");
    assert.equal(readJarvisEndpoint({ storePath }), null);
  });
});

test("createJarvisEndpointReader: re-reads on EVERY call — a restarted Jarvis has a new port and a new token", () => {
  withTempDir((dir) => {
    const storePath = path.join(dir, "action-endpoint.json");
    const reader = createJarvisEndpointReader({ storePath });
    assert.equal(reader(), null);
    fs.writeFileSync(storePath, JSON.stringify(LOOPBACK), "utf8");
    assert.deepEqual(reader(), LOOPBACK);
    fs.writeFileSync(storePath, JSON.stringify({ ...LOOPBACK, url: "http://127.0.0.1:9999", token: "second-token-0123456789ab" }), "utf8");
    assert.equal(reader().token, "second-token-0123456789ab", "a cached descriptor would outlive the process that published it");
  });
});

test("createEndpointRequest: sends the bearer token, no Origin header, and returns Jarvis's body verbatim", async () => {
  const seen = [];
  const request = createEndpointRequest({
    readEndpoint: () => LOOPBACK,
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ ok: true, answer: "Heute: 2 Termine." }) };
    },
  });
  const result = await request("/read/ask", { question: "was steht heute an" });
  assert.deepEqual(result, { ok: true, answer: "Heute: 2 Termine." });
  assert.equal(seen[0].url, `${LOOPBACK.url}/read/ask`);
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers.authorization, `Bearer ${LOOPBACK.token}`);
  assert.ok(!("origin" in seen[0].init.headers), "Jarvis refuses any request carrying an Origin header");
  assert.deepEqual(JSON.parse(seen[0].init.body), { question: "was steht heute an" });
});

test("createEndpointRequest: no running Jarvis is an honest error, never a fabricated success", async () => {
  const request = createEndpointRequest({
    readEndpoint: () => null,
    fetchImpl: async () => { throw new Error("must not be called without an endpoint"); },
  });
  const result = await request("/read/ask", { question: "x" });
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("createEndpointRequest: an unreadable body is an error, not a silent empty result", async () => {
  const request = createEndpointRequest({
    readEndpoint: () => LOOPBACK,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } }),
  });
  const result = await request("/read/tasks", {});
  assert.equal(result.ok, false);
  assert.match(result.error, /200/);
});

test("createEndpointRequest: a rejected token (HTTP 401) surfaces as an error, never as approval", async () => {
  const request = createEndpointRequest({
    readEndpoint: () => LOOPBACK,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error: "unauthorized" }) }),
  });
  const result = await request("/action/approve", { previewId: "p1" });
  assert.equal(result.ok, false);
  assert.match(result.error, /unauthorized/);
});

test("createEndpointRequest: a wedged backend times out with a clear error instead of hanging forever", async () => {
  const request = createEndpointRequest({
    readEndpoint: () => LOOPBACK,
    timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }),
  });
  const result = await request("/read/ask", { question: "x" });
  assert.equal(result.ok, false);
  assert.match(result.error, /20 ms/);
});

test("createEndpointRequest: a per-call timeout overrides the default (Ask Jarvis runs a model, approvals do not)", async () => {
  let seenTimeout = null;
  const request = createEndpointRequest({
    readEndpoint: () => LOOPBACK,
    timeoutMs: 10,
    fetchImpl: async (_url, init) => {
      // A 10 ms default would already have aborted this signal by the time a
      // real model answered; a per-call override is what keeps it alive.
      seenTimeout = init.signal.aborted;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { ok: true, status: 200, json: async () => ({ ok: true, answer: "spät, aber da." }) };
    },
  });
  const result = await request("/read/ask", { question: "x" }, { timeoutMs: 30_000 });
  assert.equal(seenTimeout, false);
  assert.deepEqual(result, { ok: true, answer: "spät, aber da." });
});
