import test from "node:test";
import assert from "node:assert/strict";
import { readStoredHermesResult } from "../electron/hermesResultService.mjs";

test("reads a complete persisted Hermes result by id", async () => {
  const output = "Result ".repeat(10000);
  const result = await readStoredHermesResult({
    runId: "run-1",
    registry: {
      get: () => ({
        task: "Long task",
        status: "completed",
        output,
      }),
    },
    fetchHistory: async () => {
      throw new Error("history should not be needed");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.output, output);
});

test("reads the expanded historical card after an app restart", async () => {
  const output = "Historical Hermes result with all details.";
  const result = await readStoredHermesResult({
    uiContext: {
      expandedTaskId: "history:session-1:message-7",
      latestResultTaskId: "other",
    },
    registry: { get: () => null },
    fetchHistory: async () => ({
      ok: true,
      tasks: [
        {
          id: "history:session-1:message-7",
          task: "Restored task",
          status: "completed",
          output,
        },
      ],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.run_id, "history:session-1:message-7");
  assert.equal(result.output, output);
});

test("refuses to invent unavailable historical output", async () => {
  const result = await readStoredHermesResult({
    runId: "missing",
    registry: { get: () => null },
    fetchHistory: async () => ({ ok: true, tasks: [] }),
  });
  assert.equal(result.ok, false);
  assert.match(result.instructions, /do not invent/i);
});
