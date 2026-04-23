# Session 2026-04-22 — Cutscene removal + post-cutscene boot tightening + pre-bind store→preview

## Context

Companion to:
- `docs/SESSION_2026_04_21_PRELOAD_ROUND_5_IMPLEMENTATION.md` — round 5 (frame-spread sync blocks + scheduler.postTask priorities + concurrency-limited preload imports + View Transitions)
- `docs/SESSION_2026_04_21_PRELOAD_ROUND_4.md` — round 4 (Workbox SW + storage.persist + adaptive device profile)
- `docs/SESSION_2026_04_19_CUTSCENE_AND_BLOOD.md` — original cutscene smoothness pass
- `docs/CUTSCENE_PIPELINE.md` / `docs/CUTSCENE_BUILD_LOG.md` — production pipeline (still valid for future cutscenes)

The user reported the intro cutscenes were "too heavy and not working anymore." This session unrefereneces them from the boot graph (source files + .mp4 binaries left on disk for clean revert), then walks down the now-exposed post-click click → game critical path with a series of subtractive tightenings, ending with a pre-bind that moves the largest remaining click-time cost (`syncEquipment`'s LPCA mesh build) into title-screen idle time.

---

## Phase A — Cutscene unreference

User policy: **unreference only**. The two `.mp4` files (~30 MB total) and the `src/cutscenes/*.ts` modules stay on disk; the boot graph stops importing them and the deploy configs stop hinting / caching them. Re-enabling the cutscene path is a one-commit revert.

### Files modified

- **[src/main.ts](../src/main.ts)** — surgery:
  - Dropped `CutsceneModule` / `SplashModule` types, `cutsceneModulePromise` / `splashModulePromise` vars, `loadCutsceneModule` / `loadSplashModule` helpers.
  - Dropped the two `void import('./cutscenes/...')` prefetch lines from the module-top chunk-prefetch block.
  - Dropped `preloadVideoFile` helper (no remaining caller).
  - Dropped `schedulePreloadChunkPrefetch` helper (was only called from `bootIntroExperience`'s cutscene branch).
  - Dropped `isWarmCacheRevisit` localStorage gate (was reading the `idle-craft-intro-cutscene-seen-v1` flag set by `markIntroCutsceneSeen` after a successful full-cutscene boot). Replaced with an unconditional always-on early preload kick at module top — the title screen is static so the preload no longer competes with a video decoder for the main thread.
  - Collapsed `bootIntroExperience` from ~150 lines (splash await + curse cutscene + device-profile gate + 4 View Transition swaps) to a 5-line synchronous function: `scheduleSecondaries → hideInlineBootVeil → schedulePreloadAfterPaint → showStartFlow → dumpRound5Measures`.
  - Stripped from `enterGame`: cutscene module load, shattering cutscene playback block, the 2000 ms preload-precaution `Promise.race`, the `markIntroCutsceneSeen()` call, the conditional `mountForgingVeil`. Veil is now mounted unconditionally at the right point.
  - Dropped the unused `detectDeviceProfile` import (its only consumers were the cutscene gates).

- **[index.html](../index.html)** — removed the two `<link rel="preload" as="fetch" type="video/mp4">` and `<link rel="prefetch">` lines for `intro_the_curse.mp4` + `intro_the_shattering.mp4`. **~30 MB of forced video download per page load is gone.** Refreshed the boot-veil lifecycle comment to say "title flow" instead of "splash."

- **[vite.config.ts](../vite.config.ts)** — removed `'**/cutscenes/**'` from Workbox `globIgnores` and dropped the entire `idle-craft-cutscenes-v1` runtime-cache route + its `rangeRequests: true` / `cacheableResponse: { statuses: [0, 200, 206] }` config. Refreshed surrounding comments.

- **[netlify.toml](../netlify.toml)** — removed the `[[headers]] for = "/cutscenes/*"` block. Refreshed the surrounding comment to drop "cutscenes" from the immutable-content paragraph.

### Files left intact (per "unreference only")

- `src/cutscenes/introCutscene.ts` + `.css` + `introSplash.ts` + `.css` — present, no importer.
- `public/cutscenes/intro_the_curse.mp4` (~12 MB) + `intro_the_shattering.mp4` (~17 MB) — present, no preload hint, no SW route, no Netlify header. Vite still copies `public/` verbatim to `dist/` on next build (harmless dead bytes; can be pruned in a follow-up if storage matters).
- All `docs/CUTSCENE_*.md`, `LORE.md` cutscene references, the `SESSION_2026_04_19_CUTSCENE_AND_BLOOD.md` historical record — untouched. Cutscene production pipeline stays canonical for future content.

### New boot flow

Was:
```
Page load → inline boot veil → splash → curse cutscene → start flow → click
  → preload-precaution wait → shattering cutscene → mountApp → game
```

Now:
```
Page load → inline boot veil → start flow → click
  → forging veil → mountApp → game
```

No splash, no video, no autoplay-with-audio gesture screen. Music starts when the player commits to play (`audioModule.setMusicMainMenuMode(false)` in `enterGame`).

---

## Phase B — Walk down the now-exposed click → game critical path

With the cutscenes gone, the existing dock preload is no longer hidden behind a 30-50 s video. The player sees it filling on the title screen, then sees the click → game gap directly. Multiple Round 5 tunings were optimised for "preload runs during cutscene playback → must yield often so video decoder isn't starved" — those tradeoffs are pure wall-clock loss without a video to protect. Walking them back in priority order:

### B1 — Lifted the `withConcurrencyLimit(2)` cap on extended-preload imports

[src/engine/dockExtendedPreload.ts](../src/engine/dockExtendedPreload.ts) `runExtendedPreload`. Round 5 phase D wrapped the 7-way `Promise.all([7 dynamic imports])` in `withConcurrencyLimit([...], 2)` to prevent a parse-storm from blocking the title-screen first paint + the pre-cutscene fade. Both justifications are gone — there's no cutscene to protect from V8 parse spikes, and the title flow is already painted by the time these imports resolve. On a warm-cache visit (every revisit) all 7 chunks are in the HTTP cache, so unconstrained `Promise.all` parses them in parallel for free. The 2-cap was serializing parses 4-deep on warm cache for no benefit.

Net code change: `withConcurrencyLimit` removed from import (helper still exists in `mainThreadYield.ts` for any future caller); 7-way array re-shaped as a destructured `Promise.all([...])` so the per-import strong typing falls out naturally without the typed-tuple cast.

**Wall-clock saved (warm cache):** ~50–150 ms.

### B2 — Single continuous veil in `enterGame`

[src/main.ts](../src/main.ts) `enterGame`. The pre-removal flow had the cutscene's `onCleanupStart` callback mount the forging veil DURING the shattering cutscene's fade-out, so the visual transition was: progressVeil (preload wait) → cutscene → forging veil (mountApp parse). With no cutscene cover, the swap was reduced to: `progressVeil.remove()` → 16 ms of nothing → `mountForgingVeil()` (which started at progress 0.05 with a different label). Player perceived this as "another preload starting."

Refactored to ONE veil mounted up front. Lives through the whole `enterGame` sequence, just mutates its progress label as it walks: "Preparing your expedition…" → "Finalizing camp interface…" → mountApp's per-phase strings. No mount/unmount in between.

### B3 — Trimmed inter-phase yields in `CharacterScenePreview.create`

[src/visual/characterScenePreview.ts](../src/visual/characterScenePreview.ts) `create()`. Was 5× `await yieldToEventLoop()` + 1× `await yieldAnimationFrame()` between phases (`_phaseForest` → `_phaseAvatar` → `_phaseLighting` → `_phaseSpawnAndCamera` → `_phasePostProcessing` → `_phaseStartRenderLoop`). Justification per the inline comment (line 1258): *"This lets the preload run during cutscene playback without freezing the video / overlay UI."*

Kept exactly two yields with surviving rationale:
- One `yieldToEventLoop()` BEFORE `_phaseForest` — the heaviest single phase (~150-300 ms `attachForestBackdrop` block); a yield here gives the title-screen first paint a frame to settle before the spike.
- One `yieldAnimationFrame()` BEFORE `_phaseStartRenderLoop` — that phase calls `loop()` which schedules the first `rAF(frame)`; pairing the yield with a paint slot lets the postProcessing setup actually paint to a frame before the render loop kicks off.

Dropped the others. The phases between them (avatar rig ~5 ms, lighting ~10 ms, spawn/camera ~3 ms, postProcessing ~30 ms) are all sub-frame and produce no visible intermediate state.

**Wall-clock saved:** ~16–30 ms (one `yieldAnimationFrame` worth + scheduler-hop costs).

### B4 — Bumped `chunkedYielding*` budget from 8 ms → 16 ms

[src/util/mainThreadYield.ts](../src/util/mainThreadYield.ts) (defaults), [src/visual/forestEnvironment.ts](../src/visual/forestEnvironment.ts) (`CHUNK_BUDGET_MS` in `scatterWorldForestStrata`), [src/world/dockForestBatchedScene.ts](../src/world/dockForestBatchedScene.ts) (`SCATTER_CHUNK_BUDGET_MS` in the BatchedMesh scatter loop).

Round 5's 8 ms chunk budget was tuned to keep cutscene video decode happy (8 ms = half the 60 Hz frame budget, leaves room for video frame decode + paint). With cutscenes removed, 16 ms (one full paint frame) is the right target — halves the yield count and the `performance.now()` polling overhead inside the hot loop.

**Wall-clock saved:** ~30–80 ms cumulative across the preload (depends on tier — heavier scatter loops save more).

### B5 — Killed two `yieldAnimationFrame()` calls in `mountApp`

[src/ui/mountApp.ts](../src/ui/mountApp.ts) at lines ~4797 (was "paint slot before tutorial mount") and ~4850 (was "paint dock canvas before tutorial DOM"). Both 16 ms full-frame waits. Both were tuned for "give the canvas a paint slot after the cutscene fade-out." The cutscene is gone; the canvas is already painting under the forging veil from the moment `requestAnimationFrame(frame)` runs.

The first `yieldAnimationFrame()` is removed entirely. The second is replaced with `yieldToEventLoop()` (sub-ms) — we still want input + microtasks to drain before the synchronous tutorial DOM build, but no full paint frame is needed.

**Wall-clock saved on the click → game critical path:** ~15 ms + ~16 ms = **~31 ms**.

### B6 — Consolidated 4 micro-phase yields after `consumePreloadedDock`

[src/ui/mountApp.ts](../src/ui/mountApp.ts) at lines ~600-610. Was 4× `yieldToEventLoop()` between `applyCharacterPreset` / `syncEquipment` / `setPageContext` / `syncGatherMastery`, each labelled with its own `p(0.93..)` / `p(0.94)` / `p(0.945)` / `p(0.95)` progress emit.

Three of those four yields are pure scheduler-hop overhead — only `syncEquipment` is heavy enough (~10–100 ms) to merit a yield after it. Consolidated to a single `await yieldToEventLoop()` after the whole micro-phase block, with a single batched `p(0.95, 'Mounting survivor, weapons & gear…')` progress emit.

**Wall-clock saved:** ~3 ms (4 scheduler hops collapsed to 1).

---

## Phase C — Move `syncEquipment` cost off the click → game critical path

After Phase B, the single biggest remaining click → game cost is `syncEquipment` itself: ~10–100 ms. It disposes 4 hand-group meshes + rebuilds 1-3 LPCA weapon meshes (axe / sword / pick / shield). This can't be made faster on the critical path — the LPCA mesh construction is what it is. But it CAN be moved off the critical path entirely.

**Insight.** The equipment + character preset state lives in the `GameStore`, which is alive during the title flow. The offscreen dock preview is also alive during the title flow (it's been rendering offscreen since `_phaseStartRenderLoop` ran). The character picker in the title flow can change the player's equipment/preset before they click Begin. Wiring the store directly into the offscreen preview lets every change propagate immediately, so by click time the preview is already in sync.

### Architecture

Three cooperating pieces:

1. **Idempotency early-returns** in `applyCharacterPreset` and `syncEquipment` — the second-and-later calls with the same state become near-zero-cost.
2. **`getIdleCraftDockPreviewIfReady()`** — new export from `dockPreload.ts` that returns the live offscreen preview when state is `ready`, `null` otherwise (including post-consume since state flips back to `idle`).
3. **`bindGameStoreToDockPreview(store)`** — new helper in `dockPreload.ts` that subscribes to both preload-ready + store-changes; whenever both are available, calls `applyCharacterPreset` + `syncEquipment` against the offscreen preview.

Wired from `main.ts` right after `new GameStore()`:

```ts
void import('./engine/dockPreload').then((m) => m.bindGameStoreToDockPreview(store));
```

Lifecycle:
- Initial sync on call (covers warm cache where preload is already done by binding time).
- Subscription to preload progress (covers cold visits + `returnToTitle` re-preloads — when a fresh preview becomes ready, equipment + preset get applied immediately).
- Subscription to `store.subscribe` (covers character-picker changes in the title flow + in-game gear swaps).

All three triggers route through `getIdleCraftDockPreviewIfReady()`, so post-consume firings cleanly skip without explicit teardown.

### Files

- **[src/visual/characterScenePreview.ts](../src/visual/characterScenePreview.ts)**:
  - `applyCharacterPreset(id)` early-returns on `(this.presetApplied && this.activeCharacterPresetId === id)`. Saves ~5–30 ms.
  - `syncEquipment(eq)` early-returns on `(this.equipmentApplied && all-three-fields-match)`. Saves ~10–100 ms (the big one).
  - Two new private boolean fields — `presetApplied` and `equipmentApplied`, both default `false`. **CRITICAL** — see "Wizard regression + sentinel fix" below for the bug they prevent.

- **[src/engine/dockPreload.ts](../src/engine/dockPreload.ts)**:
  - New `getIdleCraftDockPreviewIfReady(): CharacterScenePreview | null`.
  - New `bindGameStoreToDockPreview(store: GameStore): void`.
  - `import type { GameStore } from '../core/gameStore';` added.

- **[src/main.ts](../src/main.ts)**:
  - One line after `new GameStore()`: `void import('./engine/dockPreload').then((m) => m.bindGameStoreToDockPreview(store));`. Fire-and-forget — binding is page-lifetime and self-skips when there's no preview.

### Wizard regression + sentinel fix

**The bug.** First idempotency landing used `if (this.activeCharacterPresetId === id) return;` and `if (all-three-fields-match) return;` without the `presetApplied` / `equipmentApplied` flags. Both broke the wizard:

- `activeCharacterPresetId` is initialised to `'vanguard'` on line 525 of `characterScenePreview.ts` as a placeholder field initialiser. **The constructor never actually calls `applyCharacterPreset`** — visibility toggles for `vanguardWizardRobeRoot.visible = true`, `vanguardWizardBeardRoot.visible = true`, `vanguardWizardHatRoot.visible = true`, `vanguardWizardStaffRoot.visible = true` only run inside `applyCharacterPreset`'s `build === 'vanguard_wizard'` switch (lines 3320-3345). Without the flag, a player whose stored preset matched the placeholder had the function skip its body on the very first call → wizard parts stayed at their `buildDockHeroLpca` default visibility → wrong character appeared.
- `equippedWeapon/Pick/Shield` default to `null`. A fresh save with all-null equipment matched the defaults → first call skipped its body → INCLUDING the trailing `updateVanguardWizardAttachmentVisibility()` that the wizard staff visibility depends on.

**The fix.** Two new private boolean sentinels — `presetApplied` and `equipmentApplied`, both default `false`. Early-return guards now require BOTH the flag to be true AND the state to match. The flag flips to `true` inside the function body. So:

- **First-ever call**: flag is false → guard skipped → full body runs → flag set true → state set.
- **Subsequent calls with same state**: flag is true AND state matches → early-return.
- **Subsequent calls with different state**: flag is true but state differs → guard skipped → full body runs.

This preserves the click → game speedup (warm-path `syncEquipment` still no-ops) while guaranteeing the constructor-state never short-circuits the first real apply.

---

## Net click → game shave

| Phase | Item | Wall-clock saved |
|---|---|---|
| B1 | Lift concurrency cap on 7-way import `Promise.all` | ~50–150 ms (warm cache) |
| B2 | Single continuous veil instead of two | visual flicker eliminated; ~16 ms scheduler latency saved |
| B3 | Trim inter-phase yields in `CharacterScenePreview.create` | ~16–30 ms |
| B4 | Bump chunkedYielding budget 8 → 16 ms | ~30–80 ms cumulative |
| B5 | Drop two `yieldAnimationFrame` waits in mountApp | ~31 ms |
| B6 | Consolidate 4 micro-phase yields → 1 | ~3 ms |
| C | Pre-bind store → preview moves `syncEquipment` off critical path | ~10–100 ms (the biggest) |
| **Total** | | **~150–400 ms** off click → game window |

Plus the visual flicker between the two veils is gone, the character picker now updates the preview immediately on change (better preview UX), and the title flow's "preload progress bar" continues to fill honestly during the hide-the-cutscene window which is now just the title flow itself.

---

## What's irreducible (and what would actually get to "instant")

Even after this pass, the click → game window has irreducible work:

1. **`consumePreloadedDock` canvas reparent** (~10–50 ms) — has to move the WebGL canvas DOM node to its new parent and re-fit dimensions.
2. **~50–150 ms of cumulative `store.subscribe(...)` + `addEventListener(...)` registrations** in mountApp's middle ~4000 lines.
3. **`mountTutorial` DOM build** (~5–10 ms for first-time players, ~0 ms for returning players who completed it).
4. **Veil double-rAF + CSS fade-out** (~32 ms wait + 280 ms animation).

The only path to genuinely-instant click → game is to do the mountApp work during the title screen as part of the preload, so all that's left at click time is reparent + tutorial mount + fade. That would require restructuring `mountApp` to split into two phases:

- **`prepareApp`** — runs during preload: builds the entire app shell DOM in a hidden container, runs all the `store.subscribe` / `addEventListener` setup.
- **`revealApp`** — runs at click: reparents the prebuilt shell into `appRoot`, mounts tutorial, fades veil. Should be ~50 ms total.

200-400 line change to `mountApp.ts` to split state ownership cleanly between the two phases. Not done in this session; flagged as the next target if "instant" is still the goal.

---

## Verification

`npx tsc --noEmit` exit 0 after every phase. No lint errors. No save-state migration (`STATE_VERSION` unchanged).

Manual: refresh, watch the title-screen progress bar fill noticeably faster (B1 + B4 + B3 wins land here). Click Begin → forging veil → game appears as one continuous fade instead of veil-flicker-veil. Vanguard wizard is visible at first paint of the dock canvas (sentinel-fix verified post-regression).

---

## Lessons learned

- **Idempotency early-returns must gate on a "has been applied at least once" flag** when the constructor sets default field values without actually running the function body. Otherwise the field-default state matches the request-state and the body is skipped on the very first call. Pattern: explicit `xxxApplied: boolean` field, default `false`, flipped to `true` inside the function body, AND-ed with the state-equality check in the early-return.
- **Round-N optimisations are tuned for the assumptions of round-N's environment.** When a downstream change removes those assumptions (cutscene removal here removed every "don't starve the video decoder" justification), the optimisations can become pure cost. Walk back the now-unjustified tradeoffs in the same session.
- **The cleanest way to move work off a critical path is to start it earlier, not to make it faster.** `syncEquipment` is fundamentally a 10-100 ms LPCA mesh build. Optimizing the build itself is bounded; running it during title-screen idle time is unbounded (the player gives you several seconds of free wall-clock to fill).
- **Subscribe-and-self-skip is a cleaner lifecycle than subscribe-and-explicit-teardown.** Routing `bindGameStoreToDockPreview`'s callbacks through `getIdleCraftDockPreviewIfReady()` lets the dockPreload state machine be the single source of truth for "is there a preview to bind to" — no teardown plumbing, no stale-ref bugs across `returnToTitle` cycles.

---

## Phase F — Tier hierarchy reshape + shadow revert + apple branch removal (2026-04-22 follow-up)

After Phase E landed, the player reported three follow-up issues:

1. *"Our shadows look like voxel blocks ... like the shadow reflections are minecraft version"*
2. *"We can remove the branches you were trying to fix on apple trees, we don't need them"*
3. *"Default needs to be perf and set better so scene is enhanced but we don't lose fps. Balanced drops us to 30-40 and that is too low but looks amazing — can we get balanced mode quality but high fps?"*

### F1 — Voxel-block shadow regression diagnosed

**Root cause: stacked Phase D + Phase E shadow changes overcommitted the shadow map.**

Phase D loosened `shadow.bias -0.00012 → -0.0005`, bumped `shadow.radius 2.8 → 5.5`, and bumped `shadow.normalBias 0.02 → 0.045` in pursuit of "softer shadows." Phase E6.6 then re-enabled `mergedForestFar.castShadow = graphics.tier === 'high'`. The combination produced visible PCF banding at shadow boundaries:

- Shadow map: 2048 × 2048 covering ±14 world units = texel size 14 mm world.
- PCF kernel radius: 5.5 texels = 77 mm world filter spread.
- Far-tree group added MORE casters competing for the same shadow texel budget.
- Edge-of-frustum trees got the worst texel density; the soft PCF kernel wrapped across visibly-quantized texel boundaries → "voxel blocks" reading.

**Fix.** Reverted shadow values to the round-3 settings that had been working since 2026-04-19 lighting overhaul without complaint:
- `shadow.bias`: `-0.0005 → -0.00012` (original)
- `shadow.radius`: `5.5 → 2.8` (original)
- `shadow.normalBias`: `0.045 → 0.02` (original)
- `mergedForestFar.castShadow`: reverted to unconditional `false` — far-tree shadows can return in a future round with either a dedicated cascade or a 4096+ shadow map so texel density doesn't drop at distance

Kept Phase D's `useBasicShadowMap: false` on low tier — `PCFSoftShadowMap` is universally better than `BasicShadowMap` and that change wasn't part of the regression.

### F2 — Apple tree branches removed (player choice)

Phase E1 had fixed the broken apple branches by rotating them horizontal (rotation order YZX + base π/2 + position offset along trunk-edge direction). Player follow-up: *"we don't need them"* — the apple tree silhouette reads cleanly enough without visible branches (the crown sphere + accents + apples carry the read on their own). Branches removed entirely. Fewer draw calls per apple tree, no bug surface area. The `barkLight` material is also gone now that nothing uses it.

### F3 — Tier hierarchy reshape: enhance `'perf'`, drop `'balanced'` cost (the big one)

**The problem.** Phase E6 made `'balanced'` jump from DPR 1.0 + 3.11 MP to DPR 1.5 + 4.10 MP — that's **2.25× fragment work × 1.32× pixel budget = ~3× more fragment cost** vs `'perf'`. On the player's machine that was 60+ FPS → 30-40 FPS — too low. They explicitly asked: *"can we get balanced mode quality but high fps?"*

**Insight.** The single biggest visual feature `'balanced'` adds vs `'perf'` is **bloom** (magic projectiles + mushroom caps + lanterns + emissive props all glow). The DPR/buffer bumps were a separate quality lever that mostly fights aliasing on high-DPI displays — but the player's "looks amazing" reading was driven by bloom, not by buffer size. So: **decouple bloom from buffer size**. Add cheap bloom to `'perf'`; keep `'perf'`'s buffer size on `'balanced'` (no DPR/budget bump); make `'balanced'` add reduced-resolution SSAO instead. Net: every player gets bloom on the FPS-safe default; opt-up tier adds SSAO without paying the buffer cost; `'full'` remains the uncapped power-user tier.

**The new tier hierarchy:**

| Tier | DPR cap | Pixel budget | Bloom | SSAO | Estimated fragment cost vs `'perf'` (old) |
|---|---|---|---|---|---|
| `'perf'` (default) | 1.0 | 2.07 MP | **Cheap (str 0.18 / rad 0.18 / thr 0.94)** | OFF | ~1.15× (just the bloom add) |
| `'balanced'` | 1.0 | 2.07 MP | Full (project default str 0.32 / rad 0.35 / thr 0.9) | **Cheap (resScale 0.35 / kernelSize 8)** | ~1.4× (full bloom + cheap SSAO) |
| `'full'` | uncapped | uncapped | Full | Full (resScale 1.0 — project default) | varies by display res — uncapped |

The visual gap between `'perf'` and `'balanced'` is now "soft glow vs strong glow + ambient occlusion" instead of "blurry buffer + no glow vs sharp buffer + glow." Players get the most visually impactful upgrade (bloom) on the default tier.

**Cheap-bloom config rationale (`'perf'`):**
- `bloomStrength: 0.18` (vs project default 0.32) — subtler glow, ~50% of the additive contribution
- `bloomRadius: 0.18` (vs project default 0.35) — tighter spread, fewer blur taps
- `bloomThreshold: 0.94` (vs project default 0.90) — only the BRIGHTEST emissive pixels bloom; most fragments fail the threshold and skip the downscale pyramid → cost bounded
- Cost: ~3-5 ms per frame on integrated GPU, ~1-2 ms on dedicated. About half the cost of full-bloom config.

**Cheap-SSAO config rationale (`'balanced'`):**
- `ssaoResolutionScale: 0.35` (vs project's `1.0`) — SSAO renders at ~12% of buffer pixel count (since it's 0.35² of buffer area)
- `ssaoKernelSize: 8` (vs project default 12) — fewer kernel taps per AO pixel
- Cost: ~3-5 ms per frame on integrated GPU at the 2.07 MP buffer (vs ~12-18 ms at full-res 1.0 SSAO)
- Visual difference vs full-res SSAO: barely perceptible — the SSAO buffer is blurred + composited on top of the shaded scene anyway

### F4 — Default tier reverted to unconditional `'perf'`

[src/engine/rendererDisplaySettings.ts](../src/engine/rendererDisplaySettings.ts) — Phase E6.1's device-aware default (`'balanced'` on high-tier devices) is reverted. Default is now unconditional `'perf'` again, but `'perf'` now actually looks good thanks to the cheap bloom (F3 above). Removed the `detectDeviceProfile` import that was added in E6.1 — no longer needed.

### Files (Phase F)

- [src/visual/goeStyleHarvestLPCA.ts](../src/visual/goeStyleHarvestLPCA.ts) — apple branch loop removed; `barkLight` material removed; doc comment updated.
- [src/visual/characterScenePreview.ts](../src/visual/characterScenePreview.ts) — shadow tuning reverted to round-3 (radius 2.8 / bias -0.00012 / normalBias 0.02); tier hierarchy reshape in `computeEffectivePixelRatio` (DPR cap collapsed back to 1.0 on `'balanced'`; pixel budget collapsed back to 2.07 MP on `'balanced'`); `applyDockPostProcessing` gives `'perf'` cheap bloom + `'balanced'` cheap SSAO.
- [src/visual/forestEnvironment.ts](../src/visual/forestEnvironment.ts) — `mergedForestFar.castShadow` reverted to unconditional `false`; comment updated.
- [src/engine/rendererDisplaySettings.ts](../src/engine/rendererDisplaySettings.ts) — default tier reverted to unconditional `'perf'`; `detectDeviceProfile` import removed.

### Verification

`npx tsc --noEmit` exit 0. No lint errors. No save-state migration. Manual: refresh — shadows should look smooth (no Minecraft blocks); bloom on magic projectiles + mushroom caps + lanterns even on default `'perf'`; FPS at the same level as before Phase E (because DPR/buffer caps are back where they were); apple trees no longer have any branches (just trunk + crown + apples); opt up to `'balanced'` from Esc menu for SSAO-grounded shadows + stronger bloom at near-`'perf'` FPS cost; opt up to `'full'` for no caps at all.

---

## Phase E — Visual quality system review + apple branch fix + sharpness recovery (2026-04-22)

After Phase D landed (terrain palette + shadow softening) the player reported three more visual issues which prompted a deep system-level audit:

1. *"Apple trees have pieces that attach to top of trunk right under canopy ... trunk-color sticks placed vertically instead of horizontally"*
2. *"Trees from a distance have a blur around them, everything doesn't seem as sharp and clear as before"*
3. *"We need to analyze timing of all draws / calls — what is being called: store, inventory, attack from enemies, awaken mode dynamics — review and lets see what we find"*

### E1 — Apple tree branches were vertical sticks (long-standing bug)

**Root cause.** [src/visual/goeStyleHarvestLPCA.ts:275-285](../src/visual/goeStyleHarvestLPCA.ts#L275) — the apple tree branch loop created `THREE.CylinderGeometry` (defaults to Y-axis vertical) but only set `rotation.z = (rand() - 0.5) * 0.9` (±26° tilt). **No base π/2 rotation to lay the cylinder horizontal**. Branches stood up vertically out of the trunk at mid-trunk height, looking exactly like the player's description.

This was a bug from `4f22e76 Initial commit` — git log shows the file hadn't been touched since. Not from any recent optimization. The player only noticed it after Phase D's terrain + shadow improvements made the rest of the scene look better, exposing the broken branches by contrast.

**Fix.** Rewrote with rotation order `YZX`:
- Y rotation = `angle` (around-trunk direction)
- Z rotation = `Math.PI / 2 + (rand() - 0.5) * 0.7` (base 90° to lay horizontal + ±20° jitter for natural droop / upturn)
- Position offset = `(trunkR + len * 0.5)` along the angle direction so the branch starts AT the bark and extends OUTWARD instead of being centered on the trunk axis

### E2 — Sharpness regression diagnosis (the big one)

**Root cause: `awakenedQuality` defaulted to `'perf'` for every player.**

[src/engine/rendererDisplaySettings.ts:193](../src/engine/rendererDisplaySettings.ts#L193) — `'perf'` was the unconditional fallback. What `'perf'` does:
- DPR cap = 1.0 (vs typical 2.0 on Retina / 4K)
- Pixel budget = 1920 × 1080 = 2.07 MP
- Bloom OFF
- SSAO OFF

On a 1440p / 4K / Retina display, the buffer was rendered at 1920×1080 max, then **browser bilinear-upscaled to fill the canvas** = visible blur on everything. Distant fine features (leaves, branches) suffered most because they occupy the smallest screen-pixel footprint.

This landed in Round 4 (2026-04-21) when the tier system was introduced. Wasn't a recent regression — but the player only flagged it now because the recent terrain + shadow improvements made the rest of the scene look noticeably better, exposing the buffer-upscale blur by contrast.

**Why "blur AROUND TREES from distance" specifically.** Compounded by:
- Fog `near = R * 0.85` (37.4 units for R=44) — trees at the far edge of the dock disk start fogging.
- `mergedForestFar.castShadow = false` unconditionally — distant trees lose their contact-shadow grounding cue, look "floaty."

### E3 — Per-frame system audit (no regressions identified)

Inventoried every per-frame system in `mountApp.frame(now)`:

- `store.tick(dt)` — zero-allocation hot path per round 3
- `freeRoamHandle.update(dt)` — WASD + jump physics (early-return when not awakened)
- `harvestHandle.update(dt)` — fall/respawn animations (empty-set check is ~µs)
- `dockForestHandle.update(dt)` — same shape, BatchedMesh respawn timers
- `craftStationHandle.tick(now)` — campfire flame (early-return on empty Map)
- `mobsHandle.update(dt, playerPos)` — mob AI; **already has `farPassiveTickPhase` distance-bucketing** (passive distant mobs only tick every 3rd frame; aggro'd mobs always tick)
- `lockOnCtl.update(dt)` — camera lerps
- `cameraLockCtl.update()` — mouse-look (movementX/Y batch consumer)
- `projectilesHandle.update(dt)` — **already has `POOL_SIZE = 16` cap with overflow-recycle**
- `bouncyMushroomsHandle.update(dt)` — per-mushroom early-out for `squash === 0 && squashVel === 0`
- `defensiveWardHandle.update(...)` — early-return when not active
- `damageFloatersHandle.update(dt, camera)` — pool walk with active-flag skip
- `collisionWorld.movePosition('player', ...)` — re-buckets only every CELL_SIZE = 4 m of travel
- `magicalReticleHandle.setVisible / setMode` — no-op on unchanged values
- `scenePreview.tick(dt)` — `tickCameraSmoothing` (4 lerps, ~µs) + `applyCameraFraming` (~µs) + `dockEnvironment.update` (1-3 ms) + sceneTickers + `postProcessing.render()` or `renderer.render()` (the dominant cost)

**Verdict: no per-frame regressions.** Every system has early-returns when nothing's happening. The frame loop is well-architected. Future optimization candidates (mob spatial culling, projectile cap) are already shipped.

### E4 — Movement smoothness systems (healthy, no regressions)

- [src/visual/characterScenePreview.ts:1063-1074](../src/visual/characterScenePreview.ts#L1063) `tickCameraSmoothing(dt)` — exponential smoothing of orbit yaw / pitch / pan / zoom toward target values. Rates: `ORBIT=22 / PAN=25 / ZOOM=16`. Standard "snappy but smooth" tuning.
- [src/world/cameraLockController.ts](../src/world/cameraLockController.ts) — pointer-locked mouse-look. Yaw `0.0028`, pitch `0.0023`, pitch clamped to `[-1.12, 1.55]`. Frame-rate-independent input integration.
- [src/world/freeRoamControls.ts](../src/world/freeRoamControls.ts) — WASD + jump physics with mushroom-bounce hooks.

All look clean. No identified smoothness regressions from any of the perf work.

### E5 — Performance instrumentation (already shipped, available for future diagnosis)

1. **`?perf=audit` URL flag** — installs `long-animation-frame` PerformanceObserver + dumps round-5 named-block measures at boot completion via `console.table`. ([src/util/longAnimationFramesAudit.ts](../src/util/longAnimationFramesAudit.ts))
2. **`localStorage.setItem('idleCraft.perfDockFrame', '1')` then reload** — enables per-frame `envUpdate` + `postStackRender` / `directRender` timing logs. ([src/debug/idleCraftDockFrameProbe.ts](../src/debug/idleCraftDockFrameProbe.ts))
3. **FPS HUD** — `startIdleCraftFpsMonitor()` (auto-shows the corner HUD if previously enabled). System menu has the toggle.

### E6 — Sharpness fixes shipped

**TIER 1 — Fix the sharpness regression (4 changes):**

- **E6.1 — Device-aware default tier.** [src/engine/rendererDisplaySettings.ts](../src/engine/rendererDisplaySettings.ts) — was unconditional `'perf'`, now routes through `detectDeviceProfile().graphicsTier`. High-tier devices (≥4 cores, ≥4 GB RAM, no Save-Data, not 2G/3G, not mobile UA) → `'balanced'`; low-tier → `'perf'`. Power users keep `awakenedFullQuality = '1'` legacy localStorage opt-in to `'full'`. Also: Esc-menu picker (`user.awakenedQuality`) and project config (`graphics.awakenedQuality`) both win over the auto-default.
- **E6.2 — Loosen DPR cap on `'balanced'`.** [src/visual/characterScenePreview.ts:3135](../src/visual/characterScenePreview.ts#L3135) — was `if (tier !== 'full') tierCap = 1.0;` (both `'perf'` AND `'balanced'` got hard-capped). Now `'perf'` keeps `tierCap = 1.0`, `'balanced'` allows up to `1.5`, `'full'` no cap. A 1080p Retina now renders near-native on `'balanced'`.
- **E6.3 — Bump `'balanced'` pixel budget.** Was `1920 * 1080 * 1.5 = 3.11 MP`, now `2560 * 1600 = 4.10 MP`. Covers 1440p displays at native (no downscale-then-upscale blur).
- **E6.4 — Apple branch orientation fix.** Already shipped via E1 above — branches now extend horizontally outward from the trunk.

**TIER 2 — Fix "blur around trees from distance" specifically (2 changes):**

- **E6.5 — Push fog near distance further out.** [src/visual/forestEnvironment.ts:643](../src/visual/forestEnvironment.ts#L643) and [src/world/idleCraftDockEnvironment.ts:191](../src/world/idleCraftDockEnvironment.ts#L191) — fog near pushed `R * 0.85` → `R * 1.4`. For R=44 that's 37.4 → 61.6 units. Every dock tree now stays crisp; only `treeWorldFar` strata + horizon pick up fog. Atmospheric haze preserved at the horizon, sharp foreground.
- **E6.6 — Re-enable far-tree shadows on high tier.** [src/visual/forestEnvironment.ts:920](../src/visual/forestEnvironment.ts#L920) — was unconditional `mergedForestFar.castShadow = false`. Now `graphics.tier === 'high'`. Distant trees on high-tier devices get back their contact-shadow grounding (no more "floaty trees"); low-tier keeps the FPS protection.

**TIER 3 — Investigation, no changes needed.** Mob update already distance-bucketed via `farPassiveTickPhase` (3-frame stride for distant passive mobs); projectile pool already capped at 16 with overflow-recycle. Both systems already optimized; no work needed.

### Files

- [src/visual/goeStyleHarvestLPCA.ts](../src/visual/goeStyleHarvestLPCA.ts) — apple branch orientation fix (rotation order YZX + base π/2 + position offset).
- [src/engine/rendererDisplaySettings.ts](../src/engine/rendererDisplaySettings.ts) — device-aware default tier; `detectDeviceProfile` import added; comment refresh on the fallback in `awakenedTierFromConfigValue`.
- [src/visual/characterScenePreview.ts](../src/visual/characterScenePreview.ts) — DPR cap loosened on `'balanced'` (1.0 → 1.5); pixel budget bumped 3.11 MP → 4.10 MP.
- [src/visual/forestEnvironment.ts](../src/visual/forestEnvironment.ts) — fog near pushed 0.85 → 1.4 in initial-fog-set; far-tree shadows conditional on graphics tier.
- [src/world/idleCraftDockEnvironment.ts](../src/world/idleCraftDockEnvironment.ts) — fog near pushed 0.85 → 1.4 in dayFogNear.

### Verification

`npx tsc --noEmit` exit 0. No lint errors. No save-state migration. Manual: refresh on a 1440p+ display. Distant trees should look crisp, contact shadows visible under far trees, bloom restored on emissive props (mushroom caps, magic, lanterns), apple tree branches now extend horizontally outward like real branches.

---

## Post-removal regression audit (2026-04-22 follow-up)

User asked: *"before upon refresh game is supposed to preload faster and skip cutscenes — are any of those features bottlenecking?"* End-to-end audit confirms **zero functional regressions**. Both behaviors are preserved or improved:

### Skip-cutscenes-on-refresh

- **Old behavior**: `shouldPlayIntroCutscene()` read `localStorage['idle-craft-intro-cutscene-seen-v1']` (set by `markIntroCutsceneSeen()` after a successful full-cutscene boot). On refresh, the boot path bypassed `playIntroCutscene` for both curse + shattering and went straight to title flow.
- **New behavior**: cutscenes are skipped for **everyone** (not just refreshing visitors) because `bootIntroExperience` no longer references the cutscene module at all. The localStorage flag still exists from prior boot completions but is no longer consulted by any boot path.
- **Verdict**: not bottlenecking. The skip happens unconditionally and earlier than the old flag-gated path could ever achieve.

### Preload-faster-on-refresh

- **Old behavior**: `isWarmCacheRevisit()` (also reading the cutscene-seen flag) gated the module-top early preload kick. On refresh the kick fired at module load; on cold first visit the kick was deferred until `schedulePreloadAfterPaint` ran post-cutscene-fade. Refresh-only early-kick existed because cold visits had a 50 s curse cutscene window that hid the preload anyway.
- **New behavior**: the module-top kick is **always-on, every visit**. Cold-cache and warm-cache visits both start preload at the earliest possible microtask after the dockPreload chunk parses. Plus Phase B + C tightening make the preload itself ~150–400 ms faster end-to-end.
- **Verdict**: not bottlenecking. Refresh visits get the same early-kick they always did, plus the new Phase B + C wins.

### Three preload-kick paths, all idempotent

For belt-and-braces robustness, the preload is kicked from three independent points; all three return the same in-flight promise via `startIdleCraftDockPreload`'s built-in state machine:

1. **Module top** (always-on, post-cutscene-removal): `void import('./engine/dockPreload').then((m) => m.startIdleCraftDockPreload())`. Fires as soon as the dockPreload chunk parses. Earliest possible.
2. **`bootIntroExperience` → `schedulePreloadAfterPaint`**: fires one rAF + one `scheduler.postTask({priority:'user-visible'})` slot after sync work completes. Defensive — no-op vs the in-flight promise from #1.
3. **`mountStartFlow` → `commitToPlay` → `schedulePreloadOnCommit`**: fires on first user interaction (mousemove, pointerdown, keydown, touchstart) on the title flow. Final defensive layer; no-op vs #1.

`returnToTitle` triggers a fresh preload by calling `disposeUnusedIdleCraftDockPreload()` (state → idle) then `mountStartFlow` (re-arms #3). The `bindGameStoreToDockPreview` subscription is page-lifetime and its callbacks naturally pick up the new preview through `getIdleCraftDockPreviewIfReady()`.

### `bindGameStoreToDockPreview` lifecycle verified across `returnToTitle`

- After `disposeUnusedIdleCraftDockPreload()`, `state.status === 'idle'` → `getIdleCraftDockPreviewIfReady()` returns null → callbacks no-op.
- After fresh preload starts via #2 or #3, `state.status === 'pending'` → still null → callbacks no-op.
- After fresh preload completes, `state.status === 'ready'` → `subscribeIdleCraftDockPreloadProgress`'s "ready" notification fires → bind helper applies preset + equipment to the new preview reference.
- No stale-ref leak; no explicit teardown needed.

### Real bottleneck found: stale `dist/` artifacts

Not a runtime regression but worth flagging for deploy hygiene:

- **`dist/cutscenes/intro_the_curse.mp4`** (12.4 MB) + **`intro_the_shattering.mp4`** (18.3 MB) — Vite copies `public/cutscenes/` verbatim to `dist/cutscenes/` on every build. Total ~31 MB of dead bytes ship to Netlify each deploy. **No code references them** (no `<link rel="preload">`, no SW route, no `<video>` tag, no `fetch()` call) so they never download to a user's browser, but they DO consume Netlify deploy bandwidth + storage.
- **`dist/assets/introCutscene-*.{js,css}`** (~3.4 KB) + **`introSplash-*.{js,css}`** (~1.9 KB) — stale chunks from the build BEFORE today's source changes. After today's "no importer" state, the next `npm run build` will NOT emit these chunks (tree-shaking drops them). Vite's `cleanupOutdatedCaches: true` handles SW cache, but the file-system files in `dist/assets/` need a manual `rm -rf dist && npm run build` to clean up.

**To fully realize the deploy-size benefit**: either (a) move the `.mp4` files out of `public/cutscenes/` to e.g. `_archived_cutscenes/` (outside Vite's public copy path), or (b) add a Vite plugin / build hook that excludes `cutscenes/**` from the public copy, or (c) just `rm public/cutscenes/*.mp4` and accept losing the "one-commit revert" property (the .mp4 files would need to be regenerated via `docs/CUTSCENE_PIPELINE.md` if re-enabling). **Decision deferred to user**; the runtime is unaffected by today's stale artifacts.

---

## Phase D — Visual fixes from player report (2026-04-22)

User reported: *"shadows look horrible"* + *"our terrain didn't come out like it look in stick man project ... I would [like] the terrain to look stick man more, of the other colors aside from green, you used too much green, the stickman has a good combination of colors in the right ratio."* Two distinct visual bugs surfaced; both were latent since the round-3 trippy-palette port:

### D1 — Terrain palette: `slope thresholds tuned for stick man's heightScale never trigger here`

**Root cause.** `bakeTrippyGroundVertexColors` in [src/visual/forestEnvironment.ts](../src/visual/forestEnvironment.ts) was ported verbatim from `C:\stick man`'s `TerrainBuilder.GROUND_COLORS_TRIPPY` slope picker. Stick man uses `terrain.heightScale = 5`; we use `terrain.heightScale = 0.88` ([project.json](../project.json#L53)). `computeSlopeAt` returns the gradient magnitude `sqrt((dh/dx)² + (dh/dz)²)`, which scales **linearly** with `heightScale` — so a slope value of `0.7` on stick man's terrain corresponds to `0.7 × (0.88/5) ≈ 0.123` on ours.

The original thresholds (`> 0.7`, `> 0.4`, `> 0.28`, `> 0.15`) almost never triggered on our heightfield (max realistic slope ~0.05). Result: 99 % of vertices fell into the `grass` band → mono-cyan reading as a uniform green field. The dirt (magenta) and rock (amber) bands were essentially dead code. The `// Idle craft's awakened terrain has gentler heights ... most of the map ends up in the grass band` comment in the function flagged the issue as a known limitation but never recalibrated the math.

**Fix (three parts).**

1. **Slope-threshold scaling.** Multiply each threshold by `heightScale / 5` so stick man's tuned values translate to the right proportion of our gradient range. New thresholds at `heightScale = 0.88`: rock-heavy `0.123`, rock-light `0.070`, dirt-heavy `0.049`, dirt-light `0.026`. Cliff faces around the map skirt + creek-carved channel banks now actually pick up amber/orange and dirt/violet variants.
2. **Palette expansion.** Original was 6 colors in 3 hue families (cyan grass, magenta dirt, amber rock). New `TRIPPY_GROUND_COLORS` has 10 colors in 4 families: cyan-mint (3 variants), violet-magenta (4 variants), amber-orange (3 variants). The expanded palette gives the noise-driven flat-zone pick more variety to draw from.
3. **Deterministic XZ noise variation.** New `colorNoise2D(x, z)` helper (cheap `sin`-based hash). Two octaves: low-frequency `nLow` at `~0.18 cycles/unit` picks the major hue family; high-frequency `nHigh` at `~0.91 cycles/unit` provides per-vertex speckle so adjacent vertices break off the dominant color. Result: flat zones show "field of cyan with splashes of mint, teal, and occasional violet" rather than uniform cyan. Achieves the "good combination of colors in the right ratio" the user asked for.

Plus a height-band primary in flat zones so low areas (creek beds + map skirts) read saturated cyan, mid areas read the cyan/teal/lavender mix, and high plateaus get the cool pastel mix (mint + lavender + teal). Vertical visual interest.

### D2 — Shadow tuning: `peter-panning + hard edges + low-tier blocky shadows`

**Root cause.** [src/visual/characterScenePreview.ts](../src/visual/characterScenePreview.ts#L1985) had:
- `shadow.bias = -0.00012` — extremely tight; classic "peter-panning" symptom (shadows visibly detached from their casters, look floating).
- `shadow.radius = 2.8` — moderate but produced visible step-aliasing at shadow boundaries.
- `shadow.normalBias = 0.02` — on the low side for outdoor scenes with detailed LPCA geometry.

Plus [src/engine/graphicsTier.ts](../src/engine/graphicsTier.ts#L261) set `useBasicShadowMap: true` for low tier, which produces visibly blocky pixelated shadow edges (no filtering — each shadow texel is binary on/off).

**Fix.**

- `shadow.bias`: `-0.00012` → `-0.0005` (loosens enough to eliminate peter-panning; the normalBias bump below covers the acne case).
- `shadow.radius`: `2.8` → `5.5` (soft penumbra reads as natural ambient occlusion + key shadow blend).
- `shadow.normalBias`: `0.02` → `0.045` (nudges the shadow comparison along the surface normal so polygons facing the sun at a shallow angle don't self-shadow).
- Low tier `useBasicShadowMap`: `true` → `false` (use `PCFSoftShadowMap` everywhere — the cost difference is a 4-tap GPU filter, negligible on every GPU made since 2010; even at 1024 the soft filter masks the lower texel density well enough that the result reads as "smooth shadow" rather than "stair-stepped pixel art").

The values are still conservative (sharper than UE5's default `radius = 16`). Tuning hooks documented inline so a follow-up that pushes radius to 7-8 or tightens bias to -0.0003 is a one-number change.

### Files (modified for Phase D)

- [src/visual/forestEnvironment.ts](../src/visual/forestEnvironment.ts) — palette expanded 6 → 10 colors; new `colorNoise2D` helper; `bakeTrippyGroundVertexColors` rewritten with slope-threshold scaling + two-octave noise + height-band primary.
- [src/visual/characterScenePreview.ts](../src/visual/characterScenePreview.ts) — key-light shadow tuning (bias / radius / normalBias).
- [src/engine/graphicsTier.ts](../src/engine/graphicsTier.ts) — low tier `useBasicShadowMap: false`.

### Verification

`npx tsc --noEmit` exit 0. No lint errors. No save-state migration. Manual: refresh, observe terrain shows cyan + teal + mint + occasional violet/magenta speckle (no longer uniform green); cliff faces near map skirts show amber/orange. Shadows on the dock characters + props read soft and contact-anchored (no peter-panning, no jaggy edges).

---

## Round-N+1 candidates (in priority order)

1. **`prepareApp` / `revealApp` split in mountApp** — only known path to genuinely-instant click → game. Estimated 200-400 line refactor; saves ~50–150 ms more.
2. **Drop the `forging veil` entirely if mountApp's post-consume work shrinks below ~50 ms** — at that point the dock canvas paints fast enough that the veil's fade-in adds more perceived latency than it hides.
3. **Prune the unreferenced `.mp4` files from `public/cutscenes/`** to eliminate ~31 MB of dead bytes from every deploy. Cutscenes pipeline (`docs/CUTSCENE_PIPELINE.md`) stays canonical; the binaries can be regenerated from the production pipeline if a future session re-enables the boot integration. Or move them to `_archived_cutscenes/` to keep the one-commit revert property without the deploy cost.
4. **Re-evaluate the always-on early preload kick at module top** if startup memory matters more than warm-cache latency — a flag-gated kick (similar to the old `isWarmCacheRevisit`) only loses ~200-500 ms vs the always-on path but skips the WebGL context creation cost on cold visits where the player might not click Play immediately.
5. **Refresh `mountStartFlow.ts`'s "Why preload on first interaction" doc-comment** — it was written when the only preload kick was inside `mountStartFlow`'s `commitToPlay`. With today's always-on module-top kick, the `commitToPlay` path is the third defensive layer, not the primary path. Source-comment-only update; not affecting any runtime behavior.
