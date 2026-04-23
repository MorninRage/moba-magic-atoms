/**
 * Narrow type for preload / gameplay code that requires a **main-thread**
 * `THREE.Scene`, renderer, camera, and `getFreeRoamHandles()`.
 *
 * {@link CharacterSceneHost} renders in a worker — it does not expose a main
 * scene graph, so it is not a facade implementor yet. {@link tryDockPreviewFacade}
 * returns `null` for the host until worker migration Step 3+ provides a mirror
 * API or moves extended attach into the worker.
 */
import type { CharacterSceneHost } from '../visual/characterSceneHost';
import { CharacterScenePreview } from '../visual/characterScenePreview';

export type DockPreviewFacade = CharacterScenePreview;

/** Argument to {@link startDockExtendedPreload} — union without importing `dockPreload.ts` (avoids cycles). */
export type DockPreviewPreloadInput = CharacterScenePreview | CharacterSceneHost;

export function tryDockPreviewFacade(preview: DockPreviewPreloadInput): DockPreviewFacade | null {
  return preview instanceof CharacterScenePreview ? preview : null;
}
