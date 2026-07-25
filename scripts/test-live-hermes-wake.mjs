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
  IRIS_AUTO_WAKE_ON_HERMES: "true",
  IRIS_AUTO_SLEEP_SECONDS: "120",
  IRIS_SHOW_WAKE_DIAGNOSTICS: "true",
  IRIS_TEST_HOOKS: "1",
  IRIS_TEST_SKIP_WELCOME: "1",
};
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  args: [
    path.join(root, "electron", "main.mjs"),
    `--user-data-dir=/tmp/iris-hermes-wake-test-${process.pid}`,
  ],
  cwd: root,
  env,
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector(".deck", { timeout: 20000 });
  await page.evaluate(() => {
    window.__hermesWakeTest = { events: [] };
    window.iris.onSidecarEvent((event) => {
      window.__hermesWakeTest.events.push({ at: Date.now(), event });
    });
  });
  await page.evaluate(() => window.iris.startSidecar({ mode: "none" }));
  await page.evaluate(() => window.iris.stopSidecar());
  await page.waitForTimeout(750);

  const completedAt = Date.now();
  await app.evaluate(() =>
    globalThis.__irisTest.simulateHermesComplete(
      "Summarize a completed test",
      "Hermes completed the test successfully and returned this exact result.",
    ),
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector(".wake-reason-pill")
        ?.textContent?.includes("HERMES RESULT"),
    undefined,
    { timeout: 10000 },
  );
  await page.waitForFunction(
    (at) =>
      window.__hermesWakeTest.events.some(
        ({ at: eventAt, event }) =>
          eventAt >= at &&
          event.type === "transcript" &&
          event.speaker === "gemini",
      ),
    completedAt,
    { timeout: 30000 },
  );
  const result = await page.evaluate((at) => {
    const events = window.__hermesWakeTest.events.filter(
      ({ at: eventAt }) => eventAt >= at,
    );
    const transcript = events.find(
      ({ event }) =>
        event.type === "transcript" &&
        event.speaker === "gemini",
    );
    const connected = events.find(
      ({ event }) =>
        event.type === "gemini_status" &&
        event.status === "connected",
    );
    const speaking = events.find(
      ({ event }) =>
        event.type === "audio_state" &&
        event.state === "speaking",
    );
    return {
      connectMs: connected ? connected.at - at : null,
      speakingMs: speaking ? speaking.at - at : null,
      announceMs: transcript ? transcript.at - at : null,
      transcript: transcript?.event.text || "",
    };
  }, completedAt);
  if (!/completed|success|result/i.test(result.transcript)) {
    throw new Error("Iris did not announce the real Hermes result.");
  }
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".wcard")].some((card) =>
        card.textContent?.includes(
          "Hermes completed the test successfully and returned this exact result.",
        ),
      ),
    undefined,
    { timeout: 5000 },
  );
  const ui = await page.evaluate(() => ({
    cardText:
      [...document.querySelectorAll(".wcard")]
        .find((card) =>
          card.textContent?.includes("Summarize a completed test"),
        )
        ?.textContent || "",
    commsText: [...document.querySelectorAll(".comms .bubble")]
      .map((bubble) => bubble.textContent || "")
      .join("\n"),
  }));
  if (ui.commsText.includes("SYSTEM_EVENT_HERMES_COMPLETE")) {
    throw new Error("Internal Hermes completion payload leaked into Comms.");
  }
  await page.waitForSelector(".wake-reason-pill", {
    state: "detached",
    timeout: 8000,
  });
  console.log(JSON.stringify({ ...result, cardPopulated: true }));
  await page.evaluate(() => window.iris.stopSidecar());
} finally {
  await app.close();
}
