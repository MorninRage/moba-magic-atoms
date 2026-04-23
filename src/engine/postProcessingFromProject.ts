import { PostProcessingStack } from 'empire-engine/render/PostProcessingStack';
import type { PostProcessingStackOptions } from 'empire-engine/render/PostProcessingStack';
import type * as THREE from 'three';
import type { GraphicsTier } from './graphicsTier';
import { readUserPostProcessingPatch } from './userPostProcessingSettings';

/** Low tier: bloom/SSAO stay off unless user opts in (`?pp=heavy` or localStorage). */
export function allowHeavyPostProcessingOnLowTier(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get('pp') === 'heavy') return true;
    if (localStorage.getItem('idleCraft.postProcessing.heavy') === '1') return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Character dock + multiplayer lobby WebGL views: full SSAO/bloom is usually wasted GPU on a small
 * canvas. Stripped by default; opt in with `?previewPP=full` or
 * `localStorage.setItem('idleCraft.previewPostProcessing.full','1')`.
 */
export function allowFullPreviewPostProcessing(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get('previewPP') === 'full') return true;
    if (localStorage.getItem('idleCraft.previewPostProcessing.full') === '1') return true;
  } catch {
    /* ignore */
  }
  return false;
}

function stripHeavyPassesForEmbeddedPreview(opts: PostProcessingStackOptions): PostProcessingStackOptions {
  return { ...opts, bloom: false, ssao: false };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function postProcessingOptionsFromProjectConfig(
  cfg: Record<string, unknown> | undefined,
): PostProcessingStackOptions {
  const pp = (cfg?.postProcessing as Record<string, unknown> | undefined) ?? {};
  return {
    bloom: pp.bloom === true,
    ssao: pp.ssao === true,
    vignette: pp.vignette === true,
    fxaa: pp.fxaa === true,
    bloomStrength: num(pp.bloomStrength, 0.25),
    bloomThreshold: num(pp.bloomThreshold, 0.92),
    bloomRadius: num(pp.bloomRadius, 0.25),
    vignetteDarkness: num(pp.vignetteDarkness, 0.45),
    vignetteOffset: num(pp.vignetteOffset, 1.2),
    ssaoIntensity: num(pp.ssaoIntensity, 0.14),
    ssaoKernelRadius: num(pp.ssaoKernelRadius, 1),
    ssaoMinDistance: num(pp.ssaoMinDistance, 0.02),
    ssaoMaxDistance: num(pp.ssaoMaxDistance, 0.015),
    ssaoKernelSize: Math.max(4, Math.min(64, Math.round(num(pp.ssaoKernelSize, 12)))),
    ssaoResolutionScale: Math.max(0.1, Math.min(1, num(pp.ssaoResolutionScale, 0.35))),
    fxaaStrength: Math.max(0, Math.min(1, num(pp.fxaaStrength, 1))),
  };
}

export function isPostProcessingEnabled(opts: PostProcessingStackOptions): boolean {
  return !!(opts.bloom || opts.ssao || opts.vignette || opts.fxaa);
}

/**
 * When `project.json` leaves all toggles off: on **high** tier, **vignette only** (no FXAA / bloom / SSAO by default).
 * Low tier keeps composer off unless the project or user enables a pass.
 */
export function resolvePostProcessingOptionsForTier(
  cfg: Record<string, unknown> | undefined,
  tier: GraphicsTier,
): PostProcessingStackOptions {
  const base = postProcessingOptionsFromProjectConfig(cfg);
  let opts: PostProcessingStackOptions = base;
  if (tier === 'low' && !allowHeavyPostProcessingOnLowTier()) {
    opts = { ...base, bloom: false, ssao: false };
  }
  if (tier === 'high' && !isPostProcessingEnabled(opts)) {
    return {
      ...opts,
      fxaa: false,
      vignette: true,
      bloom: false,
      ssao: false,
    };
  }
  return opts;
}

function clampHeavyPassesForTier(opts: PostProcessingStackOptions, tier: GraphicsTier): PostProcessingStackOptions {
  if (tier === 'low' && !allowHeavyPostProcessingOnLowTier()) {
    return { ...opts, bloom: false, ssao: false };
  }
  return opts;
}

/** Tier + project defaults merged with Esc menu / localStorage overrides. */
export function getEffectivePostProcessingOptions(
  cfg: Record<string, unknown> | undefined,
  tier: GraphicsTier,
): PostProcessingStackOptions {
  const base = resolvePostProcessingOptionsForTier(cfg, tier);
  const patch = readUserPostProcessingPatch();
  const merged = { ...base, ...patch } as PostProcessingStackOptions;
  return clampHeavyPassesForTier(merged, tier);
}

/**
 * Same as {@link getEffectivePostProcessingOptions}, but for embedded previews (dock + lobby):
 * on **low** tier only, drops bloom + SSAO (vignette + FXAA stay when enabled) so small canvases stay fast.
 * **High** tier uses the same passes as the main game so dock matches project.json (no surprise “optimized” look).
 * Opt in to the old strip on high tier with {@link allowFullPreviewPostProcessing} URL/localStorage, or out on low with the same key.
 */
export function getEffectivePostProcessingOptionsForPreview(
  cfg: Record<string, unknown> | undefined,
  tier: GraphicsTier,
): PostProcessingStackOptions {
  const base = getEffectivePostProcessingOptions(cfg, tier);
  if (allowFullPreviewPostProcessing()) return base;
  if (tier === 'high') return base;
  return stripHeavyPassesForEmbeddedPreview(base);
}

/** Push all toggles + strengths onto an existing stack (same options shape as constructor). */
export function applyPostProcessingOptionsToStack(
  stack: PostProcessingStack,
  opts: PostProcessingStackOptions,
  drawableSize?: { width: number; height: number },
): void {
  const n = postProcessingOptionsFromProjectConfig(undefined);
  const f = { ...n, ...opts };
  stack.setPassEnabled('bloom', !!f.bloom);
  stack.setPassEnabled('ssao', !!f.ssao);
  stack.setPassEnabled('vignette', !!f.vignette);
  stack.setPassEnabled('fxaa', !!f.fxaa);
  stack.setBloomStrength(f.bloomStrength ?? 0.25);
  stack.setBloomThreshold(f.bloomThreshold ?? 0.92);
  stack.setBloomRadius(f.bloomRadius ?? 0.25);
  stack.setVignetteDarkness(f.vignetteDarkness ?? 0.45);
  stack.setVignetteOffset(f.vignetteOffset ?? 1.2);
  stack.setSSAOIntensity(f.ssaoIntensity ?? 0.14);
  stack.setSSAOKernelRadius(f.ssaoKernelRadius ?? 1);
  stack.setSSAOMinDistance(f.ssaoMinDistance ?? 0.02);
  stack.setSSAOMaxDistance(f.ssaoMaxDistance ?? 0.015);
  stack.setFXAAStrength(f.fxaaStrength ?? 1);
  if (drawableSize) {
    stack.setSSAOResolutionScale(
      f.ssaoResolutionScale ?? 0.35,
      Math.max(1, drawableSize.width),
      Math.max(1, drawableSize.height),
    );
  }
}

/** Only allocates the composer when at least one pass is enabled after tier + user resolution. */
export function createPostStackIfEnabled(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  cfg: Record<string, unknown> | undefined,
  graphicsTier: GraphicsTier,
): PostProcessingStack | null {
  const opts = getEffectivePostProcessingOptions(cfg, graphicsTier);
  if (!isPostProcessingEnabled(opts)) return null;
  return new PostProcessingStack(renderer, scene, camera, opts);
}

/** Like {@link createPostStackIfEnabled}, but uses {@link getEffectivePostProcessingOptionsForPreview}. */
export function createPostStackIfEnabledForPreview(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  cfg: Record<string, unknown> | undefined,
  graphicsTier: GraphicsTier,
): PostProcessingStack | null {
  const opts = getEffectivePostProcessingOptionsForPreview(cfg, graphicsTier);
  if (!isPostProcessingEnabled(opts)) return null;
  return new PostProcessingStack(renderer, scene, camera, opts);
}
