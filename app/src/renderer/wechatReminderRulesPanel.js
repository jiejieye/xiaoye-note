(() => {
  const ruleSourceOptions = [['events', '日程'], ['todos', '待办']];
  const ruleRangeOptions = [['today', '今天'], ['tomorrow', '明天']];
  const T = window.ReminderTemplates;
  const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const dialog = document.createElement('dialog');
  dialog.className = 'wecom-reminder-dialog wecom-rules-dialog';
  dialog.setAttribute('aria-labelledby', 'wecom-rules-title');
  dialog.innerHTML = `<form novalidate>
    <header><h2 id="wecom-rules-title">企微提醒</h2><button type="button" data-rules-close aria-label="关闭"><span data-ui-icon="x" aria-hidden="true"></span></button></header>
    <nav class="wecom-tabs" aria-label="企微提醒设置"><button type="button" class="active" aria-current="page">提醒规则</button><button type="button" data-rules-robot>机器人配置</button></nav>
    <output data-rules-status role="status" aria-live="polite">正在读取规则…</output>
    <output data-rules-preview-status role="status" aria-live="polite" hidden></output>
    <div class="wecom-rule-list" data-rule-list></div>
    <button type="button" data-rule-add>＋ 新增提醒</button>
    <section class="wecom-rule-editor" data-rule-editor hidden></section>
    <div class="wecom-rule-conflict" data-rule-conflict hidden><button type="button" data-rules-cloud>读取云端版本</button><button type="button" data-rules-overwrite>用本机规则覆盖</button></div>
    <footer><button type="submit" data-rules-save>保存全部规则</button><button type="button" data-rules-reload>重新读取</button></footer>
  </form>`;
  document.body.append(dialog);
  window.XiaoyeIcons.decorate(dialog);
  const form = dialog.querySelector('form');
  const output = dialog.querySelector('[data-rules-status]');
  const list = dialog.querySelector('[data-rule-list]');
  const editor = dialog.querySelector('[data-rule-editor]');
  let rules = null, rulesBinding = '', version = 0, cloudVersion = 0, busy = false, dirty = false, editingId = '', data = null, generation = 0, previewGeneration = 0;
  const status = (text, error = false) => { output.textContent = text; output.classList.toggle('is-error', error); };
  const previewStatus = (text, error = false) => {
    const output = dialog.querySelector('[data-rules-preview-status]');
    output.textContent = text; output.hidden = !text; output.classList.toggle('is-error', error);
  };
  function controls() {
    dialog.querySelector('[data-rules-save]').disabled = busy || !rules;
    dialog.querySelector('[data-rules-reload]').disabled = busy;
    dialog.querySelector('[data-rule-add]').disabled = busy || !rules || rules.length >= 20;
    list.querySelectorAll('button,input').forEach(el => { el.disabled = busy; });
    editor.querySelectorAll('button,input,select,textarea').forEach(el => { el.disabled = busy; });
  }
  function changed() { dirty = true; status('有未保存的修改，点击“保存全部规则”后生效。'); }
  function renderList() {
    list.innerHTML = (rules || []).map(rule => `<div class="wecom-rule-row"><label><input type="checkbox" data-rule-enabled="${esc(rule.id)}" ${rule.enabled ? 'checked' : ''} aria-label="启用${esc(rule.name)}" /><b>${esc(rule.name)}</b></label><span>${rule.mode === 'advance' ? `提前 ${rule.advanceMinutes} 分钟` : esc(rule.time)}</span><button type="button" data-rule-edit="${esc(rule.id)}">编辑</button><button type="button" data-rule-delete="${esc(rule.id)}" aria-label="删除${esc(rule.name)}">删除</button></div>`).join('') || '<p class="wecom-field-hint">暂无提醒，点击“新增提醒”建立规则。</p>';
    list.querySelectorAll('[data-rule-enabled]').forEach(el => el.onchange = () => { rules.find(r => r.id === el.dataset.ruleEnabled).enabled = el.checked; changed(); });
    list.querySelectorAll('[data-rule-edit]').forEach(el => el.onclick = () => { if (captureEditor()) edit(el.dataset.ruleEdit); });
    list.querySelectorAll('[data-rule-delete]').forEach(el => el.onclick = () => {
      const id = el.dataset.ruleDelete;
      const rule = rules.find(row => row.id === id);
      if (!confirm(`删除提醒规则“${rule.name}”？只删除这条规则，日程和待办内容会保留；保存全部规则后生效。`)) return;
      rules = rules.filter(row => row.id !== id);
      if (editingId === id) { editingId = ''; editor.hidden = true; editor.replaceChildren(); }
      changed(); renderList();
      status(`已移除“${rule.name}”，点击“保存全部规则”后生效。`);
    });
    controls();
  }
  function edit(id) {
    const rule = rules.find(row => row.id === id);
    editingId = id;
    editor.hidden = false;
    editor.innerHTML = `<div class="wecom-rule-editor-head"><b>编辑提醒</b><button type="button" data-rule-collapse>收起</button></div>
      <label class="wecom-field">提醒名称<input data-rule-name maxlength="60" value="${esc(rule.name)}" /></label>
      <div class="wecom-rule-grid"><label class="wecom-field">发送方式<select data-rule-mode><option value="daily" ${rule.mode === 'daily' ? 'selected' : ''}>每天定时</option><option value="advance" ${rule.mode === 'advance' ? 'selected' : ''}>事项开始前</option></select></label>
      <label class="wecom-field" data-rule-time-field>提醒时间<input data-rule-time type="time" value="${esc(rule.time)}" /></label><label class="wecom-field" data-rule-lead-field>提前分钟<input data-rule-lead type="number" min="0" max="1440" value="${rule.advanceMinutes}" /></label></div>
      <fieldset class="wecom-rule-sources"><legend>内容来源</legend>${ruleSourceOptions.map(([key, label]) => `<label><input type="checkbox" data-rule-source="${key}" ${rule.sources.includes(key) ? 'checked' : ''} />${label}</label>`).join('')}</fieldset>
      <label class="wecom-field" data-rule-range-field>日期范围<select data-rule-range>${ruleRangeOptions.map(([value, label]) => `<option value="${value}" ${rule.range === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <label class="wecom-field">输出格式<textarea data-rule-template rows="6" maxlength="2000" spellcheck="false">${esc(rule.template)}</textarea></label>
      <div class="wecom-variable-buttons" aria-label="插入内容">${T.variables.map(name => `<button type="button" data-rule-variable="${name}">${name}</button>`).join('')}</div>
      <label class="wecom-enable"><input type="checkbox" data-rule-skip ${rule.skipEmpty ? 'checked' : ''} /><span>没有内容时跳过发送</span></label>
      <p class="wecom-field-hint" data-rule-preview-hint></p><div class="wecom-rule-preview-head"><b data-rule-preview-title>输出预览</b><button type="button" data-rule-preview>刷新预览</button></div><pre class="wecom-rule-preview" data-rule-preview-content></pre><p class="is-error" data-rule-error role="status"></p>`;
    editor.querySelector('[data-rule-collapse]').onclick = () => { if (captureEditor()) { editingId = ''; editor.hidden = true; } };
    const mode = editor.querySelector('[data-rule-mode]');
    function updateMode() {
      editor.querySelector('[data-rule-time-field]').hidden = mode.value !== 'daily';
      editor.querySelector('[data-rule-lead-field]').hidden = mode.value !== 'advance';
      editor.querySelector('[data-rule-range-field]').hidden = mode.value === 'advance';
      editor.querySelector('[data-rule-preview-title]').textContent = mode.value === 'advance' ? '格式示例' : '输出预览';
      editor.querySelector('[data-rule-preview-hint]').textContent = mode.value === 'advance' ? '示例展示今天的内容，实际每次仅发送触发的事项。' + (rule.id === 'advance' ? '事项单独设置的提醒时间优先；本规则分钟数用于未单独设置的事项。' : '') : '预览使用便签当前数据，不会发送消息。';
    }
    editor.querySelectorAll('input,select,textarea').forEach(el => el.addEventListener('input', () => { changed(); preview(); }));
    mode.addEventListener('change', updateMode);
    editor.querySelectorAll('[data-rule-variable]').forEach(button => button.onclick = () => {
      const textarea = editor.querySelector('[data-rule-template]');
      textarea.setRangeText(`{${button.dataset.ruleVariable}}`, textarea.selectionStart, textarea.selectionEnd, 'end'); textarea.focus(); changed(); preview();
    });
    editor.querySelector('[data-rule-preview]').onclick = preview;
    updateMode(); preview(); controls();
    editor.style.scrollMarginTop = `${dialog.querySelector('header').offsetHeight + 12}px`;
    editor.scrollIntoView({ block: 'start' });
  }
  function editorValue() {
    const previous = rules.find(row => row.id === editingId);
    const mode = editor.querySelector('[data-rule-mode]').value;
    return T.normalize({ ...previous, name: editor.querySelector('[data-rule-name]').value, mode,
      time: editor.querySelector('[data-rule-time]').value, advanceMinutes: Number(editor.querySelector('[data-rule-lead]').value),
      sources: [...editor.querySelectorAll('[data-rule-source]:checked')].map(el => el.dataset.ruleSource),
      range: mode === 'advance' ? 'today' : editor.querySelector('[data-rule-range]').value,
      template: editor.querySelector('[data-rule-template]').value, skipEmpty: editor.querySelector('[data-rule-skip]').checked });
  }
  function captureEditor() {
    if (!editingId || editor.hidden) return true;
    try { const value = editorValue(); rules[rules.findIndex(row => row.id === editingId)] = value; editor.querySelector('[data-rule-error]').textContent = ''; renderList(); return true; }
    catch (error) { editor.querySelector('[data-rule-error]').textContent = error.message; return false; }
  }
  function preview() {
    try {
      editor.querySelector('[data-rule-preview-content]').textContent = '';
      const rule = editorValue();
      if (!data) { editor.querySelector('[data-rule-error]').textContent = ''; return; }
      const value = T.render(rule, data);
      editor.querySelector('[data-rule-preview-content]').textContent = value.content;
      editor.querySelector('[data-rule-error]').textContent = value.skipped ? '当前没有匹配内容，定时发送时会跳过。' : '';
    } catch (error) { editor.querySelector('[data-rule-error]').textContent = error.message; }
  }
  async function refreshPreviewData(seq, binding) {
    const previewSeq = ++previewGeneration;
    data = null;
    previewStatus('正在读取预览数据，可继续编辑和保存规则。');
    if (editingId && !editor.hidden) preview();
    try {
      const nextData = await window.dayline.loadData();
      if (seq !== generation || previewSeq !== previewGeneration || binding !== rulesBinding) return;
      data = nextData;
      previewStatus('');
      if (editingId && !editor.hidden) preview();
    } catch (error) {
      if (seq !== generation || previewSeq !== previewGeneration || binding !== rulesBinding) return;
      previewStatus(`预览数据读取失败：${error.message || '请稍后重新读取规则重试。'}。上方规则读取或保存结果不受影响。`, true);
    }
  }
  async function request(action, args = {}, preserveEdits = false) {
    if (busy) return;
    const seq = generation; busy = true; controls();
    status(action === 'rules-save' ? '正在保存规则…' : '正在读取规则…');
    try {
      if (!window.dayline?.wechatReminder) throw Error('请完整重启桌面便签，加载提醒规则功能。');
      const result = await window.dayline.wechatReminder(action, args);
      if (seq !== generation) return;
      if (result.error) throw Error(result.error);
      if (preserveEdits && rules && dirty && result.binding === rulesBinding) {
        renderList(); if (editingId) edit(editingId); status('已保留本次未保存的修改。');
      } else {
        rules = T.normalizeList(result.rules); rulesBinding = result.binding; version = result.version; cloudVersion = result.cloudVersion || 0;
        dirty = false; editingId = ''; editor.hidden = true;
        dialog.querySelector('[data-rule-conflict]').hidden = !result.conflict;
        status(result.message, Boolean(result.conflict)); renderList();
      }
      refreshPreviewData(seq, rulesBinding);
    } catch (error) { if (seq === generation) status(error.message || '操作失败，修改已保留，请重试。', true); }
    finally { if (seq === generation) { busy = false; controls(); } }
  }
  window.addEventListener('xiaoye:openWechatReminderRules', () => {
    if (busy || dialog.open) return;
    generation++; previewGeneration++; data = null; previewStatus('');
    if (editingId && !editor.hidden) preview();
    dialog.showModal();
    request('rules-get', {}, true);
  });
  dialog.querySelector('[data-rule-add]').onclick = () => {
    if (!captureEditor()) return;
    const rule = T.normalize({ id: 'rule-' + crypto.randomUUID(), name: `提醒${rules.length + 1}`, mode: 'daily', time: '08:00', range: 'today', sources: ['events', 'todos'], enabled: true, skipEmpty: true, template: T.personalTemplate });
    rules.push(rule); changed(); renderList(); edit(rule.id);
  };
  form.onsubmit = event => { event.preventDefault(); if (captureEditor()) request('rules-save', { rules, version, binding: rulesBinding }); };
  dialog.querySelector('[data-rules-reload]').onclick = () => { if (!dirty || confirm('重新读取会放弃尚未保存的修改，继续吗？')) request('rules-get'); };
  dialog.querySelector('[data-rules-cloud]').onclick = () => { if (confirm('读取云端版本将替换本机规则草稿，继续吗？')) request('rules-get', { discardDraft: true }); };
  dialog.querySelector('[data-rules-overwrite]').onclick = () => { if (captureEditor() && confirm('确认用当前本机规则替换刚刚读取到的云端版本？')) request('rules-save', { rules, version: cloudVersion, binding: rulesBinding }); };
  dialog.querySelector('[data-rules-close]').onclick = () => { if (captureEditor()) dialog.close(); };
  dialog.addEventListener('close', () => { if (!dialog.open) { generation++; busy = false; controls(); } });
  dialog.addEventListener('cancel', event => { if (!captureEditor()) event.preventDefault(); });
  dialog.querySelector('[data-rules-robot]').onclick = () => { if (captureEditor()) { dialog.close(); window.dispatchEvent(new Event('xiaoye:openWechatReminder')); } };
  controls();
})();
