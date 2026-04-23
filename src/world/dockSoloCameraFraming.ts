/**
 * Solo forest dock third-person camera — **shared** math for
 * {@link CharacterScenePreview.applyCameraFraming} and the worker
 * {@link WorkerAwakenedLocomotion} path so awakened mode matches legacy.
 *
 * **Camera floor (anti-dig):** Orbit is anchored to `avatarY`. Scatter **rocks /
 * ore** use non-blocking footprints so the player does not step onto prop tops.
 * We only lift the eye when it would dip below {@link computeSoloCameraClipFloorY}
 * (terrain under the camera XZ, spatially averaged + margin).
 *
 * Source of truth for constants: `characterScenePreview.ts` + `idleCraftDockCameraCompass.ts`.
 */
import * as THREE from 'three';
import {
  DOCK_SOLO_CAM_OFFSET_X,
  DOCK_SOLO_CAM_OFFSET_Y,
  DOCK_SOLO_CAM_OFFSET_Z,
} from './idleCraftDockCameraCompass';

const DOCK_FRAME_LOOK_DX = 0.01;
const DOCK_FRAME_LOOK_DY = 0.4;
const DOCK_FRAME_LOOK_DZ = 0.02;
const ORBIT_PITCH_MIN = -1.12;
const ORBIT_PITCH_MAX = 1.55;
const SHOULDER_OFFSET_RIGHT = 0.4;
const SHOULDER_OFFSET_UP = 1.55;
/** Ring (m) for camera-footprint height — 9 taps dulls local heightfield noise. */
const CAMERA_FLOOR_SPATIAL_RING_M = 0.42;

/** Center + 4 cardinals + 4 diagonals on `ring` — 9 taps, all on one radius shell. */
function spatialMeanTerrainHeight9(
  getTerrainHeight: (x: number, z: number) => number,
  x: number,
  z: number,
  ring: number,
): number {
  const h = getTerrainHeight;
  const c = h(x, z);
  const q = ring * 0.7071067811865476;
  const sum =
    c +
    h(x + ring, z) +
    h(x - ring, z) +
    h(x, z + ring) +
    h(x, z - ring) +
    h(x + q, z + q) +
    h(x + q, z - q) +
    h(x - q, z + q) +
    h(x - q, z - q);
  return sum * (1 / 9);
}

/**
 * Minimum camera Y from **camera XZ only** (spatial mean + margin). Avatar height
 * is already in the orbit anchor — do not blend feet terrain here.
 */
export function computeSoloCameraClipFloorY(
  getTerrainHeight: (x: number, z: number) => number,
  camX: number,
  camZ: number,
  margin: number,
): number {
  const ring = CAMERA_FLOOR_SPATIAL_RING_M;
  return spatialMeanTerrainHeight9(getTerrainHeight, camX, camZ, ring) + margin;
}

export type SoloDockCameraFramingParams = {
  camera: THREE.PerspectiveCamera;
  avatarX: number;
  avatarY: number;
  avatarZ: number;
  dockCamPanX?: number;
  dockCamPanY?: number;
  dockCamPanZ?: number;
  dockCamYaw: number;
  dockCamPitch: number;
  userCameraZoom: number;
  cameraLockActive: boolean;
  baseFovDeg: number;
  /** Default 1 — legacy `projectFovScale` from Esc / project. */
  projectFovScale?: number;
  getTerrainHeight?: (x: number, z: number) => number;
};

/**
 * Same pose as {@link CharacterScenePreview.getCameraForwardXZ}: XZ projection of
 * (framingLookAt − cameraPosition), unit length.
 */
export function getSoloDockCameraForwardXZ(p: {
  cameraPosX: number;
  cameraPosZ: number;
  avatarX: number;
  avatarY: number;
  avatarZ: number;
  dockCamPanX?: number;
  dockCamPanY?: number;
  dockCamPanZ?: number;
}): { x: number; z: number } {
  const px = p.dockCamPanX ?? 0;
  const pz = p.dockCamPanZ ?? 0;
  const lx0 = p.avatarX + DOCK_FRAME_LOOK_DX + px;
  const lz0 = p.avatarZ + DOCK_FRAME_LOOK_DZ + pz;
  const dx = lx0 - p.cameraPosX;
  const dz = lz0 - p.cameraPosZ;
  const len = Math.hypot(dx, dz);
  if (len < 1e-5) return { x: 0, z: 1 };
  return { x: dx / len, z: dz / len };
}

/**
 * Mirrors {@link CharacterScenePreview.applyCameraFraming} for solo forest dock
 * (no deck PvP / Hunter layout branches).
 */
export function applySoloDockCameraFraming(params: SoloDockCameraFramingParams): void {
  const {
    camera,
    avatarX,
    avatarY,
    avatarZ,
    dockCamPanX = 0,
    dockCamPanY = 0,
    dockCamPanZ = 0,
    dockCamYaw,
    dockCamPitch,
    userCameraZoom,
    cameraLockActive,
    baseFovDeg,
    projectFovScale = 1,
    getTerrainHeight,
  } = params;

  const lx0 = avatarX + DOCK_FRAME_LOOK_DX + dockCamPanX;
  const ly0 = avatarY + DOCK_FRAME_LOOK_DY + dockCamPanY;
  const lz0 = avatarZ + DOCK_FRAME_LOOK_DZ + dockCamPanZ;
  const fx0 = avatarX + DOCK_SOLO_CAM_OFFSET_X + dockCamPanX;
  const fy0 = avatarY + DOCK_SOLO_CAM_OFFSET_Y + dockCamPanY;
  const fz0 = avatarZ + DOCK_SOLO_CAM_OFFSET_Z + dockCamPanZ;
  let dx = fx0 - lx0;
  let dy = fy0 - ly0;
  let dz = fz0 - lz0;
  const dist0 = Math.hypot(dx, dy, dz) || 1;
  const yaw0 = Math.atan2(dx, dz);
  const pitch0 = Math.asin(THREE.MathUtils.clamp(dy / dist0, -1, 1));
  const yaw = yaw0 + dockCamYaw;
  const pitch = THREE.MathUtils.clamp(pitch0 + dockCamPitch, ORBIT_PITCH_MIN, ORBIT_PITCH_MAX);
  const dist = dist0 * userCameraZoom;
  const cosP = Math.cos(pitch);
  const ax = Math.sin(yaw) * cosP * dist;
  const ay = Math.sin(pitch) * dist;
  const az = Math.cos(yaw) * cosP * dist;

  let shoulderDx = 0;
  let shoulderDy = 0;
  let shoulderDz = 0;
  if (cameraLockActive) {
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    shoulderDx = rightX * SHOULDER_OFFSET_RIGHT;
    shoulderDz = rightZ * SHOULDER_OFFSET_RIGHT;
    shoulderDy = SHOULDER_OFFSET_UP;
  }

  camera.position.set(lx0 + ax + shoulderDx, ly0 + ay + shoulderDy, lz0 + az + shoulderDz);

  let lookAtBumpY = 0;
  if (getTerrainHeight) {
    const margin = 0.42;
    const floorY = computeSoloCameraClipFloorY(
      getTerrainHeight,
      camera.position.x,
      camera.position.z,
      margin,
    );
    if (camera.position.y < floorY) {
      lookAtBumpY = floorY - camera.position.y;
      camera.position.y = floorY;
    }
  }

  camera.fov = baseFovDeg * projectFovScale * (0.92 + 0.08 * userCameraZoom);
  camera.lookAt(lx0 + shoulderDx, ly0 + shoulderDy + lookAtBumpY, lz0 + shoulderDz);
  camera.updateProjectionMatrix();
}
