const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("iris", {
  startSidecar: (options) => ipcRenderer.invoke("sidecar:start", options),
  stopSidecar: () => ipcRenderer.invoke("sidecar:stop"),
  getSidecarStatus: () => ipcRenderer.invoke("sidecar:status"),
  getAppConfig: () => ipcRenderer.invoke("app:config"),
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (updates) => ipcRenderer.invoke("config:save", updates),
  testGemini: (key) => ipcRenderer.invoke("config:test-gemini", { key }),
  testHermes: (payload) => ipcRenderer.invoke("config:test-hermes", payload),
  previewVoice: (payload) => ipcRenderer.invoke("config:preview-voice", payload),
  getHermesHistory: () => ipcRenderer.invoke("hermes:history"),
  listHermesSessions: () => ipcRenderer.invoke("hermes:sessions"),
  createHermesSession: () => ipcRenderer.invoke("hermes:create-session"),
  loadBrain: () => ipcRenderer.invoke("brain:load"),
  readBrainNote: (relPath) => ipcRenderer.invoke("brain:read", relPath),
  searchBrain: (query, topK) => ipcRenderer.invoke("brain:search", query, topK),
  filterBrain: (query) => ipcRenderer.invoke("brain:filter", query),
  syncBrainIndex: (payload) => ipcRenderer.invoke("brain:sync-index", payload),
  onBrainChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("brain:changed", handler);
    return () => ipcRenderer.removeListener("brain:changed", handler);
  },
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  toggleHud: () => ipcRenderer.invoke("hud:toggle"),
  setHudInteractive: (on) => ipcRenderer.send("hud:interactive", Boolean(on)),
  windowControl: (action) => ipcRenderer.send("win:control", action),
  onHudMode: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("hud:mode", handler);
    return () => ipcRenderer.removeListener("hud:mode", handler);
  },
  onWakeRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("iris:wake", handler);
    return () => ipcRenderer.removeListener("iris:wake", handler);
  },
  onSleepRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("iris:sleep", handler);
    return () => ipcRenderer.removeListener("iris:sleep", handler);
  },
  onAutoSleep: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("iris:auto-sleep", handler);
    return () => ipcRenderer.removeListener("iris:auto-sleep", handler);
  },
  sendCommand: (command) => ipcRenderer.invoke("sidecar:command", command),
  sendUiContext: (context) => ipcRenderer.send("iris:ui-context", context),
  sendAudioChunk: (chunk) => ipcRenderer.send("live:audio", chunk),
  notifyBootDone: () => ipcRenderer.send("iris:boot-done"),
  onUiAction: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("iris:ui-action", handler);
    return () => ipcRenderer.removeListener("iris:ui-action", handler);
  },
  onAudioChunk: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("live:audio", handler);
    return () => ipcRenderer.removeListener("live:audio", handler);
  },
  onAudioInterrupt: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("live:interrupt", handler);
    return () => ipcRenderer.removeListener("live:interrupt", handler);
  },
  onSidecarEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("sidecar:event", handler);
    return () => ipcRenderer.removeListener("sidecar:event", handler);
  },
});
