/**
 * Detailed procedural equipment for the character preview (PBR materials, tier-accurate metals).
 */
import * as THREE from 'three';

export type MetalTone = { head: number; accent: number; handleWood: number };

export function metalToneForItemId(id: string): MetalTone {
  if (id.includes('platinum')) return { head: 0xe8e4ec, accent: 0xc8c2d0, handleWood: 0x3d3028 };
  if (id.includes('gold')) return { head: 0xf0d060, accent: 0xc9a227, handleWood: 0x4a3520 };
  if (id.includes('silver')) return { head: 0xd8e0e8, accent: 0xa8b4c0, handleWood: 0x3a3028 };
  if (id.includes('steel')) return { head: 0x9aa8b8, accent: 0x6a7582, handleWood: 0x3a3028 };
  if (id.includes('brass')) return { head: 0xd4af6a, accent: 0xa67c35, handleWood: 0x4a3820 };
  if (id.includes('bronze')) return { head: 0xcd7f32, accent: 0x8b5a2b, handleWood: 0x3d2e22 };
  if (id.includes('copper')) return { head: 0xc8794a, accent: 0x8b5122, handleWood: 0x3d2a1e };
  if (id.includes('iron')) return { head: 0x8a929a, accent: 0x5a6068, handleWood: 0x3a3028 };
  return { head: 0x7a8288, accent: 0x505860, handleWood: 0x3d3028 };
}

function std(
  color: number,
  metalness = 0.12,
  roughness = 0.7,
  emissive = 0x000000,
  emissiveIntensity = 0,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    metalness,
    roughness,
    emissive,
    emissiveIntensity,
  });
}

export function isAxeWeaponId(id: string): boolean {
  return id === 'axe' || id.includes('_axe');
}

export function isSwordWeaponId(id: string): boolean {
  return id.includes('sword');
}

/**
 * Single-bit felling axe: wide cheek + beard toward the edge, flat poll (no spikes — reads clearly vs pickaxe).
 */
export function buildAxeMesh(itemId: string): THREE.Group {
  const g = new THREE.Group();
  const m = metalToneForItemId(itemId);
  const headMat = std(m.head, 0.82, 0.28);
  const accentMat = std(m.accent, 0.75, 0.32);
  const woodMat = std(m.handleWood, 0.02, 0.88);
  const edgeMat = std(m.head, 0.9, 0.16);

  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.024, 0.36, 10), woodMat);
  handle.position.y = -0.06;
  handle.castShadow = true;
  g.add(handle);

  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.024, 0.005, 6, 14), std(0x2a2018, 0.2, 0.75));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.13 + i * 0.076;
    g.add(ring);
  }

  /* Socket / eye around haft */
  const eye = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.052, 0.036), accentMat);
  eye.position.set(0, 0.108, 0);
  eye.castShadow = true;
  g.add(eye);

  /* Main bit: wide in Z (broad blade), extends along +X */
  const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.076, 0.048), headMat);
  cheek.position.set(0.095, 0.118, 0);
  cheek.rotation.z = -0.06;
  cheek.castShadow = true;
  g.add(cheek);

  /* Lower beard — classic axe wedge silhouette */
  const beard = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.048, 0.044), headMat);
  beard.position.set(0.118, 0.074, 0);
  beard.rotation.z = 0.42;
  beard.castShadow = true;
  g.add(beard);

  /* Bright narrow cutting line */
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.088, 0.012, 0.034), edgeMat);
  edge.position.set(0.132, 0.068, 0.002);
  edge.rotation.z = 0.32;
  g.add(edge);

  /* Flat hammer poll on −X (not a second point) */
  const poll = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 12), accentMat);
  poll.rotation.z = Math.PI / 2;
  poll.position.set(-0.058, 0.116, 0);
  poll.castShadow = true;
  g.add(poll);

  g.rotation.set(0.12, 0, 0.3);
  return g;
}

/** Sword with fuller, guard, wrapped grip, pommel */
export function buildSwordMesh(itemId: string): THREE.Group {
  const g = new THREE.Group();
  const m = metalToneForItemId(itemId);
  const blade = std(m.head, 0.88, 0.22);
  const guardM = std(m.accent, 0.78, 0.3);
  const gripM = std(0x2a1810, 0.05, 0.82);
  const pommelM = std(m.accent, 0.7, 0.35);

  const bladeMesh = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.42, 0.012), blade);
  bladeMesh.position.y = 0.28;
  bladeMesh.castShadow = true;
  g.add(bladeMesh);

  const fuller = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.32, 0.006), std(m.head, 0.92, 0.2));
  fuller.position.set(0, 0.26, 0.008);
  g.add(fuller);

  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.08, 4), blade);
  tip.rotation.z = Math.PI;
  tip.position.y = 0.52;
  g.add(tip);

  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.028, 0.04), guardM);
  guard.position.y = 0.02;
  guard.castShadow = true;
  g.add(guard);

  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.03, 0.12, 8), gripM);
  grip.position.y = -0.05;
  grip.castShadow = true;
  g.add(grip);

  for (let i = 0; i < 4; i++) {
    const wrap = new THREE.Mesh(new THREE.TorusGeometry(0.031, 0.004, 4, 8), std(0x1a1008, 0.1, 0.8));
    wrap.rotation.x = Math.PI / 2;
    wrap.position.y = -0.09 + i * 0.025;
    g.add(wrap);
  }

  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.038, 10, 8), pommelM);
  pommel.position.y = -0.12;
  pommel.castShadow = true;
  g.add(pommel);

  /* Blade along +Y — hand pose in scene rotates grip into palm (upright carry / guard). */
  return g;
}

/**
 * Pickaxe: group origin = bottom of haft (grip in hand). Head sits above the handle along +Y, bit points +X.
 */
export function buildPickMesh(itemId: string): THREE.Group {
  const g = new THREE.Group();
  const m = metalToneForItemId(itemId);
  const head = std(m.head, 0.8, 0.3);
  const dark = std(m.accent, 0.72, 0.36);
  const woodMat = std(m.handleWood, 0.02, 0.88);
  const haftLen = 0.3;

  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.023, haftLen, 9), woodMat);
  handle.position.y = haftLen / 2;
  handle.castShadow = true;
  g.add(handle);

  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.04, 10), dark);
  collar.position.y = haftLen + 0.02;
  collar.castShadow = true;
  g.add(collar);

  const headY = haftLen + 0.04;

  const pickSide = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.14, 5), head);
  pickSide.rotation.z = -Math.PI / 2;
  pickSide.position.set(0.09, headY, 0);
  pickSide.castShadow = true;
  g.add(pickSide);

  const adze = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.04), head);
  adze.position.set(-0.06, headY, 0);
  adze.rotation.z = 0.35;
  adze.castShadow = true;
  g.add(adze);

  const wedge = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.035), dark);
  wedge.position.set(0.02, headY + 0.02, 0);
  g.add(wedge);

  /* +45° yaw so pick bit reads toward camera / strike plane in dock gather clips */
  g.rotation.set(0.2, 0, 0.25 + Math.PI / 4);
  return g;
}

/** Round wooden shield with iron rim and boss */
export function buildShieldMesh(_itemId: string): THREE.Group {
  const g = new THREE.Group();
  const wood = std(0x5c4030, 0.06, 0.78);
  const iron = std(0x6a7078, 0.72, 0.38);

  const board = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.028, 20), wood);
  board.rotation.x = Math.PI / 2;
  board.castShadow = true;
  g.add(board);

  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.012, 6, 24), iron);
  rim.rotation.x = Math.PI / 2;
  rim.position.z = 0.015;
  g.add(rim);

  const boss = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), iron);
  boss.position.z = 0.028;
  boss.scale.set(1, 1, 0.55);
  g.add(boss);

  const stud = new THREE.Mesh(new THREE.SphereGeometry(0.015, 8, 6), iron);
  stud.position.set(0.08, 0.1, 0.02);
  g.add(stud);
  const stud2 = new THREE.Mesh(new THREE.SphereGeometry(0.015, 8, 6), iron);
  stud2.position.set(-0.07, -0.09, 0.02);
  g.add(stud2);

  const planks = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.28, 0.01), std(0x4a3020, 0.05, 0.85));
  planks.position.set(0, 0, 0.018);
  g.add(planks);

  g.rotation.set(0, 0.35, 0);
  return g;
}

export function disposeGroupContents(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry?.dispose();
      const mat = o.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    }
  });
  while (root.children.length) root.remove(root.children[0]!);
}
