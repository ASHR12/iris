export function autoSleepDecision({
  now = Date.now(),
  idleMs,
  lastActivityAt,
  pendingProposal = false,
  responseInFlight = false,
  responseStartedAt = 0,
}) {
  const maxResponseWait = Math.max(120000, idleMs * 4);
  const responseFor = responseInFlight ? Math.max(0, now - responseStartedAt) : 0;
  if (responseInFlight && responseFor < maxResponseWait) {
    return {
      sleep: false,
      responseProtected: true,
      responseTimedOut: false,
      responseFor,
      maxResponseWait,
    };
  }
  const idleFor = Math.max(0, now - lastActivityAt);
  const idleLimit = pendingProposal ? idleMs * 3 : idleMs;
  return {
    sleep: idleFor >= idleLimit,
    responseProtected: false,
    responseTimedOut: responseInFlight,
    responseFor,
    maxResponseWait,
    idleFor,
    idleLimit,
  };
}

/**
 * Gemini Live performs Google Search server-side. Treat only protocol evidence
 * as search activity; predicted intent from a partial user transcript is not a
 * search invocation.
 */
export function hasGoogleSearchEvidence(serverContent = {}) {
  if (serverContent.groundingMetadata) return true;
  return (serverContent.modelTurn?.parts || []).some(
    (part) => Boolean(part?.executableCode || part?.codeExecutionResult),
  );
}

/**
 * Tracks the protocol-level lifecycle of one Gemini Live conversation.
 * Realtime text/audio can overlap, so completion is bound to an input epoch:
 * an older interrupted greeting must never settle a newer user question.
 */
export class LiveTurnState {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.reset();
  }

  reset() {
    this.epoch = 0;
    this.pendingEpoch = 0;
    this.modelEpoch = 0;
    this.phase = "idle";
    this.startedAt = 0;
    this.pendingToolIds = new Set();
    this.cancelledToolIds = new Set();
    this.interruptedCompletions = [];
  }

  beginInput(source = "input") {
    this.epoch += 1;
    this.pendingEpoch = this.epoch;
    this.phase = "waiting";
    this.startedAt = this.now();
    this.source = source;
    return this.snapshot();
  }

  modelActivity() {
    if (!this.pendingEpoch) this.beginInput("server");
    if (!this.modelEpoch) this.modelEpoch = this.pendingEpoch;
    this.phase = "generating";
    return this.snapshot();
  }

  generationComplete() {
    this.modelActivity();
    this.phase = this.pendingToolIds.size ? "tool_wait" : "playback";
    return this.snapshot();
  }

  turnComplete() {
    const interruptedEpoch = this.interruptedCompletions.shift() || 0;
    const completedEpoch = interruptedEpoch || this.modelEpoch || this.pendingEpoch;
    if (!interruptedEpoch && this.modelEpoch === completedEpoch) this.modelEpoch = 0;
    if (
      this.pendingToolIds.size === 0 &&
      completedEpoch === this.pendingEpoch
    ) {
      this.phase = "idle";
      this.startedAt = 0;
      this.modelEpoch = 0;
    } else if (this.pendingToolIds.size) {
      this.phase = "tool_wait";
    } else {
      this.phase = "waiting";
    }
    return { completedEpoch, ...this.snapshot() };
  }

  interrupted() {
    const interruptedEpoch = this.modelEpoch || this.pendingEpoch;
    if (interruptedEpoch) this.interruptedCompletions.push(interruptedEpoch);
    this.modelEpoch = 0;
    if (!this.pendingEpoch || this.pendingEpoch <= interruptedEpoch) {
      this.beginInput("interruption");
    } else {
      this.phase = "waiting";
    }
    return this.snapshot();
  }

  toolCalls(calls = []) {
    this.modelActivity();
    for (const call of calls) {
      if (call?.id) this.pendingToolIds.add(String(call.id));
    }
    this.phase = "tool_wait";
    return this.snapshot();
  }

  toolResponse(ids = []) {
    for (const id of ids) this.pendingToolIds.delete(String(id));
    this.phase = this.pendingToolIds.size ? "tool_wait" : "waiting";
    return this.snapshot();
  }

  cancelTools(ids = []) {
    for (const id of ids) {
      const value = String(id);
      this.pendingToolIds.delete(value);
      this.cancelledToolIds.add(value);
    }
    while (this.cancelledToolIds.size > 1000) {
      this.cancelledToolIds.delete(this.cancelledToolIds.values().next().value);
    }
    if (!this.pendingToolIds.size && this.phase === "tool_wait") {
      this.phase = "waiting";
    }
    return this.snapshot();
  }

  isToolCancelled(id) {
    return Boolean(id) && this.cancelledToolIds.has(String(id));
  }

  get busy() {
    return this.phase !== "idle" || this.pendingToolIds.size > 0;
  }

  snapshot() {
    return {
      phase: this.phase,
      busy: this.busy,
      epoch: this.epoch,
      pendingEpoch: this.pendingEpoch,
      modelEpoch: this.modelEpoch,
      startedAt: this.startedAt,
      pendingToolIds: [...this.pendingToolIds],
    };
  }
}

export class ResumeHandleStore {
  constructor({ ttlMs }) {
    this.ttlMs = ttlMs;
    this.handle = null;
    this.updatedAt = 0;
  }

  update(handle, now = Date.now()) {
    if (!handle) return false;
    this.handle = String(handle);
    this.updatedAt = now;
    return true;
  }

  fresh(now = Date.now()) {
    return this.handle && now - this.updatedAt < this.ttlMs ? this.handle : null;
  }

  age(now = Date.now()) {
    return this.updatedAt ? now - this.updatedAt : Infinity;
  }

  clear() {
    this.handle = null;
    this.updatedAt = 0;
  }

  expireForTest() {
    this.updatedAt = 0;
  }

  corruptForTest() {
    if (this.handle) this.handle = `${this.handle.slice(0, 8)}-corrupted-by-test`;
  }
}

export class AnnouncementLedger {
  constructor({ maxPending = 100 } = {}) {
    this.maxPending = maxPending;
    this.pending = [];
    this.inFlight = [];
  }

  enqueue(text) {
    this.pending.push(String(text));
    if (this.pending.length > this.maxPending) this.pending.shift();
  }

  sendNow(text, send) {
    const value = String(text);
    this.inFlight.push(value);
    send(value);
  }

  drain(send) {
    let count = 0;
    while (this.pending.length) {
      this.sendNow(this.pending.shift(), send);
      count += 1;
    }
    return count;
  }

  requeueInFlight() {
    if (!this.inFlight.length) return 0;
    this.pending.unshift(...this.inFlight);
    const count = this.inFlight.length;
    this.inFlight = [];
    if (this.pending.length > this.maxPending) {
      this.pending = this.pending.slice(-this.maxPending);
    }
    return count;
  }

  completeTurn() {
    const delivered = this.inFlight;
    this.inFlight = [];
    return delivered;
  }

  get pendingCount() {
    return this.pending.length;
  }
}
