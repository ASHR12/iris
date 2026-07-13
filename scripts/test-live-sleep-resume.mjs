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
  IRIS_AUTO_SLEEP_SECONDS: "120",
  IRIS_TEST_HOOKS: "1",
  IRIS_TEST_SKIP_WELCOME: "1",
};
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  args: [
    path.join(root, "electron", "main.mjs"),
    `--user-data-dir=/tmp/iris-live-sleep-test-${process.pid}`,
  ],
  cwd: root,
  env,
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector(".deck", { timeout: 20000 });
  await page.evaluate(() => {
    window.__sleepResumeTest = { events: [] };
    window.iris.onSidecarEvent((event) => {
      window.__sleepResumeTest.events.push({ at: Date.now(), event });
    });
  });
  await page.evaluate(() => window.iris.startSidecar({ mode: "none" }));
  await page.waitForTimeout(500);
  const sleepAt = Date.now();
  await page.evaluate(() =>
    window.iris.sendCommand({
      type: "text",
      text: "Bye bye, Iris. Go to sleep.",
    }),
  );
  await page.waitForFunction(
    (at) =>
      window.__sleepResumeTest.events.some(
        ({ at: eventAt, event }) =>
          eventAt >= at &&
          event.type === "sidecar_status" &&
          event.status?.running === false,
      ),
    sleepAt,
    { timeout: 15000 },
  );
  // Let the renderer finish its microphone/playback teardown before issuing
  // a new wake, just as a real wake word necessarily occurs later.
  await page.waitForTimeout(1000);

  const wokeAt = Date.now();
  const wakeStatus = await page.evaluate(() =>
    window.iris.startSidecar({ mode: "none" }),
  );
  const wakeConnectMs = Date.now() - wokeAt;
  if (!wakeStatus.running) throw new Error("Iris did not wake.");
  try {
    await page.waitForFunction(
      (at) =>
        window.__sleepResumeTest.events.some(
          ({ at: eventAt, event }) =>
            eventAt >= at &&
            event.type === "transcript" &&
            event.speaker === "gemini" &&
            /back|what.?s next/i.test(String(event.text || "")),
        ),
      wokeAt,
      { timeout: 12000 },
    );
  } catch (error) {
    const diagnostics = await page.evaluate((at) =>
      window.__sleepResumeTest.events.filter(({ at: eventAt }) => eventAt >= at),
      wokeAt,
    );
    const hasResumeHandle = await app.evaluate(() =>
      globalThis.__irisTest?.hasResumeHandle(),
    );
    console.error(JSON.stringify({ wakeStatus, hasResumeHandle, diagnostics }));
    throw error;
  }

  const questionAt = Date.now();
  await page.evaluate(() =>
    window.iris.sendCommand({
      type: "text",
      text: "Tell me one concise fact about Ooty.",
    }),
  );
  await page.waitForFunction(
    (at) =>
      window.__sleepResumeTest.events.some(
        ({ at: eventAt, event }) =>
          eventAt >= at &&
          event.type === "transcript" &&
          event.speaker === "gemini",
      ),
    questionAt,
    { timeout: 20000 },
  );
  const finalStatus = await page.evaluate(() => window.iris.getSidecarStatus());
  if (!finalStatus.running) {
    throw new Error("The historical farewell put Iris back to sleep after wake.");
  }
  const transcripts = await page.evaluate((at) =>
    window.__sleepResumeTest.events
      .filter(
        ({ at: eventAt, event }) =>
          eventAt >= at &&
          event.type === "transcript",
      )
      .map(({ event }) => ({ speaker: event.speaker, text: event.text })),
    wokeAt,
  );
  console.log(JSON.stringify({ wakeStatus, wakeConnectMs, finalStatus, transcripts }));
  await page.evaluate(() => window.iris.stopSidecar());
} finally {
  await app.close();
}
