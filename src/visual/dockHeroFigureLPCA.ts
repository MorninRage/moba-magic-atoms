/**
 * LPCA dock hero figure — procedural third-person body (factory extracted from CharacterScenePreview).
 */
import * as THREE from 'three';
import { createArtisanFemaleHairLPCA } from './artisanFemaleLPCA';
import { createForgeWifeFigureOverlay, createForgeWifeTorsoLPCA } from './forgeWifeBodyLPCA';
import { createForgeWifeHeadLPCA, createForgeWifeLipMaterial } from './forgeWifeHeadLPCA';
import {
  createVanguardWizardBeardLPCA,
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
  vanguardWizardBeardRoot: THREE.Group;
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

    /* Torso: lathe profile (tapered waist → chest → neck) + jerkin shell — reads less “tube” */
    rig.trunkUnderMesh = createTorsoLathe(mats.undertunic, { innerScale: 0.94, depthScale: 0.64 });
    rig.torso.add(rig.trunkUnderMesh);

    rig.trunkJerkinMesh = createTorsoLathe(mats.jerkin, { innerScale: 1, depthScale: 0.68 });
    rig.trunkJerkinMesh.position.z = 0.006;
    rig.torso.add(rig.trunkJerkinMesh);

    rig.forgeWifeLipMat = createForgeWifeLipMaterial();
    rig.forgeWifeIrisMat = stdMat({ color: 0x3d5230, roughness: 0.5 });
    rig.forgeWifeTorsoRoot = createForgeWifeTorsoLPCA({
      undertunic: mats.undertunic,
      jerkin: mats.jerkin,
    });
    rig.forgeWifeTorsoRoot.visible = false;
    rig.torso.add(rig.forgeWifeTorsoRoot);
    rig.forgeWifeOverlayRoot = createForgeWifeFigureOverlay({
      undertunic: mats.undertunic,
      jerkin: mats.jerkin,
    });
    rig.forgeWifeOverlayRoot.visible = false;
    rig.torso.add(rig.forgeWifeOverlayRoot);

    /* Deltoid caps — tucked into lathe silhouette, bridge to arms */
    rig.lpcaShPadL = new THREE.Mesh(new THREE.SphereGeometry(0.052, 14, 12), mats.jerkin);
    rig.lpcaShPadL.scale.set(0.92, 0.52, 0.78);
    rig.lpcaShPadL.position.set(-0.168, 0.262, 0.006);
    rig.lpcaShPadL.castShadow = true;
    rig.torso.add(rig.lpcaShPadL);
    rig.lpcaShPadR = new THREE.Mesh(new THREE.SphereGeometry(0.052, 14, 12), mats.jerkin);
    rig.lpcaShPadR.scale.set(0.92, 0.52, 0.78);
    rig.lpcaShPadR.position.set(0.168, 0.262, 0.006);
    rig.lpcaShPadR.castShadow = true;
    rig.torso.add(rig.lpcaShPadR);

    /* Lower + tighter — sits on upper chest, clears chin / jaw */
    const collar = new THREE.Mesh(
      new THREE.TorusGeometry(0.078, 0.01, 8, 28),
      stdMat({ color: 0x3a4a5c, metalness: 0.02, roughness: 0.74 }),
    );
    collar.rotation.x = Math.PI / 2;
    collar.position.set(0, 0.262, 0.014);
    collar.scale.set(1, 1, 0.85);
    collar.castShadow = true;
    rig.torso.add(collar);

    const panelMat = stdMat({ color: 0x3a5a78, roughness: 0.68 });
    const panel = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.05, 0.1, 14), panelMat);
    panel.scale.set(1, 1, 0.36);
    panel.position.set(0, 0.19, 0.112);
    panel.rotation.x = 0.09;
    panel.castShadow = true;
    rig.torso.add(panel);

    const beltMat = stdMat({ color: 0x4a3020, roughness: 0.75 });
    /* Torso lathe sits at y≈0.055–0.305; belt was at 0.034 (below mesh) → huge shirt gap */
    const belt = new THREE.Mesh(new THREE.TorusGeometry(0.108, 0.013, 10, 36), beltMat);
    belt.rotation.x = Math.PI / 2;
    belt.position.y = 0.236;
    belt.scale.set(1, 1, 0.72);
    belt.castShadow = true;
    rig.torso.add(belt);

    const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.036, 0.026), mats.trim);
    buckle.position.set(0.11, 0.236, 0.062);
    rig.torso.add(buckle);

    rig.lpcaNeck = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.074, 0.08, 16), mats.skin);
    rig.lpcaNeck.position.set(0, 0.338, 0.012);
    rig.lpcaNeck.castShadow = true;
    rig.torso.add(rig.lpcaNeck);

    rig.headRoot.position.set(0, 0.398, 0.016);
    rig.torso.add(rig.headRoot);

    rig.lpcaCranium = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 16), mats.skin);
    rig.lpcaCranium.scale.set(0.95, 1.08, 0.88);
    rig.lpcaCranium.position.y = 0.02;
    rig.lpcaCranium.castShadow = true;
    rig.headRoot.add(rig.lpcaCranium);

    rig.lpcaJaw = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.055, 0.085), mats.skin);
    rig.lpcaJaw.position.set(0, -0.055, 0.025);
    rig.lpcaJaw.scale.set(1.08, 1, 1.12);
    rig.lpcaJaw.castShadow = true;
    rig.headRoot.add(rig.lpcaJaw);

    rig.lpcaChin = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.028, 0.07), mats.skin);
    rig.lpcaChin.position.set(0, -0.09, 0.045);
    rig.lpcaChin.castShadow = true;
    rig.headRoot.add(rig.lpcaChin);

    rig.lpcaCheekL = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.04, 0.04), mats.skin);
    rig.lpcaCheekL.position.set(-0.055, -0.02, 0.06);
    rig.headRoot.add(rig.lpcaCheekL);
    rig.lpcaCheekR = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.04, 0.04), mats.skin);
    rig.lpcaCheekR.position.set(0.055, -0.02, 0.06);
    rig.headRoot.add(rig.lpcaCheekR);

    faceNeutral.jaw.copy(rig.lpcaJaw.scale);
    faceNeutral.chin.copy(rig.lpcaChin.scale);
    faceNeutral.cheek.set(1, 1, 1);
    faceNeutral.cranium.copy(rig.lpcaCranium.scale);
    faceNeutral.shPad.copy(rig.lpcaShPadL.scale);

    rig.lpcaDefaultHair = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 12), mats.hair);
    rig.lpcaDefaultHair.position.set(0, 0.055, -0.04);
    rig.lpcaDefaultHair.scale.set(1.08, 0.72, 1.05);
    rig.headRoot.add(rig.lpcaDefaultHair);

    const hatBand = new THREE.Mesh(new THREE.CylinderGeometry(0.108, 0.112, 0.045, 16), mats.hatBand);
    hatBand.position.y = 0.1;
    hatBand.castShadow = true;
    rig.hatGroup.add(hatBand);
    const hatTop = new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 12), mats.hatTop);
    hatTop.position.set(0, 0.14, -0.02);
    hatTop.scale.set(1, 0.55, 0.95);
    hatTop.castShadow = true;
    rig.hatGroup.add(hatTop);
    /* Solid disc brim (ring+torus read as hollow “frame” from most angles) */
    const hatBrimDisc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.132, 0.132, 0.014, 40),
      mats.hatBrim,
    );
    /* Cylinder axis is Y — thin height = flat disc in XZ (do not rotate X; that would stand the disc on edge) */
    hatBrimDisc.position.set(0, 0.076, 0.042);
    hatBrimDisc.castShadow = true;
    rig.hatGroup.add(hatBrimDisc);
    const hatBrimEdge = new THREE.Mesh(new THREE.TorusGeometry(0.132, 0.006, 6, 32), mats.hatBrim);
    hatBrimEdge.rotation.x = Math.PI / 2;
    hatBrimEdge.position.set(0, 0.076, 0.042);
    hatBrimEdge.castShadow = true;
    rig.hatGroup.add(hatBrimEdge);
    rig.headRoot.add(rig.hatGroup);

    /* Artisan: tied bandana (no brim) — jerkin cloth + brass knot */
    const bandMain = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.034, 0.086), mats.jerkin);
    bandMain.position.set(0, 0.074, 0.058);
    bandMain.rotation.set(0.18, 0, 0);
    bandMain.castShadow = true;
    rig.smithBandanaGroup.add(bandMain);
    const bandFore = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.022, 0.04), mats.undertunic);
    bandFore.position.set(0, 0.056, 0.092);
    bandFore.rotation.set(0.35, 0, 0);
    bandFore.castShadow = true;
    rig.smithBandanaGroup.add(bandFore);
    const bandKnot = new THREE.Mesh(new THREE.SphereGeometry(0.026, 10, 8), mats.trim);
    bandKnot.position.set(-0.092, 0.09, 0.042);
    bandKnot.scale.set(1, 0.85, 0.9);
    bandKnot.castShadow = true;
    rig.smithBandanaGroup.add(bandKnot);
    rig.smithBandanaGroup.visible = false;
    rig.headRoot.add(rig.smithBandanaGroup);

    rig.lpcaArtisanHair = createArtisanFemaleHairLPCA({
      primary: artisanHairPrimaryMat,
      streak: artisanHairStreakMat,
      forgeBand: mats.trim,
    });
    rig.lpcaArtisanHair.visible = false;
    rig.headRoot.add(rig.lpcaArtisanHair);

    rig.vanguardStaffWoodMat = stdMat({ color: 0x1e1438, roughness: 0.82 });
    rig.vanguardStaffGemMat = new THREE.MeshPhysicalMaterial({
      color: 0xc9a23a,
      metalness: 0.22,
      roughness: 0.28,
      emissive: 0x3a2818,
      emissiveIntensity: 0.12,
    });
    const vanguardMats = {
      robeOuter: mats.jerkin,
      robeInner: mats.undertunic,
      trim: mats.trim,
      hat: mats.hatTop,
      hatBrim: mats.hatBrim,
      staffWood: rig.vanguardStaffWoodMat,
      staffMetal: mats.trim,
      staffGem: rig.vanguardStaffGemMat,
    };
    rig.vanguardWizardRobeRoot = createVanguardWizardRobeLPCA(vanguardMats);
    rig.vanguardWizardRobeRoot.visible = false;
    rig.torso.add(rig.vanguardWizardRobeRoot);
    rig.vanguardWizardBeardRoot = createVanguardWizardBeardLPCA(vanguardMats);
    rig.vanguardWizardBeardRoot.visible = false;
    rig.headRoot.add(rig.vanguardWizardBeardRoot);
    rig.vanguardWizardHatRoot = createVanguardWizardHatLPCA(vanguardMats);
    /* Centered on headRoot - hood profile is built around head dimensions, no offset needed.
     * Was (0, 0.018, 0) which lifted the cowl onto TOP of the head (bishop's mitre look). */
    rig.vanguardWizardHatRoot.position.set(0, 0, 0);
    rig.vanguardWizardHatRoot.visible = false;
    rig.headRoot.add(rig.vanguardWizardHatRoot);
    rig.vanguardWizardStaffRoot = createVanguardWizardStaffLPCA(vanguardMats);
    rig.vanguardWizardStaffRoot.position.set(0.02, -0.12, 0.045);
    rig.vanguardWizardStaffRoot.rotation.set(0.12, 0, -0.15);
    rig.vanguardWizardStaffRoot.visible = false;
    handR.add(rig.vanguardWizardStaffRoot);

    const browMat = stdMat({ color: 0x1a120a, metalness: 0, roughness: 0.9 });
    const browL = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.015, 0.012), browMat);
    browL.position.set(-0.036, 0.03, 0.086);
    browL.rotation.set(-0.07, 0, 0.2);
    browL.castShadow = true;
    rig.headRoot.add(browL);
    const browLInner = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.01, 0.01), browMat);
    browLInner.position.set(-0.018, 0.024, 0.088);
    browLInner.rotation.set(-0.05, 0, 0.35);
    rig.headRoot.add(browLInner);
    const browR = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.015, 0.012), browMat);
    browR.position.set(0.036, 0.03, 0.086);
    browR.rotation.set(-0.07, 0, -0.2);
    browR.castShadow = true;
    rig.headRoot.add(browR);
    const browRInner = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.01, 0.01), browMat);
    browRInner.position.set(0.018, 0.024, 0.088);
    browRInner.rotation.set(-0.05, 0, -0.35);
    rig.headRoot.add(browRInner);

    /* Recessed into skull — less forward z, slightly smaller spheres */
    const eyeWhiteL = new THREE.Mesh(new THREE.SphereGeometry(0.021, 10, 8), stdMat({ color: 0xf8f4ec, roughness: 0.32 }));
    eyeWhiteL.position.set(-0.036, 0.002, 0.082);
    rig.headRoot.add(eyeWhiteL);
    const eyeWhiteR = new THREE.Mesh(new THREE.SphereGeometry(0.021, 10, 8), stdMat({ color: 0xf8f4ec, roughness: 0.32 }));
    eyeWhiteR.position.set(0.036, 0.002, 0.082);
    rig.headRoot.add(eyeWhiteR);

    const irisL = new THREE.Mesh(
      new THREE.RingGeometry(0.008, 0.021, 20),
      stdMat({ color: 0x5c3d22, roughness: 0.55 }),
    );
    irisL.position.set(-0.036, 0.002, 0.089);
    rig.headRoot.add(irisL);
    const irisR = new THREE.Mesh(
      new THREE.RingGeometry(0.008, 0.021, 20),
      stdMat({ color: 0x5c3d22, roughness: 0.55 }),
    );
    irisR.position.set(0.036, 0.002, 0.089);
    rig.headRoot.add(irisR);

    const pupilL = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), stdMat({ color: 0x0a0806, roughness: 0.12, metalness: 0.08 }));
    pupilL.position.set(-0.036, 0.002, 0.096);
    rig.headRoot.add(pupilL);
    const pupilR = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), stdMat({ color: 0x0a0806, roughness: 0.12, metalness: 0.08 }));
    pupilR.position.set(0.036, 0.002, 0.096);
    rig.headRoot.add(pupilR);

    const glintL = new THREE.Mesh(new THREE.SphereGeometry(0.004, 6, 4), stdMat({ color: 0xffffff, roughness: 0.15 }));
    glintL.position.set(-0.029, 0.009, 0.1);
    rig.headRoot.add(glintL);
    const glintR = new THREE.Mesh(new THREE.SphereGeometry(0.004, 6, 4), stdMat({ color: 0xffffff, roughness: 0.15 }));
    glintR.position.set(0.043, 0.009, 0.1);
    rig.headRoot.add(glintR);

    const rimMetal = stdMat({ color: 0x2a2420, metalness: 0.55, roughness: 0.32 });
    const glassLens = new THREE.MeshPhysicalMaterial({
      color: 0xaaccff,
      metalness: 0,
      roughness: 0.08,
      transmission: 0.72,
      thickness: 0.04,
      transparent: true,
      opacity: 0.35,
    });
    const rimL = new THREE.Mesh(new THREE.TorusGeometry(0.034, 0.004, 10, 28), rimMetal);
    rimL.position.set(-0.036, 0.002, 0.094);
    rig.glassesGroup.add(rimL);
    const rimR = new THREE.Mesh(new THREE.TorusGeometry(0.034, 0.004, 10, 28), rimMetal);
    rimR.position.set(0.036, 0.002, 0.094);
    rig.glassesGroup.add(rimR);
    const lensL = new THREE.Mesh(new THREE.CircleGeometry(0.03, 20), glassLens);
    lensL.position.set(-0.036, 0.002, 0.093);
    rig.glassesGroup.add(lensL);
    const lensR = new THREE.Mesh(new THREE.CircleGeometry(0.03, 20), glassLens);
    lensR.position.set(0.036, 0.002, 0.093);
    rig.glassesGroup.add(lensR);
    const bridge = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0035, 0.022, 8), rimMetal);
    bridge.rotation.z = Math.PI / 2;
    bridge.position.set(0, 0.002, 0.094);
    rig.glassesGroup.add(bridge);
    const templeL = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.006, 0.006), rimMetal);
    templeL.position.set(-0.074, 0.01, 0.084);
    templeL.rotation.z = 0.12;
    rig.glassesGroup.add(templeL);
    const templeR = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.006, 0.006), rimMetal);
    templeR.position.set(0.074, 0.01, 0.084);
    templeR.rotation.z = -0.12;
    rig.glassesGroup.add(templeR);
    rig.headRoot.add(rig.glassesGroup);

    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.042, 6), mats.skin);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, -0.02, 0.106);
    rig.headRoot.add(nose);

    const forgeEyeWhite = stdMat({ color: 0xfdf6f0, roughness: 0.28 });
    const forgeBrow = stdMat({ color: 0x241610, roughness: 0.9 });
    rig.forgeWifeHeadRoot = createForgeWifeHeadLPCA({
      skin: mats.skin,
      lip: rig.forgeWifeLipMat,
      eyeWhite: forgeEyeWhite,
      iris: rig.forgeWifeIrisMat,
      brow: forgeBrow,
    });
    rig.forgeWifeHeadRoot.visible = false;
    rig.headRoot.add(rig.forgeWifeHeadRoot);

    rig.maleDockFaceList.push(
      rig.lpcaCranium,
      rig.lpcaJaw,
      rig.lpcaChin,
      rig.lpcaCheekL,
      rig.lpcaCheekR,
      rig.lpcaDefaultHair,
      browL,
      browLInner,
      browR,
      browRInner,
      eyeWhiteL,
      eyeWhiteR,
      irisL,
      irisR,
      pupilL,
      pupilR,
      glintL,
      glintR,
      nose,
    );

    rig.legLMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.056, 0.14, 4, 8), mats.pants);
    rig.legLMesh.position.set(-0.08, -0.02, 0);
    rig.legLMesh.castShadow = true;
    rig.torso.add(rig.legLMesh);

    rig.legRMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.056, 0.14, 4, 8), mats.pants);
    rig.legRMesh.position.set(0.08, -0.02, 0);
    rig.legRMesh.castShadow = true;
    rig.torso.add(rig.legRMesh);

    rig.footLMesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.22), mats.boots);
    rig.footLMesh.position.set(0, -0.14, 0.05);
    rig.footLMesh.castShadow = true;
    rig.legLMesh.add(rig.footLMesh);

    rig.footRMesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.22), mats.boots);
    rig.footRMesh.position.set(0, -0.14, 0.05);
    rig.footRMesh.castShadow = true;
    rig.legRMesh.add(rig.footRMesh);

    rig.armL = new THREE.Group();
    /* Pivot at shoulder pad — no separate floating shoulder sphere */
    rig.armL.position.set(-0.178, 0.282, 0.014);
    /* Longer upper sleeve + flatter jerkin pad at elbow = continuous shirt; smaller skin joint reads as bump */
    const uaL = new THREE.Mesh(new THREE.CapsuleGeometry(0.038, 0.09, 6, 12), mats.jerkin);
    uaL.position.set(0, -0.057, 0.012);
    uaL.castShadow = true;
    rig.armL.add(uaL);
    const elPadL = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), mats.jerkin);
    elPadL.scale.set(0.95, 0.38, 0.9);
    elPadL.position.set(0, -0.118, 0.017);
    elPadL.castShadow = true;
    rig.armL.add(elPadL);
    const elL = new THREE.Mesh(new THREE.SphereGeometry(0.024, 12, 10), mats.skin);
    elL.position.set(0, -0.118, 0.014);
    elL.castShadow = true;
    rig.armL.add(elL);
    const faL = new THREE.Mesh(new THREE.CapsuleGeometry(0.034, 0.09, 6, 12), mats.jerkin);
    faL.position.set(0, -0.178, 0.012);
    faL.castShadow = true;
    rig.armL.add(faL);
    handL.position.set(0, -0.242, 0);
    handL.add(buildPalmFingers(mats.skin, 'left'));
    rig.armL.add(handL);
    rig.torso.add(rig.armL);

    rig.armR = new THREE.Group();
    rig.armR.position.set(0.178, 0.282, 0.014);
    const uaR = new THREE.Mesh(new THREE.CapsuleGeometry(0.038, 0.09, 6, 12), mats.jerkin);
    uaR.position.set(0, -0.057, 0.012);
    uaR.castShadow = true;
    rig.armR.add(uaR);
    const elPadR = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), mats.jerkin);
    elPadR.scale.set(0.95, 0.38, 0.9);
    elPadR.position.set(0, -0.118, 0.017);
    elPadR.castShadow = true;
    rig.armR.add(elPadR);
    const elR = new THREE.Mesh(new THREE.SphereGeometry(0.024, 12, 10), mats.skin);
    elR.position.set(0, -0.118, 0.014);
    elR.castShadow = true;
    rig.armR.add(elR);
    const faR = new THREE.Mesh(new THREE.CapsuleGeometry(0.034, 0.09, 6, 12), mats.jerkin);
    faR.position.set(0, -0.178, 0.012);
    faR.castShadow = true;
    rig.armR.add(faR);
    handR.position.set(0, -0.242, 0);
    handR.add(buildPalmFingers(mats.skin, 'right'));
    rig.armR.add(handR);
    handR.add(heldInRightHand);
    handR.add(minePickRight);
    minePickRight.visible = false;
    rig.torso.add(rig.armR);

    shieldMount.position.set(-0.02, -0.158, 0.05);
    rig.armL.add(shieldMount);
    pickLeftHand.position.set(0.02, -0.04, 0.04);
    handL.add(pickLeftHand);
    pickLeftHand.visible = false;

    pickOnBelt.position.set(0.12, 0.05, -0.08);
    pickOnBelt.rotation.set(0.4, 0.25, 0.35);
    rig.torso.add(pickOnBelt);

  return rig;
}

/** Plan name alias — same as {@link buildDockHeroLpca}. */
export const createDockHeroFigureLPCA = buildDockHeroLpca;
