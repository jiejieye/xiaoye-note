(function () {
  function setEventCompleted(event, completed, today) {
    const next = Boolean(completed);
    if (event.ongoing && !event.completed && next) event.date = today;
    event.completed = next;
  }

  function ongoingOccursOnDate(event, date, today) {
    return event.completed ? date === event.date : date === today && event.date <= today;
  }

  function sameSeries(left, right) {
    if (left.courseGroupId && right.courseGroupId) return left.courseGroupId === right.courseGroupId;
    return (left.repeatParentId || left.id) === (right.repeatParentId || right.id);
  }

  function isSeriesEvent(events, event) {
    return !event.ongoing && Boolean(event.courseGroupId || event.repeat && event.repeat !== "none" || event.repeatParentId && events.some(item => sameSeries(item, event) && item.repeat && item.repeat !== "none"));
  }

  function occurrenceCompleted(event, date) {
    return Boolean(event.completed && (event.ongoing || !event.repeat || event.repeat === "none" || date === event.date));
  }

  function occurrenceFor(events, event, date, id, now) {
    if (event.ongoing || !event.repeat || event.repeat === "none") return event;
    const parent = event.repeatParentId || event.id;
    const existing = events.find(item => item.repeatParentId === parent && (!item.repeat || item.repeat === "none") && (item.repeatOccurrenceDate || item.date) === date);
    event.repeatSkippedDates = Array.from(new Set([...(event.repeatSkippedDates || []), date]));
    event.updatedAt = now;
    if (existing) return existing;
    const occurrence = { ...event, id, date, completed: occurrenceCompleted(event, date), repeat: "none", repeatEndDate: "", repeatSkippedDates: [], repeatParentId: parent, repeatOccurrenceDate: date, reminderLastKey: "", reminderLastFiredAt: "", createdAt: now, updatedAt: now };
    events.push(occurrence);
    return occurrence;
  }

  function linkedTodoCompleted(events, todoId, nextDate) {
    const linked = events.filter(event => event.todoId === todoId);
    return linked.length > 0 && linked.every(event => {
      if (event.ongoing || !event.repeat || event.repeat === "none") return Boolean(event.completed);
      if (!event.repeatEndDate) return false;
      const skipped = new Set(event.repeatSkippedDates || []);
      let date = event.date;
      while (date && date <= event.repeatEndDate) {
        if (!skipped.has(date) && !occurrenceCompleted(event, date)) return false;
        const next = nextDate(date, event.repeat);
        if (!next || next <= date) return false;
        date = next;
      }
      return true;
    });
  }

  const api = { setEventCompleted, ongoingOccursOnDate, sameSeries, isSeriesEvent, occurrenceCompleted, occurrenceFor, linkedTodoCompleted };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof window !== "undefined") window.EventState = api;
})();
