import fs from 'fs';
const body = fs.readFileSync('src/visual/_dock_rig.txt', 'utf8');
const header = `/**
 * LPCA dock hero figure — procedural third-person body (factory extracted from CharacterScenePreview).
 */
import * as THREE from 'three';
import { createArtisanFemaleHairLPCA } from './artisanFemaleLPCA';
import { createForgeWifeFigureOverlay, createForgeWifeTorsoLPCA } from './forgeWifeBodyLPCA';
import { createForgeWifeHeadLPCA, createForgeWifeLipMaterial } from './forgeWifeHeadLPCA';
import {
  createVanguardWizardHatLPCA,
  createVanguardWizardRobeLPCA,
  createVanguardWizardStaffLPCA,
} from './vanguardWizardLPCA';

function stdMat(opts: {
  color: number;
  metalness?: number;
  roughness?: number;
  emissive?: number;
  emissiveIntensity?: number;
}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: opts.color,
    metalness: opts.metalness ?? 0.08,
    roughness: opts.roughness ?? 0.72,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
  });
}

/** Waist → chest → ribcage → neck base; revolve for organic torso. */
export function createTorsoLathe(
  material: THREE.MeshStandardMaterial,
  opts: { innerScale?: number; depthScale?: number },
): THREE.Mesh {
  const inner = opts.innerScale ?? 1;
  const zScale = opts.depthScale ?? 0.69;
  const r = [0.142, 0.152, 0.168, 0.176, 0.158, 0.086].map((x) => x * inner);
  const pts = [
    new THREE.Vector2(r[0], 0),
    new THREE.Vector2(r[1], 0.06),
    new THREE.Vector2(r[2], 0.12),
    new THREE.Vector2(r[3], 0.17),
    new THREE.Vector2(r[4], 0.22),
    new THREE.Vector2(r[5], 0.25),
  ];
  const geo = new THREE.LatheGeometry(pts, 36);
  const mesh = new THREE.Mesh(geo, material);
  mesh.scale.set(1, 1, zScale);
  mesh.position.set(0, 0.055, 0);
  mesh.castShadow = true;
  return mesh;
}

export function buildPalmFingers(skin: THREE.MeshStandardMaterial, side: 'left' | 'right'): THREE.Group {
  const m = side === 'left' ? -1 : 1;
  const g = new THREE.Group();

  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.074, 0.056, 0.022), skin);
  palm.position.set(0, -0.02, 0.007);
  palm.castShadow = true;
  g.add(palm);

  const fingers = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.038, 0.017), skin);
  fingers.position.set(0, -0.054, 0.01);
  fingers.castShadow = true;
  g.add(fingers);

  const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.034, 0.02), skin);
  thumb.position.set(0.036 * m, -0.03, 0.012);
  thumb.rotation.set(0.28, 0.42 * m, 0.18 * m);
  thumb.castShadow = true;
  g.add(thumb);

  g.rotation.order = 'YXZ';
  g.rotation.y = side === 'left' ? Math.PI / 2 : -Math.PI / 2;
  g.rotation.x = 0.09;
  g.rotation.z = side === 'left' ? 0.03 : -0.03;
  return g;
}

export type DockHeroFigureMaterials = {
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
};

export type DockHeroLpcaBuilt = {
  torso: THREE.Group;
  headRoot: THREE.Group;
  hatGroup: THREE.Group;
  smithBandanaGroup: THREE.Group;
  glassesGroup: THREE.Group;
  maleDockFaceList: THREE.Object3D[];
  trunkUnderMesh: THREE.Mesh;
  trunkJerkinMesh: THREE.Mesh;
  forgeWifeLipMat: THREE.MeshPhysicalMaterial;
  forgeWifeIrisMat: THREE.MeshStandardMaterial;
  forgeWifeTorsoRoot: THREE.Group;
  forgeWifeOverlayRoot: THREE.Group;
  forgeWifeHeadRoot: THREE.Group;
  lpcaShPadL: THREE.Mesh;
  lpcaShPadR: THREE.Mesh;
  lpcaNeck: THREE.Mesh;
  lpcaCranium: THREE.Mesh;
  lpcaJaw: THREE.Mesh;
  lpcaChin: THREE.Mesh;
  lpcaCheekL: THREE.Mesh;
  lpcaCheekR: THREE.Mesh;
  lpcaDefaultHair: THREE.Mesh;
  lpcaArtisanHair: THREE.Group;
  vanguardStaffWoodMat: THREE.MeshStandardMaterial;
  vanguardStaffGemMat: THREE.MeshPhysicalMaterial;
  vanguardWizardRobeRoot: THREE.Group;
  vanguardWizardHatRoot: THREE.Group;
  vanguardWizardStaffRoot: THREE.Group;
  legLMesh: THREE.Mesh;
  legRMesh: THREE.Mesh;
  footLMesh: THREE.Mesh;
  footRMesh: THREE.Mesh;
  armL: THREE.Group;
  armR: THREE.Group;
};

export type DockHeroLpcaBuildOpts = {
  mats: DockHeroFigureMaterials;
  handR: THREE.Group;
  handL: THREE.Group;
  heldInRightHand: THREE.Group;
  minePickRight: THREE.Group;
  shieldMount: THREE.Group;
  pickLeftHand: THREE.Group;
  pickOnBelt: THREE.Group;
  faceNeutral: {
    jaw: THREE.Vector3;
    chin: THREE.Vector3;
    cheek: THREE.Vector3;
    cranium: THREE.Vector3;
    shPad: THREE.Vector3;
  };
  graphicsBudget: GraphicsBudget;
  artisanHairPrimaryMat: THREE.MeshPhysicalMaterial;
  artisanHairStreakMat: THREE.MeshPhysicalMaterial;
};

export function buildDockHeroLpca(opts: DockHeroLpcaBuildOpts): DockHeroLpcaBuilt {
  const {
    mats,
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
  } = opts;

  const rig = {} as DockHeroLpcaBuilt;
  rig.torso = new THREE.Group();
  rig.headRoot = new THREE.Group();
  rig.hatGroup = new THREE.Group();
  rig.smithBandanaGroup = new THREE.Group();
  rig.glassesGroup = new THREE.Group();
  rig.maleDockFaceList = [];

`;

const footer = `
  return rig;
}

/** Plan name alias — same as {@link buildDockHeroLpca}. */
export const createDockHeroFigureLPCA = buildDockHeroLpca;
`;

fs.writeFileSync('src/visual/dockHeroFigureLPCA.ts', header + body + footer);
