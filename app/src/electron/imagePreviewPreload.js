const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("imagePreview", {
  saveAnnotation: (key, dataUrl) => ipcRenderer.invoke("imagePreview:saveAnnotation", key, dataUrl)
});
