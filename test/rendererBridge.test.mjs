import test from "node:test";
import assert from "node:assert/strict";
import { RendererBridge } from "../electron/rendererBridge.mjs";

test("durable events queue until the renderer is ready while audio is dropped", () => {
  const sent = [];
  const contents = {
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  const bridge = new RendererBridge({ maxMessages: 2 });
  bridge.attach(contents);
  assert.equal(bridge.send("sidecar:event", { id: 1 }), false);
  assert.equal(bridge.send("live:audio", { chunk: true }), false);
  bridge.send("sidecar:event", { id: 2 });
  bridge.send("sidecar:event", { id: 3 });
  assert.equal(bridge.queued, 2);

  bridge.markReady();
  assert.deepEqual(sent, [
    { channel: "sidecar:event", payload: { id: 2 } },
    { channel: "sidecar:event", payload: { id: 3 } },
  ]);
  assert.equal(bridge.queued, 0);
});
