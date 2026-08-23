// Gap 1 ROT (manual smoke, NOT part of `npm test` / `node --test test/*.test.mjs`):
// boots a real Electron app, so it must be run directly:
//   node test/turnOwnership.smoke.mjs
//
// Proves the missing turn-ownership gate: today, a "memory"-routed turn is
// answered by BOTH Gemini's own spoken transcript (flushModelTranscript,
// main.mjs:346-359) AND relayed to Jarvis (flushUserTranscript, main.mjs:333-
// 344) — a double answer. The fix under test exposes
// window.__irisTest.simulateMemoryToolCall(route, name, args), which for a
// "memory" route must defer to Jarvis instead of returning real tool data.
//
// EXPECTED RIGHT NOW: this hook does not exist yet, so the test fails with
// "window.__irisTest.simulateMemoryToolCall is not a function" (or similar).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const env = {
  ...process.env,
  IRIS_START_PROD: "1",
  IRIS_LOAD_TEST_DATA: "false",
  IRIS_WAKE_WORD: "false",
  IRIS_HERMES_AUTOSTART: "false",
  IRIS_TEST_HOOKS: "1",
};
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  args: [
    path.join(root, "electron", "main.mjs"),
    `--user-data-dir=/tmp/iris-turn-ownership-test-${process.pid}`,
  ],
  cwd: root,
  env,
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector(".deck", { timeout: 20000 });

  // Note: __irisTest hooks live on the main-process globalThis (see
  // electron/main.mjs:2440), not on the renderer's window — every existing
  // caller (e.g. scripts/test-live-hermes-wake.mjs) reaches them via
  // app.evaluate(), not page.evaluate(). Mirrored here for the same reason.
  const result = await app.evaluate(() =>
    globalThis.__irisTest.simulateMemoryToolCall("memory", "search_memory", { query: "test" }),
  );

  if (result?.deferredToJarvis !== true) {
    throw new Error(
      `Expected simulateMemoryToolCall("memory", ...) to return deferredToJarvis === true, got: ${JSON.stringify(result)}`,
    );
  }

  console.log("PASS: memory-route tool call deferred to Jarvis, no double answer.");
} finally {
  await app.close();
}
