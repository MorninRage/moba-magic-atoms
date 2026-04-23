/**
 * Damage floaters (Phase 1.5 — see `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` §13).
 *
 * Floating damage numbers projected from world-space hit points to screen-space DOM
 * elements. Provides the player with immediate "I hit them for X" / "they hit me for Y"
 * feedback that the existing battle-mode system has had for ages but awakened mode was
 * missing.
 *
 * **Architecture:** lightweight DOM overlay (single `<div>` parented to the game shell)
 * holds per-floater `<span>` elements. Each floater has:
 *   - World-space anchor `(x, y, z)` — usually the mob's chest or the player's chest.
 *   - Per-frame: `Vector3.project(camera)` -> NDC -> pixel coords; updated each frame
 *     so the floater STAYS attached to the world point even as the camera moves.
 *   - 0.9 s lifetime: floats UP ~30 px, fades opacity 1.0 -> 0, then removes itself.
 *   - Color: white for player-dealt damage to mobs; orange-red for damage taken by
 *     player; cyan for magic damage; gold for crits (future).
 *
 * **Pool:** preallocated 24 spans so a burst of hits doesn't spam DOM creates. When the
 * pool is full, oldest floater is recycled (reset its anchor + age + text). 24 covers a
 * full-screen mob fight (6 mobs × 4 hits/sec = 24/sec).
 *
 * **Phantom-light rule:** N/A — these are DOM elements, no THREE objects.
 */
import * as THREE from 'three';

const POOL_SIZE = 24;
const FLOATER_LIFETIME_SEC = 0.9;
/** How many pixels the floater drifts UP over its lifetime. */
const FLOATER_RISE_PX = 36;

/* ============================================================================
 * Public handle
 * ============================================================================ */

export type DamageFloaterColor = 'white' | 'red' | 'cyan' | 'gold';

export interface DamageFloatersHandle {
  /**
   * Spawn a floating damage number anchored at world `(x, y, z)`. The floater follows
   * that anchor for its lifetime — handy when the target is moving (the number floats
   * with the mob's chest, not floating away in absolute screen space).
   *
   * @param amount Damage value to display (rounded to integer in the UI).
   * @param color Visual style — see `DamageFloaterColor`.
   * @param label Optional prefix shown before the damage number (`"wood"` →
   *              floater reads `"wood -3"`). Used by the magic-as-harvest path
   *              so the player sees what resource they're chipping at distance.
   *              When omitted the floater shows the legacy `"-N"` form.
   */
  spawn(x: number, y: number, z: number, amount: number, color: DamageFloaterColor, label?: string): void;
  /** Per-frame: project + reposition each active floater; recycle expired ones. */
  update(dtSec: number, camera: THREE.Camera): void;
  /**
   * Force-recycle every active floater (hide + reset). Used on player death so the
   * "you took 11 / you took 6 / you took 3" stack of incoming-damage numbers doesn't
   * stay frozen on the death screen — fresh respawn should land in a clean overlay.
   * Idempotent: when no floaters are active, the loop is a no-op.
   */
  clearAll(): void;
  /** Detach overlay + clear pool. */
  dispose(): void;
}

interface AttachOpts {
  /** Game shell element — overlay parents here so floaters render above the canvas. */
  host: HTMLElement;
  /** Canvas element — used to read its bounding rect for pixel projection. */
  canvas: HTMLCanvasElement;
}

interface PoolEntry {
  el: HTMLSpanElement;
  active: boolean;
  ageSec: number;
  ax: number;
  ay: number;
  az: number;
}

/* ============================================================================
 * Implementation
 * ============================================================================ */

export function attachDamageFloaters(opts: AttachOpts): DamageFloatersHandle {
  /* === Cached layout rects ===
   *
   * `getBoundingClientRect()` forces a synchronous style/layout reflow. Calling it on
   * BOTH the canvas AND the host EVERY frame (24 floaters × N updates) was a
   * measurable contributor to the per-frame cost the user reported as "screen
   * stutter when enemies are doing stuff". The rects only change when:
   *   - Window resizes (handled by `ResizeObserver` below).
   *   - The host or canvas gets repositioned in the DOM (very rare; a fullscreen-
   *     transition could trigger it, which the next ResizeObserver tick catches).
   * For everything else the cached rect is correct frame-to-frame.
   *
   * Result: zero forced-layouts per frame in the steady-state floater update. The
   * ResizeObserver fires only on size changes, which are typically <1/sec at most. */
  let cachedCanvasRect = opts.canvas.getBoundingClientRect();
  let cachedHostRect = opts.host.getBoundingClientRect();
  const resizeObserver = new ResizeObserver(() => {
    cachedCanvasRect = opts.canvas.getBoundingClientRect();
    cachedHostRect = opts.host.getBoundingClientRect();
  });
  resizeObserver.observe(opts.canvas);
  resizeObserver.observe(opts.host);

  const overlay = document.createElement('div');
  overlay.className = 'damage-floater-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  /* Inline styles so we don't depend on app.css being updated; cheap + self-contained. */
  Object.assign(overlay.style, {
    position: 'absolute',
    inset: '0',
    pointerEvents: 'none',
    overflow: 'hidden',
    zIndex: '50',
  } as CSSStyleDeclaration);
  opts.host.appendChild(overlay);

  /** Reusable scratch projection vector. */
  const tmpProj = new THREE.Vector3();

  /* Build the pool — every span fully styled, hidden by default. */
  const pool: PoolEntry[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const el = document.createElement('span');
    el.className = 'damage-floater';
    Object.assign(el.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      transform: 'translate(-50%, -50%)',
      fontFamily: 'system-ui, sans-serif',
      fontWeight: '700',
      fontSize: '1.3rem',
      letterSpacing: '0.02em',
      textShadow: '0 0 4px rgba(0, 0, 0, 0.85), 0 0 12px rgba(0, 0, 0, 0.6)',
      pointerEvents: 'none',
      visibility: 'hidden',
      willChange: 'transform, opacity',
    } as CSSStyleDeclaration);
    overlay.appendChild(el);
    pool.push({ el, active: false, ageSec: 0, ax: 0, ay: 0, az: 0 });
  }

  function colorToCss(color: DamageFloaterColor): string {
    switch (color) {
      case 'white': return '#f5f5f5';
      case 'red':   return '#ff5050';
      case 'cyan':  return '#66e0ff';
      case 'gold':  return '#ffcc44';
    }
  }

  /**
   * Active-count tracker so `update()` can early-exit when nothing's floating.
   * Without this, the per-frame loop walked all 24 pool slots every awakened frame
   * just to find the (typically zero) active floaters. Mutated by `spawn` (+1 on
   * pool-find-free, 0 on pool-recycle which is a no-op count change) and by the
   * `update`'s "expired" branch + `clearAll` (-1).
   */
  let activeCount = 0;

  function spawn(
    x: number, y: number, z: number,
    amount: number, color: DamageFloaterColor,
    label?: string,
  ): void {
    /* Find the oldest free entry; if pool is full, recycle the longest-lived active. */
    let entry = pool.find((p) => !p.active);
    if (!entry) {
      /* Pool full -> recycle longest-lived. activeCount stays the same. */
      entry = pool.reduce((a, b) => (a.ageSec >= b.ageSec ? a : b));
    } else {
      /* New floater taking a free slot -> increment active count. */
      activeCount++;
    }
    entry.active = true;
    entry.ageSec = 0;
    entry.ax = x;
    entry.ay = y;
    entry.az = z;
    /* `label` (when provided) reads as e.g. "wood -3" so the player has
     * a written cue for which resource the magic chip is hitting at
     * distance. Without it, legacy "-N" form so combat hits stay visually
     * tight. */
    const dmgText = `-${Math.round(amount)}`;
    entry.el.textContent = label ? `${label} ${dmgText}` : dmgText;
    entry.el.style.color = colorToCss(color);
    entry.el.style.visibility = 'visible';
    entry.el.style.opacity = '1';
  }

  function update(dtSec: number, camera: THREE.Camera): void {
    /* Early-out when no floaters are active — common case during exploration /
     * non-combat play. Saves the 24-slot pool walk + cached-rect lookups. */
    if (activeCount === 0) return;
    /* Use the CACHED rects (refreshed only on resize) instead of per-frame
     * `getBoundingClientRect()` calls — those force layout reflows. See the cached-
     * rects block at the top of `attachDamageFloaters` for the full rationale. */
    const rect = cachedCanvasRect;
    const hostRect = cachedHostRect;
    for (const entry of pool) {
      if (!entry.active) continue;
      entry.ageSec += dtSec;
      const t = entry.ageSec / FLOATER_LIFETIME_SEC;
      if (t >= 1) {
        entry.active = false;
        activeCount--;
        entry.el.style.visibility = 'hidden';
        continue;
      }
      /* Project anchor to NDC. */
      tmpProj.set(entry.ax, entry.ay, entry.az);
      tmpProj.project(camera);
      /* If the anchor is BEHIND the camera, NDC z > 1 → hide the floater for this
       * frame instead of placing it on screen at a flipped position. */
      if (tmpProj.z > 1 || tmpProj.z < -1) {
        entry.el.style.opacity = '0';
        continue;
      }
      /* NDC -> canvas pixel coords. (NDC x in [-1, 1] -> [0, rect.width]; y is flipped.) */
      const canvasX = (tmpProj.x * 0.5 + 0.5) * rect.width;
      const canvasY = (1 - (tmpProj.y * 0.5 + 0.5)) * rect.height;
      /* Translate to host-rect coords (the overlay's coord system). */
      const hostX = canvasX + (rect.left - hostRect.left);
      const hostY = canvasY + (rect.top - hostRect.top);
      /* Apply the rise + fade. */
      const riseY = hostY - t * FLOATER_RISE_PX;
      const opacity = 1 - t * t; /* ease-out fade */
      entry.el.style.transform = `translate(${hostX - 0}px, ${riseY - 0}px) translate(-50%, -50%)`;
      entry.el.style.opacity = String(opacity);
    }
  }

  function clearAll(): void {
    for (const entry of pool) {
      if (!entry.active) continue;
      entry.active = false;
      entry.el.style.visibility = 'hidden';
    }
    activeCount = 0;
  }

  function dispose(): void {
    resizeObserver.disconnect();
    if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
    pool.length = 0;
  }

  return { spawn, update, clearAll, dispose };
}
