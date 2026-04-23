/**
 * IDLE-CRAFT — FPS monitor + persistent corner HUD.
 *
 * Lightweight standalone module:
 *   - Runs its own RAF loop to sample frame time every paint.
 *   - Maintains an EMA-smoothed FPS readout (separate from the dock's
 *     `dockPerfEmaMs` so it stays accurate even if the dock isn't mounted).
 *   - Optionally renders a small fixed-position HUD div in the screen corner
 *     showing `<FPS> · <ms>`. Visibility persists in localStorage.
 *   - Optional FPS cap that the host renderer queries each frame to decide
 *     whether to skip rendering (`shouldSkipForCap`). Cap value persists in
 *     localStorage.
 *
 * The internal RAF loop is always running once `startIdleCraftFpsMonitor()`
 * is called — cost is one `performance.now()` + a couple of arithmetic ops
 * per paint, negligible compared to the render itself.
 */

const HUD_VISIBLE_KEY = 'idle-craft-fps-hud-visible-v1';
const FPS_CAP_KEY = 'idle-craft-fps-cap-v1';

/** No-cap sentinel — render every RAF paint (display-rate ceiling). */
export const FPS_CAP_UNCAPPED = 0;

let started = false;
let raf = 0;
let lastTime = 0;
let frameMsEma = 16.67;
let lastRenderTime = 0;
let fpsCap = readPersistedCap();
let hudEl: HTMLElement | null = null;
let hudVisible = readPersistedHudVisible();
const subscribers = new Set<(fps: number, frameMs: number) => void>();

function readPersistedHudVisible(): boolean {
  try {
    return localStorage.getItem(HUD_VISIBLE_KEY) === '1';
  } catch {
    return false;
  }
}

function readPersistedCap(): number {
  try {
    const v = parseInt(localStorage.getItem(FPS_CAP_KEY) ?? '0', 10);
    if (!Number.isFinite(v) || v < 0) return FPS_CAP_UNCAPPED;
    return v;
  } catch {
    return FPS_CAP_UNCAPPED;
  }
}

function persistHudVisible(v: boolean): void {
  try {
    localStorage.setItem(HUD_VISIBLE_KEY, v ? '1' : '0');
  } catch {
    /* private mode — ignore */
  }
}

function persistCap(v: number): void {
  try {
    localStorage.setItem(FPS_CAP_KEY, String(v));
  } catch {
    /* ignore */
  }
}

function ensureHudEl(): HTMLElement {
  if (hudEl) return hudEl;
  hudEl = document.createElement('div');
  hudEl.id = 'idle-craft-fps-hud';
  hudEl.setAttribute('aria-hidden', 'true');
  hudEl.style.cssText = [
    'position:fixed',
    'top:8px',
    'right:8px',
    'z-index:99999',
    'pointer-events:none',
    'font: 600 12px/14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    'color:#aef0b8',
    'background:rgba(0,0,0,0.55)',
    'padding:4px 7px',
    'border:1px solid rgba(120,200,140,0.35)',
    'border-radius:4px',
    'text-shadow:0 1px 2px rgba(0,0,0,0.85)',
  ].join(';');
  hudEl.textContent = 'FPS …';
  return hudEl;
}

function applyHudVisibility(): void {
  if (hudVisible) {
    const el = ensureHudEl();
    if (!el.parentNode) document.body.appendChild(el);
  } else if (hudEl?.parentNode) {
    hudEl.parentNode.removeChild(hudEl);
  }
}

let lastHudRefreshAt = 0;

const loop = (now: number): void => {
  raf = requestAnimationFrame(loop);
  const dt = now - lastTime;
  lastTime = now;
  /* EMA: 88% memory, 12% new sample — same smoothing constant as `dockPerfEmaMs`
   * so the readouts agree across the codebase. */
  if (dt > 0 && dt < 1000) {
    frameMsEma = frameMsEma * 0.88 + dt * 0.12;
  }
  /* Refresh the HUD text at most ~6 times/second to keep it from flickering. */
  if (hudVisible && now - lastHudRefreshAt > 160) {
    lastHudRefreshAt = now;
    const el = ensureHudEl();
    const fps = 1000 / Math.max(0.5, frameMsEma);
    el.textContent = `FPS ${fps.toFixed(0).padStart(3)} · ${frameMsEma.toFixed(1)}ms`;
  }
  for (const s of subscribers) s(1000 / Math.max(0.5, frameMsEma), frameMsEma);
};

/** Start the global FPS monitor (idempotent). Called once from `mountApp`. */
export function startIdleCraftFpsMonitor(): void {
  if (started) return;
  started = true;
  lastTime = performance.now();
  raf = requestAnimationFrame(loop);
  applyHudVisibility();
}

/** Stop the monitor and remove the HUD (used during teardown / page unload). */
export function stopIdleCraftFpsMonitor(): void {
  if (!started) return;
  started = false;
  cancelAnimationFrame(raf);
  raf = 0;
  if (hudEl?.parentNode) hudEl.parentNode.removeChild(hudEl);
}

export function getIdleCraftFps(): number {
  return 1000 / Math.max(0.5, frameMsEma);
}

export function getIdleCraftFrameMs(): number {
  return frameMsEma;
}

export function isIdleCraftFpsHudVisible(): boolean {
  return hudVisible;
}

export function setIdleCraftFpsHudVisible(v: boolean): void {
  hudVisible = v;
  persistHudVisible(v);
  applyHudVisibility();
}

export function getIdleCraftFpsCap(): number {
  return fpsCap;
}

export function setIdleCraftFpsCap(v: number): void {
  fpsCap = Math.max(0, Math.floor(v));
  persistCap(fpsCap);
}

/**
 * Called by the host render loop each frame. Returns `true` if the render should
 * be SKIPPED to enforce the FPS cap. When the cap is `FPS_CAP_UNCAPPED` (default),
 * always returns `false` — every RAF paint renders.
 *
 * Implementation: tracks the wall-clock time of the last accepted render and
 * returns true until enough time has elapsed for the next frame slot. A small
 * 0.5 ms tolerance avoids consistently overshooting the target by one RAF tick
 * (which would land at 30 fps when capped to 30 on a 60 Hz display).
 */
export function shouldSkipFrameForFpsCap(now: number): boolean {
  if (fpsCap === FPS_CAP_UNCAPPED) {
    lastRenderTime = now;
    return false;
  }
  const targetFrameMs = 1000 / fpsCap;
  const elapsed = now - lastRenderTime;
  if (elapsed >= targetFrameMs - 0.5) {
    lastRenderTime = now;
    return false;
  }
  return true;
}

export function subscribeIdleCraftFps(fn: (fps: number, frameMs: number) => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
