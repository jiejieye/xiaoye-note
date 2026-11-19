const Templates = require('../shared/reminderTemplates');
const route = '/rest/v1/rpc/xiaoye_reminder_rules';
function createWechatReminderRules({ getTransport, getBinding, readDraft, writeDraft, loadData }) {
  const checkBinding = binding => { if (binding !== getBinding()) throw Error('同步账号已变更，请重新打开提醒规则。'); };
  const remote = async (action, args = {}, binding) => {
    checkBinding(binding);
    const transport = getTransport();
    if (!transport?.connected()) throw Error('请在便签内登录同步账号，规则草稿仍保留在本机。');
    const result = await transport.authorizedCall(route, { action, args });
    checkBinding(binding);
    return result;
  };
  async function local(binding) {
    const saved = await readDraft();
    checkBinding(binding);
    return saved?.binding === binding ? saved : null;
  }
  return {
    async get(input = {}) {
      const binding = getBinding();
      const saved = await local(binding);
      let cloud;
      try { cloud = await remote('get', {}, binding); }
      catch (error) {
        checkBinding(binding);
        const data = await loadData();
        let prefs = {};
        if (!saved && /未找到同步接口/.test(error.message)) {
          try { prefs = await getTransport()?.authorizedCall('/rest/v1/rpc/xiaoye_reminder_settings', { action: 'get', args: {} }); } catch {}
        }
        checkBinding(binding);
        return { binding, rules: saved?.rules || Templates.defaults(prefs, (data.reminderPreferences || []).find(row => row.id === 'reminders')), version: saved?.version || 0, pending: Boolean(saved?.pending), cloudReady: false, message: '规则可在本机编辑和预览；云端规则接口尚不可用，保存后暂不改变原有推送。' };
      }
      const rules = saved?.pending && !input.discardDraft ? saved.rules : Templates.normalizeList(cloud.rules);
      const version = saved?.pending && !input.discardDraft ? saved.version : cloud.version;
      if (input.discardDraft) { checkBinding(binding); await writeDraft({ binding, rules, version, pending: false }); }
      return { binding, rules, version, pending: Boolean(saved?.pending && !input.discardDraft), cloudReady: true, message: saved?.pending && !input.discardDraft ? '已恢复本机未同步草稿；点击保存后同步到云端。' : '规则已读取。' };
    },
    async save(input = {}) {
      const binding = getBinding();
      if (input.binding !== binding) throw Error('同步账号已变更，请重新打开提醒规则。');
      const rules = Templates.normalizeList(input.rules);
      const version = Number(input.version || 0);
      if (!Number.isInteger(version) || version < 0) throw Error('规则版本无效，请重新读取。');
      const draft = { binding, rules, version, pending: true };
      await writeDraft(draft);
      let result;
      try { result = await remote('save', { rules, version }, binding); }
      catch { checkBinding(binding); return { binding, rules, version, pending: true, cloudReady: false, message: '规则已保存本机，云端暂未确认；原推送继续保留，联网并更新云端后请再次保存。' }; }
      if (result.conflict) return { binding, rules, version, pending: true, cloudReady: true, conflict: true, cloudVersion: result.version, message: '云端规则已有新修改，本机草稿已保留。请选择读取云端，或用本机规则覆盖。' };
      await writeDraft({ ...draft, version: result.version, pending: false });
      return { binding, rules, version: result.version, pending: false, cloudReady: true, message: '已保存到云端，每条启用的规则将独立发送。' };
    }
  };
}
module.exports = { createWechatReminderRules };
