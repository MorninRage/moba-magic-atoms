# Worker path vs legacy path — product defaults, URL flags, and status (2026-04-22+)

**Purpose:** One place for how the app chooses between **main-thread** `CharacterScenePreview` (legacy) and **OffscreenCanvas** `CharacterSceneHost` + `renderWorker`, what URL flags do, what changed in 2026-04, runtime cost, and the **known gap** between the two paths.

**Canonical code:** `src/worker/capabilityGate.ts` — `isWorkerRenderCapable()`, `isWorkerDockPreviewEnabled()`, `isWorkerDockGameEnabled()`.  
**Checklist / migration order:** [WORKER_MIGRATION_PHASE_3X.md](WORKER_MIGRATION_PHASE_3X.md).  
**Architecture map:** [WORKER_ARCHITECTURE.md](WORKER_ARCHITECTURE.md).  
**Vision vs implementation (camera, sky, preload):** [GAME_VISION_VS_IMPLEMENTATION_2026_04.md](GAME_VISION_VS_IMPLEMENTATION_2026_04.md).

---

## 1. URL query parameters

| URL | Effect |
|-----|--------|
| **(none)** | **Default:** dock preload uses **legacy** `CharacterScenePreview` only — no render worker, no `OffscreenCanvas` transfer, no second thread for the 3D dock. |
| **`?worker=1`** | **Opt in** to the worker dock **if** the browser passes the gate: `OffscreenCanvas`, `transferControlToOffscreen`, `SharedArrayBuffer` allocation, and `crossOriginIsolated === true` (COOP/COEP — see `netlify.toml` / `vite.config.ts`). If the gate fails, the app still falls back to legacy. |
| **`?worker=0`** | **Force off** the worker preview path: `isWorkerDockPreviewEnabled()` is false; legacy dock only. Use for triage, bookmarks, or A/B with `?worker=1`. |
| **`?dockGame=0`** | When worker preview *would* be on, this can force consume behavior to dispose the host and use main-thread preview for the in-game dock (see `isWorkerDockGameEnabled()` in `capabilityGate.ts`). Rare; for debugging. |

**Note:** `isWorkerRenderCapable()` means “**browser can** run the worker” (hardware + headers). It does **not** mean the product uses the worker — that requires `?worker=1` and a successful `CharacterSceneHost` boot.

---

## 2. What actually runs (runtime)

| Mode | `new Worker(...)` for dock? | Offscreen 3D? | Typical cost |
|------|-----------------------------|--------------|-------------|
| **Default (no `worker=1`)** | **No** | **No** | One main-thread WebGL context for the dock; **no** extra worker thread, **no** duplicate worker rAF. |
| **`?worker=1` + capable** | **Yes** | **Yes** | Worker owns visible dock render loop; main may still build gameplay layers on `CharacterSceneHost.scene` for raycast/collision (see `dockPreload` / `mountApp` — potential duplicate heavy geometry until 3.x-C). |

**Bundle / download:** the `renderWorker` chunk may still be present in the build and **downloaded** (or PWA-precached) even on legacy default; it is **not executed** until something constructs the worker. Main bundle may still **parse** modules that import `CharacterSceneHost` (e.g. from `dockPreload`) — that is a small one-time cost, not per-frame game logic.

---

## 3. Product change: default flipped to legacy (2026-04-22)

**Before:** On capable browsers, `isWorkerDockPreviewEnabled()` was effectively **on by default** (only `?worker=0` disabled the worker).

**After:** Worker dock is **opt-in** — `isWorkerDockPreviewEnabled()` is true only when:

1. `isWorkerRenderCapable()` is true, and  
2. the URL has **`?worker=1`**, and  
3. the URL is not forcing off with **`?worker=0`**.

**Rationale:** The worker path is still missing **dream/deck** parity (walk-to gather, `playGatherAction` choreography, `syncGatherRpgVisuals`, many battle/clip messages are **stubs** in `CharacterSceneController.handleMessage`, `syncSharedRenderState` gather fields stubbed, etc.). Shipping legacy by default gives players the full `CharacterScenePreview` experience; teams can test the worker with `?worker=1`.

**Code touched (representative):**

- `src/worker/capabilityGate.ts` — `isWorkerDockPreviewEnabled` requires `?worker=1`; `isWorkerRenderCapable()` is pure capability (not tied to `?worker=0` for the `ok` / `capable` meaning); console messages updated.  
- `src/main.ts` — comment block for URL flags.  
- `src/ui/mountApp.ts` — comment on `activeDockWorkerHost`.  

**Related implementation work (worker path quality, not the default flip):** dock orbit **target + exponential smoothing** + SAB publishing **targets** (parity with `CharacterScenePreview.tickCameraSmoothing` / `getCameraYawPitch`); `applySoloDockCameraFraming` for deck on worker; terrain floor EMA when camera lock is active; various `mountApp` SAB / scratch sync fixes for lock-on vs pointer lock. See `src/worker/characterSceneController.ts` and `src/ui/mountApp.ts` history.

---

## 4. Current gap analysis (summary)

| Area | Legacy `CharacterScenePreview` | Worker `CharacterSceneController` + `CharacterSceneHost` |
|------|--------------------------------|--------------------------------------------------------|
| **Solo third-person + awakened** | Full | **Substantial** work: locomotion, mobs, projectiles, forest/harvest **hits**, SAB, input forwarders. |
| **Camera orbit + zoom** | `tickCameraSmoothing`, `applyCameraFraming` / `applySoloDockCameraFraming` | Largely aligned; possible gap: **pan** (`dockCamPan*`) if legacy used it. Awakened third-person constants vs `idleCraftDockCameraCompass` may still differ — see [GAME_VISION_VS_IMPLEMENTATION_2026_04.md](GAME_VISION_VS_IMPLEMENTATION_2026_04.md) §3.4. |
| **Dream / deck — gather** | `playGatherAction`, walk-to, slot props, clip state | **Stubs** in `handleMessage` for `playGatherAction`, `playGatherActionInPlace`, `syncGatherRpgVisuals`, `setResourceHover`, battle clips, `playOneShot`, etc. `CharacterSceneHost.syncGatherRpgVisuals` is a **no-op** (maps “not on the wire yet”). |
| **SAB `GATHER_*`** | Driven by real clips | **Stubbed** triple in `syncSharedRenderState` until worker runs gather LPCA. |
| **Why so many gaps?** | N/A | Phased migration: **typed `protocol` first**, bodies incrementally; thread boundary forces rewrite; dream mode is a large LPCA/FSM surface area not yet ported. |

**Triage command:** compare **`?worker=0`** (or default legacy) vs **`?worker=1`** on the same machine/tier to isolate worker-only regressions.

**Future options:** (1) keep default legacy until dream parity is implemented on the worker; (2) port gather/battle FSMs into the worker; (3) hybrid — deck on main, awakened only on worker (would need routing in preload/mount — not built as a single switch today).

---

## 5. When to read which doc

| Question | Doc |
|----------|-----|
| URL flags, default, opt-in, runtime cost | **This file** |
| Step-by-step migration, checkboxes | [WORKER_MIGRATION_PHASE_3X.md](WORKER_MIGRATION_PHASE_3X.md) |
| Module map, two-thread diagram, carve-outs | [WORKER_ARCHITECTURE.md](WORKER_ARCHITECTURE.md) |
| Player-facing gaps (preload, sky, camera feel) | [GAME_VISION_VS_IMPLEMENTATION_2026_04.md](GAME_VISION_VS_IMPLEMENTATION_2026_04.md) |
| Agent rules in worker code | [src/worker/AGENTS.md](../src/worker/AGENTS.md) |

**Changelog (this file):** 2026-04-22 — initial document; default worker → legacy + URL semantics + gap summary. Update this section when the default or flags change.
