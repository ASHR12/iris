/*
 * jarvisEndpoint.mjs — how a PACKAGED Iris finds and talks to the one running
 * Jarvis backend (P2.6).
 *
 * THE PROBLEM THIS SOLVES. jarvisBridgeClient.mjs and jarvisActionClient.mjs
 * both used to locate Jarvis by walking to a SOURCE CHECKOUT:
 * path.resolve(repoRoot, "..", "Jarvis-Desktop", "app", ...). In a packaged
 * Iris.app repoRoot is <Iris.app>/Contents/Resources/app.asar, so that path
 * points at <Iris.app>/Contents/Resources/Jarvis-Desktop — a directory that
 * does not exist. Every read and every approval failed in the packaged app
 * while working perfectly in dev. Iris now depends on no Jarvis file at all.
 *
 * WHAT REPLACES IT. Jarvis publishes a descriptor (url + per-process bearer
 * token) for its loopback endpoint into its own runtime dir. That file is a
 * CROSS-PROCESS CONTRACT, the same way a socket path is: Jarvis writes it
 * (action-endpoint-store.cjs), Iris reads it, and both derive its location
 * from the OS Application Support dir rather than from each other's code. So
 * it resolves identically whether either side runs from source or a bundle.
 *
 * WHY IRIS RE-VALIDATES THE URL. Jarvis refuses to PUBLISH a non-loopback
 * descriptor. Iris independently refuses to USE one. That is not duplicated
 * logic but a second, load-bearing check on the side that holds the secret:
 * whatever wrote that file must never be able to make Iris POST a bearer
 * token off-machine.
 *
 * Never throws. Every failure — no Jarvis running, a stale port, a rejected
 * token, a garbage response, a hang — comes back as {ok:false, error} so the
 * renderer can show it. None may ever look like success.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Long enough for a real local vault write or a bounded Drive/Calendar call,
// short enough that a wedged backend never spins an approval button forever.
const DEFAULT_TIMEOUT_MS = 10_000;

// Only these hosts may ever be dialled — mirrors the LOOPBACK_HOSTS set
// Jarvis refuses to publish outside of.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const NO_BACKEND_ERROR = "Jarvis-Backend läuft nicht — keine Verbindung möglich.";

/** The OS default Electron itself uses for appData; recomputed here so Iris
 *  never has to ask Jarvis's Electron instance where its profile lives. */
function applicationSupportDir(platform, home, env) {
  if (platform === "darwin") return path.join(home, "Library", "Application Support");
  if (platform === "win32") return env.APPDATA || path.join(home, "AppData", "Roaming");
  return env.XDG_CONFIG_HOME || path.join(home, ".config");
}

/**
 * defaultActionEndpointPath(env, platform, home) -> absolute descriptor path.
 *
 * JARVIS_ACTION_ENDPOINT names the descriptor outright; JARVIS_ENGINEERING_DIR
 * is the SAME override Jarvis's engineering-runtime-paths.cjs honors, so a
 * smoke test can point both processes at one throwaway directory with a
 * single variable and never touch the real runtime dir.
 */
export function defaultActionEndpointPath(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.JARVIS_ACTION_ENDPOINT) return env.JARVIS_ACTION_ENDPOINT;
  const runtimeDir = env.JARVIS_ENGINEERING_DIR
    || path.join(applicationSupportDir(platform, home, env), "Jarvis", "jarvis-engineering");
  return path.join(runtimeDir, "action-endpoint.json");
}

function isLoopbackUrl(value) {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

function isValidEndpoint(endpoint) {
  return Boolean(
    endpoint
    && typeof endpoint === "object"
    && !Array.isArray(endpoint)
    && typeof endpoint.url === "string"
    && endpoint.url
    && typeof endpoint.token === "string"
    && endpoint.token
    && isLoopbackUrl(endpoint.url),
  );
}

/**
 * readJarvisEndpoint({ storePath }) -> descriptor | null
 *
 * null means "no reachable Jarvis backend" and must be surfaced as an honest
 * error by the caller — never as a fabricated endpoint or an empty success.
 */
export function readJarvisEndpoint({ storePath = defaultActionEndpointPath() } = {}) {
  let parsed;
  try {
    if (!fs.existsSync(storePath)) return null;
    parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
  } catch {
    return null;
  }
  return isValidEndpoint(parsed) ? parsed : null;
}

/**
 * createJarvisEndpointReader({ storePath }) -> () => descriptor | null
 *
 * Deliberately re-reads on every call and caches nothing: Jarvis restarts on
 * a new ephemeral port with a new token, and a cached descriptor would
 * outlive the process that published it.
 */
export function createJarvisEndpointReader({ storePath = defaultActionEndpointPath() } = {}) {
  return () => readJarvisEndpoint({ storePath });
}

function failure(error) {
  return { ok: false, error: String(error) };
}

/**
 * createEndpointRequest({ readEndpoint, fetchImpl, timeoutMs })
 *   -> request(route, payload, { timeoutMs }) -> Jarvis's body | {ok:false, error}
 *
 * The ONE place Iris speaks to the Jarvis backend. Both the read client and
 * the action client go through it, so the token handling, the deliberate
 * absence of an Origin header (Jarvis refuses any request carrying one), the
 * timeout behaviour and the error shape exist exactly once.
 */
export function createEndpointRequest({
  readEndpoint,
  fetchImpl = globalThis.fetch,
  timeoutMs: defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return async function request(route, payload, { timeoutMs = defaultTimeoutMs } = {}) {
    let endpoint = null;
    try {
      endpoint = readEndpoint?.();
    } catch {
      endpoint = null;
    }
    if (!endpoint?.url || !endpoint?.token) return failure(NO_BACKEND_ERROR);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${endpoint.url}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal,
      });
      let body;
      try {
        body = await response.json();
      } catch {
        return failure(`Jarvis-Backend antwortete unlesbar (HTTP ${response.status}).`);
      }
      if (!response.ok) {
        return failure(body?.error
          ? `${body.error} (HTTP ${response.status})`
          : `Jarvis-Backend antwortete HTTP ${response.status}.`);
      }
      return body;
    } catch (error) {
      return failure(error?.name === "AbortError"
        ? `Jarvis-Backend hat nicht innerhalb von ${timeoutMs} ms geantwortet.`
        : String(error?.message ?? error));
    } finally {
      clearTimeout(timer);
    }
  };
}

export { DEFAULT_TIMEOUT_MS, NO_BACKEND_ERROR };
