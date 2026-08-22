/*
 * Jarvis Action client — the Iris-side half of Action Transport v2 (P2.5).
 *
 * WHY THIS EXISTS AT ALL. jarvisBridgeClient.mjs reaches Jarvis by
 * require()ing Jarvis's adapter module IN THE IRIS PROCESS. That is correct
 * for READS (Ask Jarvis, Personal OS, jobs, goals, connections snapshot):
 * they touch no approval state and no credentials. It is exactly WRONG for
 * write actions — an in-process require gives Iris its own
 * personal-os-action-service.cjs instance, i.e. a SECOND actionPreviews Map,
 * a SECOND approval state machine and a secondary-approval gate that nobody
 * else can see. And it could never execute a real Drive/Calendar write
 * anyway: those credentials are safeStorage/Keychain-scoped to the Jarvis
 * app identity, which Iris (its own app, its own --user-data-dir) can never
 * assume.
 *
 * So propose/approve/secondaryApprove/cancel do NOT run here. They are sent
 * to the ONE running Jarvis backend process over its loopback Action
 * endpoint (Jarvis-Desktop/app/action-bridge-server.cjs) and executed there.
 * This module owns no previewId list, no approval stage, no credentials and
 * no execution state. A previewId is an opaque handle that is only ever
 * meaningful inside Jarvis's own Action Service.
 *
 * Never throws: every failure — no Jarvis running, a dead port, a rejected
 * token, a garbage response, a hang — comes back as {ok:false, error} so the
 * renderer can show it. None of them may ever look like a successful
 * approval.
 */
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const defaultRequire = createRequire(import.meta.url);

// 10s is generous for a local vault write and still short enough that a
// wedged backend never leaves an approval button spinning forever. Drive/
// Calendar executions go through Jarvis's own already-bounded HTTP calls.
const DEFAULT_TIMEOUT_MS = 10000;

const ROUTES = Object.freeze({
  propose: "/action/propose",
  approve: "/action/approve",
  secondaryApprove: "/action/secondary-approve",
  cancel: "/action/cancel",
});

const NO_BACKEND_ERROR = "Jarvis-Backend läuft nicht — keine Action möglich.";

/** Mirrors defaultJarvisBridgePath() in jarvisBridgeClient.mjs, one file over. */
export function defaultActionEndpointStorePath(repoRoot) {
  if (process.env.JARVIS_ACTION_ENDPOINT_STORE) return process.env.JARVIS_ACTION_ENDPOINT_STORE;
  return path.resolve(repoRoot, "..", "Jarvis-Desktop", "app", "action-endpoint-store.cjs");
}

/**
 * loadActionEndpointReader(repoRoot) -> () => endpoint|null
 *
 * Deliberately require()s JARVIS's own action-endpoint-store.cjs rather than
 * re-deriving the descriptor path and re-implementing its validation here:
 * that module is pure fs+JSON (no action state, no credentials, no approval
 * logic), so reusing it keeps ONE path rule and ONE validation rule across
 * both processes. A missing Jarvis checkout degrades to "no endpoint" —
 * never a crash, never a guessed path.
 */
export function loadActionEndpointReader(
  repoRoot,
  { requireFn = defaultRequire, existsFn = fs.existsSync, onUnavailable = () => {} } = {},
) {
  const storeModulePath = defaultActionEndpointStorePath(repoRoot);
  if (!existsFn(storeModulePath)) {
    onUnavailable("missing");
    return () => null;
  }
  try {
    const { readActionEndpoint, DEFAULT_ACTION_ENDPOINT_PATH } = requireFn(storeModulePath);
    return () => {
      try {
        return readActionEndpoint({ storePath: DEFAULT_ACTION_ENDPOINT_PATH });
      } catch {
        return null;
      }
    };
  } catch {
    onUnavailable("require-error");
    return () => null;
  }
}

function failure(error) {
  return { ok: false, error: String(error) };
}

/**
 * createJarvisActionClient({ readEndpoint, fetchImpl, timeoutMs })
 *
 * readEndpoint is called on EVERY request, never cached: Jarvis restarts on
 * a new ephemeral port with a new token, and a cached descriptor would
 * outlive the process that published it.
 */
export function createJarvisActionClient({
  readEndpoint,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  async function send(route, payload) {
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
        // No Origin header: Jarvis's endpoint refuses any request that
        // carries one (that is its guard against local browser pages).
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      let body;
      try {
        body = await response.json();
      } catch {
        return failure(`Jarvis-Backend antwortete unlesbar (HTTP ${response.status}).`);
      }
      if (!response.ok) {
        return failure(body?.error ? `${body.error} (HTTP ${response.status})` : `Jarvis-Backend antwortete HTTP ${response.status}.`);
      }
      return body;
    } catch (error) {
      return failure(error?.name === "AbortError"
        ? `Jarvis-Backend hat nicht innerhalb von ${timeoutMs} ms geantwortet.`
        : String(error?.message ?? error));
    } finally {
      clearTimeout(timer);
    }
  }

  function withPreviewId(route, previewId) {
    const id = typeof previewId === "string" ? previewId.trim() : "";
    if (!id) return Promise.resolve(failure("previewId fehlt."));
    return send(route, { previewId: id });
  }

  return {
    /** Propose a write action from natural text. kind:"none" means "not an
     *  action" — the caller then falls through to the normal Ask Jarvis path. */
    proposeAction(question, { source = "text" } = {}) {
      const text = typeof question === "string" ? question.trim() : "";
      if (!text) return Promise.resolve(failure("Frage fehlt."));
      return send(ROUTES.propose, { question: text, source });
    },
    /** First approval. For a high-risk action this only advances Jarvis's own
     *  state machine to secondary_approval_required and writes NOTHING. */
    approveAction(previewId) {
      return withPreviewId(ROUTES.approve, previewId);
    },
    /** The second, distinct approval — the only thing that completes a
     *  destructive action (Drive Trash, Calendar Delete). */
    secondaryApproveAction(previewId) {
      return withPreviewId(ROUTES.secondaryApprove, previewId);
    },
    cancelAction(previewId) {
      return withPreviewId(ROUTES.cancel, previewId);
    },
  };
}

export { ROUTES as JARVIS_ACTION_ROUTES, NO_BACKEND_ERROR };
