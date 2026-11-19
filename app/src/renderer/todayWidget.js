(function () {
  const root = document.querySelector("#today-widget");
  let data = { events: [], settings: {} };
  let adding = false;
  let refreshVersion = 0;
  let currentDateKey = toDateKey(new Date());

  function toDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function parseDate(key) {
    const [year, month, day] = String(key || "").split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  function addMonthsClamped(date, months) {
    const day = date.getDate();
    const next = new Date(date.getFullYear(), date.getMonth() + months, 1);
    next.setDate(Math.min(day, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
    return next;
  }

  function normalizeRepeat(value) {
    const normalized = String(value || "none").toLowerCase();
    const aliases = { weekday: "workdays", weekdays: "workdays", workday: "workdays" };
    const next = aliases[normalized] || normalized;
    return ["none", "daily", "workdays", "weekly", "monthly", "yearly"].includes(next) ? next : "none";
  }

  function nextRepeatDate(dateKey, repeat) {
    const date = parseDate(dateKey);
    if (Number.isNaN(date.getTime())) return "";
    if (repeat === "daily") return toDateKey(addDays(date, 1));
    if (repeat === "workdays") {
      let next = date;
      do { next = addDays(next, 1); } while ([0, 6].includes(next.getDay()));
      return toDateKey(next);
    }
    if (repeat === "weekly") return toDateKey(addDays(date, 7));
    if (repeat === "monthly") return toDateKey(addMonthsClamped(date, 1));
    if (repeat === "yearly") return toDateKey(addMonthsClamped(date, 12));
    return "";
  }

  function eventOccursToday(event, today) {
    if (event?.ongoing) return window.EventState.ongoingOccursOnDate(event, today, today);
    if ((event?.repeatSkippedDates || []).includes(today)) return false;
    if (!event?.date || event.date === today) return event?.date === today;
    const repeat = normalizeRepeat(event.repeat);
    if (repeat === "none" || today <= event.date) return false;
    if (event.repeatEndDate && today > event.repeatEndDate) return false;
    let cursor = event.date;
    for (let index = 0; index < 420; index += 1) {
      cursor = nextRepeatDate(cursor, repeat);
      if (!cursor || (event.repeatEndDate && cursor > event.repeatEndDate)) return false;
      if (cursor === today) return true;
      if (cursor > today) return false;
    }
    return false;
  }

  function esc(value) {
    return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function todayEvents() {
    const today = toDateKey(new Date());
    return (data.events || [])
      .filter(event => eventOccursToday(event, today))
      .map(event => ({ ...event, completed: window.EventState.occurrenceCompleted(event, today) }))
      .sort((left, right) => {
        if (Boolean(left.ongoing) !== Boolean(right.ongoing)) return left.ongoing ? 1 : -1;
        if (left.ongoing && right.ongoing) return (Number(right.priority) || 2) - (Number(left.priority) || 2);
        if (Boolean(left.completed) !== Boolean(right.completed)) return left.completed ? 1 : -1;
        const leftTime = left.startTime || "99:99";
        const rightTime = right.startTime || "99:99";
        return leftTime.localeCompare(rightTime) || String(left.title || "").localeCompare(String(right.title || ""), "zh-CN");
      });
  }

  function applyAppearance() {
    const settings = data.settings || {};
    document.documentElement.dataset.theme = settings.theme === "light" ? "light" : "dark";
    document.documentElement.style.setProperty("--accent", settings.themeColor || settings.accentColor || "#ffd21a");
    document.documentElement.style.setProperty("--window-opacity", settings.opacity ?? .88);
    window.dayline?.setOpacity?.(settings.opacity ?? .88);
  }

  function render() {
    applyAppearance();
    const events = todayEvents();
    const alwaysOnTop = data.settings?.todayWidgetAlwaysOnTop !== false;
    root.innerHTML = `
      <section class="today-card">
        <header class="today-head">
          <h1>今日</h1>
          <div class="today-tools">
            <button class="today-tool ${adding ? "active" : ""}" data-add title="新增日程" aria-label="新增日程"><span class="add-glyph" aria-hidden="true"></span></button>
            <button class="today-tool ${alwaysOnTop ? "active" : ""}" data-pin title="${alwaysOnTop ? "取消置顶" : "置顶窗口"}" aria-label="${alwaysOnTop ? "取消置顶" : "置顶窗口"}"><span class="pin-glyph" aria-hidden="true"></span></button>
            <button class="today-tool" data-close title="关闭" aria-label="关闭"><span class="close-glyph" aria-hidden="true"></span></button>
          </div>
        </header>
        ${adding ? `<div class="today-add"><input data-new-event maxlength="200" placeholder="输入日程，Enter 添加" autocomplete="off" /></div>` : ""}
        ${events.length ? `<ul class="today-list">${events.map((event, index) => `${event.ongoing && !events[index - 1]?.ongoing ? `<li class="today-followup-divider">跟进任务</li>` : ""}
          <li class="today-row ${event.completed ? "done" : ""} ${event.startTime ? "" : "no-time"}">
            <button class="today-check ${event.completed ? "checked" : ""}" data-toggle-event="${esc(event.id)}" data-completed="${event.completed ? "true" : "false"}" aria-label="${event.completed ? "标记未完成" : "标记完成"}"></button>
            ${event.startTime ? `<time class="today-time">${esc(event.startTime)}</time>` : ""}
            <span class="today-title" title="${esc(window.TaskState.title(data, event))}${event.ongoing && event.progress ? `-${esc(event.progress)}` : ""}">${esc(window.TaskState.title(data, event))}${event.ongoing && event.progress ? `<span class="today-progress-text">-${esc(event.progress)}</span>` : ""}</span>
          </li>`).join("")}</ul>` : `<div class="today-empty">今天没有日程</div>`}
      </section>`;
    bind();
  }

  function bind() {
    root.querySelector("[data-add]")?.addEventListener("click", () => {
      adding = !adding;
      render();
      if (adding) setTimeout(() => root.querySelector("[data-new-event]")?.focus(), 0);
    });
    const input = root.querySelector("[data-new-event]");
    input?.addEventListener("keydown", async event => {
      if (event.key === "Escape") {
        adding = false;
        render();
        return;
      }
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      input.disabled = true;
      const result = await window.dayline?.addTodayEvent?.(title);
      if (result?.added) adding = false;
      await refresh();
    });
    input?.addEventListener("blur", () => setTimeout(() => {
      if (document.activeElement !== input && adding) {
        adding = false;
        render();
      }
    }, 0));
    root.querySelectorAll("[data-toggle-event]").forEach(button => button.addEventListener("click", async () => {
      button.disabled = true;
      await window.dayline?.toggleTodayEvent?.(button.dataset.toggleEvent, button.dataset.completed !== "true", toDateKey(new Date()));
      await refresh();
    }));
    root.querySelector("[data-pin]")?.addEventListener("click", async () => {
      const key = "todayWidgetAlwaysOnTop";
      const next = data.settings?.[key] === false;
      data.settings = { ...(data.settings || {}), [key]: next };
      render();
      await window.dayline?.setTodayWidgetAlwaysOnTop?.(next);
    });
    root.querySelector("[data-close]")?.addEventListener("click", () => window.dayline?.closeTodayWidget?.());
  }

  async function refresh() {
    const version = ++refreshVersion;
    const next = await window.dayline?.loadData?.();
    if (version !== refreshVersion || !next) return;
    data = next;
    currentDateKey = toDateKey(new Date());
    render();
  }

  window.dayline?.onDataChanged?.(() => refresh().catch(console.error));
  setInterval(() => {
    const next = toDateKey(new Date());
    if (next === currentDateKey) return;
    currentDateKey = next;
    render();
  }, 30000);
  refresh().catch(console.error);
})();
