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
await new Promise((resolve) => setTimeout(resolve, 1500));

if (fs.existsSync(DEST)) {
  fs.rmSync(DEST, { recursive: true, force: true });
}

// ditto preserves the bundle structure, symlinks, and permissions.
execSync(`ditto "${appPath}" "${DEST}"`, { stdio: "inherit" });
// Clear any quarantine/extended attributes so Gatekeeper never nags.
execSync(`xattr -cr "${DEST}"`);

console.log(`✓ Installed ${DEST}`);

if (!process.argv.includes("--no-launch")) {
  execSync(`open "${DEST}"`);
  console.log("✓ Launched Iris");
}
