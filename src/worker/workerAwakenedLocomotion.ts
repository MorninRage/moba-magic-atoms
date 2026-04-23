/**
 * Awakened free-roam locomotion on the **render worker** — reads
 * {@link SharedRenderState} keyboard + mouse deltas (filled by main-thread
 * forwarders) and integrates avatar + camera like {@link attachFreeRoamControls},
 * without DOM or audio.
 *
 * **Wave 0 of full dock migration:** when `CharacterSceneHost` stays in-game,
 * this replaces main-thread `attachFreeRoamControls` for the worker-owned
 * avatar. Mobs/projectiles can then target the same `collisionWorld` on the
 * worker scene.
 *
 * **Omissions vs main** (add as migration continues): footstep/land/jump audio
 * (post `audioSfx` to main) aside from mushroom bounce, jump-buffer edge timing
 * uses per-frame poll instead of key repeat semantics.
 */
import * as THREE from 'three';
import type { CollisionWorldHandle } from '../world/collisionWorld';
import { DEFAULT_STEP_UP_HEIGHT } from '../world/collisionWorld';
import type { AwakenedBouncyMushroomsHandle } from '../world/awakenedBouncyMushrooms';
import type { SharedRenderState } from './sharedState';
import { KEY_BIT } from './sharedState';
import {
  applySoloDockCameraFraming,
  getSoloDockCameraForwardXZ,
} from '../world/dockSoloCameraFraming';

const WALK_SPEED = 4.4;
const SPRINT_MULTIPLIER = 1.65;
const FACE_SLERP_RATE = 14;
const VELOCITY_SMOOTH_RATE = 18;
const GRAVITY = -22;
const JUMP_VELOCITY = 9.0;
const DOUBLE_JUMP_VELOCITY = 14.0;
const COYOTE_TIME = 0.12;
const JUMP_BUFFER = 0.12;
const FLIP_DURATION = 0.55;
const AVATAR_HEIGHT = 1.8;
const JUMP_SUBSTEP_VY = 12;
const WALK_OFF_THRESHOLD = 0.08;
const STEP_UP_HEIGHT = DEFAULT_STEP_UP_HEIGHT;
const GROUND_LANDING_TOLERANCE = 0.1;
const PLAYER_RADIUS = 0.4;
const PLAYER_OWNER = 'player';
/** Radians per CSS pixel when pointer-locked (FPS look). */
function shortestYawDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export type WorkerAwakenedLocomotionStepArgs = {
  sharedState: SharedRenderState;
  avatar: THREE.Group;
  camera: THREE.PerspectiveCamera;
  /** Base vertical FOV (degrees) before wheel-zoom factor — matches worker dock camera ctor. */
  baseCameraFovDeg: number;
  /** Esc / project scale — match `CharacterScenePreview.projectFovScale` (default 1). */
  projectFovScale?: number;
  /** Distance multiplier vs default third-person follow (wheel zoom). */
  cameraZoom: number;
  /**
   * Free-cursor orbit offsets (rad) — mirrors `CharacterScenePreview.dockCamYaw` /
   * `dockCamPitch` for third-person drag + lock-on.
   */
  orbitYaw: number;
  orbitPitch: number;
  getTerrainHeight: (x: number, z: number) => number;
  mapRadius: number;
  collisionWorld: CollisionWorldHandle | null;
  cameraLockActive: boolean;
  bouncyMushrooms: AwakenedBouncyMushroomsHandle | null;
  /** Called when a mushroom bounce launches the player (impact speed for SFX scaling). */
  onMushroomBounceSfx?: (impactSpeed: number) => void;
  dt: number;
};

export class WorkerAwakenedLocomotion {
  private velX = 0;
  private velZ = 0;
  private vy = 0;
  private isAirborne = false;
  private usedDoubleJump = false;
  private bounceJumpAvailable = false;
  private flipStartedAtSec = -1;
  private lastGroundedAtSec = 0;
  private bufferedJumpAtSec = -1;
  private elapsedSec = 0;
  private lastGroundedSurfaceY: number | null = null;
  private spaceWasDown = false;
  private playerRegistered = false;

  reset(): void {
    this.velX = 0;
    this.velZ = 0;
    this.vy = 0;
    this.isAirborne = false;
    this.usedDoubleJump = false;
    this.bounceJumpAvailable = false;
    this.flipStartedAtSec = -1;
    this.lastGroundedAtSec = 0;
    this.bufferedJumpAtSec = -1;
    this.lastGroundedSurfaceY = null;
    this.spaceWasDown = false;
  }

  /** Call before collision world is disposed or when leaving awakened mode. */
  disposeFromCollision(collisionWorld: CollisionWorldHandle | null): void {
    if (!collisionWorld || !this.playerRegistered) return;
    try {
      collisionWorld.unregister(PLAYER_OWNER);
    } catch {
      /* ignore */
    }
    this.playerRegistered = false;
  }

  getAirborne(): boolean {
    return this.isAirborne;
  }

  getGroundedSurfaceY(): number | null {
    return this.lastGroundedSurfaceY;
  }

  private keyDown(shared: SharedRenderState, bit: number): boolean {
    return shared.isKeyDown(bit);
  }

  private tryJump(elapsed: number): boolean {
    const sinceGround = elapsed - this.lastGroundedAtSec;
    if (!this.isAirborne || sinceGround <= COYOTE_TIME) {
      this.vy = JUMP_VELOCITY;
      this.isAirborne = true;
      this.usedDoubleJump = false;
      this.bounceJumpAvailable = false;
      this.flipStartedAtSec = -1;
      this.lastGroundedAtSec = -Infinity;
      return true;
    }
    if (this.bounceJumpAvailable) {
      this.vy = Math.max(this.vy, JUMP_VELOCITY);
      this.bounceJumpAvailable = false;
      this.flipStartedAtSec = -1;
      return true;
    }
    if (!this.usedDoubleJump) {
      this.vy = DOUBLE_JUMP_VELOCITY;
      this.usedDoubleJump = true;
      this.flipStartedAtSec = elapsed;
      return true;
    }
    return false;
  }

  step(a: WorkerAwakenedLocomotionStepArgs): void {
    const {
      sharedState: shared,
      avatar,
      camera,
      baseCameraFovDeg,
      projectFovScale = 1,
      cameraZoom,
      orbitYaw,
      orbitPitch,
      getTerrainHeight,
      mapRadius,
      collisionWorld,
      cameraLockActive,
      bouncyMushrooms,
      onMushroomBounceSfx,
      dt,
    } = a;
    const dtSec = Math.max(0, Math.min(0.1, dt));
    this.elapsedSec += dtSec;

    const radius = PLAYER_RADIUS;

    if (collisionWorld && !this.playerRegistered) {
      try {
        collisionWorld.register({
          kind: 'circle',
          x: avatar.position.x,
          z: avatar.position.z,
          r: radius,
          ownerId: PLAYER_OWNER,
          blocking: true,
          tag: 'player',
          bottomY: avatar.position.y,
          topY: avatar.position.y + AVATAR_HEIGHT,
        });
        this.playerRegistered = true;
      } catch {
        /* best-effort */
      }
    }

    const sampleGroundYAndOwner = (
      currY: number,
      snapUpHeight: number,
      predictXZ: boolean,
    ): { y: number; ownerId: string | null } => {
      const ax = avatar.position.x;
      const az = avatar.position.z;
      const terrainY = getTerrainHeight(ax, az);
      if (!collisionWorld) return { y: terrainY, ownerId: null };
      let best = collisionWorld.getGroundYAndOwner(ax, az, currY, terrainY, radius, snapUpHeight);
      if (predictXZ && (Math.abs(this.velX) > 0.01 || Math.abs(this.velZ) > 0.01)) {
        const px = ax + this.velX * dtSec;
        const pz = az + this.velZ * dtSec;
        const ptY = getTerrainHeight(px, pz);
        const pred = collisionWorld.getGroundYAndOwner(px, pz, currY, ptY, radius, snapUpHeight);
        if (pred.y > best.y) best = pred;
      }
      return best;
    };

    const sampleGroundY = (currY: number, snapUpHeight: number, predictXZ: boolean): number =>
      sampleGroundYAndOwner(currY, snapUpHeight, predictXZ).y;

    /* Main-thread `cameraLockController` drives orbit yaw/pitch via `setCameraYawPitch`
     * (not SAB mouse deltas). Drain accumulated mouse so the shared buffer does not grow. */
    shared.drainMouseDelta();

    /* --- Vertical phase (before horizontal) --- */
    if (this.isAirborne) {
      const speed = Math.max(Math.abs(this.vy), 1);
      const subSteps = Math.min(5, Math.max(1, Math.ceil(speed / JUMP_SUBSTEP_VY)));
      const sub = dtSec / subSteps;
      let landed = false;
      let impactSpeed = 0;
      let landingOwnerId: string | null = null;
      for (let s = 0; s < subSteps; s++) {
        this.vy += GRAVITY * sub;
        avatar.position.y += this.vy * sub;
        if (this.vy > 0) continue;
        const ground = sampleGroundYAndOwner(avatar.position.y, GROUND_LANDING_TOLERANCE, true);
        if (avatar.position.y <= ground.y) {
          impactSpeed = Math.abs(this.vy);
          avatar.position.y = ground.y;
          landed = true;
          landingOwnerId = ground.ownerId;
          break;
        }
      }
      if (
        landed &&
        landingOwnerId !== null &&
        bouncyMushrooms &&
        landingOwnerId.startsWith('mushroom:')
      ) {
        const jumpHeld = this.keyDown(shared, KEY_BIT.SPACE);
        const bounceResult = bouncyMushrooms.onPlayerLanded(landingOwnerId, impactSpeed, jumpHeld);
        if (bounceResult !== null) {
          this.vy = bounceResult.bounceVy;
          this.isAirborne = true;
          this.usedDoubleJump = false;
          this.bounceJumpAvailable = true;
          this.flipStartedAtSec = -1;
          onMushroomBounceSfx?.(impactSpeed);
          landed = false;
        }
      }
      if (landed) {
        this.vy = 0;
        this.isAirborne = false;
        this.usedDoubleJump = false;
        this.bounceJumpAvailable = false;
        this.flipStartedAtSec = -1;
        avatar.rotation.x = 0;
        this.lastGroundedAtSec = this.elapsedSec;
        if (this.bufferedJumpAtSec >= 0 && this.elapsedSec - this.bufferedJumpAtSec <= JUMP_BUFFER) {
          this.tryJump(this.elapsedSec);
        }
        this.bufferedJumpAtSec = -1;
      }
    }

    /* --- WASD --- */
    let fwd = 0;
    let strafe = 0;
    if (this.keyDown(shared, KEY_BIT.W)) fwd += 1;
    if (this.keyDown(shared, KEY_BIT.S)) fwd -= 1;
    if (this.keyDown(shared, KEY_BIT.A)) strafe -= 1;
    if (this.keyDown(shared, KEY_BIT.D)) strafe += 1;
    if (this.keyDown(shared, KEY_BIT.ARROW_UP)) fwd += 1;
    if (this.keyDown(shared, KEY_BIT.ARROW_DOWN)) fwd -= 1;
    if (this.keyDown(shared, KEY_BIT.ARROW_LEFT)) strafe -= 1;
    if (this.keyDown(shared, KEY_BIT.ARROW_RIGHT)) strafe += 1;

    const spaceDown = this.keyDown(shared, KEY_BIT.SPACE);
    if (spaceDown && !this.spaceWasDown) {
      if (!this.tryJump(this.elapsedSec)) {
        this.bufferedJumpAtSec = this.elapsedSec;
      }
    }
    this.spaceWasDown = spaceDown;

    /* Flip animation (visual only) */
    if (this.flipStartedAtSec >= 0) {
      const t = (this.elapsedSec - this.flipStartedAtSec) / FLIP_DURATION;
      if (t >= 1) {
        avatar.rotation.x = 0;
        this.flipStartedAtSec = -1;
      } else {
        const u = t * t * (3 - 2 * t);
        avatar.rotation.x = u * Math.PI * 2;
      }
    }

    /* Match {@link CharacterScenePreview.getCameraForwardXZ}: toward framing look-at, not
     * body yaw (same for Q-lock third-person and free cursor). */
    const getCamForwardXZ = (): { x: number; z: number } =>
      getSoloDockCameraForwardXZ({
        cameraPosX: camera.position.x,
        cameraPosZ: camera.position.z,
        avatarX: avatar.position.x,
        avatarY: avatar.position.y,
        avatarZ: avatar.position.z,
      });

    let targetVx = 0;
    let targetVz = 0;
    if (fwd !== 0 || strafe !== 0) {
      const len = Math.hypot(fwd, strafe);
      fwd /= len;
      strafe /= len;
      const cf = getCamForwardXZ();
      const dirX = fwd * cf.x - strafe * cf.z;
      const dirZ = fwd * cf.z + strafe * cf.x;
      const dirLen = Math.hypot(dirX, dirZ);
      if (dirLen > 1e-5) {
        const sprint = this.keyDown(shared, KEY_BIT.SHIFT);
        const speedMul = sprint ? SPRINT_MULTIPLIER : 1;
        targetVx = (dirX / dirLen) * WALK_SPEED * speedMul;
        targetVz = (dirZ / dirLen) * WALK_SPEED * speedMul;
      }
    }

    const k = 1 - Math.exp(-VELOCITY_SMOOTH_RATE * dtSec);
    this.velX += (targetVx - this.velX) * k;
    this.velZ += (targetVz - this.velZ) * k;

    if (cameraLockActive) {
      const cf = getCamForwardXZ();
      if (Math.abs(cf.x) + Math.abs(cf.z) > 1e-5) {
        const targetYaw = Math.atan2(cf.x, cf.z);
        const delta = shortestYawDelta(avatar.rotation.y, targetYaw);
        const maxStep = 12 * dtSec;
        const step = Math.max(-maxStep, Math.min(maxStep, delta));
        avatar.rotation.y += step;
      }
    }

    const speed = Math.hypot(this.velX, this.velZ);
    if (speed > 0.01) {
      const fromX = avatar.position.x;
      const fromZ = avatar.position.z;
      let nx = fromX + this.velX * dtSec;
      let nz = fromZ + this.velZ * dtSec;
      const r = Math.hypot(nx, nz);
      const maxR = mapRadius - 0.5;
      if (r > maxR) {
        const k2 = maxR / r;
        nx *= k2;
        nz *= k2;
      }
      if (collisionWorld) {
        const playerBottomY = avatar.position.y;
        const playerTopY = playerBottomY + AVATAR_HEIGHT;
        const stepUp = this.isAirborne ? 0 : STEP_UP_HEIGHT;
        const resolved = collisionWorld.resolveCircleMove(
          PLAYER_OWNER,
          fromX,
          fromZ,
          nx,
          nz,
          radius,
          playerBottomY,
          playerTopY,
          stepUp,
        );
        nx = resolved.x;
        nz = resolved.z;
      }
      avatar.position.x = nx;
      avatar.position.z = nz;

      if (!cameraLockActive) {
        const ux = this.velX / speed;
        const uz = this.velZ / speed;
        const targetYaw = Math.atan2(ux, uz);
        const delta = shortestYawDelta(avatar.rotation.y, targetYaw);
        const maxStep = FACE_SLERP_RATE * dtSec;
        const step = Math.max(-maxStep, Math.min(maxStep, delta));
        avatar.rotation.y += step;
      }
    } else {
      this.velX = 0;
      this.velZ = 0;
    }

    if (!this.isAirborne) {
      const groundY = sampleGroundY(avatar.position.y, STEP_UP_HEIGHT, false);
      this.lastGroundedSurfaceY = groundY;
      if (avatar.position.y > groundY + WALK_OFF_THRESHOLD) {
        this.isAirborne = true;
        this.vy = 0;
      } else if (groundY > avatar.position.y) {
        avatar.position.y = groundY;
      }
    } else {
      this.lastGroundedSurfaceY = null;
    }

    if (collisionWorld && this.playerRegistered) {
      const py = avatar.position.y;
      try {
        collisionWorld.movePosition(PLAYER_OWNER, avatar.position.x, avatar.position.z, py, py + AVATAR_HEIGHT);
      } catch {
        /* ignore */
      }
    }

    const zoom = Math.max(0.2, Math.min(2.35, cameraZoom));
    applySoloDockCameraFraming({
      camera,
      avatarX: avatar.position.x,
      avatarY: avatar.position.y,
      avatarZ: avatar.position.z,
      dockCamYaw: orbitYaw,
      dockCamPitch: orbitPitch,
      userCameraZoom: zoom,
      cameraLockActive,
      baseFovDeg: baseCameraFovDeg,
      projectFovScale,
      getTerrainHeight,
    });
  }
}
