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
  approveHermesAction: (runId, choice) =>
    ipcRenderer.invoke("hermes:approve", { run_id: runId, choice }),
  respondHermesInteraction: (payload) =>
    ipcRenderer.invoke("hermes:interaction-response", payload),
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
  onHudMode: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("hud:mode", handler);
    return () => ipcRenderer.removeListener("hud:mode", handler);
  },
  onWakeRequest: (callback) => {
    const handler = (_event, payload) => callback(payload || {});
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
  reportVoiceState: (state) => ipcRenderer.send("jarvisBridge:voiceState", state),
  askJarvis: (text) => ipcRenderer.invoke("jarvisBridge:askJarvis", text),
  getJarvisTasks: () => ipcRenderer.invoke("jarvisBridge:getTasks"),
  getJarvisTopFocus: () => ipcRenderer.invoke("jarvisBridge:getTopFocus"),
  getJarvisCurrentContext: () => ipcRenderer.invoke("jarvisBridge:getCurrentContext"),
  getJarvisEngineeringJob: () => ipcRenderer.invoke("jarvisBridge:getLatestEngineeringJob"),
  getJarvisActiveGoal: () => ipcRenderer.invoke("jarvisBridge:getActiveGoal"),
  getJarvisConnectionsStatus: () => ipcRenderer.invoke("jarvisBridge:getConnectionsStatus"),
  // Jarvis Actions & Approvals (P2.5). Every one of these is executed by the
  // running Jarvis backend process, never here and never in Iris's main
  // process — a previewId is an opaque handle into Jarvis's own Action
  // Service. secondaryApprove is a SEPARATE call on purpose: a destructive
  // action (Drive Trash, Calendar Delete) is not completed by approve alone.
  proposeJarvisAction: (question, source) => ipcRenderer.invoke("jarvisAction:propose", { question, source }),
  approveJarvisAction: (previewId) => ipcRenderer.invoke("jarvisAction:approve", previewId),
  secondaryApproveJarvisAction: (previewId) => ipcRenderer.invoke("jarvisAction:secondaryApprove", previewId),
  cancelJarvisAction: (previewId) => ipcRenderer.invoke("jarvisAction:cancel", previewId),
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
