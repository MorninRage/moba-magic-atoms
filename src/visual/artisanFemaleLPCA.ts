/**
 * IDLE-CRAFT — Artisan female survivor hair (LPCA layered build).
 * Follows Game of Empires character doctrine: LatheGeometry mass + Tube sweep + torus accents,
 * PBR reads (MeshPhysicalMaterial sheen for stylized hair), forge-ring identity.
 * @see C:\gameofempiresDocs\docs\LPCA_CHARACTER_PIPELINE.md
 */
import * as THREE from 'three';

export function createArtisanFemaleHairLPCA(opts: {
  primary: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
  streak: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
  forgeBand: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
}): THREE.Group {
  const root = new THREE.Group();
  root.name = 'idlecraft-lpca-artisan-hair';

  /* Layer 1 — Crown volume (lathe profile, anatomical “up-sweep”) */
  const crownPts = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(0.082, 0.018),
    new THREE.Vector2(0.104, 0.055),
    new THREE.Vector2(0.098, 0.095),
    new THREE.Vector2(0.072, 0.128),
    new THREE.Vector2(0.038, 0.148),
    new THREE.Vector2(0, 0.152),
  ];
  const crown = new THREE.Mesh(new THREE.LatheGeometry(crownPts, 40), opts.primary);
  crown.position.set(0, 0.045, -0.018);
  crown.scale.set(1.05, 1.02, 1.08);
  crown.castShadow = true;
  root.add(crown);

  /* Layer 2 — Side swept masses (paired torus “wings”) */
  const wingGeo = new THREE.TorusGeometry(0.052, 0.026, 10, 28);
  const wingL = new THREE.Mesh(wingGeo, opts.primary);
  wingL.rotation.set(0.42, 0.28, 0.95);
  wingL.position.set(-0.095, 0.012, -0.055);
  wingL.castShadow = true;
  root.add(wingL);
  const wingR = new THREE.Mesh(wingGeo, opts.primary);
  wingR.rotation.set(0.42, -0.28, -0.95);
  wingR.position.set(0.095, 0.012, -0.055);
  wingR.castShadow = true;
  root.add(wingR);

  /* Layer 3 — Braid sweep (CatmullRom tube — single readable “forge braid”) */
  const braidCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.1, 0.01, -0.05),
    new THREE.Vector3(0.12, -0.12, -0.03),
    new THREE.Vector3(0.07, -0.26, 0.06),
    new THREE.Vector3(0.02, -0.34, 0.1),
  ]);
  const braid = new THREE.Mesh(
    new THREE.TubeGeometry(braidCurve, 20, 0.02, 8, false),
    opts.streak,
  );
  braid.castShadow = true;
  root.add(braid);

  /* Layer 4 — IDLE-CRAFT forge ring (ember brass, sits like a kept hair clasp) */
  const clasp = new THREE.Mesh(new THREE.TorusGeometry(0.086, 0.008, 8, 36), opts.forgeBand);
  clasp.rotation.x = Math.PI / 2;
  clasp.position.set(0, 0.118, -0.025);
  clasp.castShadow = true;
  root.add(clasp);

  /* Nape fill — soft sphere to close silhouette behind crown */
  const nape = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 12), opts.primary);
  nape.position.set(0, -0.02, -0.1);
  nape.scale.set(1.15, 0.75, 0.85);
  nape.castShadow = true;
  root.add(nape);

  return root;
}

/** PBR hair read: low metal, controlled sheen (stylized, not photoreal strands). */
export function createArtisanHairPhysicalBase(color: number): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0.02,
    roughness: 0.48,
    sheen: 0.42,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(0x6a4838),
  });
}
