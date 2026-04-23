/**
 * Dock camera vs world compass and sun — **same convention as** {@link idleCraftCelestialMechanics}
 * (`+X` east, `+Z` north, `+Y` up).
 *
 * **Noon sun (northern mid-latitudes):** horizontal component is ~from **south** (−Z). A camera **north**
 * of the avatar looks **south** at the character; the avatar’s default forward (+Z) then faces **away**
 * from the camera while the sun lights from behind → **backlit** faces and muddy ground read.
 *
 * **Solo framing:** place the camera **south-east** of the avatar (positive X, negative Z). The view axis
 * is ~north-west, giving **short lighting** vs a south sun (three-quarter key). `dockSoloIdleFaceYawRad`
 * matches `atan2(camX - ax, camZ - az)` (see `gatherFaceY` in characterScenePreview) so idle avatar **faces the camera**.
 */
import * as THREE from 'three';

/** Horizontal offset (m): camera **east** of avatar. */
export const DOCK_SOLO_CAM_OFFSET_X = 0.52;
/** Horizontal offset (m): camera **south** of avatar (−Z = south). */
export const DOCK_SOLO_CAM_OFFSET_Z = -2.38;
export const DOCK_SOLO_CAM_OFFSET_Y = 0.84;

/** Y rotation (rad) so local +Z faces the solo dock camera — use for idle-at-home when not Hunter. */
export function dockSoloIdleFaceYawRad(): number {
  return Math.atan2(DOCK_SOLO_CAM_OFFSET_X, DOCK_SOLO_CAM_OFFSET_Z);
}

/** Degrees east of north (0° = north, 90° = east) for **avatar → camera** on the ground plane. */
export function dockSoloCameraHeadingEastOfNorthDeg(): number {
  return THREE.MathUtils.radToDeg(Math.atan2(DOCK_SOLO_CAM_OFFSET_X, DOCK_SOLO_CAM_OFFSET_Z));
}
