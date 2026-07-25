import path from "node:path";
import { pathToFileURL } from "node:url";

export function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function trustedRendererUrl(value, { repoRoot, devUrl }) {
  try {
    const url = new URL(String(value || ""));
    if (devUrl) {
      const allowedDev = new URL(devUrl);
      if (url.origin === allowedDev.origin) return true;
    }
    const distRoot = pathToFileURL(path.join(repoRoot, "dist") + path.sep).toString();
    return url.protocol === "file:" && url.toString().startsWith(distRoot);
  } catch {
    return false;
  }
}

export function assertTrustedIpc(event, options) {
  const url = event?.senderFrame?.url || event?.sender?.getURL?.() || "";
  if (!trustedRendererUrl(url, options)) {
    const error = new Error(`Rejected IPC from untrusted renderer: ${String(url).slice(0, 160)}`);
    error.code = "UNTRUSTED_IPC_SENDER";
    throw error;
  }
}

export function installWindowSecurity(win, { repoRoot, devUrl, shell }) {
  const options = { repoRoot, devUrl };
  win.webContents.setWindowOpenHandler(({ url }) => {
    const external = safeExternalUrl(url);
    if (external) void shell.openExternal(external);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (trustedRendererUrl(url, options)) return;
    event.preventDefault();
    const external = safeExternalUrl(url);
    if (external) void shell.openExternal(external);
  });
}

export function mediaPermissionAllowed(webContents, permission, options) {
  const allowed = new Set(["media", "audioCapture", "videoCapture"]);
  return allowed.has(permission) && trustedRendererUrl(webContents?.getURL?.(), options);
}
