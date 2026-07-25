import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifyStandby = process.argv.includes("--verify-standby");
const query =
  process.env.IRIS_LIVE_TEST_QUERY ||
  "Using current web information, are any FIFA World Cup 2026 matches being played tonight, July 11 2026 in India time? Answer directly with the teams, or say there is no match.";
const env = {
  ...process.env,
  IRIS_START_PROD: "1",
  IRIS_LOAD_TEST_DATA: "false",
  IRIS_WAKE_WORD: "false",
  IRIS_HERMES_AUTOSTART: "false",
  IRIS_AUTO_WAKE_ON_HERMES: "false",
  IRIS_AUTO_SLEEP_SECONDS: "15",
  IRIS_TEST_HOOKS: "1",
  IRIS_TEST_SKIP_WELCOME: process.env.IRIS_TEST_SKIP_WELCOME ?? "1",
};
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  args: [
    path.join(root, "electron", "main.mjs"),
    `--user-data-dir=/tmp/iris-live-search-test-${process.pid}`,
  ],
  cwd: root,
  env,
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector(".deck", { timeout: 20000 });
  await page.evaluate(() => {
    window.__liveSearchTest = { events: [], sentAt: 0, audioChunks: 0 };
    window.iris.onSidecarEvent((event) => {
      window.__liveSearchTest.events.push({ at: Date.now(), event });
    });
    window.iris.onAudioChunk(() => {
      window.__liveSearchTest.audioChunks += 1;
    });
  });
  await page.evaluate(() => window.iris.startSidecar({ mode: "none" }));
  if (env.IRIS_TEST_SKIP_WELCOME === "1") {
    await page.waitForTimeout(1000);
  } else {
    await page.waitForFunction(
      () =>
        window.__liveSearchTest.events.some(
          ({ event }) =>
            event.type === "transcript" &&
            event.speaker === "gemini",
        ),
      undefined,
      { timeout: 20000 },
    );
    await page.waitForTimeout(2000);
  }
  await page.evaluate((text) => {
    window.__liveSearchTest.sentAt = Date.now();
    return window.iris.sendCommand({
      type: "text",
      text,
    });
  }, query);

  await page.waitForTimeout(20000);
  const runningDuringSearch = await page.evaluate(() => window.iris.getSidecarStatus());
  if (!runningDuringSearch.running) {
    throw new Error("Iris auto-slept while Google Search was still in flight.");
  }

  await page.waitForFunction(
    () =>
      window.__liveSearchTest.events.some(({ at, event }) => {
        if (at < window.__liveSearchTest.sentAt) return false;
        if (event.type === "transcript" && event.speaker === "gemini") return true;
        return (
          event.type === "log" &&
          String(event.message || "").includes("invalid argument")
        );
      }),
    undefined,
    { timeout: 60000 },
  );

  const result = await page.evaluate(() => {
    const events = window.__liveSearchTest.events.filter(
      ({ at }) => at >= window.__liveSearchTest.sentAt,
    );
    return {
      responses: events
        .filter(
          ({ event }) =>
            event.type === "transcript" &&
            event.speaker === "gemini",
        )
        .map(({ event }) => event.text),
      invalidArgument: events.some(
        ({ event }) =>
          event.type === "log" &&
          String(event.message || "").includes("invalid argument"),
      ),
      searchStates: events
        .filter(({ event }) => event.type === "google_search")
        .map(({ event }) => event.state),
      audioChunks: window.__liveSearchTest.audioChunks,
    };
  });
  if (result.invalidArgument) {
    throw new Error("Gemini rejected the Search turn as an invalid request.");
  }
  if (!result.responses.length || !result.audioChunks) {
    throw new Error("Google Search completed without a spoken/transcribed answer.");
  }
  let runningAfterIdle = null;
  if (verifyStandby) {
    await page.waitForTimeout(20000);
    runningAfterIdle = await page.evaluate(() => window.iris.getSidecarStatus());
    if (runningAfterIdle.running) {
      throw new Error("Iris remained awake after the completed Search became idle.");
    }
  }
  console.log(JSON.stringify({ runningDuringSearch, runningAfterIdle, ...result }));
  await page.evaluate(() => window.iris.stopSidecar());
} finally {
  await app.close();
}
