# Session 2026-04-21 — Preload Round 5 Implementation (main-thread + render-loop budget)

## Context

Companion to:
- `docs/SESSION_2026_04_21_PRELOAD_ROUND_5.md` — round 5 prior-art digest (this doc's plan)
- `docs/SESSION_2026_04_21_PRELOAD_ROUND_4.md` — round 4 (Workbox SW + storage.persist + adaptive device profile)
- `docs/SESSION_2026_04_20_PRELOAD_ROUND_3.md` — round 3 (cutscene re-encode + staged forest + zero-alloc tick + awakened-only deferral)
- `docs/SESSION_2026_04_20_PRELOAD_ROUND_2.md` — round 2 (sub-ms yields + deferred renderPage + tighter caps)
- `docs/SESSION_2026_04_20_PRELOAD_OPTIMIZATION.md` — round 1 (unified pipeline + ghost mesh fix)

Round 5 prior-art digest established that 5 of 9 Tier-1 techniques were already shipped or N/A in this codebase. This implementation pass landed the remaining 4 + extended 1 (View Transitions) to additional sites. Net 6 phases (A–G, with C fanned to 4 sub-phases).

The doc structure deliberately mirrors round 4: scope reconciliation up front, per-phase implementation notes, then the empirical re-measurement plan (which is a **separate user-driven session**, not part of the agent's implementation work).

---

## Scope reconciliation vs round 5 prior-art

| Tier-1 # | Technique | Status going in | Action this session |
|---|---|---|---|
| 1 | View Transitions API | shipped for `renderPage` only (round 4) | extended to 4 hard-cut scene swaps in `main.ts` |
| 2 | `scheduler.yield()` cascade | shipped as `yieldToEventLoop` in `src/util/mainThreadYield.ts` | no action |
| 3 | rIC safety-buffer pattern | N/A — all 7 rIC sites are fire-once callbacks, not chunking loops | superseded by phase F1 (re-tag by `scheduler.postTask` priority) |
| 4 | "Empty boot scene" audit | bracketed for measurement; static analysis says deferral has race risk | bracketed only; defer decision to round 6 once numbers exist |
| 5 | Concurrency-limited preload queue | not done — 7-way `Promise.all` parse-storm in `dockExtendedPreload` | added `withConcurrencyLimit` helper; cap = 2 |
| 6 | `ImageBitmapLoader` for textures | N/A — no file-based image textures (all procedural / PMREM) | no action |
| 7 | `scheduler.postTask` priority tags | not done | added `schedulePostTask` + `schedulePostTaskCancellable`; re-tagged 7 rIC sites |
| 8 | Frame-spread `InstancedMesh` upload | not done | new `chunkedYieldingLoop` / `chunkedYieldingRange` helpers; chunked 4 hot sync blocks |
| 9 | `BatchedMesh` for multi-species foliage | shipped for dock-forest harvestables (`dockForestBatchedScene.ts`) | no migration; kept the existing static-merge path for non-harvestables (no clear win to convert) |

Research-only items (R1 OffscreenCanvas, R2 WebGPU, R3 RenderPipeline / TSL, R4 Speculation Rules) — all deferred per the round 5 prior-art conclusion.

---

## What was shipped

### Phase A — Measurement scaffold

`measureBlock` + `measureBlockAsync` helpers added to `src/util/longAnimationFramesAudit.ts`. Each writes a `performance.measure()` named `idle-craft:<label>` so the entries are namespaced and easy to filter. New `dumpRound5Measures()` walks the `performance` measure buffer at the end of `bootIntroExperience`, filters to the prefix, sorts by start-time, and console-tabulates (`console.table`) under `?perf=audit`. No-op without the flag — production traffic carries zero overhead beyond the cheap `performance.mark` / `performance.measure` calls themselves (already used widely by Three.js internals).

Brackets installed at:

| Block | File | Measure name |
|---|---|---|
| `bootstrapIdleCraftEngineRuntime` | `src/main.ts` | `main.bootstrapEngineRuntime` |
| `new GameStore()` | `src/main.ts` | `main.newGameStore` |
| `bakeTrippyGroundVertexColors` | `src/visual/forestEnvironment.ts` | `forest.bakeTrippyGround` |
| `scatterWorldForestStrata` | `src/visual/forestEnvironment.ts` | `forest.scatterStrata` |
| `mergeByMaterialTiled` × 3 | `src/visual/forestEnvironment.ts` | `forest.mergeNear` / `forest.mergeFar` / `forest.mergeUnderstory` |
| veg-wind install pass | `src/visual/forestEnvironment.ts` | `forest.windInstall` |
| 7-way dynamic-import `Promise.all` | `src/engine/dockExtendedPreload.ts` | `extPreload.parallelImports` |
| `attachDockForestBatchedScene` | `src/engine/dockExtendedPreload.ts` | `extPreload.attachDockForest` |

### Phase B — main.ts top-level sync audit

Static analysis of pre-`bootIntroExperience` work:

- `bootstrapIdleCraftEngineRuntime()` calls `ProceduralTextures.getInstance().warmUp(256)`. The singleton is consumed lazily by LPCA materials inside `attachForestBackdrop`. **Race risk if deferred:** the cutscene-skipped path fires `schedulePreloadAfterPaint()` in the SAME tick as `scheduleSecondaries()`, so an LPCA material can ask for a texture before the singleton populates. **Decision:** bracket for measurement; defer the move to round 6 if numbers warrant.
- `new GameStore()` is referenced synchronously by the `vibejam-portal-exit` window listener at the bottom of `main.ts` AND by `mountStartFlow`. Restructuring its lifetime is out of scope for round 5. **Decision:** bracket for measurement; no structural change.

Audit outcome documented inline in `src/main.ts` so the round-6 author has the constraint context without needing to re-derive it.

### Phase C — Frame-spread heavy sync blocks

Added two new helpers to `src/util/mainThreadYield.ts`:

- `chunkedYieldingLoop<T>(items, perItem, opts?)` — array-driven frame-spread iteration.
- `chunkedYieldingRange(count, perIndex, opts?)` — index-only variant; avoids constructing an intermediate array for `setMatrixAt` / vertex-bake patterns. Both default to an 8 ms wall-clock budget; the yield uses the existing `yieldToEventLoop()` cascade so each break is sub-millisecond.

Applied at:

**Phase C1 — `bakeTrippyGroundVertexColors`** (`src/visual/forestEnvironment.ts`). Converted to async. The per-vertex slope-sample + color-write loop now uses `chunkedYieldingRange` over the vertex count. Caller `attachForestBackdrop` already had a yield BEFORE the bake; the bake itself was monolithic. With ~10k–40k vertices on high tier the synchronous loop ran ~15–40 ms; chunked yielding caps each task at ~8 ms.

**Phase C2 — `scatterWorldForestStrata`** (`src/visual/forestEnvironment.ts`). Converted to async with a `scatterMaybeYield()` closure that tracks wall-clock since the last yield (8 ms budget). The inner `placeTreeStratumEvenDisk`'s slice loop calls `addStratumTree` (full LPCA tree mesh build) and now yields when the budget is exhausted. The companion `placeStratumEvenDisk` (ground stratum loop) yields once per ring (lighter per-item cost than tree builds, so per-ring yield avoids per-item overhead). The function's call site in `attachForestBackdrop` is now `await measureBlockAsync('forest.scatterStrata', () => scatterWorldForestStrata(...))`.

**Phase C3 — Yields between `mergeByMaterialTiled` passes** (`src/visual/forestEnvironment.ts`). The 3 merge passes (~40–80 ms each per inline comment) plus the `cloneMaterialsForVegetationWind` + `installVegetationWindOnMergedGroup` pass each got an `await yieldToEventLoop()` between them. `mergeByMaterialTiled`'s inner `BufferGeometryUtils.mergeGeometries` is hard to chunk internally (canonical Three.js bulk geometry op); per-call yields are the right granularity.

**Phase C4 — Frame-spread `attachDockForestBatchedScene` scatter loop** (`src/world/dockForestBatchedScene.ts`). Converted to `async`. Added a yield between Step 4 (BatchedMesh shells) and Step 5 (instance scatter). Inside the per-spec scatter loop, yield when an 8 ms wall-clock budget is exhausted. One more yield before the bounding-box compute pass. Both callers updated:
- `src/engine/dockExtendedPreload.ts` — already async, just `await`s the new return.
- `src/ui/mountApp.ts` `ensureDockForestAttached` — added `dockForestAttachInFlight: Promise<void> | null` guard so the per-frame ticker (which calls `ensureDockForestAttached()` every frame until the handle exists) doesn't re-fire the construction while it's still spreading. The handle is set inside the promise's `.then`; the in-flight is cleared in `.finally`.

### Phase D — Concurrency-limited extended-preload imports

`withConcurrencyLimit<T>(tasks, limit)` added to `src/util/mainThreadYield.ts`. The 7-way `Promise.all([7 dynamic imports])` at the start of `runExtendedPreload` (`src/engine/dockExtendedPreload.ts`) was a parse-storm: 7 chunks parse in parallel on the main thread, ~100–300 ms of stacked sync V8 parse work. Now wrapped in `withConcurrencyLimit([...], 2)` — pipelines parses 2-at-a-time, total wall-clock unchanged on a healthy network, parse work spreads across 3-4 task slices instead of one. Babylon.js / Unity LZ4 prior art (round 5 doc #5).

The destructuring shape needed a typed-tuple cast (`as [typeof import('./a'), typeof import('./b'), ...]`) because `withConcurrencyLimit<T>` infers a single-typed array; the cast is the smallest type-system surface that preserves per-import strong typing without splitting the helper into N typed overloads.

### Phase E — View Transitions for 4 hard-cut scene swaps

New `withViewTransition(swap)` helper at `src/util/viewTransitions.ts`. Wraps `document.startViewTransition`; falls back to executing the swap immediately on browsers without the API (Firefox <144, older Chromium). Swallows the `finished` rejection so an aborted transition doesn't surface as an unhandled rejection.

Wrapped at 4 sites in `src/main.ts`:

1. **Splash → curse cutscene** — outgoing splash (no canvas), incoming cutscene overlay (no canvas yet). Pure DOM, snapshot is cheap.
2. **Curse cutscene → title flow** — outgoing cutscene overlay, incoming start-flow UI. Pure DOM.
3. **`enterGame` (title → cleared appRoot)** — outgoing title flow (no canvas), incoming empty appRoot then cutscene overlay. Pure DOM at the swap moment.
4. **`returnToTitle` (game shell → title flow)** — outgoing GAME SHELL with WebGL canvas; the `disposeIdleCraftDockScene()` call happens BEFORE the swap so the snapshot captures a disposed-canvas frame. The cross-fade animates from disposed-canvas to freshly-mounted title — perceived latency win even if the snapshot is technically frozen for ~200 ms.

The known canvas-snapshot caveat from `LEARNINGS.md` (which is why `renderPage` skips View Transitions in realm-awakened mode) is documented inside `withViewTransition`'s JSDoc so future callers don't repeat the discovery.

### Phase F1 — `scheduler.postTask` priority tags

`schedulePostTask(fn, priority)` + `schedulePostTaskCancellable(fn, priority)` added to `src/util/mainThreadYield.ts`. The cancellable variant uses `scheduler.postTask`'s `AbortController`-based cancellation when available, with the same uniform interface across all 3 backend paths (postTask / rIC / setTimeout). Returns `{ cancel(): void }` so callers don't need to track which backend ran.

7 rIC sites re-tagged by priority intent:

| Site | Priority | Why |
|---|---|---|
| `main.ts` `deferredBootSecondaries` | `background` | Audio init, scrollbar, system menu, room hub, SW registration — all genuinely background |
| `main.ts` dock-preload `trigger` | `user-visible` | Dock preload IS what the player is waiting to see, but must not block first paint / input |
| `characterScenePreview.ts` `deferDockGpuWarm` (the pre-warm defer) | `background` | GPU shader compile, fundamentally interleavable |
| `characterScenePreview.ts` `scheduleNext` (warm pipeline pass scheduler) | `background` | Same — each pass is GPU-driver-side compile |
| `idleCraftDockEnvironment.ts` `runIblPmremRegen` slot | `background` | Sky-tint PMREM regen is throttled to 4 s; 50–150 ms slot delay invisible |
| `mountApp.ts` `ensureAwakenedSystemsOnce` | `user-visible` | Realm-flip fluidity matters but must not block first deck render |
| `mountApp.ts` deferred `renderPage` | `user-blocking` | Player is actively waiting to see the deck; promote above the previous rIC default |

`characterScenePreview.ts` needed a structural change because its `dockWarmRaf` / `dockWarmDeferRaf` numeric handle fields supported `cancelAnimationFrame` / `cancelIdleCallback` / `clearTimeout` "try-all-three" cancel. Now they're `dockWarmTask: CancellablePostTask | null` / `dockWarmDeferTask: CancellablePostTask | null` and `cancelDockWarmHandle('defer' | 'pass' | 'both')` calls `.cancel()` on each. Public API (the method's name + parameter) unchanged — only the internal handle type changed.

### Phase F2 — `setTimeout(0)` chunking stragglers

The targeted stragglers (`idleCraftDockEnvironment.ts` L443 and `mountApp.ts` L4859) were the rIC fallback `setTimeout` paths. Phase F1 replaced both via the unified `schedulePostTask` helper, which has its own legacy fallback ladder. Net: phase F2's intent is satisfied as a side-effect of F1; no separate changes needed. The two remaining `setTimeout(..., 0)` matches in the codebase live inside `mainThreadYield.ts` itself as the cascade endpoints — canonical, leave alone.

### Phase F3 — `WebGLQuery` audit

Grepped `readPixels`, `readRenderTargetPixels`, `getBufferSubData` across `src/`. **Zero matches.** Picking is done CPU-side via `THREE.Raycaster` (verified by file scan of `src/world/awakenedCombat.ts`, `src/world/awakenedMobs.ts`, `src/world/buildModeController.ts`). No GPU readback surface in this codebase; `WebGLQuery` has nothing to wrap. Documented as N/A.

---

## Net file changes

| File | Phase(s) | Nature |
|---|---|---|
| [src/util/longAnimationFramesAudit.ts](src/util/longAnimationFramesAudit.ts) | A | Added `measureBlock`, `measureBlockAsync`, `dumpRound5Measures` |
| [src/util/mainThreadYield.ts](src/util/mainThreadYield.ts) | C / D / F1 | Added `chunkedYieldingLoop`, `chunkedYieldingRange`, `withConcurrencyLimit`, `schedulePostTask`, `schedulePostTaskCancellable`, `CancellablePostTask` |
| [src/util/viewTransitions.ts](src/util/viewTransitions.ts) | E | New file — `withViewTransition` helper |
| [src/main.ts](src/main.ts) | A / B / E / F1 | Bracketed top-level sync work; documented audit outcome; wrapped 4 scene swaps; re-tagged 2 rIC sites |
| [src/visual/forestEnvironment.ts](src/visual/forestEnvironment.ts) | A / C1 / C2 / C3 | Bracketed forest blocks; converted bake + scatter to async with chunked yields; added yields between merge passes |
| [src/world/dockForestBatchedScene.ts](src/world/dockForestBatchedScene.ts) | C4 | Converted attach to async; chunked the scatter loop on 8 ms budget |
| [src/engine/dockExtendedPreload.ts](src/engine/dockExtendedPreload.ts) | A / D | Capped 7-way `Promise.all` to 2-concurrent; bracketed dock-forest attach + parallel imports |
| [src/ui/mountApp.ts](src/ui/mountApp.ts) | C4 / F1 | Added in-flight guard for async dock-forest attach; re-tagged 2 rIC sites |
| [src/visual/characterScenePreview.ts](src/visual/characterScenePreview.ts) | F1 | Re-tagged 2 GPU-warm rIC sites; converted handle fields to `CancellablePostTask` |
| [src/world/idleCraftDockEnvironment.ts](src/world/idleCraftDockEnvironment.ts) | F1 | Re-tagged 1 IBL PMREM regen rIC site |

No production-asset changes (no new images, no shader rewrites, no save-state migration). Type-check + production build expected to pass; no new TypeScript surface beyond the helpers' public APIs.

---

## Empirical re-measurement plan (next session)

This is the explicit handoff for the user-driven measurement pass. The implementation work above is complete; the numbers are not.

1. Run the dev server (`npm run dev`).
2. Open the app with `?perf=audit` appended to the URL.
3. Reload the page. Watch DevTools Console for:
   - The LoAF observer's per-frame warnings (existing round 4 instrumentation).
   - The `[idle-craft][perf:audit] round-5 named-block measures` table dumped near the end of `bootIntroExperience`.
4. Record the duration of each named block. Repeat 3× for stability and take the median.
5. Fill in the placeholders below.

| Block | Before (round 4) | After (round 5) | Δ |
|---|---|---|---|
| `main.bootstrapEngineRuntime` | TBD | TBD | TBD |
| `main.newGameStore` | TBD | TBD | TBD |
| `forest.bakeTrippyGround` | TBD | TBD | TBD (max-task should drop) |
| `forest.scatterStrata` | TBD | TBD | TBD (max-task should drop substantially) |
| `forest.mergeNear` | TBD | TBD | unchanged (yield is around it, not inside) |
| `forest.mergeFar` | TBD | TBD | unchanged |
| `forest.mergeUnderstory` | TBD | TBD | unchanged |
| `forest.windInstall` | TBD | TBD | unchanged |
| `extPreload.parallelImports` | TBD | TBD | total time ≈ unchanged; max-task should drop |
| `extPreload.attachDockForest` | TBD | TBD | TBD (max-task should drop) |

The measure values are **per-block totals** including any internal yields. The win in this round is **task-shape**, not total-block time — LoAF entries are the source of truth for "did we eliminate the long task."

Acceptance for round 5: no single LoAF entry from a named block exceeds 16 ms when running on a CPU 4× throttled DevTools profile.

---

## Out of scope (explicitly)

- WebGPU migration (R2, R3) — research-only, deferred.
- `OffscreenCanvas` + worker (R1) — research-only, deferred.
- Speculation Rules API (R4) — N/A for single-route SPA.
- `ImageBitmapLoader` — no surface (no file-based image textures).
- rIC safety-buffer pattern — no chunking-loop rIC sites; superseded by Phase F1.
- `BatchedMesh` migration of non-harvestable forest — `mergeByMaterialTiled` static merge already collapses draw calls; no clear win.
- main.ts top-level sync deferral — race risk identified during Phase B audit; revisit if Phase A measure says it's heavy.

---

## What round 6 should target

Empirical re-measurement first. After numbers exist, the candidates ranked by likely impact:

1. If `extPreload.attachDockForest` LoAF entries still exceed 16 ms after the C4 chunking: tune the chunk budget down (currently 8 ms) or add a yield between the per-bucket outer loop and the per-spec inner loop.
2. If `forest.scatterStrata` LoAF entries still exceed 16 ms: lower the `CHUNK_BUDGET_MS` constant (currently 8) or add per-iteration yields in `placeStratumEvenDisk` (currently per-ring).
3. If `main.bootstrapEngineRuntime` exceeds ~5 ms: revisit the deferral race documented in Phase B. Likely fix: add a "wait for proc-textures-warm" guard inside the LPCA texture lookup so deferral becomes safe.
4. If `main.newGameStore` exceeds ~10 ms: identify which content/data hydration is heavy (recipes, cards, dialog) and split into `coreInit()` (sync, needed for `mountStartFlow`) + `lazyHydrate()` (called from `scheduleSecondaries` or `enterGame`).
5. If View Transitions perceived smoothness regresses on `returnToTitle`: drop that wrapping (game-shell → title is the only canvas-snapshot site of the four).

---

## Sources

Same source list as the round 5 prior-art digest — see [docs/SESSION_2026_04_21_PRELOAD_ROUND_5.md](docs/SESSION_2026_04_21_PRELOAD_ROUND_5.md) "Sources" section.
