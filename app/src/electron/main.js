const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, shell, Notification, clipboard, protocol, globalShortcut } = require("electron");
const path = require("path");
const crypto = require("crypto");
const { screen } = require("electron");
const fs = require("fs/promises");
const { DEFAULT_DATA } = require("../shared/schema");
const { setEventCompleted, occurrenceFor, isSeriesEvent, linkedTodoCompleted } = require("../shared/eventState");
const EventAddress = require("../shared/eventAddress");
const { createWindowStateManager } = require("./windowStateManager");
const { safeStorage } = require("electron");
const { DeviceBackup } = require("./deviceBackup");
const { SupabaseSync } = require("./supabaseSync");
const { createWechatReminderService } = require('./wechatReminder');
const { createWechatReminderRules } = require('./wechatReminderRules');

const DATA_FILE = "xiaoye-note-data.json";
const STORAGE_MANIFEST_FILE = "xiaoye-note-storage.json";
const STORAGE_FORMAT = "xiaoye-note-partitioned";
const STORAGE_VERSION = 2;
const STORAGE_SLOTS = ["a", "b"];
const PARTITION_NAMES = ["todos", "events", "notes", "worktrees", "settings", "misc", "assets", "runtime"];
const APP_NAME = "小叶便签";
app.setName(APP_NAME);
if (process.platform === "win32") app.setAppUserModelId("com.xiaoye.note");

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.exit(0);
} else {
  app.on("second-instance", () => {
    const firstWindow = BrowserWindow.getAllWindows()[0];
    if (firstWindow) {
      applyTaskbarVisibility(firstWindow);
      if (!firstWindow.isVisible()) firstWindow.show();
      if (firstWindow.isMinimized()) firstWindow.restore();
      firstWindow.focus();
    }
  });
}

const windows = new Map();
let dataCache;
let tray;
let todayWidgetWindow;
let todayWidgetBoundsTimer;
let isQuitting = false;
let restartRequested = false;
let dataRevision = 0;
let storageState;
let dataLoadPromise;
let saveQueue = Promise.resolve();
const revisionSnapshots = new Map();
const attachmentWrites = new Map();
let deferredBusinessDirty = false;
let deferredRuntimeDirty = false;
let quitFlushPromise = null;
let quitFlushCompleted = false;
let pendingImportBackup = null;
let noteSync;
const ReminderRules = require('../shared/reminderRules');
const TaskState = require('../shared/taskState');
let reminderCheckRunning = false;
let reminderBackgroundTimer;

async function checkBackgroundReminders() {
  if (reminderCheckRunning || isQuitting) return;
  reminderCheckRunning = true;
  try {
    const changed = await enqueueDataOperation(async data => {
      const now = new Date();
      const delivered = data.uiState?.reminderDeliveryKeys || {};
      const due = ReminderRules.due(data, now, item => TaskState.title(data, item)).filter(entry => !delivered[entry.key]);
      if (!due.length || !Notification.isSupported()) return;
      for (const entry of due) {
        const notification = new Notification({ title: entry.title, body: entry.body, icon: windowIconPath(), silent: false });
        notification.show(); delivered[entry.key] = now.getTime();
      }
      await commitUiStatePatch({ reminderDeliveryKeys: Object.fromEntries(Object.entries(delivered).filter(([, stamp]) => now.getTime() - stamp < 8 * 86400000)) });
      return true;
    });
    if (changed) await flushDeferredStorage();
  } finally { reminderCheckRunning = false; }
}
let syncTransport;
let syncStartupError = "";
let syncTimer;
let syncPoll;
let syncAuthBusy = false;
let syncAccountBusy = false;
let wechatReminderBusy = false;

async function readSyncFile(name) {
  try { return JSON.parse(await fs.readFile(path.join(app.getPath("userData"), name), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function publishSyncStatus() {
  const status = noteSync ? noteSync.status() : { connected: false, pending: 0 };
  if (syncStartupError) status.error = syncStartupError;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("sync:status", status);
  }
  return status;
}

function scheduleNoteSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    if (!noteSync?.state || syncStartupError) return;
    if (syncAuthBusy || !syncTransport.connected()) return;
    syncAuthBusy = true;
    try { await noteSync.autoSync(); }
    catch { noteSync.error = '日程自动上传失败，已保留本地内容，将自动重试。'; }
    finally { syncAuthBusy = false; publishSyncStatus(); }
    if (noteSync.state.pendingScheduleUpload) {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(scheduleNoteSync, 60000);
      syncTimer.unref();
    }
  }, 2000);
  syncTimer.unref();
}

async function initializeNoteSync() {
  let syncDefaults = {};
  try { syncDefaults = JSON.parse(await fs.readFile(path.join(__dirname, "../../sync/project.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") syncStartupError = "同步连接配置无法读取，请检查 project.json"; }
  syncTransport = new SupabaseSync({
    defaults: syncDefaults,
    read: () => readSyncFile("xiaoye-sync-auth.json"),
    write: value => atomicWriteText(path.join(app.getPath("userData"), "xiaoye-sync-auth.json"), JSON.stringify(value)),
    encrypt: value => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("系统凭证加密不可用，无法保存登录信息");
      return safeStorage.encryptString(value).toString("base64");
    },
    decrypt: value => safeStorage.decryptString(Buffer.from(value, "base64"))
  });
  try { await syncTransport.init(); } catch { syncTransport.session = null; }
  noteSync = new DeviceBackup({
    read: () => readSyncFile("xiaoye-device-backup.json"),
    write: value => atomicWriteText(path.join(app.getPath("userData"), "xiaoye-device-backup.json"), JSON.stringify(value)),
    transaction: enqueueDataOperation,
    backup: current => createJsonBackup("before-sync", current, { skipRotate: true }),
    apply: async data => {
      const result = await commitDataSnapshot(data);
      if (result.__changedPartitions.length) {
        await maybeCreateAutoBackup(stripRuntimeFields(dataCache));
        await broadcastDataChanged("sync");
      }
    },
    transport: syncTransport,
    notify: publishSyncStatus
  });
  try { await enqueueDataOperation(current => noteSync.init(current)); }
  catch { syncStartupError = "电脑备份配置读取失败，已暂停云端操作。请保留 xiaoye-device-backup.json 并联系维护者。"; }
  if (noteSync.state?.binding && syncTransport.session && noteSync.state.binding !== `${syncTransport.config.url}|${syncTransport.session.user?.id}`) {
    await syncTransport.logout();
    noteSync.error = "登录信息与本机绑定账号不一致，请重新登录原账号";
  }
  if (!noteSync.state?.binding && syncTransport.session) await noteSync.bind(`${syncTransport.config.url}|${syncTransport.session.user.id}`);
  syncPoll = setInterval(() => {
    if (noteSync?.state && !syncAuthBusy && syncTransport.connected()) scheduleNoteSync();
  }, 5000);
  syncPoll.unref();
  scheduleNoteSync();
}

ipcMain.handle("sync:status", publishSyncStatus);
ipcMain.handle("sync:login", async (_, input) => {
  if (wechatReminderBusy) return { error: "正在处理企微配置，请稍后登录。" };
  if (syncAuthBusy) return { error: "正在处理登录，请稍后重试" };
  if (syncStartupError) return { error: syncStartupError };
  syncAuthBusy = true;
  syncAccountBusy = true;
  try {
    if (!noteSync) throw new Error("同步服务尚未就绪");
    if (noteSync.running) await noteSync.running;
    await syncTransport.login(input || {}, binding => enqueueDataOperation(current => noteSync.bind(binding, current)));
    noteSync.error = "";
    scheduleNoteSync();
    return publishSyncStatus();
  } catch (error) { return { error: error.message }; }
  finally { syncAuthBusy = false; syncAccountBusy = false; }
});
ipcMain.handle("sync:register", async (_, input) => {
  if (wechatReminderBusy) return { error: "正在处理企微配置，请稍后注册。" };
  if (syncAuthBusy) return { error: "正在处理登录，请稍后重试" };
  if (syncStartupError) return { error: syncStartupError };
  syncAuthBusy = true;
  syncAccountBusy = true;
  try {
    if (!noteSync) throw new Error("同步服务尚未就绪");
    if (noteSync.running) await noteSync.running;
    const result = await syncTransport.register(input || {}, binding => enqueueDataOperation(current => noteSync.bind(binding, current)));
    if (result?.confirmEmail) return { ...publishSyncStatus(), notice: "注册成功。请到邮箱点击确认链接，然后回到这里点“登录”。" };
    noteSync.error = "";
    scheduleNoteSync();
    return publishSyncStatus();
  } catch (error) { return { error: error.message }; }
  finally { syncAuthBusy = false; syncAccountBusy = false; }
});
ipcMain.handle("sync:check", async (_, input) => {
  try { return await syncTransport.check(input || {}); }
  catch (error) { return { error: error.message }; }
});
const syncSetupPages = { signup: "https://supabase.com/dashboard/sign-up", projects: "https://supabase.com/dashboard/projects" };
ipcMain.handle("sync:setup", async (_, action, input = {}) => {
  try {
    if (action === "copy-sql") {
      const file = input.kind === "reminders" ? "init-reminders.sql" : "init.sql";
      clipboard.writeText(await fs.readFile(path.join(__dirname, "../../sync", file), "utf8"));
      return { copied: file };
    }
    if (action === "open") {
      let target = syncSetupPages[input.page];
      if (input.page === "sql" || input.page === "api") {
        const host = (() => { try { return new URL(String(input.url || syncTransport.config.url || "")).hostname; } catch { return ""; } })();
        const ref = /^([a-z0-9]{8,40})\.supabase\.co$/.exec(host)?.[1];
        target = ref ? `https://supabase.com/dashboard/project/${ref}/${input.page === "sql" ? "sql/new" : "settings/api-keys"}` : syncSetupPages.projects;
      }
      if (!target) throw new Error("未知页面");
      await shell.openExternal(target);
      return { opened: true };
    }
    if (action === "code") { const code = syncTransport.connectionCode(); clipboard.writeText(code); return { code }; }
    throw new Error("未知操作");
  } catch (error) { return { error: error.message }; }
});
ipcMain.handle("sync:logout", async () => {
  if (wechatReminderBusy) return { error: "正在处理企微配置，请稍后退出登录。" };
  if (syncAuthBusy) return { error: "正在处理登录，请稍后重试" };
  syncAuthBusy = true;
  syncAccountBusy = true;
  try {
    if (noteSync?.running) await noteSync.running;
    await syncTransport.logout();
    return publishSyncStatus();
  } catch (error) { return { error: error.message }; }
  finally { syncAuthBusy = false; syncAccountBusy = false; }
});
ipcMain.handle("sync:now", async () => {
  return { ...publishSyncStatus(), error: '请使用上传本机或选择电脑下载。' };
});
ipcMain.handle('sync:device', async (_, action, input = {}) => {
  if (syncAuthBusy || syncStartupError) return { error: syncStartupError || '正在处理其他操作，请稍后。' };
  syncAuthBusy = true;
  try {
    if (action === 'upload') return await noteSync.upload(input.name);
    if (action === 'list') return { devices: await noteSync.list() };
    if (action === 'preview') return { preview: await noteSync.preview(input.id) };
    if (action === 'download') return await noteSync.download(input.token, input.mode);
    if (action === 'pair') return await noteSync.pair(input.scope || 'all', input.name);
    throw new Error('未知操作');
  } catch (error) { return { error: error.message }; }
  finally { syncAuthBusy = false; }
});

const wechatReminderService = createWechatReminderService({ getTransport: () => syncTransport, getDeviceId: () => noteSync?.state?.deviceId });
const wechatReminderRules = createWechatReminderRules({
  getTransport: () => syncTransport,
  getBinding: () => `${syncTransport?.config?.url || ''}|${syncTransport?.session?.user?.id || ''}`,
  readDraft: () => readSyncFile('xiaoye-reminder-rules-draft.json'),
  writeDraft: value => atomicWriteText(path.join(app.getPath('userData'), 'xiaoye-reminder-rules-draft.json'), JSON.stringify(value)),
  loadData
});
const wechatReminderReads = new Map();
let wechatReminderQueue = Promise.resolve();
let wechatReminderPending = 0;
ipcMain.handle('wechat-reminder:settings', async (_, action, input) => {
  if (syncStartupError) return { error: syncStartupError };
  if (syncAccountBusy) return { error: '正在切换同步账号，请稍后重新读取。' };
  if (!['rules-get', 'rules-save', 'get', 'save', 'test'].includes(action)) return { error: '未知的提醒操作。' };
  const readKey = action === 'get' ? 'get' : action === 'rules-get' ? `rules-get:${Boolean(input?.discardDraft)}` : '';
  if (readKey && wechatReminderReads.has(readKey)) return wechatReminderReads.get(readKey);
  if (!readKey || (action === 'rules-get' && input?.discardDraft)) wechatReminderReads.clear();
  wechatReminderPending++;
  wechatReminderBusy = true;
  const request = wechatReminderQueue.then(async () => {
    try {
      if (action === 'rules-get') return await wechatReminderRules.get(input);
      if (action === 'rules-save') return await wechatReminderRules.save(input);
      if (action === 'get') return await wechatReminderService.get();
      if (action === 'save') return await wechatReminderService.save(input);
      return await wechatReminderService.test();
    } catch (error) { return { error: error.message }; }
  }).finally(() => {
    wechatReminderBusy = --wechatReminderPending > 0;
    if (readKey && wechatReminderReads.get(readKey) === request) wechatReminderReads.delete(readKey);
  });
  wechatReminderQueue = request.then(() => undefined);
  if (readKey) wechatReminderReads.set(readKey, request);
  return request;
});

ipcMain.handle('clipboard:readWecom', () => clipboard.readText());

function dataPath() {
  return path.join(app.getPath("userData"), DATA_FILE);
}

function storageManifestPath() {
  return path.join(app.getPath("userData"), STORAGE_MANIFEST_FILE);
}

function partitionPath(name, slot) {
  return path.join(app.getPath("userData"), `xiaoye-note-${name}.${slot}.json`);
}

function attachmentDirectory(kind = "original") {
  return path.join(app.getPath("userData"), "attachments", kind);
}

function attachmentFilePath(id, kind = "original") {
  return path.join(attachmentDirectory(kind), `${id}.png`);
}

function attachmentUrl(id, kind = "original") {
  return `xiaoye-asset://${kind}/${id}`;
}

function attachmentAnnotationKey(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 32);
}

function attachmentInputBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

async function persistNativeImageAttachment(image, annotationKey = "") {
  if (!image || image.isEmpty()) throw new Error("不是有效图片");
  const original = image.toPNG();
  const id = crypto.createHash("sha256").update(original).digest("hex");
  let write = attachmentWrites.get(id);
  if (!write) {
    write = (async () => {
      const originalPath = attachmentFilePath(id);
      const thumbnailPath = attachmentFilePath(id, "thumbnail");
      const [hasOriginal, hasThumbnail] = await Promise.all([
        fs.access(originalPath).then(() => true).catch(() => false),
        fs.access(thumbnailPath).then(() => true).catch(() => false)
      ]);
      if (!hasOriginal) await atomicWriteBinary(originalPath, original);
      if (!hasThumbnail) {
        const size = image.getSize();
        const scale = Math.min(1, 480 / Math.max(1, size.width), 320 / Math.max(1, size.height));
        const thumbnail = scale < 1
          ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: "good" })
          : image;
        await atomicWriteBinary(thumbnailPath, thumbnail.toPNG());
      }
    })();
    attachmentWrites.set(id, write);
    write.then(() => attachmentWrites.delete(id), () => attachmentWrites.delete(id));
  }
  await write;
  const size = image.getSize();
  return {
    id,
    mime: "image/png",
    width: Math.max(0, Number(size.width) || 0),
    height: Math.max(0, Number(size.height) || 0),
    size: original.length,
    annotationKey: annotationKey || `attachment:${id}`
  };
}

async function persistAttachment(payload) {
  if (typeof payload === "string" && payload.startsWith("data:image/")) {
    return persistNativeImageAttachment(nativeImage.createFromDataURL(payload), attachmentAnnotationKey(payload));
  }
  const bytes = attachmentInputBuffer(payload?.bytes);
  if (!bytes?.length) throw new Error("图片数据为空");
  return persistNativeImageAttachment(nativeImage.createFromBuffer(bytes));
}

async function externalizeNoteAttachments(data) {
  let migrated = false;
  for (const note of Array.isArray(data?.notes) ? data.notes : []) {
    if (!Array.isArray(note.attachments)) continue;
    const attachments = [];
    for (const attachment of note.attachments) {
      if (typeof attachment !== "string" || !attachment.startsWith("data:image/")) {
        attachments.push(attachment);
        continue;
      }
      try {
        attachments.push(await persistAttachment(attachment));
        migrated = true;
      } catch (error) {
        console.error("[attachment migration]", error);
        attachments.push(attachment);
      }
    }
    note.attachments = attachments;
  }
  return migrated;
}

async function portableDataSnapshot(data) {
  const portable = cloneJson(stripRuntimeFields(data));
  for (const note of Array.isArray(portable.notes) ? portable.notes : []) {
    if (!Array.isArray(note.attachments)) continue;
    const attachments = [];
    for (const attachment of note.attachments) {
      if (!attachment || typeof attachment !== "object" || !/^[a-f0-9]{64}$/i.test(String(attachment.id || ""))) {
        attachments.push(attachment);
        continue;
      }
      try {
        const bytes = await fs.readFile(attachmentFilePath(attachment.id));
        attachments.push(`data:image/png;base64,${bytes.toString("base64")}`);
      } catch (error) {
        console.error("[attachment export]", error);
        attachments.push(attachment);
      }
    }
    note.attachments = attachments;
  }
  return portable;
}

function registerAttachmentProtocol() {
  protocol.handle("xiaoye-asset", async request => {
    const url = new URL(request.url);
    const kind = url.hostname;
    const id = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!['original', 'thumbnail'].includes(kind) || !/^[a-f0-9]{64}$/i.test(id)) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const bytes = await fs.readFile(attachmentFilePath(id, kind));
      return new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" } });
    } catch (error) {
      return new Response("Not found", { status: error?.code === "ENOENT" ? 404 : 500 });
    }
  });
}

function windowIconPath() {
  return path.join(__dirname, "../../assets/icon.png");
}

function trayIconPath() {
  return path.join(__dirname, "../../assets/icon.ico");
}


function backupDir() {
  return path.join(app.getPath("userData"), "backups");
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function normalizeRepeatValue(value) {
  const normalized = String(value || "none").toLowerCase();
  const aliases = { weekday: "workdays", weekdays: "workdays", workday: "workdays", weekly: "weekly", month: "monthly", year: "yearly" };
  const next = aliases[normalized] || normalized;
  return ["none", "daily", "workdays", "weekly", "monthly", "yearly"].includes(next) ? next : "none";
}

function normalizeArray(value, fallback = []) {
  return Array.isArray(value) ? value : cloneJson(fallback);
}

function normalizeDataShape(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const next = { ...cloneJson(DEFAULT_DATA), ...source };
  next.settings = { ...(DEFAULT_DATA.settings || {}), ...(source.settings || {}) };
  applyUserRequestedDefaultSettings(next);
  next.todoLists = normalizeArray(source.todoLists, DEFAULT_DATA.todoLists);
  next.noteLists = normalizeArray(source.noteLists, DEFAULT_DATA.noteLists);
  next.noteFolders = normalizeArray(source.noteFolders, DEFAULT_DATA.noteLists).map((folder, index) => ({
    id: String(folder.id || folder.listId || `folder-${index + 1}`),
    name: String(folder.name || folder.tag || `文件夹${index + 1}`),
    tag: folder.tag || "",
    color: folder.color || "",
    order: Number.isFinite(Number(folder.order)) ? Number(folder.order) : index
  }));
  next.todos = normalizeArray(source.todos, DEFAULT_DATA.todos).map((todo, index) => ({
    completed: false,
    pinned: false,
    order: index,
    tags: [],
    targetDate: "",
    reminderAt: "",
    reminderLead: next.settings.reminderLead || "none",
    reminderLastFiredAt: "",
    reminderLastKey: "",
    repeat: "none",
    repeatEndDate: "",
    repeatParentId: "",
    repeatSkippedDates: [],
    scheduledEventId: "",
    subtasks: [],
    deleted: false,
    ...todo,
    repeat: normalizeRepeatValue(todo.repeat)
  }));
  next.events = normalizeArray(source.events, DEFAULT_DATA.events).map(event => ({
    color: next.settings.eventTodoColor || next.settings.accentColor || "#ffd21a",
    tags: [],
    repeat: "none",
    repeatEndDate: "",
    repeatParentId: "",
    repeatSkippedDates: [],
    reminderAt: "",
    reminderLead: next.settings.reminderLead || "none",
    reminderLastFiredAt: "",
    reminderLastKey: "",
    todoId: "",
    completed: false,
    note: "",
    startTime: "",
    endTime: "",
    deleted: false,
    ...event,
    repeat: normalizeRepeatValue(event.repeat)
  }));
  next.notes = normalizeArray(source.notes, DEFAULT_DATA.notes).map((note, index) => ({
    pinned: false,
    archived: false,
    order: index,
    tags: [],
    color: "",
    attachments: [],
    folderId: note.listId || note.folderId || "",
    deleted: false,
    ...note
  }));
  next.backups = normalizeArray(source.backups, []);
  next.trash = normalizeArray(source.trash, []);
  next.anniversaries = normalizeArray(source.anniversaries, []);
  next.workTrees = normalizeArray(source.workTrees, DEFAULT_DATA.workTrees);
  next.windowState = { ...(DEFAULT_DATA.windowState || {}), ...(source.windowState || {}) };
  next.uiState = source.uiState || next.uiState || {};
  next.imageAnnotations = source.imageAnnotations && typeof source.imageAnnotations === "object" ? { ...source.imageAnnotations } : {};
  return next;
}

const PARTITIONED_ROOT_KEYS = new Set([
  "todos", "todoLists", "events", "anniversaries", "notes", "noteLists", "noteFolders",
  "workTrees", "settings", "backups", "trash", "windowState", "uiState", "imageAnnotations",
  "__revision", "__stale", "__changedPartitions"
]);

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeUiState(current, incoming) {
  if (!isPlainObject(incoming)) return isPlainObject(current) ? current : {};
  const previous = isPlainObject(current) ? current : {};
  return {
    ...previous,
    ...incoming,
    scrollState: {
      ...(isPlainObject(previous.scrollState) ? previous.scrollState : {}),
      ...(isPlainObject(incoming.scrollState) ? incoming.scrollState : {})
    }
  };
}

function serializeJson(value) {
  return JSON.stringify(value, null, 2);
}

function serializedHash(serialized) {
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

async function atomicWriteText(target, content) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await fs.open(temp, "w");
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, target);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

async function atomicWriteBinary(target, content) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await fs.open(temp, "w");
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, target);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

async function readOptionalText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function attachmentEntryKey(entry) {
  return entry.noteId ? `id:${entry.noteId}` : `index:${String(entry.noteIndex).padStart(12, "0")}`;
}

function splitDataPartitions(data) {
  const persisted = stripRuntimeFields(data);
  const noteAttachments = [];
  const notes = (persisted.notes || []).map((note, noteIndex) => {
    const nextNote = { ...note };
    const attachments = Array.isArray(nextNote.attachments) ? nextNote.attachments : [];
    delete nextNote.attachments;
    if (attachments.length) {
      const noteId = note?.id == null ? "" : String(note.id);
      noteAttachments.push(noteId ? { noteId, attachments } : { noteIndex, attachments });
    }
    return nextNote;
  });
  noteAttachments.sort((left, right) => attachmentEntryKey(left).localeCompare(attachmentEntryKey(right)));

  const extras = {};
  for (const [key, value] of Object.entries(persisted)) {
    if (!PARTITIONED_ROOT_KEYS.has(key)) extras[key] = value;
  }

  return {
    todos: { todos: persisted.todos || [], todoLists: persisted.todoLists || [] },
    events: { events: persisted.events || [], anniversaries: persisted.anniversaries || [] },
    notes: { notes, noteLists: persisted.noteLists || [], noteFolders: persisted.noteFolders || [] },
    worktrees: { workTrees: persisted.workTrees || [] },
    settings: { settings: persisted.settings || {} },
    misc: { backups: persisted.backups || [], trash: persisted.trash || [], extras },
    assets: { noteAttachments, imageAnnotations: persisted.imageAnnotations || {} },
    runtime: { windowState: persisted.windowState || {}, uiState: persisted.uiState || {} }
  };
}

function validatePartition(name, value) {
  if (!isPlainObject(value)) throw new Error(`存储分区 ${name} 不是有效对象`);
  const arraysByPartition = {
    todos: ["todos", "todoLists"],
    events: ["events", "anniversaries"],
    notes: ["notes", "noteLists", "noteFolders"],
    worktrees: ["workTrees"],
    misc: ["backups", "trash"],
    assets: ["noteAttachments"]
  };
  for (const key of arraysByPartition[name] || []) {
    if (!Array.isArray(value[key])) throw new Error(`存储分区 ${name}.${key} 不是有效数组`);
  }
  if (name === "settings" && !isPlainObject(value.settings)) throw new Error("存储分区 settings.settings 不是有效对象");
  if (name === "misc" && !isPlainObject(value.extras)) throw new Error("存储分区 misc.extras 不是有效对象");
  if (name === "assets" && !isPlainObject(value.imageAnnotations)) throw new Error("存储分区 assets.imageAnnotations 不是有效对象");
  if (name === "runtime" && (!isPlainObject(value.windowState) || !isPlainObject(value.uiState))) {
    throw new Error("存储分区 runtime 不是有效对象");
  }
  return value;
}

function assembleDataPartitions(partitions) {
  for (const name of PARTITION_NAMES) validatePartition(name, partitions[name]);
  const entriesById = new Map();
  const entriesByIndex = new Map();
  for (const entry of partitions.assets.noteAttachments) {
    if (!isPlainObject(entry) || !Array.isArray(entry.attachments)) continue;
    if (entry.noteId) {
      const key = String(entry.noteId);
      const queue = entriesById.get(key) || [];
      queue.push(entry.attachments);
      entriesById.set(key, queue);
    } else if (Number.isInteger(entry.noteIndex)) {
      entriesByIndex.set(entry.noteIndex, entry.attachments);
    }
  }
  const notes = partitions.notes.notes.map((note, noteIndex) => {
    const noteId = note?.id == null ? "" : String(note.id);
    const queue = noteId ? entriesById.get(noteId) : null;
    const attachments = queue?.length ? queue.shift() : (entriesByIndex.get(noteIndex) || []);
    return { ...note, attachments };
  });
  return normalizeDataShape({
    ...(partitions.misc.extras || {}),
    todos: partitions.todos.todos,
    todoLists: partitions.todos.todoLists,
    events: partitions.events.events,
    anniversaries: partitions.events.anniversaries,
    notes,
    noteLists: partitions.notes.noteLists,
    noteFolders: partitions.notes.noteFolders,
    workTrees: partitions.worktrees.workTrees,
    settings: partitions.settings.settings,
    backups: partitions.misc.backups,
    trash: partitions.misc.trash,
    imageAnnotations: partitions.assets.imageAnnotations,
    windowState: partitions.runtime.windowState,
    uiState: partitions.runtime.uiState
  });
}

function createStorageManifest(serializedPartitions, slot = "a") {
  const partitions = {};
  for (const name of PARTITION_NAMES) {
    partitions[name] = { slot, sha256: serializedHash(serializedPartitions[name]) };
  }
  const now = new Date().toISOString();
  return {
    __xiaoyeStorage: { format: STORAGE_FORMAT, version: STORAGE_VERSION },
    createdAt: now,
    updatedAt: now,
    partitions
  };
}

function validateStorageManifest(value) {
  if (!isPlainObject(value) || value.__xiaoyeStorage?.format !== STORAGE_FORMAT || Number(value.__xiaoyeStorage?.version) !== STORAGE_VERSION) {
    throw new Error("小叶便签分区存储清单无效");
  }
  if (!isPlainObject(value.partitions)) throw new Error("小叶便签分区存储清单缺少 partitions");
  for (const name of PARTITION_NAMES) {
    const entry = value.partitions[name];
    if (!isPlainObject(entry) || !STORAGE_SLOTS.includes(entry.slot) || !/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ""))) {
      throw new Error(`小叶便签分区存储清单中的 ${name} 无效`);
    }
  }
  return value;
}

function serializePartitions(partitions) {
  const serialized = {};
  for (const name of PARTITION_NAMES) serialized[name] = serializeJson(validatePartition(name, partitions[name]));
  return serialized;
}

function oppositeSlot(slot) {
  return slot === "a" ? "b" : "a";
}

function rememberRevisionSnapshot() {
  revisionSnapshots.set(dataRevision, stripRuntimeFields(dataCache));
  while (revisionSnapshots.size > 30) revisionSnapshots.delete(revisionSnapshots.keys().next().value);
}

async function rotateBackups() {
  try {
    await fs.mkdir(backupDir(), { recursive: true });
    const entries = await fs.readdir(backupDir(), { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      if (entry.name.startsWith("xiaoye-note-before-sync-")) continue;
      const fullPath = path.join(backupDir(), entry.name);
      const stat = await fs.stat(fullPath).catch(() => null);
      if (stat) files.push({ name: entry.name, fullPath, mtimeMs: stat.mtimeMs });
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const keep = new Set(files.slice(0, 30).map(file => file.fullPath));
    for (const file of files) {
      if (file.mtimeMs >= sevenDaysAgo || keep.has(file.fullPath)) continue;
      await fs.unlink(file.fullPath).catch(() => {});
    }
  } catch (error) {
    console.error("[backup rotate]", error);
  }
}

async function createJsonBackup(reason = "manual", data = null, options = {}) {
  try {
    await fs.mkdir(backupDir(), { recursive: true });
    let payload = data;
    if (!payload) payload = stripRuntimeFields(await loadData());
    payload = await portableDataSnapshot(payload);
    const safeReason = String(reason || "manual").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 32) || "manual";
    const filePath = path.join(backupDir(), `xiaoye-note-${safeReason}-${timestampForFile()}.json`);
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
    if (!options.skipRotate) await rotateBackups();
    return filePath;
  } catch (error) {
    console.error("[backup create]", error);
    return "";
  }
}

async function maybeCreateAutoBackup(data) {
  if (data?.settings?.autoBackup === false) return "";
  try {
    await fs.mkdir(backupDir(), { recursive: true });
    const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
    const dailyPath = path.join(backupDir(), `xiaoye-note-auto-${day}.json`);
    await atomicWriteText(dailyPath, JSON.stringify(await portableDataSnapshot(data), null, 2));
    await rotateBackups();
    return dailyPath;
  } catch (error) {
    console.error("[backup auto]", error);
    return "";
  }
}

async function backupCorruptData(raw, error, label = "data") {
  try {
    await fs.mkdir(backupDir(), { recursive: true });
    const safeLabel = String(label || "data").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 32) || "data";
    const filePath = path.join(backupDir(), `xiaoye-note-corrupt-${safeLabel}-${timestampForFile()}.json`);
    await fs.writeFile(filePath, raw || String(error || ""), "utf8");
    return filePath;
  } catch (backupError) {
    console.error("[backup corrupt]", backupError);
    return "";
  }
}

function validateImportData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("导入文件不是有效的 JSON 对象");
  const hasKnownArray = ["todos", "events", "notes", "todoLists", "noteLists", "noteFolders", "trash", "workTrees"].some(key => Array.isArray(value[key]));
  if (!hasKnownArray && !value.settings) throw new Error("导入文件缺少小叶便签数据字段");
  return normalizeDataShape(value);
}

function mergeImportData(rawImport, currentData) {
  if (!rawImport || typeof rawImport !== "object" || Array.isArray(rawImport)) return validateImportData(rawImport);
  validateImportData(rawImport);
  const merged = { ...currentData, ...rawImport };
  if (rawImport.settings && typeof rawImport.settings === "object") merged.settings = { ...(currentData.settings || {}), ...rawImport.settings };
  if (rawImport.windowState && typeof rawImport.windowState === "object") merged.windowState = { ...(currentData.windowState || {}), ...rawImport.windowState };
  if (rawImport.uiState && typeof rawImport.uiState === "object") merged.uiState = { ...(currentData.uiState || {}), ...rawImport.uiState };
  if (rawImport.imageAnnotations && typeof rawImport.imageAnnotations === "object") merged.imageAnnotations = { ...(currentData.imageAnnotations || {}), ...rawImport.imageAnnotations };
  return validateImportData(merged);
}

function stripRuntimeFields(data) {
  const persisted = normalizeDataShape(data);
  delete persisted.__revision;
  delete persisted.__stale;
  delete persisted.__changedPartitions;
  return persisted;
}

async function readPartitionSlot(name, slot, expectedHash = "") {
  const filePath = partitionPath(name, slot);
  const raw = await readOptionalText(filePath);
  if (raw == null) {
    const error = new Error(`存储分区 ${name}.${slot} 不存在`);
    error.code = "ENOENT";
    throw error;
  }
  try {
    const actualHash = serializedHash(raw);
    if (expectedHash && actualHash !== expectedHash) throw new Error(`存储分区 ${name}.${slot} 校验失败`);
    const value = validatePartition(name, JSON.parse(raw));
    return { value, raw, hash: actualHash };
  } catch (error) {
    error.partitionRaw = raw;
    throw error;
  }
}

async function loadPartitionedStorage(manifestRaw) {
  let manifest;
  try {
    manifest = validateStorageManifest(JSON.parse(manifestRaw));
  } catch (error) {
    const backupPath = await backupCorruptData(manifestRaw, error, "storage-manifest");
    if (!backupPath) throw new Error("分区存储清单损坏且无法备份，已停止加载", { cause: error });
    throw new Error("分区存储清单损坏，已备份并停止加载", { cause: error });
  }

  const nextManifest = cloneJson(manifest);
  const partitions = {};
  const serialized = {};
  let repaired = false;

  for (const name of PARTITION_NAMES) {
    const active = manifest.partitions[name];
    try {
      const loaded = await readPartitionSlot(name, active.slot, active.sha256);
      partitions[name] = loaded.value;
      serialized[name] = loaded.raw;
      continue;
    } catch (activeError) {
      const corruptRaw = activeError.partitionRaw;
      if (corruptRaw != null) {
        const backupPath = await backupCorruptData(corruptRaw, activeError, `${name}-${active.slot}`);
        if (!backupPath) throw new Error(`存储分区 ${name} 损坏且无法备份，已停止加载`, { cause: activeError });
      }
      const fallbackSlot = oppositeSlot(active.slot);
      try {
        const fallback = await readPartitionSlot(name, fallbackSlot);
        partitions[name] = fallback.value;
        serialized[name] = fallback.raw;
        nextManifest.partitions[name] = { slot: fallbackSlot, sha256: fallback.hash };
        repaired = true;
      } catch (fallbackError) {
        throw new Error(`存储分区 ${name} 的活动副本和备用副本均不可用，已停止加载`, { cause: fallbackError });
      }
    }
  }

  if (repaired) {
    nextManifest.updatedAt = new Date().toISOString();
    await atomicWriteText(storageManifestPath(), serializeJson(nextManifest));
  }
  return { manifest: repaired ? nextManifest : manifest, partitions, serialized };
}

async function initializePartitionedStorage(data) {
  const partitions = splitDataPartitions(data);
  const serialized = serializePartitions(partitions);
  const manifest = createStorageManifest(serialized);
  for (const name of PARTITION_NAMES) {
    await atomicWriteText(partitionPath(name, "a"), serialized[name]);
  }
  await atomicWriteText(storageManifestPath(), serializeJson(manifest));
  return { manifest, partitions, serialized };
}

function setInitialDataCache(data) {
  dataRevision = Math.max(1, dataRevision + 1);
  dataCache = { ...stripRuntimeFields(data), __revision: dataRevision };
  rememberRevisionSnapshot();
}

async function initializeDataStorage() {
  const manifestRaw = await readOptionalText(storageManifestPath());
  if (manifestRaw != null) {
    storageState = await loadPartitionedStorage(manifestRaw);
    const loaded = assembleDataPartitions(storageState.partitions);
    const attachmentsMigrated = await externalizeNoteAttachments(loaded);
    setInitialDataCache(loaded);
    if (attachmentsMigrated) await commitDataSnapshot(loaded);
    const sanitized = cloneJson(loaded);
    const beforeWindowState = serializeJson(sanitized.windowState || {});
    sanitizeWindowState(sanitized);
    if (beforeWindowState !== serializeJson(sanitized.windowState || {})) await commitDataSnapshot(sanitized);
    return;
  }

  const existingEntries = await fs.readdir(app.getPath("userData"), { withFileTypes: true }).catch(error => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const hasPartitionArtifacts = existingEntries.some(entry =>
    entry.isFile() && PARTITION_NAMES.some(name => entry.name === `xiaoye-note-${name}.a.json` || entry.name === `xiaoye-note-${name}.b.json`)
  );
  if (hasPartitionArtifacts) {
    throw new Error("检测到分区文件但存储清单缺失，为避免用旧数据覆盖新数据，已停止加载");
  }

  const legacyRaw = await readOptionalText(dataPath());
  if (legacyRaw != null) {
    let legacyData;
    try {
      const parsed = JSON.parse(legacyRaw);
      if (!isPlainObject(parsed)) throw new Error("旧版数据文件不是有效对象");
      legacyData = normalizeDataShape(parsed);
    } catch (error) {
      const backupPath = await backupCorruptData(legacyRaw, error, "legacy-data");
      if (!backupPath) throw new Error("旧版数据文件损坏且无法备份，已停止加载", { cause: error });
      throw new Error("旧版数据文件损坏，已备份并停止加载", { cause: error });
    }
    sanitizeWindowState(legacyData);
    const migrationBackup = await createJsonBackup("pre-partition-migration", legacyData, { skipRotate: true });
    if (!migrationBackup) throw new Error("旧版数据迁移前备份失败，未写入分区存储");
    await externalizeNoteAttachments(legacyData);
    storageState = await initializePartitionedStorage(legacyData);
    setInitialDataCache(legacyData);
    rotateBackups().catch(console.error);
    return;
  }

  const initialData = normalizeDataShape(DEFAULT_DATA);
  sanitizeWindowState(initialData);
  storageState = await initializePartitionedStorage(initialData);
  setInitialDataCache(initialData);
}

async function ensureDataLoaded() {
  if (dataCache && storageState) return;
  if (!dataLoadPromise) {
    dataLoadPromise = initializeDataStorage().catch(error => {
      dataLoadPromise = null;
      dataCache = undefined;
      storageState = undefined;
      dataRevision = 0;
      revisionSnapshots.clear();
      throw error;
    });
  }
  await dataLoadPromise;
}

async function loadData() {
  await ensureDataLoaded();
  return cloneJson(dataCache);
}

async function loadWindowState() {
  await ensureDataLoaded();
  return cloneJson(dataCache.windowState || {});
}

async function commitDataSnapshot(nextData, { staged = false } = {}) {
  const persisted = stripRuntimeFields(nextData);
  sanitizeWindowState(persisted);
  await externalizeNoteAttachments(persisted);
  const partitions = splitDataPartitions(persisted);
  const serialized = serializePartitions(partitions);
  const changedPartitions = PARTITION_NAMES.filter(name => serialized[name] !== storageState.serialized[name]);
  if (!changedPartitions.length) return { __revision: dataRevision, __changedPartitions: [] };

  const nextManifest = cloneJson(storageState.manifest);
  for (const name of changedPartitions) {
    const nextSlot = oppositeSlot(storageState.manifest.partitions[name].slot);
    await atomicWriteText(partitionPath(name, nextSlot), serialized[name]);
    nextManifest.partitions[name] = { slot: nextSlot, sha256: serializedHash(serialized[name]) };
  }
  nextManifest.updatedAt = new Date().toISOString();
  await atomicWriteText(storageManifestPath(), serializeJson(nextManifest));

  const attachmentChanged = changedPartitions.includes("assets") &&
    serializeJson(storageState.partitions.assets.noteAttachments) !== serializeJson(partitions.assets.noteAttachments);
  const revisionChanged = attachmentChanged || changedPartitions.some(name => !["assets", "runtime"].includes(name));
  if (revisionChanged && !staged) dataRevision += 1;
  storageState = { manifest: nextManifest, partitions, serialized };
  dataCache = { ...persisted, __revision: dataRevision };
  rememberRevisionSnapshot();

  if (changedPartitions.some(name => name === "todos" || name === "settings")) setTrayMenu().catch(console.error);
  return { __revision: dataRevision, __changedPartitions: changedPartitions };
}

let autoSaveTimer;
async function stageDataSnapshot(nextData) {
  const persisted = stripRuntimeFields(nextData);
  sanitizeWindowState(persisted);
  await externalizeNoteAttachments(persisted);
  if (noteSync?.state && !syncStartupError && ["events", "todos", "workTrees", "reminderPreferences"].some(kind => JSON.stringify(persisted[kind] || []) !== JSON.stringify(dataCache?.[kind] || []))) {
    await noteSync.markScheduleChanged();
    scheduleNoteSync();
  }
  dataRevision += 1;
  deferredBusinessDirty = true;
  deferredRuntimeDirty = true;
  dataCache = { ...persisted, __revision: dataRevision };
  rememberRevisionSnapshot();
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => flushDeferredStorage().catch(error => console.error("[auto save]", error)), 500);
  return { __revision: dataRevision, __changedPartitions: ["deferred"] };
}

async function flushDeferredStorage() {
  clearTimeout(autoSaveTimer);
  return enqueueStorageOperation(async () => {
    if (!deferredBusinessDirty && !deferredRuntimeDirty && !pendingImportBackup) return { __revision: dataRevision, __changedPartitions: [] };
    const shouldBackup = deferredBusinessDirty;
    if (pendingImportBackup) {
      await createJsonBackup("before-import", pendingImportBackup);
      pendingImportBackup = null;
    }
    const saved = await commitDataSnapshot(dataCache, { staged: true });
    deferredBusinessDirty = false;
    deferredRuntimeDirty = false;
    if (shouldBackup) await maybeCreateAutoBackup(stripRuntimeFields(dataCache));
    return saved;
  });
}

function enqueueStorageOperation(operation) {
  const run = async () => {
    await ensureDataLoaded();
    return operation();
  };
  const task = saveQueue.then(run, run);
  saveQueue = task.then(() => undefined, () => undefined);
  return task;
}

function enqueueDataOperation(operation) {
  return enqueueStorageOperation(() => operation(cloneJson(dataCache)));
}

function updateData(mutator) {
  return enqueueDataOperation(async current => {
    const next = await mutator(current);
    return stageDataSnapshot(next || current);
  });
}

async function commitWindowStatePatch(patch) {
  const holder = { windowState: { ...(dataCache.windowState || {}), ...cloneJson(patch) } };
  sanitizeWindowState(holder);
  if (serializeJson(holder.windowState) === serializeJson(dataCache.windowState || {})) {
    dataCache = { ...dataCache, windowState: holder.windowState };
    return { windowState: cloneJson(holder.windowState), __changedPartitions: [] };
  }
  dataCache = { ...dataCache, windowState: holder.windowState };
  deferredRuntimeDirty = true;
  return { windowState: cloneJson(holder.windowState), __changedPartitions: ["runtime"] };
}

function updateWindowState(patch) {
  const snapshot = cloneJson(patch);
  return enqueueStorageOperation(() => commitWindowStatePatch(snapshot));
}

async function commitUiStatePatch(patch) {
  const uiState = mergeUiState(dataCache.uiState, patch);
  if (serializeJson(uiState) === serializeJson(dataCache.uiState || {})) {
    dataCache = { ...dataCache, uiState };
    return { uiState: cloneJson(uiState), __changedPartitions: [] };
  }
  dataCache = { ...dataCache, uiState };
  deferredRuntimeDirty = true;
  return { uiState: cloneJson(uiState), __changedPartitions: ["runtime"] };
}

function updateUiState(patch) {
  const snapshot = cloneJson(patch);
  return enqueueStorageOperation(() => commitUiStatePatch(snapshot));
}

function hasRevisionRelevantChanges(baseData, nextData) {
  const base = splitDataPartitions(baseData);
  const next = splitDataPartitions(nextData);
  for (const name of PARTITION_NAMES) {
    if (name === "runtime" || name === "assets") continue;
    if (serializeJson(base[name]) !== serializeJson(next[name])) return true;
  }
  return serializeJson(base.assets.noteAttachments) !== serializeJson(next.assets.noteAttachments);
}

if (process.env.XIAOYE_STORAGE_TEST === "1") {
  module.exports.__storageTest = {
    splitDataPartitions,
    assembleDataPartitions,
    serializePartitions,
    createStorageManifest,
    validateStorageManifest,
    hasRevisionRelevantChanges
  };
}

const windowSizes = {
  todo: { width: 500, height: 520, minWidth: 430, minHeight: 320 },
  notes: { width: 500, height: 520, minWidth: 430, minHeight: 320 },
  calendar: { width: 1040, height: 720, minWidth: 820, minHeight: 560 },
  worktree: { width: 1040, height: 720, minWidth: 820, minHeight: 560 },
  main: { width: 500, height: 520, minWidth: 430, minHeight: 320 }
};

let windowStateManager;

function getWindowStateManager() {
  if (!windowStateManager) {
    windowStateManager = createWindowStateManager({
      windowSizes,
      loadData,
      loadWindowState,
      saveWindowState: updateWindowState,
      windows,
      settings: {
        edgeAutoHideEnabled,
        keepWindowsOnScreenEnabled
      },
      debug: false
    });
  }
  return windowStateManager;
}

function normalizeSurface(surface) {
  return getWindowStateManager().normalizeSurface(surface);
}

function windowKind(kind) {
  return getWindowStateManager().windowKind(kind);
}

function sanitizeWindowState(data) {
  return getWindowStateManager().sanitizeWindowState(data);
}

function applyUserRequestedDefaultSettings(data) {
  data.settings = data.settings || {};
  const settings = data.settings;

  // Default color / appearance: dark. Keep explicit user choices.
  if (settings.theme == null) settings.theme = "dark";
  if (settings.appearance == null) settings.appearance = "dark";
  if (settings.colorMode == null) settings.colorMode = "dark";
  if (settings.defaultColor == null) settings.defaultColor = "dark";
  if (settings.defaultNoteColor == null) settings.defaultNoteColor = "dark";

  // Default sensitivity: high. Keep explicit user choices.
  if (settings.sensitivity == null) settings.sensitivity = "high";
  if (settings.edgeSensitivity == null) settings.edgeSensitivity = "high";
  if (settings.autoHideSensitivity == null) settings.autoHideSensitivity = "high";
  if (settings.hoverSensitivity == null) settings.hoverSensitivity = "high";

  return data;
}


function loginItemSettingsOptions(openAtLogin) {
  const options = { openAtLogin: Boolean(openAtLogin) };
  if (process.platform === "win32") {
    options.path = process.execPath;
    options.args = [];
  }
  return options;
}

function setLaunchAtStartup(value) {
  const options = loginItemSettingsOptions(value);
  app.setLoginItemSettings(options);
  return process.platform === "win32"
    ? app.getLoginItemSettings({ path: process.execPath, args: [] })
    : app.getLoginItemSettings();
}

async function applyLaunchAtStartupFromData() {
  const data = await loadData().catch(() => dataCache || DEFAULT_DATA);
  setLaunchAtStartup(Boolean(data?.settings?.launchAtStartup));
}

function edgeAutoHideEnabled() {
  return Boolean(dataCache?.settings?.enableEdgeAutoHide);
}

function keepWindowsOnScreenEnabled() {
  return dataCache?.settings?.keepWindowsOnScreen !== false;
}

function taskbarIconHidden() {
  return Boolean(dataCache?.settings?.hideTaskbarIcon);
}

function applyTaskbarVisibility(win) {
  if (!win || win.isDestroyed()) return;
  win.setSkipTaskbar(taskbarIconHidden());
}

function sanitizeTodayWidgetBounds(bounds = {}) {
  const width = Math.max(280, Math.min(600, Math.round(Number(bounds.width) || 320)));
  const height = Math.max(180, Math.min(800, Math.round(Number(bounds.height) || 360)));
  const probe = Number.isFinite(bounds.x) && Number.isFinite(bounds.y) ? { x: bounds.x, y: bounds.y, width, height } : screen.getPrimaryDisplay().workArea;
  const workArea = screen.getDisplayMatching(probe).workArea;
  const fallbackX = workArea.x + workArea.width - width - 24;
  const fallbackY = workArea.y + 24;
  return {
    x: Math.max(workArea.x, Math.min(Math.round(Number.isFinite(bounds.x) ? bounds.x : fallbackX), workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(Math.round(Number.isFinite(bounds.y) ? bounds.y : fallbackY), workArea.y + workArea.height - height)),
    width,
    height
  };
}

function saveTodayWidgetBounds() {
  if (!todayWidgetWindow || todayWidgetWindow.isDestroyed()) return Promise.resolve();
  return updateWindowState({ todayWidget: sanitizeTodayWidgetBounds(todayWidgetWindow.getBounds()) });
}

function scheduleTodayWidgetBoundsSave() {
  clearTimeout(todayWidgetBoundsTimer);
  todayWidgetBoundsTimer = setTimeout(() => saveTodayWidgetBounds().catch(console.error), 180);
}

async function boundsForSurface(surface, anchorBounds = {}) {
  return getWindowStateManager().getStableBoundsForSurface(surface, anchorBounds);
}

async function rememberBounds(surface, bounds, options = {}) {
  return getWindowStateManager().saveStableBounds(surface, bounds, options);
}

async function rememberCurrentWindowBounds(win, surface = null, bounds = null, options = {}) {
  if (!win || win.isDestroyed()) return null;
  const manager = getWindowStateManager();
  const state = manager.stateOf(win);
  if (surface) state.surface = normalizeSurface(surface);
  if (bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y) && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)) {
    const next = manager.sanitizeStableBounds(state.surface, bounds, state.stableBounds || bounds);
    state.stableBounds = options.positionOnly
      ? { ...next, width: state.stableBounds.width, height: state.stableBounds.height }
      : next;
  }
  return manager.rememberWindow(win, { ...options, reason: options.reason || "remember-current-window-bounds" });
}

async function rememberLastSurface(surface) {
  return getWindowStateManager().rememberLastSurface(surface);
}

async function lastSurface() {
  return getWindowStateManager().lastSurface();
}

function restoreWindowMinimum(win) {
  if (!win || win.isDestroyed()) return;
  getWindowStateManager().setMinimumForSurface(win, win.__surface || "todo");
}

function correctWindowPositionInsideScreen(win) {
  return getWindowStateManager().keepOnScreen(win, "keep-on-screen");
}

function clearTransientWindowState(win) {
  if (!win || win.isDestroyed()) return;
  getWindowStateManager().cancelInteraction(win);
}

function installNativeMoveClamp(win) {
  return getWindowStateManager().installNativeMoveClamp(win);
}

async function enableAutoHideForWindow(win) {
  return getWindowStateManager().enableAutoHide(win);
}

async function clearAutoHideState(win, _bounds = null, _options = {}) {
  return getWindowStateManager().disableAutoHide(win);
}

function expandAutoHide(win) {
  return getWindowStateManager().expand(win);
}

function scheduleAutoHideCollapse(win, delay = 800) {
  if (!win || win.isDestroyed()) return;
  setTimeout(() => getWindowStateManager().collapse(win), delay);
}

function activateWindow(win) {
  if (!win || win.isDestroyed()) return false;
  applyTaskbarVisibility(win);
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  expandAutoHide(win);
  win.moveTop();
  win.focus();
  return true;
}

function activateAnyWindow() {
  return activateWindow([...windows.values()].find(win => win && !win.isDestroyed()));
}

const BACKUP_EXCLUDED_KEYS = new Set(["__revision", "windowState", "settings", "uiState"]);

async function createWindow(kind = "todo") {
  kind = windowKind(kind);
  const initialBounds = await boundsForSurface(kind);
  const size = { width: initialBounds.width, height: initialBounds.height };
  if (Number.isFinite(initialBounds.x)) size.x = initialBounds.x;
  if (Number.isFinite(initialBounds.y)) size.y = initialBounds.y;

  const win = new BrowserWindow({
    ...size,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    icon: windowIconPath(),
    show: false,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    skipTaskbar: taskbarIconHidden(),
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const manager = getWindowStateManager();
  manager.initWindow(win, kind, initialBounds);
  win.__calendarZoomActive = false;
  manager.setMinimumForSurface(win, kind);
  installNativeMoveClamp(win);

  win.webContents.on("will-navigate", event => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  win.loadFile(path.join(__dirname, "../renderer/index.html"), { query: { mode: kind } });
  win.once("ready-to-show", () => {
    win.show();
    applyTaskbarVisibility(win);
    correctWindowPositionInsideScreen(win);
    if (edgeAutoHideEnabled()) enableAutoHideForWindow(win).catch(console.error);
  });
  win.on("closed", () => {
    manager.cleanup(win);
    windows.delete(kind);
  });
  win.on("resize", () => manager.onWindowResize(win));
  win.on("move", () => manager.onWindowMove(win));
  win.on("close", async () => {
    await manager.rememberWindow(win, { reason: "window-close-save" });
  });

  windows.set(kind, win);
  return win;
}

async function openTodayWidget() {
  if (todayWidgetWindow && !todayWidgetWindow.isDestroyed()) {
    if (!todayWidgetWindow.isVisible()) todayWidgetWindow.show();
    if (todayWidgetWindow.isMinimized()) todayWidgetWindow.restore();
    todayWidgetWindow.moveTop();
    todayWidgetWindow.focus();
    return todayWidgetWindow;
  }

  const data = await loadData();
  const bounds = sanitizeTodayWidgetBounds(data.windowState?.todayWidget || {});
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    icon: windowIconPath(),
    show: false,
    alwaysOnTop: data.settings?.todayWidgetAlwaysOnTop !== false,
    hasShadow: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    title: "今日",
    minWidth: 280,
    minHeight: 180,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  todayWidgetWindow = win;
  win.loadFile(path.join(__dirname, "../renderer/todayWidget.html"));
  win.once("ready-to-show", () => win.show());
  win.on("move", scheduleTodayWidgetBoundsSave);
  win.on("resize", scheduleTodayWidgetBoundsSave);
  win.on("close", event => {
    if (isQuitting) return;
    event.preventDefault();
    saveTodayWidgetBounds().catch(console.error);
    win.hide();
  });
  win.on("closed", () => {
    if (todayWidgetWindow === win) todayWidgetWindow = null;
  });
  return win;
}

async function openKind(kind) {
  kind = windowKind(kind);
  await rememberLastSurface(kind);
  const current = windows.get(kind);
  if (current && !current.isDestroyed()) {
    activateWindow(current);
    if (kind === "calendar") current.webContents.send("calendar:today");
    return current;
  }
  return createWindow(kind);
}

async function openLastSurface() {
  return openKind(await lastSurface());
}

// 全局快速记录：任何时候按下快捷键，唤出最近使用的窗口并直接聚焦到输入框。
const QUICK_CAPTURE_SHORTCUT = "CommandOrControl+Alt+N";

async function quickCapture() {
  const open = [...windows.values()].filter(win => win && !win.isDestroyed());
  let win = open.find(item => item.isFocused()) || open[0];
  if (win) {
    activateWindow(win);
    win.webContents.send("app:quickCapture");
    return;
  }
  win = await openLastSurface();
  if (!win || win.isDestroyed()) return;
  const send = () => { if (!win.isDestroyed()) win.webContents.send("app:quickCapture"); };
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", send);
  else send();
}

function registerQuickCaptureShortcut() {
  try {
    if (!globalShortcut.register(QUICK_CAPTURE_SHORTCUT, () => quickCapture().catch(console.error))) {
      console.warn(`快速记录快捷键 ${QUICK_CAPTURE_SHORTCUT} 已被其他程序占用`);
    }
  } catch (error) {
    console.error(error);
  }
}

async function broadcastDataChanged(reason = "data:changed") {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) win.webContents.send("data:changed", { reason });
  });
}

function nextRepeatDateKey(dateKey, repeat) {
  const [year, month, day] = String(dateKey || "").split("-").map(Number);
  if (!year || !month || !day) return "";
  const date = new Date(year, month - 1, day);
  if (repeat === "daily") date.setDate(date.getDate() + 1);
  else if (repeat === "workdays") {
    do { date.setDate(date.getDate() + 1); } while ([0, 6].includes(date.getDay()));
  } else if (repeat === "weekly") date.setDate(date.getDate() + 7);
  else if (repeat === "monthly" || repeat === "yearly") {
    const months = repeat === "monthly" ? 1 : 12;
    const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
    target.setDate(Math.min(date.getDate(), new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()));
    return localDateKey(target);
  } else return "";
  return localDateKey(date);
}

function ensureNextRepeatedEvent(data, event) {
  const repeat = normalizeRepeatValue(event.repeat);
  if (repeat === "none") return;
  const nextDate = nextRepeatDateKey(event.date, repeat);
  if (!nextDate || (event.repeatEndDate && nextDate > event.repeatEndDate)) return;
  const parentId = event.repeatParentId || event.id;
  const exists = data.events.some(item => (item.repeatParentId || item.id) === parentId && item.date === nextDate);
  if (exists) { event.repeatEndDate = event.date; return; }
  const now = new Date().toISOString();
  data.events.push({ ...cloneJson(event), id: `event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, date: nextDate, completed: false, repeatParentId: parentId, reminderLastKey: "", reminderLastFiredAt: "", createdAt: now, updatedAt: now });
  event.repeatEndDate = event.date;
}

function syncLinkedTodoFromEvent(data, event) {
  if (!event.todoId) return;
  const todo = data.todos.find(item => item.id === event.todoId);
  if (!todo) return;
  const now = new Date().toISOString();
  const series = isSeriesEvent(data.events, event);
  todo.completed = series ? linkedTodoCompleted(data.events, todo.id, nextRepeatDateKey) : Boolean(event.completed);
  todo.updatedAt = now;
  data.events.filter(item => item.todoId === todo.id && !series).forEach(item => {
    setEventCompleted(item, todo.completed, localDateKey());
    if (item.ongoing || todo.taskType === "goal") item.color = todo.completed ? (data.settings?.eventDoneColor || "#78d68f") : item.ongoing ? "#ff8a65" : "#ffd21a";
    item.updatedAt = now;
  });
  const tree = data.workTrees.find(item => item.id === todo.workTreeId) || data.workTrees.find(item => item.nodes?.some(node => node.todoId === todo.id));
  const node = tree?.nodes?.find(item => item.id === todo.workTreeNodeId || item.todoId === todo.id);
  if (node) {
    node.completed = todo.completed;
    node.updatedAt = now;
    tree.updatedAt = now;
  }
}

async function addQuickTodo() {
  await updateData(data => {
    const now = new Date();
    data.todos = Array.isArray(data.todos) ? data.todos : [];
    data.todos.push({
      id: `todo-${Date.now().toString(36)}`,
      title: "新待办",
      completed: false,
      pinned: false,
      order: data.todos.length,
      tags: [],
      targetDate: now.toISOString().slice(0, 10),
      reminderAt: "",
      reminderLead: data.settings?.reminderLead || "none",
      repeat: "none",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    });
    return data;
  });
  await openKind("todo");
  await broadcastDataChanged("tray-quick-add-todo");
}

async function addQuickNote() {
  await updateData(data => {
    const now = new Date().toISOString();
    data.notes = Array.isArray(data.notes) ? data.notes : [];
    const folderId = data.noteFolders?.[0]?.id || data.noteLists?.[0]?.id || "";
    data.notes.push({
      id: `note-${Date.now().toString(36)}`,
      title: "新便签",
      body: "",
      folderId,
      tags: [],
      pinned: false,
      archived: false,
      order: data.notes.length,
      attachments: [],
      createdAt: now,
      updatedAt: now
    });
    return data;
  });
  await openKind("notes");
  await broadcastDataChanged("tray-quick-add-note");
}


async function exportAllDataDialog() {
  const data = await portableDataSnapshot(await loadData());
  const result = await dialog.showSaveDialog({
    title: "导出小叶便签数据",
    defaultPath: `xiaoye-note-export-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, JSON.stringify(data, null, 2), "utf8");
  return { canceled: false, filePath: result.filePath };
}

async function importJsonDialog() {
  const result = await dialog.showOpenDialog({
    title: "导入小叶便签数据",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
  const raw = await fs.readFile(result.filePaths[0], "utf8");
  await importData(JSON.parse(raw));
  const saved = await loadData();
  await broadcastDataChanged("data-imported");
  return { canceled: false, counts: { todos: saved.todos.length, events: saved.events.length, notes: saved.notes.length } };
}

function importData(rawImport) {
  return enqueueDataOperation(async latest => {
    const current = stripRuntimeFields(latest);
    const imported = mergeImportData(rawImport, current);
    if (!pendingImportBackup) pendingImportBackup = cloneJson(current);
    return stageDataSnapshot(imported);
  });
}

async function createManualBackupDialog() {
  const filePath = await createJsonBackup("manual", stripRuntimeFields(await loadData()));
  return { filePath };
}

async function setTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "快速记录", accelerator: QUICK_CAPTURE_SHORTCUT, click: () => quickCapture().catch(console.error) },
    { type: "separator" },
    { label: "重启便签", click: () => { restartRequested = true; app.quit(); } },
    { type: "separator" },
    {
      label: "备份/恢复选项",
      submenu: [
        { label: "导出全部", click: () => exportAllDataDialog().catch(console.error) },
        { label: "导入 JSON", click: () => importJsonDialog().catch(console.error) },
        { label: "立即备份", click: () => createManualBackupDialog().catch(console.error) },
        { type: "separator" },
        { label: "打开数据目录", click: () => shell.openPath(app.getPath("userData")) },
        { label: "打开备份目录", click: async () => { await fs.mkdir(backupDir(), { recursive: true }); shell.openPath(backupDir()); } }
      ]
    },
    { type: "separator" },
    {
      label: "最小化全部窗口",
      click: () => BrowserWindow.getAllWindows().forEach(win => win.minimize())
    },
    { type: "separator" },
    {
      label: "退出小叶便签",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
}

function createTray() {
  if (tray) return;
  const image = nativeImage.createFromPath(trayIconPath());
  tray = new Tray(image);
  tray.setToolTip(APP_NAME);
  setTrayMenu().catch(console.error);
  tray.on("click", () => {
    if (!activateAnyWindow()) openLastSurface().catch(console.error);
  });
}

app.whenReady().then(async () => {
  registerAttachmentProtocol();
  await applyLaunchAtStartupFromData();
  await initializeNoteSync();
  checkBackgroundReminders().catch(console.error);
  reminderBackgroundTimer = setInterval(() => checkBackgroundReminders().catch(console.error), 30000);
  reminderBackgroundTimer.unref();
  createTray();
  registerQuickCaptureShortcut();
  openLastSurface().catch(console.error);
  app.on("activate", () => {
    if (!activateAnyWindow()) openLastSurface().catch(console.error);
  });
});

app.on("before-quit", event => {
  isQuitting = true;
  clearTimeout(syncTimer);
  clearInterval(syncPoll);
  clearInterval(reminderBackgroundTimer);
  if (quitFlushCompleted) return;
  event.preventDefault();
  if (quitFlushPromise) return;
  quitFlushPromise = flushDeferredStorage()
    .then(() => {
      quitFlushCompleted = true;
      if (restartRequested) app.relaunch();
      app.quit();
    })
    .catch(error => {
      isQuitting = false;
      restartRequested = false;
      dialog.showErrorBox("小叶便签未退出", `保存数据失败：${error.message || error}`);
    })
    .finally(() => {
      quitFlushPromise = null;
    });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", event => {
  if (!isQuitting) event.preventDefault();
});

ipcMain.handle("data:load", loadData);
ipcMain.handle("todayWidget:addEvent", async (_event, title) => {
  const clean = String(title || "").trim().slice(0, 200);
  if (!clean) return { added: false };
  const saved = await updateData(data => {
    const now = new Date().toISOString();
    data.events = Array.isArray(data.events) ? data.events : [];
    data.events.push({
      id: `event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      title: clean,
      date: localDateKey(),
      startTime: "",
      endTime: "",
      color: data.settings?.eventTodoColor || data.settings?.accentColor || "#ffd21a",
      tags: [],
      repeat: "none",
      repeatEndDate: "",
      repeatParentId: "",
      repeatSkippedDates: [],
      reminderAt: "",
      reminderLead: "none",
      reminderLastKey: "",
      reminderLastFiredAt: "",
      todoId: "",
      completed: false,
      note: "",
      createdAt: now,
      updatedAt: now
    });
    return data;
  });
  await broadcastDataChanged("today-widget-add");
  return { added: true, __revision: saved.__revision };
});
ipcMain.handle("todayWidget:toggleEvent", async (_event, eventId, completed, occurrenceDate) => {
  const id = String(eventId || "");
  let changed = false;
  const saved = await updateData(data => {
    let event = (data.events || []).find(item => item.id === id);
    if (!event) return data;
    const occurrence = String(occurrenceDate || event.date);
    event = occurrenceFor(data.events, event, occurrence, `event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, new Date().toISOString());
    setEventCompleted(event, completed, localDateKey());
    event.updatedAt = new Date().toISOString();
    syncLinkedTodoFromEvent(data, event);
    changed = true;
    return data;
  });
  if (changed) await broadcastDataChanged("today-widget-toggle");
  return { changed, __revision: saved.__revision };
});
ipcMain.handle("todayWidget:setAlwaysOnTop", async (event, value) => {
  const alwaysOnTop = Boolean(value);
  await updateData(data => {
    data.settings = { ...(data.settings || {}), todayWidgetAlwaysOnTop: alwaysOnTop };
    return data;
  });
  const win = todayWidgetWindow;
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(alwaysOnTop, "floating");
  await broadcastDataChanged("today-widget-pin");
  return alwaysOnTop;
});
ipcMain.handle("todayWidget:close", async () => {
  await saveTodayWidgetBounds();
  if (todayWidgetWindow && !todayWidgetWindow.isDestroyed()) todayWidgetWindow.hide();
});
ipcMain.handle("runtime:saveUiStatePatch", (_, patch) => updateUiState(patch));
ipcMain.handle("data:save", (event, nextData, options) => {
  const incomingSnapshot = nextData && typeof nextData === "object" ? nextData : {};
  return enqueueDataOperation(async current => {
    const incomingRevision = Number(incomingSnapshot?.__revision || 0);
    const currentRevision = Number(current.__revision || 0);
    const incoming = { ...(incomingSnapshot || {}) };
    delete incoming.__revision;
    delete incoming.__stale;
    delete incoming.__changedPartitions;

    let merged;
    const nextUiState = mergeUiState(current.uiState, incoming.uiState);
    if (incomingRevision && incomingRevision < currentRevision) {
      const base = revisionSnapshots.get(incomingRevision);
      const incomingAtBase = base && normalizeDataShape({
        ...base,
        ...incoming,
        windowState: base.windowState || {},
        imageAnnotations: base.imageAnnotations || {}
      });
      if (!base || hasRevisionRelevantChanges(base, incomingAtBase)) {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
          win.webContents.send("data:changed", { reason: "stale-save-blocked", revision: currentRevision });
        }
        return { __revision: currentRevision, __stale: true };
      }
      merged = normalizeDataShape({
        ...current,
        uiState: nextUiState,
        windowState: current.windowState || {},
        imageAnnotations: current.imageAnnotations || {}
      });
    } else {
      merged = normalizeDataShape({
        ...current,
        ...incoming,
        uiState: nextUiState,
        windowState: current.windowState || {},
        imageAnnotations: current.imageAnnotations || {}
      });
    }
    const passwordUpdate = options?.subscriptionPassword;
    if (current.settings?.subscriptionPasswords) merged.settings.subscriptionPasswords = { ...current.settings.subscriptionPasswords };
    else delete merged.settings.subscriptionPasswords;
    let passwordCipher;
    if (passwordUpdate) {
      if (typeof passwordUpdate.password !== 'string' || !passwordUpdate.password || !merged.events.some(item => item.id === passwordUpdate.eventId && item.subscription)) throw new Error('订阅密码保存请求无效。');
      if (!safeStorage.isEncryptionAvailable()) throw new Error('本机密码加密暂不可用，请重试。');
      passwordCipher = safeStorage.encryptString(passwordUpdate.password).toString('base64');
      merged.settings.subscriptionPasswords = { ...(merged.settings.subscriptionPasswords || {}), [passwordUpdate.eventId]: passwordCipher };
    }
    const wasEdgeAutoHideEnabled = Boolean(current.settings?.enableEdgeAutoHide);
    const nextEdgeAutoHideEnabled = Boolean(merged.settings?.enableEdgeAutoHide);
    const wasKeepOnScreenEnabled = current.settings?.keepWindowsOnScreen !== false;
    const nextKeepOnScreenEnabled = merged.settings?.keepWindowsOnScreen !== false;
    const settingsChanged = JSON.stringify(current.settings || {}) !== JSON.stringify(merged.settings || {});

    if (settingsChanged) BrowserWindow.getAllWindows().forEach(clearTransientWindowState);
    const saved = await stageDataSnapshot(merged);

    if (wasEdgeAutoHideEnabled !== nextEdgeAutoHideEnabled && !nextEdgeAutoHideEnabled) {
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) clearAutoHideState(win).catch(console.error);
      });
    } else if (wasEdgeAutoHideEnabled !== nextEdgeAutoHideEnabled && nextEdgeAutoHideEnabled) {
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) enableAutoHideForWindow(win).catch(console.error);
      });
    }
    if (!wasKeepOnScreenEnabled && nextKeepOnScreenEnabled) {
      BrowserWindow.getAllWindows().forEach(win => {
        clearTransientWindowState(win);
        correctWindowPositionInsideScreen(win);
      });
    }
    if (settingsChanged) BrowserWindow.getAllWindows().forEach(win => applyTaskbarVisibility(win));
    if ((saved.__changedPartitions || []).some(name => name !== "runtime")) {
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed() && win.webContents !== event.sender) win.webContents.send("data:changed");
      });
    }
    return passwordCipher ? { ...saved, __subscriptionPasswordCipher: passwordCipher } : saved;
  });
});
ipcMain.handle("data:exportAll", exportAllDataDialog);

ipcMain.handle("data:importJson", async () => {
  const result = await dialog.showOpenDialog({
    title: "导入小叶便签数据",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
  const raw = await fs.readFile(result.filePaths[0], "utf8");
  await importData(JSON.parse(raw));
  const saved = await loadData();
  await broadcastDataChanged("data-imported");
  return { canceled: false, counts: { todos: saved.todos.length, events: saved.events.length, notes: saved.notes.length } };
});

ipcMain.handle("data:createBackup", async () => {
  const filePath = await createJsonBackup("manual", stripRuntimeFields(await loadData()));
  return { filePath };
});

ipcMain.handle("event:openUrl", async (_, value) => {
  const url = EventAddress.webUrl(value);
  if (!url) throw new Error("请输入有效的 http 或 https 网页链接。");
  await shell.openExternal(url);
  return { opened: true };
});

ipcMain.handle("data:openDataDir", async () => {
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  return shell.openPath(app.getPath("userData"));
});

ipcMain.handle("data:openBackupDir", async () => {
  await fs.mkdir(backupDir(), { recursive: true });
  return shell.openPath(backupDir());
});

ipcMain.handle("data:exportNote", async (_event, note, format = "md") => {
  if (!note || typeof note !== "object") throw new Error("缺少便签数据");
  const safeTitle = String(note.title || "未命名便签").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "note";
  const ext = format === "txt" ? "txt" : "md";
  const result = await dialog.showSaveDialog({
    title: "导出便签",
    defaultPath: `${safeTitle}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const tags = Array.isArray(note.tags) && note.tags.length ? `\n\n标签：${note.tags.join(", ")}` : "";
  const body = format === "txt"
    ? `${note.title || "未命名便签"}\n\n${note.body || ""}${tags}\n`
    : `# ${note.title || "未命名便签"}\n\n${note.body || ""}${tags}\n`;
  await fs.writeFile(result.filePath, body, "utf8");
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle("data:exportNoteFolder", async (_event, folderName, notes = []) => {
  const result = await dialog.showOpenDialog({ title: "选择便签导出目录", properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
  const dir = path.join(result.filePaths[0], String(folderName || "便签导出").replace(/[\\/:*?"<>|]+/g, "_"));
  await fs.mkdir(dir, { recursive: true });
  for (const note of Array.isArray(notes) ? notes : []) {
    const safeTitle = String(note.title || note.id || "未命名便签").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "note";
    await fs.writeFile(path.join(dir, `${safeTitle}.md`), `# ${note.title || "未命名便签"}\n\n${note.body || ""}\n`, "utf8");
  }
  return { canceled: false, dir };
});

ipcMain.handle("worktree:exportMindmapPng", async (event, payload = {}) => {
  const bytes = attachmentInputBuffer(payload.bytes);
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes?.length || bytes.length < pngSignature.length || !bytes.subarray(0, pngSignature.length).equals(pngSignature)) throw new Error("树状图 PNG 数据无效");
  const safeTitle = String(payload.title || "项目树状图").replace(/[\\/:*?\"<>|]+/g, "_").slice(0, 80) || "worktree";
  const parent = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: "导出树状图 PNG",
    defaultPath: `${safeTitle}.png`,
    filters: [{ name: "PNG 图片", extensions: ["png"] }]
  };
  const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { canceled: true };
  await atomicWriteBinary(result.filePath, bytes);
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle("clipboard:readNotePaste", async () => {
  const image = clipboard.readImage();
  if (!image.isEmpty()) return { type: "image", attachment: await persistNativeImageAttachment(image) };
  const text = clipboard.readText();
  return text ? { type: "text", text } : { type: "empty" };
});
ipcMain.handle("clipboard:readSchedulePaste", () => {
  const image = clipboard.readImage();
  if (!image.isEmpty()) return { type: "image", dataUrl: image.toDataURL() };
  const text = clipboard.readText();
  return text ? { type: "text", text } : { type: "empty" };
});
ipcMain.handle('subscription:copyPassword', (_, input = {}) => enqueueDataOperation(current => {
  let text = typeof input.password === 'string' ? input.password : '';
  if (!text) {
    const cipher = current.settings?.subscriptionPasswords?.[input.eventId];
    if (typeof cipher !== 'string' || !cipher) throw new Error('请先填写并保存密码。');
    text = safeStorage.decryptString(Buffer.from(cipher, 'base64'));
  }
  clipboard.writeText(text);
  return true;
}));
ipcMain.handle("attachment:import", (_, payload) => persistAttachment(payload));

function icsEscape(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function eventDateTimeForIcs(date, time) {
  const cleanDate = String(date || "").replace(/-/g, "");
  const cleanTime = String(time || "00:00").replace(":", "") + "00";
  return `${cleanDate}T${cleanTime}`;
}

function repeatToRRule(repeat, until) {
  const map = { daily: "FREQ=DAILY", workdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", weekly: "FREQ=WEEKLY", monthly: "FREQ=MONTHLY", yearly: "FREQ=YEARLY" };
  const base = map[normalizeRepeatValue(repeat)];
  if (!base) return "";
  return until ? `${base};UNTIL=${String(until).replace(/-/g, "")}T235959` : base;
}

ipcMain.handle("data:exportIcs", async (_event, events = []) => {
  const result = await dialog.showSaveDialog({
    title: "导出日历 ICS",
    defaultPath: `xiaoye-note-calendar-${new Date().toISOString().slice(0, 10)}.ics`,
    filters: [{ name: "iCalendar", extensions: ["ics"] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Xiaoye Note//Calendar//CN", "CALSCALE:GREGORIAN"];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event.date) continue;
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${icsEscape(event.id || `${event.date}-${event.title}`)}@xiaoye-note`);
    lines.push(`DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`);
    lines.push(`DTSTART:${eventDateTimeForIcs(event.date, event.startTime)}`);
    if (event.endTime) lines.push(`DTEND:${eventDateTimeForIcs(event.date, event.endTime)}`);
    lines.push(`SUMMARY:${icsEscape(event.title)}`);
    if (event.note) lines.push(`DESCRIPTION:${icsEscape(event.note)}`);
    const rrule = repeatToRRule(event.repeat, event.repeatEndDate);
    if (rrule) lines.push(`RRULE:${rrule}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  await fs.writeFile(result.filePath, `${lines.join("\r\n")}\r\n`, "utf8");
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle("reminder:notify", async (_event, payload = {}) => {
  const data = await loadData();
  if (data.settings?.pauseReminders) return { skipped: true };
  const title = String(payload.title || "小叶便签提醒").slice(0, 120);
  const body = String(payload.body || "").slice(0, 500);
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body, icon: windowIconPath(), silent: false });
    notification.show();
    return { shown: true };
  }
  return { shown: false };
});

ipcMain.handle("window:minimize", event => BrowserWindow.fromWebContents(event.sender)?.minimize());
ipcMain.handle("window:getBounds", event => BrowserWindow.fromWebContents(event.sender)?.getBounds());
ipcMain.on("window:dragStart", event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const manager = getWindowStateManager();
  if (!manager.beginManualMove(win)) return;
  win.__manualDrag = { cursor: screen.getCursorScreenPoint(), bounds: win.getBounds() };
});
ipcMain.on("window:dragMove", event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const drag = win?.__manualDrag;
  if (!win || win.isDestroyed() || !drag) return;
  const state = getWindowStateManager().stateOf(win);
  if (!state.isNativeSizeMoveActive || state.nativeInteractionKind !== "moving") {
    win.__manualDrag = null;
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  win.setBounds({
    x: Math.round(drag.bounds.x + cursor.x - drag.cursor.x),
    y: Math.round(drag.bounds.y + cursor.y - drag.cursor.y),
    width: drag.bounds.width,
    height: drag.bounds.height
  }, false);
});
ipcMain.on("window:dragEnd", event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !win.__manualDrag) return;
  win.__manualDrag = null;
  getWindowStateManager().finishManualMove(win);
});
ipcMain.handle("window:switchSurfaceOnly", async (event, surface) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const manager = getWindowStateManager();
  const previousSurface = normalizeSurface(win.__surface || "todo");
  const nextSurface = normalizeSurface(surface);

  const duplicate = windows.get(nextSurface);
  if (duplicate && duplicate !== win && !duplicate.isDestroyed()) {
    await manager.rememberWindow(duplicate, { reason: "surface-switch-save-duplicate" });
    duplicate.hide();
  }
  if (windows.get(previousSurface) === win) windows.delete(previousSurface);
  windows.set(nextSurface, win);

  const corrected = await manager.applySurface(win, nextSurface);
  const { windowStatePatch = {}, ...bounds } = corrected || {};
  return {
    ...bounds,
    fullBounds: undefined,
    autoHide: null,
    windowStatePatch
  };
});
ipcMain.handle("window:applySurfaceBounds", async (event, surface, _bounds) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const manager = getWindowStateManager();
  const previousSurface = normalizeSurface(win.__surface || "todo");
  const nextSurface = normalizeSurface(surface);

  const duplicate = windows.get(nextSurface);
  if (duplicate && duplicate !== win && !duplicate.isDestroyed()) {
    await manager.rememberWindow(duplicate, { reason: "surface-switch-save-duplicate" });
    duplicate.hide();
  }
  if (windows.get(previousSurface) === win) windows.delete(previousSurface);
  windows.set(nextSurface, win);

  const corrected = await manager.applySurface(win, nextSurface);
  const { windowStatePatch = {}, ...bounds } = corrected || {};
  return {
    ...bounds,
    fullBounds: undefined,
    autoHide: null,
    windowStatePatch
  };
});

ipcMain.handle("window:toggleCalendarBounds", async event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const manager = getWindowStateManager();
  const currentSurface = normalizeSurface(win.__surface || "todo");
  if (currentSurface === "calendar" || currentSurface === "worktree") return;

  const state = manager.stateOf(win);
  const currentStable = manager.sanitizeStableBounds(currentSurface, state.stableBounds || win.getBounds(), win.getBounds());

  state.isSurfaceSwitching = true;
  state.isAutoHideCollapsed = false;
  state.isAutoHideTransitioning = false;
  state.autoHideEdge = "";
  state.collapsedBounds = null;
  win.webContents.send("window:autoHideState", { collapsed: false, edge: "", surface: currentSurface });
  try {
    const largeBounds = await boundsForSurface("calendar", currentStable);
    const nextBounds = manager.sanitizeStableBounds("calendar", largeBounds, currentStable);
    win.__calendarZoomActive = false;
    win.setMinimumSize(1, 1);
    const applied = manager.setWindowBounds(win, nextBounds, "calendar-size-toggle", { keepOnScreen: keepWindowsOnScreenEnabled(), programmaticHoldMs: 250 });
    state.stableBounds = manager.sanitizeStableBounds(currentSurface, applied, applied);
    await manager.saveStableBounds(currentSurface, state.stableBounds, { reason: "compact-sync-large-size" });
    restoreWindowMinimum(win);

    const latest = await loadData();
    return { bounds: applied, windowState: latest.windowState };
  } finally {
    setTimeout(() => {
      if (win && !win.isDestroyed()) manager.stateOf(win).isSurfaceSwitching = false;
    }, 350);
  }
});

ipcMain.handle("window:close", async event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  await getWindowStateManager().rememberWindow(win, { reason: "window-close-hide-save" });
  await rememberLastSurface(win.__surface || "todo");
  win.setSkipTaskbar(true);
  win.hide();
});
ipcMain.handle("window:setAlwaysOnTop", (event, value) => BrowserWindow.fromWebContents(event.sender)?.setAlwaysOnTop(Boolean(value), "floating"));
ipcMain.handle("window:setOpacity", (event, value) => BrowserWindow.fromWebContents(event.sender)?.setOpacity(Number(value)));
function safePreviewTheme(settings = {}) {
  const mode = settings.imagePreviewBackground === "light" ? "light" : settings.imagePreviewBackground === "dark" ? "dark" : (settings.theme === "light" ? "light" : "dark");
  const accent = settings.themeColor || settings.accentColor || settings.eventTodoColor || "#ffd21a";
  const opacity = Math.max(0.45, Math.min(0.98, Number(settings.opacity ?? 0.82)));
  return { theme: mode, accent, opacity };
}

function imageAnnotationKey(src) {
  if (src && typeof src === "object") return String(src.annotationKey || (src.id ? `attachment:${src.id}` : ""));
  return attachmentAnnotationKey(src);
}

function imagePreviewSource(src) {
  if (src && typeof src === "object" && /^[a-f0-9]{64}$/i.test(String(src.id || ""))) {
    return attachmentUrl(src.id);
  }
  return typeof src === "string" ? src : "";
}

async function saveImageAnnotation(key, payload) {
  if (!key) return false;
  const hasContent = payload && (
    typeof payload === "string" ||
    (Array.isArray(payload.strokes) && payload.strokes.length > 0)
  );
  await updateData(data => {
    data.imageAnnotations = data.imageAnnotations && typeof data.imageAnnotations === "object" ? data.imageAnnotations : {};
    if (hasContent) data.imageAnnotations[key] = payload;
    else delete data.imageAnnotations[key];
    return data;
  });
  return true;
}

async function setImagePreviewBackground(mode) {
  const nextMode = mode === "light" ? "light" : "dark";
  const saved = await updateData(data => {
    data.settings = data.settings || {};
    data.settings.imagePreviewBackground = nextMode;
    return data;
  });
  await broadcastDataChanged("image-preview-background-changed");
  return safePreviewTheme(saved.settings);
}

function previewHtml(src, themeInfo, annotationKey, annotationData) {
  const payload = JSON.stringify({ src, annotationKey, annotationData: annotationData || null, ...themeInfo });
  return `<!doctype html><html><head><meta charset="utf-8"><title>图片预览</title><style>
    :root{--accent:${themeInfo.accent};--opacity:${themeInfo.opacity};--panel:rgba(18,18,18,var(--opacity));--text:#f5f0dc;--border:rgba(255,255,255,.13);--stage:#111;}
    :root[data-theme="light"]{--panel:rgba(255,250,232,var(--opacity));--text:#28230f;--border:rgba(40,35,15,.14);--stage:#f5f1e7;}
    html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent;color:var(--text);font-family:"Microsoft YaHei UI","Segoe UI",sans-serif;user-select:none;}
    body{display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--border);border-radius:0;box-sizing:border-box;box-shadow:0 22px 70px rgba(0,0,0,.34);}
    .titlebar{height:42px;display:flex;align-items:center;gap:8px;padding:0 10px 0 14px;border-bottom:1px solid var(--border);-webkit-app-region:drag;box-sizing:border-box;}
    .title{font-size:13px;font-weight:700;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .done,.close{height:28px;border:0;border-radius:0;background:rgba(255,255,255,.10);color:var(--text);cursor:pointer;-webkit-app-region:no-drag;}
    .done{display:none;padding:0 12px;font-size:12px;font-weight:700;}
    body.editing .done{display:inline-block;}
    .done:hover{background:color-mix(in srgb,var(--accent) 34%,transparent);}
    .close{width:28px;font-size:20px;line-height:26px;}
    .close:hover{background:rgba(255,77,79,.78);color:#fff;}
    .stage{position:relative;flex:1;overflow:hidden;cursor:grab;background:var(--stage);border-radius:0;}
    .stage.dragging{cursor:grabbing;}
    img{position:absolute;left:50%;top:50%;max-width:none;max-height:none;transform-origin:center center;will-change:transform;-webkit-user-drag:none;user-drag:none;}
    canvas{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;}
    body.editing canvas{pointer-events:auto;}
    body.pen .stage{cursor:crosshair;}
    body.eraser .stage{cursor:cell;}
    .toast{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);padding:6px 10px;border-radius:0;background:rgba(0,0,0,.45);color:#fff;font-size:12px;opacity:0;transition:opacity .16s;pointer-events:none;}
    .toast.show{opacity:1;}
  </style></head><body><div class="titlebar"><span class="title">图片预览</span><button class="done" id="done" title="完成标注">完成</button><button class="close" id="close" title="关闭">×</button></div><div class="stage" id="stage"><img id="image" alt="图片预览"><canvas id="marks"></canvas></div><div class="toast" id="toast"></div><script>
    const data=${payload};
    document.documentElement.dataset.theme=data.theme;
    const stage=document.getElementById('stage');
    const image=document.getElementById('image');
    const canvas=document.getElementById('marks');
    const ctx=canvas.getContext('2d');
    const toast=document.getElementById('toast');
    let scale=1, fitScale=1, offsetX=0, offsetY=0, dragging=false, drawing=false, lastX=0, lastY=0, mode='pan', dirty=false;
    let strokes=[], activeStroke=null;
    image.src=data.src;
    function say(text){toast.textContent=text;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),1200);}
    function setMode(next){mode=next;document.body.classList.toggle('editing',mode==='pen'||mode==='eraser');document.body.classList.toggle('pen',mode==='pen');document.body.classList.toggle('eraser',mode==='eraser');}
    function stageRect(){return stage.getBoundingClientRect();}
    function imageMetrics(){const r=stageRect();const w=(image.naturalWidth||1)*scale;const h=(image.naturalHeight||1)*scale;return {left:r.width/2-w/2+offsetX,top:r.height/2-h/2+offsetY,width:w,height:h};}
    function eventToImagePoint(e){const m=imageMetrics();return {x:(e.offsetX-m.left)/scale,y:(e.offsetY-m.top)/scale};}
    function drawStrokes(targetCtx, metrics, ratio){
      const sx=metrics.width/(image.naturalWidth||1), sy=metrics.height/(image.naturalHeight||1);
      targetCtx.save();
      targetCtx.beginPath();
      targetCtx.rect(metrics.left,metrics.top,metrics.width,metrics.height);
      targetCtx.clip();
      targetCtx.lineCap='round';targetCtx.lineJoin='round';
      for(const stroke of strokes){
        if(!stroke.points||stroke.points.length<1)continue;
        targetCtx.globalCompositeOperation=stroke.tool==='eraser'?'destination-out':'source-over';
        targetCtx.strokeStyle=stroke.color||data.accent;
        targetCtx.lineWidth=(stroke.width||3)*Math.max(sx,sy)*(ratio||1);
        targetCtx.beginPath();
        stroke.points.forEach((p,i)=>{const x=metrics.left+p.x*sx,y=metrics.top+p.y*sy;if(i===0)targetCtx.moveTo(x,y);else targetCtx.lineTo(x,y);});
        targetCtx.stroke();
      }
      targetCtx.restore();
    }
    function redrawMarks(){const r=stageRect();ctx.clearRect(0,0,r.width,r.height);drawStrokes(ctx,imageMetrics(),1);}
    function annotationPayload(){return {version:2,strokes};}
    function hasMarks(){return strokes.some(s=>s.points&&s.points.length>0);}
    async function saveMarks(showToast=true){if(!window.imagePreview?.saveAnnotation)return;await window.imagePreview.saveAnnotation(data.annotationKey,hasMarks()?annotationPayload():null);dirty=false;if(showToast)say('标注已保存');}
    async function clearAndSave(){strokes=[];activeStroke=null;redrawMarks();dirty=true;await saveMarks();}
    function resizeCanvas(){const r=stageRect();canvas.width=Math.max(1,Math.floor(r.width*devicePixelRatio));canvas.height=Math.max(1,Math.floor(r.height*devicePixelRatio));ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);redrawMarks();}
    function loadSavedMarks(){
      const saved=data.annotationData;
      if(saved&&saved.version===2&&Array.isArray(saved.strokes)){strokes=saved.strokes;redrawMarks();return;}
      if(typeof saved==='string'&&saved.startsWith('data:image/')){say('旧版标注需重新标注后保存');}
    }
    function layoutFit(){const r=stageRect();if(!image.naturalWidth||!image.naturalHeight)return;fitScale=Math.min(r.width/image.naturalWidth,r.height/image.naturalHeight,1);scale=fitScale;offsetX=0;offsetY=0;applyTransform();resizeCanvas();}
    function applyTransform(){image.style.transform='translate(calc(-50% + '+offsetX+'px), calc(-50% + '+offsetY+'px)) scale('+scale+')';redrawMarks();}
    image.addEventListener('load',()=>{layoutFit();loadSavedMarks();});
    window.addEventListener('resize',()=>{resizeCanvas();applyTransform();});
    stage.addEventListener('mousedown',e=>{if(mode==='pen'||mode==='eraser')return;dragging=true;stage.classList.add('dragging');lastX=e.clientX;lastY=e.clientY;});
    window.addEventListener('mousemove',e=>{if(!dragging)return;offsetX+=e.clientX-lastX;offsetY+=e.clientY-lastY;lastX=e.clientX;lastY=e.clientY;applyTransform();});
    window.addEventListener('mouseup',()=>{dragging=false;stage.classList.remove('dragging');});
    stage.addEventListener('wheel',e=>{e.preventDefault();const prev=scale;const next=scale*(e.deltaY<0?1.08:.92);scale=Math.max(fitScale*.5,Math.min(6,next));const r=stageRect();const cx=e.clientX-r.left-r.width/2-offsetX,cy=e.clientY-r.top-r.height/2-offsetY;offsetX-=cx*(scale/prev-1);offsetY-=cy*(scale/prev-1);applyTransform();},{passive:false});
    canvas.addEventListener('mousedown',e=>{if(mode!=='pen'&&mode!=='eraser')return;drawing=true;activeStroke={tool:mode,color:data.accent,width:mode==='eraser'?18:3,points:[eventToImagePoint(e)]};strokes.push(activeStroke);dirty=true;});
    canvas.addEventListener('mousemove',e=>{if(!drawing||!activeStroke)return;activeStroke.points.push(eventToImagePoint(e));redrawMarks();dirty=true;});
    window.addEventListener('mouseup',()=>{if(drawing){drawing=false;activeStroke=null;}});
    window.__setPen=()=>{setMode('pen');say('标注模式');};
    window.__setEraser=()=>{setMode('eraser');say('橡皮擦模式');};
    window.__finishAnnotating=async()=>{setMode('pan');await saveMarks(true);};
    window.__clearMarks=()=>clearAndSave();
    window.__resetView=()=>{layoutFit();say('已重置视图');};
    window.__setPreviewTheme=(next)=>{document.documentElement.dataset.theme=next==='light'?'light':'dark';};
    window.__copyAnnotationOnly=()=>annotationPayload();
    window.__copyAnnotated=async()=>{const out=document.createElement('canvas');out.width=image.naturalWidth||1;out.height=image.naturalHeight||1;const o=out.getContext('2d');o.drawImage(image,0,0,out.width,out.height);drawStrokes(o,{left:0,top:0,width:out.width,height:out.height},1);return out.toDataURL('image/png');};
    document.getElementById('done').onclick=()=>window.__finishAnnotating();
    document.getElementById('close').onclick=()=>window.close();
    window.addEventListener('beforeunload',()=>{if(dirty&&window.imagePreview?.saveAnnotation)window.imagePreview.saveAnnotation(data.annotationKey,hasMarks()?annotationPayload():null);});
    document.addEventListener('keydown',e=>{if(e.key==='Escape')window.close();if((e.ctrlKey||e.metaKey)&&e.key==='0')layoutFit();});
  </script></body></html>`;
}

async function openImagePreviewWindow(owner, src) {
  const previewSource = imagePreviewSource(src);
  if (!previewSource) return false;
  const data = await loadData();
  const themeInfo = safePreviewTheme(data.settings || {});
  const annotationKey = imageAnnotationKey(src);
  const annotationData = data.imageAnnotations?.[annotationKey] || "";
  const display = owner && !owner.isDestroyed()
    ? screen.getDisplayMatching(owner.getBounds())
    : screen.getPrimaryDisplay();
  const workArea = display.workArea || display.bounds;
  const width = Math.max(420, Math.round(workArea.width / 2));
  const height = Math.max(300, Math.round(workArea.height / 2));
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + (workArea.height - height) / 2);
  const preview = new BrowserWindow({
    width,
    height,
    x,
    y,
    parent: owner && !owner.isDestroyed() ? owner : undefined,
    modal: false,
    show: true,
    frame: false,
    transparent: true,
    autoHideMenuBar: true,
    title: "图片预览",
    icon: trayIconPath(),
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, "imagePreviewPreload.js")
    }
  });
  preview.setOpacity(themeInfo.opacity);
  preview.removeMenu();
  let savingBeforeClose = false;
  preview.on("close", event => {
    if (savingBeforeClose || preview.isDestroyed() || preview.webContents.isDestroyed()) return;
    event.preventDefault();
    savingBeforeClose = true;
    preview.webContents.executeJavaScript("window.__copyAnnotationOnly ? window.__copyAnnotationOnly() : null", true)
      .then(payload => saveImageAnnotation(annotationKey, payload))
      .catch(() => {})
      .finally(() => { if (!preview.isDestroyed()) preview.close(); });
  });
  preview.webContents.on("context-menu", () => {
    const template = [
      { label: "复制图片", click: () => { try { const image = nativeImage.createFromDataURL(src); if (!image.isEmpty()) clipboard.writeImage(image); } catch (_) {} } },
      { label: "复制当前标注画面", click: () => preview.webContents.executeJavaScript("window.__copyAnnotated && window.__copyAnnotated()", true).then(dataUrl => { if (dataUrl) { const image = nativeImage.createFromDataURL(dataUrl); if (!image.isEmpty()) clipboard.writeImage(image); } }).catch(() => {}) },
      { type: "separator" },
      { label: "标注", click: () => preview.webContents.executeJavaScript("window.__setPen && window.__setPen()", true).catch(() => {}) },
      { label: "橡皮擦", click: () => preview.webContents.executeJavaScript("window.__setEraser && window.__setEraser()", true).catch(() => {}) },
      { label: "完成", click: () => preview.webContents.executeJavaScript("window.__finishAnnotating && window.__finishAnnotating()", true).catch(() => {}) },
      { label: "清除标注", click: () => preview.webContents.executeJavaScript("window.__clearMarks && window.__clearMarks()", true).catch(() => {}) },
      { label: "重置视图", click: () => preview.webContents.executeJavaScript("window.__resetView && window.__resetView()", true).catch(() => {}) },
      { type: "separator" },
      {
        label: "背景颜色",
        submenu: [
          { label: "深色", type: "radio", checked: themeInfo.theme !== "light", click: async () => { await setImagePreviewBackground("dark"); themeInfo.theme = "dark"; preview.webContents.executeJavaScript("window.__setPreviewTheme && window.__setPreviewTheme('dark')", true).catch(() => {}); } },
          { label: "浅色", type: "radio", checked: themeInfo.theme === "light", click: async () => { await setImagePreviewBackground("light"); themeInfo.theme = "light"; preview.webContents.executeJavaScript("window.__setPreviewTheme && window.__setPreviewTheme('light')", true).catch(() => {}); } }
        ]
      },
      { type: "separator" },
      { label: "关闭", click: () => { if (!preview.isDestroyed()) preview.close(); } }
    ];
    Menu.buildFromTemplate(template).popup({ window: preview });
  });
  preview.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(previewHtml(previewSource, themeInfo, annotationKey, annotationData)));
  return true;
}

ipcMain.handle("window:openImagePreview", async (event, src) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return openImagePreviewWindow(win, src);
});

ipcMain.handle("imagePreview:saveAnnotation", async (_, key, dataUrl) => saveImageAnnotation(key, dataUrl));
ipcMain.handle("window:openSurface", (_, surface) => openKind(surface));
ipcMain.handle("window:openTodayWidget", async () => {
  await openTodayWidget();
  return true;
});
ipcMain.handle("window:autoHidePointer", (event, hovering) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  getWindowStateManager().onAutoHidePointer(win, hovering);
});
ipcMain.handle("app:setLoginItem", (_, value) => setLaunchAtStartup(value));
ipcMain.handle("app:quit", () => {
  isQuitting = true;
  app.quit();
});
