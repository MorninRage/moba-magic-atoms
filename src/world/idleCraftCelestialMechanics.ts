import * as THREE from 'three';

/** Infinite-distance moon billboard: sphere radius × this = world radius at shell. */
export const CELESTIAL_MOON_SHELL_DISTANCE = 9800;
/** Same geometry scale as moon mesh (SphereGeometry 1 × scale). */
export const CELESTIAL_MOON_APPARENT_RADIUS = 420;
/**
 * Plasma sun uses the **same** shell distance as the moon so both billboards share one
 * “infinite sky” radius — angular size matches when mesh scale matches {@link CELESTIAL_MOON_APPARENT_RADIUS}.
 */
export const CELESTIAL_SUN_SHELL_DISTANCE = CELESTIAL_MOON_SHELL_DISTANCE;

/**
 * Topocentric unit direction for a celestial body (infinite distance).
 *
 * Axes match Idle Craft world space: **+Y up**, **+X east**, **+Z north**.
 * Formulas follow the usual **altitude / azimuth** reduction (equatorial → horizontal),
 * e.g. spherical astronomy references (Meeus, *Astronomical Algorithms*).
 *
 * @param observerLatRad — observer latitude, positive north
 * @param declRad — declination δ (equatorial)
 * @param hourAngleRad — hour angle H: 0 at **local solar transit** (approx. noon); increases ~15°/h eastward
 */
export function directionFromEquatorial(
  observerLatRad: number,
  declRad: number,
  hourAngleRad: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const cosLat = Math.cos(observerLatRad);
  const sinLat = Math.sin(observerLatRad);
  const cosDec = Math.cos(declRad);
  const sinDec = Math.sin(declRad);
  const cosH = Math.cos(hourAngleRad);
  const sinH = Math.sin(hourAngleRad);

  const east = -cosDec * sinH;
  const north = -cosDec * cosH * cosLat + sinDec * sinLat;
  const up = sinDec * cosLat + cosDec * cosH * sinLat;
  return out.set(east, up, north).normalize();
}

/** Solar declination from axial tilt and day-of-year (sine seasonal model). */
export function solarDeclinationRad(totalSimDays: number, axialTiltDeg: number, yearDays: number): number {
  const tilt = THREE.MathUtils.degToRad(axialTiltDeg);
  return tilt * Math.sin((2 * Math.PI * totalSimDays) / yearDays);
}

/** Hour angle (rad): `simHour` 12 → 0 (solar noon), ~+π at midnight. */
export function hourAngleFromSimHour(simHour: number): number {
  return ((simHour - 12) / 24) * (2 * Math.PI);
}

export function sunDirectionTopocentric(
  simHour: number,
  totalSimDays: number,
  observerLatDeg: number,
  axialTiltDeg: number,
  yearDays: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(observerLatDeg);
  const dec = solarDeclinationRad(totalSimDays, axialTiltDeg, yearDays);
  const H = hourAngleFromSimHour(simHour);
  return directionFromEquatorial(phi, dec, H, out);
}

/**
 * Moon: same reduction with **mean synodic elongation** encoded as extra hour angle
 * (full moon ≈ π: opposite the sun → rises near sunset). Optional declination wobble
 * mimics orbit inclination (~5° to ecliptic).
 */
export function moonDirectionTopocentric(
  simHour: number,
  totalSimDays: number,
  lunarPhase: number,
  observerLatDeg: number,
  axialTiltDeg: number,
  yearDays: number,
  moonInclinationDeg: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(observerLatDeg);
  const decSun = solarDeclinationRad(totalSimDays, axialTiltDeg, yearDays);
  const H_sun = hourAngleFromSimHour(simHour);
  const elong = 2 * Math.PI * lunarPhase;
  const H_moon = H_sun + elong;
  const decMoon = decSun + THREE.MathUtils.degToRad(moonInclinationDeg) * Math.sin(elong);
  return directionFromEquatorial(phi, decMoon, H_moon, out);
}

/**
 * Horizon “parallax” squash: apparent disc flattening / faster motion cue near the horizon.
 * Returns multipliers for **local X** (along east–west in the sun’s tangent plane) and **Y** (thinning).
 */
export function horizonDiskParallaxScale(
  celestialDir: THREE.Vector3,
  strength: number,
  outXy: { x: number; y: number },
): void {
  const alt = Math.asin(THREE.MathUtils.clamp(celestialDir.y, -1, 1));
  const k = THREE.MathUtils.clamp(strength, 0, 2);
  /* Wider altitude blend (~18°) so squash ramps gradually at sunset; narrow band caused visible “ticks” vs lighting. */
  const raw = 1 - THREE.MathUtils.smoothstep(Math.abs(alt), 0, 0.32);
  const t = raw * raw;
  outXy.x = 1 + t * k * 0.45;
  outXy.y = 1 - t * k * 0.38;
}
