# Session 2026-04-22 — OffscreenCanvas worker scaffold (Phases 0-4)

## What shipped this session

**Big-bang OffscreenCanvas + SharedArrayBuffer migration scaffold.** Phases
0-4 of the [migration plan](../.cursor/plans/offscreen-canvas-migration_60d8fe05.plan.md)
are complete; Phases 5-7 (input/audio bridges, lobby carve-out, verification +
ship) remain. The legacy `src/visual/characterScenePreview.ts` path is
UNCHANGED and remains the live render path — the worker scaffold is
opt-in via `?worker=1` URL flag (and only after the controller actually
constructs a renderer in a future Phase 3.x pass).

## Files added

```
src/worker/
  AGENTS.md                       — hard rules for everything in src/worker/
  protocol.ts                     — typed WorkerMessage + MainMessage unions
  sharedState.ts                  — SharedArrayBuffer slot layout + accessors
  capabilityGate.ts               — probe + Atomics smoke test
  renderWorker.ts                 — worker entrypoint (dispatcher → controller)
  characterSceneController.ts     — worker-side scene owner (SCAFFOLD)
  workerBridge.ts                 — main-thread postMessage facade
src/visual/
  characterSceneHost.ts           — main-thread shell that uses WorkerBridge
                                    (DOM canvas + transferControlToOffscreen
                                    + canvas event forwarding)
```

## Files changed

- `netlify.toml` — added `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: credentialless` to `/index.html` and `/`.
  `credentialless` (not `require-corp`) so cross-origin no-credentials
  resources (Google Fonts, vibejam widget) load without each origin needing
  to send `Cross-Origin-Resource-Policy: cross-origin`.
- `vite.config.ts` — mirrors COOP/COEP headers in dev server; adds
  `worker: { format: 'es' }` so the worker bundles as ESM matching
  `new Worker(url, { type: 'module' })`.
- `src/main.ts` — calls `probeWorkerCapabilities()` + `verifyAtomicsRoundTrip()`
  early in boot. Result exposed at `globalThis.idleCraft.worker` for DevTools
  triage. Phase 0 LOGS only — does not block boot.

## SharedArrayBuffer slot layout (`sharedState.ts`)

| Slot type | Index | Field | Owner | Reader |
|-----------|-------|-------|-------|--------|
| f32       | 0-2   | Avatar XYZ | worker | main per-frame |
| f32       | 3-5   | Camera yaw/pitch/zoom | worker | main per-frame |
| f32       | 6-7   | Camera forward XZ | worker | main per-frame |
| f32       | 8-10  | Staff tip XYZ | worker | main per-frame |
| f32       | 11-13 | Gather progress + clip duration + sfx delay | worker | main on demand |
| f32       | 14-15 | Water bank XZ | worker | main on demand |
| f32       | 16    | Tone mapping exposure | worker | main on demand |
| i32       | 0     | Flags bitmask (AIRBORNE, CAMERA_LOCKED, AWAKENED, etc.) | both | both |
| i32       | 1-2   | Mouse delta XY (fx16 fixed-point, accumulated via `Atomics.add`) | main writes | worker drains |
| i32       | 3     | Wheel delta Y | main writes | worker drains |
| i32       | 4     | Keyboard state bitmask | main writes | worker reads per frame |
| i32       | 5     | Mouse buttons bitmask | main writes | worker reads per frame |
| i32       | 6     | Pointer-lock active | main writes | worker reads per frame |
| i32       | 7-8   | Frame counter + last-render-timestamp | worker writes | main reads for liveness |

Total: 1024 f32 bytes + 256 i32 bytes = 1280 bytes per worker.

## Phase 4 audit — module worker-portability

Audited every scene-construction module the controller will eventually
import. Searched for `document`, `window`, `navigator`, `localStorage`,
`HTMLElement`, `HTMLImageElement`, `Image`, `createElement`,
`requestAnimationFrame`, `AudioContext`.

| Module | Worker-safe? | Notes |
|--------|--------------|-------|
| `src/visual/forestEnvironment.ts` | ✅ Yes | Only a doc comment mentions rAF |
| `src/visual/idleCraftNightMagicLPCA.ts` | ✅ Yes | Clean |
| `src/visual/goeStyleHarvestLPCA.ts` | ✅ Yes | Clean |
| `src/visual/dockHeroFigureLPCA.ts` | ✅ Yes | Clean |
| `src/world/dockForestBatchedScene.ts` | ✅ Yes | `localStorage.getItem('dockForestDebug')` already typeof-guarded — degrades silently in worker |
| `src/world/freeRoamHarvestNodes.ts` | ✅ Yes | Clean |
| `src/world/awakenedBouncyMushrooms.ts` | ✅ Yes | Uses bare `requestAnimationFrame` for compile-then-cleanup; rAF IS available in OffscreenCanvas-bound workers |
| `src/world/idleCraftDockEnvironment.ts` | ✅ Yes | Only "window" appears in doc comments |
| `src/world/idleCraftHeightfield.ts` | ✅ Yes | Clean |
| `src/util/idbCache.ts` | ✅ Yes | Pure IndexedDB; doc-comment mention of `navigator.storage` only |
| `src/engine/idleCraftEngine.ts` | ✅ Yes | Clean of DOM refs at top level (transitive imports TBD) |
| `src/engine/graphicsTier.ts` | ⚠️ Main-only | Uses `window` + `localStorage` + `navigator`. Stays on main; resolved tier passed to worker via `init.graphicsTier` |
| `src/engine/persistentCache.ts` | ⚠️ Main-only | Registers SW + uses `navigator.storage`; stays on main |

**Conclusion**: scene-construction modules can move into the worker bundle
as-is. The two main-only items (`graphicsTier`, `persistentCache`) are
already not imported by the scene path; their outputs already cross the
worker boundary as plain values.

## Capability gate behavior

`probeWorkerCapabilities()` checks four primitives:

1. `typeof OffscreenCanvas !== 'undefined'`
2. `HTMLCanvasElement.prototype.transferControlToOffscreen`
3. `typeof SharedArrayBuffer !== 'undefined'`
4. `crossOriginIsolated === true`

Plus a runtime smoke test: actually allocates `new SharedArrayBuffer(1)`
to catch browsers where the constructor exists but isolation is incomplete.

URL flags (see **`docs/WORKER_VS_LEGACY_PATH.md`** for current product policy):
- **Default (no param):** legacy main-thread dock — worker **not** started.
- **`?worker=1`:** opt in to the worker dock when capable.
- **`?worker=0`:** block the worker path.

Capability result is exposed at `globalThis.idleCraft.worker` for triage. Console at boot notes Offscreen+SAB availability and the legacy default.

## What's NOT yet done (Phase 3.x + 5-7)

- **Phase 3.x — full `CharacterSceneController` build-out**:
  - `createRendererAsync` from `idleCraftEngine` invoked in worker context
    (will need to verify the engine's transitive imports stay clean —
    Phase 4 audit covered the scene modules but not the engine bootstrap).
  - Scene attach: forest, character rig, equipment, harvest nodes, decor.
  - Post-processing stack from `empire-engine`.
  - Real per-frame writes for all SharedState slots (currently zeroed
    placeholders).
- **Phase 5 — input + audio bridges**: refactor `freeRoamControls.ts` and
  `cameraLockController.ts` into main-listener + worker-consumer halves
  via the SharedState input ring.
- **Phase 6 — lobby carve-out**: keep `multiplayerAvatarStage.ts` (CSS2D)
  on main with its own secondary `WebGLRenderer`.
- **Phase 7 — verification + ship**: per-frame audit comparing legacy vs
  worker path, getter parity assertion in dev mode, `LEARNINGS.md` +
  `docs/WORKER_ARCHITECTURE.md` writeup, single merge.

## How to test the worker path today

```
npm run dev
# With worker dock: http://localhost:3000?worker=1
#   Console: [worker-gate] … + Atomics round-trip; CharacterSceneHost spawns render worker.
# Without ?worker=1: legacy main-thread dock only; worker not started.
# Policy: docs/WORKER_VS_LEGACY_PATH.md
```

**Manual smoke (optional):** from devtools you can also construct a host in a console:

```js
const { CharacterSceneHost } = await import('/src/visual/characterSceneHost.ts');
const host = await CharacterSceneHost.create(document.querySelector('#some-container'), {
  graphicsTier: 'balanced',
  projectJson: '{}',
});
// Console should print:
//   [render-worker] worker init OK — canvas WxH @ DPR ...
```

## Risks called out in plan, status update

- ✅ COOP/COEP breakage — `credentialless` chosen so Google Fonts +
  vibejam widget unaffected.
- ⏳ Safari <16.4 user impact — capability gate detects + logs; explicit
  "update browser" page deferred until Phase 7 (the live path still works
  for those users today since worker is opt-in).
- ⏳ Worker scene rebuild on hot-reload — Phase 3.x will need to verify
  Vite HMR re-spawns the worker on `characterSceneController.ts` edits
  (today the scaffold doesn't yet exercise this).
- ⏳ `freeRoamControls` movement-feel regressions — Phase 5 deliverable.
- ⏳ WebGL context loss in worker — handler is wired in `characterSceneHost`
  + `WorkerBridge`; controller-side recovery is Phase 3.x.
- ⏳ Service-worker + worker interaction — `persistentCache` stays main-only,
  so SW registration order is unaffected.
- ✅ Bundle split — `worker: { format: 'es' }` in `vite.config.ts` ensures
  worker module is its own chunk.
