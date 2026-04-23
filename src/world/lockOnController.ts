/**
 * Awakened-mode lock-on (Z-targeting) — Phase 1.5, see
 * `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` §13.3.
 *
 * Press T (wired in `freeRoamControls.ts`) to acquire the **nearest mob in a 30°
 * forward cone within 25 m** of the player. While locked:
 *   - Camera yaw lerps toward the target (slow ~3 rad/s) so the framing keeps the
 *     target in view even as it moves.
 *   - Magic projectiles fired from `awakenedCombat.ts` get the locked target id, so
 *     they home toward it (`magicProjectiles.ts` handles the actual bend).
 *   - A small reticle on screen would be drawn by the HUD layer (future polish; the
 *     controller exposes `getTarget()` for HUD subscribers).
 *
 * Lock releases when:
 *   - Player presses T again (manual release).
 *   - Target dies (state === 'dying' or removed from store).
 *   - Target moves beyond 30 m of player (forgive a 5 m hysteresis past 25 m acquire).
 *
 * Lock-on REQUIRES camera-lock to be active. T is a no-op when camera-lock is off
 * (caller can prompt the player via the HUD if needed).
 */
import * as THREE from 'three';
import type { AwakenedMobInstance } from '../core/types';
import type { AwakenedMobsHandle } from './awakenedMobs';

/* ============================================================================
 * Lock-on reticle constants
 * ============================================================================ */

/** Inner / outer radius of the emissive lock ring (m). Tuned to be readable but not
 * dominate the silhouette of small mobs (rats). */
const RING_INNER_RADIUS = 0.7;
const RING_OUTER_RADIUS = 0.95;
/** How far ABOVE the terrain the ring sits (m). Avoids z-fighting and stays visible
 * on slopes. */
const RING_TERRAIN_OFFSET = 0.04;
/** Emissive cyan — matches the magic projectile orb so the player reads "magic-target"
 * at a glance. Color the spec called for in BASE_BUILDING_AND_SURVIVAL_PLAN.md §13.3. */
const RING_COLOR = 0x66e0ff;
/** Pulse speed (rad/sec on the sin wave) — slow enough to read as "alive" without
 * being seizure-inducing. */
const RING_PULSE_RATE = 4.0;

/* ============================================================================
 * Constants
 * ============================================================================ */

/** Acquisition cone half-angle (radians). 120° total cone -> 60° half-angle. The
 * widened cone (was 15°) makes T forgiving — any mob within the front HEMISPHERE
 * of the camera is a candidate. The user feedback was "not working where it
 * highlights the nearby enemy" — almost always because the mob was off-cone. */
const ACQUIRE_CONE_HALF = (120 * Math.PI / 180) * 0.5;
/** Cone-scan max distance — bumped to 35 m (was 25 m). */
const ACQUIRE_RANGE = 35;
/** Proximity-fallback range. If NO mob is found in the cone, scan ALL mobs within
 * this radius regardless of facing — saves the player from "rotated my back to
 * the only enemy on the map and T did nothing". Kept smaller than the cone range
 * so the fallback can't lock something the cone scan obviously preferred. */
const FALLBACK_RANGE = 30;
/** Hysteresis — keep lock until target is this far away. */
const RELEASE_RANGE = 45;
/** Camera yaw lerp toward target (radians/sec — exponential). */
const CAMERA_LERP_RATE = 3.0;
/** Cycle window: pressing T within this many ms of the previous T cycles to the
 * NEXT-best mob instead of releasing. Outside the window, T is a normal toggle. */
const CYCLE_WINDOW_MS = 600;

/* ============================================================================
 * Public handle
 * ============================================================================ */

export interface LockOnHandle {
  /** True while a lock is held. */
  isActive(): boolean;
  /** The locked mob (or null when not active / target died). */
  getTarget(): AwakenedMobInstance | null;
  /**
   * Toggle: acquire if no lock; release if locked. Returns the new active state.
   * No-op (returns false) if camera-lock isn't engaged.
   */
  toggle(): boolean;
  /**
   * Per-frame: drop target if dead/out-of-range; lerp camera toward target. Cheap
   * when not active.
   */
  update(dtSec: number): void;
  dispose(): void;
}

interface AttachOpts {
  mobs: AwakenedMobsHandle;
  /** Player's avatar — used for cone-scan origin + range checks. */
  avatar: THREE.Object3D;
  /** Camera reference — used to compute the forward direction for cone scan. */
  camera: THREE.Camera;
  /** Returns true while camera-lock is active (gate on T toggle). */
  isCameraLocked: () => boolean;
  /** Scene preview hook for camera yaw control. Same signature as `setCameraYawPitch`. */
  setCameraYawPitch: (yaw: number, pitch: number) => void;
  getCameraYawPitch: () => { yaw: number; pitch: number };
  /**
   * Optional scene + terrain sampler — when provided, the controller mounts a flat
   * emissive cyan ring under the locked target so the player can SEE the lock-on
   * state. The ring follows the target's XZ each frame and sits at terrain height +
   * `RING_TERRAIN_OFFSET`. When omitted, the controller still works (no ring, no
   * scene mutation) — useful for headless tests.
   */
  scene?: THREE.Scene;
  getTerrainHeight?: (x: number, z: number) => number;
}

/* ============================================================================
 * Implementation
 * ============================================================================ */

export function attachLockOnController(opts: AttachOpts): LockOnHandle {
  let lockedId: number | null = null;
  /** Real-time ms when the most recent acquire / cycle happened — gates the cycle window. */
  let lastAcquireMs = 0;
  const tmpForward = new THREE.Vector3();

  /* === Lock-on reticle (emissive ring) ===
   *
   * Was lazy-built on first lock, but the first MeshStandardMaterial render
   * triggers a 100-400 ms shader compile freeze (same pattern documented in
   * `magicProjectiles.warmShaders` / `cabinBuilder.warmShaders` /
   * `awakenedMobs.warmShaders`). The user reported "freeze the first time
   * we shoot or enemies start attacking" — first lock-T ALSO triggered
   * this freeze, just less often than first cast.
   *
   * **2026-04 fix.** Eager-build the reticle at attach time, parked at a
   * far-off Y (-10000 m) so it's invisible on screen but the renderer
   * compiles the program in the boot warm window. First T-press just
   * positions the existing mesh and toggles `.visible`, no compile.
   * Phantom-light rule honored — emissive only, NO `THREE.PointLight`
   * (matches the project-wide invariant in §10).
   */
  let reticleMesh: THREE.Mesh | null = null;
  let reticleMaterial: THREE.MeshStandardMaterial | null = null;
  let reticleGeometry: THREE.RingGeometry | null = null;
  let reticleClockSec = 0;

  /* Eager-build the reticle at attach time (parked off-scene at Y=-10000) so
   * the MeshStandardMaterial program compiles in the boot warm window, not
   * on the first T-press. `ensureReticle` becomes a no-op for normal usage;
   * `showReticleAt` lifts the mesh up to the target on first lock. */
  if (opts.scene) {
    reticleGeometry = new THREE.RingGeometry(RING_INNER_RADIUS, RING_OUTER_RADIUS, 48);
    reticleGeometry.rotateX(-Math.PI / 2);
    reticleMaterial = new THREE.MeshStandardMaterial({
      color: RING_COLOR,
      emissive: RING_COLOR,
      emissiveIntensity: 1.6,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    reticleMesh = new THREE.Mesh(reticleGeometry, reticleMaterial);
    reticleMesh.name = 'LockOnReticle';
    reticleMesh.position.set(0, -10000, 0); /* parked far below ground for boot warm */
    reticleMesh.visible = false;
    opts.scene.add(reticleMesh);
  }

  function ensureReticle(): void {
    if (reticleMesh || !opts.scene) return;
    reticleGeometry = new THREE.RingGeometry(RING_INNER_RADIUS, RING_OUTER_RADIUS, 48);
    /* Lay flat on the ground — RingGeometry is built in the XY plane; rotate -90° on X
     * so it sits horizontally when added to the scene. */
    reticleGeometry.rotateX(-Math.PI / 2);
    reticleMaterial = new THREE.MeshStandardMaterial({
      color: RING_COLOR,
      emissive: RING_COLOR,
      emissiveIntensity: 1.6,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false, /* avoid blocking other transparents on the floor */
    });
    reticleMesh = new THREE.Mesh(reticleGeometry, reticleMaterial);
    reticleMesh.name = 'LockOnReticle';
    reticleMesh.visible = false;
    opts.scene.add(reticleMesh);
  }

  function showReticleAt(x: number, z: number): void {
    if (!reticleMesh) return;
    const y = opts.getTerrainHeight ? opts.getTerrainHeight(x, z) : 0;
    reticleMesh.position.set(x, y + RING_TERRAIN_OFFSET, z);
    reticleMesh.visible = true;
  }

  function hideReticle(): void {
    if (reticleMesh) reticleMesh.visible = false;
  }

  /**
   * Acquire (or cycle) a lock target. Two-stage scan + an optional `excludeId` so
   * a re-tap can pick the NEXT-closest mob instead of immediately re-locking the
   * same one.
   *
   *   - Stage 1: cone-scan within `ACQUIRE_CONE_HALF` (60°) up to `ACQUIRE_RANGE`
   *     (35 m). Mobs are scored by distance — closer wins. Off-cone mobs don't
   *     compete with on-cone mobs (we keep two separate score buckets and prefer
   *     cone hits), so a player aimed at a wolf doesn't suddenly lock onto a rat
   *     behind them just because the rat is closer.
   *   - Stage 2: proximity-fallback. Only runs if stage 1 returned nothing. Scans
   *     ALL non-dying mobs within `FALLBACK_RANGE` (30 m) regardless of facing.
   *     Saves the "I clearly meant to lock that mob and T did nothing" frustration.
   *
   * Returns the chosen mob id, or null if no candidate exists.
   */
  function findBestTarget(excludeId: number | null): number | null {
    opts.camera.getWorldDirection(tmpForward);
    const fwdX = tmpForward.x;
    const fwdZ = tmpForward.z;
    const fwdLen = Math.hypot(fwdX, fwdZ);
    /* Camera forward MAY be vertical (looking straight up/down) — fall back to
     * skipping the cone test in that pathological case so the player still gets
     * SOMETHING locked from the proximity fallback. */
    const haveForward = fwdLen >= 1e-5;
    const ufx = haveForward ? fwdX / fwdLen : 0;
    const ufz = haveForward ? fwdZ / fwdLen : 0;
    const ax = opts.avatar.position.x;
    const az = opts.avatar.position.z;
    const mobs = opts.mobs.getAllMobs();

    /* Stage 1: cone scan. */
    let coneBest: number | null = null;
    let coneBestDist = ACQUIRE_RANGE;
    if (haveForward) {
      for (const mob of mobs) {
        if (mob.state === 'dying') continue;
        if (excludeId != null && mob.id === excludeId) continue;
        const dx = mob.x - ax;
        const dz = mob.z - az;
        const dist = Math.hypot(dx, dz);
        if (dist > ACQUIRE_RANGE) continue;
        if (dist < 1e-5) {
          /* Co-incident mob — auto-pick (closest possible). */
          coneBest = mob.id;
          coneBestDist = 0;
          continue;
        }
        const dot = (dx * ufx + dz * ufz) / dist;
        const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
        if (ang > ACQUIRE_CONE_HALF) continue;
        if (dist < coneBestDist) {
          coneBestDist = dist;
          coneBest = mob.id;
        }
      }
    }
    if (coneBest != null) return coneBest;

    /* Stage 2: proximity fallback (no cone). */
    let proxBest: number | null = null;
    let proxBestDist = FALLBACK_RANGE;
    for (const mob of mobs) {
      if (mob.state === 'dying') continue;
      if (excludeId != null && mob.id === excludeId) continue;
      const dx = mob.x - ax;
      const dz = mob.z - az;
      const dist = Math.hypot(dx, dz);
      if (dist > FALLBACK_RANGE) continue;
      if (dist < proxBestDist) {
        proxBestDist = dist;
        proxBest = mob.id;
      }
    }
    return proxBest;
  }

  function acquire(): boolean {
    const id = findBestTarget(null);
    if (id == null) return false;
    lockedId = id;
    lastAcquireMs = Date.now();
    /* First-lock-of-session lazy-init the reticle; subsequent locks just reuse it. */
    ensureReticle();
    return true;
  }

  /**
   * Cycle to the NEXT-best mob (skipping the currently locked one). If no other
   * candidate exists, the existing lock is held instead of being released — feels
   * better than "I tapped T to switch targets and got disengaged entirely".
   * Returns true if the lock changed (or stayed valid), false if nothing exists.
   */
  function cycle(): boolean {
    if (lockedId == null) return acquire();
    const next = findBestTarget(lockedId);
    if (next != null) {
      lockedId = next;
      lastAcquireMs = Date.now();
      ensureReticle();
      return true;
    }
    /* No alternative — refresh the timestamp so a third tap inside the window
     * doesn't release; player is clearly trying to find a different target but
     * there isn't one. */
    lastAcquireMs = Date.now();
    return true;
  }

  function release(): void {
    lockedId = null;
    hideReticle();
  }

  function toggle(): boolean {
    if (!opts.isCameraLocked()) return false;
    /* CYCLE-ON-RETAP: pressing T while already locked AND within CYCLE_WINDOW_MS
     * of the last acquire/cycle picks the next-best mob instead of releasing.
     * Outside the window, T is a normal toggle (release the existing lock). */
    if (lockedId != null) {
      const sinceLastMs = Date.now() - lastAcquireMs;
      if (sinceLastMs <= CYCLE_WINDOW_MS) {
        cycle();
        return true;
      }
      release();
      return false;
    }
    return acquire();
  }

  function update(dtSec: number): void {
    if (lockedId == null) return;
    const target = opts.mobs.getMob(lockedId);
    if (!target || target.state === 'dying') {
      release();
      return;
    }
    const ax = opts.avatar.position.x;
    const az = opts.avatar.position.z;
    const dx = target.x - ax;
    const dz = target.z - az;
    const dist = Math.hypot(dx, dz);
    if (dist > RELEASE_RANGE) {
      release();
      return;
    }
    /* Reticle: position under the live target XZ + pulse the emissive intensity so
     * it reads as "active lock", not a static decal. The pulse uses a sine of an
     * accumulator (frame-rate independent — `reticleClockSec` advances by `dtSec`). */
    reticleClockSec += dtSec;
    if (reticleMesh && reticleMaterial) {
      showReticleAt(target.x, target.z);
      const pulse = 0.6 + 0.5 * (0.5 + 0.5 * Math.sin(reticleClockSec * RING_PULSE_RATE));
      reticleMaterial.emissiveIntensity = pulse * 1.6;
    }
    /* Lerp camera yaw toward the world-yaw that points at the target. The dock's
     * camera framing math uses `dockCamYaw` as an offset to a base orbit yaw; since
     * we don't know the base, we lerp our offset relative to the offset that would
     * face the target. Approximation: read camera forward, compare to target dir,
     * and write a delta back via getCameraYawPitch + setCameraYawPitch. */
    opts.camera.getWorldDirection(tmpForward);
    const camFwdX = tmpForward.x;
    const camFwdZ = tmpForward.z;
    const camFwdLen = Math.hypot(camFwdX, camFwdZ);
    if (camFwdLen < 1e-5) return;
    const ufx = camFwdX / camFwdLen;
    const ufz = camFwdZ / camFwdLen;
    /* Signed angle from camera forward to target direction (in camera-XZ plane). */
    const tx = dx / dist;
    const tz = dz / dist;
    const cross = ufx * tz - ufz * tx;
    const dot = ufx * tx + ufz * tz;
    const sigAng = Math.atan2(cross, dot);
    /* Lerp toward zero (i.e., reduce signed angle) — the camera yaw shifts each frame
     * by a fraction of the angle, framerate-independent. */
    const k = 1 - Math.exp(-CAMERA_LERP_RATE * dtSec);
    const deltaYaw = sigAng * k;
    const cur = opts.getCameraYawPitch();
    /* Sign convention (re-derived after the yaw flip in `cameraLockController.ts`):
     *   - `sigAng > 0` means target is to the player's RIGHT (cross product RH).
     *   - To make the camera LOOK RIGHT, the dock's `dockCamYaw` must DECREASE
     *     (because the framing math `ax = sin(yaw) * dist` puts camera +X for
     *     positive yaw -> view sweeps -X = looking LEFT; the flip in cameraLock
     *     made `mouse right = yaw decrease`, lock-on must follow the same sign). */
    opts.setCameraYawPitch(cur.yaw - deltaYaw, cur.pitch);
  }

  function dispose(): void {
    lockedId = null;
    if (reticleMesh && reticleMesh.parent) reticleMesh.parent.remove(reticleMesh);
    if (reticleGeometry) reticleGeometry.dispose();
    if (reticleMaterial) reticleMaterial.dispose();
    reticleMesh = null;
    reticleGeometry = null;
    reticleMaterial = null;
  }

  return {
    isActive: () => lockedId != null,
    getTarget: () => (lockedId != null ? opts.mobs.getMob(lockedId) : null),
    toggle,
    update,
    dispose,
  };
}
