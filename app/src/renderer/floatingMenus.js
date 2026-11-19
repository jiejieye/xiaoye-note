(function () {
  const detailsSelectors = ".calendar-more, [data-work-tree-project-menu], [data-note-card-menu], [data-note-folder-menu]";

  function attach(reference, floating, options = {}) {
    const { computePosition, autoUpdate, offset, flip, shift, size } = window.XiaoyeUiVendor;
    const padding = options.padding ?? 8;
    const originalRect = floating.getBoundingClientRect();
    const originalStyles = new Map();
    const originalMarker = floating.getAttribute("data-floating-menu");
    const originalPopover = floating.getAttribute("popover");
    const topLayer = options.topLayer === true;
    const properties = ["position", "left", "top", "right", "bottom", "margin", "max-width", "max-height", "min-width", "overflow-x", "overflow-y"];
    properties.forEach(property => originalStyles.set(property, [floating.style.getPropertyValue(property), floating.style.getPropertyPriority(property)]));

    const setStyle = (property, value) => floating.style.setProperty(property, value, "important");
    const restoreStyle = property => {
      const [value, priority] = originalStyles.get(property);
      if (value) floating.style.setProperty(property, value, priority);
      else floating.style.removeProperty(property);
    };

    floating.setAttribute("data-floating-menu", "");
    setStyle("position", "fixed");
    setStyle("left", `${originalRect.left}px`);
    setStyle("top", `${originalRect.top}px`);
    setStyle("right", "auto");
    setStyle("bottom", "auto");
    setStyle("margin", "0");
    if (topLayer) {
      // Top layer escapes paint containment without moving the menu or its event handlers.
      floating.setAttribute("popover", "manual");
      floating.showPopover();
    }

    const originalComputed = getComputedStyle(floating);
    const maxWidth = originalComputed.maxWidth.endsWith("px") ? Number.parseFloat(originalComputed.maxWidth) : Infinity;
    const maxHeight = originalComputed.maxHeight.endsWith("px") ? Number.parseFloat(originalComputed.maxHeight) : Infinity;
    const minWidth = Number.parseFloat(originalComputed.minWidth) || 0;
    let active = true;
    let revision = 0;
    let stopAutoUpdate = null;

    async function update() {
      const currentRevision = ++revision;
      if (!active || !floating.isConnected || (reference instanceof Element && !reference.isConnected)) return null;
      const result = await computePosition(reference, floating, {
        strategy: "fixed",
        placement: options.placement || "bottom-end",
        middleware: [
          offset(options.gap ?? 6),
          flip({ padding }),
          shift({ padding, crossAxis: true }),
          size({
            padding,
            apply({ availableWidth, availableHeight }) {
              if (!active || currentRevision !== revision || !floating.isConnected) return;
              const width = Math.max(0, Math.min(maxWidth, availableWidth));
              const height = Math.max(0, Math.min(maxHeight, availableHeight));
              setStyle("max-width", `${width}px`);
              setStyle("max-height", `${height}px`);
              if (minWidth > width) setStyle("min-width", `${width}px`);
              else restoreStyle("min-width");
              if (floating.scrollHeight > height) setStyle("overflow-y", "auto");
              else restoreStyle("overflow-y");
              if (floating.scrollWidth > width) setStyle("overflow-x", "auto");
              else restoreStyle("overflow-x");
            }
          })
        ]
      });
      if (!active || currentRevision !== revision || !floating.isConnected) return null;
      setStyle("left", `${result.x}px`);
      setStyle("top", `${result.y}px`);
      return result;
    }

    stopAutoUpdate = autoUpdate(reference, floating, update);

    function dispose() {
      if (!active) return;
      active = false;
      revision += 1;
      stopAutoUpdate?.();
      stopAutoUpdate = null;
      if (topLayer && floating.matches(":popover-open")) floating.hidePopover();
      if (topLayer) {
        if (originalPopover === null) floating.removeAttribute("popover");
        else floating.setAttribute("popover", originalPopover);
      }
      properties.forEach(restoreStyle);
      if (originalMarker === null) floating.removeAttribute("data-floating-menu");
      else floating.setAttribute("data-floating-menu", originalMarker);
    }

    return { update, dispose };
  }

  function bindDetails(details, options = {}) {
    const summary = details.querySelector(":scope > summary");
    const menu = options.menu || details.querySelector(":scope > div");
    if (!summary || !menu) return () => {};
    let controller = null;
    let listeningOutside = false;

    const listenOutside = enabled => {
      if (enabled === listeningOutside) return;
      listeningOutside = enabled;
      if (enabled) {
        document.addEventListener("pointerdown", onOutsidePointer, true);
        document.addEventListener("keydown", onKeyDown, true);
      } else {
        document.removeEventListener("pointerdown", onOutsidePointer, true);
        document.removeEventListener("keydown", onKeyDown, true);
      }
    };

    const synchronize = () => {
      if (details.open && details.isConnected) {
        if (!controller) controller = attach(summary, menu, { placement: "bottom-end", ...options, topLayer: true });
        else controller.update();
        listenOutside(true);
      } else {
        listenOutside(false);
        controller?.dispose();
        controller = null;
      }
    };
    const onOutsidePointer = event => {
      if (details.contains(event.target)) return;
      details.open = false;
      synchronize();
    };
    const onToggle = event => {
      if (event.target === details) synchronize();
    };
    const onKeyDown = event => {
      if (event.key !== "Escape" || (!details.open && !controller)) return;
      event.preventDefault();
      event.stopPropagation();
      details.open = false;
      synchronize();
      summary.focus({ preventScroll: true });
    };

    details.addEventListener("toggle", onToggle);
    synchronize();
    return () => {
      details.removeEventListener("toggle", onToggle);
      listenOutside(false);
      controller?.dispose();
      controller = null;
    };
  }

  function bindMenus(root) {
    const cleanups = [...root.querySelectorAll(detailsSelectors)].map(details => bindDetails(details));
    return () => cleanups.forEach(cleanup => cleanup());
  }

  window.XiaoyeFloating = { attach, bindDetails, bindMenus };
})();
