(() => {
  if (!window.dayline?.syncStatus) return;
  const dialog = document.createElement("dialog");
  dialog.className = "note-sync-dialog";
  dialog.setAttribute("aria-labelledby", "note-sync-title");
  dialog.innerHTML = `<form>
    <div class="note-sync-head"><h2 id="note-sync-title">多电脑同步</h2><button type="button" data-sync-close aria-label="关闭">×</button></div>
    <output data-sync-status aria-live="polite">正在读取状态…</output>
    <p data-sync-account></p>
    <fieldset data-sync-fields>
      <p class="note-sync-intro">同步是可选的，数据默认只保存在本机。需要多台电脑共用时，用你自己的免费 Supabase 云端按下面 4 步完成。第二台电脑：在第 2 步粘贴连接码，再到第 4 步登录。</p>
      <section class="note-sync-step"><b>1. 注册免费云端</b><p>注册 Supabase 账号并新建一个项目（名称随意，数据库密码自己记住）。已有项目可跳过。</p><div class="note-sync-row"><button type="button" data-setup-open="signup">打开 Supabase 注册</button></div></section>
      <section class="note-sync-step"><b>2. 填写连接信息</b><p>在项目的 API Keys 页面分别复制 Project URL 和 Publishable key，每复制一个回来点一次“从剪贴板粘贴”。</p>
        <label>服务地址<input name="url" type="url" placeholder="https://项目编号.supabase.co" required autocomplete="off"></label>
        <label>公共密钥<input name="key" type="password" placeholder="Publishable key 或 anon key" autocomplete="off"></label>
        <div class="note-sync-row"><button type="button" data-setup-paste>从剪贴板粘贴</button><button type="button" data-setup-open="api">打开 API Keys 页面</button></div></section>
      <section class="note-sync-step"><b>3. 初始化数据库（只需一次）</b><p>点“复制初始化脚本”，再点“打开 SQL 编辑器”，粘贴后点 Run，回来点“检查”。</p>
        <div class="note-sync-row"><button type="button" data-setup-copy="core">复制初始化脚本</button><button type="button" data-setup-open="sql">打开 SQL 编辑器</button><button type="button" data-setup-check>检查</button></div>
        <output data-setup-result hidden></output></section>
      <section class="note-sync-step"><b>4. 注册或登录同步账号</b><p>第一台电脑点“注册新账号”，其他电脑用同一账号“登录”。首次连接前会先备份本机。</p>
        <label>账号邮箱<input name="email" type="email" required autocomplete="username"></label>
        <label>密码<input name="password" type="password" required autocomplete="current-password" minlength="6" placeholder="至少 6 位"></label>
        <div class="note-sync-row"><button type="submit" data-sync-login>登录</button><button type="button" data-sync-register>注册新账号</button></div></section>
    </fieldset>
    <div data-sync-connected>
      <p>可上传本机备份，并在另一台电脑上预览、下载。图片附件和窗口设置保留在本机。</p>
      <label>本机名称<input name="deviceName" maxlength="80" placeholder="例如：办公室电脑"></label>
      <div class="note-sync-actions"><button type="button" data-sync-now>上传本机</button><button type="button" data-device-list>查看云端电脑</button><button type="button" data-sync-logout>退出登录</button></div>
      <div class="note-sync-row"><button type="button" data-setup-code>复制连接码（给另一台电脑）</button><button type="button" data-setup-copy="reminders">复制企微提醒脚本（可选）</button></div>
      <output data-setup-code-result hidden></output>
      <div data-device-results></div>
      <small>要在另一台电脑接收更新，请点“查看云端电脑”，选择来源后下载。</small>
    </div>
  </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector("form");
  const statusOutput = dialog.querySelector("[data-sync-status]");
  let busy = false;
  let latestStatus = {};
  function update(status) {
    status = { ...latestStatus, ...status };
    latestStatus = status;
    form.elements.key.placeholder = status.keyConfigured ? "已配置，留空即可" : "Publishable key 或 anon key";
    let text = !status.connected ? "未登录" : status.shared ? (status.lastSync ? `自动同步 · ${new Date(status.lastSync).toLocaleString()}` : "正在连接共享日程") : status.lastSync ? `上次同步：${new Date(status.lastSync).toLocaleString()}` : "已登录，正在连接";
    if (status.conflicts) text += ` · ${status.conflicts} 条同步冲突`;
    statusOutput.textContent = status.error || status.notice || text;
    dialog.querySelector("[data-sync-account]").textContent = status.email ? `账号：${status.email}` : "";
    dialog.querySelector("[data-sync-fields]").hidden = !!status.connected;
    dialog.querySelector("[data-sync-connected]").hidden = !status.connected;
    dialog.querySelector("[data-sync-now]").disabled = busy || !status.connected;
    dialog.querySelector('[data-device-list]').disabled = busy || !status.connected;
    dialog.querySelector("[data-sync-logout]").disabled = busy || !status.connected;
    if (!dialog.open) {
      form.elements.key.value = "";
      form.elements.deviceName.value = status.deviceName || '';
      form.elements.url.value = status.url || "";
      form.elements.email.value = status.email || "";
    }
  }
  async function action(operation) {
    if (busy) return;
    busy = true;
    latestStatus = { ...latestStatus, notice: "", error: "" };
    form.querySelectorAll("button").forEach(button => { button.disabled = true; });
    try { update(await operation()); }
    catch (error) { latestStatus.error = error.message || "操作失败，请重试；本机数据仍保留。"; }
    finally {
      busy = false;
      form.querySelectorAll("button").forEach(button => { button.disabled = false; });
      update(latestStatus);
    }
  }
  const credentials = () => {
    const input = Object.fromEntries(new FormData(form));
    if (!input.email || !input.password) { form.reportValidity(); return null; }
    form.elements.password.value = "";
    return input;
  };
  form.addEventListener("submit", event => {
    event.preventDefault();
    const input = credentials();
    if (input) action(() => window.dayline.syncLogin(input));
  });
  dialog.querySelector("[data-sync-register]").onclick = () => {
    const input = credentials();
    if (input) action(() => window.dayline.syncRegister(input));
  };
  const setupResult = dialog.querySelector("[data-setup-result]");
  const showSetup = (target, text) => { target.hidden = !text; target.textContent = text || ""; };
  const connectionInput = () => ({ url: form.elements.url.value.trim(), key: form.elements.key.value.trim() });
  const checkServer = () => action(async () => {
    const result = await window.dayline.syncCheck(connectionInput());
    if (result.error) showSetup(setupResult, result.error);
    else if (result.initialized === null) showSetup(setupResult, "连接成功，但当前项目缺少版本检查接口，暂时无法确认数据库状态。已有项目可直接登录，新项目请完成第 3 步。");
    else if (!result.initialized) showSetup(setupResult, "云端可以连接，但数据库还没有初始化，请完成第 3 步。");
    else showSetup(setupResult, `✓ 数据库已就绪${result.reminders ? "（含企微提醒）" : ""}，可以进行第 4 步。`);
    return { ...await window.dayline.syncStatus(), error: "" };
  });
  dialog.querySelector("[data-setup-check]").onclick = checkServer;
  dialog.querySelectorAll("[data-setup-open]").forEach(button => {
    button.onclick = () => action(async () => {
      const result = await window.dayline.syncSetup("open", { page: button.dataset.setupOpen, url: form.elements.url.value.trim() });
      return { ...latestStatus, error: result.error || "", notice: result.error ? "" : "已在浏览器打开，完成后回到这里继续。" };
    });
  });
  dialog.querySelectorAll("[data-setup-copy]").forEach(button => {
    button.onclick = () => action(async () => {
      const result = await window.dayline.syncSetup("copy-sql", { kind: button.dataset.setupCopy });
      const hint = button.dataset.setupCopy === "reminders" ? "企微提醒脚本已复制，到 SQL 编辑器粘贴并点 Run。需要先在 Supabase 的 Integrations 里启用 pg_cron 和 pg_net。" : "初始化脚本已复制，到 SQL 编辑器粘贴并点 Run。";
      return { ...latestStatus, error: result.error || "", notice: result.error ? "" : hint };
    });
  });
  dialog.querySelector("[data-setup-code]").onclick = () => action(async () => {
    const result = await window.dayline.syncSetup("code");
    showSetup(dialog.querySelector("[data-setup-code-result]"), result.code ? `已复制：${result.code}` : "");
    return { ...latestStatus, error: result.error || "", notice: result.code ? "连接码已复制。在另一台电脑打开本窗口，第 2 步点“从剪贴板粘贴”。" : "" };
  });
  dialog.querySelector("[data-setup-paste]").onclick = () => action(async () => {
    const clip = await window.dayline.readScheduleClipboard?.();
    const text = clip?.type === "text" ? clip.text || "" : "";
    const filled = [];
    const code = /xiaoye1:([A-Za-z0-9_-]+)/.exec(text)?.[1];
    if (code) {
      try {
        const value = JSON.parse(decodeURIComponent(escape(atob(code.replace(/-/g, "+").replace(/_/g, "/")))));
        if (value.u) { form.elements.url.value = value.u; filled.push("服务地址"); }
        if (value.k) { form.elements.key.value = value.k; filled.push("公共密钥"); }
      } catch { return { ...latestStatus, error: "连接码不完整，请重新复制。" }; }
    } else {
      const url = /https:\/\/[a-z0-9-]+\.supabase\.co/i.exec(text)?.[0];
      const key = /sb_publishable_[A-Za-z0-9_-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+/.exec(text)?.[0];
      if (/sb_secret_/.test(text)) return { ...latestStatus, error: "剪贴板里是 Secret key，不能填在客户端。请复制 Publishable key。" };
      if (url) { form.elements.url.value = url.toLowerCase(); filled.push("服务地址"); }
      if (key) { form.elements.key.value = key; filled.push("公共密钥"); }
    }
    if (!filled.length) return { ...latestStatus, error: "剪贴板里没有找到服务地址、公共密钥或连接码。" };
    const missing = !form.elements.url.value ? "，还需要服务地址" : !form.elements.key.value && !latestStatus.keyConfigured ? "，还需要公共密钥" : "";
    if (!missing) setTimeout(checkServer, 0);
    return { ...latestStatus, error: "", notice: `已填入${filled.join("和")}${missing}。` };
  });
  dialog.querySelector("[data-sync-close]").onclick = () => dialog.close();
  dialog.addEventListener("close", () => { form.elements.password.value = ""; form.elements.key.value = ""; });
  dialog.querySelector("[data-sync-now]").onclick = () => action(() => window.dayline.deviceBackup('upload', { name: form.elements.deviceName.value }));
  dialog.querySelector('[data-device-list]').onclick = () => action(async () => {
    const result = await window.dayline.deviceBackup('list');
    if (result.error) return result;
    const list = dialog.querySelector('[data-device-results]'); list.replaceChildren();
    if (!result.devices.length) list.textContent = '暂无电脑备份，请先在来源电脑点击上传本机。';
    for (const device of result.devices) {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = `${device.device_name} · ${new Date(device.updated_at).toLocaleString()} · 预览`;
      button.onclick = () => action(async () => {
        const response = await window.dayline.deviceBackup('preview', {id: device.device_id});
        if (response.error) return response;
        const preview = response.preview; list.replaceChildren();
        const heading = document.createElement('p'); heading.textContent = `来源：${preview.device_name}，备份时间：${new Date(preview.updated_at).toLocaleString()}`; list.append(heading);
        const labels = {notes:'便签',noteFolders:'便签文件夹',noteLists:'便签分类',todos:'待办',todoLists:'待办分类',events:'日程',anniversaries:'纪念日',workTrees:'工作树'};
        for (const [kind, rows] of Object.entries(preview.snapshot)) {
          const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = `${labels[kind] || kind}：${rows.length} 项`; details.append(summary);
          for (const row of rows) { const p = document.createElement('p'); p.textContent = row.title || row.name || row.id; details.append(p); }
          list.append(details);
        }
        for (const [mode, label] of [['merge','合并导入（新增副本）'],['replace','替换本机内容']]) {
          const download = document.createElement('button'); download.type = 'button'; download.textContent = label;
          download.onclick = () => {
            if (!confirm(mode === 'replace' ? `确认用“${preview.device_name}”的备份替换本机便签、待办、日程和工作树等内容？操作前会备份本机。` : '确认新增这些内容到本机？重复导入会产生副本。')) return;
            action(async () => { const r = await window.dayline.deviceBackup('download',{token:preview.token,mode}); if (!r.error) { list.replaceChildren(); return {...r,error:'导入完成，本机原内容已备份。'}; } return r; });
          };
          list.append(download);
        }
        return {...latestStatus,error:''};
      });
      list.append(button);
    }
    return {...latestStatus,error:''};
  });
  dialog.querySelector("[data-sync-logout]").onclick = () => action(() => window.dayline.syncLogout());
  window.addEventListener("xiaoye:openSync", async () => {
    try { update(await window.dayline.syncStatus()); }
    catch { statusOutput.textContent = "同步状态读取失败，请关闭后重试；当前输入已保留。"; }
    finally { if (!dialog.open) dialog.showModal(); }
  });
  window.dayline.onSyncStatus(update);
})();
