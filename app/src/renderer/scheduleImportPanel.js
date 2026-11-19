window.ScheduleImport.open = function ({ existing, save, calendarId = 'self', person = '', imageFile }) {
  const parser = window.ScheduleImport;
  const dialog = document.createElement("dialog");
  dialog.className = "schedule-import";
  dialog.setAttribute('aria-label', '离线识别日程');
  dialog.innerHTML = `<form><header><strong>离线识别日程</strong><button type="button" data-close>关闭</button></header><p>本地规则识别，无需 API 或网络。请核对后导入。</p><label>内容类型<select name="mode"><option value="notice">通知文字</option><option value="course">课表文字</option></select></label><label data-reference>通知发布日期<input name="reference" type="date" value="${parser.dateKey(new Date())}"></label><section data-course hidden><label>第 1 周起始日期<input name="weekOne" type="date" value="2026-09-06"></label><label>节次时间（每行一组，可修改）<textarea name="periods" rows="2">1-2节 08:00-09:40\n3-4节 10:00-11:40</textarea></label><p>周日换周。每行一门课程，例如：周三1-2节，2-17周 示例课程 1班 A座101 张老师</p></section><label>粘贴内容<textarea name="raw" rows="6" placeholder="粘贴通知，或每行一门课程"></textarea></label><button type="button" data-parse>粘贴并识别</button><p data-status role="status"></p><div data-results></div><footer><button type="submit" disabled>确认导入</button></footer></form>`;
  document.body.append(dialog);
  const form = dialog.querySelector("form"), status = dialog.querySelector("[data-status]"), results = dialog.querySelector("[data-results]"), submit = dialog.querySelector('[type="submit"]');
  form.noValidate = true;
  const count = document.createElement('p'); count.dataset.importCount = ''; count.setAttribute('aria-live', 'polite'); results.before(count);
  form.elements.mode.closest('label').hidden = true;
  form.elements.reference.closest('label').firstChild.textContent = '参考'; form.elements.reference.closest('label').title = '参考日期：原文没有日期时使用，可修改'; form.elements.reference.setAttribute('aria-label', '参考日期');
  const modes = document.createElement('div');
  modes.className = 'import-mode-buttons';
  modes.innerHTML = '<button type="button" data-mode="notice" class="active" aria-pressed="true">通知</button><button type="button" data-mode="course" aria-pressed="false">课程</button>';
  const header = form.querySelector('header');
  header.querySelector('strong').textContent = '识别';
  header.querySelector('strong').after(modes);
  const closeButton = header.querySelector('[data-close]'); closeButton.textContent = '✕'; closeButton.setAttribute('aria-label', '关闭'); closeButton.title = '关闭';
  closeButton.before(form.elements.reference.closest('label'));
  form.querySelector('header + p').hidden = true;
  modes.querySelectorAll('button').forEach(button => button.onclick = () => { form.elements.mode.value = button.dataset.mode; form.elements.mode.dispatchEvent(new Event('change')); });
  let drafts = [], keywordStates = [], generation = 0, imageSource = '', coursePreview = false, progressTimer, saving = false;
  const courseSection = dialog.querySelector('[data-course]');
  const parseButton = dialog.querySelector('[data-parse]');
  const repaste = document.createElement('button'); repaste.type = 'button'; repaste.dataset.repaste = ''; repaste.textContent = '重新粘贴'; repaste.hidden = true;
  const sourceHint = document.createElement('p'); sourceHint.dataset.sourceHint = ''; sourceHint.hidden = true; sourceHint.textContent = '将识别当前文字；重新粘贴会替换内容。';
  form.insertBefore(form.elements.raw.closest('label'), courseSection);
  const sourceRow = document.createElement('div'); sourceRow.className = 'import-source-row';
  form.insertBefore(sourceRow, courseSection);
  sourceRow.append(parseButton, repaste);
  sourceRow.after(sourceHint, status);
  const finishProgress = () => {
    clearInterval(progressTimer);
    dialog.setAttribute('aria-busy', 'false');
    parseButton.disabled = false; repaste.disabled = false;
    updateSourceActions();
  };
  const startProgress = (message, started = performance.now()) => {
    clearInterval(progressTimer);
    const request = generation;
    dialog.setAttribute('aria-busy', 'true');
    parseButton.disabled = true; repaste.disabled = true; submit.disabled = true;
    parseButton.textContent = `${message}…`;
    const refresh = () => {
      if (request === generation && dialog.isConnected) status.textContent = `${message}… 已用 ${Math.floor((performance.now() - started) / 1000)} 秒`;
    };
    refresh(); progressTimer = setInterval(refresh, 1000);
    status.scrollIntoView({ block: 'nearest' });
  };
  const paintProgress = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
  form.elements.raw.placeholder = '粘贴通知或任务，如：明天下午三点半到五点 项目讨论。时间可留空。';
  form.elements.mode.options[1].textContent = '通用课表模板';
  form.elements.periods.value = '1-2节 08:00-09:40\n3-4节 10:00-11:40\n5-6节 14:00-15:40\n7-8节 16:00-17:40\n9-10节 19:00-20:40\n11节 21:00-21:45';
  courseSection.querySelector('p').textContent = '每门课程填写一次，可添加多个星期、多个时段。时间可全部留空，按全天导入。'; courseSection.querySelector('p').hidden = true;
  const template = document.createElement('div');
  template.className = 'course-template-grid';
  template.innerHTML = `<label>课程名称<input name="courseTitle" placeholder="例如：智能优化及其应用"></label><label>教师<input name="teacher" placeholder="例如：王勇"></label><label>地点<input name="location" placeholder="例如：升华前207"></label><label>开始周<input name="firstWeek" type="number" min="1" max="53" value="1"></label><label>结束周<input name="lastWeek" type="number" min="1" max="53" value="17"></label><label>上课周<select name="parity"><option value="all">每周</option><option value="odd">单周</option><option value="even">双周</option></select></label><div data-meetings></div><button type="button" data-add-meeting>＋ 添加上课时段</button>`;
  courseSection.append(template);
  const addMeeting = (meeting = {}) => {
    const row = document.createElement('fieldset');
    row.className = 'course-meeting-row';
    row.innerHTML = `<legend>上课时段</legend><label><span>星期</span><select data-weekday aria-label="星期"><option value="">星期</option>${[1,2,3,4,5,6,0].map(d => `<option value="${d}">周${'日一二三四五六'[d]}</option>`).join('')}</select></label><label><span>节次</span><select data-slot aria-label="节次"><option value="">节次</option>${['1-2','3-4','5-6','7-8','9-10','11'].map(s => `<option>${s}</option>`).join('')}</select></label><label><span>开始</span><input type="time" data-start aria-label="开始"></label><label><span>结束</span><input type="time" data-end aria-label="结束"></label><button type="button" data-remove aria-label="移除此时段" title="移除此时段">✕</button>`;
    row.querySelector('[data-slot]').onchange = () => {
      const selected = row.querySelector('[data-slot]').value;
      const matches = [...form.elements.periods.value.matchAll(/(\d+(?:\s*-\s*\d+)?)节\s*(\d{1,2}[:：]\d{2})\s*[-—~～]\s*(\d{1,2}[:：]\d{2})/g)];
      const slot = matches.find(m => m[1].replace(/\s/g, '') === selected);
      for (const [field, index] of [['[data-start]',2], ['[data-end]',3]]) row.querySelector(field).value = slot ? slot[index].replace('：', ':').padStart(5,'0') : '';
      invalidate();
    };
    row.querySelector('[data-remove]').onclick = () => { row.remove(); invalidate(); };
    row.addEventListener('input', invalidate);
    template.querySelector('[data-meetings]').append(row);
    row.querySelector('[data-weekday]').value = meeting.weekday ?? '';
    row.querySelector('[data-start]').value = meeting.startTime || '';
    row.querySelector('[data-end]').value = meeting.endTime || '';
  };
  const meetingValues = () => [...template.querySelectorAll('[data-meetings] fieldset')].map(row => ({ weekday: row.querySelector('[data-weekday]').value, startTime: row.querySelector('[data-start]').value, endTime: row.querySelector('[data-end]').value }));
  const close = () => {
    generation++; clearInterval(progressTimer);
    dialog.close(); dialog.remove();
  };
  dialog.querySelector("[data-close]").onclick = () => close();
  dialog.addEventListener("cancel", e => { e.preventDefault(); close(); });
  const invalidate = () => {
    generation++; clearInterval(progressTimer);
    drafts = []; keywordStates = []; coursePreview = false; results.replaceChildren(); closeLocationChoices(); dialog.classList.remove('has-results'); if (!saving) submit.textContent = '确认导入';
    count.textContent = ''; clearErrors(); updateSourceActions();
    finishProgress();
    if (form.elements.mode.value === 'course') {
      submit.disabled = false;
      status.textContent = '';
    } else { submit.disabled = true; status.textContent = ''; }
  };
  const updateSourceActions = () => {
    const active = Boolean(form.elements.raw.value.trim());
    repaste.hidden = !(active || imageSource); sourceHint.hidden = true;
    parseButton.textContent = active ? '识别' : '粘贴并识别';
  };
  const clearErrors = () => {
    dialog.querySelectorAll('[aria-invalid="true"]').forEach(input => { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); });
    dialog.querySelectorAll('.import-field-error').forEach(error => error.remove());
  };
  const fieldError = (input, message) => {
    const error = document.createElement('span'); error.className = 'import-field-error'; error.id = `import-error-${dialog.querySelectorAll('.import-field-error').length}`; error.textContent = message;
    input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', error.id); input.after(error);
    input.closest('details')?.setAttribute('open', '');
    if (!dialog.querySelector('[aria-invalid="true"]:focus')) { const first = dialog.querySelector('[aria-invalid="true"]'); first?.focus(); }
  };
  const identity = d => JSON.stringify([d.calendarId || 'self', d.title.trim(), d.date, d.startTime || "", d.endTime || "", d.location || "", d.repeat || "none", d.repeatEndDate || ""]);
  const freshDrafts = () => {
    const known = new Set(existing().map(identity));
    return drafts.filter(draft => { if (draft.__skip) return false; const id = identity(draft); if (known.has(id)) return false; known.add(id); return true; });
  };
  const updateCount = () => {
    const fresh = freshDrafts().length, skipped = drafts.filter(draft => draft.__skip).length, known = drafts.length - fresh - skipped;
    count.textContent = drafts.length ? `识别 ${drafts.length} 项 · 新增 ${fresh}${known ? ` · 已存在 ${known}（不重复导入）` : ''}${skipped ? ` · 未勾选 ${skipped}` : ''}` : '';
    if (!saving) submit.textContent = drafts.length ? `导入 ${fresh} 项` : '确认导入';
  };
  let locationPickerId = 0;
  const closeLocationChoices = except => {
    dialog.querySelectorAll('[data-location-choices]').forEach(choices => {
      if (choices.dataset.locationPicker === except) return;
      choices.hidden = true;
      dialog.querySelector(`[aria-controls="${choices.id}"]`)?.setAttribute('aria-expanded', 'false');
    });
  };
  for (const eventName of ['pointerdown', 'focusin']) dialog.addEventListener(eventName, event => {
    closeLocationChoices(event.target.closest('[data-location-picker]')?.dataset.locationPicker);
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape' && dialog.querySelector('[data-location-choices]:not([hidden])')) {
      event.preventDefault(); event.stopPropagation(); closeLocationChoices();
    }
  });
  const bindLocationChoices = (input, source, changed) => {
    const key = String(++locationPickerId);
    const label = input.closest('label'); label.dataset.locationPicker = key;
    const choices = document.createElement('div');
    choices.className = 'import-location-choices'; choices.dataset.locationChoices = ''; choices.dataset.locationPicker = key;
    choices.id = `import-location-choices-${key}`; choices.hidden = true;
    choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', '地点关键词');
    input.setAttribute('aria-controls', choices.id); input.setAttribute('aria-expanded', 'false');
    input.placeholder = '点击选择关键词，也可直接输入';
    const words = document.createElement('div'); words.className = 'import-keywords';
    const heading = document.createElement('span'); heading.textContent = '地点关键词'; words.append(heading);
    const extra = document.createElement('div'); extra.className = 'import-location-add';
    const termInput = document.createElement('input'); termInput.type = 'text'; termInput.dataset.locationTerm = '';
    termInput.placeholder = '补充未识别的地点关键词'; termInput.setAttribute('aria-label', '补充地点关键词');
    const addButton = document.createElement('button'); addButton.type = 'button'; addButton.dataset.addLocationTerm = ''; addButton.textContent = '添加';
    extra.append(termInput, addButton); choices.append(words, extra); label.after(choices);
    let selected = [], original = input.value, previousSource;
    input.addEventListener('reset-location-choices', () => {
      previousSource = undefined; selected = []; original = input.value;
      words.replaceChildren(heading); termInput.value = ''; choices.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    });
    const refresh = () => words.querySelectorAll('button').forEach(button => {
      const active = selected.includes(button.dataset.locationKeyword);
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    });
    const apply = () => {
      input.value = selected.join(' ') || original; changed(input.value); refresh();
      choices.hidden = false; input.setAttribute('aria-expanded', 'true');
    };
    const addWord = term => {
      if ([...words.querySelectorAll('button')].some(button => button.dataset.locationKeyword === term)) return;
      const button = document.createElement('button'); button.type = 'button'; button.dataset.locationKeyword = term; button.textContent = term;
      button.onclick = () => { selected = selected.includes(term) ? selected.filter(value => value !== term) : [...selected, term]; apply(); };
      words.append(button);
    };
    const open = () => {
      const text = source();
      if (text !== previousSource) {
        previousSource = text; selected = []; original = input.value; words.replaceChildren(heading); termInput.value = '';
        const terms = new Set(parser.locationKeywords(text, input.value));
        terms.forEach(addWord); refresh();
      }
      closeLocationChoices(key); choices.hidden = false; input.setAttribute('aria-expanded', 'true');
    };
    input.addEventListener('click', open); input.addEventListener('focus', open);
    input.addEventListener('input', () => { selected = []; original = input.value; refresh(); });
    addButton.onclick = () => {
      const term = termInput.value.trim();
      if (!term) { termInput.focus(); return; }
      addWord(term);
      if (!selected.includes(term)) selected.push(term);
      termInput.value = ''; apply(); termInput.focus();
    };
    termInput.addEventListener('input', event => event.stopPropagation());
    termInput.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addButton.click(); }
    });
  };
  bindLocationChoices(form.elements.location, () => form.elements.raw.value, invalidate);
  const clearPreviousSource = () => {
    imageSource = ''; form.elements.raw.value = '';
    for (const field of ['courseTitle', 'teacher', 'location']) form.elements[field].value = '';
    form.elements.location.dispatchEvent(new Event('reset-location-choices'));
    form.elements.firstWeek.value = '1'; form.elements.lastWeek.value = '17'; form.elements.parity.value = 'all';
    template.querySelector('[data-meetings]').replaceChildren(); addMeeting();
    invalidate();
  };
  template.querySelector('[data-add-meeting]').onclick = () => { addMeeting(); invalidate(); };
  template.addEventListener('input', invalidate);
  addMeeting();
  for (const name of ["raw", "reference", "weekOne", "periods"]) form.elements[name].oninput = invalidate;
  const setMode = () => {
    const mode = form.elements.mode.value;
    for (const [section, active] of [[courseSection, mode === 'course']]) {
      section.hidden = !active;
      section.querySelectorAll('input,select,textarea,button').forEach(control => { control.disabled = !active; });
    }
    form.elements.reference.closest('label').hidden = mode !== 'notice';
    form.elements.reference.disabled = mode !== 'notice';
    form.elements.raw.placeholder = mode === 'course' ? '粘贴课程、周次、星期、节次或时间；也可以直接填写下方模板。' : '粘贴通知或任务。日期和时间可留空，参考日期可修改。';
    modes.querySelectorAll('button').forEach(button => { const active = button.dataset.mode === mode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    invalidate();
  };
  form.elements.mode.onchange = setMode;
  dialog.addEventListener('paste', event => {
    if (saving) { event.preventDefault(); event.stopPropagation(); return; }
    const image = [...(event.clipboardData?.items || [])].find(item => /^image\/(png|jpeg)$/.test(item.type));
    if (image && typeof useImage === 'function') { event.preventDefault(); event.stopPropagation(); useImage(image.getAsFile()).catch(() => { status.textContent = '图片读取失败，请重新粘贴。'; }); return; }
    if (event.target !== form.elements.raw && event.target.closest?.('input,textarea,[contenteditable="true"]')) return;
    event.preventDefault(); event.stopPropagation();
    pasteText(event.clipboardData?.getData('text/plain') || '');
  });
  const showDrafts = (elapsed = '') => {
    results.replaceChildren();
    drafts.forEach(draft => { draft.calendarId = calendarId; });
    const knownIds = new Set(existing().map(identity));
    drafts.forEach((draft, i) => {
      const compact = false;
      if (!compact && knownIds.has(identity(draft))) {
        draft.__existing = true;
        const row = document.createElement('div'); row.className = 'import-existing-item'; row.title = '已存在相同日程，不会重复导入';
        const box = document.createElement('input'); box.type = 'checkbox'; box.disabled = true; box.setAttribute('aria-label', '已存在，不导入');
        const name = document.createElement('b'); name.textContent = draft.title;
        const when = document.createElement('span'); when.textContent = [draft.date, draft.startTime].filter(Boolean).join(' ');
        const tag = document.createElement('em'); tag.textContent = '已存在';
        row.append(box, name, when, tag); results.append(row); return;
      }
      const card = document.createElement(compact ? 'details' : 'fieldset');
      let content = card, summary;
      { const legend = document.createElement('legend'); legend.textContent = `第 ${i + 1} 项`; legend.className = 'import-item-legend'; card.append(legend); card.classList.add('import-notice-item'); }
      const updateSummary = () => {};
      updateSummary();
      const dateRow = document.createElement('div'); dateRow.className = 'import-date-row';
      for (const [field, label, type] of [['title', '标题', 'text'], ['date', '日期', 'date'], ['startTime', compact ? '开始（可留空）' : '开始', 'time'], ['endTime', compact ? '结束（可留空）' : '至', 'time'], ['location', '地点', 'text'], ...(draft.repeat === 'weekly' ? [['repeatEndDate', '每周截止', 'date']] : []), ['note', '备注 / 原文', 'textarea']]) {
        const wrap = document.createElement('label'); wrap.textContent = label;
        const input = document.createElement(type === 'textarea' ? 'textarea' : 'input'); if (type !== 'textarea') input.type = type;
        input.dataset.field = field; input.value = draft[field] || ''; input.required = ['title', 'date', 'repeatEndDate'].includes(field);
        input.oninput = () => { draft[field] = input.value; clearErrors(); updateSummary(); updateCount(); }; wrap.append(input);
        if (['date', 'startTime', 'endTime'].includes(field)) dateRow.append(wrap); else content.append(wrap);
      }
      content.querySelector('label').after(dateRow);
      if (!compact) {
        const locationInput = content.querySelector('[data-field="location"]');
        bindLocationChoices(locationInput, () => draft.note || form.elements.raw.value, value => { draft.location = value; clearErrors(); updateCount(); });
        const input = content.querySelector('[data-field="title"]');
        const state = keywordStates[i] || (keywordStates[i] = { terms: parser.keywords(draft.title), selected: [], originalTitle: draft.title });
        {
          const choices = document.createElement('div'); choices.className = 'import-keywords'; choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', `第 ${i + 1} 项标题关键词`);
          const label = document.createElement('span'); label.textContent = '关键词'; choices.append(label);
          const buttons = [];
          const addKeyword = term => {
            if (buttons.some(button => button.dataset.keyword === term)) return;
            const button = document.createElement('button'); button.type = 'button'; button.dataset.keyword = term; button.textContent = term;
            button.onclick = () => {
              state.selected = state.selected.includes(term) ? state.selected.filter(value => value !== term) : [...state.selected, term];
              draft.title = state.selected.join(' ') || state.originalTitle;
              input.value = draft.title; clearErrors(); updateCount(); refresh();
            };
            choices.append(button); buttons.push(button);
          };
          const refresh = () => buttons.forEach(button => { const selected = state.selected.includes(button.dataset.keyword); button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); });
          state.terms.forEach(addKeyword);
          const extra = document.createElement('div'); extra.className = 'import-location-add'; extra.style.gridColumn = '1 / -1';
          const termInput = document.createElement('input'); termInput.type = 'text'; termInput.dataset.titleTerm = ''; termInput.placeholder = '补充标题关键词'; termInput.setAttribute('aria-label', '补充标题关键词');
          const addButton = document.createElement('button'); addButton.type = 'button'; addButton.dataset.addTitleTerm = ''; addButton.textContent = '添加';
          addButton.onclick = () => {
            const term = termInput.value.trim();
            if (!term) { termInput.focus(); return; }
            addKeyword(term);
            if (!state.selected.includes(term)) state.selected.push(term);
            draft.title = state.selected.join(' '); input.value = draft.title;
            termInput.value = ''; clearErrors(); updateCount(); refresh(); termInput.focus();
          };
          termInput.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addButton.click(); }
          });
          extra.append(termInput, addButton);
          input.addEventListener('input', () => { state.selected = []; state.originalTitle = input.value; refresh(); });
          refresh(); input.closest('label').after(choices, extra);
          const titleLabel = input.closest('label');
          const titleRow = document.createElement('div'); titleRow.className = 'import-title-row';
          const include = document.createElement('input'); include.type = 'checkbox'; include.checked = !draft.__skip; include.dataset.includeDraft = ''; include.setAttribute('aria-label', '导入此项');
          include.onchange = () => { draft.__skip = !include.checked; card.classList.toggle('is-skipped', draft.__skip); clearErrors(); updateCount(); };
          const toggle = document.createElement('button'); toggle.type = 'button'; toggle.dataset.toggleKeywords = ''; toggle.textContent = '关键词'; toggle.setAttribute('aria-expanded', 'false');
          choices.hidden = true; extra.hidden = true;
          toggle.onclick = () => { const show = choices.hidden; choices.hidden = extra.hidden = !show; toggle.setAttribute('aria-expanded', String(show)); toggle.classList.toggle('active', show); };
          titleLabel.before(titleRow); titleRow.append(include, titleLabel, toggle);
          titleLabel.firstChild.textContent = ''; input.setAttribute('aria-label', '标题');
        }
        const noteLabel = content.querySelector('[data-field="note"]').closest('label');
        const noteBox = document.createElement('details'); noteBox.className = 'import-note';
        const noteSummary = document.createElement('summary'); noteSummary.textContent = '备注 / 原文'; noteBox.append(noteSummary);
        noteLabel.before(noteBox); noteBox.append(noteLabel); noteLabel.firstChild.textContent = ''; noteLabel.querySelector('textarea').setAttribute('aria-label', '备注 / 原文');
      }
      const hint = document.createElement('p'); hint.className = 'import-item-hint'; hint.textContent = draft.hint; content.append(hint); results.append(card);
    });
    updateCount();
    status.textContent = drafts.length ? '' : '没有识别到日程，请检查原文。'; submit.disabled = !drafts.length;
    dialog.classList.toggle('has-results', drafts.length > 0);
    results.scrollIntoView({ block: 'nearest' });
  };
  const parseCurrent = async () => {
    const request = ++generation;
    results.replaceChildren(); count.textContent = ''; clearErrors(); submit.disabled = true; drafts = []; keywordStates = [];
    coursePreview = false;
    form.elements.location.dispatchEvent(new Event('reset-location-choices'));
    clearInterval(progressTimer);
    const started = performance.now();
    const phase = '识别文字';
    startProgress(phase);
    try {
      await paintProgress();
      if (request !== generation || !dialog.isConnected) return;
      if (form.elements.mode.value === 'course') {
        const text = form.elements.raw.value.replace(/&#x20;|&nbsp;/g, ' ').trim();
        if (!text) throw new Error('请粘贴需要识别的文字；手动填写可以直接点击确认导入。');
        if (text.split(/\r?\n/).filter(line => line.trim()).length > 1 && text.split(/\r?\n/).filter(line => line.trim()).every(line => /^周[一二三四五六日天]\s*\d+/.test(line))) {
          drafts = parser.courses(text, form.elements.weekOne.value, form.elements.periods.value); coursePreview = true; showDrafts(); return;
        }
        const details = parser.courseDetails(text, form.elements.periods.value);
        if (details.first) form.elements.firstWeek.value = details.first;
        if (details.last) form.elements.lastWeek.value = details.last;
        form.elements.parity.value = details.parity;
        for (const [field, value] of [['courseTitle', details.title], ['teacher', details.teacher], ['location', details.location]]) form.elements[field].value = value;
        template.querySelector('[data-meetings]').replaceChildren();
        (details.meetings.length ? details.meetings : [{}]).forEach(addMeeting);
        status.textContent = '已填入下方课表，核对后导入。';
        submit.disabled = false;
        return;
      } else {
        if (!form.elements.raw.value.trim()) throw new Error("请先粘贴内容。");
        drafts = parser.notices(form.elements.raw.value, form.elements.reference.value);
      }
      showDrafts(`，用时 ${Math.floor((performance.now() - started) / 1000)} 秒`);
    } catch (e) { if (request === generation && dialog.isConnected) { status.textContent = e.message; submit.disabled = form.elements.mode.value !== 'course'; } }
    finally { if (request === generation) finishProgress(); }
  };
  const pasteAndParse = async (auto = false) => {
    clearPreviousSource();
    const request = generation;
    startProgress('读取剪贴板');
    let pasted;
    try {
      await paintProgress();
      if (request !== generation || !dialog.isConnected) return;
      pasted = await window.dayline?.readScheduleClipboard?.();
    }
    catch (_) {
      if (request === generation && dialog.isConnected) status.textContent = auto ? '' : '剪贴板读取失败，请按 Ctrl+V 粘贴后重试。';
      return;
    }
    finally { if (request === generation) finishProgress(); }
    if (!dialog.isConnected || request !== generation) return;
    if (pasted?.type === 'image' && pasted.dataUrl) {
      if (auto) { status.textContent = ''; return; }
      if (typeof useImage !== 'function') { status.textContent = '当前版本只识别文字，请复制通知或课表文字。'; return; }
      await useImage(pasted.dataUrl); return;
    }
    await pasteText(pasted?.type === 'text' ? pasted.text || '' : '', auto);
  };
  const pasteText = async (text, auto = false) => {
    clearPreviousSource();
    form.elements.raw.value = text;
    invalidate();
    if (!text.trim()) { submit.disabled = true; status.textContent = auto ? '' : '剪贴板没有可识别的文字或图片，请重新复制后粘贴。'; return; }
    await parseCurrent();
  };
  parseButton.onclick = () => form.elements.raw.value.trim() ? parseCurrent() : pasteAndParse();
  repaste.onclick = () => pasteAndParse();
  form.onsubmit = async e => {
    e.preventDefault();
    if (saving || dialog.getAttribute('aria-busy') === 'true') return;
    clearErrors();
    if (form.elements.mode.value === 'course' && !coursePreview) {
      if (!form.elements.courseTitle.value.trim()) fieldError(form.elements.courseTitle, '请填写课程名称。');
      if (!parser.validDate(form.elements.weekOne.value)) fieldError(form.elements.weekOne, '请填写有效的第 1 周起始日期。');
      const first = Number(form.elements.firstWeek.value), last = Number(form.elements.lastWeek.value);
      if (!Number.isInteger(first) || first < 1 || first > 53) fieldError(form.elements.firstWeek, '开始周须为 1–53。');
      if (!Number.isInteger(last) || last < first || last > 53) fieldError(form.elements.lastWeek, '结束周须不早于开始周，且不超过 53。');
      [...template.querySelectorAll('[data-meetings] fieldset')].forEach((row, i) => {
        const weekday = row.querySelector('[data-weekday]'), start = row.querySelector('[data-start]'), end = row.querySelector('[data-end]');
        if (!weekday.value) fieldError(weekday, `第 ${i + 1} 个时段：请选择星期。`);
        if (start.validity.badInput) fieldError(start, `第 ${i + 1} 个时段：请填写有效开始时间。`);
        if (end.validity.badInput || end.value && (!start.value || end.value <= start.value)) fieldError(end, `第 ${i + 1} 个时段：结束须晚于开始，也可全部留空。`);
      });
      if (dialog.querySelector('[aria-invalid="true"]')) { status.textContent = '请修正已标出的课程字段，输入已保留。'; return; }
      try {
        drafts = parser.courseTemplate({ title: form.elements.courseTitle.value, teacher: form.elements.teacher.value, location: form.elements.location.value, first: form.elements.firstWeek.value, last: form.elements.lastWeek.value, parity: form.elements.parity.value, weekOne: form.elements.weekOne.value, note: form.elements.raw.value, meetings: meetingValues() });
      } catch (error) { status.textContent = error.message; return; }
    }
    if (!drafts.length) return;
    drafts.forEach(draft => { draft.calendarId = calendarId; });
    drafts.forEach((draft, i) => {
      if (draft.__skip || draft.__existing) return;
      const card = results.children[i];
      const mark = (field, text) => { const input = card?.querySelector(`[data-field="${field}"]`); if (input) fieldError(input, `第 ${i + 1} 项：${text}`); };
      if (!draft.title.trim()) mark('title', '请填写标题。');
      if (!parser.validDate(draft.date)) mark('date', '请填写有效日期。');
      if (draft.endTime && (!draft.startTime || draft.endTime <= draft.startTime)) mark('endTime', '结束时间须晚于开始，也可全部留空。');
      if (draft.repeatEndDate && (!parser.validDate(draft.repeatEndDate) || draft.repeatEndDate < draft.date)) mark('repeatEndDate', '截止日期不能早于开始日期。');
    });
    if (dialog.querySelector('[aria-invalid="true"]')) { status.textContent = '请修正已标出的字段，其他内容已保留。'; return; }
    updateCount();
    const fresh = freshDrafts().map(({hint, __skip, __existing, ...d}) => ({...d, title: d.title.trim()}));
    if (!fresh.length) { status.textContent = drafts.some(draft => draft.__skip) ? '请至少勾选一项再导入。' : "这些日程已存在，无需重复导入。"; return; }
    saving = true;
    const controls = [...form.querySelectorAll('input,select,textarea,button:not([data-close])')].map(control => [control, control.disabled]);
    startProgress('保存日程'); submit.textContent = '保存中…';
    controls.forEach(([control]) => { control.disabled = true; });
    try {
      if (await save(fresh)) close();
      else status.textContent = '保存未完成，请检查应用提示后重试。';
    } catch (err) { status.textContent = `保存失败：${err.message}`; }
    finally {
      saving = false; finishProgress();
      controls.forEach(([control, disabled]) => { control.disabled = disabled; });
      updateCount();
    }
  };
  const periods = document.createElement('details');
  periods.innerHTML = '<summary>节次时间设置</summary>';
  const periodsLabel = form.elements.periods.closest('label');
  periodsLabel.before(periods);
  periods.append(periodsLabel);
  const weekOneLabel = form.elements.weekOne.closest('label'); weekOneLabel.firstChild.textContent = '第1周';
  const termRow = document.createElement('div'); termRow.className = 'course-term-row';
  weekOneLabel.before(termRow); termRow.append(weekOneLabel, periods);
  periods.querySelector('summary').textContent = '节次时间';
  const discard = document.createElement('button'); discard.type = 'button'; discard.dataset.discardDraft = ''; discard.textContent = '清空内容'; submit.before(discard);
  discard.onclick = () => {
    form.reset();
    form.elements.location.dispatchEvent(new Event('reset-location-choices'));
    template.querySelector('[data-meetings]').replaceChildren(); addMeeting(); setMode();
    status.textContent = '内容已清空。';
  };
  setMode();
  dialog.showModal();
  if (imageFile && typeof useImage === 'function') useImage(imageFile).catch(() => { status.textContent = '图片读取失败，请重新粘贴。'; });
  else pasteAndParse(true).catch(() => { status.textContent = ''; });
  return dialog;
};
