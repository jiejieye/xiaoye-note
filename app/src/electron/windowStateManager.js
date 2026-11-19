const { screen } = require("electron");

const SURFACES = ["calendar", "todo", "notes", "worktree"];
const LARGE_SURFACES = new Set(["calendar", "worktree"]);
const AUTO_HIDE_TAB_WIDTH = 36;
const AUTO_HIDE_TAB_HEIGHT = 92;
const EDGE_SNAP_DISTANCE = 2;
const SCREEN_EDGE_GUARD = 2;
const NATIVE_SIZE_NOISE_TOLERANCE = 6;
const WM_SIZING = 0x0214;
const WM_MOVING = 0x0216;
const WM_ENTERSIZEMOVE = 0x0231;
const WM_EXITSIZEMOVE = 0x0232;

function createWindowStateManager(options) {
  const {
    windowSizes,
    loadData,
    loadWindowState,
    saveWindowState,
    settings,
    windows,
    debug = true
  } = options;

  const timers = new WeakMap();
  let persistenceQueue = Promise.resolve();

  function enqueuePersistence(operation) {
    const task = persistenceQueue.then(operation, operation);
    persistenceQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  async function persistWindowState(patch) {
    if (typeof saveWindowState !== "function") throw new Error("windowStateManager requires saveWindowState");
    return saveWindowState(patch);
  }

  async function readWindowState() {
    if (typeof loadWindowState === "function") return loadWindowState();
    const data = await loadData();
    return data?.windowState || {};
  }

  function normalizeSurface(surface) {
    return SURFACES.includes(surface) ? surface : "todo";
  }

  function windowKind(kind) {
    return normalizeSurface(kind === "main" ? "todo" : kind);
  }

  function limitsFor(surface) {
    return windowSizes[normalizeSurface(surface)] || windowSizes.todo;
  }

  function surfaceGroup(surface) {
    return LARGE_SURFACES.has(normalizeSurface(surface)) ? "large" : "compact";
  }

  function groupBoundsKey(surface) {
    return surfaceGroup(surface) === "large" ? "largeSurfaceBounds" : "compactSurfaceBounds";
  }

  function groupSurfaces(surface) {
    return surfaceGroup(surface) === "large" ? ["calendar", "worktree"] : ["todo", "notes"];
  }

  function cloneBounds(bounds) {
    if (!bounds) return null;
    return {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    };
  }

  function hasBounds(bounds) {
    return Boolean(bounds &&
      Number.isFinite(bounds.x) && Number.isFinite(bounds.y) &&
      Number.isFinite(bounds.width) && Number.isFinite(bounds.height) &&
      bounds.width > 0 && bounds.height > 0);
  }

  function hasSize(bounds) {
    return Boolean(bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height) && bounds.width > 0 && bounds.height > 0);
  }

  function workAreaFor(bounds) {
    const probe = hasBounds(bounds) ? bounds : { x: 0, y: 0, width: 1, height: 1 };
    return screen.getDisplayMatching(probe).workArea;
  }

  function clampPositionOnly(bounds, workArea = workAreaFor(bounds)) {
    if (!hasBounds(bounds)) return bounds;
    let width = Math.round(bounds.width);
    let height = Math.round(bounds.height);

    // Position correction must not resize. The only exception is a window that
    // is already larger than the usable work area; then shrink it just enough
    // to make a sane position possible. This path never enlarges a window.
    width = Math.min(width, Math.max(1, workArea.width - SCREEN_EDGE_GUARD * 2));
    height = Math.min(height, Math.max(1, workArea.height - SCREEN_EDGE_GUARD * 2));

    const minX = workArea.x + SCREEN_EDGE_GUARD;
    const minY = workArea.y + SCREEN_EDGE_GUARD;
    const maxX = Math.max(minX, workArea.x + workArea.width - width - SCREEN_EDGE_GUARD);
    const maxY = Math.max(minY, workArea.y + workArea.height - height - SCREEN_EDGE_GUARD);

    return {
      x: Math.max(minX, Math.min(Math.round(bounds.x), maxX)),
      y: Math.max(minY, Math.min(Math.round(bounds.y), maxY)),
      width,
      height
    };
  }

  function sanitizeStableBounds(surface, bounds, anchor = {}) {
    const kind = normalizeSurface(surface);
    const limits = limitsFor(kind);
    const fallbackWorkArea = workAreaFor(hasBounds(bounds) ? bounds : anchor);
    let width = Math.round(hasSize(bounds) ? bounds.width : limits.width);
    let height = Math.round(hasSize(bounds) ? bounds.height : limits.height);
    if (width < limits.minWidth || height < limits.minHeight) {
      width = limits.width;
      height = limits.height;
    }
    width = Math.max(limits.minWidth, width);
    height = Math.max(limits.minHeight, height);
    const x = Number.isFinite(bounds?.x) ? Math.round(bounds.x) : Number.isFinite(anchor?.x) ? Math.round(anchor.x) : fallbackWorkArea.x + SCREEN_EDGE_GUARD;
    const y = Number.isFinite(bounds?.y) ? Math.round(bounds.y) : Number.isFinite(anchor?.y) ? Math.round(anchor.y) : fallbackWorkArea.y + SCREEN_EDGE_GUARD;
    return clampPositionOnly({ x, y, width, height }, fallbackWorkArea);
  }

  function defaultBounds(surface, anchor = {}) {
    const limits = limitsFor(surface);
    return sanitizeStableBounds(surface, {
      x: Number.isFinite(anchor?.x) ? anchor.x : undefined,
      y: Number.isFinite(anchor?.y) ? anchor.y : undefined,
      width: limits.width,
      height: limits.height
    }, anchor);
  }

  function isCollapsedBounds(bounds) {
    return Boolean(bounds && bounds.width <= AUTO_HIDE_TAB_WIDTH + 4 && bounds.height <= AUTO_HIDE_TAB_HEIGHT + 4);
  }

  function usableStoredBounds(raw) {
    if (hasBounds(raw?.fullBounds) && !isCollapsedBounds(raw.fullBounds)) return raw.fullBounds;
    return hasBounds(raw) && !isCollapsedBounds(raw) ? raw : null;
  }

  function storedBoundsForSurface(data, surface) {
    const state = data?.windowState || {};
    const kind = normalizeSurface(surface);
    const grouped = usableStoredBounds(state[groupBoundsKey(kind)]);
    if (grouped) return grouped;
    for (const item of groupSurfaces(kind)) {
      const raw = usableStoredBounds(state[item]);
      if (raw) return raw;
    }
    return null;
  }

  function stableFromWindow(win) {
    const state = win?.__windowStateManager;
    if (state?.stableBounds && hasBounds(state.stableBounds)) return cloneBounds(state.stableBounds);
    return win && !win.isDestroyed() ? sanitizeStableBounds(state?.surface || win.__surface || "todo", win.getBounds(), win.getBounds()) : null;
  }

  function initWindow(win, surface, stableBounds) {
    const kind = normalizeSurface(surface);
    win.__surface = kind;
    win.__windowStateManager = {
      surface: kind,
      stableBounds: sanitizeStableBounds(kind, stableBounds, stableBounds),
      collapsedBounds: null,
      autoHideEdge: "",
      isAutoHideCollapsed: false,
      isAutoHideTransitioning: false,
      isUserMoving: false,
      isUserResizing: false,
      isNativeSizeMoveActive: false,
      nativeInteractionKind: "",
      nativeInteractionStartBounds: null,
      nativeResizeEventObserved: false,
      isManualMove: false,
      manualMoveGeneration: 0,
      isProgrammaticChange: false,
      programmaticChangeToken: 0,
      settleGeneration: 0,
      suppressBoundsEventsUntil: 0,
      isSurfaceSwitching: false,
      isBoundsAnimating: false,
      isKeepOnScreenCorrection: false,
      isSettingsChanging: false,
      lastUserBounds: null,
      lastSizeBeforeMove: hasSize(stableBounds) ? { width: Math.round(stableBounds.width), height: Math.round(stableBounds.height) } : null,
      suppressAutoHideUntil: 0,
      hover: false
    };
    return win.__windowStateManager;
  }

  function stateOf(win) {
    if (!win.__windowStateManager) initWindow(win, win.__surface || "todo", win.getBounds());
    return win.__windowStateManager;
  }

  function flagsForLog(win) {
    const state = win && !win.isDestroyed() ? stateOf(win) : {};
    return {
      isUserMoving: Boolean(state.isUserMoving),
      isUserResizing: Boolean(state.isUserResizing),
      isNativeSizeMoveActive: Boolean(state.isNativeSizeMoveActive),
      nativeInteractionKind: state.nativeInteractionKind || "",
      isManualMove: Boolean(state.isManualMove),
      isProgrammaticChange: Boolean(state.isProgrammaticChange),
      isAutoHideCollapsed: Boolean(state.isAutoHideCollapsed),
      isAutoHideTransitioning: Boolean(state.isAutoHideTransitioning),
      isSurfaceSwitching: Boolean(state.isSurfaceSwitching),
      isBoundsAnimating: Boolean(state.isBoundsAnimating),
      isKeepOnScreenCorrection: Boolean(state.isKeepOnScreenCorrection),
      isSettingsChanging: Boolean(state.isSettingsChanging)
    };
  }

  function log(reason, win, extra = {}) {
    if (!debug) return;
    const state = win && !win.isDestroyed() ? stateOf(win) : {};
    console.log("[window-bounds]", {
      reason,
      surface: state.surface || win?.__surface,
      stableBounds: state.stableBounds ? cloneBounds(state.stableBounds) : null,
      collapsedBounds: state.collapsedBounds ? cloneBounds(state.collapsedBounds) : null,
      ...flagsForLog(win),
      ...extra
    });
  }

  function setMinimumForSurface(win, surface) {
    const limits = limitsFor(surface);
    win.setMinimumSize(limits.minWidth, limits.minHeight);
  }

  function setResizable(win, value) {
    if (!win || win.isDestroyed() || typeof win.setResizable !== "function") return;
    try { win.setResizable(Boolean(value)); } catch (_) {}
  }

  function setWindowBounds(win, requestedBounds, reason, options = {}) {
    if (!win || win.isDestroyed() || !hasBounds(requestedBounds)) return requestedBounds;
    const state = stateOf(win);
    const before = win.getBounds();
    let target = cloneBounds(requestedBounds);

    if (options.preserveStableSize && hasBounds(state.stableBounds)) {
      target.width = state.stableBounds.width;
      target.height = state.stableBounds.height;
    }
    if (options.keepOnScreen) target = clampPositionOnly(target, workAreaFor(target));
    if (sameBounds(before, target)) {
      log(reason, win, { phase: "skip-same-bounds", before, target });
      return cloneBounds(before);
    }

    const programmaticToken = state.programmaticChangeToken + 1;
    state.programmaticChangeToken = programmaticToken;
    state.isProgrammaticChange = true;
    if (reason === "keep-on-screen") state.isKeepOnScreenCorrection = true;
    log(reason, win, { phase: "before-setBounds", before, target });
    try {
      let request = cloneBounds(target);
      win.setBounds(request, false);
      if (options.exactSize) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const actual = win.getBounds();
          if (actual.width === target.width && actual.height === target.height) break;
          const next = {
            x: request.x,
            y: request.y,
            width: Math.max(1, request.width + target.width - actual.width),
            height: Math.max(1, request.height + target.height - actual.height)
          };
          if (next.width === request.width && next.height === request.height) break;
          log(reason, win, { phase: "exact-size-retry", attempt: attempt + 1, request, actual, next });
          request = next;
          win.setBounds(request, false);
        }
      }
    } finally {
      setTimeout(() => {
        if (!win || win.isDestroyed()) return;
        const latest = stateOf(win);
        if (latest.programmaticChangeToken !== programmaticToken) return;
        latest.isProgrammaticChange = false;
        latest.isKeepOnScreenCorrection = false;
      }, options.programmaticHoldMs || 120);
    }
    const after = win.getBounds();
    log(reason, win, { phase: "after-setBounds", before, after });
    return cloneBounds(after);
  }

  async function getStableBoundsForSurface(surface, anchor = {}) {
    const kind = normalizeSurface(surface);
    const data = { windowState: await readWindowState() };
    const raw = storedBoundsForSurface(data, kind);
    return sanitizeStableBounds(kind, raw || defaultBounds(kind, anchor), anchor || raw || {});
  }

  function boundsPatchForSurface(surface, bounds) {
    const kind = normalizeSurface(surface);
    const stored = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    const patch = { [groupBoundsKey(kind)]: stored };
    for (const item of groupSurfaces(kind)) patch[item] = { ...stored };
    return patch;
  }

  function saveStableBounds(surface, bounds, options = {}) {
    return enqueuePersistence(async () => {
      const kind = normalizeSurface(surface);
      const data = { windowState: await readWindowState() };
      const existing = storedBoundsForSurface(data, kind) || {};
      const previous = hasBounds(existing) ? sanitizeStableBounds(kind, existing, existing) : defaultBounds(kind, bounds);
      const source = bounds || previous;
      let next;
      if (options.positionOnly) {
        // Never let a transient or polluted source size influence x/y clamping.
        // Clamp using the already-saved stable width/height first.
        next = clampPositionOnly({
          x: Number.isFinite(source?.x) ? source.x : previous.x,
          y: Number.isFinite(source?.y) ? source.y : previous.y,
          width: previous.width,
          height: previous.height
        }, workAreaFor({
          x: Number.isFinite(source?.x) ? source.x : previous.x,
          y: Number.isFinite(source?.y) ? source.y : previous.y,
          width: previous.width,
          height: previous.height
        }));
      } else {
        next = sanitizeStableBounds(kind, source, previous);
      }
      const patch = boundsPatchForSurface(kind, next);
      console.log("[window-bounds]", { reason: options.reason || "save-stable-bounds", surface: kind, before: previous, after: next, saveWidthHeight: !options.positionOnly });
      await persistWindowState(patch);
      return cloneBounds(next);
    });
  }

  async function rememberWindow(win, options = {}) {
    if (!win || win.isDestroyed()) return null;
    const state = stateOf(win);
    const blocked = state.isProgrammaticChange || state.isAutoHideCollapsed || state.isAutoHideTransitioning || state.isSurfaceSwitching || state.isBoundsAnimating || state.isKeepOnScreenCorrection || state.isSettingsChanging;
    const source = hasBounds(options.bounds) ? options.bounds : state.stableBounds;
    if (!hasBounds(source) || isCollapsedBounds(source)) return null;
    if (blocked && !options.force) {
      log(options.reason || "skip-save-blocked", win, { bounds: source });
      return null;
    }
    state.stableBounds = sanitizeStableBounds(state.surface, source, state.stableBounds || source);
    return saveStableBounds(state.surface, state.stableBounds, { positionOnly: Boolean(options.positionOnly), reason: options.reason || "save-stable-bounds" });
  }

  function rememberLastSurface(surface) {
    return enqueuePersistence(() => persistWindowState({ lastSurface: normalizeSurface(surface) }));
  }

  async function lastSurface() {
    const windowState = await readWindowState();
    return normalizeSurface(windowState.lastSurface || "todo");
  }

  function detectEdge(bounds) {
    if (!settings.edgeAutoHideEnabled()) return "";
    const workArea = workAreaFor(bounds);
    const width = Math.round(bounds.width);
    const leftX = workArea.x + SCREEN_EDGE_GUARD;
    const rightX = workArea.x + workArea.width - width - SCREEN_EDGE_GUARD;
    if (Math.round(bounds.x) <= leftX + EDGE_SNAP_DISTANCE) return "left";
    if (Math.round(bounds.x) >= rightX - EDGE_SNAP_DISTANCE) return "right";
    return "";
  }

  function expandedBoundsForEdge(bounds, edge) {
    const workArea = workAreaFor(bounds);
    const stable = clampPositionOnly(bounds, workArea);
    const x = edge === "right"
      ? workArea.x + workArea.width - stable.width - SCREEN_EDGE_GUARD
      : workArea.x + SCREEN_EDGE_GUARD;
    return clampPositionOnly({ ...stable, x }, workArea);
  }

  function collapsedBoundsFor(win, stable, edge) {
    const workArea = workAreaFor(stable);
    const sameEdgeCount = windows ? [...windows.values()].filter(item => {
      if (!item || item === win || item.isDestroyed()) return false;
      const s = item.__windowStateManager;
      return s?.autoHideEdge === edge && s?.isAutoHideCollapsed;
    }).length : 0;
    const centerY = stable.y + Math.round((stable.height - AUTO_HIDE_TAB_HEIGHT) / 2);
    const y = Math.max(workArea.y, Math.min(centerY + sameEdgeCount * (AUTO_HIDE_TAB_HEIGHT + 8), workArea.y + workArea.height - AUTO_HIDE_TAB_HEIGHT));
    return edge === "right"
      ? { x: workArea.x + workArea.width - AUTO_HIDE_TAB_WIDTH - SCREEN_EDGE_GUARD, y, width: AUTO_HIDE_TAB_WIDTH, height: AUTO_HIDE_TAB_HEIGHT }
      : { x: workArea.x + SCREEN_EDGE_GUARD, y, width: AUTO_HIDE_TAB_WIDTH, height: AUTO_HIDE_TAB_HEIGHT };
  }

  function pointInside(bounds) {
    const point = screen.getCursorScreenPoint();
    return point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
  }

  function sendAutoHideState(win) {
    if (!win || win.isDestroyed()) return;
    const state = stateOf(win);
    win.webContents.send("window:autoHideState", {
      collapsed: Boolean(state.isAutoHideCollapsed),
      edge: state.autoHideEdge || "",
      surface: state.surface
    });
  }

  function armAutoHideEdge(win, reason = "auto-hide-arm-edge") {
    if (!win || win.isDestroyed() || !settings.edgeAutoHideEnabled()) return "";
    const state = stateOf(win);
    const source = hasBounds(state.stableBounds) ? state.stableBounds : stableFromWindow(win);
    const edge = detectEdge(source);
    state.autoHideEdge = edge;
    if (!edge) state.collapsedBounds = null;
    sendAutoHideState(win);
    log(reason, win, { edge, bounds: source });
    return edge;
  }

  function collapse(win, reason = "auto-hide-collapse") {
    if (!win || win.isDestroyed() || !settings.edgeAutoHideEnabled()) return;
    const state = stateOf(win);
    if (!state.autoHideEdge || state.isNativeSizeMoveActive || state.isUserMoving || state.isAutoHideTransitioning || state.isSurfaceSwitching || Date.now() < state.suppressAutoHideUntil) return;
    const stable = stableFromWindow(win);
    if (!hasBounds(stable) || pointInside(stable)) return;
    state.isAutoHideTransitioning = true;
    state.isAutoHideCollapsed = true;
    state.collapsedBounds = collapsedBoundsFor(win, stable, state.autoHideEdge);
    log(reason, win, { before: win.getBounds(), after: state.collapsedBounds });
    win.setMinimumSize(1, 1);
    setResizable(win, false);
    sendAutoHideState(win);
    setWindowBounds(win, state.collapsedBounds, reason, { keepOnScreen: false, programmaticHoldMs: 180 });
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      stateOf(win).isAutoHideTransitioning = false;
    }, 180);
  }

  function expand(win, reason = "auto-hide-expand") {
    if (!win || win.isDestroyed()) return;
    const state = stateOf(win);
    if (!state.autoHideEdge || !state.isAutoHideCollapsed || state.isAutoHideTransitioning || state.isSurfaceSwitching) return;
    const stable = expandedBoundsForEdge(stableFromWindow(win), state.autoHideEdge);
    state.stableBounds = sanitizeStableBounds(state.surface, stable, state.stableBounds);
    state.isAutoHideTransitioning = true;
    state.isAutoHideCollapsed = false;
    log(reason, win, { before: win.getBounds(), after: stable });
    win.setMinimumSize(1, 1);
    setResizable(win, true);
    sendAutoHideState(win);
    setWindowBounds(win, stable, reason, { keepOnScreen: true, programmaticHoldMs: 180 });
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      stateOf(win).isAutoHideTransitioning = false;
      setMinimumForSurface(win, state.surface);
    }, 180);
  }

  function scheduleCollapse(win, delay = 800) {
    if (!win || win.isDestroyed()) return;
    const state = stateOf(win);
    clearTimeout(timers.get(win)?.autoHideTimer);
    const nextTimers = timers.get(win) || {};
    nextTimers.autoHideTimer = setTimeout(() => collapse(win), delay);
    timers.set(win, nextTimers);
  }

  function cancelPendingSettleTimers(win) {
    if (!win || win.isDestroyed()) return 0;
    const state = stateOf(win);
    const currentTimers = timers.get(win) || {};
    clearTimeout(currentTimers.moveTimer);
    clearTimeout(currentTimers.resizeTimer);
    delete currentTimers.moveTimer;
    delete currentTimers.resizeTimer;
    timers.set(win, currentTimers);
    state.settleGeneration += 1;
    return state.settleGeneration;
  }

  function cancelInteraction(win, options = {}) {
    if (!win || win.isDestroyed()) return;
    const state = stateOf(win);
    cancelPendingSettleTimers(win);
    if (options.cancelAutoHide) {
      const currentTimers = timers.get(win) || {};
      clearTimeout(currentTimers.autoHideTimer);
      delete currentTimers.autoHideTimer;
      timers.set(win, currentTimers);
    }
    state.manualMoveGeneration += 1;
    state.isManualMove = false;
    state.isUserMoving = false;
    state.isUserResizing = false;
    state.isNativeSizeMoveActive = false;
    state.nativeInteractionKind = "";
    state.nativeInteractionStartBounds = null;
    state.nativeResizeEventObserved = false;
    state.lastUserBounds = null;
    state.lastSizeBeforeMove = hasBounds(state.stableBounds)
      ? { width: state.stableBounds.width, height: state.stableBounds.height }
      : null;
    win.__manualDrag = null;
  }

  function moveSizeFor(state, current) {
    if (hasSize(state.nativeInteractionStartBounds)) {
      return { width: state.nativeInteractionStartBounds.width, height: state.nativeInteractionStartBounds.height };
    }
    if (hasSize(state.lastSizeBeforeMove)) {
      return { width: state.lastSizeBeforeMove.width, height: state.lastSizeBeforeMove.height };
    }
    if (hasSize(state.stableBounds)) {
      return { width: state.stableBounds.width, height: state.stableBounds.height };
    }
    return { width: current.width, height: current.height };
  }

  function settleMove(win, reason = "user-move-settle") {
    if (!win || win.isDestroyed()) return Promise.resolve(null);
    const state = stateOf(win);
    if (state.isAutoHideCollapsed || state.isAutoHideTransitioning || state.isSurfaceSwitching || state.isSettingsChanging) return Promise.resolve(null);

    const current = win.getBounds();
    const moveSize = moveSizeFor(state, current);
    let target = { x: current.x, y: current.y, width: moveSize.width, height: moveSize.height };
    if (settings.keepWindowsOnScreenEnabled()) target = clampPositionOnly(target, workAreaFor(target));

    const edge = detectEdge(target);
    if (edge) target = expandedBoundsForEdge(target, edge);

    state.suppressBoundsEventsUntil = Date.now() + 180;
    const applied = sameBounds(current, target)
      ? cloneBounds(current)
      : setWindowBounds(win, target, reason, { exactSize: true, programmaticHoldMs: 160 });

    state.stableBounds = sanitizeStableBounds(state.surface, {
      x: applied.x,
      y: applied.y,
      width: moveSize.width,
      height: moveSize.height
    }, state.stableBounds || current);
    state.autoHideEdge = edge;
    if (!edge) state.collapsedBounds = null;
    sendAutoHideState(win);

    state.isUserMoving = false;
    state.isUserResizing = false;
    state.lastUserBounds = null;
    state.lastSizeBeforeMove = { width: moveSize.width, height: moveSize.height };

    const saved = rememberWindow(win, { force: true, positionOnly: true, reason: "user-move-save-position" });
    if (edge && !pointInside(state.stableBounds)) scheduleCollapse(win, 500);
    return saved;
  }

  function settleResize(win, reason = "user-resize-settle") {
    if (!win || win.isDestroyed()) return Promise.resolve(null);
    const state = stateOf(win);
    if (state.isAutoHideCollapsed || state.isAutoHideTransitioning || state.isSurfaceSwitching || state.isSettingsChanging) return Promise.resolve(null);

    const current = win.getBounds();
    const target = settings.keepWindowsOnScreenEnabled()
      ? clampPositionOnly(current, workAreaFor(current))
      : cloneBounds(current);
    state.suppressBoundsEventsUntil = Date.now() + 180;
    const applied = sameBounds(current, target)
      ? cloneBounds(current)
      : setWindowBounds(win, target, reason, { exactSize: true, programmaticHoldMs: 160 });

    state.stableBounds = sanitizeStableBounds(state.surface, applied, state.stableBounds || current);
    state.lastSizeBeforeMove = { width: state.stableBounds.width, height: state.stableBounds.height };
    state.isUserResizing = false;
    state.isUserMoving = false;
    state.lastUserBounds = null;
    if (settings.edgeAutoHideEnabled()) armAutoHideEdge(win, "user-resize-arm-auto-hide");

    return rememberWindow(win, { force: true, positionOnly: false, reason: "user-resize-save" });
  }

  function maybeDockAfterUserMove(win) {
    return settleMove(win, "user-move-settle");
  }

  function scheduleMoveSettled(win) {
    const state = stateOf(win);
    if (state.isNativeSizeMoveActive || state.isProgrammaticChange || state.isAutoHideCollapsed || state.isAutoHideTransitioning || state.isSurfaceSwitching || state.isSettingsChanging || state.isUserResizing) return;
    const generation = cancelPendingSettleTimers(win);
    const currentTimers = timers.get(win) || {};
    currentTimers.moveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const latest = stateOf(win);
      if (latest.settleGeneration !== generation || latest.isNativeSizeMoveActive || latest.isProgrammaticChange || latest.isAutoHideCollapsed || latest.isAutoHideTransitioning || latest.isSurfaceSwitching || latest.isSettingsChanging || latest.isUserResizing) return;
      settleMove(win).catch(console.error);
    }, 180);
    timers.set(win, currentTimers);
  }

  function scheduleResizeSettled(win) {
    const state = stateOf(win);
    if (state.isNativeSizeMoveActive || state.isProgrammaticChange || state.isAutoHideCollapsed || state.isAutoHideTransitioning || state.isSurfaceSwitching || state.isSettingsChanging) return;
    const generation = cancelPendingSettleTimers(win);
    const currentTimers = timers.get(win) || {};
    currentTimers.resizeTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const latest = stateOf(win);
      if (latest.settleGeneration !== generation || latest.isNativeSizeMoveActive || latest.isProgrammaticChange || latest.isAutoHideCollapsed || latest.isAutoHideTransitioning || latest.isSurfaceSwitching || latest.isSettingsChanging) return;
      settleResize(win).catch(console.error);
    }, 250);
    timers.set(win, currentTimers);
  }

  function sameBounds(a, b) {
    return Boolean(a && b && Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y) && Math.round(a.width) === Math.round(b.width) && Math.round(a.height) === Math.round(b.height));
  }

  function markUserBoundsChange(win, kind, bounds) {
    const state = stateOf(win);
    if (state.isProgrammaticChange || state.isAutoHideCollapsed || state.isAutoHideTransitioning || state.isSurfaceSwitching || state.isSettingsChanging) return;
    state.lastUserBounds = cloneBounds(bounds || win.getBounds());
    if (kind === "resizing") {
      state.isUserResizing = true;
      state.isUserMoving = false;
    } else {
      state.isUserMoving = true;
      state.isUserResizing = false;
      if (!hasSize(state.lastSizeBeforeMove)) {
        const source = hasBounds(state.nativeInteractionStartBounds)
          ? state.nativeInteractionStartBounds
          : hasBounds(state.stableBounds) ? state.stableBounds : state.lastUserBounds;
        state.lastSizeBeforeMove = { width: source.width, height: source.height };
      }
    }
  }

  function beginNativeInteraction(win) {
    const state = stateOf(win);
    if (state.isProgrammaticChange || state.isAutoHideCollapsed || state.isSurfaceSwitching) return null;
    cancelPendingSettleTimers(win);
    const start = cloneBounds(win.getBounds());
    state.isNativeSizeMoveActive = true;
    state.nativeInteractionKind = "";
    state.nativeInteractionStartBounds = start;
    state.nativeResizeEventObserved = false;
    state.isUserMoving = false;
    state.isUserResizing = false;
    state.lastUserBounds = start;
    state.lastSizeBeforeMove = { width: start.width, height: start.height };
    state.suppressBoundsEventsUntil = 0;
    return state;
  }

  function finishNativeInteraction(win) {
    if (!win || win.isDestroyed()) return;
    const state = stateOf(win);
    if (!state.isNativeSizeMoveActive) return;
    const start = state.nativeInteractionStartBounds || win.getBounds();
    const current = win.getBounds();
    const widthDelta = Math.abs(current.width - start.width);
    const heightDelta = Math.abs(current.height - start.height);
    const kind = state.isManualMove ? "moving" : state.nativeInteractionKind || (
      state.nativeResizeEventObserved || widthDelta > NATIVE_SIZE_NOISE_TOLERANCE || heightDelta > NATIVE_SIZE_NOISE_TOLERANCE ? "resizing" : "moving"
    );

    state.isNativeSizeMoveActive = false;
    state.suppressBoundsEventsUntil = Date.now() + 180;
    cancelPendingSettleTimers(win);
    const settled = kind === "resizing"
      ? settleResize(win, "native-resize-exit")
      : settleMove(win, "native-move-exit");
    settled.catch(console.error);
    state.nativeInteractionKind = "";
    state.nativeInteractionStartBounds = null;
    state.nativeResizeEventObserved = false;
  }

  function beginManualMove(win) {
    const current = stateOf(win);
    if (current.isSettingsChanging || current.isAutoHideTransitioning) return false;
    const state = beginNativeInteraction(win);
    if (!state) return false;
    const currentTimers = timers.get(win) || {};
    clearTimeout(currentTimers.autoHideTimer);
    delete currentTimers.autoHideTimer;
    timers.set(win, currentTimers);
    state.nativeInteractionKind = "moving";
    state.manualMoveGeneration += 1;
    state.isManualMove = true;
    state.isUserMoving = true;
    state.isUserResizing = false;
    return true;
  }

  function finishManualMove(win) {
    if (!win || win.isDestroyed()) return;
    const state = stateOf(win);
    const generation = state.manualMoveGeneration;
    finishNativeInteraction(win);
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const latest = stateOf(win);
      if (!latest.isManualMove || latest.manualMoveGeneration !== generation) return;
      latest.isManualMove = false;
    }, 200);
  }

  function installNativeMoveClamp(win) {
    if (process.platform !== "win32" || !win || win.isDestroyed() || win.__windowStateManagerNativeHooksInstalled) return;
    win.__windowStateManagerNativeHooksInstalled = true;
    win.hookWindowMessage(WM_ENTERSIZEMOVE, () => {
      beginNativeInteraction(win);
    });
    win.hookWindowMessage(WM_MOVING, () => {
      const state = stateOf(win);
      if (!state.isNativeSizeMoveActive && !beginNativeInteraction(win)) return;
      const active = stateOf(win);
      active.nativeInteractionKind = "moving";
      active.isUserMoving = true;
      active.isUserResizing = false;
      active.lastUserBounds = cloneBounds(win.getBounds());
    });
    win.hookWindowMessage(WM_SIZING, () => {
      const state = stateOf(win);
      if (!state.isNativeSizeMoveActive && !beginNativeInteraction(win)) return;
      const active = stateOf(win);
      if (active.isManualMove) {
        active.nativeInteractionKind = "moving";
        active.isUserMoving = true;
        active.isUserResizing = false;
        active.lastUserBounds = cloneBounds(win.getBounds());
        return;
      }
      active.nativeInteractionKind = "resizing";
      markUserBoundsChange(win, "resizing", win.getBounds());
    });
    win.hookWindowMessage(WM_EXITSIZEMOVE, () => {
      finishNativeInteraction(win);
    });
  }

  function keepOnScreen(win, reason = "keep-on-screen") {
    if (!win || win.isDestroyed() || !settings.keepWindowsOnScreenEnabled()) return null;
    const state = stateOf(win);
    if (state.isNativeSizeMoveActive || state.isUserResizing || state.isAutoHideCollapsed || state.isAutoHideTransitioning || state.isSurfaceSwitching) return null;
    const before = win.getBounds();
    const stableSize = state.isUserMoving && state.lastSizeBeforeMove ? state.lastSizeBeforeMove : before;
    const source = hasSize(stableSize) ? { ...before, width: stableSize.width, height: stableSize.height } : before;
    const after = clampPositionOnly(source, workAreaFor(source));
    if (sameBounds(before, after)) return cloneBounds(after);
    log(reason, win, { before, after });
    return setWindowBounds(win, after, reason, { keepOnScreen: false, exactSize: true, programmaticHoldMs: 150 });
  }

  function onWindowMove(win) {
    if (!win || win.isDestroyed()) return;
    const state = stateOf(win);
    if (state.isProgrammaticChange || state.isAutoHideCollapsed || state.isAutoHideTransitioning || state.isSurfaceSwitching || state.isSettingsChanging || Date.now() < state.suppressBoundsEventsUntil) return;
    const current = win.getBounds();
    if (state.isNativeSizeMoveActive) {
      state.lastUserBounds = cloneBounds(current);
      if (state.isManualMove) {
        state.nativeInteractionKind = "moving";
        state.isUserMoving = true;
        state.isUserResizing = false;
      } else if (state.nativeInteractionKind !== "resizing") state.isUserMoving = true;
      return;
    }
    if (state.isUserResizing) {
      state.lastUserBounds = cloneBounds(current);
      scheduleResizeSettled(win);
      return;
    }
    markUserBoundsChange(win, "moving", current);
    scheduleMoveSettled(win);
  }

  function onWindowResize(win) {
    if (!win || win.isDestroyed()) return;
    const state = stateOf(win);
    if (state.isProgrammaticChange || state.isAutoHideCollapsed || state.isAutoHideTransitioning || state.isSurfaceSwitching || state.isSettingsChanging || Date.now() < state.suppressBoundsEventsUntil) return;

    const current = win.getBounds();
    if (state.isNativeSizeMoveActive) {
      state.lastUserBounds = cloneBounds(current);
      if (state.isManualMove) {
        state.nativeInteractionKind = "moving";
        state.isUserMoving = true;
        state.isUserResizing = false;
      } else if (state.nativeInteractionKind === "resizing") {
        state.isUserResizing = true;
        state.isUserMoving = false;
      } else if (state.nativeInteractionKind !== "moving") {
        state.nativeResizeEventObserved = true;
      }
      return;
    }

    markUserBoundsChange(win, "resizing", current);
    scheduleResizeSettled(win);
  }

  async function enableAutoHide(win) {
    if (!win || win.isDestroyed()) return;
    cancelInteraction(win, { cancelAutoHide: true });
    const state = stateOf(win);
    state.isSettingsChanging = true;
    state.suppressAutoHideUntil = Date.now() + 800;
    try {
      if (state.isAutoHideCollapsed) expand(win, "auto-hide-expand-before-enable");
      const current = win.getBounds();
      state.stableBounds = sanitizeStableBounds(state.surface, current, current);
      state.lastSizeBeforeMove = { width: state.stableBounds.width, height: state.stableBounds.height };
      state.isAutoHideCollapsed = false;
      state.collapsedBounds = null;
      const edge = armAutoHideEdge(win, "auto-hide-setting-enabled");
      log("auto-hide-setting-enabled", win, { before: current, after: state.stableBounds });
      if (edge) scheduleCollapse(win, 1000);
    } finally {
      setTimeout(() => { if (win && !win.isDestroyed()) stateOf(win).isSettingsChanging = false; }, 160);
    }
  }

  async function disableAutoHide(win) {
    if (!win || win.isDestroyed()) return;
    cancelInteraction(win, { cancelAutoHide: true });
    const state = stateOf(win);
    state.isSettingsChanging = true;
    try {
      const wasCollapsed = state.isAutoHideCollapsed;
      const current = win.getBounds();
      const stable = wasCollapsed
        ? clampPositionOnly(state.stableBounds, workAreaFor(state.stableBounds))
        : sanitizeStableBounds(state.surface, current, current);
      state.isAutoHideCollapsed = false;
      state.isAutoHideTransitioning = false;
      state.autoHideEdge = "";
      state.collapsedBounds = null;
      state.stableBounds = stable;
      sendAutoHideState(win);
      win.setMinimumSize(1, 1);
      setResizable(win, true);
      if (wasCollapsed) setWindowBounds(win, stable, "auto-hide-setting-disabled-restore", { keepOnScreen: true, preserveStableSize: true });
      setMinimumForSurface(win, state.surface);
    } finally {
      setTimeout(() => { if (win && !win.isDestroyed()) stateOf(win).isSettingsChanging = false; }, 160);
    }
  }

  async function applySurface(win, nextSurface) {
    const state = stateOf(win);
    const previousSurface = state.surface;
    const previousStable = stableFromWindow(win);
    const targetSurface = normalizeSurface(nextSurface);
    const shouldRememberPrevious = !state.isAutoHideCollapsed && hasBounds(previousStable);
    if (surfaceGroup(previousSurface) === surfaceGroup(targetSurface) && !state.isAutoHideCollapsed && !state.isAutoHideTransitioning) {
      state.surface = targetSurface;
      win.__surface = targetSurface;
      state.stableBounds = sanitizeStableBounds(targetSurface, previousStable, previousStable);
      const patch = { lastSurface: targetSurface };
      enqueuePersistence(() => persistWindowState(patch)).catch(console.error);
      return { ...win.getBounds(), windowStatePatch: patch };
    }
    cancelInteraction(win, { cancelAutoHide: true });
    state.isSurfaceSwitching = true;
    state.suppressAutoHideUntil = Date.now() + 1200;
    log("surface-switch", win, { phase: "start", from: previousSurface, to: nextSurface, before: win.getBounds(), stableBounds: previousStable });
    try {
      const target = surfaceGroup(previousSurface) === surfaceGroup(targetSurface) && hasBounds(previousStable)
        ? sanitizeStableBounds(targetSurface, previousStable, previousStable)
        : await getStableBoundsForSurface(targetSurface, previousStable);
      state.isAutoHideCollapsed = false;
      state.isAutoHideTransitioning = false;
      state.autoHideEdge = "";
      state.collapsedBounds = null;
      setResizable(win, true);
      win.webContents.send("window:autoHideState", { collapsed: false, edge: "", surface: targetSurface });
      state.surface = targetSurface;
      win.__surface = targetSurface;
      state.stableBounds = target;
      win.setMinimumSize(1, 1);
      const applied = setWindowBounds(win, target, "surface-switch", { keepOnScreen: settings.keepWindowsOnScreenEnabled(), programmaticHoldMs: 250 });
      setMinimumForSurface(win, targetSurface);
      if (settings.edgeAutoHideEnabled()) armAutoHideEdge(win, "surface-switch-arm-auto-hide");
      const patch = { lastSurface: targetSurface };
      if (shouldRememberPrevious) Object.assign(patch, boundsPatchForSurface(previousSurface, sanitizeStableBounds(previousSurface, previousStable, previousStable)));
      enqueuePersistence(() => persistWindowState(patch)).catch(console.error);
      log("surface-switch", win, { phase: "end", from: previousSurface, to: targetSurface, after: applied });
      return { ...applied, windowStatePatch: patch };
    } finally {
      setTimeout(() => { if (win && !win.isDestroyed()) stateOf(win).isSurfaceSwitching = false; }, 350);
    }
  }

  function onAutoHidePointer(win, hovering) {
    if (!win || win.isDestroyed()) return;
    const state = stateOf(win);
    state.hover = Boolean(hovering);
    if (hovering) expand(win);
    else scheduleCollapse(win);
  }

  function cleanup(win) {
    const t = timers.get(win) || {};
    Object.values(t).forEach(clearTimeout);
    timers.delete(win);
    if (win) win.__manualDrag = null;
  }

  function sanitizeWindowState(data) {
    data.windowState = data.windowState || {};
    for (const surface of ["calendar", "todo"]) {
      const raw = storedBoundsForSurface(data, surface);
      if (!raw) continue;
      const safe = sanitizeStableBounds(surface, raw, raw);
      const stored = { x: safe.x, y: safe.y, width: safe.width, height: safe.height };
      data.windowState[groupBoundsKey(surface)] = stored;
      for (const item of groupSurfaces(surface)) data.windowState[item] = { ...stored };
    }
    data.windowState.lastSurface = normalizeSurface(data.windowState.lastSurface || "todo");
    return data;
  }

  return {
    normalizeSurface,
    windowKind,
    clampPositionOnly,
    sanitizeStableBounds,
    defaultBounds,
    initWindow,
    setWindowBounds,
    getStableBoundsForSurface,
    saveStableBounds,
    rememberWindow,
    rememberLastSurface,
    lastSurface,
    installNativeMoveClamp,
    beginManualMove,
    finishManualMove,
    keepOnScreen,
    onWindowMove,
    onWindowResize,
    cancelInteraction,
    enableAutoHide,
    disableAutoHide,
    maybeDockAfterUserMove,
    collapse,
    expand,
    onAutoHidePointer,
    applySurface,
    cleanup,
    sanitizeWindowState,
    setMinimumForSurface,
    stateOf,
    log
  };
}

module.exports = { createWindowStateManager };
