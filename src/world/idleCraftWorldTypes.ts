/**
 * Typed slices of project.json for dock-scale terrain, hydrology, and environment.
 */

import type { IdleEmpireProjectFile } from '../engine/fetchEmpireProject';

export type IdleCraftTerrainConfig = {
  /** Playable turf radius (world units). Default scales from legacy 5.5 × 8. */
  radius?: number;
  planeSegments?: number;
  /** Peak height variation from macro + noise (world units). */
  heightScale?: number;
  noiseFrequency?: number;
  /** Visible ground thickness (vertical skirt under turf). */
  skirtDepth?: number;
  /** Extra width beyond creek half-width for terrain carve (world units). */
  carveFalloff?: number;
};

export type IdleCraftCreekDef = {
  id: string;
  /** Polyline in XZ; upstream-first. If `join` is set, last point is replaced by join point on parent. */
  points: [number, number][];
  join?: string;
  /** 0–1 along parent polyline total length. */
  joinT?: number;
  halfWidth?: number;
  carveDepth?: number;
  carveWidth?: number;
};

export type IdleCraftHydrologyConfig = {
  creeks?: IdleCraftCreekDef[];
};

export type IdleCraftSkyEnvironmentConfig = {
  /** When true (default), one mesh fuses gradient + aurora + clouds. Set false to restore dual dome (sky + cloud). */
  unified?: boolean;
};

/* === 2026-04-22 IdleCraftWeatherRuntimeConfig removed (player request) ===
 * The random clear/rain runtime that consumed these fields was deleted —
 * no actual rain particles, no audio cue, just a slow scene-darkening
 * cycle every ~50-130 s. The `weatherRandomEnabled / minClearSeconds /
 * maxClearSeconds / minRainSeconds / maxRainSeconds / rampSecondsMin /
 * rampSecondsMax / rainIntensityMin / rainIntensityMax` config keys are
 * therefore dead. Project files that still set them are silently ignored
 * (the parser doesn't read them anymore). See `idleCraftDockEnvironment.ts`
 * class-level `weatherRuntime` removal comment for full rationale. */

export type IdleCraftEnvironmentConfig = {
  /** Game hours advanced per real second (0 = freeze at project `time`). */
  hourPerRealSecond?: number;
  /**
   * Real-time multiplier applied when the scene is at full night
   * (`nightMix === 1`). 1.0 = no change. 2.0 = night lasts twice as long
   * in real seconds (sim hours advance HALF as fast during night). Day
   * speed is unchanged. Smoothly interpolated by `nightMix` so dawn/dusk
   * transitions get a partial slowdown — no perceptible "click" between
   * day and night cadence. Lifts the night dwell without distorting the
   * actual hour-based curves (sun/moon position still matches clock).
   * Default 2.0 (night doubled) — set to 1 to restore equal cadence.
   */
  nightDurationMul?: number;
  /** GoE-style surface water when dry / wet (0–1). */
  surfaceWaterDry?: number;
  surfaceWaterWet?: number;
  /** Simulated days per full moon cycle (each24h advances 1 / this). */
  lunarCycleDays?: number;
  /** Starting phase offset [0,1) added to time-derived phase. */
  lunarPhase0?: number;
  /** Completed sim days at init when time is frozen (hourPerRealSecond = 0). */
  lunarDayIndex?: number;
  /** Use mesh plasma sun; canvas skydome sun is suppressed when true. */
  plasmaSunEnabled?: boolean;
  /**
   * Legacy: if `moonInclinationDeg` is omitted, this feeds moon declination wobble (degrees).
   * Prefer `moonInclinationDeg` (~5° real lunar inclination to ecliptic).
   */
  eclipticTiltDeg?: number;
  /** Observer latitude (degrees north); drives sun path and horizon geometry. */
  observerLatitudeDeg?: number;
  /** Earth obliquity for seasonal δ (default ~23.44°). */
  axialTiltDeg?: number;
  /** Days per seasonal cycle for declination (default 365.25). */
  celestialYearDays?: number;
  /** Moon declination wobble amplitude (degrees); fallback to `eclipticTiltDeg` then ~5.5. */
  moonInclinationDeg?: number;
  /** 0–2: disc squash / stretch near horizon (atmospheric parallax cue). */
  horizonParallaxStrength?: number;
  /** Sky rendering mode; see `IdleCraftSkyEnvironmentConfig`. */
  sky?: IdleCraftSkyEnvironmentConfig;
  /** Resolved by {@link readEnvironmentConfig} from `sky.unified` (default true). Not a direct JSON top-level key. */
  skyUnified?: boolean;
};

export function readTerrainConfig(raw: unknown): Required<IdleCraftTerrainConfig> {
  const t = (raw && typeof raw === 'object' ? raw : {}) as IdleCraftTerrainConfig;
  const base = 5.5 * 8;
  return {
    radius: typeof t.radius === 'number' && t.radius > 2 ? t.radius : base,
    planeSegments: typeof t.planeSegments === 'number' && t.planeSegments >= 32 ? Math.min(256, t.planeSegments) : 96,
    heightScale: typeof t.heightScale === 'number' && t.heightScale > 0 ? t.heightScale : 0.88,
    noiseFrequency: typeof t.noiseFrequency === 'number' && t.noiseFrequency > 0 ? t.noiseFrequency : 0.088,
    skirtDepth: typeof t.skirtDepth === 'number' && t.skirtDepth > 0 ? t.skirtDepth : 1.35,
    carveFalloff: typeof t.carveFalloff === 'number' && t.carveFalloff > 0 ? t.carveFalloff : 1.05,
  };
}

export function readHydrologyConfig(raw: unknown): IdleCraftHydrologyConfig {
  if (!raw || typeof raw !== 'object') return { creeks: defaultCreeks() };
  const h = raw as IdleCraftHydrologyConfig;
  const creeks = Array.isArray(h.creeks) && h.creeks.length > 0 ? h.creeks : defaultCreeks();
  return { creeks };
}

export function readEnvironmentConfig(raw: unknown): Required<IdleCraftEnvironmentConfig> {
  const e = (raw && typeof raw === 'object' ? raw : {}) as IdleCraftEnvironmentConfig;
  const skyRaw =
    e.sky && typeof e.sky === 'object' && !Array.isArray(e.sky) ? (e.sky as IdleCraftSkyEnvironmentConfig) : {};
  return {
    hourPerRealSecond:
      typeof e.hourPerRealSecond === 'number' && e.hourPerRealSecond >= 0 ? e.hourPerRealSecond : 0.072,
    nightDurationMul:
      typeof e.nightDurationMul === 'number' && e.nightDurationMul >= 1 ? Math.min(8, e.nightDurationMul) : 2.0,
    surfaceWaterDry: typeof e.surfaceWaterDry === 'number' ? e.surfaceWaterDry : 0.08,
    surfaceWaterWet: typeof e.surfaceWaterWet === 'number' ? e.surfaceWaterWet : 0.26,
    /* Random-weather config keys (weatherRandomEnabled, min/maxClearSeconds,
     * min/maxRainSeconds, rampSecondsMin/Max, rainIntensityMin/Max) were
     * removed 2026-04-22 along with the storm runtime — see the type
     * definition above for context. */
    lunarCycleDays:
      typeof e.lunarCycleDays === 'number' && e.lunarCycleDays > 0.5 ? Math.min(365, e.lunarCycleDays) : 28,
    lunarPhase0:
      typeof e.lunarPhase0 === 'number' && Number.isFinite(e.lunarPhase0)
        ? ((e.lunarPhase0 % 1) + 1) % 1
        : 0.22,
    lunarDayIndex:
      typeof e.lunarDayIndex === 'number' && e.lunarDayIndex >= 0 && Number.isFinite(e.lunarDayIndex)
        ? Math.floor(e.lunarDayIndex)
        : 0,
    plasmaSunEnabled: typeof e.plasmaSunEnabled === 'boolean' ? e.plasmaSunEnabled : true,
    eclipticTiltDeg:
      typeof e.eclipticTiltDeg === 'number' && Number.isFinite(e.eclipticTiltDeg)
        ? Math.min(45, Math.max(-45, e.eclipticTiltDeg))
        : 7,
    observerLatitudeDeg:
      typeof e.observerLatitudeDeg === 'number' && Number.isFinite(e.observerLatitudeDeg)
        ? Math.min(60, Math.max(-60, e.observerLatitudeDeg))
        : 42,
    axialTiltDeg:
      typeof e.axialTiltDeg === 'number' && Number.isFinite(e.axialTiltDeg)
        ? Math.min(45, Math.max(10, e.axialTiltDeg))
        : 23.44,
    celestialYearDays:
      typeof e.celestialYearDays === 'number' && e.celestialYearDays > 30 ? e.celestialYearDays : 365.25,
    moonInclinationDeg:
      typeof e.moonInclinationDeg === 'number' && Number.isFinite(e.moonInclinationDeg)
        ? Math.min(18, Math.max(0, e.moonInclinationDeg))
        : typeof e.eclipticTiltDeg === 'number' && Number.isFinite(e.eclipticTiltDeg)
          ? Math.min(18, Math.max(0, Math.abs(e.eclipticTiltDeg)))
          : 5.5,
    horizonParallaxStrength:
      typeof e.horizonParallaxStrength === 'number' && Number.isFinite(e.horizonParallaxStrength)
        ? Math.min(2, Math.max(0, e.horizonParallaxStrength))
        : 1,
    sky: skyRaw,
    skyUnified:
      'unified' in skyRaw && typeof skyRaw.unified === 'boolean' ? skyRaw.unified : true,
  };
}

/** Sensible default creek graph around camp (radius ~44). */
export type IdleCraftDockSpawn = {
  /** Default gather / avatar home X (world). */
  homeX: number;
  homeZ: number;
};

export function readDockSpawn(project: IdleEmpireProjectFile | null): IdleCraftDockSpawn {
  const d = project?.dock;
  if (d && typeof d === 'object') {
    const o = d as { homeX?: unknown; homeZ?: unknown };
    const homeX = typeof o.homeX === 'number' ? o.homeX : -0.85;
    const homeZ = typeof o.homeZ === 'number' ? o.homeZ : 2.65;
    return { homeX, homeZ };
  }
  /* Upland pocket: river visible toward -Z / mid map, trees in arc around camp. */
  return { homeX: -0.85, homeZ: 2.65 };
}

export function parseWorldFromProject(project: IdleEmpireProjectFile | null): {
  terrain: ReturnType<typeof readTerrainConfig>;
  hydrology: ReturnType<typeof readHydrologyConfig>;
} {
  return {
    terrain: readTerrainConfig(project?.terrain),
    hydrology: readHydrologyConfig(project?.hydrology),
  };
}

export function defaultCreeks(): IdleCraftCreekDef[] {
  return [
    {
      id: 'main',
      points: [
        [22, -18],
        [14, -10],
        [8, -4],
        [3, 1],
        [-2, 6],
        [-8, 12],
        [-16, 18],
        [-22, 22],
      ],
      halfWidth: 0.46,
      carveDepth: 0.26,
      carveWidth: 1.55,
    },
    {
      id: 'north_fork',
      join: 'main',
      joinT: 0.72,
      points: [
        [-20, 8],
        [-14, 6],
        [-10, 8],
        [-8, 11],
      ],
      halfWidth: 0.32,
      carveDepth: 0.2,
      carveWidth: 1.12,
    },
    {
      id: 'east_fork',
      join: 'main',
      joinT: 0.22,
      points: [
        [24, 6],
        [18, 2],
        [12, -2],
      ],
      halfWidth: 0.34,
      carveDepth: 0.2,
      carveWidth: 1.18,
    },
  ];
}
