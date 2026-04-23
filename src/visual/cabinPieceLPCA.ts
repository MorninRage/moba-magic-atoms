/**
 * Per-kind LPCA builders for awakened-mode log-cabin pieces (Phase 1 of the base-building
 * system — see `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md`).
 *
 * **Visual identity rule (locked):** every tier reads as LOG CABIN. The dominant
 * silhouette is stacked horizontal logs (small cylinders); bands and runes are accents
 * that sit AROUND the logs, never replace them. This rule holds across all kinds: a
 * platinum-tier wall is still recognizably a log wall, just with bioluminescent
 * platinum bands wrapping the corner joints. Lore tie-in: `LORE.md` §11.
 *
 * **Grid:** all pieces snap to the 1.5 m XZ grid (matches GoE's `BuildModeSystem`
 * GRID_SIZE constant — chosen because it matches the dock map's natural scale where
 * a stacked-log wall reads ~1 m thick and the avatar is ~1.8 m tall).
 *
 * **Geometry sharing:** every builder pulls cached geometries from `geometryCache`
 * below so InstancedMesh + mergeByMaterial collapse the entire base scatter to a
 * flat draw-call count. A 200-piece cabin = ~12 unique materials × ~5 unique
 * geometries = ~12 draw calls regardless of piece count.
 *
 * **MVP set (Phase 1):** `foundation, wall_solid, wall_window, wall_doorway, door,
 * floor, roof_slope`. The other kinds (`pillar, ceiling, roof_peak, stairs, gate,
 * ladder`) ship with simpler placeholder geometry — fully playable but visually less
 * polished. Polish loop is a Phase 1.5 follow-up.
 */
import * as THREE from 'three';
import type { CabinMaterialTier, CabinPieceKind, SnapPoint } from '../core/types';
import { cabinBand, cabinLog, cabinRune } from './magicalCabinMaterials';

/* ============================================================================
 * Snap point data (Phase 1.5 — see docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md §2.1)
 *
 * Per-kind hand-authored snap points. Each entry is in piece-LOCAL coordinates (no
 * world transform applied). The build-mode controller's `findSnapXZ` + `findSnapY`
 * pipeline rotates these by the placed piece's `rotY` to find candidate attachments
 * for the next piece being placed.
 *
 * Convention: piece-local origin sits at the piece's footprint center on the ground
 * plane. `+Y` is up. `+Z` is "north" (the piece's local front). Walls are oriented so
 * their span is along ±X — north/south snaps sit in front/behind, east/west sit at the
 * left/right ends.
 *
 * The numbers below match the geometry built by the per-kind builders in this file
 * (1.5 m wide foundation/wall, 0.68 m wall height, etc.).
 * ============================================================================ */

const HALF_GRID = 0.75; /* half of the 1.5 m grid step */
const WALL_HEIGHT = 0.68; /* ~ WALL_LOG_COUNT * LOG_DIAMETER below */
const FOUNDATION_HEIGHT = 0.15;

const CABIN_SNAP_POINTS: Record<CabinPieceKind, SnapPoint[]> = {
  /* Foundation: 4 cardinal-edge snaps (accept walls), 1 top-center snap (accept floor /
   * pillar / next-tier foundation). Edge snaps sit at the foundation's top surface so
   * walls stack correctly above. */
  foundation: [
    { offset: { x: 0, y: FOUNDATION_HEIGHT, z: 0 }, direction: 'top',
      accepts: ['floor', 'pillar', 'wall_solid', 'wall_window', 'wall_doorway', 'foundation'] },
    { offset: { x: 0, y: FOUNDATION_HEIGHT, z: HALF_GRID }, direction: 'north',
      accepts: ['wall_solid', 'wall_window', 'wall_doorway'] },
    { offset: { x: 0, y: FOUNDATION_HEIGHT, z: -HALF_GRID }, direction: 'south',
      accepts: ['wall_solid', 'wall_window', 'wall_doorway'] },
    { offset: { x: HALF_GRID, y: FOUNDATION_HEIGHT, z: 0 }, direction: 'east',
      accepts: ['wall_solid', 'wall_window', 'wall_doorway'] },
    { offset: { x: -HALF_GRID, y: FOUNDATION_HEIGHT, z: 0 }, direction: 'west',
      accepts: ['wall_solid', 'wall_window', 'wall_doorway'] },
  ],
  /* Pillar: 4 cardinal mid-height snaps (accept beams / lateral walls) + top (accept
   * pillar above for stacking). */
  pillar: [
    { offset: { x: 0, y: WALL_HEIGHT * 2, z: 0 }, direction: 'top',
      accepts: ['pillar', 'roof_slope', 'roof_peak', 'ceiling'] },
    { offset: { x: 0, y: WALL_HEIGHT, z: HALF_GRID }, direction: 'north',
      accepts: ['wall_solid', 'wall_window'] },
    { offset: { x: 0, y: WALL_HEIGHT, z: -HALF_GRID }, direction: 'south',
      accepts: ['wall_solid', 'wall_window'] },
    { offset: { x: HALF_GRID, y: WALL_HEIGHT, z: 0 }, direction: 'east',
      accepts: ['wall_solid', 'wall_window'] },
    { offset: { x: -HALF_GRID, y: WALL_HEIGHT, z: 0 }, direction: 'west',
      accepts: ['wall_solid', 'wall_window'] },
  ],
  /* Wall_solid: top-center snap (accept ceiling / next-row wall) + 2 side snaps for
   * adjacent walls extending the perimeter. */
  wall_solid: [
    { offset: { x: 0, y: WALL_HEIGHT, z: 0 }, direction: 'top',
      accepts: ['wall_solid', 'wall_window', 'wall_doorway', 'ceiling', 'roof_slope'] },
    { offset: { x: HALF_GRID, y: 0, z: 0 }, direction: 'east',
      accepts: ['wall_solid', 'wall_window', 'wall_doorway', 'pillar'] },
    { offset: { x: -HALF_GRID, y: 0, z: 0 }, direction: 'west',
      accepts: ['wall_solid', 'wall_window', 'wall_doorway', 'pillar'] },
  ],
  wall_window: [
    { offset: { x: 0, y: WALL_HEIGHT, z: 0 }, direction: 'top',
      accepts: ['wall_solid', 'wall_window', 'wall_doorway', 'ceiling', 'roof_slope'] },
    { offset: { x: HALF_GRID, y: 0, z: 0 }, direction: 'east',
      accepts: ['wall_solid', 'wall_window', 'wall_doorway', 'pillar'] },
    { offset: { x: -HALF_GRID, y: 0, z: 0 }, direction: 'west',
      accepts: ['wall_solid', 'wall_window', 'wall_doorway', 'pillar'] },
  ],
  wall_doorway: [
    { offset: { x: 0, y: WALL_HEIGHT, z: 0 }, direction: 'top',
      accepts: ['wall_solid', 'wall_window', 'wall_doorway', 'ceiling', 'roof_slope'] },
    { offset: { x: HALF_GRID, y: 0, z: 0 }, direction: 'east',
      accepts: ['wall_solid', 'wall_window', 'wall_doorway', 'pillar'] },
    { offset: { x: -HALF_GRID, y: 0, z: 0 }, direction: 'west',
      accepts: ['wall_solid', 'wall_window', 'wall_doorway', 'pillar'] },
    /* Doorway also accepts a door swung in via its center bottom. */
    { offset: { x: 0, y: 0, z: 0 }, direction: 'bottom', accepts: ['door'] },
  ],
  /* Door: no outgoing snaps (terminal piece — nothing attaches to a door). */
  door: [],
  /* Floor: 4 edge snaps for adjacent floors (extend the deck) + top for ceiling. */
  floor: [
    { offset: { x: 0, y: 0.05, z: 0 }, direction: 'top',
      accepts: ['ceiling', 'wall_solid', 'wall_window', 'wall_doorway', 'pillar'] },
    { offset: { x: 0, y: 0, z: HALF_GRID }, direction: 'north', accepts: ['floor'] },
    { offset: { x: 0, y: 0, z: -HALF_GRID }, direction: 'south', accepts: ['floor'] },
    { offset: { x: HALF_GRID, y: 0, z: 0 }, direction: 'east', accepts: ['floor'] },
    { offset: { x: -HALF_GRID, y: 0, z: 0 }, direction: 'west', accepts: ['floor'] },
  ],
  ceiling: [
    { offset: { x: 0, y: 0.05, z: 0 }, direction: 'top', accepts: ['roof_slope', 'roof_peak'] },
    { offset: { x: 0, y: 0, z: HALF_GRID }, direction: 'north', accepts: ['ceiling'] },
    { offset: { x: 0, y: 0, z: -HALF_GRID }, direction: 'south', accepts: ['ceiling'] },
    { offset: { x: HALF_GRID, y: 0, z: 0 }, direction: 'east', accepts: ['ceiling'] },
    { offset: { x: -HALF_GRID, y: 0, z: 0 }, direction: 'west', accepts: ['ceiling'] },
  ],
  /* Roof slope: 1 top-center snap (accept roof_peak forming the apex) + 2 side snaps
   * for chaining slopes laterally to extend a roof line. */
  roof_slope: [
    { offset: { x: 0, y: 1.05, z: -0.45 }, direction: 'top', accepts: ['roof_peak'] },
    { offset: { x: HALF_GRID, y: 0.45, z: 0 }, direction: 'east', accepts: ['roof_slope'] },
    { offset: { x: -HALF_GRID, y: 0.45, z: 0 }, direction: 'west', accepts: ['roof_slope'] },
  ],
  /* Roof peak: 2 lateral snaps for chaining peaks across a long roof. */
  roof_peak: [
    { offset: { x: HALF_GRID, y: 0, z: 0 }, direction: 'east', accepts: ['roof_peak'] },
    { offset: { x: -HALF_GRID, y: 0, z: 0 }, direction: 'west', accepts: ['roof_peak'] },
  ],
  /* Stairs: top connects to next-floor walkable. */
  stairs: [
    { offset: { x: 0, y: 0.54, z: 0.45 }, direction: 'top',
      accepts: ['floor', 'foundation', 'wall_solid'] },
  ],
  /* Gate: same as door — terminal piece. */
  gate: [],
  /* Ladder: top connects to a floor above. */
  ladder: [
    { offset: { x: 0, y: 2.2, z: 0 }, direction: 'top', accepts: ['floor', 'ceiling'] },
  ],
};

/**
 * Snap points for a given piece kind (in piece-LOCAL coordinates). Returns the shared
 * array reference — DO NOT MUTATE the result; it's the canonical data.
 */
export function getCabinPieceSnapPoints(kind: CabinPieceKind): ReadonlyArray<SnapPoint> {
  return CABIN_SNAP_POINTS[kind];
}

/**
 * Footprint half-extents per piece kind (in piece-LOCAL coordinates). Used by the
 * build-mode controller's AABB raycast hit test (so the cursor can land ON a placed
 * piece's footprint to drive snap candidates).
 */
export function getCabinPieceHalfExtents(kind: CabinPieceKind): { halfW: number; halfD: number; halfH: number } {
  switch (kind) {
    case 'foundation': return { halfW: 0.75, halfD: 0.75, halfH: 0.075 };
    case 'pillar': return { halfW: 0.12, halfD: 0.12, halfH: 1.2 };
    case 'wall_solid':
    case 'wall_window':
    case 'wall_doorway': return { halfW: 0.75, halfD: 0.12, halfH: WALL_HEIGHT * 0.5 };
    case 'door': return { halfW: 0.35, halfD: 0.05, halfH: 0.9 };
    case 'floor': return { halfW: 0.75, halfD: 0.75, halfH: 0.025 };
    case 'ceiling': return { halfW: 0.75, halfD: 0.75, halfH: 0.025 };
    case 'roof_slope': return { halfW: 0.75, halfD: 1.0, halfH: 0.4 };
    case 'roof_peak': return { halfW: 0.75, halfD: 1.0, halfH: 0.4 };
    case 'stairs': return { halfW: 0.75, halfD: 0.5, halfH: 0.27 };
    case 'gate': return { halfW: 0.7, halfD: 0.05, halfH: 0.975 };
    case 'ladder': return { halfW: 0.22, halfD: 0.05, halfH: 1.1 };
  }
}

/* ============================================================================
 * Geometry cache — shared across all instances of every kind+tier combination
 * ============================================================================ */

interface GeometryCache {
  /** Single horizontal log used by walls + roof slats. Length = 1.5 m, radius = 0.085 m. */
  logHorizontal: THREE.CylinderGeometry;
  /** Half-length log for the wall_window cutout uppers. */
  logHorizontalHalf: THREE.CylinderGeometry;
  /** Foundation slab — 1.5 × 0.15 × 1.5 m. */
  foundationSlab: THREE.BoxGeometry;
  /** Floor tile — 1.5 × 0.05 × 1.5 m sits on top of foundation. */
  floorTile: THREE.BoxGeometry;
  /** Door panel — 0.7 × 1.8 × 0.05 m. */
  doorPanel: THREE.BoxGeometry;
  /** Roof slope panel — 1.5 × 0.08 × 2.0 m. */
  roofSlopePanel: THREE.BoxGeometry;
  /** Corner band ring — small torus that wraps a log end at corners. */
  cornerBand: THREE.TorusGeometry;
  /** Rune trace — thin box that sits along a band, glows. */
  runeTrace: THREE.BoxGeometry;
  /** Pillar log — vertical, 0.15 × 2.4 × 0.15 m. */
  pillar: THREE.CylinderGeometry;
}

let _geometryCache: GeometryCache | null = null;

function getGeometryCache(): GeometryCache {
  if (_geometryCache) return _geometryCache;
  _geometryCache = {
    logHorizontal: new THREE.CylinderGeometry(0.085, 0.085, 1.5, 8),
    logHorizontalHalf: new THREE.CylinderGeometry(0.085, 0.085, 0.65, 8),
    foundationSlab: new THREE.BoxGeometry(1.5, 0.15, 1.5),
    floorTile: new THREE.BoxGeometry(1.5, 0.05, 1.5),
    doorPanel: new THREE.BoxGeometry(0.7, 1.8, 0.05),
    roofSlopePanel: new THREE.BoxGeometry(1.5, 0.08, 2.0),
    cornerBand: new THREE.TorusGeometry(0.11, 0.018, 6, 12),
    runeTrace: new THREE.BoxGeometry(0.04, 0.012, 0.4),
    pillar: new THREE.CylinderGeometry(0.09, 0.11, 2.4, 10),
  };
  /* Rotate the horizontal-log geometries once so meshes can use the cylinder along Z
   * without per-instance rotation. */
  _geometryCache.logHorizontal.rotateZ(Math.PI / 2);
  _geometryCache.logHorizontalHalf.rotateZ(Math.PI / 2);
  return _geometryCache;
}

/** Wall stack count — 4 logs from base to lintel = 1.6 m wall height (with floor + thatch ≈ 2 m room). */
const WALL_LOG_COUNT = 4;
const LOG_DIAMETER = 0.17; /* 2 × radius */
const WALL_TOTAL_HEIGHT = WALL_LOG_COUNT * LOG_DIAMETER; /* ~0.68 m — short cabin; tunable later */

/* ============================================================================
 * Public dispatcher
 * ============================================================================ */

/**
 * Build one cabin-piece LPCA at world origin (no transform applied; caller positions
 * via `instance.position.set()` or `InstancedMesh.setMatrixAt`). Caller is responsible
 * for disposing the returned Group's geometries when truly removing — but in normal
 * operation, the geometries come from the shared cache and are NOT cloned, so disposing
 * a single instance would corrupt others. The intended lifecycle is: build template
 * once per (kind, tier) → mergeByMaterial → InstancedMesh; instance counts vary, but
 * the underlying geometry stays alive for the whole session.
 */
export function buildCabinPieceLPCA(kind: CabinPieceKind, tier: CabinMaterialTier): THREE.Group {
  switch (kind) {
    case 'foundation': return buildFoundation(tier);
    case 'wall_solid': return buildWallSolid(tier);
    case 'wall_window': return buildWallWindow(tier);
    case 'wall_doorway': return buildWallDoorway(tier);
    case 'door': return buildDoor(tier);
    case 'floor': return buildFloor(tier);
    case 'roof_slope': return buildRoofSlope(tier);
    case 'roof_peak': return buildRoofPeak(tier);
    case 'pillar': return buildPillar(tier);
    case 'ceiling': return buildCeiling(tier);
    case 'stairs': return buildStairs(tier);
    case 'gate': return buildGate(tier);
    case 'ladder': return buildLadder(tier);
  }
}

/* ============================================================================
 * Helpers — corner band stack + runes
 * ============================================================================ */

/**
 * Add 4 corner bands (torus rings) wrapping the log-stack ends at each corner of a
 * wall. T0/T1 skip this entirely (no banding visual at those tiers).
 */
function addCornerBands(group: THREE.Group, tier: CabinMaterialTier, halfWidth: number, baseY: number, topY: number): void {
  const band = cabinBand(tier);
  if (!band) return;
  const cache = getGeometryCache();
  const bandY = (baseY + topY) / 2;
  const bandHeight = topY - baseY;
  /* Stack 3 bands per corner (top, middle, bottom) for the higher tiers — adds visual
   * weight without exploding instance count. */
  const positions = [
    { x: -halfWidth, y: baseY + bandHeight * 0.15 },
    { x: -halfWidth, y: bandY },
    { x: -halfWidth, y: topY - bandHeight * 0.15 },
    { x: halfWidth, y: baseY + bandHeight * 0.15 },
    { x: halfWidth, y: bandY },
    { x: halfWidth, y: topY - bandHeight * 0.15 },
  ];
  for (const p of positions) {
    const m = new THREE.Mesh(cache.cornerBand, band);
    /* Torus default normal is +Z; rotate so the ring wraps the log (axis along X). */
    m.rotation.y = Math.PI / 2;
    m.position.set(p.x, p.y, 0);
    group.add(m);
  }
}

/**
 * Add rune-trace boxes glowing along the bands. T0/T1 skip; intensity scales with tier
 * (handled by the rune material itself). Two horizontal traces per wall corner.
 */
function addRunes(group: THREE.Group, tier: CabinMaterialTier, halfWidth: number, baseY: number, topY: number): void {
  const rune = cabinRune(tier);
  if (!rune) return;
  const cache = getGeometryCache();
  const midY = (baseY + topY) / 2;
  const positions = [
    { x: -halfWidth + 0.005, y: midY, rotZ: Math.PI / 2 },
    { x: halfWidth - 0.005, y: midY, rotZ: Math.PI / 2 },
  ];
  for (const p of positions) {
    const m = new THREE.Mesh(cache.runeTrace, rune);
    m.position.set(p.x, p.y, 0);
    m.rotation.z = p.rotZ;
    group.add(m);
  }
}

/* ============================================================================
 * Per-kind builders
 * ============================================================================ */

function buildFoundation(tier: CabinMaterialTier): THREE.Group {
  const g = new THREE.Group();
  g.name = 'cabin_foundation';
  const cache = getGeometryCache();
  const slab = new THREE.Mesh(cache.foundationSlab, cabinLog(tier));
  slab.position.y = 0.075;
  g.add(slab);
  /* Foundation gets band rings around its top edge for T2+. */
  const band = cabinBand(tier);
  if (band) {
    /* Four short cylinder caps at corners simulate metal corner-fittings. */
    const capGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.18, 8);
    const corners = [
      { x: -0.7, z: -0.7 }, { x: 0.7, z: -0.7 },
      { x: -0.7, z: 0.7 },  { x: 0.7, z: 0.7 },
    ];
    for (const c of corners) {
      const m = new THREE.Mesh(capGeo, band);
      m.position.set(c.x, 0.09, c.z);
      g.add(m);
    }
  }
  return g;
}

function buildWallStack(tier: CabinMaterialTier, halfLogLength: number, logCount = WALL_LOG_COUNT): THREE.Mesh[] {
  /* Returns N stacked horizontal logs as separate meshes — caller adds them to a Group
   * and supplies whatever cutouts (window, doorway) they want to skip. */
  const cache = getGeometryCache();
  const log = cabinLog(tier);
  const logs: THREE.Mesh[] = [];
  const fullLength = halfLogLength * 2;
  for (let i = 0; i < logCount; i++) {
    /* Geometry is rotated to lay along X (length 1.5). For non-1.5 widths, scale X. */
    const m = new THREE.Mesh(cache.logHorizontal, log);
    m.scale.x = fullLength / 1.5;
    m.position.y = LOG_DIAMETER * 0.5 + i * LOG_DIAMETER;
    logs.push(m);
  }
  return logs;
}

function buildWallSolid(tier: CabinMaterialTier): THREE.Group {
  const g = new THREE.Group();
  g.name = 'cabin_wall_solid';
  for (const log of buildWallStack(tier, 0.75)) g.add(log);
  addCornerBands(g, tier, 0.75, 0, WALL_TOTAL_HEIGHT);
  addRunes(g, tier, 0.75, 0, WALL_TOTAL_HEIGHT);
  return g;
}

function buildWallWindow(tier: CabinMaterialTier): THREE.Group {
  const g = new THREE.Group();
  g.name = 'cabin_wall_window';
  /* Bottom 2 logs full-length; top 2 split into half-logs flanking a window cutout. */
  const cache = getGeometryCache();
  const log = cabinLog(tier);
  for (let i = 0; i < 2; i++) {
    const m = new THREE.Mesh(cache.logHorizontal, log);
    m.position.y = LOG_DIAMETER * 0.5 + i * LOG_DIAMETER;
    g.add(m);
  }
  for (let i = 2; i < 4; i++) {
    /* Two half-logs (left + right of the window) for each upper row. */
    const left = new THREE.Mesh(cache.logHorizontalHalf, log);
    left.position.set(-0.425, LOG_DIAMETER * 0.5 + i * LOG_DIAMETER, 0);
    g.add(left);
    const right = new THREE.Mesh(cache.logHorizontalHalf, log);
    right.position.set(0.425, LOG_DIAMETER * 0.5 + i * LOG_DIAMETER, 0);
    g.add(right);
  }
  addCornerBands(g, tier, 0.75, 0, WALL_TOTAL_HEIGHT);
  addRunes(g, tier, 0.75, 0, WALL_TOTAL_HEIGHT);
  return g;
}

function buildWallDoorway(tier: CabinMaterialTier): THREE.Group {
  const g = new THREE.Group();
  g.name = 'cabin_wall_doorway';
  /* Bottom 3 rows split (left + right of doorway), top row full-length lintel. */
  const cache = getGeometryCache();
  const log = cabinLog(tier);
  for (let i = 0; i < 3; i++) {
    const left = new THREE.Mesh(cache.logHorizontalHalf, log);
    left.scale.x = 0.55; /* narrower than half */
    left.position.set(-0.55, LOG_DIAMETER * 0.5 + i * LOG_DIAMETER, 0);
    g.add(left);
    const right = new THREE.Mesh(cache.logHorizontalHalf, log);
    right.scale.x = 0.55;
    right.position.set(0.55, LOG_DIAMETER * 0.5 + i * LOG_DIAMETER, 0);
    g.add(right);
  }
  /* Lintel — full-length log over the doorway. */
  const lintel = new THREE.Mesh(cache.logHorizontal, log);
  lintel.position.y = LOG_DIAMETER * 0.5 + 3 * LOG_DIAMETER;
  g.add(lintel);
  addCornerBands(g, tier, 0.75, 0, WALL_TOTAL_HEIGHT);
  addRunes(g, tier, 0.75, 0, WALL_TOTAL_HEIGHT);
  return g;
}

function buildDoor(tier: CabinMaterialTier): THREE.Group {
  const g = new THREE.Group();
  g.name = 'cabin_door';
  const cache = getGeometryCache();
  const panel = new THREE.Mesh(cache.doorPanel, cabinLog(tier));
  panel.position.y = 0.9;
  g.add(panel);
  const band = cabinBand(tier);
  if (band) {
    /* Two iron straps across the door, evoking a heavy fortified door. */
    const strapGeo = new THREE.BoxGeometry(0.72, 0.06, 0.06);
    for (const y of [0.5, 1.3]) {
      const m = new THREE.Mesh(strapGeo, band);
      m.position.set(0, y, 0.04);
      g.add(m);
    }
  }
  const rune = cabinRune(tier);
  if (rune) {
    const traceGeo = new THREE.BoxGeometry(0.55, 0.012, 0.012);
    for (const y of [0.5, 1.3]) {
      const m = new THREE.Mesh(traceGeo, rune);
      m.position.set(0, y, 0.075);
      g.add(m);
    }
  }
  return g;
}

function buildFloor(tier: CabinMaterialTier): THREE.Group {
  const g = new THREE.Group();
  g.name = 'cabin_floor';
  const cache = getGeometryCache();
  /* Three plank logs side-by-side suggest a floor of split timbers. */
  const log = cabinLog(tier);
  const tile = new THREE.Mesh(cache.floorTile, log);
  tile.position.y = 0.025;
  g.add(tile);
  /* Plank seams — three thin stripes of band material across the tile (T2+). */
  const band = cabinBand(tier);
  if (band) {
    const seamGeo = new THREE.BoxGeometry(1.45, 0.005, 0.025);
    for (const z of [-0.5, 0, 0.5]) {
      const m = new THREE.Mesh(seamGeo, band);
      m.position.set(0, 0.052, z);
      g.add(m);
    }
  }
  return g;
}

function buildRoofSlope(tier: CabinMaterialTier): THREE.Group {
  const g = new THREE.Group();
  g.name = 'cabin_roof_slope';
  const cache = getGeometryCache();
  /* Slope panel tilted at ~25° representing one half of a peaked roof. */
  const panel = new THREE.Mesh(cache.roofSlopePanel, cabinLog(tier));
  panel.rotation.x = -Math.PI / 7; /* ~25.7° pitch */
  panel.position.set(0, 0.75, 0.45);
  g.add(panel);
  /* Ridge band at the high edge of the slope (T2+). */
  const band = cabinBand(tier);
  if (band) {
    const ridgeGeo = new THREE.BoxGeometry(1.5, 0.04, 0.06);
    const ridge = new THREE.Mesh(ridgeGeo, band);
    ridge.position.set(0, 1.05, -0.45);
    g.add(ridge);
  }
  const rune = cabinRune(tier);
  if (rune) {
    const traceGeo = new THREE.BoxGeometry(1.4, 0.01, 0.012);
    const trace = new THREE.Mesh(traceGeo, rune);
    trace.position.set(0, 1.07, -0.45);
    g.add(trace);
  }
  return g;
}

/* ---------- Placeholder kinds (Phase 1.5 polish target) ---------- */

function buildPillar(tier: CabinMaterialTier): THREE.Group {
  const g = new THREE.Group();
  g.name = 'cabin_pillar';
  const cache = getGeometryCache();
  const m = new THREE.Mesh(cache.pillar, cabinLog(tier));
  m.position.y = 1.2;
  g.add(m);
  const band = cabinBand(tier);
  if (band) {
    /* Three rings up the pillar. */
    const ringGeo = new THREE.TorusGeometry(0.13, 0.02, 6, 14);
    for (const y of [0.4, 1.2, 2.0]) {
      const r = new THREE.Mesh(ringGeo, band);
      r.rotation.x = Math.PI / 2;
      r.position.y = y;
      g.add(r);
    }
  }
  return g;
}

function buildCeiling(tier: CabinMaterialTier): THREE.Group {
  /* Visually identical to floor for now — different gameplay role, same geometry. */
  return buildFloor(tier);
}

function buildRoofPeak(tier: CabinMaterialTier): THREE.Group {
  const g = new THREE.Group();
  g.name = 'cabin_roof_peak';
  /* Two slope panels mirrored to form a peak. */
  const cache = getGeometryCache();
  const log = cabinLog(tier);
  const a = new THREE.Mesh(cache.roofSlopePanel, log);
  a.rotation.x = -Math.PI / 7;
  a.position.set(0, 0.75, 0.45);
  const b = new THREE.Mesh(cache.roofSlopePanel, log);
  b.rotation.x = Math.PI / 7;
  b.position.set(0, 0.75, -0.45);
  g.add(a, b);
  return g;
}

function buildStairs(tier: CabinMaterialTier): THREE.Group {
  const g = new THREE.Group();
  g.name = 'cabin_stairs';
  const log = cabinLog(tier);
  /* Three stepped log treads. */
  for (let i = 0; i < 3; i++) {
    const treadGeo = new THREE.BoxGeometry(1.5, 0.18, 0.45);
    const m = new THREE.Mesh(treadGeo, log);
    m.position.set(0, 0.09 + i * 0.18, -0.45 + i * 0.45);
    g.add(m);
  }
  return g;
}

function buildGate(tier: CabinMaterialTier): THREE.Group {
  const g = new THREE.Group();
  g.name = 'cabin_gate';
  const log = cabinLog(tier);
  /* 2× door width — roughly 1.5 m gate panel. */
  const panelGeo = new THREE.BoxGeometry(1.4, 1.95, 0.07);
  const panel = new THREE.Mesh(panelGeo, log);
  panel.position.y = 0.975;
  g.add(panel);
  const band = cabinBand(tier);
  if (band) {
    const strapGeo = new THREE.BoxGeometry(1.42, 0.08, 0.075);
    for (const y of [0.5, 1.0, 1.5]) {
      const m = new THREE.Mesh(strapGeo, band);
      m.position.set(0, y, 0.04);
      g.add(m);
    }
  }
  return g;
}

function buildLadder(tier: CabinMaterialTier): THREE.Group {
  const g = new THREE.Group();
  g.name = 'cabin_ladder';
  const log = cabinLog(tier);
  /* Two rails + 6 rungs. */
  const railGeo = new THREE.BoxGeometry(0.05, 2.2, 0.05);
  const left = new THREE.Mesh(railGeo, log);
  left.position.set(-0.18, 1.1, 0);
  const right = new THREE.Mesh(railGeo, log);
  right.position.set(0.18, 1.1, 0);
  g.add(left, right);
  const rungGeo = new THREE.BoxGeometry(0.42, 0.04, 0.04);
  for (let i = 0; i < 6; i++) {
    const r = new THREE.Mesh(rungGeo, log);
    r.position.set(0, 0.3 + i * 0.32, 0);
    g.add(r);
  }
  return g;
}
