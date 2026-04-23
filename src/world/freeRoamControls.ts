/**
 * Free-roam controls for awakened mode (`docs/AWAKENING_AND_FREE_ROAM_PLAN.md` §7).
 *
 * Adds **WASD** movement, **Space** (jump + air-double-jump), **E** (interact), and
 * **Tab** (open menu overlay) on top of the dock's existing camera system. We deliberately
 * do NOT touch mouse / pointer / pointer-lock so the dock's left-click-drag orbit,
 * right-click-pan, wheel-zoom, and double-click reset keep working in awakened mode.
 *
 * **Jump architecture (responsive + body-relative flip):**
 *   - Free-roam controls own avatar Y *only while airborne*. The dock's
 *     `syncAvatarFeetToTerrain` is gated on the `isAirborne` flag we expose via
 *     `freeRoamHandle.isAirborne()`. While grounded, the dock's accurate AABB-based foot
 *     snap runs unchanged — we don't second-guess what "grounded Y" should be.
 *   - On Space, we add a vertical velocity. Each frame in flight: `vy += GRAVITY * dt`,
 *     `avatar.y += vy * dt`. Landing trigger uses the WORLD-RELATIVE
 *     `collisionWorld.getGroundY(x, z, currentY)` so the player can land on top of any
 *     blocking footprint (foundation tops, tree canopies, wall tops) — not just the
 *     spot they jumped from. When grounded, the same sampler detects walking off a
 *     ledge and transitions back to airborne so falls happen naturally.
 *   - **Every jump triggers a front flip** (user spec: "always do a front flip"). First
 *     jump = full forward roll. Double jump = another forward roll. Avatar's
 *     `rotation.order` is set to `'YXZ'` in `setAwakenedFreeRoam` so `rotation.x` (the
 *     flip pitch) applies AFTER `rotation.y` (the body yaw) — meaning the flip is around
 *     the BODY's local lateral axis regardless of which way the camera or body is facing.
 *     The flip looks identical from every angle (front-flip = head-over-heels forward).
 *   - **Coyote time + jump buffer** for forgiving input timing (Celeste / Hollow Knight
 *     standard): jump is still allowed within 120 ms of leaving the ground (coyote), and
 *     a Space press up to 120 ms BEFORE landing fires the jump on touchdown (buffer).
 *
 * **No collision yet.** Avatar walks/jumps freely with terrain ground-snap; trees and
 * crystals are flat XZ obstacles you currently walk through. Real collision is a separate
 * system (see plan §12 risks).
 *
 * **Movement SFX (locked):** `tryJump()` fires `playJumpSound()` for the first jump and
 * `playDoubleJumpSound()` for the air double jump. The landing branch in `update()` fires
 * `playLandSound(intensity)` where intensity is computed from the impact `vy` magnitude
 * (heavier landings sound heavier). Footstep SFX is owned by `characterScenePreview`'s
 * walk-cycle integrator (where the per-leg phase is already computed) — wiring it here
 * would duplicate the cycle math for no gain.
 */

/* Lazy-load movement SFX — façade keeps this module independent of audio init order. */
import {
  playDoubleJumpSound,
  playJumpSound,
  playLandSound,
  playMushroomBounceSound,
} from '../audio/audioBridge';

export interface FreeRoamHandle {
  /** Per-frame: integrate WASD + jump physics into avatar position. Call from the dock loop. */
  update(dtSec: number): void;
  /** Tear down all event listeners. */
  detach(): void;
  /** True while the player is in awakened mode (callbacks gate on this). */
  isActive(): boolean;
  /**
   * Force-clear the WASD/jump key set. Call when the realm flips back to deck OR the menu
   * overlay opens, so the avatar doesn't keep walking after focus moves away.
   * Fixes "stuck moving" when releasing a key while the page lost focus.
   */
  clearKeys(): void;
  /**
   * True while a jump is in flight (avatar mid-air). Host (`mountApp`) polls this each
   * frame and forwards to the dock so the dock's per-frame foot-snap is skipped during
   * the jump arc — without that gate the snap cancels the jump's vy back to ground every
   * frame and Space appears to do nothing on subsequent presses.
   */
  isAirborne(): boolean;
  /**
   * Last grounded surface Y under the player's feet — terrain Y if standing on
   * bare ground, OR the top of a foundation / floor / stair / low rock / tree
   * top the player walked onto. `null` while airborne. Used by the dock's
   * `syncAvatarFeetToTerrain` to stop yanking the player back to terrain when
   * they're STANDING on a taller surface.
   */
  getGroundedSurfaceY(): number | null;
}

export interface FreeRoamOptions {
  avatar: import('three').Group;
  /** Foot-grounding sampler from the dock heightfield (`forest.getHeightAt`). */
  getTerrainHeight: (x: number, z: number) => number;
  /** Largest XZ radius the avatar can wander to (dock radius). */
  mapRadius: number;
  /**
   * Camera-forward direction projected to XZ — driven by the dock's framing math
   * which already follows the avatar. WASD computes movement in this frame so
   * pressing W walks toward where the camera looks.
   */
  getCameraForwardXZ: () => { x: number; z: number };
  /**
   * Returns true while the realm is `'awakened'`. Read on every event so flipping back
   * to `'deck'` mid-frame instantly suppresses input without us needing to rewire.
   */
  isAwakened: () => boolean;
  /** Fires on `E` key when active (Phase D wires this to harvest the nearest node). */
  onInteract: () => void;
  /**
   * Fires on `Tab` key when active and no input field is focused. UI side opens the
   * menu overlay. We `preventDefault()` first so the browser doesn't move focus.
   */
  onToggleMenu: () => void;
  /**
   * Worker GL integrates WASD/jump from the shared key bitmask; main keeps Tab/E/combat.
   * Avatar pose must be synced from the worker each frame before systems read `avatar`.
   */
  workerOwnsAvatarMovement?: boolean;
  /** When worker owns movement, poll jump/airborne from the worker (SAB), not local physics. */
  getAirborneOverride?: () => boolean;
  /**
   * Awakened-mode build mode (Phase 1 — see `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md`).
   * When `isBuildModeActive()` returns true, input handling is rewired:
   *   - `E` calls `onBuildConfirm` instead of `onInteract` (place the ghost piece).
   *   - `Esc` calls `onBuildCancel` instead of opening the system menu (drop ghost).
   *   - `R` calls `onBuildRotate(±90°)`.
   *   - `wheel` calls `onBuildRotate(±15°)`.
   * When inactive, all of the above are no-ops and harvest E + system-menu Esc work
   * as before. All four callbacks are optional — if absent, the build-mode path is
   * effectively disabled regardless of `isBuildModeActive`.
   */
  isBuildModeActive?: () => boolean;
  onBuildConfirm?: () => void;
  onBuildCancel?: () => void;
  onBuildRotate?: (radians: number) => void;
  /**
   * Awakened-mode camera-lock + combat (Phase 1.5 — see
   * `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` §12 + §13).
   *   - Q always toggles the camera lock (any time in awakened mode). When locked,
   *     the cursor disappears (pointer-lock) + mouse drives camera yaw/pitch FPS-style.
   *   - T toggles the lock-on target (only meaningful while camera-locked).
   *   - L toggles torch equipped (requires torch in inventory).
   *   - LMB while camera-locked + NOT in build mode -> `onCombatLMB` (attack).
   *   - RMB while camera-locked + NOT in build mode -> `onCombatRMB.down/up` (block).
   *   - LMB while in build mode -> `onBuildConfirm` (existing path).
   *   - All callbacks optional; the dispatch short-circuits cleanly if absent.
   */
  isCameraLocked?: () => boolean;
  onCameraLockToggle?: () => void;
  onLockOnToggle?: () => void;
  /** L-key — toggles {@link GameState.torchEquipped} when the player has a torch. */
  onTorchToggle?: () => void;
  /**
   * M-key handler — flips `state.combatMode` between `'hit'` and `'magic'`. Wired
   * to `store.toggleCombatMode()` from mountApp; without an offensive spell
   * equipped the toggle is a soft no-op (mode flips but LMB dispatch is unchanged).
   */
  onCombatModeToggle?: () => void;
  /**
   * Number-key 1-6 handler — fires when the player presses a digit in awakened
   * mode. `slotIdx` is 0-5 (key 1 -> idx 0). Wired to `store.useHotbarSlot(idx)`
   * from mountApp. Soft no-op when the slot is empty / out of stock.
   */
  onHotbarUse?: (slotIdx: number) => void;
  onCombatLMB?: () => void;
  onCombatRMB?: { down: () => void; up: () => void };
  /**
   * Awakened-mode 2D collision world (Phase 1.5 — see `world/collisionWorld.ts`).
   * When provided, every avatar XZ write goes through `resolveCircleMove` so the
   * player can't walk through registered footprints (cabin pieces, trees, crystals,
   * etc.). When undefined, movement is unchecked (legacy behavior).
   */
  collisionWorld?: import('./collisionWorld').CollisionWorldHandle;
  /** Player's owner-id in the collision world — needed so `resolveCircleMove` excludes the player's own footprint. */
  playerCollisionOwnerId?: string;
  /** Player's collision-circle radius (~0.4 m for the avatar's body). */
  playerCollisionRadius?: number;
  /**
   * Bouncy-mushroom landing intercept (Phase 8l — see
   * `docs/TRIPPY_TERRAIN_AND_BOUNCE_MUSHROOMS_PLAN.md` §5 Phase 4). When the
   * landing branch detects the player just touched down on a footprint with
   * owner-id prefix `mushroom:`, this callback fires INSTEAD of the standard
   * `landed = true` path. The returned `bounceVy` replaces the player's
   * vertical velocity (upward kick), `isAirborne` stays true, and the double-
   * jump charge is restored so the player can chain jump-into-bounce arcs.
   *
   * `impactSpeed` is the magnitude of the player's downward `vy` at the moment
   * of contact (after the gravity sub-step). Used by the mushroom for squash
   * intensity scaling. `jumpHeld` is true if the player was holding Space at
   * the moment of landing (Mario-rules boosted-bounce intent). Returns null
   * when the mushroom is mid-respawn (sapling/broken) — caller falls through
   * to the standard landing path so the player still touches down cleanly.
   */
  mushroomBounce?: (
    ownerId: string,
    impactSpeed: number,
    jumpHeld: boolean,
  ) => { bounceVy: number } | null;
}

/** Walk speed in world units / second (dock baseline scale). */
const WALK_SPEED = 4.4;
/**
 * Sprint multiplier when Shift is held in awakened mode. 1.65 × walk = ~7.3 m/s, fast
 * enough to outrun a wolf (5.5 m/s, see `AWAKENED_MOB_STATS` in `gameStore.ts`) and
 * give the player a clear escape window — exactly what was asked for. Slower than the
 * fastest axe-throw or projectile so combat staging still works.
 *
 * No stamina drain in Phase 1.5 — when survival systems land (Phase 4) we'll convert
 * sustained sprint into a stamina cost so it's a meaningful resource trade-off.
 */
const SPRINT_MULTIPLIER = 1.65;
/**
 * Avatar rotation slerp rate — radians per second of "catching up" toward the movement
 * direction. ~14 rad/s feels snappy without snapping (full half-turn in ~0.2s).
 */
const FACE_SLERP_RATE = 14;
/**
 * Horizontal velocity smoothing — exponential approach toward target velocity. Larger =
 * snappier (closer to instant snap). 18 1/s ≈ ~0.06s to reach 90% of target speed,
 * which kills the "rubber-band slide" feel on key release while still feeling responsive
 * on key press. Reaches full speed in ~0.2s. Tuned for dock-scale 3rd-person camera.
 */
const VELOCITY_SMOOTH_RATE = 18;
/* ---- Jump physics constants — tuned for dock-scale (~1.8u tall avatar). ---- */
/** Vertical acceleration (units / sec²). Negative because Y-up. */
const GRAVITY = -22;
/** Initial Y velocity when the first jump fires. Hop height ≈ vy²/(2*|g|) ≈ 1.84u (avatar shoulder). */
const JUMP_VELOCITY = 9.0;
/**
 * Air double-jump initial Y velocity. Bigger than the first jump so the SECOND jump
 * visibly launches the player much higher — when timed at the apex of the first jump
 * (vy ≈ 0), the player gains another ~4.45u of altitude on top of the first hop's
 * remaining height, for a total apex of ~6u+ above ground.
 */
const DOUBLE_JUMP_VELOCITY = 14.0;
/** Coyote-time window after walking off an edge (sec) — first jump still allowed. */
const COYOTE_TIME = 0.12;
/** Jump-buffer window before landing (sec) — pressed Space "in advance" still fires. */
const JUMP_BUFFER = 0.12;
/** Front-flip duration (sec). Avatar rotates 2π on local X axis (body's lateral axis). */
const FLIP_DURATION = 0.55;
/**
 * Approximate avatar standing height (feet -> head). Used to derive `playerTopY` when
 * passing the player's vertical band into `resolveCircleMove` so the Y-aware collision
 * filter can decide whether an obstacle is "in the way of the body" or "above the head"
 * (overhang) or "below the feet" (jumped over). Matches the LPCA character build's
 * approximate eye-line — see `characterScenePreview.ts` for the rig source of truth.
 */
const AVATAR_HEIGHT = 1.8;
/**
 * Vertical-velocity threshold above which the jump-arc Y integration is sub-stepped.
 * At |vy| > 12 m/s and dt = 1/30s a single integration step would move the avatar
 * 0.4 m, enough to skip past a 0.2 m foundation top without registering a landing.
 * Sub-stepping splits the integration into ~3-cm increments at apex velocities.
 */
const JUMP_SUBSTEP_VY = 12;
/**
 * Walk-off tolerance — when grounded and `getGroundY` reports a ground level more than
 * this far below the current avatar Y, the player has stepped off a foundation / tree
 * top and transitions to airborne (with `vy = 0`, so they fall, and coyote-time still
 * applies for one mid-air jump).
 */
const WALK_OFF_THRESHOLD = 0.08;
/**
 * Auto step-up height (world units). Obstacles whose top is within this distance
 * above the player's feet are treated as walkable surfaces (skipped by the
 * horizontal collision push-out, then snapped to via `getGroundY`). 0.55 m
 * matches the cabin stair top exactly so a single press-W onto a stair piece
 * climbs it cleanly. Walls / doors / trees are taller and still block normally.
 *
 * Same constant lives as `DEFAULT_STEP_UP_HEIGHT` in `collisionWorld.ts` —
 * duplicated here as a local because the controls module owns the player's
 * physics tuning and this number is gameplay-facing.
 */
const STEP_UP_HEIGHT = 0.55;
/**
 * Vertical slop allowed when the airborne lander samples a candidate landing
 * surface. Small (10 cm) so the lander only snaps to surfaces effectively at
 * or below the player's feet — bigger values would teleport the player up
 * onto trees mid-fall before they actually fell to the canopy. The grounded
 * step-up path uses `STEP_UP_HEIGHT` instead (the bigger slop), so the two
 * concerns don't fight each other.
 */
const GROUND_LANDING_TOLERANCE = 0.1;

/** Shortest signed angle between two yaw values, in (-π, π]. */
function shortestYawDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function attachFreeRoamControls(opts: FreeRoamOptions): FreeRoamHandle {
  const keys = new Set<string>();
  let detached = false;

  /* Smoothed horizontal velocity (world units / sec). Approaches the target velocity
   * (WASD direction × WALK_SPEED) each frame via exponential smoothing. Avoids the
   * "instant snap to/from full speed" that made WASD feel rigid. */
  let velX = 0;
  let velZ = 0;

  /* Jump-physics state. All zeroed on detach / realm flip back to deck. */
  let vy = 0;
  let isAirborne = false;
  let lastGroundedAtSec = 0; /* coyote time anchor */
  let bufferedJumpAtSec = -1; /* sec value when Space was pressed */
  let usedDoubleJump = false;
  /**
   * Mushroom-bounce-granted "first jump" charge (Phase 8l). Set to true by the
   * bounce intercept in the airborne branch when the player lands on a mushroom;
   * consumed by `tryJump`'s bounce-jump branch. Lets the player chain THREE
   * launches per mushroom touch — bounce (auto) + first jump (Space) + double
   * jump (Space again) — instead of just bounce + double-jump (which is what a
   * naive `usedDoubleJump = false` reset would give them, since `isAirborne`
   * stays true so the standard first-jump check fails).
   *
   * Why a separate flag instead of `lastGroundedAtSec = elapsedSec`:
   *   - Coyote-time is 120 ms. The bounce arc takes ~520 ms to apex with
   *     `BOUNCE_VY = 11.5` and `GRAVITY = -22`. Coyote expires before the
   *     player can usefully press Space at the apex.
   *   - The bounce-jump path uses `Math.max(vy, JUMP_VELOCITY)` so pressing
   *     Space too early (during the bounce's rising phase) leaves vy unchanged
   *     instead of cancelling part of the bounce. The flag is consumed regardless.
   *   - Cleared on standard landing AND on the next bounce (so chain-bouncing
   *     doesn't accumulate stale charges).
   */
  let bounceJumpAvailable = false;
  let flipStartedAtSec = -1;
  let elapsedSec = 0; /* monotonic time accumulator (sec) — fed by `update(dt)`. */
  /**
   * Last grounded surface Y written by the controls update. Exposed via
   * `getGroundedSurfaceY()` so the dock's `syncAvatarFeetToTerrain` can stop
   * forcing the player back to bare terrain when they're standing on a floor /
   * foundation / stair / rock. `null` while airborne (foot-snap is gated off
   * during the jump arc anyway).
   */
  let lastGroundedSurfaceY: number | null = null;

  function isInputFocused(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = (el as HTMLElement).tagName?.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || (el as HTMLElement).isContentEditable;
  }

  /**
   * Try to start a jump. Honors coyote time (first jump still allowed shortly after
   * leaving ground) and double-jump rules (one air jump per air-time). The first jump
   * is a plain hop; the **double jump triggers the front flip** (animation rotates
   * `avatar.rotation.x` in body-local space because we set rotation.order to 'YXZ').
   * Returns true if a jump fired.
   */
  function tryJump(): boolean {
    const sinceGround = elapsedSec - lastGroundedAtSec;
    /* First jump: grounded OR within coyote window. No flip on this one. */
    if (!isAirborne || sinceGround <= COYOTE_TIME) {
      vy = JUMP_VELOCITY;
      isAirborne = true;
      usedDoubleJump = false;
      bounceJumpAvailable = false;
      flipStartedAtSec = -1;
      lastGroundedAtSec = -Infinity;
      playJumpSound();
      return true;
    }
    /* Mushroom-bounce-granted first jump (Phase 8l). The bounce already set
     * `vy = BOUNCE_VY = 11.5` (or boosted 16.0), which is FASTER than
     * `JUMP_VELOCITY = 9.0`. Use `Math.max` so pressing Space too early
     * (during the bounce's rising phase) doesn't cancel the bounce by
     * dropping vy from 11.5 → 9.0. Pressing at apex (vy ≈ 0) gives the
     * standard 9.0 boost; pressing while falling refunds it to JUMP_VELOCITY.
     * Either way, this slot is single-use per bounce — the next press goes
     * to the double-jump branch below. */
    if (bounceJumpAvailable) {
      vy = Math.max(vy, JUMP_VELOCITY);
      bounceJumpAvailable = false;
      flipStartedAtSec = -1;
      playJumpSound();
      return true;
    }
    /* Air double jump → front flip (the only one). */
    if (!usedDoubleJump) {
      vy = DOUBLE_JUMP_VELOCITY;
      usedDoubleJump = true;
      flipStartedAtSec = elapsedSec;
      playDoubleJumpSound();
      return true;
    }
    return false;
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!opts.isAwakened()) return;
    if (isInputFocused()) return;
    /* Q always toggles camera-lock (works in build mode + combat alike). */
    if (e.key === 'q' || e.key === 'Q') {
      e.preventDefault();
      opts.onCameraLockToggle?.();
      return;
    }
    /* T toggles lock-on target (only meaningful while camera-locked AND not in build
     * mode; the controller itself early-returns if conditions aren't met). */
    if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      opts.onLockOnToggle?.();
      return;
    }
    if (e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      opts.onTorchToggle?.();
      return;
    }
    /* M toggles combat mode between `'hit'` (melee only) and `'magic'` (cast +
     * melee swing simultaneously). Only meaningful when an offensive spell is
     * equipped — the toggle handler itself is a no-op in deck mode and the LMB
     * dispatch ignores combatMode unless an offensive spell is slotted. */
    if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      opts.onCombatModeToggle?.();
      return;
    }
    /* Number keys 1-6 — consume the item assigned to that hotbar slot. The
     * dispatch ignores empty / unstocked slots silently (the slot UI shows the
     * inventory count so the player has visual feedback either way). Skipped
     * during build mode so digits don't double-fire as build-input. */
    if (!opts.isBuildModeActive?.() && e.key >= '1' && e.key <= '6') {
      const slotIdx = Number(e.key) - 1;
      if (slotIdx >= 0 && slotIdx < 6) {
        e.preventDefault();
        opts.onHotbarUse?.(slotIdx);
        return;
      }
    }
    /* Build mode active — intercept E/Esc/R BEFORE the harvest/menu paths so the player
     * doesn't accidentally open the system menu while placing a piece, etc. WASD + Space
     * (movement + jump) still pass through unchanged so the player can position the
     * ghost while in build mode. See `buildModeController.ts`. */
    const buildActive = !!opts.isBuildModeActive?.();
    if (buildActive) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        opts.onBuildCancel?.();
        return;
      }
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        opts.onBuildConfirm?.();
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        opts.onBuildRotate?.(Math.PI / 2);
        return;
      }
      /* fall through for WASD / Space / Tab — movement + jump still allowed during build mode */
    }
    /* Tab opens the menu overlay (block browser focus traversal). */
    if (e.key === 'Tab') {
      e.preventDefault();
      opts.onToggleMenu();
      return;
    }
    /* E interacts with the nearest harvest node (build-mode E was already intercepted above). */
    if (e.key === 'e' || e.key === 'E') {
      opts.onInteract();
      return;
    }
    /* Space → jump (with buffer for early-press forgiveness). */
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      if (opts.workerOwnsAvatarMovement) return;
      if (e.repeat) return; /* hold-to-spam blocked; explicit re-press required */
      if (!tryJump()) {
        /* Both jumps used — buffer the press in case we land in the next ~120ms. */
        bufferedJumpAtSec = elapsedSec;
      }
      return;
    }
    /* WASD (and arrows for accessibility) feed into the per-frame integrator. Shift
     * is also tracked because the per-frame integrator reads `keys.has('shift')` for
     * the sprint multiplier. We don't preventDefault on Shift since other handlers
     * (modifier-aware shortcuts) might want to see it — Shift alone has no default
     * browser action so allowing the bubbling is harmless. */
    const k = e.key.toLowerCase();
    if (!opts.workerOwnsAvatarMovement) {
      if (k === 'w' || k === 's' || k === 'a' || k === 'd' ||
          e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
          e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        keys.add(k.length === 1 ? k : e.key);
        e.preventDefault();
      } else if (k === 'shift') {
        keys.add('shift');
      }
    }
  }

  /**
   * Mouse wheel during build mode rotates the ghost by 15° per notch. Wheel scroll has
   * a varying `deltaY` magnitude across browsers/devices; we just take the sign so each
   * notch is one rotation step regardless of scroll velocity.
   */
  function onWheel(e: WheelEvent): void {
    if (!opts.isAwakened()) return;
    if (!opts.isBuildModeActive?.()) return;
    if (isInputFocused()) return;
    e.preventDefault();
    const sign = Math.sign(e.deltaY);
    if (sign !== 0) opts.onBuildRotate?.(sign * (Math.PI / 12));
  }

  /**
   * LMB / RMB dispatch (Phase 1.5 — see `BASE_BUILDING_AND_SURVIVAL_PLAN.md` §13).
   * Routing matrix:
   *   - Build mode active + LMB         -> `onBuildConfirm` (place ghost piece).
   *   - Build mode active + RMB         -> ignored (don't fight build inputs).
   *   - Camera-locked + LMB (no build)  -> `onCombatLMB` (attack — wand/melee/bare).
   *   - Camera-locked + RMB (no build)  -> `onCombatRMB.down` / `onCombatRMB.up` (block).
   *   - Free-cursor mode (Q off)        -> NO INTERCEPT — the dock's existing canvas
   *     drag handlers see the events normally (left = orbit, right = pan).
   */
  function onMouseDown(e: MouseEvent): void {
    if (!opts.isAwakened()) return;
    if (isInputFocused()) return;
    const buildActive = !!opts.isBuildModeActive?.();
    const cameraLocked = !!opts.isCameraLocked?.();
    if (buildActive) {
      if (e.button === 0) {
        e.preventDefault();
        opts.onBuildConfirm?.();
      }
      return;
    }
    if (!cameraLocked) return; /* free-cursor mode: dock's drag handlers handle it */
    if (e.button === 0) {
      e.preventDefault();
      opts.onCombatLMB?.();
    } else if (e.button === 2) {
      e.preventDefault();
      opts.onCombatRMB?.down();
    }
  }
  function onMouseUp(e: MouseEvent): void {
    if (!opts.isAwakened()) return;
    if (e.button === 2 && opts.isCameraLocked?.()) {
      opts.onCombatRMB?.up();
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    const k = e.key.toLowerCase();
    /* Shift is added as the lowercase 'shift' tag (see onKeyDown) — match that on
     * release, otherwise the sprint flag would stick. */
    if (k === 'shift') {
      keys.delete('shift');
      return;
    }
    keys.delete(k.length === 1 ? k : e.key);
  }

  /**
   * Window blur (player Alt-Tabs / clicks outside the canvas) doesn't fire `keyup` for
   * keys held during the focus loss → keys would stay in the held set forever and the
   * avatar walks indefinitely. Clearing on blur fixes the "stuck walking" bug.
   */
  function onBlur(): void {
    keys.clear();
  }

  /**
   * Per-frame integrator. WASD direction is computed in CAMERA-RELATIVE world space.
   * Avatar facing slerps toward movement direction. Vertical = jump physics integrated
   * separately so the player can jump while moving in any direction.
   *
   * Critically: when NOT airborne we DO NOT touch avatar.y. The dock's
   * `syncAvatarFeetToTerrain` is the source of truth for grounded Y (uses an
   * AABB-based foot detection that knows the rig's actual foot-to-root offset).
   * When airborne we own Y entirely; the dock's snap is gated off via
   * `isAirborne()` → `setFreeRoamAirborne(true)` plumbing in `mountApp`.
   */
  function update(dtSec: number): void {
    if (!opts.isAwakened()) {
      keys.clear();
      vy = 0;
      velX = 0;
      velZ = 0;
      isAirborne = false;
      usedDoubleJump = false;
      bounceJumpAvailable = false;
      flipStartedAtSec = -1;
      lastGroundedSurfaceY = null;
      return;
    }
    if (opts.workerOwnsAvatarMovement) {
      elapsedSec += dtSec;
      return;
    }
    elapsedSec += dtSec;

    /* ---- Vertical movement runs FIRST (gravity + landing + walk-off) ----
     *
     * Critical ordering: the vertical phase must complete BEFORE the horizontal phase.
     * Why: if horizontal runs first, the moment the player's feet drop below an
     * obstacle's `topY` (mid-fall onto a tree canopy / wall top), the Y-aware push-out
     * starts shoving the player sideways OUT of the obstacle's XZ — they slip off
     * before the landing test gets a chance to snap them to the top. Running vertical
     * first lets the landing detection fire while the player is still XZ-overlapping
     * the canopy; once landed, `avatar.y === obstacle.topY` and the subsequent
     * horizontal pass's Y-band cull skips the obstacle entirely (the player is now
     * standing ON it). This is what makes "land on top of a birch / oak / apple"
     * actually work.
     */
    const radius = opts.playerCollisionRadius ?? 0.4;
    /**
     * Sample the highest landing surface within the player's foot circle. When
     * `predictXZ` is true, ALSO sample at the position the player will be at
     * after this frame's horizontal velocity is applied, taking the higher of
     * the two. Without this prediction, an airborne player flying forward toward
     * a tree never sees the tree from the current pre-horizontal XZ — the tree
     * only enters their footprint AFTER the horizontal phase moves them, which
     * is too late (they've already fallen past tree top). Standard CCD trick
     * borrowed from Source / Unity / Unreal char movement.
     */
    const sampleGroundY = (
      currY: number,
      snapUpHeight: number,
      predictXZ: boolean,
    ): number => {
      return sampleGroundYAndOwner(currY, snapUpHeight, predictXZ).y;
    };
    /**
     * Variant of `sampleGroundY` that ALSO returns the owner-id of the surface
     * that produced the winning Y. Used by the airborne landing branch so the
     * mushroom-bounce intercept can route on owner-id prefix without a second
     * collision-world query.
     */
    const sampleGroundYAndOwner = (
      currY: number,
      snapUpHeight: number,
      predictXZ: boolean,
    ): { y: number; ownerId: string | null } => {
      const ax = opts.avatar.position.x;
      const az = opts.avatar.position.z;
      const terrainY = opts.getTerrainHeight(ax, az);
      if (!opts.collisionWorld) return { y: terrainY, ownerId: null };
      let best = opts.collisionWorld.getGroundYAndOwner(
        ax, az, currY, terrainY, radius, snapUpHeight,
      );
      if (predictXZ && (Math.abs(velX) > 0.01 || Math.abs(velZ) > 0.01)) {
        const px = ax + velX * dtSec;
        const pz = az + velZ * dtSec;
        const ptY = opts.getTerrainHeight(px, pz);
        const pred = opts.collisionWorld.getGroundYAndOwner(
          px, pz, currY, ptY, radius, snapUpHeight,
        );
        if (pred.y > best.y) best = pred;
      }
      return best;
    };

    if (isAirborne) {
      /* Sub-step the integration so big jump-arc Y deltas don't tunnel past a thin
       * landing surface (foundation top, low rock, etc.). One step when |vy| is small;
       * up to ~5 steps at apex. */
      const speed = Math.max(Math.abs(vy), 1);
      const subSteps = Math.min(5, Math.max(1, Math.ceil(speed / JUMP_SUBSTEP_VY)));
      const sub = dtSec / subSteps;
      let landed = false;
      let impactSpeed = 0;
      let landingOwnerId: string | null = null;
      for (let s = 0; s < subSteps; s++) {
        vy += GRAVITY * sub;
        opts.avatar.position.y += vy * sub;
        if (vy > 0) continue; /* still rising; can't land */
        /* Predict-XZ ON: catch tree tops the player is JUST about to fly over. */
        const ground = sampleGroundYAndOwner(
          opts.avatar.position.y, GROUND_LANDING_TOLERANCE, true,
        );
        if (opts.avatar.position.y <= ground.y) {
          impactSpeed = Math.abs(vy);
          opts.avatar.position.y = ground.y;
          landed = true;
          landingOwnerId = ground.ownerId;
          break;
        }
      }
      /* === Bouncy-mushroom landing intercept ===
       * If the surface we just touched belongs to a mushroom AND the host
       * supplied a `mushroomBounce` callback that returns a non-null result,
       * launch the player back UP instead of going to the standard landing
       * branch. The mushroom side handles cap squash + chain-bonus + boosted-
       * bounce gating; this branch just routes the upward kick.
       *
       * **Continuous-bounce contract.** `mushroomBounce` is called on EVERY
       * landing whose owner-id matches the `mushroom:` prefix; the bouncy-
       * mushroom handle never gates on a per-mushroom cooldown or "already
       * bounced" flag — every touchdown that sees a mature mushroom triggers
       * a fresh squash + launch. This is what makes successive bounces on
       * the same mushroom (or chain-bouncing across many mushrooms) work
       * without any per-mushroom state tracking up here.
       *
       * **Jump-system independence.** A mushroom bounce DOES NOT count as
       * one of the player's jumps. The player gets THREE pushes per touch:
       *   1. The bounce itself (auto, sets `vy = BOUNCE_VY` or boosted).
       *   2. A first-jump granted by `bounceJumpAvailable = true` — consumed
       *      by `tryJump`'s bounce-jump branch with `Math.max(vy, JUMP_VELOCITY)`
       *      so pressing Space during the rising bounce arc doesn't cancel
       *      the bounce velocity, but pressing at apex / while falling gives
       *      the standard JUMP_VELOCITY boost.
       *   3. A double-jump granted by `usedDoubleJump = false` — consumed
       *      by `tryJump`'s double-jump branch (sets vy = DOUBLE_JUMP_VELOCITY,
       *      plays the front flip).
       * Net: bounce + first-jump + double-jump = 3 vertical pushes per
       * mushroom touch, matching the player's "the auto bounce shouldn't
       * steal my jumps" intuition. */
      if (
        landed &&
        landingOwnerId !== null &&
        opts.mushroomBounce !== undefined &&
        landingOwnerId.startsWith('mushroom:')
      ) {
        const jumpHeld = keys.has(' ') || keys.has('Space');
        const result = opts.mushroomBounce(landingOwnerId, impactSpeed, jumpHeld);
        if (result !== null) {
          /* Bounce fires: replace vy with the upward kick, stay airborne. */
          vy = result.bounceVy;
          isAirborne = true;
          /* Refund BOTH the first-jump (via the bounce-jump charge) AND the
           * double-jump — bounce is INDEPENDENT of the jump system. */
          usedDoubleJump = false;
          bounceJumpAvailable = true;
          flipStartedAtSec = -1;
          /* Audio cue scaled by impact (heavier landing = louder splat). */
          const intensity = Math.max(0.4, Math.min(1.2, 0.5 + impactSpeed / 18));
          playMushroomBounceSound(intensity);
          /* Skip the standard landing branch. The post-vertical horizontal-
           * movement block below still runs normally so the player carries
           * their XZ velocity through the bounce arc. */
          landed = false;
        }
        /* If `result === null` (mushroom mid-respawn / sapling), fall through
         * to the standard landing path so the player still touches down on
         * the registered footprint position. */
      }
      if (landed) {
        const landIntensity = Math.max(0.4, Math.min(1.0, 0.4 + impactSpeed / 22));
        vy = 0;
        isAirborne = false;
        usedDoubleJump = false;
        bounceJumpAvailable = false; /* clear stale bounce charge on solid landing */
        flipStartedAtSec = -1;
        opts.avatar.rotation.x = 0; /* clear flip pose on landing */
        lastGroundedAtSec = elapsedSec;
        playLandSound(landIntensity);
        /* Jump-buffer: if Space was pressed in the last JUMP_BUFFER sec, fire on landing. */
        if (bufferedJumpAtSec >= 0 && elapsedSec - bufferedJumpAtSec <= JUMP_BUFFER) {
          tryJump();
        }
        bufferedJumpAtSec = -1;
      }
    }

    /* ---- Horizontal movement (WASD → smoothed camera-relative XZ velocity) ---- */
    let fwd = 0;
    let strafe = 0;
    if (keys.has('w') || keys.has('ArrowUp')) fwd += 1;
    if (keys.has('s') || keys.has('ArrowDown')) fwd -= 1;
    if (keys.has('a') || keys.has('ArrowLeft')) strafe -= 1;
    if (keys.has('d') || keys.has('ArrowRight')) strafe += 1;

    /* Compute target velocity from WASD input. When no keys are held, target = (0,0)
     * and the smoother will exponentially decay velocity to a stop (no instant cutoff). */
    let targetVx = 0;
    let targetVz = 0;
    if (fwd !== 0 || strafe !== 0) {
      const len = Math.hypot(fwd, strafe);
      fwd /= len;
      strafe /= len;
      /* Camera-forward (XZ unit vector) → world movement direction. Camera-right is
       * 90° CCW from forward when viewed top-down: `(-cfZ, +cfX)`. */
      const cf = opts.getCameraForwardXZ();
      const dirX = fwd * cf.x - strafe * cf.z;
      const dirZ = fwd * cf.z + strafe * cf.x;
      const dirLen = Math.hypot(dirX, dirZ);
      if (dirLen > 1e-5) {
        /* Sprint: Shift held while ANY WASD direction is pressed applies a flat
         * speed multiplier. Direction-agnostic — sprint left, right, back,
         * forward, diagonal, all the same. The earlier "forward only" gate was
         * removed because the user wanted Shift+S to be a real escape mechanic
         * (back-pedal away from a mob fast), and Shift+A/D to be a strafe-sprint
         * around an enemy. The `keys.has('shift')` is the only condition. */
        const sprintActive = keys.has('shift');
        const speedMul = sprintActive ? SPRINT_MULTIPLIER : 1;
        targetVx = (dirX / dirLen) * WALK_SPEED * speedMul;
        targetVz = (dirZ / dirLen) * WALK_SPEED * speedMul;
      }
    }

    /* Exponential smoothing → snappy on press, soft on release. The `1 - exp(-rate*dt)`
     * form is frame-rate independent (unlike `lerp(v, target, rate*dt)` which behaves
     * differently at 30 vs 144 FPS). */
    const k = 1 - Math.exp(-VELOCITY_SMOOTH_RATE * dtSec);
    velX += (targetVx - velX) * k;
    velZ += (targetVz - velZ) * k;

    const speed = Math.hypot(velX, velZ);
    /* === Combat-ready facing (camera-locked) ===
     *
     * In 3rd-person shooters, when the player is in aim/lock mode the
     * avatar's body always faces the camera-forward direction, regardless
     * of whether they're moving. That keeps the staff (held in the right
     * hand) on the SCREEN-RIGHT side of the avatar, so cast bolts visibly
     * leave the staff toward the reticle instead of exiting at a weird
     * angle when the avatar is facing away from the aim point.
     *
     * Without this, the user sees "magic goes where character is looking,
     * not where camera is pointing" — because the staff tip is on the
     * avatar's right hand, and if the avatar is facing (say) west while
     * the reticle aims south, the bolt LEAVES the staff heading roughly
     * north (the world-space direction of the avatar's right) before
     * straight-lining to the actual aim point. The bolt LANDS at the
     * right place but the visual exit direction is wrong, which reads as
     * "shot fired in the wrong direction."
     *
     * Fix: when the camera is locked, snap-slerp avatar yaw to camera
     * yaw every frame. Free-cursor mode (Q off) keeps the legacy
     * "facing follows movement direction" behaviour for non-combat
     * exploration. */
    if (opts.isCameraLocked?.()) {
      const cf = opts.getCameraForwardXZ();
      if (Math.abs(cf.x) + Math.abs(cf.z) > 1e-5) {
        const targetYaw = Math.atan2(cf.x, cf.z);
        const delta = shortestYawDelta(opts.avatar.rotation.y, targetYaw);
        /* Faster slerp than the movement-facing path (12 vs FACE_SLERP_RATE)
         * so combat aim feels responsive — when the player swings the camera
         * to track a target, the avatar+staff snap to follow within a few
         * frames instead of lazily drifting after. */
        const maxStep = 12 * dtSec;
        const step = Math.max(-maxStep, Math.min(maxStep, delta));
        opts.avatar.rotation.y += step;
      }
    }
    if (speed > 0.01) {
      /* Move avatar by smoothed velocity. */
      const fromX = opts.avatar.position.x;
      const fromZ = opts.avatar.position.z;
      let nx = fromX + velX * dtSec;
      let nz = fromZ + velZ * dtSec;
      /* Clamp inside the dock map radius so we don't fall off the disc. */
      const r = Math.hypot(nx, nz);
      const maxR = opts.mapRadius - 0.5;
      if (r > maxR) {
        const k2 = maxR / r;
        nx *= k2;
        nz *= k2;
      }
      /* Collision world push-out (Phase 1.5 — see `world/collisionWorld.ts`). When
       * wired, the player can't walk through registered footprints (cabin pieces,
       * trees, crystals, ore nodes, mobs). When unwired, movement is unchecked
       * (legacy behavior). The player's vertical band (feet -> head) is passed
       * through so jumping clean over a short obstacle skips its push-out. */
      if (opts.collisionWorld && opts.playerCollisionOwnerId) {
        const playerBottomY = opts.avatar.position.y;
        const playerTopY = playerBottomY + AVATAR_HEIGHT;
        /* Step-up only applies while grounded — airborne players don't auto-climb
         * surfaces during a fall (that's what the predicted-XZ landing handles). */
        const stepUp = isAirborne ? 0 : STEP_UP_HEIGHT;
        const resolved = opts.collisionWorld.resolveCircleMove(
          opts.playerCollisionOwnerId,
          fromX, fromZ,
          nx, nz,
          opts.playerCollisionRadius ?? 0.4,
          playerBottomY,
          playerTopY,
          stepUp,
        );
        nx = resolved.x;
        nz = resolved.z;
      }
      opts.avatar.position.x = nx;
      opts.avatar.position.z = nz;

      /* Smoothly turn body toward the SMOOTHED velocity direction (not instant input
       * direction) so the avatar stops turning when velocity decays. atan2(x, z) is
       * Three.js's yaw convention so a unit (+Z) forward vector gives yaw 0.
       *
       * SKIPPED when camera-locked — the combat-ready facing block above
       * already aligned the avatar to camera-forward, and a second pass
       * here would fight that alignment and produce wobble while strafing. */
      if (!opts.isCameraLocked?.()) {
        const ux = velX / speed;
        const uz = velZ / speed;
        const targetYaw = Math.atan2(ux, uz);
        const delta = shortestYawDelta(opts.avatar.rotation.y, targetYaw);
        const maxStep = FACE_SLERP_RATE * dtSec;
        const step = Math.max(-maxStep, Math.min(maxStep, delta));
        opts.avatar.rotation.y += step;
      }
    } else {
      /* Snap residual velocity to zero so the walk-cycle detector in characterScenePreview
       * sees motion stop cleanly (avoids slow-creeping pose). */
      velX = 0;
      velZ = 0;
    }

    /* ---- Walk-off + step-up snap (runs AFTER horizontal so we use the new XZ) ----
     *
     * Two cases driven by the same `getGroundY` sample (with STEP_UP slop so floors,
     * foundations, stairs, and low rocks count as ground):
     *   - groundY < currentY by more than WALK_OFF_THRESHOLD -> we walked off an
     *     edge (foundation / tree top / cliff). Transition to airborne with vy = 0
     *     so we fall naturally; coyote-time gives one mid-air jump.
     *   - groundY > currentY (we just walked onto a floor / foundation / stair):
     *     auto step-up. Snap avatar.y up to groundY in one frame so the player
     *     visibly stands on the new surface. Without this snap the dock's foot-
     *     snap would yank them back down to the bare terrain underneath.
     *
     * `_freeRoamGroundY` is exported below via `getGroundedSurfaceY()` so the
     * dock's `syncAvatarFeetToTerrain` can use the SAME sample (it runs after this
     * controls update) and stop forcing the player back to terrain Y when they're
     * standing on something taller.
     */
    if (!isAirborne) {
      const groundY = sampleGroundY(opts.avatar.position.y, STEP_UP_HEIGHT, false);
      if (opts.avatar.position.y > groundY + WALK_OFF_THRESHOLD) {
        isAirborne = true;
        vy = 0;
        /* `lastGroundedAtSec` keeps its last grounded value — coyote window starts
         * ticking from the moment we walked off. */
      } else {
        /* Step-up: surface is at or above our feet → snap up onto it. */
        opts.avatar.position.y = groundY;
        lastGroundedSurfaceY = groundY;
        lastGroundedAtSec = elapsedSec;
      }
    } else {
      /* Airborne: clear the cached ground Y so the dock's foot-snap falls back to
       * pure terrain sampling. (Airborne foot-snap is gated off via
       * `setFreeRoamAirborne(true)` anyway, but defensive null keeps the contract
       * clean for any future caller.) */
      lastGroundedSurfaceY = null;
    }

    /* ---- Front-flip rotation (double jump only, body-local via rotation.order = 'YXZ') ----
     * With Three.js's right-handed coord system + 'YXZ' Euler order, rotation around the
     * body's local +X axis by a POSITIVE angle rotates the head (local +Y) toward the
     * body's local +Z (forward) — i.e. head tilts forward, body rolls head-over-heels
     * forward. Positive 2π over FLIP_DURATION = one full forward flip. */
    if (flipStartedAtSec >= 0 && isAirborne) {
      const t = (elapsedSec - flipStartedAtSec) / FLIP_DURATION;
      if (t < 1) {
        opts.avatar.rotation.x = t * Math.PI * 2;
      } else {
        opts.avatar.rotation.x = 0;
        flipStartedAtSec = -1;
      }
    }
  }

  function clearKeys(): void {
    keys.clear();
  }

  function detach(): void {
    if (detached) return;
    detached = true;
    keys.clear();
    vy = 0;
    velX = 0;
    velZ = 0;
    isAirborne = false;
    usedDoubleJump = false;
    bounceJumpAvailable = false;
    flipStartedAtSec = -1;
    bufferedJumpAtSec = -1;
    lastGroundedSurfaceY = null;
    opts.avatar.rotation.x = 0;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('wheel', onWheel, { capture: true } as AddEventListenerOptions);
    window.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('mouseup', onMouseUp, true);
    window.removeEventListener('contextmenu', onContextMenu, true);
  }

  /* Suppress the native context menu in awakened mode — RMB is gameplay input now
   * (block attack while camera-locked, panning when not). Only suppress when we'd
   * actually consume the RMB to avoid breaking right-click on UI overlays. */
  function onContextMenu(e: MouseEvent): void {
    if (!opts.isAwakened()) return;
    if (isInputFocused()) return;
    /* Suppress only when we'd otherwise route the RMB to a gameplay action. */
    if (opts.isBuildModeActive?.() || opts.isCameraLocked?.()) {
      e.preventDefault();
    }
  }

  /* Capture-phase keydown — beats deck-mode UI handlers when in awakened mode. */
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  /* Window blur clears keys to fix the "stuck walking" bug. */
  window.addEventListener('blur', onBlur);
  /* Capture-phase wheel — only consumes events while build mode is active (the handler
   * gates internally); deck-mode camera zoom and dock-canvas wheel handlers see it
   * normally otherwise. `passive: false` because we call `preventDefault()` to stop
   * the page from scrolling while the player is rotating a ghost piece. */
  window.addEventListener('wheel', onWheel, { capture: true, passive: false });
  /* Capture-phase mousedown/up for combat + build-confirm — handlers gate internally
   * so free-cursor mode lets the dock's drag handlers see the events normally. */
  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('mouseup', onMouseUp, true);
  window.addEventListener('contextmenu', onContextMenu, true);

  return {
    update,
    detach,
    isActive: opts.isAwakened,
    clearKeys,
    isAirborne: () => opts.getAirborneOverride?.() ?? isAirborne,
    getGroundedSurfaceY: () => {
      if (opts.workerOwnsAvatarMovement) {
        if (opts.getAirborneOverride?.()) return null;
        return opts.getTerrainHeight(opts.avatar.position.x, opts.avatar.position.z);
      }
      return lastGroundedSurfaceY;
    },
  };
}
