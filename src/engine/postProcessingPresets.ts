/**
 * Quality rows aligned with `EmpireEditor/docs/FULL_ENGINE_PIPELINE.md` §3 (FXAA / bloom / SSAO / vignette).
 * Shadows remain separate (graphics tier + reload).
 */
import type { PostProcessingStackOptions } from 'empire-engine/render/PostProcessingStack';

export type GoEPostProcessingPreset = 'low' | 'medium' | 'high' | 'veryhigh' | 'ultra';

/** Full user patch for a named preset (replaces Esc menu overrides). */
export function getGoEPostProcessingPresetPatch(preset: GoEPostProcessingPreset): Partial<PostProcessingStackOptions> {
  switch (preset) {
    case 'low':
      return {
        fxaa: false,
        vignette: false,
        bloom: false,
        ssao: false,
      };
    case 'medium':
    case 'high':
      return {
        fxaa: true,
        fxaaStrength: 1,
        vignette: true,
        bloom: false,
        ssao: false,
      };
    case 'veryhigh':
      return {
        fxaa: true,
        fxaaStrength: 1,
        vignette: true,
        bloom: true,
        ssao: false,
        bloomStrength: 0.25,
        bloomThreshold: 0.92,
        bloomRadius: 0.25,
      };
    case 'ultra':
      return {
        fxaa: true,
        fxaaStrength: 1,
        vignette: true,
        bloom: true,
        ssao: true,
        bloomStrength: 0.25,
        bloomThreshold: 0.92,
        bloomRadius: 0.25,
        ssaoIntensity: 0.14,
        ssaoKernelRadius: 1,
      };
    default:
      return {};
  }
}
