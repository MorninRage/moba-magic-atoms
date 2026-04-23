import * as THREE from 'three';
import type { IdleEmpireProjectFile } from '../engine/fetchEmpireProject';
import type { IdleCraftCreekDef, IdleCraftTerrainConfig } from './idleCraftWorldTypes';
import { parseWorldFromProject, readDockSpawn } from './idleCraftWorldTypes';

function fbm2(x: number, z: number, octaves: number): number {
  let amp = 0.45;
  let freq = 1;
  let s = 0;
  for (let i = 0; i < octaves; i++) {
    s += amp * Math.sin(x * freq) * Math.cos(z * freq * 1.27);
    freq *= 2.1;
    amp *= 0.52;
  }
  return s;
}

function distPointToSegment2D(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
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

function polylineLength(points: [number, number][]): number {
  let L = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return L;
}

/** Point at distance `d` along polyline (total length). */
function pointAlongPolyline(points: [number, number][], d: number): [number, number] {
  if (points.length < 2) return points[0] ?? [0, 0];
  let remain = Math.max(0, d);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (remain <= seg) {
      const t = seg > 0 ? remain / seg : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    remain -= seg;
  }
  const last = points[points.length - 1]!;
  return [last[0], last[1]];
}

/** Parameter T in [0,1] along total length → world XZ. */
function pointOnPolylineByT(points: [number, number][], t: number): [number, number] {
  const L = polylineLength(points);
  return pointAlongPolyline(points, t * L);
}

export type ResolvedCreek = {
  id: string;
  points: [number, number][];
  halfWidth: number;
  carveDepth: number;
  carveWidth: number;
};

export function resolveCreekPolylines(defs: IdleCraftCreekDef[]): ResolvedCreek[] {
  const byId = new Map<string, IdleCraftCreekDef>();
  for (const d of defs) byId.set(d.id, d);

  const resolved: ResolvedCreek[] = [];

  for (const def of defs) {
    const halfWidth = def.halfWidth ?? 0.35;
    const carveDepth = def.carveDepth ?? 0.14;
    const carveWidth = def.carveWidth ?? 1.0;
    let pts = def.points.map((p) => [p[0], p[1]] as [number, number]);

    if (def.join && typeof def.joinT === 'number') {
      const parent = byId.get(def.join);
      if (parent && parent.points.length >= 2) {
        const j = pointOnPolylineByT(
          parent.points.map((p) => [p[0], p[1]] as [number, number]),
          Math.max(0, Math.min(1, def.joinT)),
        );
        pts = [...pts, j];
      }
    }

    if (pts.length >= 2) {
      resolved.push({ id: def.id, points: pts, halfWidth, carveDepth, carveWidth });
    }
  }

  return resolved;
}

export type CarveSegment = { ax: number; az: number; bx: number; bz: number; halfW: number; depth: number };

function collectCarveSegments(creeks: ResolvedCreek[]): CarveSegment[] {
  const segs: CarveSegment[] = [];
  for (const c of creeks) {
    for (let i = 0; i < c.points.length - 1; i++) {
      const a = c.points[i]!;
      const b = c.points[i + 1]!;
      segs.push({
        ax: a[0],
        az: a[1],
        bx: b[0],
        bz: b[1],
        halfW: c.carveWidth,
        depth: c.carveDepth,
      });
    }
  }
  return segs;
}

/**
 * Single continuous channel: carve from **nearest** polyline segment (Game of Empires–style
 * `carveRiverChannel` continuity — avoids patchy “max only” overlaps at segment joints).
 */
function carveAmount(x: number, z: number, segs: CarveSegment[]): number {
  if (segs.length === 0) return 0;
  let minD = Infinity;
  let depthAt = 0.2;
  let halfW = 1;
  for (const s of segs) {
    const d = distPointToSegment2D(x, z, s.ax, s.az, s.bx, s.bz);
    if (d < minD) {
      minD = d;
      depthAt = s.depth;
      halfW = s.halfW;
    }
  }
  if (minD >= halfW) return 0;
  const u = 1 - minD / halfW;
  const smooth = u * u * (3 - 2 * u);
  return depthAt * smooth;
}

/** Minimum distance to any creek segment (XZ) — for scattering props away from water. */
/**
 * True when `(x, z)` lies in water channel geometry — same rule as
 * `IdleCraftDockEnvironment.isWaterAt` (distance to polyline < `halfWidth * 1.35`).
 */
export function isWaterAtFromResolvedCreeks(x: number, z: number, creeks: ResolvedCreek[]): boolean {
  if (creeks.length === 0) return false;
  for (const c of creeks) {
    const pts = c.points;
    const hw = c.halfWidth * 1.35;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const d = distPointToSegment2D(x, z, a[0], a[1], b[0], b[1]);
      if (d < hw) return true;
    }
  }
  return false;
}

export function minDistToCreekNetwork(x: number, z: number, creeks: ResolvedCreek[]): number {
  let minD = Infinity;
  for (const c of creeks) {
    for (let i = 0; i < c.points.length - 1; i++) {
      const a = c.points[i]!;
      const b = c.points[i + 1]!;
      const d = distPointToSegment2D(x, z, a[0], a[1], b[0], b[1]);
      if (d < minD) minD = d;
    }
  }
  return minD;
}

/**
 * Planar mesh on a regular **vertex lattice** (segments × segments), height from `getHeightAt`.
 * This is a continuous **heightfield**, not Game of Empires–style discrete **map/cell** tiles for gameplay.
 */
export function buildTerrainGridGeometry(
  R: number,
  seg: number,
  getHeightAt: (x: number, z: number) => number,
): THREE.BufferGeometry {
  const vertCount = (seg + 1) * (seg + 1);
  const positions = new Float32Array(vertCount * 3);
  let pi = 0;
  for (let iz = 0; iz <= seg; iz++) {
    const fz = iz / seg;
    for (let ix = 0; ix <= seg; ix++) {
      const fx = ix / seg;
      const x = (fx - 0.5) * 2 * R;
      const z = (fz - 0.5) * 2 * R;
      const h = getHeightAt(x, z);
      positions[pi++] = x;
      positions[pi++] = h;
      positions[pi++] = z;
    }
  }
  const indices: number[] = [];
  for (let iz = 0; iz < seg; iz++) {
    for (let ix = 0; ix < seg; ix++) {
      const a = iz * (seg + 1) + ix;
      const b = a + 1;
      const c = a + seg + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Extra meters beyond creek `halfWidth` so the gather ring sits on dry bank, not in the channel. */
const WATER_GATHER_BANK_MARGIN = 0.14;

function closestPointOnResolvedCreeks(
  px: number,
  pz: number,
  creeks: ResolvedCreek[],
): { qx: number; qz: number; tx: number; tz: number; halfW: number } | null {
  let bestD = Infinity;
  let best: { qx: number; qz: number; tx: number; tz: number; halfW: number } | null = null;
  for (const c of creeks) {
    for (let i = 0; i < c.points.length - 1; i++) {
      const a = c.points[i]!;
      const b = c.points[i + 1]!;
      const ax = a[0];
      const az = a[1];
      const bx = b[0];
      const bz = b[1];
      const abx = bx - ax;
      const abz = bz - az;
      const apx = px - ax;
      const apz = pz - az;
      const ab2 = abx * abx + abz * abz || 1;
      let t = (apx * abx + apz * abz) / ab2;
      t = Math.max(0, Math.min(1, t));
      const qx = ax + abx * t;
      const qz = az + abz * t;
      const d = Math.hypot(px - qx, pz - qz);
      if (d < bestD) {
        bestD = d;
        best = { qx, qz, tx: abx, tz: abz, halfW: c.halfWidth };
      }
    }
  }
  return best;
}

/**
 * World XZ on the main creek bank toward `dock` — manual water gather walks here instead of a decorative pool.
 */
export function waterGatherBankXZ(project: IdleEmpireProjectFile | null): { x: number; z: number } {
  const { hydrology } = parseWorldFromProject(project);
  const creeks = resolveCreekPolylines(hydrology.creeks ?? []);
  const dock = readDockSpawn(project);
  if (creeks.length === 0) {
    return { x: dock.homeX - 0.1, z: dock.homeZ - 0.55 };
  }
  const main = creeks.find((c) => c.id === 'main') ?? creeks[0]!;
  const hit = closestPointOnResolvedCreeks(dock.homeX, dock.homeZ, [main]);
  if (!hit) {
    return { x: dock.homeX - 0.1, z: dock.homeZ - 0.55 };
  }
  const { qx, qz, tx, tz, halfW } = hit;
  const len = Math.hypot(tx, tz) || 1;
  let nx = -tz / len;
  let nz = tx / len;
  const vx = dock.homeX - qx;
  const vz = dock.homeZ - qz;
  if (nx * vx + nz * vz < 0) {
    nx = -nx;
    nz = -nz;
  }
  const dist = halfW + WATER_GATHER_BANK_MARGIN;
  return { x: qx + nx * dist, z: qz + nz * dist };
}

export function createHeightSampler(
  terrain: Required<IdleCraftTerrainConfig>,
  creeks: ResolvedCreek[],
): (x: number, z: number) => number {
  const segs = collectCarveSegments(creeks);
  const f = terrain.noiseFrequency;
  const hs = terrain.heightScale;

  return (x: number, z: number): number => {
    let h = Math.sin(x * f * 0.95) * Math.cos(z * f * 1.05) * hs * 0.52;
    h += Math.sin((x + z * 0.7) * f * 1.4) * hs * 0.28;
    h += fbm2(x * f * 2.2, z * f * 2.2, 3) * hs * 0.38;
    h -= carveAmount(x, z, segs);
    return h;
  };
}

/**
 * Slope magnitude at world XZ — finite-differences of the height sampler.
 *
 * Used by the trippy terrain palette in `forestEnvironment.attachForestBackdrop`
 * to pick per-vertex colors (rock for steep, dirt for slanted, grass for flat).
 * Same algorithm as `C:\stick man`'s `TerrainBuilder` (slope ≈ |∂h/∂x| + |∂h/∂z|
 * via a centered difference) so the slope-threshold tunings carry over directly.
 *
 * `eps` defaults to 0.5 m which matches idle craft's awakened terrain segment
 * spacing well enough that adjacent vertices read coherent slope bands rather
 * than per-vertex noise. Smaller eps = sharper bands (more rock at every cliff
 * edge); larger eps = softer transitions.
 *
 * Returns the same `slope` magnitude that stick man's TerrainBuilder uses, so
 * its threshold table (0.7 / 0.4 / 0.28 / 0.15) can be reused 1:1.
 */
export function computeSlopeAt(
  sampleHeight: (x: number, z: number) => number,
  x: number,
  z: number,
  eps = 0.5,
): number {
  const hL = sampleHeight(x - eps, z);
  const hR = sampleHeight(x + eps, z);
  const hD = sampleHeight(x, z - eps);
  const hU = sampleHeight(x, z + eps);
  const slopeX = Math.abs(hR - hL) / (2 * eps);
  const slopeZ = Math.abs(hU - hD) / (2 * eps);
  return Math.sqrt(slopeX * slopeX + slopeZ * slopeZ);
}
