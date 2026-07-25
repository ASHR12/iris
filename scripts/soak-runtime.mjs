import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? Number(process.argv[index + 1]) : fallback;
};
const hours = Math.max(0.001, option("--hours", 8));
const sampleSeconds = Math.max(5, option("--sample-seconds", 60));
const maxGrowthMbPerHour = Math.max(0, option("--max-growth-mb-hour", 8));
const warmupMinutes = Math.max(
  0,
  Math.min(option("--warmup-minutes", 2), hours * 60 * 0.25),
);

if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
  console.error("Build Iris first with `npm run build`, then run `npm run soak`.");
  process.exit(1);
}

const env = {
  ...process.env,
  IRIS_START_PROD: "1",
  IRIS_LOAD_TEST_DATA: "true",
  IRIS_WAKE_WORD: "false",
  IRIS_HERMES_AUTOSTART: "false",
  IRIS_AUTO_WAKE_ON_HERMES: "false",
  IRIS_TEST_HOOKS: "1",
};
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  args: [path.join(root, "electron", "main.mjs")],
  cwd: root,
  env,
});
const page = await app.firstWindow();
await page.waitForSelector(".deck", { timeout: 20000 });
await page.keyboard.press("d");
// Prime the GPU/helper processes before taking the memory baseline so normal
// lazy startup is not mistaken for a leak.
await page.evaluate(() => window.iris.toggleHud());
await page.waitForTimeout(800);
await page.evaluate(() => window.iris.toggleHud());
await page.waitForTimeout(Math.max(800, warmupMinutes * 60 * 1000));

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  const child = app.process();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await app
    .evaluate(({ app: electronApp }) => {
      setImmediate(() => electronApp.quit());
      return true;
    })
    .catch(() => undefined);
  const result = await Promise.race([
    exited.then(() => "exited"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000)),
  ]);
  if (result === "timeout" && child.exitCode == null) child.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

const samples = [];
const startedAt = Date.now();
const deadline = startedAt + hours * 60 * 60 * 1000;
let cycle = 0;

while (!stopping && Date.now() < deadline) {
  const mainMemory = await app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((metric) => ({
      type: metric.type,
      pid: metric.pid,
      memory: metric.memory?.workingSetSize || 0,
    })),
  );
  const renderer = await page.evaluate(() => ({
    heap: performance.memory?.usedJSHeapSize ?? null,
    tasks: document.querySelectorAll(".wcard").length,
    canvases: document.querySelectorAll("canvas").length,
    videos: document.querySelectorAll("video").length,
  }));
  const workingSetKb = mainMemory.reduce((sum, metric) => sum + metric.memory, 0);
  const sample = {
    at: new Date().toISOString(),
    elapsedMinutes: (Date.now() - startedAt) / 60000,
    workingSetMb: workingSetKb / 1024,
    rendererHeapMb: renderer.heap == null ? null : renderer.heap / 1024 / 1024,
    tasks: renderer.tasks,
    canvases: renderer.canvases,
    videos: renderer.videos,
  };
  samples.push(sample);
  console.log(JSON.stringify(sample));

  cycle += 1;
  if (cycle % 2 === 0) {
    await page.evaluate(() => window.iris.toggleHud());
    await page.waitForTimeout(800);
    await page.evaluate(() => window.iris.toggleHud());
    await page.waitForTimeout(800);
  }
  if (cycle % 5 === 0) await page.keyboard.press("g");
  await page.waitForTimeout(sampleSeconds * 1000);
}

await stop();

if (samples.length >= 2) {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const elapsedHours = Math.max((last.elapsedMinutes - first.elapsedMinutes) / 60, 1 / 60);
  const growth = (last.workingSetMb - first.workingSetMb) / elapsedHours;
  console.log(
    JSON.stringify({
      summary: true,
      samples: samples.length,
      hours: elapsedHours,
      workingSetGrowthMbPerHour: growth,
      thresholdMbPerHour: maxGrowthMbPerHour,
    }),
  );
  if (elapsedHours >= 1 && growth > maxGrowthMbPerHour) process.exitCode = 1;
}

process.exit(process.exitCode ?? 0);
