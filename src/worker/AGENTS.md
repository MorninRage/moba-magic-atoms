/**
 * @file src/worker/AGENTS.md
 * Worker-architecture rules and constraints for everything inside `src/worker/`.
 */

# `src/worker/` — Render Worker module

This folder contains code that runs INSIDE a dedicated Web Worker
(`renderWorker.ts` is the worker entrypoint). It owns the only `WebGLRenderer`
in the app, all scene state, and the rAF render loop.

**Product default (2026-04-22+):** this worker is **not** started unless the app opts in with **`?worker=1`** and the browser passes `capabilityGate` (`isWorkerRenderCapable()`). The normal dock is **main-thread** `CharacterScenePreview`. See `docs/WORKER_VS_LEGACY_PATH.md` for URL flags, runtime cost, and gap analysis.

## Hard rules for any file in this folder

1. **NO DOM**. Workers do not have `document`, `window`, `HTMLElement`,
   `HTMLImageElement`, or any DOM APIs. Do not import anything that touches
   them. `OffscreenCanvas`, `OffscreenCanvasRenderingContext2D`,
   `createImageBitmap`, and `fetch` are available — use those instead.

2. **NO Web Audio**. `AudioContext` is main-thread-only. To play a sound from
   the worker, post a typed message to main via `protocol.ts` and let
   `audioBridge.ts` on main consume it.

3. **NO localStorage / sessionStorage**. Persistence stays on the main thread.
   `idbCache` (`src/util/idbCache.ts`) is fine — IndexedDB works in workers.

4. **NO direct GameStore access**. The worker does not import `GameStore`.
   State that the worker needs (preset, equipment, online presence, mode)
   arrives as a `WorkerMessage` from main, written to controller fields.
   State the worker produces for main (avatar XYZ, camera state, gather
   progress) is written to `SharedRenderState` via `Atomics.store` and read
   on main without any postMessage round-trip.

5. **rAF inside worker**: `globalThis.requestAnimationFrame` works in workers
   when bound to an `OffscreenCanvas`. Use it. Do not `setTimeout`-loop.

6. **Capability gate already passed**: by the time this worker is spawned,
   main has verified `OffscreenCanvas`, `transferControlToOffscreen`,
   `SharedArrayBuffer`, `Atomics` all exist. Do not re-check.

## File layout

| File | Role |
|------|------|
| `renderWorker.ts` | Worker entrypoint. Receives the `OffscreenCanvas` + `SharedArrayBuffer` + initial config, constructs the controller, starts the rAF loop. |
| `protocol.ts` | Typed `WorkerMessage` discriminated union for every state-mutating call from main → worker, plus `MainMessage` for worker → main events (footstep SFX, custom events, etc.). |
| `sharedState.ts` | `SharedRenderState` class wrapping the SAB. Defines slot layout + typed accessors using `Atomics.load/store/add`. |
| `dockSharedRenderReadback.ts` | Registers active dock SAB on main while `WorkerBridge` lives; `fillPerspectiveCameraFromSharedState` for DOM projection. |
| `characterSceneController.ts` | Scene + camera + renderer + dock environment + forest tickers + post-processing + rAF. Writes per-frame `SharedRenderState` (avatar, camera, staff tip, water bank, tone exposure, flags). |
| `bootstrapDockSceneSlice.ts` | Dock sky + environment bootstrap + `attachWorkerDockTerrainWaterSlice`. |
| `attachWorkerDockHeroLpcaSlice.ts` | Dock vanguard LPCA + solo camera + staff orb; returns `avatar`, `vanguardWizardStaffRoot`, `staffOrbVfx`. |

## Why SharedArrayBuffer instead of postMessage state mirroring

`CharacterScenePreview` exposes 60+ getters that main calls per-frame
(damage floater projection, reticle aim, store-driven HUD updates).
postMessage round-trips would add 1 frame of lag on every getter, breaking
combat feel. SAB lets main read worker-produced state via `Atomics.load`
in the same frame the worker wrote it (no IPC).

## COOP/COEP requirement

`SharedArrayBuffer` requires:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: credentialless` (or `require-corp`)

Configured in `netlify.toml` (production) and `vite.config.ts` (dev server).
We use `credentialless` so cross-origin no-credentials resources
(Google Fonts, vibejam widget) load without needing CORP headers from
those origins.
