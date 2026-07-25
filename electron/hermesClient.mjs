const RETRY_DELAYS_MS = [250, 800, 1800];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HermesHttpError extends Error {
  constructor(message, { status = 0, body = "", code = "", cause } = {}) {
    super(message, { cause });
    this.name = "HermesHttpError";
    this.status = status;
    this.body = body;
    this.code = code;
  }

  get authenticationFailure() {
    return this.status === 401 || this.status === 403;
  }

  get retriable() {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export function stableHermesMemoryKey(value) {
  const identity = String(value || "local-user")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
  return `iris:desktop:${identity || "local-user"}`;
}

function combineSignal(controller, externalSignal) {
  if (!externalSignal) return () => {};
  if (externalSignal.aborted) {
    controller.abort(externalSignal.reason);
    return () => {};
  }
  const abort = () => controller.abort(externalSignal.reason);
  externalSignal.addEventListener("abort", abort, { once: true });
  return () => externalSignal.removeEventListener("abort", abort);
}

function parsePayload(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export class HermesClient {
  constructor({
    baseUrl,
    apiKey,
    sessionKey,
    fetchImpl = globalThis.fetch,
    defaultTimeoutMs = 10000,
  }) {
    this.baseUrl = String(baseUrl || "http://127.0.0.1:8642").replace(/\/$/, "");
    this.apiKey = String(apiKey || "");
    this.sessionKey = String(sessionKey || "");
    this.fetchImpl = fetchImpl;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.capabilityCache = null;
  }

  headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...(this.sessionKey ? { "X-Hermes-Session-Key": this.sessionKey } : {}),
      ...extra,
    };
  }

  async request(method, pathName, body = undefined, options = {}) {
    const upperMethod = String(method || "GET").toUpperCase();
    const retries =
      options.retries ?? (upperMethod === "GET" || upperMethod === "HEAD" ? RETRY_DELAYS_MS.length : 0);
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const detach = combineSignal(controller, options.signal);
      const timeout = setTimeout(
        () => controller.abort(new Error(`Hermes request timed out after ${options.timeoutMs ?? this.defaultTimeoutMs}ms`)),
        options.timeoutMs ?? this.defaultTimeoutMs,
      );
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${pathName}`, {
          method: upperMethod,
          headers: this.headers(
            options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {},
          ),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await response.text();
        const payload = parsePayload(text);
        if (!response.ok) {
          const apiMessage =
            payload?.error?.message || payload?.error || payload?.message || text || response.statusText;
          throw new HermesHttpError(`Hermes ${response.status}: ${String(apiMessage).slice(0, 500)}`, {
            status: response.status,
            body: text,
            code: payload?.error?.code || payload?.code || "",
          });
        }
        return payload;
      } catch (error) {
        if (error instanceof HermesHttpError) {
          lastError = error;
        } else {
          const aborted = controller.signal.aborted;
          lastError = new HermesHttpError(
            aborted
              ? controller.signal.reason?.message || "Hermes request aborted"
              : `Hermes is not reachable: ${error?.message || String(error)}`,
            { cause: error },
          );
        }
        if (
          attempt >= retries ||
          options.signal?.aborted ||
          !lastError.retriable
        ) {
          throw lastError;
        }
        const baseDelay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        await sleep(baseDelay + Math.floor(Math.random() * 100));
      } finally {
        clearTimeout(timeout);
        detach();
      }
    }
    throw lastError ?? new HermesHttpError("Hermes request failed");
  }

  async capabilities({ force = false, signal } = {}) {
    const now = Date.now();
    if (!force && this.capabilityCache && now - this.capabilityCache.at < 60000) {
      return this.capabilityCache.value;
    }
    const value = await this.request("GET", "/v1/capabilities", undefined, {
      signal,
      timeoutMs: 8000,
      retries: 1,
    });
    this.capabilityCache = { at: now, value };
    return value;
  }

  async verify(options = {}) {
    const capabilities = await this.capabilities({ force: true, signal: options.signal });
    return {
      ok: true,
      capabilities,
      version:
        capabilities?.version ||
        capabilities?.server?.version ||
        capabilities?.platform_version ||
        "",
    };
  }
}
