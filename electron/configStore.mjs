import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function parseEnvFile(envPath, target = process.env) {
  if (!envPath || !fs.existsSync(envPath)) return;
  const contents = fs.readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (!key || target[key]) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    target[key] = value;
  }
}

export function loadEnvFiles({ repoRoot, resourcesPath, target = process.env }) {
  const candidates = [
    path.join(repoRoot, ".env"),
    userConfigPath(),
    resourcesPath ? path.join(resourcesPath, ".env") : null,
  ];
  for (const candidate of candidates) parseEnvFile(candidate, target);
  try {
    if (fs.existsSync(userConfigPath())) fs.chmodSync(userConfigPath(), 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
}

export function envFlag(name, fallback = false, source = process.env) {
  const value = source[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

export function resolveConfigPath(value, repoRoot) {
  if (!value) return null;
  let resolved = String(value).trim();
  if (!resolved) return null;
  if (resolved.startsWith("~")) resolved = path.join(os.homedir(), resolved.slice(1));
  if (!path.isAbsolute(resolved)) resolved = path.join(repoRoot, resolved);
  return resolved;
}

export function userConfigPath() {
  return path.join(os.homedir(), ".iris", ".env");
}

function serializeConfigValue(value) {
  const str = String(value ?? "").trim();
  return /[\s"#]/.test(str) ? `"${str.replace(/"/g, '\\"')}"` : str;
}

export function writeEnvUpdates({
  rawUpdates,
  allowedKeys,
  secretKeys = new Set(),
  target = process.env,
  file = userConfigPath(),
}) {
  const updates = {};
  for (const [key, value] of Object.entries(rawUpdates || {})) {
    if (!allowedKeys.has(key)) continue;
    if (secretKeys.has(key) && !String(value ?? "").trim() && target[key]) continue;
    updates[key] = value;
  }
  if (!Object.keys(updates).length) return {};

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const remaining = new Set(Object.keys(updates));
  const out = [];
  for (const line of existing) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    const eq = trimmed.indexOf("=");
    const key = eq === -1 ? trimmed : trimmed.slice(0, eq).trim();
    if (remaining.has(key)) {
      out.push(`${key}=${serializeConfigValue(updates[key])}`);
      remaining.delete(key);
    } else {
      out.push(line);
    }
  }
  for (const key of remaining) out.push(`${key}=${serializeConfigValue(updates[key])}`);

  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${out.join("\n").replace(/\n+$/, "")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Filesystem may not support POSIX permissions.
  }
  for (const [key, value] of Object.entries(updates)) target[key] = String(value ?? "").trim();
  return updates;
}
