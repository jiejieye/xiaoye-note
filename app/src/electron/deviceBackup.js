const crypto = require('crypto');
const os = require('os');
const { project } = require('./noteSync');
class DeviceBackup {
  constructor(options) { Object.assign(this, options); this.error = ''; this.running = null; }
  async init() {
    this.state = await this.read() || { deviceId: crypto.randomUUID(), name: os.hostname(), binding: '', lastUpload: '' };
    await this.write(this.state);
  }
  status() { return { ...this.transport.publicConfig(), connected: this.transport.connected(), deviceName: this.state?.name, deviceId: this.state?.deviceId, lastSync: this.state?.lastUpload, running: !!this.running, error: this.error, mode: 'device-backup' }; }
  async bind(binding) {
    if (this.state.binding && this.state.binding !== binding) throw new Error('此电脑空间已绑定其他账号，请登录原账号。');
    this.state.binding = binding; await this.write(this.state);
  }
  async upload(name) {
    name = String(name || '').trim();
    if (!name || name.length > 80) throw new Error('请填写 1–80 字的电脑名称。');
    const revision = this.state.scheduleRevision || 0;
    const data = await this.transaction(current => project(current));
    await this.transport.backupCall('upload', { device_id: this.state.deviceId, device_name: name, snapshot: data });
    this.state.name = name; this.state.lastUpload = new Date().toISOString();
    if ((this.state.scheduleRevision || 0) === revision) this.state.pendingScheduleUpload = false;
    this.error = '';
    await this.write(this.state);
    return this.status();
  }
  async list() { return this.transport.backupCall('list', {}); }
  async autoSync() {
    if (this.state.pendingScheduleUpload) return this.upload(this.state.name);
    return this.status();
  }
  async markScheduleChanged() {
    this.state.scheduleRevision = (this.state.scheduleRevision || 0) + 1;
    this.state.pendingScheduleUpload = true;
    await this.write(this.state);
  }
  async preview(id) {
    const result = await this.transport.backupCall('get', { device_id: id });
    if (!result?.snapshot) throw new Error('该电脑尚无备份。');
    this.previewData = { ...result, snapshot: project(result.snapshot), token: crypto.randomUUID() };
    return this.previewData;
  }
  async download(token, mode) {
    if (!this.previewData || token !== this.previewData.token || !['merge','replace'].includes(mode)) throw new Error('请重新预览备份后再导入。');
    const snapshot = this.previewData.snapshot;
    await this.transaction(async current => {
      if (!await this.backup(current)) throw new Error('本机备份失败，未导入。');
      const next = JSON.parse(JSON.stringify(current));
      if (mode === 'replace') Object.assign(next, snapshot);
      else {
        // Remap IDs together so imported relationships cannot attach to unrelated local records.
        const ids = new Map();
        for (const rows of Object.values(snapshot)) for (const row of rows) {
          ids.set(row.id, crypto.randomUUID());
          for (const node of row.nodes || []) ids.set(node.id, crypto.randomUUID());
        }
        const remap = value => Array.isArray(value) ? value.map(remap) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k, ['id','folderId','listId','todoId','scheduledEventId','repeatParentId','parentId','workTreeId','workTreeNodeId','syncConflictOf'].includes(k) && typeof v === 'string' ? ids.get(v) || v : remap(v)])) : value;
        for (const [kind, rows] of Object.entries(snapshot)) if (kind !== 'reminderPreferences') next[kind] = [...(next[kind] || []), ...remap(rows)];
      }
      await this.apply(next);
    });
    this.previewData = null;
    return this.status();
  }
}
module.exports = { DeviceBackup };
