import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  HermesClient,
  HermesHttpError,
  stableHermesMemoryKey,
} from "../electron/hermesClient.mjs";

async function withServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("capability verification is authenticated and carries stable memory scope", async (t) => {
  const baseUrl = await withServer(t, (request, response) => {
    assert.equal(request.headers.authorization, "Bearer secret-key");
    assert.equal(request.headers["x-hermes-session-key"], "iris:desktop:ashutosh");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ version: "9.1", endpoints: { runs: true } }));
  });
  const client = new HermesClient({
    baseUrl,
    apiKey: "secret-key",
    sessionKey: stableHermesMemoryKey("Ashutosh"),
  });
  const result = await client.verify();
  assert.equal(result.ok, true);
  assert.equal(result.version, "9.1");
});

test("authentication failures are distinguishable and are not retried", async (t) => {
  let requests = 0;
  const baseUrl = await withServer(t, (_request, response) => {
    requests += 1;
    response.statusCode = 401;
    response.end(JSON.stringify({ error: { message: "bad key", code: "unauthorized" } }));
  });
  const client = new HermesClient({ baseUrl, apiKey: "wrong" });
  await assert.rejects(
    () => client.verify(),
    (error) =>
      error instanceof HermesHttpError &&
      error.authenticationFailure &&
      error.code === "unauthorized",
  );
  assert.equal(requests, 1);
});

test("safe GET requests retry transient server failures", async (t) => {
  let requests = 0;
  const baseUrl = await withServer(t, (_request, response) => {
    requests += 1;
    if (requests < 2) {
      response.statusCode = 503;
      response.end("starting");
      return;
    }
    response.end(JSON.stringify({ status: "completed" }));
  });
  const client = new HermesClient({ baseUrl, apiKey: "secret" });
  const result = await client.request("GET", "/v1/runs/run-1", undefined, { retries: 2 });
  assert.equal(result.status, "completed");
  assert.equal(requests, 2);
});

test("requests have a hard timeout", async (t) => {
  const baseUrl = await withServer(t, () => {
    // Intentionally never respond; the client must abort.
  });
  const client = new HermesClient({ baseUrl, apiKey: "secret", defaultTimeoutMs: 25 });
  await assert.rejects(
    () => client.request("GET", "/hang", undefined, { retries: 0 }),
    (error) => error instanceof HermesHttpError && /timed out|aborted/i.test(error.message),
  );
});
