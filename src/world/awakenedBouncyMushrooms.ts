/**
 * Awakened-mode bouncy drip-mushroom field.
 *
 * Spawns 18 drip-mushrooms across the awakened map, registers each one's
 * collision footprint so the player can land on top of the cap (Y-aware just
 * like trees + foundations + crystal clusters), and runs a per-mushroom damped-
 * spring squash + Mario-rules trampoline bounce loop.
 *
 * **Lifecycle (matches all other awakened-mode handles):**
 *   - `attachAwakenedBouncyMushrooms` is called from `mountApp.ts` on first
 *     awakened-mode entry. The handle holds a single `THREE.Group` parented to
 *     the scene + a per-mushroom render entry + a runtime state map.
 *   - `update(dtSec, playerPos)` runs every awakened frame from `mountApp.ts`'s
 *     per-frame loop. Drives the spring squash for every mature mushroom +
 *     ticks the respawn timer for broken ones + animates the sapling-grow
 *     scale ramp for growing ones.
 *   - `onPlayerLanded(ownerId, impactSpeed, jumpHeld)` is called from
 *     `freeRoamControls.ts`'s landing branch when the surface the player just
 *     landed on belongs to a mushroom (owner-id prefix `mushroom:`). Returns
 *     `{ bounceVy }` so the controls inject the upward kick directly into
 *     the avatar's velocity instead of going to the standard `landed = true`
 *     branch. Holding Space at landing returns the boosted bounce velocity
 *     (matches Mario-rules trampoline mushroom convention).
 *   - `applyMagicHit(ownerId, dmg)` is called from `mountApp.ts`'s
 *     `magicProjectiles.onStaticHit` branch when a bolt hits a mushroom
 *     (owner-id prefix match). Decrements HP; on reaching 0 transitions the
 *     mushroom to the broken state which triggers the universal sapling-grow
 *     respawn cycle (Phase 8c).
 *   - `dispose()` removes the root group from the scene + unregisters every
 *     footprint + clears state. Called on realm flip back to deck.
 *
 * **Why the bounce intercept lives here, not in `freeRoamControls`:**
 *   The squash + chain-bonus + boosted-bounce + HP gating logic is mushroom-
 *   specific and would balloon `freeRoamControls.update` into a god function.
 *   Keeping it behind a single `onPlayerLanded` call lets `freeRoamControls`
 *   stay agnostic — it just asks "is this a mushroom?" and routes the launch
 *   velocity. Same pattern as `magicProjectiles.onStaticHit` routing static
 *   hits to per-system damage handlers in `mountApp`.
 *
 * **Engineering invariants respected (cross-referenced from `LEARNINGS.md`):**
 *   - No `THREE.PointLight` per mushroom — cap glow is `emissive × bloom`.
 *   - Per-color shared materials (cached in `bouncyMushroomLPCA.ts`) so 18
 *     mushrooms ship 8 shader programs, not 90+.
 *   - Footprint uses the existing `bottomY` / `topY` Y-band semantics —
 *     player can walk under tiny mushrooms via auto-step-up + jump cleanly
 *     OVER any mushroom whose top is below the apex (~6 m).
 *   - Broken / growing mushrooms have NO collision footprint registered
 *     (sapling-grow phase 8c invariant: saplings don't block movement).
 *   - Bounce state is RUNTIME ONLY — never persisted. Reload page → all
 *     mushrooms back to mature (deterministic from seed).
 *   - `update` is cheap when no mushrooms are bouncing or respawning (the
 *     spring update for `squash === 0 && squashVel === 0` is a no-op early
 *     return; respawn timer ticks are integer adds).
 *
 * **Locked decisions** (see `docs/TRIPPY_TERRAIN_AND_BOUNCE_MUSHROOMS_PLAN.md` §4):
 *   - Population: **18** (sparse — landmark, not noise).
 *   - Bounce input: auto on landing; hold Space at landing for boosted.
 *   - Bounce ceilings: base 11.5 m/s, boosted 16.0 m/s, chain bonus +1.0/bounce
 *     within 0.6 s up to +3.0 cap.
 *   - HP: 5 (5 magic bolts at standard `MAGIC_BUILD_DAMAGE = 1`).
 *   - Respawn: 180 s wait + 25 s sapling-grow (matches Phase 8c bush_grow).
 */
import * as THREE from 'three';
import {
  buildBouncyMushroom,
  MUSHROOM_COLOR_COUNT,
  type BouncyMushroomBuildResult,
} from '../visual/bouncyMushroomLPCA';
import type { CollisionWorldHandle } from './collisionWorld';
import type { ResolvedCreek } from './idleCraftHeightfield';
import { minDistToCreekNetwork } from './idleCraftHeightfield';

/* ============================================================================
 * Locked tuning constants (see plan §4)
 * ============================================================================ */

/** Total mushrooms in the field. Locked: sparse density per plan §4.2. */
const MUSHROOM_COUNT = 18;
/** Deterministic seed — identical placement across page reloads + clients. */
const DEFAULT_SEED = 42;
/** HP per mushroom. 5 magic bolts at `MAGIC_BUILD_DAMAGE = 1` to destroy. */
const MUSHROOM_HP_MAX = 5;
/** Wait before sapling regrows (s). Matches Phase 8c `REGROW_WAIT_SEC`. */
const RESPAWN_WAIT_SEC = 180;
/** Sapling-grow duration (s). Matches Phase 8c `bush_grow` cycle (30 s) but a touch faster. */
const REGROW_DURATION_SEC = 25;
/** Minimum scale during sapling grow — small enough to read as "seedling". */
const SAPLING_START_SCALE = 0.10;

/** Default bounce launch velocity (m/s). Hop apex ≈ 3.0 m above cap top. */
const BOUNCE_VY = 11.5;
/** Hold Space at landing → boosted bounce. Hop apex ≈ 5.8 m. */
const BOUNCE_BOOSTED_VY = 16.0;
/** Chain bonus per consecutive bounce within `CHAIN_WINDOW_SEC`. */
const CHAIN_BONUS_PER_HOP = 1.0;
/** Hard cap on chain bonus (caps the multi-bounce skill expression). */
const CHAIN_BONUS_MAX = 3.0;
/** Time window after a bounce within which the next bounce counts as a "chain". */
const CHAIN_WINDOW_SEC = 0.6;
/** Minimum bounce velocity even on a near-zero impact (player walked off something tiny). */
const BOUNCE_MIN_VY = 7.0;

/* ----- Damped-spring squash tuning (cap pivot scale) -----
 * Hooke + linear damping integration, frame-rate independent.
 * `K` controls oscillation period; `C` controls how fast the wobble dies.
 * `K = 64, C = 7.5` → ~0.8 s settle time, lightly underdamped (overshoots once).
 * Matches the "drip-mushroom jello" target visual. */
const SPRING_K = 64;
const SPRING_C = 7.5;
/** Initial squash velocity injected on bounce, scaled by impact speed. */
const SQUASH_VEL_BASE = 6;
const SQUASH_VEL_PER_IMPACT = 0.3;
/** Maximum squash compression (cap.scale.y reduction). */
const SQUASH_MAX_COMPRESS = 0.45;

/* ============================================================================
 * Under-mushroom bioluminescent fungi (2026-04-22 — revised)
 * ----------------------------------------------------------------------------
 * Per the player's request, every bouncy mushroom gets a glowing fungi
 * cluster underneath that matches the dream-mode-spawn ground-patch style:
 * mycelium thread cylinders radiating outward + emissive node spheres
 * scattered through the patch. NO cap-shaped meshes (those were the
 * deleted bracket pattern; player explicitly wanted them gone everywhere).
 *
 * Parented to the mushroom's `build.group` so visibility tracks the
 * mushroom — break animation hides the mushroom + its fungi together;
 * sapling-grow respawn brings them both back. No extra state to manage.
 *
 * **Glow boost**: emissiveIntensity bumped vs the original ground-patch
 * version (1.55 vs 1.15) so under-mushroom fungi read as DENSER and
 * BRIGHTER than the average ground patch — matches the player's
 * "glows better, that's what I want" reading of the spawn-front overlap
 * cluster. Plus a small `THREE.PointLight` per mushroom for an ambient
 * halo. Total cost in awakened mode: 18 mushroom lights, all 2-meter
 * decay so they don't accumulate into a flood-lit scene.
 *
 * **Material caching**: shared across ALL mushrooms via module-scope
 * cache. 1 thread material + 1 node material → keeps shader compile cost
 * negligible regardless of mushroom count.
 * ============================================================================ */

let _myceliumThreadMat: THREE.MeshStandardMaterial | null = null;
let _myceliumNodeMat: THREE.MeshStandardMaterial | null = null;
function getMyceliumThreadMat(): THREE.MeshStandardMaterial {
  if (!_myceliumThreadMat) {
    _myceliumThreadMat = new THREE.MeshStandardMaterial({
      color: 0x3a3548,
      metalness: 0.02,
      roughness: 0.88,
    });
  }
  return _myceliumThreadMat;
}
function getMyceliumNodeMat(): THREE.MeshStandardMaterial {
  if (!_myceliumNodeMat) {
    _myceliumNodeMat = new THREE.MeshStandardMaterial({
      color: 0x66ffaa,
      metalness: 0.06,
      roughness: 0.42,
      emissive: new THREE.Color(0x88ffcc),
      /* Brighter than ground-patch nodes (1.15) so under-mushroom clusters
       * pop more — matches the player's "glows better" target. */
      emissiveIntensity: 1.55,
    });
  }
  return _myceliumNodeMat;
}

/** Build a mycelium fungi patch INTO the given group (matches the
 * `buildMyceliumGroundPatchInto` pattern from `idleCraftNightMagicLPCA.ts`).
 *
 *   - 9-16 horizontal thread cylinders radiating outward from origin
 *   - 5-10 emissive node spheres scattered randomly in the patch
 *
 * All non-shadow. Layout is local to the group (origin = patch center). */
function buildMyceliumPatchInto(
  g: THREE.Group,
  rng: () => number,
  radius: number,
): void {
  const threadMat = getMyceliumThreadMat();
  const nodeMat = getMyceliumNodeMat();
  const nThreads = 9 + Math.floor(rng() * 7);
  for (let i = 0; i < nThreads; i++) {
    const ang = (i / nThreads) * Math.PI * 2 + rng() * 0.4;
    const len = radius * (0.35 + rng() * 0.55);
    const tube = new THREE.Mesh(
      new THREE.CylinderGeometry(0.003 * radius, 0.002 * radius, len, 5),
      threadMat,
    );
    /* Lay flat (cylinder default Y axis → rotate to X axis along the
     * radial direction `ang`). */
    tube.rotation.z = Math.PI / 2;
    tube.rotation.y = ang;
    tube.position.set(Math.cos(ang) * len * 0.35, 0.002, Math.sin(ang) * len * 0.35);
    tube.castShadow = false;
    g.add(tube);
  }
  const nNodes = 5 + Math.floor(rng() * 5);
  for (let j = 0; j < nNodes; j++) {
    const rr = radius * (0.15 + rng() * 0.75);
    const th = rng() * Math.PI * 2;
    const node = new THREE.Mesh(
      new THREE.SphereGeometry(0.012 * radius + rng() * 0.012, 6, 5),
      nodeMat,
    );
    node.position.set(Math.cos(th) * rr, 0.008 + rng() * 0.012, Math.sin(th) * rr);
    node.scale.setScalar(0.85 + rng() * 0.45);
    node.castShadow = false;
    g.add(node);
  }
}

/** Tiny seeded RNG for the per-mushroom fungi cluster. Identical algorithm
 * to `mulberry32` used elsewhere (e.g. `freeRoamHarvestNodes`). MUST be
 * INDEPENDENT from the placement-loop's shared `rng` — see comment block
 * on `attachFungiClusterToMushroom` below for the determinism rationale. */
function fungiRng(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build a fungi cluster + small ambient PointLight at the base of a
 * mushroom. Parented to the mushroom group so visibility + transforms
 * follow naturally.
 *
 * === 2026-04-22 critical determinism fix ===
 *
 * Earlier version took the placement-loop's shared `rng` as a parameter
 * and called it 9-17 times per mushroom (1 for satellite count + 4 per
 * satellite). That advanced the SHARED RNG, which the placement loop
 * uses for the NEXT mushroom's collision retries + per-mushroom seed
 * cascade (sm, capShape, stemThickness, dripAmount, colorIndex, rotY).
 * Result: every mushroom AFTER #0 had a different position, scale, cap
 * shape, stem thickness, and color — exactly the player report
 * "stems don't match caps + mushrooms keep showing up in different
 * locations."
 *
 * Fix: take a per-mushroom `seed` instead of `rng`. Build a fresh,
 * INDEPENDENT seeded RNG inside (`fungiRng`) so the placement loop's
 * shared RNG sequence is never disturbed. Mushroom layout is now
 * identical to the pre-fungi-cluster layout. */
function attachFungiClusterToMushroom(
  mushroomGroup: THREE.Group,
  seed: number,
  capRestRadius: number,
): void {
  const rng = fungiRng(seed);
  /* === Central wreath at the mushroom base ===
   * Patch radius scales with the mushroom's cap radius — bigger mushrooms
   * get bigger central wreaths. Always at least 0.55 m so even tiny
   * mushrooms have a visible glow patch. */
  const centralRadius = Math.max(0.55, capRestRadius * 1.1) * (0.95 + rng() * 0.2);
  const centralGroup = new THREE.Group();
  centralGroup.name = 'mushroom-fungi-central';
  buildMyceliumPatchInto(centralGroup, rng, centralRadius);
  mushroomGroup.add(centralGroup);

  /* === 2026-04-22 satellite extensions ===
   * Player request: "extending more from mushrooms" — the fungi field
   * shouldn't stop at the cap edge; it should spread outward. Adds 2-4
   * smaller satellite patches in random directions around the mushroom,
   * 1-2.5 m out from the center. Each is a smaller mycelium patch
   * (radius 0.32-0.55 m) that creates the read of "the colony is
   * actively spreading from this mushroom into the surrounding soil."
   *
   * All satellites are still parented to `mushroomGroup` so they
   * disappear with the mushroom on destroy + reappear on respawn. */
  const satelliteCount = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < satelliteCount; i++) {
    const ang = rng() * Math.PI * 2;
    const dist = (1.0 + rng() * 1.5) * Math.max(1.0, capRestRadius);
    const satRadius = 0.32 + rng() * 0.23;
    const satGroup = new THREE.Group();
    satGroup.name = 'mushroom-fungi-satellite';
    buildMyceliumPatchInto(satGroup, rng, satRadius);
    satGroup.position.set(Math.cos(ang) * dist, 0, Math.sin(ang) * dist);
    satGroup.rotation.y = rng() * Math.PI * 2;
    mushroomGroup.add(satGroup);
  }

  /* === Per-mushroom ambient light ===
   * Cyan-green PointLight to give each mushroom's fungi cluster a soft
   * glow halo that lights the surrounding terrain. Distance bumped to
   * 2.4-3.4 m (was 1.8-2.6) so the halo extends out to cover the
   * satellite patches, not just the central wreath. */
  const haloLight = new THREE.PointLight(0x88ffcc, 0.34 + rng() * 0.18, 0, 2);
  haloLight.decay = 2;
  haloLight.distance = 2.4 + rng() * 1.0;
  haloLight.position.set(0, 0.2, 0);
  haloLight.castShadow = false;
  haloLight.userData.role = 'mushroom-fungi-halo';
  mushroomGroup.add(haloLight);
}
/** Width bulge when squashed (cap.scale.x = cap.scale.z). */
const SQUASH_MAX_BULGE = 0.22;

/* ----- Spawn placement gates ----- */
/** Map-edge margin so caps don't clip the skirt. */
const SPAWN_EDGE_MARGIN = 2.0;
/** Reject if too close to the dock home XZ. */
const SPAWN_DOCK_EXCLUSION = 4.0;
/** Reject if too close to a creek polyline (mushrooms don't grow in water). */
const SPAWN_CREEK_EXCLUSION = 2.0;
/** Reject if too close to another already-placed mushroom (no clumping). */
const SPAWN_MIN_SEPARATION = 1.5;
/** Max rejection-sample retries per mushroom before giving up. */
const SPAWN_MAX_RETRIES = 64;

/* ============================================================================
 * Public types
 * ============================================================================ */

export interface AttachAwakenedBouncyMushroomsOpts {
  scene: THREE.Scene;
  /** Heightfield sampler — same one the dock + free-roam controls use. */
  getTerrainHeight: (x: number, z: number) => number;
  /** Awakened map radius (terrain.radius). */
  mapRadius: number;
  /** Resolved creek polylines so spawn rejects mushrooms on water. */
  creeks: ResolvedCreek[];
  /** Dock home XZ — keep mushrooms away from the player's spawn point. */
  dockXZ: { x: number; z: number };
  /** Optional collision world; mushrooms register / unregister footprints here. */
  collisionWorld?: CollisionWorldHandle | null;
  /** Optional seed override (defaults to {@link DEFAULT_SEED}). */
  seed?: number;
}

export interface AwakenedBouncyMushroomsHandle {
  readonly group: THREE.Group;
  /** Per-frame: spring update for mature, respawn-timer tick for broken, scale ramp for growing. */
  update(dtSec: number): void;
  /**
   * Player just touched down on the mushroom whose footprint owner-id matches.
   * Returns the bounce velocity to inject into the player's `vy`, OR null if
   * the mushroom isn't ready to bounce (sapling/broken). Caller (`freeRoamControls`)
   * is responsible for keeping `isAirborne = true` + restoring double-jump
   * on the bounce.
   */
  onPlayerLanded(
    ownerId: string,
    impactSpeed: number,
    jumpHeld: boolean,
  ): { bounceVy: number } | null;
  /**
   * Magic bolt struck a mushroom; decrement HP. On reaching 0 the mushroom
   * transitions to broken (collision unregistered, group hidden, respawn
   * timer started). Returns `{ destroyed: boolean, hp: number }` for caller
   * floater feedback, or null if the owner-id doesn't match any live mushroom.
   */
  applyMagicHit(ownerId: string, damage: number): { destroyed: boolean; hp: number } | null;
  /** Pre-compile all mushroom shader variants at boot (8 cap + 8 stem + 8 drip). */
  warmShaders(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void;
  /**
   * Reset all mushrooms back to mature state — full HP, no squash, no chain
   * count, visible group, footprint re-registered. Called from `mountApp.ts`
   * on player permadeath / realm flip back to deck so the player respawns
   * into a fresh-feeling field of mushrooms (bounces refilled, destroyed
   * mushrooms restored). This is the equivalent of `awakenedMobs.clearAll`
   * for the static mushroom field — handle stays attached, only state resets.
   *
   * Idempotent. Cheap when nothing is non-mature (most of the time).
   */
  clearAll(): void;
  /** Detach + unregister all footprints + drop scene root. */
  dispose(): void;
}

/* ============================================================================
 * Implementation
 * ============================================================================ */

interface MushroomEntry {
  id: string;             // primary owner-id, e.g. 'mushroom:0' (used by `byOwnerId`
                          //  for legacy callers; not a registered footprint id)
  /** Stem footprint owner-id, e.g. `mushroom:0:stem`. Registered. */
  stemId: string;
  /** Cap landing footprint owner-id, e.g. `mushroom:0:cap`. Registered. */
  capId: string;
  index: number;          // 0..MUSHROOM_COUNT-1
  build: BouncyMushroomBuildResult;
  baseX: number;
  baseY: number;          // terrain height at XZ at spawn time
  baseZ: number;
  scale: number;
  rotY: number;
  /** Cap top Y at rest scale (world coords). Drives cap-disk `topY`. */
  capTopWorldY: number;
  /** Cap dome bottom Y (world). Drives cap-disk `bottomY` + stem `topY`. */
  capDomeBottomWorldY: number;
  /** Cap landing-disk radius (world units, ~1.05× visual cap). */
  capRadiusWorld: number;
  /** Stem cylinder radius (world units, ~0.45× visual cap, min 0.18m). */
  stemRadiusWorld: number;

  /* Runtime bounce state. */
  squash: number;         // 0 = rest, 1 = max compressed
  squashVel: number;      // damped-spring velocity
  lastBounceAtSec: number;
  chainCount: number;

  /* HP + respawn state. */
  hp: number;
  state: 'mature' | 'broken' | 'growing';
  respawnTimer: number;   // s remaining in 'broken' state
  growT: number;          // 0..REGROW_DURATION_SEC in 'growing' state
}

/**
 * Register the dual stem + cap footprints for a mushroom on the collision
 * world. See the dual-footprint comment in the spawn loop for rationale.
 * Idempotent — `register` overwrites by ownerId so callers may re-invoke
 * after a respawn / regrow without leaking stale footprints.
 */
function registerMushroomFootprints(
  cw: NonNullable<AttachAwakenedBouncyMushroomsOpts['collisionWorld']>,
  e: MushroomEntry,
): void {
  cw.register({
    kind: 'circle',
    x: e.baseX,
    z: e.baseZ,
    r: e.stemRadiusWorld,
    ownerId: e.stemId,
    blocking: true,
    tag: 'static',
    bottomY: e.baseY,
    topY: e.capDomeBottomWorldY,
  });
  cw.register({
    kind: 'circle',
    x: e.baseX,
    z: e.baseZ,
    r: e.capRadiusWorld,
    ownerId: e.capId,
    blocking: true,
    tag: 'static',
    bottomY: e.capDomeBottomWorldY,
    topY: e.capTopWorldY,
  });
}

function unregisterMushroomFootprints(
  cw: NonNullable<AttachAwakenedBouncyMushroomsOpts['collisionWorld']>,
  e: MushroomEntry,
): void {
  cw.unregister(e.stemId);
  cw.unregister(e.capId);
}

/** Hash → reproducible 0..1 stream. Used for placement + per-mushroom variation. */
function makeRng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Smooth ease-out quad — sapling grow scale ramp. */
function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

export function attachAwakenedBouncyMushrooms(
  opts: AttachAwakenedBouncyMushroomsOpts,
): AwakenedBouncyMushroomsHandle {
  const root = new THREE.Group();
  root.name = 'AwakenedBouncyMushroomsRoot';
  opts.scene.add(root);

  const seed = opts.seed ?? DEFAULT_SEED;
  const rng = makeRng(seed);

  /** Owner-id → entry. Stable across the lifetime of the handle. */
  const entries: MushroomEntry[] = [];
  const byOwnerId = new Map<string, MushroomEntry>();

  /* ---- Phase 3a: rejection-sample 18 placements ---- */
  const maxRadius = opts.mapRadius - SPAWN_EDGE_MARGIN;
  let elapsedSec = 0; /* internal monotonic clock for chain-window timing */

  for (let i = 0; i < MUSHROOM_COUNT; i++) {
    let placed = false;
    let x = 0;
    let z = 0;
    for (let retry = 0; retry < SPAWN_MAX_RETRIES; retry++) {
      /* Uniform disk sample (sqrt for area-uniform distribution). */
      const r = Math.sqrt(rng()) * maxRadius;
      const theta = rng() * Math.PI * 2;
      const cx = Math.cos(theta) * r;
      const cz = Math.sin(theta) * r;

      /* Reject on dock proximity. */
      const dDock = Math.hypot(cx - opts.dockXZ.x, cz - opts.dockXZ.z);
      if (dDock < SPAWN_DOCK_EXCLUSION) continue;

      /* Reject on creek proximity. */
      if (opts.creeks.length > 0) {
        const dCreek = minDistToCreekNetwork(cx, cz, opts.creeks);
        if (dCreek < SPAWN_CREEK_EXCLUSION) continue;
      }

      /* Reject on mushroom-mushroom proximity (no clumping). */
      let tooClose = false;
      for (const e of entries) {
        if (Math.hypot(cx - e.baseX, cz - e.baseZ) < SPAWN_MIN_SEPARATION) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      x = cx;
      z = cz;
      placed = true;
      break;
    }
    if (!placed) {
      /* Couldn't fit after 64 retries — likely a dense map. Skip this slot
       * silently rather than hanging the loop. Population stays under 18 in
       * that case; not a correctness concern. */
      continue;
    }

    const baseY = opts.getTerrainHeight(x, z);

    /* Per-mushroom seed-derived variation. Same hash cascade as harvest scatter
     * so the mushroom field is reproducible even across browser restarts. */
    const sm = 0.6 + rng() * 1.8; /* scale ∈ [0.6, 2.4] */
    const capShape = rng();
    const stemThickness = 0.3 + rng() * 0.6;
    const dripAmount = 0.5 + rng() * 0.5;
    const colorIndex = Math.floor(rng() * MUSHROOM_COLOR_COUNT);
    const rotY = rng() * Math.PI * 2;

    const build = buildBouncyMushroom({
      scale: sm,
      capShape,
      stemThickness,
      dripAmount,
      colorIndex,
      seed: seed + i * 100,
    });
    build.group.position.set(x, baseY, z);
    build.group.rotation.y = rotY;
    /* === 2026-04-22 fungi cluster under every mushroom (player request) ===
     *
     * Small bioluminescent ring of threads + nodes around the stem base
     * + 2-4 satellite patches extending outward. Parented to `build.group`
     * so visibility tracks the mushroom — break animation hides the
     * mushroom AND its fungi together; sapling-grow respawn brings them
     * both back. No extra state to manage.
     *
     * IMPORTANT: pass an independent per-mushroom seed (NOT the shared
     * placement loop `rng`). See `attachFungiClusterToMushroom` doc block
     * for the determinism trap that was caught here. The +50 offset
     * decorrelates from the `seed + i * 100` we feed `buildBouncyMushroom`
     * so fungi RNG and shape RNG produce uncorrelated sequences. */
    attachFungiClusterToMushroom(build.group, seed + i * 100 + 50, build.capRestRadius);
    root.add(build.group);

    /* Cap top + radius in WORLD units (build values are at unit-mushroom scale,
     * but our `scale` arg is already baked into the geometry — see
     * buildBouncyMushroom which multiplies stemH / capR by `c.scale`. So
     * `capRestTopY` is already in the mushroom's local scale-1 frame; the
     * group has no extra parent scale. */
    const capTopWorldY = baseY + build.capRestTopY;
    const capDomeBottomWorldY = baseY + build.stemHeight;
    /* === 2026-04-20 dual-footprint fix for "fall through large mushrooms" ===
     *
     * Previously a single cylinder with `r = 0.85 × capRestRadius` was
     * registered for the full mushroom height. Side-blocking + landing both
     * shared that radius. For larger mushrooms (`sm` ~1.5–2.4) the visible
     * cap edge extended ~15% beyond the collision circle, so a player
     * stepping onto the apparent cap could be OUTSIDE the collision disk
     * → `getGroundYAndOwner` never selected the mushroom → fall through.
     *
     * Fix: register TWO footprints with distinct owner-ids:
     *   1. `mushroom:N:stem` — narrow stem cylinder (~0.45 × capR), full
     *      height baseY → cap-dome bottom. Blocks side-walking near the
     *      stem without making the silhouette feel "fat". Stem only — caps
     *      sweep through above the band.
     *   2. `mushroom:N:cap`  — wide cap landing disk (~1.05 × capR — slight
     *      overshoot so even a foot half-off still lands), thin Y band at
     *      cap-dome height (capDomeBottomWorldY → capTopWorldY). The
     *      `inYBand` check + `getGroundYAndOwner`'s "highest landable Y"
     *      semantics mean this only blocks/lands when the player is at cap
     *      level — players walking under big mushroom caps are unaffected.
     *
     * Both ids alias to the same `MushroomEntry` via `byOwnerId` so
     * `onPlayerLanded(ownerId)` + `applyMagicHit(ownerId)` resolve correctly
     * regardless of which footprint produced the hit. */
    const capRadiusWorld = build.capRestRadius * 1.05;
    const stemRadiusWorld = Math.max(0.18, build.capRestRadius * 0.45);

    const id = `mushroom:${i}`;
    const stemId = `${id}:stem`;
    const capId = `${id}:cap`;
    const entry: MushroomEntry = {
      id,
      index: i,
      build,
      baseX: x,
      baseY,
      baseZ: z,
      scale: sm,
      rotY,
      capTopWorldY,
      capRadiusWorld,
      capDomeBottomWorldY,
      stemRadiusWorld,
      stemId,
      capId,
      squash: 0,
      squashVel: 0,
      lastBounceAtSec: -Infinity,
      chainCount: 0,
      hp: MUSHROOM_HP_MAX,
      state: 'mature',
      respawnTimer: 0,
      growT: 0,
    };
    entries.push(entry);
    byOwnerId.set(id, entry);
    byOwnerId.set(stemId, entry);
    byOwnerId.set(capId, entry);

    if (opts.collisionWorld) {
      registerMushroomFootprints(opts.collisionWorld, entry);
    }
  }

  /* ---- Public methods ---- */

  function update(dtSec: number): void {
    elapsedSec += dtSec;

    for (const e of entries) {
      switch (e.state) {
        case 'mature': {
          /* Damped-spring squash integration. Cheap early-out when at rest. */
          if (e.squash !== 0 || e.squashVel !== 0) {
            const accel = -SPRING_K * e.squash - SPRING_C * e.squashVel;
            e.squashVel += accel * dtSec;
            e.squash += e.squashVel * dtSec;
            /* Snap to rest when both displacement + velocity are tiny — avoids
             * eternal sub-millimetre wobble that costs frame matrix updates. */
            if (Math.abs(e.squash) < 0.0008 && Math.abs(e.squashVel) < 0.01) {
              e.squash = 0;
              e.squashVel = 0;
            }
            const sy = 1 - SQUASH_MAX_COMPRESS * e.squash;
            const sxz = 1 + SQUASH_MAX_BULGE * e.squash;
            e.build.capPivot.scale.set(sxz, sy, sxz);
            /* Drip wobble polish — drips are children of `capPivot` so they
             * inherit the squash, but extending their LOCAL scale.y on top
             * makes them visibly elongate during the compress (the cap pulls
             * them taut) and snap back on the rebound. Reads as "the wax is
             * being squeezed out" rather than just "everything got shorter".
             * Applied to dripGroups only — per-mushroom cost is N drip groups
             * × one matrix update. Cheap. */
            const dripStretch = 1 + 0.45 * Math.max(0, e.squash);
            for (const dg of e.build.dripGroups) {
              dg.scale.y = dripStretch;
            }
          }
          break;
        }
        case 'broken': {
          e.respawnTimer -= dtSec;
          if (e.respawnTimer <= 0) {
            /* Transition to growing — pop the mushroom back into the scene at
             * sapling scale; collision stays UNREGISTERED until mature (saplings
             * are non-blocking by design — Phase 8c invariant). */
            e.state = 'growing';
            e.growT = 0;
            e.build.group.visible = true;
            e.build.group.scale.setScalar(SAPLING_START_SCALE);
          }
          break;
        }
        case 'growing': {
          e.growT += dtSec;
          const t = Math.min(1, e.growT / REGROW_DURATION_SEC);
          const s = SAPLING_START_SCALE + (1 - SAPLING_START_SCALE) * easeOutQuad(t);
          e.build.group.scale.setScalar(s);
          if (t >= 1) {
            /* Reached maturity: snap scale to 1, restore HP, re-register footprint. */
            e.state = 'mature';
            e.hp = MUSHROOM_HP_MAX;
            e.build.group.scale.setScalar(1);
            e.squash = 0;
            e.squashVel = 0;
            e.build.capPivot.scale.set(1, 1, 1);
            for (const dg of e.build.dripGroups) dg.scale.y = 1;
            if (opts.collisionWorld) {
              registerMushroomFootprints(opts.collisionWorld, e);
            }
          }
          break;
        }
      }
    }
  }

  function onPlayerLanded(
    ownerId: string,
    impactSpeed: number,
    jumpHeld: boolean,
  ): { bounceVy: number } | null {
    const e = byOwnerId.get(ownerId);
    if (!e) return null;
    /* Belt-and-suspenders gate: bounce only on mature mushrooms. The footprint
     * is unregistered for non-mature states so this branch shouldn't normally
     * fire, but guard against any race during the registration window. */
    if (e.state !== 'mature') return null;

    /* Reset squash to 0 first so the new impulse fully expresses (no "weak
     * bounce because the cap was still down" — see plan §5 Phase 4 step 6). */
    e.squash = 0;
    e.squashVel = SQUASH_VEL_BASE + impactSpeed * SQUASH_VEL_PER_IMPACT;

    /* Chain detection — was the previous bounce within the chain window? */
    const dt = elapsedSec - e.lastBounceAtSec;
    const inChain = dt < CHAIN_WINDOW_SEC;
    e.chainCount = inChain ? Math.min(3, e.chainCount + 1) : 0;
    e.lastBounceAtSec = elapsedSec;

    const baseVy = jumpHeld ? BOUNCE_BOOSTED_VY : BOUNCE_VY;
    const chainBonus = Math.min(CHAIN_BONUS_MAX, e.chainCount * CHAIN_BONUS_PER_HOP);

    /* Soft scaling for low-impact landings (player walked off something tiny
     * onto the cap edge) — full bounce only at impact ≥ 12 m/s. */
    let bounceVy = baseVy + chainBonus;
    if (impactSpeed < 12) {
      bounceVy = Math.max(BOUNCE_MIN_VY, bounceVy * (impactSpeed / 12));
    }
    return { bounceVy };
  }

  function applyMagicHit(ownerId: string, damage: number): { destroyed: boolean; hp: number } | null {
    const e = byOwnerId.get(ownerId);
    if (!e) return null;
    if (e.state !== 'mature') return null;
    e.hp = Math.max(0, e.hp - damage);
    if (e.hp > 0) {
      return { destroyed: false, hp: e.hp };
    }
    /* Destroyed → broken state. Hide group, unregister footprint, start
     * respawn timer. Group is hidden (not removed) so the next sapling-grow
     * phase can pop it back in without re-allocating geometry / materials. */
    e.state = 'broken';
    e.respawnTimer = RESPAWN_WAIT_SEC;
    e.build.group.visible = false;
    e.build.capPivot.scale.set(1, 1, 1);
    for (const dg of e.build.dripGroups) dg.scale.y = 1;
    e.squash = 0;
    e.squashVel = 0;
    if (opts.collisionWorld) {
      unregisterMushroomFootprints(opts.collisionWorld, e);
    }
    return { destroyed: true, hp: 0 };
  }

  function warmShaders(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    /* Build one mushroom of each color offscreen so the program cache covers
     * every cap + stem + drip variant. Same disposable pattern as
     * `cabinBuilder.warmShaders` and `mobsHandle.warmShaders` — meshes are
     * removed on the next rAF so the warm cost is one frame.
     *
     * Uses `renderer.compileAsync` (Three r158+) so the 24 program compiles
     * happen on the GPU's parallel-compile worker without blocking the JS
     * thread — see `awakenedMobs.warmShaders` for the full rationale. */
    const placeholders: THREE.Group[] = [];
    for (let c = 0; c < MUSHROOM_COLOR_COUNT; c++) {
      const w = buildBouncyMushroom({ colorIndex: c, scale: 1, seed: c });
      w.group.position.set(10000, -10000, 10000); /* park far off-scene */
      root.add(w.group);
      placeholders.push(w.group);
    }
    const cleanup = (): void => {
      for (const g of placeholders) {
        root.remove(g);
        g.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && m.geometry) m.geometry.dispose();
        });
      }
    };
    const r = renderer as THREE.WebGLRenderer & {
      compileAsync?: (scene: THREE.Object3D, camera: THREE.Camera) => Promise<void>;
    };
    if (typeof r.compileAsync === 'function') {
      r.compileAsync(opts.scene, camera)
        .then(() => requestAnimationFrame(cleanup))
        .catch(() => requestAnimationFrame(cleanup));
    } else {
      try {
        renderer.compile(opts.scene, camera);
      } catch {
        /* compile is best-effort during boot transitions */
      }
      requestAnimationFrame(cleanup);
    }
  }

  function clearAll(): void {
    for (const e of entries) {
      const wasNonMature = e.state !== 'mature';
      /* Snap visual + spring state back to rest. */
      e.state = 'mature';
      e.hp = MUSHROOM_HP_MAX;
      e.respawnTimer = 0;
      e.growT = 0;
      e.squash = 0;
      e.squashVel = 0;
      e.chainCount = 0;
      e.lastBounceAtSec = -Infinity;
      e.build.group.visible = true;
      e.build.group.scale.setScalar(1);
      e.build.capPivot.scale.set(1, 1, 1);
      for (const dg of e.build.dripGroups) dg.scale.y = 1;
      /* Re-register footprints if the mushroom had been destroyed / was growing
       * (footprints were unregistered at that time). Mature mushrooms still have
       * theirs; re-registering would duplicate, so guard via the `wasNonMature`
       * flag. `register` overwrites by ownerId, so even if stale footprints
       * were somehow there, this is safe. */
      if (wasNonMature && opts.collisionWorld) {
        registerMushroomFootprints(opts.collisionWorld, e);
      }
    }
    elapsedSec = 0;
  }

  function dispose(): void {
    for (const e of entries) {
      if (opts.collisionWorld && e.state === 'mature') {
        unregisterMushroomFootprints(opts.collisionWorld, e);
      }
      e.build.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.geometry) m.geometry.dispose();
      });
      root.remove(e.build.group);
    }
    entries.length = 0;
    byOwnerId.clear();
    if (root.parent) root.parent.remove(root);
  }

  return { group: root, update, onPlayerLanded, applyMagicHit, warmShaders, clearAll, dispose };
}
