(function () {
  const account = window.AccountSubscription;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  let cleanup = null;
  let refreshCurrent = null;

  function available(event) {
    return !event.todoId && !event.ongoing && !event.repeatParentId && !event.courseGroupId && ['none', 'monthly', 'yearly'].includes(event.repeat || 'none');
  }

  function typeControl(selected) {
    const name = 'task-type', label = '属性';
    const options = [['normal', '普通'], ['goal', '目标'], ['flow', '流动']];
    return `<div class="event-type-field"><span>${label}</span><div class="event-type-control">
      <select data-${name} class="event-type-native" tabindex="-1" aria-hidden="true">${options.map(([value, text, disabled]) => `<option value="${value}" ${selected === value ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${text}</option>`).join('')}</select>
      <details class="event-type-picker" data-event-picker="${name}">
        <summary role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="${name}-options" aria-label="${label}"><span data-event-type-label></span><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>
        <div class="event-type-menu" id="${name}-options" role="listbox" aria-label="${label}选项">${options.map(([value, text, disabled]) => `<button type="button" role="option" aria-selected="${selected === value}" data-event-picker-value="${value}" ${disabled ? 'disabled' : ''}>${text}</button>`).join('')}</div>
      </details></div></div>`;
  }

  function kindControl(event) {
    const selected = event.subscription ? 'subscription' : event.draftKind || (event.todoId ? 'todo' : event.courseGroupId || event.repeat === 'weekly' ? 'course' : 'event');
    const linked = Boolean(event.todoId);
    return `<div class="event-kind" role="group" aria-label="类型"><input type="hidden" data-event-kind value="${selected}">${[['event', '日程', linked], ['todo', '待办'], ['course', '课程'], ['subscription', '订阅', !available(event)]].map(([value, text, disabled]) => `<button type="button" data-event-kind-choice="${value}" class="${selected === value ? 'active' : ''}" aria-pressed="${selected === value}" ${disabled ? 'disabled' : ''}>${text}</button>`).join('')}</div>`;
  }


  function dispose() {
    cleanup?.(); cleanup = null; refreshCurrent = null;
  }

  function extraAccountRow(item) {
    return `<div class="subscription-extra-account" data-subscription-extra-row>
      <input data-subscription-extra-name value="${escape(item.name)}" placeholder="如辅助邮箱" aria-label="账号名称" autocomplete="off">
      <input data-subscription-extra-value value="${escape(item.value)}" placeholder="账号或邮箱" aria-label="附加账号" autocomplete="off">
      <button type="button" data-subscription-remove-account aria-label="移除此账号">移除</button>
    </div>`;
  }

  function render(event, today) {
    if (!available(event)) return '';
    const subscription = event.subscription || {
      chargedOn: event.date || today, startedOn: event.date || today, expiresOn: event.date || today, cycle: 'monthly', cycleDays: 30
    };
    return `<section class="account-subscription-fields" data-subscription-fields ${event.subscription ? '' : 'hidden'}>
        <div class="subscription-account"><label for="subscription-account-input">账号</label><input id="subscription-account-input" data-subscription-account value="${escape(subscription.account || '')}" placeholder="账号" aria-label="账号" autocomplete="off"><button type="button" data-subscription-add-account>添加账号</button></div>
        <input type="hidden" data-subscription-extra-accounts value="${escape(JSON.stringify(subscription.extraAccounts || []))}">
        <div data-subscription-extra-list>${(subscription.extraAccounts || []).map(extraAccountRow).join('')}</div>
        <label class="subscription-password"><span>密码</span><div class="subscription-password-row"><input type="password" data-subscription-password placeholder="***" autocomplete="new-password" aria-label="账号密码"><button type="button" data-subscription-copy-password>复制</button></div></label>
        <p data-subscription-copy-status role="status"></p>
        <div class="account-subscription-grid">
          <label><span class="subscription-date-label">订阅时间<button type="button" data-subscription-today="charged-on">今日</button></span><input type="date" data-subscription-charged-on value="${escape(subscription.chargedOn)}"></label>
          <label><span class="subscription-date-label">到期时间<button type="button" data-subscription-today="expires-on">今日</button></span><input type="date" data-subscription-expires-on value="${escape(subscription.expiresOn)}"></label>
        </div>
        <div class="subscription-calculator"><select data-subscription-period aria-label="计算时长">${[['month', '1个月'], ['quarter', '3个月'], ['year', '1年'], ['days', '天数']].map(([value, label]) => `<option value="${value}" ${value === 'month' ? 'selected' : ''}>${label}</option>`).join('')}</select><input type="number" min="1" max="3660" step="1" data-subscription-period-days aria-label="计算天数" value="${escape(subscription.cycleDays || 30)}" hidden><button type="button" data-subscription-calculate>计算到期</button><button type="button" data-subscription-backcalculate>反推订阅</button><label class="subscription-expired-option"><input type="checkbox" data-subscription-expired ${subscription.markedExpired ? 'checked' : ''}>已到期</label></div>
        <p data-subscription-summary role="status"></p>
        ${event.subscription ? '<div class="account-subscription-actions"><button type="button" data-subscription-renew>记录续费</button></div>' : ''}
        <input type="hidden" data-subscription-renewal value="">
        ${subscription.history?.length ? `<details class="account-subscription-history"><summary>历史充值（${subscription.history.length}）</summary>${subscription.history.map(period => `<p>${escape(period.chargedOn)} 充值 → ${escape(period.expiresOn)} 到期</p>`).join('')}</details>` : ''}
      </section>`;
  }

  function displayControl(event) {
    if (!available(event)) return '';
    const display = account.displayItems(event.subscription);
    return `<details class="subscription-display" data-subscription-display><summary aria-label="选择日历显示内容" title="选择日历显示内容">·</summary><div class="subscription-display-options"><label><input type="checkbox" data-subscription-display-item="remaining" ${display.includes('remaining') ? 'checked' : ''}>剩余天数</label><label><input type="checkbox" data-subscription-display-item="continuous" ${display.includes('continuous') ? 'checked' : ''}>已用天数</label></div></details>`;
  }

  function read(panel, previous) {
    const value = name => panel.querySelector(`[data-subscription-${name}]`).value;
    const chargedOn = value('charged-on');
    return {
      chargedOn, expiresOn: value('expires-on'), startedOn: account.continuousStart(previous, chargedOn, Boolean(value('renewal'))),
      account: value('account').trim(), markedExpired: panel.querySelector('[data-subscription-expired]').checked,
      extraAccounts: JSON.parse(value('extra-accounts')).map(item => ({ name: item.name.trim() || '辅助账号', value: item.value.trim() })).filter(item => item.value),
      cycle: { month: 'monthly', quarter: 'quarterly', year: 'yearly', days: 'days' }[value('period')], cycleDays: Number(value('period-days')),
      display: [...panel.querySelectorAll('[data-subscription-display-item]:checked')].map(input => input.dataset.subscriptionDisplayItem), displayVersion: 2
    };
  }

  function bind(panel, event, today) {
    const controls = [...panel.querySelectorAll('[data-event-picker]')];
    const refreshPickers = [];
    const cleanups = [];
    controls.forEach(picker => {
      const type = picker.parentElement.querySelector('select');
      const summary = picker.querySelector('summary');
      const menu = picker.querySelector('.event-type-menu');
      const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
      const stopFloating = window.XiaoyeFloating.bindDetails(picker, { menu, placement: 'bottom-start', gap: 4 });
      const onToggle = () => {
        summary.setAttribute('aria-expanded', String(picker.open));
        menu.style.width = `${summary.getBoundingClientRect().width}px`;
      };
      picker.addEventListener('toggle', onToggle);
      const choose = button => {
        type.value = button.dataset.eventPickerValue;
        type.dispatchEvent(new Event('change', { bubbles: true }));
        picker.open = false; summary.focus({ preventScroll: true });
      };
      buttons.forEach(button => button.onclick = () => choose(button));
      summary.addEventListener('keydown', action => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(action.key)) return;
        action.preventDefault(); picker.open = true;
        buttons[action.key === 'End' || action.key === 'ArrowUp' ? buttons.length - 1 : Math.max(0, buttons.findIndex(button => button.dataset.eventPickerValue === type.value))].focus();
      });
      menu.addEventListener('keydown', action => {
        const index = buttons.indexOf(document.activeElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(action.key)) {
          action.preventDefault();
          const next = action.key === 'Home' ? 0 : action.key === 'End' ? buttons.length - 1 : (index + (action.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next].focus();
        } else if (action.key === 'Tab') picker.open = false;
      });
      const refresh = () => {
        picker.querySelector('[data-event-type-label]').textContent = type.selectedOptions[0].textContent;
        buttons.forEach(button => button.setAttribute('aria-selected', String(button.dataset.eventPickerValue === type.value)));
      };
      type.addEventListener('change', refresh); refresh(); refreshPickers.push(refresh);
      cleanups.push(() => { picker.removeEventListener('toggle', onToggle); stopFloating(); });
    });
    const displayMenu = panel.querySelector('[data-subscription-display]');
    if (displayMenu) cleanups.push(window.XiaoyeFloating.bindDetails(displayMenu, { placement: 'bottom-end' }));
    cleanup = () => cleanups.forEach(stop => stop());
    const type = panel.querySelector('[data-event-kind]');
    if (!type) return;
    const field = name => panel.querySelector(`[data-subscription-${name}]`);
    const setValue = (name, value) => {
      field(name).value = value;
      field(name).dispatchEvent(new Event('input', { bubbles: true }));
    };
    let subscriptionInitialized = Boolean(event.subscription);
    let renderedAccounts = field('extra-accounts')?.value;
    const update = () => {
      refreshPickers.forEach(refresh => refresh());
      const enabled = type.value === 'subscription';
      panel.dataset.accountSubscription = String(enabled);
      panel.querySelector('[data-event-title]').setAttribute('aria-label', enabled ? '日程名' : '日程标题');
      panel.querySelector('#event-editor-heading').textContent = ({ event: '日程', todo: '待办', course: '课程', subscription: '订阅' })[type.value];
      panel.querySelectorAll('[data-event-kind-choice]').forEach(button => {
        const active = button.dataset.eventKindChoice === type.value;
        button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
      });
      if (!field('fields')) return;
      if (field('extra-accounts').value !== renderedAccounts) {
        renderedAccounts = field('extra-accounts').value;
        field('extra-list').innerHTML = JSON.parse(renderedAccounts).map(extraAccountRow).join('');
      }
      if (enabled && !subscriptionInitialized) {
        subscriptionInitialized = true;
        const color = panel.querySelector('[data-event-color]');
        color.value = '#ba68c8'; color.dispatchEvent(new Event('input', { bubbles: true }));
        panel.querySelectorAll('[data-event-color-preset]').forEach(button => {
          const active = button.dataset.eventColorPreset === color.value;
          button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
        });
      }
      field('fields').hidden = !enabled;
      field('period-days').hidden = field('period').value !== 'days';
      const value = read(panel, event.subscription);
      const problem = account.validate(value);
      const stats = !problem && account.counts(value, today);
      field('summary').textContent = problem ? '' : `${stats.remaining < 0 ? `已过期${-stats.remaining}天` : `剩余${stats.remaining}天`} · 已连续使用${stats.continuous}天${field('renewal').value ? ' · 续费日期已填入，保存后生效' : ''}`;
      const renew = field('renew');
      if (renew) renew.disabled = Boolean(field('renewal').value);
    };
    type.addEventListener('change', update);
    refreshCurrent = update;
    update();
    if (!field('fields')) return;
    const storeExtraAccounts = () => {
      renderedAccounts = JSON.stringify([...panel.querySelectorAll('[data-subscription-extra-row]')].map(row => ({
        name: row.querySelector('[data-subscription-extra-name]').value,
        value: row.querySelector('[data-subscription-extra-value]').value
      })));
      setValue('extra-accounts', renderedAccounts);
    };
    field('add-account').onclick = () => {
      field('extra-list').insertAdjacentHTML('beforeend', extraAccountRow({ name: '辅助邮箱', value: '' }));
      storeExtraAccounts();
      field('extra-list').lastElementChild.querySelector('[data-subscription-extra-value]').focus();
    };
    field('extra-list').addEventListener('input', storeExtraAccounts);
    field('extra-list').addEventListener('click', action => {
      const button = action.target.closest('[data-subscription-remove-account]');
      if (!button) return;
      action.stopPropagation();
      button.closest('[data-subscription-extra-row]').remove();
      storeExtraAccounts();
      field('add-account').focus();
    });
    field('fields').addEventListener('input', update);
    field('fields').addEventListener('change', update);
    field('password').addEventListener('input', () => { field('copy-status').textContent = ''; });
    displayMenu.addEventListener('change', update);
    panel.querySelectorAll('[data-subscription-today]').forEach(button => button.onclick = () => setValue(button.dataset.subscriptionToday, today));
    const calculateDate = direction => {
      const from = field(direction === 1 ? 'charged-on' : 'expires-on').value;
      const date = account.calculate(from, field('period').value, Number(field('period-days').value), direction);
      if (date) setValue(direction === 1 ? 'expires-on' : 'charged-on', date);
      else field('summary').textContent = '请先填写有效日期和计算时长。';
    };
    field('calculate').onclick = () => calculateDate(1);
    field('backcalculate').onclick = () => calculateDate(-1);
    if (field('renew')) field('renew').onclick = () => {
      const current = read(panel, event.subscription);
      const renewed = account.renew({ ...event.subscription, cycle: current.cycle, cycleDays: current.cycleDays }, today);
      setValue('renewal', '1');
      for (const [name, value] of [['charged-on', renewed.chargedOn], ['expires-on', renewed.expiresOn]]) setValue(name, value);
      update();
    };
    field('copy-password').onclick = async () => {
      const button = field('copy-password');
      button.disabled = true;
      try {
        await window.dayline.copySubscriptionPassword({ eventId: event.id, password: field('password').value });
        field('copy-status').textContent = '已复制';
      } catch { field('copy-status').textContent = '复制失败，请先填写密码或稍后重试。'; }
      finally { button.disabled = false; }
    };
  }

  window.AccountSubscriptionEditor = { available, kindControl, typeControl, render, displayControl, bind, read, dispose, refresh: () => refreshCurrent?.() };
})();
