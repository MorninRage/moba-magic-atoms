import * as THREE from 'three';
import type { ResolvedCreek } from './idleCraftHeightfield';

function segmentTangent(ax: number, az: number, bx: number, bz: number): THREE.Vector3 {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  return new THREE.Vector3(dx / len, 0, dz / len);
}

/**
 * Builds one BufferGeometry ribbon per creek (merged segments). Y is sampled via getHeightAt.
 * Slight vertical bias avoids z-fighting with carved terrain.
 */
export function buildCreekRibbonGeometry(
  creek: ResolvedCreek,
  getHeightAt: (x: number, z: number) => number,
  yBias: number,
): THREE.BufferGeometry | null {
  const pts = creek.points;
  if (pts.length < 2) return null;

  const half = creek.halfWidth;
  const verts: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  let vertCursor = 0;
  let distU = 0;

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const ax = a[0];
    const az = a[1];
    const bx = b[0];
    const bz = b[1];
    const t = segmentTangent(ax, az, bx, bz);
    const px = -t.z * half;
    const pz = t.x * half;
    const segLen = Math.hypot(bx - ax, bz - az);
    const y0 = getHeightAt(ax, az) + yBias;
    const y1 = getHeightAt(bx, bz) + yBias;

    const axL = ax + px;
    const azL = az + pz;
    const axR = ax - px;
    const azR = az - pz;
    const bxL = bx + px;
    const bzL = bz + pz;
    const bxR = bx - px;
    const bzR = bz - pz;

    verts.push(axL, y0, azL, axR, y0, azR, bxL, y1, bzL, bxR, y1, bzR);
    for (let k = 0; k < 4; k++) normals.push(0, 1, 0);
    uvs.push(0, distU, 1, distU, 0, distU + segLen, 1, distU + segLen);
    indices.push(
      vertCursor,
      vertCursor + 1,
      vertCursor + 2,
      vertCursor + 1,
      vertCursor + 3,
      vertCursor + 2,
    );
    vertCursor += 4;
    distU += segLen;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}
