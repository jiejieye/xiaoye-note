const EVENT_COLORS = {
  work: "#4f8cc9",
  life: "#4da37b",
  study: "#9a78c7",
  important: "#d96b5f",
  other: "#d9a441"
};

const DEFAULT_SETTINGS = {
  launchAtStartup: false,
  alwaysOnTop: false,
  opacity: 0.88,
  fontScale: 1,
  theme: "light",
  defaultView: "week",
  defaultDuration: 60,
  showLunar: true,
  showHolidays: true,
  showWeather: true,
  completedCollapsed: true,
  widgetMode: false,
  accentColor: "#4f8cc9",
  enableEdgeAutoHide: false,
  keepWindowsOnScreen: true,
  hideTaskbarIcon: false,
  surfaceWheelSensitivity: 5,
  reminderLead: "none",
  pauseReminders: false,
  autoBackup: true,
  todayWidgetAlwaysOnTop: true,
  startupMode: "restore"
};

const DEFAULT_DATA = {
  todoLists: [
    { id: "list-work", name: "工作", tag: "工作", color: "#4f8cc9", order: 0 },
    { id: "list-life", name: "生活", tag: "生活", color: "#4da37b", order: 1 }
  ],
  noteLists: [
    { id: "notes-main", name: "备忘", tag: "备忘", color: "#d9a441", order: 0 },
    { id: "notes-ideas", name: "灵感", tag: "灵感", color: "#9a78c7", order: 1 }
  ],
  todos: [
    { id: "todo-demo-1", title: "整理本周项目优先级", completed: false, pinned: true, order: 0, listId: "list-work", tags: ["工作"], targetDate: "2026-06-09", reminderAt: "2026-06-09T09:00:00.000Z", repeat: "weekly", scheduledEventId: "", createdAt: "2026-06-02T09:00:00.000Z", updatedAt: "2026-06-02T09:00:00.000Z" },
    { id: "todo-demo-2", title: "读完产品体验笔记", completed: false, pinned: false, order: 1, listId: "list-work", tags: ["学习"], targetDate: "2026-06-12", reminderAt: "", repeat: "none", scheduledEventId: "", createdAt: "2026-06-02T09:10:00.000Z", updatedAt: "2026-06-02T09:10:00.000Z" },
    { id: "todo-demo-3", title: "预约体检", completed: false, pinned: false, order: 2, listId: "list-life", tags: ["生活"], targetDate: "2026-06-20", reminderAt: "", repeat: "yearly", scheduledEventId: "", createdAt: "2026-06-02T09:20:00.000Z", updatedAt: "2026-06-02T09:20:00.000Z" }
  ],
  events: [
    { id: "event-demo-1", title: "晨会同步", date: "2026-06-06", startTime: "09:30", endTime: "10:00", color: "#4f8cc9", source: "工作日程", tags: ["工作"], repeat: "workdays", note: "确认今天的三个关键事项", completed: false, createdAt: "2026-06-02T08:00:00.000Z", updatedAt: "2026-06-02T08:00:00.000Z" },
    { id: "event-demo-2", title: "专注写方案", date: "2026-06-06", startTime: "14:00", endTime: "15:30", color: "#d96b5f", source: "个人规划", tags: ["重要"], repeat: "none", note: "", completed: false, createdAt: "2026-06-02T08:05:00.000Z", updatedAt: "2026-06-02T08:05:00.000Z" }
  ],
  notes: [
    { id: "note-demo-1", title: "桌面便签想法", body: "透明窗口要足够轻，信息密度高一点，但不要压迫。", listId: "notes-ideas", tags: ["灵感"], pinned: true, archived: false, archiveDate: "", order: 0, createdAt: "2026-06-02T10:00:00.000Z", updatedAt: "2026-06-02T10:00:00.000Z" },
    { id: "note-demo-2", title: "会议备忘", body: "周五前整理需求清单，先做可预览版本，再考虑封装。", listId: "notes-main", tags: ["备忘", "工作"], pinned: false, archived: false, archiveDate: "", order: 1, createdAt: "2026-06-02T11:00:00.000Z", updatedAt: "2026-06-02T11:00:00.000Z" }
  ],
  backups: [],
  trash: [],
  anniversaries: [],
  workTrees: [],
  reminderPreferences: [],
  settings: DEFAULT_SETTINGS,
  windowState: { main: { width: 1320, height: 860 }, widget: { width: 400, height: 560 } },
  imageAnnotations: {}
};

if (typeof module !== "undefined") module.exports = { EVENT_COLORS, DEFAULT_SETTINGS, DEFAULT_DATA };
if (typeof window !== "undefined") {
  window.EVENT_COLORS = EVENT_COLORS;
  window.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  window.DEFAULT_DATA = DEFAULT_DATA;
}
