(function (root) {
  const defaults = { morning: '08:00', evening: '22:00', advanceMinutes: 30 };
  const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  function preferences(data) { return { ...defaults, ...(data.reminderPreferences || []).find(row => row.id === 'reminders') }; }
  function occurs(event, day) {
    if (event.completed || !event.date || day < event.date || (event.repeatSkippedDates || []).includes(day)) return false;
    if (event.ongoing) return true;
    if (event.date === day) return true;
    if (event.repeatEndDate && day > event.repeatEndDate) return false;
    const start = new Date(event.date + 'T12:00:00'), end = new Date(day + 'T12:00:00');
    const diff = Math.round((end - start) / 86400000);
    if (event.repeat === 'daily') return true;
    if (['workdays', 'weekday', 'weekdays', 'workday'].includes(event.repeat)) return ![0, 6].includes(end.getDay());
    if (event.repeat === 'weekly') return diff % 7 === 0;
    if (event.repeat === 'monthly' || event.repeat === 'yearly') {
      if (event.repeat === 'yearly' && start.getMonth() !== end.getMonth()) return false;
      const last = new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate();
      return end.getDate() === Math.min(start.getDate(), last);
    }
    return false;
  }
  function summary(data, day, today, titleOf = item => item.title) {
    const events = (data.events || []).filter(e => occurs(e, day)).sort((a, b) => String(a.startTime || '99').localeCompare(b.startTime || '99'));
    const ids = new Set(events.map(e => e.todoId).filter(Boolean));
    const todos = (data.todos || []).filter(t => !t.completed && t.targetDate === day && !ids.has(t.id));
    const tomorrow = new Date(today + 'T12:00:00'); tomorrow.setDate(tomorrow.getDate() + 1);
    const next = dateKey(tomorrow);
    return `【日程】\n${events.map(e => `${e.startTime || ''} ${titleOf(e)}`.trim()).join('\n') || '暂无'}\n\n【待办】\n${todos.map(titleOf).join('\n') || '暂无'}`;
  }
  function due(data, now, titleOf = item => item.title) {
    const prefs = preferences(data), day = dateKey(now), result = [];
    if (data.settings?.pauseReminders) return result;
    const inWindow = time => { const at = new Date(time); return now >= at && now - at < 600000; };
    for (const [kind, time] of [['morning', prefs.morning], ['evening', prefs.evening]]) {
      if (!inWindow(day + 'T' + time + ':00')) continue;
      const target = new Date(day + 'T12:00:00'); if (kind === 'evening') target.setDate(target.getDate() + 1);
      result.push({ key: `${kind}:${day}`, title: kind === 'morning' ? '今日提醒' : '明日提醒', body: summary(data, dateKey(target), day, titleOf) });
    }
    const linked = new Set((data.events || []).filter(e => !e.completed && e.startTime).map(e => e.todoId).filter(Boolean));
    const tomorrow = new Date(day + 'T12:00:00'); tomorrow.setDate(tomorrow.getDate() + 1);
    for (const eventDay of [day, dateKey(tomorrow)]) for (const e of data.events || []) {
      if (!e.startTime || !occurs(e, eventDay)) continue;
      if (e.todoId) linked.add(e.todoId);
      const starts = new Date(`${eventDay}T${e.startTime}:00`);
      const lead = e.reminderLead && !['none', 'default'].includes(e.reminderLead) ? e.reminderLead : prefs.advanceMinutes;
      const at = lead === 'morning' ? new Date(`${eventDay}T${prefs.morning}:00`) : new Date(starts - Number(lead) * 60000);
      if (inWindow(at)) result.push({ key: `event:${e.id}:${eventDay}:${e.startTime}`, title: `日程提醒：${titleOf(e)}`, body: `${eventDay} ${e.startTime}` });
    }
    for (const todo of data.todos || []) {
      if (todo.completed || linked.has(todo.id)) continue;
      const time = todo.startTime || todo.targetTime;
      if (!time || !todo.targetDate) continue;
      const starts = new Date(`${todo.targetDate}T${time}:00`);
      const lead = todo.reminderLead && !['none', 'default'].includes(todo.reminderLead) ? todo.reminderLead : prefs.advanceMinutes;
      const at = lead === 'morning' ? new Date(`${todo.targetDate}T${prefs.morning}:00`) : new Date(starts - Number(lead) * 60000);
      if (inWindow(at)) result.push({ key: `todo:${todo.id}:${todo.targetDate}:${time}`, title: `待办提醒：${titleOf(todo)}`, body: `${todo.targetDate} ${time}` });
    }
    for (const [kind, rows] of [['event', data.events || []], ['todo', data.todos || []]]) for (const item of rows) {
      if (item.completed || (kind === 'event' && item.startTime) || (kind === 'todo' && (linked.has(item.id) || item.startTime || item.targetTime))) continue;
      const lead = String(item.reminderLead || (item.reminderAt ? '0' : 'none'));
      if (lead === 'none' && !item.reminderAt) continue;
      const base = item.reminderAt || ((kind === 'event' ? item.date : item.targetDate) ? `${kind === 'event' ? item.date : item.targetDate}T09:00:00` : '');
      const at = new Date(base);
      if (lead === 'morning') { const [hours, minutes] = prefs.morning.split(':').map(Number); at.setHours(hours, minutes, 0, 0); }
      else if (lead !== 'none') at.setMinutes(at.getMinutes() - Number(lead || 0));
      if (!Number.isNaN(at.getTime()) && now >= at && now - at < 7 * 86400000) {
        const key = `${kind}:${item.id}:${at.toISOString()}`;
        if (item.reminderLastKey !== key) result.push({ key, title: `${kind === 'todo' ? '待办' : '日程'}提醒：${titleOf(item)}`, body: String(base).replace('T', ' ') });
      }
    }
    return result;
  }
  const api = { defaults, preferences, occurs, summary, due };
  if (typeof module !== 'undefined') module.exports = api; else root.ReminderRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
