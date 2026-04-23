/**
 * Worker dock hero — {@link buildDockHeroLpca} + default vanguard preset, spawn, solo camera.
 * Mirrors {@link CharacterScenePreview._phaseAvatar} + vanguard branch of {@link CharacterScenePreview.applyCharacterPreset}
 * + {@link CharacterScenePreview._phaseSpawnAndCamera} without DOM, equipment, or gather props.
 */

import * as THREE from 'three';
import type { IdleEmpireProjectFile } from '../engine/fetchEmpireProject';
import type { GraphicsBudget } from '../engine/graphicsTier';
import { DEFAULT_CHARACTER_PRESET_ID, getCharacterPreset } from '../data/characterPresets';
import { createArtisanHairPhysicalBase } from '../visual/artisanFemaleLPCA';
import { buildDockHeroLpca } from '../visual/dockHeroFigureLPCA';
import { installHalfLambertOnMaterial } from '../visual/halfLambertLighting';
import {
  createVanguardStaffOrbVfx,
  type VanguardStaffOrbVfxHandle,
} from '../visual/vanguardStaffOrbVfx';
import {
  DOCK_SOLO_CAM_OFFSET_X,
  DOCK_SOLO_CAM_OFFSET_Y,
  DOCK_SOLO_CAM_OFFSET_Z,
  dockSoloIdleFaceYawRad,
} from '../world/idleCraftDockCameraCompass';
import { readDockSpawn } from '../world/idleCraftWorldTypes';

const DOCK_FRAME_LOOK_DX = 0.01;
const DOCK_FRAME_LOOK_DY = 0.4;
const DOCK_FRAME_LOOK_DZ = 0.02;

function stdMat(opts: {
  color: number;
  metalness?: number;
  roughness?: number;
}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: opts.color,
    metalness: opts.metalness ?? 0.08,
    roughness: opts.roughness ?? 0.72,
  });
}

function getAvatarGroundContactWorldY(
  avatar: THREE.Group,
  footL: THREE.Mesh,
  footR: THREE.Mesh,
  robeVisible: boolean,
): number {
  avatar.updateMatrixWorld(true);
  if (robeVisible) {
    const b = new THREE.Box3();
    b.union(new THREE.Box3().setFromObject(footL));
    b.union(new THREE.Box3().setFromObject(footR));
    if (!b.isEmpty()) return b.min.y;
  }
  const box = new THREE.Box3().setFromObject(avatar);
  return box.isEmpty() ? 0 : box.min.y;
}

function relevelAvatarFeetOnTerrain(
  avatar: THREE.Group,
  footL: THREE.Mesh,
  footR: THREE.Mesh,
  robeVisible: boolean,
  getHeightAt: (x: number, z: number) => number,
): void {
  const footY = getAvatarGroundContactWorldY(avatar, footL, footR, robeVisible);
  avatar.position.y -= footY;
  avatar.position.y += getHeightAt(avatar.position.x, avatar.position.z);
}

export type WorkerDockHeroSliceResult = {
  avatar: THREE.Group;
  /** Vanguard staff root — staff tip world position via `localToWorld(0, 1.103, 0)`. */
  vanguardWizardStaffRoot: THREE.Object3D;
  staffOrbVfx: VanguardStaffOrbVfxHandle;
};

/**
 * @param dockKeyLight — optional; when set, key target is aimed at the avatar chest height after spawn.
 */
export function attachWorkerDockHeroLpcaSlice(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  project: IdleEmpireProjectFile | null,
  graphics: GraphicsBudget,
  getHeightAt: (x: number, z: number) => number,
  dockKeyLight: THREE.DirectionalLight | null,
): WorkerDockHeroSliceResult {
  const dockSpawn = readDockSpawn(project);
  const avatar = new THREE.Group();

  const faceNeutral = {
    jaw: new THREE.Vector3(),
    chin: new THREE.Vector3(),
    cheek: new THREE.Vector3(),
    cranium: new THREE.Vector3(),
    shPad: new THREE.Vector3(),
  };

  const handL = new THREE.Group();
  const handR = new THREE.Group();
  const heldInRightHand = new THREE.Group();
  const pickLeftHand = new THREE.Group();
  const minePickRight = new THREE.Group();
  const shieldMount = new THREE.Group();
  const pickOnBelt = new THREE.Group();

  const avatarSkinMat = stdMat({ color: 0xd4a373, metalness: 0, roughness: 0.8 });
  const avatarUndertunicMat = stdMat({ color: 0xc4b8a8, metalness: 0, roughness: 0.82 });
  const avatarJerkinMat = stdMat({ color: 0x2d4a66, metalness: 0.04, roughness: 0.76 });
  const avatarTrimMat = stdMat({ color: 0x8b6914, roughness: 0.65, metalness: 0.15 });
  const avatarPantsMat = stdMat({ color: 0x252030, roughness: 0.86 });
  const avatarBootMat = stdMat({ color: 0x2e241c, roughness: 0.88 });
  const avatarHairMat = stdMat({ color: 0x3d2817, roughness: 0.92 });
  const avatarHatBandMat = stdMat({ color: 0x3d2810, roughness: 0.78 });
  const avatarHatTopMat = stdMat({ color: 0x4a3220, roughness: 0.72 });
  const avatarHatBrimMat = stdMat({ color: 0x352010, roughness: 0.75 });
  const artisanHairPrimaryMat = createArtisanHairPhysicalBase(0x3d2818);
  const artisanHairStreakMat = createArtisanHairPhysicalBase(0x6b4428);

  for (const m of [
    avatarSkinMat,
    avatarUndertunicMat,
    avatarJerkinMat,
    avatarTrimMat,
    avatarPantsMat,
    avatarBootMat,
    avatarHairMat,
    avatarHatBandMat,
    avatarHatTopMat,
    avatarHatBrimMat,
    artisanHairPrimaryMat,
    artisanHairStreakMat,
  ]) {
    installHalfLambertOnMaterial(m);
  }

  const prop = new THREE.Group();
  const rig = buildDockHeroLpca({
    mats: {
      skin: avatarSkinMat,
      undertunic: avatarUndertunicMat,
      jerkin: avatarJerkinMat,
      trim: avatarTrimMat,
      pants: avatarPantsMat,
      boots: avatarBootMat,
      hair: avatarHairMat,
      hatBand: avatarHatBandMat,
      hatTop: avatarHatTopMat,
      hatBrim: avatarHatBrimMat,
    },
    handR,
    handL,
    heldInRightHand,
    minePickRight,
    shieldMount,
    pickLeftHand,
    pickOnBelt,
    faceNeutral,
    artisanHairPrimaryMat,
    artisanHairStreakMat,
  });

  const def = getCharacterPreset(DEFAULT_CHARACTER_PRESET_ID);
  const pal = def.palette;
  avatarSkinMat.color.setHex(pal.skin);
  avatarUndertunicMat.color.setHex(pal.undertunic);
  avatarJerkinMat.color.setHex(pal.jerkin);
  avatarTrimMat.color.setHex(pal.trim);
  avatarPantsMat.color.setHex(pal.pants);
  avatarBootMat.color.setHex(pal.boot);
  avatarHairMat.color.setHex(pal.hair);
  avatarHatBandMat.color.setHex(pal.hatBand);
  avatarHatTopMat.color.setHex(pal.hatTop);
  avatarHatBrimMat.color.setHex(pal.hatBrim);
  if (pal.lipRose !== undefined) rig.forgeWifeLipMat.color.setHex(pal.lipRose);
  if (pal.eyeIris !== undefined) rig.forgeWifeIrisMat.color.setHex(pal.eyeIris);
  rig.vanguardStaffWoodMat.color.setHex(pal.jerkin);
  rig.vanguardStaffGemMat.color.setHex(pal.trim);

  avatar.scale.setScalar(def.avatarScale);
  rig.torso.scale.set(def.torsoScale.x, def.torsoScale.y, def.torsoScale.z);
  rig.headRoot.scale.setScalar(def.headScale);
  rig.hatGroup.visible = def.headwear === 'frontier_hat';
  rig.smithBandanaGroup.visible = false;

  rig.lpcaDefaultHair.visible = true;
  rig.lpcaArtisanHair.visible = false;
  rig.glassesGroup.visible = true;
  for (const o of rig.maleDockFaceList) o.visible = true;
  rig.forgeWifeHeadRoot.visible = false;
  rig.trunkUnderMesh.visible = true;
  rig.trunkJerkinMesh.visible = true;
  rig.forgeWifeTorsoRoot.visible = false;
  rig.forgeWifeOverlayRoot.visible = false;
  rig.hatGroup.visible = false;
  avatarJerkinMat.side = THREE.DoubleSide;
  avatarUndertunicMat.side = THREE.DoubleSide;
  rig.vanguardWizardRobeRoot.visible = true;
  rig.vanguardWizardBeardRoot.visible = true;
  rig.vanguardWizardHatRoot.visible = true;
  rig.vanguardWizardStaffRoot.visible = true;
  rig.lpcaJaw.scale.copy(faceNeutral.jaw);
  rig.lpcaChin.scale.copy(faceNeutral.chin);
  rig.lpcaCheekL.scale.copy(faceNeutral.cheek);
  rig.lpcaCheekR.scale.copy(faceNeutral.cheek);
  rig.lpcaCranium.scale.copy(faceNeutral.cranium);
  rig.lpcaShPadL.scale.copy(faceNeutral.shPad);
  rig.lpcaShPadR.scale.copy(faceNeutral.shPad);
  rig.lpcaNeck.scale.set(1, 1, 1);

  const hasHeldProp = heldInRightHand.visible && heldInRightHand.children.length > 0;
  const hasMinePick = minePickRight.visible && minePickRight.children.length > 0;
  rig.vanguardWizardStaffRoot.visible = !hasHeldProp && !hasMinePick;

  rig.torso.position.set(0, 0.42, 0);
  rig.torso.add(prop);
  avatar.add(rig.torso);
  scene.add(avatar);

  avatar.position.x = dockSpawn.homeX;
  avatar.position.z = dockSpawn.homeZ;
  relevelAvatarFeetOnTerrain(
    avatar,
    rig.footLMesh,
    rig.footRMesh,
    rig.vanguardWizardRobeRoot.visible,
    getHeightAt,
  );
  avatar.rotation.y = dockSoloIdleFaceYawRad();

  const ax = avatar.position.x;
  const ay = avatar.position.y;
  const az = avatar.position.z;
  const lookAt = new THREE.Vector3(ax + DOCK_FRAME_LOOK_DX, ay + DOCK_FRAME_LOOK_DY, az + DOCK_FRAME_LOOK_DZ);
  const camPos = new THREE.Vector3(
    ax + DOCK_SOLO_CAM_OFFSET_X,
    ay + DOCK_SOLO_CAM_OFFSET_Y,
    az + DOCK_SOLO_CAM_OFFSET_Z,
  );
  camera.position.copy(camPos);
  camera.lookAt(lookAt);

  if (dockKeyLight) {
    dockKeyLight.target.position.set(ax, ay + 0.12, az);
  }

  const staffOrbVfx = createVanguardStaffOrbVfx({
    staffRoot: rig.vanguardWizardStaffRoot,
    tier: graphics.tier,
  });
  staffOrbVfx.syncPalette(pal.hair, pal.trim);
  staffOrbVfx.setActive(
    rig.vanguardWizardRobeRoot.visible && rig.vanguardWizardStaffRoot.visible,
  );

  return { avatar, vanguardWizardStaffRoot: rig.vanguardWizardStaffRoot, staffOrbVfx };
}
