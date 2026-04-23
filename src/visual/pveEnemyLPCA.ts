/**
 * LPCA PvE enemies — layered procedural anatomy (no textures), PBR stack.
 * Rat/wolf: mesh forward +X (group Y-rotates). Humanoid deserter: dock layout, local +Z toward player.
 * Pipeline: foundation mass → limbs → head/snout → detail → materials.
 */
import * as THREE from 'three';
import { createWitchEnemyLPCA, type WitchVariantId } from './witchEnemyLPCA';
import { installHalfLambertOnTree } from './halfLambertLighting';

/** Humanoid PvE only — arms/head/torso for battle animation (rat/wolf omit). */
export type PveBattleRig = {
  armL: THREE.Group;
  armR: THREE.Group;
  headRoot: THREE.Group;
  torso: THREE.Group;
};

export type PveEnemyLPCA = {
  group: THREE.Group;
  dispose: () => void;
  battleRig?: PveBattleRig;
};

function phys(p: THREE.MeshPhysicalMaterialParameters): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    roughness: 0.42,
    metalness: 0.08,
    envMapIntensity: 0.95,
    ...p,
  });
}

/** Match dock avatar — non-metallic cloth/skin (not tactical armor). */
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

/** Same profile as `characterScenePreview` createTorsoLathe — waist → chest → neck base. */
function createTorsoLathe(
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
  mesh.receiveShadow = true;
  return mesh;
}

/** Same palm/finger/thumb layout and Y-rotation as dock `buildPalmFingers` (keeps hands readable). */
function buildPalmFingers(skin: THREE.MeshStandardMaterial, side: 'left' | 'right'): THREE.Group {
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

function addMesh(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  geos: THREE.BufferGeometry[],
  mats: THREE.Material[],
  castShadow = true,
): THREE.Mesh {
  geos.push(geo);
  mats.push(mat);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = castShadow;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

/** Plague rat — low stalking silhouette, segmented tail, wet snout, rim lit eyes */
function buildRat(root: THREE.Group, geos: THREE.BufferGeometry[], mats: THREE.Material[]): void {
  const skin = phys({
    color: 0x6b5a52,
    roughness: 0.72,
    metalness: 0.02,
  });
  const skinDark = phys({ color: 0x4a3d38, roughness: 0.78, metalness: 0.02 });
  const skinPink = phys({ color: 0x8a7068, roughness: 0.55, metalness: 0.02 });
  const claw = phys({ color: 0x2a2420, roughness: 0.88, metalness: 0.04 });
  const eye = phys({
    color: 0x110805,
    emissive: 0xff4420,
    emissiveIntensity: 0.55,
    roughness: 0.22,
    clearcoat: 0.35,
    clearcoatRoughness: 0.2,
  });
  const nose = phys({
    color: 0x1a1010,
    roughness: 0.35,
    metalness: 0.12,
    clearcoat: 0.55,
    clearcoatRoughness: 0.15,
  });

  /* L1 — thorax + belly (two interlocked ellipsoids) */
  const thoraxG = new THREE.SphereGeometry(0.068, 18, 14);
  const thorax = addMesh(root, thoraxG, skin, geos, mats);
  thorax.scale.set(1.35, 0.88, 1.05);
  thorax.position.set(-0.02, 0.068, 0);

  const bellyG = new THREE.SphereGeometry(0.055, 14, 12);
  const belly = addMesh(root, bellyG, skinPink, geos, mats);
  belly.scale.set(1.1, 0.75, 0.95);
  belly.position.set(0.04, 0.048, 0);

  /* L2 — haunches */
  const haunchG = new THREE.SphereGeometry(0.048, 12, 10);
  const haunchL = addMesh(root, haunchG, skinDark, geos, mats);
  haunchL.position.set(-0.08, 0.055, 0.045);
  const haunchR = addMesh(root, new THREE.SphereGeometry(0.048, 12, 10), skinDark, geos, mats);
  haunchR.position.set(-0.08, 0.055, -0.045);

  /* L3 — neck + shoulder wedge */
  const neckG = new THREE.CylinderGeometry(0.032, 0.04, 0.06, 10);
  const neck = addMesh(root, neckG, skin, geos, mats);
  neck.rotation.z = Math.PI / 2;
  neck.position.set(0.07, 0.095, 0);

  /* L4 — head mass + snout */
  const craniumG = new THREE.SphereGeometry(0.048, 16, 12);
  const cranium = addMesh(root, craniumG, skin, geos, mats);
  cranium.scale.set(1.05, 0.92, 0.88);
  cranium.position.set(0.12, 0.118, 0);

  const snoutG = new THREE.ConeGeometry(0.038, 0.1, 10);
  const snout = addMesh(root, snoutG, skinPink, geos, mats);
  snout.rotation.z = -Math.PI / 2;
  snout.position.set(0.175, 0.108, 0);

  addMesh(root, new THREE.SphereGeometry(0.018, 10, 8), nose, geos, mats).position.set(0.218, 0.102, 0);

  /* L5 — ears */
  for (const z of [-0.038, 0.038]) {
    const eg = new THREE.ConeGeometry(0.022, 0.055, 8);
    const e = addMesh(root, eg, skinDark, geos, mats);
    e.rotation.x = z > 0 ? -0.35 : 0.35;
    e.rotation.z = Math.PI / 2;
    e.position.set(0.1, 0.158, z);
  }

  /* L6 — eyes */
  for (const z of [-0.028, 0.028]) {
    const g = new THREE.SphereGeometry(0.012, 10, 8);
    addMesh(root, g, eye, geos, mats).position.set(0.155, 0.125, z);
  }

  /* L7 — legs (digitigrade hint) */
  const legSpec = [
    { x: 0.05, z: 0.04, ry: 0.12 },
    { x: 0.05, z: -0.04, ry: -0.12 },
    { x: -0.07, z: 0.038, ry: 0.1 },
    { x: -0.07, z: -0.038, ry: -0.1 },
  ] as const;
  for (const leg of legSpec) {
    const ug = new THREE.CylinderGeometry(0.014, 0.012, 0.055, 8);
    const u = addMesh(root, ug, skin, geos, mats);
    u.rotation.x = 0.35;
    u.rotation.y = leg.ry;
    u.position.set(leg.x, 0.038, leg.z);
    const pg = new THREE.BoxGeometry(0.022, 0.012, 0.018);
    const paw = addMesh(root, pg, claw, geos, mats);
    paw.position.set(leg.x + 0.02, 0.008, leg.z);
  }

  /* L8 — tail (tapered segments) */
  let tx = -0.14;
  let ty = 0.085;
  let tz = 0;
  for (let i = 0; i < 5; i++) {
    const r = 0.022 - i * 0.0035;
    const lg = new THREE.CylinderGeometry(r * 0.85, r, 0.045, 8);
    const seg = addMesh(root, lg, i < 2 ? skinDark : skin, geos, mats);
    seg.rotation.z = Math.PI / 2.2 + i * 0.08;
    seg.rotation.y = i * 0.06;
    seg.position.set(tx, ty, tz);
    tx -= 0.038;
    ty += 0.008;
    tz += (i % 2 === 0 ? 1 : -1) * 0.006;
  }
}

/** Starved wolf — deep chest, brush tail, heavy snout, ear rake */
function buildWolf(root: THREE.Group, geos: THREE.BufferGeometry[], mats: THREE.Material[]): void {
  const furDark = phys({ color: 0x3d3530, roughness: 0.88, metalness: 0.02 });
  const furMid = phys({ color: 0x5c5048, roughness: 0.82, metalness: 0.02 });
  const furLight = phys({ color: 0x6e6258, roughness: 0.78, metalness: 0.02 });
  const leather = phys({ color: 0x2a2218, roughness: 0.76, metalness: 0.1 });
  const eye = phys({
    color: 0x050808,
    emissive: 0xffaa44,
    emissiveIntensity: 0.35,
    roughness: 0.18,
  });
  const nose = phys({ color: 0x0a0808, roughness: 0.32, clearcoat: 0.4, clearcoatRoughness: 0.18 });

  /* L1 — chest barrel */
  const chestG = new THREE.SphereGeometry(0.1, 20, 16);
  const chest = addMesh(root, chestG, furMid, geos, mats);
  chest.scale.set(1.25, 0.95, 0.88);
  chest.position.set(0.02, 0.16, 0);

  /* L2 — abdomen tuck */
  const abdG = new THREE.SphereGeometry(0.075, 16, 12);
  const abd = addMesh(root, abdG, furLight, geos, mats);
  abd.scale.set(1.1, 0.82, 0.92);
  abd.position.set(-0.08, 0.12, 0);

  /* L3 — haunches */
  for (const z of [-0.07, 0.07]) {
    const hg = new THREE.SphereGeometry(0.065, 14, 12);
    const h = addMesh(root, hg, furDark, geos, mats);
    h.scale.set(0.95, 1.05, 0.88);
    h.position.set(-0.16, 0.14, z);
  }

  /* L4 — spine ridge */
  const ridgeG = new THREE.BoxGeometry(0.22, 0.025, 0.06);
  const ridge = addMesh(root, ridgeG, furDark, geos, mats);
  ridge.position.set(-0.04, 0.225, 0);
  ridge.rotation.z = -0.04;

  /* L5 — neck */
  const neckG = new THREE.CylinderGeometry(0.055, 0.072, 0.12, 12);
  const neck = addMesh(root, neckG, furMid, geos, mats);
  neck.rotation.z = Math.PI / 2;
  neck.position.set(0.14, 0.2, 0);

  /* L6 — head block + cranium */
  const skullG = new THREE.BoxGeometry(0.12, 0.1, 0.11);
  const skull = addMesh(root, skullG, furMid, geos, mats);
  skull.position.set(0.26, 0.26, 0);

  const domeG = new THREE.SphereGeometry(0.07, 16, 12);
  const dome = addMesh(root, domeG, furDark, geos, mats);
  dome.scale.set(1.1, 0.85, 1.05);
  dome.position.set(0.24, 0.3, 0);

  /* L7 — snout */
  const snoutG = new THREE.BoxGeometry(0.14, 0.075, 0.09);
  const snout = addMesh(root, snoutG, furLight, geos, mats);
  snout.position.set(0.36, 0.235, 0);

  addMesh(root, new THREE.SphereGeometry(0.028, 10, 8), nose, geos, mats).position.set(0.44, 0.22, 0);

  /* L8 — ears */
  for (const z of [-0.055, 0.055]) {
    const eg = new THREE.ConeGeometry(0.035, 0.1, 8);
    const e = addMesh(root, eg, furDark, geos, mats);
    e.rotation.z = Math.PI / 2;
    e.rotation.x = z > 0 ? -0.45 : 0.45;
    e.position.set(0.22, 0.34, z);
  }

  /* L9 — eyes */
  for (const z of [-0.038, 0.038]) {
    addMesh(root, new THREE.SphereGeometry(0.018, 10, 8), eye, geos, mats).position.set(0.32, 0.27, z);
  }

  /* L10 — legs */
  const legs = [
    { x: 0.1, z: 0.055, ang: 0.15 },
    { x: 0.1, z: -0.055, ang: -0.15 },
    { x: -0.12, z: 0.05, ang: 0.12 },
    { x: -0.12, z: -0.05, ang: -0.12 },
  ] as const;
  for (const leg of legs) {
    const ug = new THREE.CylinderGeometry(0.028, 0.022, 0.11, 10);
    const u = addMesh(root, ug, furMid, geos, mats);
    u.rotation.x = 0.42;
    u.rotation.y = leg.ang;
    u.position.set(leg.x, 0.095, leg.z);
    const lg = new THREE.CylinderGeometry(0.02, 0.016, 0.1, 8);
    const low = addMesh(root, lg, furDark, geos, mats);
    low.rotation.x = -0.25;
    low.position.set(leg.x + 0.02, 0.035, leg.z);
    addMesh(root, new THREE.BoxGeometry(0.04, 0.02, 0.05), leather, geos, mats).position.set(
      leg.x + 0.03,
      0.012,
      leg.z,
    );
  }

  /* L11 — brush tail */
  for (let i = 0; i < 6; i++) {
    const t = i / 6;
    const rg = new THREE.ConeGeometry(0.055 * (1 - t * 0.65), 0.09, 10);
    const seg = addMesh(root, rg, i % 2 === 0 ? furDark : furMid, geos, mats);
    seg.rotation.z = Math.PI / 2 + 0.15 + t * 0.12;
    seg.position.set(-0.28 - t * 0.1, 0.16 + t * 0.04, Math.sin(t * 2.1) * 0.03);
  }
}

/**
 * Deserter — dock layout (+Z toward player). Distinct from hero: cooler skin, ash hair, receding hairline
 * (no hat/hood), olive jerkin, rope belt, hip satchel, wrist wrap, hoop ear, knee patch; club on right arm.
 */
function buildRaider(root: THREE.Group, geos: THREE.BufferGeometry[], mats: THREE.Material[]): PveBattleRig {
  const skin = stdMat({ color: 0xb89072, metalness: 0, roughness: 0.83 });
  const undertunic = stdMat({ color: 0x8a7e72, metalness: 0, roughness: 0.85 });
  const jerkin = stdMat({ color: 0x4a5c42, metalness: 0.04, roughness: 0.78 });
  const jerkinPatch = stdMat({ color: 0x3d4a38, metalness: 0.02, roughness: 0.88 });
  const rope = stdMat({ color: 0x6a5840, roughness: 0.82, metalness: 0.02 });
  const pants = stdMat({ color: 0x262018, roughness: 0.88, metalness: 0.02 });
  const boot = stdMat({ color: 0x1c1612, roughness: 0.9, metalness: 0.02 });
  const hairMat = stdMat({ color: 0x6a5a48, roughness: 0.9, metalness: 0 });
  const stubble = stdMat({ color: 0x2a2018, roughness: 0.92, metalness: 0 });
  const browMat = stdMat({ color: 0x1a120a, metalness: 0, roughness: 0.9 });
  const wood = stdMat({ color: 0x4a3520, roughness: 0.9, metalness: 0.02 });
  const bagLeather = stdMat({ color: 0x3d3020, roughness: 0.86, metalness: 0.06 });
  const brass = stdMat({ color: 0x8a7040, roughness: 0.45, metalness: 0.35 });
  const wrap = stdMat({ color: 0x5a5048, roughness: 0.8, metalness: 0.02 });

  const torso = new THREE.Group();
  torso.position.set(0, 0.42, 0);
  root.add(torso);

  const trunkUnder = createTorsoLathe(undertunic, { innerScale: 0.94, depthScale: 0.64 });
  geos.push(trunkUnder.geometry);
  mats.push(undertunic);
  torso.add(trunkUnder);

  const trunkJerkin = createTorsoLathe(jerkin, { innerScale: 1, depthScale: 0.68 });
  trunkJerkin.position.z = 0.006;
  geos.push(trunkJerkin.geometry);
  mats.push(jerkin);
  torso.add(trunkJerkin);

  const shPadL = addMesh(torso, new THREE.SphereGeometry(0.052, 14, 12), jerkin, geos, mats);
  shPadL.scale.set(0.92, 0.52, 0.78);
  shPadL.position.set(-0.168, 0.262, 0.006);

  const shPadR = addMesh(torso, new THREE.SphereGeometry(0.052, 14, 12), jerkin, geos, mats);
  shPadR.scale.set(0.92, 0.52, 0.78);
  shPadR.position.set(0.168, 0.262, 0.006);

  const collar = addMesh(
    torso,
    new THREE.TorusGeometry(0.078, 0.01, 8, 28),
    stdMat({ color: 0x3a4538, metalness: 0.02, roughness: 0.76 }),
    geos,
    mats,
  );
  collar.rotation.x = Math.PI / 2;
  collar.position.set(0, 0.262, 0.014);
  collar.scale.set(1, 1, 0.85);

  const patch = addMesh(torso, new THREE.BoxGeometry(0.08, 0.07, 0.022), jerkinPatch, geos, mats);
  patch.position.set(0, 0.17, 0.1);
  patch.rotation.x = 0.08;

  const belt = addMesh(torso, new THREE.TorusGeometry(0.108, 0.016, 10, 36), rope, geos, mats);
  belt.rotation.x = Math.PI / 2;
  belt.position.set(0, 0.236, 0);
  belt.scale.set(1, 1, 0.72);

  const buckleMesh = addMesh(torso, new THREE.CylinderGeometry(0.022, 0.022, 0.014, 8), brass, geos, mats);
  buckleMesh.rotation.z = Math.PI / 2;
  buckleMesh.position.set(0.11, 0.236, 0.062);

  /* Hip satchel (+X side — opposite heavy swing reads as travel gear) */
  const bag = addMesh(torso, new THREE.BoxGeometry(0.12, 0.14, 0.08), bagLeather, geos, mats);
  bag.position.set(0.14, 0.12, -0.04);
  bag.rotation.y = -0.35;
  const flap = addMesh(torso, new THREE.BoxGeometry(0.11, 0.04, 0.082), jerkinPatch, geos, mats);
  flap.position.set(0.14, 0.175, -0.02);
  flap.rotation.set(0.25, -0.35, 0);
  const strap = addMesh(torso, new THREE.CylinderGeometry(0.018, 0.018, 0.22, 8), bagLeather, geos, mats);
  strap.rotation.z = Math.PI / 2.4;
  strap.position.set(0.06, 0.28, -0.02);

  const neck = addMesh(torso, new THREE.CylinderGeometry(0.068, 0.074, 0.08, 16), skin, geos, mats);
  neck.position.set(0, 0.338, 0.012);

  const headRoot = new THREE.Group();
  headRoot.position.set(0, 0.398, 0.016);
  torso.add(headRoot);

  const cranium = addMesh(headRoot, new THREE.SphereGeometry(0.1, 20, 16), skin, geos, mats);
  cranium.scale.set(0.95, 1.08, 0.88);
  cranium.position.y = 0.02;

  const jaw = addMesh(headRoot, new THREE.BoxGeometry(0.1, 0.055, 0.085), skin, geos, mats);
  jaw.position.set(0, -0.055, 0.025);
  jaw.scale.set(1.08, 1, 1.12);

  const chin = addMesh(headRoot, new THREE.BoxGeometry(0.072, 0.028, 0.07), skin, geos, mats);
  chin.position.set(0, -0.09, 0.045);

  addMesh(headRoot, new THREE.BoxGeometry(0.035, 0.04, 0.04), skin, geos, mats).position.set(-0.055, -0.02, 0.06);
  addMesh(headRoot, new THREE.BoxGeometry(0.035, 0.04, 0.04), skin, geos, mats).position.set(0.055, -0.02, 0.06);

  /* Receding hairline: hair mass sits back; forehead/crown stays exposed */
  const hair = addMesh(headRoot, new THREE.SphereGeometry(0.1, 14, 12), hairMat, geos, mats);
  hair.position.set(0, 0.042, -0.072);
  hair.scale.set(0.95, 0.58, 0.88);

  const hairCrown = addMesh(headRoot, new THREE.SphereGeometry(0.048, 10, 8), hairMat, geos, mats);
  hairCrown.position.set(0, 0.1, -0.02);
  hairCrown.scale.set(1.05, 0.45, 0.95);

  /* Light stubble — few flecks on jaw */
  for (const [sx, sy, sz] of [
    [0.04, -0.07, 0.055],
    [-0.035, -0.065, 0.058],
    [0, -0.082, 0.05],
    [0.055, -0.055, 0.045],
  ] as const) {
    const s = addMesh(headRoot, new THREE.BoxGeometry(0.012, 0.008, 0.006), stubble, geos, mats);
    s.position.set(sx, sy, sz);
  }

  const earRing = addMesh(headRoot, new THREE.TorusGeometry(0.012, 0.003, 6, 12), brass, geos, mats);
  earRing.position.set(0.092, -0.01, 0.02);
  earRing.rotation.y = Math.PI / 2;

  addMesh(headRoot, new THREE.BoxGeometry(0.048, 0.015, 0.012), browMat, geos, mats).position.set(-0.036, 0.03, 0.086);
  addMesh(headRoot, new THREE.BoxGeometry(0.048, 0.015, 0.012), browMat, geos, mats).position.set(0.036, 0.03, 0.086);

  addMesh(headRoot, new THREE.SphereGeometry(0.021, 10, 8), stdMat({ color: 0xe8e0d8, roughness: 0.35 }), geos, mats).position.set(-0.036, 0.002, 0.082);
  addMesh(headRoot, new THREE.SphereGeometry(0.021, 10, 8), stdMat({ color: 0xe8e0d8, roughness: 0.35 }), geos, mats).position.set(0.036, 0.002, 0.082);
  addMesh(headRoot, new THREE.RingGeometry(0.008, 0.021, 20), stdMat({ color: 0x4a3828, roughness: 0.55 }), geos, mats).position.set(-0.036, 0.002, 0.089);
  addMesh(headRoot, new THREE.RingGeometry(0.008, 0.021, 20), stdMat({ color: 0x4a3828, roughness: 0.55 }), geos, mats).position.set(0.036, 0.002, 0.089);
  addMesh(headRoot, new THREE.SphereGeometry(0.012, 10, 8), stdMat({ color: 0x0a0806, roughness: 0.15 }), geos, mats).position.set(-0.036, 0.002, 0.096);
  addMesh(headRoot, new THREE.SphereGeometry(0.012, 10, 8), stdMat({ color: 0x0a0806, roughness: 0.15 }), geos, mats).position.set(0.036, 0.002, 0.096);

  const nose = addMesh(headRoot, new THREE.ConeGeometry(0.02, 0.042, 6), skin, geos, mats);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, -0.02, 0.106);

  const legLG = new THREE.CapsuleGeometry(0.056, 0.14, 4, 8);
  const legL = addMesh(torso, legLG, pants, geos, mats);
  legL.position.set(-0.08, -0.02, 0);

  const legRG = new THREE.CapsuleGeometry(0.056, 0.14, 4, 8);
  const legR = addMesh(torso, legRG, pants, geos, mats);
  legR.position.set(0.08, -0.02, 0);

  const kneePatchL = addMesh(torso, new THREE.BoxGeometry(0.05, 0.045, 0.018), jerkinPatch, geos, mats);
  kneePatchL.position.set(-0.08, -0.05, 0.038);
  const kneePatchR = addMesh(torso, new THREE.BoxGeometry(0.05, 0.045, 0.018), jerkinPatch, geos, mats);
  kneePatchR.position.set(0.08, -0.05, 0.038);

  const footL = addMesh(torso, new THREE.BoxGeometry(0.1, 0.05, 0.22), boot, geos, mats);
  footL.position.set(-0.08, -0.16, 0.05);

  const footR = addMesh(torso, new THREE.BoxGeometry(0.1, 0.05, 0.22), boot, geos, mats);
  footR.position.set(0.08, -0.16, 0.05);

  function addArm(px: number, pz: number, side: 'left' | 'right'): THREE.Group {
    const arm = new THREE.Group();
    arm.position.set(px, 0.282, pz);
    torso.add(arm);

    const uaG = new THREE.CapsuleGeometry(0.038, 0.09, 6, 12);
    const ua = addMesh(arm, uaG, jerkin, geos, mats);
    ua.position.set(0, -0.057, 0.012);

    const elPadG = new THREE.SphereGeometry(0.035, 10, 8);
    const elPad = addMesh(arm, elPadG, jerkin, geos, mats);
    elPad.scale.set(0.95, 0.38, 0.9);
    elPad.position.set(0, -0.118, 0.017);

    const elG = new THREE.SphereGeometry(0.024, 12, 10);
    const el = addMesh(arm, elG, skin, geos, mats);
    el.position.set(0, -0.118, 0.014);

    const faG = new THREE.CapsuleGeometry(0.034, 0.09, 6, 12);
    const fa = addMesh(arm, faG, jerkin, geos, mats);
    fa.position.set(0, -0.178, 0.012);

    if (side === 'left') {
      const wWrap = addMesh(arm, new THREE.TorusGeometry(0.036, 0.008, 6, 14), wrap, geos, mats);
      wWrap.rotation.y = Math.PI / 2;
      wWrap.position.set(0, -0.175, 0.012);
    }

    const hand = buildPalmFingers(skin, side);
    hand.position.set(0, -0.242, 0);
    arm.add(hand);

    if (side === 'right') {
      /* Cylinder on Y — club stands upright from hand toward elbow (+Y in arm space). */
      const clubLen = 0.32;
      const clubShaft = addMesh(arm, new THREE.CylinderGeometry(0.022, 0.026, clubLen, 8), wood, geos, mats);
      const shaftCy = -0.242 + clubLen * 0.5;
      clubShaft.position.set(0.02, shaftCy, 0.04);
      const clubHead = addMesh(arm, new THREE.SphereGeometry(0.046, 12, 10), wood, geos, mats);
      clubHead.position.set(0.02, -0.242 + clubLen + 0.046, 0.04);
    }

    return arm;
  }

  const armL = addArm(-0.178, 0.014, 'left');
  const armR = addArm(0.178, 0.014, 'right');

  return { armL, armR, headRoot, torso };
}

export type CreatePveEnemyLPCAOptions = {
  /** When set (rat/wolf only), replaces default battle yaw — use for hunt snare facing toward camp. */
  overrideRootYawRad?: number;
};

export function createPveEnemyLPCA(enemyId: string, opts?: CreatePveEnemyLPCAOptions): PveEnemyLPCA {
  /* Witches Guild trio — dispatch to the dedicated module (palette + hood + wand). They
   * still expose the standard `PveBattleRig` so existing dock strike / death clips work. */
  if (enemyId === 'e_witch_cori' || enemyId === 'e_witch_jenny' || enemyId === 'e_witch_kristin') {
    const variant = enemyId.replace('e_witch_', '') as WitchVariantId;
    return createWitchEnemyLPCA(variant);
  }
  const root = new THREE.Group();
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  let battleRig: PveBattleRig | undefined;

  switch (enemyId) {
    case 'e_rat':
      buildRat(root, geos, mats);
      root.scale.setScalar(1.42);
      break;
    case 'e_wolf':
      buildWolf(root, geos, mats);
      root.scale.setScalar(1.08);
      break;
    case 'e_rival':
    default:
      battleRig = buildRaider(root, geos, mats);
      root.scale.setScalar(1.02);
      break;
  }

  /* Battle: gatherFaceY aligns enemyRoot local +Z toward the player. Rat/wolf are authored along +X;
   * use the same yaw for both so they face the hero like human raiders. Deserter matches dock avatar (+Z) so yaw stays 0. */
  if (enemyId === 'e_rat' || enemyId === 'e_wolf') {
    root.rotation.y = opts?.overrideRootYawRad ?? Math.PI * 1.5;
  } else root.rotation.y = 0;

  /* Half-Lambert wrap on mob materials (Phase 8h §3) so the shadow side
   * of rats / wolves / wanderers reads as "soft cool grey" instead of
   * "black silhouette" against bright sky. WeakSet dedup means materials
   * shared across spawns get patched once. Specular path untouched. */
  installHalfLambertOnTree(root);

  root.updateMatrixWorld(true);
  const groundBox = new THREE.Box3().setFromObject(root);
  root.position.y = -groundBox.min.y;

  function dispose(): void {
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
  }

  return { group: root, dispose, battleRig };
}
