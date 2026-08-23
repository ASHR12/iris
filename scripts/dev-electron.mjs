// Dev-mode launcher: starts Iris's OWN Vite dev server programmatically
// (via Vite's Node API, not the CLI + a separate "wait-on tcp:5173" race),
// so we know the EXACT origin it actually bound to, then passes that exact
// URL to Electron as VITE_DEV_SERVER_URL. This replaces a hardcoded-port
// assumption that could attach Electron to an unrelated process already
// listening on 5173 (e.g. another project's dev server) instead of Iris's
// own renderer.
//
// If 5173 is occupied, Vite's own default port-conflict handling (no
// strictPort in vite.config.ts) picks the next free port on its own — we
// never guess a port, never probe/attach to whatever already answers on
// 5173, and never touch that other process.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const electronBin = path.join(root, "node_modules", ".bin", isWindows ? "electron.cmd" : "electron");

const server = await createServer({ root, configFile: path.resolve(root, "vite.config.ts") });
await server.listen();

const address = server.httpServer?.address();
if (!address || typeof address === "string") {
  await server.close();
  throw new Error("Iris Vite dev server did not bind to a TCP port as expected.");
}
// vite.config.ts pins server.host to "127.0.0.1" — hardcoding it here too
// (rather than trusting address.address, which can report "::" / "::1"
// depending on platform) keeps this the same loopback origin Electron's
// window-security allowlist (windowSecurity.mjs trustedRendererUrl) and the
// rest of the app already assume.
const devUrl = `http://127.0.0.1:${address.port}`;
server.config.logger.info(`\n  Iris (Electron) will load: ${devUrl}\n`, { clear: false });

const env = { ...process.env, VITE_DEV_SERVER_URL: devUrl };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, ["."], { cwd: root, env, stdio: "inherit", shell: isWindows });

let shuttingDown = false;
async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.close().catch(() => {});
  process.exit(exitCode);
}

child.on("exit", (code, signal) => {
  void shutdown(signal ? 0 : (code ?? 0));
});

// Ctrl+C / termination: stop Electron first, its own "exit" handler above
// then closes the Vite server and exits this process.
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
