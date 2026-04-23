/**
 * Awakened-mode ghost-preview build mode (Phase 1 + Phase 1.5 — see
 * `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` §2.1 + §12).
 *
 * Ports GoE's `BuildModeSystem.ts` ghost preview + snap pipeline. When the player picks
 * a (kind, tier) from the awakened-menu Build tab:
 *
 *   1. Camera-lock auto-engages (the awakened menu Build button calls Q-toggle on the
 *      caller side); cursor disappears via Pointer Lock API; mouse drives camera.
 *   2. Each frame, raycast from the camera's CENTER ray (NDC `(0,0)`) against:
 *      a. The horizontal terrain plane at the camera's current XZ heightfield sample.
 *      b. AABBs of every placed piece (within `MAX_PLACE_DIST = 30`).
 *      Pick the closest hit — that's the cursor's "world point".
 *   3. Snap the world point's XZ to the 1.5 m grid.
 *   4. Run `findSnapXZ` — lateral cardinal-direction snap from the picked piece's snap
 *      points. Beats grid-snap if the candidate is within `LATERAL_SNAP_DIST = 2.25 m`
 *      (1.5× grid, per GoE doc). Returns `sameKind: boolean` for the choose-between rule.
 *   5. Run `findSnapY` — top-stack snap (place ON TOP of the picked piece's snap-point).
 *      Threshold `TOP_SNAP_DIST = 1.0 m` euclidean so it only fires when cursor is
 *      genuinely OVER the placed piece's footprint (matches GoE "ghost OVERLAPS").
 *   6. **Choose-between rule (GoE flush-extension):**
 *      - If lateral matched a SAME-KIND placed piece (floor↔floor, wall↔wall, etc.),
 *        the lateral snap WINS outright; top-snap competition is skipped. This is the
 *        "deck extension" rule — same-kind pieces always extend flush at the same Y.
 *      - Otherwise, prefer closer-to-cursor of (lateral, top). Mixed-kind cases use
 *        the GoE generic heuristic.
 *      - No snap matched → fall back to grid-snapped XZ on terrain.
 *   7. Validate: inside `mapRadius`, terrain not water, no collision-world overlap,
 *      inventory has materials.
 *   8. Tint ghost green / red. LMB (or E) confirms; Esc cancels.
 *
 * **Inputs:** rotation = `rotateBy(radians)` (R sends ±π/2, mouse wheel sends ±π/12).
 * Confirm = LMB (matches GoE) routed via `freeRoamControls`'s mousedown handler in
 * build-mode. E still confirms too (accessibility carry-over from Phase 1). Esc cancels.
 *
 * **Phantom-light rule:** all "glow" on cabin pieces is emissive; the ghost overlay
 * has no PointLight. Same rule from `magicalCabinMaterials.ts`.
 *
 * **2026-04-18 update:** flush-snap fix — see `LEARNINGS.md` → "GoE-style flush snap"
 * and `docs/SESSION_2026_04_18_BUILDING_AND_PENDING.md`.
 */
import * as THREE from 'three';
import type {
  CabinMaterialTier,
  CabinPieceKind,
  PlacedCabinPiece,
  PlacedCraftStation,
  PlacedCraftStationKind,
  SnapPoint,
} from '../core/types';
import { getCabinPieceHalfExtents, getCabinPieceSnapPoints } from '../visual/cabinPieceLPCA';
import { getCraftStationHalfExtents } from './craftStationBuilder';
import type { CollisionWorldHandle, Footprint } from './collisionWorld';

/* ============================================================================
 * Types
 * ============================================================================ */

export interface BuildModeController {
  /**
   * Enter placement mode for a (kind, tier). Returns false if the player has no
   * inventory of the materials needed for this combination.
   */
  enter(kind: CabinPieceKind, tier: CabinMaterialTier): boolean;
  /**
   * Per-frame integrator. Reads camera + scene; raycasts center-ray to find target
   * point; runs snap pipeline; updates ghost transform; recomputes validity tint.
   * Cheap when not active.
   */
  update(camera: THREE.Camera): void;
  /** Wired from LMB (and E for legacy). Calls `placeCabinPiece` on the store; returns success. */
  confirm(): boolean;
  /** Wired from Esc. Drops the ghost without state change. */
  cancel(): void;
  /** True from `enter()` until `confirm()` succeeds OR `cancel()` runs. */
  isActive(): boolean;
  /** Apply rotation delta. R-key sends ±90°, mouse wheel sends ±15°. */
  rotateBy(radians: number): void;
  /** Read-only: the (kind, tier) currently being placed (null when inactive). */
  getActiveSelection(): { kind: CabinPieceKind; tier: CabinMaterialTier } | null;
  /** Detach ghost group; safe to call before `dispose` of the host scene. */
  dispose(): void;
}

export interface BuildModeOptions {
  scene: THREE.Scene;
  /** Heightfield sampler — same one the dock + free-roam controls use. */
  getTerrainHeight: (x: number, z: number) => number;
  /** Largest XZ radius the player can place inside (matches dock map radius). */
  mapRadius: number;
  /** Returns true if the given XZ is over water (no foundation on water). */
  isWaterAt: (x: number, z: number) => boolean;
  /**
   * Build a fresh ghost-mesh template Group for the picked (kind, tier). Caller will
   * replace materials with the overlay; geometry should not be shared with live cabins
   * (`cabinBuildHandle.buildPieceTemplate` returns a fresh Group).
   */
  buildPieceTemplate: (kind: CabinPieceKind, tier: CabinMaterialTier) => THREE.Group;
  /** Snapshot of current placed pieces for snap pipeline + collision-avoid validation. */
  getPlacedPieces: () => ReadonlyArray<PlacedCabinPiece>;
  /**
   * Place the piece in the world via the store. Should fire `store.placeCabinPiece`.
   * Returns the placed piece on success or null if validation fails store-side.
   */
  onConfirmPlace: (
    kind: CabinPieceKind, tier: CabinMaterialTier,
    x: number, y: number, z: number, rotY: number,
  ) => PlacedCabinPiece | null;
  /** Optional: run when validity changes — host can update HUD prompt text. */
  onValidityChange?: (valid: boolean) => void;
}

/* ============================================================================
 * Constants
 * ============================================================================ */

/** Snap grid (matches GoE BuildModeSystem GRID_SIZE). */
const GRID_SIZE = 1.5;
/** Map-edge buffer so pieces don't clip the dock disc edge. */
const MAP_EDGE_BUFFER = 0.5;
/** Max distance from camera the cursor can place (matches GoE BuildModeSystem MAX_PLACE_DIST). */
const MAX_PLACE_DIST = 30;
/**
 * Lateral edge-snap candidate distance (Euclidean). Per the GoE building-system
 * doc: "When a ghost's edge snap point is within 1.5× grid distance of an
 * existing piece's edge, it snaps flush." 1.5 * GRID_SIZE = 2.25 m. Tighter than
 * the prior 3.0 m so the snap only fires when the cursor is genuinely targeting
 * the adjacent grid cell — no "snap from across the room".
 */
const LATERAL_SNAP_DIST = GRID_SIZE * 1.5;
/**
 * Top-stack snap tolerance (Euclidean from cursor XZ to placed piece's top snap
 * world XZ). Tightened from the prior 4.5 m manhattan to 1.0 m euclidean so the
 * top-stack snap only competes with lateral when the cursor is genuinely INSIDE
 * the placed piece's footprint (matches GoE's "ghost OVERLAPS top snap point"
 * intent). Without this tightening, every nearby foundation's top snap competed
 * with the lateral floor-to-floor snap and could win at oblique cursor angles —
 * which was the "new floor stacks on top of existing" symptom.
 */
const TOP_SNAP_DIST = 1.0;
/** Min separation between any two placed pieces (anti-overlap fallback when no snap). */
const COLLISION_MIN_DIST = 0.4;

/* Ghost overlay materials — shared singletons; replaced in-mesh per ghost rebuild. */
const GHOST_VALID_MAT = new THREE.MeshStandardMaterial({
  color: 0x44ff66,
  emissive: 0x33aa44,
  emissiveIntensity: 0.4,
  transparent: true,
  opacity: 0.45,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const GHOST_INVALID_MAT = new THREE.MeshStandardMaterial({
  color: 0xff4444,
  emissive: 0xaa2222,
  emissiveIntensity: 0.45,
  transparent: true,
  opacity: 0.5,
  depthWrite: false,
  side: THREE.DoubleSide,
});

/* ============================================================================
 * Implementation
 * ============================================================================ */

export function createBuildModeController(opts: BuildModeOptions): BuildModeController {
  let active = false;
  let activeKind: CabinPieceKind | null = null;
  let activeTier: CabinMaterialTier | null = null;
  let ghostGroup: THREE.Group | null = null;
  let lastValid: boolean | null = null;
  /** Ghost rotation around Y axis (radians). Reset to 0 on each `enter()`. */
  let ghostRotY = 0;
  /** Latest computed ghost world XZ (used by `confirm` to feed the store). */
  let ghostX = 0;
  let ghostY = 0;
  let ghostZ = 0;

  /* Reusable raycaster + scratch math objects (avoid per-frame allocations). */
  const raycaster = new THREE.Raycaster();
  raycaster.far = MAX_PLACE_DIST;
  const ndcCenter = new THREE.Vector2(0, 0);
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const tmpHit = new THREE.Vector3();
  const tmpBoxMin = new THREE.Vector3();
  const tmpBoxMax = new THREE.Vector3();
  const tmpBox = new THREE.Box3();
  const tmpCamPos = new THREE.Vector3();

  function applyValidityTint(valid: boolean): void {
    if (!ghostGroup) return;
    if (lastValid === valid) return;
    lastValid = valid;
    const mat = valid ? GHOST_VALID_MAT : GHOST_INVALID_MAT;
    ghostGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = mat;
    });
    opts.onValidityChange?.(valid);
  }

  function buildGhost(kind: CabinPieceKind, tier: CabinMaterialTier): THREE.Group {
    /* Fresh template so we can mutate material refs without touching live cabins. */
    const tmpl = opts.buildPieceTemplate(kind, tier);
    /* Replace every mesh's material with the validity overlay (will be re-tinted on
     * the first update tick; default to valid green for the initial frame). */
    tmpl.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.material = GHOST_VALID_MAT;
        m.castShadow = false;
        m.receiveShadow = false;
      }
    });
    return tmpl;
  }

  function isPlacementValid(x: number, z: number): boolean {
    /* Map radius gate. */
    if (Math.hypot(x, z) > opts.mapRadius - MAP_EDGE_BUFFER) return false;
    /* Water gate. */
    if (opts.isWaterAt(x, z)) return false;
    /* Overlap-with-existing fallback (snap pipeline already prefers attachments to
     * existing pieces; this catches the "free placement near another piece" case). */
    const placed = opts.getPlacedPieces();
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i]!;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < COLLISION_MIN_DIST) return false;
    }
    return true;
  }

  function snapToGrid(v: number): number {
    return Math.round(v / GRID_SIZE) * GRID_SIZE;
  }

  /**
   * Center-ray raycast (NDC center) against terrain plane + placed-piece AABBs. Returns
   * the world-space hit point, or null if nothing hit within MAX_PLACE_DIST.
   *
   * Matches GoE's BuildModeSystem fire-vector pattern (camera-forward, not mouse —
   * pointer-locked FPS aim is implicit; the cursor is hidden + camera turns with
   * mouse motion via `cameraLockController`).
   */
  function raycastCursor(camera: THREE.Camera): { x: number; y: number; z: number } | null {
    raycaster.setFromCamera(ndcCenter, camera);
    /* Ground plane at heightfield(camera XZ) — close enough for dock-scale terrain
     * with gentle slope. The plane's `constant` is `-y` for the plane equation, hence
     * negative sample. */
    camera.getWorldPosition(tmpCamPos);
    groundPlane.constant = -opts.getTerrainHeight(tmpCamPos.x, tmpCamPos.z);
    let bestT: number = Infinity;
    let bestHit: { x: number; y: number; z: number } | null = null;
    /* Test ground plane first. */
    const gp = raycaster.ray.intersectPlane(groundPlane, tmpHit);
    if (gp) {
      const dist = tmpHit.distanceTo(tmpCamPos);
      if (dist < MAX_PLACE_DIST && dist < bestT) {
        bestT = dist;
        bestHit = { x: tmpHit.x, y: tmpHit.y, z: tmpHit.z };
      }
    }
    /* Test placed-piece AABBs. */
    const placed = opts.getPlacedPieces();
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i]!;
      const ext = getCabinPieceHalfExtents(p.kind);
      /* Conservative AABB — ignore rotY for the slab test (rect AABBs are thin enough
       * that overestimating the swept-AABB doesn't materially hurt cursor precision).
       * Use the inscribed-rotation bound: max(halfW, halfD) along both X and Z. */
      const rEnv = Math.max(ext.halfW, ext.halfD);
      tmpBoxMin.set(p.x - rEnv, p.y - ext.halfH, p.z - rEnv);
      tmpBoxMax.set(p.x + rEnv, p.y + ext.halfH, p.z + rEnv);
      tmpBox.set(tmpBoxMin, tmpBoxMax);
      const hit = raycaster.ray.intersectBox(tmpBox, tmpHit);
      if (!hit) continue;
      const dist = tmpHit.distanceTo(tmpCamPos);
      if (dist < bestT) {
        bestT = dist;
        bestHit = { x: tmpHit.x, y: tmpHit.y, z: tmpHit.z };
      }
    }
    return bestHit;
  }

  /**
   * Lateral edge snap (matches GoE `findSnapXZ`). Walks every placed piece, rotates its
   * cardinal-direction snap points to world space, computes a candidate placement
   * position (snap point + outward * new piece's half-extent), and picks the closest
   * to the grid-snapped cursor XZ.
   *
   * Returns the snap candidate XZ if one beats `SNAP_THRESHOLD` distance, else null
   * (caller falls back to the grid-snapped XZ).
   */
  function findSnapXZ(
    sx: number, sz: number,
    newKind: CabinPieceKind,
    placed: ReadonlyArray<PlacedCabinPiece>,
  ): { x: number; z: number; y: number; sameKind: boolean } | null {
    let bestDist = LATERAL_SNAP_DIST;
    let best: { x: number; z: number; y: number; sameKind: boolean } | null = null;
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i]!;
      const snaps = getCabinPieceSnapPoints(p.kind);
      const cosR = Math.cos(p.rotY);
      const sinR = Math.sin(p.rotY);
      for (const sp of snaps) {
        if (sp.direction === 'top' || sp.direction === 'bottom') continue;
        if (!sp.accepts.includes(newKind)) continue;
        /* Rotate piece-local snap offset into world space. */
        const wx = p.x + sp.offset.x * cosR - sp.offset.z * sinR;
        const wz = p.z + sp.offset.x * sinR + sp.offset.z * cosR;
        /* Outward direction at the snap face — the snap's `direction` interpreted in
         * the placed piece's rotation frame. */
        const outDir = cardinalToWorld(sp.direction, p.rotY);
        if (!outDir) continue;
        /* Candidate center = snap point + outward * new piece's half-extent (the snap
         * point sits on the placed piece's edge; the new piece's center should sit
         * one half-extent outward). */
        const halfExtAlong = projectHalfExtentOnDir(newKind, outDir);
        const cx = wx + outDir.x * halfExtAlong;
        const cz = wz + outDir.z * halfExtAlong;
        const dist = Math.hypot(cx - sx, cz - sz);
        if (dist < bestDist) {
          bestDist = dist;
          best = { x: cx, y: p.y, z: cz, sameKind: p.kind === newKind };
        }
      }
    }
    return best;
  }

  /**
   * Top-stack snap (matches GoE `findSnapY`). Walks every placed piece's `top`
   * snap points where the new kind is accepted; if the cursor's grid-snapped XZ is
   * within `SNAP_THRESHOLD` of a snap point's XZ, return the stack-on-top Y.
   */
  function findSnapY(
    sx: number, sz: number,
    newKind: CabinPieceKind,
    placed: ReadonlyArray<PlacedCabinPiece>,
  ): { x: number; y: number; z: number } | null {
    /* Euclidean threshold — the cursor must be genuinely OVER the placed piece's
     * top snap point (within TOP_SNAP_DIST). Manhattan over a 4.5 m radius (the
     * old behavior) caused every nearby foundation's top snap to compete with
     * lateral, so the new floor would stack on top of an adjacent foundation
     * instead of extending flush. Strict overlap matches GoE's intent. */
    let bestDist = TOP_SNAP_DIST;
    let best: { x: number; y: number; z: number } | null = null;
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i]!;
      const snaps = getCabinPieceSnapPoints(p.kind);
      const cosR = Math.cos(p.rotY);
      const sinR = Math.sin(p.rotY);
      for (const sp of snaps) {
        if (sp.direction !== 'top') continue;
        if (!sp.accepts.includes(newKind)) continue;
        const wx = p.x + sp.offset.x * cosR - sp.offset.z * sinR;
        const wz = p.z + sp.offset.x * sinR + sp.offset.z * cosR;
        const wy = p.y + sp.offset.y;
        const dist = Math.hypot(sx - wx, sz - wz);
        if (dist < bestDist) {
          bestDist = dist;
          best = { x: wx, y: wy, z: wz };
        }
      }
    }
    return best;
  }

  return {
    enter(kind, tier) {
      /* Drop any prior ghost first (defensive — prevent leaks if caller forgets to
       * cancel before a fresh enter). */
      if (ghostGroup) {
        opts.scene.remove(ghostGroup);
        ghostGroup = null;
      }
      active = true;
      activeKind = kind;
      activeTier = tier;
      ghostRotY = 0;
      lastValid = null;
      ghostGroup = buildGhost(kind, tier);
      opts.scene.add(ghostGroup);
      return true;
    },

    update(camera) {
      if (!active || !ghostGroup || !activeKind) return;
      /* Center-ray raycast against terrain + placed pieces. */
      const hit = raycastCursor(camera);
      if (!hit) return; /* keep last known position */
      /* Grid-snap the cursor XZ. */
      const sx = snapToGrid(hit.x);
      const sz = snapToGrid(hit.z);
      const placed = opts.getPlacedPieces();
      /* Lateral cardinal-edge snap from existing pieces' snap points. */
      const lateralSnap = findSnapXZ(sx, sz, activeKind, placed);
      /* Top-stack snap for "place on top" attachments. */
      const topSnap = findSnapY(sx, sz, activeKind, placed);
      /* Choose between snaps + grid. Three cases (in priority order):
       *   1. Same-kind lateral wins outright — floor-to-floor, wall-to-wall,
       *      ceiling-to-ceiling, etc. always extend flush, never stack. This is
       *      the GoE-style "deck extension" behavior the player expects when
       *      placing a same-kind piece next to one that's already there.
       *   2. Otherwise, prefer the closer-to-cursor of (lateral, top) candidates
       *      (matches GoE's general "closer-to-cursor wins" rule).
       *   3. No snap → fall back to grid-snapped XZ on terrain.
       */
      let finalX = lateralSnap ? lateralSnap.x : sx;
      let finalZ = lateralSnap ? lateralSnap.z : sz;
      let finalY = lateralSnap ? lateralSnap.y : opts.getTerrainHeight(finalX, finalZ);
      if (lateralSnap?.sameKind) {
        /* Same-kind lateral always wins; do NOT consider the top snap.
         * This is what makes "place a floor next to another floor" actually
         * land flush at the same Y level instead of stacking on the existing
         * foundation's top snap underneath. */
      } else if (topSnap) {
        const lateralDist = Math.hypot(finalX - hit.x, finalZ - hit.z);
        const topDist = Math.hypot(topSnap.x - hit.x, topSnap.z - hit.z);
        if (topDist < lateralDist) {
          finalX = topSnap.x;
          finalY = topSnap.y;
          finalZ = topSnap.z;
        }
      }
      ghostX = finalX;
      ghostY = finalY;
      ghostZ = finalZ;
      ghostGroup.position.set(finalX, finalY, finalZ);
      ghostGroup.rotation.y = ghostRotY;
      const valid = isPlacementValid(finalX, finalZ);
      applyValidityTint(valid);
    },

    confirm() {
      if (!active || !ghostGroup || !activeKind || !activeTier) return false;
      if (!isPlacementValid(ghostX, ghostZ)) return false;
      const placed = opts.onConfirmPlace(activeKind, activeTier, ghostX, ghostY, ghostZ, ghostRotY);
      if (!placed) return false; /* store rejected — likely missing materials */
      /* Stay in build mode after a successful place — common UX for stacking many
       * walls in a row. Caller can cancel manually with Esc when done. We rebuild the
       * ghost so the new piece is visible in the live scene + the next ghost still
       * shows. The active rotation persists across placements (R / wheel hold). */
      opts.scene.remove(ghostGroup);
      ghostGroup = buildGhost(activeKind, activeTier);
      opts.scene.add(ghostGroup);
      lastValid = null;
      return true;
    },

    cancel() {
      if (!active) return;
      active = false;
      activeKind = null;
      activeTier = null;
      lastValid = null;
      if (ghostGroup) {
        opts.scene.remove(ghostGroup);
        ghostGroup = null;
      }
    },

    isActive() {
      return active;
    },

    rotateBy(radians) {
      if (!active) return;
      ghostRotY += radians;
      while (ghostRotY > Math.PI) ghostRotY -= Math.PI * 2;
      while (ghostRotY < -Math.PI) ghostRotY += Math.PI * 2;
    },

    getActiveSelection() {
      if (!active || !activeKind || !activeTier) return null;
      return { kind: activeKind, tier: activeTier };
    },

    dispose() {
      if (ghostGroup && ghostGroup.parent) ghostGroup.parent.remove(ghostGroup);
      ghostGroup = null;
      active = false;
    },
  };
}

/* ============================================================================
 * Snap-pipeline helpers
 * ============================================================================ */

/**
 * Convert a cardinal `SnapDirection` to a unit world XZ vector under a placed piece's
 * `rotY` rotation. Returns null for `top`/`bottom` (those use Y stacking, not lateral).
 */
function cardinalToWorld(dir: SnapPoint['direction'], rotY: number): { x: number; z: number } | null {
  /* Local cardinal vectors (piece-local +Z is "north"; +X is "east"). */
  let lx = 0, lz = 0;
  switch (dir) {
    case 'north': lz = 1; break;
    case 'south': lz = -1; break;
    case 'east': lx = 1; break;
    case 'west': lx = -1; break;
    default: return null;
  }
  const cosR = Math.cos(rotY);
  const sinR = Math.sin(rotY);
  return {
    x: lx * cosR - lz * sinR,
    z: lx * sinR + lz * cosR,
  };
}

/**
 * Project a piece's half-extent onto a world-XZ direction. Used to offset the new
 * piece's center away from the snap point by its own half-extent so the edges meet.
 */
function projectHalfExtentOnDir(kind: CabinPieceKind, dir: { x: number; z: number }): number {
  const ext = getCabinPieceHalfExtents(kind);
  /* Approximate with the larger of the two — for square/symmetric pieces this is
   * correct; for elongated pieces it overestimates slightly so adjacent walls leave
   * a hairline gap rather than overlapping. */
  return Math.abs(dir.x) * ext.halfW + Math.abs(dir.z) * ext.halfD;
}

/* ============================================================================
 * Craft-station build-mode controller (Phase 2 — see
 * docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md §9 + the multi-instance station plan
 * in `docs/SESSION_2026_04_18_BUILDING_AND_PENDING.md` "Pending work" §1).
 *
 * Sibling of `createBuildModeController` (cabin pieces). Stations are simpler:
 *
 *   - **No tier axis.** A campfire is a campfire — no rough-log → platinum-band
 *     reskin chain (yet). The picker UI shows kinds only.
 *   - **No cardinal-edge snap pipeline.** Stations don't have snap points —
 *     a campfire next to another campfire shouldn't snap; they're discrete camp
 *     items. Placement is GRID-snapped only (1.5 m grid via the shared
 *     GRID_SIZE constant).
 *   - **Validity uses the collision world.** Instead of the cabin's
 *     `Math.hypot(p.x - x, p.z - z) < COLLISION_MIN_DIST` heuristic (which would
 *     wrongly reject a campfire placed 0.5 m from a tree it's well clear of),
 *     this controller calls `collisionWorld.overlaps(candidateFootprint)` —
 *     which knows about every cabin piece, station, tree, ore, mob, and the
 *     player. This is the same gate the GoE BuildModeSystem uses.
 *
 * **Future floor-top snap (deferred — `SESSION_2026_04_18_BUILDING_AND_PENDING.md`
 * "Pending work" §2):** when we want stations to snap onto cabin floor / foundation
 * top snap points, this controller can grow a `findStationSnapY` step that walks
 * placed cabin pieces' `top` snap points the same way `findSnapY` does, and
 * extends those snap points' `accepts` arrays to include the station kinds. Out
 * of scope for the first ship.
 * ============================================================================ */

export interface StationBuildModeController {
  /** Enter placement mode for a station kind. Returns false if the player has no
   * inventory of the materials needed. */
  enter(kind: PlacedCraftStationKind): boolean;
  /** Per-frame integrator (matches cabin controller; cheap when not active). */
  update(camera: THREE.Camera): void;
  /** Wired from LMB (and E for legacy). Calls `placeCraftStation` on the store. */
  confirm(): boolean;
  /** Drops the ghost without state change. Wired from Esc. */
  cancel(): void;
  /** True from `enter()` until `confirm()` succeeds OR `cancel()` runs. */
  isActive(): boolean;
  /** R sends ±90°, mouse wheel sends ±15°. */
  rotateBy(radians: number): void;
  /** Read-only: the station kind currently being placed (null when inactive). */
  getActiveSelection(): { kind: PlacedCraftStationKind } | null;
  /** Detach ghost group; safe to call before host scene dispose. */
  dispose(): void;
}

export interface StationBuildModeOptions {
  scene: THREE.Scene;
  /** Heightfield sampler — same one the cabin controller / free-roam controls use. */
  getTerrainHeight: (x: number, z: number) => number;
  /** Largest XZ radius the player can place inside (matches dock map radius). */
  mapRadius: number;
  /** Returns true if the given XZ is over water (no campfires on water). */
  isWaterAt: (x: number, z: number) => boolean;
  /** Build a fresh ghost-mesh template Group for the station kind. */
  buildPieceTemplate: (kind: PlacedCraftStationKind) => THREE.Group;
  /** Snapshot of currently placed stations — used for cursor placement readbacks. */
  getPlacedStations: () => ReadonlyArray<PlacedCraftStation>;
  /** Snapshot of placed cabin pieces — used for raycast targets so the cursor lands
   * on top of a floor / foundation when the player aims there. (Snap-to-floor-top
   * is deferred; until then the cursor still RAYCASTS against pieces so the ghost
   * doesn't sink into them visually.) */
  getPlacedCabinPieces: () => ReadonlyArray<PlacedCabinPiece>;
  /** Authoritative collision world — used for the placement validity gate. */
  collisionWorld: CollisionWorldHandle;
  /** Called on LMB confirm. Returns the placed station, or null if the store
   * rejected (e.g. missing materials — UI is responsible for affordability gating
   * before `enter()`, but the store re-checks defensively). */
  onConfirmPlace: (
    kind: PlacedCraftStationKind,
    x: number, y: number, z: number, rotY: number,
  ) => PlacedCraftStation | null;
  /** Optional validity-change callback for HUD prompts. */
  onValidityChange?: (valid: boolean) => void;
}

export function createStationBuildModeController(opts: StationBuildModeOptions): StationBuildModeController {
  let active = false;
  let activeKind: PlacedCraftStationKind | null = null;
  let ghostGroup: THREE.Group | null = null;
  let lastValid: boolean | null = null;
  let ghostRotY = 0;
  let ghostX = 0;
  let ghostY = 0;
  let ghostZ = 0;

  const raycaster = new THREE.Raycaster();
  raycaster.far = MAX_PLACE_DIST;
  const ndcCenter = new THREE.Vector2(0, 0);
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const tmpHit = new THREE.Vector3();
  const tmpBoxMin = new THREE.Vector3();
  const tmpBoxMax = new THREE.Vector3();
  const tmpBox = new THREE.Box3();
  const tmpCamPos = new THREE.Vector3();
  /* Reused candidate footprint for the validity-gate overlap test. Typed as the
   * rect variant explicitly so we can mutate `halfW` / `halfD` / `rotY` in
   * place without TS narrowing complaints. Filled per call so we don't
   * allocate per frame in the hot path. */
  const candidateFp: Extract<Footprint, { kind: 'rect' }> = {
    kind: 'rect',
    x: 0,
    z: 0,
    halfW: 0,
    halfD: 0,
    rotY: 0,
    ownerId: '__station_ghost__',
    blocking: true,
    tag: 'static',
  };

  function applyValidityTint(valid: boolean): void {
    if (!ghostGroup) return;
    if (lastValid === valid) return;
    lastValid = valid;
    const mat = valid ? GHOST_VALID_MAT : GHOST_INVALID_MAT;
    ghostGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = mat;
    });
    opts.onValidityChange?.(valid);
  }

  function buildGhost(kind: PlacedCraftStationKind): THREE.Group {
    const tmpl = opts.buildPieceTemplate(kind);
    tmpl.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.material = GHOST_VALID_MAT;
        m.castShadow = false;
        m.receiveShadow = false;
      }
    });
    return tmpl;
  }

  function isPlacementValid(x: number, z: number, kind: PlacedCraftStationKind, rotY: number, y: number): boolean {
    if (Math.hypot(x, z) > opts.mapRadius - MAP_EDGE_BUFFER) return false;
    if (opts.isWaterAt(x, z)) return false;
    const ext = getCraftStationHalfExtents(kind);
    /* Fill the reused candidate footprint and ask the collision world if it
     * overlaps anything blocking. Y-extent is honored — pieces whose vertical
     * range doesn't intersect the ghost are skipped (e.g. roof tiles 2 m up
     * don't reject a ground-level campfire). */
    candidateFp.x = x;
    candidateFp.z = z;
    candidateFp.halfW = ext.halfW;
    candidateFp.halfD = ext.halfD;
    candidateFp.rotY = rotY;
    candidateFp.bottomY = y;
    candidateFp.topY = y + ext.halfH * 2;
    return !opts.collisionWorld.overlaps(candidateFp);
  }

  function snapToGrid(v: number): number {
    return Math.round(v / GRID_SIZE) * GRID_SIZE;
  }

  /**
   * Center-ray raycast (NDC center) against terrain plane + placed cabin / station
   * AABBs. Same shape as the cabin controller's `raycastCursor`. Stations don't
   * snap to each other but they should still be CURSOR-TARGETABLE so the ghost
   * sits on top visually when the player aims at one (placement will then be
   * rejected by the validity gate; this keeps the cursor responsive).
   */
  function raycastCursor(camera: THREE.Camera): { x: number; y: number; z: number } | null {
    raycaster.setFromCamera(ndcCenter, camera);
    camera.getWorldPosition(tmpCamPos);
    groundPlane.constant = -opts.getTerrainHeight(tmpCamPos.x, tmpCamPos.z);
    let bestT: number = Infinity;
    let bestHit: { x: number; y: number; z: number } | null = null;
    const gp = raycaster.ray.intersectPlane(groundPlane, tmpHit);
    if (gp) {
      const dist = tmpHit.distanceTo(tmpCamPos);
      if (dist < MAX_PLACE_DIST && dist < bestT) {
        bestT = dist;
        bestHit = { x: tmpHit.x, y: tmpHit.y, z: tmpHit.z };
      }
    }
    /* AABB test against placed cabin pieces — same conservative inscribed-rotation
     * envelope as the cabin controller. */
    const pieces = opts.getPlacedCabinPieces();
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]!;
      const ext = getCabinPieceHalfExtents(p.kind);
      const rEnv = Math.max(ext.halfW, ext.halfD);
      tmpBoxMin.set(p.x - rEnv, p.y - ext.halfH, p.z - rEnv);
      tmpBoxMax.set(p.x + rEnv, p.y + ext.halfH, p.z + rEnv);
      tmpBox.set(tmpBoxMin, tmpBoxMax);
      const hit = raycaster.ray.intersectBox(tmpBox, tmpHit);
      if (!hit) continue;
      const dist = tmpHit.distanceTo(tmpCamPos);
      if (dist < bestT) {
        bestT = dist;
        bestHit = { x: tmpHit.x, y: tmpHit.y, z: tmpHit.z };
      }
    }
    /* AABB test against placed stations. */
    const stations = opts.getPlacedStations();
    for (let i = 0; i < stations.length; i++) {
      const s = stations[i]!;
      const ext = getCraftStationHalfExtents(s.kind);
      const rEnv = Math.max(ext.halfW, ext.halfD);
      tmpBoxMin.set(s.x - rEnv, s.y, s.z - rEnv);
      tmpBoxMax.set(s.x + rEnv, s.y + ext.halfH * 2, s.z + rEnv);
      tmpBox.set(tmpBoxMin, tmpBoxMax);
      const hit = raycaster.ray.intersectBox(tmpBox, tmpHit);
      if (!hit) continue;
      const dist = tmpHit.distanceTo(tmpCamPos);
      if (dist < bestT) {
        bestT = dist;
        bestHit = { x: tmpHit.x, y: tmpHit.y, z: tmpHit.z };
      }
    }
    return bestHit;
  }

  /**
   * Floor-top snap helper (Phase 8h pending pass — see Phase 8e PLAN
   * "Stations placeable on cabin floors"). Walks placed cabin pieces and
   * returns the HIGHEST top-Y of any `foundation` or `floor` whose XZ
   * footprint contains the snapped point. Returns null when no qualifying
   * piece is in range so the caller falls back to terrain Y.
   *
   * Rotation-aware: transforms the query point into each piece's local space
   * via `-rotY` so rotated foundations / floors still snap correctly. Top-Y
   * uses `getCabinPieceHalfExtents(kind).halfH * 2 + p.y` (the full piece
   * height above its base).
   *
   * Restricting to `foundation` + `floor` is intentional — players don't
   * want a campfire snapping to a wall top or roof slope. If a future
   * polish pass wants ceiling-mounted decor, add the kind to this allow-list.
   */
  function findCabinFloorTopAt(x: number, z: number): number | null {
    const pieces = opts.getPlacedCabinPieces();
    let bestTop: number | null = null;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]!;
      if (p.kind !== 'foundation' && p.kind !== 'floor') continue;
      const ext = getCabinPieceHalfExtents(p.kind);
      /* Rotate query point into the piece's local frame to handle non-axis-
       * aligned placements. atan2 yaw convention matches `placeCabinPiece`. */
      const cosR = Math.cos(-p.rotY);
      const sinR = Math.sin(-p.rotY);
      const lx = (x - p.x) * cosR - (z - p.z) * sinR;
      const lz = (x - p.x) * sinR + (z - p.z) * cosR;
      if (Math.abs(lx) > ext.halfW || Math.abs(lz) > ext.halfD) continue;
      const topY = p.y + ext.halfH * 2;
      if (bestTop == null || topY > bestTop) bestTop = topY;
    }
    return bestTop;
  }

  return {
    enter(kind) {
      if (ghostGroup) {
        opts.scene.remove(ghostGroup);
        ghostGroup = null;
      }
      active = true;
      activeKind = kind;
      ghostRotY = 0;
      lastValid = null;
      ghostGroup = buildGhost(kind);
      opts.scene.add(ghostGroup);
      return true;
    },

    update(camera) {
      if (!active || !ghostGroup || !activeKind) return;
      const hit = raycastCursor(camera);
      if (!hit) return;
      const sx = snapToGrid(hit.x);
      const sz = snapToGrid(hit.z);
      /* Floor-top snap (Phase 8h): if a placed cabin foundation or floor
       * piece covers the snapped XZ, place the station ON TOP of that piece
       * instead of on terrain. Picks the HIGHEST surface so stacked
       * foundation+floor reads as floor-top. Falls through to terrain when
       * no qualifying surface is in range. */
      const floorTopY = findCabinFloorTopAt(sx, sz);
      const y = floorTopY != null ? floorTopY : opts.getTerrainHeight(sx, sz);
      ghostX = sx;
      ghostY = y;
      ghostZ = sz;
      ghostGroup.position.set(sx, y, sz);
      ghostGroup.rotation.y = ghostRotY;
      const valid = isPlacementValid(sx, sz, activeKind, ghostRotY, y);
      applyValidityTint(valid);
    },

    confirm() {
      if (!active || !ghostGroup || !activeKind) return false;
      if (!isPlacementValid(ghostX, ghostZ, activeKind, ghostRotY, ghostY)) return false;
      const placed = opts.onConfirmPlace(activeKind, ghostX, ghostY, ghostZ, ghostRotY);
      if (!placed) return false;
      /* Stay in placement mode after a successful place — UX matches the cabin
       * controller (good for stacking many campfires across a camp). Rebuild
       * the ghost so the next placement preview is fresh + the just-placed
       * station is visible in the live scene. Active rotation persists. */
      opts.scene.remove(ghostGroup);
      ghostGroup = buildGhost(activeKind);
      opts.scene.add(ghostGroup);
      lastValid = null;
      return true;
    },

    cancel() {
      if (!active) return;
      active = false;
      activeKind = null;
      lastValid = null;
      if (ghostGroup) {
        opts.scene.remove(ghostGroup);
        ghostGroup = null;
      }
    },

    isActive() {
      return active;
    },

    rotateBy(radians) {
      if (!active) return;
      ghostRotY += radians;
      while (ghostRotY > Math.PI) ghostRotY -= Math.PI * 2;
      while (ghostRotY < -Math.PI) ghostRotY += Math.PI * 2;
    },

    getActiveSelection() {
      if (!active || !activeKind) return null;
      return { kind: activeKind };
    },

    dispose() {
      if (ghostGroup && ghostGroup.parent) ghostGroup.parent.remove(ghostGroup);
      ghostGroup = null;
      active = false;
    },
  };
}
