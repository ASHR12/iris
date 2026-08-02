import test from "node:test";
import assert from "node:assert/strict";
import { LiveToolCoordinator } from "../electron/liveToolCoordinator.mjs";

test("serializes overlapping tool batches and normalizes every response", async () => {
  const coordinator = new LiveToolCoordinator();
  const order = [];
  const sent = [];
  const execute = async (name) => {
    order.push(`start:${name}`);
    await new Promise((resolve) => setTimeout(resolve, name === "first" ? 15 : 1));
    order.push(`end:${name}`);
    if (name === "throws") throw new Error("boom");
    return name === "first" ? { value: 1 } : { status: "done" };
  };
  const send = async (responses) => sent.push(responses);

  const first = coordinator.enqueue(
    { functionCalls: [{ id: "1", name: "first", args: {} }] },
    { execute, send },
  );
  const second = coordinator.enqueue(
    { functionCalls: [{ id: "2", name: "throws", args: {} }] },
    { execute, send },
  );
  await Promise.all([first, second]);

  assert.deepEqual(order, ["start:first", "end:first", "start:throws", "end:throws"]);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0][0].response.result, {
    ok: true,
    status: "ok",
    data: { value: 1 },
  });
  assert.equal(sent[1][0].response.result.status, "error");
  assert.equal(sent[1][0].response.result.error, "boom");
});

test("drops responses for tool calls cancelled during execution", async () => {
  const coordinator = new LiveToolCoordinator();
  let release;
  const executing = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const didStart = new Promise((resolve) => {
    started = resolve;
  });
  const sent = [];
  const operation = coordinator.enqueue(
    { functionCalls: [{ id: "cancel-me", name: "slow", args: {} }] },
    {
      execute: async () => {
        started();
        await executing;
        return { status: "done" };
      },
      send: async (responses) => sent.push(responses),
    },
  );
  await didStart;
  coordinator.cancel(["cancel-me"]);
  release();
  assert.deepEqual(await operation, []);
  assert.deepEqual(sent, []);
});

test("a cancelled call is skipped unless it stages state the model will rely on", async () => {
  const coordinator = new LiveToolCoordinator();
  const ran = [];
  const sent = [];
  coordinator.cancel(["a", "b"]);
  const responses = await coordinator.enqueue(
    {
      functionCalls: [
        { id: "a", name: "check_hermes_status", args: {} },
        { id: "b", name: "propose_hermes_task", args: { goal: "Email the client" } },
      ],
    },
    {
      execute: async (name) => {
        ran.push(name);
        return { status: "ok" };
      },
      send: async (batch) => sent.push(batch),
      survivesCancellation: (name) => name === "propose_hermes_task",
    },
  );

  assert.deepEqual(ran, ["propose_hermes_task"]);
  // It ran, but a cancelled call still gets no response on the wire.
  assert.deepEqual(responses, []);
  assert.deepEqual(sent, []);
});
