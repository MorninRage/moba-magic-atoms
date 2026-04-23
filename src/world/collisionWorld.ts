/**
 * Awakened-mode 2D collision world (Phase 1.5 — see
 * `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` §10 invariants).
 *
 * Lightweight footprint registry + spatial hash. Every world entity that should block
 * movement (cabin pieces, trees, crystals, ore nodes, stations, mobs, the player)
 * registers a 2D footprint here. Per frame the player + mobs query nearby footprints,
 * resolve overlaps by pushing themselves out of the obstacle.
 *
 * **Why 2D, not 3D BVH (`three-mesh-bvh`):**
 *   - The dock map is essentially flat — terrain has gentle slope, no overhangs.
 *   - All blocking entities are vertically anchored (cabin walls / trees / mobs run
 *     from ground up). A 2D footprint captures 95% of "can I walk here?" intuition.
 *   - Zero new dependencies. Sub-millisecond per-frame cost at hundreds of footprints
 *     thanks to the spatial hash.
 *   - The Phase 4 BVH upgrade is documented in the master plan — needed for vertical
 *     pieces (roofs you can walk under, ladders) but not for the Phase 1.5 ship.
 *
 * **Footprint shapes:**
 *   - `circle` — for organic / radially-symmetric obstacles (trees, rock piles, ore
 *     chunks, crystal clusters, mobs, the player).
 *   - `rect` — for axis-aligned + rotated rectangular obstacles (cabin pieces, future
 *     stations). Rect is defined by half-width / half-depth + Y rotation.
 *
 * **Collision resolution algorithm (`resolveCircleMove`):**
 *   1. Spatial-hash query around the destination XZ (bucket size = 4 m, query the 9
 *      buckets that surround the destination so a 2 m radius footprint at the bucket
 *      edge is still found).
 *   2. For each blocking footprint that's not the moving entity itself:
 *      - Circle vs Circle: if distance < r1 + r2, push outward along the connection.
 *      - Circle vs Rect: rotate point into rect-local space, find closest point on
 *        rect, push outward from that point.
 *   3. Iterate up to 3 push passes so multi-overlap (player wedged between two trees)
 *      resolves cleanly without jitter.
 *
 * **Build-mode overlap (`overlaps`):** simpler — one shot test, no push-out, used by
 * the build-mode controller's validity gate before placing a piece.
 *
 * **Raycast XZ (`raycastXZ`):** straight 2D ray vs all footprints in the swept buckets.
 * Used by melee cone-cast + magic projectile per-step collision check. Returns first
 * hit by distance.
 */

/**
 * Vertical extent fields — when set, the resolver / overlap test / ground sampler
 * gain Y-awareness:
 *   - `bottomY` = world Y at the obstacle's base (terrain height for trees, foundation
 *     top for walls). Defaults to `-Infinity` (always extends below the player).
 *   - `topY` = world Y at the obstacle's top (canopy top for trees, top of wall, etc.).
 *     Defaults to `+Infinity` (always extends above the player).
 *
 * A footprint is treated as "in the player's Y-band" when
 * `playerBottomY < topY && playerTopY > bottomY`. Outside that band the footprint is
 * SKIPPED entirely by `resolveCircleMove` / `overlaps` so the player can:
 *   - Jump CLEAN over short obstacles (apex feet > obstacle.topY).
 *   - Walk under overhangs (head < obstacle.bottomY).
 *   - Land on top via `getGroundY` (which scans the same footprints).
 *
 * Old call sites that don't set these fields keep their original "always blocks"
 * behavior because of the ±Infinity defaults — no migration required.
 */
export type Footprint =
  | {
      kind: 'circle';
      x: number;
      z: number;
      r: number;
      ownerId: string;
      /** When false, the footprint is reported by raycasts/overlaps but does NOT block movement. */
      blocking: boolean;
      /**
       * Optional category tag — `'mob'` is set for mob footprints so `raycastXZ` with
       * `hitMobsOnly: true` can early-skip non-mob footprints. Keeps melee + projectile
       * queries cheap even at high static-obstacle counts.
       */
      tag?: 'mob' | 'static' | 'player';
      /** World-Y of the obstacle's base. Default: `-Infinity` (extends below the player). */
      bottomY?: number;
      /** World-Y of the obstacle's top. Default: `+Infinity` (extends above the player). */
      topY?: number;
    }
  | {
      kind: 'rect';
      x: number;
      z: number;
      halfW: number;
      halfD: number;
      rotY: number;
      ownerId: string;
      blocking: boolean;
      tag?: 'mob' | 'static' | 'player';
      bottomY?: number;
      topY?: number;
    };

export interface CollisionWorldHandle {
  /** Add or replace a footprint. Replaces if `ownerId` already exists. */
  register(fp: Footprint): void;
  /** Remove the footprint with this ownerId (no-op if not present). */
  unregister(ownerId: string): void;
  /**
   * Cheap per-frame position update for an EXISTING circle footprint (player + mobs
   * use this every frame). Mutates the footprint in place and only re-hashes into
   * spatial buckets when the cell membership actually changes (which happens every
   * ~CELL_SIZE world units of movement, not every frame).
   *
   * vs `register()`: avoids the per-frame remove-from-buckets + add-to-buckets
   * churn for entities that are just moving (not changing radius / Y / kind / etc).
   * Cuts steady-state CPU in awakened combat where 1 player + up to 6 mobs all
   * register every frame.
   *
   * No-op when the ownerId isn't found OR when the existing footprint is a `rect`
   * (rect re-bucketing is more involved; only circles use the fast path here).
   */
  movePosition(ownerId: string, x: number, z: number, bottomY?: number, topY?: number): void;
  /**
   * Resolve a moving entity (circle of `radius`) sliding from `(fromX, fromZ)` toward
   * `(toX, toZ)`. Returns the actual final XZ after collision push-out. The moving
   * entity's own footprint (if registered) is excluded by `ownerId` match.
   *
   * **Y-aware filter.** When `playerBottomY` / `playerTopY` are provided, candidate
   * footprints whose Y-extent doesn't overlap the player's body band are skipped — so
   * jumping over a short tree (apex feet > tree.topY) flies clean instead of pushing
   * sideways. Old callers that omit these args fall back to the original 2D-only
   * behavior (footprints default to ±Infinity Y range so they always block).
   *
   * **Sub-stepping.** Long single-frame moves (e.g. apex-of-jump XZ velocity * dt) can
   * tunnel through thin obstacles. The resolver internally splits the move into
   * sub-steps of at most `radius` so a wall is never skipped over.
   */
  resolveCircleMove(
    ownerId: string,
    fromX: number, fromZ: number,
    toX: number, toZ: number,
    radius: number,
    playerBottomY?: number,
    playerTopY?: number,
    stepUpHeight?: number,
  ): { x: number; z: number };
  /**
   * Build-mode overlap test. Returns true if the candidate `fp` overlaps any other
   * blocking footprint (excluding `ignoreOwnerId` if provided). Used to gate ghost
   * placement validity. Y-extent on `fp` is honored: pieces whose Y-range doesn't
   * overlap with `fp`'s Y-range are skipped (so a roof tile placed 2.5 m up doesn't
   * collide with a foundation tile at ground level).
   */
  overlaps(fp: Footprint, ignoreOwnerId?: string): boolean;
  /**
   * Highest blocking-footprint top Y whose XZ shape contains `(x, z)` (within the
   * player's `radius`) AND whose `topY` is at or below `currentY + GROUND_TOLERANCE`.
   * Falls back to `terrainY` when no obstacle qualifies. Used by:
   *   - Free-roam landing (replaces the old `jumpStartY` check) so the player lands
   *     on tree tops / wall tops / foundation tops naturally.
   *   - Walk-off detection (when grounded and the new ground Y is below current Y by
   *     more than the tolerance, the player transitions to airborne).
   *   - Dock foot-snap (so walking onto a foundation pops feet to the foundation top).
   */
  getGroundY(
    x: number, z: number,
    currentY: number,
    terrainY: number,
    radius: number,
    /**
     * Optional override for how far ABOVE the player's current Y a surface can
     * still count as "ground" — used by grounded foot-snap to climb floors /
     * foundations / stairs (step-up). When omitted, defaults to `GROUND_TOLERANCE`
     * (0.1 m) which is the airborne-landing slop.
     */
    snapUpHeight?: number,
  ): number;
  /**
   * Variant of {@link getGroundY} that ALSO returns the `ownerId` of the
   * footprint whose top produced the returned Y (or `null` when the result
   * collapsed to `terrainY`). Used by `freeRoamControls.ts`'s landing branch
   * to detect "did I just land on a mushroom?" and route to the bouncy-mushroom
   * launch instead of the standard `landed = true` path.
   *
   * Implementation note: `getGroundY` is now a thin wrapper that calls this
   * method and discards the owner — no behaviour change for existing callers
   * who only need the Y value.
   */
  getGroundYAndOwner(
    x: number, z: number,
    currentY: number,
    terrainY: number,
    radius: number,
    snapUpHeight?: number,
  ): { y: number; ownerId: string | null };
  /**
   * 2D raycast — origin `(ox, oz)` along normalized direction `(dx, dz)`, max length
   * `maxDist`. Returns the first footprint hit (by distance) along the ray, or null.
   * Used by melee cone cast + magic projectile per-step collision.
   */
  raycastXZ(
    ox: number, oz: number,
    dx: number, dz: number,
    maxDist: number,
    opts?: {
      hitMobsOnly?: boolean;
      ignoreOwnerId?: string;
      /** Y-aware filter (3D scene queries). When omitted, raycast is 2D-only
       * and footprints are treated as infinitely tall. See the implementation
       * for the full Y-aware spec. */
      originY?: number;
      dirY?: number;
    },
  ): { ownerId: string; dist: number } | null;
  /** Detach + clear all state. */
  dispose(): void;
}

/* ============================================================================
 * Spatial hash — bucket size CELL_SIZE m.
 * ============================================================================ */

const CELL_SIZE = 4;
/** Max push-out iterations per `resolveCircleMove` call (handles multi-overlap). */
const RESOLVE_ITERATIONS = 3;
/** Tiny epsilon to nudge entities just outside the obstacle (avoids re-overlap on next frame). */
const PUSH_EPSILON = 0.001;
/**
 * Tolerance for the Y-band overlap test. A footprint whose top is within
 * `Y_BAND_EPSILON` of the player's feet still counts as "in band" so standing exactly
 * on top of an obstacle doesn't oscillate between push and skip frame to frame.
 */
const Y_BAND_EPSILON = 0.02;
/**
 * `getGroundY` tolerance — a footprint top within this distance ABOVE the player's
 * current Y is treated as "I'm standing on it" (so a 1 cm floating-point overshoot
 * after landing doesn't drop the player back to the terrain).
 */
const GROUND_TOLERANCE = 0.1;
/**
 * Default auto step-up height (world units). Obstacles whose top is within this
 * distance ABOVE the player's feet are treated as "walkable surfaces" (skipped
 * by the horizontal push-out so the player walks ONTO them) rather than walls.
 *
 * 0.55 m covers our cabin pieces: floor (0.05), foundation (0.15), stairs (0.55),
 * and most low rocks. Standard 3D-action-game step-up sits in the 0.3 - 0.5 m
 * range (Unity CharacterController default 0.3, Unreal Char Movement 0.45,
 * Minecraft 0.6, Source engine 18 units ≈ 0.46 m). 0.55 m matches the stair top
 * exactly so a single press-W onto a stair piece climbs it cleanly.
 *
 * Pieces taller than this (walls 2.4 m, doors 1.8 m, trees 1.6 m+) still block
 * normally — the player has to jump to clear them. Caller passes their own step
 * height into `resolveCircleMove`; this constant is the recommended default.
 */
export const DEFAULT_STEP_UP_HEIGHT = 0.55;

function bucketKey(cx: number, cz: number): string {
  return `${cx}|${cz}`;
}

function bucketsForFootprint(fp: Footprint): { x: number; z: number }[] {
  /* AABB enclosing the footprint, then list every cell it intersects. */
  let minX: number, minZ: number, maxX: number, maxZ: number;
  if (fp.kind === 'circle') {
    minX = fp.x - fp.r;
    maxX = fp.x + fp.r;
    minZ = fp.z - fp.r;
    maxZ = fp.z + fp.r;
  } else {
    /* Rect rotated by `rotY` — over-approximate via the rotated-AABB diagonal so we
     * register into every cell the rect could touch. Cheap; the resolution passes
     * filter false hits. */
    const cs = Math.abs(Math.cos(fp.rotY));
    const sn = Math.abs(Math.sin(fp.rotY));
    const aabbW = fp.halfW * cs + fp.halfD * sn;
    const aabbD = fp.halfW * sn + fp.halfD * cs;
    minX = fp.x - aabbW;
    maxX = fp.x + aabbW;
    minZ = fp.z - aabbD;
    maxZ = fp.z + aabbD;
  }
  const cxMin = Math.floor(minX / CELL_SIZE);
  const cxMax = Math.floor(maxX / CELL_SIZE);
  const czMin = Math.floor(minZ / CELL_SIZE);
  const czMax = Math.floor(maxZ / CELL_SIZE);
  const out: { x: number; z: number }[] = [];
  for (let cx = cxMin; cx <= cxMax; cx++) {
    for (let cz = czMin; cz <= czMax; cz++) {
      out.push({ x: cx, z: cz });
    }
  }
  return out;
}

/* ============================================================================
 * Geometry helpers
 * ============================================================================ */

/**
 * Closest point on a (possibly rotated) rect to a world-space point. Returns the
 * world-space closest point. Used by circle-vs-rect resolution.
 */
/**
 * Conservative horizontal "radius" of a footprint from its center — circle uses `r`,
 * rect uses half-diagonal of its local box (covers corners vs center-distance tests).
 */
function footprintMaxXZExtent(fp: Footprint): number {
  if (fp.kind === 'circle') return fp.r;
  return Math.hypot(fp.halfW, fp.halfD);
}

/**
 * True when a disc at `(px, pz)` with radius `probeR` cannot overlap `fp`'s XZ shape
 * (circle or rect AABB in world space). Skips `inYBand` / `computePushFromObstacle` /
 * containment tests for distant trees and cabin pieces — large win when buckets hold
 * hundreds of static footprints.
 */
function xzDiscCannotHitFootprint(px: number, pz: number, probeR: number, fp: Footprint): boolean {
  const dx = px - fp.x;
  const dz = pz - fp.z;
  const distSq = dx * dx + dz * dz;
  const reach = probeR + footprintMaxXZExtent(fp) + 0.02;
  return distSq > reach * reach;
}

/** Closest point on ray segment `(ox,oz) + s*(dx,dz), s∈[0,maxDist]` to `fp`'s center; cull if too far for any hit. */
function xzRaySegmentCannotHitFootprint(
  ox: number, oz: number, dx: number, dz: number, maxDist: number, fp: Footprint,
): boolean {
  const fx = fp.x - ox;
  const fz = fp.z - oz;
  const t = fx * dx + fz * dz;
  const t0 = Math.max(0, Math.min(maxDist, t));
  const cx = ox + dx * t0;
  const cz = oz + dz * t0;
  const dist = Math.hypot(cx - fp.x, cz - fp.z);
  return dist > footprintMaxXZExtent(fp) + 0.02;
}

function closestPointOnRectToPoint(
  rect: { x: number; z: number; halfW: number; halfD: number; rotY: number },
  px: number, pz: number,
): { x: number; z: number } {
  /* Transform point into rect-local space (subtract center, rotate by -rotY). */
  const cosR = Math.cos(-rect.rotY);
  const sinR = Math.sin(-rect.rotY);
  const dx = px - rect.x;
  const dz = pz - rect.z;
  const localX = dx * cosR - dz * sinR;
  const localZ = dx * sinR + dz * cosR;
  /* Clamp to half-extents to find closest local-space point. */
  const clampedX = Math.max(-rect.halfW, Math.min(rect.halfW, localX));
  const clampedZ = Math.max(-rect.halfD, Math.min(rect.halfD, localZ));
  /* Transform back to world space. */
  const cosF = Math.cos(rect.rotY);
  const sinF = Math.sin(rect.rotY);
  return {
    x: rect.x + clampedX * cosF - clampedZ * sinF,
    z: rect.z + clampedX * sinF + clampedZ * cosF,
  };
}

/**
 * Returns the push vector (dx, dz, magnitude) needed to separate a circle at `(cx, cz)`
 * radius `r` from `obstacle`, or null if they don't overlap. Magnitude is how far the
 * circle has to move to escape.
 */
function computePushFromObstacle(
  cx: number, cz: number, r: number,
  obstacle: Footprint,
): { dx: number; dz: number; mag: number } | null {
  if (obstacle.kind === 'circle') {
    const dxRaw = cx - obstacle.x;
    const dzRaw = cz - obstacle.z;
    const dist = Math.hypot(dxRaw, dzRaw);
    const minDist = r + obstacle.r;
    if (dist >= minDist) return null;
    if (dist < 1e-6) {
      /* Degenerate co-incident centers — push along +X arbitrarily so the next iteration
       * finds a non-degenerate gradient. */
      return { dx: 1, dz: 0, mag: minDist + PUSH_EPSILON };
    }
    const overlap = minDist - dist + PUSH_EPSILON;
    return { dx: dxRaw / dist, dz: dzRaw / dist, mag: overlap };
  }
  /* Rect: closest-point-on-rect → if distance <= r, push outward along (circle - closest). */
  const cp = closestPointOnRectToPoint(obstacle, cx, cz);
  const dxRaw = cx - cp.x;
  const dzRaw = cz - cp.z;
  const dist = Math.hypot(dxRaw, dzRaw);
  if (dist >= r) return null;
  if (dist < 1e-6) {
    /* Center inside rect — push along the shortest exit direction (the rect's local
     * axis with the smallest distance to escape). Approximate by pushing out toward
     * the rect's center axis perpendicular. */
    return { dx: 1, dz: 0, mag: r + PUSH_EPSILON };
  }
  const overlap = r - dist + PUSH_EPSILON;
  return { dx: dxRaw / dist, dz: dzRaw / dist, mag: overlap };
}

/* ============================================================================
 * Public factory
 * ============================================================================ */

/**
 * Singleton-per-scene marker. Every caller that wants the collisionWorld
 * for a specific scene should go through `getOrCreateSceneCollisionWorld`
 * so all systems (extended preload's harvest/forest attaches, mountApp's
 * inline ensure*, the player's WASD movement check) end up using the SAME
 * collisionWorld instance. Without this, a player created via mountApp's
 * inline `createCollisionWorld()` would query a fresh empty world while
 * tree footprints sit registered in extended-preload's separate instance
 * — symptom: trees visible but no collision, player walks through them.
 */
type SceneWithCollision = import('three').Scene & {
  userData: { idleCraftCollisionWorld?: CollisionWorldHandle };
};

/**
 * Get-or-create the collisionWorld bound to a specific scene. The handle is
 * cached on `scene.userData.idleCraftCollisionWorld` so any subsequent
 * caller (in any module instance, including HMR-reloaded modules) gets the
 * SAME instance. Use this in any code path that previously called
 * `createCollisionWorld()` standalone.
 */
export function getOrCreateSceneCollisionWorld(
  scene: import('three').Scene,
): CollisionWorldHandle {
  const sceneStash = scene as SceneWithCollision;
  let cw = sceneStash.userData.idleCraftCollisionWorld;
  if (!cw) {
    cw = createCollisionWorld();
    sceneStash.userData.idleCraftCollisionWorld = cw;
  }
  return cw;
}

/** Clear the cached collisionWorld for a scene — call when the scene is being
 *  disposed so a fresh re-mount starts with a clean world. */
export function clearSceneCollisionWorld(scene: import('three').Scene): void {
  const sceneStash = scene as SceneWithCollision;
  delete sceneStash.userData.idleCraftCollisionWorld;
}

export function createCollisionWorld(): CollisionWorldHandle {
  /** Bucket map: `${cx}|${cz}` → list of footprints touching that cell. */
  const buckets = new Map<string, Footprint[]>();
  /** Reverse lookup so unregister is O(buckets-touched) instead of O(N footprints). */
  const ownerIndex = new Map<string, Footprint>();

  function addToBuckets(fp: Footprint): void {
    const cells = bucketsForFootprint(fp);
    for (const c of cells) {
      const key = bucketKey(c.x, c.z);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push(fp);
    }
  }

  function removeFromBuckets(fp: Footprint): void {
    const cells = bucketsForFootprint(fp);
    for (const c of cells) {
      const key = bucketKey(c.x, c.z);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      const idx = bucket.indexOf(fp);
      if (idx >= 0) bucket.splice(idx, 1);
      if (bucket.length === 0) buckets.delete(key);
    }
  }

  function register(fp: Footprint): void {
    const existing = ownerIndex.get(fp.ownerId);
    if (existing) removeFromBuckets(existing);
    ownerIndex.set(fp.ownerId, fp);
    addToBuckets(fp);
  }

  function unregister(ownerId: string): void {
    const fp = ownerIndex.get(ownerId);
    if (!fp) return;
    removeFromBuckets(fp);
    ownerIndex.delete(ownerId);
  }

  /**
   * Fast in-place position update for circle footprints. Mutates the existing
   * footprint and only re-buckets when the cell membership actually changes.
   * For typical per-frame movement (a few cm per frame), the entity stays in the
   * same set of cells most frames, so this is essentially free. When it does
   * cross a cell boundary, we do the remove+add. Same end-state as a full
   * register(), but ~10x cheaper in the common case.
   */
  function movePosition(
    ownerId: string,
    x: number, z: number,
    bottomY?: number, topY?: number,
  ): void {
    const fp = ownerIndex.get(ownerId);
    if (!fp || fp.kind !== 'circle') return;
    /* Compute the cell sets BEFORE and AFTER the move. If they're the same, just
     * mutate the footprint's x/z/Y in place — no spatial-hash work needed. */
    const oldMinCx = Math.floor((fp.x - fp.r) / CELL_SIZE);
    const oldMaxCx = Math.floor((fp.x + fp.r) / CELL_SIZE);
    const oldMinCz = Math.floor((fp.z - fp.r) / CELL_SIZE);
    const oldMaxCz = Math.floor((fp.z + fp.r) / CELL_SIZE);
    const newMinCx = Math.floor((x - fp.r) / CELL_SIZE);
    const newMaxCx = Math.floor((x + fp.r) / CELL_SIZE);
    const newMinCz = Math.floor((z - fp.r) / CELL_SIZE);
    const newMaxCz = Math.floor((z + fp.r) / CELL_SIZE);
    const cellsUnchanged =
      oldMinCx === newMinCx && oldMaxCx === newMaxCx &&
      oldMinCz === newMinCz && oldMaxCz === newMaxCz;
    if (cellsUnchanged) {
      /* Fast path: just mutate position fields in place. The footprint object is
       * the same reference held by the bucket lists, so no list changes needed. */
      fp.x = x;
      fp.z = z;
      if (bottomY !== undefined) fp.bottomY = bottomY;
      if (topY !== undefined) fp.topY = topY;
      return;
    }
    /* Slow path: cells changed -> remove from old buckets, mutate, add to new. */
    removeFromBuckets(fp);
    fp.x = x;
    fp.z = z;
    if (bottomY !== undefined) fp.bottomY = bottomY;
    if (topY !== undefined) fp.topY = topY;
    addToBuckets(fp);
  }

  /**
   * REUSED scratch Set for `forEachNearby` dedup. Without this, every collision query
   * (player + every mob + every projectile + every harvest proximity check, dozens
   * per frame in awakened combat) allocates a fresh `Set` and the GC pressure adds
   * up. Since the spatial-hash queries are fully synchronous, a single shared Set
   * is safe — every entry/exit through `forEachNearby` clears it before use.
   */
  const _forEachNearbyScratch = new Set<Footprint>();

  /** Walk every footprint in the cell window around (x, z) extending `radius` outward. */
  function forEachNearby(
    x: number, z: number, radius: number,
    fn: (fp: Footprint) => boolean | void,
  ): void {
    const cxMin = Math.floor((x - radius) / CELL_SIZE);
    const cxMax = Math.floor((x + radius) / CELL_SIZE);
    const czMin = Math.floor((z - radius) / CELL_SIZE);
    const czMax = Math.floor((z + radius) / CELL_SIZE);
    /* Reused dedup Set — cleared at entry, mutated as we walk. Zero allocations. */
    const seen = _forEachNearbyScratch;
    seen.clear();
    for (let cx = cxMin; cx <= cxMax; cx++) {
      for (let cz = czMin; cz <= czMax; cz++) {
        const bucket = buckets.get(bucketKey(cx, cz));
        if (!bucket) continue;
        for (const fp of bucket) {
          if (seen.has(fp)) continue;
          seen.add(fp);
          const stop = fn(fp);
          if (stop === true) return;
        }
      }
    }
  }

  /**
   * Returns true when the player's vertical band overlaps the obstacle's vertical
   * band AND the obstacle isn't shorter than the player's auto step-up height.
   * When either Y bound is unset (default ±Infinity), the test reduces to "always
   * in band" — preserves the old XZ-only behavior for legacy footprints.
   *
   * **Step-up gate (`stepUp > 0`):** any obstacle whose top is at most `stepUp`
   * world-units above the player's feet is SKIPPED here. Combined with the
   * caller's post-move snap-up to `getGroundY`, this is what lets the player
   * walk onto floors, foundations, low rocks, and stairs without bonking. Walls,
   * doors, trees, etc. (taller than `stepUp`) still block normally.
   */
  function inYBand(
    fp: Footprint,
    playerBottomY: number,
    playerTopY: number,
    stepUp: number = 0,
  ): boolean {
    const obsBottom = fp.bottomY ?? -Infinity;
    const obsTop = fp.topY ?? Infinity;
    /* Player above obstacle (apex of jump cleared the canopy)? Skip. */
    if (playerBottomY >= obsTop - Y_BAND_EPSILON) return false;
    /* Player below obstacle (head still under the overhang)? Skip. */
    if (playerTopY <= obsBottom + Y_BAND_EPSILON) return false;
    /* Walkable surface (floor / foundation / stair / low rock)? Skip the wall
     * push-out — the caller's post-move getGroundY snap puts feet on top. */
    if (stepUp > 0 && obsTop <= playerBottomY + stepUp + Y_BAND_EPSILON) return false;
    return true;
  }

  function resolveCircleMove(
    ownerId: string,
    fromX: number, fromZ: number,
    toX: number, toZ: number,
    radius: number,
    playerBottomY: number = -Infinity,
    playerTopY: number = Infinity,
    stepUpHeight: number = 0,
  ): { x: number; z: number } {
    /* Sub-step the move so a single big XZ delta (e.g. apex-of-jump * dt at low FPS)
     * can't tunnel through a thin obstacle. Step length capped at `radius` so any
     * obstacle the player can collide with is sampled at least once along the path. */
    const dx = toX - fromX;
    const dz = toZ - fromZ;
    const moveLen = Math.hypot(dx, dz);
    const maxStepLen = Math.max(radius, 0.05); /* never step less than ~5cm to avoid loops */
    const stepCount = Math.max(1, Math.ceil(moveLen / maxStepLen));

    let curX = fromX;
    let curZ = fromZ;
    for (let s = 1; s <= stepCount; s++) {
      /* Target XZ for this sub-step. */
      const t = s / stepCount;
      let stepX = fromX + dx * t;
      let stepZ = fromZ + dz * t;
      /* Push-out iterations at the sub-step destination. */
      for (let iter = 0; iter < RESOLVE_ITERATIONS; iter++) {
        let anyPush = false;
        const queryRadius = radius + 2.5; /* generous; rect AABBs may be larger */
        forEachNearby(stepX, stepZ, queryRadius, (fp) => {
          if (!fp.blocking) return;
          if (fp.ownerId === ownerId) return;
          if (xzDiscCannotHitFootprint(stepX, stepZ, radius, fp)) return;
          if (!inYBand(fp, playerBottomY, playerTopY, stepUpHeight)) return;
          const push = computePushFromObstacle(stepX, stepZ, radius, fp);
          if (!push) return;
          stepX += push.dx * push.mag;
          stepZ += push.dz * push.mag;
          anyPush = true;
        });
        if (!anyPush) break;
      }
      curX = stepX;
      curZ = stepZ;
    }
    return { x: curX, z: curZ };
  }

  function overlaps(fp: Footprint, ignoreOwnerId?: string): boolean {
    /* Use forEachNearby to get candidates, then per-pair shape test. */
    const probeRadius = fp.kind === 'circle' ? fp.r : Math.hypot(fp.halfW, fp.halfD);
    const fpBottom = fp.bottomY ?? -Infinity;
    const fpTop = fp.topY ?? Infinity;
    let hit = false;
    forEachNearby(fp.x, fp.z, probeRadius + 2.5, (other) => {
      if (!other.blocking) return;
      if (other.ownerId === ignoreOwnerId) return;
      if (other.ownerId === fp.ownerId) return;
      if (xzDiscCannotHitFootprint(fp.x, fp.z, probeRadius, other)) return;
      /* Y-band cull: if the candidate piece sits entirely above or below the new
       * piece's vertical extent there's no collision, regardless of XZ overlap. */
      const otherBottom = other.bottomY ?? -Infinity;
      const otherTop = other.topY ?? Infinity;
      if (fpBottom >= otherTop - Y_BAND_EPSILON) return;
      if (fpTop <= otherBottom + Y_BAND_EPSILON) return;
      /* Reduce both shapes to "circle vs other" by treating fp as a swept circle of
       * its bounding radius. Cheap conservative test. */
      const fpRadius = fp.kind === 'circle' ? fp.r : Math.hypot(fp.halfW, fp.halfD);
      const dx = other.x - fp.x;
      const dz = other.z - fp.z;
      const otherRadius = other.kind === 'circle' ? other.r : Math.hypot(other.halfW, other.halfD);
      if (Math.hypot(dx, dz) > fpRadius + otherRadius) return;
      /* Refined test for rect-vs-circle pairs uses the same closest-point routine. */
      if (other.kind === 'circle' && fp.kind === 'circle') {
        if (Math.hypot(dx, dz) < fp.r + other.r) {
          hit = true;
          return true;
        }
      } else if (other.kind === 'rect' && fp.kind === 'circle') {
        const cp = closestPointOnRectToPoint(other, fp.x, fp.z);
        if (Math.hypot(fp.x - cp.x, fp.z - cp.z) < fp.r) {
          hit = true;
          return true;
        }
      } else if (other.kind === 'circle' && fp.kind === 'rect') {
        const cp = closestPointOnRectToPoint(fp, other.x, other.z);
        if (Math.hypot(other.x - cp.x, other.z - cp.z) < other.r) {
          hit = true;
          return true;
        }
      } else if (other.kind === 'rect' && fp.kind === 'rect') {
        /* Rect-vs-rect is the toughest. Approximate via "is rect A's center inside
         * rect B's rotated bounds OR vice versa" — close enough for build-mode
         * placement validation where pieces are grid-snapped. */
        const cpA = closestPointOnRectToPoint(fp, other.x, other.z);
        if (Math.hypot(other.x - cpA.x, other.z - cpA.z) < 1e-3) {
          hit = true;
          return true;
        }
        const cpB = closestPointOnRectToPoint(other, fp.x, fp.z);
        if (Math.hypot(fp.x - cpB.x, fp.z - cpB.z) < 1e-3) {
          hit = true;
          return true;
        }
      }
      return undefined;
    });
    return hit;
  }

  /**
   * REUSED scratch Set for raycastXZ's per-query "already checked" dedup. Same
   * rationale as `_forEachNearbyScratch` above, but separate because raycastXZ
   * walks MULTIPLE forEachNearby calls (one per ray sample step) and the inner
   * scratch gets cleared each step — we need an outer scratch that persists
   * across steps within one raycast call.
   */
  const _raycastCheckedScratch = new Set<Footprint>();

  function raycastXZ(
    ox: number, oz: number,
    dx: number, dz: number,
    maxDist: number,
    opts?: {
      hitMobsOnly?: boolean;
      ignoreOwnerId?: string;
      /**
       * OPTIONAL Y-awareness. When BOTH `originY` and `dirY` are provided, each
       * candidate footprint's hit is filtered against the ray's Y at the hit
       * XZ distance: the hit only counts if `(originY + dirY * hitDist)` falls
       * within the footprint's `[bottomY, topY]` extent. Use this when the
       * caller cares about 3D scene queries — e.g. aiming a projectile from
       * the camera against a tree's actual canopy height instead of a flat
       * 2D footprint. When omitted, the legacy 2D-only behaviour applies
       * (footprints are infinitely tall in the raycast sense).
       *
       * `dirY` is "Y change per unit XZ distance travelled". For a camera-
       * forward unit vector `(fx, fy, fz)`: `dirY = fy / hypot(fx, fz)`.
       * `hitDist` is the XZ distance the raycast already returns, so the
       * world-Y at the hit point is `originY + dirY * hitDist`.
       */
      originY?: number;
      dirY?: number;
    },
  ): { ownerId: string; dist: number } | null {
    /* Walk along the ray sampling points every CELL_SIZE/2; at each sample query the
     * nearby buckets and per-pair test. Cheap (~2*maxDist/CELL_SIZE samples). For
     * accurate test, intersect ray with each candidate's circle/rect and take the
     * smallest positive t. */
    let bestT: number = Infinity;
    let bestOwner: string | null = null;
    const checked = _raycastCheckedScratch;
    checked.clear();
    const yAware = opts?.originY !== undefined && opts?.dirY !== undefined;
    const ry0 = opts?.originY ?? 0;
    const ryD = opts?.dirY ?? 0;
    /* Step length — half a cell so we visit every bucket along the ray exactly once. */
    const step = CELL_SIZE * 0.5;
    const steps = Math.ceil(maxDist / step) + 1;
    for (let i = 0; i <= steps; i++) {
      const t = Math.min(i * step, maxDist);
      const sx = ox + dx * t;
      const sz = oz + dz * t;
      forEachNearby(sx, sz, step + 1.0, (fp) => {
        if (checked.has(fp)) return;
        checked.add(fp);
        if (opts?.hitMobsOnly && fp.tag !== 'mob') return;
        if (opts?.ignoreOwnerId && fp.ownerId === opts.ignoreOwnerId) return;
        if (!fp.blocking && fp.tag !== 'mob') return; /* mob footprints are always raycast targets */
        if (xzRaySegmentCannotHitFootprint(ox, oz, dx, dz, maxDist, fp)) return;
        const hitT = rayHitFootprint(ox, oz, dx, dz, fp, maxDist);
        if (hitT === null) return;
        /* Y-aware filter: skip if the ray's Y at the hit XZ distance falls
         * outside the footprint's vertical extent. Defaults to ±Infinity
         * for footprints that don't set bottomY/topY (registered with the
         * legacy 2D-only API), so those continue to act as "infinitely
         * tall" in this raycast — backwards-compatible. */
        if (yAware) {
          const rayY = ry0 + ryD * hitT;
          const fpBottom = fp.bottomY ?? -Infinity;
          const fpTop = fp.topY ?? Infinity;
          if (rayY < fpBottom || rayY > fpTop) return;
        }
        if (hitT < bestT) {
          bestT = hitT;
          bestOwner = fp.ownerId;
        }
      });
      /* Early-exit: if we've found a hit closer than the next sample step would reach,
       * later samples can't beat it. */
      if (bestT < t) break;
    }
    if (bestOwner === null) return null;
    return { ownerId: bestOwner, dist: bestT };
  }

  /**
   * Highest blocking footprint top whose XZ shape contains the player's circle (within
   * `radius`) AND whose `topY` is at or below `currentY + GROUND_TOLERANCE`. Falls
   * back to `terrainY` when nothing qualifies. Cheap (linear over ~10-25 nearby
   * footprints with the spatial hash + Y-band cull).
   */
  function getGroundYAndOwner(
    x: number, z: number,
    currentY: number,
    terrainY: number,
    radius: number,
    snapUpHeight: number = GROUND_TOLERANCE,
  ): { y: number; ownerId: string | null } {
    let best = terrainY;
    let bestOwner: string | null = null;
    /* Sweep radius matches resolveCircleMove so we catch the same footprints. */
    forEachNearby(x, z, radius + 2.5, (fp) => {
      if (!fp.blocking) return;
      if (xzDiscCannotHitFootprint(x, z, radius, fp)) return;
      const top = fp.topY ?? Infinity;
      if (top === Infinity) return; /* no Y data → can't be a landing surface */
      if (top > currentY + snapUpHeight) return; /* obstacle out of reach above feet */
      if (top <= best) return; /* a higher candidate already wins */
      /* XZ containment test: does the player's foot circle overlap this footprint's
       * XZ shape? Reuse closest-point math to keep this honest for rotated rects. */
      let contains = false;
      if (fp.kind === 'circle') {
        const dxc = x - fp.x;
        const dzc = z - fp.z;
        if (Math.hypot(dxc, dzc) < fp.r + radius) contains = true;
      } else {
        const cp = closestPointOnRectToPoint(fp, x, z);
        if (Math.hypot(x - cp.x, z - cp.z) < radius) contains = true;
      }
      if (contains) {
        best = top;
        bestOwner = fp.ownerId;
      }
    });
    return { y: best, ownerId: bestOwner };
  }

  function getGroundY(
    x: number, z: number,
    currentY: number,
    terrainY: number,
    radius: number,
    snapUpHeight: number = GROUND_TOLERANCE,
  ): number {
    return getGroundYAndOwner(x, z, currentY, terrainY, radius, snapUpHeight).y;
  }

  function dispose(): void {
    buckets.clear();
    ownerIndex.clear();
  }

  return {
    register, unregister, movePosition, resolveCircleMove, overlaps,
    raycastXZ, getGroundY, getGroundYAndOwner, dispose,
  };
}

/* ============================================================================
 * Ray-vs-footprint helper (private)
 * ============================================================================ */

/**
 * Returns the smallest t in [0, maxDist] where the ray `(ox, oz) + t*(dx, dz)` enters
 * `fp`'s footprint, or null if no hit.
 */
function rayHitFootprint(
  ox: number, oz: number,
  dx: number, dz: number,
  fp: Footprint,
  maxDist: number,
): number | null {
  if (fp.kind === 'circle') {
    /* Standard ray-circle intersection. */
    const ex = ox - fp.x;
    const ez = oz - fp.z;
    const a = dx * dx + dz * dz;
    const b = 2 * (ex * dx + ez * dz);
    const c = ex * ex + ez * ez - fp.r * fp.r;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sqrt = Math.sqrt(disc);
    const t1 = (-b - sqrt) / (2 * a);
    if (t1 >= 0 && t1 <= maxDist) return t1;
    const t2 = (-b + sqrt) / (2 * a);
    if (t2 >= 0 && t2 <= maxDist) return t2;
    return null;
  }
  /* Rect: transform the ray into rect-local space, then standard slab test. */
  const cosR = Math.cos(-fp.rotY);
  const sinR = Math.sin(-fp.rotY);
  const lox = (ox - fp.x) * cosR - (oz - fp.z) * sinR;
  const loz = (ox - fp.x) * sinR + (oz - fp.z) * cosR;
  const ldx = dx * cosR - dz * sinR;
  const ldz = dx * sinR + dz * cosR;
  /* Slab test on X. */
  let tMin = -Infinity;
  let tMax = Infinity;
  if (Math.abs(ldx) > 1e-8) {
    const t1 = (-fp.halfW - lox) / ldx;
    const t2 = (fp.halfW - lox) / ldx;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
  } else if (lox < -fp.halfW || lox > fp.halfW) {
    return null;
  }
  /* Slab test on Z. */
  if (Math.abs(ldz) > 1e-8) {
    const t1 = (-fp.halfD - loz) / ldz;
    const t2 = (fp.halfD - loz) / ldz;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
  } else if (loz < -fp.halfD || loz > fp.halfD) {
    return null;
  }
  if (tMin > tMax) return null;
  if (tMax < 0) return null;
  if (tMin > maxDist) return null;
  return Math.max(0, tMin);
}
