/*
 * Jarvis backend lifecycle — Iris is the only visible shell, Jarvis is its
 * headless backend.
 *
 * WHY Iris has to start it at all: Jarvis owns the Connections Status
 * producer (publishConnectionsStatus in Jarvis-Desktop/app/adapter/
 * iris-bridge.cjs, called from its electron-main.cjs). Only Jarvis's own
 * Electron process can compute that status, because its Drive/Calendar
 * credentials live in Electron safeStorage and its GMX/api keys behind the
 * macOS Keychain — both keyed to the JARVIS app identity, which Iris (its
 * own app, its own --user-data-dir) can never assume.
 *
 * WHY this is not a second backend: it launches Jarvis's real, unmodified
 * electron-main.cjs with `--headless-backend`, which only suppresses the
 * window/tray/shortcut. Jarvis's own single-instance lock guarantees it
 * runs exactly once — a duplicate launch exits immediately, and a later
 * `npm run jarvis` reaches the SAME process through its existing
 * "second-instance" handler and simply shows the window. No parallel
 * runtime, no second Action/Approval/Job state owner is created here.
 *
 * Never throws: a missing or unstartable Jarvis degrades to "no backend",
 * and Iris still boots (Connections Status then honestly reports that
 * Jarvis published nothing).
 */
import path from "node:path";
import fs from "node:fs";
import { spawn as defaultSpawn } from "node:child_process";

// The exact flag Jarvis's electron-main.cjs parses (headlessBackendMode).
export const HEADLESS_BACKEND_ARG = "--headless-backend";

const DEFAULT_PACKAGED_JARVIS = "/Applications/Jarvis.app/Contents/MacOS/Jarvis";

// A macOS .app bundle is a directory; the thing to exec lives inside it.
function executableForBundle(candidate) {
  if (!candidate.endsWith(".app")) return candidate;
  return path.join(candidate, "Contents", "MacOS", path.basename(candidate, ".app"));
}

/**
 * resolveJarvisLauncher({ repoRoot, env, platform, existsFn })
 *   -> { command, args, mode } | null
 *
 * Order: an explicit JARVIS_APP_PATH, then the sibling dev checkout, then an
 * installed Jarvis.app. The dev checkout deliberately outranks the installed
 * app so a developer running Iris from source drives the source Jarvis.
 */
export function resolveJarvisLauncher({
  repoRoot,
  env = process.env,
  platform = process.platform,
  existsFn = fs.existsSync,
} = {}) {
  const explicit = env.JARVIS_APP_PATH;
  if (explicit) {
    return { command: executableForBundle(explicit), args: [HEADLESS_BACKEND_ARG], mode: "explicit" };
  }

  // Dev: the sibling Jarvis-Desktop checkout, launched through its OWN
  // Electron install so the app identity (and therefore safeStorage) is
  // Jarvis's, never Iris's.
  const jarvisRoot = path.resolve(repoRoot, "..", "Jarvis-Desktop");
  const jarvisAppDir = path.join(jarvisRoot, "app");
  if (existsFn(jarvisAppDir)) {
    // Jarvis-Desktop is a pnpm workspace and electron is a dependency of the
    // `app` package, so the binary normally lives in app/node_modules/.bin;
    // the repo-root path is only a fallback for a hoisted install.
    const candidates = [
      path.join(jarvisAppDir, "node_modules", ".bin", "electron"),
      path.join(jarvisRoot, "node_modules", ".bin", "electron"),
    ];
    const devElectron = candidates.find((candidate) => existsFn(candidate));
    if (devElectron) {
      return { command: devElectron, args: [jarvisAppDir, HEADLESS_BACKEND_ARG], mode: "dev" };
    }
  }

  if (platform === "darwin" && existsFn(DEFAULT_PACKAGED_JARVIS)) {
    return { command: DEFAULT_PACKAGED_JARVIS, args: [HEADLESS_BACKEND_ARG], mode: "packaged" };
  }

  return null;
}

/**
 * startJarvisBackend({ launcher, spawnFn, onLog }) -> child | null
 *
 * Deliberately NOT detached: the backend belongs to this Iris session and
 * must go away with it. stdio is ignored so Jarvis's logs never interleave
 * with Iris's own.
 */
export function startJarvisBackend({ launcher, spawnFn = defaultSpawn, onLog = () => {} } = {}) {
  if (!launcher) {
    onLog("Jarvis backend not found; Connections Status will report no published snapshot.");
    return null;
  }
  try {
    const child = spawnFn(launcher.command, launcher.args, { stdio: "ignore", detached: false });
    onLog(`Jarvis backend started headless (${launcher.mode}, pid ${child?.pid ?? "?"}).`);
    return child;
  } catch (error) {
    onLog(`Jarvis backend could not be started: ${String(error?.message ?? error)}`);
    return null;
  }
}

/** stopJarvisBackend(child) — terminate only a backend WE started. */
export function stopJarvisBackend(child) {
  if (!child || child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone; nothing to clean up.
  }
  setTimeout(() => {
    if (child.exitCode == null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone; nothing to clean up.
      }
    }
  }, 3000).unref();
}
