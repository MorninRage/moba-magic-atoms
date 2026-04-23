/**
 * Dock hero idle / page ambient motion — data-driven layer consumed by CharacterScenePreview.
 * Keeps pose math out of the preview class while preserving the original ordering (sway then page ambient).
 */
import * as THREE from 'three';

/** Matches {@link AppPageContext} in characterScenePreview — duplicated to avoid circular imports. */
export type DockAmbientPageContext =
  | 'gather'
  | 'craft'
  | 'inventory'
  | 'decks'
  | 'idle'
  | 'rpg'
  | 'battle'
  | 'hire'
  | 'portal';

export type DockIdlePoseRig = {
  torso: THREE.Group;
  headRoot: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
};

/** Page-specific idle stance (runs after per-frame sway adds in {@link applyDockIdleBodyLayer}). */
export function applyDockPageAmbient(
  pageContext: DockAmbientPageContext,
  t: number,
  rig: DockIdlePoseRig,
): void {
  const { torso, headRoot, armL, armR } = rig;
  switch (pageContext) {
    case 'craft':
      torso.rotation.x = 0.06 + Math.sin(t * 2.2) * 0.025;
      armR.rotation.x = -0.05 + Math.sin(t * 2.8) * 0.06;
      armR.rotation.y = 0.05;
      armR.rotation.z = -0.08;
      armL.rotation.x = 0.08;
      armL.rotation.y = -0.05;
      armL.rotation.z = 0.08;
      break;
    case 'decks':
      headRoot.rotation.y = Math.sin(t * 0.85) * 0.06;
      armR.rotation.x = -0.18 + Math.sin(t * 1.6) * 0.04;
      armR.rotation.y = 0.04;
      armR.rotation.z = -0.07;
      armL.rotation.x = -0.16;
      armL.rotation.y = -0.04;
      armL.rotation.z = 0.07;
      break;
    case 'idle':
      torso.rotation.z = Math.sin(t * 0.7) * 0.05;
      armL.rotation.x = 0.15;
      armR.rotation.x = 0.12;
      break;
    case 'battle':
      torso.rotation.y = 0;
      torso.rotation.x = 0.05;
      armR.rotation.x = -0.38;
      armR.rotation.y = 0.08;
      armR.rotation.z = -0.12;
      armL.rotation.x = 0.18;
      armL.rotation.y = -0.06;
      armL.rotation.z = 0.12;
      break;
    case 'hire':
      torso.rotation.y = Math.sin(t * 1.1) * 0.08;
      armR.rotation.x = -0.42 + Math.sin(t * 2.2) * 0.08;
      armR.rotation.y = 0.06;
      armR.rotation.z = -0.14;
      break;
    case 'inventory':
      headRoot.rotation.x = Math.sin(t * 1.2) * 0.04;
      armL.rotation.x = 0.04;
      armL.rotation.y = -0.04;
      armL.rotation.z = 0.11 + Math.sin(t * 2) * 0.03;
      armR.rotation.x = 0.04;
      armR.rotation.y = 0.04;
      armR.rotation.z = -0.11 - Math.sin(t * 2) * 0.03;
      break;
    case 'gather':
      torso.rotation.x = 0.02;
      armL.rotation.x = 0.06;
      armL.rotation.z = 0.1;
      armR.rotation.x = 0.06;
      armR.rotation.z = -0.1;
      break;
    case 'portal':
      torso.rotation.x = 0.04;
      torso.rotation.y = Math.sin(t * 0.9) * 0.06;
      armR.rotation.x = -0.14;
      armR.rotation.z = -0.1;
      armL.rotation.x = -0.12;
      armL.rotation.z = 0.1;
      break;
    default:
      break;
  }
}

/** Sway + page ambient in one call (matches legacy applyIdle pose order). */
export function applyDockIdleBodyLayer(
  t: number,
  pageContext: DockAmbientPageContext,
  rig: DockIdlePoseRig,
): void {
  rig.torso.rotation.z +=
    pageContext === 'gather' ? Math.sin(t * 1.1) * 0.018 : Math.sin(t * 1.1) * 0.035;
  rig.headRoot.rotation.x += Math.sin(t * 0.9) * 0.045;
  rig.armL.rotation.x += Math.sin(t * 0.85) * 0.05;
  rig.armR.rotation.x += Math.sin(t * 0.85 + 0.4) * 0.05;
  applyDockPageAmbient(pageContext, t, rig);
}
