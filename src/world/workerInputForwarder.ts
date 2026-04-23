/**
 * Worker input forwarder — main-side keyboard / mouse listener layer that
 * writes player input into `SharedRenderState` so the worker-side
 * `CharacterSceneController` can read it without knowing about `window`
 * or DOM events.
 *
 * Splits the input concern into two halves:
 *
 *   - **Main side (this module)**: attaches `window` keydown/keyup,
 *     mousemove (pointer-lock deltas), wheel, mousedown/up listeners.
 *     Writes the resulting state to SharedRenderState via `Atomics.store`/
 *     `Atomics.add` calls — atomic, sub-microsecond, lock-free.
 *
 *   - **Worker side (Phase 5.x in `freeRoamControls`)**: reads keyboard
 *     bitmask via `sharedState.isKeyDown(KEY_BIT.W)` etc., drains accumulated
 *     mouse deltas via `sharedState.drainMouseDelta()` once per frame, applies
 *     movement / camera-look / interaction logic.
 *
 * Why SharedState instead of postMessage:
 *
 *   - Keyboard input is hot-polled per frame (`update()` reads `keys.has('w')`
 *     etc.). postMessage round-trip would queue input on the receive side
 *     and read 1 frame stale — visible as input lag.
 *   - SAB lets main write on event, worker read on next frame, with no
 *     IPC and no measurable latency above the listener cost itself.
 *
 * **Activation:** {@link CharacterSceneHost.create} with
 * `attachWindowKeyboardMouseForwarders: true` (worker title preload in
 * `dockPreload.ts` when `?worker=1` + capable). {@link CharacterSceneHost.dispose}
 * detaches. Legacy `freeRoamControls` keeps its own listeners; paths do not
 * combine.
 *
 * **Worker consumption:** `CharacterSceneController` must read
 * `sharedState.isKeyDown` / `drainMouseDelta` in its update loop (Step 7) for
 * movement to respond; forwarding alone only fills the SAB.
 */

import type { CharacterSceneHost } from '../visual/characterSceneHost';
import { keyCodeToBit } from '../visual/characterSceneHost';

export interface WorkerInputForwarderHandle {
  /** Detach all listeners. Idempotent. */
  detach(): void;
}

export interface WorkerInputForwarderOptions {
  /**
   * Element that owns the canvas — pointer-lock requests target this. If
   * omitted, falls back to `host.canvas`.
   */
  pointerLockTarget?: HTMLElement;
  /**
   * Capture-phase listeners (default: true). Matches the legacy
   * `freeRoamControls` pattern which uses capture so input fires before any
   * UI handler can stopPropagation.
   */
  useCapture?: boolean;
}

/**
 * Attach window-level keyboard/mouse/wheel listeners that mirror state into
 * the host's `SharedRenderState`. Returns a handle with `detach()` that
 * removes every listener — call this on host dispose / mode change.
 */
export function attachWorkerInputForwarders(
  host: CharacterSceneHost,
  opts: WorkerInputForwarderOptions = {},
): WorkerInputForwarderHandle {
  const useCapture = opts.useCapture ?? true;
  const pointerLockTarget = opts.pointerLockTarget ?? host.canvas;
  let detached = false;

  /* === Keyboard — keydown/keyup write bit flips into SharedState.
   * `event.code` is layout-independent (KeyW == physical W key regardless
   * of QWERTY/AZERTY), matching how `freeRoamControls` reads input today. */
  const onKeyDown = (e: KeyboardEvent): void => {
    if (detached) return;
    /* Don't swallow input that the player is typing into a text field
     * (system menu name input, future text-entry UIs). The DOM target
     * tells us whether to participate. */
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }
    const bit = keyCodeToBit(e.code);
    if (bit !== 0) {
      host.setKeyDownByCode(e.code);
    }
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    if (detached) return;
    const bit = keyCodeToBit(e.code);
    if (bit !== 0) {
      host.setKeyUpByCode(e.code);
    }
  };

  /* === Window blur — drop all keys to prevent stuck-key bugs when the
   * player tabs away mid-keypress. Same pattern legacy freeRoamControls uses. */
  const onBlur = (): void => {
    if (detached) return;
    host.clearAllKeys();
  };

  /* === Pointer lock — main owns the lock state (DOM API) and toggles
   * the SharedState flag so worker-side aim/camera reads see it without
   * a postMessage. */
  const onPointerLockChange = (): void => {
    if (detached) return;
    const isLocked = document.pointerLockElement === pointerLockTarget;
    host.setPointerLockActive(isLocked);
    /* Body class toggle stays main-side — used by CSS rules to hide the
     * default cursor + pin certain UI elements. */
    document.body.classList.toggle('camera-locked', isLocked);
  };

  /* === Mouse-look deltas — only meaningful when pointer is locked;
   * accumulated atomically into SharedState fx16 slots so multiple events
   * between worker frames combine cleanly. */
  const onMouseMove = (e: MouseEvent): void => {
    if (detached) return;
    if (document.pointerLockElement !== pointerLockTarget) return;
    /* `movementX/Y` are CSS pixel deltas, sign matches DOM convention. */
    host.addMouseLookDelta(e.movementX, e.movementY);
  };

  /* === Listeners attach on `window` so they catch input even when the
   * canvas isn't the focused element (matches legacy freeRoamControls). */
  const opt = { capture: useCapture };
  window.addEventListener('keydown', onKeyDown, opt);
  window.addEventListener('keyup', onKeyUp, opt);
  window.addEventListener('blur', onBlur);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  window.addEventListener('mousemove', onMouseMove, opt);

  return {
    detach(): void {
      if (detached) return;
      detached = true;
      window.removeEventListener('keydown', onKeyDown, opt);
      window.removeEventListener('keyup', onKeyUp, opt);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      window.removeEventListener('mousemove', onMouseMove, opt);
      /* Clear lingering state so a re-attach starts clean. */
      host.clearAllKeys();
      host.setPointerLockActive(false);
      document.body.classList.remove('camera-locked');
    },
  };
}
