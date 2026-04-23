/**
 * IDLE-CRAFT — Forge-wife survivor head (standalone LPCA, not a retarget of the male dock).
 * Layer order: lathe skull → nose → eyes → arched brows → PBR lips — no eyewear.
 * @see C:\gameofempiresDocs\docs\LPCA_CHARACTER_PIPELINE.md (lathe profiles, PBR passes)
 */
import * as THREE from 'three';

function smat(o: {
  color: number;
  metalness?: number;
  roughness?: number;
}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: o.color,
    metalness: o.metalness ?? 0.06,
    roughness: o.roughness ?? 0.74,
  });
}

export type ForgeWifeHeadMats = {
  skin: THREE.MeshStandardMaterial;
  lip: THREE.MeshPhysicalMaterial;
  eyeWhite: THREE.MeshStandardMaterial;
  iris: THREE.MeshStandardMaterial;
  brow: THREE.MeshStandardMaterial;
};

export function createForgeWifeHeadLPCA(m: ForgeWifeHeadMats): THREE.Group {
  const root = new THREE.Group();
  root.name = 'idlecraft-forge-wife-head';

  /* Skull — distinct female profile (softer gonial, fuller upper vault than male dock). */
  const skullPts = [
    new THREE.Vector2(0, -0.092),
    new THREE.Vector2(0.048, -0.088),
    new THREE.Vector2(0.078, -0.068),
    new THREE.Vector2(0.09, -0.038),
    new THREE.Vector2(0.092, -0.008),
    new THREE.Vector2(0.086, 0.028),
    new THREE.Vector2(0.074, 0.062),
    new THREE.Vector2(0.056, 0.092),
    new THREE.Vector2(0.032, 0.118),
    new THREE.Vector2(0, 0.128),
  ];
  const skull = new THREE.Mesh(new THREE.LatheGeometry(skullPts, 40), m.skin);
  skull.position.set(0, 0.012, 0.004);
  skull.scale.set(1.02, 1.05, 0.94);
  skull.castShadow = true;
  root.add(skull);

  /* Subtle zygomatic pads — read as different bone than male box jaw */
  const zyL = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), m.skin);
  zyL.position.set(-0.062, -0.012, 0.056);
  zyL.scale.set(1.1, 0.85, 0.75);
  zyL.castShadow = true;
  root.add(zyL);
  const zyR = zyL.clone();
  zyR.position.x = 0.062;
  root.add(zyR);

  /* Nose — shorter, slightly upturned cone */
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.017, 0.036, 8), m.skin);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, -0.028, 0.102);
  nose.scale.set(1, 1, 0.88);
  nose.castShadow = true;
  root.add(nose);

  const nost = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.014, 0.012), m.skin);
  nost.position.set(0, -0.038, 0.098);
  root.add(nost);

  /* Eyes — rounder spacing, hazel iris read */
  const ewL = new THREE.Mesh(new THREE.SphereGeometry(0.019, 12, 10), m.eyeWhite);
  ewL.position.set(-0.038, 0.006, 0.078);
  root.add(ewL);
  const ewR = new THREE.Mesh(new THREE.SphereGeometry(0.019, 12, 10), m.eyeWhite);
  ewR.position.set(0.038, 0.006, 0.078);
  root.add(ewR);

  const irisL = new THREE.Mesh(new THREE.RingGeometry(0.007, 0.019, 22), m.iris);
  irisL.position.set(-0.038, 0.006, 0.086);
  root.add(irisL);
  const irisR = new THREE.Mesh(new THREE.RingGeometry(0.007, 0.019, 22), m.iris);
  irisR.position.set(0.038, 0.006, 0.086);
  root.add(irisR);

  const pupilL = new THREE.Mesh(
    new THREE.SphereGeometry(0.011, 10, 8),
    smat({ color: 0x0a0604, roughness: 0.1, metalness: 0.05 }),
  );
  pupilL.position.set(-0.038, 0.006, 0.092);
  root.add(pupilL);
  const pupilR = pupilL.clone();
  pupilR.position.x = 0.038;
  root.add(pupilR);

  const glL = new THREE.Mesh(new THREE.SphereGeometry(0.0035, 6, 4), smat({ color: 0xffffff, roughness: 0.12 }));
  glL.position.set(-0.032, 0.012, 0.095);
  root.add(glL);
  const glR = glL.clone();
  glR.position.set(0.046, 0.012, 0.095);
  root.add(glR);

  /* Brows — arched, finer than male blocks */
  const brL = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.008, 0.01), m.brow);
  brL.position.set(-0.034, 0.034, 0.084);
  brL.rotation.set(-0.05, 0, 0.28);
  brL.castShadow = true;
  root.add(brL);
  const brR = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.008, 0.01), m.brow);
  brR.position.set(0.034, 0.034, 0.084);
  brR.rotation.set(-0.05, 0, -0.28);
  brR.castShadow = true;
  root.add(brR);

  /* Lips — PBR soft rose (clearcoat read, no glasses distraction) */
  const upperLip = new THREE.Mesh(new THREE.SphereGeometry(0.026, 14, 10), m.lip);
  upperLip.position.set(0, -0.058, 0.1);
  upperLip.scale.set(1.45, 0.42, 0.75);
  upperLip.rotation.x = 0.12;
  upperLip.castShadow = true;
  root.add(upperLip);

  const lowerLip = new THREE.Mesh(new THREE.SphereGeometry(0.022, 12, 10), m.lip);
  lowerLip.position.set(0, -0.076, 0.1);
  lowerLip.scale.set(1.35, 0.55, 0.9);
  lowerLip.castShadow = true;
  root.add(lowerLip);

  const cupid = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.01, 0.008), m.lip);
  cupid.position.set(0, -0.055, 0.104);
  cupid.rotation.x = 0.2;
  root.add(cupid);

  return root;
}

export function createForgeWifeLipMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xc06068,
    metalness: 0,
    roughness: 0.35,
    clearcoat: 0.35,
    clearcoatRoughness: 0.4,
    sheen: 0.25,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(0xff9098),
  });
}
