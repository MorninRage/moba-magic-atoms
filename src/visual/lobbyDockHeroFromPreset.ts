/**
 * Lobby / online presence: full dock LPCA hero per {@link CharacterPresetId} — same meshes
 * as the main game dock (`buildDockHeroLpca`), not the legacy blocky `buildLobbyMiniFigure`.
 */

import * as THREE from 'three';
import type { CharacterPresetId } from '../core/types';
import type { CharacterBuildKind } from '../data/characterPresets';
import { getCharacterPreset } from '../data/characterPresets';
import { createArtisanHairPhysicalBase } from './artisanFemaleLPCA';
import { buildDockHeroLpca, type DockHeroLpcaBuilt } from './dockHeroFigureLPCA';
import { installHalfLambertOnMaterial } from './halfLambertLighting';

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

/** Match legacy {@link buildLobbyMiniFigure} footprint on the stage carousel. */
const LOBBY_CAROUSEL_BASE_SCALE = 0.42;

/** Pass to {@link buildLobbyDockHeroFromPreset} as `sceneScale` so the hero matches in-world dock height (× vs carousel). */
export const LOBBY_DOCK_HERO_WORLD_SCALE = 1 / LOBBY_CAROUSEL_BASE_SCALE;

function applyPaletteToMats(
  rig: DockHeroLpcaBuilt,
  pal: ReturnType<typeof getCharacterPreset>['palette'],
  mats: {
    skin: THREE.MeshStandardMaterial;
    undertunic: THREE.MeshStandardMaterial;
    jerkin: THREE.MeshStandardMaterial;
    trim: THREE.MeshStandardMaterial;
    pants: THREE.MeshStandardMaterial;
    boots: THREE.MeshStandardMaterial;
    hair: THREE.MeshStandardMaterial;
    hatBand: THREE.MeshStandardMaterial;
    hatTop: THREE.MeshStandardMaterial;
    hatBrim: THREE.MeshStandardMaterial;
  },
): void {
  mats.skin.color.setHex(pal.skin);
  mats.undertunic.color.setHex(pal.undertunic);
  mats.jerkin.color.setHex(pal.jerkin);
  mats.trim.color.setHex(pal.trim);
  mats.pants.color.setHex(pal.pants);
  mats.boots.color.setHex(pal.boot);
  mats.hair.color.setHex(pal.hair);
  mats.hatBand.color.setHex(pal.hatBand);
  mats.hatTop.color.setHex(pal.hatTop);
  mats.hatBrim.color.setHex(pal.hatBrim);
  if (pal.lipRose !== undefined) rig.forgeWifeLipMat.color.setHex(pal.lipRose);
  if (pal.eyeIris !== undefined) rig.forgeWifeIrisMat.color.setHex(pal.eyeIris);
  rig.vanguardStaffWoodMat.color.setHex(pal.jerkin);
  rig.vanguardStaffGemMat.color.setHex(pal.trim);
}

/**
 * Visibility + scale for torso/head — mirrors {@link CharacterScenePreview.applyCharacterPreset}
 * (without dock position / orb VFX).
 */
function applyBuildKindToRig(
  rig: DockHeroLpcaBuilt,
  def: ReturnType<typeof getCharacterPreset>,
  mats: {
    jerkin: THREE.MeshStandardMaterial;
    undertunic: THREE.MeshStandardMaterial;
    artisanHairPrimary: THREE.MeshPhysicalMaterial;
    artisanHairStreak: THREE.MeshPhysicalMaterial;
  },
  faceNeutral: {
    jaw: THREE.Vector3;
    chin: THREE.Vector3;
    cheek: THREE.Vector3;
    cranium: THREE.Vector3;
    shPad: THREE.Vector3;
  },
): void {
  rig.headRoot.scale.setScalar(def.headScale);
  rig.hatGroup.visible = def.headwear === 'frontier_hat';
  rig.smithBandanaGroup.visible = false;

  mats.artisanHairPrimary.color.setHex(def.palette.hair);
  if (def.palette.hairStreak !== undefined) {
    mats.artisanHairStreak.color.setHex(def.palette.hairStreak);
  }

  const build: CharacterBuildKind = def.characterBuild ?? 'default';
  if (build === 'artisan_female') {
    mats.jerkin.side = THREE.FrontSide;
    mats.undertunic.side = THREE.FrontSide;
    rig.lpcaDefaultHair.visible = false;
    rig.lpcaArtisanHair.visible = true;
    rig.glassesGroup.visible = false;
    for (const o of rig.maleDockFaceList) o.visible = false;
    rig.forgeWifeHeadRoot.visible = true;
    rig.trunkUnderMesh.visible = false;
    rig.trunkJerkinMesh.visible = false;
    rig.forgeWifeTorsoRoot.visible = true;
    rig.forgeWifeOverlayRoot.visible = true;
    rig.vanguardWizardRobeRoot.visible = false;
    rig.vanguardWizardBeardRoot.visible = false;
    rig.vanguardWizardHatRoot.visible = false;
    rig.vanguardWizardStaffRoot.visible = false;
    rig.lpcaJaw.scale.copy(faceNeutral.jaw);
    rig.lpcaChin.scale.copy(faceNeutral.chin);
    rig.lpcaCheekL.scale.copy(faceNeutral.cheek);
    rig.lpcaCheekR.scale.copy(faceNeutral.cheek);
    rig.lpcaCranium.scale.copy(faceNeutral.cranium);
    rig.lpcaShPadL.scale.set(
      faceNeutral.shPad.x * 0.76,
      faceNeutral.shPad.y * 0.92,
      faceNeutral.shPad.z * 0.78,
    );
    rig.lpcaShPadR.scale.copy(rig.lpcaShPadL.scale);
    rig.lpcaNeck.scale.set(0.9, 0.97, 0.9);
  } else if (build === 'vanguard_wizard') {
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
    mats.jerkin.side = THREE.DoubleSide;
    mats.undertunic.side = THREE.DoubleSide;
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
  } else {
    mats.jerkin.side = THREE.FrontSide;
    mats.undertunic.side = THREE.FrontSide;
    rig.lpcaDefaultHair.visible = true;
    rig.lpcaArtisanHair.visible = false;
    rig.glassesGroup.visible = true;
    for (const o of rig.maleDockFaceList) o.visible = true;
    rig.forgeWifeHeadRoot.visible = false;
    rig.trunkUnderMesh.visible = true;
    rig.trunkJerkinMesh.visible = true;
    rig.forgeWifeTorsoRoot.visible = false;
    rig.forgeWifeOverlayRoot.visible = false;
    rig.vanguardWizardRobeRoot.visible = false;
    rig.vanguardWizardBeardRoot.visible = false;
    rig.vanguardWizardHatRoot.visible = false;
    rig.vanguardWizardStaffRoot.visible = false;
    rig.lpcaJaw.scale.copy(faceNeutral.jaw);
    rig.lpcaChin.scale.copy(faceNeutral.chin);
    rig.lpcaCheekL.scale.copy(faceNeutral.cheek);
    rig.lpcaCheekR.scale.copy(faceNeutral.cheek);
    rig.lpcaCranium.scale.copy(faceNeutral.cranium);
    rig.lpcaShPadL.scale.copy(faceNeutral.shPad);
    rig.lpcaShPadR.scale.copy(faceNeutral.shPad);
    rig.lpcaNeck.scale.set(1, 1, 1);
  }

  /* Lobby: no held tools — staff stays on for vanguard wizard. */
  const hasHeldProp = false;
  const hasMinePick = false;
  if (build === 'vanguard_wizard') {
    rig.vanguardWizardStaffRoot.visible = !hasHeldProp && !hasMinePick;
  }
}

/**
 * Full dock survivor LPCA for multiplayer lobby slots or scaled-down gather ghosts.
 *
 * @param sceneScale — Extra multiplier (e.g. `0.78` for gather ghosts vs carousel).
 */
export function buildLobbyDockHeroFromPreset(
  presetId: CharacterPresetId,
  team: 0 | 1,
  sceneScale = 1,
): THREE.Group {
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
  const prop = new THREE.Group();

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

  minePickRight.visible = false;
  heldInRightHand.visible = false;

  const def = getCharacterPreset(presetId);
  applyPaletteToMats(rig, def.palette, {
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
  });

  const teamHue = team === 0 ? 0x4fc3f7 : 0xe8a54b;
  avatarJerkinMat.emissive = new THREE.Color(teamHue);
  avatarJerkinMat.emissiveIntensity = 0.08;

  const avatar = new THREE.Group();
  avatar.scale.setScalar(def.avatarScale);
  rig.torso.scale.set(def.torsoScale.x, def.torsoScale.y, def.torsoScale.z);
  applyBuildKindToRig(
    rig,
    def,
    {
      jerkin: avatarJerkinMat,
      undertunic: avatarUndertunicMat,
      artisanHairPrimary: artisanHairPrimaryMat,
      artisanHairStreak: artisanHairStreakMat,
    },
    faceNeutral,
  );

  rig.torso.position.set(0, 0.42, 0);
  rig.torso.add(prop);
  avatar.add(rig.torso);

  const root = new THREE.Group();
  root.add(avatar);
  root.scale.setScalar(LOBBY_CAROUSEL_BASE_SCALE * sceneScale);

  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (!box.isEmpty()) {
    root.position.y -= box.min.y;
  }

  root.userData.disposeGhost = () => {
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const m = obj.material;
        if (Array.isArray(m)) m.forEach((mat) => mat.dispose());
        else m.dispose();
      }
    });
  };

  return root;
}
