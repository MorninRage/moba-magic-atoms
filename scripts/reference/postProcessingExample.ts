/**
 * PostProcessingStack — reads settings from project.json (set in editor Post-Processing panel).
 * Your game uses the same config as the editor viewport.
 */
import { PostProcessingStack } from 'empire-engine';
import type * as THREE from 'three';
import { loadProject } from './gameData';

export function createPostProcessing(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
) {
  const project = loadProject();
  const pp = (project.config?.postProcessing as Record<string, unknown>) ?? {};
  const post = new PostProcessingStack(renderer, scene, camera, {
    bloom: pp.bloom !== false,
    ssao: pp.ssao !== false,
    vignette: pp.vignette !== false,
    fxaa: pp.fxaa !== false,
    bloomStrength: (pp.bloomStrength as number) ?? 0.25,
    bloomThreshold: (pp.bloomThreshold as number) ?? 0.92,
    bloomRadius: (pp.bloomRadius as number) ?? 0.25,
    vignetteDarkness: (pp.vignetteDarkness as number) ?? 0.45,
    vignetteOffset: (pp.vignetteOffset as number) ?? 1.2,
    ssaoIntensity: (pp.ssaoIntensity as number) ?? 0.14,
    ssaoKernelRadius: (pp.ssaoKernelRadius as number) ?? 1.0,
  });
  return post;
}

// In your render loop: postProcessing.render();
// On resize: postProcessing.setSize(width, height, renderer.getPixelRatio());
