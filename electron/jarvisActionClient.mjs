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
import {
  createEndpointRequest,
  createJarvisEndpointReader,
  defaultActionEndpointPath,
  DEFAULT_TIMEOUT_MS,
  NO_BACKEND_ERROR,
} from "./jarvisEndpoint.mjs";

const ROUTES = Object.freeze({
  propose: "/action/propose",
  approve: "/action/approve",
  secondaryApprove: "/action/secondary-approve",
  cancel: "/action/cancel",
});

/**
 * loadActionEndpointReader() -> () => endpoint|null
 *
 * P2.6: this used to require() JARVIS's own action-endpoint-store.cjs out of
 * a sibling source checkout, to keep ONE path rule across both processes.
 * That reasoning was right and the mechanism was wrong: a packaged Iris.app
 * has no Jarvis checkout to require(), so approvals were dead in the very
 * build that matters. The shared rule now lives in jarvisEndpoint.mjs, which
 * derives the SAME descriptor path from the OS Application Support dir (and
 * honors the same JARVIS_ENGINEERING_DIR override Jarvis honors) without
 * touching a single Jarvis file.
 */
export function loadActionEndpointReader({ onUnavailable = () => {} } = {}) {
  const storePath = defaultActionEndpointPath();
  const read = createJarvisEndpointReader({ storePath });
  return () => {
    const endpoint = read();
    if (!endpoint) onUnavailable("no-endpoint");
    return endpoint;
  };
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
  // The transport (bearer token, the deliberately absent Origin header, the
  // timeout, the error shape) lives in jarvisEndpoint.mjs and is shared with
  // the read client — one implementation, so a security property can never
  // hold on one path and not the other.
  const send = createEndpointRequest({ readEndpoint, fetchImpl, timeoutMs });

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
