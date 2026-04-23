/**
 * Awakened-mode placed craft-station renderer (Phase 2 of the base-building system —
 * see `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` §9).
 *
 * Owns the visual representation of every `PlacedCraftStation` in `GameState`. The
 * store is the single source of truth; this module diffs the rendered scene against
 * the latest state on each `syncFromState` call. Mirror of `cabinBuilder.ts` in
 * intent, with two structural differences:
 *
 * 1. **Group per instance, not InstancedMesh per (kind, tier).** Stations need
 *    per-instance `tick()` for flame / ember emissive animation. Expected counts
 *    are tiny (~1-10 stations per camp) so the InstancedMesh consolidation pay-off
 *    is moot. One `THREE.Group` per placed entry built from
 *    `createCampfireLPCA` / `createWorkbenchLPCA`.
 *
 * 2. **Phantom-light pool for visual parity with the dream-mode campfire.**
 *    The dream-mode dock-yard campfire keeps two permanent `PointLight`s in
 *    the scene with `intensity = 0` from boot, and the LPCA's `tick()`
 *    animates them to a real value when the campfire renders (see
 *    `characterScenePreview.campfirePhantomFireLight`). That orange glow on
 *    nearby logs / stones / ground is what makes the dream campfire feel
 *    alive — a pure emissive-only campfire reads as a "fire-shaped lava
 *    lamp" with no warm bath of light around it.
 *
 *    For visual parity we pre-allocate a SMALL POOL of phantom light pairs
 *    at attach time (`STATION_LIGHT_POOL_SIZE` pairs = 2× that many
 *    `PointLight`s). Each placed campfire claims a pair from the pool and
 *    feeds them to `createCampfireLPCA`; the factory animates intensity on
 *    them just like the dream-mode dock-yard campfire. When the campfire is
 *    removed, the pair returns to the pool (intensity → 0, parked off-
 *    scene). Pool exhaustion (more campfires than pool slots) falls back to
 *    OFF-SCENE dummy lights so the LPCA factory still has somewhere to write
 *    intensity but no fresh `PointLight`s join the scene — i.e. emissive-only
 *    glow for those overflow campfires.
 *
 *    Why a pool instead of "one fresh PointLight per campfire": Three.js's
 *    `WebGLPrograms` hashes lit-material shaders by `numPointLights`. Adding
 *    fresh PointLights at runtime flips that count and triggers a scene-wide
 *    shader recompile freeze (5+ s on first use — same root cause as the
 *    documented "Campfire 5-second freeze" + "first-sunset" entries in
 *    `LEARNINGS.md`). The pool registers all its lights ONCE at attach time;
 *    `numPointLights` is constant for the rest of the session.
 *
 * **Render strategy:** scene graph holds N station Groups under `root`. Diff sync
 * builds groups for newly-placed stations, disposes groups for removed stations.
 * `tick(timeSec)` advances every campfire's flame animation each frame.
 *
 * **Collision:** every station registers a rect footprint with the collision
 * world on placement, unregisters on removal. Player + mob movement queries
 * resolve overlap (no walking through a workbench). Station footprints are
 * tagged `'static'` so melee / projectile raycasts can early-skip via the
 * existing `hitMobsOnly` filter when needed.
 */
import * as THREE from 'three';
import type { PlacedCraftStation, PlacedCraftStationKind } from '../core/types';
import {
  createCampfireLPCA,
  createWorkbenchLPCA,
  type CampfireLPCA,
  type WorkbenchLPCA,
} from '../visual/craftStationDecorLPCA';
import type { CollisionWorldHandle } from './collisionWorld';

/* ============================================================================
 * Per-kind footprint descriptors — feed both the collision world and the
 * build-mode controller's snap pipeline.
 * ============================================================================ */

interface StationFootprint {
  /** Half-extent in piece-local +X (depth across "front" of the station). */
  halfW: number;
  /** Half-extent in piece-local +Z. */
  halfD: number;
  /** When false, the footprint is ignored by movement push-out (decorative only). */
  blocking: boolean;
  /** World-Y added to the station's `y` to get the footprint's bottom in the Y-band test. */
  bottomYOffset: number;
  /** World-Y added to the station's `y` to get the footprint's top. */
  topYOffset: number;
}

/**
 * Footprint per kind. Numbers were sized from the LPCA bounding boxes
 * (`createCampfireLPCA` / `createWorkbenchLPCA`) plus a small clearance buffer so
 * the player doesn't bonk on invisible edges.
 */
const STATION_FOOTPRINT: Record<PlacedCraftStationKind, StationFootprint> = {
  campfire:  { halfW: 0.34, halfD: 0.34, blocking: true, bottomYOffset: 0,    topYOffset: 0.42 },
  workbench: { halfW: 0.30, halfD: 0.18, blocking: true, bottomYOffset: 0,    topYOffset: 0.66 },
  forge:     { halfW: 0.45, halfD: 0.45, blocking: true, bottomYOffset: 0,    topYOffset: 1.20 },
  kitchen:   { halfW: 0.40, halfD: 0.30, blocking: true, bottomYOffset: 0,    topYOffset: 0.85 },
};

/** Public accessor — used by the build-mode controller to size ghost AABBs. */
export function getCraftStationHalfExtents(kind: PlacedCraftStationKind): {
  halfW: number;
  halfD: number;
  halfH: number;
} {
  const fp = STATION_FOOTPRINT[kind];
  return { halfW: fp.halfW, halfD: fp.halfD, halfH: (fp.topYOffset - fp.bottomYOffset) * 0.5 };
}

/* ============================================================================
 * Per-instance render state
 * ============================================================================ */

interface StationInstance {
  station: PlacedCraftStation;
  group: THREE.Group;
  /** When kind === 'campfire', the LPCA's tick driver — called from `tick()`. */
  campfire: CampfireLPCA | null;
  /** When kind === 'workbench', the LPCA owner (for dispose only). */
  workbench: WorkbenchLPCA | null;
  /** Pool slot index this campfire claimed, or -1 if it ran into the pool-
   * exhaustion fallback (off-scene dummy lights, emissive-only). Released
   * back to the pool on `disposeInstance`. */
  lightSlotIdx: number;
}

/**
 * One slot in the phantom-light pool. `fire` + `hot` are real `THREE.PointLight`s
 * permanently parented to the scene from `attachCraftStationBuilder` time. Their
 * `intensity` starts at 0 and stays at 0 unless a placed campfire claims the
 * slot — at which point `createCampfireLPCA`'s `tick()` drives them to a real
 * orange flicker. `ownerId` tracks the campfire that owns this slot (or -1
 * when free).
 */
interface LightPoolSlot {
  fire: THREE.PointLight;
  hot: THREE.PointLight;
  /** -1 = free; otherwise the placed-station id that owns this slot. */
  ownerId: number;
}

/** How many placed campfires can be lit at once. Beyond this count, additional
 * campfires fall back to emissive-only (still visible, just no orange glow on
 * nearby surfaces). 4 covers a typical camp setup; raise if needed but
 * remember each slot adds 2 PointLights to the per-frame lighting cost.
 *
 * Light colors / distances / decays match the dream-mode dock-yard phantoms
 * in `characterScenePreview.campfirePhantomFireLight` so visual parity is
 * exact when a placed campfire claims a pool slot. */
const STATION_LIGHT_POOL_SIZE = 4;

/* ============================================================================
 * Public handle
 * ============================================================================ */

export interface CraftStationBuildHandle {
  /**
   * Sync the rendered scene with the latest store state. Cheap when no stations
   * were added or removed since the prior call (a per-id signature compare).
   * Called on every store emit.
   */
  syncFromState(stations: ReadonlyArray<PlacedCraftStation>): void;
  /**
   * Per-frame: advance every campfire's flame / ember animation. Cheap when no
   * campfires are placed (early-return on empty map).
   */
  tick(timeSec: number): void;
  /**
   * Build a fresh ghost-preview Group for a station kind. Caller is responsible
   * for material substitution (translucent green/red overlay) and disposal.
   * The returned Group is NOT cached — each call constructs new geometry/group
   * references so the caller can mutate freely without poisoning the live scene.
   */
  buildPieceTemplate(kind: PlacedCraftStationKind): THREE.Group;
  /** Detach the station root group + dispose all owned LPCAs. */
  dispose(): void;
}

interface AttachOpts {
  scene: THREE.Scene;
  /**
   * Optional collision world. When provided, every placed station registers a
   * rotated rect footprint via `register()` on `syncFromState`, and removes via
   * `unregister()` when the station is removed from state.
   */
  collisionWorld?: CollisionWorldHandle;
}

export function attachCraftStationBuilder(opts: AttachOpts): CraftStationBuildHandle {
  const root = new THREE.Group();
  root.name = 'CraftStationBuildRoot';
  opts.scene.add(root);

  /** Active instances keyed by station id. */
  const instances = new Map<number, StationInstance>();

  /* Phantom-light pool — see header comment §2 for the full rationale.
   *
   * Allocate ALL pool lights ONCE at attach time so `numPointLights` is
   * constant for the rest of the session. Park them at far-off coordinates
   * (10000, -10000, 10000) with `intensity = 0` until a placed campfire
   * claims a slot. Color / distance / decay match the dream-mode dock-yard
   * phantoms exactly so a placed campfire that claims a slot is visually
   * indistinguishable from the dock-yard original. */
  const lightPool: LightPoolSlot[] = [];
  for (let i = 0; i < STATION_LIGHT_POOL_SIZE; i++) {
    const fire = new THREE.PointLight(0xff8833, 0, 2.4, 1.35);
    fire.position.set(10000 + i * 50, -10000, 10000);
    fire.castShadow = false;
    opts.scene.add(fire);
    const hot = new THREE.PointLight(0xffcc66, 0, 1.2, 1.8);
    hot.position.set(10000 + i * 50 + 0.04, -10000, 10000 + 0.04);
    hot.castShadow = false;
    opts.scene.add(hot);
    lightPool.push({ fire, hot, ownerId: -1 });
  }

  function claimLightSlot(stationId: number, x: number, y: number, z: number): number {
    for (let i = 0; i < lightPool.length; i++) {
      const slot = lightPool[i]!;
      if (slot.ownerId === -1) {
        slot.ownerId = stationId;
        /* Move the lights to the campfire's pit position. Y offsets match the
         * dream-mode `characterScenePreview` phantoms (fire at +0.2, hot at
         * +0.26 with a tiny XZ offset for visual interest). */
        slot.fire.position.set(x, y + 0.2, z);
        slot.hot.position.set(x + 0.04, y + 0.26, z + 0.04);
        return i;
      }
    }
    return -1;
  }

  function releaseLightSlot(slotIdx: number): void {
    if (slotIdx < 0 || slotIdx >= lightPool.length) return;
    const slot = lightPool[slotIdx]!;
    slot.ownerId = -1;
    slot.fire.intensity = 0;
    slot.hot.intensity = 0;
    /* Park back off-scene so the lights don't accidentally light anything
     * visible while idle. Same far-off bookkeeping as initial setup. */
    slot.fire.position.set(10000 + slotIdx * 50, -10000, 10000);
    slot.hot.position.set(10000 + slotIdx * 50 + 0.04, -10000, 10000 + 0.04);
  }

  function footprintOwnerId(stationId: number): string {
    return `craft_station:${stationId}`;
  }

  /**
   * Build one station instance. For unknown kinds (`forge` / `kitchen` until
   * their LPCAs are written) we drop a small placeholder box so the player
   * still gets visible feedback after a placement. Placeholder is intentional —
   * surfaces the gap so we don't ship "you placed something invisible".
   */
  function createInstance(station: PlacedCraftStation): StationInstance {
    const group = new THREE.Group();
    group.name = `craft_station_${station.kind}_${station.id}`;
    group.position.set(station.x, station.y, station.z);
    group.rotation.y = station.rotY;

    let campfire: CampfireLPCA | null = null;
    let workbench: WorkbenchLPCA | null = null;
    let lightSlotIdx = -1;

    if (station.kind === 'campfire') {
      /* Try to claim a pool slot first — that gives the campfire REAL
       * orange glow on nearby surfaces (matches the dream-mode dock-yard
       * campfire exactly). Pool exhaustion (more campfires than slots)
       * falls back to off-scene dummy PointLights so the factory still
       * has somewhere to write intensity but no NEW PointLight joins the
       * scene (which would trigger a full-scene shader recompile). The
       * fallback campfire still glows via emissive flame meshes + bloom,
       * just without the surface bath of light. */
      lightSlotIdx = claimLightSlot(station.id, station.x, station.y, station.z);
      if (lightSlotIdx >= 0) {
        const slot = lightPool[lightSlotIdx]!;
        campfire = createCampfireLPCA({ fireLight: slot.fire, hotLight: slot.hot });
      } else {
        const fireLight = new THREE.PointLight(0xff8833, 0, 2.4, 1.35);
        const hotLight = new THREE.PointLight(0xffcc66, 0, 1.2, 1.8);
        /* DO NOT add to scene — they exist only as targets for the LPCA's
         * intensity animation; the count contribution stays zero. */
        campfire = createCampfireLPCA({ fireLight, hotLight });
      }
      group.add(campfire.group);
    } else if (station.kind === 'workbench') {
      workbench = createWorkbenchLPCA();
      group.add(workbench.group);
    } else {
      /* Placeholder for forge / kitchen — visible coloured box so the player
       * sees their placement land somewhere. Sized to the kind's footprint. */
      const fp = STATION_FOOTPRINT[station.kind];
      const tier = station.kind === 'forge' ? 0xa84a2a : 0x4f7ea2;
      const placeholderMat = new THREE.MeshStandardMaterial({
        color: tier,
        roughness: 0.55,
        metalness: 0.2,
      });
      const placeholderGeo = new THREE.BoxGeometry(
        fp.halfW * 2,
        fp.topYOffset - fp.bottomYOffset,
        fp.halfD * 2,
      );
      const mesh = new THREE.Mesh(placeholderGeo, placeholderMat);
      mesh.position.y = (fp.topYOffset + fp.bottomYOffset) * 0.5;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }

    return { station, group, campfire, workbench, lightSlotIdx };
  }

  function disposeInstance(inst: StationInstance): void {
    if (inst.campfire) inst.campfire.dispose();
    if (inst.workbench) inst.workbench.dispose();
    /* Placeholder geometry/material not tracked individually — Three.js GC handles
     * unreferenced THREE objects, but we proactively dispose Group children to be
     * tidy. */
    inst.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        if (!inst.campfire && !inst.workbench) {
          /* Only dispose placeholder geo (campfire/workbench owners already
           * disposed their internal geos via their own dispose()). */
          o.geometry.dispose();
          if (o.material instanceof THREE.Material) o.material.dispose();
        }
      }
    });
    /* Release any claimed pool slot back to the pool so a future campfire
     * placement can light up. Pool slot lights stay in the scene; only their
     * intensity drops + position parks off-scene (so Three.js's lighting
     * pipeline still counts them but they contribute nothing visible). */
    if (inst.lightSlotIdx >= 0) releaseLightSlot(inst.lightSlotIdx);
    if (inst.group.parent) inst.group.parent.remove(inst.group);
  }

  function registerCollisionFootprint(station: PlacedCraftStation): void {
    if (!opts.collisionWorld) return;
    const fp = STATION_FOOTPRINT[station.kind];
    opts.collisionWorld.register({
      kind: 'rect',
      x: station.x,
      z: station.z,
      halfW: fp.halfW,
      halfD: fp.halfD,
      rotY: station.rotY,
      ownerId: footprintOwnerId(station.id),
      blocking: fp.blocking,
      tag: 'static',
      bottomY: station.y + fp.bottomYOffset,
      topY: station.y + fp.topYOffset,
    });
  }

  function unregisterCollisionFootprint(stationId: number): void {
    if (!opts.collisionWorld) return;
    opts.collisionWorld.unregister(footprintOwnerId(stationId));
  }

  function syncFromState(stations: ReadonlyArray<PlacedCraftStation>): void {
    /* Diff against current `instances` map — add new ids, remove dropped ids,
     * leave unchanged ids untouched. Station mutations (e.g. HP changes from a
     * future Phase 4 damage system) don't change the visual transform so the
     * existing instance can stay; only add / remove triggers a render edit. */
    const liveIds = new Set<number>();
    for (const s of stations) {
      liveIds.add(s.id);
      if (!instances.has(s.id)) {
        const inst = createInstance(s);
        root.add(inst.group);
        instances.set(s.id, inst);
        registerCollisionFootprint(s);
      }
    }
    for (const [id, inst] of instances) {
      if (!liveIds.has(id)) {
        disposeInstance(inst);
        instances.delete(id);
        unregisterCollisionFootprint(id);
      }
    }
  }

  function tick(timeSec: number): void {
    /* Cheap when no campfires are placed — Map.values() iterator + early continue
     * for non-campfire instances (workbenches, placeholders). */
    for (const inst of instances.values()) {
      if (inst.campfire) inst.campfire.tick(timeSec);
    }
  }

  function buildPieceTemplate(kind: PlacedCraftStationKind): THREE.Group {
    /* Fresh group; caller will swap materials for ghost rendering. We disable
     * the campfire's flame light by passing dummy off-scene phantoms — same as
     * the live render path. The ghost geometry never animates so the LPCA's
     * tick is never called on it. */
    const wrap = new THREE.Group();
    if (kind === 'campfire') {
      const fireLight = new THREE.PointLight(0xff8833, 0, 2.4, 1.35);
      const hotLight = new THREE.PointLight(0xff5511, 0, 1.0, 1.0);
      const lpca = createCampfireLPCA({ fireLight, hotLight });
      wrap.add(lpca.group);
    } else if (kind === 'workbench') {
      const lpca = createWorkbenchLPCA();
      wrap.add(lpca.group);
    } else {
      const fp = STATION_FOOTPRINT[kind];
      const tier = kind === 'forge' ? 0xa84a2a : 0x4f7ea2;
      const placeholderMat = new THREE.MeshStandardMaterial({
        color: tier,
        roughness: 0.55,
        metalness: 0.2,
      });
      const placeholderGeo = new THREE.BoxGeometry(
        fp.halfW * 2,
        fp.topYOffset - fp.bottomYOffset,
        fp.halfD * 2,
      );
      const mesh = new THREE.Mesh(placeholderGeo, placeholderMat);
      mesh.position.y = (fp.topYOffset + fp.bottomYOffset) * 0.5;
      wrap.add(mesh);
    }
    return wrap;
  }

  function dispose(): void {
    for (const inst of instances.values()) disposeInstance(inst);
    instances.clear();
    /* Tear down the phantom-light pool. This will flip `numPointLights` back
     * down → triggers the same one-time recompile cost as the initial pool
     * creation (in reverse). Acceptable since `dispose()` only runs at
     * full session teardown / hot-reload, never mid-session. */
    for (const slot of lightPool) {
      if (slot.fire.parent) slot.fire.parent.remove(slot.fire);
      if (slot.hot.parent) slot.hot.parent.remove(slot.hot);
    }
    lightPool.length = 0;
    if (root.parent) root.parent.remove(root);
  }

  return { syncFromState, tick, buildPieceTemplate, dispose };
}
