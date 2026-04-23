/**
 * Legacy Vanguard wizard LPCA (cone hat + bell robe + short staff).
 * Kept for NPC / merchant / travel-wizard visuals — see `src/data/npcWizardVisual.ts`.
 * Playable vanguard preset uses `vanguardWizardLPCA.ts` (sage hood + beard).
 */
import * as THREE from 'three';

export type LegacyVanguardWizardLpcaMaterials = {
  robeOuter: THREE.MeshStandardMaterial;
  robeInner: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  hat: THREE.MeshStandardMaterial;
  hatBrim: THREE.MeshStandardMaterial;
  staffWood: THREE.MeshStandardMaterial;
  staffMetal: THREE.MeshStandardMaterial;
  staffGem: THREE.MeshPhysicalMaterial;
};

export function createLegacyVanguardWizardRobeLPCA(m: LegacyVanguardWizardLpcaMaterials): THREE.Group {
  const root = new THREE.Group();
  root.name = 'idlecraft-legacy-vanguard-wizard-robe';

  const outerProfile = [
    new THREE.Vector2(0.052, 0.302),
    new THREE.Vector2(0.1, 0.252),
    new THREE.Vector2(0.138, 0.182),
    new THREE.Vector2(0.168, 0.092),
    new THREE.Vector2(0.198, -0.028),
    new THREE.Vector2(0.238, -0.158),
    new THREE.Vector2(0.288, -0.268),
  ];
  const outer = new THREE.Mesh(new THREE.LatheGeometry(outerProfile, 48), m.robeOuter);
  outer.castShadow = true;
  outer.receiveShadow = true;
  root.add(outer);

  const innerProfile = outerProfile.map(
    (p) => new THREE.Vector2(p.x * 0.9, p.y * 0.985 + 0.012),
  );
  const inner = new THREE.Mesh(new THREE.LatheGeometry(innerProfile, 48), m.robeInner);
  inner.castShadow = true;
  root.add(inner);

  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.014, 10, 40), m.trim);
  collar.rotation.x = Math.PI / 2;
  collar.position.set(0, 0.278, 0.02);
  collar.scale.set(1, 1, 0.88);
  collar.castShadow = true;
  root.add(collar);

  const shoulderL = new THREE.Mesh(
    new THREE.CylinderGeometry(0.058, 0.072, 0.14, 14),
    m.robeOuter,
  );
  shoulderL.rotation.z = Math.PI / 2;
  shoulderL.position.set(-0.2, 0.22, 0.012);
  shoulderL.castShadow = true;
  root.add(shoulderL);
  const shoulderR = shoulderL.clone();
  shoulderR.position.x = 0.2;
  root.add(shoulderR);

  root.scale.set(1.028, 1.02, 1.028);
  return root;
}

export function createLegacyVanguardWizardHatLPCA(m: LegacyVanguardWizardLpcaMaterials): THREE.Group {
  const root = new THREE.Group();
  root.name = 'idlecraft-legacy-vanguard-wizard-hat';

  const hatMat = m.hat.clone();
  hatMat.side = THREE.DoubleSide;

  const underside = new THREE.Mesh(
    new THREE.CylinderGeometry(0.104, 0.108, 0.014, 32),
    m.hatBrim,
  );
  underside.position.set(0, 0.052, 0.018);
  underside.castShadow = true;
  underside.receiveShadow = true;
  root.add(underside);

  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.104, 0.072, 28), m.hatBrim);
  band.position.y = 0.098;
  band.castShadow = true;
  band.receiveShadow = true;
  root.add(band);

  const bandTopY = 0.098 + 0.036;
  const coneH = 0.26;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.096, coneH, 28, 1, false), hatMat);
  cone.position.y = bandTopY + coneH * 0.5;
  cone.castShadow = true;
  root.add(cone);

  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 10), hatMat);
  tip.position.y = bandTopY + coneH;
  tip.castShadow = true;
  root.add(tip);

  const brim = new THREE.Mesh(new THREE.TorusGeometry(0.132, 0.012, 10, 48), m.hatBrim);
  brim.rotation.x = Math.PI / 2;
  brim.position.set(0, 0.048, 0.024);
  brim.castShadow = true;
  root.add(brim);

  return root;
}

export function createLegacyVanguardWizardStaffLPCA(m: LegacyVanguardWizardLpcaMaterials): THREE.Group {
  const root = new THREE.Group();
  root.name = 'idlecraft-legacy-vanguard-wizard-staff';
  root.userData.staffOrbAttachY = 0.93;

  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.026, 0.88, 12),
    m.staffWood,
  );
  shaft.position.y = 0.38;
  shaft.castShadow = true;
  root.add(shaft);

  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.09, 12), m.staffMetal);
  grip.position.y = 0.08;
  grip.castShadow = true;
  root.add(grip);

  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.038, 16, 12), m.staffMetal);
  cap.position.y = 0.86;
  cap.castShadow = true;
  root.add(cap);

  const gemBand = new THREE.Mesh(new THREE.TorusGeometry(0.044, 0.0035, 6, 22), m.staffGem);
  gemBand.rotation.x = Math.PI / 2;
  gemBand.position.y = 0.902;
  gemBand.castShadow = true;
  root.add(gemBand);

  return root;
}
