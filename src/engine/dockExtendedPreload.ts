/**
 * **Gameplay attach stage** of the unified dock preload (`dockPreload.ts`) —
 * work that previously ran AFTER the shattering cutscene in `mountApp`. All of
 * these are **save-independent**
 * — they only need the preloaded `CharacterScenePreview`'s scene + cached
 * free-roam handles, not the player's character preset or store state.
 * Moving them to the title-screen idle window (while the player picks mode +
 * character) means mountApp boot has near-zero heavy work for those layers.
 *
 * What runs here:
 *   1. `collisionWorld` — shared spatial hash (every other handle wires its
 *      footprints into this).
 *   2. `dockForestHandle` — heavy `BatchedMesh` + per-instance scatter
 *      (~150-300 ms — the single biggest pre-cutscene-only cost).
 *   3. `harvestHandle` — free-roam mineable nodes / herbs / crystals.
 *   4. `cabinHandle` + shader warm — magical cabin material program JIT.
 *   5. `craftStationHandle` — multi-instance station renderer.
 *   6. **Mob shader warm** — `createPveEnemyLPCA` for each kind, render to
 *      compile, dispose. Doesn't construct the full mobsHandle (needs store
 *      callbacks); just warms the shared LPCA materials so mountApp's real
 *      construct gets program-cache hits.
 *   7. `projectilesHandle` — magic projectile pool + 5-material shader warm.
 *      Constructed with stub callbacks; mountApp swaps the real `mobs` +
 *      `onStaticHit` after consume via `setMobs()` / `setOnStaticHit()`.
 *   8. `defensiveWardHandle` — protective ward (lazy visual until activate).
 *   9. `bouncyMushroomsHandle` — 18 mushrooms + collision + shader warm.
 *
 * Only the post-construct sync work stays in mountApp:
 *   - `cabinHandle.syncFromState(...)` (per-save cabin pieces)
 *   - `craftStationHandle.syncFromState(...)` (per-save stations)
 *   - `projectilesHandle.setMobs(realMobs)` + `.setOnStaticHit(realCb)`
 *
 * Lazy-imports the heavy world modules so this file stays a small standalone
 * chunk — only fetched when extended preload is actually scheduled.
 */
import type { DockPreviewFacade, DockPreviewPreloadInput } from './dockPreviewFacade';
import { tryDockPreviewFacade } from './dockPreviewFacade';
import { runDockGameplayAttachShared, type DockExtendedPreloadHandles } from './dockGameplayAttachShared';

export type { DockExtendedPreloadHandles };

type ExtendedPreloadState =
  | { status: 'idle' }
  | { status: 'pending'; promise: Promise<DockExtendedPreloadHandles | null> }
  | { status: 'ready'; handles: DockExtendedPreloadHandles }
  | { status: 'failed'; error: unknown };

let state: ExtendedPreloadState = { status: 'idle' };

/**
 * Per-phase progress label + 0..1 fraction.
 *
 * Emitted from {@link runExtendedPreload} for debugging / secondary UI.
 * Player-facing progress uses `subscribeIdleCraftDockPreloadProgress` in
 * `dockPreload.ts`, which forwards these phase labels on the unified 0..1 bar.
 */
export type DockExtendedPreloadProgress = {
  fraction: number;
  phase: string;
  ready: boolean;
};

const extProgressListeners = new Set<(p: DockExtendedPreloadProgress) => void>();
let latestExtProgress: DockExtendedPreloadProgress = {
  fraction: 0,
  phase: '',
  ready: false,
};

function emitExtProgress(next: DockExtendedPreloadProgress): void {
  latestExtProgress = next;
  for (const l of extProgressListeners) l(next);
}

export function subscribeDockExtendedPreloadProgress(
  listener: (p: DockExtendedPreloadProgress) => void,
): () => void {
  extProgressListeners.add(listener);
  listener(latestExtProgress);
  return () => {
    extProgressListeners.delete(listener);
  };
}

export function getDockExtendedPreloadProgress(): DockExtendedPreloadProgress {
  return latestExtProgress;
}

/**
 * Build all gameplay layers (collisionWorld + dock-forest BatchedMesh + harvest
 * scatter + cabin + craftStation + projectiles + bouncy mushrooms + defensive
 * ward + mob shader warm) into the preview's scene. Idempotent — second + later
 * calls return the cached result.
 *
 * Called from the unified `startIdleCraftDockPreload` pipeline in
 * `dockPreload.ts` as Phase 2. The caller's `onProgress` callback is forwarded
 * to each phase so the loading veil shows real activity.
 */
export function startDockExtendedPreload(
  preview: DockPreviewPreloadInput,
  onProgress?: (fraction: number, phase: string) => void,
): Promise<DockExtendedPreloadHandles | null> {
  const facade = tryDockPreviewFacade(preview);
  if (!facade) {
    /* CharacterSceneHost: no main-thread scene — worker migration Step 3. */
    return Promise.resolve(null);
  }

  if (state.status === 'pending') return state.promise;
  if (state.status === 'ready') return Promise.resolve(state.handles);
  if (state.status === 'failed') return Promise.resolve(null);

  emitExtProgress({ fraction: 0, phase: 'Building expedition layers…', ready: false });
  onProgress?.(0, 'Building expedition layers…');
  const promise = runExtendedPreload(facade, onProgress)
    .then((handles) => {
      state = { status: 'ready', handles };
      emitExtProgress({ fraction: 1, phase: 'Expedition layers ready', ready: true });
      return handles;
    })
    .catch((err: unknown) => {
      state = { status: 'failed', error: err };
      // eslint-disable-next-line no-console
      console.warn('[dockExtendedPreload] phase failure — partial handles disposed', err);
      return null;
    });
  state = { status: 'pending', promise };
  return promise;
}

export function getDockExtendedPreloadHandles(): DockExtendedPreloadHandles | null {
  return state.status === 'ready' ? state.handles : null;
}

export async function awaitDockExtendedPreload(): Promise<DockExtendedPreloadHandles | null> {
  if (state.status === 'ready') return state.handles;
  if (state.status === 'pending') {
    try {
      return await state.promise;
    } catch {
      return null;
    }
  }
  return null;
}

export function clearDockExtendedPreloadCache(): void {
  state = { status: 'idle' };
}

async function runExtendedPreload(
  preview: DockPreviewFacade,
  onProgress?: (fraction: number, phase: string) => void,
): Promise<DockExtendedPreloadHandles> {
  const handles = preview.getFreeRoamHandles();
  const freeRoam = {
    getTerrainHeight: handles.getTerrainHeight,
    mapRadius: handles.mapRadius,
    crystalSpotsXZ: handles.crystalSpotsXZ,
    crystalClusters: handles.crystalClusters,
    forestStaticObstacles: handles.forestStaticObstacles,
    resolvedCreeks: handles.resolvedCreeks,
    dockXZ: handles.dockXZ,
  };
  try {
    return await runDockGameplayAttachShared(
      { scene: preview.scene, camera: preview.camera, renderer: preview.renderer },
      freeRoam,
      (f, label) => {
        onProgress?.(f, label);
        emitExtProgress({ fraction: f, phase: label, ready: false });
      },
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[dockExtendedPreload] phase failure — partial handles disposed', err);
    throw err;
  }
}
