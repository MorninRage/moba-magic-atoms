/**
 * Dock-forest harvestable obstacles via `THREE.BatchedMesh` — universal-harvest.
 *
 * Replaces the prior `dockForestHarvestables.ts` (InstancedMesh-per-species). This
 * is the conclusion of the comprehensive research documented in LEARNINGS.md
 * "Dock-forest BatchedMesh refactor" entry. BatchedMesh is the only Three.js
 * primitive that gives us, simultaneously:
 *
 *   1. **Low draw calls** — one draw per material across all kinds + variants.
 *   2. **Per-instance hide on harvest** — `setVisibleAt(i, false)` is a first-class
 *      API (no zero-scale hack; multi-draw buffer regenerates lazily).
 *   3. **Per-instance fall animation** — `setMatrixAt(i, animatedMatrix)` per frame
 *      drives the same tree_fall / bush_collapse / stone_crumble / fiber_wisp
 *      archetypes the awakened-mode scatter uses.
 *   4. **Per-tree LPCA variation** — multiple geometries per (kind, species) via
 *      `addGeometry()`; instances pick a variant. Pines no longer all look identical.
 *   5. **Wind sway** — the path-aware vegetation wind shader (USE_BATCHING /
 *      USE_INSTANCING / merged branches in `idleCraftVegetationWind.ts`) makes
 *      every BatchedMesh material sway with per-instance world-space phase.
 *
 * **Architecture overview:**
 *   - For each (kind, species) bucket: build N LPCA-randomized templates (3 default
 *     for trees, 1 for shrubs/bushes/rocks/ferns/heather, custom geometry for
 *     grass/vine/moss patches that compose 5-10 member plants into one mesh).
 *   - Run `mergeByMaterial` on each template -> set of (material, geometry) pairs.
 *   - Group ALL sub-meshes ACROSS variants AND kinds by material reference.
 *   - For each material: build one `THREE.BatchedMesh(capacity, vertCap, idxCap, mat)`.
 *     Add each variant's geometry via `addGeometry()` -> per-variant geometryId.
 *   - For each spec: pick a variant (round-robin), for each material in that
 *     variant call `addInstance(geomId)` -> instanceId, then `setMatrixAt(instanceId,
 *     baseMatrix)`. Record all (BatchedMesh, instanceId) pairs in a per-spec node
 *     so harvest updates can fan out across them in lockstep.
 *
 * **Patches (grass / vine / moss):** each patch spec carries `patchMembers[]` (5-10
 * sub-plant entries with offsets from the patch centroid). At attach time, build
 * ONE composite Group containing all member plants at their offsets, merge by
 * material, and treat that as the patch's "variant" geometry. Each patch is its own
 * unique geometry (no template sharing across patches; member-density variation per
 * patch is the visual variety). Per-patch hide = `setVisibleAt(i, false)` for every
 * BatchedMesh slot the patch touches.
 *
 * **Wind sway integration:** after creating each BatchedMesh, we
 * `cloneMaterialsForVegetationWind` (per-BatchedMesh material clone so we don't
 * poison the shared LPCA singleton cache) + `installVegetationWindOnMergedGroup`.
 * The path-aware shader patch handles USE_BATCHING world-space phase derivation
 * automatically — no per-BatchedMesh shader bookkeeping needed here.
 *
 * **Collision lifecycle:** this module owns the collision footprint for every spec.
 * Register on attach, unregister on break, re-register on respawn. Mirrors the
 * `freeRoamHarvestNodes.ts` pattern so the caller (mountApp) doesn't have to
 * coordinate two systems for one harvest event.
 */

import * as THREE from 'three';
import { mergeByMaterial } from 'empire-engine/lpca';
import {
  buildIdleCraftAppleTree,
  buildIdleCraftBalsamFirTree,
  buildIdleCraftBerryBush,
  buildIdleCraftBirchTree,
  buildIdleCraftCreeperVine,
  buildIdleCraftDrapeVine,
  buildIdleCraftFernCluster,
  buildIdleCraftFiberGrass,
  buildIdleCraftHeatherMound,
  buildIdleCraftMossClump,
  buildIdleCraftPineTree,
  buildIdleCraftRhododendronClump,
  buildIdleCraftRoundOakTree,
  buildIdleCraftSedgeGrass,
  buildIdleCraftTuftGrass,
} from '../visual/goeStyleHarvestLPCA';
import {
  buildShrubLpcaLite,
  forestRand,
  leafPhysicalMat,
  stdMat,
  type ForestStaticObstacle,
  type ForestObstacleKind,
  type ForestPatchMember,
  type ForestTreeSpecies,
} from '../visual/forestEnvironment';
import {
  bakeVegetationWindHeightForTemplate,
  cloneMaterialsForVegetationWind,
  installVegetationWindOnMergedGroup,
} from '../visual/idleCraftVegetationWind';
import type { CollisionWorldHandle } from './collisionWorld';
import { yieldToEventLoop } from '../util/mainThreadYield';

/* ============================================================================
 * Public types — DockForestSpec / DockForestHandle / DockForestHarvestNode
 * ============================================================================ */

export type DockForestKind = ForestObstacleKind;

export type DockForestSpec = ForestStaticObstacle;

export interface DockForestHarvestNode {
  /** Index into the flat scattered-node list — used by applyHit + state lookups. */
  index: number;
  kind: DockForestKind;
  /** World-space XZ for proximity checks. */
  x: number;
  z: number;
  /** Hits remaining until break. Counts down by `applyHit(node, mult)`. */
  hp: number;
  /** Original `baseHits` for HUD progress display. */
  maxHp: number;
  /**
   * Per-instance collision radius — surfaced so callers can compute SURFACE
   * distance for harvest-reach gates. Without this, big trees / boulders are
   * unreachable: collision push-out keeps the player at center-distance >
   * trunk radius + avatar radius, which exceeds the gate. With it, callers
   * can use `(centerDist - collisionRadius) <= reach` so any obstacle the
   * player can touch is harvestable regardless of size.
   */
  collisionRadius: number;
  /**
   * World Y of the trunk / canopy top. Used by the height-aware harvest
   * picker in `mountApp.ts` to prefer the tallest reachable node when the
   * player aims at a cluster (e.g. a big oak surrounded by ferns + bushes
   * → chops the oak, not a fern).
   */
  topYWorld: number;
  /** World Y of the node's base (terrain Y at scatter time). `topYWorld - bottomY` = visible height. */
  bottomY: number;
}

export interface DockForestHitResult {
  ignored: boolean;
  broken: boolean;
  chipYield: number;
  hpRemaining: number;
  yieldKind: string;
}

export interface DockForestHandle {
  getNodeNearAvatar(
    avatarPos: { x: number; z: number },
    radius: number,
  ): DockForestHarvestNode | null;
  /**
   * Direct lookup by the flat scattered-node index — used by the magic-as-
   * harvest path in `mountApp.ts` to find the node corresponding to a
   * `dock-forest-batched:<kind>:<idx>` collision-world owner-id without
   * iterating the full `nodes` array. Returns null when the index is out
   * of range or the node is currently broken / regrowing.
   */
  getNodeByIndex(idx: number): DockForestHarvestNode | null;
  /**
   * Live ReadonlyArray of all dock-forest scatter nodes (mirrors
   * `harvestHandle.nodes`). Used by the height-aware harvest picker so
   * `mountApp.ts` can walk all nodes inside a small radius around the
   * reticle hit and prefer the tallest. The array is the live store
   * reference — do NOT mutate. */
  readonly nodes: ReadonlyArray<DockForestHarvestNode>;
  applyHit(node: DockForestHarvestNode, hitsMult: number): DockForestHitResult;
  update(dtSec: number): void;
  dispose(): void;
}

/* ============================================================================
 * Per-kind harvest config (matches awakened scatter idiom)
 * ============================================================================ */

type BreakAnim = 'tree_fall' | 'stone_crumble' | 'bush_collapse' | 'fiber_wisp';
/**
 * Growth archetypes — the symmetric counterpart to break animations. After the
 * respawn timer elapses, instead of instantly snapping the node back to full size
 * we kick off one of these. The instance becomes visible at a tiny "sapling" scale
 * and grows up to its full per-spec scale over GROW_DURATION_SEC. During growth:
 *   - HP stays at 0 (player can't harvest a sapling — would be unsatisfying)
 *   - Collision footprint is NOT registered (player walks freely through saplings)
 *
 * On grow completion: HP → maxHp, collision re-registered at full radius, node
 * leaves the brokenNodeIndices set. The whole "broken → wait → grow → mature"
 * cycle is what the user asked for ("we need to see smaller ones grow into larger
 * ones").
 */
type GrowAnim = 'tree_grow' | 'stone_form' | 'bush_grow' | 'fiber_grow';
type AnimArchetype = BreakAnim | GrowAnim;

interface KindBucketConfig {
  baseHits: number;
  chipPerHit: number;
  breakAnim: BreakAnim;
  yieldKind: string;
}

interface KindBucketConfigFull extends KindBucketConfig {
  /**
   * Whether this footprint blocks movement + contributes to `getGroundY`. Ground
   * cover + rocks + understory shrub/berry stay false; **all** scatter trees use
   * this (saplings during regrow growth anim stay unregistered separately).
   */
  blocking: boolean;
}

const KIND_BUCKET_CONFIG: Record<DockForestKind, KindBucketConfigFull> = {
  tree:        { baseHits: 8, chipPerHit: 0.6,  breakAnim: 'tree_fall',     yieldKind: 'wood',    blocking: true },
  /* Understory / sapling-like — harvestable but no movement shell (same spirit as ferns). */
  shrub:       { baseHits: 4, chipPerHit: 0.18, breakAnim: 'bush_collapse', yieldKind: 'fiber',   blocking: false },
  berry_bush:  { baseHits: 5, chipPerHit: 0.22, breakAnim: 'bush_collapse', yieldKind: 'berries', blocking: false },
  /* Scatter rocks are visual/harvest only — no footprint blocking so feet stay on
   * terrain and the third-person camera does not fight step-up onto mesh tops. */
  rock:        { baseHits: 8, chipPerHit: 0.45, breakAnim: 'stone_crumble', yieldKind: 'stone',   blocking: false },
  /* Small plants — harvestable + counted by proximity scan, but DO NOT block movement. */
  fern:        { baseHits: 3, chipPerHit: 0.2,  breakAnim: 'fiber_wisp',    yieldKind: 'fiber',   blocking: false },
  heather:     { baseHits: 3, chipPerHit: 0.18, breakAnim: 'bush_collapse', yieldKind: 'fiber',   blocking: false },
  /* Patches are bigger -> more hits + larger per-hit yield (scaled further by member count). */
  grass_patch: { baseHits: 6, chipPerHit: 0.25, breakAnim: 'fiber_wisp',    yieldKind: 'fiber',   blocking: false },
  vine_patch:  { baseHits: 6, chipPerHit: 0.25, breakAnim: 'bush_collapse', yieldKind: 'fiber',   blocking: false },
  moss_patch:  { baseHits: 4, chipPerHit: 0.2,  breakAnim: 'fiber_wisp',    yieldKind: 'fiber',   blocking: false },
};

/**
 * Real-time seconds the broken node sits invisible before its growth animation
 * starts. Cut from the prior 7-min cooldown to a 3-min wait so the player sees
 * the world heal at a "decent rate" (per the user's growth-system request).
 * Total cycle time = REGROW_WAIT_SEC + per-kind GROW_DURATION_SEC.
 */
const REGROW_WAIT_SEC = 180;

/** Animation timings (seconds) — same as the awakened scatter. */
const TREE_FALL_ROT_SEC = 0.7;
const TREE_FALL_POOF_SEC = 0.2;
const TREE_FALL_TOTAL_SEC = TREE_FALL_ROT_SEC + TREE_FALL_POOF_SEC;
const STONE_CRUMBLE_SEC = 0.4;
const BUSH_COLLAPSE_SEC = 0.3;
const FIBER_WISP_SEC = 0.25;

/**
 * Growth durations (seconds). Trees take the longest because the eye needs to
 * read the sapling-to-mature transition; ground cover snaps back faster so the
 * world doesn't feel sparse while you wait.
 */
const TREE_GROW_SEC = 60;       /* sapling → full canopy in 1 min  */
const BUSH_GROW_SEC = 30;       /* shrubs / berry bushes / heather */
const STONE_FORM_SEC = 12;      /* rocks "rise" out of the ground  */
const FIBER_GROW_SEC = 18;      /* ferns / grass / vine / moss     */

/**
 * Starting scale fraction at the very first growth frame. The instance pops
 * into visibility at this fraction of its final size, then eases up to 1.0
 * over GROW_DURATION_SEC. Different per kind so the "first frame" reads as a
 * believable seedling/pebble/sprout rather than a barely-visible dot.
 */
const TREE_GROW_MIN_SCALE = 0.08;   /* about ankle-high seedling for a giant oak */
const BUSH_GROW_MIN_SCALE = 0.14;
const STONE_FORM_MIN_SCALE = 0.30;  /* rocks "emerge" half-buried */
const FIBER_GROW_MIN_SCALE = 0.18;

/** Number of LPCA-randomized variants per (kind, species). 3 = noticeable variation, low capacity overhead. */
const VARIANTS_PER_TREE_SPECIES = 3;
const VARIANTS_PER_SHRUB = 2; /* rhodo + shrub_lite already cover the variation */
const VARIANTS_PER_BERRY = 2;
const VARIANTS_PER_FERN = 2;
const VARIANTS_PER_HEATHER = 2;

const HIDDEN_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Minimum per-instance scale at which a tree gets a wide canopy landing
 * footprint added (in addition to its trunk-only base footprint). Below this
 * threshold trees keep the legacy walk-under-only behaviour. 1.5 covers the
 * "emergent oaks / apples / pines" tier that the player can plausibly jump
 * onto without making every shrub-sized tree a flying carpet.
 */
const LARGE_TREE_CANOPY_LAND_MIN_SCALE = 1.5;

/**
 * Shrink factor applied to the variant's MEASURED max-XZ extent before
 * registering the canopy footprint. The mesh bounding box includes the very
 * outermost leaf vertices where there's typically nothing solid to land on
 * (sparse outer foliage, single drooping branches). Pulling the disk in by
 * 30% keeps landings inside the visually-dense crown so players don't appear
 * to float on air past the leaf silhouette. Tunable — raise to 0.8 if
 * landings feel too restrictive on smaller large-trees, lower to 0.6 if
 * float-on-air still happens.
 */
const LARGE_TREE_CANOPY_RADIUS_SHRINK = 0.7;
/**
 * Hard upper cap on canopy radius as a multiplier of TRUNK radius. Defends
 * against a freak variant whose bounding box is huge (e.g. an animation pose
 * baked into the geometry, a stray decorative branch). Without this cap a
 * single bad variant could give the player a 5m+ landing platform — set
 * conservatively low so worst case is still inside the visible crown.
 */
const LARGE_TREE_CANOPY_RADIUS_TRUNK_CAP_MUL = 2.2;

/**
 * Register a thin, wide landing disk at the very top of a tree so the player
 * can JUMP onto large trees. No-op for kinds other than `tree`, for
 * non-blocking specs (ground cover), or for trees below
 * `LARGE_TREE_CANOPY_LAND_MIN_SCALE`. The footprint owner-id is the trunk's
 * id with `:canopy` suffix so {@link unregisterLargeTreeCanopyIfApplicable}
 * can clean it up alongside the trunk on break / dispose.
 *
 * **Canopy radius derivation (2026-04-20 float-on-air fix):**
 * Uses the variant's MEASURED max-XZ extent (computed at template build time
 * from the merged sub-mesh bounding boxes — see `buildVariantTemplate`) so
 * thin pines get tight footprints and fat oaks get wide ones, matching the
 * visible leaf silhouette. The measured value is shrunk by
 * `LARGE_TREE_CANOPY_RADIUS_SHRINK` (~0.7) to stay inside the dense crown
 * (outer leaves are sparse) and capped at
 * `LARGE_TREE_CANOPY_RADIUS_TRUNK_CAP_MUL × trunkRadius` (~2.2× trunk) as a
 * safety against a freak oversized variant. Previously a fixed 3.0× trunk
 * multiplier was used regardless of variant — which over-extended for tall
 * thin pines and made the player land on invisible air outside the leaves.
 *
 * Why a thin band: the `inYBand` collision check ensures the wider canopy
 * disk only blocks lateral movement when the player's Y overlaps with the
 * canopy's last ~0.4–0.6 m. Players walking under the leaves are unaffected
 * (they're below the band); players jumping at mid-height clear it sideways.
 */
function registerLargeTreeCanopyIfApplicable(
  cw: CollisionWorldHandle,
  kind: DockForestKind,
  scale: number,
  blocking: boolean,
  x: number,
  z: number,
  baseY: number,
  measuredTopY: number,
  trunkRadius: number,
  measuredRadiusXZAtUnitScale: number,
  trunkOwnerId: string,
): void {
  if (kind !== 'tree') return;
  if (!blocking) return;
  if (scale < LARGE_TREE_CANOPY_LAND_MIN_SCALE) return;
  const canopyTopY = measuredTopY;
  const canopyBandHeight = Math.max(0.4, (measuredTopY - baseY) * 0.08);
  const canopyBottomY = canopyTopY - canopyBandHeight;
  const measuredRadiusWorld = measuredRadiusXZAtUnitScale * scale * LARGE_TREE_CANOPY_RADIUS_SHRINK;
  const trunkCappedRadius = trunkRadius * LARGE_TREE_CANOPY_RADIUS_TRUNK_CAP_MUL;
  const canopyRadius = Math.max(trunkRadius, Math.min(measuredRadiusWorld, trunkCappedRadius));
  cw.register({
    kind: 'circle',
    x,
    z,
    r: canopyRadius,
    ownerId: `${trunkOwnerId}:canopy`,
    blocking: true,
    tag: 'static',
    bottomY: canopyBottomY,
    topY: canopyTopY,
  });
}

/** Counterpart to {@link registerLargeTreeCanopyIfApplicable}. Idempotent. */
function unregisterLargeTreeCanopyIfApplicable(
  cw: CollisionWorldHandle,
  trunkOwnerId: string,
): void {
  cw.unregister(`${trunkOwnerId}:canopy`);
}

/* ============================================================================
 * Internal types
 * ============================================================================ */

/**
 * One template variant in a bucket: the merged sub-meshes (one per material) for
 * one LPCA-randomized geometry. Indexed inside `bucketTemplates[bucketKey][variantIdx]`.
 */
interface VariantTemplate {
  /**
   * Per-material sub-meshes from `mergeByMaterial(templateGroup)`. Each entry is
   * later inserted into the corresponding material's BatchedMesh via `addGeometry`,
   * yielding a per-(BatchedMesh, variant) `geometryId` stored in `materialGeomIds`.
   */
  subMeshes: { material: THREE.Material; geometry: THREE.BufferGeometry }[];
  /**
   * Filled in after BatchedMesh creation. Maps material reference to that variant's
   * geometryId in the material's BatchedMesh. Keys = `material`, values = geomId.
   */
  materialGeomIds: Map<THREE.Material, number>;
  /**
   * Highest local-space Y across all sub-mesh bounding boxes. Computed at template
   * build time (after `mergeByMaterial` + bounding-box compute). Used to derive
   * each instance's collision `topY` via `spec.baseY + maxYAtUnitScale * spec.scale`,
   * so the player lands EXACTLY on the visual canopy top instead of on the prior
   * hand-tuned `TREE_SPECIES_TOP_Y_PER_SM` value (which was tuned at sm=1.0 and
   * drifted by ~1 body length on a sm=2 medium tree). Mirrors how Unity / Unreal
   * derive collision capsule height from the rendered mesh's bounds.
   */
  maxYAtUnitScale: number;
  /**
   * Largest local-space horizontal radius across all sub-mesh bounding boxes
   * — `max(|min.x|, |max.x|, |min.z|, |max.z|)`. Multiplied by `spec.scale`
   * to derive the world-space canopy landing radius for large trees.
   * See `registerLargeTreeCanopyIfApplicable`. Per-variant so a tall thin
   * pine doesn't get the same wide footprint as a fat oak.
   */
  maxRadiusXZAtUnitScale: number;
}

interface ScatteredNode extends DockForestHarvestNode {
  /** Cached per-spec state for animations. */
  rotY: number;
  scale: number;
  baseY: number;
  /**
   * Variant's measured XZ radius at unit scale (from its merged sub-mesh
   * bounding boxes). Stored per-node so the regrow path can re-register the
   * canopy footprint with the same per-variant radius the initial scatter
   * used — without keeping a back-reference to the variant template.
   */
  canopyMeasuredRadiusXZAtUnitScale: number;
  /** Random fall direction for tree_fall (XZ unit vector). */
  fallAxisX: number;
  fallAxisZ: number;
  /** Per-spec instance records — one per (BatchedMesh, instanceId) the spec touches. */
  instanceRecords: { batched: THREE.BatchedMesh; instanceId: number }[];
  /**
   * Real-time ms when the node's growth animation should START. While
   * `availableAtMs > now` the node is in the invisible "respawn-wait" phase.
   * When it elapses, the respawn loop kicks off a grow animation and sets this
   * to 0 so we don't re-trigger.
   */
  availableAtMs: number;
  /**
   * True while a `*_grow` animation is in flight on this node. Prevents the
   * respawn loop from kicking off duplicate growth animations and gates harvest
   * (sapling can't be chopped). Cleared when the grow animation finalizes.
   */
  isGrowing: boolean;
  /** Stable collision-world owner id. */
  collisionOwnerId: string;
  /** Vertical extent + radius for collision register/respawn. */
  bottomY: number;
  topYWorld: number;
  collisionRadius: number;
  /** Mirrors {@link ForestStaticObstacle.nonBlockingFootprint} for regrow collision. */
  nonBlockingFootprint?: boolean;
}

interface ActiveAnimation {
  nodeIdx: number;
  archetype: AnimArchetype;
  t: number;
  duration: number;
}

/* ============================================================================
 * Attach factory
 * ============================================================================ */

interface AttachOpts {
  scene: THREE.Scene;
  specs: ReadonlyArray<DockForestSpec>;
  collisionWorld?: CollisionWorldHandle;
}

/**
 * Singleton-per-scene marker stored on the THREE.Scene itself (not in a
 * module-level WeakMap) so it SURVIVES Vite HMR / module-reload. Without
 * this, dev-mode hot reloads create new module instances of this file with
 * fresh module-level state, allowing duplicate attaches even when the scene
 * already has a working handle.
 *
 * Lookup pattern: `(scene.userData as { ... }).dockForestHandle`. Cleared
 * when `dispose()` runs.
 */
type SceneWithDockForest = THREE.Scene & {
  userData: { dockForestHandle?: DockForestHandle };
};

export async function attachDockForestBatchedScene(opts: AttachOpts): Promise<DockForestHandle> {
  /* === 2026-04-20 scene-singleton enforcement ===
   *
   * If this scene already has a dock-forest handle attached (via prior call
   * — including from extended preload during the title screen), return
   * THAT existing handle instead of building a duplicate. This is the
   * single most robust fix against ghost meshes — even if mountApp's
   * adoption logic fails to detect the prebuilt handle (Vite HMR module-
   * instance mismatch, race condition, whatever), the second
   * `attachDockForestBatchedScene` call short-circuits to reuse the existing
   * handle. The scene is the SINGLE source of truth, not module-level state. */
  const sceneWithHandle = opts.scene as SceneWithDockForest;
  const existing = sceneWithHandle.userData.dockForestHandle;
  if (existing) {
    /* Scene-singleton hit: silently reuse. This branch is the safety net
     * that prevents ghost meshes if some new caller bypasses the unified
     * preload pipeline — no log, since the unified pipeline guarantees
     * exactly one attach per scene under normal flow. */
    return existing;
  }

  /* Diagnostic flag: set `localStorage.setItem('dockForestDebug', '1')` in the
   * browser console then reload to enable verbose attach-time logging. Useful for
   * tracing "where did all the giant trees go?" — logs spec counts per kind+species,
   * BatchedMesh capacities + actual instance counts, and capacity-exceeded warnings. */
  let debugLog = false;
  try {
    debugLog = typeof localStorage !== 'undefined'
      && localStorage.getItem('dockForestDebug') === '1';
  } catch {
    /* no localStorage available — diagnostic just stays off */
  }
  const dbg = (msg: string, ...args: unknown[]): void => {
    if (debugLog) console.warn(`[dockForestBatched] ${msg}`, ...args);
  };

  const root = new THREE.Group();
  root.name = 'DockForestBatchedScene';
  opts.scene.add(root);

  /* Break up Steps 2–4 + final bounds on the main thread (legacy `worker=0` preload).
   * Same total work as before; yields keep input/paint from starving during LPCA
   * template builds + BatchedMesh buffer creation. */
  const FOREST_ATTACH_CHUNK_MS = 16;
  let forestAttachChunkStart = performance.now();
  const maybeYieldForestAttach = async (): Promise<void> => {
    if (performance.now() - forestAttachChunkStart >= FOREST_ATTACH_CHUNK_MS) {
      await yieldToEventLoop();
      forestAttachChunkStart = performance.now();
    }
  };

  /* ---- Step 1: group specs by bucket key ---- */
  const specsByBucket = new Map<string, DockForestSpec[]>();
  for (const spec of opts.specs) {
    const key = bucketKeyForSpec(spec);
    let arr = specsByBucket.get(key);
    if (!arr) {
      arr = [];
      specsByBucket.set(key, arr);
    }
    arr.push(spec);
  }
  if (debugLog) {
    /* Per-bucket spec counts + scale stats so we can see if giant trees are missing
     * from the input specs (would mean the bug is in forestEnvironment, not here)
     * vs missing from the rendered output (would mean the bug is in BatchedMesh). */
    for (const [key, arr] of specsByBucket) {
      const scales = arr.map((s) => s.scale);
      const maxScale = Math.max(...scales);
      const minScale = Math.min(...scales);
      dbg(`spec bucket ${key}: count=${arr.length} scale=[${minScale.toFixed(2)}..${maxScale.toFixed(2)}]`);
    }
  }

  /* ---- Step 2: build templates per bucket (multiple variants for trees etc.) ---- */
  /** bucketKey -> array of variants. Patches use a unique variant per spec. */
  const bucketTemplates = new Map<string, VariantTemplate[]>();
  /** For patch buckets only: spec.index (within bucket) -> variant index (always 1:1). */

  for (const [bucketKey, bucketSpecs] of specsByBucket) {
    const sample = bucketSpecs[0]!;
    const variantCount = variantCountForKind(sample.kind, bucketSpecs.length);
    const templates: VariantTemplate[] = [];
    if (isPatchKind(sample.kind)) {
      /* Patches: one unique geometry per patch spec. variantCount === bucketSpecs.length. */
      for (let i = 0; i < bucketSpecs.length; i++) {
        const spec = bucketSpecs[i]!;
        const tmpl = buildPatchTemplate(spec);
        templates.push(buildVariantFromTemplate(tmpl));
        await maybeYieldForestAttach();
      }
    } else {
      /* Trees / shrubs / etc: N shared variants, instances round-robin pick one. */
      for (let v = 0; v < variantCount; v++) {
        const tmpl = buildTemplateForBucket(sample, v);
        templates.push(buildVariantFromTemplate(tmpl));
        await maybeYieldForestAttach();
      }
    }
    bucketTemplates.set(bucketKey, templates);
    await maybeYieldForestAttach();
  }

  /* ---- Step 3: index sub-meshes by material across ALL buckets+variants ---- */
  /** material -> list of (bucketKey, variantIdx, subMeshIdx) entries. */
  const materialUsages = new Map<THREE.Material, {
    bucketKey: string;
    variantIdx: number;
    subMeshIdx: number;
  }[]>();
  for (const [bucketKey, variants] of bucketTemplates) {
    for (let v = 0; v < variants.length; v++) {
      const variant = variants[v]!;
      for (let s = 0; s < variant.subMeshes.length; s++) {
        const sub = variant.subMeshes[s]!;
        let arr = materialUsages.get(sub.material);
        if (!arr) {
          arr = [];
          materialUsages.set(sub.material, arr);
        }
        arr.push({ bucketKey, variantIdx: v, subMeshIdx: s });
      }
    }
  }

  /* ---- Step 4: for each material, create one BatchedMesh + addGeometry per variant ---- */
  const batchedMeshesByMaterial = new Map<THREE.Material, THREE.BatchedMesh>();
  /* Track ALL BatchedMeshes for dispose. */
  const allBatched: THREE.BatchedMesh[] = [];
  /* Per-BatchedMesh diagnostic stats (filled in only when debugLog is on, but the
   * map is always allocated to keep the hot path branchless). */
  const batchedStats = new Map<THREE.BatchedMesh, { capacity: number; usedInstances: number; label: string }>();
  for (const [material, usages] of materialUsages) {
    /* Capacity = how many spec instances will touch this material. */
    let totalInstanceCount = 0;
    let totalVertexCount = 0;
    let totalIndexCount = 0;
    /* Which kinds use this material — drives shadow-cast. If any kind with
     * `KIND_BUCKET_CONFIG[k].blocking === true` appears (mature trees only among
     * plants), the batch casts shadows. */
    const kindsForMaterial = new Set<DockForestKind>();
    for (const u of usages) {
      const variant = bucketTemplates.get(u.bucketKey)![u.variantIdx]!;
      const sub = variant.subMeshes[u.subMeshIdx]!;
      const specs = specsByBucket.get(u.bucketKey)!;
      kindsForMaterial.add(specs[0]!.kind);
      /* Patches: one instance per spec (variant idx == spec idx). Otherwise:
       * specs in this bucket round-robin across variants, so this variant gets
       * approximately specs.length / variantCount instances. */
      const variants = bucketTemplates.get(u.bucketKey)!;
      const instancesForThisVariant = isPatchKind(specs[0]!.kind)
        ? 1
        : Math.ceil(specs.length / variants.length);
      totalInstanceCount += instancesForThisVariant;
      const vc = sub.geometry.attributes.position?.count ?? 0;
      const ic = sub.geometry.index ? sub.geometry.index.count : vc;
      totalVertexCount += vc;
      totalIndexCount += ic;
    }
    /* Add 25% buffer so capacity isn't tight + edge cases (uneven round-robin
     * distribution at small spec counts) don't trip capacity exceeded. */
    const cap = Math.max(1, Math.ceil(totalInstanceCount * 1.25));
    const vertCap = Math.max(64, Math.ceil(totalVertexCount * 1.2));
    const idxCap = Math.max(64, Math.ceil(totalIndexCount * 1.2));
    /* Clone the material so we can patch it for vegetation wind without poisoning the
     * shared LPCA singleton cache. */
    const clonedMat = material.clone();
    const batched = new THREE.BatchedMesh(cap, vertCap, idxCap, clonedMat);
    /* Shadow casting: only if at least one BLOCKING kind uses this material. Ground
     * cover only (ferns / heather / grass / vine / moss) -> no shadow cast (saves
     * the depth pass for that whole BatchedMesh). */
    let castShadow = false;
    for (const k of kindsForMaterial) {
      if (KIND_BUCKET_CONFIG[k].blocking) {
        castShadow = true;
        break;
      }
    }
    batched.castShadow = castShadow;
    batched.receiveShadow = false;
    /* Per-object frustum culling INTENTIONALLY OFF.
     *
     * Why: BatchedMesh's per-instance frustum check uses
     * `geometry.boundingSphere.applyMatrix4(instanceMatrix)`, which only multiplies
     * the radius by `matrix.getMaxScaleOnAxis()`. That math is correct for a tight
     * sphere around an upright (non-rotated) tree — but during the tree_fall
     * animation the per-instance matrix rotates ~86 deg around a horizontal axis.
     * For an elongated tree the rotated bounding sphere should grow (the canopy
     * sweeps far from the trunk axis), but `applyMatrix4` doesn't account for
     * rotation. Result: GIANT TREES get false-culled mid-fall, the player sees the
     * tree visually disappear before the animation completes — exactly the symptom
     * the user reported ("the larger oaks/apples don't fall over and disappear").
     * Whole-batch `frustumCulled = true` (below) still culls the entire forest when
     * off-camera, which is the meaningful win for a forest centered on the dock.
     * Per-instance culling savings are sub-millisecond at our scale anyway. */
    batched.perObjectFrustumCulled = false;
    batched.sortObjects = false; /* opaque foliage; no overdraw sort needed */
    batched.frustumCulled = true; /* whole-batch sphere culling — cheap early-out when forest off-screen */
    /* Apply the path-aware vegetation wind shader (USE_BATCHING branch covers BatchedMesh). */
    cloneMaterialsForVegetationWind(batched);
    installVegetationWindOnMergedGroup(batched, { flexMul: windFlexForMaterial(material) });
    root.add(batched);
    batchedMeshesByMaterial.set(material, batched);
    allBatched.push(batched);
    if (debugLog) {
      const label = `${Array.from(kindsForMaterial).join(',')}-${(material as THREE.MeshStandardMaterial).name || 'unnamed'}`;
      batchedStats.set(batched, { capacity: cap, usedInstances: 0, label });
    }

    /* For each variant that uses this material, compute per-geometry bounding sphere
     * FIRST (perObjectFrustumCulled needs it), then addGeometry + record geomId. */
    for (const u of usages) {
      const variant = bucketTemplates.get(u.bucketKey)![u.variantIdx]!;
      const sub = variant.subMeshes[u.subMeshIdx]!;
      if (sub.geometry.boundingSphere === null) sub.geometry.computeBoundingSphere();
      if (sub.geometry.boundingBox === null) sub.geometry.computeBoundingBox();
      const geomId = batched.addGeometry(sub.geometry);
      variant.materialGeomIds.set(material, geomId);
    }
    await maybeYieldForestAttach();
  }

  /* Round 5 phase C4 — yield between Step 4 (BatchedMesh shells) and Step 5
   * (instance scatter). Step 4 builds the GPU buffers; Step 5 writes
   * thousands of `setMatrixAt` slots + collision registers. Splitting the
   * task here lets the browser paint the freshly-attached BatchedMesh shells
   * (still empty / invisible) while the scatter populates them. */
  await yieldToEventLoop();

  /* ---- Step 5: scatter spec instances ---- */
  const nodes: ScatteredNode[] = [];
  const activeAnimations: ActiveAnimation[] = [];
  /* Frame-spread budget for the scatter loop. Each spec touches multiple
   * BatchedMeshes (one per material in its variant) plus a collisionWorld
   * register, totalling ~10-50 microseconds. Yield once we cross one paint
   * frame of wall-clock to keep individual tasks bounded.
   *
   * 2026-04-22 — bumped 8 → 16 ms after cutscene removal. The 8 ms cap was
   * for cutscene-decode protection; without video to protect, 16 ms (one
   * full paint frame) is the right target and halves the yield count. */
  const SCATTER_CHUNK_BUDGET_MS = 16;
  let scatterChunkStart = performance.now();
  /**
   * Indices of nodes currently in "broken" state (hp <= 0, awaiting respawn timer).
   * Tracked explicitly so the per-frame respawn scan only walks broken nodes (typically
   * 0-5 in active play) instead of all ~360 nodes. Without this, the respawn loop
   * iterated every node every frame even when nothing was broken — pure waste in
   * the common case. Mutated by applyHit (add) + the respawn loop (remove).
   */
  const brokenNodeIndices = new Set<number>();
  const tmpQuat = new THREE.Quaternion();
  const tmpUp = new THREE.Vector3(0, 1, 0);
  for (const [bucketKey, bucketSpecs] of specsByBucket) {
    const variants = bucketTemplates.get(bucketKey)!;
    for (let i = 0; i < bucketSpecs.length; i++) {
      const spec = bucketSpecs[i]!;
      const cfg = KIND_BUCKET_CONFIG[spec.kind];
      const variantIdx = isPatchKind(spec.kind) ? i : (i % variants.length);
      const variant = variants[variantIdx]!;
      /* Compose base matrix. For patches, scale = 1 (members carry per-member scale). */
      const baseMatrix = new THREE.Matrix4();
      tmpQuat.setFromAxisAngle(tmpUp, spec.rotY);
      const sc = isPatchKind(spec.kind) ? 1 : spec.scale;
      baseMatrix.compose(
        new THREE.Vector3(spec.x, spec.baseY, spec.z),
        tmpQuat,
        new THREE.Vector3(sc, sc, sc),
      );
      const instanceRecords: ScatteredNode['instanceRecords'] = [];
      for (const [material, geomId] of variant.materialGeomIds) {
        const batched = batchedMeshesByMaterial.get(material);
        if (!batched) continue;
        let instanceId = -1;
        try {
          instanceId = batched.addInstance(geomId);
        } catch (e) {
          /* Capacity exceeded — log + skip this material for this spec so the rest of
           * the scene still attaches. Visible symptom would be "this tree's bark is
           * missing" rather than "everything is broken". The capacity calculation
           * upstream has a 25% buffer and should never hit this in practice; warn so
           * we catch any edge case (e.g. very large emergent trees pushing per-material
           * counts past expectations — exactly the "giant trees never appear" symptom). */
          // eslint-disable-next-line no-console
          console.warn(
            `[dockForestBatched] CAPACITY EXCEEDED for kind=${spec.kind} variant=${variantIdx} scale=${sc.toFixed(2)}; instance dropped`,
            e,
          );
          continue;
        }
        if (instanceId < 0) continue;
        batched.setMatrixAt(instanceId, baseMatrix);
        instanceRecords.push({ batched, instanceId });
        const stat = batchedStats.get(batched);
        if (stat) stat.usedInstances += 1;
      }
      const flatIdx = nodes.length;
      const collisionOwnerId = `dock-forest-batched:${spec.kind}:${flatIdx}`;
      const fallAng = pseudoRandom(spec.x * 31.7 + spec.z * 17.3) * Math.PI * 2;
      /* Derive the collision topY from the VARIANT'S MEASURED MESH HEIGHT instead
       * of trusting `spec.topY` (which uses the hand-tuned per-species constant
       * in forestEnvironment that drifts with sm). variant.maxYAtUnitScale was
       * computed from the merged mesh's bounding boxes — multiplying by the
       * per-instance scale gives the canopy top in WORLD units relative to baseY.
       * Patches don't apply scale (sc = 1) so this is also correct for them. */
      const measuredTopY = spec.baseY + variant.maxYAtUnitScale * sc;
      const footprintBlocking = cfg.blocking && !spec.nonBlockingFootprint;
      nodes.push({
        index: flatIdx,
        kind: spec.kind,
        x: spec.x,
        z: spec.z,
        hp: cfg.baseHits,
        maxHp: cfg.baseHits,
        rotY: spec.rotY,
        scale: sc,
        baseY: spec.baseY,
        fallAxisX: Math.cos(fallAng),
        fallAxisZ: Math.sin(fallAng),
        instanceRecords,
        availableAtMs: 0,
        isGrowing: false,
        collisionOwnerId,
        bottomY: spec.baseY,
        topYWorld: measuredTopY,
        collisionRadius: spec.radius,
        canopyMeasuredRadiusXZAtUnitScale: variant.maxRadiusXZAtUnitScale,
        nonBlockingFootprint: spec.nonBlockingFootprint === true ? true : undefined,
      });
      if (opts.collisionWorld) {
        opts.collisionWorld.register({
          kind: 'circle',
          x: spec.x,
          z: spec.z,
          r: spec.radius,
          ownerId: collisionOwnerId,
          blocking: footprintBlocking,
          tag: 'static',
          bottomY: spec.baseY,
          topY: measuredTopY,
        });
        registerLargeTreeCanopyIfApplicable(
          opts.collisionWorld, spec.kind, sc, footprintBlocking,
          spec.x, spec.z, spec.baseY, measuredTopY, spec.radius,
          variant.maxRadiusXZAtUnitScale,
          collisionOwnerId,
        );
      }
      if (performance.now() - scatterChunkStart >= SCATTER_CHUNK_BUDGET_MS) {
        await yieldToEventLoop();
        scatterChunkStart = performance.now();
      }
    }
  }

  /* Yield once more before the bounding-box compute pass — typically cheap
   * (allBatched.length ≈ number of unique materials, ~5-10) but it's a
   * convenient natural break and the browser gets one more paint window
   * with the populated batch before bounds are finalized. */
  await yieldToEventLoop();

  /* Compute whole-batch bounds so frustum culling works correctly. Without this,
   * BatchedMesh's bounding sphere is null and Three.js falls back to "always render"
   * (still correct, just slightly less efficient). Calling this once after all
   * instances are placed is the canonical Three.js BatchedMesh pattern. */
  for (const batched of allBatched) {
    batched.computeBoundingBox();
    batched.computeBoundingSphere();
    await maybeYieldForestAttach();
  }

  if (debugLog) {
    /* Per-material capacity vs actual-usage report. If usedInstances < expected for
     * a tree material, we lost some giant trees somewhere. */
    let totalDraws = 0;
    let totalInstances = 0;
    for (const [, stat] of batchedStats) {
      totalDraws++;
      totalInstances += stat.usedInstances;
      if (stat.usedInstances === 0) {
        dbg(`!! BatchedMesh "${stat.label}" has ZERO instances (all addInstance calls dropped?)`);
      } else if (stat.usedInstances >= stat.capacity) {
        dbg(`!! BatchedMesh "${stat.label}" at capacity: ${stat.usedInstances}/${stat.capacity}`);
      } else {
        dbg(`BatchedMesh "${stat.label}": ${stat.usedInstances}/${stat.capacity} instances (cast=${batchedMeshesByMaterial.get(stat.label.includes('-') ? null as never : stat.label as never)?.castShadow})`);
      }
    }
    dbg(`SUMMARY: ${totalDraws} BatchedMeshes (=${totalDraws} draw calls), ${totalInstances} total instances across ${nodes.length} nodes`);
  }

  /* ---- Public API ---- */

  function getNodeNearAvatar(
    avatarPos: { x: number; z: number },
    radius: number,
  ): DockForestHarvestNode | null {
    const ax = avatarPos.x;
    const az = avatarPos.z;
    let best: ScatteredNode | null = null;
    /* Track surface-distance (center-distance MINUS the obstacle's collision radius)
     * so reachability adapts to obstacle size. Without this fix, a giant oak with
     * a 1.9 m trunk radius is unreachable: the player gets pushed out by collision
     * at center-distance ~2.3 m, but the harvest check uses a fixed 1.8 m center-
     * distance. Result: small/medium trees are harvestable but giants are not —
     * the user-reported "the largest trees don't fall" bug. The surface check makes
     * reachability proportional to size: if you can TOUCH the trunk, you can chop it. */
    let bestSurfaceDist2 = radius * radius;
    const nowMs = Date.now();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (n.availableAtMs > nowMs) continue;
      if (n.hp <= 0) continue;
      const dx = n.x - ax;
      const dz = n.z - az;
      const centerDist = Math.hypot(dx, dz);
      /* Distance from the player to the obstacle's collision SURFACE (not center).
       * Negative value would mean the player is inside the obstacle (impossible due
       * to push-out collision); clamp to 0 just in case. */
      const surfaceDist = Math.max(0, centerDist - n.collisionRadius);
      const surfaceDist2 = surfaceDist * surfaceDist;
      if (surfaceDist2 < bestSurfaceDist2) {
        bestSurfaceDist2 = surfaceDist2;
        best = n;
      }
    }
    return best;
  }

  function applyHit(node: DockForestHarvestNode, hitsMult: number): DockForestHitResult {
    const inner = nodes[node.index];
    if (!inner) {
      return { ignored: true, broken: false, chipYield: 0, hpRemaining: 0, yieldKind: '' };
    }
    const cfg = KIND_BUCKET_CONFIG[inner.kind];
    const nowMs = Date.now();
    if (inner.availableAtMs > nowMs || inner.hp <= 0) {
      return { ignored: true, broken: false, chipYield: 0, hpRemaining: inner.hp, yieldKind: cfg.yieldKind };
    }
    const damage = Math.max(0.01, hitsMult);
    inner.hp -= damage;
    node.hp = inner.hp;
    if (inner.hp <= 0) {
      inner.hp = 0;
      node.hp = 0;
      inner.availableAtMs = nowMs + REGROW_WAIT_SEC * 1000;
      inner.isGrowing = false;
      brokenNodeIndices.add(inner.index);
      if (opts.collisionWorld) {
        opts.collisionWorld.unregister(inner.collisionOwnerId);
        unregisterLargeTreeCanopyIfApplicable(opts.collisionWorld, inner.collisionOwnerId);
      }
      activeAnimations.push({
        nodeIdx: inner.index,
        archetype: cfg.breakAnim,
        t: 0,
        duration: durationFor(cfg.breakAnim),
      });
      return {
        ignored: false, broken: true,
        chipYield: cfg.chipPerHit, hpRemaining: 0,
        yieldKind: cfg.yieldKind,
      };
    }
    return {
      ignored: false, broken: false,
      chipYield: cfg.chipPerHit, hpRemaining: inner.hp,
      yieldKind: cfg.yieldKind,
    };
  }

  /* Per-frame: drive animations + check respawns. */
  const _scratchMat = new THREE.Matrix4();
  const _scratchPos = new THREE.Vector3();
  const _scratchQuat = new THREE.Quaternion();
  const _scratchScale = new THREE.Vector3();
  const _scratchAxis = new THREE.Vector3();
  const _scratchFallQuat = new THREE.Quaternion();
  const _scratchYQuat = new THREE.Quaternion();
  const _yUp = new THREE.Vector3(0, 1, 0);

  function update(dtSec: number): void {
    /* Animations: covers BOTH break (fall/crumble/etc.) and grow (sapling -> mature).
     * Break-done -> hide instance. Grow-done -> finalize: full matrix + register
     * collision + restore hp + remove from brokenNodeIndices. */
    if (activeAnimations.length > 0) {
      for (let i = activeAnimations.length - 1; i >= 0; i--) {
        const anim = activeAnimations[i]!;
        anim.t += dtSec;
        const node = nodes[anim.nodeIdx];
        if (!node) {
          activeAnimations.splice(i, 1);
          continue;
        }
        const done = anim.t >= anim.duration;
        const isGrow = isGrowArchetype(anim.archetype);
        if (done) {
          if (isGrow) {
            /* Grow finalize: snap to exact base matrix at full scale, restore hp,
             * register collision footprint at full radius. The player can now
             * harvest the freshly-mature node again. */
            _scratchQuat.setFromAxisAngle(_yUp, node.rotY);
            _scratchPos.set(node.x, node.baseY, node.z);
            _scratchScale.set(node.scale, node.scale, node.scale);
            _scratchMat.compose(_scratchPos, _scratchQuat, _scratchScale);
            for (const rec of node.instanceRecords) {
              rec.batched.setMatrixAt(rec.instanceId, _scratchMat);
            }
            node.hp = node.maxHp;
            node.isGrowing = false;
            if (opts.collisionWorld) {
              const cfg = KIND_BUCKET_CONFIG[node.kind];
              const footprintBlocking = cfg.blocking && !node.nonBlockingFootprint;
              opts.collisionWorld.register({
                kind: 'circle',
                x: node.x, z: node.z, r: node.collisionRadius,
                ownerId: node.collisionOwnerId,
                blocking: footprintBlocking,
                tag: 'static',
                bottomY: node.bottomY,
                topY: node.topYWorld,
              });
              registerLargeTreeCanopyIfApplicable(
                opts.collisionWorld, node.kind, node.scale, footprintBlocking,
                node.x, node.z, node.bottomY, node.topYWorld, node.collisionRadius,
                node.canopyMeasuredRadiusXZAtUnitScale,
                node.collisionOwnerId,
              );
            }
            brokenNodeIndices.delete(anim.nodeIdx);
          } else {
            /* Break done: hide via setVisibleAt (first-class BatchedMesh primitive). */
            for (const rec of node.instanceRecords) {
              rec.batched.setVisibleAt(rec.instanceId, false);
            }
          }
          activeAnimations.splice(i, 1);
        } else {
          const mat = computeAnimatedMatrix(
            anim, node,
            _scratchMat, _scratchPos, _scratchQuat, _scratchScale,
            _scratchAxis, _scratchFallQuat, _scratchYQuat, _yUp,
          );
          for (const rec of node.instanceRecords) {
            rec.batched.setMatrixAt(rec.instanceId, mat);
          }
        }
      }
    }

    /* Respawns. Walk ONLY broken nodes (typically 0-5) instead of all ~360.
     * Common case: brokenNodeIndices is empty -> single Set.size compare exits.
     *
     * State machine per broken node:
     *   1. broken: hp = 0, isGrowing = false, availableAtMs > now -> wait
     *   2. wait elapses: kick off grow animation, set isGrowing = true,
     *      availableAtMs = 0, instance becomes visible at sapling scale
     *   3. growing: animation finalizer (above) flips back to mature + removes
     *      from brokenNodeIndices
     */
    if (brokenNodeIndices.size === 0) return;
    const nowMs = Date.now();
    for (const idx of brokenNodeIndices) {
      const node = nodes[idx];
      if (!node) continue;
      if (node.isGrowing) continue; /* animation is already in flight */
      if (node.availableAtMs > nowMs) continue; /* still waiting for respawn timer */
      /* Kick off grow animation. */
      const breakArch = KIND_BUCKET_CONFIG[node.kind].breakAnim;
      const growArch = growForBreak(breakArch);
      const minScale = minScaleFor(growArch);
      node.isGrowing = true;
      node.availableAtMs = 0;
      /* Place instance at sapling scale FIRST so the moment it becomes visible
       * it reads as a tiny seedling rather than briefly snapping to full size. */
      _scratchQuat.setFromAxisAngle(_yUp, node.rotY);
      _scratchPos.set(node.x, node.baseY, node.z);
      const startScale = node.scale * minScale;
      _scratchScale.set(startScale, startScale, startScale);
      _scratchMat.compose(_scratchPos, _scratchQuat, _scratchScale);
      for (const rec of node.instanceRecords) {
        rec.batched.setMatrixAt(rec.instanceId, _scratchMat);
        rec.batched.setVisibleAt(rec.instanceId, true);
      }
      activeAnimations.push({
        nodeIdx: idx,
        archetype: growArch,
        t: 0,
        duration: durationFor(growArch),
      });
    }
  }

  function dispose(): void {
    if (opts.collisionWorld) {
      for (const node of nodes) {
        opts.collisionWorld.unregister(node.collisionOwnerId);
        unregisterLargeTreeCanopyIfApplicable(opts.collisionWorld, node.collisionOwnerId);
      }
    }
    for (const batched of allBatched) {
      root.remove(batched);
      batched.dispose();
    }
    if (root.parent) root.parent.remove(root);
    /* Clear the scene-singleton marker so subsequent legitimate re-attaches
     * (e.g., return-to-title → re-enter game) build fresh handles. */
    const sceneStash = opts.scene as SceneWithDockForest;
    if (sceneStash.userData.dockForestHandle === handle) {
      delete sceneStash.userData.dockForestHandle;
    }
  }

  function getNodeByIndex(idx: number): DockForestHarvestNode | null {
    const n = nodes[idx];
    if (!n) return null;
    if (n.availableAtMs > Date.now()) return null;
    if (n.hp <= 0) return null;
    if (n.isGrowing) return null;
    return n;
  }

  const handle: DockForestHandle = { getNodeNearAvatar, getNodeByIndex, nodes, applyHit, update, dispose };
  /* Stash the handle on the scene's userData so subsequent attach calls on
   * the same scene SHORT-CIRCUIT to reuse it instead of building a duplicate.
   * See the singleton-enforcement comment at the top of this function. */
  sceneWithHandle.userData.dockForestHandle = handle;
  return handle;
}

/* ============================================================================
 * Helpers
 * ============================================================================ */

function bucketKeyForSpec(spec: DockForestSpec): string {
  switch (spec.kind) {
    case 'tree': return `tree:${spec.species ?? 0}`;
    case 'shrub': return `shrub:${spec.shrubVariant ?? 'rhodo'}`;
    case 'berry_bush': return 'berry_bush:_';
    case 'rock': return 'rock:_';
    case 'fern': return 'fern:_';
    case 'heather': return 'heather:_';
    /* Patch buckets are per-spec — each gets its own unique geometry, so the bucket
     * key doesn't matter for sharing. We still group by kind for grouping clarity. */
    case 'grass_patch': return 'grass_patch:_';
    case 'vine_patch': return 'vine_patch:_';
    case 'moss_patch': return 'moss_patch:_';
  }
}

function isPatchKind(kind: DockForestKind): boolean {
  return kind === 'grass_patch' || kind === 'vine_patch' || kind === 'moss_patch';
}

function variantCountForKind(kind: DockForestKind, specCount: number): number {
  switch (kind) {
    case 'tree': return Math.min(VARIANTS_PER_TREE_SPECIES, specCount);
    case 'shrub': return Math.min(VARIANTS_PER_SHRUB, specCount);
    case 'berry_bush': return Math.min(VARIANTS_PER_BERRY, specCount);
    case 'fern': return Math.min(VARIANTS_PER_FERN, specCount);
    case 'heather': return Math.min(VARIANTS_PER_HEATHER, specCount);
    case 'rock': return 1;
    case 'grass_patch':
    case 'vine_patch':
    case 'moss_patch':
      return specCount; /* unique per patch */
  }
}

/**
 * Build a single canonical visual for one (kind, species) bucket variant.
 * Templates are at unit scale; per-instance scale is applied via the matrix.
 */
function buildTemplateForBucket(spec: DockForestSpec, variantIdx: number): THREE.Group {
  switch (spec.kind) {
    case 'tree': {
      const species = (spec.species ?? 0) as ForestTreeSpecies;
      const seed = 0x42000 + species * 31 + variantIdx;
      const rand = forestRand(seed);
      return buildTreeBySpeciesNumber(rand, 1.0, species);
    }
    case 'shrub': {
      const variant = spec.shrubVariant ?? 'rhodo';
      const seed = 0x42100 + (variant === 'rhodo' ? 0 : 47) + variantIdx;
      const rand = forestRand(seed);
      if (variant === 'rhodo') {
        return buildIdleCraftRhododendronClump(rand, 1.0);
      }
      const stemMat = stdMat({ color: 0x3d3028, roughness: 0.88 });
      const leafDark = leafPhysicalMat(0x1a4a24, 0.44);
      const leafMid = leafPhysicalMat(0x2a6a36, 0.38);
      return buildShrubLpcaLite(stemMat, leafDark, leafMid, 1.0, 0);
    }
    case 'berry_bush': {
      const seed = 0x42200 + variantIdx;
      const rand = forestRand(seed);
      return buildIdleCraftBerryBush(rand);
    }
    case 'rock': {
      const grp = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0x4a4a52, roughness: 0.9 });
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.1, 0), mat);
      rock.position.y = 0.13;
      rock.castShadow = true;
      grp.add(rock);
      return grp;
    }
    case 'fern': {
      const seed = 0x42300 + variantIdx;
      const rand = forestRand(seed);
      return buildIdleCraftFernCluster(rand, 1.0);
    }
    case 'heather': {
      const seed = 0x42400 + variantIdx;
      const rand = forestRand(seed);
      return buildIdleCraftHeatherMound(rand, 1.0);
    }
    case 'grass_patch':
    case 'vine_patch':
    case 'moss_patch':
      throw new Error('Patches use buildPatchTemplate, not buildTemplateForBucket');
  }
}

/**
 * Build a patch template by composing all member plants at their offsets into one
 * Group, then merging by material. Each patch is unique (different members).
 */
function buildPatchTemplate(spec: DockForestSpec): THREE.Group {
  const group = new THREE.Group();
  group.name = `${spec.kind}-template`;
  const members: ForestPatchMember[] = spec.patchMembers ?? [];
  for (const m of members) {
    const rand = forestRand(m.seed >>> 0);
    let mesh: THREE.Group | null = null;
    if (spec.kind === 'grass_patch') {
      if (m.subKind === 'fiber') mesh = buildIdleCraftFiberGrass(rand);
      else if (m.subKind === 'tuft') mesh = buildIdleCraftTuftGrass(rand);
      else if (m.subKind === 'sedge') mesh = buildIdleCraftSedgeGrass(rand);
    } else if (spec.kind === 'vine_patch') {
      if (m.subKind === 'creeper') mesh = buildIdleCraftCreeperVine(rand, 1.0);
      else if (m.subKind === 'drape') mesh = buildIdleCraftDrapeVine(rand, 1.0);
    } else if (spec.kind === 'moss_patch') {
      mesh = buildIdleCraftMossClump(rand, 1.0);
    }
    if (!mesh) continue;
    mesh.position.set(m.dx, 0, m.dz);
    mesh.rotation.y = m.rotY;
    mesh.scale.setScalar(m.scale);
    group.add(mesh);
  }
  return group;
}

/**
 * Internal: take a built template Group, bake the wind-height attribute, run
 * mergeByMaterial, return the variant template ready for BatchedMesh insertion.
 */
function buildVariantFromTemplate(template: THREE.Group): VariantTemplate {
  template.position.set(0, 0, 0);
  template.updateMatrixWorld(true);
  /* Bake the wind-height attribute on the template's meshes BEFORE merge so the
   * baked attribute survives mergeByMaterial. The path-aware shader expects
   * `vegetationWindH` on every wind-patched material's geometry. */
  bakeVegetationWindHeightForTemplate(template);
  const merged = mergeByMaterial(template);
  const subMeshes: { material: THREE.Material; geometry: THREE.BufferGeometry }[] = [];
  merged.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    subMeshes.push({ material: m.material as THREE.Material, geometry: m.geometry });
  });
  /* Dispose the original template's geometries — `mergeByMaterial` cloned them. */
  template.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry) m.geometry.dispose();
  });
  /* Measure the variant's actual local-space max Y from its sub-mesh bounding
   * boxes. This drives the per-instance collision topY so the player's feet
   * land on the VISUAL canopy top, not on a hand-tuned constant that drifts
   * with sm. Falls back to 1.0 for variants with no geometry (defensive — a
   * 1m sentinel keeps collision sane while making the bug obvious if it ever
   * happens).
   *
   * Also measure the variant's max XZ radius (largest absolute X or Z across
   * all sub-mesh bounding boxes) so the large-tree canopy landing footprint
   * matches the variant's actual leaf silhouette instead of a fixed
   * `trunkRadius × constant` multiplier (which over-extended for tall thin
   * pines and undershoots fat oaks). The full-mesh extent is conservative —
   * it includes any low branches as well as the canopy — so we still apply
   * a `0.85` shrink factor at the consumer site to avoid landing on the
   * very outer leaf edge where there's typically nothing solid. */
  let maxY = -Infinity;
  let maxRadiusXZ = 0;
  for (const sub of subMeshes) {
    if (!sub.geometry.boundingBox) sub.geometry.computeBoundingBox();
    const bb = sub.geometry.boundingBox;
    if (!bb) continue;
    if (bb.max.y > maxY) maxY = bb.max.y;
    const rx = Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x));
    const rz = Math.max(Math.abs(bb.min.z), Math.abs(bb.max.z));
    const r = Math.max(rx, rz);
    if (r > maxRadiusXZ) maxRadiusXZ = r;
  }
  if (!Number.isFinite(maxY)) maxY = 1.0;
  if (maxRadiusXZ <= 0) maxRadiusXZ = 0.5; /* defensive sentinel */
  return { subMeshes, materialGeomIds: new Map(), maxYAtUnitScale: maxY, maxRadiusXZAtUnitScale: maxRadiusXZ };
}

/**
 * Tree species dispatcher. Inlined here so the new module doesn't have to import a
 * helper from forestEnvironment that may have other side effects.
 */
function buildTreeBySpeciesNumber(rand: () => number, sm: number, species: ForestTreeSpecies): THREE.Group {
  switch (species) {
    case 1: return buildIdleCraftPineTree(rand, sm);
    case 2: return buildIdleCraftBirchTree(rand, sm);
    case 3: return buildIdleCraftBalsamFirTree(rand, sm);
    case 4: return buildIdleCraftRoundOakTree(rand, sm);
    default: return buildIdleCraftAppleTree(rand, sm);
  }
}

/**
 * Per-material wind flex tuning. Trees use the default 0.94; ground cover uses
 * stronger motion (1.06 with `understory: true` would be ideal but we don't have
 * that signal per-material here — stick with a neutral default). Fine for v1.
 */
function windFlexForMaterial(_material: THREE.Material): number {
  return 0.94;
}

function durationFor(arch: AnimArchetype): number {
  switch (arch) {
    case 'tree_fall': return TREE_FALL_TOTAL_SEC;
    case 'stone_crumble': return STONE_CRUMBLE_SEC;
    case 'bush_collapse': return BUSH_COLLAPSE_SEC;
    case 'fiber_wisp': return FIBER_WISP_SEC;
    case 'tree_grow': return TREE_GROW_SEC;
    case 'stone_form': return STONE_FORM_SEC;
    case 'bush_grow': return BUSH_GROW_SEC;
    case 'fiber_grow': return FIBER_GROW_SEC;
  }
}

/** Symmetric mapping: each break archetype has a paired growth archetype. */
function growForBreak(arch: BreakAnim): GrowAnim {
  switch (arch) {
    case 'tree_fall': return 'tree_grow';
    case 'stone_crumble': return 'stone_form';
    case 'bush_collapse': return 'bush_grow';
    case 'fiber_wisp': return 'fiber_grow';
  }
}

function minScaleFor(arch: GrowAnim): number {
  switch (arch) {
    case 'tree_grow': return TREE_GROW_MIN_SCALE;
    case 'stone_form': return STONE_FORM_MIN_SCALE;
    case 'bush_grow': return BUSH_GROW_MIN_SCALE;
    case 'fiber_grow': return FIBER_GROW_MIN_SCALE;
  }
}

function isGrowArchetype(arch: AnimArchetype): boolean {
  return arch === 'tree_grow' || arch === 'stone_form'
      || arch === 'bush_grow' || arch === 'fiber_grow';
}

/** Smooth ease-out: starts fast, eases to a gentle approach at full size. */
function easeOutCubic(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

/**
 * Per-frame animation matrix. Same archetypes as `freeRoamHarvestNodes.ts` so the
 * visual idiom is identical across both harvest paths.
 */
function computeAnimatedMatrix(
  anim: ActiveAnimation,
  node: ScatteredNode,
  outMat: THREE.Matrix4,
  outPos: THREE.Vector3,
  outQuat: THREE.Quaternion,
  outScale: THREE.Vector3,
  scratchAxis: THREE.Vector3,
  scratchFallQuat: THREE.Quaternion,
  scratchYQuat: THREE.Quaternion,
  yUp: THREE.Vector3,
): THREE.Matrix4 {
  outPos.set(node.x, node.baseY, node.z);
  outQuat.identity();
  outScale.set(node.scale, node.scale, node.scale);
  const t = anim.t / anim.duration;

  switch (anim.archetype) {
    case 'tree_fall': {
      const rotPhase = TREE_FALL_ROT_SEC / anim.duration;
      let scaleFactor: number;
      let fallAngle: number;
      if (t <= rotPhase) {
        const tt = t / rotPhase;
        const eased = Math.sin(tt * Math.PI * 0.5);
        const easedSq = eased * eased;
        fallAngle = easedSq * (Math.PI * 0.48); /* up to ~86 deg */
        scaleFactor = 1.0;
      } else {
        const tt = (t - rotPhase) / (1 - rotPhase);
        fallAngle = Math.PI * 0.48;
        scaleFactor = Math.max(0, 1 - tt);
      }
      scratchAxis.set(node.fallAxisZ, 0, -node.fallAxisX);
      if (scratchAxis.lengthSq() < 1e-6) scratchAxis.set(1, 0, 0);
      else scratchAxis.normalize();
      scratchFallQuat.setFromAxisAngle(scratchAxis, fallAngle);
      scratchYQuat.setFromAxisAngle(yUp, node.rotY);
      scratchFallQuat.multiply(scratchYQuat);
      const s = node.scale * scaleFactor;
      outMat.compose(outPos, scratchFallQuat, outScale.set(s, s, s));
      return outMat;
    }
    case 'stone_crumble': {
      const sf = Math.max(0, 1 - t);
      const wobble = Math.sin(t * Math.PI * 6) * 0.08 * (1 - t);
      scratchAxis.set(1, 0, 0);
      scratchFallQuat.setFromAxisAngle(scratchAxis, wobble);
      scratchYQuat.setFromAxisAngle(yUp, node.rotY);
      scratchFallQuat.multiply(scratchYQuat);
      const s = node.scale * sf;
      outMat.compose(outPos, scratchFallQuat, outScale.set(s, s, s));
      return outMat;
    }
    case 'bush_collapse': {
      /* === 2026-04-22 degenerate-matrix fix ===
       * Original used `sh = max(0, 1 - t)` and `sv = max(0, 1 - t * 1.4)`,
       * which made vertical scale hit 0 at t = 0.714 while horizontal
       * still had ~28 % to shrink. The resulting `(sh, 0, sh)` scale is a
       * singular matrix → undefined normals + degenerate shadow caster
       * → moiré in the shadow pass that reads as a screen-wide flash.
       * New formula: `sv = sf²` so vertical shrinks faster than horizontal
       * (flatten effect preserved) but reaches 0 at the same frame as
       * horizontal — no singular-matrix phase. See matching comment in
       * `freeRoamHarvestNodes.ts`. */
      const sf = Math.max(0, 1 - t);
      const sh = sf;
      const sv = sf * sf;
      scratchYQuat.setFromAxisAngle(yUp, node.rotY);
      outMat.compose(
        outPos, scratchYQuat,
        outScale.set(node.scale * sh, node.scale * sv, node.scale * sh),
      );
      return outMat;
    }
    case 'fiber_wisp': {
      const sf = Math.max(0, 1 - t);
      /* Mutate outPos in place (it's already set to node base above and isn't read
       * again after this branch). Avoids per-frame Vector3 allocation that the
       * previous `outPos.clone()` did during fiber-wisp animations. */
      outPos.y += t * 0.15;
      scratchYQuat.setFromAxisAngle(yUp, node.rotY);
      outMat.compose(
        outPos, scratchYQuat,
        outScale.set(node.scale * sf, node.scale * sf, node.scale * sf),
      );
      return outMat;
    }
    /* Growth archetypes — symmetric counterpart to break animations. Scale lerps
     * from per-archetype minimum up to the node's full per-spec scale via a
     * smooth ease-out so the last few seconds settle gently into "mature" rather
     * than snapping. Position + Y rotation stay fixed at the spec values; only
     * scale changes. Kind-specific flair (slight hop for fiber, settling wobble
     * for stone) layered on top so the four grow archetypes feel distinct. */
    case 'tree_grow': {
      const grow = TREE_GROW_MIN_SCALE
        + (1 - TREE_GROW_MIN_SCALE) * easeOutCubic(t);
      scratchYQuat.setFromAxisAngle(yUp, node.rotY);
      const s = node.scale * grow;
      outMat.compose(outPos, scratchYQuat, outScale.set(s, s, s));
      return outMat;
    }
    case 'bush_grow': {
      const grow = BUSH_GROW_MIN_SCALE
        + (1 - BUSH_GROW_MIN_SCALE) * easeOutCubic(t);
      scratchYQuat.setFromAxisAngle(yUp, node.rotY);
      const s = node.scale * grow;
      outMat.compose(outPos, scratchYQuat, outScale.set(s, s, s));
      return outMat;
    }
    case 'stone_form': {
      const grow = STONE_FORM_MIN_SCALE
        + (1 - STONE_FORM_MIN_SCALE) * easeOutCubic(t);
      /* Tiny settling wobble in the first half — stone reads as "still settling"
       * rather than just inflating. Damps to zero by mid-animation. */
      const settle = (t < 0.5)
        ? Math.sin(t * Math.PI * 4) * 0.04 * (1 - t * 2)
        : 0;
      scratchAxis.set(1, 0, 0);
      scratchFallQuat.setFromAxisAngle(scratchAxis, settle);
      scratchYQuat.setFromAxisAngle(yUp, node.rotY);
      scratchFallQuat.multiply(scratchYQuat);
      const s = node.scale * grow;
      outMat.compose(outPos, scratchFallQuat, outScale.set(s, s, s));
      return outMat;
    }
    case 'fiber_grow': {
      const grow = FIBER_GROW_MIN_SCALE
        + (1 - FIBER_GROW_MIN_SCALE) * easeOutCubic(t);
      scratchYQuat.setFromAxisAngle(yUp, node.rotY);
      const s = node.scale * grow;
      outMat.compose(outPos, scratchYQuat, outScale.set(s, s, s));
      return outMat;
    }
  }
}

/** Cheap deterministic random in [0, 1) from a single number seed. */
function pseudoRandom(seed: number): number {
  let t = (seed * 0x9e3779b1) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/* Reference HIDDEN_MATRIX so it stays exported (was used by InstancedMesh path; kept
 * as a sentinel for future "permanent hide" use cases, e.g. a reset-all-progress
 * branch that needs to explicitly null an instance's matrix). */
void HIDDEN_MATRIX;
