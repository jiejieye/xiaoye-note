(function (root) {
  function typeOf(item) { return item?.ongoing || item?.taskType === 'flow' ? 'flow' : item?.taskType === 'goal' ? 'goal' : 'normal'; }
  function title(data, item) {
    const todo = item.todoId ? (data.todos || []).find(row => row.id === item.todoId) || item : item;
    if (typeOf(todo || item) !== 'goal') return item.title || '';
    const tree = (data.workTrees || []).find(row => row.id === todo?.workTreeId);
    const node = tree?.nodes?.find(row => row.id === todo?.workTreeNodeId);
    const parent = tree?.nodes?.find(row => row.id === node?.parentId);
    const parentTitle = parent?.title || (node && !node.parentId ? tree.title : '') || todo?.goalParentTitle || item.goalParentTitle;
    return `${node?.title || todo?.title || item.title || ''}${parentTitle ? '－' + parentTitle : ''}`;
  }
  const api = { typeOf, title };
  if (typeof module !== 'undefined') module.exports = api;
  else root.TaskState = api;
})(typeof window !== 'undefined' ? window : globalThis);
