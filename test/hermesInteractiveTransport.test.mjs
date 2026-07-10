import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { HermesInteractiveTransport } from "../electron/hermesInteractiveTransport.mjs";

class FakeGatewayClient extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
  }

  async start() {}

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "session.resume") {
      return {
        session_id: "live-1",
        resumed: params.session_id,
        session_key: params.session_id,
      };
    }
    if (method === "session.create") {
      return { session_id: "live-new", stored_session_id: "stored-new" };
    }
    return { status: "ok" };
  }

  close() {}
}

test("full protocol pauses for clarification and resumes with the chosen answer", async () => {
  const client = new FakeGatewayClient();
  const transport = new HermesInteractiveTransport({ client });
  const interactions = [];
  const completed = [];
  transport.on("interaction", (event) => interactions.push(event));
  transport.on("complete", (event) => completed.push(event));

  const run = await transport.submit({
    task: "Compare deployment options",
    sessionId: "stored-1",
    instructions: "Use the full interaction channel.",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(client.calls.some((call) => call.method === "prompt.submit"));

  client.emit("event", {
    type: "clarify.request",
    session_id: "live-1",
    payload: {
      request_id: "clarify-1",
      question: "Which environment?",
      choices: ["Staging", "Production"],
    },
  });
  assert.equal(interactions[0].interaction.type, "clarify");
  assert.equal(transport.getRun(run.run_id).status, "waiting_for_input");

  await transport.respond(run.run_id, {
    interactionId: "clarify-1",
    type: "clarify",
    value: "Staging",
  });
  assert.deepEqual(
    client.calls.find((call) => call.method === "clarify.respond").params,
    { request_id: "clarify-1", answer: "Staging" },
  );

  client.emit("event", {
    type: "message.complete",
    session_id: "live-1",
    payload: { status: "complete", text: "Deployed to staging." },
  });
  assert.equal(completed[0].status, "completed");
  assert.equal(completed[0].output, "Deployed to staging.");
});

test("approval, sudo, and secret requests use their exact response methods", async () => {
  const client = new FakeGatewayClient();
  const transport = new HermesInteractiveTransport({ client });
  const run = await transport.submit({ task: "Interactive task", sessionId: "stored-1" });
  await new Promise((resolve) => setImmediate(resolve));

  client.emit("event", {
    type: "approval.request",
    session_id: "live-1",
    payload: { command: "send-email", description: "External action" },
  });
  let pending = transport.getRun(run.run_id).interaction;
  await transport.respond(run.run_id, {
    interactionId: pending.id,
    type: "approval",
    value: "once",
  });
  assert.equal(
    client.calls.find((call) => call.method === "approval.respond").params.choice,
    "once",
  );

  client.emit("event", {
    type: "sudo.request",
    session_id: "live-1",
    payload: { request_id: "sudo-1" },
  });
  pending = transport.getRun(run.run_id).interaction;
  await transport.respond(run.run_id, {
    interactionId: pending.id,
    type: "sudo",
    value: "password",
  });
  assert.equal(
    client.calls.find((call) => call.method === "sudo.respond").params.password,
    "password",
  );

  client.emit("event", {
    type: "secret.request",
    session_id: "live-1",
    payload: { request_id: "secret-1", env_var: "API_KEY", prompt: "Enter API key" },
  });
  pending = transport.getRun(run.run_id).interaction;
  await transport.respond(run.run_id, {
    interactionId: pending.id,
    type: "secret",
    value: "secret-value",
  });
  assert.equal(
    client.calls.find((call) => call.method === "secret.respond").params.value,
    "secret-value",
  );
});

test("tasks in one stored session queue without interrupting the active turn", async () => {
  const client = new FakeGatewayClient();
  const transport = new HermesInteractiveTransport({ client });
  const first = await transport.submit({ task: "First", sessionId: "stored-1" });
  const second = await transport.submit({ task: "Second", sessionId: "stored-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    client.calls.filter((call) => call.method === "prompt.submit").length,
    1,
  );
  assert.equal(transport.getRun(second.run_id).status, "queued");

  client.emit("event", {
    type: "message.complete",
    session_id: "live-1",
    payload: { status: "complete", text: "First done" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    client.calls.filter((call) => call.method === "prompt.submit").length,
    2,
  );
  assert.equal(transport.getRun(first.run_id).status, "completed");
});

test("new sessions defer to Hermes terminal.cwd unless Iris has an explicit override", async () => {
  const defaultClient = new FakeGatewayClient();
  const defaultTransport = new HermesInteractiveTransport({ client: defaultClient });
  await defaultTransport.createSession();
  const defaultCreate = defaultClient.calls.find((call) => call.method === "session.create");
  assert.equal("cwd" in defaultCreate.params, false);

  const explicitClient = new FakeGatewayClient();
  const explicitTransport = new HermesInteractiveTransport({
    client: explicitClient,
    defaultCwd: "/safe/workspace",
  });
  await explicitTransport.createSession();
  const explicitCreate = explicitClient.calls.find((call) => call.method === "session.create");
  assert.equal(explicitCreate.params.cwd, "/safe/workspace");
});
