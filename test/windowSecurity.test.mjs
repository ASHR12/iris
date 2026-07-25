import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  installWindowSecurity,
  safeExternalUrl,
  trustedRendererUrl,
} from "../electron/windowSecurity.mjs";

test("only the packaged app and configured dev origin are trusted", () => {
  const repoRoot = path.resolve("/tmp/iris");
  const options = { repoRoot, devUrl: "http://127.0.0.1:5173" };
  assert.equal(trustedRendererUrl("http://127.0.0.1:5173/src/main.tsx", options), true);
  assert.equal(
    trustedRendererUrl(pathToFileURL(path.join(repoRoot, "dist", "index.html")).toString(), options),
    true,
  );
  assert.equal(trustedRendererUrl("https://example.com", options), false);
  assert.equal(safeExternalUrl("javascript:alert(1)"), null);
  assert.equal(safeExternalUrl("https://example.com/path"), "https://example.com/path");
});

test("new windows are denied and external navigation leaves Electron", async () => {
  let openHandler;
  let navigateHandler;
  const opened = [];
  const win = {
    webContents: {
      setWindowOpenHandler(handler) {
        openHandler = handler;
      },
      on(name, handler) {
        if (name === "will-navigate") navigateHandler = handler;
      },
    },
  };
  installWindowSecurity(win, {
    repoRoot: "/tmp/iris",
    devUrl: "http://127.0.0.1:5173",
    shell: { openExternal: async (url) => opened.push(url) },
  });
  assert.deepEqual(openHandler({ url: "https://example.com" }), { action: "deny" });
  let prevented = false;
  navigateHandler({ preventDefault: () => (prevented = true) }, "https://example.org");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.deepEqual(opened, ["https://example.com/", "https://example.org/"]);
});
