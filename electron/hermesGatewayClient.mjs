import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import WebSocketPackage from "ws";

const READY_RE = /HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d+)/;

export class HermesGatewayRpcError extends Error {
  constructor(message, { code = 0, data } = {}) {
    super(message);
    this.name = "HermesGatewayRpcError";
    this.code = code;
    this.data = data;
  }
}

export class HermesGatewayClient extends EventEmitter {
  constructor({
    candidates,
    env = process.env,
    WebSocketImpl = globalThis.WebSocket || WebSocketPackage,
    spawnImpl = spawn,
    log = () => {},
    startupTimeoutMs = 45000,
    cwd = os.homedir(),
    terminalCwd = process.env.IRIS_HERMES_CWD || "",
  }) {
    super();
    this.candidates = candidates;
    this.env = env;
    this.WebSocketImpl = WebSocketImpl;
    this.spawnImpl = spawnImpl;
    this.log = log;
    this.startupTimeoutMs = startupTimeoutMs;
    this.cwd = cwd;
    this.terminalCwd = terminalCwd;
    this.process = null;
    this.socket = null;
    this.port = 0;
    this.token = "";
    this.startPromise = null;
    this.connectPromise = null;
    this.ready = false;
    this.closed = false;
    this.sequence = 0;
    this.pending = new Map();
    this.logTail = "";
  }

  async start() {
    if (this.ready && this.socket?.readyState === this.WebSocketImpl.OPEN) return this;
    if (this.startPromise) return this.startPromise;
    this.closed = false;
    this.startPromise = this.#start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async #start() {
    if (this.process && this.port) {
      await this.connect();
      return this;
    }
    let lastError = null;
    for (const candidate of this.candidates()) {
      try {
        await this.#spawn(candidate);
        await this.connect();
        return this;
      } catch (error) {
        lastError = error;
        this.#stopProcess();
      }
    }
    throw lastError || new Error("No usable Hermes runtime could start the interactive gateway.");
  }

  #appendLog(chunk) {
    const text = String(chunk || "");
    this.logTail = `${this.logTail}${text}`.slice(-32000);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) this.log(line.trim());
    }
  }

  #spawn(candidate) {
    return new Promise((resolve, reject) => {
      const token = crypto.randomBytes(32).toString("base64url");
      const args = [...candidate.args, "serve", "--host", "127.0.0.1", "--port", "0"];
      let child;
      try {
        child = this.spawnImpl(candidate.cmd, args, {
          cwd: this.cwd,
          env: {
            ...this.env,
            HERMES_DASHBOARD_SESSION_TOKEN: token,
            HERMES_DESKTOP: "1",
            ...(this.terminalCwd ? { TERMINAL_CWD: this.terminalCwd } : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        reject(error);
        return;
      }
      this.process = child;
      this.token = token;
      let settled = false;
      const finish = (error, port = 0) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExitBeforeReady);
        if (error) reject(error);
        else {
          this.port = port;
          resolve();
        }
      };
      const inspect = (chunk) => {
        this.#appendLog(chunk);
        const match = READY_RE.exec(this.logTail);
        if (match) finish(null, Number(match[1]));
      };
      const onError = (error) => finish(error);
      const onExitBeforeReady = (code, signal) =>
        finish(
          new Error(
            `Hermes interactive backend exited before ready (${signal || code}). ${this.logTail.slice(-500)}`,
          ),
        );
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              `Timed out starting Hermes interactive backend. ${this.logTail.slice(-500)}`,
            ),
          ),
        this.startupTimeoutMs,
      );
      child.stdout?.on("data", inspect);
      child.stderr?.on("data", inspect);
      child.once("error", onError);
      child.once("exit", onExitBeforeReady);
      child.on("exit", (code, signal) => {
        if (this.process !== child) return;
        this.process = null;
        this.port = 0;
        this.ready = false;
        this.#rejectPending(
          new Error(`Hermes interactive backend exited (${signal || code}).`),
        );
        this.emit("backend-exit", { code, signal });
      });
    });
  }

  async connect() {
    if (this.ready && this.socket?.readyState === this.WebSocketImpl.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    if (!this.port || !this.token) throw new Error("Hermes interactive backend is not started.");
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(
        `ws://127.0.0.1:${this.port}/api/ws?token=${encodeURIComponent(this.token)}`,
      );
      this.socket = socket;
      let sawGatewayReady = false;
      const timeout = setTimeout(() => {
        try { socket.close(); } catch { /* already closed */ }
        reject(new Error("Timed out connecting to Hermes interactive gateway."));
      }, 10000);
      const finishReady = () => {
        if (!sawGatewayReady) return;
        clearTimeout(timeout);
        this.ready = true;
        this.emit("connected");
        resolve();
      };
      socket.addEventListener("open", finishReady);
      socket.addEventListener("message", (message) => {
        try {
          for (const line of String(message.data).split("\n").filter(Boolean)) {
            const frame = JSON.parse(line);
            if (
              frame.method === "event" &&
              frame.params?.type === "gateway.ready"
            ) {
              sawGatewayReady = true;
              finishReady();
            }
            this.#onFrame(frame);
          }
        } catch (error) {
          this.emit("protocol-error", error);
        }
      });
      socket.addEventListener("error", () => {
        if (!this.ready) {
          clearTimeout(timeout);
          reject(new Error("Could not connect to Hermes interactive gateway."));
        }
      });
      socket.addEventListener("close", (event) => {
        clearTimeout(timeout);
        const wasReady = this.ready;
        this.ready = false;
        if (this.socket === socket) this.socket = null;
        this.#rejectPending(
          new Error(`Hermes interactive socket closed (${event.code || "unknown"}).`),
        );
        if (wasReady && !this.closed) this.emit("disconnected", event);
      });
    }).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  #onFrame(frame) {
    if (frame?.id && this.pending.has(frame.id)) {
      const pending = this.pending.get(frame.id);
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error) {
        pending.reject(
          new HermesGatewayRpcError(frame.error.message || "Hermes RPC failed.", {
            code: frame.error.code,
            data: frame.error.data,
          }),
        );
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    if (frame?.method === "event" && frame.params) this.emit("event", frame.params);
  }

  async request(method, params = {}, { timeoutMs = 30000 } = {}) {
    await this.start();
    const id = `iris-${Date.now()}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hermes RPC ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #stopProcess(force = false) {
    const child = this.process;
    this.process = null;
    this.port = 0;
    if (!child || child.exitCode != null) return;
    try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* already exited */ }
    if (force) return;
    setTimeout(() => {
      if (child.exitCode == null) {
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
      }
    }, 3000).unref?.();
  }

  close({ force = false } = {}) {
    this.closed = true;
    this.ready = false;
    this.#rejectPending(new Error("Hermes interactive gateway closed."));
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = null;
    this.#stopProcess(force);
  }
}
