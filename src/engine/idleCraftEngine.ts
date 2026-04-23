/**
 * Idle Craft — EmpireEngine entrypoint (single Three.js instance in dev/prod).
 *
 * - **LPCA** comes from `empire-engine/lpca` only (not the root barrel — that pulls WebGPU/TSL).
 * - **Renderer** uses `createRendererAsync` from `./createIdleWebGLRenderer` (WebGL only, no `three/webgpu`).
 *
 * Full `empire-engine` barrel is for tools/scripts that need `PostProcessingWebGPU`, etc.
 */
export * from 'empire-engine/lpca';

export {
  createRendererAsync,
  type CreateIdleRendererOptions as CreateRendererOptions,
  type CreateIdleRendererResult as CreateRendererResult,
} from './createIdleWebGLRenderer';

export {
  getWebGPUCompat,
  checkWebGPUAsync,
  isWebGPUAvailableSync,
} from 'empire-engine/render/WebGPUCompat';
export type { WebGPUCompatResult } from 'empire-engine/render/WebGPUCompat';

export { PostProcessingStack } from 'empire-engine/render/PostProcessingStack';
export type { PostProcessingStackOptions } from 'empire-engine/render/PostProcessingStack';
export { ConfigSystem } from 'empire-engine/config';
export {
  EngineKernel,
  createSystem,
  TypedEventBus,
  EntityRegistry,
} from 'empire-engine/core';
export type {
  IEngineSystem,
  EngineKernelConfig,
  FrameTiming,
  EngineEventMap,
  EntityHandle,
  EntityLifecycleCallback,
} from 'empire-engine/core';
export * as EmpirePhysics from 'empire-engine/physics';
export * as EmpireWorld from 'empire-engine/world';
export * as EmpireNet from 'empire-engine/network';
export * as EmpireInput from 'empire-engine/input';

export { fetchEmpireProject, type IdleEmpireProjectFile } from './fetchEmpireProject';
export { getIdleCraftEmpireConfig, hydrateEmpireConfigFromProject } from './empireConfigBridge';

import { ProceduralTextures } from 'empire-engine/lpca';
import { getWebGPUCompat } from 'empire-engine/render/WebGPUCompat';

export function bootstrapIdleCraftEngineRuntime(options?: { proceduralTextureSize?: number }): void {
  const size = options?.proceduralTextureSize ?? 256;
  ProceduralTextures.getInstance().warmUp(size);
}

export async function logIdleCraftWebGPUCompat(): Promise<void> {
  const c = await getWebGPUCompat();
  if (import.meta.env.DEV) {
    console.info('[IdleCraftEngine] WebGPU available:', c.available, c.reason ? `(${c.reason})` : '');
  }
}
