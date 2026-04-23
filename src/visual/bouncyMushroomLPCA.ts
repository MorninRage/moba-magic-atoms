/**
 * Bouncy mushroom LPCA — port of `C:\stick man`'s `MushroomBuilder.buildMushroom`
 * (`C:\EmpireEditor\src\builders\MushroomBuilder.ts`) with three idle-craft-specific
 * adjustments:
 *
 *   1. **Cap pivot group.** The squash animation needs to scale the cap downward
 *      with the rim staying anchored to the stem top. Stick-man's source places
 *      the cap mesh at `position.y = stemH` and the cap's local origin is the
 *      sphere center → scaling y in place would sink the cap into the stem.
 *      We wrap the cap mesh in a `capPivot` group whose pivot sits at the rim
 *      (cap-mesh local Y offset = 0). Animating `capPivot.scale` then squashes
 *      the dome cleanly without shifting the rim. Same idiom the source already
 *      uses for the `drip.anim` groups.
 *
 *   2. **Shared materials by colorIndex.** Stick man builds fresh
 *      `MeshPhysicalMaterial` instances per mushroom. With 18 mushrooms ×
 *      (cap + stem + ~5 drips) = 90+ unique materials → 90+ shader programs,
 *      each compiled on first-use → multi-second freezes on first awakened
 *      entry. We cache materials per colorIndex in module scope so the builder
 *      ships at most 8 cap materials + 8 stem materials + 8 drip materials
 *      regardless of population. Cap material is bumped via `customProgramCacheKey`
 *      to keep it distinct in the program cache from the others.
 *
 *   3. **Builder return shape exposes the cap pivot + rest top-Y.** The bounce
 *      controller (`awakenedBouncyMushrooms.ts`) needs to write `capPivot.scale`
 *      each frame for the spring squash, and the scatter needs the rest-position
 *      top-Y (cap rim + dome height at scale 1) for the collision footprint
 *      `topY` field. Both are returned alongside the standard `THREE.Group` so
 *      callers don't have to traverse to find them.
 *
 * Visual model preserved 1:1 from stick man:
 *   - Stem: tapered cylinder, MeshStandardMaterial with stemColor + emissive.
 *   - Cap: half-sphere with rim vertex displacement → "melting wax" lobes,
 *     MeshPhysicalMaterial with transmission + emissive (the visual hero).
 *   - Drips: per rim lobe a `drip.anim` Group with a blend sphere + tapered
 *     drip body cylinder. `drip.anim` is the pivot for any future drip
 *     stretch animation (Phase 6 polish drip wobble extends `scale.y`).
 *
 * No `THREE.PointLight`s anywhere — phantom-light invariant respected.
 * Cap glow is `emissive × 0.45 × bloomThreshold` (post-Phase-8h tuning).
 */
import * as THREE from 'three';

/* Vivid neon palette ported from stick man — see docs §4 lore framing. */
const MUSHROOM_COLORS = [
  new THREE.Color(0xff00aa), // hot pink
  new THREE.Color(0x00ffcc), // cyan
  new THREE.Color(0xcc00ff), // magenta
  new THREE.Color(0x66ff00), // lime
  new THREE.Color(0xff6600), // orange
  new THREE.Color(0xaa00ff), // purple
  new THREE.Color(0xffcc00), // golden
  new THREE.Color(0x00aaff), // sky blue
];

export const MUSHROOM_COLOR_COUNT = MUSHROOM_COLORS.length;

/** Deterministic hash for reproducible drip rim displacement. */
function hash(x: number, y: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

export interface BouncyMushroomConfig {
  /** Overall scale multiplier — final mushroom dimensions × `scale`. */
  scale?: number;
  /** 0–1: flat to round cap. Drives `capR`. */
  capShape?: number;
  /** 0–1: stem thickness (wider stems for stockier mushrooms). */
  stemThickness?: number;
  /** 0–1: drip intensity (more / longer drip blobs around the cap rim). */
  dripAmount?: number;
  /** Color index into `MUSHROOM_COLORS` (mod 8). */
  colorIndex?: number;
  /** Random seed for per-vertex / per-drip variation. */
  seed?: number;
}

const DEFAULT_CONFIG: Required<BouncyMushroomConfig> = {
  scale: 1,
  capShape: 0.6,
  stemThickness: 0.5,
  dripAmount: 0.8,
  colorIndex: 0,
  seed: 0,
};

/**
 * Public return shape from `buildBouncyMushroom`. The bounce controller in
 * `awakenedBouncyMushrooms.ts` reads:
 *   - `group` — root, attached to the scatter group, position/rotation set per instance.
 *   - `capPivot` — squash target. Scale-Y down + scale-XZ up = "jello compressed".
 *   - `capRestTopY` — rim Y (relative to group origin) + dome top Y at scale 1.
 *     Used to compute the collision footprint's `topY` for "stand on cap" landing.
 *   - `dripGroups` — per-drip pivot groups so Phase 6 polish can wobble them on bounce.
 */
export interface BouncyMushroomBuildResult {
  group: THREE.Group;
  capPivot: THREE.Group;
  capMesh: THREE.Mesh;
  stemMesh: THREE.Mesh;
  dripGroups: THREE.Group[];
  /** Y of the cap dome's top at rest scale (group-local). */
  capRestTopY: number;
  /** Cap base radius at rest (used by the scatter for the collision-footprint radius). */
  capRestRadius: number;
  /** Stem total height (used for debug + future dust VFX anchoring). */
  stemHeight: number;
}

/* --------------------------------------------------------------------------
 * Material caches — one program per colorIndex, shared across all mushrooms.
 * -------------------------------------------------------------------------- */

const stemMatCache = new Map<number, THREE.MeshStandardMaterial>();
const capMatCache = new Map<number, THREE.MeshPhysicalMaterial>();
const dripMatCache = new Map<number, THREE.MeshPhysicalMaterial>();

function getStemMaterial(stemColorIdx: number): THREE.MeshStandardMaterial {
  let m = stemMatCache.get(stemColorIdx);
  if (m) return m;
  const stemColor = MUSHROOM_COLORS[stemColorIdx]!;
  m = new THREE.MeshStandardMaterial({
    color: stemColor,
    roughness: 0.5,
    metalness: 0.08,
    emissive: stemColor.clone().multiplyScalar(0.3),
  });
  stemMatCache.set(stemColorIdx, m);
  return m;
}

function getCapMaterial(capColorIdx: number): THREE.MeshPhysicalMaterial {
  let m = capMatCache.get(capColorIdx);
  if (m) return m;
  const capColor = MUSHROOM_COLORS[capColorIdx]!;
  m = new THREE.MeshPhysicalMaterial({
    color: capColor,
    roughness: 0.25,
    metalness: 0.03,
    transmission: 0.55,
    /* `thickness` is bound to the unit-scale baseline — the cap mesh's per-instance
     * scale is applied via the parent group, not the material, so a single shared
     * material works across all sizes. Slight thickness mismatch on giant mushrooms
     * reads as "thicker glass" which is fine. */
    thickness: 0.12,
    ior: 1.25,
    attenuationColor: capColor,
    attenuationDistance: 0.4,
    emissive: capColor.clone().multiplyScalar(0.45),
    transparent: false,
  });
  capMatCache.set(capColorIdx, m);
  return m;
}

function getDripMaterial(capColorIdx: number): THREE.MeshPhysicalMaterial {
  let m = dripMatCache.get(capColorIdx);
  if (m) return m;
  const capColor = MUSHROOM_COLORS[capColorIdx]!;
  m = new THREE.MeshPhysicalMaterial({
    color: capColor,
    roughness: 0.2,
    metalness: 0.03,
    transmission: 0.6,
    thickness: 0.1,
    ior: 1.25,
    attenuationColor: capColor,
    attenuationDistance: 0.3,
    emissive: capColor.clone().multiplyScalar(0.45),
  });
  dripMatCache.set(capColorIdx, m);
  return m;
}

/**
 * Build a single bouncy drip-mushroom (cap + stem + drips).
 *
 * The cap mesh is wrapped in `capPivot` (origin at the cap's rim, where it joins
 * the stem) so the bounce controller can squash the dome with `capPivot.scale.set(
 * 1 + bulge, 1 - squish, 1 + bulge)` and the rim stays glued to the stem top.
 */
export function buildBouncyMushroom(config: BouncyMushroomConfig = {}): BouncyMushroomBuildResult {
  const c = { ...DEFAULT_CONFIG, ...config };
  const group = new THREE.Group();
  group.name = 'bouncy_mushroom.lpca';

  const capColorIdx = ((c.colorIndex % MUSHROOM_COLORS.length) + MUSHROOM_COLORS.length) %
    MUSHROOM_COLORS.length;
  /* Stem color picked to be 3 steps away in the palette → guaranteed visual contrast
   * (no "magenta cap on magenta stem"). Same offset stick man uses. */
  const stemColorIdx = (capColorIdx + 3) % MUSHROOM_COLORS.length;

  const stemH = 0.4 * c.scale;
  const stemRBottom = (0.06 + c.stemThickness * 0.08) * c.scale;
  const stemRTop = stemRBottom * 0.7;
  const capR = (0.25 + c.capShape * 0.15) * c.scale;

  /* ---- Stem (tapered cylinder, position so base sits at group y = 0) ---- */
  const stemGeo = new THREE.CylinderGeometry(stemRTop, stemRBottom, stemH, 8);
  const stem = new THREE.Mesh(stemGeo, getStemMaterial(stemColorIdx));
  stem.position.y = stemH / 2;
  /* === 2026-04-20 mushroom shadow-cost optimization ===
   *
   * 18 mushrooms × (cap + stem + ~3-7 drips × 2 meshes) = 144-288 mesh
   * shadow draws per frame. Most of those produce shadow contributions
   * that are immediately occluded by the mushroom's OWN cap or stem
   * shadow, so the GPU is doing 100+ shadow rasterizations of the same
   * blob. Strategy:
   *   - **Stem casts** — single tall vertical pillar; gives the
   *     mushroom its primary ground-anchor shadow.
   *   - **Cap does NOT cast** — its shadow is essentially the same
   *     footprint as the stem's (small lateral offset), so it would
   *     just darken the existing stem shadow and add cost.
   *   - **Drips do NOT cast** (set in the drip loop below) — they're
   *     tiny and entirely covered by the cap's silhouette anyway.
   *
   * Net win: 144-288 → 18 shadow draws per mushroom field. ALL meshes
   * still receive shadows so they look properly lit by the sun + moon. */
  stem.castShadow = true;
  stem.receiveShadow = true;
  group.add(stem);

  /* ---- Cap (half-sphere with rim vertex drip displacement) ----
   *
   * Important: the half-sphere geometry is centered on its own origin (sphere
   * center). To pivot at the rim (where it attaches to the stem) we wrap the
   * cap mesh in a `capPivot` group whose origin is at the rim (group y = stemH),
   * and shift the cap mesh up by 0 (the dome already sits with rim at y = 0
   * locally because we use `phiStart = 0`, `phiLength = π`). */
  const capSegs = 14;
  const capGeo = new THREE.SphereGeometry(
    capR,
    capSegs,
    Math.floor(capSegs / 2),
    0,
    Math.PI * 2,
    0,
    Math.PI / 2,
  );

  /* Rim drip displacement — pull lobes of vertices near the rim downward. */
  const pos = capGeo.attributes.position as THREE.BufferAttribute;
  const dripCount = Math.floor(3 + c.dripAmount * 4);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const rimFactor = 1 - Math.max(0, (y - capR * 0.2) / (capR * 0.8));
    const angle = Math.atan2(x, z);
    const dripPhase = (angle / (Math.PI * 2) + 0.5) * dripCount;
    const dripSeed = Math.floor(dripPhase) % dripCount;
    const dripStrength = (hash(c.seed + dripSeed, 0) * 0.7 + 0.3) * c.dripAmount * rimFactor;
    const pullDown = dripStrength * capR * 0.6;
    pos.setY(i, y - pullDown);
  }
  capGeo.computeVertexNormals();

  const capPivot = new THREE.Group();
  capPivot.name = 'bouncy_mushroom.cap_pivot';
  capPivot.position.y = stemH;

  const cap = new THREE.Mesh(capGeo, getCapMaterial(capColorIdx));
  cap.position.y = 0; /* rim at pivot origin */
  /* Cap intentionally does NOT cast — see shadow-cost note on stem above.
   * Stem's shadow already grounds the mushroom convincingly. */
  cap.castShadow = false;
  cap.receiveShadow = true;
  capPivot.add(cap);
  group.add(capPivot);

  /* ---- Drip blobs (each in a `drip.anim` group anchored at the cap rim) ---- */
  const dripGroups: THREE.Group[] = [];
  const dripMat = getDripMaterial(capColorIdx);
  for (let d = 0; d < dripCount; d++) {
    const angle = (d / dripCount) * Math.PI * 2 + hash(c.seed + d, 0) * 0.5;
    const dripR = (0.12 + hash(c.seed + d, 1) * 0.18) * capR * c.dripAmount;
    const dripH = dripR * (2 + hash(c.seed + d, 2) * 1.5);
    const cx = Math.cos(angle) * capR * 0.9;
    const cz = Math.sin(angle) * capR * 0.9;
    const blendR = dripR * 1.1;
    const bodyH = dripH - blendR;

    /* Drip is a child of the cap pivot, not the root group, so the squash
     * carries the drips with it (they "drape" downward as the cap compresses).
     * Phase 6 polish wobble adds `scale.y` extension on top. */
    const dripGroup = new THREE.Group();
    dripGroup.position.set(cx, 0, cz);
    dripGroup.name = 'drip.anim';
    dripGroup.userData = { phase: hash(c.seed + d, 3) * Math.PI * 2, dripId: d };

    const blendGeo = new THREE.SphereGeometry(blendR, 10, 8);
    const blendMesh = new THREE.Mesh(blendGeo, dripMat);
    blendMesh.position.set(0, -blendR * 0.6, 0);
    /* Drips do NOT cast shadows (entirely under cap silhouette). See
     * shadow-cost note on stem above — saves 100+ shadow draws per frame. */
    blendMesh.castShadow = false;
    blendMesh.receiveShadow = true;
    dripGroup.add(blendMesh);

    const dripGeo = new THREE.CylinderGeometry(dripR * 0.9, dripR * 0.2, bodyH, 12);
    const dripMesh = new THREE.Mesh(dripGeo, dripMat);
    dripMesh.position.set(0, -blendR - bodyH / 2, 0);
    dripMesh.castShadow = false;
    dripMesh.receiveShadow = true;
    dripGroup.add(dripMesh);

    capPivot.add(dripGroup);
    dripGroups.push(dripGroup);
  }

  return {
    group,
    capPivot,
    capMesh: cap,
    stemMesh: stem,
    dripGroups,
    /* Cap rest top Y (group-local): stem height + cap dome max-Y after rim drip.
     * The rim displacement only pulls vertices DOWN, so the dome top (vertex at
     * the cap's pole) is unaffected and sits at exactly capR above the rim. */
    capRestTopY: stemH + capR,
    capRestRadius: capR,
    stemHeight: stemH,
  };
}

/**
 * Free all cached materials. Called from disposal paths if we ever need to
 * fully tear down the mushroom system (currently a no-op in normal play —
 * realm flips dispose the scatter handle but keep the materials for the next
 * awakened entry, exactly like every other LPCA material cache in the codebase).
 */
export function disposeBouncyMushroomMaterials(): void {
  for (const m of stemMatCache.values()) m.dispose();
  for (const m of capMatCache.values()) m.dispose();
  for (const m of dripMatCache.values()) m.dispose();
  stemMatCache.clear();
  capMatCache.clear();
  dripMatCache.clear();
}
