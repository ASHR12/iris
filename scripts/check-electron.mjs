import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = fs
  .readdirSync(path.join(root, "electron"))
  .filter((file) => file.endsWith(".mjs") || file.endsWith(".cjs"))
  .sort();

for (const file of files) {
  const relative = path.join("electron", file);
  const result = spawnSync(process.execPath, ["--check", relative], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Checked ${files.length} Electron modules.`);
