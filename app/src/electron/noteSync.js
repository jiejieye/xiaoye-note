const crypto = require("crypto");

const COLLECTIONS = ["notes", "noteFolders", "noteLists", "todos", "todoLists", "events", "anniversaries", "workTrees"];
const LOCAL_FIELDS = ["reminderLastKey", "reminderLastFiredAt", "collapsed"];
const NOTE_FIELDS = ["id", "title", "body", "folderId", "listId", "tags", "color", "pinned", "archived", "archiveDate", "order", "createdAt", "updatedAt", "syncConflictOf"];
const FOLDER_FIELDS = ["id", "name", "tag", "color", "order", "syncConflictOf"];
const clone = value => JSON.parse(JSON.stringify(value));
const key = (kind, id) => JSON.stringify([kind, id]);
function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const keys = Object.keys(a).sort();
  return equalKeys(keys, Object.keys(b).sort()) && keys.every(k => equal(a[k], b[k]));
}
function equalKeys(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }
function project(data) {
  const result = {};
  for (const kind of COLLECTIONS) {
    result[kind] = (data[kind] || []).map(record => {
      if (!record.id || typeof record.id !== "string") throw new Error("便签记录缺少有效 ID，暂不能同步");
      const fields = kind === "notes" ? NOTE_FIELDS : ["noteFolders", "noteLists", "todoLists"].includes(kind) ? FOLDER_FIELDS : Object.keys(record).filter(field => !LOCAL_FIELDS.includes(field));
      const value = Object.fromEntries(fields
        .filter(field => record[field] !== undefined).map(field => [field, clone(record[field])]));
      if (kind === "workTrees") value.nodes = (record.nodes || []).map(node => Object.fromEntries(Object.entries(node).filter(([field]) => !LOCAL_FIELDS.includes(field))));
      return value;
    });
    if (new Set(result[kind].map(row => row.id)).size !== result[kind].length) throw new Error("便签存在重复 ID，暂不能同步");
  }
  result.reminderPreferences = clone(data.reminderPreferences || []);
  return result;
}
function records(data) {
  return new Map(COLLECTIONS.flatMap(kind => (data[kind] || []).map(payload => [key(kind, payload.id), { kind, id: payload.id, payload }])));
}
function changes(state) {
  const base = new Map(state.base.map(row => [key(row.kind, row.id), row]));
  const desired = records(state.desired);
  const ops = [];
  for (const k of new Set([...base.keys(), ...desired.keys()])) {
    const before = base.get(k), after = desired.get(k);
    const oldPayload = before && !before.deleted ? before.payload : undefined;
    if (equal(oldPayload, after?.payload)) continue;
    ops.push({ opId: crypto.randomUUID(), kind: (after || before).kind, id: (after || before).id,
      baseVersion: before?.version || 0, payload: after?.payload || null, deleted: !after });
  }
  return ops;
}

// All state mutations run through the application's existing storage queue.
class NoteSync {
  constructor({ read, write, transaction, apply, backup, transport, notify = () => {} }) {
    Object.assign(this, { read, write, transaction, apply, backup, transport, notify });
    this.state = null;
    this.error = "";
    this.running = null;
    this.lastSync = "";
  }
  async init(current) {
    this.state = await this.read();
    if (this.state) {
      if (![1, 2].includes(this.state.format) || !Array.isArray(this.state.base) || !this.state.desired || !this.state.assets) throw new Error("同步日志格式无效，请保留日志并联系维护者");
      if (this.state.format === 1) {
        const backupPath = await this.backup(current);
        if (!backupPath) throw new Error("同步升级备份失败");
        const added = project(current);
        const desired = { ...added, ...this.state.desired };
        const pending = this.state.pending;
        await this.persist({ ...this.state, format: 2, desired, pending, upgradeBackupPath: backupPath });
      }
      project(this.state.desired);
      await this.apply(this.hydrate(this.state.desired, current));
      if (this.state.awaitingApply) await this.persist({ ...this.state, awaitingApply: false });
    }
  }
  status() {
    return { bound: !!this.state, connected: !!this.transport.connected(), running: !!this.running,
      pending: this.state ? changes(this.state).length + (this.state.pending ? 1 : 0) : 0,
      conflicts: this.state ? COLLECTIONS.reduce((count, kind) => count + (this.state.desired[kind] || []).filter(n => n.syncConflictOf).length, 0) : 0,
      lastSync: this.lastSync, error: this.error, ...this.transport.publicConfig() };
  }
  async persist(next) {
    await this.write(next);
    this.state = next;
    this.notify(this.status());
  }
  async bind(binding, current) {
    if (this.state && this.state.binding !== binding) throw new Error("此数据目录已绑定其他账号或服务，请使用独立数据目录，避免数据混入");
    if (this.state) return;
    const desired = project(current);
    const backupPath = await this.backup(current);
    if (!backupPath) throw new Error("首次同步备份失败，未启用同步");
    await this.persist({ format: 2, binding, base: [], desired, assets: Object.fromEntries((current.notes || []).map(n => [n.id, n.attachments || []])), pending: null, backupPath });
  }
  async capture(current) {
    if (!this.state) return;
    if (this.state.awaitingApply) throw new Error("同步数据尚未成功写入本机，请先点击立即同步重试");
    const desired = project(current);
    const assets = Object.fromEntries((current.notes || []).map(n => [n.id, n.attachments || []]));
    if (equal(desired, this.state.desired) && equal(assets, this.state.assets)) return;
    await this.persist({ ...this.state, desired, assets });
  }
  hydrate(desired, current) {
    const next = { ...current, ...clone(desired), notes: desired.notes.map(note => ({ ...note,
      attachments: clone(this.state.assets[note.id] || this.state.assets[note.syncConflictOf] || []) })) };
    for (const kind of ["todos", "events", "anniversaries", "workTrees"]) {
      const local = new Map((current[kind] || []).map(row => [row.id, row]));
      next[kind] = (next[kind] || []).map(row => {
        for (const field of LOCAL_FIELDS) if (local.get(row.id)?.[field] !== undefined) row[field] = local.get(row.id)[field];
        if (kind === "workTrees") {
          const nodes = new Map((local.get(row.id)?.nodes || []).map(n => [n.id, n]));
          row.nodes = (row.nodes || []).map(node => ({ ...node, collapsed: nodes.get(node.id)?.collapsed || false }));
        }
        return row;
      });
    }
    return next;
  }
  async sync() {
    if (this.running) return this.running;
    if (!this.state || !this.transport.connected()) return this.status();
    this.running = this.exchange().catch(error => { this.error = error.message; }).finally(() => {
      this.running = null;
      this.notify(this.status());
    });
    this.notify(this.status());
    await this.running;
    return this.status();
  }
  async exchange() {
    const batch = await this.transaction(async current => {
      if (this.state.awaitingApply) {
        await this.apply(this.hydrate(this.state.desired, current));
        await this.persist({ ...this.state, awaitingApply: false });
      }
      if (!this.state.pending) await this.persist({ ...this.state,
        pending: { ops: changes(this.state), sent: clone(this.state.desired) } });
      return clone(this.state.pending);
    });
    const response = await this.transport.exchange(batch.ops);
    if (!response || response.protocol !== 2 || !Array.isArray(response.rows)) throw new Error("同步服务需要升级，请执行第二阶段数据库脚本");
    const seen = new Set();
    for (const row of response.rows) {
      const k = key(row.kind, row.id);
      if (!COLLECTIONS.includes(row.kind) || typeof row.id !== "string" || !Number.isSafeInteger(row.version) || row.version < 1 || typeof row.deleted !== "boolean" || (!row.deleted && row.payload?.id !== row.id) || seen.has(k)) throw new Error("同步服务返回记录无效");
      seen.add(k);
    }
    await this.transaction(async current => {
      const sent = records(batch.sent), latest = records(this.state.desired);
      const remote = new Map(response.rows.filter(row => !row.deleted).map(row => [key(row.kind, row.id), row]));
      const base = new Map(response.rows.map(row => [key(row.kind, row.id), row]));
      const oldBase = new Map(this.state.base.map(row => [key(row.kind, row.id), row]));
      // Keep edits made while the request was in flight; upload them on the next pass.
      for (const k of new Set([...sent.keys(), ...latest.keys()])) {
        if (equal(sent.get(k)?.payload, latest.get(k)?.payload)) continue;
        if (!equal(sent.get(k)?.payload, remote.get(k)?.payload)) {
          if (oldBase.has(k)) base.set(k, oldBase.get(k)); else base.delete(k);
        }
        if (latest.has(k)) remote.set(k, latest.get(k)); else remote.delete(k);
      }
      const desired = Object.fromEntries(COLLECTIONS.map(kind => [kind, [...remote.values()].filter(row => row.kind === kind).map(row => row.payload)]));
      project(desired);
      await this.persist({ ...this.state, base: [...base.values()], desired, pending: null, awaitingApply: true });
      await this.apply(this.hydrate(desired, current));
      await this.persist({ ...this.state, awaitingApply: false });
      this.error = "";
      this.lastSync = new Date().toISOString();
    });
  }
}

module.exports = { NoteSync, project, changes };
