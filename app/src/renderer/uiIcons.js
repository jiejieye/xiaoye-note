(() => {
  const vendor = window.XiaoyeUiVendor;
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const icons = { x: vendor.X, trash: vendor.Trash2, restore: vendor.RotateCcw };
  let previous = new Map();
  const mounted = new Map();

  function svgIcon(nodes) {
    const svg = document.createElementNS(svgNamespace, 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'ui-svg-icon' })) svg.setAttribute(name, value);
    for (const [tag, attributes] of nodes) {
      const node = document.createElementNS(svgNamespace, tag);
      for (const [name, value] of Object.entries(attributes)) if (value !== undefined) node.setAttribute(name, value);
      svg.append(node);
    }
    return svg;
  }

  function decorate(root) {
    const containers = [...root.querySelectorAll('[data-ui-icon]')];
    if (root.matches?.('[data-ui-icon]')) containers.unshift(root);
    for (const container of containers) {
      const name = container.dataset.uiIcon;
      const nodes = icons[name];
      if (!nodes) continue;
      const current = container.querySelector(':scope > svg.ui-svg-icon');
      if (current?.dataset.uiIconName === name) continue;
      current?.remove();
      const svg = svgIcon(nodes);
      svg.dataset.uiIconName = name;
      container.prepend(svg);
    }
  }

  function beforeRender() {
    for (const [key, record] of mounted) {
      previous.set(key, { kind: record.kind, expanded: record.expanded, d: record.path.getAttribute('d'), moving: record.morph.progress < 1 });
      record.morph.destroy();
    }
    mounted.clear();
  }

  function targetIcon(kind, expanded) {
    return kind === 'archive' ? (expanded ? vendor.ChevronUp : vendor.ChevronDown) : (expanded ? vendor.ChevronDown : vendor.ChevronRight);
  }

  function mount(root) {
    beforeRender();
    decorate(root);
    const next = new Map();
    for (const container of root.querySelectorAll('[data-ui-morph-key][data-ui-expanded]')) {
      const key = container.dataset.uiMorphKey;
      const kind = container.dataset.uiMorph;
      if (!key || !['tree', 'archive'].includes(kind)) continue;
      const expanded = container.dataset.uiExpanded === 'true';
      const target = targetIcon(kind, expanded);
      const prior = previous.get(key);
      const animate = !reducedMotion.matches && prior?.kind === kind && (prior.expanded !== expanded || prior.moving);
      container.querySelector(':scope > svg.ui-svg-icon')?.remove();
      const svg = svgIcon([]);
      const path = document.createElementNS(svgNamespace, 'path');
      svg.append(path);
      container.prepend(svg);
      const morph = vendor.createMorph(path, animate ? prior.d : target, { reducedMotion: reducedMotion.matches ? 'always' : 'never', strokeWidth: 2 });
      if (animate) morph.morphTo(target, { stiffness: 1200, damping: 70 });
      mounted.set(key, { kind, expanded, path, morph, target });
      next.set(key, { kind, expanded });
    }
    previous = next;
  }

  reducedMotion.addEventListener('change', () => {
    for (const record of mounted.values()) {
      record.morph.reducedMotion = reducedMotion.matches ? 'always' : 'never';
      if (reducedMotion.matches) record.morph.set(record.target);
    }
  });

  window.XiaoyeIcons = { beforeRender, mount, decorate };
})();
