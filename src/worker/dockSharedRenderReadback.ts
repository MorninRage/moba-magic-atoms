/**
 * Main-thread helpers for reading worker-published {@link SharedRenderState}.
 *
 * While a {@link CharacterSceneHost} is alive, registers the SAB so HUD code
 * (e.g. damage floaters) can rebuild a matching `PerspectiveCamera` for
 * world→screen projection without a main-thread scene graph.
 */

import * as THREE from 'three';
import type { SharedRenderState } from './sharedState';

let activeDockSharedState: SharedRenderState | null = null;

/** Called from {@link WorkerBridge} when the worker dock is ready; cleared on dispose. */
export function registerMainThreadDockSharedState(state: SharedRenderState | null): void {
  activeDockSharedState = state;
}

/** Clears registration only if `expected` is still the active buffer (safe with replace). */
export function unregisterMainThreadDockSharedState(expected: SharedRenderState): void {
  if (activeDockSharedState === expected) activeDockSharedState = null;
}

/** Live SAB while a worker dock host owns it; otherwise `null` (legacy preview path). */
export function getMainThreadActiveDockSharedState(): SharedRenderState | null {
  return activeDockSharedState;
}

let scratchDockProjCam: THREE.PerspectiveCamera | null = null;

/** Reused `PerspectiveCamera` for floater projection — avoids per-frame allocation. */
export function getScratchDockProjectionCamera(): THREE.PerspectiveCamera {
  if (!scratchDockProjCam) {
    scratchDockProjCam = new THREE.PerspectiveCamera(45, 1, 0.1, 50000);
  }
  return scratchDockProjCam;
}

/**
 * Copy worker camera pose + projection from SAB into `cam` (mutates in place).
 * Uses yaw/pitch euler `YXZ` to match {@link CharacterSceneController.syncSharedRenderState}.
 */
export function fillPerspectiveCameraFromSharedState(s: SharedRenderState, cam: THREE.PerspectiveCamera): void {
  cam.position.set(s.getCameraPosX(), s.getCameraPosY(), s.getCameraPosZ());
  cam.rotation.order = 'YXZ';
  cam.rotation.y = s.getCameraYaw();
  cam.rotation.x = s.getCameraPitch();
  cam.rotation.z = 0;
  cam.fov = s.getCameraFovDeg();
  cam.aspect = Math.max(1e-6, s.getCameraAspect());
  cam.updateProjectionMatrix();
}
