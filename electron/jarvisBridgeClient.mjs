/*
 * Jarvis Bridge client — the Iris-side half of the thin adapter between
 * Iris's voice pipeline and Jarvis's existing Ask Jarvis pipeline.
 *
 * HOW THIS USED TO WORK, AND WHY IT CHANGED (P2.6). Jarvis and Iris are two
 * separate local Electron apps. This module used to reach Jarvis's
 * already-shipped askJarvis() with a plain Node require() of Jarvis's adapter
 * (Jarvis-Desktop/app/adapter/iris-bridge.cjs) IN THE IRIS MAIN PROCESS.
 * Two things were wrong with that:
 *
 *  1. It only ever resolved from a SOURCE CHECKOUT. A packaged Iris.app has
 *     no sibling Jarvis-Desktop directory, so every read — Ask Jarvis,
 *     Connections Status, Work Stream, jobs, goals — failed there while
 *     working perfectly in dev.
 *  2. It booted a SECOND in-process Jarvis runtime inside Iris. Reads touch
 *     no approval state, so that was survivable, but it was still a second
 *     retrieval/model/memory pipeline in the wrong process — and one with no
 *     access to Jarvis's safeStorage/Keychain-scoped credentials.
 *
 * Reads now travel the SAME loopback endpoint the write actions already use
 * (jarvisActionClient.mjs, Jarvis's action-bridge-server.cjs): one running
 * Jarvis backend process, one bearer token, one pipeline. Iris requires no
 * Jarvis file at all any more.
 *
 * WHAT DID NOT CHANGE. Every *ForRenderer function below keeps its exact
 * never-throws, forward-{ok,...}-as-is contract, and the bridge object they
 * take still exposes the same method names as Jarvis's own bridge — so the
 * IPC contract, the renderer and the security boundary are untouched.
 */
import { decideTurnOwner } from "./routingPolicy.mjs";
import { createEndpointRequest } from "./jarvisEndpoint.mjs";

/* Ask Jarvis runs real retrieval and a model call, so it needs far more room
 * than an approval round-trip. Still bounded: a wedged backend must surface
 * as an honest error, never as a Comms bubble that spins forever. */
const ASK_TIMEOUT_MS = 120_000;

// The route table Jarvis's action-bridge-server.cjs serves (READ_BRIDGE_ROUTES
// there). Kept next to the calls so a rename on either side fails loudly in
// the smoke test rather than silently degrading to "Jarvis not available".
const READ_ROUTES = Object.freeze({
  ask: "/read/ask",
  connectionsStatus: "/read/connections-status",
  tasks: "/read/tasks",
  topFocus: "/read/top-focus",
  currentContext: "/read/current-context",
  latestEngineeringJob: "/read/latest-engineering-job",
  activeGoal: "/read/active-goal",
});

export function shouldAskJarvis(route) {
  return decideTurnOwner(route) === "jarvis";
}

/**
 * createJarvisBridge({ readEndpoint, request }) -> bridge
 *
 * Returns an object with the SAME method names as Jarvis's own in-process
 * bridge, so every *ForRenderer function below (and their tests) stay
 * unaware of the transport. It holds no state, no credentials and no cached
 * endpoint: the descriptor is re-read per request, because a restarted
 * Jarvis has a new port and a new token.
 */
export function createJarvisBridge({ readEndpoint, request } = {}) {
  const send = request || createEndpointRequest({ readEndpoint });
  const readData = (route) => send(route, {});
  return {
    askJarvis: (question) => send(READ_ROUTES.ask, { question }, { timeoutMs: ASK_TIMEOUT_MS }),
    getConnectionsStatus: () => readData(READ_ROUTES.connectionsStatus),
    getTasks: () => readData(READ_ROUTES.tasks),
    getTopFocus: () => readData(READ_ROUTES.topFocus),
    getCurrentContext: () => readData(READ_ROUTES.currentContext),
    getLatestEngineeringJob: () => readData(READ_ROUTES.latestEngineeringJob),
    getActiveGoal: () => readData(READ_ROUTES.activeGoal),
  };
}

export { READ_ROUTES as JARVIS_READ_ROUTES, ASK_TIMEOUT_MS };

// Never throws, never returns a blank/empty answer as success — a Comms
// bubble with no text would be a silent, confusing failure. Also the
// request/response IPC contract boundary: intentionally reconstructs
// {ok, answer|error} rather than spreading the raw askJarvis() result, so
// none of Jarvis's internal fields (sources, timings, mail/drive status,
// model name, ...) ever cross into the renderer.
export async function askJarvisForTurn(bridge, text) {
  if (!bridge) return { ok: false, error: "Jarvis Bridge nicht verfügbar." };
  try {
    const result = await bridge.askJarvis(text);
    if (result?.ok && typeof result.answer === "string" && result.answer) {
      return { ok: true, answer: result.answer };
    }
    return { ok: false, error: result?.error || "Jarvis-Anfrage ohne Antwort." };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// getTasksForRenderer/getTopFocusForRenderer/getCurrentContextForRenderer —
// the same never-throws, forward-the-bridge's-{ok,...}-result-as-is contract
// as askJarvisForTurn above, for the three read-only Personal OS bridge
// methods (getTasks/getTopFocus/getCurrentContext). No re-derivation, no
// invented fallback data: an unavailable bridge or reader surfaces as
// {ok:false, error}, never a silently empty/demo Work Stream or focus panel.
export async function getTasksForRenderer(bridge) {
  if (!bridge) return { ok: false, error: "Jarvis Bridge nicht verfügbar." };
  try {
    return bridge.getTasks();
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

export async function getTopFocusForRenderer(bridge) {
  if (!bridge) return { ok: false, error: "Jarvis Bridge nicht verfügbar." };
  try {
    return await bridge.getTopFocus();
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

export async function getCurrentContextForRenderer(bridge) {
  if (!bridge) return { ok: false, error: "Jarvis Bridge nicht verfügbar." };
  try {
    return await bridge.getCurrentContext();
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// getLatestEngineeringJobForRenderer/getActiveGoalForRenderer — same
// never-throws, forward-the-bridge's-{ok,...}-result-as-is contract as the
// three Personal OS readers above, for Jarvis V1's autonomous engineering
// read surface (bridge.getLatestEngineeringJob/getActiveGoal — see
// Jarvis-Desktop/app/adapter/iris-bridge.cjs). A job already carries
// status/workerKind/attemptCount/verification/promotion/events verbatim;
// no re-derivation here, no invented "no job"/"no goal" fallback data.
export async function getLatestEngineeringJobForRenderer(bridge) {
  if (!bridge) return { ok: false, error: "Jarvis Bridge nicht verfügbar." };
  try {
    return bridge.getLatestEngineeringJob();
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

export async function getActiveGoalForRenderer(bridge) {
  if (!bridge) return { ok: false, error: "Jarvis Bridge nicht verfügbar." };
  try {
    return bridge.getActiveGoal();
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// getConnectionsStatusForRenderer() — Jarvis Integrations/Connections
// readout (P2.4). Same never-throws, forward-the-bridge's-{ok,...}-result-
// as-is contract as every other *ForRenderer function above: no bridge is
// itself a distinct, honest {ok:false} rather than a silently empty list.
export async function getConnectionsStatusForRenderer(bridge) {
  if (!bridge) return { ok: false, error: "Jarvis Bridge nicht verfügbar." };
  try {
    return await bridge.getConnectionsStatus();
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// Pure: builds the [you, jarvis|jarvis-error] pair the renderer appends to
// the existing Comms transcript for a request/response askJarvis call.
// "jarvis-error" is a distinct speaker value (never silently reused as
// "jarvis") so a failure is never visually indistinguishable from a real
// answer — see requirement #9, "Fehler müssen sichtbar und eindeutig
// propagiert werden".
export function describeSmokeTranscript(question, result) {
  return [
    { speaker: "you", text: question },
    result.ok
      ? { speaker: "jarvis", text: result.answer }
      : { speaker: "jarvis-error", text: `Jarvis-Anfrage fehlgeschlagen: ${result.error}` },
  ];
}
