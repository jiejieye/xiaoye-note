// 快速输入解析：从一句话里识别日期、时间和重复规则，例如
// “明天下午3点 开会”“周五 交报告”“每周一 9:30 组会”“10月12日 体检”。
(function (root) {
  const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 七: 0 };
  const NUM = "[0-9]{1,4}|[零〇一二两三四五六七八九十]{1,3}";

  function toNumber(value) {
    if (value == null || value === "") return NaN;
    if (/^\d+$/.test(value)) return Number(value);
    if (value === "十") return 10;
    if (value.length === 2 && value[0] === "十") return 10 + CN_DIGITS[value[1]];
    if (value.length === 2 && value[1] === "十") return CN_DIGITS[value[0]] * 10;
    if (value.length === 3 && value[1] === "十") return CN_DIGITS[value[0]] * 10 + CN_DIGITS[value[2]];
    return value.length === 1 && value in CN_DIGITS ? CN_DIGITS[value] : NaN;
  }

  const pad = number => String(number).padStart(2, "0");
  const dateKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const addDays = (date, days) => { const next = new Date(date); next.setDate(next.getDate() + days); return next; };
  const validDate = (y, m, d) => { const date = new Date(y, m - 1, d); return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null; };

  // 本周/这周 = 本周内；下周 = 下周内；无前缀 = 最近的那一天（含今天）。
  function weekdayDate(today, weekday, prefix) {
    const monday = addDays(today, -((today.getDay() + 6) % 7));
    const offset = (weekday + 6) % 7;
    if (prefix === "下") return addDays(monday, 7 + offset);
    if (prefix === "下下") return addDays(monday, 14 + offset);
    if (prefix === "本" || prefix === "这") return addDays(monday, offset);
    const diff = (weekday - today.getDay() + 7) % 7;
    return addDays(today, diff);
  }

  function parse(input, now = new Date()) {
    const original = String(input || "");
    let text = ` ${original} `;
    const today = startOfDay(now);
    const result = { title: original.trim(), date: "", time: "", repeat: "none", labels: [] };
    let date = null;
    let weekdayHint = null;
    let dayPart = "";
    const take = (regex, handler) => {
      const match = text.match(regex);
      if (!match) return false;
      if (handler(match) === false) return false;
      text = text.slice(0, match.index) + " " + text.slice(match.index + match[0].length);
      return true;
    };

    // 重复规则
    take(/每(?:个)?工作日|工作日每天/, () => { result.repeat = "workdays"; });
    if (result.repeat === "none") take(/每(?:天|日)/, () => { result.repeat = "daily"; });
    if (result.repeat === "none") take(/每(?:周|星期|礼拜)([一二三四五六日天七])?/, match => { result.repeat = "weekly"; if (match[1]) weekdayHint = WEEKDAY[match[1]]; });
    if (result.repeat === "none") take(new RegExp(`每月(?:(${NUM})(?:号|日))?`), match => { result.repeat = "monthly"; if (match[1]) { const day = toNumber(match[1]); const candidate = validDate(today.getFullYear(), today.getMonth() + 1, day); date = candidate && candidate >= today ? candidate : validDate(today.getFullYear(), today.getMonth() + 2, day) || candidate; } });
    if (result.repeat === "none") take(/每年/, () => { result.repeat = "yearly"; });

    // 日期
    take(/今晚/, () => { date = today; dayPart = "晚"; });
    if (!date) take(/大后天/, () => { date = addDays(today, 3); });
    if (!date) take(/后天/, () => { date = addDays(today, 2); });
    if (!date) take(/明(?:天|日|早|晚)/, match => { date = addDays(today, 1); if (match[0] === "明晚") dayPart = "晚"; if (match[0] === "明早") dayPart = "早"; });
    if (!date) take(/今(?:天|日)/, () => { date = today; });
    if (!date) take(new RegExp(`(${NUM})天(?:后|以后|之后)`), match => { const days = toNumber(match[1]); if (!(days >= 0 && days < 3660)) return false; date = addDays(today, days); });
    if (!date) take(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日|号)?/, match => { date = validDate(Number(match[1]), Number(match[2]), Number(match[3])); if (!date) return false; });
    if (!date) take(new RegExp(`(${NUM})月(${NUM})(?:日|号)?`), match => {
      const month = toNumber(match[1]), day = toNumber(match[2]);
      let candidate = validDate(today.getFullYear(), month, day);
      if (candidate && candidate < today) candidate = validDate(today.getFullYear() + 1, month, day);
      if (!candidate) return false;
      date = candidate;
    });
    if (!date) take(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/, match => {
      const month = Number(match[1]), day = Number(match[2]);
      let candidate = validDate(today.getFullYear(), month, day);
      if (candidate && candidate < today) candidate = validDate(today.getFullYear() + 1, month, day);
      if (!candidate) return false;
      date = candidate;
    });
    if (!date) take(/(下下|下|本|这)?(?:个)?(?:周|星期|礼拜)([一二三四五六日天七])/, match => { date = weekdayDate(today, WEEKDAY[match[2]], match[1] || ""); });
    if (!date && weekdayHint !== null) date = weekdayDate(today, weekdayHint, "");

    // 时间
    const applyPart = (hour, part) => {
      if (/下午|晚|傍晚/.test(part) && hour < 12) return hour + 12;
      if (/中午/.test(part) && hour < 11) return hour + 12;
      if (/凌晨|早|上午/.test(part) && hour === 12) return 0;
      return hour;
    };
    take(/(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|晚)?\s*(\d{1,2})[:：](\d{2})/, match => {
      let hour = Number(match[2]); const minute = Number(match[3]);
      if (hour > 23 || minute > 59) return false;
      hour = applyPart(hour, match[1] || dayPart);
      result.time = `${pad(hour)}:${pad(minute)}`;
    });
    if (!result.time) take(new RegExp(`(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|晚)?\\s*(?<![第快慢多少好大小高低有差近远轻重这那些再])(${NUM})\\s*(?:点钟?|时)(?:\\s*(半|一刻|三刻|(${NUM})\\s*分?))?`), match => {
      // “快一点”“早一点”这类口语不是时间。
      if (match[2] === "一" && !match[3] && !/凌晨|中午|下午|晚上|夜里/.test(match[1] || "")) return false;
      let hour = toNumber(match[2]);
      if (!(hour >= 0 && hour <= 24)) return false;
      let minute = 0;
      if (match[3] === "半") minute = 30;
      else if (match[3] === "一刻") minute = 15;
      else if (match[3] === "三刻") minute = 45;
      else if (match[4]) minute = toNumber(match[4]);
      if (!(minute >= 0 && minute <= 59)) return false;
      if (hour === 24) hour = 0;
      hour = applyPart(hour, match[1] || dayPart);
      result.time = `${pad(hour)}:${pad(minute)}`;
    });

    if (result.time && !date) {
      // 只写了时间：如果今天这个时间已经过了，就放到明天。
      const [h, m] = result.time.split(":").map(Number);
      const candidate = new Date(today); candidate.setHours(h, m, 0, 0);
      date = candidate < now && result.repeat === "none" ? addDays(today, 1) : today;
    }
    if (result.repeat !== "none" && !date) date = today;

    const title = text.replace(/\s+/g, " ").replace(/^[\s,，、.。:：-]+|[\s,，、.。:：-]+$/g, "").trim();
    if (!title) return { title: original.trim(), date: "", time: "", repeat: "none", labels: [] };
    result.title = title;
    result.date = date ? dateKey(date) : "";
    result.labels = describe(result, now);
    return result;
  }

  function describe(result, now = new Date()) {
    const labels = [];
    if (result.date) {
      const today = startOfDay(now);
      const [y, m, d] = result.date.split("-").map(Number);
      const target = new Date(y, m - 1, d);
      const diff = Math.round((target - today) / 86400000);
      const week = "日一二三四五六"[target.getDay()];
      labels.push(diff === 0 ? "今天" : diff === 1 ? "明天" : diff === 2 ? "后天" : `${m}月${d}日 周${week}`);
    }
    if (result.time) labels.push(result.time);
    const repeatNames = { daily: "每天", workdays: "工作日", weekly: "每周", monthly: "每月", yearly: "每年" };
    if (repeatNames[result.repeat]) labels.push(repeatNames[result.repeat]);
    return labels;
  }

  const api = { parse, describe };
  if (typeof module !== "undefined") module.exports = api;
  if (root) root.QuickParse = api;
})(typeof window !== "undefined" ? window : null);
