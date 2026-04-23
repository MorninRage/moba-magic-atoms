/**
 * Awakened-mode camera-lock controller (Phase 1.5 — see
 * `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` §12).
 *
 * Q-toggle that swaps the input contract from "free cursor" to "pointer-locked FPS-style
 * mouse-look" while keeping the dock's existing third-person follow camera.
 *
 * **What happens on Q:**
 *   1. Snapshot the dock's CURRENT `dockCamYaw` + `dockCamPitch` so the camera doesn't
 *      jump on activation.
 *   2. Call `canvas.requestPointerLock()` — browser hides the cursor, switches to
 *      "infinite mouse" mode (movementX/Y deltas with no edge clamping).
 *   3. Tell the scene preview `setCameraLockActive(true)` — disables the left-click-drag
 *      orbit handler + the double-click camera-reset handler, so they don't fight us.
 *   4. Each frame, integrate accumulated `movementX/Y` deltas into camera yaw/pitch.
 *
 * **What happens on Q again (or browser releases pointer-lock):**
 *   1. `setCameraLockActive(false)` — orbit + double-click reset re-enable.
 *   2. The dock camera keeps the yaw/pitch the player ended on (no snap-back).
 *
 * **Mouse delta accumulation:** `mousemove` events accumulate `movementX/Y` between
 * frames; `update()` consumes them as a batch (matches frame-rate-independent input
 * integration, doesn't drop deltas if the browser delivers multiple events per frame).
 *
 * **Browser-released pointer lock:** the browser drops pointer lock on Esc, alt-tab,
 * or full-screen exit. We listen for `pointerlockchange` and auto-deactivate so we
 * don't end up stuck "locked" with a free cursor.
 *
 * **Keyboard:** the Q-key handling itself lives in `freeRoamControls.ts` (it owns the
 * keydown listener for the awakened mode); it calls `toggle()` here when Q is pressed.
 */

import type { CharacterScenePreview } from '../visual/characterScenePreview';
import type { CharacterSceneHost } from '../visual/characterSceneHost';

/** Mouse-look sensitivity. Tuned for desktop gaming mouse at default DPI. */
const YAW_SENSITIVITY = 0.0028;
const PITCH_SENSITIVITY = 0.0023;
/** Pitch clamp — same range as the dock's existing orbit clamp so framing stays sane. */
const PITCH_MIN = -1.12;
const PITCH_MAX = 1.55;

export interface CameraLockHandle {
  /** True while pointer-lock is engaged + camera yaw/pitch is mouse-driven. */
  isActive(): boolean;
  /**
   * Toggle camera-lock. Returns the new active state. If activating fails (pointer-lock
   * blocked by the browser — e.g. not in a user-gesture context) returns false silently.
   */
  toggle(): boolean;
  /** Per-frame: integrate accumulated mouse delta into camera yaw/pitch. */
  update(): void;
  /** Force-deactivate (called on realm flip back to deck). */
  deactivate(): void;
  /** Detach all listeners. */
  dispose(): void;
}

/** When the visible dock is worker-rendered, mouse-look mutates the worker camera via the bridge. */
export interface DockCameraLockAuthority {
  getCameraYawPitch(): { yaw: number; pitch: number };
  setCameraYawPitch(yaw: number, pitch: number): void;
  setCameraLockActive(active: boolean): void;
}

interface CameraLockOpts {
  canvas: HTMLCanvasElement;
  /** Preview or worker host — both implement camera lock + yaw/pitch for third-person aim. */
  scenePreview: CharacterScenePreview | CharacterSceneHost;
  /** If set, yaw/pitch integration + lock flag also apply here (worker dock game path). */
  cameraAuthority?: DockCameraLockAuthority;
  /** Returns true while the player is in awakened mode — gates the toggle. */
  isAwakened: () => boolean;
}

export function createCameraLockController(opts: CameraLockOpts): CameraLockHandle {
  let active = false;
  /** True after `activate()` requests lock until browser confirms, `deactivate()`, or denial. */
  let lockIntent = false;
  let pendingDX = 0;
  let pendingDY = 0;

  function onPointerLockChange(): void {
    /* Browser is the source of truth — if document.pointerLockElement isn't us, we're
     * not locked, period. Auto-update internal state so an Esc-release returns control.
     * The body class drop must happen here too — Esc-release fires async after the
     * keydown that triggered it, so the body-class side-channel for the system menu
     * is only correct if BOTH `deactivate()` AND this auto-release path drop it. */
    const stillLocked = document.pointerLockElement === opts.canvas;
    if (stillLocked) {
      /* Lock confirmed (possibly async after `requestPointerLock`). Only promote when
       * we still intend to hold lock — avoids a race where `deactivate()` ran before the
       * promise resolved but the browser still delivered a late lock grant. */
      if (lockIntent && !active && opts.isAwakened()) {
        active = true;
        pendingDX = 0;
        pendingDY = 0;
        opts.scenePreview.setCameraLockActive(true);
        opts.cameraAuthority?.setCameraLockActive(true);
        setBodyLockClass(true);
      }
      return;
    }
    if (!stillLocked && active) {
      active = false;
      lockIntent = false;
      pendingDX = 0;
      pendingDY = 0;
      opts.scenePreview.setCameraLockActive(false);
      opts.cameraAuthority?.setCameraLockActive(false);
      document.body.classList.remove('camera-locked');
    }
  }

  function onMouseMove(e: MouseEvent): void {
    if (!active) return;
    /* movementX/Y is the pointer-lock delta API — works regardless of cursor position
     * because the cursor is "infinite" while locked. */
    pendingDX += e.movementX;
    pendingDY += e.movementY;
  }

  /**
   * Body-class hook for the system menu's Esc handler. The browser auto-releases
   * pointer lock on Esc (security) and our `pointerlockchange` listener flips
   * `active` to false — but the system menu's keydown handler runs SYNCHRONOUSLY
   * with the Esc keydown, BEFORE the async pointerlockchange dispatch. Without
   * this hook the menu would still pop open on the same Esc that released the
   * mouse, defeating the "first Esc = release mouse, second Esc = open menu"
   * behavior the player asked for.
   *
   * We toggle a `body.camera-locked` class in lock-step with `active`. The system
   * menu checks for this class on Esc and skips opening the menu when present.
   */
  function setBodyLockClass(on: boolean): void {
    document.body.classList.toggle('camera-locked', on);
  }

  function activate(): boolean {
    if (active) return true;
    if (!opts.isAwakened()) return false;
    /* `requestPointerLock` may return a Promise; rejections (e.g. NotAllowedError
     * without a user gesture) are not caught by try/catch. Real activation + scene
     * hooks run from `pointerlockchange` when the lock is actually granted. */
    lockIntent = true;
    try {
      const ret = opts.canvas.requestPointerLock() as void | Promise<void>;
      if (ret != null && typeof (ret as Promise<void>).catch === 'function') {
        void (ret as Promise<void>).catch(() => {
          lockIntent = false;
        });
      }
    } catch {
      lockIntent = false;
      return false;
    }
    return true;
  }

  function deactivate(): void {
    lockIntent = false;
    if (!active) {
      try {
        if (document.pointerLockElement === opts.canvas) {
          document.exitPointerLock();
        }
      } catch {
        /* Best-effort. */
      }
      return;
    }
    active = false;
    pendingDX = 0;
    pendingDY = 0;
    opts.scenePreview.setCameraLockActive(false);
    opts.cameraAuthority?.setCameraLockActive(false);
    setBodyLockClass(false);
    /* Release the pointer lock if we still hold it — browser may have already done so
     * (Esc), in which case this is a no-op. */
    try {
      if (document.pointerLockElement === opts.canvas) {
        document.exitPointerLock();
      }
    } catch {
      /* Best-effort. */
    }
  }

  function toggle(): boolean {
    if (active) {
      deactivate();
      return false;
    }
    return activate();
  }

  function update(): void {
    if (!active) return;
    if (pendingDX === 0 && pendingDY === 0) return;
    /* Push accumulated mouse-look deltas into the dock camera.
     *
     * YAW SIGN: the dock's framing math is `ax = sin(yaw) * cos(pitch) * dist` for the
     * camera's X offset from the look-at target. POSITIVE yaw -> camera POSITION moves
     * to +X relative to target -> camera ends up on the player's right looking back at
     * the player from the right side -> the camera's VIEW DIRECTION sweeps toward -X
     * (looking LEFT in world coordinates). Standard FPS convention is "mouse right ->
     * camera looks right", so we need yaw to DECREASE when mouse-X is positive.
     * Formula: `newYaw = yaw - dx * sens`.
     *
     * PITCH SIGN: `ay = sin(pitch) * dist`. POSITIVE pitch -> camera ABOVE target ->
     * looking DOWN. Standard non-inverted: mouse UP -> camera looks UP -> pitch must
     * decrease when mouse-Y delta is negative. Formula: `newPitch = pitch + dy * sens`.
     *
     * (Both axes were originally written with the OPPOSITE sign — backwards relative
     * to every shooter the user has played. Flipped to match standard convention.) */
    const auth = opts.cameraAuthority;
    const { yaw, pitch } = auth ? auth.getCameraYawPitch() : opts.scenePreview.getCameraYawPitch();
    const newYaw = yaw - pendingDX * YAW_SENSITIVITY;
    const newPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch + pendingDY * PITCH_SENSITIVITY));
    if (auth) auth.setCameraYawPitch(newYaw, newPitch);
    else opts.scenePreview.setCameraYawPitch(newYaw, newPitch);
    pendingDX = 0;
    pendingDY = 0;
  }

  function dispose(): void {
    deactivate();
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    window.removeEventListener('mousemove', onMouseMove, true);
  }

  document.addEventListener('pointerlockchange', onPointerLockChange);
  window.addEventListener('mousemove', onMouseMove, true);

  return {
    isActive: () => active,
    toggle,
    update,
    deactivate,
    dispose,
  };
}
