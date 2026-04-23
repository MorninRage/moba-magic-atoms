/**
 * Forest backdrop: **one procedural sky** (full sphere, gradient + seam-free aurora + clouds in one shader),
 * sun-aligned directional hint, LPCA terrain + skirt, creek ribbons (GoE-style water material),
 * trees and shrubs grounded on heightfield.
 *
 * **Seven forest strata** (temperate vertical design — placement budgets, not voxels):
 * 0 **Emergent** — sparse tallest stems (apple, oak, balsam fir, pine; rare birch), largest height variance.
 * 1 **Canopy** — main closed forest layer, biased to lush broadleaf + dense fir.
 * 2 **Subcanopy** — understory trees, shorter / thinner; mostly deciduous.
 * 3 **Tall shrub** — berry, rhododendron clump, mound shrubs, tall fern, vines.
 * 4 **Low shrub** — heather (multi-palette), rhodo, berry, fern, boxwood, vines.
 * 5 **Herb / graminoid** — fiber grass, tuft, sedge (map-wide same density as camp halo).
 * 6 **Litter / micro** — small clones of cover types for ground-plane fill.
 * **Vines & moss** (LPCA): {@link buildIdleCraftCreeperVine}, {@link buildIdleCraftDrapeVine},
 * {@link buildIdleCraftMossClump} — mixed into strata 4–6 for the same map-wide density as camp.
 */
import * as THREE from 'three';
import { getWaterPlaneMaterial } from 'empire-engine/lpca';
import { yieldToEventLoop } from '../util/mainThreadYield';
import { measureBlock, measureBlockAsync } from '../util/longAnimationFramesAudit';
import { mergeByMaterialTiled } from './spatialTileMerge';
import type { IdleEmpireProjectFile } from '../engine/fetchEmpireProject';
import type { GraphicsBudget } from '../engine/graphicsTier';
import { IdleCraftDockEnvironment } from '../world/idleCraftDockEnvironment';
import {
  buildTerrainGridGeometry,
  createHeightSampler,
  minDistToCreekNetwork,
  resolveCreekPolylines,
  type ResolvedCreek,
} from '../world/idleCraftHeightfield';
import { parseWorldFromProject, readDockSpawn } from '../world/idleCraftWorldTypes';
import { buildCreekRibbonGeometry } from '../world/idleCraftWaterRibbon';
import {
  buildIdleCraftAppleTree,
  buildIdleCraftBalsamFirTree,
  buildIdleCraftBirchTree,
  buildIdleCraftPineTree,
  buildIdleCraftRoundOakTree,
} from './goeStyleHarvestLPCA';
import { attachIdleCraftNightMagic } from './idleCraftNightMagicLPCA';
import {
  attachIdleCraftSkyCrystalSeal,
  getIdleCraftCrystalWorldPositions,
  scatterIdleCraftCrystalProps,
  type IdleCraftSkyCrystalSealHandle,
} from './idleCraftCrystalProps';
import {
  bakeVegetationWindHeightAboveGround,
  cloneMaterialsForVegetationWind,
  installVegetationWindOnMergedGroup,
} from './idleCraftVegetationWind';
import { getIdleCraftGatherAnchors } from '../world/idleCraftGatherWorld';
import { dockForestShadowNearM } from '../world/dockVegetationLod';
import { createUnifiedSkyDomeMesh } from './idleCraftSkyStack';
import { bakeTrippyGroundVertexColorsChunked } from './trippyGroundBake';

/**
 * Forest tree species (LPCA builders): **0** apple, **1** **tiered-cone pine** (classic stacked cones),
 * **2** birch (sparse), **3** balsam **fir** (pads + droop — not the same as pine), **4** round-crown oak.
 */
export type ForestTreeSpecies = 0 | 1 | 2 | 3 | 4;

/** Inner ring: local xz + scale; species chosen for lively mix (few pale birches). */
const DOCK_FOREST_RING_XZS: [number, number, number][] = [
  [-2.8, -1.2, 1.05],
  [-3.1, 0.6, 0.92],
  [-2.4, 1.8, 1.1],
  [2.6, -1.5, 0.88],
  [3.0, 0.3, 1.0],
  [2.5, 2.0, 0.95],
  [-1.2, -2.6, 1.08],
  [1.4, -2.8, 0.9],
  [-3.4, -2.2, 0.85],
  [3.2, 2.4, 0.98],
  [0.2, 3.2, 0.82],
  [-0.5, 2.9, 0.9],
  [-4.1, 0.4, 0.96],
  [-3.6, 2.2, 0.9],
  [4.0, -0.5, 0.94],
  [3.5, 1.6, 0.91],
  [-2.0, 3.6, 0.86],
  [1.8, 3.4, 0.89],
  [-4.3, -1.8, 0.84],
  [4.2, -2.4, 0.87],
  [0.8, -3.2, 0.9],
  [-1.6, -3.6, 0.83],
  [5.1, 0.8, 0.82],
  [-5.0, 1.2, 0.8],
  [2.2, 4.0, 0.78],
  [-0.3, 4.2, 0.81],
  [-4.6, -3.0, 0.8],
  [4.8, 3.1, 0.83],
  [-2.2, -4.1, 0.79],
  [3.8, 4.4, 0.77],
  [-5.2, -0.9, 0.81],
  [5.4, -1.6, 0.76],
  [1.1, 4.8, 0.74],
  [-3.8, 4.6, 0.78],
  [0.4, -4.4, 0.8],
  [-1.0, -4.8, 0.75],
  [4.6, 0.1, 0.82],
  [-0.8, -3.8, 0.84],
  [2.9, -3.5, 0.79],
  [-4.8, 2.8, 0.77],
  [1.5, 4.5, 0.73],
  [-5.4, 2.0, 0.72],
  [5.0, -2.8, 0.74],
  [-2.7, 4.3, 0.71],
  [3.3, -3.9, 0.76],
];

/** ~40% apple/oak, ~22% balsam, ~18% pine, ~7% birch — matches “more alive / less ghost birch”. */
const DOCK_RING_SPECIES: ForestTreeSpecies[] = [
  0, 4, 3, 1, 0, 4, 0, 3, 4, 1, 0, 4, 3, 0, 1, 4, 0, 3, 0, 4, 1, 3, 4, 0, 0, 4, 3, 1, 0, 4, 0, 3, 4, 2, 0, 4, 3, 0, 1, 4, 0, 3, 0, 4, 1,
];

const DOCK_FOREST_RING_TREE_PLACEMENTS: [number, number, number, ForestTreeSpecies][] =
  DOCK_FOREST_RING_XZS.map((p, i) => [...p, DOCK_RING_SPECIES[i] ?? 0]);

/** Inner-ring index with smallest base scale — one intentional walk-through sapling. */
const DOCK_RING_PASS_THROUGH_TREE_IDX = DOCK_FOREST_RING_XZS.reduce<number>(
  (bestI, p, i, arr) => (p[2] < arr[bestI]![2] ? i : bestI),
  0,
);

export function buildTreeBySpecies(r: () => number, sm: number, species: ForestTreeSpecies): THREE.Group {
  switch (species) {
    case 1:
      return buildIdleCraftPineTree(r, sm);
    case 2:
      return buildIdleCraftBirchTree(r, sm);
    case 3:
      return buildIdleCraftBalsamFirTree(r, sm);
    case 4:
      return buildIdleCraftRoundOakTree(r, sm);
    default:
      return buildIdleCraftAppleTree(r, sm);
  }
}

export function forestRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function stdMat(opts: {
  color: number;
  metalness?: number;
  roughness?: number;
}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: opts.color,
    metalness: opts.metalness ?? 0.06,
    roughness: opts.roughness ?? 0.85,
  });
}

export function leafPhysicalMat(color: number, roughness: number): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0,
    roughness,
    clearcoat: 0.22,
    clearcoatRoughness: 0.55,
    reflectivity: 0.35,
  });
}

/** Unit vector toward the sun (matches painted sun on skydome + key light). */
export function computeForestSunDirection(): THREE.Vector3 {
  const v = new THREE.Vector3();
  /* Slightly higher elevation → more direct light on horizontal ground before env clock runs. */
  const elev = THREE.MathUtils.degToRad(46);
  const azim = THREE.MathUtils.degToRad(58);
  const h = Math.cos(elev);
  v.set(Math.sin(azim) * h, Math.sin(elev), Math.cos(azim) * h);
  return v.normalize();
}

/** One full-sphere procedural sky (horizon-filled in shader); camera-centered in dock env. */
function attachSkydome(scene: THREE.Scene, dockEnvironment: IdleCraftDockEnvironment, graphics: GraphicsBudget): void {
  const sky = createUnifiedSkyDomeMesh(graphics, 12000);
  dockEnvironment.registerSkyDome(sky);
  scene.add(sky);
}

/**
 * Small boxwood-style shrub: woody stem + stacked displaced foliage mounds (EoE bush pattern, reduced).
 */
export function buildShrubLpcaLite(
  stemMat: THREE.MeshStandardMaterial,
  darkLeaf: THREE.MeshPhysicalMaterial,
  midLeaf: THREE.MeshPhysicalMaterial,
  scale: number,
  rotY: number,
): THREE.Group {
  const g = new THREE.Group();
  g.rotation.y = rotY;
  g.scale.setScalar(scale);

  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.022, 0.09, 6), stemMat);
  stem.position.y = 0.045;
  stem.castShadow = true;
  g.add(stem);

  const twig = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.012, 0.12, 5), stemMat);
  twig.position.set(0.03, 0.08, 0.02);
  twig.rotation.z = 0.35;
  twig.rotation.x = 0.2;
  twig.castShadow = true;
  g.add(twig);

  const clusters: [number, number, number, number, number, number][] = [
    [0, 0.11, 0, 0.11, 0.62, 1],
    [0.07, 0.13, 0.04, 0.075, 0.58, 0.95],
    [-0.06, 0.12, -0.03, 0.068, 0.55, 0.92],
    [0.02, 0.15, -0.06, 0.055, 0.52, 0.88],
  ];
  for (let i = 0; i < clusters.length; i++) {
    const [x, y, z, r, sy, roughMul] = clusters[i]!;
    const geo = new THREE.IcosahedronGeometry(r, 1);
    const p = geo.attributes.position;
    for (let vi = 0; vi < p.count; vi++) {
      const ix = vi * 3;
      const nx = p.array[ix]!;
      const ny = p.array[ix + 1]!;
      const nz = p.array[ix + 2]!;
      const n = Math.sin(nx * 9 + ny * 7) * 0.045 + Math.cos(nz * 8) * 0.035;
      p.array[ix] = nx + nx * n;
      p.array[ix + 1] = ny + ny * n * 0.85;
      p.array[ix + 2] = nz + nz * n;
    }
    geo.computeVertexNormals();
    const base = i % 2 === 0 ? darkLeaf : midLeaf;
    const mat = base.clone();
    mat.roughness = Math.min(0.95, 0.42 * roughMul + 0.2);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.scale.set(1, sy, 1);
    m.castShadow = true;
    g.add(m);
  }

  return g;
}

/**
 * Static collision obstacle exposed by the forest backdrop. Captured during scatter
 * BEFORE `mergeByMaterialTiled` consumes the per-tree transforms (after which positions
 * are baked into vertex buffers and unrecoverable).
 *
 * `mountApp` bulk-registers each entry into the awakened-mode `collisionWorld` so the
 * player + mobs can't walk through the visual forest. The `topY` field drives jump
 * physics: a tall pine is impossible to clear with a single jump, while a short
 * understory shrub (~0.7 m) clears trivially.
 *
 * **Excluded by design** (per the user spec for the universal-collision pass):
 * fiber/tuft/sedge grass, creeper/drape vines, and moss clumps stay un-registered —
 * the player walks through tall grass and ground cover freely.
 */
/**
 * Spec describing one harvestable obstacle in the dock forest. Collected during
 * scatter and handed to `attachDockForestHarvestables` (see
 * [src/world/dockForestHarvestables.ts](../world/dockForestHarvestables.ts)) which
 * renders these via per-(kind, species) `THREE.InstancedMesh` buckets — same proven
 * pattern as the awakened-mode harvest scatter. Per-instance hide on break is O(1)
 * (`setMatrixAt(i, ZERO)`) and the fall/crumble/collapse animations come from the
 * same archetype set as the awakened scatter.
 *
 * Trade-off: the merged-mesh forest pass no longer renders these — they're rendered
 * by the InstancedMesh scene instead. Wind sway DOES NOT apply to InstancedMesh (see
 * `LEARNINGS.md` "Dock forest wind, WebGL shaders" entry), so harvestable trees /
 * shrubs / bushes / rocks no longer sway. Non-harvestable understory (grass, vines,
 * moss, ferns, heather) STAYS on the merged path so most of the dock vegetation
 * keeps its sway. This is the per-instance-fall-vs-wind trade-off the user accepted
 * by asking for "the same system as the original apple tree".
 */
/**
 * Kind union for every harvestable plant on the dock. Per-instance kinds are one
 * spec per plant; `*_patch` kinds bundle 5-10 nearby plants of one species into a
 * single harvestable patch (one E-press harvests the whole patch with bulk yield).
 *
 * Per-instance: tree (5 species), shrub, berry_bush, rock, fern, heather.
 * Patch-based: grass_patch (fiber/tuft/sedge grass), vine_patch (creeper/drape),
 * moss_patch (moss clumps).
 */
export type ForestObstacleKind =
  | 'tree'
  | 'shrub'
  | 'berry_bush'
  | 'rock'
  | 'fern'
  | 'heather'
  | 'grass_patch'
  | 'vine_patch'
  | 'moss_patch';

/**
 * One member-plant placement inside a patch (relative to the patch centroid).
 * `subKind` lets the BatchedMesh patch builder pick the right LPCA builder for
 * each member (e.g. fiber vs tuft vs sedge inside a grass patch).
 */
export type ForestPatchMember = {
  /** Offset from the patch centroid (world XZ). */
  dx: number;
  dz: number;
  /** Per-member scale multiplier. */
  scale: number;
  /** Per-member yaw. */
  rotY: number;
  /** Sub-builder selector. For grass: 'fiber' | 'tuft' | 'sedge'. For vine: 'creeper' | 'drape'. For moss: 'moss'. */
  subKind: string;
  /** Per-member RNG seed for the builder. */
  seed: number;
};

export type ForestStaticObstacle = {
  /** Categorical kind. Drives template selection + harvest yield in the InstancedMesh scene. */
  kind: ForestObstacleKind;
  x: number;
  z: number;
  /** Terrain Y at the obstacle base. */
  baseY: number;
  /** Approximate canopy / mound top Y in world coordinates. */
  topY: number;
  /** Trunk-equivalent collision radius (folds in per-instance scale). */
  radius: number;
  /** Per-instance scale multiplier (`sm` for trees). */
  scale: number;
  /** World yaw of the original placement. */
  rotY: number;
  /** Tree species 0-4 (undefined for non-tree kinds). */
  species?: ForestTreeSpecies;
  /** Per-shrub variant ('rhodo' | 'shrub_lite'); undefined for non-shrub kinds. */
  shrubVariant?: 'rhodo' | 'shrub_lite';
  /** Patch members (grass_patch / vine_patch / moss_patch only). */
  patchMembers?: ForestPatchMember[];
  /**
   * When set, dock-forest collision skips trunk + canopy landing for this instance only.
   * Harvest / visuals unchanged. Use for a single scenic gap tree, not a scale rule.
   */
  nonBlockingFootprint?: boolean;
};

export type ForestBackdropResult = {
  ground: THREE.Mesh;
  /** Normalized; directional light should sit at sunDirection * distance, targeting the scene. */
  sunDirection: THREE.Vector3;
  dockEnvironment: IdleCraftDockEnvironment;
  hemisphereLight: THREE.HemisphereLight;
  mapRadius: number;
  /** Terrain height at XZ (same sampler as mesh + carve). */
  getHeightAt: (x: number, z: number) => number;
  resolvedCreeks: ResolvedCreek[];
  /** Per-frame updaters for animated forest props (e.g. spinning sky-crystal seal).
   * Host must call each one with `dt` (seconds) inside the render loop. */
  sceneTickers: ((dt: number) => void)[];
  /** Optional disposers for animated props that need cleanup on scene teardown. */
  sceneDisposers: (() => void)[];
  /** World-space XZ of the on-map crystal scatter (free-roam harvest reuses these). */
  crystalSpotsXZ: { x: number; z: number }[];
  /**
   * Per-cluster Group references for the same crystal scatter, aligned 1:1 with
   * `crystalSpotsXZ` order. Free-roam harvest module shrinks/hides these on full break.
   */
  crystalClusters: { x: number; z: number; group: THREE.Group }[];
  /**
   * Dock-forest scatter specs. `attachDockForestBatchedScene` registers collision
   * from per-kind `blocking` flags (regrowing saplings temporarily unregister).
   */
  staticObstacles: ForestStaticObstacle[];
};

/**
 * Per-species nominal canopy top (multiplied by the tree's `sizeMult`/`sm`). These
 * are coarse approximations of the values in `goeStyleHarvestLPCA.ts` — the LPCA
 * tree builders use random per-instance scale on top of `sm`, so per-tree variation
 * shows up as ±15% around these numbers. Good enough for "can the player jump over
 * this" gameplay; not used for visuals.
 */
const TREE_SPECIES_TOP_Y_PER_SM: Record<ForestTreeSpecies, number> = {
  0: 1.6, /* apple */
  1: 1.5, /* pine */
  2: 1.5, /* birch */
  3: 1.7, /* balsam fir */
  4: 1.3, /* round oak */
};

/** Per-species TRUNK-ONLY collision radius (multiplied by the tree's `sizeMult`/`sm`).
 *
 * Tightened in 2026-04 from canopy-edge values to actual TRUNK silhouette so the
 * player can walk under the canopy and stand right next to the bark to harvest.
 * Earlier values pushed the player out at canopy distance, which combined with
 * sm=2.5+ on giant trees made max-scale specimens unreachable: the harvest-reach
 * gate could never be satisfied no matter how close the player got.
 *
 * Surface distance still scales with size via the harvest dispatch's
 * `(centerDist - collisionRadius) <= reach` check, so the player can always
 * touch the trunk. The visible canopy stays as decoration; nothing in the game
 * actually requires landing on top of a tree (foundations / floors / roof
 * pieces handle "land on this" via `getGroundY`). */
const TREE_SPECIES_RADIUS_PER_SM: Record<ForestTreeSpecies, number> = {
  0: 0.24, /* apple   — was 0.40 */
  1: 0.20, /* pine    — was 0.32 */
  2: 0.18, /* birch   — was 0.28 (slim trunk) */
  3: 0.22, /* fir     — was 0.34 */
  4: 0.26, /* oak     — was 0.42 (heavy but still trunk-only) */
};

/**
 * Attach forest + skydome + LPCA terrain + creeks + shrubs; `project` drives
 * scale and hydrology.
 *
 * **2026-04-20 Tier B — staged async build.**
 *
 * Was a single ~150-300 ms synchronous block (terrain grid + creek ribbons +
 * `scatterWorldForestStrata` (~80-150 ms — the biggest single cost) +
 * crystal scatter + sky-crystal seal + 3× `mergeByMaterialTiled` + 3×
 * vegetation-wind material patch + `attachIdleCraftNightMagic`). On every
 * device the unified preload's `_phaseForest` spent the entire build inside
 * one task that the browser cannot split externally — Chromium's "long
 * task" warning fires + input handlers freeze for the full duration.
 *
 * Now drained as **4 sub-phases** with `await yieldToEventLoop()` between
 * them (sub-ms drain via `MessageChannel.postMessage` / `scheduler.yield()`,
 * not the 16 ms `requestAnimationFrame` cost). Caller (`_phaseForest`) is
 * `async` and `create()` awaits it. Each sub-phase lands as ~30-80 ms of
 * contiguous main-thread work, well under Chromium's 50 ms long-task
 * threshold for most devices and well within the slack the browser has
 * between video decode frames during the title-time preload window.
 *
 * Phase boundaries (yield AFTER each):
 *   1. Terrain grid + skirt + water meshes + dock environment
 *   2. Tree placements + scatterWorldForestStrata (the heaviest single op)
 *   3. Crystal scatter + sky-crystal seal + shrub-ring spec collection
 *   4. mergeByMaterialTiled × 3 + vegetation wind patches
 *   (final: night-magic LPCA, no yield needed — return immediately after)
 */
export async function attachForestBackdrop(
  scene: THREE.Scene,
  project: IdleEmpireProjectFile | null,
  graphics: GraphicsBudget,
): Promise<ForestBackdropResult> {
  const { terrain, hydrology } = parseWorldFromProject(project);
  const resolved = resolveCreekPolylines(hydrology.creeks ?? []);
  const getHeightAt = createHeightSampler(terrain, resolved);
  const R = terrain.radius;
  const segRaw = Math.round(terrain.planeSegments * graphics.terrainSegmentMul);
  const seg = Math.max(graphics.terrainSegmentMin, Math.min(segRaw, graphics.terrainSegmentMax));

  scene.background = new THREE.Color(0xa8daf8);
  /* Day-fog near distance pushed 0.85 → 1.4 (mapRadius units) — 2026-04-22.
   *
   * Was 0.85 (37.4 units for R=44) which fogged trees at the FAR EDGE of the
   * dock disk and contributed to the "blur around trees from distance"
   * player report. The dock disk extends to R units; `treeWorldFar` strata
   * extend up to R*1.5+. The new 1.4 (61.6 units for R=44) keeps every dock
   * tree crisp and lets only the world strata + horizon haze pick up fog —
   * matches the "atmospheric horizon, sharp foreground" target.
   *
   * `IdleCraftDockEnvironment` overrides per-frame with the same constants
   * so this initial value matches the runtime baseline (see
   * `idleCraftDockEnvironment.ts:191` `dayFogNear = mapRadius * 1.4`). */
  scene.fog = new THREE.Fog(0xa8daf8, R * 1.4, R * 2.85);

  const hemi = new THREE.HemisphereLight(0xb8d8f0, 0x5c5648, 0.54);
  scene.add(hemi);

  const dockEnvironment = new IdleCraftDockEnvironment(scene, project, hemi, R, graphics);
  attachSkydome(scene, dockEnvironment, graphics);
  dockEnvironment.setResolvedCreeks(resolved);

  /* Trippy palette — locked decision, full replacement of the legacy `turfMat`.
   * Per-vertex colors picked by slope + height (cyan grass, magenta dirt, amber rock).
   * Material is `MeshPhysicalMaterial` with mild transmission + emissive lift so the
   * ground reads as "glowing wet candy" under bloom. See
   * `docs/TRIPPY_TERRAIN_AND_BOUNCE_MUSHROOMS_PLAN.md` §4.1 + §5 Phase 1. */
  const terrainGeo = buildTerrainGridGeometry(R, seg, getHeightAt);
  await measureBlockAsync('forest.bakeTrippyGround', () =>
    bakeTrippyGroundVertexColorsChunked(terrainGeo, getHeightAt, terrain.heightScale),
  );
  const turfMat = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.45,
    metalness: 0.05,
    transmission: 0.18,
    thickness: 0.25,
    ior: 1.2,
    emissive: 0x111122,
  });
  const ground = new THREE.Mesh(terrainGeo, turfMat);
  ground.receiveShadow = true;
  scene.add(ground);

  const skirtMat = stdMat({ color: 0x151c14, roughness: 0.96 });
  skirtMat.side = THREE.DoubleSide;
  const skirtSeg = Math.max(graphics.tier === 'low' ? 24 : 48, Math.floor(seg / 2));
  const skirt = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 1.012, R * 0.99, terrain.skirtDepth, skirtSeg, 1, true),
    skirtMat,
  );
  skirt.position.y = -terrain.skirtDepth * 0.5 - 0.05;
  skirt.receiveShadow = true;
  scene.add(skirt);

  const waterMat = getWaterPlaneMaterial().clone();
  waterMat.polygonOffset = true;
  waterMat.polygonOffsetFactor = -1.2;
  waterMat.polygonOffsetUnits = -1;
  const waterMeshes: THREE.Mesh[] = [];
  for (const creek of resolved) {
    const wgeo = buildCreekRibbonGeometry(creek, getHeightAt, 0.034);
    if (!wgeo) continue;
    const wm = new THREE.Mesh(wgeo, waterMat);
    wm.receiveShadow = true;
    waterMeshes.push(wm);
  }
  dockEnvironment.registerWater(waterMeshes, waterMat);

  /* Tier B yield #1 — after terrain + skirt + water + dockEnvironment.
   * Lets video decode / input drain before the heavy scatter + tree LPCA
   * builds in `scatterWorldForestStrata`. */
  await yieldToEventLoop();

  const dockPhases = await attachDockForestBackdropForestPhases(
    scene,
    project,
    graphics,
    dockEnvironment,
    ground,
    R,
    resolved,
    getHeightAt,
  );

  return {
    ground,
    sunDirection: dockPhases.sunDirection,
    dockEnvironment,
    hemisphereLight: hemi,
    mapRadius: R,
    getHeightAt,
    resolvedCreeks: resolved,
    sceneTickers: dockPhases.sceneTickers,
    sceneDisposers: dockPhases.sceneDisposers,
    crystalSpotsXZ: dockPhases.crystalSpotsXZ,
    crystalClusters: dockPhases.crystalClusters,
    staticObstacles: dockPhases.staticObstacles,
  };
}

/**
 * Forest strata + crystals + merges + night magic — same sequence as the tail of
 * {@link attachForestBackdrop} after base terrain/water. Used by the render worker
 * so dock parity does not duplicate logic.
 */
export async function attachDockForestBackdropForestPhases(
  scene: THREE.Scene,
  project: IdleEmpireProjectFile | null,
  graphics: GraphicsBudget,
  dockEnvironment: IdleCraftDockEnvironment,
  _ground: THREE.Mesh,
  R: number,
  resolved: ResolvedCreek[],
  getHeightAt: (x: number, z: number) => number,
): Promise<{
  sunDirection: THREE.Vector3;
  sceneTickers: ((dt: number) => void)[];
  sceneDisposers: (() => void)[];
  crystalSpotsXZ: { x: number; z: number }[];
  crystalClusters: { x: number; z: number; group: THREE.Group }[];
  staticObstacles: ForestStaticObstacle[];
}> {
  const dockSpawn = readDockSpawn(project);
  const dockCx = dockSpawn.homeX;
  const dockCz = dockSpawn.homeZ;
  const ringMul = R / 5.5;
  const vegShadowNear = dockForestShadowNearM(R);
  const treeWorldNear = new THREE.Group();
  const treeWorldFar = new THREE.Group();
  const understoryStaging = new THREE.Group();
  understoryStaging.name = 'forest-understory-staging';

  /* Collect per-instance harvestable obstacle specs during scatter. These are NOT
   * added to the merged forest groups — they're rendered separately by the
   * InstancedMesh-based dock-forest-harvestables scene (see
   * `src/world/dockForestHarvestables.ts`) so each tree / shrub / berry_bush / rock
   * can be hidden + fall-animated per-instance the same way the awakened-mode
   * harvest scatter handles its apple trees. The non-harvestable understory items
   * (grass, vines, moss, ferns, heather) DO go into the merged path with wind. */
  const staticObstacles: ForestStaticObstacle[] = [];

  DOCK_FOREST_RING_TREE_PLACEMENTS.forEach(([x, z, sc, species], idx) => {
    const wx = dockCx + x * ringMul;
    const wz = dockCz + z * ringMul;
    const ty = getHeightAt(wx, wz);
    /* Inner ring: taller stems + variance so silhouettes read at dock scale. */
    const ringBoost = 1.22 + (idx % 6) * 0.045 + ((idx >> 3) % 4) * 0.03;
    const sm = 1.04 * sc * ringBoost;
    const rotY = (idx * 0.37) % (Math.PI * 2);
    staticObstacles.push({
      kind: 'tree',
      x: wx, z: wz,
      baseY: ty,
      topY: ty + TREE_SPECIES_TOP_Y_PER_SM[species] * sm,
      radius: TREE_SPECIES_RADIUS_PER_SM[species] * sm,
      scale: sm,
      rotY,
      species,
      ...(idx === DOCK_RING_PASS_THROUGH_TREE_IDX ? { nonBlockingFootprint: true } : {}),
    });
  });
  await measureBlockAsync('forest.scatterStrata', () =>
    scatterWorldForestStrata(
      treeWorldNear,
      treeWorldFar,
      dockCx,
      dockCz,
      vegShadowNear,
      getHeightAt,
      R,
      resolved,
      forestRand(41811),
      understoryStaging,
      staticObstacles,
    ),
  );

  /* Tier B yield #2 — after the SINGLE HEAVIEST step (`scatterWorldForestStrata`
   * is ~80-150 ms of LPCA tree builds + transform writes). Before this yield,
   * the main thread has been blocked since yield #1; without this slot, the
   * browser would land yield #1's wait + the entire scatter as one combined
   * task. */
  await yieldToEventLoop();

  /* Ring rocks are now rendered by the InstancedMesh-based dock-forest-harvestables
   * scene (so they crumble on harvest just like the awakened-mode scatter rocks).
   * We just emit the spec here; no merged-mesh visual on this path. */
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2 + 0.3;
    const r = (1.4 + (i % 3) * 0.15) * ringMul;
    const rx = dockCx + Math.cos(ang) * r;
    const rz = dockCz + Math.sin(ang) * r;
    const rockSize = 0.08 + (i % 2) * 0.04;
    const ty = getHeightAt(rx, rz);
    /* The InstancedMesh template is built at unit scale (radius 0.1); per-instance
     * scale is rockSize / 0.1 so the rendered rock matches the original visual. */
    staticObstacles.push({
      kind: 'rock',
      x: rx, z: rz,
      baseY: ty,
      topY: ty + rockSize * 2 + 0.1,
      radius: rockSize * 1.6,
      scale: rockSize / 0.1,
      rotY: i * 0.2,
    });
  }

  /* Dark-fantasy crystal scatter — small/medium/large glowing gem clusters around the
   * dock. Same gem PBR + iridescence recipe as the wizard's staff, scaled up to ground
   * formations including 6 towering landmark monoliths in the outer ring.
   *
   * Returns per-cluster Group references (aligned with `crystalSpotsXZ` order below) so
   * the awakened-mode harvest module can shrink/hide individual clusters when fully
   * harvested — the rubble bed stays as scenery, only the gem cluster shatters out. */
  const crystalClusters = scatterIdleCraftCrystalProps(scene, dockCx, dockCz, ringMul, getHeightAt);

  /* THE SEAL — giant slowly-spinning sci-fi-dark-fantasy crystal hovering high above
   * the dock. Lore: this is the Witches Guild's binding crystal that locks the wizard
   * into the idle-deck dream-prison (`LORE.md` §4–§6). Returns an updater the host
   * must call each frame to drive the rotation + orbital animation. */
  const skyCrystalSeal: IdleCraftSkyCrystalSealHandle = attachIdleCraftSkyCrystalSeal(
    scene,
    dockCx,
    dockCz,
  );
  const sceneTickers: ((dt: number) => void)[] = [(dt) => skyCrystalSeal.update(dt)];
  const sceneDisposers: (() => void)[] = [() => skyCrystalSeal.dispose()];

  /* Tier B yield #3 — after crystal scatter + sky-crystal seal. Next block
   * is `mergeByMaterialTiled` × 3 + `installVegetationWindOnMergedGroup` × 3
   * (~40-80 ms of geometry merge + material clones). Yield so the seal's
   * scene-graph attach actually paints before the merge takes the thread. */
  await yieldToEventLoop();

  /* Camp-clearing decorative ring spec table — boxwood (0) / fern (1) / heather (2)
   * placements relative to the dock center. The shared shrub/fern/heather materials
   * used by these specs are owned by the BatchedMesh scene now (see
   * `dockForestBatchedScene.ts`); we only emit positions + scale + rotation here. */
  /** sx, sz, scale, rotY, kind: 0 boxwood, 1 fern, 2 heather */
  const shrubRing: [number, number, number, number, number][] = [
    [-1.85, -0.55, 0.95, 0.2, 0],
    [-2.15, 0.95, 1.02, 1.1, 1],
    [1.92, -0.72, 0.88, 2.4, 2],
    [2.2, 1.1, 0.92, 3.9, 0],
    [-0.55, -2.05, 0.9, 0.8, 1],
    [0.62, -2.15, 0.87, 5.1, 2],
    [-2.5, -1.85, 0.78, 4.2, 0],
    [2.45, 1.65, 0.82, 2.9, 1],
    [0.1, 2.35, 0.85, 1.7, 2],
    [-1.1, 2.2, 0.8, 3.3, 0],
    [1.25, 2.05, 0.83, 0.5, 1],
    [-2.95, 0.2, 0.72, 2.1, 2],
    [-3.6, -0.3, 0.88, 1.55, 0],
    [3.4, -1.0, 0.86, 2.2, 1],
    [-0.8, 3.2, 0.79, 4.5, 2],
    [2.8, 3.5, 0.81, 0.9, 0],
    [4.2, 1.8, 0.74, 3.1, 1],
    [-4.0, 2.4, 0.76, 5.6, 2],
    [1.0, -3.0, 0.84, 2.8, 0],
    [-1.4, -3.4, 0.77, 4.1, 1],
    [-3.2, 1.4, 0.8, 2.2, 0],
    [3.0, 2.8, 0.78, 1.1, 2],
    [-1.6, 3.8, 0.74, 4.8, 1],
    [2.1, -3.6, 0.76, 0.6, 2],
    [-4.4, -2.6, 0.72, 3.4, 0],
    [4.5, 2.2, 0.73, 5.2, 1],
  ];
  /* Camp-clearing decorative ring: every shrub / fern / heather here is harvestable.
   * Per the universal-harvest pass, all named plants on the dock yield resources
   * with proper fall/collapse animations. Rendered by the BatchedMesh scene; spec
   * captured here (no merged-mesh add). */
  for (const [sx, sz, sc, ry, kind] of shrubRing) {
    const wx = dockCx + sx * ringMul;
    const wz = dockCz + sz * ringMul;
    const y0 = getHeightAt(wx, wz);
    if (kind === 1) {
      /* Fern cluster — height ~0.55 m at unit scale, footprint ~0.20 m. */
      staticObstacles.push({
        kind: 'fern',
        x: wx, z: wz,
        baseY: y0,
        topY: y0 + 0.55 * sc,
        radius: 0.2 * sc,
        scale: sc,
        rotY: ry,
      });
    } else if (kind === 2) {
      /* Heather mound — height ~0.45 m, footprint ~0.30 m. */
      staticObstacles.push({
        kind: 'heather',
        x: wx, z: wz,
        baseY: y0,
        topY: y0 + 0.45 * sc * 0.92,
        radius: 0.3 * sc,
        scale: sc * 0.92,
        rotY: ry,
      });
    } else {
      /* shrubLite shrub — height ~0.8 m, footprint ~0.35 m. */
      staticObstacles.push({
        kind: 'shrub',
        x: wx, z: wz,
        baseY: y0,
        topY: y0 + 0.8 * sc,
        radius: 0.35 * sc,
        scale: sc,
        rotY: ry,
        shrubVariant: 'shrub_lite',
      });
    }
  }

  /* Spatial-tile merge (`docs/AWAKENING_AND_FREE_ROAM_PLAN.md` §9 + LEARNINGS spatial-tile
   * entry). A single `mergeByMaterial(treeWorldNear)` collapses every tree in the disk into
   * a few merged meshes whose bounding sphere covers the WHOLE disk — frustum culling never
   * kicks in even though only ~25-40% of trees are in the camera view at any moment, and
   * the GPU vertex-shades every tree on both sides of the avatar each frame.
   *
   * Tiling into a 3×3 grid over the dock disk produces ~9 sub-merges per group, each with
   * a tight per-tile bounding sphere → typically 2-4 tiles intersect the camera frustum
   * per frame and the rest are culled. Vegetation wind shader work drops by ~60-75%, the
   * shadow pass drops by ~50%, and per-frame GPU cost on integrated/laptop hardware drops
   * substantially. Material identity is preserved across tiles so the wind shader's
   * WeakSet-gated material patch + shared-uniform per-frame update still work unchanged.
   * Cell width covers the full disk diameter (`R * 2 / 3`) so all scattered trees fall
   * inside one of the 9 buckets. */
  const FOREST_GRID = 3;
  const FOREST_CELL = (R * 2) / FOREST_GRID;
  const mergedForestNear = measureBlock('forest.mergeNear', () =>
    mergeByMaterialTiled(treeWorldNear, FOREST_GRID, dockCx, dockCz, FOREST_CELL),
  );
  /* Round 5 phase C3 — yield between merge passes so each ~40-80 ms tile
   * merge lands as its own task instead of stacking into one ~120-240 ms
   * combined task. Cheap (sub-ms cascade) and `mergeByMaterialTiled` is a
   * pure CPU geometry merge with no inter-call state to coordinate. */
  await yieldToEventLoop();
  const mergedForestFar = measureBlock('forest.mergeFar', () =>
    mergeByMaterialTiled(treeWorldFar, FOREST_GRID, dockCx, dockCz, FOREST_CELL),
  );
  mergedForestNear.castShadow = true;
  /* Far-tree group never casts shadows — keeps shadow map texels focused on
   * the near disk where the player actually sees contact shadows.
   *
   * 2026-04-22 — briefly tried conditional `graphics.tier === 'high'` but
   * the extra casters compounded with Phase D shadow softening to produce
   * visible "voxel block" PCF banding on edge-of-frustum trees. Reverted.
   * If far-tree shadows return in the future, they'll need either a
   * dedicated cascade or a much larger shadow map (4096+) so the texel
   * density doesn't drop at distance. */
  mergedForestFar.castShadow = false;
  await yieldToEventLoop();
  const mergedUnderstory = measureBlock('forest.mergeUnderstory', () =>
    mergeByMaterialTiled(understoryStaging, FOREST_GRID, dockCx, dockCz, FOREST_CELL),
  );
  mergedUnderstory.castShadow = false;
  if (graphics.enableVegetationWind) {
    await yieldToEventLoop();
    measureBlock('forest.windInstall', () => {
      cloneMaterialsForVegetationWind(mergedForestNear);
      cloneMaterialsForVegetationWind(mergedForestFar);
      cloneMaterialsForVegetationWind(mergedUnderstory);
      installVegetationWindOnMergedGroup(mergedForestNear, { flexMul: 0.94 });
      installVegetationWindOnMergedGroup(mergedForestFar, { flexMul: 0.94 });
      installVegetationWindOnMergedGroup(mergedUnderstory, { understory: true, flexMul: 1.06 });
    });
  }
  scene.add(mergedForestNear);
  scene.add(mergedForestFar);
  scene.add(mergedUnderstory);

  /* Tier B yield #4 — after the merge + wind-shader patch passes. Final
   * block is `attachIdleCraftNightMagic` (~30-60 ms of mushroom / firefly /
   * glow LPCA builds) which only runs when night magic is enabled. Yield
   * so the merged forest paints before the night-magic LPCA construction
   * blocks the thread. */
  await yieldToEventLoop();

  if (graphics.nightMagicQuality !== 'off') {
    attachIdleCraftNightMagic(scene, dockEnvironment, {
      getHeightAt,
      dockCx,
      dockCz,
      ringMul,
      placements: DOCK_FOREST_RING_TREE_PLACEMENTS,
      resolved,
      gatherAnchors: getIdleCraftGatherAnchors(project),
      nightMagicQuality: graphics.nightMagicQuality === 'reduced' ? 'reduced' : 'full',
    });
  }

  const sunDirection = dockEnvironment.getSunDirection(new THREE.Vector3());
  const crystalSpotsXZ = getIdleCraftCrystalWorldPositions(dockCx, dockCz, ringMul);
  return {
    sunDirection,
    sceneTickers,
    sceneDisposers,
    crystalSpotsXZ,
    crystalClusters,
    staticObstacles,
  };
}

/** Global polar grid + trees: keep ground cover out of creek corridors. */
const COVER_MIN_DIST_RIVER = 1.65;
/**
 * Dock halo / inner ring / creek bank: allow **riparian** props. The old 1.65 m rule rejected almost
 * everything near spawn when the creek passes close to `dock` — so nothing colorful read by the avatar.
 */
const COVER_MIN_DIST_DOCK_ZONES = 0.72;
/** Keep avatar feet clear on low strata; trees may start slightly closer. */
const CAMP_CORE_CLEAR = 0.88;

function distXZToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const ab2 = abx * abx + abz * abz || 1;
  let t = (apx * abx + apz * abz) / ab2;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + abx * t;
  const qz = az + abz * t;
  return Math.hypot(px - qx, pz - qz);
}
/**
 * World polar grid skips props closer than this to `dock` (feet + a hair) so the avatar isn’t buried.
 * The big empty ring was from ~0.26·R — too large; camp fill uses {@link scatterDockHaloGroundCover} instead.
 */
function dockStrataGroundExcludeR(): number {
  return CAMP_CORE_CLEAR + 0.22;
}
/** Stratum trees: small inner skip so trunks don’t spawn on the mat; vista ring still anchors the shot. */
function dockStrataTreeExcludeR(R: number): number {
  return Math.min(5.2, Math.max(2.35, R * 0.058));
}

function pickSpeciesForStratum(layer: 0 | 1 | 2, rand: () => number): ForestTreeSpecies {
  const u = rand();
  if (layer === 0) {
    if (u < 0.28) return 0;
    if (u < 0.48) return 4;
    if (u < 0.66) return 3;
    if (u < 0.82) return 1;
    if (u < 0.93) return 2;
    return rand() < 0.5 ? 0 : 4;
  }
  if (layer === 1) {
    if (u < 0.26) return 0;
    if (u < 0.48) return 4;
    if (u < 0.62) return 3;
    if (u < 0.74) return 1;
    if (u < 0.86) return 2;
    return rand() < 0.55 ? 0 : 4;
  }
  if (u < 0.34) return 0;
  if (u < 0.58) return 4;
  if (u < 0.72) return 1;
  if (u < 0.84) return 3;
  if (u < 0.93) return 2;
  return 0;
}

function addStratumTree(
  _treeNear: THREE.Group,
  _treeFar: THREE.Group,
  _dockCx: number,
  _dockCz: number,
  _shadowNearRadius: number,
  getHeightAt: (x: number, z: number) => number,
  wx: number,
  wz: number,
  layer: 0 | 1 | 2,
  species: ForestTreeSpecies,
  _seed: number,
  rand: () => number,
  staticObstacles: ForestStaticObstacle[],
): void {
  let sm: number;
  if (layer === 0) {
    const base = 1.18 + rand() * 0.4;
    const tier = rand();
    const mult =
      tier < 0.09 ? 2.55 + rand() * 0.55 : tier < 0.32 ? 1.72 + rand() * 0.28 : 1;
    sm = base * mult;
  } else if (layer === 1) sm = 0.9 + rand() * 0.3;
  else sm = 0.74 + rand() * 0.26;
  const rotY = rand() * Math.PI * 2;
  const ty = getHeightAt(wx, wz);
  /* No more merged-mesh add — the InstancedMesh scene renders this tree from the
   * spec we push below. The merged near/far groups stay empty for trees (they only
   * receive non-harvestable understory items now). */
  staticObstacles.push({
    kind: 'tree',
    x: wx, z: wz,
    baseY: ty,
    topY: ty + TREE_SPECIES_TOP_Y_PER_SM[species] * sm,
    radius: TREE_SPECIES_RADIUS_PER_SM[species] * sm,
    scale: sm,
    rotY,
    species,
  });
}

/**
 * Map-wide forest strata: **polar grid + jitter** for every vertical layer (trees + shrubs + ground)
 * so the full disk matches the even, filled-in read of the opening view — not patchy random throws.
 */
async function scatterWorldForestStrata(
  treeNear: THREE.Group,
  treeFar: THREE.Group,
  dockCx: number,
  dockCz: number,
  shadowNearRadius: number,
  getHeightAt: (x: number, z: number) => number,
  R: number,
  creeks: ResolvedCreek[],
  rand: () => number,
  understoryRoot: THREE.Group,
  staticObstacles: ForestStaticObstacle[],
): Promise<void> {
  /* Round 5 phase C2 — scatter is the single heaviest sync block in the
   * forest preload (~80-150 ms per inline comment at the call site). The
   * hot path is `placeTreeStratumEvenDisk`'s inner slice loop calling
   * `addStratumTree` (full LPCA tree mesh build per slot). Track wall-clock
   * since the last yield and break to event loop whenever budget exceeded.
   * Sub-ms cost per yield (scheduler.yield → MessageChannel cascade); the
   * win is that no single task exceeds the 60 Hz frame budget so input +
   * paint can drain.
   *
   * 2026-04-22 — budget bumped 8 → 16 ms after cutscene removal. The 8 ms
   * cap was for cutscene-decode protection; without video to protect, 16 ms
   * (one full paint frame) is the right target and halves the yield count. */
  const CHUNK_BUDGET_MS = 16;
  let scatterChunkStart = performance.now();
  const scatterMaybeYield = async (): Promise<void> => {
    if (performance.now() - scatterChunkStart >= CHUNK_BUDGET_MS) {
      await yieldToEventLoop();
      scatterChunkStart = performance.now();
    }
  };
  /**
   * Adds a NON-HARVESTABLE understory plant (grasses, vines, moss, ferns, heather) to
   * the merged staging group with wind-sway baked in. Harvestable kinds (shrubs +
   * berry bushes) are no longer added to the merged group — they get rendered by the
   * InstancedMesh-based dock-forest-harvestables scene so they can fall on harvest.
   * Their visual + collision spec is collected via `pushObs` instead.
   */
  const addUnderstory = (obj: THREE.Object3D, terrainY: number): void => {
    bakeVegetationWindHeightAboveGround(obj, terrainY);
    understoryRoot.add(obj);
  };

  /* Patch staging — every individual grass / vine / moss placement records its
   * world position + sub-kind + scale + seed here. After all placeGroundStratum
   * calls finish, `groupIntoPatches` clusters nearby members of the same kind
   * (within PATCH_RADIUS = 1.5 m) into one harvestable patch spec. Cuts ~150
   * individual ground items down to ~30-50 patches that the player harvests
   * with one E-press each. */
  type PatchMemberRecord = {
    x: number; z: number; baseY: number;
    scale: number; rotY: number; subKind: string; seed: number;
  };
  const grassMembers: PatchMemberRecord[] = [];
  const vineMembers: PatchMemberRecord[] = [];
  const mossMembers: PatchMemberRecord[] = [];
  const PATCH_RADIUS = 1.5;
  const PATCH_RADIUS_SQ = PATCH_RADIUS * PATCH_RADIUS;
  const PATCH_MAX_MEMBERS = 10;

  const d = R / 44;
  const dockGrEx = dockStrataGroundExcludeR();
  const dockTrEx = dockStrataTreeExcludeR(R);

  let sid = 91000;

  const rMinGr = R * 0.042;
  const rMaxGr = R * 0.968;
  const diskA = Math.PI * (rMaxGr * rMaxGr - rMinGr * rMinGr);

  const placeTreeStratumEvenDisk = async (
    layer: 0 | 1 | 2,
    spacing: number,
    rMinF: number,
    rMaxF: number,
    minDockClear: number,
    seedBase: number,
  ): Promise<void> => {
    const rMinT = R * rMinF;
    const rMaxT = R * rMaxF;
    const diskT = Math.PI * (rMaxT * rMaxT - rMinT * rMinT);
    const est = Math.max(20, Math.floor(diskT / (spacing * spacing)));
    const rings = Math.max(6, Math.floor(Math.sqrt(est / 2.05)));
    const slices = Math.max(12, Math.ceil(est / rings));
    let seed = seedBase;
    const angOff = layer * 0.41;
    for (let ir = 0; ir < rings; ir++) {
      const rf = (ir + 0.5 + (rand() - 0.5) * 0.76) / rings;
      const rr = rMinT + rf * (rMaxT - rMinT);
      for (let ia = 0; ia < slices; ia++) {
        const th =
          ((ia + 0.5 + (rand() - 0.5) * 0.72) / slices) * Math.PI * 2 + angOff + (layer + ir) * 0.09;
        let x = Math.cos(th) * rr;
        let z = Math.sin(th) * rr;
        const jitter = spacing * 0.44;
        x += (rand() - 0.5) * jitter;
        z += (rand() - 0.5) * jitter;
        const rad = Math.hypot(x, z);
        if (rad > R * 0.975 || rad < rMinT * 0.88) continue;
        if (Math.hypot(x - dockCx, z - dockCz) < Math.max(minDockClear, dockTrEx)) continue;
        if (minDistToCreekNetwork(x, z, creeks) < COVER_MIN_DIST_RIVER) continue;
        addStratumTree(
          treeNear,
          treeFar,
          dockCx,
          dockCz,
          shadowNearRadius,
          getHeightAt,
          x,
          z,
          layer,
          pickSpeciesForStratum(layer, rand),
          seed++,
          rand,
          staticObstacles,
        );
        await scatterMaybeYield();
      }
    }
  };

  /* Emergent (sparse), canopy, understory — even coverage, layer-staggered angles. */
  const treeSp0 = (12.2 + 0.35 * d) * 0.9;
  const treeSp1 = (6.55 + 0.22 * d) * 0.9;
  const treeSp2 = (4.85 + 0.18 * d) * 0.9;
  await placeTreeStratumEvenDisk(0, treeSp0, 0.2, 0.96, 0.58, sid + 10000);
  await placeTreeStratumEvenDisk(1, treeSp1, 0.075, 0.97, 0.52, sid + 20000);
  await placeTreeStratumEvenDisk(2, treeSp2, 0.048, 0.97, 0.46, sid + 25000);

  const placeGroundStratum = (
    layer: 3 | 4 | 5 | 6,
    x: number,
    z: number,
    seed: number,
  ): void => {
    const y = getHeightAt(x, z);
    const rf = forestRand(seed);
    const u = rf();
    const rFn = () => (rand() + rf()) % 1;
    /* Tiny helper: append a harvestable understory spec. Now covers shrubs (with
     * variant), berry bushes, ferns, heather, AND opens the door for grass/vine/moss
     * (those are emitted as patches via `pushPatchObs` below, NOT individual specs).
     * Every harvestable plant gets rendered by the BatchedMesh scene with proper
     * sway + fall-on-harvest animations. */
    const pushObs = (
      kind: 'shrub' | 'berry_bush' | 'fern' | 'heather',
      scale: number,
      heightAtUnitScale: number,
      radiusAtUnitScale: number,
      rotY: number,
      shrubVariant?: 'rhodo' | 'shrub_lite',
    ): void => {
      staticObstacles.push({
        kind,
        x, z,
        baseY: y,
        topY: y + heightAtUnitScale * scale,
        radius: radiusAtUnitScale * scale,
        scale,
        rotY,
        shrubVariant,
      });
    };
    /* Per-frame member-staging helpers — push to scatterWorldForestStrata closure
     * arrays. Patch grouping runs after all placeGroundStratum calls finish. */
    const pushGrassMember = (subKind: 'fiber' | 'tuft' | 'sedge', scale: number, ry: number): void => {
      grassMembers.push({ x, z, baseY: y, scale, rotY: ry, subKind, seed: seed ^ Math.floor(scale * 1e5) });
    };
    const pushVineMember = (subKind: 'creeper' | 'drape', scale: number, ry: number): void => {
      vineMembers.push({ x, z, baseY: y, scale, rotY: ry, subKind, seed: seed ^ Math.floor(scale * 1e5) });
    };
    const pushMossMember = (scale: number, ry: number): void => {
      mossMembers.push({ x, z, baseY: y, scale, rotY: ry, subKind: 'moss', seed: seed ^ Math.floor(scale * 1e5) });
    };

    if (layer === 3) {
      const t = Math.floor(u * 6);
      if (t === 0) {
        const bs = 0.44 + rand() * 0.14;
        const ry = rand() * Math.PI * 2;
        pushObs('berry_bush', bs, 0.6, 0.32, ry);
      } else if (t === 1) {
        const rs = 0.88 + rand() * 0.18;
        const ry = rand() * Math.PI * 2;
        pushObs('shrub', rs, 0.7, 0.4, ry, 'rhodo');
      } else if (t === 2) {
        const ss = 0.64 + rand() * 0.28;
        const ry = rand() * Math.PI * 2;
        pushObs('shrub', ss, 0.8, 0.35, ry, 'shrub_lite');
      } else if (t === 3) {
        const fs = 0.74 + rand() * 0.22;
        pushObs('fern', fs, 0.55, 0.2, rand() * Math.PI * 2);
      } else if (t === 4) {
        pushVineMember('creeper', 0.92 + rand() * 0.2, rand() * Math.PI * 2);
      } else {
        pushVineMember('drape', 0.94 + rand() * 0.2, rand() * Math.PI * 2);
      }
    } else if (layer === 4) {
      const t = Math.floor(u * 7);
      if (t === 0 || t === 1) {
        const hs = 0.52 + rand() * 0.22;
        pushObs('heather', hs, 0.45, 0.3, rand() * Math.PI * 2);
      } else if (t === 2) {
        const rs = 0.62 + rand() * 0.16;
        const ry = rand() * Math.PI * 2;
        pushObs('shrub', rs, 0.7, 0.4, ry, 'rhodo');
      } else if (t === 3) {
        const fs = 0.68 + rand() * 0.2;
        pushObs('fern', fs, 0.55, 0.2, rand() * Math.PI * 2);
      } else if (t === 4) {
        const ss = 0.58 + rand() * 0.24;
        const ry = rand() * Math.PI * 2;
        pushObs('shrub', ss, 0.8, 0.35, ry, 'shrub_lite');
      } else if (t === 5) {
        const bs = 0.4 + rand() * 0.12;
        const ry = rand() * Math.PI * 2;
        pushObs('berry_bush', bs, 0.6, 0.32, ry);
      } else {
        const creep = rand() < 0.52;
        const vs = (creep ? 0.88 : 0.9) + rand() * 0.18;
        pushVineMember(creep ? 'creeper' : 'drape', vs, rand() * Math.PI * 2);
      }
    } else if (layer === 5) {
      const t = Math.floor(u * 6);
      if (t === 0) {
        pushGrassMember('fiber', 0.9 + rand() * 0.22, rand() * Math.PI * 2);
      } else if (t === 1) {
        pushGrassMember('tuft', 0.92 + rand() * 0.22, rand() * Math.PI * 2);
      } else if (t === 2) {
        pushGrassMember('sedge', 0.88 + rand() * 0.2, rand() * Math.PI * 2);
      } else if (t === 3) {
        pushVineMember('creeper', 0.86 + rand() * 0.18, rand() * Math.PI * 2);
      } else if (t === 4) {
        pushVineMember('drape', 0.88 + rand() * 0.18, rand() * Math.PI * 2);
      } else {
        pushMossMember(0.82 + rand() * 0.18, rand() * Math.PI * 2);
      }
    } else {
      const t = Math.floor(u * 9);
      if (t === 0 || t === 1) {
        pushGrassMember('fiber', 0.72 + rand() * 0.2, rand() * Math.PI * 2);
      } else if (t === 2) {
        const hs = 0.48 + rand() * 0.16;
        pushObs('heather', hs, 0.45, 0.3, rand() * Math.PI * 2);
      } else if (t === 3) {
        const fs = 0.55 + rand() * 0.18;
        pushObs('fern', fs, 0.55, 0.2, rand() * Math.PI * 2);
      } else if (t === 4) {
        const ss = 0.52 + rand() * 0.22;
        pushObs('shrub', ss, 0.8, 0.35, rand() * Math.PI * 2, 'shrub_lite');
      } else if (t === 5) {
        pushVineMember('creeper', 0.68 + rand() * 0.16, rand() * Math.PI * 2);
      } else if (t === 6) {
        pushVineMember('drape', 0.7 + rand() * 0.16, rand() * Math.PI * 2);
      } else {
        pushMossMember(0.62 + rand() * 0.16, rand() * Math.PI * 2);
      }
    }
    /* `addUnderstory` and `rFn` are intentionally unreferenced now — every plant
     * goes through the BatchedMesh path. Keep them in scope so the wider closure
     * doesn't break if future code wants to fall back to merged for any reason. */
    void addUnderstory; void rFn;
  };

  const placeStratumEvenDisk = async (layer: 3 | 4 | 5 | 6, spacing: number, seedBase: number): Promise<void> => {
    const est = Math.min(380, Math.max(56, Math.floor(diskA / (spacing * spacing))));
    const rings = Math.max(9, Math.floor(Math.sqrt(est / 2.05)));
    const slices = Math.max(15, Math.ceil(est / rings));
    let seed = seedBase;
    for (let ir = 0; ir < rings; ir++) {
      const rf = (ir + 0.5 + (rand() - 0.5) * 0.78) / rings;
      const rr = rMinGr + rf * (rMaxGr - rMinGr);
      for (let ia = 0; ia < slices; ia++) {
        const th = ((ia + 0.5 + (rand() - 0.5) * 0.74) / slices) * Math.PI * 2;
        let x = Math.cos(th) * rr;
        let z = Math.sin(th) * rr;
        const jitter = spacing * 0.48;
        x += (rand() - 0.5) * jitter;
        z += (rand() - 0.5) * jitter;
        const rad = Math.hypot(x, z);
        if (rad > R * 0.975 || rad < rMinGr * 0.9) continue;
        if (Math.hypot(x - dockCx, z - dockCz) < dockGrEx) continue;
        if (minDistToCreekNetwork(x, z, creeks) < COVER_MIN_DIST_RIVER) continue;
        placeGroundStratum(layer, x, z, seed++);
      }
      /* Per-ring yield: ground placements are cheaper per item than tree
       * builds, but the outer rings have many slices each — yield once per
       * ring to keep tasks bounded without overhead-per-item. */
      await scatterMaybeYield();
    }
  };

  /* Even disk on the outer map; camp inner disk uses vista + shrub ring only (see dockGrEx). */
  const spMul = 1.26;
  const sp3 = (4.65 + 0.28 * d) * 0.88 * spMul;
  const sp4 = (4.05 + 0.24 * d) * 0.88 * spMul;
  const sp5 = (3.2 + 0.2 * d) * 0.88 * spMul;
  const sp6 = (2.72 + 0.16 * d) * 0.88 * spMul;
  await placeStratumEvenDisk(3, sp3, sid + 300000);
  await placeStratumEvenDisk(4, sp4, sid + 400000);
  await placeStratumEvenDisk(5, sp5, sid + 500000);
  await placeStratumEvenDisk(6, sp6, sid + 600000);

  scatterDockHaloGroundCover(creeks, dockCx, dockCz, R, d, placeGroundStratum, rand, sid + 800000);
  /* Tight ring at **dock** — colorful strata read next to the avatar (halo alone biases outward by area). */
  scatterDockInnerShrubRing(
    creeks,
    dockCx,
    dockCz,
    R,
    placeGroundStratum,
    rand,
    sid + 850000,
  );
  scatterCreekBankColorShrubs(creeks, R, dockCx, dockCz, placeGroundStratum, rand, sid + 880000);

  /* ============================================================================
   * PATCH GROUPING — group nearby grass / vine / moss members into harvestable
   * patches. Cluster each kind's members by proximity (PATCH_RADIUS = 1.5 m,
   * max PATCH_MAX_MEMBERS = 10 per patch) and emit one ForestStaticObstacle per
   * patch. Cuts ~150 individual ground items down to ~30-50 patches.
   * ============================================================================ */
  const groupIntoPatches = (
    members: PatchMemberRecord[],
    patchKind: 'grass_patch' | 'vine_patch' | 'moss_patch',
    baseCollisionRadius: number,
    baseTopY: number,
  ): void => {
    if (members.length === 0) return;
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < members.length; i++) {
      const m = members[i]!;
      const cx = Math.floor(m.x / PATCH_RADIUS);
      const cz = Math.floor(m.z / PATCH_RADIUS);
      const key = `${cx}|${cz}`;
      let arr = buckets.get(key);
      if (!arr) {
        arr = [];
        buckets.set(key, arr);
      }
      arr.push(i);
    }
    const assigned = new Uint8Array(members.length);
    for (let seedIdx = 0; seedIdx < members.length; seedIdx++) {
      if (assigned[seedIdx]) continue;
      const seedM = members[seedIdx]!;
      assigned[seedIdx] = 1;
      const patchIndices: number[] = [seedIdx];
      const cx = Math.floor(seedM.x / PATCH_RADIUS);
      const cz = Math.floor(seedM.z / PATCH_RADIUS);
      for (let dcx = -1; dcx <= 1 && patchIndices.length < PATCH_MAX_MEMBERS; dcx++) {
        for (let dcz = -1; dcz <= 1 && patchIndices.length < PATCH_MAX_MEMBERS; dcz++) {
          const nb = buckets.get(`${cx + dcx}|${cz + dcz}`);
          if (!nb) continue;
          for (const candIdx of nb) {
            if (assigned[candIdx]) continue;
            const c = members[candIdx]!;
            const dx = c.x - seedM.x;
            const dz = c.z - seedM.z;
            if (dx * dx + dz * dz > PATCH_RADIUS_SQ) continue;
            assigned[candIdx] = 1;
            patchIndices.push(candIdx);
            if (patchIndices.length >= PATCH_MAX_MEMBERS) break;
          }
        }
      }
      let cxSum = 0;
      let czSum = 0;
      let avgBaseY = 0;
      for (const idx of patchIndices) {
        const m = members[idx]!;
        cxSum += m.x;
        czSum += m.z;
        avgBaseY += m.baseY;
      }
      const centroidX = cxSum / patchIndices.length;
      const centroidZ = czSum / patchIndices.length;
      avgBaseY /= patchIndices.length;
      let maxR = 0;
      const memberRecords: ForestPatchMember[] = [];
      for (const idx of patchIndices) {
        const m = members[idx]!;
        const dx = m.x - centroidX;
        const dz = m.z - centroidZ;
        const dist = Math.hypot(dx, dz);
        if (dist > maxR) maxR = dist;
        memberRecords.push({
          dx, dz,
          scale: m.scale,
          rotY: m.rotY,
          subKind: m.subKind,
          seed: m.seed,
        });
      }
      staticObstacles.push({
        kind: patchKind,
        x: centroidX,
        z: centroidZ,
        baseY: avgBaseY,
        topY: avgBaseY + baseTopY,
        radius: maxR + baseCollisionRadius,
        scale: 1, /* members carry their own scale */
        rotY: 0,
        patchMembers: memberRecords,
      });
    }
  };
  groupIntoPatches(grassMembers, 'grass_patch', 0.25, 0.4);
  groupIntoPatches(vineMembers, 'vine_patch', 0.3, 0.5);
  groupIntoPatches(mossMembers, 'moss_patch', 0.25, 0.25);
}

/**
 * Random annulus around **dock** (not world origin) — restores shrubs/grass/vines near the character
 * without stacking the global polar grid in a visible ring.
 */
function scatterDockHaloGroundCover(
  creeks: ResolvedCreek[],
  dockCx: number,
  dockCz: number,
  R: number,
  d: number,
  placeGroundStratum: (layer: 3 | 4 | 5 | 6, x: number, z: number, seed: number) => void,
  rand: () => number,
  seedBase: number,
): void {
  const rIn = CAMP_CORE_CLEAR + 0.12;
  const rOut = Math.min(8.4, R * 0.2);
  const target = Math.round(28 + 12 * d);
  let placed = 0;
  let guard = 0;
  let seed = seedBase;
  while (placed < target && guard < target * 22) {
    guard++;
    const ang = rand() * Math.PI * 2;
    /* Bias radius toward the avatar: uniform disk wastes most samples on the far annulus. */
    const rr = rIn + (rOut - rIn) * Math.pow(rand(), 1.75);
    const x = dockCx + Math.cos(ang) * rr;
    const z = dockCz + Math.sin(ang) * rr;
    if (Math.hypot(x, z) > R * 0.972) continue;
    if (minDistToCreekNetwork(x, z, creeks) < COVER_MIN_DIST_DOCK_ZONES) continue;
    const u = rand();
    /* Bias toward shrub strata near the dock so purple heather + bloom clumps read around the character. */
    const layer: 3 | 4 | 5 | 6 = u < 0.2 ? 3 : u < 0.46 ? 4 : u < 0.74 ? 5 : 6;
    placeGroundStratum(layer, x, z, seed++);
    placed++;
  }
}

/**
 * Extra **tall + low shrub** strata only, 1.0–3.8 m from dock — lilac heather / rhodo / berry read in frame.
 */
function scatterDockInnerShrubRing(
  creeks: ResolvedCreek[],
  dockCx: number,
  dockCz: number,
  R: number,
  placeGroundStratum: (layer: 3 | 4 | 5 | 6, x: number, z: number, seed: number) => void,
  rand: () => number,
  seedBase: number,
): void {
  const rIn = CAMP_CORE_CLEAR + 0.06;
  const rOut = Math.min(3.75, R * 0.086);
  const target = 22;
  let placed = 0;
  let guard = 0;
  let seed = seedBase;
  while (placed < target && guard < target * 35) {
    guard++;
    const ang = rand() * Math.PI * 2;
    const rr = rIn + (rOut - rIn) * Math.pow(rand(), 1.35);
    const x = dockCx + Math.cos(ang) * rr;
    const z = dockCz + Math.sin(ang) * rr;
    if (Math.hypot(x, z) > R * 0.972) continue;
    if (minDistToCreekNetwork(x, z, creeks) < COVER_MIN_DIST_DOCK_ZONES) continue;
    /* Layer 4 = heather-weighted; layer 3 = berry + rhodo. */
    const layer: 3 | 4 = rand() < 0.58 ? 4 : 3;
    placeGroundStratum(layer, x, z, seed++);
    placed++;
  }
}

/**
 * Colorful shrubs **on the creek bank** — offset from each polyline segment so they sit beside water,
 * not in the ribbon (validated with distance-to-segment).
 */
function scatterCreekBankColorShrubs(
  creeks: ResolvedCreek[],
  R: number,
  dockCx: number,
  dockCz: number,
  placeGroundStratum: (layer: 3 | 4 | 5 | 6, x: number, z: number, seed: number) => void,
  rand: () => number,
  seedBase: number,
): void {
  let seed = seedBase;
  let placed = 0;
  const maxNearDock = 42;
  const dockReach = 24;
  for (const c of creeks) {
    if (c.id !== 'main') continue;
    const hw = c.halfWidth;
    for (let i = 0; i < c.points.length - 1; i++) {
      const ax = c.points[i]![0];
      const az = c.points[i]![1];
      const bx = c.points[i + 1]![0];
      const bz = c.points[i + 1]![1];
      const segLen = Math.hypot(bx - ax, bz - az);
      if (segLen < 0.06) continue;
      const midx = (ax + bx) * 0.5;
      const midz = (az + bz) * 0.5;
      if (Math.hypot(midx - dockCx, midz - dockCz) > dockReach) continue;
      const dx = (bx - ax) / segLen;
      const dz = (bz - az) / segLen;
      const nx = -dz;
      const nz = dx;
      const step = 1.55 + rand() * 0.55;
      const nSteps = Math.max(1, Math.ceil(segLen / step));
      for (let k = 0; k < nSteps; k++) {
        if (placed >= maxNearDock) return;
        const u = (k + 0.2 + rand() * 0.6) / (nSteps + 0.45);
        if (u < 0.035 || u > 0.965) continue;
        const px = ax + (bx - ax) * u;
        const pz = az + (bz - az) * u;
        const side = rand() < 0.5 ? 1 : -1;
        const off = hw + 0.14 + rand() * 0.48;
        const x = px + nx * off * side;
        const z = pz + nz * off * side;
        if (Math.hypot(x, z) > R * 0.972) continue;
        const dSeg = distXZToSegment(x, z, ax, az, bx, bz);
        if (dSeg < hw + 0.05 || dSeg > hw + 1.22) continue;
        const layer: 3 | 4 = rand() < 0.68 ? 4 : 3;
        placeGroundStratum(layer, x, z, seed++);
        placed++;
      }
    }
  }
}
