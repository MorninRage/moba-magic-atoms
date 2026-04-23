import * as THREE from 'three';

/**
 * GoE-inspired **clock periods** blended with **sun elevation** so midday feels long
 * and sunset/dusk are distinct (see docs/DAYNIGHT_WEATHER_GOE_PLAN.md).
 * `IdleCraftDockEnvironment` applies real-time easing on `dayMix` **and** on sunset/dusk/warmth/star
 * opacity so fog tints and sun color move with the same phase as brightness (no “stair steps”).
 */
export type DayPeriodState = {
  /** 0 = night, 1 = full daylight — drives key light, fog day side. */
  dayMix: number;
  nightMix: number;
  /** 0–1 orange sunset band (sun low, late afternoon). */
  sunsetMix: number;
  /** 0–1 purple twilight after sunset. */
  duskMix: number;
  /** Star visibility 0–1 (fade in evening, out morning). */
  starOpacity: number;
  /** 0 = cool/white sun, 1 = warm orange (sunset + dawn). */
  sunWarmth: number;
};

function wrapHour(h: number): number {
  let x = h % 24;
  if (x < 0) x += 24;
  return x;
}

/**
 * Smooth maximum of two values (C¹ blend near the crossover). Plain `Math.max(a,b)` left a kink
 * where clock-based and sun-elevation curves met → occasional brightness steps in lighting + skydome.
 * Uses log-sum-exp with correction so a === b returns exactly a (not a + log(2)/k).
 */
function smoothMax2(a: number, b: number, k = 14): number {
  const m = Math.max(a, b);
  return m + (Math.log(Math.exp(k * (a - m)) + Math.exp(k * (b - m))) - Math.LN2) / k;
}

/**
 * Idealized day curve by **clock hour**. Evening keeps its wide dusk ramps (user confirmed
 * "going to dark is smooth, perfect"). **Morning** keeps deep dark until h=5.0, then ramps
 * gradually through pre-dawn so the climb from dark cobalt to bright day is monotonic and
 * fully covered by the new sunsetMix red tint (no "blue stage after red" reappearing).
 */
function hourDayMix(h: number): number {
  if (h < 5.0 || h >= 22.8) return 0;
  /* Pre-dawn ramp through dark cobalt phases (dayMix 0 -> ~0.5 by sunrise at h=6.5). */
  if (h < 6.5) return THREE.MathUtils.smoothstep(h, 5.0, 6.5) * 0.5;
  /* Sunrise to full day — covered entirely by the morning sunsetMix plateau + fade. */
  if (h < 8.5) return 0.5 + THREE.MathUtils.smoothstep(h, 6.5, 8.5) * 0.5;
  if (h < 16.35) return 1;
  /* Golden hour → sunset: wider sim-time window = shallower derivative (more “phases” per hour). */
  if (h < 18.4) return 1 - THREE.MathUtils.smoothstep(h, 16.35, 18.4) * 0.32;
  if (h < 19.55) return 0.68 - THREE.MathUtils.smoothstep(h, 18.4, 19.55) * 0.48;
  if (h < 21.15) return 0.2 - THREE.MathUtils.smoothstep(h, 19.55, 21.15) * 0.1;
  return THREE.MathUtils.smoothstep(h, 21.15, 22.8) * 0.1;
}

/*
 * Sunset / sunrise warm band (orange / red horizon tint).
 *
 *   Evening (unchanged - user confirmed "perfect").
 *     15.3 -> 17.2 ramp in, 17.2 -> 19.2 plateau, 19.2 -> 20.6 fade out.
 *
 *   Morning - SHIFTED LATER and EXTENDED to cover the entire climb from civil twilight
 *     to bright day. Critical so there is no "blue stage after red" — the red overlay
 *     stays present right through dayMix 0.5 -> 1.0 climb so the sky never reverts to a
 *     cool blue tone between sunrise and full daylight.
 *     6.0 -> 6.5 ramp in, 6.5 -> 7.5 plateau, 7.5 -> 8.5 fade out.
 */
function sunsetMixFromHour(h: number): number {
  let eve = 0;
  if (h >= 15.3 && h <= 20.6) {
    if (h < 17.2) eve = THREE.MathUtils.smoothstep(h, 15.3, 17.2);
    else if (h < 19.2) eve = 1;
    else eve = 1 - THREE.MathUtils.smoothstep(h, 19.2, 20.6);
  }
  let morn = 0;
  if (h >= 6.0 && h <= 8.5) {
    if (h < 6.5) morn = THREE.MathUtils.smoothstep(h, 6.0, 6.5);
    else if (h < 7.5) morn = 1;
    else morn = 1 - THREE.MathUtils.smoothstep(h, 7.5, 8.5);
  }
  return Math.max(eve, morn);
}

/*
 * Dusk / pre-dawn blue-violet twilight - the cool tint that paints the sky during the
 * dark cobalt phases between deep night and sunrise.
 *
 *   Evening (unchanged):  17.8 -> 19.6 ramp up, 19.6 -> 20.4 plateau, 20.4 -> 21.3 down.
 *   Morning - ENDS BEFORE sunsetMix begins so the sequence reads
 *               dark -> blue stages -> red sunrise -> day
 *             with no overlap that would smear blue into the red phase.
 *     5.0 -> 5.5 ramp up, 5.5 -> 5.9 plateau, 5.9 -> 6.1 fade out.
 */
function duskMixFromHour(h: number): number {
  let eve = 0;
  if (h >= 17.8 && h <= 21.3) {
    if (h < 19.6) eve = THREE.MathUtils.smoothstep(h, 17.8, 19.6);
    else if (h < 20.4) eve = 1;
    else eve = 1 - THREE.MathUtils.smoothstep(h, 20.4, 21.3);
  }
  let morn = 0;
  if (h >= 5.0 && h <= 6.1) {
    if (h < 5.5) morn = THREE.MathUtils.smoothstep(h, 5.0, 5.5);
    else if (h < 5.9) morn = 1;
    else morn = 1 - THREE.MathUtils.smoothstep(h, 5.9, 6.1);
  }
  return Math.max(eve, morn);
}

/*
 * Star opacity — staged reveal matching the twilight-phase dayMix cap.
 *
 *   Evening (unchanged):
 *     civil        (h 18.5 -> 19.3)  0 -> 0.3
 *     nautical     (h 19.3 -> 20.0)  0.3 -> 0.7
 *     astronomical (h 20.0 -> 20.6)  0.7 -> 0.95
 *     deep         (h 20.6 -> 21.2)  0.95 -> 1.0
 *
 *   Morning - hold full visibility through the long deep-night and the dusk blue stages,
 *             only fade once sunsetMix red is on the way in (h>5.9).
 *     deep         (h < 5.5)         1.0
 *     astronomical (h 5.5 -> 5.8)    0.95
 *     nautical     (h 5.8 -> 6.0)    0.7
 *     civil        (h 6.0 -> 6.3)    0.3
 *     fade         (h 6.3 -> 6.8)    0
 */
function starOpacityFromHour(h: number): number {
  if (h >= 21.2 || h < 5.5) return 1;
  if (h >= 20.6) return 0.95 + THREE.MathUtils.smoothstep(h, 20.6, 21.2) * 0.05;
  if (h >= 20.0) return 0.7 + THREE.MathUtils.smoothstep(h, 20.0, 20.6) * 0.25;
  if (h >= 19.3) return 0.3 + THREE.MathUtils.smoothstep(h, 19.3, 20.0) * 0.4;
  if (h >= 18.5) return THREE.MathUtils.smoothstep(h, 18.5, 19.3) * 0.3;
  if (h < 5.8) return 0.95 + (1 - THREE.MathUtils.smoothstep(h, 5.5, 5.8)) * 0.05;
  if (h < 6.0) return 0.7 + (1 - THREE.MathUtils.smoothstep(h, 5.8, 6.0)) * 0.25;
  if (h < 6.3) return 0.3 + (1 - THREE.MathUtils.smoothstep(h, 6.0, 6.3)) * 0.4;
  if (h < 6.8) return (1 - THREE.MathUtils.smoothstep(h, 6.3, 6.8)) * 0.3;
  return 0;
}

function sunWarmthFromHour(h: number, sunsetMix: number): number {
  let w = 0;
  /* Dawn warmth aligned to the new morning sunsetMix window (6.0 -> 8.5). Peaks at
   * h=7.0 (well after sunrise) so the warmth coincides with the red overlay rather
   * than preceding it. */
  if (h >= 6.0 && h < 8.5) w = Math.max(w, (1 - Math.abs(h - 7.0) / 1.8) * 0.85);
  if (sunsetMix > 0.05) w = Math.max(w, sunsetMix * 0.95);
  return Math.min(1, w);
}

/**
 * Twilight phase cap — table-driven so we can express **real plateaus** (two adjacent
 * stops with the same cap value) for the dwell phases the player wants to enjoy.
 *
 * Stops are ordered DESCENDING by `y` (sun elevation). Between adjacent stops, the cap
 * lerps with smoothstep easing. When two adjacent stops share the same cap value, that
 * range becomes a flat plateau where dayMix dwells.
 *
 *   Plateau values (dayMix): 1.00, 0.78, 0.55, 0.35, 0.22, 0.14, 0.09, 0.06, 0.04
 *
 *   Evening (h >= 12) — in-between phases compressed, deep blue + dark held LONG:
 *     y +0.15 → +0.05      1.00 → 0.78  (late-day, normal width)
 *     y +0.05 → -0.04      0.78 → 0.55  (civil / golden, normal)
 *     y -0.04 → -0.08      0.55 → 0.35  (sunset, COMPRESSED 0.04)
 *     y -0.08 → -0.11      0.35 → 0.22  (blue-hour, COMPRESSED 0.03)
 *     y -0.11 → -0.14      0.22 → 0.14  (nautical, COMPRESSED 0.03)
 *     y -0.14 → -0.18      0.14 → 0.09  (astro entry, brief 0.04)
 *     y -0.18 → -0.22      0.09 → 0.06  (descending into deep blue)
 *     y -0.22 → -0.42      0.06 → 0.06  (DEEP BLUE PLATEAU - 0.20 wide)
 *     y -0.42 → -0.50      0.06 → 0.04  (final descent to deep dark)
 *     y <  -0.50           0.04 plateau (DARKEST DWELL - widest range)
 *
 *   Morning (h < 12) — same shape, compressed near horizon so deep night persists
 *                       until moon is about to vanish; deep blue plateau still present
 *                       in the brief pre-dawn window before red sunrise.
 *     y +0.15 → +0.08      1.00 → 0.78
 *     y +0.08 → +0.02      0.78 → 0.55
 *     y +0.02 → -0.01      0.55 → 0.35  (sunrise, compressed)
 *     y -0.01 → -0.03      0.35 → 0.22  (blue-hour, compressed)
 *     y -0.03 → -0.05      0.22 → 0.14  (nautical, compressed)
 *     y -0.05 → -0.07      0.14 → 0.09  (astro entry)
 *     y -0.07 → -0.10      0.09 → 0.06  (descending to deep blue)
 *     y -0.10 → -0.16      0.06 → 0.06  (DEEP BLUE PLATEAU)
 *     y -0.16 → -0.20      0.06 → 0.04  (final to dark)
 *     y <  -0.20           0.04 plateau (deep night hold)
 */
type CapStop = { y: number; v: number };

/**
 * Stops are tuned so the **deep-dark backdrop arrives shortly after sunset** and then
 * **dwells** through the rest of the night. Earlier versions placed the deep-dark
 * plateau threshold at sun.y ≈ -0.50, which didn't reach until ~2.5 sim hours after
 * sunset (the moon was already past mid-arc by then). Now the deep-dark plateau begins
 * at sun.y ≈ -0.18 (≈40 sim minutes after sunset / before sunrise), so the spectacular
 * dark backdrop covers nearly the entire moon arc.
 *
 * In-between phases (sunset / blue-hour / nautical) are compressed so the eye sees them
 * but does not linger. The "important phases leading to the best part" — late-astro and
 * the final descent into deep dark — get a wider cap window so they read as their own
 * stones, but they still finish quickly relative to the long dark dwell that follows.
 *
 * Evening (h >= 12):
 *   y +0.15 → +0.05    1.00 → 0.78  (late-day, normal)
 *   y +0.05 → -0.04    0.78 → 0.55  (civil/golden, normal)
 *   y -0.04 → -0.07    0.55 → 0.35  (sunset, compressed)
 *   y -0.07 → -0.10    0.35 → 0.22  (blue-hour, compressed)
 *   y -0.10 → -0.13    0.22 → 0.14  (nautical, compressed)
 *   y -0.13 → -0.16    0.14 → 0.09  (astro, leading-phase width)
 *   y -0.16 → -0.18    0.09 → 0.06  (deep blue, leading-phase)
 *   y -0.18 → -0.22    0.06 → 0.04  (final to deep dark)
 *   y <  -0.22         0.04         (DEEP DARK plateau — dominant dwell)
 *
 * Morning (h < 12): mirror with the same fast in-betweens; the deep-dark plateau holds
 * for sun.y < -0.12 so darkness persists through pre-dawn until just before sunrise.
 */
/* === 2026-04-20 day/night transition smoothness ===
 *
 * Stop widths roughly DOUBLED so each brightness drop spreads across a
 * longer sun-elevation band. Previous tightest segments (e.g. morning
 * −0.01→−0.03 = 0.02 wide for a 0.13 v drop) made `dayMix` target step
 * down so quickly the EMA couldn't keep up — visible "snap" through dawn.
 * Wider segments + the same stop values mean the same brightness curve
 * shape, just paced over more elevation = no perceptible step.
 *
 * Trade-off vs the prior design intent ("morning compresses phases so deep
 * night holds until right before sunrise"): morning still falls/rises
 * faster than evening (bottom plateau at −0.18 vs −0.22) but no longer at
 * a step-perceptible rate. */
const EVENING_CAP_STOPS: readonly CapStop[] = [
  { y: 0.18, v: 1.0 },
  { y: 0.05, v: 0.78 },
  { y: -0.06, v: 0.55 },
  { y: -0.12, v: 0.35 },
  { y: -0.17, v: 0.22 },
  { y: -0.22, v: 0.14 },
  { y: -0.26, v: 0.09 },
  { y: -0.30, v: 0.06 },
  { y: -0.36, v: 0.04 },
];
const MORNING_CAP_STOPS: readonly CapStop[] = [
  { y: 0.18, v: 1.0 },
  { y: 0.08, v: 0.78 },
  { y: 0.0, v: 0.55 },
  { y: -0.05, v: 0.35 },
  { y: -0.09, v: 0.22 },
  { y: -0.13, v: 0.14 },
  { y: -0.16, v: 0.09 },
  { y: -0.19, v: 0.06 },
  { y: -0.23, v: 0.04 },
];

function twilightPhaseCap(sunElevationY: number, isMorning: boolean): number {
  const stops = isMorning ? MORNING_CAP_STOPS : EVENING_CAP_STOPS;
  if (sunElevationY >= stops[0]!.y) return stops[0]!.v;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (sunElevationY >= b.y) {
      const t = THREE.MathUtils.smoothstep(sunElevationY, b.y, a.y);
      return THREE.MathUtils.lerp(b.v, a.v, t);
    }
  }
  return stops[stops.length - 1]!.v;
}

/**
 * @param simHour — continuous 0-24
 * @param sunElevationY — normalized sun direction Y (same formula as dock env)
 */
export function computeDayPeriodState(simHour: number, sunElevationY: number): DayPeriodState {
  const h = wrapHour(simHour);
  const sunCurve = THREE.MathUtils.smoothstep(sunElevationY, -0.14, 0.38);
  const hourCurve = hourDayMix(h);
  let dayMix = Math.min(1, smoothMax2(hourCurve, sunCurve * 0.94, 14));
  /*
   * Asymmetric phased cap: evening keeps the smooth wide transitions the player loves;
   * morning compresses the phases near the horizon so deep night holds until right
   * before sunrise (when the moon is about to vanish on the other side of the sky).
   */
  const isMorning = h < 12;
  dayMix = Math.min(dayMix, twilightPhaseCap(sunElevationY, isMorning));
  const nightMix = 1 - dayMix;
  const sunsetMix = sunsetMixFromHour(h) * (0.35 + 0.65 * sunCurve);
  const duskMix = duskMixFromHour(h) * nightMix;
  const starOpacity = starOpacityFromHour(h) * Math.min(1, nightMix * 1.15 + duskMix * 0.4);
  const sunWarmth = sunWarmthFromHour(h, sunsetMixFromHour(h));

  return { dayMix, nightMix, sunsetMix, duskMix, starOpacity, sunWarmth };
}

/**
 * Peaks near the **astronomical horizon** (sun elevation crossing ~0). Used to slow real-time EMAs
 * so we “dwell” longer in messy transition regions — independent of clock hour.
 */
export function horizonBeltWeight(sunElevationY: number): number {
  const sy = sunElevationY;
  const pastDeepNight = THREE.MathUtils.smoothstep(sy, -0.32, -0.04);
  const beforeNoon = 1 - THREE.MathUtils.smoothstep(sy, 0.1, 0.52);
  return THREE.MathUtils.clamp(pastDeepNight * beforeNoon * 1.15, 0, 1);
}
