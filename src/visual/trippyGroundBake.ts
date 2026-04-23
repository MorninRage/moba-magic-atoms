/**
 * Trippy dock terrain vertex-color bake — shared by {@link forestEnvironment.attachForestBackdrop}
 * (chunked, main-thread) and worker dock bootstrap (sync during worker init).
 */

import * as THREE from 'three';
import { computeSlopeAt } from '../world/idleCraftHeightfield';
import { chunkedYieldingRange } from '../util/mainThreadYield';

const TRIPPY_GROUND_COLORS = {
  grassCyan: new THREE.Color(0x2effcc),
  grassTeal: new THREE.Color(0x1eddab),
  grassMint: new THREE.Color(0x4ff0a0),
  dirtMagenta: new THREE.Color(0xff7fbf),
  dirtViolet: new THREE.Color(0xc060e0),
  dirtLavender: new THREE.Color(0xa080ff),
  dirtPink: new THREE.Color(0xff5faa),
  rockAmber: new THREE.Color(0xffb030),
  rockOrange: new THREE.Color(0xff8040),
  rockGold: new THREE.Color(0xffd055),
};

function colorNoise2D(x: number, z: number): number {
  const n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

function trippyVertexColor(
  x: number,
  z: number,
  h: number,
  sampleHeight: (x: number, z: number) => number,
  heightScale: number,
): THREE.Color {
  const PAL = TRIPPY_GROUND_COLORS;
  const slope = computeSlopeAt(sampleHeight, x, z, 0.5);
  const nLow = colorNoise2D(x * 0.18, z * 0.18);
  const nHigh = colorNoise2D(x * 0.91, z * 0.91);

  const slopeRef = heightScale / 5;
  const ROCK_HEAVY = 0.7 * slopeRef;
  const ROCK_LIGHT = 0.4 * slopeRef;
  const DIRT_HEAVY = 0.28 * slopeRef;
  const DIRT_LIGHT = 0.15 * slopeRef;
  const grassHighThreshold = heightScale * 0.6;
  const grassMidThreshold = heightScale * 0.2;

  if (slope > ROCK_HEAVY) {
    return nLow < 0.34 ? PAL.rockAmber : nLow < 0.67 ? PAL.rockOrange : PAL.rockGold;
  }
  if (slope > ROCK_LIGHT) {
    return nLow < 0.5 ? PAL.rockOrange : PAL.dirtMagenta;
  }
  if (slope > DIRT_HEAVY) {
    return nLow < 0.34 ? PAL.dirtMagenta : nLow < 0.67 ? PAL.dirtViolet : PAL.dirtPink;
  }
  if (slope > DIRT_LIGHT) {
    return nLow < 0.5 ? PAL.dirtLavender : PAL.dirtPink;
  }
  if (h > grassHighThreshold) {
    return nLow < 0.4 ? PAL.grassMint : nLow < 0.75 ? PAL.dirtLavender : PAL.grassTeal;
  }
  if (h > grassMidThreshold) {
    if (nHigh < 0.08) return PAL.dirtLavender;
    if (nLow < 0.55) return PAL.grassCyan;
    if (nLow < 0.85) return PAL.grassTeal;
    return PAL.grassMint;
  }
  if (nHigh < 0.06) return PAL.dirtMagenta;
  if (nLow < 0.5) return PAL.grassCyan;
  if (nLow < 0.85) return PAL.grassMint;
  return PAL.grassTeal;
}

/** Worker / off-main init — one contiguous CPU block is fine. */
export function bakeTrippyGroundVertexColorsSync(
  terrainGeo: THREE.BufferGeometry,
  sampleHeight: (x: number, z: number) => number,
  heightScale: number,
): void {
  const pos = terrainGeo.attributes.position as THREE.BufferAttribute;
  const count = pos.count;
  if (!terrainGeo.attributes.color) {
    terrainGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  }
  const col = terrainGeo.attributes.color as THREE.BufferAttribute;

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = pos.getY(i);
    const c = trippyVertexColor(x, z, h, sampleHeight, heightScale);
    col.setXYZ(i, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
}

/** Main-thread forest attach — yields so title / input stay responsive. */
export async function bakeTrippyGroundVertexColorsChunked(
  terrainGeo: THREE.BufferGeometry,
  sampleHeight: (x: number, z: number) => number,
  heightScale: number,
): Promise<void> {
  const pos = terrainGeo.attributes.position as THREE.BufferAttribute;
  const count = pos.count;
  if (!terrainGeo.attributes.color) {
    terrainGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  }
  const col = terrainGeo.attributes.color as THREE.BufferAttribute;

  await chunkedYieldingRange(
    count,
    (i) => {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = pos.getY(i);
      const c = trippyVertexColor(x, z, h, sampleHeight, heightScale);
      col.setXYZ(i, c.r, c.g, c.b);
    },
    { label: 'forest.bakeTrippyGround' },
  );
  col.needsUpdate = true;
}
