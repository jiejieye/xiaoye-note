const route = '/rest/v1/rpc/xiaoye_reminder_settings';
const webhookPattern = /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9_-]{16,128}$/;

function createWechatReminderService({ getTransport, getDeviceId }) {
  const call = async (action, args = {}) => {
    const transport = getTransport();
    if (!transport?.connected()) throw Error('请先在便签“多电脑同步”中登录原账号，再配置企业微信。');
    return transport.authorizedCall(route, { action, args });
  };
  const publicStatus = prefs => ({
    configured: Boolean(prefs.webhook_configured), active: prefs.channel === 'wecom',
    enabled: Boolean(prefs.enabled), supported: Boolean(prefs.group_supported)
  });
  return {
    async get() { return publicStatus(await call('get')); },
    async save(input = {}) {
      const webhook = String(input.webhook || '').trim();
      if (webhook && !webhookPattern.test(webhook)) throw Error('请粘贴企业微信群机器人的完整 Webhook 地址；Bot ID 和 Secret 不能填在这里。');
      const current = await call('get');
      if (!current.group_supported) throw Error('当前云端尚未支持群机器人配置，请保留原设置。');
      if (!webhook && !current.webhook_configured) throw Error('请先填写新机器人的 Webhook 地址。');
      const deviceId = current.device_id || getDeviceId();
      if (!deviceId) throw Error('请先在便签中连接共享日程，再配置提醒。');
      const args = {
        device_id: deviceId, send_time: String(current.send_time || '08:00').slice(0, 5),
        channel: 'wecom', webhook,
        enabled: typeof input.enabled === 'boolean' ? input.enabled : Boolean(current.enabled)
      };
      if (current.multiple_supported) for (const key of ['evening_time', 'morning_enabled', 'evening_enabled', 'advance_enabled']) {
        if (current[key] !== undefined && current[key] !== null) args[key] = key === 'evening_time' ? String(current[key]).slice(0, 5) : current[key];
      }
      const saved = await call('save', args);
      if (!saved.webhook_configured || saved.channel !== 'wecom') throw Error('云端未确认保存成功，请重试。');
      return publicStatus(saved);
    },
    async test() {
      const current = await call('get');
      if (current.channel !== 'wecom' || !current.webhook_configured) throw Error('请先保存企业微信群机器人配置，再发送测试汇总。');
      const result = await call('test');
      return { queued: Boolean(result.queued) };
    }
  };
}
module.exports = { createWechatReminderService };
