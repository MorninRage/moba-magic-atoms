/**
 * Renderer + dock lighting options (GoE / TECHNICAL_SPEC alignment).
 * Persists Esc overrides in `localStorage` `idleCraft.renderer.display`.
 */
import * as THREE from 'three';

const DISPLAY_KEY = 'idleCraft.renderer.display';

/**
 * Awakened-mode quality tier. Picks the tradeoff between visual fidelity
 * and FPS at fullscreen HiDPI.
 *
 *   - **`perf`**: DPR cap 1.0 + bloom OFF + SSAO OFF. The legacy awakened
 *     budget. ~100 FPS on integrated GPUs at fullscreen 1080p. Pick this if
 *     `balanced` still drops your FPS too much.
 *   - **`balanced`** (default): DPR cap 1.0 + bloom ON + SSAO OFF. Brings the
 *     magic-orb / lantern / crystal bloom back without paying the full SSAO
 *     cost. With the Phase 8h bloom threshold raised to 0.85, only HDR-bright
 *     surfaces actually bloom — much cheaper than the legacy 0.05 threshold.
 *     ~70-80 FPS on integrated GPUs. Best look-per-FPS for most players.
 *   - **`full`**: no DPR cap + bloom ON + SSAO ON. The dream-mode look at
 *     awakened scale. ~30-40 FPS on integrated GPUs but pristine on dedicated
 *     GPUs. Equivalent to the legacy `idleCraft.awakenedFullQuality = '1'`
 *     opt-out.
 */
export type AwakenedQualityTier = 'perf' | 'balanced' | 'full';

export type UserRendererDisplayPatch = {
  toneMapping?: string;
  /** Same scale as `graphics.exposure` in project.json (multiplied by dock 0.82 bake). */
  exposure?: number;
  outputColorSpace?: 'srgb' | 'linear';
  sunIntensity?: number;
  ambientBrightness?: number;
  hemisphereFill?: number;
  moonlightStrength?: number;
  /** Awakened-mode quality tier — see {@link AwakenedQualityTier}. Default: `'perf'`. */
  awakenedQuality?: AwakenedQualityTier;
  /* === Phase 8h lighting overhaul knobs (2026-04-19) ===
   *
   * Each is a multiplier on the corresponding overhaul-phase effect.
   * `1` = ship-default strength. Player tuning lives in the Esc menu's
   * "Lighting & color" block. */
  /** Camera-relative fill light (Phase §2). 0 = off, 1 = ship default, 2 = double bright. */
  cameraFill?: number;
  /** Night-grade post pass (Phase §4). 0 = off, 1 = full grade, 1.5 = stylized extreme. */
  nightGradeStrength?: number;
  /** Cone-geometry sun shafts (Phase §6). 0 = off, 1 = ship default, 2 = pronounced. */
  sunShafts?: number;
  /** PMREM IBL env-map intensity (Phase §1). 0 = off, 1 = neutral, 1.5 = stronger reflections. */
  envReflections?: number;
};

const displayListeners: Array<() => void> = [];

export function registerRendererDisplaySync(fn: () => void): () => void {
  displayListeners.push(fn);
  return () => {
    const i = displayListeners.indexOf(fn);
    if (i >= 0) displayListeners.splice(i, 1);
  };
}

export function notifyRendererDisplayChanged(): void {
  for (const fn of displayListeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function readUserRendererDisplayPatch(): UserRendererDisplayPatch {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(DISPLAY_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as UserRendererDisplayPatch) : {};
  } catch {
    return {};
  }
}

export function patchUserRendererDisplay(updates: UserRendererDisplayPatch): void {
  const cur = readUserRendererDisplayPatch();
  const next = { ...cur, ...updates };
  try {
    localStorage.setItem(DISPLAY_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  notifyRendererDisplayChanged();
}

export function replaceUserRendererDisplayPatch(next: UserRendererDisplayPatch): void {
  try {
    localStorage.setItem(DISPLAY_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  notifyRendererDisplayChanged();
}

export function clearUserRendererDisplayPatch(): void {
  try {
    localStorage.removeItem(DISPLAY_KEY);
  } catch {
    /* ignore */
  }
  notifyRendererDisplayChanged();
}

/** Map GoE-style names (TECHNICAL_SPEC §6 / settings dropdown). */
export function toneMappingFromConfigValue(v: unknown): THREE.ToneMapping {
  if (typeof v !== 'string') return THREE.ACESFilmicToneMapping;
  const s = v.trim().toLowerCase();
  if (s === 'none' || s === 'notone' || s === 'notonemapping') return THREE.NoToneMapping;
  if (s === 'linear') return THREE.LinearToneMapping;
  if (s === 'reinhard') return THREE.ReinhardToneMapping;
  if (s === 'cineon') return THREE.CineonToneMapping;
  if (s === 'aces' || s === 'acesfilmic' || s === 'filmic') return THREE.ACESFilmicToneMapping;
  if (s === 'agx') return THREE.AgXToneMapping;
  if (s === 'neutral') return THREE.NeutralToneMapping;
  return THREE.ACESFilmicToneMapping;
}

function awakenedTierFromConfigValue(v: unknown): AwakenedQualityTier {
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'perf' || s === 'performance' || s === 'low') return 'perf';
    if (s === 'balanced' || s === 'medium' || s === 'mid') return 'balanced';
    if (s === 'full' || s === 'high' || s === 'max') return 'full';
  }
  /* Fallback when the value is unrecognized. Real defaulting happens in
   * `getEffectiveRendererDisplay` via {@link detectDeviceProfile} — see the
   * device-aware default block there. */
  return 'balanced';
}

export function getEffectiveRendererDisplay(projectCfg: Record<string, unknown>): {
  toneMapping: THREE.ToneMapping;
  exposureRaw: number;
  outputColorSpace: THREE.ColorSpace;
  sunIntensity: number;
  ambientBrightness: number;
  hemisphereFill: number;
  moonlightStrength: number;
  awakenedQuality: AwakenedQualityTier;
  /* Phase 8h overhaul knobs — see `UserRendererDisplayPatch` for definitions. */
  cameraFill: number;
  nightGradeStrength: number;
  sunShafts: number;
  envReflections: number;
} {
  const user = readUserRendererDisplayPatch();
  const exp = num(user.exposure ?? projectCfg['graphics.exposure'], 1);
  const oc =
    (user.outputColorSpace ??
      (typeof projectCfg['graphics.outputColorSpace'] === 'string'
        ? projectCfg['graphics.outputColorSpace']
        : 'srgb')) === 'linear'
      ? THREE.LinearSRGBColorSpace
      : THREE.SRGBColorSpace;
  /* Awakened quality tier — user override > project config > legacy
   * `idleCraft.awakenedFullQuality = '1'` (which mapped to the full tier)
   * > 'perf' default. */
  let awakenedQuality: AwakenedQualityTier;
  if (user.awakenedQuality !== undefined) {
    awakenedQuality = awakenedTierFromConfigValue(user.awakenedQuality);
  } else if (projectCfg['graphics.awakenedQuality'] !== undefined) {
    awakenedQuality = awakenedTierFromConfigValue(projectCfg['graphics.awakenedQuality']);
  } else {
    /* === 2026-04-22 default reverted to `'perf'` (player report) ===
     *
     * Briefly tried device-aware `'balanced'`-on-high-tier default (earlier
     * same day) to fix the "blur around trees from distance" report. Player
     * follow-up: `'balanced'` drops their FPS to 30-40 — too low — even
     * though it "looks amazing." Need `'balanced'` visual quality at `'perf'`
     * FPS budget. Solution: revert default to unconditional `'perf'` AND
     * enhance the `'perf'` tier itself with cheap bloom (the single biggest
     * visual feature `'balanced'` adds) while keeping DPR cap 1.0 + 2.07 MP
     * pixel budget + SSAO OFF. See `applyDockPostProcessing` in
     * `characterScenePreview.ts` for the cheap-bloom `'perf'` config.
     *
     * The `awakenedFullQuality = '1'` legacy localStorage flag still wins.
     * Esc-menu picker (`user.awakenedQuality`) and project config
     * (`graphics.awakenedQuality`) both win over this default. */
    let legacyFull = false;
    try {
      legacyFull = typeof localStorage !== 'undefined' &&
        localStorage.getItem('idleCraft.awakenedFullQuality') === '1';
    } catch {
      /* ignore */
    }
    awakenedQuality = legacyFull ? 'full' : 'perf';
  }
  return {
    toneMapping: toneMappingFromConfigValue(user.toneMapping ?? projectCfg['graphics.toneMapping']),
    exposureRaw: exp,
    outputColorSpace: oc,
    sunIntensity: num(user.sunIntensity ?? projectCfg['graphics.sunIntensity'], 1),
    ambientBrightness: num(user.ambientBrightness ?? projectCfg['graphics.ambientBrightness'], 1),
    hemisphereFill: num(user.hemisphereFill ?? projectCfg['graphics.hemisphereFill'], 2),
    moonlightStrength: num(user.moonlightStrength ?? projectCfg['graphics.moonlightStrength'], 1),
    awakenedQuality,
    cameraFill: num(user.cameraFill ?? projectCfg['graphics.cameraFill'], 1),
    nightGradeStrength: num(user.nightGradeStrength ?? projectCfg['graphics.nightGradeStrength'], 1),
    sunShafts: num(user.sunShafts ?? projectCfg['graphics.sunShafts'], 1),
    envReflections: num(user.envReflections ?? projectCfg['graphics.envReflections'], 1),
  };
}
