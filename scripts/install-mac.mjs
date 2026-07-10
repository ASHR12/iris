// Install the freshly packaged Iris.app into /Applications so it launches
// from Finder/Launchpad like any normal macOS app.
//
// Usage:
//   npm run install:mac                (build + package + install + launch)
//   node scripts/install-mac.mjs       (install the last packaged build)
//   node scripts/install-mac.mjs --no-launch
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "release");
const DEST = "/Applications/Iris.app";
const IRIS_EXECUTABLE_RE = "^/Applications/Iris\\.app/Contents/MacOS/Iris$";

function isInstalledIrisRunning() {
  const probe = spawnSync("pgrep", ["-f", IRIS_EXECUTABLE_RE], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

async function waitFor(check, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check() === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return check() === expected;
}

if (process.platform !== "darwin") {
  console.error("install:mac only works on macOS.");
  process.exit(1);
}

// electron-builder outputs per-arch folders; take whichever exists.
const appPath = ["mac-arm64", "mac", "mac-x64"]
  .map((dir) => path.join(releaseDir, dir, "Iris.app"))
  .find((candidate) => fs.existsSync(candidate));

if (!appPath) {
  console.error("No packaged Iris.app found in release/. Run: npm run package:mac");
  process.exit(1);
}

// Quit a running installed Iris before replacing it (ignore if not running).
// Targets the app bundle by name only — never other Electron processes.
spawnSync("osascript", ["-e", 'tell application "Iris" to quit'], { stdio: "ignore" });
if (!(await waitFor(isInstalledIrisRunning, false, 10000))) {
  throw new Error("The running Iris instance did not quit in time; installation was cancelled.");
}

if (fs.existsSync(DEST)) {
  fs.rmSync(DEST, { recursive: true, force: true });
}

// ditto preserves the bundle structure, symlinks, and permissions.
execSync(`ditto "${appPath}" "${DEST}"`, { stdio: "inherit" });
// Clear any quarantine/extended attributes so Gatekeeper never nags.
execSync(`xattr -cr "${DEST}"`);

console.log(`✓ Installed ${DEST}`);

if (!process.argv.includes("--no-launch")) {
  // Cursor/CI shells may export ELECTRON_RUN_AS_NODE=1. Passing that through
  // LaunchServices starts Iris as a headless Node process with no window.
  const launchEnv = { ...process.env };
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  const launched = spawnSync("open", [DEST], {
    env: launchEnv,
    stdio: "inherit",
  });
  if (launched.status !== 0) {
    throw new Error(`Could not launch Iris (open exited ${launched.status}).`);
  }
  if (!(await waitFor(isInstalledIrisRunning, true, 10000))) {
    throw new Error("LaunchServices returned success, but the Iris process did not start.");
  }
  console.log("✓ Launched Iris");
}
