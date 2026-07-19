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
  IRIS_AUTO_WAKE_ON_HERMES: "false",
  IRIS_AUTO_SLEEP_SECONDS: "15",
  IRIS_SHOW_WAKE_DIAGNOSTICS: "true",
  IRIS_TEST_HOOKS: "1",
  IRIS_TEST_SKIP_WELCOME: "1",
};
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  args: [
    path.join(root, "electron", "main.mjs"),
    `--user-data-dir=/tmp/iris-live-speech-test-${process.pid}`,
  ],
  cwd: root,
  env,
});

try {
  const page = await app.firstWindow();
  const consoleMessages = [];
  const failedRequests = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  page.on("requestfailed", (request) =>
    failedRequests.push({
      url: request.url(),
      error: request.failure()?.errorText,
    }),
  );
  await page.waitForSelector(".deck", { timeout: 20000 });
  await page.evaluate(() => {
    window.__speechStandbyTest = { events: [] };
    window.iris.onSidecarEvent((event) => {
      window.__speechStandbyTest.events.push(event);
    });
  });
  await page.waitForTimeout(1000);
  const config = await page.evaluate(() => window.iris.getConfig());
  if (!config.showWakeDiagnostics) {
    throw new Error("Wake diagnostics test configuration was not enabled.");
  }
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("iris:wake", {
      source: "hotkey",
    });
  });
  await page.waitForFunction(
    () =>
      document.querySelector(".wake-reason-pill")?.textContent?.includes("⌥W"),
    undefined,
    { timeout: 10000 },
  );
  try {
    await page.waitForFunction(
      () =>
        window.__speechStandbyTest.events.some(
          (event) =>
            event.type === "log" &&
            String(event.message || "").includes("Silero speech detection is ready"),
        ),
      undefined,
      { timeout: 30000 },
    );
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      events: window.__speechStandbyTest.events,
      status: null,
    }));
    diagnostics.status = await page.evaluate(() => window.iris.getSidecarStatus());
    console.error(
      JSON.stringify({ diagnostics, consoleMessages, failedRequests }),
    );
    throw error;
  }
  const readyStatus = await page.evaluate(() => window.iris.getSidecarStatus());
  if (!readyStatus.running) {
    await page.evaluate(() => window.iris.startSidecar({ mode: "none" }));
  }
  await page.evaluate(() =>
    window.iris.sendCommand({
      type: "speech_activity",
      source: "test",
      active: true,
    }),
  );
  await page.waitForTimeout(20000);
  const duringSpeech = await page.evaluate(() => window.iris.getSidecarStatus());
  if (!duringSpeech.running) {
    throw new Error("Iris entered standby while local speech was active.");
  }
  if ((await page.locator(".wake-reason-pill").count()) !== 0) {
    throw new Error("Wake diagnostics overlay did not auto-hide.");
  }

  await page.evaluate(() =>
    window.iris.sendCommand({
      type: "speech_activity",
      source: "test",
      active: false,
    }),
  );
  await page.waitForTimeout(20000);
  const afterSpeech = await page.evaluate(() => window.iris.getSidecarStatus());
  if (afterSpeech.running) {
    throw new Error("Iris did not enter standby after speech ended.");
  }
  if ((await page.locator(".wake-reason-pill").count()) !== 0) {
    throw new Error("Wake diagnostics overlay reappeared during standby.");
  }
  console.log(JSON.stringify({ duringSpeech, afterSpeech }));
} finally {
  await app.close();
}
