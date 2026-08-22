/*
 * Jarvis Bridge client — the Iris-side half of the thin adapter between
 * Iris's voice pipeline and Jarvis's existing Ask Jarvis pipeline.
 *
 * Jarvis and Iris are two separate local Electron apps/processes. There is
 * no cross-process transport built for this round, so this module reaches
 * Jarvis's already-shipped, already-tested askJarvis() the most direct way
 * available: a plain Node require() of Jarvis's own adapter module
 * (Jarvis-Desktop/app/adapter/iris-bridge.cjs), loaded in-process from
 * Iris's Electron main process. This executes Jarvis's real code, unmodified
 * and unduplicated — never a second retrieval/model/memory pipeline.
 */
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { decideTurnOwner } from "./routingPolicy.mjs";

const defaultRequire = createRequire(import.meta.url);

export function shouldAskJarvis(route) {
  return decideTurnOwner(route) === "jarvis";
}

export function defaultJarvisBridgePath(repoRoot) {
  if (process.env.JARVIS_BRIDGE_PATH) return process.env.JARVIS_BRIDGE_PATH;
  return path.resolve(repoRoot, "..", "Jarvis-Desktop", "app", "adapter", "iris-bridge.cjs");
}

// Never throws: an unreachable/missing Jarvis checkout must degrade to "no
// bridge", not crash Iris's voice pipeline.
export function loadJarvisBridge(
  repoRoot,
  { requireFn = defaultRequire, existsFn = fs.existsSync, onUnavailable = () => {} } = {}
) {
  const bridgePath = defaultJarvisBridgePath(repoRoot);
  if (!existsFn(bridgePath)) {
    onUnavailable("missing");
    return null;
  }
  try {
    const { createIrisBridge } = requireFn(bridgePath);
    return createIrisBridge();
  } catch {
    onUnavailable("require-error");
    return null;
  }
}

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
