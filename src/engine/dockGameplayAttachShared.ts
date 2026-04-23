/**
 * Shared dock **gameplay attach** pipeline — same phases as title-screen extended
 * preload, runnable from either:
 *   - main-thread {@link CharacterScenePreview} (`dockExtendedPreload.ts`), or
 *   - worker {@link CharacterSceneController} (OffscreenCanvas scene).
 *
 * **Phase 3.x-B:** main `mountApp` still expects live handle refs on the main
 * thread today; worker attach is wired for protocol/parity work until consume +
 * world systems cross the boundary (see `docs/WORKER_MIGRATION_PHASE_3X.md`).
 */
import type {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  Group,
} from 'three';
import type { CollisionWorldHandle } from '../world/collisionWorld';
import type { DockForestHandle } from '../world/dockForestBatchedScene';
import type { FreeRoamHarvestHandle } from '../world/freeRoamHarvestNodes';
import type { CabinBuildHandle } from '../world/cabinBuilder';
import type { CraftStationBuildHandle } from '../world/craftStationBuilder';
import type { MagicProjectilesHandle } from '../world/magicProjectiles';
import type { AwakenedBouncyMushroomsHandle } from '../world/awakenedBouncyMushrooms';
import type { DefensiveWardHandle } from '../world/defensiveWard';
import type { ForestStaticObstacle } from '../visual/forestEnvironment';
import type { ResolvedCreek } from '../world/idleCraftHeightfield';
import { measureBlockAsync } from '../util/longAnimationFramesAudit';

/** Save-independent handles produced by {@link runDockGameplayAttachShared}. */
export interface DockExtendedPreloadHandles {
  collisionWorld: CollisionWorldHandle;
  dockForestHandle: DockForestHandle;
  harvestHandle: FreeRoamHarvestHandle;
  cabinHandle: CabinBuildHandle;
  craftStationHandle: CraftStationBuildHandle;
  projectilesHandle: MagicProjectilesHandle;
  defensiveWardHandle: DefensiveWardHandle;
  bouncyMushroomsHandle: AwakenedBouncyMushroomsHandle;
}

export type DockGameplayAttachFreeRoamFields = {
  getTerrainHeight: (x: number, z: number) => number;
  mapRadius: number;
  crystalSpotsXZ: { x: number; z: number }[];
  crystalClusters: { x: number; z: number; group: Group }[];
  forestStaticObstacles: ForestStaticObstacle[];
  resolvedCreeks: ResolvedCreek[];
  dockXZ: { x: number; z: number };
};

export type DockGameplayAttachGlTarget = {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
};

function createStubMobsHandleForWarming(): import('../world/awakenedMobs').AwakenedMobsHandle {
  return {
    update: () => {},
    damage: () => false,
    getMob: () => null,
    getAllMobs: () => [],
    getProximityVolumeScale: () => 1,
    warmShaders: () => {},
    clearAll: () => {},
    dispose: () => {},
  } as unknown as import('../world/awakenedMobs').AwakenedMobsHandle;
}

function warmMobShadersStandalone(
  target: DockGameplayAttachGlTarget,
  createPveEnemyLPCA: typeof import('../visual/pveEnemyLPCA').createPveEnemyLPCA,
): void {
  const MOB_KIND_TO_PVE_ID: Record<'rat' | 'wolf' | 'wanderer', string> = {
    rat: 'pve_rat',
    wolf: 'pve_wolf',
    wanderer: 'pve_wanderer',
  };
  const placeholders: import('three').Group[] = [];
  for (const kind of ['rat', 'wolf', 'wanderer'] as const) {
    try {
      const lpca = createPveEnemyLPCA(MOB_KIND_TO_PVE_ID[kind]);
      lpca.group.position.set(10000, -10000, 10000);
      target.scene.add(lpca.group);
      placeholders.push(lpca.group);
    } catch {
      /* skip */
    }
  }
  const cleanupPlaceholders = (): void => {
    for (const g of placeholders) {
      target.scene.remove(g);
      g.traverse((o: unknown) => {
        const m = o as import('three').Mesh;
        if (m && (m as { isMesh?: boolean }).isMesh && m.geometry) m.geometry.dispose();
      });
    }
  };
  const r = target.renderer as import('three').WebGLRenderer & {
    compileAsync?: (s: import('three').Object3D, c: import('three').Camera) => Promise<void>;
  };
  if (typeof r.compileAsync === 'function') {
    r.compileAsync(target.scene, target.camera)
      .then(() => requestAnimationFrame(cleanupPlaceholders))
      .catch(() => requestAnimationFrame(cleanupPlaceholders));
    return;
  }
  try {
    target.renderer.compile(target.scene, target.camera);
  } catch {
    /* best-effort */
  }
  requestAnimationFrame(cleanupPlaceholders);
}

const PHASE_WEIGHTS = {
  collisionWorld: 0.024,
  dockForest: 0.232,
  harvest: 0.112,
  cabin: 0.168,
  craftStation: 0.056,
  mobWarm: 0.088,
  projectiles: 0.12,
  bouncyMushrooms: 0.18,
  defensiveWard: 0.02,
} as const;

type DockGameplayWorldModulesBundle = [
  typeof import('../world/collisionWorld'),
  typeof import('../world/dockForestBatchedScene'),
  typeof import('../world/freeRoamHarvestNodes'),
  typeof import('../world/cabinBuilder'),
  typeof import('../world/craftStationBuilder'),
  typeof import('../world/magicProjectiles'),
  typeof import('../visual/pveEnemyLPCA'),
  typeof import('../world/awakenedBouncyMushrooms'),
  typeof import('../world/defensiveWard'),
];

let dockGameplayWorldModulesPromise: Promise<DockGameplayWorldModulesBundle> | null = null;

/**
 * Kick off parallel dynamic imports for gameplay attach (collision, dock forest,
 * harvest, cabin, …). Idempotent — {@link runDockGameplayAttachShared} awaits the
 * same promise. Legacy `dockPreload` calls this **before** `CharacterScenePreview.create`
 * finishes so fetch + parse overlaps WebGL / LPCA work (no feature change).
 */
export function warmDockGameplayWorldModules(): Promise<DockGameplayWorldModulesBundle> {
  if (!dockGameplayWorldModulesPromise) {
    dockGameplayWorldModulesPromise = Promise.all([
      import('../world/collisionWorld'),
      import('../world/dockForestBatchedScene'),
      import('../world/freeRoamHarvestNodes'),
      import('../world/cabinBuilder'),
      import('../world/craftStationBuilder'),
      import('../world/magicProjectiles'),
      import('../visual/pveEnemyLPCA'),
      import('../world/awakenedBouncyMushrooms'),
      import('../world/defensiveWard'),
    ]);
  }
  return dockGameplayWorldModulesPromise;
}

/**
 * Full gameplay-layer attach into an existing dock scene + WebGL context.
 * @param onProgress — sub-fraction 0..1 within this stage (caller scales for unified bar).
 */
export async function runDockGameplayAttachShared(
  gl: DockGameplayAttachGlTarget,
  freeRoam: DockGameplayAttachFreeRoamFields,
  onProgress?: (fraction: number, phase: string) => void,
): Promise<DockExtendedPreloadHandles> {
  const [
    { getOrCreateSceneCollisionWorld },
    { attachDockForestBatchedScene },
    { attachFreeRoamHarvestNodes },
    { attachCabinBuilder },
    { attachCraftStationBuilder },
    { attachMagicProjectiles },
    { createPveEnemyLPCA },
    { attachAwakenedBouncyMushrooms },
    { attachDefensiveWard },
  ] = await measureBlockAsync('gameplayAttach.parallelImports', () => warmDockGameplayWorldModules());

  let collisionWorld: CollisionWorldHandle | null = null;
  let dockForestHandle: DockForestHandle | null = null;
  let harvestHandle: FreeRoamHarvestHandle | null = null;
  let cabinHandle: CabinBuildHandle | null = null;
  let craftStationHandle: CraftStationBuildHandle | null = null;
  let projectilesHandle: MagicProjectilesHandle | null = null;
  let defensiveWardHandle: DefensiveWardHandle | null = null;
  let bouncyMushroomsHandle: AwakenedBouncyMushroomsHandle | null = null;

  const disposePartialOnFailure = (): void => {
    try { bouncyMushroomsHandle?.dispose?.(); } catch { /* ignore */ }
    try { defensiveWardHandle?.dispose?.(); } catch { /* ignore */ }
    try { projectilesHandle?.dispose?.(); } catch { /* ignore */ }
    try { craftStationHandle?.dispose?.(); } catch { /* ignore */ }
    try { cabinHandle?.dispose?.(); } catch { /* ignore */ }
    try { harvestHandle?.dispose?.(); } catch { /* ignore */ }
    try { dockForestHandle?.dispose?.(); } catch { /* ignore */ }
    try { collisionWorld?.dispose?.(); } catch { /* ignore */ }
  };

  let cumulative = 0;
  const advance = (phase: keyof typeof PHASE_WEIGHTS, label: string): void => {
    cumulative += PHASE_WEIGHTS[phase];
    const f = Math.min(0.999, cumulative);
    onProgress?.(f, label);
  };

  try {
    collisionWorld = getOrCreateSceneCollisionWorld(gl.scene);
    advance('collisionWorld', 'Charting expedition space…');
    /* Next label matches heavy work in `attachDockForestBatchedScene` (was stuck on
     * "Charting…" through templates + BatchedMesh build). */
    onProgress?.(cumulative, 'Building forest geometry…');

    dockForestHandle = await measureBlockAsync('gameplayAttach.attachDockForest', () =>
      attachDockForestBatchedScene({
        scene: gl.scene,
        specs: freeRoam.forestStaticObstacles,
        collisionWorld: collisionWorld!,
      }),
    );
    advance('dockForest', 'Raising the forest canopy…');

    harvestHandle = attachFreeRoamHarvestNodes({
      scene: gl.scene,
      getTerrainHeight: freeRoam.getTerrainHeight,
      mapRadius: freeRoam.mapRadius,
      crystalSpotsXZ: freeRoam.crystalSpotsXZ,
      crystalClusters: freeRoam.crystalClusters,
      collisionWorld,
    });
    advance('harvest', 'Seeding ore + herb veins…');

    cabinHandle = attachCabinBuilder({ scene: gl.scene, collisionWorld });
    cabinHandle.warmShaders(gl.renderer, gl.camera);
    advance('cabin', 'Forging cabin walls…');

    craftStationHandle = attachCraftStationBuilder({
      scene: gl.scene,
      collisionWorld,
    });
    advance('craftStation', 'Stocking craft stations…');

    warmMobShadersStandalone(gl, createPveEnemyLPCA);
    advance('mobWarm', 'Warming creature shaders…');

    projectilesHandle = attachMagicProjectiles({
      scene: gl.scene,
      collisionWorld,
      mobs: createStubMobsHandleForWarming(),
      getTerrainHeight: freeRoam.getTerrainHeight,
    });
    projectilesHandle.warmShaders(gl.renderer, gl.camera);
    advance('projectiles', 'Charging magic projectile lanes…');

    defensiveWardHandle = attachDefensiveWard({ scene: gl.scene });
    advance('defensiveWard', 'Raising protective ward…');

    bouncyMushroomsHandle = attachAwakenedBouncyMushrooms({
      scene: gl.scene,
      getTerrainHeight: freeRoam.getTerrainHeight,
      mapRadius: freeRoam.mapRadius,
      creeks: freeRoam.resolvedCreeks,
      dockXZ: freeRoam.dockXZ,
      collisionWorld: collisionWorld!,
    });
    bouncyMushroomsHandle.warmShaders(gl.renderer, gl.camera);
    advance('bouncyMushrooms', 'Spreading meadow mushrooms…');

    return {
      collisionWorld: collisionWorld!,
      dockForestHandle: dockForestHandle!,
      harvestHandle: harvestHandle!,
      cabinHandle: cabinHandle!,
      craftStationHandle: craftStationHandle!,
      projectilesHandle: projectilesHandle!,
      defensiveWardHandle: defensiveWardHandle!,
      bouncyMushroomsHandle: bouncyMushroomsHandle!,
    };
  } catch (err) {
    disposePartialOnFailure();
    throw err;
  }
}

/** Best-effort teardown of handles from {@link runDockGameplayAttachShared}. */
export function disposeDockGameplayAttachHandles(handles: DockExtendedPreloadHandles | null): void {
  if (!handles) return;
  try { handles.bouncyMushroomsHandle.dispose(); } catch { /* ignore */ }
  try { handles.defensiveWardHandle.dispose(); } catch { /* ignore */ }
  try { handles.projectilesHandle.dispose(); } catch { /* ignore */ }
  try { handles.craftStationHandle.dispose(); } catch { /* ignore */ }
  try { handles.cabinHandle.dispose(); } catch { /* ignore */ }
  try { handles.harvestHandle.dispose(); } catch { /* ignore */ }
  try { handles.dockForestHandle.dispose(); } catch { /* ignore */ }
  try { handles.collisionWorld.dispose(); } catch { /* ignore */ }
}
