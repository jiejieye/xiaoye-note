(function (root) {
  function create(kinds) {
  const clone = value => JSON.parse(JSON.stringify(value));
  const equal = (a, b) => {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const keys = Object.keys(a).sort();
    return JSON.stringify(keys) === JSON.stringify(Object.keys(b).sort()) && keys.every(key => equal(a[key], b[key]));
  };
  function editable(snapshot) {
    return Object.fromEntries(kinds.map(kind => [kind, (snapshot[kind] || []).map(record => Object.fromEntries(Object.entries(record).filter(([key]) => !['reminderLastKey', 'reminderLastFiredAt', '__draft', 'virtual', 'baseEventId'].includes(key))))]));
  }
  function operations(base, next, versions) {
    return kinds.flatMap(kind => {
      const before = new Map((base[kind] || []).map(row => [row.id, row]));
      const after = new Map((next[kind] || []).map(row => [row.id, row]));
      return [...new Set([...before.keys(), ...after.keys()])].filter(id => !equal(before.get(id), after.get(id))).map(id => ({ kind, id, version: versions[kind + ':' + id] || 0, ...(after.has(id) ? { payload: after.get(id) } : { deleted: true }) }));
    });
  }
  function merge(base, local, remote) {
    const snapshot = {}, conflicts = [];
    for (const kind of kinds) {
      const maps = [base, local, remote].map(data => new Map((data[kind] || []).map(row => [row.id, row])));
      snapshot[kind] = [];
      for (const id of new Set(maps.flatMap(map => [...map.keys()]))) {
        const [b, l, r] = maps.map(map => map.get(id));
        let value;
        if (equal(l, b) || equal(l, r)) value = r;
        else if (equal(r, b)) value = l;
        else { conflicts.push({ kind, id, local: l || null, remote: r || null }); value = l; }
        if (value) snapshot[kind].push(clone(value));
      }
    }
    return { snapshot, conflicts };
  }
  return { kinds, clone, equal, editable, operations, merge, withKinds: create };
  }
  const api = create(['events', 'todos']);
  if (typeof module !== 'undefined') module.exports = api;
  else root.DeviceSync = api;
})(typeof window !== 'undefined' ? window : globalThis);
