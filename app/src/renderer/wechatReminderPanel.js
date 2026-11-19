(() => {
  const dialog = document.createElement('dialog');
  dialog.className = 'wecom-reminder-dialog';
  dialog.setAttribute('aria-labelledby', 'wecom-reminder-title');
  dialog.innerHTML = `<form novalidate>
    <header><h2 id="wecom-reminder-title">企微提醒</h2><button type="button" data-wecom-close aria-label="关闭"><span data-ui-icon="x" aria-hidden="true"></span></button></header>
    <nav class="wecom-tabs" aria-label="企微提醒设置"><button type="button" data-wecom-rules-tab>提醒规则</button><button type="button" class="active" aria-current="page">机器人配置</button></nav>
    <p>更换企业后，粘贴新群机器人的 Webhook。原提醒时间和日程来源继续保留。</p>
    <output data-wecom-status role="status" aria-live="polite">正在读取配置…</output>
    <label class="wecom-field">群机器人 Webhook<span class="wecom-webhook-row"><input name="webhook" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴完整 Webhook；留空保留已保存地址" /><button type="button" data-wecom-paste>粘贴</button></span></label>
    <p class="wecom-field-hint">使用群机器人的 Webhook 地址。智能机器人的 Bot ID、Secret 属于长连接接入，不能填在这里。</p>
    <label class="wecom-enable"><input name="enabled" type="checkbox" /><span>开启企微提醒</span></label>
    <p class="wecom-field-hint">地址只提交到现有提醒服务，保存后不回显。测试会把日程汇总发到已保存的群，群成员均可看到。</p>
    <div class="wecom-secondary"><button type="button" data-wecom-reload>重新读取</button><button type="button" data-wecom-account>同步账号</button></div>
    <footer><button type="submit" data-wecom-save>保存并使用</button><button type="button" data-wecom-test>发送测试汇总</button></footer>
  </form>`;
  document.body.append(dialog);
  window.XiaoyeIcons.decorate(dialog);
  const form = dialog.querySelector('form');
  const input = form.elements.webhook;
  const enabled = form.elements.enabled;
  const output = dialog.querySelector('[data-wecom-status]');
  let current = null, busy = false, pendingAction = '', generation = 0;
  const message = (text, error = false) => { output.textContent = text; output.classList.toggle('is-error', error); };
  function resetSession() {
    generation++; busy = false; pendingAction = ''; input.value = ''; current = null; updateControls();
  }
  function closePanel() { resetSession(); dialog.close(); }
  function updateControls() {
    dialog.querySelector('.wecom-secondary').hidden = Boolean(current?.supported);
    input.disabled = busy && pendingAction !== 'get';
    dialog.querySelector('[data-wecom-paste]').disabled = input.disabled;
    enabled.disabled = busy || !current?.supported;
    dialog.querySelector('[data-wecom-save]').disabled = busy || !current?.supported;
    dialog.querySelector('[data-wecom-test]').disabled = busy || !current?.active || !current?.configured || Boolean(input.value.trim());
    dialog.querySelector('[data-wecom-reload]').disabled = busy;
    dialog.querySelector('[data-wecom-account]').disabled = busy;
  }
  async function run(action, payload) {
    if (busy) return;
    const seq = generation;
    busy = true; pendingAction = action; updateControls();
    message(action === 'get' ? '正在读取配置…' : action === 'save' ? '正在保存…' : '正在提交测试汇总…');
    try {
      if (!window.dayline?.wechatReminder) throw Error('请在新版桌面便签中打开此功能；更新后需重新启动便签。');
      const result = await window.dayline.wechatReminder(action, payload);
      if (seq !== generation || !dialog.open) return;
      if (result.error) throw Error(result.error);
      if (action === 'test') message(result.queued ? '测试汇总已提交，请到企业微信群确认收到；提交成功不代表已送达。' : '云端未确认测试提交，请稍后重试。', !result.queued);
      else {
        current = result;
        enabled.checked = result.enabled;
        if (action === 'save') { input.value = ''; message(result.enabled ? '已保存，后续提醒将发到此机器人所在的群。' : '已保存，定时提醒已暂停；可以单独发送测试汇总。'); }
        else if (!result.supported) message('当前云端尚未支持群机器人配置，原设置已保留。', true);
        else message(result.configured ? result.active ? '已配置企业微信群机器人；填入新地址即可更换。' : '已保存群机器人地址，当前使用其他提醒通道。' : '尚未配置群机器人，请粘贴新群的 Webhook。');
      }
    } catch (error) {
      if (seq === generation && dialog.open) message(error.message || '操作失败，请重试。', true);
    } finally { if (seq === generation) { busy = false; pendingAction = ''; updateControls(); } }
  }
  window.addEventListener('xiaoye:openWechatReminder', () => {
    if (dialog.open) return;
    resetSession();
    dialog.showModal();
    run('get');
  });
  input.addEventListener('input', () => { updateControls(); if (input.value.trim()) message(current?.supported ? '填入新地址后先保存，再向新群发送测试汇总。' : '地址已填入，配置尚未读取，请点击“重新读取”。'); });
  async function pasteWebhook() {
    if (input.disabled) return;
    const seq = generation;
    try {
      const text = window.dayline?.readWecomClipboard ? await window.dayline.readWecomClipboard() : await navigator.clipboard.readText();
      if (seq !== generation || !dialog.open || input.disabled) return;
      if (!String(text || '').trim()) { message('剪贴板没有文字，请先复制群机器人的 Webhook 地址。', true); return; }
      input.value = String(text).trim();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    } catch { if (seq === generation && dialog.open) message('无法读取剪贴板，请在输入框中按 Ctrl+V。', true); }
  }
  dialog.querySelector('[data-wecom-paste]').onclick = pasteWebhook;
  dialog.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v' && window.dayline?.readWecomClipboard) {
      event.preventDefault(); pasteWebhook();
    }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy || !current?.supported) return;
    const webhook = input.value.trim();
    if (webhook && !/^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9_-]{16,128}$/.test(webhook)) { message('请输入群机器人的完整 Webhook 地址，不能填写 Bot ID 或 Secret。', true); input.focus(); return; }
    run('save', { webhook, enabled: enabled.checked });
  });
  dialog.querySelector('[data-wecom-test]').onclick = () => { if (!input.value.trim()) run('test'); };
  dialog.querySelector('[data-wecom-reload]').onclick = () => run('get');
  dialog.querySelector('[data-wecom-rules-tab]').onclick = () => { closePanel(); window.dispatchEvent(new Event('xiaoye:openWechatReminderRules')); };
  dialog.querySelector('[data-wecom-close]').onclick = closePanel;
  dialog.querySelector('[data-wecom-account]').onclick = () => { closePanel(); window.dispatchEvent(new Event('xiaoye:openSync')); };
  dialog.addEventListener('cancel', resetSession);
  dialog.addEventListener('close', () => { if (!dialog.open) resetSession(); });
  updateControls();
})();
