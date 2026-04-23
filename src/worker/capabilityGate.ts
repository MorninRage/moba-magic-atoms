/**
 * Capability gate for the OffscreenCanvas + SharedArrayBuffer worker path.
 *
 * Runs early in `src/main.ts` to detect whether the current browser can host
 * the render worker. The four required capabilities are:
 *
 *   1. `OffscreenCanvas` global constructor exists.
 *   2. `HTMLCanvasElement.prototype.transferControlToOffscreen` exists.
 *   3. `SharedArrayBuffer` global constructor exists.
 *   4. `crossOriginIsolated === true` — the document is isolated by COOP/COEP
 *      headers, which is the runtime gate browsers use to actually allow
 *      `SharedArrayBuffer` allocation.
 *
 * **Phase 0 behavior** (current): the gate ONLY logs the result and exposes
 * a `isWorkerRenderCapable()` query. It does NOT block boot. The worker is
 * still a stub at this point — main thread continues to render via
 * `CharacterScenePreview` as before.
 *
 * **Phase 3 behavior** (after the full scene migrates): main flow checks
 * `isWorkerRenderCapable()` and shows an "update your browser" page if false
 * (per the migration plan: no main-thread fallback ships).
 *
 * URL override (see {@link isWorkerDockPreviewEnabled}):
 *   - **Default:** main-thread `CharacterScenePreview` (no OffscreenCanvas transfer).
 *   - `?worker=1` opts into `CharacterSceneHost` + render worker when the browser
 *     is capable (OffscreenCanvas + COOP/COEP + SAB).
 *   - `?worker=0` explicitly blocks the worker path even if `worker=1` is absent
 *     (keeps triage / bookmark safety).
 *
 * **Browser support summary** (as of 2026-04):
 *   - Chrome / Edge 96+ : full support with COEP credentialless.
 *   - Firefox 110+      : full support.
 *   - Safari 17.4+      : full support (16.4 added OffscreenCanvas, 17.4 added
 *                         COEP credentialless).
 *   - Safari < 16.4     : no OffscreenCanvas → gate fails.
 *   - Safari 16.4-17.3  : OffscreenCanvas yes, COEP credentialless missing.
 *                         Gate may still pass if document is isolated via
 *                         require-corp (we use credentialless, so these
 *                         versions effectively fail the `crossOriginIsolated`
 *                         check today).
 */

interface WorkerCapabilityResult {
  /** True if OffscreenCanvas + SAB + isolation requirements are met (same as `capable`). */
  ok: boolean;
  /** True if every required capability is present. */
  capable: boolean;
  /** `?worker=0` in the URL (explicit block of worker dock). */
  forcedOff: boolean;
  /** Per-capability detail for debugging. */
  details: {
    offscreenCanvas: boolean;
    transferControlToOffscreen: boolean;
    sharedArrayBuffer: boolean;
    crossOriginIsolated: boolean;
  };
}

let cachedResult: WorkerCapabilityResult | null = null;

/**
 * Probe browser capabilities. Idempotent — first call performs the checks
 * and logs a summary line; subsequent calls return the cached result.
 */
export function probeWorkerCapabilities(): WorkerCapabilityResult {
  if (cachedResult) return cachedResult;

  const details = {
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    transferControlToOffscreen:
      typeof HTMLCanvasElement !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function',
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    /* `crossOriginIsolated` is the runtime gate browsers use; if false then
     * `new SharedArrayBuffer(n)` throws even when the constructor exists. */
    crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true,
  };

  /* Try to actually allocate a 1-byte SAB. The constructor may exist but
   * still throw if isolation is incomplete. Wrap in try/catch — we don't
   * want a false-positive "capable" classification here. */
  let sabAllocates = false;
  if (details.sharedArrayBuffer && details.crossOriginIsolated) {
    try {
      const _probe = new SharedArrayBuffer(1);
      sabAllocates = _probe.byteLength === 1;
    } catch {
      sabAllocates = false;
    }
  }

  const capable =
    details.offscreenCanvas &&
    details.transferControlToOffscreen &&
    details.sharedArrayBuffer &&
    details.crossOriginIsolated &&
    sabAllocates;

  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const forcedOff = params.get('worker') === '0';

  const ok = capable;

  cachedResult = { ok, capable, forcedOff, details };

  /* Single summary log. Detailed breakdown only at info level if a
   * capability is missing — keeps the console quiet on the happy path. */
  if (!capable) {
    /* Format which checks failed so triage doesn't need DevTools breakpoint. */
    const failed = Object.entries(details)
      .filter(([_, v]) => !v)
      .map(([k]) => k)
      .join(', ');
    console.warn(
      `[worker-gate] worker path unavailable — failing checks: ${failed || '(SAB allocation)'}`,
    );
  } else if (forcedOff) {
    console.info('[worker-gate] ?worker=0 — Offscreen render worker disabled');
  } else {
    console.info(
      '[worker-gate] OffscreenCanvas + SAB OK — main-thread dock is default; use ?worker=1 for render worker',
    );
  }

  /* Expose on the global so DevTools / debug overlays can read without
   * re-importing this module. Namespaced under `idleCraft.worker` to match
   * other dev affordances (`idleCraft.perfDockFrame`, etc.). */
  const idleCraftAny = (globalThis as Record<string, unknown>).idleCraft as
    | Record<string, unknown>
    | undefined;
  const idleCraft: Record<string, unknown> = idleCraftAny ?? {};
  idleCraft.worker = cachedResult;
  (globalThis as Record<string, unknown>).idleCraft = idleCraft;

  return cachedResult;
}

/**
 * True when the browser can run the OffscreenCanvas render worker (hardware + headers).
 * Does **not** mean the app uses the worker — see {@link isWorkerDockPreviewEnabled}.
 */
export function isWorkerRenderCapable(): boolean {
  return probeWorkerCapabilities().capable;
}

/**
 * Worker dock (`CharacterSceneHost` + render worker) for unified preload + solo game dock.
 *
 * **Default is OFF** — the dock uses main-thread `CharacterScenePreview` (no transfer).
 * Opt in with `?worker=1` on a {@link isWorkerRenderCapable} browser.
 * `?worker=0` forces OFF (safety for bookmarks that disable the worker).
 */
export function isWorkerDockPreviewEnabled(): boolean {
  if (!isWorkerRenderCapable()) return false;
  const params = new URLSearchParams(
    typeof globalThis.location !== 'undefined' ? globalThis.location.search ?? '' : '',
  );
  if (params.get('worker') === '0') return false;
  return params.get('worker') === '1';
}

/**
 * Retain {@link CharacterSceneHost} as the visible in-game dock after preload consume
 * (shadow `CharacterScenePreview` keeps gameplay handles). **Default on** whenever
 * {@link isWorkerDockPreviewEnabled} is true so enter-game is reparent-only (instant).
 *
 * Escape hatch: `?dockGame=0` consumes like the old shadow path (dispose worker host,
 * visible dock is main-thread preview only).
 */
export function isWorkerDockGameEnabled(): boolean {
  if (!isWorkerDockPreviewEnabled()) return false;
  const params = new URLSearchParams(
    typeof globalThis.location !== 'undefined' ? globalThis.location.search ?? '' : '',
  );
  return params.get('dockGame') !== '0';
}

/**
 * Smoke-test the SAB + Atomics primitives we depend on. Runs a synchronous
 * round-trip on a 1-int SAB:
 *
 *   1. Allocate `new SharedArrayBuffer(4)`.
 *   2. Wrap with `Int32Array`.
 *   3. `Atomics.store` → `Atomics.load` → `Atomics.add` → `Atomics.exchange`.
 *
 * Detects browser quirks where the constructor exists + isolation is on but
 * the Atomics methods themselves are buggy or missing (rare, but worth
 * catching at boot rather than during gameplay). Logs a one-line PASS/FAIL.
 *
 * Cheap (sub-millisecond) — safe to run unconditionally on the boot path.
 */
export function verifyAtomicsRoundTrip(): boolean {
  const cap = probeWorkerCapabilities();
  if (!cap.capable) return false;
  try {
    const sab = new SharedArrayBuffer(4);
    const i32 = new Int32Array(sab);
    Atomics.store(i32, 0, 42);
    if (Atomics.load(i32, 0) !== 42) return false;
    if (Atomics.add(i32, 0, 1) !== 42) return false; /* returns OLD value */
    if (Atomics.load(i32, 0) !== 43) return false;
    if (Atomics.exchange(i32, 0, 0) !== 43) return false;
    if (Atomics.load(i32, 0) !== 0) return false;
    if (Atomics.compareExchange(i32, 0, 0, 7) !== 0) return false;
    if (Atomics.load(i32, 0) !== 7) return false;
    console.info('[worker-gate] Atomics round-trip PASS');
    return true;
  } catch (err) {
    console.warn('[worker-gate] Atomics round-trip FAIL:', err);
    return false;
  }
}
