(function (root) {
  const Calendar = typeof module !== 'undefined' ? require('./reminderRules') : root.ReminderRules;
  const Tasks = typeof module !== 'undefined' ? require('./taskState') : root.TaskState;
  const variables = ['提醒名称', '日期', '星期', '日程', '待办'];
  const personalTemplate = '【{提醒名称}】\n{日期} {星期}\n\n【日程】\n{日程}\n\n【待办】\n{待办}';
  function defaults(prefs = {}, shared = {}) {
    const morning = shared.morning || String(prefs.send_time || '08:00').slice(0, 5);
    const evening = shared.evening || String(prefs.evening_time || '22:00').slice(0, 5);
    return [
      { id: 'morning', name: '今日事项', mode: 'daily', time: morning, range: 'today', sources: ['events', 'todos'], enabled: prefs.morning_enabled !== false, template: personalTemplate, skipEmpty: true },
      { id: 'evening', name: '明日事项', mode: 'daily', time: evening, range: 'tomorrow', sources: ['events', 'todos'], enabled: prefs.evening_enabled !== false, template: personalTemplate, skipEmpty: true },
      { id: 'advance', name: '事项提前提醒', mode: 'advance', time: morning, advanceMinutes: shared.advanceMinutes ?? 30, range: 'today', sources: ['events', 'todos'], enabled: prefs.advance_enabled !== false, template: personalTemplate, skipEmpty: true },
    ].map(normalize);
  }
  function normalize(rule) {
    const id = String(rule.id || ''), name = String(rule.name || '').trim(), template = String(rule.template || '');
    const mode = rule.mode || 'daily', time = rule.time || '08:00', range = rule.range || 'today';
    const advanceMinutes = Number(rule.advanceMinutes ?? 30);
    const sources = [...new Set(rule.sources || [])];
    if (!/^[\w-]{1,100}$/.test(id) || !name || name.length > 60) throw Error('请填写 1–60 字的提醒名称。');
    if (!['daily', 'advance'].includes(mode) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !Number.isInteger(advanceMinutes) || advanceMinutes < 0 || advanceMinutes > 1440) throw Error('请填写有效时间，提前分钟为 0–1440 的整数。');
    if (!['today', 'tomorrow'].includes(range) || sources.some(key => !['events', 'todos'].includes(key)) || (mode === 'advance' && range !== 'today')) throw Error('请选择有效的内容和日期范围。');
    if (mode === 'advance' && !sources.length) throw Error('事项提前提醒至少选择一种内容来源。');
    if (!template.trim() || template.length > 2000) throw Error('请填写输出格式，最多 2000 字。');
    return { id, name, mode, time, advanceMinutes, range, sources, enabled: rule.enabled !== false, template, skipEmpty: rule.skipEmpty !== false };
  }
  function normalizeList(rules) {
    if (!Array.isArray(rules) || rules.length > 20) throw Error('最多设置 20 条提醒。');
    const result = rules.map(normalize);
    if (new Set(result.map(row => row.id)).size !== result.length) throw Error('提醒编号重复，请重新添加。');
    return result;
  }
  const key = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  function shift(day, amount) { const date = new Date(day + 'T12:00:00'); date.setDate(date.getDate() + amount); return key(date); }
  function render(rule, data, today = key(new Date())) {
    rule = normalize(rule);
    const day = rule.range === 'tomorrow' ? shift(today, 1) : today;
    const sources = new Set(rule.sources);
    const ordered = events => events.sort((a, b) => String(a.startTime || '99:99').localeCompare(String(b.startTime || '99:99')));
    const events = sources.has('events') ? ordered((data.events || []).filter(e => Calendar.occurs(e, day))) : [];
    const linked = new Set(events.map(e => e.todoId).filter(Boolean));
    const todos = sources.has('todos') ? (data.todos || []).filter(t => !t.completed && t.targetDate === day && !linked.has(t.id)) : [];
    const lines = items => items.map(item => `${item.startTime || item.targetTime || ''} ${Tasks.title(data, item)}`.trim()).join('\n');
    const values = { 提醒名称: rule.name, 日期: `${Number(day.slice(5, 7))}.${Number(day.slice(8))}`, 星期: '周' + '日一二三四五六'[new Date(day + 'T12:00:00').getDay()], 日程: lines(events), 待办: lines(todos) };
    const hasContent = events.length + todos.length > 0 || !sources.size;
    const content = rule.template.replace(/\{(提醒名称|日期|星期|日程|待办)\}/g, (_, name) => values[name] || '暂无');
    return { content, hasContent, skipped: rule.skipEmpty && !hasContent };
  }
  const api = { variables, personalTemplate, defaults, normalize, normalizeList, render };
  if (typeof module !== 'undefined') module.exports = api; else root.ReminderTemplates = api;
})(typeof window !== 'undefined' ? window : globalThis);
