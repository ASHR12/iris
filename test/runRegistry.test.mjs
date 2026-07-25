import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunRegistry } from "../electron/runRegistry.mjs";

test("run state survives restart and retains approval metadata", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-run-registry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "runs.json");

  const registry = new RunRegistry({ filePath });
  registry.start({
    runId: "run-1",
    task: "Prepare a report",
    sessionId: "session-a",
    urgency: "high",
  });
  registry.update("run-1", { status: "waiting_for_approval" });
  registry.setApproval("run-1", {
    command: "send report",
    reason: "External side effect",
    choices: ["once", "deny"],
  });
  registry.setInteraction("run-1", {
    id: "clarify-1",
    type: "clarify",
    question: "Which path?",
    choices: ["A", "B"],
    allowCustom: true,
    secret: false,
    value: "must-not-be-persisted",
  });

  const restored = new RunRegistry({ filePath });
  assert.equal(restored.list({ activeOnly: true }).length, 1);
  assert.equal(restored.get("run-1").sessionId, "session-a");
  assert.equal(restored.get("run-1").approval.command, "send report");
  assert.equal(restored.get("run-1").interaction.question, "Which path?");
  assert.doesNotMatch(fs.readFileSync(filePath, "utf8"), /must-not-be-persisted/);

  restored.update("run-1", {
    status: "completed",
    output: "Done",
    approval: null,
    interaction: null,
  });
  restored.markAnnounced("run-1");
  const complete = new RunRegistry({ filePath }).get("run-1");
  assert.equal(complete.status, "completed");
  assert.equal(complete.output, "Done");
  assert.ok(complete.announcedAt > 0);
  assert.equal(complete.approval, null);
});

test("registry files are valid bounded JSON", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-run-registry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "runs.json");
  const registry = new RunRegistry({ filePath, maxEntries: 2 });
  registry.start({ runId: "a", task: "A", sessionId: "s" });
  registry.start({ runId: "b", task: "B", sessionId: "s" });
  registry.start({ runId: "c", task: "C", sessionId: "s" });
  assert.equal(registry.list().length, 2);
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(payload.version, 1);
  assert.equal(payload.runs.length, 2);
});

test("registry preserves complete Hermes output without truncation", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-run-registry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "runs.json");
  const output = Array.from(
    { length: 5000 },
    (_, index) => `${index + 1}. Complete Hermes result line`,
  ).join("\n");
  const registry = new RunRegistry({ filePath });
  registry.start({ runId: "long-output", task: "List everything", sessionId: "s" });
  registry.update("long-output", { status: "completed", output });
  assert.equal(new RunRegistry({ filePath }).get("long-output").output, output);
});
