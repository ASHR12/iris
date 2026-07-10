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
