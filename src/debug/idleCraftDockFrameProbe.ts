/**
 * Opt-in timing for the dock / forest frame — isolate hitches without disabling features.
 *
 * Enable: `localStorage.setItem('idleCraft.perfDockFrame', '1')` then reload.
 * Disable: `localStorage.removeItem('idleCraft.perfDockFrame')`
 *
 * **Interpretation:** If `envUpdate` is tiny but `postStackRender` or `directRender` is large (or spikes to
 * seconds), the cost is **WebGL** (scene draw + shadows + PostProcessingStack: SSAO/bloom/FXAA),
 * not Canvas2D skydome. See `docs/DOCK_FRAME_PIPELINE.md`.
 *
 * Logs when {@link IdleCraftDockEnvironment.update} exceeds ~6ms or any inner slice > ~2.5ms, and when
 * the preview tail (env + render) exceeds ~7ms.
 */

function readEnabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('idleCraft.perfDockFrame') === '1';
  } catch {
    return false;
  }
}

export function isDockFrameProbeEnabled(): boolean {
  return readEnabled();
}

export type DockEnvProbe = {
  split: (label: string) => void;
  finish: () => void;
};

/** Call at start of {@link IdleCraftDockEnvironment.update}; `finish()` must run before return. */
export function createDockEnvProbe(): DockEnvProbe | null {
  if (!readEnabled()) return null;
  const t0 = performance.now();
  let last = t0;
  const ms: Record<string, number> = {};
  return {
    split(label: string) {
      const t = performance.now();
      ms[label] = t - last;
      last = t;
    },
    finish() {
      ms.totalMs = performance.now() - t0;
      const slowSlice = Object.entries(ms).some(([k, v]) => k !== 'totalMs' && v > 2.5);
      if (ms.totalMs > 6 || slowSlice) {
        console.info('[idleCraft.perfDockFrame] IdleCraftDockEnvironment.update (ms)', ms);
      }
    },
  };
}

export type DockPreviewProbe = {
  split: (label: string) => void;
  finish: () => void;
};

/** Outer loop: env.update vs post/render — enable with same `idleCraft.perfDockFrame` key. */
export function createDockPreviewProbe(): DockPreviewProbe | null {
  if (!readEnabled()) return null;
  const t0 = performance.now();
  let last = t0;
  const ms: Record<string, number> = {};
  return {
    split(label: string) {
      const t = performance.now();
      ms[label] = t - last;
      last = t;
    },
    finish() {
      ms.totalMs = performance.now() - t0;
      const gpu = ms.postStackRender ?? ms.directRender ?? 0;
      const badGpu = gpu > 12 || ms.totalMs > 20;
      if (ms.totalMs > 7 || badGpu) {
        console.info('[idleCraft.perfDockFrame] CharacterScenePreview frame (ms)', ms);
      }
    },
  };
}
