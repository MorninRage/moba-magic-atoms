/**
 * Awakened-mode magical reticle (Phase 1.5 — see
 * `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` §13.1+§13.3).
 *
 * Center-of-screen crosshair shown while camera-lock is active. Two modes:
 *
 *   - **Free-aim** (no lock-on target): cool cyan, gentle 4 s pulse, four short
 *     cardinal ticks + an inner rune diamond. Tells the player "shots fly here".
 *
 *   - **Locked-on** (T-pressed, target acquired): warm magenta, faster 1.6 s pulse,
 *     ticks bracket inward + a small rotating outer ring with three dotted notches
 *     ("reticle aligned to target"). Pairs with the world-space cyan ground ring
 *     (`lockOnController.ts`) for a complete lock-on read.
 *
 * **Rendering choice — SVG, not THREE:** the reticle MUST sit at exact screen-center
 * regardless of camera FOV / DPR / window resize. A DOM/SVG overlay is one node, scales
 * crisply at any DPI, and incurs zero per-frame work in THREE. CSS animations drive
 * the pulse/rotate (GPU-composited transform/opacity), so the per-frame cost is just
 * `setMode()` calls when the lock state flips.
 *
 * **Mount lifecycle:** `attach()` adds the SVG to the host element; `dispose()` removes
 * it. The element starts HIDDEN — `setVisible(true)` is called by `mountApp` whenever
 * camera-lock is active. State changes (`setMode('free' | 'locked')`) are no-ops when
 * the requested mode is already current → cheap to call every frame.
 *
 * **Phantom-light rule:** N/A — DOM only, no THREE objects.
 */

/* ============================================================================
 * Constants
 * ============================================================================ */

/** Outer crosshair size (px at 1× DPR). Sized to be visible without dominating. */
const RETICLE_SIZE_PX = 56;
/** SVG viewBox is 100×100 — kept square + power-of-2-friendly so the hand-tuned
 * stroke widths stay crisp at the chosen pixel size. */
const VIEWBOX = 100;
/** Mode color tokens — cyan for free-aim, magenta for locked. Both have full
 * `currentColor` flow so the SVG strokes/fills inherit one swap. */
const FREE_COLOR = '#66e0ff';
const LOCKED_COLOR = '#ff7afe';

/* ============================================================================
 * Public handle
 * ============================================================================ */

export type ReticleMode = 'free' | 'locked';

export interface MagicalReticleHandle {
  /** Show or hide the reticle. Flat opacity toggle — no animation cost. */
  setVisible(on: boolean): void;
  /** Switch between free-aim (cyan) and locked-on (magenta) styling. Idempotent. */
  setMode(mode: ReticleMode): void;
  /** Detach + remove DOM. */
  dispose(): void;
}

interface AttachOpts {
  /** Game shell element — reticle is appended here so it sits above the canvas. */
  host: HTMLElement;
}

/* ============================================================================
 * Implementation
 * ============================================================================ */

export function attachMagicalReticle(opts: AttachOpts): MagicalReticleHandle {
  /* Outer wrapper: absolute-centered, pointer-events:none so it never steals input.
   * The wrapper carries the visibility toggle (display: none vs flex) so the SVG
   * itself doesn't get repeatedly attached/detached. */
  const wrap = document.createElement('div');
  wrap.className = 'magical-reticle-wrap';
  wrap.setAttribute('aria-hidden', 'true');
  Object.assign(wrap.style, {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: `${RETICLE_SIZE_PX}px`,
    height: `${RETICLE_SIZE_PX}px`,
    marginLeft: `${-RETICLE_SIZE_PX / 2}px`,
    marginTop: `${-RETICLE_SIZE_PX / 2}px`,
    pointerEvents: 'none',
    zIndex: '60',
    color: FREE_COLOR,
    /* Slight outer glow so the reticle reads against any backdrop (snow, sky, dirt). */
    filter: 'drop-shadow(0 0 4px rgba(0, 0, 0, 0.85)) drop-shadow(0 0 6px currentColor)',
    display: 'none',
    /* Subtle pulse — scales the entire reticle 1.0 → 1.06 → 1.0 over the cycle.
     * Animation duration is set per mode below via `--reticle-pulse-dur`. */
    animation: 'magical-reticle-pulse var(--reticle-pulse-dur, 4s) ease-in-out infinite',
    transition: 'color 0.18s ease-out',
  } as CSSStyleDeclaration);

  /* Inject the @keyframes once per document. Idempotent — safe to call repeatedly. */
  injectReticleKeyframes();

  /* SVG body — crisp at any DPI. Layered groups: outer ring + cardinal ticks (always
   * visible), inner rune (mode-aware: diamond in free-aim, rotating notched ring in
   * locked). The rune layer animates via CSS class swap. */
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${VIEWBOX} ${VIEWBOX}`);
  svg.setAttribute('width', String(RETICLE_SIZE_PX));
  svg.setAttribute('height', String(RETICLE_SIZE_PX));
  svg.style.display = 'block';
  svg.style.overflow = 'visible';

  /* === Layer 1: cardinal ticks (always visible) ===
   *
   * Four short strokes pointing at center from N, E, S, W. Length sized so a tiny
   * gap remains around the inner rune — gives the "I'm not blocking the target"
   * feel of a good crosshair. */
  const tickGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  tickGroup.setAttribute('stroke', 'currentColor');
  tickGroup.setAttribute('stroke-width', '2.2');
  tickGroup.setAttribute('stroke-linecap', 'round');
  tickGroup.setAttribute('fill', 'none');
  /* N, E, S, W — radius 22..36, leaving a 22-radius gap around center. */
  const tickCoords: [number, number, number, number][] = [
    [50, 14, 50, 28],
    [86, 50, 72, 50],
    [50, 86, 50, 72],
    [14, 50, 28, 50],
  ];
  for (const [x1, y1, x2, y2] of tickCoords) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(x1));
    line.setAttribute('y1', String(y1));
    line.setAttribute('x2', String(x2));
    line.setAttribute('y2', String(y2));
    tickGroup.appendChild(line);
  }
  svg.appendChild(tickGroup);

  /* === Layer 2: outer rune ring (only visible when locked) ===
   *
   * A thin ring with three short dot-dash notches at 0°, 120°, 240° that slowly
   * rotates around center — reads as "tracking system engaged". Hidden in free-aim
   * mode via `display: none`. */
  const lockRing = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  lockRing.setAttribute('class', 'magical-reticle-lockring');
  lockRing.setAttribute('stroke', 'currentColor');
  lockRing.setAttribute('stroke-width', '1.4');
  lockRing.setAttribute('fill', 'none');
  lockRing.style.transformOrigin = '50% 50%';
  lockRing.style.animation = 'magical-reticle-spin 6s linear infinite';
  lockRing.style.display = 'none';
  /* Outer dashed ring — a circle made of 3 long dashes by a single stroke-dasharray. */
  const ringCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  ringCircle.setAttribute('cx', '50');
  ringCircle.setAttribute('cy', '50');
  ringCircle.setAttribute('r', '40');
  ringCircle.setAttribute('stroke-dasharray', '6 30');
  ringCircle.setAttribute('opacity', '0.95');
  lockRing.appendChild(ringCircle);
  /* Three short bracket notches at 0/120/240 — anchor pieces that read as a target reticle. */
  const bracketAngles = [-90, 30, 150]; /* N / SE / SW */
  for (const angDeg of bracketAngles) {
    const ang = angDeg * Math.PI / 180;
    const r0 = 36;
    const r1 = 44;
    const cx = 50, cy = 50;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(cx + Math.cos(ang) * r0));
    line.setAttribute('y1', String(cy + Math.sin(ang) * r0));
    line.setAttribute('x2', String(cx + Math.cos(ang) * r1));
    line.setAttribute('y2', String(cy + Math.sin(ang) * r1));
    line.setAttribute('stroke-width', '2.4');
    line.setAttribute('stroke-linecap', 'round');
    lockRing.appendChild(line);
  }
  svg.appendChild(lockRing);

  /* === Layer 3: inner rune (mode-aware center mark) ===
   *
   * Free-aim: small rune diamond + center dot — clean "where my shot goes" mark.
   * Locked  : single bright center dot, slightly larger — the target glyph.
   * Both share the center dot so the shot anchor stays consistent across modes. */
  const innerGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  innerGroup.setAttribute('class', 'magical-reticle-inner');
  /* Diamond — 4-point rune symbol; visible in free-aim, hidden in locked. */
  const diamond = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  diamond.setAttribute('points', '50,42 58,50 50,58 42,50');
  diamond.setAttribute('stroke', 'currentColor');
  diamond.setAttribute('stroke-width', '1.6');
  diamond.setAttribute('stroke-linejoin', 'round');
  diamond.setAttribute('fill', 'none');
  diamond.setAttribute('opacity', '0.95');
  innerGroup.appendChild(diamond);
  /* Center dot — always visible, sized smaller in free-aim, larger when locked. */
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('class', 'magical-reticle-dot');
  dot.setAttribute('cx', '50');
  dot.setAttribute('cy', '50');
  dot.setAttribute('r', '1.6');
  dot.setAttribute('fill', 'currentColor');
  innerGroup.appendChild(dot);
  svg.appendChild(innerGroup);

  wrap.appendChild(svg);
  opts.host.appendChild(wrap);

  let currentMode: ReticleMode = 'free';
  let currentVisible = false;

  function setVisible(on: boolean): void {
    if (currentVisible === on) return;
    currentVisible = on;
    wrap.style.display = on ? 'flex' : 'none';
  }

  function setMode(mode: ReticleMode): void {
    if (currentMode === mode) return;
    currentMode = mode;
    if (mode === 'locked') {
      wrap.style.color = LOCKED_COLOR;
      wrap.style.setProperty('--reticle-pulse-dur', '1.6s');
      lockRing.style.display = '';
      diamond.style.display = 'none';
      dot.setAttribute('r', '2.4');
    } else {
      wrap.style.color = FREE_COLOR;
      wrap.style.setProperty('--reticle-pulse-dur', '4s');
      lockRing.style.display = 'none';
      diamond.style.display = '';
      dot.setAttribute('r', '1.6');
    }
  }

  function dispose(): void {
    if (wrap.parentElement) wrap.parentElement.removeChild(wrap);
  }

  return { setVisible, setMode, dispose };
}

/* ============================================================================
 * Keyframe injection (idempotent)
 * ============================================================================ */

let keyframesInjected = false;
function injectReticleKeyframes(): void {
  if (keyframesInjected) return;
  keyframesInjected = true;
  /* CSS animations rather than JS rAF — these are GPU-composited transforms/opacity,
   * so the per-frame cost is zero on the main thread. The pulse uses translate(-50%)
   * so the wrap stays anchored on its absolute-centered margin offsets while the
   * scale animates around the wrap's center. */
  const style = document.createElement('style');
  style.textContent = `
    @keyframes magical-reticle-pulse {
      0%, 100% { opacity: 0.85; transform: scale(1.0); }
      50%      { opacity: 1.0;  transform: scale(1.06); }
    }
    @keyframes magical-reticle-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
}
