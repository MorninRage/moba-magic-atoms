/**
 * Worker-side dock scene bootstrap — Step 4: sky + {@link IdleCraftDockEnvironment},
 * then terrain disk + trippy ground + skirt + creek ribbons (no trees/LPCA scatter).
 *
 * Aligns with `forestEnvironment.attachForestBackdrop` through the water-registration
 * boundary. Forest LPCA runs next via `attachDockForestBackdropForestPhases` in
 * `characterSceneController` (shared implementation in `forestEnvironment.ts`).
 */

import * as THREE from 'three';
import { getWaterPlaneMaterial } from 'empire-engine/lpca';
import type { IdleEmpireProjectFile } from '../engine/fetchEmpireProject';
import type { GraphicsBudget } from '../engine/graphicsTier';
import { IdleCraftDockEnvironment } from '../world/idleCraftDockEnvironment';
import {
  buildTerrainGridGeometry,
  createHeightSampler,
  resolveCreekPolylines,
  type ResolvedCreek,
} from '../world/idleCraftHeightfield';
import { buildCreekRibbonGeometry } from '../world/idleCraftWaterRibbon';
import { parseWorldFromProject } from '../world/idleCraftWorldTypes';
import { createUnifiedSkyDomeMesh } from '../visual/idleCraftSkyStack';
import { bakeTrippyGroundVertexColorsSync } from '../visual/trippyGroundBake';

export type BootstrapDockSceneSliceResult = {
  dockEnvironment: IdleCraftDockEnvironment;
  /** Hemisphere added to `scene` before the dock environment ctor — same as forest path. */
  hemi: THREE.HemisphereLight;
  mapRadius: number;
};

export function bootstrapDockEnvironmentAndSky(
  scene: THREE.Scene,
  project: IdleEmpireProjectFile | null,
  graphics: GraphicsBudget,
): BootstrapDockSceneSliceResult {
  const { terrain, hydrology } = parseWorldFromProject(project);
  const R = terrain.radius;
  const resolved = resolveCreekPolylines(hydrology.creeks ?? []);

  scene.background = new THREE.Color(0xa8daf8);
  scene.fog = new THREE.Fog(0xa8daf8, R * 1.4, R * 2.85);

  const hemi = new THREE.HemisphereLight(0xb8d8f0, 0x5c5648, 0.54);
  scene.add(hemi);

  const dockEnvironment = new IdleCraftDockEnvironment(scene, project, hemi, R, graphics);
  const sky = createUnifiedSkyDomeMesh(graphics, 12000);
  dockEnvironment.registerSkyDome(sky);
  scene.add(sky);
  dockEnvironment.setResolvedCreeks(resolved);

  return { dockEnvironment, hemi, mapRadius: R };
}

/** Ground mesh + height sampler for {@link attachDockForestBackdropForestPhases}. */
export type WorkerDockTerrainWaterSliceResult = {
  ground: THREE.Mesh;
  getHeightAt: (x: number, z: number) => number;
  mapRadius: number;
  resolved: ResolvedCreek[];
};

/**
 * Terrain grid, vertex-colored ground, underside skirt, creek water meshes — matches
 * legacy `attachForestBackdrop` steps after skydome until the first yield (no forest).
 */
export function attachWorkerDockTerrainWaterSlice(
  scene: THREE.Scene,
  project: IdleEmpireProjectFile | null,
  graphics: GraphicsBudget,
  dockEnvironment: IdleCraftDockEnvironment,
): WorkerDockTerrainWaterSliceResult {
  const { terrain, hydrology } = parseWorldFromProject(project);
  const resolved = resolveCreekPolylines(hydrology.creeks ?? []);
  const getHeightAt = createHeightSampler(terrain, resolved);
  const R = terrain.radius;
  const segRaw = Math.round(terrain.planeSegments * graphics.terrainSegmentMul);
  const seg = Math.max(graphics.terrainSegmentMin, Math.min(segRaw, graphics.terrainSegmentMax));

  const terrainGeo = buildTerrainGridGeometry(R, seg, getHeightAt);
  bakeTrippyGroundVertexColorsSync(terrainGeo, getHeightAt, terrain.heightScale);
  const turfMat = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.45,
    metalness: 0.05,
    transmission: 0.18,
    thickness: 0.25,
    ior: 1.2,
    emissive: 0x111122,
  });
  const ground = new THREE.Mesh(terrainGeo, turfMat);
  ground.receiveShadow = true;
  scene.add(ground);

  const skirtMat = new THREE.MeshStandardMaterial({
    color: 0x151c14,
    metalness: 0.06,
    roughness: 0.96,
    side: THREE.DoubleSide,
  });
  const skirtSeg = Math.max(graphics.tier === 'low' ? 24 : 48, Math.floor(seg / 2));
  const skirt = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 1.012, R * 0.99, terrain.skirtDepth, skirtSeg, 1, true),
    skirtMat,
  );
  skirt.position.y = -terrain.skirtDepth * 0.5 - 0.05;
  skirt.receiveShadow = true;
  scene.add(skirt);

  const waterMat = getWaterPlaneMaterial().clone();
  waterMat.polygonOffset = true;
  waterMat.polygonOffsetFactor = -1.2;
  waterMat.polygonOffsetUnits = -1;
  const waterMeshes: THREE.Mesh[] = [];
  for (const creek of resolved) {
    const wgeo = buildCreekRibbonGeometry(creek, getHeightAt, 0.034);
    if (!wgeo) continue;
    const wm = new THREE.Mesh(wgeo, waterMat);
    wm.receiveShadow = true;
    waterMeshes.push(wm);
  }
  dockEnvironment.registerWater(waterMeshes, waterMat);

  return { ground, getHeightAt, mapRadius: R, resolved };
}
