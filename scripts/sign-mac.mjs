import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") process.exit(0);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const identity = process.env.IRIS_MAC_SIGNING_IDENTITY || "Local Development";
const appPath = ["mac-arm64", "mac", "mac-x64"]
  .map((dir) => path.join(root, "release", dir, "Iris.app"))
  .find((candidate) => fs.existsSync(candidate));

if (!appPath) throw new Error("No packaged Iris.app found to sign.");

const identities = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
  encoding: "utf8",
});
if (identities.status !== 0 || !identities.stdout.includes(`"${identity}"`)) {
  console.warn(`⚠ Code-signing identity "${identity}" is unavailable; leaving the local build unsigned.`);
  process.exit(0);
}

const sign = spawnSync(
  "codesign",
  ["--force", "--deep", "--sign", identity, "--timestamp=none", appPath],
  { stdio: "inherit" },
);
if (sign.status !== 0) throw new Error(`codesign failed with exit code ${sign.status}.`);

const verify = spawnSync(
  "codesign",
  ["--verify", "--deep", "--strict", "--verbose=2", appPath],
  { stdio: "inherit" },
);
if (verify.status !== 0) throw new Error(`codesign verification failed with exit code ${verify.status}.`);

console.log(`✓ Signed Iris with "${identity}"`);
