import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const RUN_REGISTRY_VERSION = 1;
export const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "error",
]);

function cleanEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const runId = String(raw.runId || raw.run_id || "").trim();
  if (!runId) return null;
  return {
    runId,
    task: String(raw.task || "").slice(0, 20000),
    sessionId: String(raw.sessionId || raw.session_id || ""),
    status: String(raw.status || "unknown"),
    urgency: String(raw.urgency || "normal"),
    transport: String(raw.transport || "runs_api"),
    liveSessionId: String(raw.liveSessionId || raw.live_session_id || ""),
    output: String(raw.output || ""),
    error: String(raw.error || ""),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    announcedAt: Number(raw.announcedAt) || 0,
    approval:
      raw.approval && typeof raw.approval === "object"
        ? {
            command: String(raw.approval.command || "").slice(0, 2000),
            reason: String(raw.approval.reason || raw.approval.message || "").slice(0, 1000),
            choices: Array.isArray(raw.approval.choices)
              ? raw.approval.choices.map(String).slice(0, 8)
              : [],
            requestedAt: Number(raw.approval.requestedAt) || Date.now(),
          }
        : null,
    interaction:
      raw.interaction && typeof raw.interaction === "object"
        ? {
            id: String(raw.interaction.id || ""),
            type: String(raw.interaction.type || ""),
            question: String(raw.interaction.question || "").slice(0, 4000),
            command: String(raw.interaction.command || "").slice(0, 2000),
            envVar: String(raw.interaction.envVar || "").slice(0, 200),
            choices: Array.isArray(raw.interaction.choices)
              ? raw.interaction.choices.map(String).slice(0, 8)
              : [],
            allowCustom: Boolean(raw.interaction.allowCustom),
            secret: Boolean(raw.interaction.secret),
          }
        : null,
  };
}

export class RunRegistry {
  constructor({
    filePath = path.join(os.homedir(), ".iris", "run-registry.json"),
    maxEntries = 200,
    terminalRetentionMs = 30 * 24 * 60 * 60 * 1000,
  } = {}) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    this.terminalRetentionMs = terminalRetentionMs;
    this.entries = new Map();
    this.load();
  }

  load() {
    this.entries.clear();
    if (!fs.existsSync(this.filePath)) return;
    try {
      const payload = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (payload.version !== RUN_REGISTRY_VERSION || !Array.isArray(payload.runs)) return;
      for (const raw of payload.runs) {
        const entry = cleanEntry(raw);
        if (entry) this.entries.set(entry.runId, entry);
      }
      this.prune({ persist: false });
    } catch {
      // A corrupt registry must never prevent Iris from launching.
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    const runs = [...this.entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    fs.writeFileSync(
      temp,
      JSON.stringify({ version: RUN_REGISTRY_VERSION, updatedAt: Date.now(), runs }, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
    fs.renameSync(temp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
  }

  prune({ persist = true } = {}) {
    const cutoff = Date.now() - this.terminalRetentionMs;
    for (const [runId, entry] of this.entries) {
      if (TERMINAL_RUN_STATUSES.has(entry.status.toLowerCase()) && entry.updatedAt < cutoff) {
        this.entries.delete(runId);
      }
    }
    const ordered = [...this.entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const entry of ordered.slice(this.maxEntries)) this.entries.delete(entry.runId);
    if (persist) this.persist();
  }

  get(runId) {
    const entry = this.entries.get(String(runId));
    return entry
      ? {
          ...entry,
          approval: entry.approval ? { ...entry.approval } : null,
          interaction: entry.interaction ? { ...entry.interaction } : null,
        }
      : null;
  }

  list({ sessionId, activeOnly = false } = {}) {
    return [...this.entries.values()]
      .filter((entry) => !sessionId || entry.sessionId === sessionId)
      .filter(
        (entry) =>
          !activeOnly || !TERMINAL_RUN_STATUSES.has(String(entry.status).toLowerCase()),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((entry) => ({
        ...entry,
        approval: entry.approval ? { ...entry.approval } : null,
        interaction: entry.interaction ? { ...entry.interaction } : null,
      }));
  }

  start({
    runId,
    task,
    sessionId,
    urgency = "normal",
    status = "started",
    transport = "runs_api",
    liveSessionId = "",
  }) {
    const now = Date.now();
    const entry = cleanEntry({
      runId,
      task,
      sessionId,
      urgency,
      status,
      transport,
      liveSessionId,
      createdAt: now,
      updatedAt: now,
    });
    if (!entry) throw new Error("runId is required");
    this.entries.set(entry.runId, entry);
    this.prune({ persist: false });
    this.persist();
    return this.get(entry.runId);
  }

  update(runId, updates = {}) {
    const current = this.entries.get(String(runId));
    if (!current) return null;
    const next = cleanEntry({
      ...current,
      ...updates,
      runId: current.runId,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    });
    this.entries.set(current.runId, next);
    this.persist();
    return this.get(current.runId);
  }

  setApproval(runId, approval) {
    return this.update(runId, { approval });
  }

  setInteraction(runId, interaction) {
    return this.update(runId, { interaction });
  }

  markAnnounced(runId) {
    return this.update(runId, { announcedAt: Date.now() });
  }
}
