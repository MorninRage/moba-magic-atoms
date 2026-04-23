# Session 2026-04-20 — Preload Round 2 (post-cutscene-2 latency cut)

## Context

Companion to **`docs/SESSION_2026_04_20_PRELOAD_OPTIMIZATION.md`** (morning ghost-mesh + unified-preload work) and **`docs/SESSION_2026_04_20_ANIMATION_AND_UX_POLISH.md`** (afternoon animation polish). This pass is a focused latency cut on the **post-cutscene-2 → game-playable** window. No functions removed, no fallback paths altered, no veils dropped — just faster slots + shorter caps.

User report: "after cutscene 2 we are coming in faster to the game" — i.e. the gap between the shattering cutscene fading out and the gather page being interactive felt longer than necessary.

---

## What was changed

### Patch 1 — Tier A (smallest-diff wins)

**A1. Yield-primitive swap (`yieldAnimationFrame` → `yieldToEventLoop`).**

`yieldAnimationFrame` waits ~16 ms for the next paint frame; `yieldToEventLoop` (already in `src/util/mainThreadYield.ts` from this morning's work) drains the event loop in <1 ms via `scheduler.yield()` / `MessageChannel.postMessage`. The yields between cheap synchronous phases (preset apply, equipment sync, page-context flip, gather-mastery sync, scene-singleton no-op ensures, adoption block) don't need a paint frame — they only need to release the main thread for input + microtask drain.

Files:
- `src/engine/dockExtendedPreload.ts` — all 9 inter-phase yields swapped (~135 ms saved title-time per preload).
- `src/ui/mountApp.ts` — 7 of the 11 yields swapped (~110 ms saved post-cutscene). The 4 retained `yieldAnimationFrame` calls are at slots that genuinely need paint sync (between awakened-systems schedule and pre-tutorial render, before tutorial mount, the double-rAF before veil fade).

**A3. Drop the 120 ms "veil fade gap" `setTimeout` in `enterGame`.**

The 120 ms wait was a perceived smoothness band-aid: "let the preload veil's CSS fade play before the cutscene paints over it." In practice the cutscene `<video>`'s first frame is transparent and the cutscene root carries a CSS opacity transition on the next rAF, so the veil fade and cutscene fade-in already overlap visually. The 120 ms was 100 % perceived dead air on every slow-device boot.

File: `src/main.ts` — `enterGame` post-`preloadPromise` block.

**A4. Mount the post-cutscene compositor veil from the shattering cutscene's `onCleanupStart` callback.**

Previously the veil was mounted AFTER `await playIntroCutscene(...)` resolved (which fires at cleanup-start, not end-of-fade — so already in parallel with the 600 ms fade in concept, but the veil DOM mount + first paint still landed serially after the await). Now `onCleanupStart` runs synchronously inside the cutscene's `cleanup()` right before `resolve()`, so the veil DOM is mounted + queued for paint while the cutscene's own fade-out is still in flight.

`onCleanupStart`-triggered mount is parallel to how cutscene 1 already used `onCleanupStart: schedulePreloadAfterPaint` (the unified-preload kick fires at cleanup-start so the title screen is ready faster). Same pattern, applied to cutscene 2's veil.

Saves ~10–40 ms perceived (no flash between cutscene fade and veil paint) plus eliminates the "cutscene ends → blank frame → veil appears" beat on slower devices.

File: `src/main.ts` — `enterGame` cutscene block.

### Patch 2 — Tier B (slightly more invasive)

**B2. Defer `renderPage()` off the post-cutscene-2 critical path via `requestIdleCallback`.**

`renderPage()` is the gather-page DOM build (every recipe row, inventory entry, helper card, durability bar from the player's full inventory + recipe set). On slower devices it costs 50–200 ms. Previously it ran SYNCHRONOUSLY after `mountTutorial` and before `p(1, 'Ready')`, holding the post-cutscene critical path open for its full duration.

The welcome dialog (mounted by `mountTutorial`) covers the entire page area on first mount, so the gather-page DOM underneath is invisible until the player dismisses the tutorial. Deferring `renderPage` to `requestIdleCallback` (with a `setTimeout(0)` Safari fallback) and resolving `p(1, 'Ready')` immediately means the veil can start fading the same frame the tutorial mounts — the gather page populates 1–2 frames later behind the dialog. Player perception: cutscene → instant tutorial dialog → dismiss reveals fully-rendered page.

Worst-case fallback: if `renderPage` throws (it shouldn't), we log + leave the page empty; the next user interaction's `refreshHud` chain rebuilds it.

File: `src/ui/mountApp.ts` — final block of `mountApp`.

**B4. Lower the pre-shattering `Promise.race(... 4500 ms)` safety cap to 2000 ms.**

The 4500 ms cap was chosen when shader warm passes were synchronous (`renderer.compile`). Today every warm pass uses `compileAsync` (`KHR_parallel_shader_compile`, runs on the GPU driver worker), so the residual sync work in extended preload is just `attachDockForestBatchedScene` + `attachFreeRoamHarvestNodes` + `attachCabinBuilder` + handles attaches — total <2000 ms even on slow devices.

Lower cap means slow-device players who clicked Begin before preload finished reach the shattering cutscene up to 2500 ms sooner. If preload genuinely couldn't finish in 2 s, mountApp's `consume` still awaits the rest after the cutscene (no functional regression — same behaviour as today's timeout path), so the worst case is "first frame of dock paints 200–500 ms after cutscene ends" instead of "+2.5 s of black wait BEFORE the cutscene". The latter is what the player perceives as broken; the former is invisible behind the always-on compositor veil.

File: `src/main.ts` — `enterGame` pre-shattering block.

---

## Estimated wall-clock impact (post-cutscene-2 → playable)

| Bucket | Before | After Patch 1 | After Patch 1 + 2 |
|---|---|---|---|
| Pre-cutscene-2 fade-gap setTimeout | 120 ms (slow path) | 0 ms | 0 ms |
| Pre-shattering preload safety cap | up to 4500 ms (slow path) | up to 4500 ms | up to 2000 ms |
| Sum of yield waits in mountApp post-cutscene | ~144 ms | ~32 ms | ~32 ms |
| Sum of yield waits in dockExtendedPreload | ~144 ms | ~9 ms | ~9 ms |
| `renderPage()` on critical path | 50–200 ms | 50–200 ms | ~0 ms (deferred) |
| Veil mount serial after cutscene | ~10–40 ms perceived | 0 ms (parallel to fade) | 0 ms |

**Net: ~250–500 ms cut from the happy-path post-cutscene-2 latency, +500–2500 ms cut from slow-device boots.** Title-time preload also finishes earlier (~120 ms), raising the "preload ready by player click" hit rate.

---

## Why this respects existing LEARNINGS

1. **Unified preload pipeline intact.** No new state machines, no second `.then` chain. `consumePreloadedDock` still returns the full bundle synchronously — no race window.
2. **Scene-singleton handles unchanged.** Defense-in-depth against HMR / future callers stays in place.
3. **Single shared `collisionWorld`.** No new direct calls to `createCollisionWorld`; `getOrCreateSceneCollisionWorld(scene)` remains the public path.
4. **`compileAsync` warm pattern preserved.** Phase 4 / 6 / 7 / 8 of extended preload still warm via `compileAsync`; the only change is the inter-phase yield primitive.
5. **`AbortError` catch on all three transition promises** unchanged.
6. **Always-on compositor veil during mountApp** preserved. The veil now mounts via `onCleanupStart` instead of after the cutscene's resolve, but the contract is identical: veil shows during the synchronous mountApp body, double-rAF fade after `p(1, 'Ready')`.
7. **No save-state change** — `STATE_VERSION` unchanged, no migration, no save-shape risk.
8. **`renderPage` deferral is invisible** because the welcome dialog covers the gather page on first mount. If a future change makes the dialog dismissable instantly (e.g. ESC during `mountTutorial`'s open animation), the rIC fallback (`setTimeout(0)`) still resolves within ~1 frame, so the worst-case unrendered window is bounded.

---

## Files touched

| File | Change |
|---|---|
| `src/engine/dockExtendedPreload.ts` | Import swap + 9× `yieldAnimationFrame` → `yieldToEventLoop` between phases |
| `src/ui/mountApp.ts` | Import added; 7× yield primitive swap; `renderPage()` deferred via `requestIdleCallback` after `p(1, 'Ready')`; updated comment blocks |
| `src/main.ts` | Dropped 120 ms `setTimeout` post-veil; lowered Promise.race cap 4500 → 2000 ms; veil mounts via shattering cutscene's `onCleanupStart`; `veil` typed as nullable with `activeVeil!` after the cutscene-skipped fallback |

## Files NOT touched (deliberately, with reasoning)

| File | Why skipped |
|---|---|
| `src/engine/dockPreload.ts` | Unified pipeline correct as-is; no further structural change |
| `src/world/collisionWorld.ts` / `dockForestBatchedScene.ts` / `freeRoamHarvestNodes.ts` | Scene-singleton defense-in-depth unchanged |
| `src/visual/characterScenePreview.ts` | Inter-phase yields here can be tuned later (Tier C item C4); not touched in this round to keep the diff narrow + the payoff cleanly attributable |
| Awakened-systems deferral (`scheduleAwakenedWarm`, `realmFlipUnsub`) | Already optimal — deferred to rIC after mountApp finishes |
| `compileAsync` warm passes | Already optimal |

---

## Verification

- `npx tsc --noEmit` clean
- `npm run build` clean (~2.77 s; identical chunk sizes to before — no bundle-size regression)
- ReadLints clean on all 3 modified files

## Test in browser

1. Hard refresh, click through the splash + curse cutscene + title flow.
2. Click Begin on the title — note the time from "shattering cutscene fades out" to "tutorial dialog visible". Should feel near-instant on a hot boot.
3. Slow-throttle CPU (DevTools → Performance → 4× CPU slowdown), repeat. The pre-shattering safety wait should now max at ~2 s instead of 4.5 s.
4. Dismiss the tutorial. The gather page DOM should be present (rendered from the deferred `requestIdleCallback`). If the device is so slow that rIC hasn't fired by dismissal, you'll see one frame of empty page before it populates — acceptable trade-off.
5. Re-click Begin from the same session (skip to title via Esc → Return to title → Begin). Same boot path; preload is already cached from session.

## Follow-up (deferred from this round)

- **Tier B1** — `consumePreloadedDock` BEFORE the shattering cutscene with the canvas hidden. Saves another 10–30 ms but risks the historical "1–2 second flash of character + tutorial UI before the overlay covered them" bug. Worth a separate session with explicit visual QA.
- **Tier B3 (parallelize warmShaders in extended preload)** — already implicit because `warmShaders` calls don't await `compileAsync` (fire-and-forget). The original analysis overstated the win; serial issue is fine.
- **Tier C1 (conditional veil skip on hot boot)** — UX trade-off, deferred for separate decision.
- **Tier C4 (yield-primitive swap inside `CharacterScenePreview.create`)** — same pattern as A1, applied to the 6 staged-phase drains. Estimated ~50 ms title-time. Skipped this round to keep the file untouched.
