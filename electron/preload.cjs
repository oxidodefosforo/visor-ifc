// Puente mínimo y seguro entre Electron y la interfaz web (contextIsolation + sandbox).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("visorDesktop", {
  getInfo: () => ipcRenderer.invoke("app-info"),
  onMenu: (cb) => ipcRenderer.on("menu", (_e, action) => cb(action)),
  onUpdateStatus: (cb) => ipcRenderer.on("update-status", (_e, s) => cb(s)),
  /** Abre el modelo actual en Chrome/Edge para verlo con gafas VR (WebXR). */
  openVR: (payload) => ipcRenderer.invoke("vr-open", payload),
  openUrl: (url) => ipcRenderer.invoke("open-url", url),
});
