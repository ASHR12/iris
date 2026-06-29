const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("iris", {
  startSidecar: (options) => ipcRenderer.invoke("sidecar:start", options),
  stopSidecar: () => ipcRenderer.invoke("sidecar:stop"),
  getSidecarStatus: () => ipcRenderer.invoke("sidecar:status"),
  getAppConfig: () => ipcRenderer.invoke("app:config"),
  sendCommand: (command) => ipcRenderer.invoke("sidecar:command", command),
  sendUiContext: (context) => ipcRenderer.send("iris:ui-context", context),
  sendAudioChunk: (chunk) => ipcRenderer.send("live:audio", chunk),
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
