const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dayline", {
  backgroundReminders: true,
  syncStatus: () => ipcRenderer.invoke("sync:status"),
  syncLogin: input => ipcRenderer.invoke("sync:login", input),
  syncRegister: input => ipcRenderer.invoke("sync:register", input),
  syncCheck: input => ipcRenderer.invoke("sync:check", input),
  syncSetup: (action, input) => ipcRenderer.invoke("sync:setup", action, input),
  syncLogout: () => ipcRenderer.invoke("sync:logout"),
  syncNow: () => ipcRenderer.invoke("sync:now"),
  deviceBackup: (action, input) => ipcRenderer.invoke('sync:device', action, input),
  wechatReminder: (action, input) => ipcRenderer.invoke('wechat-reminder:settings', action, input),
  readWecomClipboard: () => ipcRenderer.invoke('clipboard:readWecom'),
  onSyncStatus: callback => {
    const listener = (_, status) => callback(status);
    ipcRenderer.on("sync:status", listener);
    return () => ipcRenderer.removeListener("sync:status", listener);
  },
  loadData: () => ipcRenderer.invoke("data:load"),
  saveData: (data, options) => ipcRenderer.invoke("data:save", data, options),
  copySubscriptionPassword: input => ipcRenderer.invoke('subscription:copyPassword', input),
  saveUiStatePatch: patch => ipcRenderer.invoke("runtime:saveUiStatePatch", patch),
  importNoteImage: payload => ipcRenderer.invoke("attachment:import", payload),
  exportAll: () => ipcRenderer.invoke("data:exportAll"),
  importJson: () => ipcRenderer.invoke("data:importJson"),
  createBackup: () => ipcRenderer.invoke("data:createBackup"),
  openDataDir: () => ipcRenderer.invoke("data:openDataDir"),
  openBackupDir: () => ipcRenderer.invoke("data:openBackupDir"),
  exportNote: (note, format) => ipcRenderer.invoke("data:exportNote", note, format),
  exportNoteFolder: (folderName, notes) => ipcRenderer.invoke("data:exportNoteFolder", folderName, notes),
  exportWorkTreeMindmapPng: payload => ipcRenderer.invoke("worktree:exportMindmapPng", payload),
  readNoteClipboard: () => ipcRenderer.invoke("clipboard:readNotePaste"),
  readScheduleClipboard: () => ipcRenderer.invoke("clipboard:readSchedulePaste"),
  openEventUrl: url => ipcRenderer.invoke("event:openUrl", url),
  exportIcs: events => ipcRenderer.invoke("data:exportIcs", events),
  notifyReminder: payload => ipcRenderer.invoke("reminder:notify", payload),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  close: () => ipcRenderer.invoke("window:close"),
  getBounds: () => ipcRenderer.invoke("window:getBounds"),
  startWindowDrag: () => ipcRenderer.send("window:dragStart"),
  moveWindowDrag: () => ipcRenderer.send("window:dragMove"),
  endWindowDrag: () => ipcRenderer.send("window:dragEnd"),
  applySurfaceBounds: (surface, bounds) => ipcRenderer.invoke("window:applySurfaceBounds", surface, bounds),
  switchSurfaceOnly: surface => ipcRenderer.invoke("window:switchSurfaceOnly", surface),
  toggleCalendarBounds: () => ipcRenderer.invoke("window:toggleCalendarBounds"),
  setAlwaysOnTop: value => ipcRenderer.invoke("window:setAlwaysOnTop", value),
  setOpacity: value => ipcRenderer.invoke("window:setOpacity", value),
  openImagePreview: src => ipcRenderer.invoke("window:openImagePreview", src),
  openSurface: surface => ipcRenderer.invoke("window:openSurface", surface),
  openTodayWidget: () => ipcRenderer.invoke("window:openTodayWidget"),
  addTodayEvent: title => ipcRenderer.invoke("todayWidget:addEvent", title),
  toggleTodayEvent: (eventId, completed, occurrenceDate) => ipcRenderer.invoke("todayWidget:toggleEvent", eventId, completed, occurrenceDate),
  setTodayWidgetAlwaysOnTop: value => ipcRenderer.invoke("todayWidget:setAlwaysOnTop", value),
  closeTodayWidget: () => ipcRenderer.invoke("todayWidget:close"),
  autoHidePointer: hovering => ipcRenderer.invoke("window:autoHidePointer", hovering),
  onAutoHideState: callback => {
    const listener = (_, value) => callback(value);
    ipcRenderer.on("window:autoHideState", listener);
    return () => ipcRenderer.removeListener("window:autoHideState", listener);
  },
  onDataChanged: callback => {
    const listener = () => callback();
    ipcRenderer.on("data:changed", listener);
    return () => ipcRenderer.removeListener("data:changed", listener);
  },
  onQuickCapture: callback => {
    const listener = () => callback();
    ipcRenderer.on("app:quickCapture", listener);
    return () => ipcRenderer.removeListener("app:quickCapture", listener);
  },
  onCalendarToday: callback => {
    const listener = () => callback();
    ipcRenderer.on("calendar:today", listener);
    return () => ipcRenderer.removeListener("calendar:today", listener);
  },
  setLoginItem: value => ipcRenderer.invoke("app:setLoginItem", value),
  quit: () => ipcRenderer.invoke("app:quit")
});
