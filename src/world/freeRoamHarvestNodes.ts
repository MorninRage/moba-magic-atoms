/**
 * Free-roam harvest nodes (Phase D — `docs/AWAKENING_AND_FREE_ROAM_PLAN.md` §8 + multi-hit
 * supersession in this file's header).
 *
 * Scatters every harvestable kind onto the heightfield around the dock — wood, fiber,
 * stone, the full ore tier line, plus magic crystals — so the awakened-mode player walks
 * the world to gather directly instead of clicking idle-deck buttons.
 *
 * **Multi-hit harvest (supersedes the original "instant-press = full yield" design).**
 * Each scattered node now carries `hp` and `maxHp` (in-memory only; no save bloat). Every
 * `applyHit()` decrements hp by the player's tool multiplier (better axe / pickaxe → bigger
 * decrement → fewer hits to break). When `hp <= 0` the node enters its fall animation,
 * grants the climactic yield via `freeRoamHarvest()`, and starts a long real-time respawn
 * (`REGROW_SEC`, ~7 minutes per the locked design). Per-hit "chip" yield (1 unit each
 * swing) makes every press feel productive without rushing the despawn.
 *
 * **Per-instance visibility via `THREE.InstancedMesh` (replaces the old `mergeByMaterial`
 * approach).** The original implementation merged every instance of a kind into one
 * static mesh per material — great for draw calls, but it made it impossible to hide a
 * single node when it broke. The new design:
 *   1. Build the LPCA template ONCE per kind (one apple tree / one rock pile / etc.)
 *   2. Run `mergeByMaterial` on that single template → ~1-3 merged sub-meshes per kind.
 *   3. For each sub-mesh, create one `THREE.InstancedMesh(geometry, material, count)`.
 *   4. Each scattered node = one instance index; its world placement is written into
 *      the InstancedMesh's `instanceMatrix`.
 *
 * Trade-off: every instance of a given kind is a clone of one template (no per-tree
 * geometry variation). Variation comes from per-instance random Y rotation and scale
 * (±15%). The eye accepts this — every open-world game does it for foliage. Draw calls
 * stay LOW (~26 total for the whole scatter) and per-instance visibility is `O(1)`.
 *
 * **Fall / shrink animations (the climactic moment).** When a node breaks:
 *   - Trees (`apple_tree`): pivot rotation around the trunk base over 0.7s (eased by
 *     gravity-feel sin²), then scale 1→0 over 0.2s. Reads as the iconic "tree falls then
 *     poofs" moment.
 *   - Bushes / fiber: quick scale-collapse over 0.3s with a small wobble.
 *   - Stone / ore: quick scale-collapse over 0.35s, no rotation.
 *   - Magic crystal: no visual animation (the on-map crystal scatter is permanent
 *     scenery; the SFX bell sweep carries the moment).
 *
 * **Respawn.** When `availableAtMs` elapses on a hidden node, the original instance
 * matrix is restored and `hp` resets. Visual: the tree just "is back" — fine for a 7-min
 * timer where the player has wandered far. Future polish: a brief grow-in scale tween.
 *
 * **Visibility model (unchanged from original):**
 *   - In `'deck'` mode: gate per-kind `.visible` on whether the unlock card is owned.
 *   - In `'awakened'` mode: every kind visible.
 *   - Dev override `idleCraft.devUnlockAllNodes = '1'` shows everything in either mode.
 *   - `setVisibilityRules()` is signature-gated for cheap per-frame calls.
 */
import * as THREE from 'three';
import { mergeByMaterial } from 'empire-engine/lpca';
import {
  buildIdleCraftAppleTree,
  buildIdleCraftBerryBush,
  buildIdleCraftFiberGrass,
} from '../visual/goeStyleHarvestLPCA';

export type FreeRoamHarvestKind =
  | 'wood'
  | 'fiber'
  | 'stone'
  | 'berries'
  | 'mine_iron_ore'
  | 'mine_coal'
  | 'mine_copper_ore'
  | 'mine_tin_ore'
  | 'mine_zinc_ore'
  | 'mine_silver_ore'
  | 'mine_gold_ore'
  | 'mine_platinum_ore'
  | 'magic_crystal';

export const FREE_ROAM_HARVEST_KINDS: FreeRoamHarvestKind[] = [
  'wood',
  'fiber',
  'stone',
  'berries',
  'mine_iron_ore',
  'mine_coal',
  'mine_copper_ore',
  'mine_tin_ore',
  'mine_zinc_ore',
  'mine_silver_ore',
  'mine_gold_ore',
  'mine_platinum_ore',
  'magic_crystal',
];

/** Animation archetype for the break-VFX dispatcher. */
type BreakAnim = 'tree_fall' | 'bush_collapse' | 'stone_crumble' | 'fiber_wisp' | 'crystal_flash';

/**
 * Growth archetypes — symmetric counterpart to BreakAnim. After the respawn timer
 * elapses we kick off one of these to scale the instance from a "sapling" up to
 * its full per-instance scale over GROW_DURATION_SEC. During growth: hp stays 0
 * (sapling can't be harvested) and collision stays unregistered (player walks
 * freely through saplings). The user-requested "see smaller ones grow into larger
 * ones" cycle, applied to every awakened-mode harvest node.
 */
type GrowAnim = 'tree_grow' | 'bush_grow' | 'stone_form' | 'fiber_grow' | 'crystal_emerge';
type AnimArchetype = BreakAnim | GrowAnim;

interface KindConfig {
  /** How many nodes to scatter for this kind. */
  count: number;
  /** Hex color for the bulk material (rock pile / ore chunk / fallback crystal). */
  bulkColor: number;
  emissive?: number;
  emissiveIntensity?: number;
  roughness?: number;
  metalness?: number;
  /** Mesh archetype — drives geometry choice + scale. */
  shape: 'apple_tree' | 'fiber_tuft' | 'berry_bush' | 'rock_pile' | 'ore_chunk' | 'crystal_cluster';
  /**
   * How many bare-hand E presses to fully break this kind. Tool tier from
   * `gameStore.getHarvestHitsMultiplier()` divides through this (e.g. iron axe = 2.22×
   * → 8 hits ÷ 2.22 ≈ 4 hits). 5–10 range tuned per the user spec.
   */
  baseHits: number;
  /** Per-hit chip yield (raw inventory units). Total chip + final yield ≈ legacy single-press. */
  chipPerHit: number;
  /** Animation archetype on break. */
  breakAnim: BreakAnim;
}

const KIND_CFG: Record<FreeRoamHarvestKind, KindConfig> = {
  wood:               { count: 30, bulkColor: 0x6a4a30, roughness: 0.86, shape: 'apple_tree',
                        baseHits: 8, chipPerHit: 0.6, breakAnim: 'tree_fall' },
  fiber:              { count: 26, bulkColor: 0x9aa856, roughness: 0.92, shape: 'fiber_tuft',
                        baseHits: 5, chipPerHit: 0.18, breakAnim: 'fiber_wisp' },
  stone:              { count: 24, bulkColor: 0x76787a, roughness: 0.88, shape: 'rock_pile',
                        baseHits: 8, chipPerHit: 0.45, breakAnim: 'stone_crumble' },
  berries:            { count: 20, bulkColor: 0xc42d4e, roughness: 0.5, shape: 'berry_bush',
                        baseHits: 5, chipPerHit: 0.22, breakAnim: 'bush_collapse' },
  mine_iron_ore:      { count: 12, bulkColor: 0x6a5648, roughness: 0.7, metalness: 0.18, shape: 'ore_chunk',
                        baseHits: 10, chipPerHit: 0.16, breakAnim: 'stone_crumble' },
  mine_coal:          { count: 10, bulkColor: 0x1a1814, roughness: 0.92, shape: 'ore_chunk',
                        baseHits: 10, chipPerHit: 0.18, breakAnim: 'stone_crumble' },
  mine_copper_ore:    { count: 9, bulkColor: 0x9a6238, roughness: 0.55, metalness: 0.34, shape: 'ore_chunk',
                        baseHits: 10, chipPerHit: 0.15, breakAnim: 'stone_crumble' },
  mine_tin_ore:       { count: 9, bulkColor: 0x8a8a8e, roughness: 0.55, metalness: 0.32, shape: 'ore_chunk',
                        baseHits: 10, chipPerHit: 0.14, breakAnim: 'stone_crumble' },
  mine_zinc_ore:      { count: 9, bulkColor: 0x90a0a4, roughness: 0.55, metalness: 0.32, shape: 'ore_chunk',
                        baseHits: 10, chipPerHit: 0.14, breakAnim: 'stone_crumble' },
  mine_silver_ore:    { count: 7, bulkColor: 0xb6c6cc, roughness: 0.42, metalness: 0.62, shape: 'ore_chunk',
                        emissive: 0x66889a, emissiveIntensity: 0.18,
                        baseHits: 12, chipPerHit: 0.11, breakAnim: 'stone_crumble' },
  mine_gold_ore:      { count: 6, bulkColor: 0xd6a046, roughness: 0.4, metalness: 0.68, shape: 'ore_chunk',
                        emissive: 0xa07028, emissiveIntensity: 0.22,
                        baseHits: 12, chipPerHit: 0.09, breakAnim: 'stone_crumble' },
  mine_platinum_ore:  { count: 5, bulkColor: 0xe2e6e8, roughness: 0.36, metalness: 0.78, shape: 'ore_chunk',
                        emissive: 0x9aa6ae, emissiveIntensity: 0.26,
                        baseHits: 12, chipPerHit: 0.07, breakAnim: 'stone_crumble' },
  magic_crystal:      { count: 0, bulkColor: 0x3da8d2, shape: 'crystal_cluster',
                        baseHits: 7, chipPerHit: 0.18, breakAnim: 'crystal_flash' },
};

/**
 * Deck-mode visibility gate. When in `'deck'` realm, only show nodes whose unlock card is
 * owned. In `'awakened'` realm, ignored — everything visible.
 */
const DECK_UNLOCK_CARD: Partial<Record<FreeRoamHarvestKind, string>> = {
  mine_iron_ore: 'c_card_iron_tools',
  mine_coal: 'c_card_iron_tools',
  mine_copper_ore: 'c_card_alloy_crucible',
  mine_tin_ore: 'c_card_alloy_crucible',
  mine_zinc_ore: 'c_card_alloy_crucible',
  mine_silver_ore: 'c_card_precious_arc',
  mine_gold_ore: 'c_card_precious_arc',
  mine_platinum_ore: 'c_card_precious_arc',
  magic_crystal: 'c_magic_awakening',
};

/**
 * Real-time seconds the broken node sits invisible (HP 0, no collision) before
 * its growth animation starts. Cut from the prior 7-min hard cooldown to a 3-min
 * wait so the world heals at a "decent rate" — the player sees seedlings appear
 * and grow into mature obstacles as they explore. Total cycle =
 * REGROW_WAIT_SEC + per-kind GROW_DURATION_SEC (see below).
 */
const REGROW_WAIT_SEC = 180;
/** Avatar-to-node max distance for the "Press E" prompt + harvest. */
const INTERACT_RADIUS = 1.5;
/** Don't scatter inside this radius of camp center (keep the dock area clear). */
const CAMP_KEEPOUT_RADIUS = 4;

/** Animation timings (seconds). */
const TREE_FALL_ROT_SEC = 0.7;
const TREE_FALL_POOF_SEC = 0.2;
const TREE_FALL_TOTAL_SEC = TREE_FALL_ROT_SEC + TREE_FALL_POOF_SEC;
const STONE_CRUMBLE_SEC = 0.4;
const BUSH_COLLAPSE_SEC = 0.3;
const FIBER_WISP_SEC = 0.2;
const CRYSTAL_FLASH_SEC = 0.55;

/**
 * Growth durations per archetype (seconds). Trees are slowest so the sapling-to-
 * mature transition is legibly visible; ground props snap back faster so the
 * world doesn't feel sparse for long.
 */
const TREE_GROW_SEC = 60;
const BUSH_GROW_SEC = 30;
const STONE_FORM_SEC = 12;        /* rocks + ore "rise" out of the ground */
const FIBER_GROW_SEC = 18;
const CRYSTAL_EMERGE_SEC = 14;    /* crystal cluster phases up with a slight rotate */

/** Starting scale fraction at the very first growth frame. Tuned per archetype so
 *  the first visible frame reads as a believable seedling/pebble/sprout. */
const TREE_GROW_MIN_SCALE = 0.08;
const BUSH_GROW_MIN_SCALE = 0.14;
const STONE_FORM_MIN_SCALE = 0.30;
const FIBER_GROW_MIN_SCALE = 0.18;
const CRYSTAL_EMERGE_MIN_SCALE = 0.20;

export interface ScatteredNode {
  kind: FreeRoamHarvestKind;
  index: number;
  /** World-space XZ. */
  x: number;
  z: number;
  /**
   * Real-time ms when the node's growth animation should START. While > now the
   * node is in the invisible "respawn-wait" phase. When it elapses, the respawn
   * loop kicks off the grow animation and zeros this so it's not re-triggered.
   */
  availableAtMs: number;
  /**
   * True while a `*_grow` animation is in flight. Prevents the respawn loop from
   * pushing duplicate animations and gates harvest (saplings can't be chopped).
   * Cleared on grow finalize when the node returns to mature state.
   */
  isGrowing: boolean;
  /** Hits remaining until break. Counts down by `applyHit(node, mult)`. */
  hp: number;
  /** Original baseHits for this kind (for HUD progress display). */
  maxHp: number;
  /**
   * Per-instance collision radius (`HARVEST_FOOTPRINT_RADII[shape] * scaleBase`).
   * Surfaced so callers can compute SURFACE distance — essential for harvest-reach
   * gates on big trees / boulders, where center-distance vs collision push-out
   * makes them otherwise unreachable. Without this, the player can't get close
   * enough to a max-scale apple tree to harvest it because collision push-out
   * keeps them at center-distance > the gate radius.
   */
  collisionRadius: number;
}

export interface HitResult {
  /** Set when the node was already broken / on cooldown — caller should ignore. */
  ignored: boolean;
  /** True iff this hit took the node down to hp <= 0. Triggers final yield + animation. */
  broken: boolean;
  /** Per-hit chip yield (raw inventory units). 0 if `ignored`. */
  chipYield: number;
  /** Hits remaining after this hit (for HUD). */
  hpRemaining: number;
}

export interface FreeRoamHarvestHandle {
  nodes: ReadonlyArray<ScatteredNode>;
  /**
   * Find the closest visible & available node within `INTERACT_RADIUS` of `avatarPos`.
   * Returns `null` when nothing is reachable. Cheap (linear over ~150 nodes; no allocations).
   */
  getNodeNearAvatar(avatarPos: { x: number; z: number }): ScatteredNode | null;
  /**
   * Apply one hit to a node. `hitsMult` is the player's tool multiplier (1.0 = bare-hand
   * baseline, 4.0 = steel axe etc.). Returns `{ broken, chipYield, hpRemaining }` so the
   * caller can deposit chip yield + (on break) trigger final yield + break SFX.
   */
  applyHit(node: ScatteredNode, hitsMult: number): HitResult;
  /**
   * Per-frame integrator. Advances any in-flight fall / crumble / collapse animations and
   * lazily restores broken nodes whose `availableAtMs` has elapsed. Cheap: typically
   * 0–3 active animations at once + a handful of respawn checks.
   */
  update(dtSec: number): void;
  /**
   * Apply visibility rules. Signature-gated — calling with unchanged rules is a single
   * string compare and early-return.
   */
  setVisibilityRules(rules: VisibilityRules): void;
  /** Detach group + dispose geometries / materials. */
  dispose(): void;
}

export interface VisibilityRules {
  realm: 'deck' | 'awakened';
  unlockedCardIds: ReadonlySet<string> | ReadonlyArray<string>;
  forceShowAll: boolean;
}

interface AttachOpts {
  scene: THREE.Scene;
  getTerrainHeight: (x: number, z: number) => number;
  mapRadius: number;
  /** Stable seed so node positions are reproducible across launches. */
  seed?: number;
  /**
   * World-space XZ of the existing on-map crystal scatter
   * (`scatterIdleCraftCrystalProps`). Magic-crystal harvest nodes reuse THESE positions —
   * we don't spawn parallel crystal meshes; the player mines the visible crystals.
   */
  crystalSpotsXZ?: { x: number; z: number }[];
  /**
   * Per-cluster Group references aligned 1:1 with `crystalSpotsXZ`. When a magic_crystal
   * node is fully harvested, the harvest module animates the matching cluster Group
   * (shrink-and-hide with a slight wobble) so the crystal visibly shatters out of the
   * scene. Restores the cluster on respawn.
   */
  crystalClusters?: { x: number; z: number; group: THREE.Group }[];
  /**
   * Optional collision world (Phase 1.5 — see `BASE_BUILDING_AND_SURVIVAL_PLAN.md` §10).
   * When provided, every scattered tree / berry bush / fiber tuft / rock pile / ore
   * chunk / crystal cluster registers a circle footprint so the player + mobs can't
   * walk through them. On harvest break (hp -> 0) the footprint is unregistered.
   * On respawn (the long REGROW_SEC cycle) it's re-registered.
   */
  collisionWorld?: import('./collisionWorld').CollisionWorldHandle;
}

/** Stable collision-world owner-id encoding for a (kind, index) pair. */
function harvestFootprintOwnerId(kind: FreeRoamHarvestKind, index: number): string {
  return `harvest:${kind}:${index}`;
}

/* Per-shape COLLISION footprint radius (world units). Matches the TRUNK / base
 * silhouette, NOT the canopy. The visual canopy of an apple tree is ~1.4 m wide
 * at full scale, but the trunk is ~0.3 m. Sizing collision to the trunk lets the
 * player walk under the canopy and stand right next to the bark to harvest —
 * a bigger collision radius would push them out at canopy-distance and the
 * harvest-reach gate could never be satisfied for max-scale trees (the user
 * report: "a lot of trees won't let me harvest, won't let me get close enough").
 *
 * Y-extent (`HARVEST_TOP_Y_OFFSET`) is decoupled — it's measured from the merged
 * mesh bbox in `maxYAtUnitScale` and stays at the visual canopy top so jumping
 * onto a tree from above still lands on the canopy via `getGroundY`. */
const HARVEST_FOOTPRINT_RADII: Record<KindConfig['shape'], number> = {
  apple_tree: 0.30,    /* trunk-only (was 0.45 = trunk+canopy edge) */
  fiber_tuft: 0.18,
  berry_bush: 0.32,
  rock_pile: 0.28,
  ore_chunk: 0.22,
  crystal_cluster: 0.55, /* matches the on-map crystal cluster's stone bed footprint */
};

/**
 * Per-shape vertical extent above the node's terrain Y. Used to set `topY` on the
 * collision footprint so:
 *   - jumping over a 0.4 m rock pile is trivial (single jump apex ~1.84 m clears it),
 *   - jumping over an 1.8 m apple tree needs the double jump,
 *   - the player can land ON top of the tree / rock / crystal via `getGroundY`.
 *
 * Apple trees from `buildIdleCraftAppleTree` cap their canopy at roughly 1.8 m * scale;
 * the per-instance scale (0.85-1.15) is folded in at register time.
 */
const HARVEST_TOP_Y_OFFSET: Record<KindConfig['shape'], number> = {
  apple_tree: 1.8,
  fiber_tuft: 0.35, /* not used for blocking — fiber is non-blocking now — but kept for tagging */
  berry_bush: 0.6,
  rock_pile: 0.4,
  ore_chunk: 0.45,
  crystal_cluster: 1.6,
};

/**
 * Which shapes block movement. Ores + trees + berries + crystals block; fiber /
 * rock piles do not (matches dock: stone scatter non-blocking, ore veins blocking).
 */
const HARVEST_SHAPE_BLOCKING: Record<KindConfig['shape'], boolean> = {
  apple_tree: true,
  fiber_tuft: false,
  berry_bush: false,
  rock_pile: false,
  ore_chunk: true,
  crystal_cluster: true,
};

/**
 * Per-instance state used by the per-frame animator. One entry per (node, sub-mesh) is
 * NOT needed — the world matrix at the node level is the same across all sub-meshes of a
 * kind, since `mergeByMaterial` baked sub-mesh local transforms into vertex positions.
 */
interface InstanceTransform {
  /** Original placement (T·R·S) at node's world XZ. Restored on respawn. */
  baseMatrix: THREE.Matrix4;
  /** Random fall direction (XZ unit vector) — picked at scatter time, used by tree_fall. */
  fallAxisX: number;
  fallAxisZ: number;
  /** Per-instance random scale (0.85..1.15). Stored so respawn restores correctly. */
  scaleBase: number;
  /** Per-instance Y rotation. */
  rotY: number;
}

/**
 * Per-kind GPU resources + state. One entry per kind in `FREE_ROAM_HARVEST_KINDS`.
 * `magic_crystal` is a special case: `meshes` is empty (no parallel meshes — uses the
 * existing on-map crystal scatter); harvest still tracks hp/respawn via `nodes`.
 */
interface KindHandle {
  cfg: KindConfig;
  /** One InstancedMesh per material in the LPCA template. 0 entries for magic_crystal. */
  meshes: THREE.InstancedMesh[];
  /** Node-level transforms (length = cfg.count). Magic crystal: length = crystalSpotsXZ.length. */
  transforms: InstanceTransform[];
  /** Sub-group for visibility toggling (`.visible = false` short-circuits descendant draws). */
  group: THREE.Group;
  /**
   * Highest local-space Y across all merged sub-mesh bounding boxes (template
   * scale). Drives each instance's collision `topY` override so the player's
   * feet land EXACTLY on the visual canopy top — replaces the prior hand-tuned
   * `HARVEST_TOP_Y_OFFSET` value which drifted with `scaleBase`. Same idiom as
   * `dockForestBatchedScene.VariantTemplate.maxYAtUnitScale`.
   */
  maxYAtUnitScale: number;
  /**
   * Magic-crystal only: per-node Group reference into the existing on-map crystal scatter
   * (`scatterIdleCraftCrystalProps`). Indexed by `node.index`. Animated on break (shrink
   * + wobble) and restored on respawn. Empty for all other kinds.
   */
  externalGroups?: THREE.Group[];
  /**
   * Magic-crystal only: original Y rotation per cluster, captured at attach time so the
   * shatter animation can rebuild the Group's Euler each frame around its base wobble.
   */
  externalBaseRotY?: number[];
}

/** In-flight fall/crumble/collapse OR sapling-grow animation. Removed when `t >= duration`. */
interface ActiveAnimation {
  kind: FreeRoamHarvestKind;
  nodeIndex: number;
  archetype: AnimArchetype;
  /** Elapsed seconds since the animation started. */
  t: number;
  duration: number;
}

const HIDDEN_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Singleton-per-scene marker stored on the THREE.Scene (not module state) so
 * it survives Vite HMR / dynamic-import module-instance differences. See the
 * matching pattern in `dockForestBatchedScene.ts`.
 */
type SceneWithFreeRoamHarvest = THREE.Scene & {
  userData: { freeRoamHarvestHandle?: FreeRoamHarvestHandle };
};

export function attachFreeRoamHarvestNodes(opts: AttachOpts): FreeRoamHarvestHandle {
  /* === 2026-04-20 scene-singleton enforcement ===
   *
   * If this scene already has a free-roam harvest handle attached, return
   * THAT existing handle instead of building a duplicate. Robust against any
   * adoption-gap or module-instance race — the scene is the single source
   * of truth. See the matching pattern in `dockForestBatchedScene.ts`. */
  const sceneWithHandle = opts.scene as SceneWithFreeRoamHarvest;
  const existing = sceneWithHandle.userData.freeRoamHarvestHandle;
  if (existing) {
    /* Scene-singleton hit: silently reuse — see matching pattern + comment
     * in `dockForestBatchedScene.ts`. */
    return existing;
  }

  const seed = opts.seed ?? 0x7a3c2d51;
  const rng = mulberry32(seed);
  const root = new THREE.Group();
  root.name = 'FreeRoamHarvestRoot';
  opts.scene.add(root);

  const nodes: ScatteredNode[] = [];
  const handles: Partial<Record<FreeRoamHarvestKind, KindHandle>> = {};
  const activeAnimations: ActiveAnimation[] = [];
  /* === 2026-04-20 broken-node tracking (FPS) ===
   *
   * Mirrors the proven pattern in `dockForestBatchedScene.ts`: instead of
   * walking ALL scattered nodes (~150-300) every frame to look for any node
   * whose respawn timer has elapsed, we track the small set of currently-
   * broken nodes (typically 0-5). The respawn loop early-exits when the set
   * is empty (the common case), and otherwise iterates only those entries
   * → ~150x reduction in per-frame work for the common case. */
  const brokenNodes = new Set<ScatteredNode>();

  for (const kind of FREE_ROAM_HARVEST_KINDS) {
    const cfg = KIND_CFG[kind];
    const sub = new THREE.Group();
    sub.name = `FreeRoam_${kind}`;
    root.add(sub);

    /* Magic crystals: REUSE existing on-map crystal scatter (no parallel InstancedMesh).
     * The harvest module ANIMATES the existing per-cluster Groups directly when one is
     * fully harvested — shrink + wobble + hide — and restores them on respawn. */
    if (kind === 'magic_crystal' && opts.crystalSpotsXZ && opts.crystalSpotsXZ.length > 0) {
      const transforms: InstanceTransform[] = [];
      const externalGroups: THREE.Group[] = [];
      const externalBaseRotY: number[] = [];
      opts.crystalSpotsXZ.forEach((pos, idx) => {
        nodes.push({
          kind,
          index: idx,
          x: pos.x,
          z: pos.z,
          availableAtMs: 0,
          isGrowing: false,
          hp: cfg.baseHits,
          maxHp: cfg.baseHits,
          collisionRadius: HARVEST_FOOTPRINT_RADII.crystal_cluster,
        });
        transforms.push({
          baseMatrix: new THREE.Matrix4(), /* unused for crystal — no mesh */
          fallAxisX: 0, fallAxisZ: 0, scaleBase: 1, rotY: 0,
        });
        /* Crystal cluster footprint — sits on its rubble bed; player + mobs can't walk
         * through it. Same owner-id scheme as scattered kinds so unregister-on-break /
         * re-register-on-respawn share one path below. */
        if (opts.collisionWorld) {
          const baseY = opts.getTerrainHeight(pos.x, pos.z);
          opts.collisionWorld.register({
            kind: 'circle',
            x: pos.x,
            z: pos.z,
            r: HARVEST_FOOTPRINT_RADII.crystal_cluster,
            ownerId: harvestFootprintOwnerId(kind, idx),
            blocking: HARVEST_SHAPE_BLOCKING.crystal_cluster,
            tag: 'static',
            bottomY: baseY,
            topY: baseY + HARVEST_TOP_Y_OFFSET.crystal_cluster,
          });
        }
        /* Pair each node with its cluster Group by matching XZ position (positions are
         * generated by the same `getIdleCraftCrystalWorldPositions()` so the orders should
         * align by index, but match defensively in case ordering drifts). */
        const cluster = opts.crystalClusters?.[idx];
        if (cluster) {
          externalGroups.push(cluster.group);
          externalBaseRotY.push(cluster.group.rotation.y);
        } else {
          /* Push a placeholder so the array stays parallel to nodes — animation branch
           * checks for null group before touching it. */
          externalGroups.push(new THREE.Group());
          externalBaseRotY.push(0);
        }
      });
      handles[kind] = {
        cfg,
        meshes: [],
        transforms,
        group: sub,
        externalGroups,
        externalBaseRotY,
        /* Crystal cluster top — keep the prior hand-tuned offset since the
         * external Group's measured bbox isn't readily available here and the
         * existing 1.6 m value was correct for the crystal scatter. */
        maxYAtUnitScale: HARVEST_TOP_Y_OFFSET.crystal_cluster,
      };
      continue;
    }

    if (cfg.count === 0) {
      handles[kind] = { cfg, meshes: [], transforms: [], group: sub, maxYAtUnitScale: 1.0 };
      continue;
    }

    /* Build ONE template instance and merge by material to get N sub-meshes (one per
     * material in the template). Each sub-mesh becomes one InstancedMesh. */
    const sharedMat = makeMat(cfg);
    const template = buildKindTemplate(cfg, sharedMat, rng);
    template.position.set(0, 0, 0);
    template.updateMatrixWorld(true);
    /* The Group's children carry the template's geometry. We need a wrapping Group for
     * mergeByMaterial; we already have that. */
    const mergedGroup = mergeByMaterial(template);
    /* Collect (geometry, material) pairs from the merged result. */
    const mergedMeshes: THREE.Mesh[] = [];
    mergedGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) mergedMeshes.push(m);
    });
    /* Dispose original template geometries — `mergeByMaterial` cloned them; we hold the
     * merged copies via `mergedMeshes`. */
    template.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) m.geometry.dispose();
    });

    /* Measure the LPCA template's actual local-space max Y from the merged sub-
     * mesh bounding boxes — used as the per-instance collision topY so the
     * player lands on the visual canopy top, not on the prior hand-tuned
     * `HARVEST_TOP_Y_OFFSET` value (which drifted by ~1 body length on bigger
     * scaleBase variants). 1.0 fallback keeps collision sane if a kind has no
     * geometry (e.g. magic_crystal which doesn't reach this branch). */
    let maxYAtUnitScale = -Infinity;
    for (const m of mergedMeshes) {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox;
      if (bb && bb.max.y > maxYAtUnitScale) maxYAtUnitScale = bb.max.y;
    }
    if (!Number.isFinite(maxYAtUnitScale)) maxYAtUnitScale = 1.0;

    /* Create one InstancedMesh per merged sub-mesh. Init every instance to the
     * HIDDEN_MATRIX placeholder; we'll write the real placement matrices below. */
    const instancedMeshes: THREE.InstancedMesh[] = mergedMeshes.map((m) => {
      const im = new THREE.InstancedMesh(m.geometry, m.material as THREE.Material, cfg.count);
      im.castShadow = shouldCastShadow(cfg.shape);
      im.receiveShadow = false;
      im.frustumCulled = true;
      /* Default to hidden — gets overwritten with real matrices in the loop below. */
      for (let i = 0; i < cfg.count; i++) im.setMatrixAt(i, HIDDEN_MATRIX);
      im.instanceMatrix.needsUpdate = true;
      sub.add(im);
      return im;
    });

    /* Scatter and write the per-instance world matrices. */
    const transforms: InstanceTransform[] = [];
    const tmpMat = new THREE.Matrix4();
    const tmpQuat = new THREE.Quaternion();
    const tmpUp = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < cfg.count; i++) {
      /* Disc rejection sampling — keep nodes outside the camp keepout radius and inside
       * the map. */
      let x = 0;
      let z = 0;
      for (let attempt = 0; attempt < 16; attempt++) {
        const r = CAMP_KEEPOUT_RADIUS + rng() * (opts.mapRadius - CAMP_KEEPOUT_RADIUS - 1);
        const a = rng() * Math.PI * 2;
        x = Math.cos(a) * r;
        z = Math.sin(a) * r;
        const ndist = Math.hypot(x, z);
        if (ndist > CAMP_KEEPOUT_RADIUS && ndist < opts.mapRadius - 0.5) break;
      }
      const y = opts.getTerrainHeight(x, z);
      const rotY = rng() * Math.PI * 2;
      const scale = 0.85 + rng() * 0.3; /* 0.85..1.15 visible variation between instances */
      /* Random horizontal fall direction for tree_fall. */
      const fallAng = rng() * Math.PI * 2;
      const fallAxisX = Math.cos(fallAng);
      const fallAxisZ = Math.sin(fallAng);

      /* Compose base matrix: T(x,y,z) * R_y(rotY) * S(scale). */
      tmpQuat.setFromAxisAngle(tmpUp, rotY);
      const baseMatrix = new THREE.Matrix4();
      baseMatrix.compose(new THREE.Vector3(x, y, z), tmpQuat, new THREE.Vector3(scale, scale, scale));
      transforms.push({ baseMatrix, fallAxisX, fallAxisZ, scaleBase: scale, rotY });

      for (const im of instancedMeshes) {
        im.setMatrixAt(i, baseMatrix);
      }

      nodes.push({
        kind,
        index: i,
        x, z,
        availableAtMs: 0,
        isGrowing: false,
        hp: cfg.baseHits,
        maxHp: cfg.baseHits,
        collisionRadius: HARVEST_FOOTPRINT_RADII[cfg.shape] * scale,
      });
      /* Register a circle footprint with the collision world (when wired) so the
       * player and mobs can't walk through scattered trees / rocks / ore / crystals.
       * Owner id encodes (kind, index) so we can unregister on harvest break + re-register
       * on respawn. Scaled by the per-instance scale so a smaller tree has a smaller
       * footprint. */
      if (opts.collisionWorld) {
        opts.collisionWorld.register({
          kind: 'circle',
          x, z,
          r: HARVEST_FOOTPRINT_RADII[cfg.shape] * scale,
          ownerId: harvestFootprintOwnerId(kind, i),
          blocking: HARVEST_SHAPE_BLOCKING[cfg.shape],
          tag: 'static',
          bottomY: y,
          topY: y + maxYAtUnitScale * scale,
        });
      }
    }
    /* One needsUpdate per InstancedMesh after the whole scatter is written. */
    for (const im of instancedMeshes) im.instanceMatrix.needsUpdate = true;

    handles[kind] = { cfg, meshes: instancedMeshes, transforms, group: sub, maxYAtUnitScale };

    /* Suppress unused-var warnings; tmpMat/tmpQuat are reused in animation below via
     * closures, so the references are kept by `update()`. */
    void tmpMat;
  }

  /* ---- Public API ---- */

  function getNodeNearAvatar(avatarPos: { x: number; z: number }): ScatteredNode | null {
    const ax = avatarPos.x;
    const az = avatarPos.z;
    let best: ScatteredNode | null = null;
    let bestDist2 = INTERACT_RADIUS * INTERACT_RADIUS;
    const nowMs = Date.now();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      const h = handles[n.kind];
      if (!h || !h.group.visible) continue;
      if (n.availableAtMs > nowMs) continue; /* still respawning */
      if (n.isGrowing) continue;             /* sapling — let it grow up first */
      if (n.hp <= 0) continue;               /* fall animation in flight */
      const dx = n.x - ax;
      const dz = n.z - az;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDist2) {
        bestDist2 = d2;
        best = n;
      }
    }
    return best;
  }

  function applyHit(node: ScatteredNode, hitsMult: number): HitResult {
    const nowMs = Date.now();
    if (node.availableAtMs > nowMs || node.hp <= 0) {
      return { ignored: true, broken: false, chipYield: 0, hpRemaining: node.hp };
    }
    const cfg = KIND_CFG[node.kind];
    const damage = Math.max(0.01, hitsMult);
    node.hp -= damage;
    /* Chip yield every hit — small, satisfying "you got something" signal. */
    const chip = cfg.chipPerHit;
    if (node.hp <= 0) {
      node.hp = 0;
      /* Schedule grow-start now. The timer counts during the fall animation —
       * by the time the player wanders back, the wait is mostly over and a
       * sapling will pop into existence + visibly grow. */
      node.availableAtMs = nowMs + REGROW_WAIT_SEC * 1000;
      node.isGrowing = false;
      brokenNodes.add(node);
      /* Unregister the node's collision footprint so the player can walk THROUGH the
       * spot where the tree fell / rock crumbled. Re-registered on respawn below. */
      if (opts.collisionWorld) {
        opts.collisionWorld.unregister(harvestFootprintOwnerId(node.kind, node.index));
      }
      /* Kick off the visual break animation. The animator will hide the instance at
       * animation end. */
      activeAnimations.push({
        kind: node.kind,
        nodeIndex: node.index,
        archetype: cfg.breakAnim,
        t: 0,
        duration: durationFor(cfg.breakAnim),
      });
      return { ignored: false, broken: true, chipYield: chip, hpRemaining: 0 };
    }
    return { ignored: false, broken: false, chipYield: chip, hpRemaining: node.hp };
  }

  /* Per-frame: advance animations + check for respawns. */
  const _scratchMat = new THREE.Matrix4();
  const _scratchQuat = new THREE.Quaternion();
  const _scratchPos = new THREE.Vector3();
  const _scratchScale = new THREE.Vector3();
  const _scratchAxis = new THREE.Vector3();
  const _scratchFallQuat = new THREE.Quaternion();
  const _scratchYQuat = new THREE.Quaternion();
  const _yUp = new THREE.Vector3(0, 1, 0);

  function update(dtSec: number): void {
    /* ---- Animations (covers BOTH break and grow archetypes; typically 0-5 active) ----
     * On break done -> hide instance / hide external crystal group.
     * On grow done -> snap to base matrix at full scale, restore hp = maxHp,
     *                 register collision, clear isGrowing. The node is then fully
     *                 harvestable again. */
    if (activeAnimations.length > 0) {
      const dirtyKinds = new Set<FreeRoamHarvestKind>();
      for (let i = activeAnimations.length - 1; i >= 0; i--) {
        const anim = activeAnimations[i]!;
        anim.t += dtSec;
        const h = handles[anim.kind];
        if (!h) {
          if (anim.t >= anim.duration) activeAnimations.splice(i, 1);
          continue;
        }
        const done = anim.t >= anim.duration;
        const isGrow = isGrowArchetype(anim.archetype);

        /* ---- Magic crystal external-group animations (both flash + emerge) ---- */
        if (anim.archetype === 'crystal_flash' || anim.archetype === 'crystal_emerge') {
          const grp = h.externalGroups?.[anim.nodeIndex];
          const baseRotY = h.externalBaseRotY?.[anim.nodeIndex] ?? 0;
          const node = nodes.find((n) => n.kind === anim.kind && n.index === anim.nodeIndex);
          if (grp) {
            if (done) {
              if (anim.archetype === 'crystal_flash') {
                grp.visible = false;
                grp.scale.setScalar(1);
                grp.rotation.y = baseRotY;
              } else {
                /* Emerge done: settle to full scale + base rot. */
                grp.visible = true;
                grp.scale.setScalar(1);
                grp.rotation.y = baseRotY;
                if (node) {
                  node.hp = node.maxHp;
                  node.isGrowing = false;
                  brokenNodes.delete(node);
                }
                /* Re-register the crystal's full-radius footprint. */
                if (opts.collisionWorld && node) {
                  const baseY = opts.getTerrainHeight(node.x, node.z);
                  opts.collisionWorld.register({
                    kind: 'circle',
                    x: node.x, z: node.z,
                    r: HARVEST_FOOTPRINT_RADII.crystal_cluster,
                    ownerId: harvestFootprintOwnerId(node.kind, node.index),
                    blocking: HARVEST_SHAPE_BLOCKING.crystal_cluster,
                    tag: 'static',
                    bottomY: baseY,
                    topY: baseY + HARVEST_TOP_Y_OFFSET.crystal_cluster,
                  });
                }
              }
            } else {
              const t = anim.t / anim.duration;
              if (anim.archetype === 'crystal_flash') {
                const sf = Math.max(0, 1 - t);
                const wobble = Math.sin(t * Math.PI * 8) * 0.6 * (1 - t);
                grp.scale.setScalar(sf);
                grp.rotation.y = baseRotY + wobble;
              } else {
                /* Emerge: scale up from min with a slow upward rotate. */
                const grow = CRYSTAL_EMERGE_MIN_SCALE
                  + (1 - CRYSTAL_EMERGE_MIN_SCALE) * easeOutCubic(t);
                const slowSpin = (1 - t) * 0.6; /* gentle settle */
                grp.scale.setScalar(grow);
                grp.rotation.y = baseRotY + slowSpin;
              }
            }
          }
          if (done) activeAnimations.splice(i, 1);
          continue;
        }

        if (h.meshes.length === 0) {
          if (done) activeAnimations.splice(i, 1);
          continue;
        }
        const xform = h.transforms[anim.nodeIndex];
        if (!xform) {
          activeAnimations.splice(i, 1);
          continue;
        }
        if (done && isGrow) {
          /* Grow finalize: write the exact base matrix at full scale, restore hp,
           * register collision, clear flag. */
          for (const im of h.meshes) im.setMatrixAt(anim.nodeIndex, xform.baseMatrix);
          dirtyKinds.add(anim.kind);
          const node = nodes.find((n) => n.kind === anim.kind && n.index === anim.nodeIndex);
          if (node) {
            node.hp = node.maxHp;
            node.isGrowing = false;
            brokenNodes.delete(node);
            if (opts.collisionWorld) {
              const cfg = KIND_CFG[node.kind];
              const baseY = opts.getTerrainHeight(node.x, node.z);
              opts.collisionWorld.register({
                kind: 'circle',
                x: node.x, z: node.z,
                r: HARVEST_FOOTPRINT_RADII[cfg.shape] * xform.scaleBase,
                ownerId: harvestFootprintOwnerId(node.kind, node.index),
                blocking: HARVEST_SHAPE_BLOCKING[cfg.shape],
                tag: 'static',
                bottomY: baseY,
                topY: baseY + h.maxYAtUnitScale * xform.scaleBase,
              });
            }
          }
          activeAnimations.splice(i, 1);
          continue;
        }
        const mat = computeAnimatedMatrix(
          anim,
          xform,
          done && !isGrow, /* `done` here only means "hide" for break archetypes */
          _scratchMat, _scratchQuat, _scratchPos, _scratchScale,
          _scratchAxis, _scratchFallQuat, _scratchYQuat, _yUp,
        );
        for (const im of h.meshes) im.setMatrixAt(anim.nodeIndex, mat);
        dirtyKinds.add(anim.kind);
        if (done) activeAnimations.splice(i, 1);
      }
      for (const k of dirtyKinds) {
        const h = handles[k];
        if (!h) continue;
        for (const im of h.meshes) im.instanceMatrix.needsUpdate = true;
      }
    }

    /* ---- Respawns: now KICKS OFF a grow animation instead of snap-restoring ----
     * State machine per broken node:
     *   1. broken (hp == 0, isGrowing == false, availableAtMs > now): wait
     *   2. wait elapsed: push grow animation, set isGrowing = true,
     *      availableAtMs = 0, instance pops in at sapling scale
     *   3. growing: animation finalizer (above) restores hp + collision + flag
     *
     * Walks only `brokenNodes` (typically 0-5) instead of all ~150-300
     * scattered nodes. Common case: brokenNodes is empty -> single Set.size
     * compare exits. See matching pattern in `dockForestBatchedScene.ts`. */
    if (brokenNodes.size === 0) return;
    const nowMs = Date.now();
    const dirtyRespawnKinds = new Set<FreeRoamHarvestKind>();
    for (const n of brokenNodes) {
      if (n.hp > 0) continue;
      if (n.isGrowing) continue;
      if (n.availableAtMs > nowMs) continue;

      const h = handles[n.kind];
      if (!h) continue;
      n.isGrowing = true;
      n.availableAtMs = 0;
      const cfg = KIND_CFG[n.kind];
      const growArch = growForBreak(cfg.breakAnim);

      /* Magic crystal: emerge animation on the external cluster Group. */
      if (n.kind === 'magic_crystal') {
        const grp = h.externalGroups?.[n.index];
        const baseRotY = h.externalBaseRotY?.[n.index] ?? 0;
        if (grp) {
          grp.visible = true;
          grp.scale.setScalar(CRYSTAL_EMERGE_MIN_SCALE);
          grp.rotation.y = baseRotY;
        }
        activeAnimations.push({
          kind: n.kind,
          nodeIndex: n.index,
          archetype: growArch,
          t: 0,
          duration: durationFor(growArch),
        });
        continue;
      }

      if (h.meshes.length === 0) continue;
      const xform = h.transforms[n.index];
      if (!xform) continue;

      /* Build the sapling-scale matrix from the base matrix's position + rotation
       * but at min-scale * scaleBase. The instance becomes visible immediately at
       * this tiny size so the player sees a believable seedling pop in. */
      const minScale = minScaleFor(growArch);
      xform.baseMatrix.decompose(_scratchPos, _scratchQuat, _scratchScale);
      const startScale = xform.scaleBase * minScale;
      _scratchMat.compose(
        _scratchPos, _scratchQuat,
        _scratchScale.set(startScale, startScale, startScale),
      );
      for (const im of h.meshes) im.setMatrixAt(n.index, _scratchMat);
      dirtyRespawnKinds.add(n.kind);

      activeAnimations.push({
        kind: n.kind,
        nodeIndex: n.index,
        archetype: growArch,
        t: 0,
        duration: durationFor(growArch),
      });
    }
    for (const k of dirtyRespawnKinds) {
      const h = handles[k];
      if (!h) continue;
      for (const im of h.meshes) im.instanceMatrix.needsUpdate = true;
    }
  }

  /* ---- Visibility ---- */
  let lastRulesSig = '';
  function setVisibilityRules(vis: VisibilityRules): void {
    const unlockedSet =
      vis.unlockedCardIds instanceof Set
        ? (vis.unlockedCardIds as ReadonlySet<string>)
        : new Set(vis.unlockedCardIds);
    const cards = Array.from(unlockedSet).sort().join(',');
    const sig = `${vis.realm}|${vis.forceShowAll ? 1 : 0}|${cards}`;
    if (sig === lastRulesSig) return;
    lastRulesSig = sig;
    for (let i = 0; i < FREE_ROAM_HARVEST_KINDS.length; i++) {
      const kind = FREE_ROAM_HARVEST_KINDS[i]!;
      const h = handles[kind];
      if (!h) continue;
      const cardGate = DECK_UNLOCK_CARD[kind];
      const gateOk =
        vis.forceShowAll ||
        vis.realm === 'awakened' ||
        cardGate == null ||
        unlockedSet.has(cardGate);
      h.group.visible = gateOk;
    }
  }

  function dispose(): void {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry?.dispose();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else (mat as THREE.Material | undefined)?.dispose();
    });
    if (root.parent) root.parent.remove(root);
    /* Clear the scene-singleton marker so subsequent legitimate re-attaches
     * (e.g., return-to-title → re-enter game) build fresh handles. */
    const sceneStash = opts.scene as SceneWithFreeRoamHarvest;
    if (sceneStash.userData.freeRoamHarvestHandle === handle) {
      delete sceneStash.userData.freeRoamHarvestHandle;
    }
  }

  const handle: FreeRoamHarvestHandle = { nodes, getNodeNearAvatar, applyHit, update, setVisibilityRules, dispose };
  /* Stash the handle on the scene's userData so subsequent attach calls on
   * the same scene SHORT-CIRCUIT to reuse it. See singleton-enforcement
   * comment at the top of this function. */
  sceneWithHandle.userData.freeRoamHarvestHandle = handle;
  return handle;
}

/* ============================================================================
 * Helpers
 * ============================================================================ */

function makeMat(cfg: KindConfig): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: cfg.bulkColor,
    roughness: cfg.roughness ?? 0.78,
    metalness: cfg.metalness ?? 0.08,
    emissive: cfg.emissive ?? 0x000000,
    emissiveIntensity: cfg.emissiveIntensity ?? 0,
  });
}

/**
 * Build ONE template Group for a kind. The template will be merged by material into a
 * small set of (geometry, material) pairs that drive the InstancedMesh per-kind setup.
 */
function buildKindTemplate(
  cfg: KindConfig,
  sharedMat: THREE.MeshStandardMaterial,
  rng: () => number,
): THREE.Group {
  switch (cfg.shape) {
    case 'apple_tree': {
      const tree = buildIdleCraftAppleTree(rng, 0.95);
      tree.rotation.y = 0;
      return tree;
    }
    case 'fiber_tuft': {
      const fiberGroup = buildIdleCraftFiberGrass(rng);
      fiberGroup.scale.setScalar(1.0);
      return fiberGroup;
    }
    case 'berry_bush': {
      const bush = buildIdleCraftBerryBush(rng);
      bush.scale.setScalar(1.0);
      return bush;
    }
    case 'rock_pile': {
      /* Multi-pebble cluster. All pebbles share `sharedMat` so mergeByMaterial collapses
       * the whole pile to ONE merged mesh per template. */
      const cluster = new THREE.Group();
      const n = 5;
      for (let i = 0; i < n; i++) {
        const r = 0.06 + rng() * 0.06;
        const geo = new THREE.DodecahedronGeometry(r, 0);
        const m = new THREE.Mesh(geo, sharedMat);
        const ang = (i / n) * Math.PI * 2 + rng() * 0.3;
        const dist = rng() * 0.12;
        m.position.set(Math.cos(ang) * dist, 0.02 + r * 0.65 + rng() * 0.04, Math.sin(ang) * dist);
        m.rotation.set(rng() * 1.5, rng() * 6.28, rng() * 1.5);
        cluster.add(m);
      }
      cluster.scale.setScalar(1.4);
      return cluster;
    }
    case 'ore_chunk': {
      const cluster = new THREE.Group();
      const g = new THREE.IcosahedronGeometry(0.24, 0);
      const m = new THREE.Mesh(g, sharedMat);
      m.scale.set(1, 0.95, 1);
      m.position.y = 0.18;
      cluster.add(m);
      return cluster;
    }
    case 'crystal_cluster': {
      /* Fallback only — magic_crystal kind takes the special branch above. */
      const cluster = new THREE.Group();
      const g = new THREE.OctahedronGeometry(0.2, 0);
      const m = new THREE.Mesh(g, sharedMat);
      m.scale.set(1, 1.5, 1);
      m.position.y = 0.32;
      cluster.add(m);
      return cluster;
    }
  }
}

/**
 * Shadow strategy: trees and bushes cast (silhouette matters at dock scale); fiber tufts,
 * stone piles, and ore chunks skip shadow casting (small ground props where the depth
 * pass cost outweighs the visual gain).
 */
function shouldCastShadow(shape: KindConfig['shape']): boolean {
  return shape === 'apple_tree' || shape === 'berry_bush';
}

function durationFor(arch: AnimArchetype): number {
  switch (arch) {
    case 'tree_fall': return TREE_FALL_TOTAL_SEC;
    case 'stone_crumble': return STONE_CRUMBLE_SEC;
    case 'bush_collapse': return BUSH_COLLAPSE_SEC;
    case 'fiber_wisp': return FIBER_WISP_SEC;
    case 'crystal_flash': return CRYSTAL_FLASH_SEC;
    case 'tree_grow': return TREE_GROW_SEC;
    case 'bush_grow': return BUSH_GROW_SEC;
    case 'stone_form': return STONE_FORM_SEC;
    case 'fiber_grow': return FIBER_GROW_SEC;
    case 'crystal_emerge': return CRYSTAL_EMERGE_SEC;
  }
}

/** Symmetric mapping: each break archetype has a paired growth archetype. */
function growForBreak(arch: BreakAnim): GrowAnim {
  switch (arch) {
    case 'tree_fall': return 'tree_grow';
    case 'bush_collapse': return 'bush_grow';
    case 'stone_crumble': return 'stone_form';
    case 'fiber_wisp': return 'fiber_grow';
    case 'crystal_flash': return 'crystal_emerge';
  }
}

function minScaleFor(arch: GrowAnim): number {
  switch (arch) {
    case 'tree_grow': return TREE_GROW_MIN_SCALE;
    case 'bush_grow': return BUSH_GROW_MIN_SCALE;
    case 'stone_form': return STONE_FORM_MIN_SCALE;
    case 'fiber_grow': return FIBER_GROW_MIN_SCALE;
    case 'crystal_emerge': return CRYSTAL_EMERGE_MIN_SCALE;
  }
}

function isGrowArchetype(arch: AnimArchetype): boolean {
  return arch === 'tree_grow' || arch === 'bush_grow'
      || arch === 'stone_form' || arch === 'fiber_grow'
      || arch === 'crystal_emerge';
}

/** Smooth ease-out: starts fast, eases to a gentle approach at full size. */
function easeOutCubic(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

/**
 * Compose the per-frame matrix for a node currently animating. After the animation's
 * duration, returns the HIDDEN_MATRIX equivalent (zero scale) — the instance disappears
 * cleanly until respawn restores `xform.baseMatrix`.
 *
 * All scratch objects passed in are reused across calls — no per-frame allocations.
 */
function computeAnimatedMatrix(
  anim: ActiveAnimation,
  xform: InstanceTransform,
  done: boolean,
  outMat: THREE.Matrix4,
  outQuat: THREE.Quaternion,
  outPos: THREE.Vector3,
  outScale: THREE.Vector3,
  scratchAxis: THREE.Vector3,
  scratchFallQuat: THREE.Quaternion,
  scratchYQuat: THREE.Quaternion,
  yUp: THREE.Vector3,
): THREE.Matrix4 {
  /* Suppress unused-param linter — kept for API symmetry with the dock-forest
   * computeAnimatedMatrix and to make extending with new archetypes cheap. */
  void outQuat;
  if (done) {
    return HIDDEN_MATRIX;
  }
  /* Decompose the base matrix to get position / Y rotation / scale. */
  xform.baseMatrix.decompose(outPos, outQuat, outScale);
  const t = anim.t / anim.duration; /* 0..1 */

  switch (anim.archetype) {
    case 'tree_fall': {
      /* Rotation phase: 0..(TREE_FALL_ROT_SEC/duration) — the trunk pivots toward the
       * fall direction. Eased by sin² so the start is gentle (gravity ramp). */
      const rotPhase = TREE_FALL_ROT_SEC / anim.duration;
      let scaleFactor: number;
      let fallAngle: number;
      if (t <= rotPhase) {
        const tt = t / rotPhase;
        const eased = Math.sin(tt * Math.PI * 0.5);
        const easedSq = eased * eased;
        fallAngle = easedSq * (Math.PI * 0.48); /* up to ~86° forward — not full 90 to keep root visible */
        scaleFactor = 1.0;
      } else {
        const tt = (t - rotPhase) / (1 - rotPhase);
        fallAngle = Math.PI * 0.48;
        scaleFactor = Math.max(0, 1 - tt);
      }
      /* Build rotation quaternion: rotate around horizontal axis perpendicular to fall
       * direction. Axis = (fallAxisZ, 0, -fallAxisX) → cross of yUp with (fallAxisX, 0, fallAxisZ). */
      scratchAxis.set(xform.fallAxisZ, 0, -xform.fallAxisX);
      if (scratchAxis.lengthSq() < 1e-6) scratchAxis.set(1, 0, 0);
      else scratchAxis.normalize();
      scratchFallQuat.setFromAxisAngle(scratchAxis, fallAngle);
      /* Compose: T * fallRot * baseYRot * S(scaleFactor). The trunk base sits at
       * (xform.x, terrainY, xform.z) and the fall pivots around that point because the
       * geometry's local origin is at the trunk base. */
      scratchYQuat.setFromAxisAngle(yUp, xform.rotY);
      scratchFallQuat.multiply(scratchYQuat);
      const s = xform.scaleBase * scaleFactor;
      outMat.compose(outPos, scratchFallQuat, outScale.set(s, s, s));
      return outMat;
    }
    case 'stone_crumble': {
      /* Quick scale-collapse with subtle wobble. */
      const scaleFactor = Math.max(0, 1 - t);
      const wobble = Math.sin(t * Math.PI * 6) * 0.08 * (1 - t);
      scratchAxis.set(1, 0, 0);
      scratchFallQuat.setFromAxisAngle(scratchAxis, wobble);
      scratchYQuat.setFromAxisAngle(yUp, xform.rotY);
      scratchFallQuat.multiply(scratchYQuat);
      const s = xform.scaleBase * scaleFactor;
      outMat.compose(outPos, scratchFallQuat, outScale.set(s, s, s));
      return outMat;
    }
    case 'bush_collapse': {
      /* Flatten + shrink.
       *
       * === 2026-04-22 degenerate-matrix fix ===
       * Original used `sh = max(0, 1 - t)` and `sv = max(0, 1 - t * 1.4)`,
       * which made the vertical scale hit 0 at t = 0.714 while horizontal
       * still had ~28 % to shrink. For that final 28 % the scale was
       * `(sh, 0, sh)` — a singular matrix with a zero column → undefined
       * normals + degenerate shadow caster → moiré / artifacts in the
       * shadow pass that read as a SCREEN-WIDE FLASH. Player report
       * 2026-04-22 ("the whole screen flashes when I harvest berries /
       * vines / heather in awakened mode"; awakened-only because magic
       * projectiles are the only way to break bushes).
       *
       * New formula: `sv = sf²` so vertical shrinks FASTER than horizontal
       * (preserving the "flatten faster than shrink" feel) but reaches 0
       * at the SAME frame as horizontal — never produces a degenerate
       * matrix at any point during the animation. At t = 0.5: sh = 0.5,
       * sv = 0.25 (already half-flat — the flatten effect still reads
       * clearly). At t = 1.0: both = 0 (instance hidden). */
      const sf = Math.max(0, 1 - t);
      const sh = sf;
      const sv = sf * sf;
      scratchYQuat.setFromAxisAngle(yUp, xform.rotY);
      outMat.compose(outPos, scratchYQuat, outScale.set(xform.scaleBase * sh, xform.scaleBase * sv, xform.scaleBase * sh));
      return outMat;
    }
    case 'fiber_wisp': {
      /* Quick fade + tiny rise. */
      const sf = Math.max(0, 1 - t);
      outPos.y += t * 0.15;
      scratchYQuat.setFromAxisAngle(yUp, xform.rotY);
      outMat.compose(outPos, scratchYQuat, outScale.set(xform.scaleBase * sf, xform.scaleBase * sf, xform.scaleBase * sf));
      return outMat;
    }
    case 'crystal_flash':
    case 'crystal_emerge': {
      /* Magic crystals have no InstancedMesh — animation runs on the external Group
       * directly in the update() loop. This branch is only reached if a future
       * crystal kind grows its own meshes. */
      return xform.baseMatrix;
    }
    /* ---- Growth archetypes — symmetric to break, scale lerps min -> 1.0 ---- */
    case 'tree_grow': {
      const grow = TREE_GROW_MIN_SCALE
        + (1 - TREE_GROW_MIN_SCALE) * easeOutCubic(t);
      scratchYQuat.setFromAxisAngle(yUp, xform.rotY);
      const s = xform.scaleBase * grow;
      outMat.compose(outPos, scratchYQuat, outScale.set(s, s, s));
      return outMat;
    }
    case 'bush_grow': {
      const grow = BUSH_GROW_MIN_SCALE
        + (1 - BUSH_GROW_MIN_SCALE) * easeOutCubic(t);
      scratchYQuat.setFromAxisAngle(yUp, xform.rotY);
      const s = xform.scaleBase * grow;
      outMat.compose(outPos, scratchYQuat, outScale.set(s, s, s));
      return outMat;
    }
    case 'stone_form': {
      const grow = STONE_FORM_MIN_SCALE
        + (1 - STONE_FORM_MIN_SCALE) * easeOutCubic(t);
      /* Tiny settling wobble in the first half so the stone reads as "still
       * settling" rather than just inflating. Damps out by mid-animation. */
      const settle = (t < 0.5)
        ? Math.sin(t * Math.PI * 4) * 0.04 * (1 - t * 2)
        : 0;
      scratchAxis.set(1, 0, 0);
      scratchFallQuat.setFromAxisAngle(scratchAxis, settle);
      scratchYQuat.setFromAxisAngle(yUp, xform.rotY);
      scratchFallQuat.multiply(scratchYQuat);
      const s = xform.scaleBase * grow;
      outMat.compose(outPos, scratchFallQuat, outScale.set(s, s, s));
      return outMat;
    }
    case 'fiber_grow': {
      const grow = FIBER_GROW_MIN_SCALE
        + (1 - FIBER_GROW_MIN_SCALE) * easeOutCubic(t);
      scratchYQuat.setFromAxisAngle(yUp, xform.rotY);
      const s = xform.scaleBase * grow;
      outMat.compose(outPos, scratchYQuat, outScale.set(s, s, s));
      return outMat;
    }
  }
}

/* ---- mulberry32 inlined (see scatter-side modules for the rationale) ---- */
function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
