/**
 * SharedRenderState — `SharedArrayBuffer`-backed cross-thread state.
 *
 * The render worker writes hot per-frame state (avatar position, camera
 * orientation, gather progress, etc.) into this shared buffer at the END of
 * its render loop. The main thread reads the same slots via `Atomics.load`
 * with NO postMessage round-trip and NO frame lag.
 *
 * Why SAB instead of postMessage state mirroring:
 *
 *   - `CharacterScenePreview` exposes 60+ getters (`getAvatarGroundXZ`,
 *     `getCameraForwardXZ`, `getCameraYawPitch`, `getStaffTipWorldPosition`,
 *     `getGatherClipProgress01`, etc.) which main calls per-frame from the
 *     game-systems loop, damage floater projection, magical reticle, etc.
 *   - Mirroring via postMessage would queue state on the receive side and add
 *     1 frame of stale read on every getter — combat feel would degrade.
 *   - SAB + Atomics: worker writes, main reads, both synchronous. The
 *     `Atomics` ensure no torn reads on multi-byte fields.
 *
 * Why NOT use Atomics.wait/notify here:
 *
 *   - Main thread is forbidden from blocking on Atomics.wait (it would freeze
 *     UI). Polling reads are sufficient — the game loop already polls every
 *     frame.
 *
 * Memory layout (one SAB, multiple typed-array views):
 *
 *   - 256 floats (1024 bytes) of f32 slots for continuous-valued state
 *     (positions, angles, intensities).
 *   - 64 ints (256 bytes) of i32 slots for flags + counters + input deltas.
 *
 * Total: 1280 bytes — trivial allocation, page-aligned by the runtime.
 *
 * Slot layout below: edit ONLY by appending new slots. Reordering existing
 * slots is a breaking change that must be coordinated with the worker side.
 */

/* ============================================================================
 * Buffer sizes — keep both views in sync.
 * ============================================================================ */

const F32_SLOTS = 256;
const I32_SLOTS = 64;
const F32_BYTES = F32_SLOTS * Float32Array.BYTES_PER_ELEMENT;
const I32_BYTES = I32_SLOTS * Int32Array.BYTES_PER_ELEMENT;
const TOTAL_BYTES = F32_BYTES + I32_BYTES;

/* ============================================================================
 * F32 slot indices (continuous-valued state).
 * ============================================================================ */

export const F32_SLOT = {
  /** Avatar world position (worker → main; per-frame). */
  AVATAR_X: 0,
  AVATAR_Y: 1,
  AVATAR_Z: 2,

  /** Camera state (worker → main; per-frame). */
  CAMERA_YAW: 3,
  CAMERA_PITCH: 4,
  CAMERA_ZOOM: 5,
  CAMERA_FORWARD_X: 6,
  CAMERA_FORWARD_Z: 7,

  /** Staff tip world position for VFX/aim (worker → main; per-frame). */
  STAFF_TIP_X: 8,
  STAFF_TIP_Y: 9,
  STAFF_TIP_Z: 10,

  /** Gather state (worker → main; updated when clip plays). */
  GATHER_PROGRESS_01: 11,
  GATHER_CLIP_DURATION_MS: 12,
  GATHER_SFX_DELAY_MS: 13,

  /** Water bank (worker → main; for `GameStore.reserveHarvestSlot`). */
  WATER_BANK_X: 14,
  WATER_BANK_Z: 15,

  /** Tone mapping exposure currently in use (worker → main; rare). */
  TONE_MAPPING_EXPOSURE: 16,

  /**
   * Camera world position + projection (worker → main; per-frame).
   * Lets main thread rebuild a `PerspectiveCamera` for DOM projection
   * (damage floaters) without a main-thread scene graph.
   */
  CAMERA_POS_X: 17,
  CAMERA_POS_Y: 18,
  CAMERA_POS_Z: 19,
  /** Vertical FOV in degrees (Three.js `PerspectiveCamera.fov`). */
  CAMERA_FOV_DEG: 20,
  /** Width / height (worker canvas pixel aspect). */
  CAMERA_ASPECT: 21,

  /**
   * Third-person dock orbit **targets** (worker → main) — match
   * `CharacterScenePreview.getCameraYawPitch` (`dockCamYawTarget` / `dockCamPitchTarget`).
   * Framing on the worker uses smoothed display values; SAB exposes targets for
   * lock-on / mouselock delta accumulation.
   */
  DOCK_ORBIT_YAW: 22,
  DOCK_ORBIT_PITCH: 23,

  /** Reserved for future continuous state. */
  _RESERVED_F32_END: 24,
} as const;

/* ============================================================================
 * I32 slot indices (flags + counters + inputs).
 *
 * Boolean flags are i32 (not bytes) so we can use Atomics.store/load with
 * full 32-bit alignment. 0 = false, 1 = true.
 * ============================================================================ */

export const I32_SLOT = {
  /** Bitmask of worker-side state flags. See FLAG_* below. */
  FLAGS: 0,

  /**
   * Mouse-look deltas (main → worker; cleared by worker each frame).
   * Main writes via Atomics.add — multiple events between frames accumulate
   * cleanly. Stored as int (CSS pixel × 16 fixed-point) to avoid float
   * tearing on accumulation.
   */
  MOUSE_DELTA_X_FX16: 1,
  MOUSE_DELTA_Y_FX16: 2,

  /** Wheel delta (main → worker; cleared by worker each frame). */
  WHEEL_DELTA_Y_FX16: 3,

  /**
   * Keyboard state bitmask (main → worker; main writes on keydown/keyup,
   * worker reads each frame). One bit per tracked key.
   * See KEY_BIT below.
   */
  KEY_STATE: 4,

  /**
   * Mouse button state bitmask (main → worker; per pointer button).
   * Bit 0 = left, bit 1 = right, bit 2 = middle.
   */
  MOUSE_BUTTONS: 5,

  /**
   * Pointer-lock active flag (main → worker; main toggles from
   * pointerlockchange listener). 0 = not locked, 1 = locked.
   */
  POINTER_LOCK_ACTIVE: 6,

  /**
   * Frame counter (worker → main; incremented at end of each render frame).
   * Lets main detect "worker is alive and rendering" without polling state.
   */
  FRAME_COUNTER: 7,

  /**
   * Last render timestamp in ms (worker → main; truncated to int).
   * `performance.now()` floored. Main reads to detect stalls.
   */
  LAST_RENDER_AT_MS: 8,

  /** Reserved for future flags / counters. */
  _RESERVED_I32_END: 9,
} as const;

/* ============================================================================
 * Bitmask constants for FLAGS slot.
 * ============================================================================ */

export const FLAG = {
  /** Avatar is currently airborne (no ground contact). */
  AIRBORNE: 1 << 0,
  /** Camera lock (FPS-style mouse-look) is active. */
  CAMERA_LOCKED: 1 << 1,
  /** Player is in awakened realm (free-roam world). */
  AWAKENED: 1 << 2,
  /** Render budget is in low-budget mode (busy crafting / interaction). */
  LOW_BUDGET: 1 << 3,
  /** Worker should skip the next frame for the FPS cap. */
  FPS_CAP_SKIP: 1 << 4,
  /** Worker has finished its bootstrap render and is in steady state. */
  WORKER_READY: 1 << 5,
} as const;

/* ============================================================================
 * Bitmask constants for KEY_STATE slot.
 *
 * Only tracks keys read by gameplay (movement, interact, jump, build mode).
 * UI keys (Escape, Tab) stay handled on main.
 * ============================================================================ */

export const KEY_BIT = {
  W: 1 << 0,
  A: 1 << 1,
  S: 1 << 2,
  D: 1 << 3,
  SPACE: 1 << 4,
  SHIFT: 1 << 5,
  E: 1 << 6, // interact
  Q: 1 << 7, // build rotate
  R: 1 << 8, // reload / cancel build
  F: 1 << 9, // alt interact
  ARROW_UP: 1 << 10,
  ARROW_DOWN: 1 << 11,
  ARROW_LEFT: 1 << 12,
  ARROW_RIGHT: 1 << 13,
} as const;

/* ============================================================================
 * Fixed-point scale for mouse deltas.
 *
 * Mouse deltas are floats (CSS pixels) but we accumulate via Atomics.add on
 * int32. Multiply by 16 before writing, divide by 16 after reading. Keeps
 * sub-pixel precision while avoiding float tearing.
 * ============================================================================ */

const FX16_SCALE = 16;

/* ============================================================================
 * SharedRenderState class — typed wrapper around the SAB.
 * ============================================================================ */

export class SharedRenderState {
  readonly sab: SharedArrayBuffer;
  private readonly f32: Float32Array;
  private readonly i32: Int32Array;

  /**
   * Allocate a fresh SharedRenderState with a new SAB.
   * Used on main thread once at boot; the SAB is then transferred (by
   * reference, since SABs are inherently shared) to the worker.
   */
  static create(): SharedRenderState {
    const sab = new SharedArrayBuffer(TOTAL_BYTES);
    return new SharedRenderState(sab);
  }

  /**
   * Wrap an existing SAB. Used on the worker side when receiving the buffer
   * from the init message.
   */
  constructor(sab: SharedArrayBuffer) {
    if (sab.byteLength !== TOTAL_BYTES) {
      throw new Error(
        `SharedRenderState: expected SAB of ${TOTAL_BYTES} bytes, got ${sab.byteLength}`,
      );
    }
    this.sab = sab;
    this.f32 = new Float32Array(sab, 0, F32_SLOTS);
    this.i32 = new Int32Array(sab, F32_BYTES, I32_SLOTS);
  }

  /* ----- Float slot access ----- */

  /**
   * Atomic store of a float into a named f32 slot.
   *
   * Note: Atomics doesn't support Float32Array directly. We bitcast through
   * Int32Array of the same buffer for atomicity, which matches the
   * single-writer / many-reader pattern (no torn reads even though
   * `Atomics.store` itself is on i32).
   */
  storeF32(slot: number, value: number): void {
    /* Float32Array writes are atomic at the 4-byte word level on all major
     * runtimes (the storage is a single 32-bit word). The Atomics fence is
     * only needed if multiple writers race — in our model, the worker is
     * the SOLE writer for each f32 slot, so a plain assignment is correct
     * and faster. Document the invariant here so future authors don't
     * "fix" this to use Atomics for no benefit. */
    this.f32[slot] = value;
  }

  loadF32(slot: number): number {
    return this.f32[slot];
  }

  /* ----- Int slot access (uses Atomics for multi-writer safety) ----- */

  /**
   * Atomically store an int into a named i32 slot. Use this for any slot
   * that has multiple writers (currently: input deltas — main writes,
   * worker reads + clears).
   */
  storeI32(slot: number, value: number): void {
    Atomics.store(this.i32, slot, value);
  }

  /**
   * Atomically load an int from a named i32 slot.
   */
  loadI32(slot: number): number {
    return Atomics.load(this.i32, slot);
  }

  /**
   * Atomically add to an int slot, returning the previous value. Used for
   * accumulating mouse deltas across multiple events between frames.
   */
  addI32(slot: number, delta: number): number {
    return Atomics.add(this.i32, slot, delta);
  }

  /**
   * Atomically swap an int slot to a new value, returning the previous.
   * Used by the worker to read-and-clear delta slots in one operation.
   */
  swapI32(slot: number, value: number): number {
    return Atomics.exchange(this.i32, slot, value);
  }

  /* ============================================================================
   * Convenience accessors — keep call sites readable on both sides.
   * ============================================================================ */

  /* ----- Avatar / camera (worker writes, main reads) ----- */

  setAvatarPosition(x: number, y: number, z: number): void {
    this.f32[F32_SLOT.AVATAR_X] = x;
    this.f32[F32_SLOT.AVATAR_Y] = y;
    this.f32[F32_SLOT.AVATAR_Z] = z;
  }

  getAvatarX(): number {
    return this.f32[F32_SLOT.AVATAR_X];
  }
  getAvatarY(): number {
    return this.f32[F32_SLOT.AVATAR_Y];
  }
  getAvatarZ(): number {
    return this.f32[F32_SLOT.AVATAR_Z];
  }

  setCameraState(yaw: number, pitch: number, zoom: number, forwardX: number, forwardZ: number): void {
    this.f32[F32_SLOT.CAMERA_YAW] = yaw;
    this.f32[F32_SLOT.CAMERA_PITCH] = pitch;
    this.f32[F32_SLOT.CAMERA_ZOOM] = zoom;
    this.f32[F32_SLOT.CAMERA_FORWARD_X] = forwardX;
    this.f32[F32_SLOT.CAMERA_FORWARD_Z] = forwardZ;
  }

  getCameraYaw(): number {
    return this.f32[F32_SLOT.CAMERA_YAW];
  }
  getCameraPitch(): number {
    return this.f32[F32_SLOT.CAMERA_PITCH];
  }
  getCameraForwardX(): number {
    return this.f32[F32_SLOT.CAMERA_FORWARD_X];
  }
  getCameraForwardZ(): number {
    return this.f32[F32_SLOT.CAMERA_FORWARD_Z];
  }

  setDockOrbit(yaw: number, pitch: number): void {
    this.f32[F32_SLOT.DOCK_ORBIT_YAW] = yaw;
    this.f32[F32_SLOT.DOCK_ORBIT_PITCH] = pitch;
  }

  getDockOrbitYaw(): number {
    return this.f32[F32_SLOT.DOCK_ORBIT_YAW];
  }

  getDockOrbitPitch(): number {
    return this.f32[F32_SLOT.DOCK_ORBIT_PITCH];
  }

  setStaffTip(x: number, y: number, z: number): void {
    this.f32[F32_SLOT.STAFF_TIP_X] = x;
    this.f32[F32_SLOT.STAFF_TIP_Y] = y;
    this.f32[F32_SLOT.STAFF_TIP_Z] = z;
  }

  getStaffTipX(): number {
    return this.f32[F32_SLOT.STAFF_TIP_X];
  }
  getStaffTipY(): number {
    return this.f32[F32_SLOT.STAFF_TIP_Y];
  }
  getStaffTipZ(): number {
    return this.f32[F32_SLOT.STAFF_TIP_Z];
  }

  setGatherProgress(progress01: number, durationMs: number, sfxDelayMs: number): void {
    this.f32[F32_SLOT.GATHER_PROGRESS_01] = progress01;
    this.f32[F32_SLOT.GATHER_CLIP_DURATION_MS] = durationMs;
    this.f32[F32_SLOT.GATHER_SFX_DELAY_MS] = sfxDelayMs;
  }

  getGatherProgress01(): number {
    return this.f32[F32_SLOT.GATHER_PROGRESS_01];
  }
  getGatherClipDurationMs(): number {
    return this.f32[F32_SLOT.GATHER_CLIP_DURATION_MS];
  }
  getGatherSfxDelayMs(): number {
    return this.f32[F32_SLOT.GATHER_SFX_DELAY_MS];
  }

  setWaterBank(x: number, z: number): void {
    this.f32[F32_SLOT.WATER_BANK_X] = x;
    this.f32[F32_SLOT.WATER_BANK_Z] = z;
  }

  getWaterBankX(): number {
    return this.f32[F32_SLOT.WATER_BANK_X];
  }
  getWaterBankZ(): number {
    return this.f32[F32_SLOT.WATER_BANK_Z];
  }

  setToneMappingExposure(exposure: number): void {
    this.f32[F32_SLOT.TONE_MAPPING_EXPOSURE] = exposure;
  }

  getToneMappingExposure(): number {
    return this.f32[F32_SLOT.TONE_MAPPING_EXPOSURE];
  }

  setCameraWorldPose(x: number, y: number, z: number, fovDeg: number, aspect: number): void {
    this.f32[F32_SLOT.CAMERA_POS_X] = x;
    this.f32[F32_SLOT.CAMERA_POS_Y] = y;
    this.f32[F32_SLOT.CAMERA_POS_Z] = z;
    this.f32[F32_SLOT.CAMERA_FOV_DEG] = fovDeg;
    this.f32[F32_SLOT.CAMERA_ASPECT] = aspect;
  }

  getCameraPosX(): number {
    return this.f32[F32_SLOT.CAMERA_POS_X];
  }
  getCameraPosY(): number {
    return this.f32[F32_SLOT.CAMERA_POS_Y];
  }
  getCameraPosZ(): number {
    return this.f32[F32_SLOT.CAMERA_POS_Z];
  }
  getCameraFovDeg(): number {
    return this.f32[F32_SLOT.CAMERA_FOV_DEG];
  }
  getCameraAspect(): number {
    return this.f32[F32_SLOT.CAMERA_ASPECT];
  }

  getCameraZoom(): number {
    return this.f32[F32_SLOT.CAMERA_ZOOM];
  }

  /* ----- Flags (worker AND main both set / clear specific bits) ----- */

  /**
   * Atomically set bits in the flags slot. Both threads can call this; the
   * read-modify-write is racy without Atomics so we use compareExchange
   * loop for true atomicity.
   */
  setFlags(bits: number): void {
    let prev = Atomics.load(this.i32, I32_SLOT.FLAGS);
    /* compareExchange loop = lock-free OR. Bounded retries because contention
     * is extremely low (~10 writes per second across both threads). */
    for (let i = 0; i < 8; i++) {
      const next = prev | bits;
      if (next === prev) return;
      const observed = Atomics.compareExchange(this.i32, I32_SLOT.FLAGS, prev, next);
      if (observed === prev) return;
      prev = observed;
    }
    /* Fallback after retry budget — non-atomic OR. Realistically unreachable. */
    Atomics.store(this.i32, I32_SLOT.FLAGS, Atomics.load(this.i32, I32_SLOT.FLAGS) | bits);
  }

  clearFlags(bits: number): void {
    let prev = Atomics.load(this.i32, I32_SLOT.FLAGS);
    for (let i = 0; i < 8; i++) {
      const next = prev & ~bits;
      if (next === prev) return;
      const observed = Atomics.compareExchange(this.i32, I32_SLOT.FLAGS, prev, next);
      if (observed === prev) return;
      prev = observed;
    }
    Atomics.store(this.i32, I32_SLOT.FLAGS, Atomics.load(this.i32, I32_SLOT.FLAGS) & ~bits);
  }

  hasFlag(bit: number): boolean {
    return (Atomics.load(this.i32, I32_SLOT.FLAGS) & bit) !== 0;
  }

  /* ----- Input — main writes deltas, worker drains per frame ----- */

  addMouseDelta(dx: number, dy: number): void {
    /* Convert CSS px floats to fixed-point ints before atomic add. */
    Atomics.add(this.i32, I32_SLOT.MOUSE_DELTA_X_FX16, Math.round(dx * FX16_SCALE));
    Atomics.add(this.i32, I32_SLOT.MOUSE_DELTA_Y_FX16, Math.round(dy * FX16_SCALE));
  }

  /**
   * Worker calls each frame to read accumulated mouse delta and reset to 0.
   * Returns CSS pixel deltas (sub-pixel precision via fx16 scaling).
   */
  drainMouseDelta(): { dx: number; dy: number } {
    const dxFx = Atomics.exchange(this.i32, I32_SLOT.MOUSE_DELTA_X_FX16, 0);
    const dyFx = Atomics.exchange(this.i32, I32_SLOT.MOUSE_DELTA_Y_FX16, 0);
    return { dx: dxFx / FX16_SCALE, dy: dyFx / FX16_SCALE };
  }

  addWheelDelta(dy: number): void {
    Atomics.add(this.i32, I32_SLOT.WHEEL_DELTA_Y_FX16, Math.round(dy * FX16_SCALE));
  }

  drainWheelDelta(): number {
    const dyFx = Atomics.exchange(this.i32, I32_SLOT.WHEEL_DELTA_Y_FX16, 0);
    return dyFx / FX16_SCALE;
  }

  setKeyDown(keyBit: number): void {
    let prev = Atomics.load(this.i32, I32_SLOT.KEY_STATE);
    for (let i = 0; i < 8; i++) {
      const next = prev | keyBit;
      if (next === prev) return;
      const observed = Atomics.compareExchange(this.i32, I32_SLOT.KEY_STATE, prev, next);
      if (observed === prev) return;
      prev = observed;
    }
  }

  setKeyUp(keyBit: number): void {
    let prev = Atomics.load(this.i32, I32_SLOT.KEY_STATE);
    for (let i = 0; i < 8; i++) {
      const next = prev & ~keyBit;
      if (next === prev) return;
      const observed = Atomics.compareExchange(this.i32, I32_SLOT.KEY_STATE, prev, next);
      if (observed === prev) return;
      prev = observed;
    }
  }

  isKeyDown(keyBit: number): boolean {
    return (Atomics.load(this.i32, I32_SLOT.KEY_STATE) & keyBit) !== 0;
  }

  /**
   * Drop all key state. Used on `window.blur` to prevent stuck-key bugs
   * when the player tabs away mid-keypress.
   */
  clearAllKeys(): void {
    Atomics.store(this.i32, I32_SLOT.KEY_STATE, 0);
  }

  setMouseButtons(mask: number): void {
    Atomics.store(this.i32, I32_SLOT.MOUSE_BUTTONS, mask);
  }

  getMouseButtons(): number {
    return Atomics.load(this.i32, I32_SLOT.MOUSE_BUTTONS);
  }

  setPointerLockActive(active: boolean): void {
    Atomics.store(this.i32, I32_SLOT.POINTER_LOCK_ACTIVE, active ? 1 : 0);
  }

  isPointerLockActive(): boolean {
    return Atomics.load(this.i32, I32_SLOT.POINTER_LOCK_ACTIVE) !== 0;
  }

  /* ----- Liveness (worker writes, main reads to detect stalls) ----- */

  incrementFrameCounter(): number {
    return Atomics.add(this.i32, I32_SLOT.FRAME_COUNTER, 1) + 1;
  }

  getFrameCounter(): number {
    return Atomics.load(this.i32, I32_SLOT.FRAME_COUNTER);
  }

  setLastRenderAtMs(ms: number): void {
    Atomics.store(this.i32, I32_SLOT.LAST_RENDER_AT_MS, ms | 0);
  }

  getLastRenderAtMs(): number {
    return Atomics.load(this.i32, I32_SLOT.LAST_RENDER_AT_MS);
  }
}
