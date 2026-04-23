/**
 * Harvest visuals inspired by Game of Empires `LPCA_ResourceNodeFactory` (fiber grass, berry bush, apple tree).
 * Idle Craft scale — no procedural texture bridge / GAME_SCALE; geometry + PBR reads only.
 */
import * as THREE from 'three';

/** Shared materials so {@link mergeByMaterial} can collapse forest instances (GoE LPCA pattern). */
const physLeafCache = new Map<number, THREE.MeshPhysicalMaterial>();
function physLeaf(color: number): THREE.MeshPhysicalMaterial {
  let m = physLeafCache.get(color);
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({
      color,
      metalness: 0.02,
      roughness: 0.42,
      transmission: 0.22,
      thickness: 0.2,
      clearcoat: 0.12,
      clearcoatRoughness: 0.55,
      envMapIntensity: 1.05,
    });
    physLeafCache.set(color, m);
  }
  return m;
}

const STD_BARK = new THREE.MeshStandardMaterial({
  color: 0x4a3a2a,
  metalness: 0.04,
  roughness: 0.88,
});
function stdBark(): THREE.MeshStandardMaterial {
  return STD_BARK;
}

const stdLitCache = new Map<string, THREE.MeshStandardMaterial>();
function stdLit(key: string, p: { color: number; roughness: number; metalness?: number }): THREE.MeshStandardMaterial {
  let m = stdLitCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: p.color,
      roughness: p.roughness,
      metalness: p.metalness ?? 0,
    });
    stdLitCache.set(key, m);
  }
  return m;
}

const physGlossCache = new Map<string, THREE.MeshPhysicalMaterial>();
function physGloss(
  key: string,
  p: { color: number; roughness: number; transmission: number; thickness: number; envMapIntensity: number },
): THREE.MeshPhysicalMaterial {
  let m = physGlossCache.get(key);
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({
      color: p.color,
      metalness: 0.03,
      roughness: p.roughness,
      transmission: p.transmission,
      thickness: p.thickness,
      envMapIntensity: p.envMapIntensity,
    });
    physGlossCache.set(key, m);
  }
  return m;
}

/**
 * Flowers / berries must read **saturated** in the dock preview: there is no `scene.environment`,
 * so `MeshPhysicalMaterial` + transmission turns tiny spheres muddy or black under ACES tone mapping.
 */
const vividAccentCache = new Map<string, THREE.MeshStandardMaterial>();
function vividAccentMat(hex: number, emissiveIntensity: number): THREE.MeshStandardMaterial {
  const key = `${hex}:${emissiveIntensity}`;
  let m = vividAccentCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: hex,
      metalness: 0.04,
      roughness: 0.38,
      emissive: new THREE.Color(hex),
      emissiveIntensity,
    });
    vividAccentCache.set(key, m);
  }
  return m;
}

/** Single grass blade — same extruded profile as GoE `createFiberBlade`. */
function createFiberBlade(h: number, w: number, leanX: number, leanZ: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const hw = w * 0.5;
  shape.moveTo(-hw, 0);
  shape.lineTo(hw, 0);
  shape.lineTo(hw * 0.3, h);
  shape.lineTo(0, h);
  shape.lineTo(-hw * 0.3, h * 0.9);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: w * 0.3, bevelEnabled: false });
  geo.rotateZ(leanX);
  geo.rotateY(leanZ);
  return geo;
}

/** GoE-style fiber patch: extruded blades + optional seed heads (idle scale ~0.35 world units tall). */
export function buildIdleCraftFiberGrass(rand: () => number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'idlecraft-fiber-grass';
  const dark = physLeaf(0x5a8a42);
  const light = physLeaf(0x8aba6a);
  const tip = physLeaf(0xa0c880);
  const seed = stdLit('idle-fiber-seed', { color: 0x9a8a5a, roughness: 0.85, metalness: 0 });

  const bladeCount = 12 + Math.floor(rand() * 6);
  const bladeTips: { x: number; y: number; z: number }[] = [];
  const scale = 0.42;

  for (let i = 0; i < bladeCount; i++) {
    const h = (0.38 + rand() * 0.5) * scale;
    const w = (0.028 + rand() * 0.018) * scale;
    const px = (rand() - 0.5) * 0.42;
    const pz = (rand() - 0.5) * 0.42;
    const bladeGeo = createFiberBlade(h, w, (rand() - 0.5) * 0.35, (rand() - 0.5) * 0.35);
    const mat = h > 0.48 * scale ? tip : rand() < 0.5 ? dark : light;
    const mesh = new THREE.Mesh(bladeGeo, mat);
    mesh.position.set(px, 0, pz);
    mesh.castShadow = true;
    g.add(mesh);
    bladeTips.push({ x: px, y: h * 0.92, z: pz });
  }

  const seedCount = Math.min(3 + Math.floor(rand() * 2), bladeTips.length);
  const indices = Array.from({ length: bladeTips.length }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  for (let i = 0; i < seedCount; i++) {
    const t = bladeTips[indices[i]!]!;
    const seedGeo = new THREE.SphereGeometry(0.022 * scale, 5, 4);
    seedGeo.scale(1, 2.2, 1);
    const s = new THREE.Mesh(seedGeo, seed);
    s.position.set(t.x, t.y, t.z);
    s.castShadow = true;
    g.add(s);
  }

  return g;
}

/** Berry tones for LPCA bush — raspberry/red through blueberry, elder, wine. */
const BERRY_FRUIT_HEX = [
  0xc42d4e, 0xd04060, 0x3a4a9e, 0x5a3a8a, 0x4a2840, 0xe0a028, 0xb03050, 0x6a4088,
] as const;

/** GoE berry bush silhouette: layered foliage ellipsoids + surface berries (idle scale). */
export function buildIdleCraftBerryBush(rand: () => number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'idlecraft-berry-bush';
  const bark = stdBark();
  const leafDark = physLeaf(0x1e5a1e);
  const leafLight = physLeaf(0x2e6e2e);
  const leafTip = physLeaf(0x4a9a4a);
  const berryHex = BERRY_FRUIT_HEX[Math.floor(rand() * BERRY_FRUIT_HEX.length)]!;
  const berryMat = vividAccentMat(berryHex, 0.32);

  const s = 0.55 + rand() * 0.2;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.04 * s, 0.055 * s, 0.22 * s, 8), bark);
  stem.position.y = 0.11 * s;
  stem.castShadow = true;
  g.add(stem);

  const clusters: { cx: number; cy: number; cz: number; r: number; sy: number; mat: THREE.MeshPhysicalMaterial }[] = [
    { cx: 0, cy: 0.36 * s, cz: 0, r: 0.45 * s, sy: 0.72, mat: leafDark },
    { cx: 0.2 * s, cy: 0.4 * s, cz: 0.12 * s, r: 0.28 * s, sy: 0.68, mat: leafLight },
    { cx: -0.18 * s, cy: 0.38 * s, cz: -0.1 * s, r: 0.26 * s, sy: 0.68, mat: leafLight },
    { cx: 0.06 * s, cy: 0.5 * s, cz: -0.18 * s, r: 0.2 * s, sy: 0.68, mat: leafTip },
  ];

  const berryR = 0.032 * s;
  for (const c of clusters) {
    const geo = new THREE.SphereGeometry(c.r, 10, 8);
    geo.scale(1, c.sy, 1);
    const fol = new THREE.Mesh(geo, c.mat);
    fol.position.set(c.cx, c.cy, c.cz);
    fol.castShadow = true;
    g.add(fol);

    const nBerries = 2 + Math.floor(rand() * 3);
    for (let b = 0; b < nBerries; b++) {
      const theta = rand() * Math.PI * 2;
      const phi = rand() * Math.PI * 0.5 + Math.PI * 0.2;
      const R = c.r * 0.88;
      const bx = c.cx + R * Math.sin(theta) * Math.cos(phi);
      const by = c.cy + c.r * c.sy * Math.cos(theta) * 0.85;
      const bz = c.cz + R * Math.sin(theta) * Math.sin(phi);
      const berry = new THREE.Mesh(new THREE.SphereGeometry(berryR, 8, 6), berryMat);
      berry.position.set(bx, by, bz);
      berry.castShadow = true;
      g.add(berry);
    }
  }

  return g;
}

function displaceSphere(geo: THREE.BufferGeometry, strength: number, squashY: number): void {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const n = Math.sin(x * 12.99 + y * 78.23 + z * 45.16) * 43758.55;
    const disp = (n - Math.floor(n)) * strength - strength * 0.5;
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    pos.setXYZ(
      i,
      x + (x / len) * disp,
      y + (y / len) * disp * squashY,
      z + (z / len) * disp,
    );
  }
  geo.computeVertexNormals();
}

/**
 * Compact apple tree (GoE-style trunk, branches, lumpy crown, red apples) — fits gather + forest scale.
 */
export function buildIdleCraftAppleTree(rand: () => number, sizeMult = 1): THREE.Group {
  const g = new THREE.Group();
  g.name = 'idlecraft-apple-tree';
  const bark = stdBark();
  const leafDark = physLeaf(0x1e5a1e);
  const leafLight = physLeaf(0x2e6e2e);
  const leafTip = physLeaf(0x4a9a4a);
  const appleMat = physGloss('idle-apple-fruit', {
    color: 0xe83a3a,
    roughness: 0.24,
    transmission: 0.1,
    thickness: 0.1,
    envMapIntensity: 1.45,
  });

  /* Larger default broadleaf; ~40% “specimen” apples approach oak-scale crowns. */
  let s = (1.02 + rand() * 0.42) * sizeMult;
  if (rand() < 0.4) s *= 1.14 + rand() * 0.22;
  const crownMult = 1.58;
  const crownY = 1.02 * s;
  const crownR = 0.25 * s * crownMult;

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1 * s, 0.14 * s, 0.05 * s, 10),
    stdLit('idle-apple-base', { color: 0x3d4a38, roughness: 0.9 }),
  );
  base.position.y = 0.025 * s;
  base.receiveShadow = true;
  g.add(base);

  const rootH = 0.1 * s;
  const root = new THREE.Mesh(new THREE.CylinderGeometry(0.045 * s, 0.08 * s, rootH, 8), bark);
  root.position.y = rootH * 0.5;
  root.castShadow = true;
  g.add(root);

  const trunkH = 0.76 * s;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.028 * s, 0.052 * s, trunkH, 10), bark);
  /* Trunk center = root **top** + half trunk (root top = rootH; old code used 0.15·s and left a 0.05·s gap). */
  trunk.position.y = rootH + trunkH * 0.5;
  trunk.castShadow = true;
  g.add(trunk);

  /* === 2026-04-22 apple-tree branches removed ===
   *
   * The original branches were vertical sticks (CylinderGeometry default
   * Y-axis + only Z-jitter ±26°, no base π/2 to lay them horizontal). First
   * fix attempted to rotate them horizontal via rotation order YZX + base
   * π/2, but the player decided the apple tree silhouette reads cleanly
   * enough WITHOUT visible branches (the crown sphere + accents + apples
   * carry the read on their own). Branches removed entirely — fewer draw
   * calls, no bug surface area. The `barkLight` material is also gone now
   * that nothing uses it. */

  const mainGeo = new THREE.SphereGeometry(0.25 * s * crownMult, 12, 10);
  mainGeo.scale(1, 0.88, 1);
  displaceSphere(mainGeo, 0.08, 0.65);
  const mainF = new THREE.Mesh(mainGeo, leafDark);
  mainF.position.set(0, crownY, 0);
  mainF.castShadow = true;
  g.add(mainF);

  const accents: { x: number; y: number; z: number; r: number; mat: THREE.MeshPhysicalMaterial }[] = [
    { x: 0.12, y: 1.02, z: 0.08, r: 0.2, mat: leafLight },
    { x: -0.1, y: 0.99, z: -0.06, r: 0.18, mat: leafLight },
    { x: 0.05, y: 1.08, z: -0.1, r: 0.15, mat: leafTip },
  ];
  for (const o of accents) {
    const lg = new THREE.SphereGeometry(o.r * s * crownMult, 8, 6);
    lg.scale(1, 0.78, 1);
    displaceSphere(lg, 0.06, 0.7);
    const leaf = new THREE.Mesh(lg, o.mat);
    leaf.position.set(o.x * s, o.y * s, o.z * s);
    leaf.castShadow = true;
    g.add(leaf);
  }

  const nApples = 5 + Math.floor(rand() * 3);
  for (let i = 0; i < nApples; i++) {
    const ang = (i / nApples) * Math.PI * 2 + rand() * 0.5;
    const r = crownR * (0.82 + rand() * 0.28);
    const ay = crownY + (rand() - 0.5) * 0.12 * s;
    const ax = Math.cos(ang) * r;
    const az = Math.sin(ang) * r;
    const apple = new THREE.Mesh(new THREE.SphereGeometry(0.055 * s, 10, 8), appleMat);
    apple.position.set(ax, ay, az);
    apple.castShadow = true;
    g.add(apple);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.006 * s, 0.006 * s, 0.025 * s, 4), bark);
    stem.position.set(ax, ay + 0.055 * s, az);
    g.add(stem);
  }

  return g;
}

/**
 * **Species 1 — classic pine:** tapered trunk + **stacked needle cones** (tiered silhouette, reads clearly from distance).
 * Distinct from {@link buildIdleCraftBalsamFirTree} (species 3), which uses horizontal pads + droop tufts — that is “fir”, not this.
 */
export function buildIdleCraftPineTree(rand: () => number, sizeMult = 1): THREE.Group {
  const g = new THREE.Group();
  g.name = 'idlecraft-pine-tree';
  const bark = stdLit('idle-pine-bark', { color: 0x3a3028, roughness: 0.9, metalness: 0.04 });
  const needleDark = physLeaf(0x1a4a2a);
  const needleMid = physLeaf(0x2a6a3a);
  const needleTip = physLeaf(0x347848);
  const s = (0.92 + rand() * 0.28) * sizeMult;
  const trunkH = 1.14 * s;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.02 * s, 0.052 * s, trunkH, 8), bark);
  trunk.position.y = trunkH * 0.5;
  trunk.castShadow = true;
  g.add(trunk);

  const nTiers = 4 + Math.floor(rand() * 2);
  for (let i = 0; i < nTiers; i++) {
    const t = i / nTiers;
    const y = (0.36 + t * 0.74) * trunkH;
    const rad = (0.48 - t * 0.4) * 0.4 * s;
    const h = (0.32 + rand() * 0.07) * s * (1.02 - t * 0.38);
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(rad, h, 7),
      rand() < 0.5 ? needleDark : needleMid,
    );
    cone.position.y = y;
    cone.castShadow = true;
    g.add(cone);
  }
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.08 * s, 0.22 * s, 6), needleTip);
  tip.position.y = trunkH * 0.92;
  tip.castShadow = true;
  g.add(tip);
  return g;
}

/**
 * **Balsam fir (Abies balsamea)** — narrow spire, **horizontal needle pads** (squashed spheres), branches that
 * **droop** at the tips, blue‑green palette; whorls overlap + **fill bridges** only (no inner “pipe”).
 */
export function buildIdleCraftBalsamFirTree(rand: () => number, sizeMult = 1): THREE.Group {
  const g = new THREE.Group();
  g.name = 'idlecraft-balsam-fir';
  const bark = stdLit('idle-balsam-bark', { color: 0x2a2218, roughness: 0.91, metalness: 0.03 });
  const needleShade = physLeaf(0x0a2218);
  const needleDeep = physLeaf(0x0f3020);
  const needleMid = physLeaf(0x143c2a);
  const needleTip = physLeaf(0x1e4c38);
  const needleHi = physLeaf(0x285e48);
  const mats = [needleShade, needleDeep, needleMid, needleTip, needleHi];
  const s = (0.9 + rand() * 0.26) * sizeMult;
  const trunkH = 0.58 * s;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.02 * s, 0.048 * s, trunkH, 9), bark);
  trunk.position.y = trunkH * 0.5;
  trunk.castShadow = true;
  g.add(trunk);

  const yLow = trunkH * 0.36;
  const yHigh = trunkH * 0.48 + 1.08 * s;
  const nLayers = 11 + Math.floor(rand() * 4);
  const layerYs: number[] = [];
  const layerRads: number[] = [];

  for (let i = 0; i < nLayers; i++) {
    const t = i / Math.max(1, nLayers - 1);
    const y = THREE.MathUtils.lerp(yLow, yHigh, t);
    const rad = ((0.36 - t * 0.32) * 0.42 + 0.04) * s;
    layerYs.push(y);
    layerRads.push(rad);

    const padGeo = new THREE.SphereGeometry(rad * 0.46, 12, 10);
    padGeo.scale(1.22 + rand() * 0.1, 0.26 + rand() * 0.06, 1.18 + rand() * 0.1);
    displaceSphere(padGeo, 0.046 + rand() * 0.016, 0.6);
    const pad = new THREE.Mesh(padGeo, mats[i % mats.length]!);
    pad.position.y = y;
    pad.rotation.y = rand() * Math.PI * 2 + i * 0.14 + (rand() - 0.5) * 0.32;
    pad.castShadow = true;
    g.add(pad);

    const nTufts = 9 + Math.floor(rand() * 4);
    for (let k = 0; k < nTufts; k++) {
      const ang = (k / nTufts) * Math.PI * 2 + rand() * 0.38 + i * 0.26;
      const rr = rad * (0.76 + rand() * 0.26);
      const tuftH = (0.095 + rand() * 0.065) * s * (1 - t * 0.2);
      const tuftR = (0.021 + rand() * 0.009) * s * (1 - t * 0.16);
      const tuft = new THREE.Mesh(
        new THREE.ConeGeometry(tuftR, tuftH, 6),
        mats[(i + k) % mats.length]!,
      );
      const ty = y - rad * 0.05;
      tuft.position.set(Math.cos(ang) * rr, ty, Math.sin(ang) * rr);
      tuft.rotation.order = 'YXZ';
      tuft.rotation.y = ang + (rand() - 0.5) * 0.22;
      tuft.rotation.x = -0.48 - rand() * 0.32 - t * 0.12;
      tuft.rotation.z = (rand() - 0.5) * 0.32;
      tuft.castShadow = true;
      g.add(tuft);
    }

    if (i < nLayers - 1) {
      const t2 = (i + 1) / Math.max(1, nLayers - 1);
      const y2 = THREE.MathUtils.lerp(yLow, yHigh, t2);
      const rad2 = ((0.36 - t2 * 0.32) * 0.42 + 0.04) * s;
      const yMid = (y + y2) * 0.5;
      const radMid = (rad + rad2) * 0.5;
      const nBridge = 6 + Math.floor(rand() * 4);
      for (let b = 0; b < nBridge; b++) {
        const ang = (b / nBridge) * Math.PI * 2 + i * 0.31 + rand() * 0.22;
        const br = radMid * (0.55 + rand() * 0.34);
        const bridgeGeo = new THREE.SphereGeometry(radMid * 0.19 + rand() * 0.014 * s, 8, 7);
        bridgeGeo.scale(1.05, 0.42 + rand() * 0.1, 1.02);
        displaceSphere(bridgeGeo, 0.032, 0.64);
        const bridge = new THREE.Mesh(bridgeGeo, mats[(i + b + 2) % mats.length]!);
        bridge.position.set(Math.cos(ang) * br, yMid, Math.sin(ang) * br);
        bridge.rotation.y = ang;
        bridge.castShadow = true;
        g.add(bridge);
      }
    }
  }

  const lastY = layerYs[layerYs.length - 1]!;
  const lastR = layerRads[layerRads.length - 1]!;
  const leader = new THREE.Mesh(new THREE.ConeGeometry(0.042 * s, 0.26 * s, 8), needleTip);
  leader.position.y = lastY + lastR * 0.1;
  leader.castShadow = true;
  g.add(leader);

  const crownTip = new THREE.Mesh(new THREE.IcosahedronGeometry(0.04 * s, 1), needleHi);
  displaceSphere(crownTip.geometry, 0.026, 0.68);
  crownTip.position.y = lastY + lastR * 0.2 + 0.11 * s;
  crownTip.scale.set(0.52, 1.02, 0.52);
  crownTip.castShadow = true;
  g.add(crownTip);

  return g;
}

/**
 * **Round-crown oak-style broadleaf** — LPCA: sturdy flared trunk + **multi-lobe displaced spheres**
 * (deep summer greens). Distinct from {@link buildIdleCraftAppleTree} (no fruit, wider stem, rounder mass).
 */
export function buildIdleCraftRoundOakTree(rand: () => number, sizeMult = 1): THREE.Group {
  const g = new THREE.Group();
  g.name = 'idlecraft-round-oak';
  const bark = stdLit('idle-oak-bark', { color: 0x3a3026, roughness: 0.87, metalness: 0.03 });
  const leafA = physLeaf(0x163c16);
  const leafB = physLeaf(0x245822);
  const leafC = physLeaf(0x34702c);
  const s = (0.88 + rand() * 0.28) * sizeMult;
  const trunkH = 0.78 * s;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.038 * s, 0.072 * s, trunkH, 10),
    bark,
  );
  trunk.position.y = trunkH * 0.5;
  trunk.castShadow = true;
  g.add(trunk);

  const crownBaseY = trunkH * 0.82;
  const mainR = 0.36 * s;
  const mainGeo = new THREE.SphereGeometry(mainR, 14, 12);
  mainGeo.scale(1.08, 0.74, 1.06);
  displaceSphere(mainGeo, 0.095, 0.62);
  const main = new THREE.Mesh(mainGeo, leafA);
  main.position.y = crownBaseY;
  main.castShadow = true;
  g.add(main);

  const lobes: { ox: number; oz: number; oy: number; r: number; mat: THREE.MeshPhysicalMaterial }[] = [
    { ox: 0.22, oz: 0.1, oy: 0.08, r: 0.22, mat: leafB },
    { ox: -0.18, oz: -0.14, oy: 0.04, r: 0.2, mat: leafB },
    { ox: 0.08, oz: -0.22, oy: 0.12, r: 0.17, mat: leafC },
    { ox: -0.12, oz: 0.2, oy: 0.06, r: 0.18, mat: leafC },
  ];
  for (const L of lobes) {
    if (rand() < 0.12) continue;
    const lg = new THREE.SphereGeometry(L.r * s, 10, 8);
    lg.scale(1, 0.82, 1);
    displaceSphere(lg, 0.07, 0.68);
    const m = new THREE.Mesh(lg, L.mat);
    m.position.set(L.ox * s, crownBaseY + L.oy * s, L.oz * s);
    m.castShadow = true;
    g.add(m);
  }

  return g;
}

/** Pale bark + airy leaf plates — reads as secondary broadleaf in mixed forest. */
export function buildIdleCraftBirchTree(rand: () => number, sizeMult = 1): THREE.Group {
  const g = new THREE.Group();
  g.name = 'idlecraft-birch-tree';
  const bark = stdLit('idle-birch-bark', { color: 0xefeae2, roughness: 0.76, metalness: 0.02 });
  const mark = stdLit('idle-birch-mark', { color: 0x2a2824, roughness: 0.88 });
  const leafA = physLeaf(0x529650);
  const leafB = physLeaf(0x72b864);
  const s = (0.88 + rand() * 0.22) * sizeMult;
  const trunkH = 1.06 * s;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.032 * s, 0.056 * s, trunkH, 10), bark);
  trunk.position.y = trunkH * 0.5;
  trunk.castShadow = true;
  g.add(trunk);
  for (let m = 0; m < 4; m++) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.012 * s, trunkH * (0.12 + rand() * 0.08), 0.004 * s), mark);
    strip.position.set((rand() - 0.5) * 0.04 * s, trunkH * (0.35 + rand() * 0.45), 0.028 * s);
    strip.rotation.y = m * 1.2 + rand() * 0.4;
    g.add(strip);
  }
  const nBranches = 5 + Math.floor(rand() * 3);
  for (let i = 0; i < nBranches; i++) {
    const ang = (i / nBranches) * Math.PI * 2 + rand() * 0.5;
    const by = (0.55 + rand() * 0.28) * trunkH;
    const len = (0.16 + rand() * 0.08) * s;
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.005 * s, 0.012 * s, len, 5), bark);
    br.position.set(Math.cos(ang) * 0.03 * s, by, Math.sin(ang) * 0.03 * s);
    br.rotation.y = ang;
    br.rotation.z = 0.55 + rand() * 0.35;
    br.castShadow = true;
    g.add(br);
    const plate = new THREE.Mesh(new THREE.CircleGeometry((0.12 + rand() * 0.06) * s, 6), rand() < 0.5 ? leafA : leafB);
    plate.position.set(
      Math.cos(ang) * (0.03 + len * 0.45) * s,
      by + len * Math.sin(br.rotation.z) * 0.42,
      Math.sin(ang) * (0.03 + len * 0.45) * s,
    );
    plate.rotation.x = -Math.PI / 2 + (rand() - 0.5) * 0.35;
    plate.rotation.z = ang + rand() * 0.4;
    plate.castShadow = true;
    g.add(plate);
  }
  return g;
}

/** Low wide blades — meadow tuft (different silhouette than fiber grass). */
export function buildIdleCraftTuftGrass(rand: () => number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'idlecraft-tuft-grass';
  const a = physLeaf(0x4a7a3a);
  const b = physLeaf(0x6a9a52);
  const c = physLeaf(0x8aba6a);
  const scale = 0.48;
  const n = 8 + Math.floor(rand() * 5);
  for (let i = 0; i < n; i++) {
    const h = (0.22 + rand() * 0.2) * scale;
    const w = (0.05 + rand() * 0.02) * scale;
    const shape = new THREE.Shape();
    shape.moveTo(-w, 0);
    shape.quadraticCurveTo(0, h * 1.1, w * 0.2, h);
    shape.lineTo(-w * 0.15, h * 0.92);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: w * 0.25, bevelEnabled: false });
    geo.rotateY((rand() - 0.5) * 0.5);
    geo.rotateZ((rand() - 0.5) * 0.25);
    const mesh = new THREE.Mesh(geo, i % 3 === 0 ? a : i % 3 === 1 ? b : c);
    mesh.position.set((rand() - 0.5) * 0.38 * scale, 0, (rand() - 0.5) * 0.38 * scale);
    mesh.castShadow = true;
    g.add(mesh);
  }
  return g;
}

/** Stiff sedge: radiating narrow boxes (wet-ground read). */
export function buildIdleCraftSedgeGrass(rand: () => number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'idlecraft-sedge-grass';
  const mat = physLeaf(0x5a8048);
  const matTip = physLeaf(0x7a9858);
  const scale = 0.44;
  const blades = 6 + Math.floor(rand() * 4);
  for (let i = 0; i < blades; i++) {
    const ang = (i / blades) * Math.PI * 2 + rand() * 0.2;
    const len = (0.26 + rand() * 0.16) * scale;
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.014 * scale, len, 0.012 * scale), rand() > 0.35 ? mat : matTip);
    box.position.set(Math.cos(ang) * 0.04 * scale, len * 0.48, Math.sin(ang) * 0.04 * scale);
    box.rotation.y = ang;
    box.rotation.x = 0.12 + rand() * 0.18;
    box.castShadow = true;
    g.add(box);
  }
  return g;
}

/** Arching frond cluster — understory fern. */
export function buildIdleCraftFernCluster(rand: () => number, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.name = 'idlecraft-fern-cluster';
  const stem = stdLit('idle-fern-stem', { color: 0x3d5038, roughness: 0.86 });
  const fr = physLeaf(0x2d6a3a);
  const frTip = physLeaf(0x4a8a48);
  const st = new THREE.Mesh(new THREE.CylinderGeometry(0.012 * scale, 0.02 * scale, 0.08 * scale, 6), stem);
  st.position.y = 0.04 * scale;
  st.castShadow = true;
  g.add(st);
  const n = 5 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + rand() * 0.3;
    const reach = (0.16 + rand() * 0.08) * scale;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.quadraticCurveTo(reach * 0.35, reach * 0.55, reach, reach * 0.08);
    shape.lineTo(reach * 0.85, 0);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.004 * scale, bevelEnabled: false });
    const m = new THREE.Mesh(geo, i % 2 === 0 ? fr : frTip);
    m.position.set(0, 0.06 * scale, 0);
    m.rotation.y = ang;
    m.rotation.x = -0.65 - rand() * 0.25;
    m.castShadow = true;
    g.add(m);
  }
  return g;
}

/** Calluna / Erica–style bloom pairs — purple, magenta, blue-heath, cream (LPCA research: moor heather palettes). */
const HEATHER_BLOOM_PAIRS: ReadonlyArray<{ deep: number; light: number }> = [
  { deep: 0x8a4a8a, light: 0xc86aa8 },
  { deep: 0x6b3d7a, light: 0xa878c8 },
  { deep: 0x7a3d92, light: 0xd090e8 },
  { deep: 0x9b4d8e, light: 0xf0a8d8 },
  { deep: 0x4a5a8a, light: 0x8a9ad8 },
  { deep: 0x8a6a48, light: 0xc8a878 },
  { deep: 0xe8d8e8, light: 0xf8f0f8 },
];

function heatherBloomMat(hex: number): THREE.MeshStandardMaterial {
  return vividAccentMat(hex, 0.45);
}

/** Low dome of tiny blooms — heather / heath ground cover. */
export function buildIdleCraftHeatherMound(rand: () => number, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.name = 'idlecraft-heather-mound';
  const stem = stdLit('idle-heather-stem', { color: 0x3a4538, roughness: 0.9 });
  const pair = HEATHER_BLOOM_PAIRS[Math.floor(rand() * HEATHER_BLOOM_PAIRS.length)]!;
  const fl = heatherBloomMat(pair.deep);
  const fl2 = heatherBloomMat(pair.light);
  const base = new THREE.Mesh(new THREE.SphereGeometry(0.14 * scale, 8, 6), stem);
  base.scale.set(1, 0.45, 1);
  base.position.y = 0.05 * scale;
  base.castShadow = true;
  g.add(base);
  const n = 14 + Math.floor(rand() * 10);
  for (let i = 0; i < n; i++) {
    const bx = (rand() - 0.5) * 0.24 * scale;
    const bz = (rand() - 0.5) * 0.24 * scale;
    const by = 0.06 + rand() * 0.09 * scale;
    const pr = (0.024 + rand() * 0.018) * scale;
    const p = new THREE.Mesh(new THREE.SphereGeometry(pr, 8, 6), rand() < 0.55 ? fl : fl2);
    p.position.set(bx, by, bz);
    p.castShadow = false;
    g.add(p);
  }
  return g;
}

/**
 * Rhododendron / azalea-style clump: woody stem, glossy leaf lobes, dense magenta–violet trusses (LPCA layer stack).
 */
export function buildIdleCraftRhododendronClump(rand: () => number, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.name = 'idlecraft-rhodo-clump';
  const bark = stdBark();
  const leafA = physLeaf(0x1a4a28);
  const leafB = physLeaf(0x2a6a3a);
  const flowerHexes = [
    [0x7a3d9a, 0xb868d8],
    [0x8a4ab8, 0xd080e8],
    [0x9a5090, 0xe070a8],
    [0x6a48a8, 0xa070d8],
    [0xc85a78, 0xf090b0],
  ] as const;
  const fp = flowerHexes[Math.floor(rand() * flowerHexes.length)]!;
  const flo = heatherBloomMat(fp[0]);
  const floHi = heatherBloomMat(fp[1]);

  const s = (0.72 + rand() * 0.28) * scale;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035 * s, 0.048 * s, 0.2 * s, 8), bark);
  stem.position.y = 0.1 * s;
  stem.castShadow = true;
  g.add(stem);

  const nLeaf = 5 + Math.floor(rand() * 4);
  for (let i = 0; i < nLeaf; i++) {
    const ang = (i / nLeaf) * Math.PI * 2 + rand() * 0.4;
    const geo = new THREE.SphereGeometry((0.11 + rand() * 0.04) * s, 8, 6);
    geo.scale(1.15, 0.48, 0.72);
    const m = new THREE.Mesh(geo, i % 2 === 0 ? leafA : leafB);
    m.position.set(Math.cos(ang) * 0.1 * s, (0.22 + rand() * 0.06) * s, Math.sin(ang) * 0.1 * s);
    m.rotation.y = ang;
    m.rotation.x = -0.35 - rand() * 0.25;
    m.castShadow = true;
    g.add(m);
  }

  const nFl = 16 + Math.floor(rand() * 14);
  for (let i = 0; i < nFl; i++) {
    const cx = (rand() - 0.5) * 0.28 * s;
    const cz = (rand() - 0.5) * 0.28 * s;
    const cy = (0.26 + rand() * 0.17) * s;
    const pr = (0.028 + rand() * 0.022) * s;
    const mat = rand() < 0.58 ? flo : floHi;
    const b = new THREE.Mesh(new THREE.SphereGeometry(pr, 8, 6), mat);
    b.position.set(cx, cy, cz);
    b.castShadow = false;
    g.add(b);
  }
  return g;
}

/**
 * Ground-creeping vine: `TubeGeometry` along a wandering XZ path + lobed leaf chips (ivy / Vitis read).
 */
export function buildIdleCraftCreeperVine(rand: () => number, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.name = 'idlecraft-creeper-vine';
  const stemMat = stdLit('idle-creeper-stem', { color: 0x2a3830, roughness: 0.9, metalness: 0.02 });
  const leafA = physLeaf(0x3a6e42);
  const leafB = physLeaf(0x4a8850);
  const pts: THREE.Vector3[] = [];
  let x = 0;
  let z = 0;
  const steps = 8 + Math.floor(rand() * 7);
  const stepLen = (0.09 + rand() * 0.07) * scale;
  let ang = rand() * Math.PI * 2;
  for (let i = 0; i <= steps; i++) {
    ang += (rand() - 0.5) * 1.15;
    x += Math.cos(ang) * stepLen * (0.55 + rand() * 0.55);
    z += Math.sin(ang) * stepLen * (0.55 + rand() * 0.55);
    const y = (Math.sin(i * 0.62) * 0.012 + (rand() - 0.5) * 0.006) * scale;
    pts.push(new THREE.Vector3(x, y, z));
  }
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.42);
  const tubeR = (0.004 + rand() * 0.003) * scale;
  const tubular = Math.max(28, steps * 5);
  const tubeGeo = new THREE.TubeGeometry(curve, tubular, tubeR, 5, false);
  const stem = new THREE.Mesh(tubeGeo, stemMat);
  stem.castShadow = true;
  g.add(stem);

  const nLeaves = 5 + Math.floor(rand() * 7);
  for (let i = 0; i < nLeaves; i++) {
    const u = Math.min(0.96, 0.06 + (i / Math.max(1, nLeaves - 1)) * 0.88);
    const p = curve.getPointAt(u);
    const tang = curve.getTangentAt(u);
    const up = new THREE.Vector3(0, 1, 0);
    let side = new THREE.Vector3().crossVectors(tang, up);
    if (side.lengthSq() < 1e-6) side = new THREE.Vector3(1, 0, 0);
    side.normalize();
    const leafGeo = new THREE.SphereGeometry((0.018 + rand() * 0.014) * scale, 5, 4);
    leafGeo.scale(1.15, 0.32 + rand() * 0.12, 0.85 + rand() * 0.2);
    const lm = new THREE.Mesh(leafGeo, rand() < 0.5 ? leafA : leafB);
    lm.position.copy(p).addScaledVector(side, (0.012 + rand() * 0.01) * scale);
    lm.position.y += (0.008 + rand() * 0.006) * scale;
    lm.rotation.y = rand() * Math.PI * 2;
    lm.rotation.x = (rand() - 0.5) * 0.45;
    lm.castShadow = true;
    g.add(lm);
  }
  return g;
}

/**
 * Short draping vine: stem arcs from an implicit support toward the ground (forest edge / stump read).
 */
export function buildIdleCraftDrapeVine(rand: () => number, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.name = 'idlecraft-drape-vine';
  const stemMat = stdLit('idle-drape-stem', { color: 0x323c34, roughness: 0.91 });
  const leafA = physLeaf(0x2d6840);
  const leafB = physLeaf(0x3d8050);
  const h0 = (0.38 + rand() * 0.32) * scale;
  const reach = (0.16 + rand() * 0.24) * scale;
  const sway = (rand() - 0.5) * 0.14 * scale;
  const pts = [
    new THREE.Vector3(0, h0, 0),
    new THREE.Vector3(reach * 0.28 + sway * 0.3, h0 * 0.68, rand() * 0.05 * scale),
    new THREE.Vector3(reach * 0.55 + sway * 0.5, h0 * 0.35, rand() * 0.08 * scale),
    new THREE.Vector3(reach * (0.82 + rand() * 0.18) + sway, 0.015 * scale, rand() * 0.1 * scale),
  ];
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const tubeGeo = new THREE.TubeGeometry(curve, 22, (0.0038 + rand() * 0.0024) * scale, 5, false);
  const stem = new THREE.Mesh(tubeGeo, stemMat);
  stem.castShadow = true;
  g.add(stem);
  const nLeaves = 3 + Math.floor(rand() * 4);
  for (let i = 0; i < nLeaves; i++) {
    const u = 0.12 + (i / Math.max(1, nLeaves)) * 0.78;
    const p = curve.getPointAt(u);
    const tang = curve.getTangentAt(u);
    const up = new THREE.Vector3(0, 1, 0);
    let side = new THREE.Vector3().crossVectors(tang, up);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    const leafGeo = new THREE.SphereGeometry((0.016 + rand() * 0.01) * scale, 5, 4);
    leafGeo.scale(0.95, 0.38, 0.72);
    const lm = new THREE.Mesh(leafGeo, rand() < 0.45 ? leafA : leafB);
    lm.position.copy(p).addScaledVector(side, 0.014 * scale);
    lm.rotation.z = (rand() - 0.5) * 0.6;
    lm.castShadow = true;
    g.add(lm);
  }
  return g;
}

/** Irregular moss / liverwort pad — low lumps for litter layer. */
export function buildIdleCraftMossClump(rand: () => number, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.name = 'idlecraft-moss-clump';
  const mA = physLeaf(0x3a5a42);
  const mB = physLeaf(0x4a6a50);
  const n = 5 + Math.floor(rand() * 6);
  for (let i = 0; i < n; i++) {
    const lump = new THREE.Mesh(new THREE.SphereGeometry((0.035 + rand() * 0.028) * scale, 6, 5), rand() < 0.5 ? mA : mB);
    lump.position.set((rand() - 0.5) * 0.16 * scale, rand() * 0.02 * scale, (rand() - 0.5) * 0.16 * scale);
    lump.scale.set(1 + rand() * 0.35, 0.28 + rand() * 0.18, 1 + rand() * 0.35);
    lump.castShadow = true;
    g.add(lump);
  }
  return g;
}

/** Raised garden bed — readable vegetable/herb silhouettes: stems, paired leaf blades, rosettes, fruit. */
export function buildIdleCraftGardenBed(rand: () => number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'idlecraft-garden-bed';
  const wood = stdLit('idle-garden-wood', { color: 0x5c4030, roughness: 0.88 });
  const soil = stdLit('idle-garden-soil', { color: 0x3d3028, roughness: 0.94 });
  const stemDark = stdLit('idle-garden-stem', { color: 0x2d6a38, roughness: 0.78, metalness: 0.02 });
  const leafDeep = physLeaf(0x2a6e32);
  const leafMid = physLeaf(0x3d8a45);
  const leafTip = physLeaf(0x5cba62);
  const fruit = physGloss('idle-garden-fruit', {
    color: 0xd84a3a,
    roughness: 0.35,
    transmission: 0.08,
    thickness: 0.05,
    envMapIntensity: 1.2,
  });

  const w = 0.52;
  const d = 0.38;
  const h = 0.055;
  const soilY = h + 0.02;
  const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.06, h, d + 0.06), wood);
  frame.position.y = h / 2;
  frame.castShadow = true;
  g.add(frame);
  const soilTop = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, 0.035, d * 0.9), soil);
  soilTop.position.y = soilY;
  soilTop.receiveShadow = true;
  g.add(soilTop);

  function addLeafBlade(
    px: number,
    py: number,
    pz: number,
    mat: THREE.MeshPhysicalMaterial,
    tiltZ: number,
    tiltX: number,
    len: number,
  ): void {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(len, 0.008, 0.04), mat);
    blade.position.set(px, py, pz);
    blade.rotation.set(tiltX, (rand() - 0.5) * 0.25, tiltZ);
    blade.castShadow = true;
    g.add(blade);
  }

  function addPlantCluster(cx: number, cz: number, tall: boolean): void {
    const baseY = soilY + 0.02;
    const stemH = tall ? 0.2 + rand() * 0.14 : 0.06 + rand() * 0.04;
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.014, stemH, 7),
      stemDark,
    );
    stem.position.set(cx, baseY + stemH / 2, cz);
    stem.rotation.z = (rand() - 0.5) * 0.12;
    stem.rotation.x = (rand() - 0.5) * 0.1;
    stem.castShadow = true;
    g.add(stem);

    const topY = baseY + stemH;
    if (tall) {
      for (let b = 0; b < 5; b++) {
        const ang = (b / 5) * Math.PI * 2 + rand() * 0.4;
        const reach = 0.05 + rand() * 0.05;
        addLeafBlade(
          cx + Math.cos(ang) * reach * 0.3,
          topY - 0.02 + b * 0.028,
          cz + Math.sin(ang) * reach * 0.3,
          b % 2 === 0 ? leafMid : leafDeep,
          ang * 0.35,
          0.35 + rand() * 0.25,
          0.07 + rand() * 0.03,
        );
      }
      if (rand() > 0.25) {
        const fr = new THREE.Mesh(new THREE.SphereGeometry(0.026, 8, 6), fruit);
        fr.position.set(cx + (rand() - 0.5) * 0.03, topY + 0.04, cz + (rand() - 0.5) * 0.03);
        fr.castShadow = true;
        g.add(fr);
      }
    } else {
      /* Low rosette — many short blades from crown */
      for (let r = 0; r < 7; r++) {
        const ang = (r / 7) * Math.PI * 2;
        addLeafBlade(
          cx + Math.cos(ang) * 0.04,
          baseY + 0.035,
          cz + Math.sin(ang) * 0.04,
          r % 3 === 0 ? leafTip : leafMid,
          ang + (rand() - 0.5) * 0.2,
          0.55 + rand() * 0.15,
          0.055 + rand() * 0.02,
        );
      }
    }
  }

  const placements: { x: number; z: number; tall: boolean }[] = [
    { x: -0.14, z: -0.08, tall: true },
    { x: 0.06, z: 0.06, tall: false },
    { x: 0.15, z: -0.1, tall: true },
    { x: -0.08, z: 0.1, tall: false },
    { x: 0.12, z: 0.12, tall: true },
    { x: -0.16, z: 0.05, tall: false },
  ];
  for (const p of placements) {
    addPlantCluster(p.x, p.z, p.tall);
  }

  return g;
}
