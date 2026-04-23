/**
 * Night forest bioluminescence — LPCA + merge-by-material.
 *
 * **Research (fantasy / MMO VFX):** Games like WoW and FFXIV lean on **additive** particles (soft
 * quads or point sprites), **layered** color (cool cyan/violet + warm pink accents), and **modest**
 * mesh emissive so the bulk of “magic” reads from particles—not a single blown-out sphere. With
 * project bloom often off, we use **PBR bodies** (MeshPhysicalMaterial) + **trailing dust** (GPU * points) instead of huge halos.
 *
 * Patches hug gather anchors, dock ring, path to water, and **riparian strips** (both creek banks).
 * Fairies: **instanced** silhouette (5 PBR materials + shared geo) + ring-buffer **spark trail** (1 draw).
 * Active fairy count eases with night visibility so work and overdraw ramp smoothly.
 */
import * as THREE from 'three';
import { mergeByMaterial } from 'empire-engine/lpca';
import type { ResolvedCreek } from '../world/idleCraftHeightfield';
import { minDistToCreekNetwork } from '../world/idleCraftHeightfield';
import type { IdleCraftDockEnvironment } from '../world/idleCraftDockEnvironment';
import type { GatherAnchor } from '../world/idleCraftGatherWorld';
import { gatherSurroundOffsets } from '../world/idleCraftGatherWorld';

const THREAD_MAT = new THREE.MeshStandardMaterial({
  color: 0x3a3548,
  roughness: 0.88,
  metalness: 0.02,
});

/* === 2026-04-22 cap-style materials removed ===
 * `STALK_MAT`, `makeSharedCapMaterials`, `pickCap`, `makeFoxfireMaterials`
 * were all part of the deleted bracket-cap pattern that produced
 * floating-in-space caps near tree trunks. Replaced 2026-04-22 by the
 * mycelium thread + node sphere pattern (using `THREAD_MAT` and the
 * shared `nodeMat` from `makeSharedNodeMaterial` below) which matches the
 * dense glowing fungi style the player wanted everywhere. */

function makeSharedNodeMaterial(emissiveMats: THREE.MeshStandardMaterial[]): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0x66ffaa,
    metalness: 0.06,
    roughness: 0.42,
    emissive: new THREE.Color(0x88ffcc),
    /* === 2026-04-22 emissive bumped 0.72 → 1.15 ===
     * Player report: the dense fungi patch near character spawn glows
     * brighter than the rest. That patch's brightness comes from 8
     * overlapping `gatherSurroundOffsets` patches in a tiny ~10 cm area —
     * the OVERLAP makes the additive emissive contribution roughly 3-4×
     * a single patch. Bumping per-node intensity raises the baseline so
     * lone-cluster patches read closer to the spawn-area density without
     * needing geometry duplication. */
    emissiveIntensity: 1.15,
  });
  m.userData.baseEmissive = m.emissiveIntensity;
  emissiveMats.push(m);
  return m;
}

function trunkHeightApprox(species: number, sm: number): number {
  if (species === 1) return 1.05 * sm * 0.95 * 1.08;
  if (species === 2) return 0.95 * sm * 0.98;
  if (species === 3) return 1.02 * sm;
  if (species === 4) return 0.96 * sm;
  return 0.92 * sm;
}

/**
 * Horizontal clearance from local tree axis so bioluminescent meshes sit on bark / needle shell,
 * matching {@link buildIdleCraftPineTree} / birch / apple radii (not inside merged trunk volume).
 */
function bioLumeShellRadius(species: number, sm: number, yAlongTrunk: number, hTrunk: number): number {
  const yn = THREE.MathUtils.clamp(yAlongTrunk / Math.max(0.08, hTrunk), 0, 1);
  if (species === 1) {
    const trunkR = THREE.MathUtils.lerp(0.055, 0.022, yn) * sm;
    const coneShell = yn > 0.32 ? (0.1 + (yn - 0.32) * 0.52) * sm : 0;
    return Math.max(trunkR, coneShell) + (0.026 + yn * 0.018) * sm;
  }
  if (species === 3) {
    const trunkR = THREE.MathUtils.lerp(0.052, 0.024, yn) * sm;
    const fluffShell = yn > 0.26 ? (0.12 + (yn - 0.26) * 0.58) * sm : 0;
    return Math.max(trunkR, fluffShell) + (0.028 + yn * 0.02) * sm;
  }
  if (species === 2) {
    const trunkR = THREE.MathUtils.lerp(0.06, 0.034, yn) * sm;
    return trunkR + (0.028 + (1 - yn) * 0.012) * sm;
  }
  const trunkR = THREE.MathUtils.lerp(species === 4 ? 0.086 : 0.08, species === 4 ? 0.03 : 0.028, yn) * sm;
  const crownBoost = yn > (species === 4 ? 0.42 : 0.48) ? (yn - (species === 4 ? 0.42 : 0.48)) * (species === 4 ? 0.4 : 0.34) * sm : 0;
  return trunkR + crownBoost + (0.03 + (1 - yn) * 0.015) * sm;
}

/* === 2026-04-22 addFoxfireToTree + addBracketClusterToTree removed ===
 * Both placed geometry at species-approximated trunk radii via
 * `bioLumeShellRadius`, which works mathematically but didn't visually
 * match the actual merged tree meshes — caps and streaks read as
 * floating in space near the trunks rather than ON the bark. Replaced by
 * `addBaseClimbingFungiToTree` (defined below) which uses the same
 * radius helper but anchors the geometry at the BASE (on the ground) +
 * climbs UP the trunk surface as a vertical strip — a much more
 * grounded read that the player sees as fungi colonies actually growing
 * on the trees, not floating around them. See player report 2026-04-22. */

/**
 * 2026-04-22 (revised) — proper bioluminescent mycelium fungi at the base
 * of trees + climbing up the trunk surface. Uses the SAME thread+node
 * pattern as the ground patches near character spawn (the style the
 * player explicitly asked for everywhere). NO cap-shaped meshes — those
 * were the "old broken bracket pattern" the player wanted entirely gone.
 *
 * Visual recipe:
 *   - **Ground wreath** at y ≈ 0 (terrain) — a `buildMyceliumGroundPatchInto`
 *     style scatter at the trunk base: 9-16 horizontal thread cylinders
 *     radiating outward + 5-10 small node spheres scattered in the patch.
 *     This is the SAME builder that produces the dense glowing patches
 *     near the character spawn.
 *   - **Vertical climb threads** running UP the trunk surface — 3-5
 *     mycelium thread cylinders oriented vertically (rotation.x = 0,
 *     rotation.z = 0 keeps them along Y) with 4-6 small node spheres
 *     placed along their length. Threads cluster around a primary
 *     "colony face" angle (±0.6 rad jitter) so the climb reads as a
 *     fungal colony spreading up one face of the trunk.
 *   - **Top crown** — 3-4 extra node spheres at the highest climb point
 *     where the colony "reaches" maximum height.
 *
 * All parented to `treeRoot` Group, all merged into `fungiBatch` after
 * the per-tree loop. The trees never disappear (backdrop forest, not
 * harvestable), so no orphan-on-chop possibility.
 */
function addBaseClimbingFungiToTree(
  treeRoot: THREE.Group,
  rand: () => number,
  sm: number,
  species: number,
  nodeMat: THREE.MeshStandardMaterial,
): void {
  const hTrunk = trunkHeightApprox(species, sm);
  /* Primary "colony face" angle — climb threads cluster around this with
   * ±0.6 rad jitter so the strip reads as one-sided spread, not a ring. */
  const baseAng = rand() * Math.PI * 2;

  /* === Ground wreath at trunk base ===
   * Uses the SAME `buildMyceliumGroundPatchInto` pattern as the ground
   * patches near spawn. Builds into a sub-group offset to the trunk
   * surface, then we drop the sub-group into treeRoot so the patch
   * stays at ground level around the bark. */
  const baseR = bioLumeShellRadius(species, sm, 0.04 * sm, hTrunk);
  const wreathRadius = (0.42 + rand() * 0.28) * sm;
  /* Build the patch INTO a sub-group at world Y = 0 of treeRoot (which
   * sits at terrain Y of the tree). */
  const wreathGroup = new THREE.Group();
  buildMyceliumGroundPatchInto(wreathGroup, rand, wreathRadius, nodeMat);
  /* Position the wreath so its center is at the trunk surface, slightly
   * radially offset on the colony face so it overlaps the trunk's foot
   * but spreads outward into the soil. */
  wreathGroup.position.set(
    Math.cos(baseAng) * baseR * 0.4,
    0,
    Math.sin(baseAng) * baseR * 0.4,
  );
  treeRoot.add(wreathGroup);

  /* === Vertical climb threads up the trunk surface ===
   * Each thread is a thin cylinder running along the trunk's vertical axis
   * at the bark surface, with small node spheres placed along its length.
   * Threads cluster on the colony face (random per-tree). */
  const climbThreadCount = 3 + Math.floor(rand() * 3);
  const climbStartY = 0.08 * hTrunk;
  const climbEndY = 0.55 * hTrunk;
  const climbLen = climbEndY - climbStartY;
  for (let i = 0; i < climbThreadCount; i++) {
    const ang = baseAng + (rand() - 0.5) * 1.2;
    /* Use trunk radius at MID climb height for thread positioning.
     * Threads are thin, so treat as a point-line on the bark surface. */
    const midY = (climbStartY + climbEndY) * 0.5;
    const trunkR = bioLumeShellRadius(species, sm, midY, hTrunk);
    const tx = Math.cos(ang) * trunkR;
    const tz = Math.sin(ang) * trunkR;

    /* Vertical mycelium thread (cylinder along Y axis by default). */
    const threadLen = climbLen * (0.5 + rand() * 0.4);
    const threadStartY = climbStartY + rand() * (climbLen - threadLen);
    const thread = new THREE.Mesh(
      new THREE.CylinderGeometry(0.005 * sm, 0.004 * sm, threadLen, 5),
      THREAD_MAT,
    );
    thread.position.set(tx, threadStartY + threadLen * 0.5, tz);
    /* Cylinders default to Y-axis = vertical, which is what we want for
     * climbing threads — no rotation needed beyond a tiny tilt for
     * organic variation. */
    thread.rotation.z = (rand() - 0.5) * 0.15;
    thread.castShadow = false;
    treeRoot.add(thread);

    /* Node spheres along the thread (3-5 per thread). */
    const nodeCount = 3 + Math.floor(rand() * 3);
    for (let n = 0; n < nodeCount; n++) {
      const nodeT = (n + rand() * 0.4) / nodeCount;
      const ny = threadStartY + threadLen * nodeT;
      /* Slight outward nudge from the trunk surface so nodes don't
       * z-fight with the bark. */
      const outNudge = 0.008 * sm + rand() * 0.006 * sm;
      const node = new THREE.Mesh(
        new THREE.SphereGeometry(0.012 * sm + rand() * 0.01 * sm, 6, 5),
        nodeMat,
      );
      node.position.set(
        tx + Math.cos(ang) * outNudge,
        ny,
        tz + Math.sin(ang) * outNudge,
      );
      node.scale.setScalar(0.85 + rand() * 0.45);
      node.castShadow = false;
      treeRoot.add(node);
    }
  }

  /* === Top crown (3-4 extra nodes at the highest climb point) ===
   * Brighter cluster where the colony reaches maximum trunk height. */
  const crownCount = 3 + Math.floor(rand() * 2);
  for (let i = 0; i < crownCount; i++) {
    const ly = climbEndY + (rand() * 0.12 + 0.02) * sm;
    const ang = baseAng + (rand() - 0.5) * 1.6;
    const trunkR = bioLumeShellRadius(species, sm, ly, hTrunk);
    const outNudge = 0.012 * sm;
    const node = new THREE.Mesh(
      new THREE.SphereGeometry(0.014 * sm + rand() * 0.012 * sm, 6, 5),
      nodeMat,
    );
    node.position.set(
      Math.cos(ang) * trunkR + Math.cos(ang) * outNudge,
      ly,
      Math.sin(ang) * trunkR + Math.sin(ang) * outNudge,
    );
    node.scale.setScalar(0.9 + rand() * 0.5);
    node.castShadow = false;
    treeRoot.add(node);
  }
}

/* === 2026-04-22 trunkBandY / midTrunkBandY / crownBandY removed ===
 * These per-species Y-position helpers were only consumed by
 * `addBracketClusterToTree` (3 calls) + the per-tree mid-Y light
 * placement. Both call sites are gone (tree fungi now use
 * `addBaseClimbingFungiToTree` which derives Y positions internally
 * from `trunkHeightApprox`; the light placement uses a simple
 * `trunkHeightApprox * 0.42`). */

function buildMyceliumGroundPatchInto(
  g: THREE.Group,
  rand: () => number,
  radius: number,
  nodeMat: THREE.MeshStandardMaterial,
): void {
  const nThreads = 9 + Math.floor(rand() * 7);
  for (let i = 0; i < nThreads; i++) {
    const ang = (i / nThreads) * Math.PI * 2 + rand() * 0.4;
    const len = radius * (0.35 + rand() * 0.55);
    const tube = new THREE.Mesh(
      new THREE.CylinderGeometry(0.003 * radius, 0.002 * radius, len, 5),
      THREAD_MAT,
    );
    tube.rotation.z = Math.PI / 2;
    tube.rotation.y = ang;
    tube.position.set(Math.cos(ang) * len * 0.35, 0.002, Math.sin(ang) * len * 0.35);
    tube.castShadow = false;
    g.add(tube);
  }
  const nNodes = 5 + Math.floor(rand() * 5);
  for (let j = 0; j < nNodes; j++) {
    const rr = radius * (0.15 + rand() * 0.75);
    const th = rand() * Math.PI * 2;
    const nd = new THREE.Mesh(
      new THREE.SphereGeometry(0.012 * radius + rand() * 0.012, 6, 5),
      nodeMat,
    );
    nd.position.set(Math.cos(th) * rr, 0.008 + rand() * 0.012, Math.sin(th) * rr);
    nd.scale.setScalar(0.85 + rand() * 0.45);
    nd.castShadow = false;
    g.add(nd);
  }
}

function uniqueEmissive(hex: number, emissiveIntensity: number, roughness = 0.42): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: hex,
    metalness: 0.06,
    roughness,
    emissive: new THREE.Color(hex),
    emissiveIntensity,
  });
}

function buildWisp(rand: () => number, sm: number, owned: THREE.MeshStandardMaterial[]): THREE.Group {
  const g = new THREE.Group();
  const col = rand() < 0.5 ? 0xa8eeff : 0xffcc88;
  const mat = uniqueEmissive(col, 0.95 + rand() * 0.35, 0.28);
  owned.push(mat);
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.05 * sm, 0), mat);
  core.castShadow = false;
  g.add(core);
  const haloMat = uniqueEmissive(col, 0.28, 0.55);
  haloMat.transparent = true;
  haloMat.opacity = 0.38;
  owned.push(haloMat);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.085 * sm, 8, 6), haloMat);
  halo.castShadow = false;
  g.add(halo);
  const light = new THREE.PointLight(col, 0.36, 0, 2);
  light.decay = 2;
  light.distance = 5.5 + rand() * 3;
  light.userData.baseIntensity = light.intensity;
  g.add(light);
  g.userData.light = light;
  return g;
}

function buildGlowMoth(rand: () => number, sm: number, owned: THREE.MeshStandardMaterial[]): THREE.Group {
  const g = new THREE.Group();
  const col = rand() < 0.45 ? 0xcc88ff : 0x88aaff;
  const bodyMat = uniqueEmissive(0x4a3860, 0.36, 0.62);
  owned.push(bodyMat);
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.026 * sm, 6, 5), bodyMat);
  body.scale.set(0.75, 1.15, 0.85);
  g.add(body);
  const wingMat = uniqueEmissive(col, 0.65 + rand() * 0.3, 0.35);
  owned.push(wingMat);
  for (const side of [-1, 1] as const) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(0.13 * sm, 0.075 * sm, 1, 1), wingMat);
    w.position.set(side * 0.052 * sm, 0.01 * sm, 0);
    w.rotation.y = side * 0.35;
    w.rotation.z = side * 0.2;
    g.add(w);
  }
  const light = new THREE.PointLight(col, 0.28, 0, 2);
  light.decay = 2;
  light.distance = 4.5 + rand() * 2.5;
  light.userData.baseIntensity = light.intensity;
  g.add(light);
  g.userData.light = light;
  return g;
}

export type IdleCraftNightMagicParams = {
  getHeightAt: (x: number, z: number) => number;
  dockCx: number;
  dockCz: number;
  ringMul: number;
  placements: readonly [number, number, number, number][];
  resolved: ResolvedCreek[];
  gatherAnchors: GatherAnchor[];
  /** Mobile / low tier: fewer lights, fairies, and ground patches. */
  nightMagicQuality?: 'full' | 'reduced';
};

/** Cool / warm fantasy accents — dust RGB matches wing family (additive trail reads the magic). */
type FairyPaletteDef = {
  body: number;
  bodyEmissive: number;
  /** Secondary glim hue — lerps with bodyEmissive over time for living light. */
  glimHueB: number;
  wing: number;
  dust: THREE.Color;
};

const FAIRY_PALETTE_COUNT = 5;

const FAIRY_PALETTES: FairyPaletteDef[] = [
  {
    body: 0x4a3248,
    bodyEmissive: 0xff4da6,
    glimHueB: 0xffb8f0,
    wing: 0xff66b8,
    dust: new THREE.Color(0xff8cc8),
  },
  {
    body: 0x2c3a58,
    bodyEmissive: 0x58b4ff,
    glimHueB: 0xa8f0ff,
    wing: 0x78c8ff,
    dust: new THREE.Color(0x9bd8ff),
  },
  {
    body: 0x453866,
    bodyEmissive: 0xa880ff,
    glimHueB: 0xffc8ff,
    wing: 0xc4a0ff,
    dust: new THREE.Color(0xd8b8ff),
  },
  {
    body: 0x4c3848,
    bodyEmissive: 0xff7eb3,
    glimHueB: 0xffd0a0,
    wing: 0xff9cc8,
    dust: new THREE.Color(0xffb0d8),
  },
  {
    body: 0x304850,
    bodyEmissive: 0x5ee0e8,
    glimHueB: 0xb8fff0,
    wing: 0x7aeef5,
    dust: new THREE.Color(0xa0f5fa),
  },
];

/** Organic bulge on convex glow mesh — reads less “billiard ball”, cheap once at init. */
function displaceGlowBlob(geo: THREE.BufferGeometry, strength: number): void {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    const n =
      Math.sin(x * 31.2 + y * 19.7 + z * 27.4) * 0.55 +
      Math.sin(x * 12.1 - z * 18.3) * 0.35;
    const disp = n * strength;
    pos.setXYZ(
      i,
      x + (x / len) * disp,
      y + (y / len) * disp * 0.82,
      z + (z / len) * disp,
    );
  }
  geo.computeVertexNormals();
}

function sampleRiparianBankXZ(
  resolved: ResolvedCreek[],
  dockCx: number,
  dockCz: number,
  ringMul: number,
  pr: () => number,
  maxAttempts: number,
): [number, number] | null {
  if (!resolved.length) return null;
  for (let att = 0; att < maxAttempts; att++) {
    const c = resolved[Math.floor(pr() * resolved.length)]!;
    if (c.points.length < 2) continue;
    const seg = Math.floor(pr() * (c.points.length - 1));
    const a = c.points[seg]!;
    const b = c.points[seg + 1]!;
    const tr = pr();
    const mx = a[0] + (b[0] - a[0]) * tr;
    const mz = a[1] + (b[1] - a[1]) * tr;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const sl = Math.hypot(dx, dz) || 1;
    const px = -dz / sl;
    const pz = dx / sl;
    const side = pr() < 0.5 ? -1 : 1;
    const off = c.halfWidth * (1.55 + pr() * 0.65) + 0.12;
    const wx = mx + px * off * side;
    const wz = mz + pz * off * side;
    const dist = minDistToCreekNetwork(wx, wz, resolved);
    if (dist < 0.36 || dist > 1.65) continue;
    const dDock = Math.hypot(wx - dockCx, wz - dockCz);
    if (dDock > Math.min(14.5, ringMul * 3.35)) continue;
    return [wx, wz];
  }
  return null;
}

function computeFairyBasePositions(
  n: number,
  dockCx: number,
  dockCz: number,
  ringMul: number,
  getHeightAt: (x: number, z: number) => number,
  resolved: ResolvedCreek[],
  pr: () => number,
): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  /* Fairy spread radius (Phase 8j night-magic spread pass — user request:
   * "we need them more spread across the map in awakened mode"). The legacy
   * `Math.min(12.5, ringMul * 2.9)` capped fairies inside a ~12.5 m disc
   * even on the awakened map (radius ~44 m, ringMul ~8 → would naturally
   * spread to 23 m). Removed the hard cap so fairies fill the larger map.
   * The InstancedMesh pipeline means more spread doesn't add draw calls;
   * only per-frame matrix updates which scale linearly + remain cheap. */
  const rMax = ringMul * 3.4;
  const rMin = 0.88;
  let i = 0;
  let guard = 0;
  while (i < n && guard < n * 80) {
    guard++;
    const t = (i + 0.37) / Math.max(1, n);
    const r = Math.sqrt(rMin * rMin + (rMax * rMax - rMin * rMin) * t);
    const th = i * golden + pr() * 0.62;
    let x = dockCx + Math.cos(th) * r;
    let z = dockCz + Math.sin(th) * r;
    x += (pr() - 0.5) * 1.25;
    z += (pr() - 0.5) * 1.25;
    if (minDistToCreekNetwork(x, z, resolved) < 0.48) continue;
    const y = getHeightAt(x, z) + 0.38 + pr() * 0.95;
    out.push({ x, y, z });
    i++;
  }
  while (out.length < n) {
    const s = sampleRiparianBankXZ(resolved, dockCx, dockCz, ringMul, pr, 40);
    if (!s) break;
    const y = getHeightAt(s[0], s[1]) + 0.42 + pr() * 0.75;
    out.push({ x: s[0], y, z: s[1] });
  }
  for (let k = 0; k < 4 && out.length >= k + 1; k++) {
    const s = sampleRiparianBankXZ(resolved, dockCx, dockCz, ringMul, pr, 35);
    if (!s) break;
    const y = getHeightAt(s[0], s[1]) + 0.45 + pr() * 0.7;
    out[out.length - 1 - (k % out.length)] = { x: s[0], y, z: s[1] };
  }
  return out;
}

/** Additive point-sprite trail (shader) — fantasy “pixie dust”, not a second mega-halo. */
class FairyDustTrail {
  readonly points: THREE.Points;
  private readonly geom: THREE.BufferGeometry;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly fadeAttr: Float32Array;
  private readonly history: Float32Array;
  private readonly trailLen: number;
  readonly fairyCount: number;

  constructor(fairyCount: number, trailLen: number) {
    this.trailLen = trailLen;
    this.fairyCount = fairyCount;
    const n = fairyCount * trailLen;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.fadeAttr = new Float32Array(n);
    this.history = new Float32Array(fairyCount * trailLen * 3);
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('instanceColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('fade', new THREE.BufferAttribute(this.fadeAttr, 1).setUsage(THREE.DynamicDrawUsage));

    const mat = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: `
        attribute vec3 instanceColor;
        attribute float fade;
        varying vec3 vColor;
        varying float vFade;
        void main() {
          vColor = instanceColor;
          vFade = fade;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          float dist = max(0.1, -mvPosition.z);
          float px = mix(0.95, 2.5, fade) * (220.0 / dist);
          gl_PointSize = clamp(px, 0.65, 22.0);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vFade;
        void main() {
          vec2 c = gl_PointCoord - vec2(0.5);
          float d = length(c);
          float soft = 1.0 - smoothstep(0.36, 0.54, d);
          if (soft < 0.015) discard;
          gl_FragColor = vec4(vColor * soft * vFade * 1.18, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });

    this.points = new THREE.Points(this.geom, mat);
    this.points.frustumCulled = false;
  }

  seedHistory(bases: { x: number; y: number; z: number }[]): void {
    for (let fi = 0; fi < this.fairyCount; fi++) {
      const b = bases[fi] ?? bases[0]!;
      const base = fi * this.trailLen * 3;
      for (let k = 0; k < this.trailLen; k++) {
        this.history[base + k * 3] = b.x;
        this.history[base + k * 3 + 1] = b.y;
        this.history[base + k * 3 + 2] = b.z;
      }
    }
  }

  setFairyTrail(fi: number, x: number, y: number, z: number, dustRgb: THREE.Color, strength: number): void {
    const base = fi * this.trailLen * 3;
    for (let k = this.trailLen - 1; k > 0; k--) {
      const dst = base + k * 3;
      const src = base + (k - 1) * 3;
      this.history[dst] = this.history[src]!;
      this.history[dst + 1] = this.history[src + 1]!;
      this.history[dst + 2] = this.history[src + 2]!;
    }
    this.history[base] = x;
    this.history[base + 1] = y;
    this.history[base + 2] = z;

    const st = THREE.MathUtils.clamp(strength, 0, 1);
    for (let k = 0; k < this.trailLen; k++) {
      const bufI = fi * this.trailLen + k;
      const hI = base + k * 3;
      this.pos[bufI * 3] = this.history[hI]!;
      this.pos[bufI * 3 + 1] = this.history[hI + 1]!;
      this.pos[bufI * 3 + 2] = this.history[hI + 2]!;
      const age = k / Math.max(1, this.trailLen - 1);
      const falloff = (1 - age);
      const f = falloff * falloff * st;
      this.fadeAttr[bufI] = f;
      const pulse = 0.75 + 0.25 * f;
      this.col[bufI * 3] = dustRgb.r * pulse;
      this.col[bufI * 3 + 1] = dustRgb.g * pulse;
      this.col[bufI * 3 + 2] = dustRgb.b * pulse;
    }
  }

  markDirty(): void {
    const pa = this.geom.attributes.position as THREE.BufferAttribute;
    const ca = this.geom.attributes.instanceColor as THREE.BufferAttribute;
    const fa = this.geom.attributes.fade as THREE.BufferAttribute;
    pa.needsUpdate = true;
    ca.needsUpdate = true;
    fa.needsUpdate = true;
  }

  /** Inactive fairies: no history shift; zero fade so GPU skips contribution. */
  zeroFairyTrail(fi: number): void {
    const base = fi * this.trailLen;
    for (let k = 0; k < this.trailLen; k++) {
      const bufI = base + k;
      this.fadeAttr[bufI] = 0;
    }
  }

  setVisible(v: boolean): void {
    this.points.visible = v;
  }

  dispose(): void {
    this.geom.dispose();
    (this.points.material as THREE.ShaderMaterial).dispose();
  }
}

const _fM0 = new THREE.Matrix4();
const _fM1 = new THREE.Matrix4();
const _fM2 = new THREE.Matrix4();
const _fV = new THREE.Vector3();
const _fQ = new THREE.Quaternion();
const _fS = new THREE.Vector3();
const _fEuler = new THREE.Euler();

/** Body / wings / glim / flight orbit vs forest — tune down if sprites dominate the grove. */
const NIGHT_FAIRY_SCALE = 0.3;

/**
 * Single PBR material for all fairy bodies: **per-instance emissive tint** via `instanceEmissiveTint`
 * (InstancedBufferAttribute) × night-scaled `emissive` uniform; **per-instance albedo** via
 * {@link THREE.InstancedMesh#setColorAt} (built-in `USE_INSTANCING_COLOR`).
 */
function makeFairyInstancedBodyMaterial(emissiveReg: THREE.MeshStandardMaterial[]): THREE.MeshPhysicalMaterial {
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 0.34,
    metalness: 0.08,
    roughness: 0.36,
    clearcoat: 0.52,
    clearcoatRoughness: 0.38,
    iridescence: 0.42,
    iridescenceIOR: 1.45,
    iridescenceThicknessRange: [90, 380],
  });
  bodyMat.userData.baseEmissive = bodyMat.emissiveIntensity;
  emissiveReg.push(bodyMat);

  bodyMat.customProgramCacheKey = () => 'idlecraft:fairyBody:ieTint:v2';

  bodyMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <color_pars_vertex>',
      `#include <color_pars_vertex>
attribute vec3 instanceEmissiveTint;
varying vec3 vInstanceEmissiveTint;`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <color_vertex>',
      `#include <color_vertex>
vInstanceEmissiveTint = instanceEmissiveTint;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_pars_fragment>',
      `#include <color_pars_fragment>
varying vec3 vInstanceEmissiveTint;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
totalEmissiveRadiance *= vInstanceEmissiveTint;`,
    );
  };

  return bodyMat;
}

function setInstancesHidden(mesh: THREE.InstancedMesh, count: number): void {
  _fV.set(0, -999, 0);
  _fQ.identity();
  _fS.set(1e-6, 1e-6, 1e-6);
  _fM0.compose(_fV, _fQ, _fS);
  for (let s = 0; s < count; s++) {
    mesh.setMatrixAt(s, _fM0);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

/**
 * **Draw budget:** 3 InstancedMesh (body + wings + glim) + 1 Points trail — body uses custom * instance emissive tint shader; wings/glim use `setColorAt` (single material each).
 */
type NightFairySwarmUpdateOpts = {
  maxActiveCap?: number;
  slowRatioRamp?: boolean;
};

class NightFairySwarm {
  readonly trail: FairyDustTrail;
  readonly count: number;
  private readonly phases: Float32Array;
  private readonly speeds: Float32Array;
  private readonly radii: Float32Array;
  private readonly baseX: Float32Array;
  private readonly baseY: Float32Array;
  private readonly baseZ: Float32Array;
  private readonly palettes: FairyPaletteDef[];
  private ratioSmoothed = 0;
  private readonly bodyInst: THREE.InstancedMesh;
  private readonly wingInst: THREE.InstancedMesh;
  private readonly glimInst: THREE.InstancedMesh;
  private readonly wingMat: THREE.MeshBasicMaterial;
  private readonly glimMat: THREE.MeshBasicMaterial;
  private readonly bodyGeo: THREE.BufferGeometry;
  private readonly wingGeo: THREE.BufferGeometry;
  private readonly glimGeo: THREE.BufferGeometry;
  private readonly _glimMixA = new THREE.Color();
  private readonly _glimMixB = new THREE.Color();
  private readonly _glimOut = new THREE.Color();
  private readonly _glimRim = new THREE.Color();

  constructor(
    bases: { x: number; y: number; z: number }[],
    emissiveReg: THREE.MeshStandardMaterial[],
    owned: THREE.Material[],
    pr: () => number,
  ) {
    this.count = bases.length;
    this.phases = new Float32Array(this.count);
    this.speeds = new Float32Array(this.count);
    this.radii = new Float32Array(this.count);
    this.baseX = new Float32Array(this.count);
    this.baseY = new Float32Array(this.count);
    this.baseZ = new Float32Array(this.count);
    this.palettes = [];

    const tmpC = new THREE.Color();
    for (let i = 0; i < this.count; i++) {
      const p = i % FAIRY_PALETTE_COUNT;
      this.phases[i] = pr() * Math.PI * 2;
      this.speeds[i] = 0.55 + pr() * 0.95;
      this.radii[i] = (0.22 + pr() * 0.52) * NIGHT_FAIRY_SCALE;
      const b = bases[i]!;
      this.baseX[i] = b.x;
      this.baseY[i] = b.y;
      this.baseZ[i] = b.z;
      this.palettes.push(FAIRY_PALETTES[p]!);
    }

    const fs = NIGHT_FAIRY_SCALE;
    this.bodyGeo = new THREE.SphereGeometry(0.0185 * fs, 10, 8);
    this.bodyGeo.scale(0.78, 1.12, 0.72);
    this.wingGeo = new THREE.PlaneGeometry(0.076 * fs, 0.048 * fs);
    this.glimGeo = new THREE.IcosahedronGeometry(0.0058 * fs, 1);
    displaceGlowBlob(this.glimGeo, 0.0028 * fs);

    const emTint = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      tmpC.setHex(this.palettes[i]!.bodyEmissive);
      emTint[i * 3] = tmpC.r;
      emTint[i * 3 + 1] = tmpC.g;
      emTint[i * 3 + 2] = tmpC.b;
    }
    this.bodyGeo.setAttribute('instanceEmissiveTint', new THREE.InstancedBufferAttribute(emTint, 3));

    const trailLen = 15;
    this.trail = new FairyDustTrail(this.count, trailLen);
    this.trail.seedHistory(bases);

    const bodyMat = makeFairyInstancedBodyMaterial(emissiveReg);
    const body = new THREE.InstancedMesh(this.bodyGeo, bodyMat, this.count);
    body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    body.frustumCulled = false;
    body.castShadow = false;
    body.receiveShadow = false;
    for (let i = 0; i < this.count; i++) {
      tmpC.setHex(this.palettes[i]!.body);
      body.setColorAt(i, tmpC);
    }
    if (body.instanceColor) body.instanceColor.needsUpdate = true;

    this.wingMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    owned.push(this.wingMat);
    const wings = new THREE.InstancedMesh(this.wingGeo, this.wingMat, this.count * 2);
    wings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    wings.frustumCulled = false;
    wings.castShadow = false;
    for (let i = 0; i < this.count; i++) {
      tmpC.setHex(this.palettes[i]!.wing);
      wings.setColorAt(i * 2, tmpC);
      wings.setColorAt(i * 2 + 1, tmpC);
    }
    if (wings.instanceColor) wings.instanceColor.needsUpdate = true;

    this.glimMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    owned.push(this.glimMat);
    const glim = new THREE.InstancedMesh(this.glimGeo, this.glimMat, this.count);
    glim.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    glim.frustumCulled = false;
    glim.castShadow = false;
    for (let i = 0; i < this.count; i++) {
      tmpC.setHex(this.palettes[i]!.bodyEmissive);
      glim.setColorAt(i, tmpC);
    }
    if (glim.instanceColor) glim.instanceColor.needsUpdate = true;

    setInstancesHidden(body, this.count);
    setInstancesHidden(wings, this.count * 2);
    setInstancesHidden(glim, this.count);

    this.bodyInst = body;
    this.wingInst = wings;
    this.glimInst = glim;
  }

  addTo(parent: THREE.Group): void {
    parent.add(this.bodyInst);
    parent.add(this.wingInst);
    parent.add(this.glimInst);
    parent.add(this.trail.points);
  }

  update(dt: number, t: number, strength: number, opts?: NightFairySwarmUpdateOpts): void {
    const st = THREE.MathUtils.clamp(strength, 0, 1);
    const dtEff = Math.max(dt, 1e-4);

    if (st < 0.018) {
      this.ratioSmoothed = Math.max(0, this.ratioSmoothed - dtEff * 0.42);
    } else {
      const targetRatio = THREE.MathUtils.smoothstep(st, 0.06, 0.94);
      const rampTau = opts?.slowRatioRamp === true ? 0.22 : 0.52;
      const k = 1 - Math.exp(-dtEff * rampTau);
      this.ratioSmoothed = THREE.MathUtils.lerp(this.ratioSmoothed, targetRatio, k);
    }

    let activeCount =
      this.count === 0 ? 0 : Math.min(this.count, Math.ceil(this.count * this.ratioSmoothed - 1e-6));
    if (opts?.maxActiveCap != null && opts.maxActiveCap > 0) {
      activeCount = Math.min(activeCount, opts.maxActiveCap);
    }

    /* Never toggle InstancedMesh.visible — that forces pipeline rebind hitches. Hide with zeroed matrices + transparent wings. */
    if (activeCount === 0 && this.ratioSmoothed < 0.008) {
      this.wingMat.opacity = 0;
      this.glimMat.opacity = 0;
      /* Trail: leave `points.visible = true` and hide via per-fairy `fade=0` (additive × 0 = no light).
       * Toggling `visible` would leave the trail's ShaderMaterial out of the boot `renderer.compile()`
       * and cause a first-use compile freeze at the first sunset (same pattern as the old moon disc). */
      for (let i = 0; i < this.count; i++) {
        _fV.set(0, -999, 0);
        _fQ.identity();
        _fS.set(1e-6, 1e-6, 1e-6);
        _fM2.compose(_fV, _fQ, _fS);
        this.bodyInst.setMatrixAt(i, _fM2);
        this.wingInst.setMatrixAt(i * 2, _fM2);
        this.wingInst.setMatrixAt(i * 2 + 1, _fM2);
        this.glimInst.setMatrixAt(i, _fM2);
        this.trail.zeroFairyTrail(i);
      }
      this.bodyInst.instanceMatrix.needsUpdate = true;
      this.wingInst.instanceMatrix.needsUpdate = true;
      this.glimInst.instanceMatrix.needsUpdate = true;
      this.trail.markDirty();
      return;
    }

    /* No `trail.setVisible` here — visibility stays on; fade/pos attributes gate the pixels. */

    const wingPulse = 0.14 + 0.12 * st + 0.06 * Math.sin(t * 3.6);
    const flap = Math.sin(t * 14);
    this.wingMat.opacity = wingPulse + 0.05 * flap;
    this.glimMat.opacity = 0.24 * st + 0.14 * flap * st + 0.06 * st * Math.sin(t * 2.2);

    let glimColorsDirty = false;

    _fQ.identity();

    for (let i = 0; i < this.count; i++) {
      const ph = this.phases[i]!;
      const sp = this.speeds[i]!;
      const rad = this.radii[i]!;
      const bx = this.baseX[i]!;
      const by = this.baseY[i]!;
      const bz = this.baseZ[i]!;

      if (i >= activeCount) {
        _fV.set(0, -999, 0);
        _fQ.identity();
        _fS.set(1e-6, 1e-6, 1e-6);
        _fM2.compose(_fV, _fQ, _fS);
        this.bodyInst.setMatrixAt(i, _fM2);
        this.wingInst.setMatrixAt(i * 2, _fM2);
        this.wingInst.setMatrixAt(i * 2 + 1, _fM2);
        this.glimInst.setMatrixAt(i, _fM2);
        this.trail.zeroFairyTrail(i);
        continue;
      }

      const fs = NIGHT_FAIRY_SCALE;
      const bob = Math.sin(t * (2.05 + (i % 5) * 0.07) + ph) * 0.082 * fs;
      const ox = Math.cos(t * sp * 0.62 + ph * 0.71) * rad;
      const oz = Math.sin(t * sp * 0.58 + ph * 0.79) * rad;
      const breeze =
        (Math.sin(t * 1.14 + bx * 0.41 + bz * 0.33 + ph * 0.2) * 0.048 * st +
          Math.cos(t * 0.88 + bz * 0.37) * 0.036 * st) *
        fs;
      const breezeZ =
        (Math.cos(t * 1.02 + bx * 0.29 + bz * 0.44) * 0.042 * st +
          Math.sin(t * 1.21 + bx * 0.51) * 0.028 * st) *
        fs;
      const px = bx + ox + breeze;
      const py = by + bob;
      const pz = bz + oz + breezeZ;
      const ry = t * 0.95 + ph * 0.3;

      _fQ.setFromAxisAngle(_fV.set(0, 1, 0), ry);
      _fV.set(px, py, pz);
      _fS.set(1, 1, 1);
      _fM0.compose(_fV, _fQ, _fS);

      _fQ.identity();
      _fV.set(0, 0.011 * fs, 0);
      _fS.set(1, 1, 1);
      _fM1.compose(_fV, _fQ, _fS);
      _fM2.multiplyMatrices(_fM0, _fM1);
      this.bodyInst.setMatrixAt(i, _fM2);

      _fEuler.set(0, -0.72, -0.14);
      _fQ.setFromEuler(_fEuler);
      _fV.set(-0.034 * fs, 0.013 * fs, 0);
      _fS.set(1, 1, 1);
      _fM1.compose(_fV, _fQ, _fS);
      _fM2.multiplyMatrices(_fM0, _fM1);
      this.wingInst.setMatrixAt(i * 2, _fM2);

      _fEuler.set(0, 0.72, 0.14);
      _fQ.setFromEuler(_fEuler);
      _fV.set(0.034 * fs, 0.013 * fs, 0);
      _fM1.compose(_fV, _fQ, _fS);
      _fM2.multiplyMatrices(_fM0, _fM1);
      this.wingInst.setMatrixAt(i * 2 + 1, _fM2);

      const wobA = Math.sin(t * (2.35 + sp * 0.35) + ph * 1.1);
      const wobB = Math.sin(t * 1.65 + ph * 0.85);
      const gsx = 0.58 + 0.2 * wobA;
      const gsy = 0.92 + 0.42 * wobB;
      const gsz = 0.55 + 0.18 * Math.cos(t * 2.05 + ph * 1.2);
      _fQ.setFromAxisAngle(_fV.set(0, 1, 0), t * (1.65 + (i % 4) * 0.08) + ph);
      _fV.set(0, 0.0165 * fs, 0);
      _fS.set(gsx, gsy, gsz);
      _fM1.compose(_fV, _fQ, _fS);
      _fM2.multiplyMatrices(_fM0, _fM1);
      this.glimInst.setMatrixAt(i, _fM2);

      const pal = this.palettes[i]!;
      const hueWave =
        0.5 +
        0.5 *
          Math.sin(
            t * (1.95 + (i % 5) * 0.12) + ph * 1.25 + Math.sin(t * 0.55 + i) * 0.35,
          );
      const rim = 0.22 * (0.5 + 0.5 * Math.sin(t * 3.1 + ph * 2));
      this._glimMixA.setHex(pal.bodyEmissive);
      this._glimMixB.setHex(pal.glimHueB);
      this._glimOut.copy(this._glimMixA).lerp(this._glimMixB, hueWave);
      this._glimRim.copy(this._glimMixB).lerp(this._glimMixA, 1 - hueWave);
      this._glimOut.lerp(this._glimRim, rim);
      this.glimInst.setColorAt(i, this._glimOut);
      glimColorsDirty = true;

      this.trail.setFairyTrail(i, px, py + 0.018 * fs, pz, pal.dust, st);
    }

    this.bodyInst.instanceMatrix.needsUpdate = true;
    this.wingInst.instanceMatrix.needsUpdate = true;
    this.glimInst.instanceMatrix.needsUpdate = true;
    if (glimColorsDirty && this.glimInst.instanceColor) this.glimInst.instanceColor.needsUpdate = true;
    this.trail.markDirty();
  }

  disposeGeometries(): void {
    this.trail.dispose();
    this.bodyGeo.dispose();
    this.wingGeo.dispose();
    this.glimGeo.dispose();
  }

  removeFromParent(): void {
    this.bodyInst.removeFromParent();
    this.wingInst.removeFromParent();
    this.glimInst.removeFromParent();
    this.trail.points.removeFromParent();
  }
}

export class IdleCraftNightMagicField {
  readonly root = new THREE.Group();
  private readonly emissiveMats: THREE.MeshStandardMaterial[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly patchLights: THREE.PointLight[] = [];
  private readonly motes: {
    group: THREE.Group;
    wx: number;
    wz: number;
    baseY: number;
    phase: number;
    speed: number;
    orbitR: number;
  }[] = [];
  private fairySwarm: NightFairySwarm | null = null;
  private t = 0;
  /** Short follow on already-smoothed visibility from dock (hides single-frame spikes). */
  private displayStrength = 0;
  /**
   * Latched once during the daylight skip so the per-frame "zero everything to dormant"
   * flush only happens once per night→day transition (instead of every frame all day).
   * Reset whenever visibility ramps back up so the next sunset re-flushes cleanly.
   */
  private dayQuietApplied = false;

  constructor(scene: THREE.Scene, p: IdleCraftNightMagicParams) {
    this.root.name = 'idlecraft-night-magic';
    scene.add(this.root);

    const reduced = p.nightMagicQuality === 'reduced';
    /* === 2026-04-22 tree-fungi coverage trimmed (player request) ===
     *
     * Was 0.015 (98.5 % of trees got a fungi cluster — saturation). Player
     * request: "this doesn't have to be every tree, just a few." Bumped to
     * 0.78 (full) / 0.85 (reduced) so the gate `if (rFn() > treeRingSkip)`
     * triggers on ~22 % / ~15 % of placements respectively. Combined with
     * the new `addBaseClimbingFungiToTree` (which makes the fungi actually
     * sit on the trunk surface instead of floating in space), the result
     * is a sparse, visually grounded fungi colony scatter rather than a
     * uniform cap-on-every-tree look. */
    const treeRingSkip = reduced ? 0.85 : 0.78;
    const treeLightModulo = reduced ? 8 : 4;

    const nodeMat = makeSharedNodeMaterial(this.emissiveMats);

    const fungiBatch = new THREE.Group();
    fungiBatch.name = 'night-fungi-batch';
    let treeLightIdx = 0;

    p.placements.forEach(([lx, lz, sc, species], idx) => {
      const rFn = forestRand(idx + 90211);
      if (rFn() > treeRingSkip) {
        const ringBoost = 1.22 + (idx % 6) * 0.045 + ((idx >> 3) % 4) * 0.03;
        const sm = 1.04 * sc * ringBoost;
        const wx = p.dockCx + lx * p.ringMul;
        const wz = p.dockCz + lz * p.ringMul;
        const ty = p.getHeightAt(wx, wz);
        const rotY = (idx * 0.37) % (Math.PI * 2);
        const treeRoot = new THREE.Group();
        treeRoot.position.set(wx, ty, wz);
        treeRoot.rotation.y = rotY;

        /* === 2026-04-22 base-climbing fungi (replaces broken brackets) ===
         *
         * Was: addFoxfireToTree (vertical streak strips floating in air) +
         * 1-3 calls to addBracketClusterToTree at trunkBandY / midTrunkBandY
         * / crownBandY (mid + upper-trunk clusters that read as floating
         * brackets near the tree, not on it). Player report: "the fungi
         * isn't on trees properly, it's floating in space."
         *
         * Now: ONE call to addBaseClimbingFungiToTree which builds a
         * grounded mycelium wreath at the trunk base + a vertical strip of
         * caps climbing up the trunk surface (using the species's exact
         * `bioLumeShellRadius` for trunk-bark contact). One-sided colony
         * angle gives the "fungi grew up one face of this tree" read
         * instead of a uniform ring. */
        addBaseClimbingFungiToTree(treeRoot, rFn, sm, species, nodeMat);

        fungiBatch.add(treeRoot);
        treeLightIdx++;
        if (treeLightIdx % treeLightModulo === 0) {
          /* Atmospheric point light near each fungi-bearing tree at mid-trunk
           * height — gives the trunk-climb a soft interior glow at night. */
          const midY = ty + trunkHeightApprox(species, sm) * 0.42;
          const pl = new THREE.PointLight(0x77eecc, 0.16, 0, 2);
          pl.decay = 2;
          pl.distance = 4.2 + rFn() * 1.9;
          pl.position.set(wx, midY, wz);
          pl.userData.baseIntensity = pl.intensity;
          this.root.add(pl);
          this.patchLights.push(pl);
        }
      }
    });

    fungiBatch.updateMatrixWorld(true);
    const mergedFungi = mergeByMaterial(fungiBatch);
    mergedFungi.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        (o as THREE.Mesh).castShadow = false;
        (o as THREE.Mesh).receiveShadow = false;
      }
    });
    this.root.add(mergedFungi);
    /* Bioluminescent fungi: keep static — wind reads wrong on tiny merged caps and user prefers no fungal sway. */

    const groundBatch = new THREE.Group();
    groundBatch.name = 'night-mycelium-batch';
    let patchLightsPlaced = 0;
    const maxGroundLights = reduced ? 6 : 11;
    let groundPatchSerial = 0;

    const tryAddGroundLight = (wx: number, y0: number, wz: number, pr: () => number, hex: number): void => {
      if (patchLightsPlaced >= maxGroundLights) return;
      if (groundPatchSerial % 4 !== 1) return;
      const pl = new THREE.PointLight(hex, 0.055 + pr() * 0.06, 0, 2);
      pl.decay = 2;
      pl.distance = 2.4 + pr() * 1.35;
      pl.position.set(wx, y0 + 0.05, wz);
      pl.userData.baseIntensity = pl.intensity;
      this.root.add(pl);
      this.patchLights.push(pl);
      patchLightsPlaced++;
    };

    const addPatchAt = (wx: number, wz: number, radius: number, pr: () => number): void => {
      if (minDistToCreekNetwork(wx, wz, p.resolved) < 0.72) return;
      const patchRoot = new THREE.Group();
      buildMyceliumGroundPatchInto(patchRoot, pr, radius, nodeMat);
      const y0 = p.getHeightAt(wx, wz);
      patchRoot.position.set(wx, y0 + 0.01, wz);
      patchRoot.rotation.y = pr() * Math.PI * 2;
      groundBatch.add(patchRoot);
      groundPatchSerial++;
      tryAddGroundLight(wx, y0, wz, pr, 0x66eebb);
    };

    /** Riparian ring: both banks, not in water — extra teal / violet micro-lights. */
    const addBankPatchAt = (wx: number, wz: number, radius: number, pr: () => number): void => {
      const d = minDistToCreekNetwork(wx, wz, p.resolved);
      if (d < 0.32 || d > 1.62) return;
      const patchRoot = new THREE.Group();
      buildMyceliumGroundPatchInto(patchRoot, pr, radius * 0.92, nodeMat);
      const y0 = p.getHeightAt(wx, wz);
      patchRoot.position.set(wx, y0 + 0.01, wz);
      patchRoot.rotation.y = pr() * Math.PI * 2;
      groundBatch.add(patchRoot);
      groundPatchSerial++;
      tryAddGroundLight(wx, y0, wz, pr, pr() < 0.5 ? 0x8866ff : 0x55ddcc);
    };

    const water = p.gatherAnchors.find((a) => a.kind === 'water');
    for (const a of p.gatherAnchors) {
      const pr = forestRand(Math.floor(a.x * 1000 + a.z * 717));
      for (let k = 0; k < 7; k++) {
        const j = pr() * Math.PI * 2;
        const rr = 0.18 + pr() * 0.72;
        addPatchAt(a.x + Math.cos(j) * rr * 0.42, a.z + Math.sin(j) * rr * 0.42, 0.3 + pr() * 0.26, pr);
      }
    }

    for (const off of gatherSurroundOffsets(p.ringMul)) {
      const pr = forestRand(Math.floor(off.x * 500 + off.z * 333));
      addPatchAt(p.dockCx + off.x, p.dockCz + off.z, 0.38 + pr() * 0.28, pr);
    }

    /* Dock-ring + inner-ring scatter counts bumped (Phase 8j night-magic
     * spread pass). Ground-patch mushrooms go through `mergeByMaterial`
     * at the bottom of the constructor, so increasing the count adds
     * geometry but no draw calls. Cost is vertex shader work for emissive-
     * only materials with `castShadow = false` / `receiveShadow = false`
     * — well below 1 ms even at the new counts. */
    /* === 2026-04-22 dock-ring count bumped (more patches everywhere) ===
     * Was 26 (full) / 10 (reduced). Bumped to 44 / 18 — patches all merge
     * into `mergedGround` so adding more is vertex-only cost (no draw
     * calls, no shadow cost). */
    const dockRingExtra = reduced ? 18 : 44;
    for (let e = 0; e < dockRingExtra; e++) {
      const pr = forestRand(50_000 + e * 17);
      const ang = (e / dockRingExtra) * Math.PI * 2 + pr() * 0.35;
      const dist = (0.65 + pr() * 0.55) * Math.min(p.ringMul * 0.95, 3.8);
      addPatchAt(p.dockCx + Math.cos(ang) * dist, p.dockCz + Math.sin(ang) * dist, 0.32 + pr() * 0.24, pr);
    }

    /*
     * Inner close ring — fungi/violet patches RIGHT next to the wizard so the magical
     * flora reads in the foreground, not just at the forest edge. Distances are
     * 0.45–1.4 ringMul (≈ 2.5–8 world units), avoiding the immediate dock pad
     * (< 0.45 ringMul). Half teal (matches existing forest patches), half violet
     * (matches the riparian banks) so the player sees the same color palette they'd
     * otherwise only get near the creeks. No creek-distance gate: we WANT these violet
     * patches near the character even on dry ground.
     */
    /* === 2026-04-22 dock-inner-ring count bumped 22 → 38 (full) /
     * 10 → 18 (reduced) for denser fungi field near character spawn. */
    const dockInnerExtra = reduced ? 18 : 38;
    for (let e = 0; e < dockInnerExtra; e++) {
      const pr = forestRand(70_000 + e * 23);
      const ang = (e / dockInnerExtra) * Math.PI * 2 + pr() * 0.55;
      const dist = (0.45 + pr() * 0.95) * p.ringMul * 0.55;
      const wx = p.dockCx + Math.cos(ang) * dist;
      const wz = p.dockCz + Math.sin(ang) * dist;
      const radius = 0.22 + pr() * 0.18;
      const violet = e % 2 === 1;
      const patchRoot = new THREE.Group();
      buildMyceliumGroundPatchInto(patchRoot, pr, radius * 0.9, nodeMat);
      const y0 = p.getHeightAt(wx, wz);
      patchRoot.position.set(wx, y0 + 0.01, wz);
      patchRoot.rotation.y = pr() * Math.PI * 2;
      groundBatch.add(patchRoot);
      groundPatchSerial++;
      tryAddGroundLight(wx, y0, wz, pr, violet ? 0x8866ff : 0x66eebb);
    }

    /* === 2026-04-22 creek-bank "landing strip" → organic clusters ===
     *
     * Was: walked each creek polyline at fixed 1.85 m steps, dropped
     * patches at 38 % chance per step, ALWAYS placed on BOTH sides of
     * the creek (`for (const side of [-1, 1])`). Result: two parallel
     * rows of patches running the length of every creek = the "giant
     * rectangular landing strip" the player called out 2026-04-22.
     *
     * New: bigger step (3.5 m), lower drop chance (28 %), pick ONE side
     * randomly per drop instead of both, AND add bigger angular jitter
     * + bigger radial jitter so the result is a ribbon of CLUSTERED
     * patches scattered along the creek rather than a parallel double-
     * row. Total patch count drops ~70 % (less coverage = less
     * landing-strip read) AND any remaining patches are randomly placed
     * on either bank rather than mirrored. */
    for (const c of p.resolved) {
      for (let i = 0; i < c.points.length - 1; i++) {
        const a = c.points[i]!;
        const b = c.points[i + 1]!;
        const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
        /* 3.5 m step (was 1.85 m) so far fewer drops per creek length. */
        const steps = Math.max(1, Math.floor(segLen / 3.5));
        for (let s = 0; s < steps; s++) {
          const pr = forestRand(i * 4096 + s * 97 + 88_888);
          /* 28 % chance per step (was 38 %). */
          if (pr() > 0.28) continue;
          const t = (s + pr() * 0.4) / steps;
          const mx = a[0] + (b[0] - a[0]) * t;
          const mz = a[1] + (b[1] - a[1]) * t;
          const dx = b[0] - a[0];
          const dz = b[1] - a[1];
          const sl = Math.hypot(dx, dz) || 1;
          const px = -dz / sl;
          const pz = dx / sl;
          const off = c.halfWidth * (1.4 + pr() * 1.1) + 0.15;
          /* Pick ONE side randomly per drop — half of the drops sit on
           * the left bank, half on the right. No more mirrored rows. */
          const side = pr() < 0.5 ? -1 : 1;
          /* Bigger jitter so even when adjacent steps both pick the same
           * side, they don't form a perfect line. */
          const jx = (pr() - 0.5) * 1.1;
          const jz = (pr() - 0.5) * 1.1;
          addBankPatchAt(mx + px * off * side + jx, mz + pz * off * side + jz, 0.28 + pr() * 0.24, pr);
        }
      }
    }

    if (water) {
      /* === 2026-04-22 water-anchor "landing strip" → organic clusters ===
       *
       * Was 7 patches placed at fixed `t` ratios `[0.04, 0.10, 0.18, 0.30,
       * 0.44, 0.58, 0.72]` along a straight line from dock to water + 1
       * "grand" patch at t=0.78. With only ±0.275 m perpendicular jitter,
       * the result was a visible STRAIGHT STRIP of fungi running toward the
       * map's side ("looks like a landing strip not randomly placed fungi").
       *
       * New layout: TWO ORGANIC CLUSTERS — one near the water gather anchor
       * itself, one ~midway between dock and water. Each cluster picks a
       * random center within a small radius then drops 4-6 patches in a
       * tight ring around that center. Same total patch count (~10) but no
       * straight-line pattern.
       *
       * Plus a single "grand" patch near the water's edge for the foreground
       * read, also organically jittered. */
      const dx = water.x - p.dockCx;
      const dz = water.z - p.dockCz;
      const len = Math.hypot(dx, dz) || 1;
      const ux = dx / len;
      const uz = dz / len;

      /* Two cluster centers along the dock→water axis at t = 0.42 (middle)
       * and t = 0.72 (near water), each offset by a random vector so the
       * clusters don't sit ON the line. */
      for (const tCenter of [0.42, 0.72]) {
        const prC = forestRand(Math.floor(tCenter * 87539));
        const cAng = prC() * Math.PI * 2;
        const cOff = (0.4 + prC() * 0.6) * Math.min(p.ringMul * 0.45, 1.8);
        const ccx = p.dockCx + ux * len * tCenter + Math.cos(cAng) * cOff;
        const ccz = p.dockCz + uz * len * tCenter + Math.sin(cAng) * cOff;
        const patchesInCluster = 4 + Math.floor(prC() * 3);
        for (let k = 0; k < patchesInCluster; k++) {
          const prP = forestRand(Math.floor(tCenter * 10000) + k * 191);
          const ang = prP() * Math.PI * 2;
          const r = 0.6 + prP() * 1.4;
          addPatchAt(
            ccx + Math.cos(ang) * r,
            ccz + Math.sin(ang) * r,
            0.32 + prP() * 0.28,
            prP,
          );
        }
      }

      /* "Grand" foreground patch near the water's edge — single accent that
       * marks the water destination without forming a line back to the dock. */
      const prG = forestRand(44044);
      const grandT = 0.78;
      const grandAng = prG() * Math.PI * 2;
      const grandOff = (0.3 + prG() * 0.5) * Math.min(p.ringMul * 0.4, 1.4);
      addPatchAt(
        p.dockCx + ux * len * grandT + Math.cos(grandAng) * grandOff,
        p.dockCz + uz * len * grandT + Math.sin(grandAng) * grandOff,
        0.52 + prG() * 0.2,
        prG,
      );
    }

    /* === 2026-04-22 open-area cluster scatter — fixed "giant rectangle" ===
     *
     * Was 32 cluster centers × 5-7 patches per cluster × radius 0.55-1.35 m.
     * Math: 5-7 patches that are 2-4× bigger than other patches all
     * overlapping in a ~5 m diameter cluster → reads as a SINGLE giant
     * rectangular fungi patch (5× any other patch's size). Player report
     * 2026-04-22: "the largest patch there is, 5 times the size of any
     * other patch, rectangle running from purple mushroom to green
     * mushroom toward back of map."
     *
     * Fix: normalize per-patch radius back to the standard 0.32-0.66 m
     * range that all other patches use. Each cluster still bunches 5-7
     * patches together (the "fungal colony" read), but each individual
     * patch is normal-sized, and the OVERLAP no longer creates a single
     * giant blob — instead the cluster reads as a dense bouquet of
     * normally-sized patches.
     *
     * AND: bumped cluster count 32 → 56 (full) / 14 → 22 (reduced) per
     * "we are not drawing much, let's add more patches everywhere" — the
     * patches all merge into the single `mergedGround` mesh below, so
     * adding more geometry costs vertex work but ZERO extra draw calls.
     * Player will see a denser fungi field across the whole map. */
    const clusterCount = reduced ? 22 : 56;
    const patchesPerCluster = reduced ? 3 : 5;
    const clusterMaxAttempts = reduced ? 110 : 280;
    let clustersPlaced = 0;
    let clusterAttempts = 0;
    while (clustersPlaced < clusterCount && clusterAttempts < clusterMaxAttempts) {
      const rA = forestRand(clusterAttempts + 9000);
      clusterAttempts++;
      const ang = rA() * Math.PI * 2;
      const t = 0.25 + rA() * 0.75;
      const cdist = Math.sqrt(t) * p.ringMul * 4.2;
      const ccx = p.dockCx + Math.cos(ang) * cdist;
      const ccz = p.dockCz + Math.sin(ang) * cdist;
      if (minDistToCreekNetwork(ccx, ccz, p.resolved) < 1.2) continue;
      const pcount = patchesPerCluster + (rA() < 0.4 ? 2 : 0);
      for (let k = 0; k < pcount; k++) {
        const pr = forestRand(clusterAttempts * 31 + k * 71 + 4011);
        const subAng = pr() * Math.PI * 2;
        const subDist = 0.6 + pr() * 1.8;
        const wx = ccx + Math.cos(subAng) * subDist;
        const wz = ccz + Math.sin(subAng) * subDist;
        if (minDistToCreekNetwork(wx, wz, p.resolved) < 0.6) continue;
        /* === Per-patch radius normalized 0.55-1.35 → 0.32-0.66 ===
         * Matches dock-ring + dock-inner-ring patches so cluster overlap
         * doesn't form a giant blob. */
        const radius = 0.32 + pr() * 0.34;
        addPatchAt(wx, wz, radius, pr);
      }
      clustersPlaced++;
    }

    groundBatch.updateMatrixWorld(true);
    const mergedGround = mergeByMaterial(groundBatch);
    mergedGround.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        (o as THREE.Mesh).castShadow = false;
        (o as THREE.Mesh).receiveShadow = false;
      }
    });
    this.root.add(mergedGround);

    /* Fairy count (Phase 8j night-magic spread pass). All fairies share
     * 3 InstancedMesh draw calls (body + wing + glim) regardless of count,
     * so bumping is essentially free for the GPU. Per-frame matrix update
     * loops scale linearly + remain cheap (Float32Array iteration). */
    const fairyN = reduced ? 12 : 30;
    const fr = forestRand(60_001);
    const fairyBases = computeFairyBasePositions(fairyN, p.dockCx, p.dockCz, p.ringMul, p.getHeightAt, p.resolved, fr);
    const fairySwarm = new NightFairySwarm(fairyBases, this.emissiveMats, this.ownedMaterials, fr);
    this.fairySwarm = fairySwarm;
    fairySwarm.addTo(this.root);
    fairySwarm.update(1 / 60, 0, 0);

    const fillLightCount = reduced ? 2 : 4;
    for (let g = 0; g < fillLightCount; g++) {
      const ang = (g / 4) * Math.PI * 2 + 0.2;
      const fill = new THREE.PointLight(0xd0b8ff, 0.042, 0, 2);
      fill.decay = 2;
      fill.distance = 10;
      fill.position.set(p.dockCx + Math.cos(ang) * 0.55, 0.95, p.dockCz + Math.sin(ang) * 0.55);
      fill.userData.baseIntensity = fill.intensity;
      this.root.add(fill);
      this.patchLights.push(fill);
    }

    /* Wisp + glow-moth count (Phase 8j night-magic spread). Each is a
     * tiny independent group with its own emissive; cheap. Bumped to
     * fill the larger awakened map. Distance also uncapped — was 8.5 m
     * which clustered them all near dock spawn. */
    const moteCreatureCount = reduced ? 3 : 6;
    for (let c = 0; c < moteCreatureCount; c++) {
      const cr = forestRand(8000 + c);
      const ang = cr() * Math.PI * 2;
      const dist = 1.4 + cr() * (p.ringMul * 3.5);
      const wx = p.dockCx + Math.cos(ang) * dist;
      const wz = p.dockCz + Math.sin(ang) * dist;
      if (minDistToCreekNetwork(wx, wz, p.resolved) < 0.8) continue;
      const y0 = p.getHeightAt(wx, wz) + 0.65 + cr() * 2.1;
      const sm = 0.78 + cr() * 0.35;
      const creature = cr() < 0.52 ? buildWisp(cr, sm, this.emissiveMats) : buildGlowMoth(cr, sm, this.emissiveMats);
      creature.position.set(wx, y0, wz);
      this.root.add(creature);
      this.motes.push({
        group: creature,
        wx,
        wz,
        baseY: y0,
        phase: cr() * Math.PI * 2,
        speed: 0.48 + cr() * 0.82,
        orbitR: 0.14 + cr() * 0.38,
      });
    }

    for (const m of this.emissiveMats) {
      if (m.userData.baseEmissive === undefined) m.userData.baseEmissive = m.emissiveIntensity;
      if (!this.ownedMaterials.includes(m)) this.ownedMaterials.push(m);
    }
  }

  update(
    dt: number,
    magicVisibility: number,
    opts?: { interactionLowBudget?: boolean; perfScale?: number },
  ): void {
    this.t += dt;
    const perf = opts?.perfScale ?? 1;
    const target = THREE.MathUtils.clamp(magicVisibility * perf, 0, 1);
    const low = opts?.interactionLowBudget === true;
    /* Slower ease than dock raw signal — avoids popping when nightMix jumps (Glenn Fiedler–style: separate smooth state). */
    const k = 1 - Math.exp(-dt * (low ? 1.15 : 2.35));
    this.displayStrength = THREE.MathUtils.lerp(this.displayStrength, target, k);

    const vis = this.displayStrength;
    /* Keep root in scene always so WebGL never pays first-use compile + state churn when crossing 0.004 (was a major hitch). */
    this.root.visible = true;

    /* Daylight skip — biggest CPU win for awakened-mode roaming during the day. When BOTH
     * the target visibility and the smoothed display strength are essentially zero, every
     * write below resolves to ~0 (emissive × ~0, light intensity × ~0, mote position
     * orbiting around an invisible center). Latch a one-time "everything to dormant"
     * flush so the renderer state matches the all-day "no night magic" reality, then
     * early-return until visibility starts ramping back up at dusk. The fairy swarm has
     * its own zero-ratio bail (`activeCount === 0 && ratioSmoothed < 0.008`) that fires
     * the same way, so we still call into it to keep its smoothed ratio consistent. */
    if (target < 0.003 && vis < 0.003) {
      if (!this.dayQuietApplied) {
        for (const m of this.emissiveMats) {
          m.emissiveIntensity = 0;
        }
        for (const pl of this.patchLights) {
          pl.intensity = 0;
        }
        this.dayQuietApplied = true;
      }
      /* Fairy swarm zero-ratio bail still needs the call so its `ratioSmoothed` decays. */
      this.fairySwarm?.update(dt, this.t, vis);
      return;
    }
    this.dayQuietApplied = false;

    const pulse = 0.88 + 0.12 * Math.sin(this.t * 2.4);
    const emScale = vis * pulse;
    for (const m of this.emissiveMats) {
      const base = (m.userData.baseEmissive as number) ?? m.emissiveIntensity;
      m.emissiveIntensity = base * emScale;
    }

    for (const pl of this.patchLights) {
      const baseI = (pl.userData.baseIntensity as number) ?? pl.intensity;
      pl.intensity = baseI * vis * pulse;
    }

    /* Do not cap or hide fairies during travel gather / craft-busy: same per-frame work either way, and culling reads worse. */
    this.fairySwarm?.update(dt, this.t, vis);

    for (const m of this.motes) {
      const lg = m.group.userData.light as THREE.PointLight | undefined;
      const bi = (lg?.userData.baseIntensity as number) ?? 0.5;
      if (lg) {
        lg.intensity = bi * vis * (0.82 + 0.18 * Math.sin(this.t * 3.1 + m.phase));
      }
      const ox = Math.cos(this.t * m.speed + m.phase) * m.orbitR;
      const oz = Math.sin(this.t * (m.speed * 0.85) + m.phase * 1.3) * m.orbitR;
      const bob = Math.sin(this.t * 2.2 + m.phase) * 0.14;
      const br = vis * 0.08;
      const bx =
        Math.sin(this.t * 1.08 + m.wx * 0.34 + m.wz * 0.29) * br +
        Math.cos(this.t * 1.55 + m.phase) * br * 0.35;
      const bz =
        Math.cos(this.t * 0.96 + m.wx * 0.38 + m.wz * 0.33) * br +
        Math.sin(this.t * 1.4 + m.phase * 0.7) * br * 0.32;
      m.group.position.set(m.wx + ox + bx, m.baseY + bob, m.wz + oz + bz);
      m.group.rotation.y = this.t * 0.35 + m.phase;
    }
  }

  dispose(): void {
    if (this.fairySwarm) {
      this.fairySwarm.removeFromParent();
      this.fairySwarm.disposeGeometries();
      this.fairySwarm = null;
    }
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    const seen = new Set<THREE.Material>();
    for (const m of this.ownedMaterials) {
      if (seen.has(m)) continue;
      seen.add(m);
      m.dispose();
    }
    this.ownedMaterials.length = 0;
    this.emissiveMats.length = 0;
    this.patchLights.length = 0;
    this.motes.length = 0;
    this.root.removeFromParent();
  }
}

function forestRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function attachIdleCraftNightMagic(
  scene: THREE.Scene,
  dock: IdleCraftDockEnvironment,
  params: IdleCraftNightMagicParams,
): void {
  const field = new IdleCraftNightMagicField(scene, params);
  dock.registerNightMagic(field);
}
