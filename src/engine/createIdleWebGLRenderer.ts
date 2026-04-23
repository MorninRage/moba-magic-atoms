/**
 * WebGL-only renderer bootstrap for Idle Craft.
 *
 * EmpireEngine's `RendererFactory` references `three/webgpu`. Even with `preferWebGPU: false`,
 * bundlers still pull that graph and you get `THREE.WARNING: Multiple instances of Three.js`
 * together with the main `three` build.
 */
import * as THREE from 'three';
import type { WebGLRenderer } from 'three';

export interface CreateIdleRendererOptions {
  /**
   * Main-thread dock uses `HTMLCanvasElement`. Worker / OffscreenCanvas path
   * passes `OffscreenCanvas` — `THREE.WebGLRenderer` accepts both.
   */
  canvas: HTMLCanvasElement | OffscreenCanvas;
  antialias?: boolean;
  /** Accepted for API parity with EmpireEngine; ignored — always WebGL here. */
  preferWebGPU?: boolean;
  forceWebGL?: boolean;
}

export interface CreateIdleRendererResult {
  renderer: WebGLRenderer;
  isWebGPU: false;
  THREE: typeof THREE;
}

function glContextOk(r: THREE.WebGLRenderer): boolean {
  const gl = r.getContext() as WebGLRenderingContext | null;
  return gl != null && typeof gl.isContextLost === 'function' && !gl.isContextLost();
}

/**
 * Try progressively cheaper WebGL attribute sets. Chrome may block new contexts after repeated GPU loss
 * until the tab (or browser) is restarted — we still surface a clear error and avoid antialias OOM paths.
 */
export async function createRendererAsync(
  options: CreateIdleRendererOptions,
): Promise<CreateIdleRendererResult> {
  const canvas = options.canvas;
  const wantAa = options.antialias ?? true;

  const attempts: THREE.WebGLRendererParameters[] = [
    {
      canvas,
      antialias: wantAa,
      /* Opaque GL — alpha:true can leave bright hairlines at buffer edges in some Chromium builds (e.g. Brave fullscreen). */
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'default',
      failIfMajorPerformanceCaveat: false,
      preserveDrawingBuffer: false,
    },
    {
      canvas,
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'default',
      failIfMajorPerformanceCaveat: false,
      preserveDrawingBuffer: false,
    },
  ];

  let lastErr: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const params = attempts[i]!;
    try {
      const renderer = new THREE.WebGLRenderer(params);
      if (!glContextOk(renderer)) {
        renderer.dispose();
        throw new Error('WebGL context is null or already lost');
      }
      if (i > 0) console.warn('[IdleCraft] WebGLRenderer using fallback parameters (antialias off).');
      return { renderer, isWebGPU: false, THREE };
    } catch (e) {
      lastErr = e;
    }
  }

  const hint =
    'WebGL could not start. If you see “context loss and was blocked”, fully close this tab (or restart the browser), update GPU drivers, and disable extra WebGL debug extensions.';
  console.error('[IdleCraft]', hint, lastErr);
  throw new Error(`${hint} (${String(lastErr)})`);
}
