/*
 * P2.5 end-to-end smoke: Iris -> Ask Jarvis -> Action Preview -> Approval ->
 * Jarvis backend process -> Result -> Iris.
 *
 * This is the whole point of P2.5 in one run, with nothing stubbed:
 *   - a real Iris Electron app,
 *   - which starts the real headless Jarvis backend process,
 *   - which binds its real loopback Action endpoint and publishes a real
 *     0600 descriptor,
 *   - a real natural-language request typed into the real Ask Jarvis
 *     composer,
 *   - a real proposal produced by Jarvis's own capture/action engines,
 *   - a real human-style approval click in Iris,
 *   - a real write executed IN THE JARVIS PROCESS,
 *   - and a real result rendered back in Iris's transcript.
 *
 * SAFETY — read this before changing anything below.
 * An approved Personal OS action performs a REAL file write. The vault it
 * writes into is redirected to a throwaway directory via JARVIS_VAULT_PATH,
 * and assertThrowawayVault() re-resolves Jarvis's OWN DEFAULT_VAULT under
 * exactly the environment this script is about to use, then ABORTS BEFORE
 * ELECTRON EVER LAUNCHES unless that path is inside the temp dir. The user's
 * real Obsidian vault must never be reachable from this script — a variable
 * that is set but not exported would silently fall back to it, which is
 * exactly what this guard exists to make impossible.
 *
 * JARVIS_ENGINEERING_DIR is redirected the same way, for two reasons: the
 * run leaves no state behind, and an unrelated Jarvis that happens to be
 * running already (single-instance lock) publishes its endpoint to the
 * DEFAULT dir, so this script simply will not find one and fails loudly
 * instead of driving the real vault.
 *
 * Run: npm run test:jarvis-action-smoke
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jarvisAppDir = path.resolve(root, "..", "Jarvis-Desktop", "app");
const failureDir = path.join(root, "test-results");
const failureScreenshot = path.join(failureDir, "jarvis-action-smoke-failure.png");

const REAL_VAULT = "/Users/cd/Documents/Obsidian-Mind/Cengiz-Mind";
const REQUEST = "Notiere: P2.5 Action Smoke Aufgabe";
const EXPECTED_NOTE = "00 Inbox/Capture/P2.5 Action Smoke Aufgabe.md";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-action-smoke-"));
const vaultPath = path.join(tmpRoot, "vault");
const engineeringDir = path.join(tmpRoot, "engineering");
const auditPath = path.join(tmpRoot, "action-audit.jsonl");
fs.mkdirSync(vaultPath, { recursive: true });
fs.mkdirSync(engineeringDir, { recursive: true });

// The production audit log must be byte-for-byte untouched by this run. Its
// size is recorded before launch and re-checked at the end — a positive
// assertion, not just a trust in the override.
const PRODUCTION_AUDIT_PATH = path.join(os.homedir(), "Library", "Application Support", "Jarvis", "action-audit.jsonl");
const productionAuditSizeBefore = fs.existsSync(PRODUCTION_AUDIT_PATH) ? fs.statSync(PRODUCTION_AUDIT_PATH).size : null;

const env = {
  ...process.env,
  IRIS_START_PROD: "1",
  IRIS_WAKE_WORD: "false",
  IRIS_HERMES_AUTOSTART: "false",
  IRIS_TEST_HOOKS: "1",
  // Both processes get these: Iris inherits them, and the Jarvis backend
  // Iris spawns inherits them again (jarvisBackend.mjs passes no env of its
  // own), so producer and consumer resolve the same isolated locations.
  JARVIS_VAULT_PATH: vaultPath,
  JARVIS_ENGINEERING_DIR: engineeringDir,
  // A propose arriving over the loopback Action endpoint carries only
  // {question, source}, so it cannot use the Action Service's per-call
  // params.auditPath injection and would otherwise append every lifecycle
  // transition of this run to the user's REAL action-audit.jsonl.
  JARVIS_ACTION_AUDIT_PATH: auditPath,
};
delete env.ELECTRON_RUN_AS_NODE;

/*
 * The guard. Asks JARVIS'S OWN modules — not this script's assumptions —
 * where they would write, under exactly the env we are about to hand them.
 */
function assertThrowawayVault() {
  if (!env.JARVIS_VAULT_PATH) throw new Error("ABORT: JARVIS_VAULT_PATH is not set in the child environment.");
  const resolved = execFileSync(
    process.execPath,
    ["-e", "process.stdout.write(require('./personal-os-reader.cjs').DEFAULT_VAULT)"],
    { cwd: jarvisAppDir, env, encoding: "utf8" },
  );
  if (resolved === REAL_VAULT || resolved.startsWith(`${REAL_VAULT}/`)) {
    throw new Error(`ABORT: Jarvis would write into the REAL Obsidian vault (${resolved}). Refusing to run.`);
  }
  if (path.resolve(resolved) !== path.resolve(vaultPath)) {
    throw new Error(`ABORT: Jarvis resolved its vault to ${resolved}, expected the throwaway ${vaultPath}.`);
  }
  const resolvedEngineering = execFileSync(
    process.execPath,
    ["-e", "process.stdout.write(require('./engineering-runtime-paths.cjs').defaultEngineeringRuntimeDir())"],
    { cwd: jarvisAppDir, env, encoding: "utf8" },
  );
  if (path.resolve(resolvedEngineering) !== path.resolve(engineeringDir)) {
    throw new Error(`ABORT: Jarvis resolved its runtime dir to ${resolvedEngineering}, expected ${engineeringDir}.`);
  }
  if (!env.JARVIS_ACTION_AUDIT_PATH) throw new Error("ABORT: JARVIS_ACTION_AUDIT_PATH is not set in the child environment.");
  const resolvedAudit = execFileSync(
    process.execPath,
    ["-e", "process.stdout.write(require('./personal-os-action-service.cjs').DEFAULT_ACTION_AUDIT_PATH)"],
    { cwd: jarvisAppDir, env, encoding: "utf8" },
  );
  if (path.resolve(resolvedAudit) === path.resolve(PRODUCTION_AUDIT_PATH)) {
    throw new Error(`ABORT: Jarvis would append to the REAL production audit log (${resolvedAudit}). Refusing to run.`);
  }
  if (path.resolve(resolvedAudit) !== path.resolve(auditPath)) {
    throw new Error(`ABORT: Jarvis resolved its audit log to ${resolvedAudit}, expected the throwaway ${auditPath}.`);
  }
  console.log(`GUARD OK: Jarvis will write into the throwaway vault ${resolved}`);
  console.log(`GUARD OK: Jarvis will append to the throwaway audit log ${resolvedAudit}`);
}

async function waitFor(label, predicate, timeoutMs = 30000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

assertThrowawayVault();

const app = await electron.launch({
  args: [path.join(root, "electron", "main.mjs"), `--user-data-dir=${path.join(tmpRoot, "iris-user-data")}`],
  cwd: root,
  env,
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector(".deck", { timeout: 30000 });

  // 1. The Jarvis backend process really came up and really published its
  //    loopback Action endpoint. Without this, everything below is theatre.
  const endpointPath = path.join(engineeringDir, "action-endpoint.json");
  const endpoint = await waitFor(
    "the Jarvis backend to publish its Action endpoint descriptor",
    () => (fs.existsSync(endpointPath) ? JSON.parse(fs.readFileSync(endpointPath, "utf8")) : null),
    60000,
  );
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint.url)) throw new Error(`Action endpoint is not loopback: ${endpoint.url}`);
  if (!endpoint.token) throw new Error("Action endpoint descriptor carries no token.");
  if ((fs.statSync(endpointPath).mode & 0o077) !== 0) throw new Error("Action endpoint descriptor is group/world readable.");
  if (endpoint.pid === process.pid) throw new Error("The Action endpoint must be owned by the Jarvis process, not this one.");
  console.log(`PASS 1/6: Jarvis backend (pid ${endpoint.pid}) published a 0600 loopback endpoint at ${endpoint.url}`);

  // 2. A real natural request, typed into the existing Ask Jarvis composer.
  const composer = page.locator('.comms-composer input[aria-label="Nachricht an Jarvis"]');
  await composer.waitFor({ timeout: 15000 });
  await composer.fill(REQUEST);
  await composer.press("Enter");

  // 3. Jarvis turned it into an Action and Iris is showing it for approval.
  const card = page.locator(".jarvis-action").first();
  await card.waitFor({ timeout: 30000 });
  const proposed = await card.evaluate((node) => ({
    previewId: node.getAttribute("data-preview-id"),
    risk: node.getAttribute("data-risk"),
    status: node.getAttribute("data-status"),
    summary: node.querySelector(".jarvis-action-summary")?.textContent ?? "",
  }));
  if (!proposed.previewId) throw new Error("The approval card carries no previewId.");
  if (proposed.status !== "proposed") throw new Error(`Expected a proposed action, got status ${proposed.status}.`);
  console.log(`PASS 2/6: Jarvis proposed an action for approval: ${JSON.stringify(proposed)}`);

  // 4. Nothing may have been written yet — approval is the gate, not the
  //    proposal.
  if (fs.existsSync(path.join(vaultPath, EXPECTED_NOTE))) {
    throw new Error("The note was written BEFORE approval — the approval gate is not doing its job.");
  }
  console.log("PASS 3/6: nothing was written before approval");

  // 5. The human approval, and the real write it triggers inside Jarvis.
  await page.locator(".jarvis-action-confirm").first().click();

  const notePath = path.join(vaultPath, EXPECTED_NOTE);
  await waitFor("the approved write to land in the throwaway vault", () => fs.existsSync(notePath), 30000);
  const note = fs.readFileSync(notePath, "utf8");
  if (!note.includes("P2.5 Action Smoke Aufgabe")) throw new Error("The written note does not contain the requested title.");
  if (!note.includes("confirmation: yes")) throw new Error("The written note carries no confirmed audit trail entry.");
  console.log(`PASS 4/6: the approved action really wrote ${EXPECTED_NOTE} inside the Jarvis process`);

  // 6. And the result came back into Iris's own transcript.
  await page.waitForSelector(".comms-scroll .bubble.jarvis, .comms-scroll .bubble.jarvis-error", { timeout: 20000 });
  const transcript = await page.evaluate(() => ({
    errors: [...document.querySelectorAll(".comms-scroll .bubble.jarvis-error")].map((node) => node.textContent ?? ""),
    lines: [...document.querySelectorAll(".comms-scroll .bubble.jarvis")].map((node) => node.textContent ?? ""),
  }));
  const done = transcript.lines.find((line) => line.includes("Erledigt"));
  if (!done) {
    throw new Error(`No execution result rendered in Iris. jarvis=${JSON.stringify(transcript.lines)} errors=${JSON.stringify(transcript.errors)}`);
  }
  if ((await page.locator(".jarvis-action").count()) !== 0) {
    throw new Error("The approval card is still visible after the action completed.");
  }
  console.log(`PASS 5/6: the result reached Iris's transcript: ${JSON.stringify(done)}`);

  // 7. Isolation, proven both ways: the throwaway audit log really received
  //    this run's lifecycle transitions, and the production one is byte-for-
  //    byte untouched.
  if (!fs.existsSync(auditPath)) throw new Error("The throwaway audit log was never written — the override did not take effect.");
  const auditEntries = fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const executed = auditEntries.filter((entry) => entry.actionId === proposed.previewId);
  if (!executed.some((entry) => entry.status === "succeeded")) {
    throw new Error(`The throwaway audit log holds no succeeded entry for ${proposed.previewId}: ${JSON.stringify(executed.map((entry) => entry.status))}`);
  }
  const productionAuditSizeAfter = fs.existsSync(PRODUCTION_AUDIT_PATH) ? fs.statSync(PRODUCTION_AUDIT_PATH).size : null;
  if (productionAuditSizeAfter !== productionAuditSizeBefore) {
    throw new Error(`The production audit log was modified (${productionAuditSizeBefore} -> ${productionAuditSizeAfter} bytes). This run must never touch it.`);
  }
  console.log(`PASS 6/6: ${executed.length} lifecycle entries landed in the throwaway audit log; production audit log untouched (${productionAuditSizeBefore} bytes)`);

  console.log("\nSMOKE PASS: Iris -> Ask Jarvis -> Action Preview -> Approval -> Jarvis backend -> Result -> Iris");
} catch (error) {
  try {
    fs.mkdirSync(failureDir, { recursive: true });
    const page = await app.firstWindow();
    await page.screenshot({ path: failureScreenshot });
    console.error(`Failure screenshot: ${failureScreenshot}`);
  } catch {
    // best-effort screenshot only
  }
  throw error;
} finally {
  await app.close();
  // The temp tree only ever held throwaway state; leaving it behind would
  // just accumulate stale bearer tokens.
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
}
