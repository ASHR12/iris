import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { HermesGatewayRpcError } from "./hermesGatewayClient.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled", "canceled", "error"]);

function promptForTask(task, instructions) {
  return [
    "<iris_background_task>",
    String(task || "").trim(),
    "</iris_background_task>",
    "",
    "<iris_task_guidance>",
    String(instructions || "").trim(),
    "</iris_task_guidance>",
  ].join("\n");
}

export class HermesInteractiveTransport extends EventEmitter {
  constructor({ client, log = () => {}, defaultCwd = "" }) {
    super();
    this.client = client;
    this.log = log;
    this.defaultCwd = defaultCwd;
    this.sessions = new Map();
    this.liveSessions = new Map();
    this.runs = new Map();
    this.reconnectTimer = null;
    client.on("event", (event) => this.#onEvent(event));
    client.on("disconnected", () => this.#scheduleReconnect());
    client.on("backend-exit", (detail) => this.#onBackendExit(detail));
  }

  async start() {
    await this.client.start();
    return this;
  }

  async createSession() {
    const result = await this.client.request(
      "session.create",
      {
        source: "iris",
        close_on_disconnect: false,
        cols: 110,
        ...(this.defaultCwd ? { cwd: this.defaultCwd } : {}),
      },
      { timeoutMs: 45000 },
    );
    const state = this.#registerSession({
      storedId: result.stored_session_id,
      liveId: result.session_id,
    });
    return { id: state.storedId, liveSessionId: state.liveId };
  }

  async deleteSession(storedId) {
    const state = this.sessions.get(String(storedId || ""));
    if (!state) return { deleted: false };
    if (state.current || state.queue.length) {
      throw new Error("Cannot delete an active Hermes session.");
    }
    await this.client.request("session.close", { session_id: state.liveId }).catch(() => undefined);
    const result = await this.client.request("session.delete", {
      session_id: state.storedId,
    });
    this.liveSessions.delete(state.liveId);
    this.sessions.delete(state.storedId);
    return result;
  }

  async ensureSession(storedId) {
    const requested = String(storedId || "").trim();
    const existing = requested ? this.sessions.get(requested) : null;
    if (existing?.liveId) return existing;
    if (requested) {
      try {
        const resumed = await this.client.request(
          "session.resume",
          {
            session_id: requested,
            source: "iris",
            close_on_disconnect: false,
            cols: 110,
          },
          { timeoutMs: 45000 },
        );
        return this.#registerSession({
          storedId: resumed.resumed || resumed.session_key || requested,
          liveId: resumed.session_id,
        });
      } catch (error) {
        if (!(error instanceof HermesGatewayRpcError) || error.code !== 4007) throw error;
      }
    }
    const created = await this.createSession();
    return this.sessions.get(created.id);
  }

  #registerSession({ storedId, liveId, liveSessionId }) {
    const resolvedLiveId = liveId || liveSessionId;
    const resolvedStoredId = String(storedId || "").trim();
    let state = this.sessions.get(resolvedStoredId);
    if (!state) {
      state = {
        storedId: resolvedStoredId,
        liveId: resolvedLiveId,
        queue: [],
        current: null,
      };
      this.sessions.set(resolvedStoredId, state);
    } else {
      if (state.liveId) this.liveSessions.delete(state.liveId);
      state.liveId = resolvedLiveId;
    }
    this.liveSessions.set(resolvedLiveId, state);
    return state;
  }

  async submit({ task, sessionId, urgency = "normal", instructions = "" }) {
    const state = await this.ensureSession(sessionId);
    const runId = `iris_${crypto.randomUUID()}`;
    const item = {
      runId,
      task: String(task || "").trim(),
      urgency,
      instructions,
      storedSessionId: state.storedId,
      liveSessionId: state.liveId,
      status: state.current ? "queued" : "starting",
      output: "",
      interaction: null,
      submittedAt: Date.now(),
    };
    this.runs.set(runId, item);
    state.queue.push(item);
    this.emit("run-update", { ...item });
    void this.#drain(state);
    return {
      run_id: runId,
      status: item.status,
      session_id: state.storedId,
      live_session_id: state.liveId,
    };
  }

  async #drain(state) {
    if (state.current || !state.queue.length) return;
    const item = state.queue.shift();
    state.current = item;
    item.status = "running";
    item.liveSessionId = state.liveId;
    this.emit("run-update", { ...item });
    try {
      await this.client.request(
        "prompt.submit",
        {
          session_id: state.liveId,
          text: promptForTask(item.task, item.instructions),
        },
        { timeoutMs: 45000 },
      );
    } catch (error) {
      this.#finish(state, item, {
        status: "failed",
        error: error?.message || String(error),
      });
    }
  }

  #onEvent(event) {
    const type = String(event?.type || "");
    const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
    const state = this.liveSessions.get(String(event?.session_id || ""));
    if (!state) return;
    const item = state.current;
    if (type === "terminal.read.request") {
      void this.client.request("terminal.read.respond", {
        request_id: payload.request_id,
        text: JSON.stringify({ lines: [], unavailable: true }),
      }).catch(() => undefined);
      return;
    }
    if (!item) return;
    if (type === "message.start") {
      item.status = "running";
      this.emit("run-update", { ...item });
      return;
    }
    if (type === "message.delta") {
      const delta = String(payload.text || "");
      item.output = `${item.output}${delta}`.slice(-12000);
      this.emit("run-event", {
        runId: item.runId,
        task: item.task,
        event: "message.delta",
        delta,
      });
      return;
    }
    if (type === "reasoning.delta" || type === "reasoning.available") {
      this.emit("run-event", {
        runId: item.runId,
        task: item.task,
        event: "reasoning.available",
        text: String(payload.text || ""),
      });
      return;
    }
    if (type === "tool.start") {
      this.emit("run-event", {
        runId: item.runId,
        task: item.task,
        event: "tool.started",
        tool: String(payload.name || "tool"),
        toolId: String(payload.tool_id || ""),
        preview: String(payload.context || payload.args_text || ""),
      });
      return;
    }
    if (type === "tool.complete") {
      this.emit("run-event", {
        runId: item.runId,
        task: item.task,
        event: "tool.completed",
        tool: String(payload.name || "tool"),
        toolId: String(payload.tool_id || ""),
        preview: String(payload.summary || ""),
        duration: Number(payload.duration_s) || undefined,
        isError: Boolean(payload.error),
      });
      return;
    }
    if (type === "clarify.request") {
      this.#requestInteraction(item, {
        id: String(payload.request_id || ""),
        type: "clarify",
        question: String(payload.question || "Hermes needs more information."),
        choices: Array.isArray(payload.choices) ? payload.choices.map(String) : [],
        allowCustom: true,
        secret: false,
      });
      return;
    }
    if (type === "approval.request") {
      this.#requestInteraction(item, {
        id: `approval:${item.runId}`,
        type: "approval",
        question: String(payload.description || "Hermes wants to run a protected command."),
        command: String(payload.command || ""),
        choices: [
          "once",
          "session",
          ...(payload.allow_permanent === false ? [] : ["always"]),
          "deny",
        ],
        allowCustom: false,
        secret: false,
      });
      return;
    }
    if (type === "sudo.request") {
      this.#requestInteraction(item, {
        id: String(payload.request_id || ""),
        type: "sudo",
        question: "Hermes needs your sudo password to continue.",
        choices: [],
        allowCustom: true,
        secret: true,
      });
      return;
    }
    if (type === "secret.request") {
      this.#requestInteraction(item, {
        id: String(payload.request_id || ""),
        type: "secret",
        question: String(payload.prompt || "Hermes needs a secret value."),
        envVar: String(payload.env_var || ""),
        choices: [],
        allowCustom: true,
        secret: true,
      });
      return;
    }
    if (type === "message.complete") {
      const status = String(payload.status || "complete").toLowerCase();
      const failed = status !== "complete" && status !== "completed";
      this.#finish(state, item, {
        status: item.cancelRequested ? "cancelled" : failed ? "failed" : "completed",
        output: String(payload.text || item.output || ""),
        error: failed ? String(payload.warning || status) : "",
      });
      return;
    }
    if (type === "error") {
      this.#finish(state, item, {
        status: "failed",
        error: String(payload.message || "Hermes interactive run failed."),
      });
    }
  }

  #requestInteraction(item, interaction) {
    item.interaction = interaction;
    item.status =
      interaction.type === "approval" ? "waiting_for_approval" : "waiting_for_input";
    this.emit("interaction", {
      runId: item.runId,
      task: item.task,
      interaction: { ...interaction },
    });
    this.emit("run-update", { ...item });
  }

  async respond(runId, { interactionId, type, value }) {
    const item = this.runs.get(String(runId));
    if (!item || !item.interaction) throw new Error("No pending Hermes interaction for this run.");
    const interaction = item.interaction;
    if (interaction.id !== interactionId || interaction.type !== type) {
      throw new Error("Hermes interaction no longer matches this response.");
    }
    const state = this.sessions.get(item.storedSessionId);
    if (!state) throw new Error("Hermes session is unavailable.");
    if (type === "clarify") {
      await this.client.request("clarify.respond", {
        request_id: interaction.id,
        answer: String(value ?? ""),
      });
    } else if (type === "approval") {
      await this.client.request("approval.respond", {
        session_id: state.liveId,
        choice: String(value || "deny"),
      });
    } else if (type === "sudo") {
      await this.client.request("sudo.respond", {
        request_id: interaction.id,
        password: String(value ?? ""),
      });
    } else if (type === "secret") {
      await this.client.request("secret.respond", {
        request_id: interaction.id,
        value: String(value ?? ""),
      });
    } else {
      throw new Error(`Unsupported Hermes interaction: ${type}`);
    }
    item.interaction = null;
    item.status = "running";
    this.emit("interaction-resolved", {
      runId: item.runId,
      task: item.task,
      interactionId,
      type,
    });
    this.emit("run-update", { ...item });
    return { status: "resolved", run_id: item.runId, type };
  }

  async stop(runId) {
    const item = this.runs.get(String(runId));
    if (!item) throw new Error("Hermes run not found.");
    const state = this.sessions.get(item.storedSessionId);
    if (!state) throw new Error("Hermes session is unavailable.");
    if (state.current?.runId !== item.runId) {
      state.queue = state.queue.filter((queued) => queued.runId !== item.runId);
      this.#finish(state, item, { status: "cancelled" });
      return { status: "cancelled" };
    }
    item.cancelRequested = true;
    item.status = "cancelling";
    this.emit("run-update", { ...item });
    await this.client.request("session.interrupt", { session_id: state.liveId });
    return { status: "stopping" };
  }

  getRun(runId) {
    const item = this.runs.get(String(runId));
    return item ? { ...item, interaction: item.interaction ? { ...item.interaction } : null } : null;
  }

  #finish(state, item, updates) {
    if (TERMINAL.has(item.status) && TERMINAL.has(String(updates.status))) return;
    Object.assign(item, updates, { interaction: null, finishedAt: Date.now() });
    this.emit("run-update", { ...item });
    this.emit("complete", { ...item });
    if (state.current?.runId === item.runId) state.current = null;
    void this.#drain(state);
  }

  #scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.client.connect();
        const states = [...this.sessions.values()];
        this.liveSessions.clear();
        for (const state of states) {
          const resumed = await this.client.request("session.resume", {
            session_id: state.storedId,
            source: "iris",
            close_on_disconnect: false,
            cols: 110,
          });
          state.liveId = resumed.session_id;
          this.liveSessions.set(state.liveId, state);
          if (state.current) state.current.liveSessionId = state.liveId;
        }
        this.emit("reconnected");
      } catch (error) {
        this.log(`Hermes interactive reconnect failed: ${error?.message || error}`);
        this.#scheduleReconnect();
      }
    }, 1000);
  }

  #onBackendExit(detail) {
    this.liveSessions.clear();
    for (const state of this.sessions.values()) {
      const queued = state.queue.splice(0);
      if (state.current) {
        this.#finish(state, state.current, {
          status: "failed",
          error: `Hermes interactive backend exited (${detail.signal || detail.code || "unknown"}).`,
        });
      }
      for (const item of queued) {
        this.#finish(state, item, {
          status: "failed",
          error: `Hermes interactive backend exited (${detail.signal || detail.code || "unknown"}).`,
        });
      }
      state.liveId = null;
    }
  }

  close({ force = false } = {}) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.client.close({ force });
  }
}
