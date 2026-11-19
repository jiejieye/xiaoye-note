(function (root) {
  "use strict";
  const pad = n => String(n).padStart(2, "0");
  const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && dateKey(new Date(`${s}T12:00:00`)) === s;
  function chineseNumber(value) {
    if (/^\d+$/.test(value)) return +value;
    const digits = '零一二三四五六七八九';
    value = value.replace(/两/g, '二').replace(/〇/g, '零');
    if (value.includes('十')) { const [tens, units] = value.split('十'); return (tens ? digits.indexOf(tens) : 1) * 10 + (units ? digits.indexOf(units) : 0); }
    return digits.indexOf(value);
  }
  function timeRange(text) {
    text = text.normalize('NFKC').replace(/(\d{1,2}|[一二两三四五六七八九十]+)\s*([-—~～至到])\s*(?=(?:\d{1,2}|[一二两三四五六七八九十]+)\s*[点时])/g, '$1点$2');
    const matches = [...text.matchAll(/(?:(上午|早上|早晨|下午|晚上|傍晚|中午|凌晨)\s*)?(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*[:：点时]\s*(半|一刻|三刻|\d{1,2}|[零〇一二两三四五六七八九十]{1,3})?/g)];
    let period = '';
    const times = matches.slice(0, 2).map(m => {
      period = m[1] || period;
      let hour = chineseNumber(m[2]);
      const minute = m[3] === '半' ? 30 : m[3] === '一刻' ? 15 : m[3] === '三刻' ? 45 : m[3] ? chineseNumber(m[3]) : 0;
      if (/下午|晚上|傍晚/.test(period) && hour < 12) hour += 12;
      if (period === '中午' && hour < 11) hour += 12;
      if (/凌晨|早上|早晨/.test(period) && hour === 12) hour = 0;
      return hour >= 0 && hour < 24 && minute >= 0 && minute < 60 ? `${pad(hour)}:${pad(minute)}` : '';
    });
    return { startTime: times[0] || '', endTime: times[1] || '' };
  }
  const readTime = text => timeRange(text).startTime;
  function noticeDate(text, reference) {
    text = text.normalize('NFKC').replace(/([零〇一二两三四五六七八九十]{1,3})(?=[月日号])/g, value => String(chineseNumber(value)));
    const m = text.match(/(?:(\d{4})\s*[年/.-]\s*)?(\d{1,2})\s*[月/]\s*(\d{1,2})\s*[日号]?|(?:(\d{4})[-.])(\d{1,2})[-.](\d{1,2})/);
    if (m) {
      const date = `${m[1] || m[4] || reference.slice(0, 4)}-${pad(m[2] || m[5])}-${pad(m[3] || m[6])}`;
      return { date: validDate(date) ? date : '', hint: validDate(date) ? '按原文日期' : '原文日期无效，请修正' };
    }
    const relative = text.match(/大后天|后天|明天|明日|今天|今日/), weekday = text.match(/(下下周|下周|本周|这周|周|星期|礼拜)([一二三四五六日天])/);
    const date = new Date(`${reference}T12:00:00`);
    if (relative) date.setDate(date.getDate() + ({ 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3 }[relative[0]]));
    else if (weekday) {
      const day = '日一二三四五六'.indexOf(weekday[2] === '天' ? '日' : weekday[2]);
      const weeks = { 下下周: 14, 下周: 7, 本周: 0, 这周: 0 };
      const offset = Object.hasOwn(weeks, weekday[1]) ? (day + 6) % 7 - (date.getDay() + 6) % 7 + weeks[weekday[1]] : (day - date.getDay() + 7) % 7;
      date.setDate(date.getDate() + offset);
    }
    return { date: dateKey(date), hint: relative || weekday ? `按参考日期 ${reference} 换算` : `未提供日期，暂按 ${reference}；可修改` };
  }
  function keywords(raw) {
    const headline = String(raw || '').normalize('NFKC').split(/\r?\n/).find(line => line.trim())?.replace(/^(?:标题|事项|事件|日程|任务|项目|主题|活动名称)\s*[:：]\s*/, '').trim() || '';
    const found = [];
    const add = (value, index) => {
      value = value.trim();
      if (value.length < 2 || value.length > 32 || found.some(item => item.value === value)) return;
      found.push({ value, index });
    };
    const quoted = [...headline.matchAll(/[《“「【]([^》”」】\n]{2,32})[》”」】]/g)];
    quoted.forEach(match => { if (!/^(?:重要)?通知$/.test(match[1])) add(match[1], match.index); });
    for (const match of headline.matchAll(/(?:19|20)\d{2}(?!\d)/g)) add(match[0], match.index);
    for (const match of headline.matchAll(/\d{1,2}月份?/g)) add(match[0], match.index);
    for (const match of headline.matchAll(/新生|毕业生|研究生|本科生|教职工|开题报告|毕业答辩|学术报告|研讨会|交流会|考试|考核|培训|会议|讲座|报名|答辩|汇报|讨论|开题|提交|评审|竞赛|比赛|实践|研讨|体检|面试|演练|迎新|调研|申报|申领|缴费|返校|注册/g)) {
      if (!quoted.some(quote => match.index > quote.index && match.index < quote.index + quote[0].length)) add(match[0], match.index);
    }
    const subject = headline.replace(/[《“「【][^》”」】\n]*[》”」】]/g, '|').replace(/(?:\d{4}[年/.-])?\d{1,2}[月/.-]\d{1,2}[日号]?/g, '|').replace(/(?:上午|早上|下午|晚上|中午|凌晨)?\s*(?:\d{1,2}|[一二两三四五六七八九十]+)[:：点时](?:半|一刻|三刻|\d{1,2}|[一二三四五六七八九十]+)?/g, '|').replace(/(?:19|20)\d{2}\s*[年级届]?/g, '|').replace(/关于|组织|开展|举办|召开|举行|进行|参加|参与|及其|以及|相关|有关|通知|安排|要求|请于|请在|请|的/g, '|');
    for (const part of subject.split(/[|，,。；;:：\s]+/)) {
      const value = part.replace(/^[级届年]+|[年月日号]+$/g, '');
      if (/^[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9·-]{1,15}$/u.test(value) && !/^(?:所有人|各单位|各部门|各学院|各位同学|各位老师|现将|如下|事项|时间|地点|上午|下午|晚上|今天|明天|后天)$/.test(value)) add(value, headline.indexOf(value));
      for (const word of new Intl.Segmenter('zh', { granularity: 'word' }).segment(value)) {
        if (word.isWordLike && /\p{L}/u.test(word.segment) && !/^(?:月份?|年|今天|明天|后天|上午|下午|晚上)$/.test(word.segment)) add(word.segment, headline.indexOf(value) + word.index);
      }
    }
    return found.sort((a, b) => a.index - b.index || b.value.length - a.value.length).slice(0, 32).map(item => item.value);
  }
  function locationKeywords(raw, current = '') {
    const text = String(raw || '').normalize('NFKC');
    const places = [];
    const add = value => {
      value = String(value || '').trim().replace(/^(?:地点|地址|会场|教室|位置)\s*[:：]\s*/, '').replace(/^[\s，,:：]+|[\s，,。；;]+$/g, '').split(/(?:[，,；;]\s*(?:时间|请|联系人|联系电话|参会|注意|要求))|(?:举行|召开|开展|进行|集合|签到|报到)/)[0].trim();
      if (value.length >= 2 && value.length <= 80 && !places.includes(value)) places.push(value);
    };
    add(current);
    for (const match of text.matchAll(/(?:地点|地址|教室|会议室|会场|位置|线上平台)\s*[:：]\s*([^\n；;]+)/g)) add(match[1]);
    for (const match of text.matchAll(/(?:^|\n)\s*(?:地点|地址|教室|会议室|会场|位置)(?:安排在|设在|在|为|是)?\s*[:：]?\s*([^\n；;]+)/g)) add(match[1]);
    for (const match of text.matchAll(/(?:在|于|前往|设在|位于)\s*([^\n，,。；;]{1,65}?(?:报告厅|会议室|教室|图书馆|体育馆|会议中心|会堂|[A-Za-z]?座\s*\d{2,5}|[\d一二三四五六七八九十]+(?:楼|室)|升华前\s*\d{2,5})(?:\s*[A-Za-z\d一二三四五六七八九十]{0,8}(?:层|楼|报告厅|会议室|教室|室|座)){0,4})/g)) add(match[1]);
    for (const line of text.split(/\r?\n/)) {
      if (/^(?:\S{1,20}(?:校区|教学楼|实验楼|图书馆|报告厅|会议室)|[A-Za-z]座\d{2,5}|升华前\d{2,5})\s*$/.test(line.trim())) add(line);
    }
    for (const place of [...places]) {
      for (const part of place.split(/[，,、/\s]+/)) {
        const pieces = part.match(/[^，,\s]*?(?:大学|学院|校区|大厦|教学楼|实验楼|综合楼|图书馆|体育馆|会议中心|报告厅|会议室|教室|会堂|[座栋楼室])(?:\d{2,5})?|升华前\d{2,5}|\d{2,5}(?:教室|会议室)?/g) || [];
        if (pieces.join('') === part) pieces.forEach(value => add(value));
        else if (part !== place && /校区|楼|室|座|厅|馆|中心|路|街|号|升华前/.test(part)) add(part);
      }
    }
    return places.slice(0, 16);
  }

  function notices(raw, reference) {
    if (!validDate(reference)) throw new Error("请填写有效的通知发布日期。");
    const lines = raw.split(/\r?\n/).map(s => s.replace(/[📢📍⏰📋🔹✅⚠️🎉👇①②③④⑤]/gu, "").replace(/^[-*•]\s*|^\d+[)）、]\s*|^\d+\.\s+/, '').trim());
    const blocks = [];
    for (const line of lines) {
      if (!line) continue;
      const datedLine = /^(?:\d{4}[年/.-])?\d{1,2}[月/]\d{1,2}|^\d{4}[-.]\d{1,2}[-.]\d{1,2}|^(?:今天|明天|后天|大后天|今日|明日|(?:下下周|下周|本周|周|星期|礼拜)[一二三四五六日天])/.test(line);
      const previousDated = blocks.at(-1)?.some(previous => /\d{1,2}[月/.-]\d{1,2}|今天|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]/.test(previous));
      if (!blocks.length || (blocks.at(-1).length && (/^(?:标题|事项|事件|日程|任务|项目)\s*[:：]/.test(line) || /^【/.test(line) || (datedLine && previousDated)))) blocks.push([]);
      blocks.at(-1).push(line);
    }
    return blocks.filter(lines => lines.length).flatMap(lines => {
      const text = lines.join("\n"), { date, hint } = noticeDate(text, reference);
      const location = locationKeywords(text)[0] || '';
      let title = (lines.find(x => /^(?:标题|事项|事件|日程|任务|项目|主题|活动名称)\s*[:：]/.test(x)) || lines.find(x => !/^(?:时间|日期|地点|地址|开始|结束|联系人)\s*[:：]/.test(x)) || lines[0] || "").replace(/@所有人/g, "").replace(/【重要通知】/g, "").replace(/[【】]/g, "").replace(/^(?:标题|事项|事件|日程|任务|项目|主题|活动名称)\s*[:：]\s*/, '').trim();
      title = title.replace(/^(?:(?:\d{4}[年/.-])?\d{1,2}[月/.-]\d{1,2}[日号]?|大后天|后天|明天|明日|今天|今日|(?:下下周|下周|本周|这周|周|星期|礼拜)[一二三四五六日天])\s*[，,:：]?\s*/, '').replace(/^(?:上午|早上|下午|晚上|中午|凌晨)?\s*(?:\d{1,2}|[一二两三四五六七八九十]+)[:：点时](?:半|一刻|三刻|\d{1,2}|[一二三四五六七八九十]+)?(?:\s*[-—~～至到]\s*(?:上午|下午|晚上)?(?:\d{1,2}|[一二两三四五六七八九十]+)(?:[:：点时](?:半|\d{1,2}|[一二三四五六七八九十]+)?)?)?\s*/, '').replace(/\s*(?:时间|地点|地址)\s*[:：].*$/, '').trim() || '待办事项';
      if (/第一次班会/.test(title)) title = "第一次班会";
      const phases = lines.filter(x => /第[一二三四五六\d]+阶段/.test(x) && readTime(x));
      const ti = lines.findIndex(x => /^时间/.test(x));
      const timeText = ti < 0 ? text : lines.slice(ti, ti + 2).join(" ");
      return (phases.length ? phases : [null]).map(p => {
        const times = timeRange(p || timeText);
        return { title: p ? p.replace(/^.*?阶段\s*[｜|:：]?\s*/, "").replace(/[（(].*$/, "").trim() : title, date, ...times, location, note: text, repeat: "none", hint: `${hint}；${times.startTime ? '已提取时间，请核对' : '未提供时间，按全天导入'}。${/毕业典礼/.test(text) ? '原文提到毕业典礼，请核对活动名称。' : ''}` };
      });
    });
  }
  function courses(raw, weekOne, periods) {
    if (!validDate(weekOne)) throw new Error("请填写有效的第 1 周起始日期。");
    const slots = {};
    for (const line of periods.split(/\n|，|,/)) {
      const m = line.match(/(\d+)\s*[-—~～]\s*(\d+)节?\s+(\d{1,2}[:：]\d{2})\s*[-—~～]\s*(\d{1,2}[:：]\d{2})/);
      if (m) slots[`${+m[1]}-${+m[2]}`] = [readTime(m[3]), readTime(m[4])];
    }
    return raw.split(/\r?\n/).filter(x => x.trim()).map(line => {
      const m = line.match(/周([一二三四五六日天])\s*(\d+)\s*[-—~～]\s*(\d+)节\s*[，,]?\s*(\d+)\s*[-—~～]\s*(\d+)\s*周?\s*(单周|双周)?\s*(.+)/);
      if (!m) throw new Error(`无法识别课程：${line}。格式：周三1-2节，2-17周 课程名 地点 教师`);
      const first = +m[4], last = +m[5], slot = slots[`${+m[2]}-${+m[3]}`];
      if (first < 1 || last < first || last > 53) throw new Error("课程周次应在 1–53 周内，结束周不得早于开始周。");
      if (slot && (!slot[0] || !slot[1] || slot[1] <= slot[0])) throw new Error(`请修正 ${m[2]}-${m[3]} 节的时间，或留空按全天导入。`);
      const base = new Date(`${weekOne}T12:00:00`), weekday = "日一二三四五六".indexOf(m[1] === "天" ? "日" : m[1]);
      const dates = [], skipped = [];
      for (let w = first; w <= last; w++) {
        const d = new Date(base); d.setDate(d.getDate() + (w - 1) * 7 + (weekday - base.getDay() + 7) % 7);
        if ((m[6] === "单周" && w % 2 === 0) || (m[6] === "双周" && w % 2 === 1)) skipped.push(dateKey(d)); else dates.push(dateKey(d));
      }
      if (!dates.length) throw new Error("该周次范围内没有符合单双周条件的课程。");
      const parts = m[7].trim().split(/\s+/), location = parts.slice(1).find(x => /座|楼|室|报告厅/.test(x)) || "";
      return { title: parts[0], date: dates[0], startTime: slot?.[0] || '', endTime: slot?.[1] || '', location, repeat: "weekly", repeatEndDate: dates.at(-1), repeatSkippedDates: skipped, courseGroupId: JSON.stringify(['course-text', weekOne, line.trim()]), note: `课表原文：${line}\n第1周起始：${weekOne}\n${first}–${last}周 ${m[6] || "每周"}`, hint: `共 ${dates.length} 次，${dates[0]} 至 ${dates.at(-1)}；${slot ? '班级和教师信息保留在备注中' : '未提供时间，按全天导入'}。` };
    });
  }
  function courseTemplate({ title, teacher, location, first, last, parity, weekOne, meetings, note = "" }) {
    if (!title.trim()) throw new Error("请填写课程名称。");
    if (!validDate(weekOne)) throw new Error("请填写第 1 周起始日期。");
    first = Number(first); last = Number(last);
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > 53) throw new Error("请填写有效的起止周次（1–53 周）。");
    if (!meetings.length) throw new Error("请至少添加一个上课时段。");
    const courseGroupId = JSON.stringify(['course-template', title.trim(), teacher.trim(), weekOne, first, last, parity, location.trim(), meetings.map(({ weekday, startTime, endTime }) => [String(weekday), startTime || '', endTime || '']).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
    return meetings.map(({ weekday, startTime, endTime }) => {
      if (weekday === "" || !/^[0-6]$/.test(String(weekday))) throw new Error("请选择每个时段的星期，原文缺少星期时不能自动推断。");
      if ((startTime && (!/^\d{2}:\d{2}$/.test(startTime) || readTime(startTime) !== startTime)) || (endTime && (!startTime || !/^\d{2}:\d{2}$/.test(endTime) || readTime(endTime) !== endTime || endTime <= startTime))) throw new Error("请检查上课起止时间；也可全部留空按全天导入。");
      const base = new Date(`${weekOne}T12:00:00`), dates = [], skipped = [];
      for (let w = first; w <= last; w++) {
        const d = new Date(base); d.setDate(d.getDate() + (w - 1) * 7 + (+weekday - base.getDay() + 7) % 7);
        if ((parity === "odd" && w % 2 === 0) || (parity === "even" && w % 2 === 1)) skipped.push(dateKey(d)); else dates.push(dateKey(d));
      }
      if (!dates.length) throw new Error("该周次范围没有符合单双周条件的课程。");
      return { title: title.trim(), teacher: teacher.trim(), location: location.trim(), date: dates[0], startTime, endTime, repeat: "weekly", repeatEndDate: dates.at(-1), repeatSkippedDates: skipped, courseGroupId, note: `教师：${teacher.trim()}\n第1周起始：${weekOne}\n第${first}–${last}周\n${note}`.trim(), hint: `共 ${dates.length} 次，${dates[0]} 至 ${dates.at(-1)}。` };
    });
  }
  function courseDetails(raw, periods) {
    const text = raw.normalize('NFKC').replace(/&#x20;|&nbsp;/g, ' ');
    const weeks = text.match(/(?:第)?(\d+)\s*[-—~～至到]\s*(\d+)\s*周/);
    const title = text.match(/(?:课程(?:名称)?|科目)\s*[:：]\s*([^\n，,；;]+)/)?.[1].trim();
    let teacher = text.match(/(?:任课教师|教师|老师)\s*[:：]\s*([^\n，,；;]+)/)?.[1].trim() || '';
    const location = text.match(/(?:地点|教室)\s*[:：]\s*([^\n，,；;]+)/)?.[1].trim() || text.match(/\S*(?:座|楼|室|升华前|报告厅)\s*\d*/)?.[0].trim() || '';
    const weekdays = [...text.matchAll(/(?:周|星期|礼拜)([一二三四五六日天1-7])/g)];
    const meetings = weekdays.map((m, index) => {
      const segment = text.slice(m.index + m[0].length, weekdays[index + 1]?.index ?? text.length);
      const slot = segment.match(/^\s*(\d+(?:\s*[-—~～至到]\s*\d+)?)\s*节/);
      const times = timeRange(segment);
      if (slot && !times.startTime) {
        const key = slot[1].replace(/\s/g, '').replace(/[-—~～至到]/g, '-');
        const found = periods.split('\n').find(line => line.replace(/\s/g, '').startsWith(`${key}节`));
        if (found) Object.assign(times, timeRange(found));
      }
      return { weekday: String(/\d/.test(m[1]) ? +m[1] % 7 : '日一二三四五六'.indexOf(m[1] === '天' ? '日' : m[1])), ...times };
    });
    let inferred = title || '';
    if (!inferred) {
      inferred = text.replace(/(?:第)?\d+\s*[-—~～至到]\s*\d+周\s*(?:单周|双周)?/g, '').replace(/(?:周|星期|礼拜)[一二三四五六日天1-7]\s*\d*(?:\s*[-—~～至到]\s*\d+)?\s*节?/g, '').replace(/(?:上午|下午|晚上)?\d{1,2}:\d{2}(?:\s*[-—~～至到]\s*\d{1,2}:\d{2})?/g, '').split(/[\n，,；;]/).find(line => line.trim() && !/^(?:教师|老师|地点|教室)\s*[:：]/.test(line.trim()))?.trim() || '';
      if (inferred && location && inferred.includes(location)) {
        const [name, rest] = inferred.split(location);
        inferred = name.trim();
        if (!teacher) teacher = rest.trim();
      }
    }
    return { title: inferred, teacher, location, first: weeks?.[1], last: weeks?.[2], parity: /单周/.test(text) ? 'odd' : /双周/.test(text) ? 'even' : 'all', meetings };
  }
  const api = { notices, courses, courseTemplate, courseDetails, timeRange, validDate, dateKey, keywords, locationKeywords };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ScheduleImport = api;
})(typeof window !== "undefined" ? window : globalThis);
