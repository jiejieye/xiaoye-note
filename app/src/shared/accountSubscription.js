(function (root) {
  const dayMilliseconds = 86400000;
  const dateKey = date => date.toISOString().slice(0, 10);
  const dateValue = value => Date.parse(`${value}T00:00:00Z`);

  function validDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(dateValue(value)) && dateKey(new Date(dateValue(value))) === value;
  }

  function daysBetween(start, end) {
    return Math.round((dateValue(end) - dateValue(start)) / dayMilliseconds);
  }

  function nextExpiry(from, cycle, days = 30, anchor = from) {
    if (!validDate(from) || !validDate(anchor)) return '';
    const date = new Date(dateValue(from));
    if (cycle === 'days') {
      if (!Number.isInteger(Number(days)) || Number(days) < 1) return '';
      date.setUTCDate(date.getUTCDate() + Number(days));
    } else {
      const month = cycle === 'yearly' ? Number(anchor.slice(5, 7)) - 1 : date.getUTCMonth() + (cycle === 'quarterly' ? 3 : 1);
      const year = date.getUTCFullYear() + (cycle === 'yearly' ? 1 : 0);
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      date.setUTCFullYear(year, month, Math.min(Number(anchor.slice(8, 10)), lastDay));
    }
    return dateKey(date);
  }

  function counts(subscription, today) {
    const remaining = daysBetween(today, subscription.expiresOn);
    const through = today < subscription.expiresOn ? today : subscription.expiresOn;
    return { remaining, continuous: Math.max(0, daysBetween(subscription.startedOn, through)) };
  }

  function displayItems(subscription) {
    return subscription?.displayVersion === 2 && Array.isArray(subscription.display) ? subscription.display : ['remaining'];
  }

  function badge(subscription, today) {
    const { remaining, continuous } = counts(subscription, today);
    const display = displayItems(subscription);
    const expired = remaining < 0 || Boolean(subscription.markedExpired);
    const level = expired ? 'expired' : 'normal';
    const left = subscription.markedExpired && remaining >= 0 ? '到期' : remaining < 0 ? `过期${-remaining}` : remaining === 0 ? '今天' : `${remaining}天`;
    const parts = [];
    if (display.includes('continuous')) parts.push(`用${continuous}`);
    if (display.includes('remaining')) parts.push(left);
    return { text: parts.join('·'), level, remaining, continuous };
  }

  function label(title, subscription, today) {
    const { text } = badge(subscription, today);
    return title + (text ? ` · ${text}` : '');
  }

  function calculate(from, period, days, direction = 1) {
    if (!validDate(from)) return '';
    const date = new Date(dateValue(from));
    if (period === 'days') {
      if (!Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 3660) return '';
      date.setUTCDate(date.getUTCDate() + Number(days) * direction);
    } else {
      const months = { month: 1, quarter: 3, year: 12 }[period];
      if (!months) return '';
      const targetMonth = date.getUTCMonth() + months * direction;
      const last = new Date(Date.UTC(date.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
      date.setUTCFullYear(date.getUTCFullYear(), targetMonth, Math.min(date.getUTCDate(), last));
    }
    return dateKey(date);
  }

  function continuousStart(previous, chargedOn, renewing) {
    if (!previous) return chargedOn;
    if (chargedOn < previous.startedOn) return chargedOn;
    if (renewing) return chargedOn > previous.expiresOn ? chargedOn : previous.startedOn;
    if (chargedOn === previous.chargedOn || previous.history?.length && chargedOn <= previous.expiresOn) return previous.startedOn;
    return chargedOn;
  }

  function validate(value) {
    if (!validDate(value.chargedOn)) return ['charged-on', '请填写有效的充值日期。'];
    if (!validDate(value.expiresOn) || value.expiresOn < value.chargedOn) return ['expires-on', '到期日期不能早于订阅日期。'];
    if (!validDate(value.startedOn) || value.startedOn > value.chargedOn) return ['started-on', '连续起始日期须早于或等于本次充值日期。'];
    if (!['monthly', 'quarterly', 'yearly', 'days'].includes(value.cycle)) return ['period', '请选择计算时长。'];
    if (value.cycle === 'days' && (!Number.isInteger(Number(value.cycleDays)) || Number(value.cycleDays) < 1 || Number(value.cycleDays) > 3660)) return ['period-days', '计算天数须为1至3660天。'];
    return null;
  }

  function renew(previous, chargedOn) {
    const from = chargedOn > previous.expiresOn ? chargedOn : previous.expiresOn;
    const anchor = chargedOn > previous.expiresOn ? chargedOn : previous.billingAnchor || previous.expiresOn;
    return {
      ...previous,
      chargedOn,
      expiresOn: nextExpiry(from, previous.cycle, previous.cycleDays, anchor),
      startedOn: chargedOn > previous.expiresOn ? chargedOn : previous.startedOn
    };
  }

  function save(value, previous, renewing) {
    const history = [...(previous?.history || [])];
    if (renewing && previous) history.push({ chargedOn: previous.chargedOn, expiresOn: previous.expiresOn, startedOn: previous.startedOn });
    const sameBilling = previous && value.chargedOn <= previous.expiresOn && previous.cycle === value.cycle && (renewing || previous.expiresOn === value.expiresOn);
    return { ...value, cycleDays: Number(value.cycleDays) || 30, billingAnchor: sameBilling ? previous.billingAnchor || previous.expiresOn : value.expiresOn, history };
  }

  const api = { validDate, daysBetween, nextExpiry, counts, displayItems, badge, label, calculate, continuousStart, validate, renew, save };
  if (typeof module !== 'undefined') module.exports = api;
  if (root) root.AccountSubscription = api;
})(typeof window === 'undefined' ? null : window);
