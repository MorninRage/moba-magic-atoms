import * as THREE from 'three';
import type { DayPeriodState } from './idleCraftDayPeriods';

/** Band colors matching the skydome gradient (+ storm/dusk tint) for moon limb / sky matching. */
export function skydomeBandColorsForMoon(
  p: Pick<SkydomePaintInput, 'dayMix' | 'sunsetMix' | 'duskMix' | 'stormDim'>,
): { zenith: THREE.Vector3; mid: THREE.Vector3; horizon: THREE.Vector3 } {
  const storm = THREE.MathUtils.clamp(p.stormDim, 0, 1);
  const day = THREE.MathUtils.clamp(p.dayMix, 0, 1);
  const sunset = THREE.MathUtils.clamp(p.sunsetMix, 0, 1);
  const dusk = THREE.MathUtils.clamp(p.duskMix, 0, 1);

  /*
   * Piecewise sky-band interpolation through the four twilight phases. Each band now
   * has **five color stops** (day, civil, nautical, astronomical, deep night) matching
   * the `dayMix` plateaus emitted by `computeDayPeriodState`. Previously the lerp went
   * straight from day hex to a near-black night hex, so the sky wiped 90% dark in one
   * step whenever the cap dropped off a plateau — a visible snap each time.
   *
   * Stop mapping:
   *   dayMix 1.00 -> day hex          (bright blue-white)
   *   dayMix 0.55 -> civil hex        (mid blue, still lit)
   *   dayMix 0.22 -> nautical hex     (deep cobalt blue)
   *   dayMix 0.09 -> astronomical hex (very dark indigo)
   *   dayMix 0.04 -> deep night hex   (near-black)
   */
  const cTop = _piecewiseSkyColor(day, 'top');
  const cMid = _piecewiseSkyColor(day, 'mid');
  const cBot = _piecewiseSkyColor(day, 'bot');

  const zenith = _hexToRgbVec01(cTop);
  const mid = _hexToRgbVec01(cMid);
  const horizon = _hexToRgbVec01(cBot);

  /* All overlays compute unconditionally - no `if > X` gates. The lerp factors go to
   * ~0 when their input is small, so the visual is identical to the gated version,
   * but without the on/off snap when the EMA-smoothed input crossed the threshold. */
  const du = new THREE.Vector3(0.14, 0.10, 0.28);
  zenith.lerp(du, dusk * 0.44);
  mid.lerp(du, dusk * 0.38);
  horizon.lerp(du, dusk * 0.42);
  const warm = new THREE.Vector3(0.6, 0.24, 0.12);
  const warmHi = new THREE.Vector3(0.45, 0.22, 0.28);
  horizon.lerp(warm, sunset * 0.34);
  mid.lerp(warm, sunset * 0.14);
  zenith.lerp(warmHi, sunset * 0.05);
  if (storm > 0.0) {
    /* Storm grey wash kept gated only because the lerp coefficient (0.22 base) is
     * non-zero even at storm=0, which would visibly grey out the clear sky. */
    const gray = new THREE.Vector3(0.28, 0.31, 0.34);
    const k = 0.22 + storm * 0.38;
    zenith.lerp(gray, k * storm);
    mid.lerp(gray, k * storm);
    horizon.lerp(gray, k * storm);
  }
  return { zenith, mid, horizon };
}

/*
 * Nine-stop sky color ramp per band matching the 9 dayMix plateaus. Three extra stops
 * between blue-hour and deep night (nautical, late-astro, deep) so the descent into the
 * darkest backdrop has no visible leap — the previous three-stop tail (0.18 -> 0.09 ->
 * 0.04) dropped brightness ~60% per step, which read as a snap right at the darkest
 * point. Linear interpolation between stops.
 *
 *   dayMix 1.00  -> day             (bright sky)
 *   dayMix 0.78  -> late-day        (slightly darker, warmer-leaning)
 *   dayMix 0.55  -> civil / golden  (horizon still lit, sky mid cobalt)
 *   dayMix 0.35  -> sunset          (sun below, sky deepening)
 *   dayMix 0.22  -> blue hour       (deep indigo, last color)
 *   dayMix 0.14  -> nautical        (darker blue-indigo, stars rising)
 *   dayMix 0.09  -> astronomical    (near-black indigo)
 *   dayMix 0.06  -> late-astro      (almost deep, stars full)
 *   dayMix 0.04  -> deep night      (near-black backdrop)
 */
/*
 * 17-stop sky band ramp. The 9 named phase stops (day, late-day, civil, sunset,
 * blue-hour, nautical, astro, late-astro, night) are unchanged so the dayMix
 * plateaus in computeDayPeriodState still match. Between each pair we now add ONE
 * perceptually-tuned intermediate color (not just the midpoint hex - the
 * intermediates are slightly biased toward the darker end of each pair to compensate
 * for human vision being logarithmic in brightness, so each visible step covers a
 * similar perceived brightness drop). Combined with smoothstep easing in
 * `_piecewiseSkyColor` this eliminates the "step" snap players see in the day -> night
 * transition.
 */
const topDayHex = '#5aa8ec';
const topPostDayHex = '#54a4e9';
const topLateHex = '#4f9fe6';
const topPostLateHex = '#3a7ec9';
const topCivilHex = '#2e6fb2';
const topPreSunsetHex = '#245d9d';
const topSunsetHex = '#1c4e88';
const topPostSunsetHex = '#143e6f';
const topBlueHourHex = '#0e2f5c';
const topPostBlueHexHex = '#0a284c';
const topNauticalHex = '#08213e';
const topPostNauticalHex = '#061a31';
const topAstroHex = '#040f24';
const topPostAstroHex = '#030c1e';
const topLateAstroHex = '#03091a';
const topPostLateAstroHex = '#020618';
const topNightHex = '#020416';

const midDayHex = '#8cc8f4';
const midPostDayHex = '#87c4f2';
const midLateHex = '#82c0f0';
const midPostLateHex = '#64a2d6';
const midCivilHex = '#4882b8';
const midPostCivilHex = '#386da3';
const midSunsetHex = '#28568c';
const midPreBlueHexHex = '#1f4677';
const midBlueHourHex = '#163660';
const midPostBlueHexHex = '#112e54';
const midNauticalHex = '#0c2348';
const midPostNauticalHex = '#091c3b';
const midAstroHex = '#06152e';
const midPostAstroHex = '#051028';
const midLateAstroHex = '#040e22';
const midPostLateAstroHex = '#04091e';
const midNightHex = '#04081a';

const botDayHex = '#c8e8fc';
const botPostDayHex = '#c2e3f9';
const botLateHex = '#bbdef6';
const botPostLateHex = '#8ab2d7';
const botCivilHex = '#5886b8';
const botPostCivilHex = '#4671a4';
const botSunsetHex = '#365c90';
const botPreBlueHexHex = '#284c7b';
const botBlueHourHex = '#1e3c66';
const botPostBlueHexHex = '#193459';
const botNauticalHex = '#152c4c';
const botPostNauticalHex = '#122642';
const botAstroHex = '#101f38';
const botPostAstroHex = '#0e1b30';
const botLateAstroHex = '#0c1628';
const botPostLateAstroHex = '#0b1324';
const botNightHex = '#0a1020';

/**
 * Piecewise sky color for a given dayMix. 17 stops total (9 phase + 8 intermediates),
 * with smoothstep easing within each segment so the derivative is zero at every stop.
 * Combined with linear-spaced extra stops, the visible color transitions feel like a
 * continuous slide rather than detectable steps.
 */
function _piecewiseSkyColor(day: number, band: 'top' | 'mid' | 'bot'): string {
  const stops = BAND_STOPS[band];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (day >= b.v) {
      const t = THREE.MathUtils.clamp((day - b.v) / Math.max(1e-6, a.v - b.v), 0, 1);
      const eased = t * t * (3 - 2 * t);
      return _lerpHex(b.hex, a.hex, eased);
    }
  }
  return stops[stops.length - 1]!.hex;
}

const BAND_STOPS: Record<'top' | 'mid' | 'bot', { v: number; hex: string }[]> = {
  top: [
    { v: 1.0, hex: topDayHex },
    { v: 0.89, hex: topPostDayHex },
    { v: 0.78, hex: topLateHex },
    { v: 0.665, hex: topPostLateHex },
    { v: 0.55, hex: topCivilHex },
    { v: 0.45, hex: topPreSunsetHex },
    { v: 0.35, hex: topSunsetHex },
    { v: 0.285, hex: topPostSunsetHex },
    { v: 0.22, hex: topBlueHourHex },
    { v: 0.18, hex: topPostBlueHexHex },
    { v: 0.14, hex: topNauticalHex },
    { v: 0.115, hex: topPostNauticalHex },
    { v: 0.09, hex: topAstroHex },
    { v: 0.075, hex: topPostAstroHex },
    { v: 0.06, hex: topLateAstroHex },
    { v: 0.05, hex: topPostLateAstroHex },
    { v: 0.04, hex: topNightHex },
  ],
  mid: [
    { v: 1.0, hex: midDayHex },
    { v: 0.89, hex: midPostDayHex },
    { v: 0.78, hex: midLateHex },
    { v: 0.665, hex: midPostLateHex },
    { v: 0.55, hex: midCivilHex },
    { v: 0.45, hex: midPostCivilHex },
    { v: 0.35, hex: midSunsetHex },
    { v: 0.285, hex: midPreBlueHexHex },
    { v: 0.22, hex: midBlueHourHex },
    { v: 0.18, hex: midPostBlueHexHex },
    { v: 0.14, hex: midNauticalHex },
    { v: 0.115, hex: midPostNauticalHex },
    { v: 0.09, hex: midAstroHex },
    { v: 0.075, hex: midPostAstroHex },
    { v: 0.06, hex: midLateAstroHex },
    { v: 0.05, hex: midPostLateAstroHex },
    { v: 0.04, hex: midNightHex },
  ],
  bot: [
    { v: 1.0, hex: botDayHex },
    { v: 0.89, hex: botPostDayHex },
    { v: 0.78, hex: botLateHex },
    { v: 0.665, hex: botPostLateHex },
    { v: 0.55, hex: botCivilHex },
    { v: 0.45, hex: botPostCivilHex },
    { v: 0.35, hex: botSunsetHex },
    { v: 0.285, hex: botPreBlueHexHex },
    { v: 0.22, hex: botBlueHourHex },
    { v: 0.18, hex: botPostBlueHexHex },
    { v: 0.14, hex: botNauticalHex },
    { v: 0.115, hex: botPostNauticalHex },
    { v: 0.09, hex: botAstroHex },
    { v: 0.075, hex: botPostAstroHex },
    { v: 0.06, hex: botLateAstroHex },
    { v: 0.05, hex: botPostLateAstroHex },
    { v: 0.04, hex: botNightHex },
  ],
};

function _hexToRgbVec01(hex: string): THREE.Vector3 {
  const { r, g, b } = _hexToRgb(hex);
  return new THREE.Vector3(r / 255, g / 255, b / 255);
}

export type SkydomePaintInput = {
  simHour: number;
  sunDir: THREE.Vector3;
  stormDim: number;
  /** 0–1;0 skips canvas sun (e.g. plasma mesh handles the disk). Default 1. */
  canvasSunScale?: number;
} & Pick<DayPeriodState, 'dayMix' | 'sunsetMix' | 'duskMix'>;

/** Equirectangular canvas UV for sun position (matches sphere default UVs). */
export function sunDirToSkydomeCanvas(sun: THREE.Vector3, w: number, h: number): { sx: number; sy: number } {
  const u = Math.atan2(sun.x, sun.z) / (Math.PI * 2) + 0.5;
  const v = Math.asin(THREE.MathUtils.clamp(sun.y, -1, 1)) / Math.PI + 0.5;
  return { sx: u * w, sy: v * h };
}

const CLOUD_CENTERS: [number, number, number][] = [
  [0.12, 0.18, 0.38],
  [0.28, 0.22, 0.52],
  [0.45, 0.16, 0.44],
  [0.62, 0.2, 0.48],
  [0.88, 0.19, 0.42],
  [0.08, 0.32, 0.36],
  [0.35, 0.35, 0.55],
  [0.72, 0.33, 0.5],
  [0.92, 0.3, 0.4],
  [0.2, 0.42, 0.45],
  [0.55, 0.44, 0.52],
  [0.82, 0.4, 0.46],
  [0.15, 0.52, 0.38],
  [0.48, 0.54, 0.5],
  [0.68, 0.5, 0.44],
  [0.38, 0.12, 0.35],
  [0.95, 0.14, 0.36],
  [0.05, 0.26, 0.42],
  [0.58, 0.28, 0.48],
  [0.25, 0.58, 0.4],
  [0.75, 0.56, 0.46],
  [0.42, 0.48, 0.42],
  [0.9, 0.46, 0.4],
  [0.22, 0.14, 0.32],
];

/**
 * Full skydome repaint: day gradient, sunset warm band, dusk purple, storm gray-down, sun + clouds.
 */
export function paintIdleCraftSkydome(ctx: CanvasRenderingContext2D, w: number, h: number, p: SkydomePaintInput): void {
  const { sx, sy } = sunDirToSkydomeCanvas(p.sunDir, w, h);
  const storm = THREE.MathUtils.clamp(p.stormDim, 0, 1);
  const day = THREE.MathUtils.clamp(p.dayMix, 0, 1);
  const sunset = THREE.MathUtils.clamp(p.sunsetMix, 0, 1);
  const dusk = THREE.MathUtils.clamp(p.duskMix, 0, 1);

  const cTop = _piecewiseSkyColor(day, 'top');
  const cMid = _piecewiseSkyColor(day, 'mid');
  const cBot = _piecewiseSkyColor(day, 'bot');

  const grd = ctx.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, cTop);
  grd.addColorStop(0.22, _lerpHex(cTop, cMid, 0.55));
  grd.addColorStop(0.45, cMid);
  grd.addColorStop(0.62, _lerpHex(cMid, cBot, 0.5));
  grd.addColorStop(0.78, cBot);
  grd.addColorStop(1, cBot);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, h);

  /* GoE-style sunset: radial aureole at sun (wrap at u=0/u=1 so no vertical seam), soft anti-glow — not a full-height vertical stripe. */
  if (sunset > 0.02) {
    const rad = Math.min(w, h) * 0.64;
    const wrap = rad * 1.05;
    const paintAureole = (cx: number): void => {
      const warm = ctx.createRadialGradient(cx, sy, 4, cx, sy, rad);
      warm.addColorStop(0, `rgba(255, 238, 175, ${0.55 * sunset})`);
      warm.addColorStop(0.14, `rgba(255, 150, 75, ${0.48 * sunset})`);
      warm.addColorStop(0.32, `rgba(255, 88, 95, ${0.32 * sunset})`);
      warm.addColorStop(0.52, `rgba(210, 65, 130, ${0.16 * sunset})`);
      warm.addColorStop(1, 'rgba(255, 70, 90, 0)');
      ctx.fillStyle = warm;
      ctx.fillRect(0, 0, w, h);
    };
    paintAureole(sx);
    if (sx < wrap) paintAureole(sx + w);
    if (sx > w - wrap) paintAureole(sx - w);

    /* Wide horizontal bias from sun row — avoids a tall “curtain” at the anti-meridian */
    const ay = THREE.MathUtils.clamp(sy, h * 0.12, h * 0.55);
    const anti = ctx.createRadialGradient(sx, ay, h * 0.06, sx, ay + h * 0.22, h * 0.62);
    anti.addColorStop(0, `rgba(95, 55, 145, ${0.14 * sunset})`);
    anti.addColorStop(0.45, `rgba(70, 42, 105, ${0.08 * sunset})`);
    anti.addColorStop(1, 'rgba(50, 30, 80, 0)');
    ctx.fillStyle = anti;
    ctx.fillRect(0, 0, w, h);
  }

  if (sunset > 0.05) {
    const hg = ctx.createLinearGradient(0, h * 0.52, 0, h);
    hg.addColorStop(0, 'rgba(255, 215, 145, 0)');
    hg.addColorStop(0.38, `rgba(255, 175, 95, ${0.5 * sunset})`);
    hg.addColorStop(0.78, `rgba(255, 105, 85, ${0.42 * sunset})`);
    hg.addColorStop(1, `rgba(195, 75, 130, ${0.32 * sunset})`);
    ctx.fillStyle = hg;
    ctx.fillRect(0, 0, w, h);
  }

  if (dusk > 0.02) {
    /* Vertical-only: diagonal gradients break u=0 / u=1 continuity on the sphere. */
    const du = ctx.createLinearGradient(0, 0, 0, h);
    du.addColorStop(0, `rgba(40, 30, 72, ${0.38 * dusk})`);
    du.addColorStop(0.48, `rgba(62, 44, 88, ${0.3 * dusk})`);
    du.addColorStop(1, `rgba(32, 24, 56, ${0.35 * dusk})`);
    ctx.fillStyle = du;
    ctx.fillRect(0, 0, w, h);
  }

  if (storm > 0.04) {
    ctx.fillStyle = `rgba(72, 78, 88, ${0.22 + storm * 0.38})`;
    ctx.fillRect(0, 0, w, h);
  }

  const sunScale = typeof p.canvasSunScale === 'number' ? THREE.MathUtils.clamp(p.canvasSunScale, 0, 1) : 1;
  /* Smooth late-sunset dimming (replaces a linear cliff at 0.85 that stepped against per-frame fog). */
  const lateSunsetMul = 1 - THREE.MathUtils.smoothstep(sunset, 0.72, 0.995) * 0.72;
  const sunVis = sunScale * day * (1 - storm * 0.55) * lateSunsetMul;
  if (sunVis > 0.02) {
    _paintCanvasSunDisc(ctx, sx, sy, w, h, sunVis);
    const wrap = 172;
    if (sx < wrap) _paintCanvasSunDisc(ctx, sx + w, sy, w, h, sunVis);
    if (sx > w - wrap) _paintCanvasSunDisc(ctx, sx - w, sy, w, h, sunVis);
  }

  /* Fade clouds into the night dome so bright puffs don’t pop against dark gradients after dusk. */
  const cloudNightFade = THREE.MathUtils.lerp(0.12, 1, Math.pow(day, 0.82));
  const cloudA = (0.42 - storm * 0.28) * (0.35 + day * 0.65) * cloudNightFade;
  for (const [ux, vy, radNorm] of CLOUD_CENTERS) {
    const cx = ux * w;
    const cy = vy * h;
    const r = radNorm * Math.min(w, h) * 0.5;
    _paintCloudDisc(ctx, cx, cy, r, cloudA);
    if (cx - r < 0) _paintCloudDisc(ctx, cx + w, cy, r, cloudA);
    if (cx + r > w) _paintCloudDisc(ctx, cx - w, cy, r, cloudA);
  }
  /* Intentionally no `getImageData` seam seal: readback caused multi-second stalls on some GPUs even when throttled. */
}

function _paintCanvasSunDisc(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  w: number,
  h: number,
  sunVis: number,
): void {
  const core = ctx.createRadialGradient(sx, sy, 2, sx, sy, 18);
  core.addColorStop(0, `rgba(255, 254, 240, ${sunVis})`);
  core.addColorStop(0.35, `rgba(255, 244, 200, ${0.85 * sunVis})`);
  core.addColorStop(1, 'rgba(255, 240, 200, 0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(sx, sy, 18, 0, Math.PI * 2);
  ctx.fill();

  const halo = ctx.createRadialGradient(sx, sy, 8, sx, sy, 170);
  halo.addColorStop(0, `rgba(255, 248, 220, ${0.5 * sunVis})`);
  halo.addColorStop(0.12, `rgba(255, 235, 190, ${0.26 * sunVis})`);
  halo.addColorStop(0.45, `rgba(255, 220, 160, ${0.07 * sunVis})`);
  halo.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, w, h);
}

function _paintCloudDisc(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, cloudA: number): void {
  const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  cg.addColorStop(0, `rgba(255, 255, 255, ${cloudA})`);
  cg.addColorStop(0.35, `rgba(255, 255, 255, ${cloudA * 0.48})`);
  cg.addColorStop(0.7, `rgba(255, 255, 255, ${cloudA * 0.14})`);
  cg.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

function _lerpHex(a: string, b: string, t: number): string {
  const u = THREE.MathUtils.clamp(t, 0, 1);
  const ca = _hexToRgb(a);
  const cb = _hexToRgb(b);
  const r = Math.round(ca.r + (cb.r - ca.r) * u);
  const g = Math.round(ca.g + (cb.g - ca.g) * u);
  const bl = Math.round(ca.b + (cb.b - ca.b) * u);
  return `#${((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1)}`;
}

function _hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
