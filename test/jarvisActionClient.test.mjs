/*
 * jarvisActionClient.test.mjs — the Iris-side half of Action Transport v2
 * (P2.5).
 *
 * The contract being pinned here is deliberately narrow: this client OWNS
 * NOTHING. It holds no previewId list, no approval stage, no credentials —
 * it resolves the running Jarvis backend's loopback endpoint, forwards the
 * call, and returns what Jarvis said. Every failure mode (no Jarvis, dead
 * port, rejected token, garbage response) must surface as an honest
 * {ok:false, error}; none of them may ever look like a successful approval.
 *
 * Tests run against a real loopback http server, not a mocked fetch, because
 * "did the bearer token actually go out on the wire" is the point.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createJarvisActionClient } from "../electron/jarvisActionClient.mjs";

const TOKEN = "test-token-0123456789abcdef";

// Records what actually arrived, so the assertions are about the wire, not
// about an argument we passed to a stub.
async function withEndpoint(handler, body) {
  const received = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const entry = {
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        origin: request.headers.origin,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      received.push(entry);
      handler(entry, response);
    });
  });
  await new Promise((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const { port } = server.address();
  const endpoint = { url: `http://127.0.0.1:${port}`, token: TOKEN, pid: 1, publishedAt: "2026-08-22T10:00:00.000Z" };
  try {
    return await body({ endpoint, received, port });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function respondJson(response, payload, status = 200) {
  const text = JSON.stringify(payload);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  response.end(text);
}

test("proposeAction posts the question to the running Jarvis backend and returns its answer verbatim", async () => {
  await withEndpoint(
    (_entry, response) => respondJson(response, { ok: true, kind: "preview", previews: [{ previewId: "p1", title: "Rechnung prüfen", riskLevel: "low" }] }),
    async ({ endpoint, received }) => {
      const client = createJarvisActionClient({ readEndpoint: () => endpoint });
      const result = await client.proposeAction("Notiere: Rechnung prüfen", { source: "text" });
      assert.deepEqual(result, { ok: true, kind: "preview", previews: [{ previewId: "p1", title: "Rechnung prüfen", riskLevel: "low" }] });
      assert.equal(received[0].method, "POST");
      assert.equal(received[0].url, "/action/propose");
      assert.equal(received[0].authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(JSON.parse(received[0].body), { question: "Notiere: Rechnung prüfen", source: "text" });
    },
  );
});

test("approve/secondaryApprove/cancel each hit their own route with the previewId and the bearer token", async () => {
  await withEndpoint(
    (_entry, response) => respondJson(response, { ok: true }),
    async ({ endpoint, received }) => {
      const client = createJarvisActionClient({ readEndpoint: () => endpoint });
      await client.approveAction("p1");
      await client.secondaryApproveAction("p2");
      await client.cancelAction("p3");
      assert.deepEqual(received.map((entry) => entry.url), ["/action/approve", "/action/secondary-approve", "/action/cancel"]);
      assert.deepEqual(received.map((entry) => JSON.parse(entry.body).previewId), ["p1", "p2", "p3"]);
      assert.ok(received.every((entry) => entry.authorization === `Bearer ${TOKEN}`));
    },
  );
});

// Jarvis's endpoint refuses any request carrying an Origin (see
// action-bridge-server.cjs). Iris must therefore never send one.
test("no browser Origin header is ever sent", async () => {
  await withEndpoint(
    (_entry, response) => respondJson(response, { ok: true }),
    async ({ endpoint, received }) => {
      await createJarvisActionClient({ readEndpoint: () => endpoint }).approveAction("p1");
      assert.equal(received[0].origin, undefined);
    },
  );
});

// Jarvis restarts on a NEW ephemeral port with a NEW token. A client that
// cached the first descriptor would keep talking to a dead port forever.
test("the endpoint descriptor is re-read for every call, so a restarted Jarvis is followed", async () => {
  await withEndpoint(
    (_entry, response) => respondJson(response, { ok: true }),
    async ({ endpoint, received }) => {
      let reads = 0;
      const client = createJarvisActionClient({
        readEndpoint: () => { reads += 1; return endpoint; },
      });
      await client.approveAction("p1");
      await client.approveAction("p2");
      assert.equal(reads, 2, "a cached descriptor would outlive the Jarvis process that published it");
      assert.equal(received.length, 2);
    },
  );
});

test("no published endpoint is an honest failure, never a fabricated approval", async () => {
  const client = createJarvisActionClient({
    readEndpoint: () => null,
    fetchImpl: () => { throw new Error("fetch must not be attempted without an endpoint"); },
  });
  for (const call of [
    () => client.proposeAction("Notiere: x"),
    () => client.approveAction("p1"),
    () => client.secondaryApproveAction("p1"),
    () => client.cancelAction("p1"),
  ]) {
    const result = await call();
    assert.equal(result.ok, false);
    assert.match(result.error, /Jarvis/i);
  }
});

test("a dead port surfaces as ok:false instead of throwing into the IPC handler", async () => {
  // The server is already closed again by the time the port is used.
  const { port } = await withEndpoint(
    (_entry, response) => respondJson(response, { ok: true }),
    async (context) => context,
  );
  const client = createJarvisActionClient({
    readEndpoint: () => ({ url: `http://127.0.0.1:${port}`, token: TOKEN }),
  });
  const result = await client.approveAction("p1");
  assert.equal(result.ok, false);
  assert.ok(result.error, "a refused connection must carry a reason");
});

test("a rejected token surfaces as ok:false and never as a silent success", async () => {
  await withEndpoint(
    (_entry, response) => respondJson(response, { ok: false, error: "unauthorized" }, 401),
    async ({ endpoint }) => {
      const result = await createJarvisActionClient({ readEndpoint: () => endpoint }).approveAction("p1");
      assert.equal(result.ok, false);
      assert.match(result.error, /401|unauthorized/i);
    },
  );
});

test("a non-JSON response surfaces as ok:false rather than crashing the caller", async () => {
  await withEndpoint(
    (_entry, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end("<html>nope</html>"); },
    async ({ endpoint }) => {
      const result = await createJarvisActionClient({ readEndpoint: () => endpoint }).approveAction("p1");
      assert.equal(result.ok, false);
      assert.ok(result.error);
    },
  );
});

// An empty question is a UI-level mistake, not something to bother the
// backend (or the vault) with.
test("an empty question is refused locally without contacting Jarvis", async () => {
  await withEndpoint(
    (_entry, response) => respondJson(response, { ok: true }),
    async ({ endpoint, received }) => {
      const result = await createJarvisActionClient({ readEndpoint: () => endpoint }).proposeAction("   ");
      assert.equal(result.ok, false);
      assert.deepEqual(received, []);
    },
  );
});

test("a missing previewId is refused locally without contacting Jarvis", async () => {
  await withEndpoint(
    (_entry, response) => respondJson(response, { ok: true }),
    async ({ endpoint, received }) => {
      const client = createJarvisActionClient({ readEndpoint: () => endpoint });
      assert.equal((await client.approveAction("")).ok, false);
      assert.equal((await client.secondaryApproveAction(null)).ok, false);
      assert.equal((await client.cancelAction(undefined)).ok, false);
      assert.deepEqual(received, []);
    },
  );
});

// A Jarvis that accepted the request but never answers must not wedge the
// Iris renderer's approval button forever.
test("a hanging backend is abandoned after the timeout with an honest error", async () => {
  await withEndpoint(
    () => { /* never responds */ },
    async ({ endpoint }) => {
      const client = createJarvisActionClient({ readEndpoint: () => endpoint, timeoutMs: 150 });
      const result = await client.approveAction("p1");
      assert.equal(result.ok, false);
      assert.ok(result.error);
    },
  );
});
