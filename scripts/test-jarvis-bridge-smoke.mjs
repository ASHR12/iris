// Gap 3 ROT: no Playwright/_electron E2E smoke exists yet that proves a real
// Iris Electron app can launch, show the Main Deck, trigger a real
// ask-Jarvis round trip (via the existing dev "j" hotkey / runJarvisSmoke()
// in src/App.tsx), and render the answer in CommsPanel.
//
// Run: npm run test:jarvis-bridge-smoke  (or: node scripts/test-jarvis-bridge-smoke.mjs
// after `npm run build`)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failureDir = path.join(root, "test-results");
const failureScreenshot = path.join(failureDir, "jarvis-bridge-smoke-failure.png");

const env = {
  ...process.env,
  IRIS_START_PROD: "1",
  IRIS_LOAD_TEST_DATA: "1",
  IRIS_WAKE_WORD: "false",
  IRIS_HERMES_AUTOSTART: "false",
  IRIS_TEST_HOOKS: "1",
};
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  args: [
    path.join(root, "electron", "main.mjs"),
    `--user-data-dir=/tmp/iris-jarvis-bridge-smoke-test-${process.pid}`,
  ],
  cwd: root,
  env,
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector(".deck", { timeout: 20000 });

  await page.keyboard.press("j");

  await page.waitForSelector(".comms-scroll .bubble.jarvis, .comms-scroll .bubble.jarvis-error", {
    timeout: 20000,
  });

  const result = await page.evaluate(() => {
    const errorBubble = document.querySelector(".comms-scroll .bubble.jarvis-error");
    const okBubble = document.querySelector(".comms-scroll .bubble.jarvis");
    return {
      hasError: Boolean(errorBubble),
      errorText: errorBubble?.textContent ?? null,
      hasOk: Boolean(okBubble),
      okText: okBubble?.textContent ?? null,
    };
  });

  if (result.hasError) {
    throw new Error(`Jarvis bridge round trip failed with a jarvis-error bubble: ${result.errorText}`);
  }
  if (!result.hasOk || !result.okText || !result.okText.trim()) {
    throw new Error(
      `Expected a non-empty .bubble.jarvis in .comms-scroll after pressing "j", got: ${JSON.stringify(result)}`,
    );
  }

  console.log(`PASS: real Jarvis bridge round trip rendered in CommsPanel: ${JSON.stringify(result)}`);
} catch (error) {
  try {
    fs.mkdirSync(failureDir, { recursive: true });
    const page = await app.firstWindow();
    await page.screenshot({ path: failureScreenshot });
  } catch {
    // best-effort screenshot only
  }
  throw error;
} finally {
  await app.close();
}
