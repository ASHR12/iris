/*
 * P2.6 end-to-end smoke: the PACKAGED runtime.
 *
 * P2.5's smoke (test-jarvis-action-smoke.mjs) proves the Iris -> Jarvis flow
 * from SOURCE. This one proves the thing a user actually installs, and it is
 * a different claim in every step that matters:
 *
 *   - a real packaged Iris.app binary (not electron + electron/main.mjs),
 *   - loading its bundled renderer from file://, with NO Vite dev server,
 *   - which starts a real packaged Jarvis.app HEADLESS as its backend,
 *   - exactly one Jarvis backend process, owned by this Iris session,
 *   - Connections Status produced BY THAT BACKEND (proven by the snapshot
 *     file the Jarvis process itself wrote),
 *   - a real Ask Jarvis answer over the loopback read endpoint,
 *   - a real Action -> Approval -> write-inside-Jarvis -> Result in Iris,
 *   - and a clean teardown: quitting Iris takes the Jarvis process with it.
 *
 * WHY IT EXISTS. Before P2.6 both Iris clients located Jarvis by walking to a
 * sibling SOURCE CHECKOUT (path.resolve(repoRoot, "..", "Jarvis-Desktop")).
 * In a packaged Iris.app repoRoot is <Iris.app>/Contents/Resources/app.asar,
 * so that directory does not exist and every read and every approval failed —
 * in dev only, everything looked perfect. A source-mode smoke could never
 * have caught that. This one fails loudly if it ever comes back.
 *
 * SAFETY — read before changing anything below.
 * An approved Personal OS action performs a REAL file write. The vault, the
 * engineering runtime dir and the action audit log are all redirected to a
 * throwaway temp tree, and assertThrowawayPaths() asks the PACKAGED JARVIS
 * BINARY ITSELF (via ELECTRON_RUN_AS_NODE) where it would write under exactly
 * the environment this script is about to hand it. It ABORTS BEFORE ANYTHING
 * LAUNCHES unless every answer points inside the temp tree. The user's real
 * Obsidian vault and the production audit log are additionally re-verified as
 * untouched at the end — a positive assertion, not trust in an override.
 *
 * Prerequisites (both are asserted before launch):
 *   Jarvis: cd ../Jarvis-Desktop/app && pnpm dist:mac
 *   Iris:   npm run package:mac
 *
 * Run: npm run test:packaged-runtime-smoke
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failureDir = path.join(root, "test-results");
const failureScreenshot = path.join(failureDir, "packaged-runtime-smoke-failure.png");

const IRIS_APP = process.env.IRIS_APP_PATH || path.join(root, "release", "mac-arm64", "Iris.app");
const IRIS_BINARY = path.join(IRIS_APP, "Contents", "MacOS", "Iris");
const JARVIS_APP = process.env.JARVIS_APP_PATH
  || path.resolve(root, "..", "Jarvis-Desktop", "app", "dist-electron", "mac-arm64", "Jarvis.app");
const JARVIS_BINARY = path.join(JARVIS_APP, "Contents", "MacOS", "Jarvis");
const JARVIS_ASAR = path.join(JARVIS_APP, "Contents", "Resources", "app.asar");

const REAL_VAULT = "/Users/cd/Documents/Obsidian-Mind/Cengiz-Mind";
const REQUEST = "Notiere: P2.6 Packaged Smoke Aufgabe";
const EXPECTED_NOTE = "00 Inbox/Capture/P2.6 Packaged Smoke Aufgabe.md";
const ASK_QUESTION = "Wie heißt du?";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-packaged-smoke-"));
const vaultPath = path.join(tmpRoot, "vault");
const engineeringDir = path.join(tmpRoot, "engineering");
const auditPath = path.join(tmpRoot, "action-audit.jsonl");
fs.mkdirSync(vaultPath, { recursive: true });
fs.mkdirSync(engineeringDir, { recursive: true });

const PRODUCTION_AUDIT_PATH = path.join(os.homedir(), "Library", "Application Support", "Jarvis", "action-audit.jsonl");
const productionAuditSizeBefore = fs.existsSync(PRODUCTION_AUDIT_PATH) ? fs.statSync(PRODUCTION_AUDIT_PATH).size : null;

const env = {
  ...process.env,
  IRIS_WAKE_WORD: "false",
  IRIS_HERMES_AUTOSTART: "false",
  IRIS_TEST_HOOKS: "1",
  // Deliberately NOT set: IRIS_START_PROD. A packaged app must reach prod
  // mode through app.isPackaged alone — if it needed the flag, it would be
  // relying on a dev-mode escape hatch that no installed app ever gets.
  //
  // Both processes get these: Iris inherits them, and the Jarvis backend Iris
  // spawns inherits them again (jarvisBackend.mjs passes no env of its own),
  // so producer and consumer resolve the same isolated locations.
  JARVIS_VAULT_PATH: vaultPath,
  JARVIS_ENGINEERING_DIR: engineeringDir,
  JARVIS_ACTION_AUDIT_PATH: auditPath,
  // Pin the backend to the FRESHLY BUILT bundle instead of whatever happens
  // to sit in /Applications, so this smoke tests the code under review. The
  // no-env default (/Applications/Jarvis.app) is asserted separately below.
  JARVIS_APP_PATH: JARVIS_APP,
};
delete env.ELECTRON_RUN_AS_NODE;

function fail(message) {
  throw new Error(message);
}

/** Ask the PACKAGED Jarvis binary itself — not this script's assumptions, and
 *  not the source checkout — where it would write under `env`. */
function resolveInPackagedJarvis(expression) {
  return execFileSync(
    JARVIS_BINARY,
    ["-e", `process.stdout.write(String(${expression}))`],
    { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" },
  );
}

function assertBuildsExist() {
  if (!fs.existsSync(IRIS_BINARY)) fail(`ABORT: no packaged Iris at ${IRIS_BINARY}. Run: npm run package:mac`);
  if (!fs.existsSync(JARVIS_BINARY)) fail(`ABORT: no packaged Jarvis at ${JARVIS_BINARY}. Run: cd ../Jarvis-Desktop/app && pnpm dist:mac`);
  console.log(`GUARD OK: packaged Iris   ${IRIS_BINARY}`);
  console.log(`GUARD OK: packaged Jarvis ${JARVIS_BINARY}`);
}

function assertThrowawayPaths() {
  const vault = resolveInPackagedJarvis(`require(${JSON.stringify(path.join(JARVIS_ASAR, "personal-os-reader.cjs"))}).DEFAULT_VAULT`);
  if (vault === REAL_VAULT || vault.startsWith(`${REAL_VAULT}/`)) {
    fail(`ABORT: the packaged Jarvis would write into the REAL Obsidian vault (${vault}). Refusing to run.`);
  }
  if (path.resolve(vault) !== path.resolve(vaultPath)) {
    fail(`ABORT: the packaged Jarvis resolved its vault to ${vault}, expected the throwaway ${vaultPath}.`);
  }

  const runtimeDir = resolveInPackagedJarvis(`require(${JSON.stringify(path.join(JARVIS_ASAR, "engineering-runtime-paths.cjs"))}).defaultEngineeringRuntimeDir()`);
  if (path.resolve(runtimeDir) !== path.resolve(engineeringDir)) {
    fail(`ABORT: the packaged Jarvis resolved its runtime dir to ${runtimeDir}, expected ${engineeringDir}.`);
  }

  const audit = resolveInPackagedJarvis(`require(${JSON.stringify(path.join(JARVIS_ASAR, "personal-os-action-service.cjs"))}).DEFAULT_ACTION_AUDIT_PATH`);
  if (path.resolve(audit) === path.resolve(PRODUCTION_AUDIT_PATH)) {
    fail(`ABORT: the packaged Jarvis would append to the REAL production audit log (${audit}). Refusing to run.`);
  }
  if (path.resolve(audit) !== path.resolve(auditPath)) {
    fail(`ABORT: the packaged Jarvis resolved its audit log to ${audit}, expected the throwaway ${auditPath}.`);
  }
  console.log(`GUARD OK: packaged Jarvis writes into throwaway vault ${vault}`);
  console.log(`GUARD OK: packaged Jarvis appends to throwaway audit log ${audit}`);
}

/** The default (no JARVIS_APP_PATH) resolution a real installed Iris uses. It
 *  must NOT fall back to a source checkout — that regression is the entire
 *  reason P2.6 exists. */
async function assertPackagedDefaultResolution() {
  const { resolveJarvisLauncher } = await import(path.join(root, "electron", "jarvisBackend.mjs"));
  const packagedRepoRoot = path.join(IRIS_APP, "Contents", "Resources", "app.asar");
  const launcher = resolveJarvisLauncher({ repoRoot: packagedRepoRoot, env: {}, platform: "darwin" });
  if (!launcher) fail("ABORT: a packaged Iris resolves NO Jarvis launcher at all.");
  if (launcher.mode !== "packaged") {
    fail(`ABORT: a packaged Iris resolved a '${launcher.mode}' launcher (${launcher.command}) — it must never depend on a source checkout.`);
  }
  console.log(`PASS 0/8: a packaged Iris resolves Jarvis in '${launcher.mode}' mode (${launcher.command}), never a source checkout`);
}

async function waitFor(label, predicate, timeoutMs = 30000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) fail(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function processArgs(pid) {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** Every live process whose executable is the packaged Jarvis MAIN binary.
 *  Electron's helpers have their own distinct binaries, so this counts backend
 *  processes only. */
function jarvisMainProcessPids() {
  try {
    const out = execFileSync("/usr/bin/pgrep", ["-f", `^${JARVIS_BINARY}`], { encoding: "utf8" });
    return out.split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

assertBuildsExist();
assertThrowawayPaths();
await assertPackagedDefaultResolution();

const strayBefore = jarvisMainProcessPids();
if (strayBefore.length) {
  fail(`ABORT: a packaged Jarvis (pid ${strayBefore.join(", ")}) is already running. Quit it first — this smoke must own the only backend.`);
}

const app = await electron.launch({
  executablePath: IRIS_BINARY,
  args: [`--user-data-dir=${path.join(tmpRoot, "iris-user-data")}`],
  cwd: root,
  env,
});

let backendPid = null;

try {
  const page = await app.firstWindow();
  await page.waitForSelector(".deck", { timeout: 60000 });

  // 1. A real packaged shell: exactly one window, rendered from the bundle,
  //    with no dev server anywhere in the picture.
  const windows = app.windows();
  if (windows.length !== 1) fail(`Expected exactly one Iris window, got ${windows.length}.`);
  const pageUrl = page.url();
  if (!pageUrl.startsWith("file://")) fail(`Iris is not running from its bundle — window URL is ${pageUrl}.`);
  if (/localhost|127\.0\.0\.1:\d+/.test(pageUrl)) fail(`Iris is being served by a dev server: ${pageUrl}`);
  if (!pageUrl.includes("app.asar")) fail(`Iris did not load its packaged renderer (${pageUrl}).`);
  console.log(`PASS 1/8: exactly one Iris window, loaded from the bundle (${pageUrl})`);

  // 2. The backend really came up, headless, as the packaged Jarvis — and
  //    there is exactly one of it.
  const endpointPath = path.join(engineeringDir, "action-endpoint.json");
  const endpoint = await waitFor(
    "the packaged Jarvis backend to publish its loopback endpoint descriptor",
    () => (fs.existsSync(endpointPath) ? JSON.parse(fs.readFileSync(endpointPath, "utf8")) : null),
    90000,
  );
  backendPid = endpoint.pid;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint.url)) fail(`The endpoint is not loopback: ${endpoint.url}`);
  if (!endpoint.token) fail("The endpoint descriptor carries no token.");
  if ((fs.statSync(endpointPath).mode & 0o077) !== 0) fail("The endpoint descriptor is group/world readable.");
  if (endpoint.pid === process.pid) fail("The endpoint must be owned by the Jarvis process, not this script.");

  const backendArgs = processArgs(backendPid);
  if (!backendArgs.startsWith(JARVIS_BINARY)) {
    fail(`The backend is not the packaged Jarvis binary: ${backendArgs}`);
  }
  if (!backendArgs.includes("--headless-backend")) {
    fail(`The backend was not started headless (no window suppression): ${backendArgs}`);
  }
  const running = jarvisMainProcessPids();
  if (running.length !== 1 || running[0] !== backendPid) {
    fail(`Expected exactly one Jarvis backend process (${backendPid}), found: ${running.join(", ") || "none"}.`);
  }
  console.log(`PASS 2/8: exactly one packaged Jarvis backend (pid ${backendPid}), headless, on ${endpoint.url}`);

  // 3. Connections Status comes FROM THE BACKEND. The proof is not that Iris
  //    rendered something — it is that the Jarvis process wrote the snapshot
  //    file itself, and that Iris's own renderer API returns exactly it.
  const snapshotPath = path.join(engineeringDir, "connections-status.json");
  const snapshot = await waitFor(
    "the Jarvis backend to publish a Connections Status snapshot",
    () => (fs.existsSync(snapshotPath) ? JSON.parse(fs.readFileSync(snapshotPath, "utf8")) : null),
    60000,
  );
  if (!Array.isArray(snapshot.connections) || snapshot.connections.length === 0) {
    fail(`The backend published an empty Connections Status snapshot: ${JSON.stringify(snapshot)}`);
  }
  const fromRenderer = await page.evaluate(() => window.iris.getJarvisConnectionsStatus());
  if (!fromRenderer?.ok) fail(`Iris could not read Connections Status from the backend: ${JSON.stringify(fromRenderer)}`);
  const rendererIds = (fromRenderer.data?.connections ?? []).map((entry) => entry.id).sort();
  const snapshotIds = snapshot.connections.map((entry) => entry.id).sort();
  if (rendererIds.length === 0 || JSON.stringify(rendererIds) !== JSON.stringify(snapshotIds)) {
    fail(`Iris's Connections Status does not match the backend's snapshot.\n  renderer: ${JSON.stringify(rendererIds)}\n  backend:  ${JSON.stringify(snapshotIds)}`);
  }
  console.log(`PASS 3/8: Connections Status came from the backend (${rendererIds.length} connections, checkedAt ${fromRenderer.data.checkedAt})`);

  // 4. Ask Jarvis over the loopback read endpoint — the path that did not
  //    exist in a packaged build before P2.6.
  const answer = await page.evaluate((question) => window.iris.askJarvis(question), ASK_QUESTION);
  if (!answer?.ok) fail(`Ask Jarvis failed in the packaged runtime: ${JSON.stringify(answer)}`);
  if (typeof answer.answer !== "string" || !answer.answer.trim()) {
    fail(`Ask Jarvis returned an empty answer: ${JSON.stringify(answer)}`);
  }
  if (Object.keys(answer).sort().join(",") !== "answer,ok") {
    fail(`Ask Jarvis leaked internal fields across the boundary: ${Object.keys(answer).join(", ")}`);
  }
  console.log(`PASS 4/8: Ask Jarvis answered over the packaged loopback endpoint: ${JSON.stringify(answer.answer.slice(0, 120))}`);

  // 5. A real request typed into the real composer becomes a real proposal.
  const composer = page.locator('.comms-composer input[aria-label="Nachricht an Jarvis"]');
  await composer.waitFor({ timeout: 20000 });
  await composer.fill(REQUEST);
  await composer.press("Enter");

  const card = page.locator(".jarvis-action").first();
  await card.waitFor({ timeout: 60000 });
  const proposed = await card.evaluate((node) => ({
    previewId: node.getAttribute("data-preview-id"),
    risk: node.getAttribute("data-risk"),
    status: node.getAttribute("data-status"),
  }));
  if (!proposed.previewId) fail("The approval card carries no previewId.");
  if (proposed.status !== "proposed") fail(`Expected a proposed action, got status ${proposed.status}.`);
  if (fs.existsSync(path.join(vaultPath, EXPECTED_NOTE))) {
    fail("The note was written BEFORE approval — the approval gate is not doing its job.");
  }
  console.log(`PASS 5/8: Jarvis proposed an action for approval and wrote nothing yet (${JSON.stringify(proposed)})`);

  // 6. The human approval, and the real write it triggers inside Jarvis.
  await page.locator(".jarvis-action-confirm").first().click();
  const notePath = path.join(vaultPath, EXPECTED_NOTE);
  await waitFor("the approved write to land in the throwaway vault", () => fs.existsSync(notePath), 60000);
  const note = fs.readFileSync(notePath, "utf8");
  if (!note.includes("P2.6 Packaged Smoke Aufgabe")) fail("The written note does not contain the requested title.");
  if (!note.includes("confirmation: yes")) fail("The written note carries no confirmed audit trail entry.");
  console.log(`PASS 6/8: the approved action really wrote ${EXPECTED_NOTE} inside the packaged Jarvis process`);

  // 7. And the result came back into Iris's own transcript.
  await page.waitForSelector(".comms-scroll .bubble.jarvis, .comms-scroll .bubble.jarvis-error", { timeout: 30000 });
  const transcript = await page.evaluate(() => ({
    errors: [...document.querySelectorAll(".comms-scroll .bubble.jarvis-error")].map((node) => node.textContent ?? ""),
    lines: [...document.querySelectorAll(".comms-scroll .bubble.jarvis")].map((node) => node.textContent ?? ""),
  }));
  const done = transcript.lines.find((line) => line.includes("Erledigt"));
  if (!done) {
    fail(`No execution result rendered in Iris. jarvis=${JSON.stringify(transcript.lines)} errors=${JSON.stringify(transcript.errors)}`);
  }
  if ((await page.locator(".jarvis-action").count()) !== 0) {
    fail("The approval card is still visible after the action completed.");
  }
  console.log(`PASS 7/8: the result reached Iris's transcript: ${JSON.stringify(done)}`);

  // Isolation, proven both ways.
  if (!fs.existsSync(auditPath)) fail("The throwaway audit log was never written — the override did not take effect.");
  const auditEntries = fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  if (!auditEntries.some((entry) => entry.actionId === proposed.previewId && entry.status === "succeeded")) {
    fail(`The throwaway audit log holds no succeeded entry for ${proposed.previewId}.`);
  }
  const productionAuditSizeAfter = fs.existsSync(PRODUCTION_AUDIT_PATH) ? fs.statSync(PRODUCTION_AUDIT_PATH).size : null;
  if (productionAuditSizeAfter !== productionAuditSizeBefore) {
    fail(`The production audit log was modified (${productionAuditSizeBefore} -> ${productionAuditSizeAfter} bytes). This run must never touch it.`);
  }
  if (fs.existsSync(path.join(REAL_VAULT, EXPECTED_NOTE))) {
    fail("The smoke wrote into the REAL Obsidian vault. Isolation failed.");
  }
  console.log("ISOLATION OK: throwaway audit log received this run; production audit log and the real vault untouched");
} catch (error) {
  try {
    fs.mkdirSync(failureDir, { recursive: true });
    const page = await app.firstWindow();
    await page.screenshot({ path: failureScreenshot });
    console.error(`Failure screenshot: ${failureScreenshot}`);
  } catch {
    // best-effort screenshot only
  }
  await app.close().catch(() => {});
  throw error;
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
}

// 8. Teardown: quitting Iris must take the backend it started with it. A
//    surviving Jarvis would hold a stale single-instance lock and an orphaned
//    Action endpoint — the next Iris launch would silently get no backend.
await app.close();
const backendGone = async () => {
  const deadline = Date.now() + 20000;
  for (;;) {
    if (!jarvisMainProcessPids().includes(backendPid)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};
if (!(await backendGone())) {
  fail(`Quitting Iris left the Jarvis backend (pid ${backendPid}) running. Cleanup is broken.`);
}
console.log(`PASS 8/8: quitting Iris cleaned up the Jarvis backend (pid ${backendPid})`);

console.log("\nSMOKE PASS: packaged Iris.app -> one headless packaged Jarvis.app backend -> Connections Status, Ask Jarvis, Action/Approval/Result -> clean teardown");
