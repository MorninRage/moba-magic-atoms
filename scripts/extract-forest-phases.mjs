import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const p = path.join(__dirname, '..', 'src', 'visual', 'forestEnvironment.ts');
let s = fs.readFileSync(p, 'utf8');

const start = '  const dockCx = dockSpawn.homeX;';
const i = s.indexOf(start);
if (i < 0) throw new Error('start marker not found');

const endRe =
  /  const crystalSpotsXZ = getIdleCraftCrystalWorldPositions\(dockCx, dockCz, ringMul\);\r?\n/;
const endM = endRe.exec(s.slice(i));
if (!endM) throw new Error('end marker not found');
const j = i + endM.index;
const endLen = endM[0].length;
const body = s.slice(i, j + endLen);

const call = `  const dockPhases = await attachDockForestBackdropForestPhases(
    scene,
    project,
    graphics,
    dockEnvironment,
    ground,
    R,
    resolved,
    getHeightAt,
  );

`;

s = s.slice(0, i) + call + s.slice(j + endLen);

const retRe =
  /  return \{\r?\n    ground,\r?\n    sunDirection,\r?\n    dockEnvironment,\r?\n    hemisphereLight: hemi,\r?\n    mapRadius: R,\r?\n    getHeightAt,\r?\n    resolvedCreeks: resolved,\r?\n    sceneTickers,\r?\n    sceneDisposers,\r?\n    crystalSpotsXZ,\r?\n    crystalClusters,\r?\n    staticObstacles,\r?\n  \};/;

const retNew = `  return {
    ground,
    sunDirection: dockPhases.sunDirection,
    dockEnvironment,
    hemisphereLight: hemi,
    mapRadius: R,
    getHeightAt,
    resolvedCreeks: resolved,
    sceneTickers: dockPhases.sceneTickers,
    sceneDisposers: dockPhases.sceneDisposers,
    crystalSpotsXZ: dockPhases.crystalSpotsXZ,
    crystalClusters: dockPhases.crystalClusters,
    staticObstacles: dockPhases.staticObstacles,
  };`;

if (!retRe.test(s)) throw new Error('return block not found');
s = s.replace(retRe, retNew);

const insertMarker = '/** Global polar grid + trees: keep ground cover out of creek corridors. */';

const fnHead = `/**
 * Forest strata + crystals + merges + night magic — same sequence as the tail of
 * {@link attachForestBackdrop} after base terrain/water. Used by the render worker
 * so dock parity does not duplicate logic.
 */
export async function attachDockForestBackdropForestPhases(
  scene: THREE.Scene,
  project: IdleEmpireProjectFile | null,
  graphics: GraphicsBudget,
  dockEnvironment: IdleCraftDockEnvironment,
  _ground: THREE.Mesh,
  R: number,
  resolved: ResolvedCreek[],
  getHeightAt: (x: number, z: number) => number,
): Promise<{
  sunDirection: THREE.Vector3;
  sceneTickers: ((dt: number) => void)[];
  sceneDisposers: (() => void)[];
  crystalSpotsXZ: { x: number; z: number }[];
  crystalClusters: { x: number; z: number; group: THREE.Group }[];
  staticObstacles: ForestStaticObstacle[];
}> {
`;

const fnTail = `
  const sunDirection = dockEnvironment.getSunDirection(new THREE.Vector3());
  const crystalSpotsXZ = getIdleCraftCrystalWorldPositions(dockCx, dockCz, ringMul);
  return {
    sunDirection,
    sceneTickers,
    sceneDisposers,
    crystalSpotsXZ,
    crystalClusters,
    staticObstacles,
  };
}

`;

const crystalLine =
  /  const crystalSpotsXZ = getIdleCraftCrystalWorldPositions\(dockCx, dockCz, ringMul\);\r?\n/;
const inner = body.replace(crystalLine, '');

const fullFn = fnHead + inner + fnTail;
const k = s.indexOf(insertMarker);
if (k < 0) throw new Error('insert marker');
s = s.slice(0, k) + fullFn + s.slice(k);

fs.writeFileSync(p, s);
console.log('ok', body.length, 'chars');
