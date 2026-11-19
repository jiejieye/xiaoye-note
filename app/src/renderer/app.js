
(function () {
  const DEFAULT_SETTINGS = window.DEFAULT_SETTINGS || {};
  const DEFAULT_DATA = window.DEFAULT_DATA || {};
  const app = document.querySelector("#app");
  const params = new URLSearchParams(location.search);
  const requestedSurface = params.get("mode");
  const initialSurface = ["calendar", "todo", "notes", "worktree"].includes(requestedSurface) ? requestedSurface : "todo";
  const surfaceItems = [["calendar", "\u65e5"], ["worktree", "\u9879"], ["todo", "\u5f85"], ["notes", "\u7b7e"]];
  const weekNames = ["一", "二", "三", "四", "五", "六", "日"];
  const colorPalette = ["#ff9ac5", "#a8eb4d", "#ffe05a", "#ffe3a0", "#bfb2ff", "#a7f0a7", "#98c7f5", "#d0d0d0", "#c8d4ff", "#ffd2a6", "#cbeeee", "#f5dddd", "#f7b3ef", "#f8b4b4", "#eadfc9", "#eded9a"];
  const labelColorPresets = ["#ffd21a", "#ff8a65", "#ba68c8", "#78d68f", "#64b5f6"];
  const eventColorPresets = [["#ffd21a", "黄色"], ["#ff8a65", "橙色"], ["#ba68c8", "紫色"], ["#78d68f", "绿色"], ["#64b5f6", "蓝色"], ["#ef6c78", "红色"], ["#26c6b0", "青色"], ["#ec6fa9", "粉色"], ["#7e8ce0", "靛蓝"]];
  const themeColorPresets = [...labelColorPresets, "#ef6c78", "#26c6b0", "#ec6fa9", "#7e8ce0"];
  const UNDO_LIMIT = 5;
  const WORK_TREE_ZOOM_MIN = 0.25;
  const WORK_TREE_ZOOM_MAX = 1.6;
  const WORK_TREE_ZOOM_STEP = 0.1;
  const WORK_TREE_CREATE_DEDUPE_MS = 300;

  let state = {
    surface: initialSurface,
    todos: [],
    events: [],
    notes: [],
    todoLists: [],
    noteLists: [],
    noteFolders: [],
    backups: [],
    trash: [],
    anniversaries: [],
    workTrees: [],
    reminderPreferences: [],
    showReminderSettings: false,
    windowState: {},
    settings: { ...DEFAULT_SETTINGS, alwaysOnTop: true, launchAtStartup: false, opacity: 0.82, theme: "dark", themeColor: "#ffd21a", eventTodoColor: "#ffd21a", eventDoneColor: "#78d68f", reopenTodoAfterDrop: false, multiOpen: false, todoColumns: 1, enableEdgeAutoHide: false, keepWindowsOnScreen: true, hideTaskbarIcon: false, surfaceWheelSensitivity: 5 },
    showSettings: false,
    showTrash: false,
    searchOpen: false,
    searchQuery: "",
    highlight: null,
    editingTodoId: "",
    editingOccurrenceDate: "",
    showDone: true,
    todoScheduleSortAsc: true,
    todoTodayOnly: false,
    calendarTodoVisible: false,
    restoreCalendarTodoAfterDrop: false,
    calendarView: "month",
    calendarContinuous: false,
    calendarHolidaysVisible: true,
    calendarLinkedEdit: false,
    followupVisible: true,
    calendarBatchDelete: false,
    calendarBatchSelected: new Set(),
    followupPosition: { x: 1, y: 1 },
    cursor: startOfDay(new Date()),
    selectedDate: toDateKey(new Date()),
    editingEventId: "",
    noteFilter: "active",
    activeFolderId: "all",
    activeWorkTreeId: "",
    workTreeView: "tree",
    workTreeMapMode: "single",
    workTreeFolderColumns: 1,
    hideCompletedWorkTreeNodes: false,
    editingWorkTreeTitleId: "",
    editingWorkTreeTabTitleId: "",
    editingWorkNodeTitleId: "",
    showWorkTreeTrash: false,
    workTreeContextMenu: null,
    undoStack: [],
    workTreeUndoStack: [],
    showNewNote: false,
    pendingNewImages: [],
    lightboxImage: "",
    customThemeColorOpen: false,
    pendingEventDraft: null,
    scrollState: {},
    __revision: 0
  };
  let scrollSaveTimer;
  let uiStatePatchTimer;
  let pendingUiStatePatch = {};
  let persistQueue = Promise.resolve();
  let persistEpoch = 0;
  let workTreeMutationQueue = Promise.resolve();
  let workTreeMutationEpoch = 0;
  let workTreeCreateRequestId = 0;
  let latestWorkTreeCreateRequestId = 0;
  let workTreeCreateRequestTimes = new Map();
  let workTreeLineTimer;
  let workTreeDraggingNodeId = "";
  let workTreeSuppressNodeActionUntil = 0;
  let workTreePointerDropRow = null;
  let workTreePanState = null;
  let workTreeDragOverlay = null;
  let workTreeDragAction = null;
  let workTreePointerDragState = null;
  let workTreeProjectDragState = null;
  let workTreeProjectDropTab = null;
  let workTreeSuppressProjectClickUntil = 0;
  let workTreeRenameSelectingInput = null;
  let workTreeSuppressRenameBlurUntil = 0;
  let creatingNote = false;
  let dataLoaded = false;
  let pendingQuickCapture = false;
  let reminderLoopStarted = false;
  let editorReturnSelector = "";
  let editorReturnElement = null;
  const editorSaveStates = { todo: { id: "", busy: false, message: "" }, event: { id: "", busy: false, message: "" } };
  const editorDisabledStates = new WeakMap();
  const pageStatus = document.createElement("div");
  pageStatus.className = "page-status";
  pageStatus.setAttribute("role", "status");
  pageStatus.hidden = true;
  app.after(pageStatus);
  let duplicatingNoteId = "";
  const noteAutosaveTimers = new WeakMap();
  let notePasteMenuElement = null;
  let notePasteMenuContext = null;
  let notePasteMenuCleanup = null;
  let floatingMenusCleanup = null;
  let surfaceWheelDelta = 0;
  let switchingSurface = false;
  let surfaceSwitchVersion = 0;
  let queuedSurfaceSwitch = null;
  let surfaceSwitchFlushTimer = null;
  let undoInProgress = false;
  let appliedAlwaysOnTop;
  let appliedOpacity;
  let restoringEditorDraft = false;
  let compositionActive = false;
  let dataRefreshPromise = null;
  let dataRefreshBarrier = Promise.resolve();
  let dataRefreshQueued = false;
  let queuedRefreshDraft = null;
  let customThemePersistTimer = null;
  let reminderTimer = null;
  let reminderPersisting = false;
  let monthCalendarResizeObserver;
  let calendarRevealDate = "";
  let continuousMonthStart = null;
  const dirtyDraftKeys = new Set();

  const clone = value => JSON.parse(JSON.stringify(value || {}));
  const uid = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const nowIso = () => new Date().toISOString();
  function nextCopyName(baseName, existingNames) {
    const base = String(baseName || "未命名").trim() || "未命名";
    const used = new Set((existingNames || []).map(name => String(name || "").trim()));
    let candidate = `${base} 副本`;
    let index = 2;
    while (used.has(candidate)) candidate = `${base} 副本 ${index++}`;
    return candidate;
  }
  const esc = value => String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const tagsFrom = value => String(value || "").match(/\[(.+?)\]/g)?.map(tag => tag.slice(1, -1).trim()).filter(Boolean) || [];
  function startOfDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
  function toDateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
  function parseDate(key) { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d); }
  function addDays(date, days) { const next = new Date(date); next.setDate(next.getDate() + days); return next; }
  function addMonths(date, months) { const next = new Date(date); next.setMonth(next.getMonth() + months); return next; }
  function addMonthsClamped(date, months) { const day = date.getDate(); const next = new Date(date.getFullYear(), date.getMonth() + months, 1); const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate(); next.setDate(Math.min(day, maxDay)); return next; }
  function dateTimeLocalValue(value) { if (!value) return ""; const date = new Date(value); if (Number.isNaN(date.getTime())) return String(value).slice(0, 16); const pad = number => String(number).padStart(2, "0"); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; }
  function fromDateTimeLocalValue(value) { if (!value) return ""; const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : date.toISOString(); }
  function startOfWeek(date) { const next = startOfDay(date); next.setDate(next.getDate() - ((next.getDay() + 6) % 7)); return next; }
  function monthDays(date) { const start = startOfWeek(new Date(date.getFullYear(), date.getMonth(), 1)); return Array.from({ length: 42 }, (_, index) => addDays(start, index)); }
  function weekDays(date) { const start = startOfWeek(date); return Array.from({ length: 7 }, (_, index) => addDays(start, index)); }
  const formatMonth = date => date.toLocaleDateString("zh-CN", { year: "numeric", month: "long" });
  const formatDay = date => date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  const lunarDayNames = ["", "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十"];
  const lunarDayFormatter = typeof Intl !== "undefined" ? new Intl.DateTimeFormat("zh-u-ca-chinese", { day: "numeric" }) : null;
  function lunarLabel(date) {
    const raw = lunarDayFormatter?.format(date) || "";
    const day = Number(raw.replace(/\D/g, ""));
    return lunarDayNames[day] || "";
  }

  function normalizeRepeat(value) {
    const normalized = String(value || "none").toLowerCase();
    const aliases = { weekday: "workdays", weekdays: "workdays", workday: "workdays" };
    const next = aliases[normalized] || normalized;
    return ["none", "daily", "workdays", "weekly", "monthly", "yearly"].includes(next) ? next : "none";
  }

  function normalizeWorkTrees(trees = []) {
    return Array.isArray(trees) ? trees.map((tree, treeIndex) => ({
      id: String(tree.id || uid("tree")),
      ...(tree.syncConflictOf ? { syncConflictOf: tree.syncConflictOf } : {}),
      title: String(tree.title || `\u5de5\u4f5c\u9879\u76ee${treeIndex + 1}`),
      tabTitle: String(tree.tabTitle || tree.title || `\u5de5\u4f5c\u9879\u76ee${treeIndex + 1}`),
      archived: Boolean(tree.archived),
      archivedAt: String(tree.archivedAt || ""),
      collapsed: Boolean(tree.collapsed),
      order: Number.isFinite(Number(tree.order)) ? Number(tree.order) : treeIndex,
      createdAt: tree.createdAt || nowIso(),
      updatedAt: tree.updatedAt || nowIso(),
      nodes: Array.isArray(tree.nodes) ? tree.nodes.map((node, nodeIndex) => ({
        id: String(node.id || uid("node")),
        parentId: String(node.parentId || ""),
        title: String(node.title || `\u5b50\u4efb\u52a1${nodeIndex + 1}`),
        folder: Boolean(node.folder),
        completed: Boolean(node.completed),
        collapsed: Boolean(node.collapsed),
        todoId: String(node.todoId || ""),
        note: String(node.note || ""),
        order: Number.isFinite(Number(node.order)) ? Number(node.order) : nodeIndex,
        createdAt: node.createdAt || nowIso(),
        updatedAt: node.updatedAt || nowIso()
      })) : []
    })) : [];
  }

  function migrate(data) {
    const next = { ...clone(DEFAULT_DATA), ...(data || {}) };
    next.__revision = Number(data?.__revision || 0);
    next.settings = { ...state.settings, ...(data?.settings || {}) };
    next.windowState = { ...(DEFAULT_DATA.windowState || {}), ...(data?.windowState || {}) };
    next.todoLists = Array.isArray(data?.todoLists) ? data.todoLists : (DEFAULT_DATA.todoLists || []);
    next.noteLists = Array.isArray(data?.noteLists) ? data.noteLists : (DEFAULT_DATA.noteLists || []);
    next.noteFolders = Array.isArray(data?.noteFolders) ? data.noteFolders : ["\u6587\u4ef6\u59391", "\u6587\u4ef6\u59392"].map((name, index) => ({ id: next.noteLists[index]?.id || `folder-${index + 1}`, name, order: index }));
    next.todos = (Array.isArray(data?.todos) ? data.todos : DEFAULT_DATA.todos || []).map((todo, index) => ({ completed: false, pinned: false, order: index, tags: [], targetDate: "", reminderAt: "", reminderLead: "none", reminderLastKey: "", reminderLastFiredAt: "", repeat: "none", repeatEndDate: "", repeatParentId: "", repeatSkippedDates: [], subtasks: [], color: "", ...todo, repeat: normalizeRepeat(todo.repeat) }));
    next.events = (Array.isArray(data?.events) ? data.events : DEFAULT_DATA.events || []).map(event => ({ color: event.subscription ? '#ba68c8' : next.settings.eventTodoColor || "#ffd21a", tags: [], repeat: "none", repeatEndDate: "", repeatParentId: "", repeatSkippedDates: [], reminderAt: "", reminderLead: "none", reminderLastKey: "", reminderLastFiredAt: "", todoId: "", completed: false, note: "", startTime: "", endTime: "", ...event, ...(event.subscription && event.date ? { subscription: { ...event.subscription, expiresOn: event.date } } : {}), repeat: normalizeRepeat(event.repeat) }));
    next.notes = (Array.isArray(data?.notes) ? data.notes : DEFAULT_DATA.notes || []).map((note, index) => ({ pinned: false, archived: false, order: index, tags: [], color: "", attachments: [], folderId: note.listId || note.folderId || "", ...note }));
    next.todos.forEach(todo => {
      const flow = next.events.find(event => event.todoId === todo.id && event.ongoing);
      if (!flow) return;
      if (!todo.taskType) todo.taskType = "flow";
      if (todo.progress === undefined) todo.progress = flow.progress || "";
      if (todo.priority === undefined) todo.priority = Number(flow.priority) || 2;
    });
    next.trash = Array.isArray(data?.trash) ? data.trash : [];
    next.anniversaries = Array.isArray(data?.anniversaries) ? data.anniversaries : [];
    next.workTrees = normalizeWorkTrees(data?.workTrees || DEFAULT_DATA.workTrees);
    next.reminderPreferences = Array.isArray(data?.reminderPreferences) ? data.reminderPreferences : [];
    return next;
  }

  async function loadData() {
    const raw = window.dayline ? await window.dayline.loadData() : JSON.parse(localStorage.getItem("dayline-data") || "null");
    const data = migrate(raw);
    Object.assign(state, data);
    state.undoStack = [];
    state.workTreeUndoStack = [];
    applyUiState(data.uiState || {});
    applySettings();
  }

  function uiState() {
    return {
      showDone: state.showDone,
      todoScheduleSortAsc: state.todoScheduleSortAsc,
      todoTodayOnly: state.todoTodayOnly,
      calendarTodoVisible: state.calendarTodoVisible,
      calendarView: state.calendarView,
      calendarContinuous: state.calendarContinuous,
      calendarHolidaysVisible: state.calendarHolidaysVisible,
      calendarLinkedEdit: state.calendarLinkedEdit,
      followupVisible: state.followupVisible,
      followupPosition: state.followupPosition,
      cursor: toDateKey(state.cursor),
      noteFilter: state.noteFilter,
      activeFolderId: state.activeFolderId,
      activeWorkTreeId: state.activeWorkTreeId,
      workTreeView: state.workTreeView,
      workTreeMapMode: state.workTreeMapMode,
      workTreeFolderColumns: state.workTreeFolderColumns,
      hideCompletedWorkTreeNodes: state.hideCompletedWorkTreeNodes,
      scrollState: state.scrollState || {}
    };
  }

  function applyUiState(ui = {}) {
    if (typeof ui.showDone === "boolean") state.showDone = ui.showDone;
    if (typeof ui.todoScheduleSortAsc === "boolean") state.todoScheduleSortAsc = ui.todoScheduleSortAsc;
    if (typeof ui.todoTodayOnly === "boolean") state.todoTodayOnly = ui.todoTodayOnly;
    state.calendarTodoVisible = false;
    if (["month", "week", "year"].includes(ui.calendarView)) state.calendarView = ui.calendarView;
    if (typeof ui.calendarContinuous === "boolean") state.calendarContinuous = ui.calendarContinuous;
    if (typeof ui.calendarHolidaysVisible === "boolean") state.calendarHolidaysVisible = ui.calendarHolidaysVisible;
    if (typeof ui.calendarLinkedEdit === "boolean") state.calendarLinkedEdit = ui.calendarLinkedEdit;

    if (typeof ui.followupVisible === "boolean") state.followupVisible = ui.followupVisible;
    if (ui.followupPosition) state.followupPosition = { x: Math.max(0, Math.min(1, Number(ui.followupPosition.x) || 0)), y: Math.max(0, Math.min(1, Number(ui.followupPosition.y) || 0)) };
    if (ui.cursor) state.cursor = parseDate(ui.cursor);
    if (["active", "archived"].includes(ui.noteFilter)) state.noteFilter = ui.noteFilter;
    if (ui.activeFolderId) state.activeFolderId = ui.activeFolderId;
    if (ui.activeWorkTreeId) state.activeWorkTreeId = ui.activeWorkTreeId;
    if (["tree", "mindmap"].includes(ui.workTreeView)) state.workTreeView = ui.workTreeView;
    if (["single", "double"].includes(ui.workTreeMapMode)) state.workTreeMapMode = ui.workTreeMapMode;
    if ([1, 2].includes(Number(ui.workTreeFolderColumns))) state.workTreeFolderColumns = Number(ui.workTreeFolderColumns);
    if (typeof ui.hideCompletedWorkTreeNodes === "boolean") state.hideCompletedWorkTreeNodes = ui.hideCompletedWorkTreeNodes;
    state.scrollState = ui.scrollState || state.scrollState || {};
  }

  function currentData() {
    return { __revision: state.__revision || 0, todos: state.todos, events: state.events, notes: state.notes, noteFolders: state.noteFolders, todoLists: state.todoLists, noteLists: state.noteLists, backups: state.backups, trash: state.trash, anniversaries: state.anniversaries, workTrees: state.workTrees, reminderPreferences: state.reminderPreferences, settings: state.settings, windowState: state.windowState, uiState: uiState() };
  }

  function persist(preservedDraft = null, rollback = null, saveOptions = null) {
    if (!dataLoaded) return Promise.resolve(false);
    const requestedDraft = mergeEditorDrafts(captureEditorDraft(), preservedDraft);
    const epoch = persistEpoch;
    const run = async () => {
      await dataRefreshBarrier;
      if (epoch !== persistEpoch) return false;
      for (const kind of ["todo", "event"]) if (editorSaveStates[kind].busy) { editorSaveStates[kind].writing = true; updateEditorFeedback(kind); }
      const draft = mergeEditorDrafts(requestedDraft, captureEditorDraft());
      const data = currentData();
      if (window.dayline) {
        const saved = await window.dayline.saveData(data, saveOptions);
        if (saved?.__stale) {
          persistEpoch += 1;
          workTreeMutationEpoch += 1;
          const refresh = requestDataRefresh(draft);
          dataRefreshBarrier = refresh.then(() => undefined, () => undefined);
          await refresh;
          showSaveProblem("其他窗口已更新，当前草稿已保留，请再次保存。");
          return false;
        }
        if (Number.isFinite(saved?.__revision)) state.__revision = saved.__revision;
        if (saved?.__subscriptionPasswordCipher && saveOptions?.subscriptionPassword) {
          state.settings.subscriptionPasswords = { ...(state.settings.subscriptionPasswords || {}), [saveOptions.subscriptionPassword.eventId]: saved.__subscriptionPasswordCipher };
        }
      } else localStorage.setItem("dayline-data", JSON.stringify(data));
      pageStatus.hidden = true;
      return true;
    };
    const task = persistQueue.then(run, run).catch(error => {
      rollback?.();
      showSaveProblem("保存失败，当前输入已保留，请重试。");
      if (!editorSaveStates.todo.busy && !editorSaveStates.event.busy) throw error;
      return false;
    });
    persistQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  function captureEditorChanges() {
    const epoch = persistEpoch;
    const restoreFields = (target, prior, written, excluded = []) => {
      for (const name of new Set([...Object.keys(prior), ...Object.keys(written)])) {
        if (excluded.includes(name) || JSON.stringify(prior[name]) === JSON.stringify(written[name]) || JSON.stringify(target[name]) !== JSON.stringify(written[name])) continue;
        if (Object.hasOwn(prior, name)) target[name] = structuredClone(prior[name]);
        else delete target[name];
      }
    };
    const before = Object.fromEntries(["todos", "events", "workTrees", "trash"].map(key => [key, new Map(state[key].map(item => [item.id, { ref: item, value: JSON.stringify(item) }]))]));
    return () => {
      const after = Object.fromEntries(Object.keys(before).map(key => [key, new Map(state[key].map(item => [item.id, JSON.stringify(item)]))]));
      return () => {
        if (persistEpoch !== epoch) return;
        for (const key of Object.keys(before)) {
          state[key] = state[key].filter(item => before[key].has(item.id) || !after[key].has(item.id) || JSON.stringify(item) !== after[key].get(item.id));
          for (const [id, saved] of before[key]) {
            if (saved.value === after[key].get(id)) continue;
            const current = state[key].find(item => item.id === id);
            if (!current && after[key].has(id)) continue;
            const target = current || saved.ref;
            const prior = JSON.parse(saved.value), written = after[key].has(id) ? JSON.parse(after[key].get(id)) : null;
            if (current && !written) continue;
            if (!current) { for (const name of Object.keys(target)) delete target[name]; Object.assign(target, prior); }
            else if (key === "workTrees") {
              const priorNodes = new Map(prior.nodes.map(node => [node.id, node]));
              const writtenNodes = new Map(written.nodes.map(node => [node.id, node]));
              target.nodes = target.nodes.filter(node => priorNodes.has(node.id) || !writtenNodes.has(node.id) || JSON.stringify(node) !== JSON.stringify(writtenNodes.get(node.id)));
              for (const [nodeId, node] of priorNodes) {
                const active = target.nodes.find(row => row.id === nodeId);
                if (active && writtenNodes.has(nodeId)) restoreFields(active, node, writtenNodes.get(nodeId));
                else if (!active && !writtenNodes.has(nodeId)) target.nodes.push(node);
              }
              restoreFields(target, prior, written, ["nodes"]);
            } else restoreFields(target, prior, written);
            if (!current) state[key].push(target);
          }
        }
      };
    };
  }

  function showSaveProblem(message) {
    const kind = state.editingEventId ? "event" : state.editingTodoId ? "todo" : "";
    if (kind) {
      pageStatus.hidden = true;
      editorSaveStates[kind].id = kind === "event" ? state.editingEventId : state.editingTodoId;
      editorSaveStates[kind].message = message;
      updateEditorFeedback(kind);
    } else {
      pageStatus.textContent = message;
      pageStatus.hidden = false;
      pageStatus.classList.add("is-error");
    }
  }

  function updateEditorFeedback(kind) {
    const panel = app.querySelector(kind === "event" ? "[data-event-editor]" : "[data-todo-editor-panel]");
    if (!panel) return;
    const value = editorSaveStates[kind];
    const id = kind === "event" ? state.editingEventId : state.editingTodoId;
    if (value.id !== id) return;
    const status = panel.querySelector("[data-editor-status]");
    if (status) { status.textContent = value.message; status.hidden = !value.message; }
    const save = panel.querySelector(`[data-save-${kind}]`);
    if (save) { save.disabled = value.busy; save.textContent = value.busy ? "保存中…" : "保存"; }
    panel.querySelectorAll("input,select,textarea,button:not([data-save-event]):not([data-save-todo])").forEach(control => {
      if (value.busy && value.writing) { if (!editorDisabledStates.has(control)) editorDisabledStates.set(control, control.disabled); control.disabled = true; }
      else if (editorDisabledStates.has(control)) { control.disabled = editorDisabledStates.get(control); editorDisabledStates.delete(control); }
    });
    panel.setAttribute("aria-busy", String(value.busy));
  }

  async function saveEditor(kind, id, action) {
    if (editorSaveStates[kind].busy) return;
    editorSaveStates[kind] = { id, busy: true, writing: false, message: "" };
    updateEditorFeedback(kind);
    try { await action(); }
    catch (_) { showSaveProblem("保存失败，当前输入已保留，请重试。"); }
    finally { editorSaveStates[kind].busy = false; updateEditorFeedback(kind); }
  }

  function rememberEditorEntry(element = document.activeElement) {
    editorReturnElement = element;
    editorReturnSelector = "";
    for (const name of ["data-work-node-todo", "data-calendar-add", "data-edit-event", "data-open-todo", "data-date", "data-new-todo-inline"]) {
      if (!element?.hasAttribute?.(name)) continue;
      editorReturnSelector = `[${name}="${CSS.escape(element.getAttribute(name))}"]`;
      if (name === "data-edit-event" && element.dataset.occurrenceDate) editorReturnSelector += `[data-occurrence-date="${CSS.escape(element.dataset.occurrenceDate)}"]`;
      break;
    }
  }

  function restoreEditorEntry() {
    const target = editorReturnElement?.isConnected ? editorReturnElement : editorReturnSelector ? app.querySelector(editorReturnSelector) : null;
    (target || app.querySelector(state.surface === "calendar" ? "[data-calendar-add]" : "[data-new-todo-inline]"))?.focus({ preventScroll: true });
  }

  function persistUiStatePatch(patch) {
    if (!window.dayline?.saveUiStatePatch) return persist();
    pendingUiStatePatch = {
      ...pendingUiStatePatch,
      ...patch,
      scrollState: { ...(pendingUiStatePatch.scrollState || {}), ...(patch.scrollState || {}) }
    };
    clearTimeout(uiStatePatchTimer);
    uiStatePatchTimer = setTimeout(() => {
      const nextPatch = pendingUiStatePatch;
      pendingUiStatePatch = {};
      window.dayline.saveUiStatePatch(nextPatch).catch(console.error);
    }, 0);
    return Promise.resolve(true);
  }

  function enqueueWorkTreeMutation(operation) {
    const epoch = workTreeMutationEpoch;
    const run = async () => {
      await dataRefreshBarrier;
      return epoch === workTreeMutationEpoch ? operation() : false;
    };
    const task = workTreeMutationQueue.then(run, run);
    workTreeMutationQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  function applySettings() {
    document.documentElement.dataset.theme = state.settings.theme === "light" ? "light" : "dark";
    document.documentElement.style.setProperty("--window-opacity", state.settings.opacity ?? 0.82);
    document.documentElement.style.setProperty("--accent", state.settings.themeColor || state.settings.accentColor || "#ffd21a");
    document.documentElement.style.setProperty("--event-todo", state.settings.eventTodoColor || "#ffd21a");
    document.documentElement.style.setProperty("--event-done", state.settings.eventDoneColor || "#78d68f");
    const alwaysOnTop = Boolean(state.settings.alwaysOnTop);
    const opacity = state.settings.opacity ?? 0.82;
    if (appliedAlwaysOnTop !== alwaysOnTop) {
      appliedAlwaysOnTop = alwaysOnTop;
      window.dayline?.setAlwaysOnTop(alwaysOnTop);
    }
    if (appliedOpacity !== opacity) {
      appliedOpacity = opacity;
      window.dayline?.setOpacity(opacity);
    }
  }

  function clamp(number, min, max) {
    return Math.max(min, Math.min(max, number));
  }

  function normalizeHexColor(value, fallback = "#ffd21a") {
    const text = String(value || "").trim();
    if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(text)) return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toLowerCase();
    return fallback;
  }

  function hexToRgb(value) {
    const hex = normalizeHexColor(value).slice(1);
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16)
    };
  }

  function rgbToHex(r, g, b) {
    return `#${[r, g, b].map(value => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0")).join("")}`;
  }

  function rgbToHsv({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let h = 0;
    if (delta) {
      if (max === r) h = ((g - b) / delta) % 6;
      else if (max === g) h = (b - r) / delta + 2;
      else h = (r - g) / delta + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: max ? delta / max : 0, v: max };
  }

  function hsvToHex(h, s, v) {
    h = ((Number(h) % 360) + 360) % 360;
    s = clamp(Number(s), 0, 1);
    v = clamp(Number(v), 0, 1);
    const c = v * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
  }

  function eventsFor(dateKey) {
    return state.events
      .filter(event => (!event.ongoing || event.completed || !state.followupVisible || event.followupInCalendar) && eventOccursOnDate(event, dateKey))
      .map(event => materializeEvent(event, dateKey))
      .sort((a, b) => {
        if (Boolean(a.ongoing) !== Boolean(b.ongoing)) return a.ongoing ? 1 : -1;
        if (a.ongoing && b.ongoing) return (Number(b.priority) || 2) - (Number(a.priority) || 2);
        return (a.startTime || "99:99").localeCompare(b.startTime || "99:99");
      });
  }

  function countdown(todo, dateKey = todo.targetDate) {
    if (!dateKey) return "";
    const diff = Math.ceil((parseDate(dateKey) - startOfDay(new Date())) / 86400000);
    return diff < 0 ? `逾期${Math.abs(diff)}天` : diff === 0 ? "今天" : `${diff}天`;
  }


  function repeatLabel(value) {
    return ({ none: "不重复", daily: "每天", workdays: "工作日", weekly: "每周", monthly: "每月", yearly: "每年" })[normalizeRepeat(value)] || "不重复";
  }

  function reminderLeadLabel(value) {
    return ({ none: "不提醒", "0": "准时", "5": "提前5分钟", "15": "提前15分钟", "60": "提前1小时", morning: "当天早上" })[String(value || "none")] || "不提醒";
  }

  function renderReminderLeadOptions(selected) {
    const value = String(selected || "none");
    return [["none", "默认（有时间跟随全局）"], ["0", "准时"], ["5", "提前5分钟"], ["15", "提前15分钟"], ["60", "提前1小时"], ["morning", "当天早上"]]
      .map(([key, label]) => `<option value="${key}" ${value === key ? "selected" : ""}>${label}</option>`).join("");
  }

  function renderRepeatOptions(selected) {
    const value = normalizeRepeat(selected);
    return [["none", "不重复"], ["daily", "每天"], ["workdays", "工作日"], ["weekly", "每周"], ["monthly", "每月"], ["yearly", "每年"]]
      .map(([key, label]) => `<option value="${key}" ${value === key ? "selected" : ""}>${label}</option>`).join("");
  }

  function nextRepeatDate(dateKey, repeat) {
    repeat = normalizeRepeat(repeat);
    if (!dateKey || repeat === "none") return "";
    let date = parseDate(dateKey);
    if (repeat === "daily") date = addDays(date, 1);
    else if (repeat === "workdays") {
      do { date = addDays(date, 1); } while ([0, 6].includes(date.getDay()));
    } else if (repeat === "weekly") date = addDays(date, 7);
    else if (repeat === "monthly") date = addMonthsClamped(date, 1);
    else if (repeat === "yearly") date = addMonthsClamped(date, 12);
    return toDateKey(date);
  }

  function repeatAllowsDate(dateKey, endDate) {
    return Boolean(dateKey && (!endDate || dateKey <= endDate));
  }

  function cloneWithNextDate(item, dateKey, type) {
    const next = { ...item, id: uid(type), completed: false, targetDate: type === "todo" ? dateKey : item.targetDate, date: type === "event" ? dateKey : item.date, repeatParentId: item.repeatParentId || item.id, reminderLastKey: "", reminderLastFiredAt: "", createdAt: nowIso(), updatedAt: nowIso() };
    if (type === "todo") {
      if (item.reminderAt) {
        const previous = new Date(item.reminderAt);
        if (!Number.isNaN(previous.getTime())) {
          const [year, month, day] = dateKey.split("-").map(Number);
          previous.setFullYear(year, month - 1, day);
          next.reminderAt = previous.toISOString();
        }
      }
    }
    return next;
  }

  function ensureNextTodoFromRepeat(todo) {
    const repeat = normalizeRepeat(todo.repeat);
    if (repeat === "none") return;
    const baseDate = todo.targetDate || toDateKey(new Date());
    const nextDate = nextRepeatDate(baseDate, repeat);
    if (!repeatAllowsDate(nextDate, todo.repeatEndDate)) return;
    const parentId = todo.repeatParentId || todo.id;
    const exists = state.todos.some(item => (item.repeatParentId || item.id) === parentId && item.targetDate === nextDate && !item.completed);
    if (!exists) state.todos.push({ ...cloneWithNextDate(todo, nextDate, "todo"), order: state.todos.length });
  }

  function ensureNextEventFromRepeat(event) {
    if (event.ongoing) return;
    const repeat = normalizeRepeat(event.repeat);
    if (repeat === "none") return;
    const nextDate = nextRepeatDate(event.date, repeat);
    if (!repeatAllowsDate(nextDate, event.repeatEndDate)) return;
    const parentId = event.repeatParentId || event.id;
    const exists = state.events.some(item => (item.repeatParentId || item.id) === parentId && item.date === nextDate);
    if (!exists) state.events.push({ ...cloneWithNextDate(event, nextDate, "event") });
    event.repeatEndDate = event.date;
  }

  function eventOccursOnDate(event, dateKey) {
    if (event?.ongoing) return window.EventState.ongoingOccursOnDate(event, dateKey, toDateKey(new Date()));
    if ((event?.repeatSkippedDates || []).includes(dateKey)) return false;
    if (!event?.date || event.date === dateKey) return event?.date === dateKey;
    const repeat = normalizeRepeat(event.repeat);
    if (repeat === "none" || dateKey <= event.date) return false;
    if (event.repeatEndDate && dateKey > event.repeatEndDate) return false;
    let cursor = event.date;
    for (let index = 0; index < 420; index += 1) {
      cursor = nextRepeatDate(cursor, repeat);
      if (!cursor || (event.repeatEndDate && cursor > event.repeatEndDate)) return false;
      if (cursor === dateKey) return true;
      if (cursor > dateKey) return false;
    }
    return false;
  }

  function materializeEvent(event, dateKey) {
    if (event.date === dateKey) return event;
    return { ...event, id: `${event.id}::${dateKey}`, baseEventId: event.id, date: dateKey, virtual: true, completed: window.EventState.occurrenceCompleted(event, dateKey) };
  }

  function reminderBaseDateTime(item, type) {
    if (item.reminderAt) {
      const date = new Date(item.reminderAt);
      if (!Number.isNaN(date.getTime())) return date;
    }
    if (type === "event" && item.date) {
      const time = item.startTime || "09:00";
      return new Date(`${item.date}T${time}`);
    }
    if (type === "todo" && item.targetDate) return new Date(`${item.targetDate}T${item.startTime || item.targetTime || "09:00"}`);
    return null;
  }

  function scheduledReminderAt(item, type) {
    const base = reminderBaseDateTime(item, type);
    if (!base || Number.isNaN(base.getTime())) return null;
    let lead = String(item.reminderLead || (item.reminderAt ? "0" : "none"));
    if (lead === "none" && (item.startTime || item.targetTime)) lead = String(window.ReminderRules.preferences(state).advanceMinutes);
    const scheduled = new Date(base);
    if (lead === "none") return item.reminderAt ? scheduled : null;
    if (lead === "morning") { const [hours, minutes] = window.ReminderRules.preferences(state).morning.split(":").map(Number); scheduled.setHours(hours, minutes, 0, 0); }
    else scheduled.setMinutes(scheduled.getMinutes() - Number(lead || 0));
    return Number.isNaN(scheduled.getTime()) ? null : scheduled;
  }

  function reminderKey(item, type, scheduled) {
    return `${type}:${item.id}:${scheduled.toISOString()}`;
  }

  async function checkReminders() {
    if (window.dayline?.backgroundReminders) return;
    if (state.settings.pauseReminders || reminderPersisting) return;
    const now = new Date();
    const oldest = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const due = [];
    state.todos.filter(todo => !todo.completed).forEach(todo => {
      const scheduled = scheduledReminderAt(todo, "todo");
      if (!scheduled || scheduled > now || scheduled < oldest) return;
      const key = reminderKey(todo, "todo", scheduled);
      if (todo.reminderLastKey === key) return;
      due.push({ type: "todo", item: todo, scheduled, key, title: `待办提醒：${todo.title}`, body: todo.targetDate ? `目标日：${todo.targetDate}` : "" });
    });
    state.events.filter(event => !event.completed).forEach(event => {
      const scheduled = scheduledReminderAt(event, "event");
      if (!scheduled || scheduled > now || scheduled < oldest) return;
      const key = reminderKey(event, "event", scheduled);
      if (event.reminderLastKey === key) return;
      due.push({ type: "event", item: event, scheduled, key, title: `日程提醒：${event.title}`, body: `${event.date || ""} ${event.startTime || ""}`.trim() });
    });
    if (!due.length) return;
    reminderPersisting = true;
    try {
      for (const entry of due) {
        await window.dayline?.notifyReminder?.({ title: entry.title, body: entry.body });
        entry.item.reminderLastKey = entry.key;
        entry.item.reminderLastFiredAt = nowIso();
      }
      await persist();
    } finally {
      reminderPersisting = false;
    }
  }

  function startReminderLoop() {
    if (reminderTimer) clearInterval(reminderTimer);
    checkReminders().catch(console.error);
    let displayedDay = toDateKey(new Date());
    reminderTimer = setInterval(() => {
      const today = toDateKey(new Date());
      if (today !== displayedDay) { displayedDay = today; render(); }
      checkReminders().catch(console.error);
    }, 30000);
  }

  function searchTextFor(item, fields) {
    return fields.map(field => Array.isArray(item[field]) ? item[field].join(" ") : item[field] || "").join(" ").toLowerCase();
  }

  function buildSearchResults(query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return { todos: [], events: [], notes: [] };
    return {
      todos: state.todos.filter(todo => searchTextFor(todo, ["title", "targetDate", "reminderAt", "tags"]).includes(q)),
      events: state.events.filter(event => searchTextFor(event, ["title", "date", "startTime", "endTime", "source", "note", "tags"]).includes(q)),
      notes: state.notes.filter(note => searchTextFor(note, ["title", "body", "archiveDate", "tags"]).includes(q))
    };
  }

  function renderSearchPanel() {
    if (!state.searchOpen) return "";
    const results = buildSearchResults(state.searchQuery);
    const total = results.todos.length + results.events.length + results.notes.length;
    const section = (title, items, type) => `
      <div class="search-section"><b>${title}</b>${items.length ? items.slice(0, 20).map(item => `<button data-search-go="${type}:${item.id}"><span>${esc(item.title || "未命名")}</span><em>${esc(type === "todo" ? (item.targetDate || item.tags?.join(" ") || "待办") : type === "event" ? `${item.date || ""} ${item.startTime || ""}` : (item.tags?.join(" ") || "便签"))}</em></button>`).join("") : `<p>暂无匹配</p>`}</div>`;
    return `
      <section class="search-panel" data-search-panel>
        <div class="search-head"><input data-search-input value="${esc(state.searchQuery)}" placeholder="待办、日程、便签" aria-label="搜索" autofocus /><span class="search-label">搜索</span><button data-close-search aria-label="关闭搜索"><span data-ui-icon="x" aria-hidden="true"></span></button></div>
        <div class="search-results">${state.searchQuery.trim() ? (total ? `${section("待办", results.todos, "todo")}${section("日程", results.events, "event")}${section("便签", results.notes, "note")}` : `<div class="empty-row">无结果</div>`) : ``}</div>
      </section>`;
  }

  function focusSearchInputAtEnd() {
    const input = app.querySelector("[data-search-input]");
    if (!input) return;
    input.focus();
    const end = input.value.length;
    try { input.setSelectionRange(end, end); } catch {}
  }

  function selectInputText(input, { reveal = false } = {}) {
    if (!input) return;
    if (reveal) {
      try { input.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch {}
    }
    try { input.focus({ preventScroll: true }); } catch { input.focus(); }
    try { input.setSelectionRange(0, input.value.length); } catch {}
  }

  const draftControlSelector = 'input, textarea, select, [contenteditable="true"]';
  const draftPanelSelector = '[data-todo-editor-panel], [data-event-editor], [data-new-note-card]';
  const inlineDraftControlSelector = '[data-new-todo-inline], [data-edit-todo], [data-note-title], [data-note-body], [data-folder-name], [data-work-tree-title], [data-work-tree-tab-title], [data-work-node-title]';

  function draftControlKey(control) {
    if (!control?.matches?.(draftControlSelector)) return "";
    const dataAttributes = [...control.attributes].filter(attribute => attribute.name.startsWith("data-") && attribute.name !== "data-scroll-key");
    const dataAttribute = dataAttributes.find(attribute => attribute.value) || dataAttributes[0];
    if (dataAttribute) return `${control.tagName}:${dataAttribute.name}:${dataAttribute.value}`;
    if (control.id) return `${control.tagName}:id:${control.id}`;
    if (control.name) return `${control.tagName}:name:${control.name}`;
    return "";
  }

  function isTrackedDraftControl(control) {
    return Boolean(control?.matches?.(draftControlSelector) && (control.closest(draftPanelSelector) || control.matches(inlineDraftControlSelector)));
  }

  function markDraftControlDirty(control) {
    if (!isTrackedDraftControl(control)) return;
    const key = draftControlKey(control);
    if (key) dirtyDraftKeys.add(key);
  }

  function clearDraftControl(control) {
    const key = draftControlKey(control);
    if (key) dirtyDraftKeys.delete(key);
  }

  function clearDraftControls(root) {
    if (!root) return;
    if (root.matches?.(draftControlSelector)) clearDraftControl(root);
    root.querySelectorAll?.(draftControlSelector).forEach(clearDraftControl);
  }

  function captureEditorDraft(extraElement = null) {
    const controls = new Set();
    app.querySelectorAll(draftControlSelector).forEach(control => {
      const key = draftControlKey(control);
      if (key && dirtyDraftKeys.has(key)) controls.add(control);
    });
    const active = document.activeElement;
    [extraElement, active].forEach(element => {
      if (element && app.contains(element) && element.matches?.(draftControlSelector)) controls.add(element);
    });
    const fields = [...controls].map(control => {
      const key = draftControlKey(control);
      if (!key) return null;
      const field = {
        key,
        restoreValue: dirtyDraftKeys.has(key),
        value: control.isContentEditable ? control.innerHTML : control.value,
        scrollTop: control.scrollTop,
        scrollLeft: control.scrollLeft
      };
      if (control.type === "checkbox" || control.type === "radio") field.checked = control.checked;
      if (control === active && Number.isInteger(control.selectionStart)) {
        field.selectionStart = control.selectionStart;
        field.selectionEnd = control.selectionEnd;
        field.selectionDirection = control.selectionDirection;
      }
      return field;
    }).filter(Boolean);
    if (!fields.length) return null;
    return {
      fields,
      focusKey: active && app.contains(active) ? draftControlKey(active) : ""
    };
  }

  function mergeEditorDrafts(...drafts) {
    const fields = new Map();
    let focusKey = "";
    drafts.filter(Boolean).forEach(draft => {
      (draft.fields || []).forEach(field => fields.set(field.key, field));
      if (draft.focusKey) focusKey = draft.focusKey;
    });
    return fields.size ? { fields: [...fields.values()], focusKey } : null;
  }

  function restoreEditorDraft(draft) {
    if (!draft?.fields?.length) return;
    const controls = new Map();
    app.querySelectorAll(draftControlSelector).forEach(control => {
      const key = draftControlKey(control);
      if (key && !controls.has(key)) controls.set(key, control);
    });
    draft.fields.forEach(field => {
      const control = controls.get(field.key);
      if (!control) return;
      if (field.restoreValue) {
        if (control.isContentEditable) control.innerHTML = field.value;
        else if (control.type === "checkbox" || control.type === "radio") control.checked = Boolean(field.checked);
        else control.value = field.value;
        dirtyDraftKeys.add(field.key);
      }
      control.scrollTop = field.scrollTop || 0;
      control.scrollLeft = field.scrollLeft || 0;
    });
    const focused = controls.get(draft.focusKey);
    if (!focused) return;
    const field = draft.fields.find(item => item.key === draft.focusKey);
    restoringEditorDraft = true;
    try {
      focused.focus({ preventScroll: true });
      if (field && Number.isInteger(field.selectionStart)) {
        focused.setSelectionRange(field.selectionStart, field.selectionEnd, field.selectionDirection || "none");
      }
    } catch {}
    restoringEditorDraft = false;
  }

  function pruneDirtyDraftKeys() {
    const liveKeys = new Set([...app.querySelectorAll(draftControlSelector)].map(draftControlKey).filter(Boolean));
    [...dirtyDraftKeys].forEach(key => {
      if (!liveKeys.has(key)) dirtyDraftKeys.delete(key);
    });
  }

  function bindSelectAllOnFocus(input) {
    if (!input) return;
    let selectOnMouseUp = false;
    input.addEventListener("mousedown", () => { selectOnMouseUp = document.activeElement !== input; });
    input.addEventListener("focus", () => {
      if (restoringEditorDraft) return;
      selectOnMouseUp = true;
      setTimeout(() => selectInputText(input), 0);
    });
    input.addEventListener("mouseup", event => {
      if (!selectOnMouseUp) return;
      event.preventDefault();
      selectOnMouseUp = false;
      selectInputText(input);
    });
  }

  function bindWorkTreeRenameSelectionGuard(input) {
    if (!input) return;
    input.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      workTreeRenameSelectingInput = input;
      const finish = () => {
        if (workTreeRenameSelectingInput === input && input.selectionStart !== input.selectionEnd) {
          workTreeSuppressRenameBlurUntil = Date.now() + 300;
        }
        if (workTreeRenameSelectingInput === input) workTreeRenameSelectingInput = null;
        window.removeEventListener("pointerup", finish, true);
        window.removeEventListener("pointercancel", finish, true);
      };
      window.addEventListener("pointerup", finish, true);
      window.addEventListener("pointercancel", finish, true);
    });
  }

  async function applySearchTargetSurface(targetSurface) {
    targetSurface = surfaceItems.some(([key]) => key === targetSurface) ? targetSurface : state.surface;
    // Search jumps can originate from another module while the BrowserWindow is
    // still using that source module's size. Always ask the main process to
    // apply the target module's stable bounds, even when renderer state already
    // says we are on that surface. This prevents a notes/todo sized window from
    // displaying the calendar surface, and also lets the main process sanitize
    // any old too-small calendar bounds back to the calendar minimum/default.
    if (window.dayline?.applySurfaceBounds) {
      const bounds = await window.dayline.getBounds?.();
      const appliedBounds = await window.dayline.applySurfaceBounds(targetSurface, bounds);
      if (appliedBounds?.windowState) state.windowState = appliedBounds.windowState;
      else if (appliedBounds) state.windowState = { ...(state.windowState || {}), [targetSurface]: appliedBounds };
      state.surface = targetSurface;
      render();
    } else {
      state.surface = targetSurface;
    }
  }

  async function goToSearchResult(type, id) {
    state.searchOpen = false;
    state.searchQuery = "";
    state.highlight = { type, id };
    let targetSurface = state.surface;
    if (type === "todo") {
      targetSurface = "todo";
    } else if (type === "event") {
      targetSurface = "calendar";
    } else if (type === "note") {
      targetSurface = "notes";
    }

    await applySearchTargetSurface(targetSurface);

    if (type === "todo") {
      state.editingTodoId = id;
    } else if (type === "event") {
      const event = state.events.find(item => item.id === id);

      if (event?.date) state.cursor = parseDate(event.date);
      state.editingEventId = id;
    } else if (type === "note") {
      const note = state.notes.find(item => item.id === id);
      state.noteFilter = note?.archived ? "archived" : "active";
      state.activeFolderId = note?.folderId || "all";
    }
    await persist();
    render();
    setTimeout(() => app.querySelector(`[data-${type}-id="${id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 80);
  }

  function renderTrashPanel() {
    if (!state.showTrash) return "";
    const items = state.trash || [];
    return `
      <section class="trash-panel" data-trash-panel>
        <div class="trash-head"><b>回收站</b><button class="trash-clear-head" data-clear-trash ${items.length ? "" : "disabled"}>清空</button><button data-close-trash aria-label="关闭回收站"><span data-ui-icon="x" aria-hidden="true"></span></button></div>
        <div class="trash-list">${items.length ? items.map(entry => `<div class="trash-row"><span>${trashTypeLabel(entry.type)}</span><b>${esc(entry.title || entry.item?.title || "未命名")}</b><em>${new Date(entry.deletedAt).toLocaleString("zh-CN")}</em><button data-restore-trash="${entry.id}">恢复</button><button data-permanent-trash="${entry.id}">永久删除</button></div>`).join("") : `<div class="empty-row">回收站为空</div>`}</div>
        <div class="trash-actions"><button data-clear-trash ${items.length ? "" : "disabled"}>清空回收站</button></div>
      </section>`;
  }

  function trashTypeLabel(type) {
    if (type === "todo") return "待办";
    if (type === "event") return "日程";
    if (type === "note") return "便签";
    if (type === "workTreeNode") return "树杈";
    return "项目";
  }

  function collectionForType(type) {
    if (type === "todo") return "todos";
    if (type === "event") return "events";
    if (type === "note") return "notes";
    return "";
  }

  function pushUndoEntry(entry) {
    if (!entry) return;
    state.undoStack = [...(state.undoStack || []), { ...clone(entry), at: nowIso() }].slice(-UNDO_LIMIT);
  }

  function clearTrashUndoEntry(entryId) {
    if (!entryId) return;
    state.undoStack = (state.undoStack || []).filter(action => action.id !== entryId && action.entryId !== entryId);
    state.workTreeUndoStack = (state.workTreeUndoStack || []).filter(action => action.entryId !== entryId);
  }

  function clearAllTrashUndoEntries() {
    state.undoStack = (state.undoStack || []).filter(action => !action.id && !action.entryId);
    state.workTreeUndoStack = (state.workTreeUndoStack || []).filter(action => action.type !== "trashEntry");
  }

  async function softDelete(type, id, { changes = null, editingId = id } = {}) {
    const collection = collectionForType(type);
    if (!collection) return;
    const index = state[collection].findIndex(item => item.id === id);
    if (index < 0) return;
    const [item] = state[collection].splice(index, 1);
    const entry = { id: uid("trash"), type, item, index, title: item.title || "未命名", deletedAt: nowIso() };
    state.trash = [entry, ...(state.trash || [])].slice(0, 200);
    if (type === "event" && item.todoId) refreshTodoSchedule(item.todoId);
    const saved = await persist(null, changes?.());
    if (!saved) { render(); return false; }
    pushUndoEntry(entry);
    if (type === "event" && state.editingEventId === editingId) {
      clearDraftControls(app.querySelector("[data-event-editor]"));
      state.editingEventId = "";
      state.editingOccurrenceDate = "";
    }
    if (type === "todo" && state.editingTodoId === id) state.editingTodoId = "";
    render();
    return true;
  }

  async function restoreTrashEntry(entry) {
    if (!entry) return;
    clearTrashUndoEntry(entry.id);
    if (entry.type === "workTreeNode") {
      restoreWorkTreeNodeTrashEntry(entry);
      await persist();
      render();
      return;
    }
    const collection = collectionForType(entry.type);
    if (!collection) return;
    if (!state[collection].some(item => item.id === entry.item.id)) {
      const restored = { ...clone(entry.item), updatedAt: nowIso() };
      const index = Number.isInteger(entry.index) ? Math.max(0, Math.min(entry.index, state[collection].length)) : state[collection].length;
      state[collection].splice(index, 0, restored);
      if (entry.type === "event" && restored.todoId) refreshTodoSchedule(restored.todoId);
    }
    state.trash = (state.trash || []).filter(item => item.id !== entry.id);
    await persist();
    render();
  }

  async function undoLastDelete() {
    const action = state.undoStack?.pop();
    if (!action) return;
    if (action.type === "createNote") {
      state.notes = state.notes.filter(note => note.id !== action.noteId);
      normalizeNoteOrders();
      await persist();
      render();
      return;
    }
    if (action.type === "createFolder") {
      const fallbackFolderId = state.noteFolders.some(folder => folder.id === action.sourceFolderId) ? action.sourceFolderId : "";
      state.notes.forEach(note => {
        if (note.folderId === action.folderId && !(action.noteIds || []).includes(note.id)) {
          note.folderId = fallbackFolderId;
          note.updatedAt = nowIso();
        }
      });
      state.noteFolders = state.noteFolders.filter(folder => folder.id !== action.folderId);
      state.notes = state.notes.filter(note => !(action.noteIds || []).includes(note.id));
      state.noteFolders.forEach((folder, order) => { folder.order = order; });
      state.activeFolderId = state.noteFolders.some(folder => folder.id === action.previousActiveFolderId) ? action.previousActiveFolderId : "all";
      await persist();
      render();
      return;
    }
    const entry = (state.trash || []).find(item => item.id === action.id && item.type !== "workTreeNode");
    if (entry) await restoreTrashEntry(entry);
  }

  async function skipTodoOccurrence(todo) {
    const nextDate = nextRepeatDate(todo.targetDate || toDateKey(new Date()), todo.repeat);
    if (!repeatAllowsDate(nextDate, todo.repeatEndDate)) return;
    todo.repeatSkippedDates = [...(todo.repeatSkippedDates || []), todo.targetDate].filter(Boolean);
    todo.targetDate = nextDate;
    todo.completed = false;
    todo.reminderLastKey = "";
    todo.updatedAt = nowIso();
    await persist();
    render();
  }

  async function skipEventOccurrence(event, occurrenceDate = event.date) {
    const repeat = normalizeRepeat(event.repeat);
    if (repeat === "none") return;
    if (occurrenceDate && occurrenceDate !== event.date) {
      event.repeatSkippedDates = Array.from(new Set([...(event.repeatSkippedDates || []), occurrenceDate]));
    } else {
      const nextDate = nextRepeatDate(event.date, repeat);
      if (!repeatAllowsDate(nextDate, event.repeatEndDate)) return;
      event.date = nextDate;
    }
    event.reminderLastKey = "";
    event.updatedAt = nowIso();
    await persist();
    state.editingEventId = "";
    state.editingOccurrenceDate = "";
    render();
  }
  function render(preservedDraft = null) {
    window.AccountSubscriptionEditor.dispose();
    const calendarAnchor = !calendarRevealDate && continuousCalendarAnchor(app.querySelector(".continuous-months"));
    const draft = mergeEditorDrafts(captureEditorDraft(), preservedDraft);
    closeNotePasteMenu();
    floatingMenusCleanup?.();
    floatingMenusCleanup = null;
    window.XiaoyeIcons.beforeRender();
    applySettings();
    monthCalendarResizeObserver?.disconnect();
    app.innerHTML = `
      <main class="glass-app ${state.surface}">
        <div class="auto-hide-tab" aria-hidden="true">${surfaceItems.find(([key]) => key === state.surface)?.[1] || "\u5f85"}</div>
        ${renderToolbar()}
        <section class="surface-body">
          ${state.surface === "todo" ? renderTodo() : ""}
          ${state.surface === "calendar" ? renderCalendar() : ""}
          ${state.surface === "notes" ? renderNotes() : ""}
          ${state.surface === "worktree" ? renderWorkTree() : ""}
        </section>
        ${state.editingTodoId ? renderTodoEditor() : ""}
        ${state.showSettings ? renderSettings() : ""}
        ${state.showReminderSettings ? renderReminderSettings() : ""}
        ${renderSearchPanel()}
        ${renderTrashPanel()}
        ${state.surface === "worktree" ? renderWorkTreeContextMenu() : ""}
        ${state.lightboxImage ? `<button class="image-lightbox" data-close-lightbox><img src="${state.lightboxImage}" alt="note image" /></button>` : ""}
      </main>
    `;
    bindCommon();
    bindSearchPanel();
    bindTrashPanel();
    bindTodoEditor();
    bindReminderSettings();
    if (state.surface === "todo") bindTodo();
    if (state.surface === "calendar") bindCalendar();
    if (state.surface === "notes") bindNotes();
    if (state.surface === "worktree") bindWorkTree();
    bindScrollState();
    restoreContinuousCalendarAnchor(app.querySelector(".continuous-months"), calendarAnchor);
    restoreEditorDraft(draft);
    window.AccountSubscriptionEditor.refresh();
    refreshEventColorControls();
    const eventUrl = app.querySelector("[data-event-url]");
    if (eventUrl) app.querySelector("[data-open-event-url]").disabled = !window.EventAddress.webUrl(eventUrl.value);
    app.querySelectorAll("[data-task-options]").forEach(panel => {
      const type = panel.querySelector("[data-task-type]").value;
      panel.querySelector("[data-goal-fields]").hidden = type !== "goal";
      panel.querySelector("[data-goal-new-field]").hidden = panel.querySelector("[data-goal-parent]").value !== "__new";
      const flow = panel.querySelector("[data-todo-flow-fields]");
      if (flow) flow.hidden = type !== "flow";
    });
    const taskFields = app.querySelector("[data-event-task-fields]");
    if (taskFields) taskFields.hidden = !app.querySelector("[data-event-ongoing]")?.checked;
    pruneDirtyDraftKeys();
    updateEditorFeedback("todo");
    updateEditorFeedback("event");
    window.XiaoyeIcons.mount(app);
    const disposeDetailsMenus = window.XiaoyeFloating.bindMenus(app);
    const nodeMenu = app.querySelector("[data-work-node-menu]");
    const menuState = state.workTreeContextMenu;
    let nodeFloating = null;
    if (nodeMenu && menuState) {
      const nodeId = CSS.escape(menuState.nodeId);
      const anchor = menuState.kind === "task" ? app.querySelector(`[data-work-node-todo="${nodeId}"]`) : null;
      const reference = anchor || {
        getBoundingClientRect: () => new DOMRect(menuState.x, menuState.y, 0, 0),
        contextElement: app.querySelector(`[data-work-node-command="${nodeId}"]`)
      };
      nodeFloating = window.XiaoyeFloating.attach(reference, nodeMenu, { placement: "bottom-start", gap: anchor ? 4 : 0 });
    }
    floatingMenusCleanup = () => { disposeDetailsMenus(); nodeFloating?.dispose(); };
    revealCalendarDate();
  }

  function revealCalendarDate() {
    if (!calendarRevealDate || state.surface !== "calendar") return;
    const grid = app.querySelector(state.calendarView === "year" ? ".calendar-year-grid" : ".calendar-grid");
    const cell = grid?.querySelector(`[data-date="${calendarRevealDate}"], [data-year-date="${calendarRevealDate}"]`);
    if (!cell || !grid.clientHeight) return;
    const target = state.calendarView === "year" ? cell.closest(".year-month") : cell;
    const top = target.getBoundingClientRect().top - grid.getBoundingClientRect().top + grid.scrollTop;
    grid.scrollTop = Math.max(0, top - 8);
    if (grid.classList.contains("continuous-months")) {
      state.selectedDate = calendarRevealDate;
      grid.querySelectorAll("[data-date]").forEach(day => { day.tabIndex = day === cell ? 0 : -1; });
    }
    calendarRevealDate = "";
  }

  function selectCalendarToday() {
    state.cursor = startOfDay(new Date());
    state.selectedDate = toDateKey(state.cursor);
    calendarRevealDate = state.selectedDate;
  }

  function showCalendarToday() {
    selectCalendarToday();
    render();
    persistUiStatePatch({ cursor: toDateKey(state.cursor) });
  }

  function bindScrollState() {
    app.querySelectorAll("[data-scroll-key]").forEach(element => {
      const key = element.dataset.scrollKey;
      const saved = state.scrollState?.[key];
      const isWorkTreeMindmap = key === "worktreeMindmap" || key.startsWith("worktreeMindmap:");
      let shouldCorrectSingleRoot = false;
      if (isWorkTreeMindmap) {
        const zoom = clampWorkTreeZoom(saved?.zoom || element.dataset.mindZoom || 1);
        const rootX = Number(element.dataset.rootX || 0) * zoom;
        const rootY = Number(element.dataset.rootY || 0) * zoom;
        const rootW = Number(element.dataset.rootW || 0) * zoom;
        const rootH = Number(element.dataset.rootH || 0) * zoom;
        let hasSavedTop = false;
        let hasSavedLeft = false;
        const placeSingleRoot = () => {
          element.scrollLeft = Math.max(0, rootX - 28);
          element.scrollTop = Math.max(0, rootY - Math.max(28, element.clientHeight * .34));
        };
        const placeDoubleRoot = () => {
          element.scrollLeft = Math.max(0, rootX - (element.clientWidth - rootW) / 2);
          element.scrollTop = Math.max(0, rootY - (element.clientHeight - rootH) / 2);
        };
        if (Number.isFinite(saved)) {
          element.scrollTop = saved;
          hasSavedTop = true;
        }
        else if (saved && typeof saved === "object") {
          if (Number.isFinite(saved.top)) {
            element.scrollTop = saved.top;
            hasSavedTop = true;
          }
          if (Number.isFinite(saved.left)) {
            element.scrollLeft = saved.left;
            hasSavedLeft = true;
          }
        }
        if (!hasSavedTop && !hasSavedLeft) {
          if (element.classList.contains("single")) placeSingleRoot();
          else placeDoubleRoot();
        } else if (element.classList.contains("single")) {
          if (!hasSavedLeft) element.scrollLeft = Math.max(0, rootX - 28);
          if (!hasSavedTop) element.scrollTop = Math.max(0, rootY - Math.max(28, element.clientHeight * .34));
        } else {
          if (!hasSavedLeft) element.scrollLeft = Math.max(0, rootX - (element.clientWidth - rootW) / 2);
          if (!hasSavedTop) element.scrollTop = Math.max(0, rootY - (element.clientHeight - rootH) / 2);
        }
        // A saved position is intentional user navigation; ordinary rerenders must not pull the root back into view.
        shouldCorrectSingleRoot = element.classList.contains("single") && !hasSavedTop && !hasSavedLeft;
      } else if (Number.isFinite(saved)) element.scrollTop = saved;
      else if (saved && typeof saved === "object") {
        if (Number.isFinite(saved.top)) element.scrollTop = saved.top;
        if (Number.isFinite(saved.left)) element.scrollLeft = saved.left;
      }
      element.addEventListener("scroll", () => {
        const previous = state.scrollState?.[key];
        const next = {
          ...(previous && typeof previous === "object" ? previous : {}),
          top: element.scrollTop,
          left: element.scrollLeft
        };
        if (isWorkTreeMindmap) next.zoom = clampWorkTreeZoom(element.dataset.mindZoom || next.zoom || 1);
        state.scrollState = { ...(state.scrollState || {}), [key]: next };
        clearTimeout(scrollSaveTimer);
        scrollSaveTimer = setTimeout(() => persistUiStatePatch({ scrollState: state.scrollState }), 180);
      });
      if (isWorkTreeMindmap && shouldCorrectSingleRoot) correctSingleWorkTreeRootPosition(element);
    });
  }

  function correctSingleWorkTreeRootPosition(element) {
    const root = element.querySelector("[data-mind-root]");
    if (!root || !element.classList.contains("single")) return;
    const mapRect = element.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const targetX = 42;
    const targetY = Math.min(72, Math.max(38, element.clientHeight * .1));
    const offsetX = rootRect.left - mapRect.left;
    const offsetY = rootRect.top - mapRect.top;
    if (offsetX < 12 || offsetX > element.clientWidth * .5) element.scrollLeft = Math.max(0, element.scrollLeft + offsetX - targetX);
    if (offsetY < 16 || offsetY > element.clientHeight * .42) element.scrollTop = Math.max(0, element.scrollTop + offsetY - targetY);
  }

  function renderToolbar() {
    return `
      <header class="toolbar">
        <nav class="mini-switch" style="--index:${surfaceItems.findIndex(([key]) => key === state.surface)};--count:${surfaceItems.length}">${surfaceItems.map(([key, label]) => `<button data-surface="${key}" class="${state.surface === key ? "active" : ""}">${label}</button>`).join("")}</nav>
        <div class="toolbar-spacer"></div>
        <button class="icon-btn search-btn ${state.searchOpen ? "active" : ""}" data-open-search title="搜索"><span class="toolbar-icon search-icon" aria-hidden="true"></span></button>
        ${["notes", "todo"].includes(state.surface) ? renderWindowMatchButton("toolbar") : ""}
        <button class="icon-btn pin-btn ${state.settings.alwaysOnTop ? "active" : ""}" data-toggle-top title="置顶"><span class="toolbar-icon pin-outline" aria-hidden="true"></span></button>
        <button class="icon-btn menu-btn ${state.showSettings ? "active" : ""}" data-menu title="设置"><span class="toolbar-icon gear-icon" aria-hidden="true"></span></button>
        <button class="icon-btn close-btn" data-close-window title="关闭"><span class="toolbar-icon close-icon" aria-hidden="true"></span></button>
      </header>
    `;
  }

  function renderCustomThemeColorPicker() {
    if (!state.customThemeColorOpen) return "";
    const color = normalizeHexColor(state.settings.themeColor || state.settings.accentColor || "#ffd21a");
    const hsv = rgbToHsv(hexToRgb(color));
    return `
      <div class="theme-color-custom-panel" style="--picker-hue:${hsv.h};--picker-color:${color};--picker-x:${hsv.s * 100}%;--picker-y:${(1 - hsv.v) * 100}%">
        <div class="theme-color-field" data-theme-color-field><span class="theme-color-thumb"></span></div>
        <input class="theme-color-hue" data-theme-color-hue type="range" min="0" max="360" step="1" value="${Math.round(hsv.h)}" />
      </div>
    `;
  }

  function refreshCustomThemeColorPicker() {
    const color = normalizeHexColor(state.settings.themeColor || "#ffd21a");
    const hsv = rgbToHsv(hexToRgb(color));
    const panel = app.querySelector(".theme-color-custom-panel");
    panel?.style.setProperty("--picker-hue", hsv.h);
    panel?.style.setProperty("--picker-color", color);
    panel?.style.setProperty("--picker-x", `${hsv.s * 100}%`);
    panel?.style.setProperty("--picker-y", `${(1 - hsv.v) * 100}%`);
    const hue = app.querySelector("[data-theme-color-hue]");
    if (hue && document.activeElement !== hue) hue.value = String(Math.round(hsv.h));
    app.querySelector(".color-picker-dot")?.style.setProperty("--preset", color);
    app.querySelectorAll("[data-theme-color]").forEach(button => {
      button.classList.toggle("active", button.dataset.themeColor?.toLowerCase() === color);
    });
  }

  async function saveCustomThemeColorSoon(delay = 180) {
    clearTimeout(customThemePersistTimer);
    customThemePersistTimer = setTimeout(() => persist().catch(console.error), delay);
  }

  function setCustomThemeColor(color, options = {}) {
    state.settings.themeColor = normalizeHexColor(color, state.settings.themeColor || "#ffd21a");
    applySettings();
    refreshCustomThemeColorPicker();
    if (options.save) saveCustomThemeColorSoon(options.delay);
  }

  function setCustomThemeColorFromField(event, save = false) {
    const field = app.querySelector("[data-theme-color-field]");
    if (!field) return;
    const rect = field.getBoundingClientRect();
    const hsv = rgbToHsv(hexToRgb(state.settings.themeColor || "#ffd21a"));
    const s = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const v = 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1);
    setCustomThemeColor(hsvToHex(hsv.h, s, v), { save, delay: save ? 0 : 180 });
  }

  function renderSettings() {
    return `
      <section class="settings-panel" data-settings-panel>
        <label class="switch-row"><span>\u5f00\u673a\u542f\u52a8</span><input type="checkbox" data-setting="launchAtStartup" ${state.settings.launchAtStartup ? "checked" : ""} /></label>
        <label class="switch-row"><span>\u9690\u85cf\u56fe\u6807</span><input type="checkbox" data-setting="hideTaskbarIcon" ${state.settings.hideTaskbarIcon ? "checked" : ""} /></label>
        <label class="switch-row"><span>\u9760\u8fb9\u9690\u85cf</span><input type="checkbox" data-setting="enableEdgeAutoHide" ${state.settings.enableEdgeAutoHide ? "checked" : ""} /></label>
        <label class="switch-row"><span>\u9632\u79fb\u51fa</span><input type="checkbox" data-setting="keepWindowsOnScreen" ${state.settings.keepWindowsOnScreen !== false ? "checked" : ""} /></label>
        <label class="switch-row" title="开启后点击日/项/待/签各自在新窗口打开；未开启时可按住Ctrl点击临时新开"><span>多窗口打开</span><input type="checkbox" data-setting="multiOpen" ${state.settings.multiOpen ? "checked" : ""} /></label>
        <div class="sensitivity-row"><span>\u7075\u654f\u5ea6</span><div class="settings-segmented"><button data-switch-sensitivity="5" class="${Number(state.settings.surfaceWheelSensitivity || 5) < 10 ? "active" : ""}">\u4f4e</button><button data-switch-sensitivity="10" class="${Number(state.settings.surfaceWheelSensitivity || 5) >= 10 ? "active" : ""}">\u9ad8</button></div></div>
        <div class="theme-row"><span>\u4e3b\u9898</span><div class="settings-segmented"><button data-theme="dark" class="${state.settings.theme !== "light" ? "active" : ""}">\u6df1\u8272</button><button data-theme="light" class="${state.settings.theme === "light" ? "active" : ""}">\u6d45\u8272</button></div></div>
        <div class="theme-color-palette"><div class="theme-color-presets">${themeColorPresets.map(color => `<button data-theme-color="${color}" style="--preset:${color}" class="${(state.settings.themeColor || "#ffd21a").toLowerCase() === color ? "active" : ""}" aria-label="theme color"></button>`).join("")}<label class="color-picker-dot" title="自定义主题颜色" style="--preset:${state.settings.themeColor || "#ffd21a"}"><input type="color" data-custom-theme-color value="${state.settings.themeColor || "#ffd21a"}" /></label></div></div>
        ${renderCustomThemeColorPicker()}
        <label class="switch-row"><span>\u81ea\u52a8\u5907\u4efd</span><input type="checkbox" data-setting="autoBackup" ${state.settings.autoBackup !== false ? "checked" : ""} /></label>
        <label class="range-row settings-opacity-row"><span>\u900f\u660e\u5ea6</span><input type="range" min="0.45" max="0.98" step="0.01" data-setting="opacity" value="${state.settings.opacity ?? 0.82}" /><output data-opacity-value>${Math.round((state.settings.opacity ?? 0.82) * 100)}%</output></label>
        <div class="settings-actions settings-actions-compact">
          <button data-create-backup>立即备份</button>
          <button data-open-sync>多电脑同步</button>
          <button data-open-reminder-settings>提醒时间</button>
          <button data-open-wechat-reminder>企微提醒</button>
          <button data-toggle-trash>回收站 (${(state.trash || []).length})</button>
        </div>
        <div class="settings-shortcuts" aria-label="快捷键">
          <b>快捷键</b>
          <span><kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>N</kbd></span><span>任何地方快速记录</span>
          <span><kbd>Ctrl</kbd> <kbd>N</kbd></span><span>新建待办 / 便签 / 日程</span>
          <span><kbd>Ctrl</kbd> <kbd>1</kbd>–<kbd>4</kbd></span><span>切换 日 / 项 / 待 / 签</span>
          <span><kbd>Ctrl</kbd> <kbd>K</kbd></span><span>搜索，↑↓ 选择，Enter 打开</span>
          <span><kbd>Ctrl</kbd> <kbd>Enter</kbd></span><span>完成待办 / 保存便签</span>
          <span><kbd>Ctrl</kbd> <kbd>Z</kbd></span><span>撤销删除</span>
        </div>
      </section>
    `;
  }
  function renderReminderSettings() {
    const prefs = window.ReminderRules.preferences(state);
    return `<section class="todo-editor reminder-editor" data-reminder-editor><div class="editor-head"><b>提醒时间</b><button data-close-reminder-settings aria-label="关闭"><span data-ui-icon="x" aria-hidden="true"></span></button></div>
      <div class="todo-simple-stack"><label>早间汇总<input type="time" data-reminder-morning value="${esc(prefs.morning)}" required /></label><label>晚间汇总<input type="time" data-reminder-evening value="${esc(prefs.evening)}" required /></label><label>提前分钟<input type="number" data-reminder-advance min="0" max="1440" step="1" value="${prefs.advanceMinutes}" /></label></div>
      <p class="reminder-settings-hint">早间提醒当天，晚间提醒明天。有具体时间的事项按提前分钟提醒；单条设置优先。时间随共享数据同步到电脑和微信。</p><p data-reminder-error role="status"></p>
      <div class="editor-actions"><button data-save-reminder-settings>保存</button></div></section>`;
  }

  function bindReminderSettings() {
    app.querySelector("[data-open-reminder-settings]")?.addEventListener("click", () => { state.showSettings = false; state.showReminderSettings = true; render(); });
    app.querySelector("[data-close-reminder-settings]")?.addEventListener("click", () => { state.showReminderSettings = false; render(); });
    app.querySelector("[data-save-reminder-settings]")?.addEventListener("click", async () => {
      const morning = app.querySelector("[data-reminder-morning]").value;
      const evening = app.querySelector("[data-reminder-evening]").value;
      const advanceMinutes = Number(app.querySelector("[data-reminder-advance]").value);
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(morning) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(evening) || !Number.isInteger(advanceMinutes) || advanceMinutes < 0 || advanceMinutes > 1440) { app.querySelector("[data-reminder-error]").textContent = "请输入有效时间和 0–1440 的整分钟。"; return; }
      state.reminderPreferences = [{ id: "reminders", morning, evening, advanceMinutes, updatedAt: nowIso() }];
      if (await persist()) { state.showReminderSettings = false; render(); }
    });
  }

  function renderTodo(options = {}) {
    const compact = Boolean(options.compact);
    const todayOnly = !compact && state.todoTodayOnly;
    const active = sortTodosBySchedule(state.todos.filter(todo => !todo.completed && (!todayOnly || isTodoForToday(todo))));
    const done = state.todos.filter(todo => todo.completed).sort(sortPinned);
    const twoColumns = !compact && Number(state.settings.todoColumns) === 2;
    return `
      <div class="list-panel todo-panel ${compact ? "compact" : ""} ${twoColumns ? "columns-2" : "columns-1"}">
        <div class="panel-action-row todo-action-row ${compact ? "compact-action-row" : ""}"><button class="panel-icon-btn" data-toggle-todo-schedule-sort title="按日程时间排序"><span class="sort-lines-icon ${state.todoScheduleSortAsc ? "asc" : "desc"}" aria-hidden="true"></span></button>${compact ? "" : `<button class="panel-icon-btn todo-columns-btn ${twoColumns ? "active" : ""}" data-toggle-todo-columns title="${twoColumns ? "单列显示" : "双列显示"}"><span class="todo-columns-icon ${twoColumns ? "double" : "single"}" aria-hidden="true"></span></button><button class="panel-icon-btn todo-today-btn ${state.todoTodayOnly ? "active" : ""}" data-toggle-todo-today title="今日待办"><span class="today-todo-icon" aria-hidden="true"></span></button>`}</div>
        ${renderTodoActiveList(active, twoColumns)}
        <button class="done-toggle" data-toggle-done aria-expanded="${state.showDone}"><span class="done-badge">${done.length}</span><b>\u5df2\u5f52\u6863</b><em class="archive-chevron ${state.showDone ? "open" : ""}" aria-hidden="true" data-ui-morph="archive" data-ui-morph-key="archive:${compact ? "calendar" : "todo"}" data-ui-expanded="${state.showDone}"></em></button>
        ${state.showDone ? `<ul class="task-list done-list" data-scroll-key="todoDone">${done.map(renderTodoRow).join("") || `<li class="empty-row">\u6682\u65e0\u5df2\u5b8c\u6210</li>`}</ul>` : ""}
      </div>
    `;
  }

  function isTodoForToday(todo) {
    const today = toDateKey(new Date());
    return todo.targetDate === today || state.events.some(event => event.todoId === todo.id && event.date === today && !event.completed);
  }

  function renderTodoAddRow() {
    return `<li class="task-row add-row"><button class="checkbox ghost" tabindex="-1" aria-hidden="true"></button><input data-new-todo-inline placeholder="新待办，如“明天下午3点 开会”" aria-describedby="todo-quick-hint" /><span class="quick-parse-hint" id="todo-quick-hint" data-quick-parse-hint hidden></span><select data-new-todo-type aria-label="任务类型"><option value="normal">待办</option><option value="goal">目标</option><option value="flow">流动</option></select></li>`;
  }

  function taskTitle(item) { return window.TaskState.title(state, item); }

  function renderGoalParents(tree, selected = "", excluded = "") {
    const blocked = tree && excluded ? new Set([excluded, ...workTreeDescendantIds(tree, excluded)]) : new Set();
    return `<option value="">请选择上级目标</option>${tree ? `<option value="__root" ${excluded && !selected ? "selected" : ""}>${esc(tree.title)}（项目）</option>` : ""}${(tree?.nodes || []).filter(node => !blocked.has(node.id) && isWorkTreeFolder(tree, node)).map(node => {
      const names = [node.title], seen = new Set([node.id]);
      let parent = tree.nodes.find(row => row.id === node.parentId);
      while (parent && !seen.has(parent.id)) { names.unshift(parent.title); seen.add(parent.id); parent = tree.nodes.find(row => row.id === parent.parentId); }
      return `<option value="${esc(node.id)}" ${node.id === selected ? "selected" : ""}>${esc(names.join(" / "))}</option>`;
    }).join("")}<option value="__new">新建上级目标…</option>`;
  }

  function renderTaskOptions(scope, item) {
    const type = window.TaskState.typeOf(item);
    const trees = visibleWorkTrees();
    const tree = trees.find(row => row.id === item.workTreeId) || trees[0];
    const node = tree?.nodes.find(row => row.id === item.workTreeNodeId);
    return `<div class="task-options" data-task-options="${scope}">
      ${scope === 'event' ? window.AccountSubscriptionEditor.typeControl(type, item) : `<label>类型<select data-task-type><option value="normal" ${type === "normal" ? "selected" : ""}>普通待办</option><option value="goal" ${type === "goal" ? "selected" : ""}>目标</option><option value="flow" ${type === "flow" ? "selected" : ""}>流动</option></select></label>`}
      <div class="goal-fields" data-goal-fields ${type === "goal" ? "" : "hidden"}>
        <label>项目<select data-goal-project><option value="">请选择项目</option>${trees.map(row => `<option value="${esc(row.id)}" ${row.id === tree?.id ? "selected" : ""}>${esc(row.title)}</option>`).join("")}</select></label>
        <label>上级目标<select data-goal-parent>${renderGoalParents(tree, node?.parentId, node?.id)}</select></label>
        <label data-goal-new-field hidden>新目标<input data-goal-new placeholder="输入上级目标名称" /></label>
      </div>${scope === "todo" ? `<div class="goal-fields" data-todo-flow-fields ${type === "flow" ? "" : "hidden"}><label>进度<input data-todo-flow-progress value="${esc(item.progress || "")}" placeholder="例如：实验中" /></label><label>优先级<select data-todo-flow-priority>${[[3, "高"], [2, "普通"], [1, "低"]].map(([value, label]) => `<option value="${value}" ${(Number(item.priority) || 2) === value ? "selected" : ""}>${label}</option>`).join("")}</select></label></div>` : ""}<p class="task-option-error" data-task-error role="status"></p>
    </div>`;
  }

  function bindTaskOptions(scope) {
    const panel = app.querySelector(`[data-task-options="${scope}"]`);
    if (!panel) return;
    const update = () => {
      const type = panel.querySelector("[data-task-type]").value;
      panel.querySelector("[data-goal-fields]").hidden = type !== "goal";
      if (scope === "todo") panel.querySelector("[data-todo-flow-fields]").hidden = type !== "flow";
      const ongoing = app.querySelector("[data-event-ongoing]");
      if (scope === "event" && ongoing) { ongoing.checked = type === "flow"; ongoing.dispatchEvent(new Event("change")); }
    };
    panel.querySelector("[data-task-type]").addEventListener("change", update);
    panel.querySelector("[data-goal-project]").addEventListener("change", e => {
      const tree = state.workTrees.find(row => row.id === e.target.value);
      panel.querySelector("[data-goal-parent]").innerHTML = renderGoalParents(tree);
      panel.querySelector("[data-goal-new-field]").hidden = true;
    });
    panel.querySelector("[data-goal-parent]").addEventListener("change", e => { panel.querySelector("[data-goal-new-field]").hidden = e.target.value !== "__new"; });
  }

  function readTaskOptions(scope) {
    const panel = app.querySelector(`[data-task-options="${scope}"]`);
    if (!panel) return { type: "normal" };
    const type = panel.querySelector("[data-task-type]").value;
    const tree = state.workTrees.find(row => row.id === panel.querySelector("[data-goal-project]").value);
    const parentId = panel.querySelector("[data-goal-parent]").value;
    const newTitle = panel.querySelector("[data-goal-new]").value.trim();
    if (type === "goal" && (!tree || !parentId || (parentId === "__new" && !newTitle))) {
      panel.querySelector("[data-task-error]").textContent = "请选择项目和上级目标，或输入新目标名称。";
      return null;
    }
    return { type, tree, parentId, newTitle, ...(scope === "todo" ? { progress: panel.querySelector("[data-todo-flow-progress]").value.trim(), priority: Number(panel.querySelector("[data-todo-flow-priority]").value) || 2 } : {}) };
  }

  function applyTaskOptions(todo, options) {
    todo.taskType = options.type;
    if (options.type === "flow" && options.progress !== undefined) { todo.progress = options.progress; todo.priority = options.priority; }
    if (options.type !== "goal") return;
    const { tree, newTitle } = options;
    let parent = options.parentId === "__root" ? { id: "", title: tree.title } : options.parentId === "__new" ? tree.nodes.find(row => row.title === newTitle && !row.parentId && isWorkTreeFolder(tree, row)) : tree.nodes.find(row => row.id === options.parentId);
    if (!parent) { parent = { id: uid("node"), title: newTitle, folder: true, parentId: "", order: tree.nodes.length, createdAt: nowIso(), updatedAt: nowIso() }; tree.nodes.push(parent); }
    let node = tree.nodes.find(row => row.id === todo.workTreeNodeId || row.todoId === todo.id);
    if (!node) {
      const oldTree = state.workTrees.find(row => row.id === todo.workTreeId);
      const oldNode = oldTree?.nodes.find(row => row.id === todo.workTreeNodeId);
      if (oldNode?.todoId === todo.id) oldNode.todoId = "";
      node = { id: uid("node"), title: todo.title, parentId: parent.id, order: tree.nodes.length, createdAt: nowIso(), updatedAt: nowIso() };
      tree.nodes.push(node);
    }
    node.parentId = parent.id; node.todoId = todo.id; node.title = todo.title; node.completed = Boolean(todo.completed); node.updatedAt = nowIso();
    parent.folder = true; tree.updatedAt = nowIso();
    todo.workTreeId = tree.id; todo.workTreeNodeId = node.id; todo.goalParentTitle = parent.title;
  }

  function applyTodoTaskToEvent(todo, event) {
    event.taskType = todo.taskType || "normal";
    event.ongoing = todo.taskType === "flow";
    if (event.ongoing) { event.repeat = "none"; event.repeatEndDate = ""; }
    event.goalParentTitle = todo.goalParentTitle || "";
    event.workTreeId = todo.workTreeId || "";
    event.workTreeNodeId = todo.workTreeNodeId || "";
    if (todo.taskType === "flow" && todo.progress !== undefined) { event.progress = todo.progress; event.priority = todo.priority || 2; }
    event.color = todo.completed ? (state.settings.eventDoneColor || "#78d68f") : todo.taskType === "flow" ? labelColorPresets[1] : labelColorPresets[0];
  }

  function renderTodoActiveList(active, twoColumns) {
    if (!twoColumns) {
      return `<ul class="task-list" data-scroll-key="todoActive">${active.map(renderTodoRow).join("") || `<li class="empty-row empty-hint">没有待办，直接在下方输入即可</li>`}${renderTodoAddRow()}</ul>`;
    }
    if (!active.length) {
      return `<div class="task-list todo-column-major-list" data-scroll-key="todoActive"><div class="empty-row todo-column-empty">\u6682\u65e0</div>${renderTodoAddRow()}</div>`;
    }
    const splitAt = Math.ceil(active.length / 2);
    const left = active.slice(0, splitAt);
    const right = active.slice(splitAt);
    return `<div class="task-list todo-column-major-list" data-scroll-key="todoActive"><ul class="task-list-column">${left.map(renderTodoRow).join("")}</ul><ul class="task-list-column">${right.map(renderTodoRow).join("")}</ul>${renderTodoAddRow()}</div>`;
  }

  function sortPinned(a, b) {
    return a.pinned === b.pinned ? (a.order || 0) - (b.order || 0) : a.pinned ? -1 : 1;
  }

  function renderWindowMatchButton(place = "panel") {
    const cls = place === "toolbar" ? "icon-btn toolbar-window-match-btn" : "panel-icon-btn";
    return `<button class="${cls} window-match-btn" data-toggle-calendar-window-size title="同步窗口大小"><span class="window-glyph match-window-icon" aria-hidden="true"></span></button>`;
  }

  function scheduleTimeKey(event) {
    return `${event.date || "9999-12-31"}T${event.startTime || "00:00"}`;
  }

  function sortedTodoEvents(todoId) {
    return state.events
      .filter(event => event.todoId === todoId && event.date)
      .sort((a, b) => scheduleTimeKey(a).localeCompare(scheduleTimeKey(b)));
  }

  function todoScheduleInfo(todo) {
    const today = toDateKey(new Date());
    const events = sortedTodoEvents(todo.id);
    const scheduleItems = [
      ...events.map(event => ({
        date: event.date,
        key: scheduleTimeKey(event)
      })),
      ...(todo.targetDate && !events.some(event => event.date === todo.targetDate)
        ? [{ date: todo.targetDate, key: `${todo.targetDate}T00:00` }]
        : [])
    ].filter(item => item.date);
    scheduleItems.sort((a, b) => a.key.localeCompare(b.key));
    const overdue = scheduleItems.filter(item => item.date < today);
    const upcoming = scheduleItems.filter(item => item.date >= today);
    const primary = overdue[0] || upcoming[0] || null;
    return {
      hasSchedule: Boolean(scheduleItems.length),
      overdue: Boolean(overdue.length),
      date: primary?.date || "",
      key: primary?.key || "9999-12-31T99:99"
    };
  }

  function sortTodosBySchedule(todos) {
    const meta = new Map();
    const read = todo => {
      if (!meta.has(todo.id)) meta.set(todo.id, todoScheduleInfo(todo));
      return meta.get(todo.id);
    };
    return [...todos].sort((a, b) => {
      const left = read(a);
      const right = read(b);
      const leftGroup = left.hasSchedule ? 0 : 1;
      const rightGroup = right.hasSchedule ? 0 : 1;
      if (leftGroup !== rightGroup) return leftGroup - rightGroup;
      if (left.hasSchedule && right.hasSchedule && left.key !== right.key) {
        return state.todoScheduleSortAsc ? left.key.localeCompare(right.key) : right.key.localeCompare(left.key);
      }
      return sortPinned(a, b);
    });
  }

  function isTodoOverdue(todo) {
    return !todo.completed && todo.taskType !== "flow" && todoScheduleInfo(todo).overdue;
  }

  function isEventOverdue(event) {
    return Boolean(event.todoId && !event.completed && event.date && event.date < toDateKey(new Date()));
  }

  function renderTodoRow(todo) {
    const schedule = todoScheduleInfo(todo);
    const scheduleLabel = !todo.completed ? countdown(todo, schedule.date || todo.targetDate) : "";
    const overdue = isTodoOverdue(todo);
    const reminder = scheduledReminderAt(todo, "todo");
    const meta = [todo.repeat && todo.repeat !== "none" ? repeatLabel(todo.repeat) : "", reminder ? `提醒 ${dateTimeLocalValue(reminder).replace("T", " ")}` : ""].filter(Boolean).join(" · ");
    return `
      <li class="task-row ${todo.completed ? "completed" : ""} ${overdue ? "overdue" : ""} ${state.highlight?.type === "todo" && state.highlight.id === todo.id ? "highlight" : ""}" data-todo-id="${todo.id}" draggable="true">
        <button class="checkbox ${todo.completed ? "checked" : ""}" data-toggle-todo="${todo.id}" aria-label="toggle todo"></button>
        <input class="row-input" data-edit-todo="${todo.id}" value="${esc(todo.title)}" ${todo.taskType === "goal" ? `style="flex:0 1 auto;width:${Math.max(2, Math.min(24, [...todo.title].length))}em;max-width:50%"` : ""} />${todo.taskType === "goal" ? `<span class="goal-parent-label">${esc(taskTitle(todo).slice(todo.title.length))}</span>` : ""}${todo.taskType === "flow" ? `<span class="task-type-flow">流动</span>` : ""}
        ${scheduleLabel ? `<span class="date-chip ${overdue ? "overdue" : ""}">${scheduleLabel}</span>` : ""}
        ${meta ? `<span class="todo-meta">${esc(meta)}</span>` : ""}
        <span style="display:inline-flex;align-items:center;gap:2px"><button class="row-icon todo-detail-more" data-open-todo="${todo.id}" title="待办详情" aria-label="待办详情">…</button><button class="row-icon quick-delete-todo" data-delete-todo="${todo.id}" title="删除">&times;</button></span>
      </li>
    `;
  }

  function renderTodoEditor() {
    const todo = state.todos.find(item => item.id === state.editingTodoId) || state.pendingTodoDraft;
    if (!todo) return "";
    return `
      <section class="todo-editor" data-todo-editor-panel role="region" aria-labelledby="todo-editor-heading">
        <div class="editor-head"><b id="todo-editor-heading">待办详情</b><button data-close-todo-editor aria-label="关闭待办详情"><span data-ui-icon="x" aria-hidden="true"></span></button></div>
        <input data-todo-editor-title value="${esc(todo.title)}" placeholder="待办标题" aria-label="待办标题" />
        ${renderTaskOptions("todo", todo)}
        <div class="todo-simple-stack">
          <label>目标日<input type="date" data-todo-target-date value="${todo.targetDate || ""}" /></label>
          <label>时间<input type="time" data-todo-target-time value="${esc(todo.startTime || "")}" /></label>
          <label>提前提醒<select data-todo-reminder-lead>${renderReminderLeadOptions(todo.reminderLead || (todo.reminderAt ? "0" : "none"))}</select></label>
          <label class="todo-complete-line">状态<span class="complete-toggle"><input type="checkbox" data-todo-completed ${todo.completed ? "checked" : ""} /> <em>${todo.completed ? "已完成" : "未完成"}</em></span></label>
        </div>
        <p data-editor-status role="status" hidden></p>
        <div class="editor-actions editor-actions-two"><button data-save-todo>保存</button><button data-delete-todo-detail class="${state.pendingTodoDraft === todo ? "" : "is-destructive"}">${state.pendingTodoDraft === todo ? "取消" : "删除"}</button></div>
      </section>`;
  }

  function bindTodoEditor() {
    const todo = state.todos.find(item => item.id === state.editingTodoId) || state.pendingTodoDraft;
    if (!todo) return;
    bindTaskOptions("todo");
    app.querySelector("[data-close-todo-editor]")?.addEventListener("click", () => { state.pendingTodoDraft = null; state.editingTodoId = ""; render(); restoreEditorEntry(); });
    app.querySelector("[data-save-todo]")?.addEventListener("click", () => saveEditor("todo", todo.id, async () => {
      const options = readTaskOptions("todo");
      if (!options) return;
      const title = app.querySelector("[data-todo-editor-title]");
      if (!title.value.trim()) { editorSaveStates.todo.message = "请填写待办标题。"; title.setAttribute("aria-invalid", "true"); title.focus(); return; }
      const wasDraft = state.pendingTodoDraft === todo;
      const draftLinks = { ...todo };
      const changes = captureEditorChanges();
      if (wasDraft) state.todos.push(todo);
      const wasCompleted = Boolean(todo.completed);
      todo.title = app.querySelector("[data-todo-editor-title]")?.value.trim() || todo.title;
      todo.targetDate = app.querySelector("[data-todo-target-date]")?.value || "";
      todo.startTime = app.querySelector("[data-todo-target-time]")?.value || "";
      todo.reminderLead = app.querySelector("[data-todo-reminder-lead]")?.value || "none";
      todo.reminderAt = todo.targetDate && (todo.startTime || todo.reminderLead !== "none") ? `${todo.targetDate}T${todo.startTime || "09:00"}:00.000` : "";
      todo.completed = Boolean(app.querySelector("[data-todo-completed]")?.checked);
      todo.reminderLastKey = "";
      todo.updatedAt = nowIso();
      applyTaskOptions(todo, options);
      if (options.type === "flow") ensureTodoEventForDate(todo, todo.targetDate || toDateKey(new Date()));
      if (!wasCompleted && todo.completed) ensureNextTodoFromRepeat(todo);
      syncTodoEvents(todo);
      const rollback = changes();
      const saved = await persist(null, rollback);
      if (!saved) {
        if (wasDraft) {
          for (const key of ["workTreeId", "workTreeNodeId", "goalParentTitle", "scheduledEventId"]) { if (Object.hasOwn(draftLinks, key)) todo[key] = draftLinks[key]; else delete todo[key]; }
          state.pendingTodoDraft = todo;
        }
        render();
        return;
      }
      clearDraftControls(app.querySelector("[data-todo-editor-panel]"));
      if (wasDraft) state.pendingTodoDraft = null;
      state.editingTodoId = "";
      render();
      restoreEditorEntry();
    }));
    app.querySelector("[data-skip-todo]")?.addEventListener("click", () => skipTodoOccurrence(todo));
    app.querySelector("[data-delete-todo-detail]")?.addEventListener("click", () => { if (state.pendingTodoDraft === todo) { state.pendingTodoDraft = null; state.editingTodoId = ""; render(); restoreEditorEntry(); } else softDelete("todo", todo.id); });
  }

  async function addTodo(title) {
    const clean = title.trim();
    if (!clean) return;
    const tags = tagsFrom(clean);
    const type = app.querySelector("[data-new-todo-type]")?.value || "normal";
    const parsed = window.QuickParse?.parse(clean.replace(/\[(.+?)\]/g, "").trim()) || { title: clean.replace(/\[(.+?)\]/g, "").trim(), date: "", time: "", repeat: "none" };
    const todo = { id: uid("todo"), title: parsed.title, taskType: type, completed: false, pinned: false, order: state.todos.length, tags, targetDate: parsed.date, startTime: parsed.time, reminderLead: "none", reminderAt: parsed.date && parsed.time ? `${parsed.date}T${parsed.time}:00.000` : "", repeat: parsed.repeat, createdAt: nowIso(), updatedAt: nowIso() };
    if (type !== "normal") { rememberEditorEntry(app.querySelector("[data-new-todo-inline]")); state.pendingTodoDraft = todo; state.editingTodoId = todo.id; clearDraftControl(app.querySelector("[data-new-todo-inline]")); render(); return; }
    state.todos.push(todo);
    const saved = await persist();
    if (!saved) return;
    clearDraftControl(app.querySelector("[data-new-todo-inline]"));
    render();
    setTimeout(() => selectInputText(app.querySelector("[data-new-todo-inline]"), { reveal: true }), 0);
  }

  function bindTodo() {
    app.querySelectorAll("[data-open-todo]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      rememberEditorEntry(button);
      state.editingTodoId = button.dataset.openTodo;
      render();
      setTimeout(() => selectInputText(app.querySelector("[data-todo-editor-title]")), 0);
    }));
    app.querySelector("[data-toggle-todo-schedule-sort]")?.addEventListener("click", () => {
      state.todoScheduleSortAsc = !state.todoScheduleSortAsc;
      render();
      persistUiStatePatch({ todoScheduleSortAsc: state.todoScheduleSortAsc });
    });
    app.querySelector("[data-toggle-todo-columns]")?.addEventListener("click", async () => {
      state.settings.todoColumns = Number(state.settings.todoColumns) === 2 ? 1 : 2;
      await persist();
      render();
    });
    app.querySelector("[data-toggle-todo-today]")?.addEventListener("click", () => {
      state.todoTodayOnly = !state.todoTodayOnly;
      render();
      persistUiStatePatch({ todoTodayOnly: state.todoTodayOnly });
    });
    const inlineTodo = app.querySelector("[data-new-todo-inline]");
    const updateQuickHint = () => {
      const hint = app.querySelector("[data-quick-parse-hint]");
      if (!hint || !inlineTodo) return;
      const labels = inlineTodo.value.trim() ? window.QuickParse?.parse(inlineTodo.value.replace(/\[(.+?)\]/g, "").trim()).labels || [] : [];
      hint.hidden = !labels.length;
      hint.textContent = labels.join(" · ");
    };
    inlineTodo?.addEventListener("input", updateQuickHint);
    updateQuickHint();
    inlineTodo?.addEventListener("keydown", async event => {
      if (event.key === "Enter" && !event.ctrlKey && !event.isComposing) {
        event.preventDefault();
        await addTodo(event.target.value);
      } else if (event.key === "Escape" && event.target.value) {
        event.preventDefault();
        event.stopPropagation();
        event.target.value = "";
        clearDraftControl(event.target);
        updateQuickHint();
      } else if (event.key === "ArrowUp" && !event.isComposing) {
        const rows = [...app.querySelectorAll("[data-edit-todo]")];
        if (rows.length) { event.preventDefault(); rows.at(-1).focus(); }
      }
    });
    app.querySelectorAll("[data-edit-todo]").forEach((input, index, rows) => input.addEventListener("keydown", event => {
      if (event.isComposing) return;
      // Ctrl+Enter 勾选完成；Enter 提交修改；上下方向键在列表中移动。
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        const todo = state.todos.find(item => item.id === input.dataset.editTodo);
        if (todo && input.value.trim()) todo.title = input.value.trim();
        clearDraftControl(input);
        app.querySelector(`[data-toggle-todo="${CSS.escape(input.dataset.editTodo)}"]`)?.click();
      }
      else if (event.key === "Enter") { event.preventDefault(); input.blur(); }
      else if (event.key === "ArrowDown") { event.preventDefault(); (rows[index + 1] || inlineTodo)?.focus(); }
      else if (event.key === "ArrowUp" && index > 0) { event.preventDefault(); rows[index - 1].focus(); }
    }));
    app.querySelector("[data-toggle-done]")?.addEventListener("click", () => { state.showDone = !state.showDone; render(); persistUiStatePatch({ showDone: state.showDone }); });
    app.querySelectorAll("[data-toggle-todo]").forEach(button => button.addEventListener("click", async () => {
      const todo = state.todos.find(item => item.id === button.dataset.toggleTodo);
      if (!todo) return;
      const wasCompleted = Boolean(todo.completed);
      todo.completed = !todo.completed;
      todo.updatedAt = nowIso();
      if (!wasCompleted && todo.completed) ensureNextTodoFromRepeat(todo);
      syncTodoEvents(todo);
      await persist();
      render();
    }));
    app.querySelectorAll("[data-edit-todo]").forEach(input => input.addEventListener("change", async () => {
      const todo = state.todos.find(item => item.id === input.dataset.editTodo);
      if (!todo) return;
      todo.title = input.value.trim() || todo.title;
      todo.updatedAt = nowIso();
      syncTodoEvents(todo);
      const saved = await persist(captureEditorDraft(input));
      if (!saved) return;
      clearDraftControl(input);
      render();
    }));
    app.querySelectorAll("[data-pin-todo]").forEach(button => button.addEventListener("click", async () => {
      const todo = state.todos.find(item => item.id === button.dataset.pinTodo);
      if (!todo) return;
      todo.pinned = !todo.pinned;
      await persist();
      render();
    }));
    app.querySelectorAll("[data-delete-todo]").forEach(button => button.addEventListener("click", () => softDelete("todo", button.dataset.deleteTodo)));
    app.querySelectorAll("[data-todo-id]").forEach(row => row.addEventListener("dragstart", event => {
      event.dataTransfer.setData("text/todo-id", row.dataset.todoId);
      if (state.surface === "calendar" && row.closest(".calendar-todo-edit")) {
        state.restoreCalendarTodoAfterDrop = Boolean(state.settings.reopenTodoAfterDrop);
        state.calendarTodoVisible = false;
        setTimeout(render, 0);
      }
    }));
  }

  function visibleWorkTrees() {
    return (state.workTrees || [])
      .filter(tree => !tree.archived)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  function archivedWorkTrees() {
    return (state.workTrees || [])
      .filter(tree => tree.archived)
      .sort((a, b) => String(b.archivedAt || "").localeCompare(String(a.archivedAt || "")) || (a.order || 0) - (b.order || 0));
  }

  function normalizeWorkTreeProjectOrders() {
    (state.workTrees || [])
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .forEach((tree, index) => { tree.order = index; });
  }

  function activeWorkTree() {
    const visible = visibleWorkTrees();
    if (!visible.length) return null;
    let tree = visible.find(item => item.id === state.activeWorkTreeId);
    if (!tree) {
      tree = visible[0];
      state.activeWorkTreeId = tree.id;
    }
    return tree;
  }

  function workTreeChildren(tree, parentId = "") {
    return (tree?.nodes || [])
      .filter(node => (node.parentId || "") === parentId)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  function isWorkTreeFolder(tree, node) {
    return Boolean(node?.folder) || workTreeChildren(tree, node.id).length > 0;
  }

  function workTreeLeafNodes(tree, parentId = "") {
    const children = workTreeChildren(tree, parentId);
    if (!children.length) {
      const node = parentId ? tree.nodes.find(item => item.id === parentId) : null;
      return node && !isWorkTreeFolder(tree, node) ? [node] : [];
    }
    return children.flatMap(child => workTreeLeafNodes(tree, child.id));
  }

  function workTreeNodeStats(tree, node) {
    const leaves = workTreeLeafNodes(tree, node.id);
    const done = leaves.filter(item => item.completed).length;
    return { done, open: leaves.length - done, total: leaves.length };
  }

  function hasVisibleWorkTreeNode(tree, node) {
    const stats = workTreeNodeStats(tree, node);
    const completed = isWorkTreeFolder(tree, node) ? stats.total > 0 && stats.open === 0 : node.completed;
    if (!state.hideCompletedWorkTreeNodes || !completed) return true;
    return workTreeChildren(tree, node.id).some(child => hasVisibleWorkTreeNode(tree, child));
  }

  function workTreeProgress(tree) {
    const nodes = workTreeChildren(tree).flatMap(node => workTreeLeafNodes(tree, node.id));
    const done = nodes.filter(node => node.completed).length;
    return { done, total: nodes.length };
  }

  function renderWorkTreeProjectTab(item, activeId) {
    const label = item.tabTitle || item.title;
    const active = activeId === item.id ? "active" : "";
    if (state.editingWorkTreeTabTitleId === item.id) {
      return `<input class="worktree-project-tab worktree-project-tab-input ${active}" data-work-tree-tab-title="${item.id}" value="${esc(label)}" />`;
    }
    return `<button data-work-tree-select="${item.id}" data-work-tree-tab-rename="${item.id}" data-work-tree-tab-drag="${item.id}" class="worktree-project-tab ${active}" title="左键拖动排序，右键/双击重命名">${esc(label)}</button>`;
  }

  function workTreeMindmapScrollKey(treeId) {
    return `worktreeMindmap:${treeId || "none"}`;
  }

  function clampWorkTreeZoom(value) {
    const zoom = Number(value);
    return clamp(Number.isFinite(zoom) ? zoom : 1, WORK_TREE_ZOOM_MIN, WORK_TREE_ZOOM_MAX);
  }

  function ensureWorkTreeMindmapViewport(treeId) {
    const key = workTreeMindmapScrollKey(treeId);
    const scrollState = { ...(state.scrollState || {}) };
    if (!scrollState[key]) {
      const legacy = scrollState.worktreeMindmap;
      if (Number.isFinite(legacy)) {
        scrollState[key] = { top: legacy, zoom: 1 };
        scrollState.worktreeMindmap = { migratedTo: treeId };
      } else if (legacy && typeof legacy === "object" && !legacy.migratedTo) {
        scrollState[key] = { ...legacy, zoom: clampWorkTreeZoom(legacy.zoom) };
        scrollState.worktreeMindmap = { migratedTo: treeId };
      }
    }
    state.scrollState = scrollState;
    const saved = scrollState[key];
    return saved && typeof saved === "object" ? saved : {};
  }

  function workTreeZoomFor(treeId) {
    return clampWorkTreeZoom(ensureWorkTreeMindmapViewport(treeId).zoom);
  }

  function resetWorkTreeMindmapScroll(treeId = state.activeWorkTreeId) {
    if (!treeId) return;
    const key = workTreeMindmapScrollKey(treeId);
    const zoom = workTreeZoomFor(treeId);
    state.scrollState = { ...(state.scrollState || {}), [key]: { zoom } };
  }

  function renderWorkTreeZoomControls(tree) {
    const zoom = workTreeZoomFor(tree.id);
    const percent = Math.round(zoom * 100);
    return `
      <div class="worktree-zoom-controls" data-work-tree-zoom-controls>
        <button data-work-tree-zoom-out title="缩小（Ctrl+-）" ${zoom <= WORK_TREE_ZOOM_MIN ? "disabled" : ""}>－</button>
        <button class="worktree-zoom-value" data-work-tree-zoom-reset title="恢复 100%（Ctrl+0）">${percent}%</button>
        <button data-work-tree-zoom-in title="放大（Ctrl++）" ${zoom >= WORK_TREE_ZOOM_MAX ? "disabled" : ""}>＋</button>
        <button class="worktree-zoom-fit" data-work-tree-zoom-fit title="适应当前窗口">适应</button>
      </div>
    `;
  }

  function renderWorkTree() {
    const tree = activeWorkTree();
    const projects = visibleWorkTrees();
    const folderDouble = Number(state.workTreeFolderColumns) === 2;
    const mapDouble = state.workTreeMapMode === "double";
    const mindmap = state.workTreeView === "mindmap";
    const nextWorkTreeView = state.workTreeView === "mindmap" ? "tree" : "mindmap";
    const workTreeViewIcon = state.workTreeView === "mindmap" ? "tree" : "folder";
    const modeButton = state.workTreeView === "tree"
      ? `<button class="worktree-title-icon-btn worktree-folder-columns-btn ${folderDouble ? "active" : ""}" data-toggle-work-tree-folder-columns title="${folderDouble ? "单列显示" : "双列显示"}"><span class="todo-columns-icon ${folderDouble ? "double" : "single"}" aria-hidden="true"></span></button>`
      : `<button class="worktree-title-icon-btn worktree-map-mode-btn ${mapDouble ? "active" : ""}" data-toggle-work-tree-map-mode title="${mapDouble ? "单侧显示" : "双侧显示"}"><span class="todo-columns-icon ${mapDouble ? "double" : "single"}" aria-hidden="true"></span></button>`;
    return `
      <div class="worktree-panel">
        <div class="worktree-head">
          <div class="worktree-projects folder-tabs">${projects.map(item => renderWorkTreeProjectTab(item, tree?.id)).join("")}<button class="worktree-project-new" data-work-tree-new title="新建项目"><span class="app-plus-icon" aria-hidden="true"></span></button></div>
        </div>
        ${tree ? `
          <div class="worktree-title-row worktree-actions-row ${mindmap ? "has-mindmap-zoom" : ""}">
            ${state.editingWorkTreeTitleId === tree.id ? `<input class="worktree-project-title-input" data-work-tree-title="${tree.id}" value="${esc(tree.title)}" />` : `<button class="worktree-current-title" data-work-tree-rename="${tree.id}" title="右键/双击重命名">${esc(tree.title)}</button>`}
            ${mindmap ? renderWorkTreeZoomControls(tree) : ""}
            <button class="worktree-add-root-icon worktree-icon-btn" data-work-tree-add-root title="新建子任务"><span class="worktree-action-glyph add app-plus-icon" aria-hidden="true"></span></button>
            ${renderWorkTreeUndoButton()}
            <button class="worktree-title-icon-btn worktree-view-toggle-btn ${state.workTreeView === "mindmap" ? "active" : ""}" data-work-tree-view="${nextWorkTreeView}" title="${state.workTreeView === "mindmap" ? "切换到文件夹" : "切换到树状图"}"><span class="worktree-view-glyph ${workTreeViewIcon}" aria-hidden="true"></span></button>
            ${modeButton}
            <button class="worktree-title-filter-btn ${state.hideCompletedWorkTreeNodes ? "active" : ""}" data-work-tree-hide-done>未完成</button>
            ${renderWorkTreeProjectMenu(tree)}
          </div>
          ${state.workTreeView === "mindmap" ? renderWorkTreeMindmap(tree) : renderWorkTreeFolder(tree)}
        ` : renderWorkTreeEmpty()}
      </div>
    `;
  }

  function workTreeTrashEntries() {
    return (state.trash || []).filter(entry => entry.type === "workTreeNode");
  }

  function renderWorkTreeUndoButton() {
    const undoCount = state.workTreeUndoStack?.length || 0;
    const canUndo = undoCount > 0;
    return `<button class="worktree-undo-btn ${canUndo ? "" : "empty"}" data-work-tree-undo title="${canUndo ? `撤回上一步（还可撤回 ${undoCount} 步）` : "暂无可撤回操作"}" ${canUndo ? "" : "disabled"}><span aria-hidden="true"></span></button>`;
  }

  function renderWorkTreeProjectMenu(tree) {
    const archived = archivedWorkTrees();
    const archivedList = archived.length ? `
      <div class="worktree-archive-list">
        <b>已归档</b>
        ${archived.map(item => `<button data-work-tree-restore-archive="${item.id}" title="恢复项目">${esc(item.tabTitle || item.title)}</button>`).join("")}
      </div>
    ` : "";
    return `
      <details class="worktree-project-menu" data-work-tree-project-menu>
        <summary title="项目菜单">···</summary>
        <div>
          ${state.workTreeView === "mindmap" ? `<button data-export-work-tree-mindmap="${tree.id}">导出高清 PNG</button>` : ""}
          <button data-work-tree-duplicate="${tree.id}">复制项目</button>
          <button data-work-tree-archive="${tree.id}">归档项目</button>
          <button class="danger" data-work-tree-delete="${tree.id}">删除项目</button>
          ${archivedList}
        </div>
      </details>
    `;
  }

  function renderWorkTreeNodeTrashPanel() {
    const items = workTreeTrashEntries();
    return `
      <section class="worktree-trash-panel" data-work-tree-trash-panel>
        <div class="worktree-trash-head">
          <b>回收站</b>
          <button data-work-tree-trash-clear ${items.length ? "" : "disabled"}>清空</button>
          <button data-work-tree-trash-close aria-label="关闭项目回收站"><span data-ui-icon="x" aria-hidden="true"></span></button>
        </div>
        <div class="worktree-trash-list">
          ${items.length ? items.map(entry => {
            const nodes = Array.isArray(entry.item?.nodes) ? entry.item.nodes : [];
            return `<div class="worktree-trash-row">
              <div class="worktree-trash-info">
                <span>树杈</span>
                <b>${esc(entry.title || "未命名")}</b>
                <em>${esc(entry.item?.treeTitle || "工作树")} · ${nodes.length} 项</em>
              </div>
              <div class="worktree-trash-actions">
                <button class="worktree-trash-icon restore" data-work-tree-trash-restore="${entry.id}" title="恢复" aria-label="恢复"><span data-ui-icon="restore" aria-hidden="true"></span></button>
                <button class="worktree-trash-icon delete" data-work-tree-trash-delete="${entry.id}" title="彻底删除" aria-label="彻底删除"><span data-ui-icon="trash" aria-hidden="true"></span></button>
              </div>
            </div>`;
          }).join("") : `<div class="empty-row">回收站为空</div>`}
        </div>
      </section>
    `;
  }

  function renderWorkTreeContextMenu() {
    const menu = state.workTreeContextMenu;
    const tree = activeWorkTree();
    const node = tree?.nodes.find(item => item.id === menu?.nodeId);
    if (!menu || !node) return "";
    const folder = isWorkTreeFolder(tree, node);
    const style = `left:${Math.max(8, menu.x)}px;top:${Math.max(8, menu.y)}px`;
    const toggleItem = folder ? `<button role="menuitem" data-work-node-menu-action="toggle" data-work-node-menu-id="${node.id}">${node.collapsed ? "展开" : "收缩"}</button>` : "";
    if (menu.kind === "task") return `<div class="worktree-node-menu" style="${style}" data-work-node-menu role="menu" aria-label="项目任务操作">${[["today", "普通待办"], ["goal", "目标"], ["flow", "流动"]].map(([action, label]) => `<button role="menuitem" data-work-node-menu-action="${action}" data-work-node-menu-id="${node.id}">${label}</button>`).join("")}</div>`;
    return `
      <div class="worktree-node-menu" style="${style}" data-work-node-menu role="menu" aria-label="项目任务操作">
        <button role="menuitem" data-work-node-menu-action="add" data-work-node-menu-id="${node.id}">新建子任务</button>
        <button role="menuitem" data-work-node-menu-action="today" data-work-node-menu-id="${node.id}">加入今日待办</button>
        ${toggleItem}
        <button role="menuitem" data-work-node-menu-action="rename" data-work-node-menu-id="${node.id}">重命名</button>
        <button class="danger" data-work-node-menu-action="delete" data-work-node-menu-id="${node.id}">删除</button>
      </div>
    `;
  }

  function renderWorkTreeEmpty() {
    const archived = archivedWorkTrees();
    return `
      <div class="worktree-empty">
        <b>还没有当前项目</b>
        <button data-work-tree-new>新建项目</button>
        ${archived.length ? `<div class="worktree-archive-empty"><span>已归档</span>${archived.map(item => `<button data-work-tree-restore-archive="${item.id}">${esc(item.tabTitle || item.title)}</button>`).join("")}</div>` : ""}
      </div>
    `;
  }

  function renderWorkTreeFolder(tree) {
    const columns = Number(state.workTreeFolderColumns) === 2 ? 2 : 1;
    const roots = workTreeChildren(tree).filter(node => hasVisibleWorkTreeNode(tree, node));
    if (!roots.length) return `<div class="worktree-folder columns-${columns}" data-scroll-key="worktreeFolder" data-work-tree-drop-zone><div class="empty-row">暂无子任务</div></div>`;
    if (columns === 2) {
      const splitAt = Math.ceil(roots.length / 2);
      const leftColumn = roots.slice(0, splitAt).map(node => `<div class="worktree-branch-block">${renderWorkTreeNodeRow(tree, node, 0)}</div>`).join("");
      const rightColumn = roots.slice(splitAt).map(node => `<div class="worktree-branch-block">${renderWorkTreeNodeRow(tree, node, 0)}</div>`).join("");
      return `<div class="worktree-folder columns-2" data-scroll-key="worktreeFolder" data-work-tree-drop-zone><div class="worktree-folder-column">${leftColumn}</div><div class="worktree-folder-column">${rightColumn}</div></div>`;
    }
    const rows = roots.map(node => `<div class="worktree-branch-block">${renderWorkTreeNodeRow(tree, node, 0)}</div>`).join("");
    return `<div class="worktree-folder columns-1" data-scroll-key="worktreeFolder" data-work-tree-drop-zone>${rows}</div>`;
  }

  function renderWorkTreeCollapseControl(node, children) {
    if (!children.length) return "";
    return `<button class="worktree-chevron ${node.collapsed ? "collapsed" : ""}" data-work-node-collapse="${node.id}" title="展开/收起" aria-expanded="${!node.collapsed}" data-ui-morph="tree" data-ui-morph-key="tree:${esc(activeWorkTree().id)}:${esc(node.id)}" data-ui-expanded="${!node.collapsed}"></button>`;
  }

  function renderWorkTreeNodeRow(tree, node, depth) {
    const realChildren = workTreeChildren(tree, node.id);
    const children = realChildren.filter(child => hasVisibleWorkTreeNode(tree, child));
    const folder = isWorkTreeFolder(tree, node);
    const stats = workTreeNodeStats(tree, node);
    const linkedTodo = state.todos.find(todo => todo.id === node.todoId);
    const hasTodayEvent = linkedTodo && state.events.some(event => event.todoId === linkedTodo.id && event.date === toDateKey(new Date()) && !event.completed);
    const isToday = linkedTodo && linkedTodo.targetDate === toDateKey(new Date()) && !linkedTodo.completed;
    const completed = folder ? stats.total > 0 && stats.open === 0 : node.completed;
    const collapseControl = renderWorkTreeCollapseControl(node, realChildren);
    const titleTip = folder ? "单击展开/收缩，右键/双击重命名" : "右键/双击重命名";
    const titleControl = state.editingWorkNodeTitleId === node.id
      ? `<input class="worktree-node-title" data-work-node-title="${node.id}" value="${esc(node.title)}" />`
      : `<button class="worktree-node-title worktree-node-title-button" data-work-node-rename="${node.id}" data-work-node-can-collapse="${folder ? "true" : "false"}" title="${titleTip}">${esc(node.title)}</button>`;
    const addButton = `<button class="row-icon worktree-icon-btn" data-work-node-add="${node.id}" data-work-node-drag="${node.id}" data-work-node-command="${node.id}" title="添加子任务 / 左键拖拽 / 右键菜单"><span class="worktree-action-glyph add app-plus-icon" aria-hidden="true"></span></button>`;
    return `
      <div class="worktree-row ${completed ? "completed" : ""} ${folder ? "folder" : "leaf"}" style="--depth:${depth}" data-work-node-row="${node.id}" data-work-node-folder="${folder ? "true" : "false"}" data-work-node-child="${depth > 0 ? "true" : "false"}">
        ${folder ? `
          ${collapseControl}
          <span class="worktree-folder-mark" title="任务夹"></span>
          ${titleControl}
          ${addButton}
          <span class="worktree-node-meta" data-work-node-drag="${node.id}" data-work-node-command="${node.id}" title="左键拖拽 / 右键菜单">${stats.open}/${stats.total}</span>
        ` : `
          <button class="checkbox worktree-check ${node.completed ? "checked" : ""}" data-work-node-toggle="${node.id}" title="完成"></button>
          ${titleControl}
          ${addButton}
          <span class="worktree-node-meta">${hasTodayEvent ? "今日" : linkedTodo ? "待办" : ""}</span>
          <button class="row-icon worktree-icon-btn ${isToday ? "active" : ""}" data-work-node-todo="${node.id}" data-work-node-drag="${node.id}" data-work-node-command="${node.id}" aria-label="转为待办、目标或流动任务" aria-haspopup="menu" aria-expanded="${Boolean(state.workTreeContextMenu?.kind === "task" && state.workTreeContextMenu?.nodeId === node.id)}" title="选择普通待办、目标或流动 / 拖拽 / 右键菜单"><span class="worktree-action-glyph today" aria-hidden="true"></span></button>
        `}
      </div>
      ${children.length && !node.collapsed ? children.map(child => renderWorkTreeNodeRow(tree, child, depth + 1)).join("") : ""}
    `;
  }

  function buildWorkTreeMindmapLayout(tree) {
    const roots = workTreeChildren(tree).filter(node => hasVisibleWorkTreeNode(tree, node));
    const double = state.workTreeMapMode === "double";
    const leftRoots = double ? roots.filter((_, index) => index % 2 === 1) : [];
    const rightRoots = double ? roots.filter((_, index) => index % 2 === 0) : roots;
    const titleWidth = title => {
      const length = Array.from(String(title || "")).length;
      return Math.max(260, Math.min(420, 180 + Math.min(length, 26) * 10));
    };
    const rootBox = { w: 54, h: 26 };
    const nodeBox = { w: 260, h: 44 };
    const gap = { x: 60, y: 8 };
    const pad = 34;

    if (double) {
      const collectSide = (nodes, side) => {
        const entries = [];
        const visit = (node, depth, parent = null) => {
          const entry = { node, side, depth, parent, children: [], slots: 1, x: 0, y: 0, w: nodeBox.w, h: nodeBox.h, centerY: 0 };
          entries.push(entry);
          if (!node.collapsed) {
            const children = workTreeChildren(tree, node.id).filter(child => hasVisibleWorkTreeNode(tree, child));
            entry.children = children.map(child => visit(child, depth + 1, entry));
          }
          return entry;
        };
        nodes.forEach(node => visit(node, 0));
        return entries;
      };
      const leftEntries = collectSide(leftRoots, "left");
      const rightEntries = collectSide(rightRoots, "right");
      const sideWidth = entries => Math.max(nodeBox.w, ...entries.map(entry => Math.min(420, titleWidth(entry.node.title) + Math.min(entry.depth, 3) * 12)));
      const sideHeight = entries => entries.length ? entries.length * nodeBox.h + (entries.length - 1) * gap.y : 0;
      const leftWidth = sideWidth(leftEntries);
      const rightWidth = sideWidth(rightEntries);
      const leftHeight = sideHeight(leftEntries);
      const rightHeight = sideHeight(rightEntries);
      const contentHeight = Math.max(rootBox.h, leftHeight, rightHeight);
      const width = pad * 2 + leftWidth + rightWidth + rootBox.w + gap.x * 2;
      const height = pad * 2 + contentHeight;
      const root = { x: pad + leftWidth + gap.x, y: pad + contentHeight / 2 - rootBox.h / 2, w: rootBox.w, h: rootBox.h, centerY: pad + contentHeight / 2 };
      const assign = (entries, side, columnWidth, startY) => {
        let cursorY = startY;
        entries.forEach(entry => {
          entry.w = columnWidth;
          entry.h = nodeBox.h;
          entry.x = side === "left" ? root.x - gap.x - columnWidth : root.x + root.w + gap.x;
          entry.y = cursorY;
          entry.centerY = cursorY + nodeBox.h / 2;
          cursorY += nodeBox.h + gap.y;
        });
      };
      assign(leftEntries, "left", leftWidth, pad + (contentHeight - leftHeight) / 2);
      assign(rightEntries, "right", rightWidth, pad + (contentHeight - rightHeight) / 2);
      const entries = [...leftEntries, ...rightEntries];
      const links = entries
        .filter(entry => entry.depth === 0)
        .map(entry => ({ from: root, to: entry, side: entry.side, depth: 0 }));
      return { width, height, root, entries, links };
    }

    const visualDepth = depth => double ? Math.min(depth, 1) : depth;
    const buildEntry = (node, side, depth, parent = null) => {
      const entry = { node, side, depth, parent, children: [], slots: 1, x: 0, y: 0, w: nodeBox.w, h: nodeBox.h, centerY: 0 };
      const children = node.collapsed ? [] : workTreeChildren(tree, node.id).filter(child => hasVisibleWorkTreeNode(tree, child));
      entry.children = children.map(child => buildEntry(child, side, depth + 1, entry));
      entry.slots = entry.children.length ? entry.children.reduce((sum, child) => sum + child.slots, 0) : 1;
      return entry;
    };
    const left = leftRoots.map(node => buildEntry(node, "left", 0));
    const right = rightRoots.map(node => buildEntry(node, "right", 0));
    const maxDepth = entries => entries.reduce((max, entry) => Math.max(max, visualDepth(entry.depth), maxDepth(entry.children)), -1);
    const flattenEntries = entries => entries.flatMap(entry => [entry, ...flattenEntries(entry.children)]);
    const columnWidths = entries => {
      const widths = Array.from({ length: maxDepth(entries) + 1 }, () => nodeBox.w);
      flattenEntries(entries).forEach(entry => {
        const column = visualDepth(entry.depth);
        widths[column] = Math.max(widths[column] || nodeBox.w, titleWidth(entry.node.title));
      });
      return widths;
    };
    const leftWidths = columnWidths(left);
    const rightWidths = columnWidths(right);
    const sideSpan = widths => widths.length ? widths.reduce((sum, width) => sum + width, 0) + gap.x * widths.length : 0;
    const slotCount = entries => entries.reduce((sum, entry) => sum + entry.slots, 0);
    const sideHeight = entries => {
      const slots = slotCount(entries);
      return slots ? slots * nodeBox.h + (slots - 1) * gap.y : 0;
    };
    const leftSpan = sideSpan(leftWidths);
    const rightSpan = sideSpan(rightWidths);
    const contentHeight = Math.max(rootBox.h, sideHeight(left), sideHeight(right));
    const width = pad * 2 + leftSpan + rootBox.w + rightSpan;
    const height = pad * 2 + contentHeight;
    const root = { x: pad + leftSpan, y: pad + contentHeight / 2 - rootBox.h / 2, w: rootBox.w, h: rootBox.h, centerY: pad + contentHeight / 2 };
    const entries = [];
    const links = [];
    const assignSide = (sideEntries, side, startY) => {
      let cursorY = startY;
      const assign = entry => {
        if (entry.children.length) {
          entry.children.forEach(assign);
          entry.centerY = (entry.children[0].centerY + entry.children[entry.children.length - 1].centerY) / 2;
        } else {
          entry.centerY = cursorY + nodeBox.h / 2;
          cursorY += nodeBox.h + gap.y;
        }
        const column = visualDepth(entry.depth);
        const widths = side === "left" ? leftWidths : rightWidths;
        const previous = widths.slice(0, column).reduce((sum, width) => sum + width, 0);
        entry.w = widths[column] || nodeBox.w;
        entry.x = side === "left"
          ? root.x - gap.x * (column + 1) - previous - entry.w
          : root.x + root.w + gap.x * (column + 1) + previous;
        entry.y = entry.centerY - nodeBox.h / 2;
      };
      const collect = entry => {
        entries.push(entry);
        links.push({ from: entry.parent || root, to: entry, side, depth: entry.depth });
        entry.children.forEach(collect);
      };
      sideEntries.forEach(assign);
      sideEntries.forEach(collect);
    };
    assignSide(left, "left", pad + (contentHeight - sideHeight(left)) / 2);
    assignSide(right, "right", pad + (contentHeight - sideHeight(right)) / 2);
    return { width, height, root, entries, links };
  }

  function renderMindLinks(layout) {
    const point = (box, side, source) => {
      if (source && box === layout.root) return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      const x = side === "left" ? (source ? box.x : box.x + box.w) : (source ? box.x + box.w : box.x);
      return { x, y: box.y + box.h / 2 };
    };
    const pathFor = (from, to, side) => {
      const distance = Math.abs(to.x - from.x);
      const curve = Math.max(54, Math.min(170, distance * .58));
      const c1x = side === "left" ? from.x - curve : from.x + curve;
      const c2x = side === "left" ? to.x + curve : to.x - curve;
      return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} C ${c1x.toFixed(1)} ${from.y.toFixed(1)}, ${c2x.toFixed(1)} ${to.y.toFixed(1)}, ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
    };
    return layout.links.map(link => {
      const sameColumn = link.from !== layout.root && Math.abs(link.from.x - link.to.x) < 4;
      const from = point(link.from, link.side, true);
      const to = point(link.to, link.side, sameColumn);
      return `<path class="mind-link depth-${Math.min(link.depth, 3)} ${link.side}" d="${pathFor(from, to, link.side)}"></path>`;
    }).join("");
  }

  function renderWorkTreeMindmap(tree) {
    const double = state.workTreeMapMode === "double";
    const layout = buildWorkTreeMindmapLayout(tree);
    const zoom = workTreeZoomFor(tree.id);
    const canvasWidth = Math.ceil(layout.width * zoom);
    const canvasHeight = Math.ceil(layout.height * zoom);
    return `
      <div class="worktree-map ${double ? "double" : "single"}" data-scroll-key="${workTreeMindmapScrollKey(tree.id)}" data-root-x="${layout.root.x}" data-root-y="${layout.root.y}" data-root-w="${layout.root.w}" data-root-h="${layout.root.h}" data-mind-zoom="${zoom}" data-work-tree-id="${tree.id}" data-worktree-map data-work-tree-drop-zone>
        <div class="mind-canvas" data-mind-canvas data-mind-width="${layout.width}" data-mind-height="${layout.height}" data-mind-zoom="${zoom}" style="width:${canvasWidth}px;height:${canvasHeight}px">
          <div class="mind-stage" data-mind-stage style="width:${layout.width}px;height:${layout.height}px;--worktree-zoom:${zoom}">
            <svg class="mind-links" data-mind-links viewBox="0 0 ${layout.width} ${layout.height}" aria-hidden="true">${renderMindLinks(layout)}</svg>
            ${layout.entries.map(entry => renderMindNode(tree, entry)).join("")}
          </div>
        </div>
      </div>
    `;
  }

  function drawWorkTreeExportRoundRect(context, x, y, width, height, radius, fill, stroke = "") {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
    if (fill) {
      context.fillStyle = fill;
      context.fill();
    }
    if (stroke) {
      context.strokeStyle = stroke;
      context.stroke();
    }
  }

  function fitWorkTreeExportText(context, value, maxWidth) {
    const text = String(value || "未命名任务");
    if (context.measureText(text).width <= maxWidth) return text;
    let shortened = text;
    while (shortened.length > 1 && context.measureText(`${shortened}…`).width > maxWidth) shortened = shortened.slice(0, -1);
    return `${shortened}…`;
  }

  async function exportWorkTreeMindmapPng(treeId) {
    const tree = state.workTrees.find(item => item.id === treeId);
    if (!tree || !window.dayline?.exportWorkTreeMindmapPng) return null;
    const layout = buildWorkTreeMindmapLayout(tree);
    const margin = 42;
    const titleHeight = 64;
    const logicalWidth = Math.ceil(layout.width + margin * 2);
    const logicalHeight = Math.ceil(layout.height + margin + titleHeight);
    const maxSide = 16384;
    const maxPixels = 64 * 1024 * 1024;
    const scale = Math.min(3, maxSide / Math.max(logicalWidth, logicalHeight), Math.sqrt(maxPixels / (logicalWidth * logicalHeight)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(logicalWidth * scale));
    canvas.height = Math.max(1, Math.floor(logicalHeight * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法创建树状图导出画布");
    const rootStyles = getComputedStyle(document.documentElement);
    const accent = rootStyles.getPropertyValue("--accent").trim() || "#e7c944";
    const text = rootStyles.getPropertyValue("--text").trim() || "#f3f4f5";
    const muted = rootStyles.getPropertyValue("--muted").trim() || "#aab0b4";
    const fontFamily = '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
    const point = (box, side, source) => {
      if (source && box === layout.root) return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      return { x: side === "left" ? (source ? box.x : box.x + box.w) : (source ? box.x + box.w : box.x), y: box.y + box.h / 2 };
    };

    try {
      context.scale(scale, scale);
      context.fillStyle = "#202729";
      context.fillRect(0, 0, logicalWidth, logicalHeight);
      context.fillStyle = "rgba(255,255,255,.04)";
      context.fillRect(0, 0, logicalWidth, titleHeight);
      context.fillStyle = accent;
      context.font = `800 15px ${fontFamily}`;
      context.fillText("项目树状图", margin, 26);
      context.fillStyle = text;
      context.font = `800 20px ${fontFamily}`;
      context.fillText(fitWorkTreeExportText(context, tree.title, logicalWidth - margin * 2), margin, 52);
      context.translate(margin, titleHeight);

      layout.links.forEach(link => {
        const sameColumn = link.from !== layout.root && Math.abs(link.from.x - link.to.x) < 4;
        const from = point(link.from, link.side, true);
        const to = point(link.to, link.side, sameColumn);
        const distance = Math.abs(to.x - from.x);
        const curve = Math.max(54, Math.min(170, distance * .58));
        const c1x = link.side === "left" ? from.x - curve : from.x + curve;
        const c2x = link.side === "left" ? to.x + curve : to.x - curve;
        context.save();
        context.strokeStyle = accent;
        context.globalAlpha = link.depth === 0 ? .78 : link.depth === 1 ? .62 : .46;
        context.lineWidth = link.depth === 0 ? 3 : link.depth === 1 ? 2.35 : 1.8;
        context.lineCap = "round";
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.bezierCurveTo(c1x, from.y, c2x, to.y, to.x, to.y);
        context.stroke();
        context.restore();
      });

      drawWorkTreeExportRoundRect(context, layout.root.x, layout.root.y, layout.root.w, layout.root.h, 7, "rgba(231,201,68,.18)", accent);
      context.fillStyle = accent;
      context.font = `800 13px ${fontFamily}`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("项", layout.root.x + layout.root.w / 2, layout.root.y + layout.root.h / 2 + .5);
      context.textAlign = "left";
      context.textBaseline = "alphabetic";

      layout.entries.forEach(entry => {
        const node = entry.node;
        const folder = isWorkTreeFolder(tree, node);
        const stats = folder ? workTreeNodeStats(tree, node) : null;
        const completed = folder ? stats.total > 0 && stats.open === 0 : node.completed;
        context.save();
        context.globalAlpha = completed ? .56 : 1;
        context.lineWidth = 1;
        drawWorkTreeExportRoundRect(context, entry.x, entry.y, entry.w, entry.h, 8, folder ? "rgba(231,201,68,.10)" : "rgba(255,255,255,.075)", folder ? "rgba(231,201,68,.40)" : "rgba(255,255,255,.14)");
        const iconX = entry.x + 12;
        const iconY = entry.y + 15;
        if (folder) {
          context.strokeStyle = accent;
          context.lineWidth = 1.7;
          context.strokeRect(iconX, iconY + 3, 18, 12);
          context.fillStyle = accent;
          context.fillRect(iconX + 2, iconY, 9, 4);
        } else {
          context.strokeStyle = node.completed ? accent : muted;
          context.lineWidth = 2;
          drawWorkTreeExportRoundRect(context, iconX, iconY, 18, 18, 5, "rgba(255,255,255,.02)", context.strokeStyle);
          if (node.completed) {
            context.beginPath();
            context.moveTo(iconX + 4, iconY + 9);
            context.lineTo(iconX + 8, iconY + 13);
            context.lineTo(iconX + 15, iconY + 5);
            context.stroke();
          }
        }
        const meta = folder ? `${stats.open}/${stats.total}` : "";
        context.font = `${folder ? 800 : 600} ${folder ? 16 : 15}px ${fontFamily}`;
        const metaFont = `800 13px ${fontFamily}`;
        context.font = meta ? metaFont : context.font;
        const metaWidth = meta ? context.measureText(meta).width : 0;
        context.font = `${folder ? 800 : 600} ${folder ? 16 : 15}px ${fontFamily}`;
        context.fillStyle = folder ? accent : text;
        context.fillText(fitWorkTreeExportText(context, node.title, entry.w - 54 - metaWidth), entry.x + 42, entry.y + 28);
        if (meta) {
          context.font = metaFont;
          context.fillStyle = accent;
          context.textAlign = "right";
          context.fillText(meta, entry.x + entry.w - 10, entry.y + 28);
          context.textAlign = "left";
        }
        context.restore();
      });

      const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("树状图 PNG 生成失败")), "image/png"));
      const bytes = await blob.arrayBuffer();
      return await window.dayline.exportWorkTreeMindmapPng({ title: `${tree.title} 树状图`, bytes, width: canvas.width, height: canvas.height });
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
  }

  function renderMindNode(tree, entry) {
    const node = entry.node;
    const realChildren = workTreeChildren(tree, node.id);
    const children = realChildren.filter(child => hasVisibleWorkTreeNode(tree, child));
    const folder = isWorkTreeFolder(tree, node);
    const stats = workTreeNodeStats(tree, node);
    const linkedTodo = state.todos.find(todo => todo.id === node.todoId);
    const isToday = linkedTodo && linkedTodo.targetDate === toDateKey(new Date()) && !linkedTodo.completed;
    const completed = folder ? stats.total > 0 && stats.open === 0 : node.completed;
    const collapseControl = state.workTreeMapMode === "single" ? "" : renderWorkTreeCollapseControl(node, realChildren);
    const titleTip = folder ? "单击展开/收缩，右键/双击重命名" : "右键/双击重命名";
    const titleControl = state.editingWorkNodeTitleId === node.id
      ? `<input data-work-node-title="${node.id}" value="${esc(node.title)}" />`
      : `<button class="mind-title worktree-node-title-button" data-work-node-rename="${node.id}" data-work-node-can-collapse="${folder ? "true" : "false"}" title="${titleTip}">${esc(node.title)}</button>`;
    const addButton = `<button class="worktree-icon-btn" data-work-node-add="${node.id}" data-work-node-drag="${node.id}" data-work-node-command="${node.id}" title="添加子任务 / 左键拖拽 / 右键菜单"><span class="worktree-action-glyph add app-plus-icon" aria-hidden="true"></span></button>`;
    return `
      <div class="mind-node-wrap ${entry.side}" style="left:${entry.x}px;top:${entry.y}px;width:${entry.w}px;height:${entry.h}px;--mind-depth:${entry.depth || 0}" data-mind-branch="${node.id}" data-mind-side="${entry.side}" data-work-node-row="${node.id}" data-work-node-folder="${folder ? "true" : "false"}">
        <div class="mind-node ${completed ? "completed" : ""} ${folder ? "folder" : "leaf"}" data-mind-node="${node.id}">
          ${folder ? `
            ${collapseControl}
            <span class="worktree-folder-mark" title="任务夹"></span>
            ${titleControl}
            ${addButton}
            <em data-work-node-drag="${node.id}" data-work-node-command="${node.id}" title="左键拖拽 / 右键菜单">${stats.open}/${stats.total}</em>
          ` : `
            <button class="checkbox worktree-check ${node.completed ? "checked" : ""}" data-work-node-toggle="${node.id}" title="完成"></button>
            ${titleControl}
            ${addButton}
            <button class="worktree-icon-btn ${isToday ? "active" : ""}" data-work-node-todo="${node.id}" data-work-node-drag="${node.id}" data-work-node-command="${node.id}" aria-label="转为待办、目标或流动任务" aria-haspopup="menu" aria-expanded="${Boolean(state.workTreeContextMenu?.kind === "task" && state.workTreeContextMenu?.nodeId === node.id)}" title="选择普通待办、目标或流动 / 拖拽 / 右键菜单"><span class="worktree-action-glyph today" aria-hidden="true"></span></button>
          `}
        </div>
      </div>
    `;
  }

  async function createWorkTree() {
    const title = `新项目 ${state.workTrees.length + 1}`;
    const previousActiveWorkTreeId = state.activeWorkTreeId;
    normalizeWorkTreeProjectOrders();
    const tree = { id: uid("tree"), title, tabTitle: title, archived: false, archivedAt: "", collapsed: false, order: state.workTrees.length, nodes: [], createdAt: nowIso(), updatedAt: nowIso() };
    state.workTrees.push(tree);
    state.activeWorkTreeId = tree.id;
    state.editingWorkTreeTitleId = tree.id;
    setLastWorkTreeUndo({ type: "createProject", treeId: tree.id, previousActiveWorkTreeId });
    await persist();
    render();
    setTimeout(() => {
      const input = app.querySelector(`[data-work-tree-title="${tree.id}"]`);
      selectInputText(input);
    }, 0);
  }

  async function duplicateWorkTreeProject(treeId) {
    const source = state.workTrees.find(tree => tree.id === treeId);
    if (!source) return;
    const previousActiveWorkTreeId = state.activeWorkTreeId;
    const createdAt = nowIso();
    const nodeIds = new Map((source.nodes || []).map(node => [node.id, uid("node")]));
    normalizeWorkTreeProjectOrders();
    const sourceOrder = Number(source.order || 0);
    state.workTrees.forEach(tree => {
      if (tree.id !== source.id && Number(tree.order || 0) > sourceOrder) tree.order += 1;
    });
    const title = nextCopyName(source.title, state.workTrees.map(tree => tree.title));
    const tabTitle = source.tabTitle && source.tabTitle !== source.title
      ? nextCopyName(source.tabTitle, state.workTrees.map(tree => tree.tabTitle || tree.title))
      : title;
    const copy = {
      ...clone(source),
      id: uid("tree"),
      title,
      tabTitle,
      archived: false,
      archivedAt: "",
      collapsed: false,
      order: sourceOrder + 1,
      createdAt,
      updatedAt: createdAt,
      nodes: (source.nodes || []).map(node => ({
        ...clone(node),
        id: nodeIds.get(node.id),
        parentId: node.parentId ? (nodeIds.get(node.parentId) || "") : "",
        todoId: "",
        createdAt,
        updatedAt: createdAt
      }))
    };
    state.workTrees.push(copy);
    normalizeWorkTreeProjectOrders();
    state.activeWorkTreeId = copy.id;
    state.editingWorkTreeTitleId = "";
    state.editingWorkTreeTabTitleId = "";
    state.editingWorkNodeTitleId = "";
    const scrollState = { ...(state.scrollState || {}) };
    delete scrollState.worktreeMindmap;
    delete scrollState.worktreeFolder;
    state.scrollState = scrollState;
    setLastWorkTreeUndo({ type: "createProject", treeId: copy.id, previousActiveWorkTreeId });
    await persist();
    render();
  }

  function addWorkTreeNode(parentId = "", treeId = state.activeWorkTreeId) {
    const capturedTreeId = treeId || "";
    const key = `${capturedTreeId}:${parentId || ""}`;
    const now = Date.now();
    const lastRequestAt = Number(workTreeCreateRequestTimes.get(key) || 0);
    if (now - lastRequestAt < WORK_TREE_CREATE_DEDUPE_MS) return Promise.resolve(false);
    workTreeCreateRequestTimes.set(key, now);
    if (workTreeCreateRequestTimes.size > 100) {
      for (const [requestKey, requestedAt] of workTreeCreateRequestTimes) {
        if (now - requestedAt > 5000) workTreeCreateRequestTimes.delete(requestKey);
      }
    }
    const requestId = ++workTreeCreateRequestId;
    latestWorkTreeCreateRequestId = requestId;
    return enqueueWorkTreeMutation(() => performAddWorkTreeNode(capturedTreeId, parentId, requestId));
  }

  async function performAddWorkTreeNode(treeId, parentId, requestId) {
    const tree = state.workTrees.find(item => item.id === treeId);
    if (!tree) return treeId ? false : createWorkTree();
    const parent = parentId ? tree.nodes.find(item => item.id === parentId) : null;
    if (parentId && !parent) return false;
    const siblings = workTreeChildren(tree, parentId);
    const node = { id: uid("node"), parentId, title: `新任务 ${siblings.length + 1}`, completed: false, collapsed: false, todoId: "", note: "", order: siblings.length, createdAt: nowIso(), updatedAt: nowIso() };
    const parentWasFolder = Boolean(parent?.folder);
    const parentWasCollapsed = Boolean(parent?.collapsed);
    const previousEditingNodeId = state.editingWorkNodeTitleId;
    tree.nodes.push(node);
    if (parent) {
      parent.folder = true;
      parent.collapsed = false;
    }
    tree.updatedAt = nowIso();
    const undoEntry = setLastWorkTreeUndo({ type: "createNode", treeId: tree.id, nodeId: node.id, parentId, parentWasFolder, parentWasCollapsed, mergeNextRename: true });
    let saved;
    try {
      saved = await persist();
    } catch (error) {
      tree.nodes = tree.nodes.filter(item => item.id !== node.id);
      const liveParent = parentId ? tree.nodes.find(item => item.id === parentId) : null;
      if (liveParent) {
        liveParent.folder = Boolean(parentWasFolder || workTreeChildren(tree, liveParent.id).length);
        if (liveParent.collapsed === false) liveParent.collapsed = parentWasCollapsed;
      }
      tree.updatedAt = nowIso();
      state.workTreeUndoStack = (state.workTreeUndoStack || []).filter(action => action !== undoEntry);
      state.editingWorkNodeTitleId = previousEditingNodeId;
      render();
      throw error;
    }
    if (!saved) return false;
    state.editingWorkNodeTitleId = requestId === latestWorkTreeCreateRequestId ? node.id : "";
    render();
    if (requestId === latestWorkTreeCreateRequestId) {
      setTimeout(() => {
        if (state.editingWorkNodeTitleId !== node.id) return;
        const input = [...app.querySelectorAll("[data-work-node-title]")].find(item => item.dataset.workNodeTitle === node.id);
        selectInputText(input, { reveal: true });
      }, 0);
    }
    return true;
  }

  function workTreeDescendantIds(tree, nodeId) {
    const result = [];
    const visit = id => {
      workTreeChildren(tree, id).forEach(child => {
        result.push(child.id);
        visit(child.id);
      });
    };
    visit(nodeId);
    return result;
  }

  function softDeleteWorkTreeNode(nodeId, treeId = state.activeWorkTreeId) {
    return enqueueWorkTreeMutation(() => performSoftDeleteWorkTreeNode(treeId, nodeId));
  }

  async function performSoftDeleteWorkTreeNode(treeId, nodeId) {
    const tree = state.workTrees.find(item => item.id === treeId);
    const node = tree?.nodes.find(item => item.id === nodeId);
    if (!tree || !node) return;
    const ids = [node.id, ...workTreeDescendantIds(tree, node.id)];
    const removedNodes = tree.nodes.filter(item => ids.includes(item.id)).map(item => ({ ...item }));
    const parent = node.parentId ? tree.nodes.find(item => item.id === node.parentId) : null;
    tree.nodes = tree.nodes.filter(item => !ids.includes(item.id));
    if (parent) parent.folder = Boolean(workTreeChildren(tree, parent.id).length);
    tree.updatedAt = nowIso();
    const entry = {
      id: uid("trash"),
      type: "workTreeNode",
      item: { treeId: tree.id, treeTitle: tree.title, treeTabTitle: tree.tabTitle || tree.title, rootId: node.id, parentId: node.parentId || "", parent: parent ? { ...parent } : null, nodes: removedNodes },
      title: node.title || "未命名树杈",
      deletedAt: nowIso()
    };
    state.trash = [entry, ...(state.trash || [])].slice(0, 200);
    setLastWorkTreeUndo({ type: "trashEntry", entryId: entry.id });
    await persist();
    render();
  }

  function restoreWorkTreeNodeTrashEntry(entry) {
    const item = entry?.item || {};
    const nodes = Array.isArray(item.nodes) ? item.nodes.map(node => ({ ...node })) : [];
    if (!nodes.length) return;
    let tree = state.workTrees.find(workTree => workTree.id === item.treeId);
    if (!tree) {
      tree = { id: item.treeId || uid("tree"), title: item.treeTitle || "恢复的工作树", tabTitle: item.treeTabTitle || item.treeTitle || "恢复的工作树", collapsed: false, nodes: [], createdAt: nowIso(), updatedAt: nowIso() };
      state.workTrees.push(tree);
    }
    const existingIds = new Set((tree.nodes || []).map(node => node.id));
    const restoredIds = new Set(nodes.map(node => node.id));
    const rootId = item.rootId || nodes[0].id;
    const rootParentExists = Boolean(item.parentId && existingIds.has(item.parentId));
    const restoredNodes = nodes
      .filter(node => !existingIds.has(node.id))
      .map(node => ({
        ...node,
        parentId: node.id === rootId && !rootParentExists ? "" : (restoredIds.has(node.parentId) || existingIds.has(node.parentId) ? node.parentId : ""),
        updatedAt: nowIso()
      }));
    tree.nodes = [...(tree.nodes || []), ...restoredNodes];
    const parent = item.parentId ? tree.nodes.find(node => node.id === item.parentId) : null;
    if (parent && item.parent) {
      parent.folder = Boolean(item.parent.folder || workTreeChildren(tree, parent.id).length);
      parent.collapsed = Boolean(item.parent.collapsed);
      parent.updatedAt = nowIso();
    }
    tree.updatedAt = nowIso();
    state.activeWorkTreeId = tree.id;
    state.trash = (state.trash || []).filter(trashEntry => trashEntry.id !== entry.id);
  }

  function setLastWorkTreeUndo(action) {
    if (!action) return;
    const entry = { ...clone(action), at: nowIso() };
    state.workTreeUndoStack = [...(state.workTreeUndoStack || []), entry].slice(-UNDO_LIMIT);
    return state.workTreeUndoStack.includes(entry) ? entry : null;
  }

  function recordWorkTreeNodeRenameUndo(treeId, nodeId, previousTitle, changed) {
    const createAction = [...(state.workTreeUndoStack || [])].reverse().find(action => action.type === "createNode" && action.treeId === treeId && action.nodeId === nodeId && action.mergeNextRename);
    if (createAction) {
      createAction.mergeNextRename = false;
      return { type: "merged", action: createAction };
    }
    if (changed) return { type: "added", action: setLastWorkTreeUndo({ type: "renameNode", treeId, nodeId, title: previousTitle }) };
    return null;
  }

  function clearWorkTreeTrashUndo(entryId) {
    clearTrashUndoEntry(entryId);
  }

  function workTreeNodeSnapshot(tree, nodeId) {
    const node = tree?.nodes.find(item => item.id === nodeId);
    return node ? { ...node } : null;
  }

  function workTreeNodesSnapshot(tree) {
    return (tree?.nodes || []).map(node => ({ ...node }));
  }

  function restoreWorkTreeNodeSnapshot(tree, snapshot) {
    if (!tree || !snapshot?.id) return;
    const index = tree.nodes.findIndex(item => item.id === snapshot.id);
    if (index >= 0) tree.nodes[index] = { ...snapshot };
    else tree.nodes.push({ ...snapshot });
    tree.updatedAt = nowIso();
  }

  function restoreWorkTreeNodesSnapshot(tree, nodes) {
    if (!tree || !Array.isArray(nodes)) return;
    tree.nodes = nodes.map(node => ({ ...node }));
    tree.updatedAt = nowIso();
  }

  function restoreStateItem(collection, snapshot) {
    if (!snapshot?.id || !Array.isArray(state[collection])) return;
    const index = state[collection].findIndex(item => item.id === snapshot.id);
    if (index >= 0) state[collection][index] = { ...snapshot };
    else state[collection].push({ ...snapshot });
  }

  function removeStateItem(collection, id) {
    if (!id || !Array.isArray(state[collection])) return;
    state[collection] = state[collection].filter(item => item.id !== id);
  }

  function workTreeNodePosition(tree, nodeId) {
    const node = tree?.nodes.find(item => item.id === nodeId);
    return node ? { id: node.id, parentId: node.parentId || "", order: Number(node.order || 0) } : null;
  }

  function restoreWorkTreeNodePosition(tree, position) {
    const node = tree?.nodes.find(item => item.id === position?.id);
    if (!node) return;
    node.parentId = position.parentId || "";
    node.order = Number(position.order || 0);
    node.updatedAt = nowIso();
  }

  async function undoLastWorkTreeAction() {
    const action = state.workTreeUndoStack?.pop();
    if (!action) {
      return;
    }
    if (action.type === "trashEntry") {
      await restoreTrashEntry((state.trash || []).find(entry => entry.id === action.entryId));
      if (!(state.trash || []).some(entry => entry.id === action.entryId)) render();
      return;
    }
    if (action.type === "archiveProject") {
      const tree = state.workTrees.find(item => item.id === action.treeId);
      if (tree) {
        tree.archived = false;
        tree.archivedAt = "";
        tree.updatedAt = nowIso();
        state.activeWorkTreeId = tree.id;
      }
    }
    if (action.type === "createProject") {
      state.workTrees = state.workTrees.filter(item => item.id !== action.treeId);
      normalizeWorkTreeProjectOrders();
      state.activeWorkTreeId = state.workTrees.some(item => item.id === action.previousActiveWorkTreeId)
        ? action.previousActiveWorkTreeId
        : (visibleWorkTrees()[0]?.id || "");
      state.editingWorkTreeTitleId = "";
      state.editingWorkTreeTabTitleId = "";
    }
    if (action.type === "createNode") {
      const tree = state.workTrees.find(item => item.id === action.treeId);
      if (tree) {
        const ids = [action.nodeId, ...workTreeDescendantIds(tree, action.nodeId)];
        tree.nodes = tree.nodes.filter(item => !ids.includes(item.id));
        const parent = action.parentId ? tree.nodes.find(item => item.id === action.parentId) : null;
        if (parent) {
          parent.folder = Boolean(action.parentWasFolder || workTreeChildren(tree, parent.id).length);
          parent.collapsed = Boolean(action.parentWasCollapsed);
        }
        tree.updatedAt = nowIso();
      }
      if (state.editingWorkNodeTitleId === action.nodeId) state.editingWorkNodeTitleId = "";
    }
    if (action.type === "deleteProject") {
      const tree = action.tree ? clone(action.tree) : null;
      if (tree?.id) {
        state.workTrees = state.workTrees.filter(item => item.id !== tree.id);
        state.workTrees.push(tree);
        state.activeWorkTreeId = tree.id;
      }
      state.editingWorkTreeTitleId = "";
      state.editingWorkTreeTabTitleId = "";
      state.editingWorkNodeTitleId = "";
    }
    if (action.type === "renameProject") {
      const tree = state.workTrees.find(item => item.id === action.treeId);
      if (tree) {
        tree.title = action.title;
        tree.updatedAt = nowIso();
      }
    }
    if (action.type === "renameProjectTab") {
      const tree = state.workTrees.find(item => item.id === action.treeId);
      if (tree) {
        tree.tabTitle = action.tabTitle || "";
        tree.updatedAt = nowIso();
      }
    }
    if (action.type === "renameNode") {
      const tree = state.workTrees.find(item => item.id === action.treeId);
      const node = tree?.nodes.find(item => item.id === action.nodeId);
      if (tree && node) {
        node.title = action.title;
        node.updatedAt = nowIso();
        const todo = state.todos.find(item => item.id === node.todoId);
        if (todo) {
          todo.title = action.title;
          todo.updatedAt = nowIso();
          syncTodoEvents(todo);
        }
        tree.updatedAt = nowIso();
      }
    }
    if (action.type === "moveNode") {
      const tree = state.workTrees.find(item => item.id === action.treeId);
      if (action.nodes) {
        restoreWorkTreeNodesSnapshot(tree, action.nodes);
      } else {
        restoreWorkTreeNodePosition(tree, action.source);
        normalizeWorkTreeSiblingOrders(tree, action.source?.parentId || "");
        normalizeWorkTreeSiblingOrders(tree, action.targetParentId || "");
      }
      if (tree) tree.updatedAt = nowIso();
    }
    if (action.type === "swapNodes") {
      const tree = state.workTrees.find(item => item.id === action.treeId);
      if (action.nodes) {
        restoreWorkTreeNodesSnapshot(tree, action.nodes);
      } else {
        restoreWorkTreeNodePosition(tree, action.source);
        restoreWorkTreeNodePosition(tree, action.target);
        normalizeWorkTreeSiblingOrders(tree, action.source?.parentId || "");
        normalizeWorkTreeSiblingOrders(tree, action.target?.parentId || "");
      }
      if (tree) tree.updatedAt = nowIso();
    }
    if (action.type === "toggleCollapse") {
      const tree = state.workTrees.find(item => item.id === action.treeId);
      const node = tree?.nodes.find(item => item.id === action.nodeId);
      if (tree && node) {
        node.collapsed = Boolean(action.collapsed);
        node.updatedAt = nowIso();
        tree.updatedAt = nowIso();
      }
    }
    if (action.type === "toggleComplete") {
      const tree = state.workTrees.find(item => item.id === action.treeId);
      restoreWorkTreeNodeSnapshot(tree, action.node);
      if (action.todo) restoreStateItem("todos", action.todo);
      (action.events || []).forEach(event => restoreStateItem("events", event));
      if (tree) tree.updatedAt = nowIso();
    }
    if (action.type === "addToday") {
      const tree = state.workTrees.find(item => item.id === action.treeId);
      restoreWorkTreeNodeSnapshot(tree, action.node);
      if (action.todo) restoreStateItem("todos", action.todo);
      else removeStateItem("todos", action.todoId);
      if (action.event) restoreStateItem("events", action.event);
      else removeStateItem("events", action.eventId);
      if (tree) tree.updatedAt = nowIso();
    }
    if (action.type === "restoreArchive") {
      const tree = state.workTrees.find(item => item.id === action.treeId);
      if (tree) {
        tree.archived = true;
        tree.archivedAt = action.archivedAt || nowIso();
        tree.updatedAt = nowIso();
        state.activeWorkTreeId = visibleWorkTrees().some(item => item.id === action.previousActiveWorkTreeId)
          ? action.previousActiveWorkTreeId
          : (visibleWorkTrees()[0]?.id || "");
      }
    }
    if (action.type === "swapProjects") {
      const source = state.workTrees.find(item => item.id === action.source?.id);
      const target = state.workTrees.find(item => item.id === action.target?.id);
      if (source) source.order = action.source.order;
      if (target) target.order = action.target.order;
      state.activeWorkTreeId = action.activeWorkTreeId || state.activeWorkTreeId;
    }
    await persist();
    render();
  }

  async function undoLastAction() {
    if (undoInProgress) return;
    undoInProgress = true;
    try {
      if (state.surface === "worktree") {
        await enqueueWorkTreeMutation(undoLastWorkTreeAction);
        return;
      }
      await undoLastDelete();
    } finally {
      undoInProgress = false;
    }
  }

  async function archiveWorkTree(treeId) {
    const tree = state.workTrees.find(item => item.id === treeId);
    if (!tree) return;
    tree.archived = true;
    tree.archivedAt = nowIso();
    tree.updatedAt = nowIso();
    const nextTree = visibleWorkTrees().find(item => item.id !== tree.id);
    state.activeWorkTreeId = nextTree?.id || "";
    setLastWorkTreeUndo({ type: "archiveProject", treeId: tree.id });
    await persist();
    render();
  }

  async function restoreArchivedWorkTree(treeId) {
    const tree = state.workTrees.find(item => item.id === treeId);
    if (!tree) return;
    setLastWorkTreeUndo({ type: "restoreArchive", treeId: tree.id, archivedAt: tree.archivedAt || "", previousActiveWorkTreeId: state.activeWorkTreeId });
    tree.archived = false;
    tree.archivedAt = "";
    tree.updatedAt = nowIso();
    state.activeWorkTreeId = tree.id;
    await persist();
    render();
  }

  async function swapWorkTreeProjectOrder(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return;
    normalizeWorkTreeProjectOrders();
    const source = state.workTrees.find(item => item.id === sourceId);
    const target = state.workTrees.find(item => item.id === targetId);
    if (!source || !target || source.archived || target.archived) return;
    const sourceOrder = source.order || 0;
    const targetOrder = target.order || 0;
    setLastWorkTreeUndo({
      type: "swapProjects",
      source: { id: source.id, order: sourceOrder },
      target: { id: target.id, order: targetOrder },
      activeWorkTreeId: state.activeWorkTreeId
    });
    source.order = targetOrder;
    target.order = sourceOrder;
    source.updatedAt = nowIso();
    target.updatedAt = nowIso();
    await persist();
    render();
  }

  async function addWorkNodeToToday(nodeId, taskType = "normal") {
    const tree = activeWorkTree();
    const node = tree?.nodes.find(item => item.id === nodeId);
    if (!tree || !node) return;
    const today = toDateKey(new Date());
    const nodeBefore = workTreeNodeSnapshot(tree, node.id);
    let todo = state.todos.find(item => item.id === node.todoId) || state.todos.find(item => item.workTreeId === tree.id && item.workTreeNodeId === node.id);
    const todoBefore = todo ? { ...todo } : null;
    const eventBefore = todo ? state.events.find(item => item.todoId === todo.id && item.date === today) : null;
    const eventSnapshot = eventBefore ? { ...eventBefore } : null;
    if (!todo) {
      todo = { id: uid("todo"), title: node.title, completed: false, pinned: false, order: state.todos.length, tags: ["工作树"], targetDate: today, reminderAt: "", reminderLead: state.settings.reminderLead || "none", repeat: "none", workTreeId: tree.id, workTreeNodeId: node.id, createdAt: nowIso(), updatedAt: nowIso() };
      state.todos.push(todo);
    } else {
      todo.title = node.title;
      todo.targetDate = today;
      todo.completed = false;
      todo.workTreeId = tree.id;
      todo.workTreeNodeId = node.id;
      todo.updatedAt = nowIso();
    }
    node.todoId = todo.id;
    todo.taskType = taskType;
    todo.goalParentTitle = tree.nodes.find(row => row.id === node.parentId)?.title || tree.title;
    node.completed = false;
    node.updatedAt = nowIso();
    const event = ensureTodoEventForDate(todo, today);
    applyTodoTaskToEvent(todo, event);
    syncTodoEvents(todo);
    refreshTodoSchedule(todo.id);
    setLastWorkTreeUndo({ type: "addToday", treeId: tree.id, node: nodeBefore, todoId: todo.id, todo: todoBefore, eventId: event.id, event: eventSnapshot });
    await persist();
    render();
  }

  function ensureTodoEventForDate(todo, date) {
    let event = state.events.find(item => item.todoId === todo.id && (item.ongoing || item.date === date)) || (todo.taskType === "flow" ? state.events.find(item => item.todoId === todo.id && !item.completed) : null);
    if (!event) {
      event = { id: uid("event"), todoId: todo.id, title: todo.title, date, startTime: "", endTime: "", color: todo.completed ? (state.settings.eventDoneColor || "#78d68f") : (state.settings.eventTodoColor || "#ffd21a"), completed: todo.completed, note: "来自工作树", repeat: "none", reminderAt: "", reminderLead: "none", createdAt: nowIso(), updatedAt: nowIso() };
      state.events.push(event);
    } else {
      event.title = todo.title;
      if (event.ongoing && todo.taskType !== "flow") event.date = date;
      if (todo.taskType === "flow") event.ongoing = true;
      window.EventState.setEventCompleted(event, todo.completed, toDateKey(new Date()));
      event.color = todo.completed ? (state.settings.eventDoneColor || "#78d68f") : (event.color || state.settings.eventTodoColor || "#ffd21a");
      event.updatedAt = nowIso();
    }
    if (todo.taskType === "flow") consolidateFlowEvents(todo, event);
    if (todo.taskType === "flow" && todo.completed && !event.ongoing) event.date = toDateKey(new Date());
    if (todo.taskType) applyTodoTaskToEvent(todo, event);
    return event;
  }

  function consolidateFlowEvents(todo, keep) {
    const duplicates = state.events.filter(row => row.todoId === todo.id && row.id !== keep.id && !row.completed);
    for (const item of duplicates) state.trash.unshift({ id: uid("trash"), type: "event", item: clone(item), index: state.events.indexOf(item), title: item.title, deletedAt: nowIso() });
    state.events = state.events.filter(row => !duplicates.includes(row));
  }

  function syncWorkTreeFromTodo(todo) {
    const tree = state.workTrees.find(item => item.id === todo.workTreeId) || state.workTrees.find(item => item.nodes?.some(node => node.todoId === todo.id));
    const node = tree?.nodes?.find(item => item.id === todo.workTreeNodeId || item.todoId === todo.id);
    if (!tree || !node) return;
    node.todoId = todo.id;
    node.title = todo.title || node.title;
    node.completed = Boolean(todo.completed);
    node.updatedAt = nowIso();
    tree.updatedAt = nowIso();
  }

  function beginWorkNodeRename(nodeId) {
    state.editingWorkNodeTitleId = nodeId;
    render();
    setTimeout(() => {
      const input = [...app.querySelectorAll("[data-work-node-title]")].find(item => item.dataset.workNodeTitle === nodeId);
      selectInputText(input);
    }, 0);
  }

  async function toggleWorkNodeCollapse(nodeId) {
    const tree = activeWorkTree();
    const node = tree?.nodes.find(item => item.id === nodeId);
    if (!node) return;
    setLastWorkTreeUndo({ type: "toggleCollapse", treeId: tree.id, nodeId: node.id, collapsed: Boolean(node.collapsed) });
    node.collapsed = !node.collapsed;
    node.updatedAt = nowIso();
    tree.updatedAt = nowIso();
    render();
    await persist();
  }

  async function toggleWorkNodeCompleted(nodeId) {
    const tree = activeWorkTree();
    const node = tree?.nodes.find(item => item.id === nodeId);
    if (!tree || !node) return;
    const todo = state.todos.find(item => item.id === node.todoId);
    setLastWorkTreeUndo({
      type: "toggleComplete",
      treeId: tree.id,
      node: workTreeNodeSnapshot(tree, node.id),
      todo: todo ? { ...todo } : null,
      events: todo ? state.events.filter(event => event.todoId === todo.id).map(event => ({ ...event })) : []
    });
    node.completed = !node.completed;
    node.updatedAt = nowIso();
    if (todo) {
      todo.completed = node.completed;
      todo.updatedAt = nowIso();
      syncTodoEvents(todo);
    }
    tree.updatedAt = nowIso();
    await persist();
    render();
  }

  async function swapWorkTreeNodeOrder(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const tree = activeWorkTree();
    const source = tree?.nodes.find(node => node.id === sourceId);
    const target = tree?.nodes.find(node => node.id === targetId);
    if (!tree || !source || !target || !validWorkTreeExchangeTarget(sourceId, targetId)) return;
    const sourceParentId = source.parentId || "";
    const targetParentId = target.parentId || "";
    const sourceOrder = Number(source.order || 0);
    const targetOrder = Number(target.order || 0);
    setLastWorkTreeUndo({
      type: "swapNodes",
      treeId: tree.id,
      nodes: workTreeNodesSnapshot(tree),
      source: { id: source.id, parentId: sourceParentId, order: sourceOrder },
      target: { id: target.id, parentId: targetParentId, order: targetOrder }
    });
    source.parentId = targetParentId;
    target.parentId = sourceParentId;
    source.order = targetOrder;
    target.order = sourceOrder;
    normalizeWorkTreeSiblingOrders(tree, sourceParentId);
    normalizeWorkTreeSiblingOrders(tree, targetParentId);
    tree.updatedAt = nowIso();
    await persist();
    render();
  }

  async function moveWorkTreeNodeInto(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const tree = activeWorkTree();
    const source = tree?.nodes.find(node => node.id === sourceId);
    const target = tree?.nodes.find(node => node.id === targetId);
    if (!tree || !source || !target || !validWorkTreeInsideTarget(sourceId, targetId)) return;
    const previousParentId = source.parentId || "";
    const previousParent = previousParentId ? tree.nodes.find(node => node.id === previousParentId) : null;
    setLastWorkTreeUndo({
      type: "moveNode",
      treeId: tree.id,
      nodes: workTreeNodesSnapshot(tree),
      source: { id: source.id, parentId: previousParentId, order: Number(source.order || 0) },
      targetParentId: target.id
    });
    target.folder = true;
    target.collapsed = false;
    source.parentId = target.id;
    source.order = workTreeChildren(tree, target.id).filter(node => node.id !== source.id).length;
    normalizeWorkTreeSiblingOrders(tree, previousParentId);
    normalizeWorkTreeSiblingOrders(tree, target.id);
    if (previousParent) previousParent.folder = Boolean(workTreeChildren(tree, previousParent.id).length);
    tree.updatedAt = nowIso();
    await persist();
    render();
  }

  function normalizeWorkTreeSiblingOrders(tree, parentId = "") {
    workTreeChildren(tree, parentId).forEach((node, index) => { node.order = index; });
  }

  function isWorkTreeDescendant(tree, parentId, childId) {
    return workTreeDescendantIds(tree, parentId).includes(childId);
  }

  function validWorkTreeExchangeTarget(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return false;
    const tree = activeWorkTree();
    if (!tree) return false;
    return !isWorkTreeDescendant(tree, sourceId, targetId) && !isWorkTreeDescendant(tree, targetId, sourceId);
  }

  function validWorkTreeInsideTarget(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return false;
    const tree = activeWorkTree();
    if (!tree) return false;
    return !isWorkTreeDescendant(tree, sourceId, targetId);
  }

  function validWorkTreeDropTarget(sourceId, targetId) {
    return validWorkTreeExchangeTarget(sourceId, targetId) || validWorkTreeInsideTarget(sourceId, targetId);
  }

  function clearWorkTreePointerDrop() {
    if (workTreePointerDropRow) {
      workTreePointerDropRow.classList.remove("worktree-drop-target");
      delete workTreePointerDropRow.dataset.worktreeDropMode;
      delete workTreePointerDropRow.dataset.worktreeCanInside;
      delete workTreePointerDropRow.dataset.worktreeCanSwap;
    }
    workTreePointerDropRow = null;
  }

  function workTreeDragElement(event) {
    return event.target instanceof Element ? event.target : null;
  }

  function setWorkTreeTrashHot(hot) {
    app.querySelector("[data-work-tree-node-trash]")?.classList.toggle("hot-drop", hot);
  }

  function ensureWorkTreeDragOverlay() {
    if (workTreeDragOverlay) return workTreeDragOverlay;
    const panel = document.createElement("div");
    panel.className = "worktree-drag-panel";
    panel.innerHTML = `
      <div class="worktree-drag-delete" data-worktree-drag-delete>松开删除</div>
    `;
    panel.querySelector("[data-worktree-drag-delete]")?.addEventListener("dragover", event => {
      if (!workTreeDraggingNodeId || !isWorkTreeDeleteZone(event.clientX, event.clientY)) return;
      event.preventDefault();
      workTreeDragAction = { action: "delete", targetId: "" };
      panel.querySelector("[data-worktree-drag-delete]")?.classList.add("hot");
    });
    panel.querySelector("[data-worktree-drag-delete]")?.addEventListener("dragleave", () => {
      panel.querySelector("[data-worktree-drag-delete]")?.classList.remove("hot");
    });
    panel.querySelector("[data-worktree-drag-delete]")?.addEventListener("drop", async event => {
      if (!workTreeDraggingNodeId || !isWorkTreeDeleteZone(event.clientX, event.clientY)) return;
      event.preventDefault();
      event.stopPropagation();
      const sourceId = workTreeDraggingNodeId;
      resetWorkTreeDragState();
      await softDeleteWorkTreeNode(sourceId);
    });
    document.body.appendChild(panel);
    workTreeDragOverlay = panel;
    return panel;
  }

  function workTreeRowFromPoint(x, y) {
    return document.elementsFromPoint(x, y)
      .map(element => element.closest?.("[data-work-node-row]"))
      .find(Boolean) || null;
  }

  function workTreeDropActionForRow(row, x) {
    const targetId = row?.dataset.workNodeRow || "";
    if (!targetId || targetId === workTreeDraggingNodeId) return null;
    const canInside = validWorkTreeInsideTarget(workTreeDraggingNodeId, targetId);
    const canSwap = validWorkTreeExchangeTarget(workTreeDraggingNodeId, targetId);
    if (!canInside && !canSwap) return null;
    const rect = row.getBoundingClientRect();
    const mode = x < rect.left + rect.width / 2 ? "inside" : "swap";
    row.classList.add("worktree-drop-target");
    row.dataset.worktreeDropMode = mode;
    row.dataset.worktreeCanInside = canInside ? "true" : "false";
    row.dataset.worktreeCanSwap = canSwap ? "true" : "false";
    workTreePointerDropRow = row;
    if (mode === "inside" && canInside) return { action: "inside", targetId };
    if (mode === "swap" && canSwap) return { action: "swap", targetId };
    return null;
  }

  function isWorkTreeDeleteZone(x, y) {
    if (!workTreeDraggingNodeId) return false;
    const panel = app.querySelector(".worktree-panel");
    if (!panel) return false;
    const panelRect = panel.getBoundingClientRect();
    const appRect = app.querySelector(".glass-app")?.getBoundingClientRect() || panelRect;
    if (x < appRect.left || x > appRect.right || y < appRect.top || y > appRect.bottom) return false;
    if (workTreeRowFromPoint(x, y)) return false;
    const blocked = document.elementsFromPoint(x, y).some(element => element.closest?.("button,input,textarea,select,details,summary,[data-work-node-row],[data-work-tree-tab-drag]"));
    if (blocked) return false;
    const toolbarRect = app.querySelector(".toolbar")?.getBoundingClientRect();
    if (toolbarRect && x >= toolbarRect.left && x <= toolbarRect.right && y >= toolbarRect.top && y <= toolbarRect.bottom) return true;
    const dropZone = app.querySelector("[data-work-tree-drop-zone]");
    const dropRect = dropZone?.getBoundingClientRect();
    if (dropRect) {
      return x >= panelRect.left && x <= panelRect.right && y >= panelRect.top && y < dropRect.top;
    }
    const topDeleteBottom = panelRect.top + Math.min(150, Math.max(86, panelRect.height * .18));
    return x >= panelRect.left && x <= panelRect.right && y >= panelRect.top && y <= topDeleteBottom;
  }

  function updateWorkTreeDragOverlay(event) {
    if (!workTreeDraggingNodeId) return;
    const panel = ensureWorkTreeDragOverlay();
    const deleteHot = isWorkTreeDeleteZone(event.clientX, event.clientY);
    const workPanel = app.querySelector(".worktree-panel");
    const panelRect = workPanel?.getBoundingClientRect();
    const toolbarRect = app.querySelector(".toolbar")?.getBoundingClientRect();
    if (panelRect) {
      const hintLeft = toolbarRect ? toolbarRect.left + toolbarRect.width / 2 : panelRect.left + panelRect.width / 2;
      const hintTop = toolbarRect ? toolbarRect.top + Math.max(4, (toolbarRect.height - 32) / 2) : panelRect.top + 10;
      panel.style.setProperty("--delete-hint-left", `${hintLeft}px`);
      panel.style.setProperty("--delete-hint-top", `${hintTop}px`);
    }
    panel.style.setProperty("--drag-x", `${event.clientX}px`);
    panel.style.setProperty("--drag-y", `${event.clientY}px`);
    panel.classList.add("visible");
    panel.classList.toggle("delete-hot", deleteHot);
    panel.querySelector("[data-worktree-drag-delete]")?.classList.toggle("hot", deleteHot);
    clearWorkTreePointerDrop();
    workTreeDragAction = deleteHot ? { action: "delete", targetId: "" } : workTreeDropActionForRow(workTreeRowFromPoint(event.clientX, event.clientY), event.clientX);
  }

  function resetWorkTreeDragState() {
    workTreeDraggingNodeId = "";
    workTreeDragAction = null;
    workTreePointerDragState = null;
    workTreeSuppressNodeActionUntil = Date.now() + 250;
    document.documentElement.classList.remove("worktree-dragging");
    setWorkTreeTrashHot(false);
    clearWorkTreePointerDrop();
    if (workTreeDragOverlay) {
      workTreeDragOverlay.classList.remove("visible");
      workTreeDragOverlay.classList.remove("delete-hot");
      workTreeDragOverlay.querySelector("[data-worktree-drag-delete]")?.classList.remove("hot");
    }
  }

  function workTreeDragActionFromPoint(x, y) {
    if (isWorkTreeDeleteZone(x, y)) return { action: "delete", targetId: "" };
    return workTreeDropActionForRow(workTreeRowFromPoint(x, y), x);
  }

  function startWorkTreePointerDrag(event) {
    if (!workTreePointerDragState || workTreePointerDragState.dragging) return;
    workTreePointerDragState.dragging = true;
    workTreeDraggingNodeId = workTreePointerDragState.nodeId;
    state.workTreeContextMenu = null;
    document.documentElement.classList.add("worktree-dragging");
    ensureWorkTreeDragOverlay();
    updateWorkTreeDragOverlay(event);
  }

  async function finishWorkTreePointerDrag(event) {
    const pointerState = workTreePointerDragState;
    if (!pointerState || pointerState.pointerId !== event.pointerId) return;
    pointerState.handle?.releasePointerCapture?.(event.pointerId);
    if (!pointerState.dragging) {
      workTreePointerDragState = null;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const sourceId = workTreeDraggingNodeId;
    const action = workTreeDragActionFromPoint(event.clientX, event.clientY);
    resetWorkTreeDragState();
    if (!sourceId || !action) return;
    if (action.action === "delete") await softDeleteWorkTreeNode(sourceId);
    else if (action.action === "inside") await moveWorkTreeNodeInto(sourceId, action.targetId);
    else if (action.action === "swap") await swapWorkTreeNodeOrder(sourceId, action.targetId);
  }

  function cancelWorkTreePointerDrag(event) {
    const pointerState = workTreePointerDragState;
    if (!pointerState || pointerState.pointerId !== event.pointerId) return;
    pointerState.handle?.releasePointerCapture?.(event.pointerId);
    if (pointerState.dragging) resetWorkTreeDragState();
    else workTreePointerDragState = null;
  }

  function clearWorkTreeProjectDrop() {
    workTreeProjectDropTab?.classList.remove("worktree-project-drop-target");
    workTreeProjectDropTab = null;
  }

  function workTreeProjectTabFromPoint(x, y) {
    return document.elementsFromPoint(x, y)
      .map(element => element.closest?.("[data-work-tree-tab-drag]"))
      .find(Boolean) || null;
  }

  function installWorkTreeProjectDrag() {
    if (window.__xiaoyeWorkTreeProjectDragInstalled) return;
    window.__xiaoyeWorkTreeProjectDragInstalled = true;
    document.addEventListener("pointermove", event => {
      const dragState = workTreeProjectDragState;
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
      if (!dragState.dragging && distance < 12) return;
      if (!dragState.dragging) {
        dragState.dragging = true;
        document.documentElement.classList.add("worktree-project-dragging");
        state.workTreeContextMenu = null;
        app.querySelector("[data-work-tree-project-menu][open]")?.removeAttribute("open");
      }
      clearWorkTreeProjectDrop();
      const target = workTreeProjectTabFromPoint(event.clientX, event.clientY);
      if (target && target.dataset.workTreeTabDrag !== dragState.treeId) {
        target.classList.add("worktree-project-drop-target");
        workTreeProjectDropTab = target;
      }
      event.preventDefault();
    }, { passive: false });
    document.addEventListener("pointerup", event => {
      const dragState = workTreeProjectDragState;
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      dragState.handle?.releasePointerCapture?.(event.pointerId);
      workTreeProjectDragState = null;
      document.documentElement.classList.remove("worktree-project-dragging");
      const target = workTreeProjectTabFromPoint(event.clientX, event.clientY);
      clearWorkTreeProjectDrop();
      if (!dragState.dragging) return;
      event.preventDefault();
      event.stopPropagation();
      workTreeSuppressProjectClickUntil = Date.now() + 250;
      const targetId = target?.dataset.workTreeTabDrag || "";
      if (targetId && targetId !== dragState.treeId) swapWorkTreeProjectOrder(dragState.treeId, targetId).catch(console.error);
    });
    document.addEventListener("pointercancel", event => {
      if (!workTreeProjectDragState || workTreeProjectDragState.pointerId !== event.pointerId) return;
      workTreeProjectDragState.handle?.releasePointerCapture?.(event.pointerId);
      workTreeProjectDragState = null;
      document.documentElement.classList.remove("worktree-project-dragging");
      clearWorkTreeProjectDrop();
    });
  }

  function installWorkTreePointerDrag() {
    if (window.__xiaoyeWorkTreePointerDragInstalled) return;
    window.__xiaoyeWorkTreePointerDragInstalled = true;
    document.addEventListener("pointermove", event => {
      const pointerState = workTreePointerDragState;
      if (!pointerState || pointerState.pointerId !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - pointerState.startX, event.clientY - pointerState.startY);
      if (!pointerState.dragging && distance < 14) return;
      startWorkTreePointerDrag(event);
      updateWorkTreeDragOverlay(event);
      event.preventDefault();
    }, { passive: false });
    document.addEventListener("pointerup", event => {
      finishWorkTreePointerDrag(event).catch(console.error);
    });
    document.addEventListener("pointercancel", cancelWorkTreePointerDrag);
  }

  function installWorkTreeGlobalDrop() {
    if (window.__xiaoyeWorkTreeGlobalDropInstalled) return;
    window.__xiaoyeWorkTreeGlobalDropInstalled = true;
    document.addEventListener("dragover", event => {
      if (!workTreeDraggingNodeId || state.surface !== "worktree") return;
      updateWorkTreeDragOverlay(event);
    });
    document.addEventListener("drop", event => {
      if (!workTreeDraggingNodeId || state.surface !== "worktree") return;
      const sourceId = workTreeDraggingNodeId;
      const action = workTreeDragActionFromPoint(event.clientX, event.clientY);
      resetWorkTreeDragState();
      if (sourceId && action?.action === "delete") softDeleteWorkTreeNode(sourceId).catch(console.error);
    });
  }

  function scheduleWorkTreeLines() {
    clearTimeout(workTreeLineTimer);
    const draw = () => drawWorkTreeMindmapLines();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(draw);
    else workTreeLineTimer = setTimeout(draw, 0);
  }

  function applyWorkTreeMindmapZoom(map, requestedZoom) {
    const canvas = map?.querySelector("[data-mind-canvas]");
    const stage = map?.querySelector("[data-mind-stage]");
    if (!map || !canvas || !stage) return null;
    const width = Number(canvas.dataset.mindWidth || 0);
    const height = Number(canvas.dataset.mindHeight || 0);
    if (!width || !height) return null;
    const zoom = clampWorkTreeZoom(requestedZoom);
    canvas.dataset.mindZoom = String(zoom);
    map.dataset.mindZoom = String(zoom);
    canvas.style.width = `${Math.ceil(width * zoom)}px`;
    canvas.style.height = `${Math.ceil(height * zoom)}px`;
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    stage.style.setProperty("--worktree-zoom", String(zoom));
    return { canvas, stage, width, height, zoom };
  }

  function updateWorkTreeZoomControls(zoom) {
    const normalized = clampWorkTreeZoom(zoom);
    const controls = app.querySelector("[data-work-tree-zoom-controls]");
    if (!controls) return;
    const value = controls.querySelector("[data-work-tree-zoom-reset]");
    if (value) value.textContent = `${Math.round(normalized * 100)}%`;
    const zoomOut = controls.querySelector("[data-work-tree-zoom-out]");
    const zoomIn = controls.querySelector("[data-work-tree-zoom-in]");
    if (zoomOut) zoomOut.disabled = normalized <= WORK_TREE_ZOOM_MIN;
    if (zoomIn) zoomIn.disabled = normalized >= WORK_TREE_ZOOM_MAX;
  }

  function scheduleWorkTreeViewportPersist() {
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(() => persistUiStatePatch({ scrollState: state.scrollState }), 180);
  }

  function setWorkTreeZoom(nextZoom, anchor = null, options = {}) {
    const map = app.querySelector("[data-worktree-map]");
    const canvas = map?.querySelector("[data-mind-canvas]");
    if (!map || !canvas) return false;
    const treeId = map.dataset.workTreeId || state.activeWorkTreeId;
    if (!treeId) return false;
    const oldZoom = clampWorkTreeZoom(map.dataset.mindZoom || canvas.dataset.mindZoom || workTreeZoomFor(treeId));
    const normalized = clampWorkTreeZoom(Math.round(Number(nextZoom) * 100) / 100);
    const rect = map.getBoundingClientRect();
    const anchorX = Number.isFinite(anchor?.clientX) ? clamp(anchor.clientX - rect.left, 0, map.clientWidth) : map.clientWidth / 2;
    const anchorY = Number.isFinite(anchor?.clientY) ? clamp(anchor.clientY - rect.top, 0, map.clientHeight) : map.clientHeight / 2;
    const oldOriginLeft = canvas.offsetLeft;
    const oldOriginTop = canvas.offsetTop;
    const logicalX = (map.scrollLeft + anchorX - oldOriginLeft) / oldZoom;
    const logicalY = (map.scrollTop + anchorY - oldOriginTop) / oldZoom;
    const applied = applyWorkTreeMindmapZoom(map, normalized);
    if (!applied) return false;
    const newOriginLeft = canvas.offsetLeft;
    const newOriginTop = canvas.offsetTop;
    if (options.center) {
      map.scrollLeft = Math.max(0, newOriginLeft + applied.width * normalized / 2 - map.clientWidth / 2);
      map.scrollTop = Math.max(0, newOriginTop + applied.height * normalized / 2 - map.clientHeight / 2);
    } else {
      map.scrollLeft = Math.max(0, newOriginLeft + logicalX * normalized - anchorX);
      map.scrollTop = Math.max(0, newOriginTop + logicalY * normalized - anchorY);
    }
    const key = workTreeMindmapScrollKey(treeId);
    const previous = state.scrollState?.[key];
    state.scrollState = {
      ...(state.scrollState || {}),
      [key]: {
        ...(previous && typeof previous === "object" ? previous : {}),
        top: map.scrollTop,
        left: map.scrollLeft,
        zoom: normalized
      }
    };
    updateWorkTreeZoomControls(normalized);
    scheduleWorkTreeViewportPersist();
    scheduleWorkTreeLines();
    return true;
  }

  function changeWorkTreeZoom(delta, anchor = null) {
    const map = app.querySelector("[data-worktree-map]");
    if (!map) return false;
    const current = clampWorkTreeZoom(map.dataset.mindZoom || 1);
    return setWorkTreeZoom(current + delta, anchor);
  }

  function fitWorkTreeZoom() {
    const map = app.querySelector("[data-worktree-map]");
    const canvas = map?.querySelector("[data-mind-canvas]");
    if (!map || !canvas) return false;
    const width = Number(canvas.dataset.mindWidth || 0);
    const height = Number(canvas.dataset.mindHeight || 0);
    if (!width || !height) return false;
    const availableWidth = Math.max(1, map.clientWidth - 32);
    const availableHeight = Math.max(1, map.clientHeight - 32);
    const fit = Math.floor(Math.min(1, availableWidth / width, availableHeight / height) * 100) / 100;
    return setWorkTreeZoom(clamp(fit, WORK_TREE_ZOOM_MIN, 1), null, { center: true });
  }

  function drawWorkTreeMindmapLines() {
    if (state.surface !== "worktree" || state.workTreeView !== "mindmap") return;
    const map = app.querySelector("[data-worktree-map]");
    if (!map) return;
    applyWorkTreeMindmapZoom(map, map.dataset.mindZoom || 1);
  }

  function bindWorkTreeMapPan(map) {
    if (!map) return;
    const interactiveSelector = ".mind-node,.mind-root,button,input,textarea,details,summary,[data-work-node-drag]";
    map.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest(interactiveSelector)) return;
      workTreePanState = { x: event.clientX, y: event.clientY, left: map.scrollLeft, top: map.scrollTop };
      map.classList.add("panning");
      map.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    map.addEventListener("pointermove", event => {
      if (!workTreePanState) return;
      map.scrollLeft = workTreePanState.left - (event.clientX - workTreePanState.x);
      map.scrollTop = workTreePanState.top - (event.clientY - workTreePanState.y);
      event.preventDefault();
    });
    const stopPan = event => {
      if (!workTreePanState) return;
      workTreePanState = null;
      map.classList.remove("panning");
      map.releasePointerCapture?.(event.pointerId);
    };
    map.addEventListener("pointerup", stopPan);
    map.addEventListener("pointercancel", stopPan);
    map.addEventListener("lostpointercapture", () => {
      workTreePanState = null;
      map.classList.remove("panning");
    });
  }

  function bindWorkTreeMapZoom(map) {
    if (!map) return;
    map.addEventListener("wheel", event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.deltaY) return;
      changeWorkTreeZoom(event.deltaY < 0 ? WORK_TREE_ZOOM_STEP : -WORK_TREE_ZOOM_STEP, { clientX: event.clientX, clientY: event.clientY });
    }, { passive: false });
  }

  function bindWorkTree() {
    installWorkTreeGlobalDrop();
    installWorkTreePointerDrag();
    installWorkTreeProjectDrag();
    app.querySelectorAll("[data-work-tree-select]").forEach(button => button.addEventListener("click", () => {
      if (Date.now() < workTreeSuppressProjectClickUntil) return;
      state.activeWorkTreeId = button.dataset.workTreeSelect;
      render();
      persistUiStatePatch({ activeWorkTreeId: state.activeWorkTreeId });
    }));
    app.querySelectorAll("[data-work-tree-new]").forEach(button => button.addEventListener("click", createWorkTree));
    app.querySelectorAll("[data-work-tree-tab-drag]").forEach(tab => {
      tab.addEventListener("pointerdown", event => {
        if (event.button !== 0 || state.editingWorkTreeTabTitleId) return;
        workTreeProjectDragState = {
          treeId: tab.dataset.workTreeTabDrag,
          startX: event.clientX,
          startY: event.clientY,
          pointerId: event.pointerId,
          handle: tab,
          dragging: false
        };
        tab.setPointerCapture?.(event.pointerId);
      });
    });
    app.querySelectorAll("[data-work-tree-view]").forEach(button => button.addEventListener("click", () => {
      state.workTreeView = button.dataset.workTreeView;
      render();
      persistUiStatePatch({ workTreeView: state.workTreeView });
    }));
    app.querySelector("[data-toggle-work-tree-folder-columns]")?.addEventListener("click", () => {
      state.workTreeFolderColumns = Number(state.workTreeFolderColumns) === 2 ? 1 : 2;
      render();
      persistUiStatePatch({ workTreeFolderColumns: state.workTreeFolderColumns });
    });
    app.querySelector("[data-toggle-work-tree-map-mode]")?.addEventListener("click", () => {
      state.workTreeMapMode = state.workTreeMapMode === "double" ? "single" : "double";
      resetWorkTreeMindmapScroll(state.activeWorkTreeId);
      render();
      persistUiStatePatch({ workTreeMapMode: state.workTreeMapMode, scrollState: state.scrollState });
    });
    app.querySelector("[data-work-tree-zoom-out]")?.addEventListener("click", () => changeWorkTreeZoom(-WORK_TREE_ZOOM_STEP));
    app.querySelector("[data-work-tree-zoom-in]")?.addEventListener("click", () => changeWorkTreeZoom(WORK_TREE_ZOOM_STEP));
    app.querySelector("[data-work-tree-zoom-reset]")?.addEventListener("click", () => setWorkTreeZoom(1));
    app.querySelector("[data-work-tree-zoom-fit]")?.addEventListener("click", fitWorkTreeZoom);
    app.querySelector("[data-work-tree-hide-done]")?.addEventListener("click", () => { state.hideCompletedWorkTreeNodes = !state.hideCompletedWorkTreeNodes; render(); persistUiStatePatch({ hideCompletedWorkTreeNodes: state.hideCompletedWorkTreeNodes }); });
    app.querySelectorAll("[data-work-tree-add-root]").forEach(button => button.addEventListener("click", () => addWorkTreeNode("")));
    app.querySelector(".worktree-panel")?.addEventListener("pointerdown", event => {
      const menu = app.querySelector("[data-work-tree-project-menu][open]");
      if (menu && !event.target.closest("[data-work-tree-project-menu]")) menu.removeAttribute("open");
    }, true);
    app.querySelectorAll("[data-work-tree-rename]").forEach(button => {
      const beginRename = () => {
        state.editingWorkTreeTitleId = button.dataset.workTreeRename;
        state.editingWorkTreeTabTitleId = "";
        render();
        setTimeout(() => {
          const input = app.querySelector(`[data-work-tree-title="${state.editingWorkTreeTitleId}"]`);
          selectInputText(input);
        }, 0);
      };
      button.addEventListener("contextmenu", event => { event.preventDefault(); beginRename(); });
      button.addEventListener("dblclick", beginRename);
    });
    app.querySelectorAll("[data-work-tree-tab-rename]").forEach(button => {
      const beginRename = () => {
        state.editingWorkTreeTabTitleId = button.dataset.workTreeTabRename;
        state.editingWorkTreeTitleId = "";
        render();
        setTimeout(() => {
          const input = app.querySelector(`[data-work-tree-tab-title="${state.editingWorkTreeTabTitleId}"]`);
          selectInputText(input);
        }, 0);
      };
      button.addEventListener("contextmenu", event => { event.preventDefault(); beginRename(); });
      button.addEventListener("dblclick", beginRename);
    });
    app.querySelectorAll("[data-work-tree-title]").forEach(input => {
      bindSelectAllOnFocus(input);
      bindWorkTreeRenameSelectionGuard(input);
      const saveTitle = async () => {
        const tree = state.workTrees.find(item => item.id === input.dataset.workTreeTitle);
        if (!tree) return;
        const previousTitle = tree.title;
        const nextTitle = input.value.trim() || tree.title;
        if (nextTitle !== previousTitle) setLastWorkTreeUndo({ type: "renameProject", treeId: tree.id, title: previousTitle });
        tree.title = nextTitle;
        tree.updatedAt = nowIso();
        state.editingWorkTreeTitleId = "";
        await persist();
        render();
      };
      input.addEventListener("keydown", event => {
        if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          saveTitle().catch(console.error);
        }
      });
      input.addEventListener("blur", () => saveTitle().catch(console.error));
    });
    app.querySelectorAll("[data-work-tree-tab-title]").forEach(input => {
      bindSelectAllOnFocus(input);
      bindWorkTreeRenameSelectionGuard(input);
      const saveTitle = async () => {
        const tree = state.workTrees.find(item => item.id === input.dataset.workTreeTabTitle);
        if (!tree) return;
        const previousLabel = tree.tabTitle || tree.title;
        const previousTabTitle = tree.tabTitle || "";
        const nextTitle = input.value.trim() || previousLabel;
        if (nextTitle !== previousLabel) setLastWorkTreeUndo({ type: "renameProjectTab", treeId: tree.id, tabTitle: previousTabTitle });
        tree.tabTitle = nextTitle;
        tree.updatedAt = nowIso();
        state.editingWorkTreeTabTitleId = "";
        await persist();
        render();
      };
      input.addEventListener("keydown", event => {
        if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          saveTitle().catch(console.error);
        }
      });
      input.addEventListener("blur", () => saveTitle().catch(console.error));
    });
    app.querySelectorAll("[data-export-work-tree-mindmap]").forEach(button => button.addEventListener("click", async () => {
      button.closest("[data-work-tree-project-menu]")?.removeAttribute("open");
      await exportWorkTreeMindmapPng(button.dataset.exportWorkTreeMindmap).catch(console.error);
    }));
    app.querySelectorAll("[data-work-tree-duplicate]").forEach(button => button.addEventListener("click", () => duplicateWorkTreeProject(button.dataset.workTreeDuplicate).catch(console.error)));
    app.querySelectorAll("[data-work-tree-delete]").forEach(button => button.addEventListener("click", async () => {
      const tree = state.workTrees.find(item => item.id === button.dataset.workTreeDelete);
      if (!tree) return;
      const progress = workTreeProgress(tree);
      const detail = progress.total ? `，其中还有 ${progress.total - progress.done} 个未完成任务` : "";
      if (!confirm(`确定删除项目“${tree.title}”？将删除 ${tree.nodes.length} 个节点${detail}。`)) return;
      const previousActiveWorkTreeId = state.activeWorkTreeId;
      const deletedTree = clone(tree);
      state.workTrees = state.workTrees.filter(item => item.id !== tree.id);
      state.activeWorkTreeId = visibleWorkTrees()[0]?.id || "";
      setLastWorkTreeUndo({ type: "deleteProject", tree: deletedTree, previousActiveWorkTreeId });
      await persist();
      render();
    }));
    app.querySelectorAll("[data-work-tree-archive]").forEach(button => button.addEventListener("click", () => archiveWorkTree(button.dataset.workTreeArchive)));
    app.querySelectorAll("[data-work-tree-restore-archive]").forEach(button => button.addEventListener("click", () => restoreArchivedWorkTree(button.dataset.workTreeRestoreArchive)));
    app.querySelector("[data-work-tree-undo]")?.addEventListener("click", () => undoLastAction().catch(console.error));
    app.querySelector("[data-work-tree-node-trash]")?.addEventListener("dragover", event => {
      if (!workTreeDraggingNodeId) return;
      updateWorkTreeDragOverlay(event);
    });
    app.querySelector("[data-work-tree-node-trash]")?.addEventListener("dragleave", event => {
      event.currentTarget.classList.remove("hot-drop");
    });
    app.querySelector("[data-work-tree-trash-close]")?.addEventListener("click", async () => { state.showWorkTreeTrash = false; await persist(); render(); });
    app.querySelectorAll("[data-work-tree-trash-restore]").forEach(button => button.addEventListener("click", () => restoreTrashEntry(workTreeTrashEntries().find(entry => entry.id === button.dataset.workTreeTrashRestore))));
    app.querySelectorAll("[data-work-tree-trash-delete]").forEach(button => button.addEventListener("click", async () => {
      if (!confirm("确定彻底删除这个树杈？此操作不可撤销。")) return;
      clearWorkTreeTrashUndo(button.dataset.workTreeTrashDelete);
      state.trash = (state.trash || []).filter(entry => entry.id !== button.dataset.workTreeTrashDelete);
      await persist();
      render();
    }));
    app.querySelector("[data-work-tree-trash-clear]")?.addEventListener("click", async event => {
      if (event.currentTarget.disabled) return;
      if (!confirm("确定清空工作树回收站？此操作不可撤销。")) return;
      state.workTreeUndoStack = (state.workTreeUndoStack || []).filter(action => action.type !== "trashEntry");
      state.trash = (state.trash || []).filter(entry => entry.type !== "workTreeNode");
      await persist();
      render();
    });
    app.querySelectorAll("[data-work-node-collapse]").forEach(button => button.addEventListener("click", event => {
      event.stopPropagation();
      toggleWorkNodeCollapse(button.dataset.workNodeCollapse).catch(console.error);
    }));
    app.querySelectorAll("[data-work-node-toggle]").forEach(button => button.addEventListener("click", async () => {
      await toggleWorkNodeCompleted(button.dataset.workNodeToggle);
    }));
    app.querySelectorAll("[data-work-node-rename]").forEach(button => {
      button.addEventListener("click", event => {
        event.stopPropagation();
        if (event.detail > 1) return;
        if (button.dataset.workNodeCanCollapse === "true") toggleWorkNodeCollapse(button.dataset.workNodeRename).catch(console.error);
      });
      button.addEventListener("dblclick", event => {
        event.preventDefault();
        event.stopPropagation();
        if (button.dataset.workNodeCanCollapse === "true") return;
        beginWorkNodeRename(button.dataset.workNodeRename);
      });
      button.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
        beginWorkNodeRename(button.dataset.workNodeRename);
      });
    });
    app.querySelectorAll("[data-work-node-title]").forEach(input => {
      bindSelectAllOnFocus(input);
      bindWorkTreeRenameSelectionGuard(input);
      let saving = false;
      const saveTitle = () => {
        if (saving) return Promise.resolve(false);
        saving = true;
        const nodeId = input.dataset.workNodeTitle;
        const treeId = state.workTrees.find(tree => tree.nodes?.some(node => node.id === nodeId))?.id || "";
        const inputValue = input.value;
        const preservedDraft = captureEditorDraft(input);
        return enqueueWorkTreeMutation(async () => {
          const tree = state.workTrees.find(item => item.id === treeId);
          const node = tree?.nodes.find(item => item.id === nodeId);
          if (!tree || !node) return false;
          const previousTitle = node.title;
          const nextTitle = inputValue.trim() || node.title;
          const changed = nextTitle !== previousTitle;
          const undoRecord = recordWorkTreeNodeRenameUndo(tree.id, node.id, previousTitle, changed);
          if (!changed) {
            if (state.editingWorkNodeTitleId === node.id) state.editingWorkNodeTitleId = "";
            clearDraftControl(input);
            render();
            return true;
          }
          const nodeBefore = workTreeNodeSnapshot(tree, node.id);
          const treeUpdatedAt = tree.updatedAt;
          const todo = state.todos.find(item => item.id === node.todoId);
          const todoBefore = todo ? { ...todo } : null;
          const eventsBefore = todo ? state.events.filter(event => event.todoId === todo.id).map(event => ({ ...event })) : [];
          node.title = nextTitle;
          node.updatedAt = nowIso();
          if (todo) {
            todo.title = node.title;
            todo.updatedAt = nowIso();
            syncTodoEvents(todo);
          }
          tree.updatedAt = nowIso();
          let saved;
          try {
            saved = await persist(preservedDraft);
          } catch (error) {
            restoreWorkTreeNodeSnapshot(tree, nodeBefore);
            tree.updatedAt = treeUpdatedAt;
            if (todoBefore) restoreStateItem("todos", todoBefore);
            eventsBefore.forEach(event => restoreStateItem("events", event));
            if (undoRecord?.type === "added") state.workTreeUndoStack = (state.workTreeUndoStack || []).filter(action => action !== undoRecord.action);
            if (undoRecord?.type === "merged" && undoRecord.action) undoRecord.action.mergeNextRename = true;
            render(preservedDraft);
            throw error;
          }
          if (!saved) return false;
          if (state.editingWorkNodeTitleId === node.id) state.editingWorkNodeTitleId = "";
          clearDraftControl(input);
          render();
          return true;
        });
      };
      input.addEventListener("keydown", event => {
        if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          saveTitle().catch(console.error);
        }
      });
      input.addEventListener("blur", () => saveTitle().catch(console.error));
    });
    app.querySelectorAll("[data-work-node-add]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() < workTreeSuppressNodeActionUntil) return;
      addWorkTreeNode(button.dataset.workNodeAdd);
    }));
    app.querySelectorAll("[data-work-node-todo]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() < workTreeSuppressNodeActionUntil) return;
      const rect = button.getBoundingClientRect();
      rememberEditorEntry(button);
      state.workTreeContextMenu = { nodeId: button.dataset.workNodeTodo, kind: "task", x: rect.left, y: rect.bottom + 4 };
      render();
      app.querySelector("[data-work-node-menu-action]")?.focus();
    }));
    app.querySelectorAll("[data-work-node-command]").forEach(button => button.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      state.workTreeContextMenu = {
        nodeId: button.dataset.workNodeCommand,
        kind: "node",
        x: event.clientX,
        y: event.clientY
      };
      render();
    }));
    app.querySelector("[data-work-node-menu]")?.addEventListener("keydown", event => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = [...app.querySelectorAll("[data-work-node-menu-action]")];
      const index = items.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    });
    app.querySelectorAll("[data-work-node-menu-action]").forEach(button => button.addEventListener("click", async () => {
      const action = button.dataset.workNodeMenuAction;
      const nodeId = button.dataset.workNodeMenuId;
      state.workTreeContextMenu = null;
      if (action === "add") await addWorkTreeNode(nodeId);
      else if (action === "today") await addWorkNodeToToday(nodeId);
      else if (action === "goal" || action === "flow") await addWorkNodeToToday(nodeId, action);
      else if (action === "toggle") await toggleWorkNodeCollapse(nodeId);
      else if (action === "rename") beginWorkNodeRename(nodeId);
      else if (action === "delete") await softDeleteWorkTreeNode(nodeId);
      else render();
    }));
    app.querySelectorAll("[data-work-node-delete]").forEach(button => button.addEventListener("click", async () => {
      const tree = activeWorkTree();
      const node = tree?.nodes.find(item => item.id === button.dataset.workNodeDelete);
      if (!tree || !node) return;
      const descendants = workTreeDescendantIds(tree, node.id);
      const message = descendants.length ? `确定删除“${node.title}”及其 ${descendants.length} 个子任务？` : `确定删除“${node.title}”？`;
      if (!confirm(message)) return;
      await softDeleteWorkTreeNode(node.id);
    }));
    app.querySelectorAll("[data-work-node-row][data-work-node-folder='true']").forEach(row => row.addEventListener("click", async event => {
      if (workTreeRenameSelectingInput || Date.now() < workTreeSuppressRenameBlurUntil) return;
      if (event.target.closest("button,input,details,summary,[data-work-node-drag]")) return;
      await toggleWorkNodeCollapse(row.dataset.workNodeRow);
    }));
    app.querySelectorAll("[data-work-node-drag]").forEach(handle => {
      handle.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        workTreePointerDragState = {
          nodeId: handle.dataset.workNodeDrag,
          startX: event.clientX,
          startY: event.clientY,
          pointerId: event.pointerId,
          handle,
          dragging: false
        };
        handle.setPointerCapture?.(event.pointerId);
      });
    });
    app.querySelectorAll("[data-work-node-row]").forEach(row => {
      row.addEventListener("dragover", event => {
        if (!workTreeDraggingNodeId || workTreeDraggingNodeId === row.dataset.workNodeRow) return;
        updateWorkTreeDragOverlay(event);
      });
      row.addEventListener("dragleave", () => row.classList.remove("worktree-drop-target"));
      row.addEventListener("drop", event => {
        row.classList.remove("worktree-drop-target");
        if (workTreeDraggingNodeId) resetWorkTreeDragState();
      });
    });
    if (state.workTreeView === "mindmap") {
      const map = app.querySelector("[data-worktree-map]");
      bindWorkTreeMapPan(map);
      bindWorkTreeMapZoom(map);
      if (!window.__xiaoyeWorkTreeLineResizeInstalled) {
        window.__xiaoyeWorkTreeLineResizeInstalled = true;
        window.addEventListener("resize", () => {
          if (state.surface === "worktree" && state.workTreeView === "mindmap") scheduleWorkTreeLines();
        });
      }
      setTimeout(scheduleWorkTreeLines, 0);
      setTimeout(scheduleWorkTreeLines, 120);
    }
  }

  function renderNotes() {
    const folders = state.noteFolders;
    const allFolder = { id: "all", name: "\u5168\u90e8" };
    const notes = visibleNotesForCurrentView();
    return `
      <div class="note-panel-modern">
        <div class="folder-tabs">${folders.map(folder => `<button class="${state.activeFolderId === folder.id ? "active" : ""}" data-folder="${folder.id}">${esc(folder.name)}</button>`).join("")}<button class="add-folder" data-add-folder title="\u65b0\u5efa\u6587\u4ef6\u5939"><span class="app-plus-icon" aria-hidden="true"></span></button><button class="${state.activeFolderId === allFolder.id ? "active" : ""}" data-folder="${allFolder.id}">${esc(allFolder.name)}</button></div>
        ${state.activeFolderId !== "all" ? renderFolderTools() : ""}
        <div class="note-list-modern" data-scroll-key="notesList">${notes.map((note, index) => renderNoteCard(note, index, notes.length)).join("") || (state.showNewNote ? "" : `<div class="empty-row empty-hint">${state.noteFilter === "archived" ? "没有已归档的便签" : "还没有便签<br><kbd>Ctrl</kbd> + <kbd>N</kbd> 新建"}</div>`)}${state.showNewNote ? renderNewNoteCard() : ""}</div>
        <div class="note-bottom-bar"><button data-show-new-note title="新建便签 (Ctrl+N)" aria-label="新建便签"><span class="app-plus-icon" aria-hidden="true"></span></button><button data-note-filter="active" class="${state.noteFilter === "active" ? "active" : ""}">\u5f53\u524d</button><button data-note-filter="archived" class="${state.noteFilter === "archived" ? "active" : ""}">\u5f52\u6863</button></div>
      </div>
    `;
  }

  function visibleNotesForCurrentView() {
    return state.notes
      .filter(note => state.activeFolderId === "all" || note.folderId === state.activeFolderId)
      .filter(note => state.noteFilter === "archived" ? note.archived : !note.archived)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  function normalizeNoteOrders() {
    state.notes = state.notes
      .map((note, index) => ({ note, index, order: Number(note.order) }))
      .sort((a, b) => {
        const aOrder = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
        const bOrder = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
        return aOrder - bOrder || a.index - b.index;
      })
      .map(({ note }, order) => {
        note.order = order;
        return note;
      });
  }

  function renderFolderTools() {
    const folder = state.noteFolders.find(item => item.id === state.activeFolderId);
    if (!folder) return "";
    return `<div class="folder-tools"><input data-folder-name value="${esc(folder.name)}" /><details class="note-folder-menu" data-note-folder-menu><summary title="\u6587\u4ef6\u5939\u83dc\u5355">...</summary><div><button data-duplicate-folder>复制文件夹</button><button class="danger" data-delete-folder>\u5220\u9664\u6587\u4ef6\u5939</button></div></details></div>`;
  }
  function renderNewNoteCard() {
    return `<article class="note-card add-note-card" data-new-note-card><input data-new-note-title placeholder="标题（可留空）" /><textarea data-new-note-body placeholder="直接输入内容，失焦自动保存；Ctrl+Enter 保存，Esc 取消；可粘贴图片"></textarea>${state.pendingNewImages?.length ? `<div class="note-images">${state.pendingNewImages.map((attachment, index) => `<span class="note-image-wrap"><button data-open-pending-image="${index}"><img src="${esc(noteAttachmentThumbnail(attachment))}" alt="pending" loading="lazy" decoding="async" /></button><button class="image-delete" data-delete-pending-image="${index}">&times;</button></span>`).join("")}</div>` : ""}</article>`;
  }

  function noteAttachmentThumbnail(attachment) {
    return attachment && typeof attachment === "object" && /^[a-f0-9]{64}$/i.test(String(attachment.id || ""))
      ? `xiaoye-asset://thumbnail/${attachment.id}`
      : String(attachment || "");
  }

  function renderNoteCard(note, index = 0, total = 1) {
    const archiveLabel = note.archived ? "恢复便签" : "归档便签";
    return `
      <article class="note-card ${state.highlight?.type === "note" && state.highlight.id === note.id ? "highlight" : ""}" data-note-id="${note.id}">
        <header data-note-drag-handle="${note.id}" draggable="true">
          <input data-note-title="${note.id}" value="${esc(note.title)}" />
          <button data-move-note="${note.id}:up" class="row-icon note-card-icon" title="上移" ${index <= 0 ? "disabled" : ""}><span class="note-action-icon up" aria-hidden="true"></span></button>
          <button data-move-note="${note.id}:down" class="row-icon note-card-icon" title="下移" ${index >= total - 1 ? "disabled" : ""}><span class="note-action-icon down" aria-hidden="true"></span></button>
          <details class="note-card-menu" data-note-card-menu>
            <summary class="row-icon note-card-icon" title="便签菜单"><span class="note-action-icon more" aria-hidden="true"></span></summary>
            <div>
              <button data-duplicate-note="${note.id}">复制便签</button>
              <button data-archive-note="${note.id}">${archiveLabel}</button>
              <button class="danger" data-delete-note="${note.id}">删除便签</button>
            </div>
          </details>
        </header>
        <textarea data-note-body="${note.id}" data-scroll-key="noteBody:${note.id}" placeholder="便签内容，可粘贴图片">${esc(note.body)}</textarea>
        ${note.attachments?.length ? `<div class="note-images">${note.attachments.map((attachment, index) => `<span class="note-image-wrap"><button data-open-image="${note.id}:${index}"><img src="${esc(noteAttachmentThumbnail(attachment))}" alt="note image" loading="lazy" decoding="async" /></button><button class="image-delete" data-delete-image="${note.id}:${index}">&times;</button></span>`).join("")}</div>` : ""}
      </article>
    `;
  }

  async function duplicateNote(noteId) {
    if (!noteId || duplicatingNoteId === noteId) return;
    duplicatingNoteId = noteId;
    try {
      normalizeNoteOrders();
      const sourceIndex = state.notes.findIndex(note => note.id === noteId);
      if (sourceIndex < 0) return;
      const source = state.notes[sourceIndex];
      const createdAt = nowIso();
      const copy = {
        ...source,
        id: uid("note"),
        title: nextCopyName(source.title, state.notes.filter(note => note.folderId === source.folderId).map(note => note.title)),
        tags: [...(source.tags || [])],
        attachments: [...(source.attachments || [])],
        order: sourceIndex + 1,
        createdAt,
        updatedAt: createdAt
      };
      state.notes.splice(sourceIndex + 1, 0, copy);
      normalizeNoteOrders();
      pushUndoEntry({ type: "createNote", noteId: copy.id });
      try {
        const saved = await persist();
        if (!saved) {
          state.undoStack = (state.undoStack || []).filter(action => action.type !== "createNote" || action.noteId !== copy.id);
          state.notes = state.notes.filter(note => note.id !== copy.id);
          normalizeNoteOrders();
          return;
        }
        render();
      } catch (error) {
        state.undoStack = (state.undoStack || []).filter(action => action.type !== "createNote" || action.noteId !== copy.id);
        state.notes = state.notes.filter(note => note.id !== copy.id);
        normalizeNoteOrders();
        throw error;
      }
    } finally {
      duplicatingNoteId = "";
    }
  }

  async function duplicateNoteFolder(folderId) {
    const index = state.noteFolders.findIndex(folder => folder.id === folderId);
    if (index < 0) return;
    const source = state.noteFolders[index];
    const previousActiveFolderId = state.activeFolderId;
    const createdAt = nowIso();
    const folder = {
      ...clone(source),
      id: uid("folder"),
      name: nextCopyName(source.name, state.noteFolders.map(item => item.name)),
      order: index + 1,
      createdAt,
      updatedAt: createdAt
    };
    const notes = state.notes
      .filter(note => note.folderId === source.id)
      .map(note => ({ ...clone(note), id: uid("note"), folderId: folder.id, createdAt, updatedAt: createdAt }));
    state.noteFolders.splice(index + 1, 0, folder);
    state.noteFolders.forEach((item, order) => { item.order = order; });
    state.notes.push(...notes);
    state.activeFolderId = folder.id;
    pushUndoEntry({ type: "createFolder", folderId: folder.id, sourceFolderId: source.id, noteIds: notes.map(note => note.id), previousActiveFolderId });
    await persist();
    render();
  }


  function noteTitleFromBody(body) {
    const firstLine = String(body || "").split(/\r?\n/).map(line => line.trim()).find(Boolean) || "";
    return [...firstLine].slice(0, 20).join("") || "\u65b0\u4fbf\u7b7e";
  }

  async function addNote(title, body = "") {
    const clean = title.trim();
    if (!clean || creatingNote) return;
    creatingNote = true;
    try {
      const tags = tagsFrom(clean);
      const folderId = state.activeFolderId === "all" ? (state.noteFolders[0]?.id || "") : state.activeFolderId;
      state.notes.push({ id: uid("note"), title: clean.replace(/\[(.+?)\]/g, "").trim(), body, tags, color: state.settings.eventTodoColor || "#ffd21a", attachments: [...(state.pendingNewImages || [])], folderId, pinned: false, archived: false, order: state.notes.length, createdAt: nowIso(), updatedAt: nowIso() });
      const saved = await persist();
      if (!saved) return;
      clearDraftControls(app.querySelector("[data-new-note-card]"));
      state.pendingNewImages = [];
      state.showNewNote = false;
      render();
    } finally {
      creatingNote = false;
    }
  }

  async function moveNoteInCurrentView(noteId, direction) {
    const notes = visibleNotesForCurrentView();
    const index = notes.findIndex(note => note.id === noteId);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= notes.length) return;
    const note = notes[index];
    const target = notes[targetIndex];
    const order = note.order || 0;
    note.order = target.order || 0;
    target.order = order;
    note.updatedAt = nowIso();
    target.updatedAt = nowIso();
    await persist();
    render();
  }

  function openImageFullscreen(src) {
    if (!src) return;
    window.dayline?.openImagePreview?.(src);
  }

  function closeImageFullscreen() {
    state.lightboxImage = "";
    render();
  }

  function bindNotes() {
    app.querySelectorAll("[data-folder]").forEach(button => {
      button.addEventListener("click", () => {
        if (state.activeFolderId === button.dataset.folder) return;
        state.activeFolderId = button.dataset.folder;
        render();
        persistUiStatePatch({ activeFolderId: state.activeFolderId });
      });
      button.addEventListener("dragover", event => { event.preventDefault(); button.classList.add("hot-drop"); });
      button.addEventListener("dragleave", () => button.classList.remove("hot-drop"));
      button.addEventListener("drop", async event => { event.preventDefault(); button.classList.remove("hot-drop"); const noteId = event.dataTransfer.getData("text/note-id"); if (noteId && button.dataset.folder !== "all") await moveNoteToFolder(noteId, button.dataset.folder); });
    });
    app.querySelector("[data-add-folder]")?.addEventListener("click", async () => { state.noteFolders.push({ id: uid("folder"), name: `\u6587\u4ef6\u5939${state.noteFolders.length + 1}`, order: state.noteFolders.length }); await persist(); render(); });
    bindSelectAllOnFocus(app.querySelector("[data-folder-name]"));
    app.querySelector("[data-folder-name]")?.addEventListener("change", async event => { const folder = state.noteFolders.find(item => item.id === state.activeFolderId); if (!folder) return; folder.name = event.target.value.trim() || folder.name; const saved = await persist(captureEditorDraft(event.target)); if (!saved) return; clearDraftControl(event.target); render(); });
    app.querySelector("[data-duplicate-folder]")?.addEventListener("click", () => duplicateNoteFolder(state.activeFolderId).catch(console.error));
    app.querySelector("[data-delete-folder]")?.addEventListener("click", async () => { const id = state.activeFolderId; state.noteFolders = state.noteFolders.filter(folder => folder.id !== id); state.notes.filter(note => note.folderId === id).forEach(note => { note.folderId = ""; }); state.activeFolderId = "all"; await persist(); render(); });
    app.querySelectorAll("[data-note-filter]").forEach(button => button.addEventListener("click", () => {
      if (state.noteFilter === button.dataset.noteFilter) return;
      state.noteFilter = button.dataset.noteFilter;
      render();
      persistUiStatePatch({ noteFilter: state.noteFilter });
    }));
    app.querySelector("[data-show-new-note]")?.addEventListener("click", () => { state.showNewNote = true; render(); setTimeout(() => selectInputText(app.querySelector("[data-new-note-title]")), 0); });
    bindSelectAllOnFocus(app.querySelector("[data-new-note-title]"));
    const cancelNewNoteIfEmpty = event => {
      if (event.key !== "Escape" || event.isComposing) return false;
      const title = app.querySelector("[data-new-note-title]")?.value.trim();
      const body = app.querySelector("[data-new-note-body]")?.value.trim();
      if (title || body || state.pendingNewImages?.length) return false;
      event.preventDefault();
      event.stopPropagation();
      state.showNewNote = false;
      clearDraftControls(app.querySelector("[data-new-note-card]"));
      render();
      return true;
    };
    app.querySelector("[data-new-note-title]")?.addEventListener("keydown", event => {
      if (cancelNewNoteIfEmpty(event) || event.isComposing) return;
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); addNote(event.target.value || noteTitleFromBody(app.querySelector("[data-new-note-body]")?.value), app.querySelector("[data-new-note-body]")?.value || ""); return; }
      if (event.key === "Enter" || event.key === "ArrowDown") { event.preventDefault(); app.querySelector("[data-new-note-body]")?.focus(); }
    });
    const newNoteCard = app.querySelector("[data-new-note-card]");
    // 只有焦点真正离开新便签卡片时才保存，避免在标题和正文之间切换时提前创建。
    newNoteCard?.addEventListener("focusout", event => {
      if (newNoteCard.contains(event.relatedTarget)) return;
      const title = app.querySelector("[data-new-note-title]")?.value || "";
      const body = app.querySelector("[data-new-note-body]")?.value || "";
      if ((title || body).trim()) addNote(title.trim() || noteTitleFromBody(body), body);
    });
    app.querySelector("[data-new-note-body]")?.addEventListener("keydown", event => {
      if (cancelNewNoteIfEmpty(event)) return;
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); addNote(app.querySelector("[data-new-note-title]")?.value.trim() || noteTitleFromBody(event.target.value), event.target.value); }
    });
    app.querySelector("[data-new-note-body]")?.addEventListener("paste", event => handleNotePaste(event, "new"));
    app.querySelector("[data-new-note-body]")?.addEventListener("contextmenu", event => openNotePasteMenu(event, event.currentTarget, "new"));
    app.querySelectorAll("[data-note-drag-handle]").forEach(handle => handle.addEventListener("dragstart", event => {
      if (event.target.closest("button,details,summary")) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.setData("text/note-id", handle.dataset.noteDragHandle);
    }));
    app.querySelectorAll("[data-note-title], [data-note-body]").forEach(input => input.addEventListener("input", () => {
      if (input.dataset.noteBody && !input.value.trim() && !input.dataset.noteTitle) return;
      clearTimeout(noteAutosaveTimers.get(input));
      noteAutosaveTimers.set(input, setTimeout(async () => {
        const note = state.notes.find(item => item.id === (input.dataset.noteTitle || input.dataset.noteBody));
        if (!note || compositionActive) return;
        if (input.dataset.noteTitle) { if (!input.value.trim()) return; note.title = input.value.trim(); }
        else note.body = input.value;
        note.updatedAt = nowIso();
        const value = input.value;
        const saved = await persist(captureEditorDraft(input));
        if (saved && input.value === value) clearDraftControl(input);
      }, 800));
    }));
    app.querySelectorAll("[data-note-title]").forEach(input => { bindSelectAllOnFocus(input); input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); app.querySelector(`[data-note-body="${CSS.escape(input.dataset.noteTitle)}"]`)?.focus(); } }); input.addEventListener("change", async () => { const note = state.notes.find(item => item.id === input.dataset.noteTitle); if (!note) return; note.title = input.value.trim() || note.title; note.updatedAt = nowIso(); const saved = await persist(captureEditorDraft(input)); if (saved) clearDraftControl(input); }); });
    app.querySelectorAll("[data-note-body]").forEach(input => { input.addEventListener("change", async () => { const note = state.notes.find(item => item.id === input.dataset.noteBody); if (!note) return; note.body = input.value; note.updatedAt = nowIso(); const saved = await persist(captureEditorDraft(input)); if (saved) clearDraftControl(input); }); input.addEventListener("paste", event => handleNotePaste(event, input.dataset.noteBody)); input.addEventListener("contextmenu", event => openNotePasteMenu(event, input, input.dataset.noteBody)); });
    app.querySelector(".note-panel-modern")?.addEventListener("pointerdown", event => {
      const cardMenu = app.querySelector("[data-note-card-menu][open]");
      const folderMenu = app.querySelector("[data-note-folder-menu][open]");
      if (cardMenu && !event.target.closest("[data-note-card-menu]")) cardMenu.removeAttribute("open");
      if (folderMenu && !event.target.closest("[data-note-folder-menu]")) folderMenu.removeAttribute("open");
    }, true);
    app.querySelectorAll("[data-move-note]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;
      const [noteId, direction] = button.dataset.moveNote.split(":");
      moveNoteInCurrentView(noteId, direction).catch(console.error);
    }));
    app.querySelectorAll("[data-duplicate-note]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      duplicateNote(button.dataset.duplicateNote).catch(console.error);
    }));
    app.querySelectorAll("[data-archive-note]").forEach(button => button.addEventListener("click", async () => { const note = state.notes.find(item => item.id === button.dataset.archiveNote); if (!note) return; note.archived = !note.archived; await persist(); render(); }));
    app.querySelectorAll("[data-export-note-card]").forEach(button => button.addEventListener("click", async () => { const note = state.notes.find(item => item.id === button.dataset.exportNoteCard); if (!note) return; const format = confirm("确定导出为 Markdown？\n选择‘取消’将导出为 TXT。") ? "md" : "txt"; await window.dayline?.exportNote?.(note, format); }));
    app.querySelector("[data-export-folder]")?.addEventListener("click", async () => {
      const notes = state.notes.filter(note => state.activeFolderId === "all" || note.folderId === state.activeFolderId);
      const folder = state.noteFolders.find(item => item.id === state.activeFolderId);
      await window.dayline?.exportNoteFolder?.(folder?.name || "全部便签", notes);
    });
    app.querySelectorAll("[data-delete-note]").forEach(button => button.addEventListener("click", async () => { if (!confirm("删除后会进入回收站，确定删除？")) return; await softDelete("note", button.dataset.deleteNote); }));
    app.querySelectorAll("[data-delete-image]").forEach(button => button.addEventListener("click", async event => { event.stopPropagation(); const [noteId, rawIndex] = button.dataset.deleteImage.split(":"); const note = state.notes.find(item => item.id === noteId); if (!note) return; note.attachments = (note.attachments || []).filter((_, index) => index !== Number(rawIndex)); note.updatedAt = nowIso(); await persist(); render(); }));
    app.querySelectorAll("[data-open-image]").forEach(button => button.addEventListener("click", () => { const [noteId, rawIndex] = button.dataset.openImage.split(":"); const note = state.notes.find(item => item.id === noteId); openImageFullscreen(note?.attachments?.[Number(rawIndex)] || ""); }));
    app.querySelectorAll("[data-open-pending-image]").forEach(button => button.addEventListener("click", () => { openImageFullscreen(state.pendingNewImages?.[Number(button.dataset.openPendingImage)] || ""); }));
    app.querySelectorAll("[data-delete-pending-image]").forEach(button => button.addEventListener("click", event => { event.stopPropagation(); state.pendingNewImages = (state.pendingNewImages || []).filter((_, index) => index !== Number(button.dataset.deletePendingImage)); render(); }));
  }
  // 2026 年放假调休：国办发明电〔2025〕7号。
  const holidayPeriods2026 = [
    ["01-01", "01-03", "元旦"], ["02-15", "02-23", "春节"],
    ["04-04", "04-06", "清明节"], ["05-01", "05-05", "劳动节"],
    ["06-19", "06-21", "端午节"], ["09-25", "09-27", "中秋节"],
    ["10-01", "10-07", "国庆节"]
  ];
  const workdays2026 = new Set(["01-04", "02-14", "02-28", "05-09", "09-20", "10-10"]);
  const festivalFormatter = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", { month: "numeric", day: "numeric" });
  function calendarHoliday(day) {
    const md = toDateKey(day).slice(5);
    const fixed = { "01-01": "元旦", "02-14": "情人节", "03-08": "妇女节", "03-12": "植树节", "05-01": "劳动节", "05-04": "青年节", "06-01": "儿童节", "07-01": "建党节", "08-01": "建军节", "09-10": "教师节", "10-01": "国庆节", "12-24": "平安夜", "12-25": "圣诞节" };
    const names = [];
    if (fixed[md]) names.push(fixed[md]);
    if (day.getDay() === 0 && day.getMonth() === 4 && day.getDate() >= 8 && day.getDate() <= 14) names.push("母亲节");
    if (day.getDay() === 0 && day.getMonth() === 5 && day.getDate() >= 15 && day.getDate() <= 21) names.push("父亲节");
    const parts = festivalFormatter.formatToParts(day);
    const month = parts.find(part => part.type === "month")?.value;
    const date = Number(parts.find(part => part.type === "day")?.value);
    const festival = { "1-1": "春节", "1-15": "元宵节", "5-5": "端午节", "7-7": "七夕", "8-15": "中秋节", "9-9": "重阳节", "12-8": "腊八节" }[`${month}-${date}`];
    if (festival) names.push(festival);
    let holiday = null;
    if (day.getFullYear() === 2026) {
      if (workdays2026.has(md)) holiday = { name: "补班", work: true };
      const period = holidayPeriods2026.find(([start, end]) => md >= start && md <= end);
      if (period) holiday = { name: period[2], rest: true };
    }
    if (holiday) return { ...holiday, extra: names.filter(name => name !== holiday.name).join(" · ") };
    return names.length ? { name: names.join(" · ") } : null;
  }

  function renderYearCalendar() {
    const year = state.cursor.getFullYear();
    const today = toDateKey(new Date());
    return `<div class="calendar-year-grid" data-scroll-key="calendarYear">${Array.from({ length: 12 }, (_, month) => {
      const first = new Date(year, month, 1);
      return `<section class="year-month"><button class="year-month-title" data-year-date="${toDateKey(first)}">${month + 1}月</button>
        <div class="year-month-days">${weekNames.map(name => `<span class="year-weekday">${name}</span>`).join("")}${monthDays(first).map(day => {
          if (day.getMonth() !== month) return "<span></span>";
          const key = toDateKey(day);
          const holiday = state.calendarHolidaysVisible ? calendarHoliday(day) : null;
          const count = eventsFor(key).length;
          return `<button class="year-day ${key === today ? "is-today" : ""} ${count ? "has-events" : ""} ${holiday ? holiday.work ? "is-workday" : "is-holiday" : ""}" data-year-date="${key}" title="${key}${holiday ? ` · ${holiday.name}${holiday.rest ? "（休）" : ""}${holiday.extra ? ` · ${holiday.extra}` : ""}` : ""}${count ? ` · ${count}项日程` : ""}">${day.getDate()}${holiday ? `<small>${holiday.work ? "班" : holiday.rest ? "休" : "节"}</small>` : ""}</button>`;
        }).join("")}</div></section>`;
    }).join("")}</div>${state.calendarHolidaysVisible && year !== 2026 ? `<div class="calendar-holiday-note">本年暂未内置放假调休安排，仅显示部分节日。</div>` : ""}`;
  }

  function renderCalendar() {
    const continuous = state.calendarView === "month" && state.calendarContinuous;
    const days = state.calendarView === "week" ? weekDays(state.cursor) : monthDays(state.cursor);
    const label = state.calendarView === "year" ? `${state.cursor.getFullYear()}年` : state.calendarView === "week" ? `${formatDay(days[0])} - ${formatDay(days[days.length - 1])}` : formatMonth(state.cursor);
    const personal = true;
    const showTodos = personal && state.calendarTodoVisible;
    return `
      <div class="calendar-modern ${showTodos ? "with-todos" : "todos-hidden"} ${state.calendarView} ${state.calendarBatchDelete ? "batch-deleting" : ""}">
        ${showTodos ? `<aside class="calendar-todo-edit">${renderTodo({ compact: true })}</aside>` : ""}
        <section class="calendar-board-wrap">
          <div class="calendar-nav calendar-single-row">
            <div class="calendar-title"><button class="calendar-period-btn previous" data-prev-period title="上一周期" aria-label="上一周期"><span class="calendar-period-icon" aria-hidden="true"></span></button><strong>${label}</strong><button class="calendar-period-btn next" data-next-period title="下一周期" aria-label="下一周期"><span class="calendar-period-icon" aria-hidden="true"></span></button></div>
            <button data-today title="跳转到今日" aria-label="跳转到今日">今日</button>
            <button data-schedule-import>识别</button>
            ${state.calendarBatchDelete ? `<div class="calendar-batch-bar" role="group" aria-label="批量删除"><span data-batch-count>已选 ${state.calendarBatchSelected.size}</span><button data-batch-delete-run class="is-destructive" ${state.calendarBatchSelected.size ? "" : "disabled"}>删除</button><button data-batch-delete-exit title="退出批量删除">完成</button></div>` : ""}
            <div class="view-switch mini-switch" style="--index:${["week", "month", "year"].indexOf(state.calendarView)};--count:3">${[["week", "周"], ["month", "月"], ["year", "年"]].map(([view, name]) => `<button data-calendar-view="${view}" class="${state.calendarView === view ? "active" : ""}" aria-pressed="${state.calendarView === view}">${name}</button>`).join("")}</div>
            <button class="calendar-add" data-calendar-add title="新增日程" aria-label="新增日程"><svg class="calendar-tool-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
            <details class="calendar-more"><summary aria-label="更多日历操作" title="更多"><svg class="calendar-tool-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></summary><div class="calendar-more-menu">
            ${personal ? `<button data-toggle-followup class="calendar-goal-toggle ${state.followupVisible ? "active" : ""}" aria-pressed="${state.followupVisible}" title="${state.followupVisible ? "关闭流动浮窗，任务回到今日日程" : "在浮窗显示流动任务"}">流动浮窗</button>` : ""}
            <button data-toggle-batch-delete class="${state.calendarBatchDelete ? "active" : ""}" aria-pressed="${state.calendarBatchDelete}" title="开启后点击日程即可多选，点击日期空白处选中当天全部">批量删除</button>
            <button data-toggle-continuous-months class="${state.calendarContinuous ? "active" : ""}" aria-pressed="${state.calendarContinuous}" title="月与月上下连续滑动，再次点击恢复单月">连续月视图</button>
            <button class="today-widget-chip" data-open-today-widget title="打开今日浮窗" aria-label="打开今日浮窗">今日浮窗<svg class="calendar-tool-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 13h6M7 16h4"/></svg></button>
            <button class="trash-chip" data-calendar-trash title="拖入此处移除日程" aria-label="拖入此处移除日程">拖入以移除日程<svg class="calendar-tool-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/></svg></button>
            ${personal ? `<button class="side-chip" data-toggle-calendar-todos>${state.calendarTodoVisible ? "\u9690\u85cf\u5f85\u529e" : "\u663e\u793a\u5f85\u529e"}</button>
            <button class="reopen-todo-chip ${state.settings.reopenTodoAfterDrop ? "active" : ""}" data-toggle-reopen-todo-after-drop title="连续拖入：拖放后继续显示待办" aria-label="连续拖入">连续拖入<span class="reopen-todo-icon" aria-hidden="true"></span></button>` : ""}
            <button data-toggle-holidays aria-pressed="${state.calendarHolidaysVisible}" aria-label="显示节假日" class="holiday-toggle ${state.calendarHolidaysVisible ? "active" : ""}" title="${state.calendarHolidaysVisible ? "隐藏" : "显示"}节假日">节假日</button>
            </div></details>
          </div>
          <div class="calendar-content-row"><div class="calendar-date-board">
          ${state.calendarView === "year" ? renderYearCalendar() : `<div class="calendar-weekdays">${weekNames.map(day => `<span>${day}</span>`).join("")}</div>
          ${continuous ? renderContinuousMonths() : `<div class="calendar-grid" data-scroll-key="calendarGrid">${days.map(renderCalendarCell).join("")}</div><span data-calendar-scroll-hint hidden aria-hidden="true">向下滚动查看日程</span>`}`}
          </div>
          ${personal && state.followupVisible ? renderFollowupFloat() : ""}
          </div>
        </section>
        ${state.editingEventId ? renderEventEditor() : ""}
      </div>
    `;
  }

  function renderContinuousMonths() {
    if (!continuousMonthStart || calendarRevealDate || state.cursor < continuousMonthStart || state.cursor >= addMonthsClamped(continuousMonthStart, 9)) {
      continuousMonthStart = new Date(state.cursor.getFullYear(), state.cursor.getMonth() - 4, 1);
    }
    return `<div class="calendar-grid continuous-months" data-scroll-key="calendarContinuous">${Array.from({ length: 9 }, (_, index) => renderContinuousMonth(addMonthsClamped(continuousMonthStart, index))).join("")}</div>`;
  }

  function renderContinuousMonth(month) {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return `<section data-continuous-month="${toDateKey(first)}" aria-label="${formatMonth(first)}" style="--month-start-column:${(first.getDay() + 6) % 7 + 1}"><div class="continuous-month-grid">${Array.from({ length: count }, (_, index) => renderCalendarCell(addDays(first, index))).join("")}</div></section>`;
  }

  function continuousCalendarAnchor(grid) {
    if (!grid?.clientHeight) return null;
    const top = grid.getBoundingClientRect().top;
    const cell = Array.from(grid.querySelectorAll("[data-date]")).find(cell => cell.getBoundingClientRect().bottom > top + 8);
    return cell ? { date: cell.dataset.date, offset: cell.getBoundingClientRect().top - top } : null;
  }

  function restoreContinuousCalendarAnchor(grid, anchor) {
    const cell = anchor && grid?.querySelector(`[data-date="${anchor.date}"]`);
    if (cell) grid.scrollTop += cell.getBoundingClientRect().top - grid.getBoundingClientRect().top - anchor.offset;
  }

  function bindContinuousCalendar(grid) {
    let scheduled = false;
    let previousAnchorDate = "";
    const update = () => {
      scheduled = false;
      if (!grid.isConnected || !grid.clientHeight) return;
      const anchor = continuousCalendarAnchor(grid);
      const atStart = grid.scrollTop < grid.clientHeight;
      const atEnd = grid.scrollHeight - grid.scrollTop - grid.clientHeight < grid.clientHeight;
      if (atStart || atEnd) {
        const edge = atStart ? grid.firstElementChild : grid.lastElementChild;
        const month = addMonthsClamped(parseDate(edge.dataset.continuousMonth), atStart ? -1 : 1);
        const added = document.createElement("template");
        added.innerHTML = renderContinuousMonth(month);
        bindCalendarDates(added.content);
        if (atStart) grid.prepend(added.content);
        else grid.append(added.content);
        if (grid.children.length > 9) (atStart ? grid.lastElementChild : grid.firstElementChild).remove();
        continuousMonthStart = parseDate(grid.firstElementChild.dataset.continuousMonth);
        restoreContinuousCalendarAnchor(grid, anchor);
      }
      const current = anchor && grid.querySelector(`[data-date="${anchor.date}"]`);
      const changedRow = previousAnchorDate && previousAnchorDate !== anchor?.date;
      previousAnchorDate = anchor?.date || "";
      if (current && changedRow && toDateKey(state.cursor).slice(0, 7) !== current.dataset.date.slice(0, 7)) {
        state.cursor = parseDate(current.dataset.date);
        app.querySelector(".calendar-title strong").textContent = formatMonth(state.cursor);
        persistUiStatePatch({ cursor: toDateKey(state.cursor) });
      }
      if (current && !grid.querySelector(`[data-date="${state.selectedDate}"]`)) {
        state.selectedDate = current.dataset.date;
        current.tabIndex = 0;
      }
    };
    grid.addEventListener("scroll", () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(update);
    }, { passive: true });
    requestAnimationFrame(update);
  }

  function renderCalendarCell(day) {
    const key = toDateKey(day);
    const holiday = state.calendarHolidaysVisible ? calendarHoliday(day) : null;
    const events = eventsFor(key);
    const outside = state.calendarView === "month" && !state.calendarContinuous && day.getMonth() !== state.cursor.getMonth();
    const focusDate = state.calendarView === "month" && state.calendarContinuous ? state.selectedDate : state.calendarView === "week" ? (weekDays(state.cursor).some(date => toDateKey(date) === state.selectedDate) ? state.selectedDate : toDateKey(state.cursor)) : state.selectedDate.slice(0, 7) === toDateKey(state.cursor).slice(0, 7) ? state.selectedDate : toDateKey(new Date(state.cursor.getFullYear(), state.cursor.getMonth(), 1));
    return `
      <div class="calendar-cell ${outside ? "outside" : ""} ${key === toDateKey(new Date()) ? "is-today" : ""}" data-date="${key}" tabindex="${key === focusDate ? 0 : -1}" role="group" aria-label="${key}，${events.length} 项日程，方向键选日期，Enter 新增" style="--event-rows:${Math.max(1, events.length)}">
        <div class="cell-date"><b>${day.getDate()}${state.calendarView === "month" && state.calendarContinuous && day.getDate() === 1 ? `<small class="continuous-month-label">${day.getMonth() + 1}月</small>` : ""}</b><span>${key === toDateKey(new Date()) ? "今天" : lunarLabel(day)}</span></div>
        <div class="event-stack">${events.map(renderEventPill).join("")}</div>
        ${holiday ? `<div class="calendar-holiday-footer"><div class="calendar-holiday ${holiday.work ? "workday" : ""}">${holiday.name}${holiday.rest ? " · 休" : ""}</div>${holiday.extra ? `<div class="calendar-holiday">${holiday.extra}</div>` : ""}</div>` : ""}
      </div>
    `;
  }

  function renderFollowupFloat() {
    const tasks = state.events.filter(event => event.ongoing && !event.completed && !event.followupInCalendar)
      .sort((a, b) => (Number(b.priority) || 2) - (Number(a.priority) || 2));
    const { x, y } = state.followupPosition;
    return `<div class="followup-corner" style="left:${x * 100}%;top:${y * 100}%;transform:translate(${-x * 100}%,${-y * 100}%)"><aside class="followup-float" aria-label="流动任务">
      <header data-drag-followup title="拖动浮窗"><b>流动 <small>${tasks.length}</small></b><button data-hide-followup title="关闭浮窗，流动任务回到今日日程" aria-label="关闭浮窗并回到日程"><span data-ui-icon="x" aria-hidden="true"></span></button></header>
      <div class="followup-items" data-scroll-key="followupFloat">${tasks.length ? tasks.map(event => `<div class="followup-item">
        <button class="followup-complete" data-complete-followup="${esc(event.id)}" aria-label="完成 ${esc(event.title)}"></button>
        <button class="followup-task" data-edit-event="${esc(event.id)}" data-occurrence-date="${toDateKey(new Date())}" title="${esc(event.title)}${event.progress ? `-${esc(event.progress)}` : ""}">${esc(event.title)}${event.progress ? `<span>-${esc(event.progress)}</span>` : ""}</button>
        <button class="followup-return" data-return-followup="${esc(event.id)}" title="在今日日程中显示">回日程</button>
      </div>`).join("") : `<p class="followup-empty">暂无流动任务</p>`}</div>
    </aside></div>`;
  }

  function renderEventPill(event) {
    const overdue = isEventOverdue(event);
    let color = overdue ? "#ff4d4f" : event.completed ? (state.settings.eventDoneColor || "#78d68f") : (event.color || state.settings.eventTodoColor || "#ffd21a");
    if (event.subscription) color = event.subscription.markedExpired ? '#ff4d4f' : event.color || '#ba68c8';
    const baseId = event.baseEventId || event.id;
    const title = event.subscription ? window.AccountSubscription.label(event.title, event.subscription, toDateKey(new Date())) : taskTitle(event);
    let labelHtml = esc(title);
    let description = title;
    if (event.subscription) {
      const stats = window.AccountSubscription.badge(event.subscription, toDateKey(new Date()));
      labelHtml = `<span class="subscription-name">${esc(event.title)}</span>${stats.text ? `<em class="subscription-badge ${stats.level}">${esc(stats.text)}</em>` : ''}`;
      const extras = (event.subscription.extraAccounts || []).map(item => `${item.name}：${item.value}`);
      description = [`${event.title}`, `${stats.remaining < 0 ? `已过期${-stats.remaining}天` : stats.remaining === 0 ? '今日到期' : `剩余${stats.remaining}天`}（${event.subscription.expiresOn}到期）`, `已连续使用${stats.continuous}天`, event.subscription.markedExpired ? '已标记到期' : '', event.subscription.account ? `账号：${event.subscription.account}` : '', ...extras].filter(Boolean).join(' · ');
    }
    return `
      <button class="event-pill ${event.completed ? "done" : ""} ${overdue ? "overdue" : ""} ${event.virtual ? "virtual" : ""} ${state.highlight?.type === "event" && state.highlight.id === baseId ? "highlight" : ""} ${state.calendarBatchDelete && state.calendarBatchSelected.has(`${baseId}|${event.date}`) ? "batch-selected" : ""}" data-edit-event="${baseId}" data-occurrence-date="${event.date}" draggable="true" style="--event-color:${color}">
        <span>${event.startTime ? esc(event.startTime) : ""}</span><b${event.subscription ? ` data-account-label="${esc(event.id)}" title="${esc(description)}" aria-label="${esc(description)}"` : ''}>${labelHtml}${event.ongoing && event.progress ? ` · ${esc(event.progress)}` : ""}${event.virtual && !event.ongoing ? " ↻" : ""}</b>
      </button>
    `;
  }

  function currentEditingEvent() {
    return state.events.find(item => item.id === state.editingEventId) || (state.pendingEventDraft?.id === state.editingEventId ? state.pendingEventDraft : null);
  }

  function repeatSourceForEvent(event) {
    if (!state.calendarLinkedEdit || normalizeRepeat(event.repeat) !== "none") return event;
    const family = state.events.filter(item => window.EventState.sameSeries(item, event) && normalizeRepeat(item.repeat) !== "none");
    const parent = event.repeatParentId || event.id;
    const date = event.repeatOccurrenceDate || event.date;
    const roots = family.filter(item => (item.repeatParentId || item.id) === parent);
    return roots.find(item => item.date <= date && (!item.repeatEndDate || item.repeatEndDate >= date)) || roots[0] || family[0] || event;
  }

  function renderEventColorPresets(value) {
    const custom = Array.isArray(state.settings.eventCustomColors) ? state.settings.eventCustomColors : [];
    const colors = [...new Set([...eventColorPresets.map(([color]) => color), ...custom, value].filter(color => typeof color === "string" && /^#[\da-f]{6}$/i.test(color)).map(color => color.toLowerCase()))];
    return colors.map(color => {
      const name = eventColorPresets.find(([preset]) => preset === color)?.[1] || `自定义颜色 ${color}`;
      return `<button type="button" data-event-color-preset="${color}" aria-label="${name}" title="${name}" aria-pressed="${value.toLowerCase() === color}" style="--preset:${color}" class="${value.toLowerCase() === color ? "active" : ""}"></button>`;
    }).join("");
  }

  function refreshEventColorControls() {
    const options = app.querySelector(".event-color-options"), input = app.querySelector("[data-event-color]");
    if (options && input) options.innerHTML = renderEventColorPresets(input.value);
  }

  function renderEventEditor() {
    const event = currentEditingEvent();
    if (!event) return "";
    const personal = true;
    const repeatSource = repeatSourceForEvent(event);
    const singleOccurrence = !event.__draft && !state.calendarLinkedEdit && window.EventState.isSeriesEvent(state.events, event);
    const occurrence = state.editingOccurrenceDate && state.editingOccurrenceDate !== event.date ? state.editingOccurrenceDate : "";
    return `
      <section class="event-editor" data-event-editor role="region" aria-labelledby="event-editor-heading">
        <div class="editor-head"><b id="event-editor-heading">日程${occurrence ? ` · ${occurrence}` : ""}</b>${personal ? window.AccountSubscriptionEditor.kindControl(event) : ''}<button data-close-event-editor aria-label="关闭日程编辑"><span data-ui-icon="x" aria-hidden="true"></span></button></div>
        <div class="subscription-title-row"><input data-event-title value="${esc(event.title)}" placeholder="日程标题" aria-label="日程标题" />${window.AccountSubscriptionEditor.displayControl(event)}</div>
        ${personal ? `${renderTaskOptions("event", { ...event, ...(state.todos.find(todo => todo.id === event.todoId) || {}) })}${window.AccountSubscriptionEditor.render(event, toDateKey(new Date()))}<label class="event-task-choice" hidden><input type="checkbox" data-event-ongoing ${event.ongoing ? "checked" : ""} />流动任务</label>
        <div class="event-task-fields" data-event-task-fields ${event.ongoing ? "" : "hidden"}><input data-event-progress value="${esc(event.progress || "")}" placeholder="进度：例如实验中、修改中" /><label>优先级<select data-event-priority>${[[3, "高"], [2, "普通"], [1, "低"]].map(([value, label]) => `<option value="${value}" ${(Number(event.priority) || 2) === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label class="event-status-option"><input type="checkbox" data-followup-in-calendar ${event.followupInCalendar ? "checked" : ""} /><span>在日程显示</span></label></div>` : ""}
        <div class="editor-stack">
          <label>日期<input type="date" data-event-date value="${occurrence || event.date}" /></label>
          <label>时间<input type="time" data-event-time value="${event.startTime || ""}" /></label>
          <label>结束<input type="time" data-event-end-time value="${esc(event.endTime || "")}" /></label>
          <label>地点<input data-event-location value="${esc(event.location || "")}" /></label>
          <label class="event-link-field">链接<div class="event-link-input"><input type="url" data-event-url value="${esc(event.url || "")}" placeholder="输入、粘贴或拖入网页链接" /><button type="button" data-open-event-url ${window.EventAddress.webUrl(event.url || "") ? "" : "disabled"}>打开</button></div></label>
          <label title="修改整组重复规则请开启关联">重复<select data-event-repeat ${singleOccurrence ? "disabled" : ""}>${["none", "daily", "workdays", "weekly", "monthly", "yearly"].map(value => `<option value="${value}" ${value === (singleOccurrence ? "none" : normalizeRepeat(repeatSource.repeat)) ? "selected" : ""}>${repeatLabel(value)}</option>`).join("")}</select></label>
          <label title="修改整组重复规则请开启关联">重复截至<input type="date" data-event-repeat-end ${singleOccurrence ? "disabled" : ""} value="${singleOccurrence ? "" : repeatSource.repeatEndDate || ""}" /></label>
        </div>
        <div class="event-status-row"><div class="event-status-options">${event.__draft ? "" : `<label class="event-status-option"><input type="checkbox" data-event-completed ${window.EventState.occurrenceCompleted(event, state.editingOccurrenceDate || event.date) ? "checked" : ""} /><span>已完成</span></label>`}
        ${!event.__draft && window.EventState.isSeriesEvent(state.events, event) ? `<label class="event-status-option" title="勾选后拖动和编辑整组课程；取消后只调整本次"><input type="checkbox" data-editor-linked ${state.calendarLinkedEdit ? "checked" : ""} /><span>关联</span></label>` : ""}</div>
        <div class="event-color-picker"><span class="event-color-label">颜色</span><div class="event-color-options">${renderEventColorPresets(event.color || state.settings.eventTodoColor || "#ffd21a")}</div><label class="event-palette-toggle" title="调色板：新颜色会自动加入色块"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18h1.5a2.5 2.5 0 0 0 1.7-4.3 1 1 0 0 1 .7-1.7H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8Z"/><circle cx="7.5" cy="10.5" r=".8"/><circle cx="10" cy="6.8" r=".8"/><circle cx="14.5" cy="7" r=".8"/><circle cx="17" cy="10.5" r=".8"/></svg><input type="color" data-custom-event-color aria-label="调色板，选择并记住新颜色" value="${state.settings.eventLastCustomColor || event.color || state.settings.eventTodoColor || "#ffd21a"}" /></label><input type="hidden" data-event-color value="${event.color || state.settings.eventTodoColor || "#ffd21a"}" /></div>
        </div><details ${event.note ? "open" : ""}><summary>备注</summary><textarea data-event-note placeholder="备注">${esc(event.note || "")}</textarea></details>
        <p data-event-error data-editor-status role="status" hidden></p>
        <div class="editor-actions editor-actions-two"><button data-save-event>保存</button><button data-delete-event class="${event.__draft ? "" : "is-destructive"}">${event.__draft ? "取消" : "删除"}</button></div>
      </section>
    `;
  }

  function bindCalendar() {
    bindTodo();
    const float = app.querySelector(".followup-corner");
    const handle = app.querySelector("[data-drag-followup]");
    let floatDrag = null;
    handle?.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest("button")) return;
      event.preventDefault();
      const bounds = float.getBoundingClientRect();
      const parent = float.parentElement.getBoundingClientRect();
      floatDrag = { pointerId: event.pointerId, dx: event.clientX - bounds.left, dy: event.clientY - bounds.top, parent, width: bounds.width, height: bounds.height };
      handle.setPointerCapture(event.pointerId);
    });
    handle?.addEventListener("pointermove", event => {
      if (!floatDrag || event.pointerId !== floatDrag.pointerId) return;
      const { parent, dx, dy, width, height } = floatDrag;
      const x = Math.max(0, Math.min(1, (event.clientX - parent.left - dx) / Math.max(1, parent.width - width)));
      const y = Math.max(0, Math.min(1, (event.clientY - parent.top - dy) / Math.max(1, parent.height - height)));
      state.followupPosition = { x, y };
      float.style.left = `${x * 100}%`;
      float.style.top = `${y * 100}%`;
      float.style.transform = `translate(${-x * 100}%,${-y * 100}%)`;
    });
    handle?.addEventListener("lostpointercapture", () => {
      if (!floatDrag) return;
      floatDrag = null;
      persistUiStatePatch({ followupPosition: state.followupPosition });
    });
    app.querySelectorAll("[data-toggle-followup], [data-hide-followup]").forEach(button => button.addEventListener("click", () => {
      state.followupVisible = !state.followupVisible;
      render();
      persistUiStatePatch({ followupVisible: state.followupVisible });
    }));
    app.querySelectorAll("[data-return-followup], [data-complete-followup]").forEach(button => button.addEventListener("click", async () => {
      const event = state.events.find(item => item.id === (button.dataset.returnFollowup || button.dataset.completeFollowup));
      if (!event) return;
      if (button.dataset.returnFollowup) event.followupInCalendar = true;
      else {
        window.EventState.setEventCompleted(event, true, toDateKey(new Date()));
        const todo = state.todos.find(item => item.id === event.todoId);
        if (todo) { todo.completed = true; syncTodoEventStatus(todo); }
      }
      event.updatedAt = nowIso();
      await persist();
      render();
    }));
    app.querySelector("[data-schedule-import]")?.addEventListener("click", () => openScheduleImport());
    app.querySelector("[data-calendar-add]")?.addEventListener("click", event => { event.stopPropagation(); rememberEditorEntry(event.currentTarget); createEvent(toDateKey(state.cursor)); });
    const calendarMore = app.querySelector(".calendar-more");
    calendarMore?.querySelector(".calendar-more-menu")?.addEventListener("click", () => { calendarMore.open = false; });
    calendarMore?.addEventListener("keydown", event => { if (event.key === "Escape") calendarMore.open = false; });
    calendarMore?.addEventListener("focusout", event => { if (event.relatedTarget && !calendarMore.contains(event.relatedTarget)) calendarMore.open = false; });
    calendarMore?.querySelector("summary")?.addEventListener("dragenter", () => { calendarMore.open = true; });

    app.querySelector("[data-toggle-batch-delete]")?.addEventListener("click", () => setBatchDelete(!state.calendarBatchDelete));
    app.querySelector("[data-batch-delete-exit]")?.addEventListener("click", () => setBatchDelete(false));
    app.querySelector("[data-batch-delete-run]")?.addEventListener("click", () => deleteBatchSelection().catch(console.error));
    app.querySelector("[data-open-today-widget]")?.addEventListener("click", () => window.dayline?.openTodayWidget?.());
    app.querySelector("[data-toggle-calendar-todos]")?.addEventListener("click", () => { state.calendarTodoVisible = !state.calendarTodoVisible; render(); persistUiStatePatch({ calendarTodoVisible: state.calendarTodoVisible }); });
    app.querySelector("[data-toggle-reopen-todo-after-drop]")?.addEventListener("click", async () => {
      state.settings.reopenTodoAfterDrop = !state.settings.reopenTodoAfterDrop;
      await persist();
      render();
    });
    app.querySelector("[data-toggle-holidays]")?.addEventListener("click", () => { state.calendarHolidaysVisible = !state.calendarHolidaysVisible; render(); persistUiStatePatch({ calendarHolidaysVisible: state.calendarHolidaysVisible }); });
    app.querySelector("[data-toggle-continuous-months]")?.addEventListener("click", () => {
      state.calendarContinuous = !state.calendarContinuous;
      state.calendarView = "month";
      calendarRevealDate = toDateKey(state.cursor);
      render();
      persistUiStatePatch({ calendarView: state.calendarView, calendarContinuous: state.calendarContinuous });
    });
    app.querySelectorAll("[data-year-date]").forEach(button => button.addEventListener("click", () => { state.cursor = parseDate(button.dataset.yearDate); state.selectedDate = button.dataset.yearDate; calendarRevealDate = state.selectedDate; state.calendarView = "month"; render(); persistUiStatePatch({ cursor: toDateKey(state.cursor), calendarView: "month" }); }));
    app.querySelector("[data-prev-period]")?.addEventListener("click", () => { state.cursor = state.calendarView === "week" ? addDays(state.cursor, -7) : addMonthsClamped(state.cursor, state.calendarView === "year" ? -12 : -1); if (state.calendarView === "month" && state.calendarContinuous) calendarRevealDate = toDateKey(new Date(state.cursor.getFullYear(), state.cursor.getMonth(), 1)); render(); persistUiStatePatch({ cursor: toDateKey(state.cursor) }); });
    app.querySelector("[data-next-period]")?.addEventListener("click", () => { state.cursor = state.calendarView === "week" ? addDays(state.cursor, 7) : addMonthsClamped(state.cursor, state.calendarView === "year" ? 12 : 1); if (state.calendarView === "month" && state.calendarContinuous) calendarRevealDate = toDateKey(new Date(state.cursor.getFullYear(), state.cursor.getMonth(), 1)); render(); persistUiStatePatch({ cursor: toDateKey(state.cursor) }); });
    app.querySelector("[data-today]")?.addEventListener("click", event => { event.stopPropagation(); showCalendarToday(); });
    app.querySelectorAll("[data-calendar-view]").forEach(button => button.addEventListener("click", () => {
      const viewOrder = ["week", "month", "year"];
      const previousIndex = viewOrder.indexOf(state.calendarView);
      if (button.dataset.calendarView === state.calendarView) return;
      state.calendarView = button.dataset.calendarView;
      calendarRevealDate = toDateKey(state.cursor);
      render();
      const viewSwitch = app.querySelector(".calendar-nav > .view-switch.mini-switch");
      viewSwitch?.style.setProperty("--index", previousIndex);
      if (viewSwitch) {
        getComputedStyle(viewSwitch, "::before").transform;
        requestAnimationFrame(() => {
          if (viewSwitch.isConnected) viewSwitch.style.setProperty("--index", viewOrder.indexOf(state.calendarView));
        });
      }
      persistUiStatePatch({ calendarView: state.calendarView });
    }));
    const trash = app.querySelector("[data-calendar-trash]");
    trash?.addEventListener("dragover", event => { event.preventDefault(); trash.classList.add("hot-drop"); });
    trash?.addEventListener("dragleave", () => trash.classList.remove("hot-drop"));
    trash?.addEventListener("drop", async event => { event.preventDefault(); trash.classList.remove("hot-drop"); const eventId = event.dataTransfer.getData("text/event-id"); const todoId = event.dataTransfer.getData("text/todo-id"); if (eventId) { const source = state.events.find(item => item.id === eventId); if (source) { const target = eventForScope(source, event.dataTransfer.getData("text/occurrence-date") || source.date, "single"); await removeEventFromCalendar(target.id); } } else if (todoId) await unscheduleTodo(todoId); restoreCalendarTodoDrawer(); });
    bindCalendarDates(app.querySelector(".calendar-content-row"));
    if (state.calendarView === "month" && state.calendarContinuous) {
      bindContinuousCalendar(app.querySelector(".continuous-months"));
    } else if (state.calendarView === "month") {
      const grid = app.querySelector(".calendar-grid");
      sizeMonthCalendar(grid);
      monthCalendarResizeObserver = new ResizeObserver(() => sizeMonthCalendar(grid));
      monthCalendarResizeObserver.observe(grid);
    }
    bindEventEditor();
  }

  function readEventAddress(transfer) {
    let text = transfer?.getData("text/plain") || "";
    const moz = transfer?.getData("text/x-moz-url") || "";
    const html = transfer?.getData("text/html") || (/^\s*</.test(text) ? text : "");
    let url = "", title = "", location = "";
    if (html) {
      const source = document.createElement("template");
      source.innerHTML = html;
      source.content.querySelectorAll("script, style").forEach(node => node.remove());
      const anchor = source.content.querySelector("a[href]");
      const place = source.content.querySelector("location[label], [data-address]");
      url = anchor?.getAttribute("href") || source.content.querySelector("appmsg > url")?.textContent || "";
      title = anchor?.textContent?.trim() || source.content.querySelector("appmsg > title")?.textContent?.trim() || place?.getAttribute("poiname") || "";
      location = place?.getAttribute("label") || place?.getAttribute("data-address") || "";
      if (!text || /^\s*</.test(text)) text = source.content.textContent.trim();
    }
    if (!text && moz) text = moz;
    return window.EventAddress.parse({ text, uri: transfer?.getData("text/uri-list") || moz.split(/\r?\n/)[0], url, title, location });
  }

  function bindCalendarDates(container) {
    container.querySelectorAll("[data-date]").forEach(cell => {
      cell.addEventListener("dragover", event => { event.preventDefault(); cell.classList.add("hot-drop"); });
      cell.addEventListener("dragleave", () => cell.classList.remove("hot-drop"));
      cell.addEventListener("drop", async event => {
        event.preventDefault();
        cell.classList.remove("hot-drop");
        const eventId = event.dataTransfer.getData("text/event-id");
        const todoId = event.dataTransfer.getData("text/todo-id");
        if (eventId) await moveEvent(eventId, cell.dataset.date, event.dataTransfer.getData("text/occurrence-date"));
        else if (todoId) await scheduleTodo(todoId, cell.dataset.date);
        else {
          const address = readEventAddress(event.dataTransfer);
          if (!address) { showSaveProblem("未读到网页链接或地点文字，请复制后粘贴到日程中。"); return; }
          if (state.editingEventId) { showSaveProblem("请先保存或关闭当前日程，再拖入新地址。"); return; }
          rememberEditorEntry(cell);
          await createEvent(cell.dataset.date, address);
        }
        restoreCalendarTodoDrawer();
      });
      cell.addEventListener("dblclick", event => { if (!state.calendarBatchDelete && !event.target.closest("[data-edit-event]")) { rememberEditorEntry(cell); createEvent(cell.dataset.date); } });
      cell.addEventListener("click", event => {
        if (!state.calendarBatchDelete || event.target.closest("[data-edit-event], button, input")) return;
        toggleBatchSelection([...cell.querySelectorAll(".event-pill[data-edit-event]")]);
      });
      cell.addEventListener("keydown", event => {
        if (event.target !== cell) return;
        if (event.key === "Enter") { event.preventDefault(); rememberEditorEntry(cell); createEvent(cell.dataset.date); return; }
        const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
        if (!offset) return;
        const target = app.querySelector(`.calendar-cell[data-date="${toDateKey(addDays(parseDate(cell.dataset.date), offset))}"]`);
        if (!target) return;
        event.preventDefault();
        app.querySelectorAll(".calendar-cell").forEach(day => { day.tabIndex = day === target ? 0 : -1; });
        state.selectedDate = target.dataset.date;
        target.focus();
      });
    });
    container.querySelectorAll("[data-edit-event]").forEach(button => {
      button.addEventListener("dragstart", event => { event.dataTransfer.setData("text/event-id", button.dataset.editEvent); event.dataTransfer.setData("text/occurrence-date", button.dataset.occurrenceDate); });
      button.addEventListener("click", () => {
        if (state.calendarBatchDelete && !button.classList.contains("followup-task")) { toggleBatchSelection([button]); return; }
        rememberEditorEntry(button); state.editingEventId = button.dataset.editEvent; state.editingOccurrenceDate = button.dataset.occurrenceDate || ""; render();
      });
    });
  }

  function sizeMonthCalendar(grid) {
    if (!grid?.isConnected || state.calendarView !== "month") return;
    const height = grid.clientHeight;
    if (height <= 0) return;
    const first = startOfWeek(new Date(state.cursor.getFullYear(), state.cursor.getMonth(), 1));
    const last = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + 1, 0);
    const monthRows = Math.ceil((Math.round((last - first) / 86400000) + 1) / 7);
    const top = grid.firstElementChild.getBoundingClientRect().top;
    const monthHeight = grid.children[monthRows * 7 - 1].getBoundingClientRect().bottom - top;
    let count = monthRows * 7;
    for (let row = monthRows; row < grid.children.length / 7; row++) {
      if (grid.children[row * 7].getBoundingClientRect().top - top >= height) break;
      count += 7;
    }
    while (grid.children.length > count) grid.lastElementChild.remove();
    while (grid.lastElementChild.getBoundingClientRect().bottom - top < height) {
      const added = document.createElement("template");
      added.innerHTML = Array.from({ length: 7 }, (_, index) => renderCalendarCell(addDays(first, grid.children.length + index))).join("");
      bindCalendarDates(added.content);
      grid.append(added.content);
    }
    for (let row = monthRows; row < grid.children.length / 7; row++) {
      const bounds = grid.children[row * 7].getBoundingClientRect();
      const visible = Math.min(1, Math.max(0, (height - (bounds.top - top)) / bounds.height));
      for (let column = 0; column < 7; column++) grid.children[row * 7 + column].style.opacity = String(.38 * visible);
    }
    grid.classList.toggle("month-scrollable", monthHeight > height);
    if (monthHeight <= height) grid.scrollTop = 0;
    const updateHint = () => {
      const hint = app.querySelector("[data-calendar-scroll-hint]");
      if (hint) hint.hidden = !grid.classList.contains("month-scrollable") || grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 2;
    };
    grid.onscroll = updateHint;
    updateHint();
  }

  function openScheduleImport(imageFile) {
    if (document.querySelector(".schedule-import")) return;
    const calendarId = "self";
    window.ScheduleImport.open({
      calendarId, imageFile,
      existing: () => state.events,
      save: async drafts => {
        const items = drafts.map(draft => ({ ...draft, calendarId, id: uid("event"), color: state.settings.eventTodoColor, completed: false, reminderAt: "", reminderLead: "none", createdAt: nowIso(), updatedAt: nowIso() }));
        state.events.push(...items);
        try {
          const saved = await persist();
          if (!saved) {
            const ids = new Set(items.map(item => item.id));
            state.events = state.events.filter(item => !ids.has(item.id));
            return false;
          }
          state.pendingEventDraft = null;
          state.editingEventId = "";
          state.editingOccurrenceDate = "";
          state.cursor = parseDate(items[0].date);
          render();
          return true;
        } catch (error) {
          const ids = new Set(items.map(item => item.id));
          state.events = state.events.filter(item => !ids.has(item.id));
          throw error;
        }
      }
    });
  }


  function nextTodoScheduleDate(todoId) {
    const dates = sortedTodoEvents(todoId).map(event => event.date);
    if (!dates.length) return "";
    const today = toDateKey(new Date());
    return dates.find(date => date >= today) || dates[dates.length - 1];
  }

  function refreshTodoSchedule(todoId, { preserveManualTarget = false } = {}) {
    const todo = state.todos.find(item => item.id === todoId);
    if (!todo) return;
    const linked = state.events.filter(event => event.todoId === todoId);
    const nextDate = nextTodoScheduleDate(todoId);
    if (nextDate || !preserveManualTarget) todo.targetDate = nextDate;
    todo.scheduledEventId = linked[0]?.id || "";
    todo.updatedAt = nowIso();
  }

  function syncLinkedEventCompletion(todo) {
    const linked = state.events.filter(event => event.todoId === todo.id);
    const hasSeries = linked.some(event => window.EventState.isSeriesEvent(state.events, event));
    const today = toDateKey(new Date());
    if (!hasSeries) linked.forEach(event => window.EventState.setEventCompleted(event, todo.completed, today));
    else if (Boolean(todo.completed) !== window.EventState.linkedTodoCompleted(state.events, todo.id, nextRepeatDate)) {
      const date = todo.targetDate && linked.some(event => eventOccursOnDate(event, todo.targetDate)) ? todo.targetDate : today;
      linked.forEach(source => {
        if (window.EventState.isSeriesEvent(state.events, source)) {
          if (!eventOccursOnDate(source, date)) return;
          const event = eventForScope(source, date, "single");
          window.EventState.setEventCompleted(event, todo.completed, today);
        } else window.EventState.setEventCompleted(source, todo.completed, today);
      });
      todo.completed = window.EventState.linkedTodoCompleted(state.events, todo.id, nextRepeatDate);
    }
    state.events.filter(event => event.todoId === todo.id).forEach(event => {
      if (!hasSeries) event.color = event.completed ? (state.settings.eventDoneColor || "#78d68f") : (event.color || state.settings.eventTodoColor || "#ffd21a");
      event.updatedAt = nowIso();
    });
    syncWorkTreeFromTodo(todo);
  }

  function syncTodoEvents(todo) {
    state.events.filter(event => event.todoId === todo.id).forEach(event => {
      event.title = todo.title;
      if (todo.taskType) { const color = event.color; const series = window.EventState.isSeriesEvent(state.events, event); applyTodoTaskToEvent(todo, event); if (series) event.color = color; }
    });
    syncLinkedEventCompletion(todo);
    refreshTodoSchedule(todo.id, { preserveManualTarget: true });
  }

  function syncTodoEventStatus(todo) {
    state.events.filter(event => event.todoId === todo.id).forEach(event => {
      if (todo.taskType) { const color = event.color; const series = window.EventState.isSeriesEvent(state.events, event); applyTodoTaskToEvent(todo, event); if (series) event.color = color; }
    });
    syncLinkedEventCompletion(todo);
    refreshTodoSchedule(todo.id, { preserveManualTarget: true });
  }
  function restoreCalendarTodoDrawer() {
    if (!state.restoreCalendarTodoAfterDrop) return;
    state.restoreCalendarTodoAfterDrop = false;
    state.calendarTodoVisible = true;
    render();
  }
  async function unscheduleTodo(todoId) {
    const eventIds = state.events.filter(event => event.todoId === todoId).map(event => event.id);
    state.events = state.events.filter(event => event.todoId !== todoId);
    refreshTodoSchedule(todoId);
    if (eventIds.includes(state.editingEventId)) state.editingEventId = "";
    await persist();
    render();
  }

  function setBatchDelete(enabled) {
    state.calendarBatchDelete = enabled;
    state.calendarBatchSelected = new Set();
    if (enabled && state.editingEventId) { state.pendingEventDraft = null; state.editingEventId = ""; state.editingOccurrenceDate = ""; }
    render();
  }

  function updateBatchBar() {
    const count = state.calendarBatchSelected.size;
    const label = app.querySelector("[data-batch-count]");
    if (label) label.textContent = `已选 ${count}`;
    const run = app.querySelector("[data-batch-delete-run]");
    if (run) run.disabled = !count;
  }

  function toggleBatchSelection(buttons) {
    const keys = buttons.map(button => `${button.dataset.editEvent}|${button.dataset.occurrenceDate || ""}`);
    if (!keys.length) return;
    const select = !keys.every(key => state.calendarBatchSelected.has(key));
    keys.forEach(key => select ? state.calendarBatchSelected.add(key) : state.calendarBatchSelected.delete(key));
    app.querySelectorAll(".event-pill[data-edit-event]").forEach(pill => pill.classList.toggle("batch-selected", state.calendarBatchSelected.has(`${pill.dataset.editEvent}|${pill.dataset.occurrenceDate || ""}`)));
    updateBatchBar();
  }

  let batchDeleteBusy = false;
  async function deleteBatchSelection() {
    if (batchDeleteBusy || !state.calendarBatchSelected.size) return;
    batchDeleteBusy = true;
    const run = app.querySelector("[data-batch-delete-run]");
    if (run) run.disabled = true;
    const changes = captureEditorChanges();
    const entries = [];
    const todoIds = new Set();
    try {
      for (const key of state.calendarBatchSelected) {
        const split = key.lastIndexOf("|");
        const id = key.slice(0, split), date = key.slice(split + 1);
        const source = state.events.find(item => item.id === id);
        if (!source) continue;
        const target = eventForScope(source, date || source.date, "single");
        const index = state.events.findIndex(item => item.id === target.id);
        if (index < 0) continue;
        const [item] = state.events.splice(index, 1);
        entries.push({ id: uid("trash"), type: "event", item, index, title: item.title || "未命名", deletedAt: nowIso() });
        if (item.todoId) todoIds.add(item.todoId);
      }
      if (!entries.length) { state.calendarBatchSelected = new Set(); render(); return; }
      state.trash = [...entries.slice().reverse(), ...(state.trash || [])].slice(0, 200);
      todoIds.forEach(todoId => refreshTodoSchedule(todoId));
      let saved = false;
      try { saved = await persist(null, changes()); } catch { saved = false; }
      if (!saved) { render(); return; }
      entries.forEach(pushUndoEntry);
      state.calendarBatchSelected = new Set();
      render();
    } finally { batchDeleteBusy = false; }
  }

  async function removeEventFromCalendar(eventId) {
    await softDelete("event", eventId);
  }

  async function scheduleTodo(todoId, date) {
    const todo = state.todos.find(item => item.id === todoId);
    if (!todo) return;
    const event = { id: uid("event"), todoId, title: todo.title, date, startTime: "", endTime: "", color: todo.completed ? (state.settings.eventDoneColor || "#78d68f") : (state.settings.eventTodoColor || "#ffd21a"), completed: todo.completed, note: "", repeat: "none", reminderAt: "", reminderLead: "none", createdAt: nowIso(), updatedAt: nowIso() };
    if (todo.taskType === "flow") { ensureTodoEventForDate(todo, date); }
    else { if (todo.taskType) applyTodoTaskToEvent(todo, event); state.events.push(event); }
    refreshTodoSchedule(todoId);
    await persist();
    render();
  }

  function eventForScope(event, occurrence, scope) {
    if (event.ongoing) return event;
    if (normalizeRepeat(event.repeat) === "none" || scope === "series") return event;
    if (scope === "single") return window.EventState.occurrenceFor(state.events, event, occurrence, uid("event"), nowIso());
    if (scope === "future" && occurrence === event.date) return event;
    const copy = { ...event, id: uid("event"), date: occurrence, completed: false, createdAt: nowIso(), updatedAt: nowIso() };
    if (scope === "future") {
      copy.repeatSkippedDates = [...(event.repeatSkippedDates || [])].filter(date => date >= occurrence);
      event.repeatEndDate = toDateKey(addDays(parseDate(occurrence), -1));
    } else {
      event.repeatSkippedDates = Array.from(new Set([...(event.repeatSkippedDates || []), occurrence]));
      copy.repeat = "none";
      copy.repeatEndDate = "";
      copy.repeatSkippedDates = [];
    }
    event.updatedAt = nowIso();
    copy.repeatParentId = event.repeatParentId || event.id;
    state.events.push(copy);
    return copy;
  }

  async function moveEvent(eventId, date, occurrence) {
    let event = state.events.find(item => item.id === eventId);
    if (!event) return;
    if ((occurrence || event.date) === date) return;
    if (event.subscription) {
      if (date < event.subscription.chargedOn) { showSaveProblem('到期日期不能早于订阅日期。'); return; }
      const changes = captureEditorChanges();
      event.subscription = { ...event.subscription, expiresOn: date, billingAnchor: date };
      event.date = date;
      event.updatedAt = nowIso();
      try { await persist(null, changes()); }
      catch { render(); return; }
      render();
      return;
    }
    if (state.calendarLinkedEdit) {
      const offset = Math.round((parseDate(date) - parseDate(occurrence || event.date)) / 86400000);
      state.events.filter(item => window.EventState.sameSeries(item, event)).forEach(item => {
        item.date = toDateKey(addDays(parseDate(item.date), offset));
        if (item.repeatEndDate) item.repeatEndDate = toDateKey(addDays(parseDate(item.repeatEndDate), offset));
        item.repeatSkippedDates = (item.repeatSkippedDates || []).map(day => toDateKey(addDays(parseDate(day), offset)));
        if (item.repeatOccurrenceDate) item.repeatOccurrenceDate = toDateKey(addDays(parseDate(item.repeatOccurrenceDate), offset));
        item.updatedAt = nowIso();
      });
    } else {
      event = eventForScope(event, occurrence || event.date, "single");
      event.date = date;
    }
    event.updatedAt = nowIso();
    if (event.todoId) {
      const todo = state.todos.find(item => item.id === event.todoId);
      if (todo) refreshTodoSchedule(todo.id);
    }
    await persist();
    render();
  }

  async function createEvent(date, address = {}) {
    const event = { id: uid("event"), calendarId: "self", title: "\u65b0\u65e5\u7a0b", date, startTime: "", endTime: "", color: state.settings.eventTodoColor, completed: false, note: "", repeat: "none", reminderAt: "", reminderLead: "none", createdAt: nowIso(), updatedAt: nowIso(), __draft: true };
    Object.assign(event, address);
    state.pendingEventDraft = event;
    state.editingEventId = event.id;
    state.editingOccurrenceDate = "";
    render();
    setTimeout(() => {
      const input = app.querySelector("[data-event-title]");
      input?.focus();
      try { input?.select(); } catch {}
    }, 0);
  }

  function bindEventEditor() {
    let event = currentEditingEvent();
    if (!event) return;
    window.AccountSubscriptionEditor.bind(app.querySelector('[data-event-editor]'), event, toDateKey(new Date()));
    const urlInput = app.querySelector("[data-event-url]");
    const openUrl = app.querySelector("[data-open-event-url]");
    const updateUrl = () => { openUrl.disabled = !window.EventAddress.webUrl(urlInput.value); };
    urlInput.addEventListener("input", updateUrl);
    for (const field of [urlInput, app.querySelector("[data-event-location]")]) {
      const receive = transferred => {
        const address = readEventAddress(transferred);
        if (!address) return false;
        if (field !== urlInput && address.url) {
          urlInput.value = address.url;
          markDraftControlDirty(urlInput);
          updateUrl();
        }
        const value = field === urlInput ? address.url : address.location;
        if (!value && field !== urlInput && address.url) return true;
        if (!value) return false;
        field.value = value;
        markDraftControlDirty(field);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      };
      field.addEventListener("dragover", action => action.preventDefault());
      field.addEventListener("drop", action => { action.preventDefault(); action.stopPropagation(); receive(action.dataTransfer); });
      field.addEventListener("paste", action => {
        if (field === urlInput && receive(action.clipboardData)) action.preventDefault();
      });
    }
    openUrl.addEventListener("click", async () => {
      const url = window.EventAddress.webUrl(urlInput.value);
      if (!url) return;
      try { await window.dayline?.openEventUrl?.(url); }
      catch { showSaveProblem("链接打开失败，请检查地址后重试。"); }
    });
    bindTaskOptions("event");
    app.querySelector("[data-event-ongoing]")?.addEventListener("change", e => {
      app.querySelector("[data-event-task-fields]").hidden = !e.target.checked;
      if (e.target.checked) {
        const color = labelColorPresets[1];
        const input = app.querySelector("[data-event-color]");
        input.value = color;
        markDraftControlDirty(input);
        app.querySelectorAll("[data-event-color-preset]").forEach(button => button.classList.toggle("active", button.dataset.eventColorPreset === color));
      }
    });
    app.querySelector('[data-event-kind]')?.addEventListener('change', action => {
      const kind = action.target.value;
      if (kind === "course") {
        app.querySelector("[data-schedule-import]")?.click();
        const mode = document.querySelector('.schedule-import-dialog select[name="mode"], dialog select[name="mode"]');
        if (mode) { mode.value = "course"; mode.dispatchEvent(new Event("change")); }
        action.target.value = event.subscription ? 'subscription' : event.draftKind || (event.todoId ? 'todo' : 'event');
        window.AccountSubscriptionEditor.refresh();
        return;
      }
      if (event.__draft) event.draftKind = kind;
    });
    app.querySelectorAll('[data-event-kind-choice]').forEach(button => button.addEventListener('click', () => {
      const kind = app.querySelector('[data-event-kind]');
      kind.value = button.dataset.eventKindChoice;
      markDraftControlDirty(kind);
      kind.dispatchEvent(new Event('change', { bubbles: true }));
    }));
    app.querySelector("[data-editor-linked]")?.addEventListener("change", e => {
      state.calendarLinkedEdit = e.target.checked;
      const repeatSource = repeatSourceForEvent(event);
      const singleOccurrence = !state.calendarLinkedEdit && window.EventState.isSeriesEvent(state.events, event);
      const repeatField = app.querySelector("[data-event-repeat]"), endField = app.querySelector("[data-event-repeat-end]");
      repeatField.disabled = singleOccurrence;
      endField.disabled = singleOccurrence;
      repeatField.value = singleOccurrence ? "none" : normalizeRepeat(repeatSource.repeat);
      endField.value = singleOccurrence ? "" : repeatSource.repeatEndDate || "";
      persistUiStatePatch({ calendarLinkedEdit: state.calendarLinkedEdit });
    });
    app.querySelector("[data-close-event-editor]")?.addEventListener("click", () => { if (event.__draft) state.pendingEventDraft = null; state.editingEventId = ""; state.editingOccurrenceDate = ""; render(); restoreEditorEntry(); });
    app.querySelector("[data-event-title]")?.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        app.querySelector("[data-save-event]")?.click();
      }
    });
    app.querySelector("[data-save-event]")?.addEventListener("click", () => saveEditor("event", event.id, async () => {
      const subscriptionEnabled = app.querySelector('[data-event-editor] [data-event-kind]')?.value === 'subscription';
      if (subscriptionEnabled) {
        const panel = app.querySelector('[data-event-editor]');
        const subscription = window.AccountSubscriptionEditor.read(panel, event.subscription);
        const renewing = Boolean(panel.querySelector('[data-subscription-renewal]').value);
        const title = app.querySelector('[data-event-title]').value.trim();
        const issue = !title ? ['title', '请填写账号名称。'] : window.AccountSubscription.validate(subscription);
        const renewalInvalid = renewing && event.subscription && (subscription.expiresOn <= event.subscription.expiresOn || subscription.chargedOn < event.subscription.chargedOn);
        if (issue || renewalInvalid || urlInput.value.trim() && !window.EventAddress.webUrl(urlInput.value)) {
          editorSaveStates.event.message = issue?.[1] || (renewalInvalid ? '续费后的到期日期须延长，充值日期须晚于或等于上次充值。' : '请输入有效的 http 或 https 网页链接。');
          const control = issue ? panel.querySelector(issue[0] === 'title' ? '[data-event-title]' : `[data-subscription-${issue[0]}]`) : renewalInvalid ? panel.querySelector('[data-subscription-expires-on]') : urlInput;
          control.focus();
          return;
        }
        const changes = captureEditorChanges();
        const wasDraft = Boolean(event.__draft);
        event.title = title;
        event.subscription = window.AccountSubscription.save(subscription, event.subscription, renewing);
        event.date = subscription.expiresOn;
        event.color = panel.querySelector('[data-event-color]').value || '#ba68c8';
        event.completed = false;
        event.startTime = ''; event.endTime = ''; event.repeat = 'none'; event.repeatEndDate = '';
        event.repeatSkippedDates = [];
        event.reminderLastKey = '';
        event.note = panel.querySelector('[data-event-note]').value;
        event.location = panel.querySelector('[data-event-location]').value.trim();
        event.url = window.EventAddress.webUrl(urlInput.value);
        event.updatedAt = nowIso();
        if (wasDraft) {
          delete event.__draft; delete event.draftKind;
          state.events.push(event);
        }
        const password = panel.querySelector('[data-subscription-password]').value;
        const saveOptions = password ? { subscriptionPassword: { eventId: event.id, password } } : null;
        const saved = await persist(null, changes(), saveOptions);
        if (!saved) {
          if (wasDraft) { event.__draft = true; state.pendingEventDraft = event; }
          render(); event = currentEditingEvent();
          return;
        }
        if (wasDraft) state.pendingEventDraft = null;
        clearDraftControls(panel);
        state.editingEventId = ''; state.editingOccurrenceDate = '';
        render(); restoreEditorEntry();
        return;
      }
      const taskOptions = readTaskOptions("event");
      if (!taskOptions) return;
      const scope = event.__draft || state.calendarLinkedEdit ? "series" : "single";
      const before = { ...event };
      const repeatSource = repeatSourceForEvent(event);
      const selectedDate = app.querySelector("[data-event-date]")?.value;
      const repeat = scope === "single" && window.EventState.isSeriesEvent(state.events, event) ? "none" : app.querySelector("[data-event-repeat]")?.value || "none";
      const repeatEnd = app.querySelector("[data-event-repeat-end]")?.value || "";
      const repeatChanged = repeat !== normalizeRepeat(repeatSource.repeat);
      const repeatEndChanged = repeatEnd !== (repeatSource.repeatEndDate || "");
      const start = app.querySelector("[data-event-time]")?.value;
      const end = app.querySelector("[data-event-end-time]")?.value;
      const titleInput = app.querySelector("[data-event-title]");
      const invalid = !titleInput.value.trim() ? [titleInput, "请填写日程标题。"] : !selectedDate ? [app.querySelector("[data-event-date]"), "请填写有效日期。"] : end && !start ? [app.querySelector("[data-event-time]"), "填写结束时间前，请先填写开始时间。"] : end && end <= start ? [app.querySelector("[data-event-end-time]"), "结束时间必须晚于开始时间。"] : repeat !== "none" && repeatEnd && repeatEnd < selectedDate ? [app.querySelector("[data-event-repeat-end]"), "重复截止日期不能早于日程日期。"] : null;
      const invalidUrl = urlInput.value.trim() && !window.EventAddress.webUrl(urlInput.value);
      app.querySelectorAll("[aria-invalid]").forEach(input => input.removeAttribute("aria-invalid"));
      if (invalid || invalidUrl) {
        const error = invalid || [urlInput, "请输入有效的 http 或 https 网页链接。"];
        editorSaveStates.event.message = error[1];
        error[0].setAttribute("aria-invalid", "true");
        error[0].setAttribute("aria-describedby", "event-editor-status");
        app.querySelector("[data-event-error]").id = "event-editor-status";
        error[0].focus();
        return;
      }
      const changes = captureEditorChanges();
      const draftLinks = { ...event };
      const occurrenceDate = state.editingOccurrenceDate || event.date;
      const completionChanged = Boolean(app.querySelector("[data-event-completed]")?.checked) !== window.EventState.occurrenceCompleted(event, occurrenceDate);
      const completionScope = !event.__draft && completionChanged && window.EventState.isSeriesEvent(state.events, event) ? "single" : scope;
      event = eventForScope(event, occurrenceDate, completionScope);
      const detached = event.id !== before.id;
      const wasDraft = Boolean(event.__draft);
      const wasCompleted = Boolean(event.completed);
      event.title = app.querySelector("[data-event-title]")?.value.trim() || event.title;
      event.ongoing = Boolean(app.querySelector("[data-event-ongoing]")?.checked);
      event.followupInCalendar = event.ongoing && Boolean(app.querySelector("[data-followup-in-calendar]")?.checked);
      event.progress = app.querySelector("[data-event-progress]")?.value.trim() || "";
      event.priority = Number(app.querySelector("[data-event-priority]")?.value) || 2;
      event.date = app.querySelector("[data-event-date]")?.value || event.date;
      event.repeat = detached || before.repeatParentId && normalizeRepeat(before.repeat) === "none" && window.EventState.isSeriesEvent(state.events, before) ? "none" : repeat;
      event.repeatEndDate = event.repeat === "none" ? "" : repeatEnd;
      event.startTime = app.querySelector("[data-event-time]")?.value || "";
      event.endTime = app.querySelector("[data-event-end-time]")?.value || "";
      event.location = app.querySelector("[data-event-location]")?.value.trim() || "";
      event.url = window.EventAddress.webUrl(urlInput.value);
      if (wasDraft || completionChanged) window.EventState.setEventCompleted(event, app.querySelector("[data-event-completed]")?.checked, toDateKey(new Date()));
      event.note = app.querySelector("[data-event-note]")?.value || "";
      event.color = app.querySelector("[data-event-color]")?.value || event.color || state.settings.eventTodoColor;
      delete event.subscription;
      event.reminderLastKey = "";
      event.updatedAt = nowIso();
      if (!wasDraft && state.calendarLinkedEdit) {
        const offset = Math.round((parseDate(selectedDate) - parseDate(state.editingOccurrenceDate || before.date)) / 86400000);
        state.events.filter(item => window.EventState.sameSeries(item, before)).forEach(item => {
          const original = item.id === before.id ? { ...before, repeatSkippedDates: [...(item.repeatSkippedDates || [])] } : item === event && detached ? { ...item, date: occurrenceDate, repeatOccurrenceDate: occurrenceDate } : { ...item };
          item.date = toDateKey(addDays(parseDate(original.date), offset));
          item.repeatSkippedDates = (original.repeatSkippedDates || []).map(day => toDateKey(addDays(parseDate(day), offset)));
          if (original.repeatOccurrenceDate) item.repeatOccurrenceDate = toDateKey(addDays(parseDate(original.repeatOccurrenceDate), offset));
          if (normalizeRepeat(original.repeat) !== "none") {
            item.repeatEndDate = repeatChanged && repeat === "none" ? "" : repeatEndChanged ? repeatEnd : original.repeatEndDate ? toDateKey(addDays(parseDate(original.repeatEndDate), offset)) : "";
            if (repeatChanged) item.repeat = repeat;
          } else item.repeatEndDate = "";
          for (const field of ["title", "startTime", "endTime", "location", "url", "note", "color"]) {
            if (event[field] !== before[field]) item[field] = event[field];
          }
          item.updatedAt = nowIso();
        });
      }
      if (!event.todoId && (taskOptions.type !== "normal" || app.querySelector("[data-event-kind]")?.value === "todo")) {
          const todo = { id: uid("todo"), title: event.title, targetDate: event.date, completed: false, createdAt: nowIso(), updatedAt: nowIso(), order: state.todos.length, tags: [], subtasks: [], repeat: "none" };
          state.todos.push(todo);
          event.todoId = todo.id;
      }
      if (event.todoId) {
        const todo = state.todos.find(row => row.id === event.todoId);
        if (todo) { const series = window.EventState.isSeriesEvent(state.events, event); const color = event.color; if (!series || state.calendarLinkedEdit) todo.title = event.title; todo.completed = event.completed; if (taskOptions.type === "flow") { todo.progress = event.progress; todo.priority = event.priority; } applyTaskOptions(todo, taskOptions); if (taskOptions.type === "flow") consolidateFlowEvents(todo, event); applyTodoTaskToEvent(todo, event); if (series) event.color = color; }
      }
      if (wasDraft) {
        delete event.__draft;
        delete event.draftKind;
        state.events.push(event);
      }
      if (!wasCompleted && event.completed && !state.calendarLinkedEdit) ensureNextEventFromRepeat(event);
      if (event.todoId) {
        const todo = state.todos.find(item => item.id === event.todoId);
        if (todo) {
          if (window.EventState.isSeriesEvent(state.events, event)) { todo.completed = window.EventState.linkedTodoCompleted(state.events, todo.id, nextRepeatDate); syncWorkTreeFromTodo(todo); }
          else { todo.completed = event.completed; syncTodoEventStatus(todo); }
        }
      }
      const rollback = changes();
      const saved = await persist(null, rollback);
      if (!saved) {
        if (wasDraft) {
          for (const key of ["todoId", "workTreeId", "workTreeNodeId", "goalParentTitle", "draftKind"]) { if (Object.hasOwn(draftLinks, key)) event[key] = draftLinks[key]; else delete event[key]; }
          event.__draft = true;
          state.pendingEventDraft = event;
        }
        render();
        event = currentEditingEvent();
        return;
      }
      if (wasDraft) state.pendingEventDraft = null;
      clearDraftControls(app.querySelector("[data-event-editor]"));
      state.editingEventId = "";
      state.editingOccurrenceDate = "";
      render();
      restoreEditorEntry();
    }));
    app.querySelector(".event-color-options")?.addEventListener("click", event => {
      const button = event.target.closest("[data-event-color-preset]");
      if (!button) return;
      const input = app.querySelector("[data-event-color]");
      if (input) {
        input.value = button.dataset.eventColorPreset;
        markDraftControlDirty(input);
      }
      app.querySelectorAll("[data-event-color-preset]").forEach(item => { item.classList.toggle("active", item === button); item.setAttribute("aria-pressed", String(item === button)); });
    });
    app.querySelector("[data-custom-event-color]")?.addEventListener("change", async event => {
      const color = event.target.value.toLowerCase();
      const input = app.querySelector("[data-event-color]");
      input.value = color;
      markDraftControlDirty(input);
      const custom = Array.isArray(state.settings.eventCustomColors) ? state.settings.eventCustomColors : [];
      if (!eventColorPresets.some(([preset]) => preset === color) && !custom.includes(color)) state.settings.eventCustomColors = [...custom, color];
      state.settings.eventLastCustomColor = color;
      refreshEventColorControls();
      const options = app.querySelector(".event-color-options");
      options.scrollLeft = options.scrollWidth;
      await persist();
    });
    app.querySelector("[data-delete-event]")?.addEventListener("click", () => {
      if (event.__draft) {
        state.pendingEventDraft = null;
        state.editingEventId = "";
        state.editingOccurrenceDate = "";
        render();
        restoreEditorEntry();
        return;
      }
      saveEditor("event", event.id, async () => {
        const changes = captureEditorChanges();
        const target = eventForScope(event, state.editingOccurrenceDate || event.date, "single");
        const saved = await softDelete("event", target.id, { changes, editingId: event.id });
        if (saved) restoreEditorEntry();
      });
    });
  }

  async function addEventInline(date) {
    const title = prompt("新增日程", "");
    if (!title?.trim()) return;
    state.events.push({ id: uid("event"), calendarId: "self", title: title.trim(), date, startTime: "09:00", endTime: "10:00", color: state.settings.accentColor || "#ffd21a", repeat: "none", reminderAt: "", reminderLead: "none", createdAt: nowIso(), updatedAt: nowIso() });
    await persist();
    render();
  }

  async function editEventTitle(eventId) {
    const event = state.events.find(item => item.id === eventId);
    if (!event) return;
    const title = prompt("修改日程", event.title);
    if (!title?.trim()) return;
    event.title = title.trim();
    event.updatedAt = nowIso();
    await persist();
    render();
  }

  function showDayList(date) {
    const list = eventsFor(date).map(event => `${event.startTime || ""} ${event.title}`).join("\n") || "暂无日程";
    alert(`${formatDay(parseDate(date))}\n${list}`);
  }


  function bindSearchPanel() {
    const searchInput = app.querySelector("[data-search-input]");
    searchInput?.addEventListener("input", event => {
      state.searchQuery = event.target.value;
      if (event.isComposing) return;
      render();
      setTimeout(() => focusSearchInputAtEnd(), 0);
    });
    searchInput?.addEventListener("compositionend", event => {
      state.searchQuery = event.target.value;
      render();
      setTimeout(() => focusSearchInputAtEnd(), 0);
    });
    // 搜索结果键盘导航：↓/↑ 选择，Enter 打开第一条或当前选中项。
    const searchPanel = app.querySelector("[data-search-panel]");
    searchPanel?.addEventListener("keydown", event => {
      if (event.isComposing) return;
      const results = [...searchPanel.querySelectorAll("[data-search-go]")];
      const index = results.indexOf(document.activeElement);
      if (event.key === "ArrowDown" && results.length) { event.preventDefault(); results[Math.min(results.length - 1, index + 1)].focus(); }
      else if (event.key === "ArrowUp" && results.length) { event.preventDefault(); if (index <= 0) focusSearchInputAtEnd(); else results[index - 1].focus(); }
      else if (event.key === "Enter" && event.target === searchInput && results.length) { event.preventDefault(); results[0].click(); }
    });
    app.querySelector("[data-close-search]")?.addEventListener("click", () => { state.searchOpen = false; state.searchQuery = ""; render(); });
    app.querySelectorAll("[data-search-go]").forEach(button => button.addEventListener("click", () => {
      const [type, id] = button.dataset.searchGo.split(":");
      goToSearchResult(type, id).catch(console.error);
    }));
  }

  function bindTrashPanel() {
    app.querySelector("[data-close-trash]")?.addEventListener("click", () => { state.showTrash = false; render(); });
    app.querySelectorAll("[data-restore-trash]").forEach(button => button.addEventListener("click", () => restoreTrashEntry((state.trash || []).find(entry => entry.id === button.dataset.restoreTrash))));
    app.querySelectorAll("[data-permanent-trash]").forEach(button => button.addEventListener("click", async () => { clearWorkTreeTrashUndo(button.dataset.permanentTrash); state.trash = (state.trash || []).filter(entry => entry.id !== button.dataset.permanentTrash); await persist(); render(); }));
    app.querySelectorAll("[data-clear-trash]").forEach(button => button.addEventListener("click", async () => { if (button.disabled) return; if (!confirm("确定清空回收站？此操作不可撤销。")) return; clearAllTrashUndoEntries(); state.trash = []; await persist(); render(); }));
  }
  async function moveNoteToFolder(noteId, folderId) { const note = state.notes.find(item => item.id === noteId); if (!note) return; note.folderId = folderId; note.updatedAt = nowIso(); await persist(); render(); }
  function closeNotePasteMenu() {
    notePasteMenuCleanup?.();
    notePasteMenuCleanup = null;
    notePasteMenuElement?.remove();
    notePasteMenuElement = null;
    notePasteMenuContext = null;
  }

  function openNotePasteMenu(event, target, noteId) {
    event.preventDefault();
    event.stopPropagation();
    closeNotePasteMenu();
    try { target.focus({ preventScroll: true }); } catch { target.focus(); }
    const valueLength = target.value.length;
    const selectionStart = Number.isInteger(target.selectionStart) ? target.selectionStart : valueLength;
    const selectionEnd = Number.isInteger(target.selectionEnd) ? target.selectionEnd : selectionStart;
    notePasteMenuContext = { target, noteId, selectionStart, selectionEnd };

    const menu = document.createElement("div");
    menu.className = "note-paste-menu";
    menu.dataset.notePasteMenu = "";
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.notePasteAction = "";
    button.textContent = "粘贴";
    const keepFocus = pointerEvent => {
      pointerEvent.preventDefault();
      pointerEvent.stopPropagation();
    };
    button.addEventListener("pointerdown", keepFocus);
    button.addEventListener("mousedown", keepFocus);
    button.addEventListener("click", async clickEvent => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      const context = notePasteMenuContext;
      closeNotePasteMenu();
      if (!context) return;
      try {
        const payload = await window.dayline?.readNoteClipboard?.();
        await applyNoteClipboardPayload(payload, context);
      } catch (error) {
        console.error(error);
      }
    });
    menu.appendChild(button);
    document.body.appendChild(menu);
    notePasteMenuElement = menu;
    const floating = window.XiaoyeFloating.attach({ getBoundingClientRect: () => new DOMRect(event.clientX, event.clientY, 0, 0), contextElement: target }, menu, { placement: "bottom-start", gap: 0 });

    const dismissPointer = pointerEvent => {
      if (!menu.contains(pointerEvent.target)) closeNotePasteMenu();
    };
    const dismissKey = keyEvent => {
      if (keyEvent.key === "Escape") closeNotePasteMenu();
    };
    const dismissBlur = () => closeNotePasteMenu();
    window.addEventListener("pointerdown", dismissPointer, true);
    window.addEventListener("keydown", dismissKey, true);
    window.addEventListener("blur", dismissBlur, true);
    notePasteMenuCleanup = () => {
      floating.dispose();
      window.removeEventListener("pointerdown", dismissPointer, true);
      window.removeEventListener("keydown", dismissKey, true);
      window.removeEventListener("blur", dismissBlur, true);
    };
  }

  function resolveNotePasteTarget(context) {
    if (context?.target?.isConnected) return context.target;
    if (context?.noteId === "new") return app.querySelector("[data-new-note-body]");
    return [...app.querySelectorAll("[data-note-body]")].find(input => input.dataset.noteBody === context?.noteId) || null;
  }

  async function applyNoteClipboardPayload(payload, context) {
    if (!payload || payload.type === "empty") return false;
    const target = resolveNotePasteTarget(context);
    if (!target) return false;
    if (payload.type === "text") {
      const text = String(payload.text ?? "");
      if (!text) return false;
      const valueLength = target.value.length;
      const start = Math.max(0, Math.min(valueLength, Number.isInteger(context.selectionStart) ? context.selectionStart : valueLength));
      const end = Math.max(start, Math.min(valueLength, Number.isInteger(context.selectionEnd) ? context.selectionEnd : start));
      target.setRangeText(text, start, end, "end");
      target.dispatchEvent(new Event("input", { bubbles: true }));
      try { target.focus({ preventScroll: true }); } catch { target.focus(); }
      if (context.noteId === "new") return true;
      const note = state.notes.find(item => item.id === context.noteId);
      if (!note) return false;
      note.body = target.value;
      note.updatedAt = nowIso();
      const saved = await persist(captureEditorDraft(target));
      if (saved) clearDraftControl(target);
      return saved;
    }
    if (payload.type !== "image") return false;
    const attachment = payload.attachment || (typeof window !== "undefined" && window.dayline?.importNoteImage
      ? await window.dayline.importNoteImage(payload.attachmentPayload || payload.dataUrl)
      : payload.dataUrl);
    if (!attachment) return false;
    if (context.noteId === "new") {
      state.pendingNewImages = [...(state.pendingNewImages || []), attachment];
      state.showNewNote = true;
      render(captureEditorDraft(target));
      return true;
    }
    const note = state.notes.find(item => item.id === context.noteId);
    if (!note) return false;
    note.body = target.value;
    note.attachments = [...(note.attachments || []), attachment];
    note.updatedAt = nowIso();
    const saved = await persist(captureEditorDraft(target));
    if (!saved) return false;
    clearDraftControl(target);
    render();
    return true;
  }

  function handleNotePaste(event, noteId) {
    const item = [...(event.clipboardData?.items || [])].find(entry => entry.type.startsWith("image/"));
    if (!item) return;
    event.preventDefault();
    const target = event.currentTarget || event.target;
    const file = item.getAsFile();
    if (!file) return;
    file.arrayBuffer().then(bytes => applyNoteClipboardPayload({
      type: "image",
      attachmentPayload: { bytes, mime: file.type }
    }, {
      target,
      noteId,
      selectionStart: target.selectionStart,
      selectionEnd: target.selectionEnd
    })).catch(console.error);
  }
  function wheelSwitchThreshold() {
    const sensitivity = Math.min(10, Math.max(1, Number(state.settings.surfaceWheelSensitivity || 5)));
    return 260 - (sensitivity - 1) * 22;
  }

  async function applySurfaceSwitch(nextSurface) {
    if (window.dayline?.switchSurfaceOnly) return window.dayline.switchSurfaceOnly(nextSurface);
    if (window.dayline?.applySurfaceBounds) return window.dayline.applySurfaceBounds(nextSurface);
    return null;
  }

  async function flushSurfaceSwitchQueue() {
    if (switchingSurface) return;
    switchingSurface = true;
    try {
      while (queuedSurfaceSwitch) {
        const request = queuedSurfaceSwitch;
        queuedSurfaceSwitch = null;
        try {
          const result = await applySurfaceSwitch(request.surface);
          if (request.version === surfaceSwitchVersion && !queuedSurfaceSwitch) {
            if (result?.windowState) state.windowState = result.windowState;
            else if (result?.windowStatePatch) state.windowState = { ...(state.windowState || {}), ...result.windowStatePatch };
            else if (result?.bounds) state.windowState = { ...(state.windowState || {}), [request.surface]: result.bounds };
            if (request.surface === "calendar" && state.surface === "calendar" && toDateKey(state.cursor) === toDateKey(new Date())) {
              calendarRevealDate = state.selectedDate;
              requestAnimationFrame(revealCalendarDate);
            }
          }
        } catch (error) {
          console.error(error);
        }
      }
    } finally {
      switchingSurface = false;
      if (queuedSurfaceSwitch) scheduleSurfaceSwitchFlush();
    }
  }

  function scheduleSurfaceSwitchFlush() {
    clearTimeout(surfaceSwitchFlushTimer);
    surfaceSwitchFlushTimer = setTimeout(() => {
      surfaceSwitchFlushTimer = null;
      flushSurfaceSwitchQueue().catch(console.error);
    }, 16);
  }

  async function switchSurface(nextSurface) {
    nextSurface = surfaceItems.some(([key]) => key === nextSurface) ? nextSurface : state.surface;
    if (state.settings.multiOpen) {
      await window.dayline?.openSurface?.(nextSurface);
      return;
    }
    const activeTarget = queuedSurfaceSwitch?.surface || state.surface;
    if (nextSurface === activeTarget) {
      if (nextSurface === "calendar") showCalendarToday();
      return;
    }
    const version = ++surfaceSwitchVersion;
    clearTimeout(scrollSaveTimer);
    persistUiStatePatch({ scrollState: state.scrollState });
    delete document.documentElement.dataset.surfaceSwitching;
    delete document.documentElement.dataset.surfaceSwitchPhase;
    delete document.documentElement.dataset.surfaceSwitchTarget;
    state.surface = nextSurface;
    if (nextSurface === "calendar") selectCalendarToday();
    render();
    queuedSurfaceSwitch = { surface: nextSurface, version };
    scheduleSurfaceSwitchFlush();
  }
  function bindCommon() {
    app.querySelectorAll("[data-toggle-calendar-window-size]").forEach(button => button.addEventListener("click", async event => {
      event.stopPropagation();
      const result = await window.dayline?.toggleCalendarBounds?.();
      if (result?.windowState) state.windowState = result.windowState;
      else if (result?.bounds) state.windowState = { ...(state.windowState || {}), [state.surface]: result.bounds };
      render();
    }));
    app.querySelectorAll("[data-surface]").forEach(button => {
      button.title ||= "按住Ctrl点击在新窗口打开";
      button.addEventListener("click", event => {
        if ((event.ctrlKey || event.metaKey) && !state.settings.multiOpen && window.dayline?.openSurface) { window.dayline.openSurface(button.dataset.surface); return; }
        switchSurface(button.dataset.surface).catch(console.error);
      });
    });
    app.querySelector(".toolbar")?.addEventListener("wheel", event => {
      event.preventDefault();
      event.stopPropagation();
      surfaceWheelDelta += event.deltaY;
      const threshold = wheelSwitchThreshold();
      if (Math.abs(surfaceWheelDelta) < threshold) return;
      const direction = surfaceWheelDelta > 0 ? 1 : -1;
      surfaceWheelDelta = 0;
      const currentSurface = queuedSurfaceSwitch?.surface || state.surface;
      const index = surfaceItems.findIndex(([key]) => key === currentSurface);
      const next = surfaceItems[(index + direction + surfaceItems.length) % surfaceItems.length][0];
      switchSurface(next).catch(console.error);
    }, { passive: false });
    const toolbarSpacer = app.querySelector(".toolbar-spacer");
    toolbarSpacer?.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
    });
    toolbarSpacer?.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.isPrimary === false || !window.dayline?.startWindowDrag) return;
      event.preventDefault();
      const pointerId = event.pointerId;
      let active = true;
      let moveFrame = 0;
      const flushMove = () => {
        moveFrame = 0;
        if (active) window.dayline?.moveWindowDrag?.();
      };
      const move = moveEvent => {
        if (moveEvent.pointerId !== pointerId) return;
        moveEvent.preventDefault();
        if (!moveFrame) moveFrame = requestAnimationFrame(flushMove);
      };
      const finish = finishEvent => {
        if (finishEvent?.pointerId !== undefined && finishEvent.pointerId !== pointerId) return;
        if (!active) return;
        active = false;
        if (moveFrame) cancelAnimationFrame(moveFrame);
        moveFrame = 0;
        if (finishEvent?.type === "pointerup") window.dayline?.moveWindowDrag?.();
        window.dayline?.endWindowDrag?.();
        if (toolbarSpacer.hasPointerCapture?.(pointerId)) toolbarSpacer.releasePointerCapture(pointerId);
        toolbarSpacer.removeEventListener("pointermove", move);
        toolbarSpacer.removeEventListener("pointerup", finish);
        toolbarSpacer.removeEventListener("pointercancel", finish);
        toolbarSpacer.removeEventListener("lostpointercapture", finish);
        window.removeEventListener("blur", finish);
      };
      toolbarSpacer.setPointerCapture?.(pointerId);
      toolbarSpacer.addEventListener("pointermove", move);
      toolbarSpacer.addEventListener("pointerup", finish);
      toolbarSpacer.addEventListener("pointercancel", finish);
      toolbarSpacer.addEventListener("lostpointercapture", finish);
      window.addEventListener("blur", finish);
      window.dayline.startWindowDrag();
    });
    app.querySelector("[data-toggle-multi-open]")?.addEventListener("click", async event => {
      event.stopPropagation();
      state.settings.multiOpen = !state.settings.multiOpen;
      await persist();
      render();
    });
    app.querySelector("[data-toggle-top]")?.addEventListener("click", async event => { event.stopPropagation(); state.settings.alwaysOnTop = !state.settings.alwaysOnTop; await persist(); render(); });
    app.querySelector("[data-close-window]")?.addEventListener("click", () => window.dayline?.close?.() || window.dayline?.minimize?.());
    app.querySelector("[data-open-search]")?.addEventListener("click", event => { event.stopPropagation(); state.searchOpen = true; render(); setTimeout(() => focusSearchInputAtEnd(), 0); });
    app.querySelector("[data-menu]")?.addEventListener("click", event => { event.stopPropagation(); state.showSettings = !state.showSettings; if (!state.showSettings) state.customThemeColorOpen = false; render(); });
    app.querySelector("[data-settings-panel]")?.addEventListener("click", event => event.stopPropagation());
    app.querySelector("[data-open-sync]")?.addEventListener("click", () => window.dispatchEvent(new Event("xiaoye:openSync")));
    app.querySelector("[data-open-wechat-reminder]")?.addEventListener("click", () => window.dispatchEvent(new Event("xiaoye:openWechatReminderRules")));
    app.querySelector(".glass-app")?.addEventListener("click", event => {
      const workTreeTitleInput = app.querySelector("[data-work-tree-title]");
      const workTreeTabTitleInput = app.querySelector("[data-work-tree-tab-title]");
      const workNodeTitleInput = app.querySelector("[data-work-node-title]");
      if ((workTreeTitleInput || workTreeTabTitleInput || workNodeTitleInput) && (workTreeRenameSelectingInput || Date.now() < workTreeSuppressRenameBlurUntil)) return;
      if (workTreeTabTitleInput && !event.target.closest("[data-work-tree-tab-title]") && !event.target.closest("[data-work-tree-tab-rename]")) {
        workTreeTabTitleInput.blur();
        return;
      }
      if (workTreeTitleInput && !event.target.closest("[data-work-tree-title]") && !event.target.closest("[data-work-tree-rename]")) {
        workTreeTitleInput.blur();
        return;
      }
      if (workNodeTitleInput && !event.target.closest("[data-work-node-title]") && !event.target.closest("[data-work-node-rename]")) {
        workNodeTitleInput.blur();
        return;
      }
      const shouldCloseSettings = state.showSettings && !event.target.closest("[data-settings-panel]") && !event.target.closest("[data-menu]");
      const shouldCloseEditor = state.editingEventId && !editorSaveStates.event.busy && !event.target.closest("[data-event-editor]") && !event.target.closest("[data-edit-event]") && !event.target.closest("[data-calendar-trash]");
      const shouldCloseWorkTreeMenu = state.workTreeContextMenu && !event.target.closest("[data-work-node-menu]") && !event.target.closest("[data-work-node-command]");
      const shouldCloseWorkTreeTrash = state.showWorkTreeTrash && !event.target.closest("[data-work-tree-trash-panel]") && !event.target.closest("[data-work-tree-node-trash]");
      const openWorkTreeProjectMenu = app.querySelector("[data-work-tree-project-menu][open]");
      const shouldCloseWorkTreeProjectMenu = openWorkTreeProjectMenu && !event.target.closest("[data-work-tree-project-menu]");
      const openNoteCardMenu = app.querySelector("[data-note-card-menu][open]");
      const shouldCloseNoteCardMenu = openNoteCardMenu && !event.target.closest("[data-note-card-menu]");
      const openNoteFolderMenu = app.querySelector("[data-note-folder-menu][open]");
      const shouldCloseNoteFolderMenu = openNoteFolderMenu && !event.target.closest("[data-note-folder-menu]");
      if (shouldCloseSettings || shouldCloseEditor || shouldCloseWorkTreeMenu || shouldCloseWorkTreeTrash || shouldCloseWorkTreeProjectMenu || shouldCloseNoteCardMenu || shouldCloseNoteFolderMenu) {
        state.showSettings = shouldCloseSettings ? false : state.showSettings;
        state.customThemeColorOpen = shouldCloseSettings ? false : state.customThemeColorOpen;
        state.workTreeContextMenu = shouldCloseWorkTreeMenu ? null : state.workTreeContextMenu;
        state.showWorkTreeTrash = shouldCloseWorkTreeTrash ? false : state.showWorkTreeTrash;
        if (shouldCloseWorkTreeProjectMenu) openWorkTreeProjectMenu.removeAttribute("open");
        if (shouldCloseNoteCardMenu) openNoteCardMenu.removeAttribute("open");
        if (shouldCloseNoteFolderMenu) openNoteFolderMenu.removeAttribute("open");
        if (shouldCloseEditor && state.pendingEventDraft?.id === state.editingEventId) state.pendingEventDraft = null;
        state.editingEventId = shouldCloseEditor ? "" : state.editingEventId;
        state.editingOccurrenceDate = shouldCloseEditor ? "" : state.editingOccurrenceDate;
        if ((shouldCloseWorkTreeProjectMenu || shouldCloseNoteCardMenu || shouldCloseNoteFolderMenu) && !shouldCloseSettings && !shouldCloseEditor && !shouldCloseWorkTreeMenu && !shouldCloseWorkTreeTrash) return;
        render();
      }
    });
    app.querySelectorAll("[data-theme]").forEach(button => button.addEventListener("click", async () => { state.settings.theme = button.dataset.theme; await persist(); render(); }));
    app.querySelectorAll("[data-switch-sensitivity]").forEach(button => button.addEventListener("click", async () => {
      state.settings.surfaceWheelSensitivity = Number(button.dataset.switchSensitivity);
      await persist();
      render();
    }));
    app.querySelectorAll("[data-theme-color]").forEach(button => button.addEventListener("click", async () => { state.settings.themeColor = button.dataset.themeColor; state.customThemeColorOpen = false; applySettings(); await persist(); render(); }));
    app.querySelector(".color-picker-dot")?.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      state.customThemeColorOpen = !state.customThemeColorOpen;
      render();
    });
    app.querySelector("[data-custom-theme-color]")?.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
    });
    app.querySelector("[data-custom-theme-color]")?.addEventListener("input", event => setCustomThemeColor(event.target.value || state.settings.themeColor, { save: true }));
    const colorField = app.querySelector("[data-theme-color-field]");
    colorField?.addEventListener("pointerdown", event => {
      event.preventDefault();
      event.stopPropagation();
      const pointerId = event.pointerId;
      const move = moveEvent => {
        if (moveEvent.pointerId !== pointerId) return;
        moveEvent.preventDefault();
        setCustomThemeColorFromField(moveEvent, false);
      };
      const up = upEvent => {
        if (upEvent.pointerId !== pointerId) return;
        colorField.releasePointerCapture?.(pointerId);
        colorField.removeEventListener("pointermove", move);
        colorField.removeEventListener("pointerup", up);
        colorField.removeEventListener("pointercancel", up);
        setCustomThemeColorFromField(upEvent, true);
      };
      colorField.setPointerCapture?.(pointerId);
      colorField.addEventListener("pointermove", move);
      colorField.addEventListener("pointerup", up);
      colorField.addEventListener("pointercancel", up);
      setCustomThemeColorFromField(event, false);
    });
    app.querySelector("[data-theme-color-hue]")?.addEventListener("input", event => {
      const hsv = rgbToHsv(hexToRgb(state.settings.themeColor || "#ffd21a"));
      setCustomThemeColor(hsvToHex(Number(event.target.value), hsv.s, hsv.v), { save: true });
    });
    app.querySelector("[data-export-all]")?.addEventListener("click", async () => { try { await window.dayline?.exportAll?.(); } catch (error) { console.error(error); alert("导出失败：" + error.message); } });
    app.querySelector("[data-import-json]")?.addEventListener("click", async () => { const result = await window.dayline?.importJson?.(); if (result && !result.canceled) { await loadData(); render(); } });
    app.querySelector("[data-create-backup]")?.addEventListener("click", async () => { const result = await window.dayline?.createBackup?.(); if (result?.filePath) alert(`已备份：${result.filePath}`); });
    app.querySelector("[data-open-data-dir]")?.addEventListener("click", () => window.dayline?.openDataDir?.());
    app.querySelector("[data-open-backup-dir]")?.addEventListener("click", () => window.dayline?.openBackupDir?.());
    app.querySelector("[data-export-ics]")?.addEventListener("click", () => window.dayline?.exportIcs?.(state.events));
    app.querySelector("[data-toggle-trash]")?.addEventListener("click", () => { state.showTrash = true; state.showSettings = false; render(); });
    app.querySelector("[data-close-lightbox]")?.addEventListener("click", closeImageFullscreen);
    app.querySelector(".glass-app")?.addEventListener("mouseenter", () => window.dayline?.autoHidePointer?.(true));
    app.querySelector(".glass-app")?.addEventListener("mouseleave", () => window.dayline?.autoHidePointer?.(false));
    app.querySelectorAll("[data-setting]").forEach(input => {
      const settingKey = input.dataset.setting;
      const saveSetting = async ({ rerender = true } = {}) => {
        const key = settingKey;
        let value = input.type === "checkbox" ? input.checked : input.value;
        if (key === "opacity" || key === "surfaceWheelSensitivity") value = Number(value);
        state.settings[key] = value;
        if (key === "launchAtStartup") window.dayline?.setLoginItem(value);
        if (key === "eventTodoColor" || key === "eventDoneColor") {
          state.events.forEach(event => { event.color = event.completed ? state.settings.eventDoneColor : state.settings.eventTodoColor; });
        }
        applySettings();
        await persist();
        if (rerender) render();
      };
      if (settingKey === "opacity" && input.type === "range") {
        input.addEventListener("input", () => {
          state.settings.opacity = Number(input.value);
          applySettings();
          const output = app.querySelector("[data-opacity-value]");
          if (!output) return;
          output.textContent = `${Math.round(state.settings.opacity * 100)}%`;
          output.classList.add("visible");
        });
        input.addEventListener("change", async () => {
          state.settings.opacity = Number(input.value);
          applySettings();
          app.querySelector("[data-opacity-value]")?.classList.remove("visible");
          await persist();
        });
        return;
      }
      if (input.type === "range") input.addEventListener("input", () => saveSetting({ rerender: false }));
      input.addEventListener("change", () => saveSetting());
    });
    if (!window.__xiaoyeKeybindsInstalled) {
      window.__xiaoyeKeybindsInstalled = true;
      window.addEventListener("keydown", event => {
        if (event.isComposing) return;
        const mod = event.ctrlKey || event.metaKey;
        if (mod && !event.altKey && !event.shiftKey && /^[1-4]$/.test(event.key)) {
          event.preventDefault();
          switchSurface(surfaceItems[Number(event.key) - 1][0]).catch(console.error);
          return;
        }
        if (mod && !event.altKey && event.key.toLowerCase() === "n") {
          event.preventDefault();
          focusQuickCapture();
          return;
        }
        if (mod && event.key === ",") {
          event.preventDefault();
          state.showSettings = !state.showSettings;
          if (!state.showSettings) state.customThemeColorOpen = false;
          render();
          return;
        }
        if (mod && ["f", "k"].includes(event.key.toLowerCase())) {
          event.preventDefault();
          state.searchOpen = true;
          render();
          setTimeout(() => focusSearchInputAtEnd(), 0);
        }
        if ((event.ctrlKey || event.metaKey) && state.surface === "worktree" && state.workTreeView === "mindmap") {
          if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            changeWorkTreeZoom(WORK_TREE_ZOOM_STEP);
            return;
          }
          if (event.key === "-") {
            event.preventDefault();
            changeWorkTreeZoom(-WORK_TREE_ZOOM_STEP);
            return;
          }
          if (event.key === "0") {
            event.preventDefault();
            setWorkTreeZoom(1);
            return;
          }
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
          const target = event.target;
          if (target?.closest?.("input,textarea,[contenteditable='true']")) return;
          event.preventDefault();
          undoLastAction().catch(console.error);
        }
        if (event.key === "Escape" && state.lightboxImage) {
          closeImageFullscreen();
          return;
        }
        if (event.key === "Escape" && (state.showSettings || state.showReminderSettings) && !state.searchOpen && !state.editingTodoId && !state.editingEventId) {
          state.showSettings = false;
          state.showReminderSettings = false;
          state.customThemeColorOpen = false;
          render();
          return;
        }
        if (event.key === "Escape" && (state.searchOpen || state.showTrash || state.editingTodoId || state.editingEventId || state.workTreeContextMenu || state.showWorkTreeTrash)) {
          if ((state.editingEventId && editorSaveStates.event.busy) || (state.editingTodoId && editorSaveStates.todo.busy)) return;
          state.searchOpen = false;
          state.showTrash = false;
          state.showWorkTreeTrash = false;
          state.workTreeContextMenu = null;
          state.pendingTodoDraft = null;
          state.editingTodoId = "";
          if (state.pendingEventDraft?.id === state.editingEventId) state.pendingEventDraft = null;
          state.editingEventId = "";
          state.editingOccurrenceDate = "";
          render();
          restoreEditorEntry();
        }
      });
    }
  }

  // 快速记录：Ctrl+N 或全局快捷键 Ctrl+Alt+N，按当前页面直接进入输入状态。
  function focusQuickCapture() {
    if (!dataLoaded) { pendingQuickCapture = true; return; }
    state.searchOpen = false;
    state.showSettings = false;
    state.showReminderSettings = false;
    if (state.surface === "notes") {
      if (state.noteFilter === "archived") state.noteFilter = "active";
      state.showNewNote = true;
      render();
      selectInputText(app.querySelector("[data-new-note-title]"), { reveal: true });
      return;
    }
    if (state.surface === "calendar") {
      createEvent(state.selectedDate || toDateKey(new Date())).catch(console.error);
      return;
    }
    if (state.surface === "worktree" && activeWorkTree()) {
      addWorkTreeNode("", activeWorkTree().id).catch(console.error);
      return;
    }
    if (state.surface !== "todo") {
      if (state.settings.multiOpen) { window.dayline?.openSurface?.("todo"); return; }
      switchSurface("todo").then(() => setTimeout(focusQuickCapture, 0)).catch(console.error);
      return;
    }
    if (state.todoTodayOnly) { state.todoTodayOnly = false; persistUiStatePatch({ todoTodayOnly: false }); }
    render();
    selectInputText(app.querySelector("[data-new-todo-inline]"), { reveal: true });
  }

  function clearMissingEditingTargets() {
    if (state.editingTodoId && state.pendingTodoDraft?.id !== state.editingTodoId && !state.todos.some(todo => todo.id === state.editingTodoId)) {
      console.warn("正在编辑的待办已在其他窗口删除，未自动恢复。");
      state.editingTodoId = "";
    }
    if (state.editingEventId && !state.events.some(event => event.id === state.editingEventId) && state.pendingEventDraft?.id !== state.editingEventId) {
      console.warn("正在编辑的日程已在其他窗口删除，未自动恢复。");
      state.editingEventId = "";
      state.editingOccurrenceDate = "";
    }
    if (state.editingWorkTreeTitleId && !state.workTrees.some(tree => tree.id === state.editingWorkTreeTitleId)) state.editingWorkTreeTitleId = "";
    if (state.editingWorkTreeTabTitleId && !state.workTrees.some(tree => tree.id === state.editingWorkTreeTabTitleId)) state.editingWorkTreeTabTitleId = "";
    if (state.editingWorkNodeTitleId && !state.workTrees.some(tree => tree.nodes?.some(node => node.id === state.editingWorkNodeTitleId))) state.editingWorkNodeTitleId = "";
  }

  async function refreshDataFromStore(preservedDraft = null) {
    const before = mergeEditorDrafts(preservedDraft, captureEditorDraft());
    await loadData();
    if (compositionActive) {
      dataRefreshQueued = true;
      queuedRefreshDraft = mergeEditorDrafts(queuedRefreshDraft, before, captureEditorDraft());
      return;
    }
    clearMissingEditingTargets();
    render(mergeEditorDrafts(before, captureEditorDraft()));
  }

  function requestDataRefresh(preservedDraft = null) {
    dataRefreshQueued = true;
    queuedRefreshDraft = mergeEditorDrafts(queuedRefreshDraft, preservedDraft, captureEditorDraft());
    if (compositionActive) return dataRefreshPromise || Promise.resolve();
    if (dataRefreshPromise) return dataRefreshPromise;
    dataRefreshPromise = (async () => {
      while (dataRefreshQueued && !compositionActive) {
        dataRefreshQueued = false;
        const draft = queuedRefreshDraft;
        queuedRefreshDraft = null;
        await refreshDataFromStore(draft);
      }
    })().finally(() => {
      dataRefreshPromise = null;
      if (dataRefreshQueued && !compositionActive) requestDataRefresh().catch(console.error);
    });
    return dataRefreshPromise;
  }

  app.addEventListener("input", event => markDraftControlDirty(event.target), true);
  document.addEventListener("paste", event => {
    if (state.surface !== "calendar" || document.querySelector("dialog[open]") || event.defaultPrevented) return;
    const image = [...(event.clipboardData?.items || [])].find(item => /^image\/(png|jpeg)$/.test(item.type));
    if (!image) return;
    event.preventDefault();
    openScheduleImport(image.getAsFile());
  });
  app.addEventListener("change", event => markDraftControlDirty(event.target), true);
  app.addEventListener("compositionstart", () => { compositionActive = true; }, true);
  app.addEventListener("compositionend", () => {
    compositionActive = false;
    if (dataRefreshQueued) queueMicrotask(() => requestDataRefresh().catch(console.error));
  }, true);

  window.dayline?.onDataChanged?.(() => {
    persistEpoch += 1;
    workTreeMutationEpoch += 1;
    const refresh = requestDataRefresh();
    dataRefreshBarrier = refresh.then(() => undefined, () => undefined);
    refresh.catch(console.error);
  });

  window.dayline?.onQuickCapture?.(() => focusQuickCapture());

  window.dayline?.onCalendarToday?.(() => {
    if (!dataLoaded || state.surface !== "calendar") return;
    showCalendarToday();
  });


  window.dayline?.onAutoHideState?.(value => {
    document.documentElement.dataset.autoHideCollapsed = value?.collapsed ? "true" : "false";
    document.documentElement.dataset.autoHideEdge = value?.edge || "";
    document.body.classList.toggle("edge-left", value?.edge === "left");
    document.body.classList.toggle("edge-right", value?.edge === "right");
  });

  async function startApp() {
    try {
      await loadData();
      dataLoaded = true;
      pageStatus.hidden = true;
      if (state.surface === "calendar") selectCalendarToday();
      render();
      if (!reminderLoopStarted) { reminderLoopStarted = true; startReminderLoop(); }
      if (pendingQuickCapture) { pendingQuickCapture = false; setTimeout(focusQuickCapture, 0); }
    } catch (_) {
      dataLoaded = false;
      applySettings();
      app.innerHTML = `<main class="glass-app"><section class="data-load-error" role="alert"><h2>暂时无法读取便签数据</h2><p>原有内容未被覆盖。请重新读取后继续操作。</p><button type="button" data-retry-load>重新读取</button></section></main>`;
      app.querySelector("[data-retry-load]").onclick = event => { event.currentTarget.disabled = true; event.currentTarget.textContent = "正在读取…"; startApp(); };
    }
  }
  startApp();
})();
