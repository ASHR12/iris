export class RendererBridge {
  constructor({ maxMessages = 500, nonQueueable = ["live:audio", "hud:interactive"] } = {}) {
    this.maxMessages = maxMessages;
    this.nonQueueable = new Set(nonQueueable);
    this.webContents = null;
    this.ready = false;
    this.queue = [];
  }

  attach(webContents) {
    this.webContents = webContents;
    this.ready = false;
  }

  detach(webContents = this.webContents) {
    if (this.webContents !== webContents) return;
    this.webContents = null;
    this.ready = false;
  }

  markReady(webContents = this.webContents) {
    if (this.webContents !== webContents || !this.webContents || this.webContents.isDestroyed?.()) return;
    this.ready = true;
    this.flush();
  }

  send(channel, payload) {
    if (!this.webContents || this.webContents.isDestroyed?.() || !this.ready) {
      if (!this.nonQueueable.has(channel)) {
        this.queue.push({ channel, payload });
        if (this.queue.length > this.maxMessages) this.queue.shift();
      }
      return false;
    }
    this.webContents.send(channel, payload);
    return true;
  }

  flush() {
    if (!this.webContents || this.webContents.isDestroyed?.() || !this.ready) return 0;
    let count = 0;
    while (this.queue.length) {
      const message = this.queue.shift();
      this.webContents.send(message.channel, message.payload);
      count += 1;
    }
    return count;
  }

  get queued() {
    return this.queue.length;
  }
}
