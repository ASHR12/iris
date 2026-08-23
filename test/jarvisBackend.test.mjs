import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  HEADLESS_BACKEND_ARG,
  resolveJarvisLauncher,
  startJarvisBackend,
  stopJarvisBackend,
} from "../electron/jarvisBackend.mjs";

/*
 * Iris is the only visible shell; Jarvis is its backend. Iris therefore
 * starts Jarvis HEADLESS (no window, no tray) and stops it again on quit.
 *
 * It never starts a second backend: Jarvis's own electron-main.cjs already
 * holds a single-instance lock, so a duplicate launch exits immediately and
 * a later `npm run jarvis` just shows the existing process's window.
 */

const REPO = "/Users/x/Development/iris-test";
const JARVIS_ELECTRON = "/Users/x/Development/Jarvis-Desktop/node_modules/.bin/electron";
const JARVIS_APP_DIR = "/Users/x/Development/Jarvis-Desktop/app";
const PACKAGED_JARVIS = "/Applications/Jarvis.app/Contents/MacOS/Jarvis";

test("the headless flag is the documented one Jarvis's electron-main parses", () => {
  assert.equal(HEADLESS_BACKEND_ARG, "--headless-backend");
});

test("dev: resolves the sibling Jarvis checkout's own electron binary and passes the app dir + headless flag", () => {
  const launcher = resolveJarvisLauncher({
    repoRoot: REPO,
    env: {},
    platform: "darwin",
    existsFn: (p) => p === JARVIS_ELECTRON || p === JARVIS_APP_DIR,
  });
  assert.equal(launcher.command, JARVIS_ELECTRON);
  assert.deepEqual(launcher.args, [JARVIS_APP_DIR, HEADLESS_BACKEND_ARG]);
  assert.equal(launcher.mode, "dev");
});

// Jarvis-Desktop is a pnpm workspace: electron is a dependency of the `app`
// package, so the binary really lives in app/node_modules/.bin, NOT at the
// repo root. Resolving only the root path found nothing and Iris silently
// started no backend at all — caught by a real dev smoke.
test("dev: finds the electron binary in the pnpm workspace package (app/node_modules/.bin), not just at the repo root", () => {
  const workspaceElectron = "/Users/x/Development/Jarvis-Desktop/app/node_modules/.bin/electron";
  const launcher = resolveJarvisLauncher({
    repoRoot: REPO,
    env: {},
    platform: "darwin",
    existsFn: (p) => p === workspaceElectron || p === JARVIS_APP_DIR,
  });
  assert.notEqual(launcher, null, "a workspace-installed electron must still be found");
  assert.equal(launcher.command, workspaceElectron);
  assert.deepEqual(launcher.args, [JARVIS_APP_DIR, HEADLESS_BACKEND_ARG]);
  assert.equal(launcher.mode, "dev");
});

test("packaged: falls back to an installed Jarvis.app and launches it headless", () => {
  const launcher = resolveJarvisLauncher({
    repoRoot: REPO,
    env: {},
    platform: "darwin",
    existsFn: (p) => p === PACKAGED_JARVIS,
  });
  assert.equal(launcher.command, PACKAGED_JARVIS);
  assert.deepEqual(launcher.args, [HEADLESS_BACKEND_ARG]);
  assert.equal(launcher.mode, "packaged");
});

test("the dev checkout wins over an installed Jarvis.app, so a developer never drives the installed copy by accident", () => {
  const launcher = resolveJarvisLauncher({
    repoRoot: REPO,
    env: {},
    platform: "darwin",
    existsFn: () => true,
  });
  assert.equal(launcher.mode, "dev");
});

test("JARVIS_APP_PATH overrides everything, for a Jarvis installed somewhere non-standard", () => {
  const launcher = resolveJarvisLauncher({
    repoRoot: REPO,
    env: { JARVIS_APP_PATH: "/opt/Jarvis/Jarvis" },
    platform: "darwin",
    existsFn: () => true,
  });
  assert.equal(launcher.command, "/opt/Jarvis/Jarvis");
  assert.deepEqual(launcher.args, [HEADLESS_BACKEND_ARG]);
  assert.equal(launcher.mode, "explicit");
});

test("a .app bundle given via JARVIS_APP_PATH is resolved to its inner executable", () => {
  const launcher = resolveJarvisLauncher({
    repoRoot: REPO,
    env: { JARVIS_APP_PATH: "/opt/Jarvis.app" },
    platform: "darwin",
    existsFn: () => true,
  });
  assert.equal(launcher.command, path.join("/opt/Jarvis.app", "Contents", "MacOS", "Jarvis"));
});

test("no Jarvis anywhere resolves to null — Iris must still start, just without a backend", () => {
  assert.equal(
    resolveJarvisLauncher({ repoRoot: REPO, env: {}, platform: "darwin", existsFn: () => false }),
    null,
  );
});

test("startJarvisBackend spawns the resolved launcher detached from Iris's stdio and returns the child", () => {
  const calls = [];
  const child = { pid: 4242, on: () => {}, killed: false };
  const started = startJarvisBackend({
    launcher: { command: JARVIS_ELECTRON, args: [JARVIS_APP_DIR, HEADLESS_BACKEND_ARG], mode: "dev" },
    spawnFn: (command, args, options) => { calls.push({ command, args, options }); return child; },
  });
  assert.equal(started, child);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, JARVIS_ELECTRON);
  assert.deepEqual(calls[0].args, [JARVIS_APP_DIR, HEADLESS_BACKEND_ARG]);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.notEqual(calls[0].options.detached, true, "the backend must die with Iris, so it must NOT be detached");
});

test("startJarvisBackend without a launcher never throws and never spawns", () => {
  let spawned = false;
  const started = startJarvisBackend({ launcher: null, spawnFn: () => { spawned = true; } });
  assert.equal(started, null);
  assert.equal(spawned, false);
});

test("startJarvisBackend swallows a spawn failure — Iris must still boot if Jarvis cannot be started", () => {
  const logs = [];
  const started = startJarvisBackend({
    launcher: { command: "/nope", args: [], mode: "dev" },
    spawnFn: () => { throw new Error("ENOENT"); },
    onLog: (message) => logs.push(message),
  });
  assert.equal(started, null);
  assert.equal(logs.some((line) => /ENOENT/.test(line)), true);
});

test("stopJarvisBackend terminates the backend Iris started, so no orphan Jarvis survives", () => {
  const signals = [];
  const child = { pid: 1, killed: false, kill: (signal) => signals.push(signal) };
  stopJarvisBackend(child);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("stopJarvisBackend is a safe no-op for a missing or already-dead backend", () => {
  assert.doesNotThrow(() => stopJarvisBackend(null));
  assert.doesNotThrow(() => stopJarvisBackend({ killed: true, kill: () => { throw new Error("already gone"); } }));
});

// Mirrors the grace-window escalation already used for the Hermes gateway
// child (hermesGatewayClient.mjs #stopProcess, ~line 269-280): SIGTERM first,
// then SIGKILL after a 3000ms grace period if the child never reports exit.
// A backend that ignores/survives SIGTERM must not be left running forever.
test("stopJarvisBackend escalates to SIGKILL if the backend ignores SIGTERM for 3000ms", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals = [];
  const child = {
    pid: 1,
    killed: false,
    exitCode: null, // never set — simulates a child that survives SIGTERM
    kill: (signal) => { signals.push(signal); },
  };
  stopJarvisBackend(child);
  t.mock.timers.tick(3000);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});
