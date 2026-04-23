/**
 * Mobile / low-power graphics path.
 *
 * **Auto:** phone/tablet UA, or narrow viewport + coarse pointer — picks the `low` budget (fewer pixels,
 * lighter terrain, no vegetation wind shader, softer shadows, smaller skydome/stars, reduced night biolum).
 *
 * **Overrides:** URL `?perf=low` | `?perf=mobile` or `?perf=high` | `?perf=desktop`.
 * **Persist:** `localStorage.setItem('idleCraft.graphics', 'low' | 'high' | 'auto')` (`auto` = use detection again).
 */

export type GraphicsTier = 'high' | 'low';

const STORAGE_KEY = 'idleCraft.graphics';

export type GraphicsBudget = {
  tier: GraphicsTier;
  /** Cap for Math.min(devicePixelRatio, this). */
  maxDevicePixelRatio: number;
  /** Extra multiplier on top of project `graphics.renderScale` (low = fewer shaded pixels). */
  renderScaleMul: number;
  rendererAntialias: boolean;
  shadowMapSizeKey: number;
  useBasicShadowMap: boolean;
  /** Multiply `terrain.planeSegments` from project (clamped). */
  terrainSegmentMul: number;
  terrainSegmentMin: number;
  terrainSegmentMax: number;
  skydomeTexW: number;
  skydomeTexH: number;
  skydomeSphereW: number;
  skydomeSphereH: number;
  moonSphereW: number;
  moonSphereH: number;
  starsBright: number;
  starsDim: number;
  starsMilky: number;
  starsSparkle: number;
  enableVegetationWind: boolean;
  /** `off` skips night biolum / fairies; `reduced` keeps a lighter version. */
  nightMagicQuality: 'off' | 'reduced' | 'full';
};

function readUrlTierOverride(): GraphicsTier | null {
  if (typeof window === 'undefined') return null;
  try {
    const p = new URLSearchParams(window.location.search).get('perf');
    if (p === 'low' || p === 'mobile') return 'low';
    if (p === 'high' || p === 'desktop') return 'high';
  } catch {
    /* ignore */
  }
  return null;
}

export type GraphicsPreference = 'auto' | GraphicsTier;

function readStoragePreference(): 'auto' | GraphicsTier | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'low' || v === 'high') return v;
    if (v === 'auto') return 'auto';
  } catch {
    /* ignore */
  }
  return null;
}

/** What the user saved (Esc menu) — `auto` uses device heuristics. */
export function getStoredGraphicsPreference(): GraphicsPreference {
  const s = readStoragePreference();
  if (s === 'high' || s === 'low') return s;
  return 'auto';
}

export function setStoredGraphicsPreference(pref: GraphicsPreference): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* ignore */
  }
}

/** Heuristic: phones / tablets and tight viewports with touch. */
export function autoDetectLowGraphicsTier(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const mobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  try {
    const narrow = window.matchMedia('(max-width: 720px)').matches;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    if (mobileUA || (narrow && coarse)) return true;
  } catch {
    if (mobileUA) return true;
  }
  if (typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 4) {
    return mobileUA;
  }
  return false;
}

export function resolveGraphicsTier(): GraphicsTier {
  const url = readUrlTierOverride();
  if (url) return url;
  const stored = readStoragePreference();
  if (stored === 'high' || stored === 'low') return stored;
  return autoDetectLowGraphicsTier() ? 'low' : 'high';
}

/* === 2026-04-21 Preload Round 4 — adaptive device profile ===
 *
 * The existing tier resolution above probes `hardwareConcurrency` + UA +
 * viewport. Three real device-capability signals it didn't probe:
 *
 *  - `navigator.deviceMemory` (RAM in GB, rounded to nearest power of 2):
 *    a 2 GB Chromebook + an 8 GB iPad Pro both report `hardwareConcurrency: 8`
 *    but have radically different texture-residency budgets. With
 *    `deviceMemory < 4` we should fall to `low` tier preemptively + skip the
 *    background shattering preload (don't keep two cutscenes resident in RAM).
 *
 *  - `navigator.connection.effectiveType` (`'4g' | '3g' | '2g' | 'slow-2g'`):
 *    a judge on hotel wifi (`'3g'` effective) sees the cutscene download
 *    dominate boot. Skip background shattering preload on `'3g'`/`'2g'` and
 *    they reach the title screen ~10s faster — the cutscene buffers when
 *    they actually press Begin (acceptable trade vs the first impression of
 *    a hung black screen).
 *
 *  - `navigator.connection.saveData`: explicit user opt-in to data thrift.
 *    Skip cutscene preload entirely; the user has told the browser "don't
 *    load big media".
 *
 * The profile is purely additive — existing URL/localStorage graphics-tier
 * overrides still take precedence via `resolveGraphicsTier()`. New signals
 * only relax the cutscene-preload assumption.
 */

export interface DeviceProfile {
  graphicsTier: GraphicsTier;
  /**
   * Whether to play the intro cutscenes at all on cold visits. False for
   * Save-Data + 2G (cutscene download is bandwidth-hostile). The cutscene-
   * skip-on-warm-visit `localStorage` flag is checked separately in
   * `cutscene.shouldPlayIntroCutscene` and takes precedence on warm visits.
   */
  shouldPreloadCutscenes: boolean;
  /**
   * Whether to fire the background `preloadVideoFile(shattering)` fetch during
   * the curse-cutscene + title-flow window. False for low-RAM devices,
   * narrowband, and Save-Data. Doesn't affect cutscene playback — just defers
   * the network fetch until the player explicitly clicks Begin (where it
   * runs while the loading veil is up).
   */
  shouldPreloadShatteringInBackground: boolean;
  /** True if the browser/user signaled `Save-Data` or reduced-data preference. */
  isDataSaver: boolean;
  /** Diagnostic — what the detector saw. Logged once at module init. */
  signals: {
    hardwareConcurrency: number | null;
    deviceMemoryGB: number | null;
    effectiveConnectionType: string | null;
    saveData: boolean;
    mobileUA: boolean;
  };
}

interface NetworkInformationLike {
  effectiveType?: string;
  saveData?: boolean;
}
interface NavigatorWithDeviceMemory {
  deviceMemory?: number;
  connection?: NetworkInformationLike;
}

let cachedDeviceProfile: DeviceProfile | null = null;

/**
 * Detect device capability signals + decide cutscene-preload policy.
 *
 * **Memoized** at module scope — the underlying signals don't change within a
 * session. The first call logs the resolved profile to console; subsequent
 * calls are silent.
 */
export function detectDeviceProfile(): DeviceProfile {
  if (cachedDeviceProfile) return cachedDeviceProfile;

  const nav: (Navigator & NavigatorWithDeviceMemory) | null =
    typeof navigator !== 'undefined' ? (navigator as Navigator & NavigatorWithDeviceMemory) : null;

  const hardwareConcurrency = nav && typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null;
  const deviceMemoryGB = nav && typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;
  const effectiveConnectionType = nav?.connection?.effectiveType ?? null;
  const saveData = Boolean(nav?.connection?.saveData);
  const mobileUA = nav
    ? /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(nav.userAgent)
    : false;

  /* `prefers-reduced-data` is the formal CSS Media Query equivalent of
   * `Save-Data`. Honor either signal — if a Safari user has reduced-data on
   * but their browser doesn't expose `connection.saveData`, the media query
   * still catches them. */
  let prefersReducedData = false;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      prefersReducedData = window.matchMedia('(prefers-reduced-data: reduce)').matches;
    } catch {
      /* Some browsers throw on unknown media queries — treat as not-set. */
    }
  }
  const isDataSaver = saveData || prefersReducedData;

  const graphicsTier = resolveGraphicsTier();

  /* Decision matrix — see DeviceProfile docstring above for rationale. */
  let shouldPreloadCutscenes = true;
  let shouldPreloadShatteringInBackground = true;

  if (isDataSaver) {
    shouldPreloadCutscenes = false;
    shouldPreloadShatteringInBackground = false;
  } else if (effectiveConnectionType === 'slow-2g' || effectiveConnectionType === '2g') {
    shouldPreloadCutscenes = false;
    shouldPreloadShatteringInBackground = false;
  } else if (effectiveConnectionType === '3g') {
    /* Curse plays from the inline `<link rel="preload">` cache; skip the
     * background shattering fetch so the curse + title-flow isn't competing
     * for bandwidth. The shattering will network-fetch when the player
     * clicks Begin (covered by the loading veil). */
    shouldPreloadShatteringInBackground = false;
  } else if (deviceMemoryGB !== null && deviceMemoryGB <= 2) {
    /* Low-RAM device — don't keep two cutscenes resident. */
    shouldPreloadShatteringInBackground = false;
  }

  cachedDeviceProfile = {
    graphicsTier,
    shouldPreloadCutscenes,
    shouldPreloadShatteringInBackground,
    isDataSaver,
    signals: {
      hardwareConcurrency,
      deviceMemoryGB,
      effectiveConnectionType,
      saveData,
      mobileUA,
    },
  };
  console.info('[idle-craft] device profile:', cachedDeviceProfile);
  return cachedDeviceProfile;
}

/**
 * Map worker init tier (`protocol` / {@link CharacterSceneHost}) to {@link GraphicsBudget}.
 * Worker uses four quality labels; budget snaps to the same low vs high presets as the main thread.
 */
export function graphicsBudgetForWorkerTier(
  tier: 'low' | 'perf' | 'balanced' | 'cinematic',
): GraphicsBudget {
  return getGraphicsBudget(tier === 'low' ? 'low' : 'high');
}

export function getGraphicsBudget(tier: GraphicsTier): GraphicsBudget {
  if (tier === 'low') {
    return {
      tier: 'low',
      maxDevicePixelRatio: 1.15,
      renderScaleMul: 0.88,
      rendererAntialias: false,
      shadowMapSizeKey: 1024,
      /* === 2026-04-22 PCFSoftShadowMap on low tier ===
       *
       * Was `useBasicShadowMap: true` which produced visibly blocky pixelated
       * shadow edges (no filtering — each shadow texel is binary on/off). The
       * cost difference vs `PCFSoftShadowMap` is a 4-tap filter per shadow
       * sample on the GPU, which is negligible on every GPU made since 2010.
       * Even with a 1024 shadow map the soft filter masks the lower texel
       * density well enough that the result reads as "smooth shadow" rather
       * than "stair-stepped pixel art." */
      useBasicShadowMap: false,
      terrainSegmentMul: 0.52,
      terrainSegmentMin: 36,
      terrainSegmentMax: 64,
      skydomeTexW: 512,
      skydomeTexH: 256,
      skydomeSphereW: 32,
      skydomeSphereH: 16,
      moonSphereW: 16,
      moonSphereH: 12,
      starsBright: 120,
      starsDim: 260,
      starsMilky: 380,
      starsSparkle: 14,
      enableVegetationWind: false,
      nightMagicQuality: 'reduced',
    };
  }
  return {
    tier: 'high',
    maxDevicePixelRatio: 2.25,
    renderScaleMul: 1,
    rendererAntialias: true,
    shadowMapSizeKey: 2048,
    useBasicShadowMap: false,
    terrainSegmentMul: 1,
    terrainSegmentMin: 8,
    terrainSegmentMax: 512,
    skydomeTexW: 1024,
    skydomeTexH: 512,
    skydomeSphereW: 64,
    skydomeSphereH: 32,
    moonSphereW: 28,
    moonSphereH: 20,
    starsBright: 380,
    starsDim: 1100,
    starsMilky: 1650,
    starsSparkle: 42,
    enableVegetationWind: true,
    nightMagicQuality: 'full',
  };
}
