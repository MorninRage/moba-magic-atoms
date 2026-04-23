/**
 * Awakened-mode cabin renderer (Phase 1 of the base-building system — see
 * `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md`).
 *
 * Owns the visual representation of every `PlacedCabinPiece` in `GameState`. The store
 * is the single source of truth; this module just diffs the rendered scene against the
 * latest state on each `syncFromState` call.
 *
 * **Render strategy: `THREE.InstancedMesh` per (kind, tier, material).** Each unique
 * combination of piece kind, material tier, and underlying PBR material gets ONE
 * `InstancedMesh` with capacity for many pieces. Per-piece world transforms are written
 * into the instance matrix. Cost per piece = ~constant (single matrix write per
 * sub-mesh of the LPCA template). Cost per draw = constant in piece count (the renderer
 * only sees N InstancedMeshes regardless of how many cabin pieces they contain).
 *
 * For a 200-piece base spread across 5 kinds × 4 tiers = ~20 (kind, tier) buckets ×
 * ~3 materials each = ~60 InstancedMeshes total ≈ ~60 draw calls. Naïve per-piece
 * rendering would be ~200 × 12 sub-meshes ≈ 2,400 draws.
 *
 * **Diff strategy: full rebuild per (kind, tier) bucket on state change.** Store emits
 * are human-paced (placement / removal clicks). Even a "rebuild every bucket every
 * emit" is sub-millisecond; we cheap out further by skipping buckets whose piece set
 * is unchanged via a per-bucket signature (sorted ids string).
 *
 * **Phantom-light rule:** see `magicalCabinMaterials.ts` header. No `THREE.PointLight`
 * is ever created here — all glow is emissive + post-processing bloom.
 */
import * as THREE from 'three';
import { mergeByMaterial } from 'empire-engine/lpca';
import type { CabinMaterialTier, CabinPieceKind, PlacedCabinPiece } from '../core/types';
import { buildCabinPieceLPCA } from '../visual/cabinPieceLPCA';
import {
  CABIN_TIER_ORDER,
  cabinBand,
  cabinLog,
  cabinRune,
} from '../visual/magicalCabinMaterials';
import type { CollisionWorldHandle } from './collisionWorld';

/* Per-kind footprint shape + vertical extent (in world units) used to register the
 * collision footprint for each placed cabin piece.
 *
 * `bottomYOffset` / `topYOffset` are added to the piece's world `y` to get the actual
 * Y range the player's body must overlap before the footprint blocks. With Y-aware
 * collision the rules are:
 *   - **Foundation** (low slab, ~0.15 m tall): blocking, but a normal jump (apex ~1.84 m)
 *     trivially clears it — and `getGroundY` snaps the player to the slab top so you
 *     walk *on* the foundation.
 *   - **Walls / pillars / doors / gates**: full-height blockers. Tall stacks can't be
 *     jumped over with a single jump but a double-jump (apex ~6 m) clears one row.
 *   - **Roof / ceiling**: blocking ONLY when the player's head intersects them
 *     (Y-band cull does this naturally). You walk under without being pushed; you
 *     bonk if you double-jump into the roof.
 *   - **Floor / stairs / ladder**: thin walkable surfaces. `getGroundY` snaps you on top.
 */
const CABIN_PIECE_FOOTPRINT_HALF_EXTENTS: Record<CabinPieceKind, {
  halfW: number; halfD: number; blocking: boolean;
  bottomYOffset: number; topYOffset: number;
}> = {
  foundation:   { halfW: 0.75, halfD: 0.75, blocking: true,  bottomYOffset: 0,    topYOffset: 0.15 },
  pillar:       { halfW: 0.12, halfD: 0.12, blocking: true,  bottomYOffset: 0,    topYOffset: 2.4 },
  wall_solid:   { halfW: 0.75, halfD: 0.12, blocking: true,  bottomYOffset: 0,    topYOffset: 2.4 },
  wall_window:  { halfW: 0.75, halfD: 0.12, blocking: true,  bottomYOffset: 0,    topYOffset: 2.4 },
  wall_doorway: { halfW: 0.55, halfD: 0.12, blocking: true,  bottomYOffset: 0,    topYOffset: 2.4 }, /* lintel above doorway */
  door:         { halfW: 0.35, halfD: 0.05, blocking: true,  bottomYOffset: 0,    topYOffset: 1.8 },
  floor:        { halfW: 0.75, halfD: 0.75, blocking: true,  bottomYOffset: 0,    topYOffset: 0.05 },
  ceiling:      { halfW: 0.75, halfD: 0.75, blocking: true,  bottomYOffset: -0.05, topYOffset: 0.05 },
  roof_slope:   { halfW: 0.75, halfD: 1.0,  blocking: true,  bottomYOffset: 0,    topYOffset: 0.8 }, /* Y-cull lets you walk under */
  roof_peak:    { halfW: 0.75, halfD: 1.0,  blocking: true,  bottomYOffset: 0,    topYOffset: 0.8 },
  stairs:       { halfW: 0.75, halfD: 0.5,  blocking: true,  bottomYOffset: 0,    topYOffset: 0.55 },
  gate:         { halfW: 0.7,  halfD: 0.05, blocking: true,  bottomYOffset: 0,    topYOffset: 1.95 },
  ladder:       { halfW: 0.22, halfD: 0.05, blocking: false, bottomYOffset: 0,    topYOffset: 2.2 }, /* climb-by-walking-into; no push */
};

/* ============================================================================
 * Per-bucket render state
 * ============================================================================ */

interface KindTierBucket {
  /** One InstancedMesh per merged-material sub-mesh of the LPCA template. */
  meshes: THREE.InstancedMesh[];
  /** Current capacity (instance count) of every mesh in this bucket. */
  capacity: number;
  /** Stable signature of the last sync state (sorted piece ids); skip rebuild if unchanged. */
  lastSig: string;
}

const _scratchMatrix = new THREE.Matrix4();
const _scratchPos = new THREE.Vector3();
const _scratchQuat = new THREE.Quaternion();
const _scratchScale = new THREE.Vector3(1, 1, 1);
const _scratchAxis = new THREE.Vector3(0, 1, 0);
const _hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

/** Lower bound on instance capacity per bucket — avoids re-allocation churn for small bases. */
const MIN_BUCKET_CAPACITY = 16;

/* ============================================================================
 * Public handle
 * ============================================================================ */

export interface CabinBuildHandle {
  /**
   * Sync the rendered scene with the latest store state. Cheap when the placed-pieces
   * set is unchanged from the prior call (early-return after a string signature
   * compare per bucket). Called on every store emit.
   */
  syncFromState(pieces: ReadonlyArray<PlacedCabinPiece>): void;
  /**
   * Find the closest piece within `radius` of `(x, z)`. Used by the future repair UX
   * (Phase 4) and currently exposed for the build-mode controller's collision-avoid
   * snap. Linear scan over the live state — cheap for typical base sizes.
   */
  getPieceNear(x: number, z: number, radius: number, pieces: ReadonlyArray<PlacedCabinPiece>): PlacedCabinPiece | null;
  /**
   * Build a fresh ghost-preview Group for a (kind, tier). Caller is responsible for
   * material substitution (translucent green/red overlay) and disposal. The returned
   * Group is NOT cached — each call constructs new geometry/group references so the
   * caller can mutate freely without poisoning the live scene.
   */
  buildPieceTemplate(kind: CabinPieceKind, tier: CabinMaterialTier): THREE.Group;
  /**
   * Pre-compile every cabin material's shader program at boot so the first time the
   * player places a (kind, tier) doesn't trigger a synchronous WebGL compile freeze.
   * Same root pattern as `warmCraftDecorShadersForGpu` in `characterScenePreview` —
   * see `LEARNINGS.md` "Campfire 5-second freeze" for the program-cache rationale.
   *
   * Implementation: parks one tiny placeholder mesh per cabin material at a far-off
   * world position, calls `renderer.compile(scene, camera)` to JIT every program, then
   * schedules disposal next tick. The far-off position ensures the placeholders never
   * appear in the player's view even on the warm frame.
   */
  warmShaders(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void;
  /** Detach the cabin root group + dispose all owned InstancedMeshes. */
  dispose(): void;
}

interface AttachOpts {
  scene: THREE.Scene;
  /**
   * Optional collision world. When provided, every placed piece registers a rotated
   * rect footprint via `register()` on `syncFromState`, and removes via `unregister()`
   * when the piece is removed from state. Player + mob movement queries this world to
   * resolve overlap (no walking through walls). Pass undefined to skip collision
   * registration entirely (useful for tests / preview-only contexts).
   */
  collisionWorld?: CollisionWorldHandle;
}

export function attachCabinBuilder(opts: AttachOpts): CabinBuildHandle {
  const root = new THREE.Group();
  root.name = 'CabinBuildRoot';
  opts.scene.add(root);

  /** Active buckets keyed by `${kind}:${tier}`. */
  const buckets = new Map<string, KindTierBucket>();

  /* ---- Bucket lifecycle ---- */

  /**
   * Build a fresh bucket for a (kind, tier) at a given capacity. Mounts the InstancedMesh
   * children to `root` and initializes every instance to the hidden matrix (zero scale)
   * so unused slots don't render until the diff loop fills them.
   */
  function createBucket(kind: CabinPieceKind, tier: CabinMaterialTier, capacity: number): KindTierBucket {
    /* Build the LPCA template once, run mergeByMaterial to consolidate by material —
     * this is the proven pattern from freeRoamHarvestNodes.ts. The merged result has
     * one mesh per unique material in the template; each becomes one InstancedMesh. */
    const template = buildCabinPieceLPCA(kind, tier);
    template.position.set(0, 0, 0);
    template.updateMatrixWorld(true);
    const mergedGroup = mergeByMaterial(template);
    const mergedMeshes: THREE.Mesh[] = [];
    mergedGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) mergedMeshes.push(m);
    });
    /* The original template's geometry is now baked into the merged result; we don't
     * dispose it because cabinPieceLPCA pulls from the SHARED geometry cache (disposing
     * would corrupt other pieces of the same kind). The merged result's geometries are
     * fresh clones; those are owned by the InstancedMesh below. */
    const meshes: THREE.InstancedMesh[] = mergedMeshes.map((m) => {
      const im = new THREE.InstancedMesh(m.geometry, m.material as THREE.Material, capacity);
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = true;
      for (let i = 0; i < capacity; i++) im.setMatrixAt(i, _hiddenMatrix);
      im.instanceMatrix.needsUpdate = true;
      root.add(im);
      return im;
    });
    return { meshes, capacity, lastSig: '' };
  }

  /** Dispose a bucket: detach + dispose its InstancedMesh geometries. */
  function disposeBucket(bucket: KindTierBucket): void {
    for (const im of bucket.meshes) {
      root.remove(im);
      im.geometry.dispose();
      /* Material is shared from the magical-cabin material cache; do NOT dispose. */
      im.dispose();
    }
  }

  /**
   * Grow a bucket's capacity by rebuilding it. Fired when the player places more pieces
   * of one (kind, tier) than the bucket can hold. Doubles capacity to avoid frequent
   * regrowth at large bases.
   */
  function growBucket(key: string, kind: CabinPieceKind, tier: CabinMaterialTier, neededCapacity: number): KindTierBucket {
    const old = buckets.get(key);
    if (old) disposeBucket(old);
    let cap = MIN_BUCKET_CAPACITY;
    while (cap < neededCapacity) cap *= 2;
    const fresh = createBucket(kind, tier, cap);
    buckets.set(key, fresh);
    return fresh;
  }

  /* ---- Diff sync ---- */

  /** Set of piece ids currently registered with the collision world. Used to diff
   * state changes — register newcomers, unregister departures. */
  const registeredFootprintIds = new Set<number>();

  function footprintOwnerId(pieceId: number): string {
    return `cabin:${pieceId}`;
  }

  function syncFromState(pieces: ReadonlyArray<PlacedCabinPiece>): void {
    /* Collision world diff (independent of the bucket sync below). Register footprints
     * for newly placed pieces and unregister for removed ones. The collision world
     * reuses the per-piece ownerId so registering an existing id replaces in place
     * (handles in-place edits if a piece is ever moved). */
    if (opts.collisionWorld) {
      const liveIds = new Set<number>();
      for (const p of pieces) {
        liveIds.add(p.id);
        const fpExtents = CABIN_PIECE_FOOTPRINT_HALF_EXTENTS[p.kind];
        opts.collisionWorld.register({
          kind: 'rect',
          x: p.x,
          z: p.z,
          halfW: fpExtents.halfW,
          halfD: fpExtents.halfD,
          rotY: p.rotY,
          ownerId: footprintOwnerId(p.id),
          blocking: fpExtents.blocking,
          tag: 'static',
          bottomY: p.y + fpExtents.bottomYOffset,
          topY: p.y + fpExtents.topYOffset,
        });
        registeredFootprintIds.add(p.id);
      }
      for (const oldId of registeredFootprintIds) {
        if (!liveIds.has(oldId)) {
          opts.collisionWorld.unregister(footprintOwnerId(oldId));
          registeredFootprintIds.delete(oldId);
        }
      }
    }

    /* Group pieces by (kind, tier) into buckets. */
    const groupedByBucket = new Map<string, PlacedCabinPiece[]>();
    for (const p of pieces) {
      const key = `${p.kind}:${p.tier}`;
      let arr = groupedByBucket.get(key);
      if (!arr) {
        arr = [];
        groupedByBucket.set(key, arr);
      }
      arr.push(p);
    }
    /* Dispose buckets whose (kind, tier) is no longer present. */
    for (const [key, bucket] of buckets) {
      if (!groupedByBucket.has(key)) {
        disposeBucket(bucket);
        buckets.delete(key);
      }
    }
    /* Sync each active bucket. Sorting ids gives a stable signature so the per-bucket
     * skip-when-unchanged check is cheap. */
    for (const [key, list] of groupedByBucket) {
      list.sort((a, b) => a.id - b.id);
      const sig = list.map((p) => p.id).join(',');
      let bucket = buckets.get(key);
      if (bucket && sig === bucket.lastSig) continue; /* no change in this bucket */
      const [kind, tier] = key.split(':') as [CabinPieceKind, CabinMaterialTier];
      if (!bucket || list.length > bucket.capacity) {
        bucket = growBucket(key, kind, tier, Math.max(list.length, MIN_BUCKET_CAPACITY));
      }
      bucket.lastSig = sig;
      /* Write matrices for every active instance + zero out the unused tail. */
      for (let i = 0; i < bucket.capacity; i++) {
        if (i < list.length) {
          const p = list[i]!;
          _scratchPos.set(p.x, p.y, p.z);
          _scratchQuat.setFromAxisAngle(_scratchAxis, p.rotY);
          _scratchScale.set(1, 1, 1);
          _scratchMatrix.compose(_scratchPos, _scratchQuat, _scratchScale);
          for (const im of bucket.meshes) im.setMatrixAt(i, _scratchMatrix);
        } else {
          for (const im of bucket.meshes) im.setMatrixAt(i, _hiddenMatrix);
        }
      }
      for (const im of bucket.meshes) im.instanceMatrix.needsUpdate = true;
    }
  }

  function getPieceNear(
    x: number, z: number, radius: number,
    pieces: ReadonlyArray<PlacedCabinPiece>,
  ): PlacedCabinPiece | null {
    let best: PlacedCabinPiece | null = null;
    let bestDist2 = radius * radius;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]!;
      const dx = p.x - x;
      const dz = p.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDist2) {
        bestDist2 = d2;
        best = p;
      }
    }
    return best;
  }

  function buildPieceTemplate(kind: CabinPieceKind, tier: CabinMaterialTier): THREE.Group {
    /* Returned Group is fresh; caller can mutate materials for ghost rendering without
     * poisoning the live scene. The cabinPieceLPCA builder DOES pull cached materials,
     * so the caller MUST replace them with overlay materials before adding to the
     * scene — direct material mutation would tint every live cabin. */
    return buildCabinPieceLPCA(kind, tier);
  }

  function warmShaders(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    /* Tiny placeholder geometry — every material gets one mesh; same geometry across
     * all so the GPU caches the geometry buffer once. Far-off position (10000 m) so
     * even if the warm frame appears in the player's view, the meshes are below the
     * floor and out of frustum. */
    const tinyGeo = new THREE.BoxGeometry(0.01, 0.01, 0.01);
    const placeholders: THREE.Mesh[] = [];
    for (const tier of CABIN_TIER_ORDER) {
      const log = cabinLog(tier);
      const m = new THREE.Mesh(tinyGeo, log);
      m.position.set(10000, -10000, 10000);
      root.add(m);
      placeholders.push(m);
      const band = cabinBand(tier);
      if (band) {
        const m2 = new THREE.Mesh(tinyGeo, band);
        m2.position.set(10000, -10000, 10000);
        root.add(m2);
        placeholders.push(m2);
      }
      const rune = cabinRune(tier);
      if (rune) {
        const m3 = new THREE.Mesh(tinyGeo, rune);
        m3.position.set(10000, -10000, 10000);
        root.add(m3);
        placeholders.push(m3);
      }
    }
    /* JIT every program. Synchronous on the main thread — best to call this once at
     * boot during the existing warm pipeline window, not later.
     *
     * === 2026-04-20 non-blocking GPU compile ===
     *
     * Use `renderer.compileAsync` (Three r158+) so the program JIT runs
     * via `KHR_parallel_shader_compile` on the GPU's worker thread
     * without blocking the JS main thread. Without this the per-tier
     * cabin shader compile was 100-300 ms of frozen UI in the title
     * preload window. */
    const cleanupPlaceholders = (): void => {
      for (const m of placeholders) {
        root.remove(m);
      }
      tinyGeo.dispose();
    };
    const r = renderer as THREE.WebGLRenderer & {
      compileAsync?: (s: THREE.Object3D, c: THREE.Camera) => Promise<void>;
    };
    if (typeof r.compileAsync === 'function') {
      r.compileAsync(opts.scene, camera)
        .then(() => requestAnimationFrame(cleanupPlaceholders))
        .catch(() => requestAnimationFrame(cleanupPlaceholders));
      return;
    }
    try {
      renderer.compile(opts.scene, camera);
    } catch {
      /* renderer.compile is best-effort — swallow any context-loss / state errors. */
    }
    /* Schedule cleanup on next frame so the GPU has had a chance to actually compile.
     * Removing the meshes immediately after compile() returns is also safe in practice
     * — the program cache survives mesh removal — but the rAF wait is defensive. */
    requestAnimationFrame(cleanupPlaceholders);
  }

  function dispose(): void {
    for (const bucket of buckets.values()) disposeBucket(bucket);
    buckets.clear();
    if (root.parent) root.parent.remove(root);
  }

  return { syncFromState, getPieceNear, buildPieceTemplate, warmShaders, dispose };
}
