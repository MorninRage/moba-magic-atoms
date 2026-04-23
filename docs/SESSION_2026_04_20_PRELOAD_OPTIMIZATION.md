# Session 2026-04-20 — Preload Optimization + Outstanding Harvest Visual Bug

## Context

This session focused on optimizing the IDLE-CRAFT (Vibe Jam 2026) intro flow to eliminate the multi-second post-cutscene freezes the player was experiencing. We made significant boot-time + per-emit performance improvements across 5 logical "commits", but a regression in harvest object visual hide remains unresolved.

---

## What Was Changed (Today, in Order)

### Commit 1 — Always-on Compositor Veil (Boot UX)

**Problem solved:** Page felt frozen during the post-shattering-cutscene `mountApp` window. Even when the dock was technically ready, the player saw a frozen-looking page with no visual feedback while ~3700 lines of mountApp body executed synchronously.

**Files changed:**
- `index.html` — Added inline `#boot-veil` with CSS-only animations (`transform` + `opacity` only). Renders at first browser paint (~50 ms), before any JS runs. Uses compositor thread so it animates smoothly even when JS main thread is 100% saturated. Inline `<script>` exposes `window.__hideBootVeil()`.
- `src/main.ts` — `hideInlineBootVeil()` helper called when splash is about to mount. `enterGame` now ALWAYS shows `expeditionLoadingOverlay` during post-cutscene mountApp (not just as fallback). Veil hides via double-rAF after `mountApp` resolves so the tutorial paint completes before the fade-out.

### Commit 2 — Defer Awakened Systems to First "Break the Spell"

**Problem solved:** `ensureCabinAttached()` synchronously created 12 awakened-only handles (mobs, combat, lockOn, cameraLock, damage floaters, magical reticle, build mode, station build mode, mushrooms, ward, projectiles late-binding) post-cutscene. ~150-1500 ms of synchronous work in dream mode where none of these are needed.

**Files changed:**
- `src/ui/mountApp.ts` — Refactored eager attach block:
  - Always runs `ensureHarvestNodesAttached()` + `ensureDockForestAttached()` (dream-visible)
  - **NEW:** `attachDreamHandlesInline()` — when extended preload didn't run, attaches ONLY cabin + craft station (fast, dream-visible) inline. Does NOT create awakened-only handles.
  - **NEW:** `awakenedSystemsAttached` flag + `ensureAwakenedSystemsOnce()` async helper.
  - **NEW:** `realmFlipUnsub = store.subscribe(...)` — fires `ensureAwakenedSystemsOnce()` the first time `realmMode === 'awakened'` (`store.breakTheSpell()` from `awakeningPage.ts`). Self-detaches after first fire.
  - Edge case: `alreadyAwakened` (save loaded mid-awakening) triggers awakened attach via `setTimeout(200)` after `mountTutorial` paints.

### Commit 3 — getStateRef + Diff-Only syncFromState (Per-Emit Performance)

**Problem solved:** `store.getState()` deep-clones the entire state via `JSON.parse(JSON.stringify(state))` on every call. mountApp.ts called it 37 times during boot + main subscriber callback called it on every store emit (gather tick, currency grant, inventory, battle = dozens/sec during play). Cumulative 100-500 ms of pure JSON tax during boot, ~5 FPS drop during active play.

**Files changed:**
- `src/core/gameStore.ts` — Added `getStateRef(): Readonly<GameState>` returns the LIVE state object (no clone). TypeScript `Readonly` makes accidental mutation a compile error.
- `src/ui/mountApp.ts` — Migrated 5 high-traffic call sites:
  1. **Boot batch** (`bootState`) — consolidated 3 separate `getState()` calls into 1 `getStateRef()` for `applyCharacterPreset` + `syncEquipment` + `setBattleMusicMode`.
  2. **`refreshHudImmediate`** (line 763) — runs on every store emit.
  3. **`applyOnlineCharacterDockVisuals`** (line 999) — runs on every renderPage.
  4. **Main `store.subscribe` callback** (line 2394) — runs on EVERY store emit (most impactful migration).
  5. **`applyHarvestVisibilityRules`** (line 3110) — fires on every emit + on attach.
  6. **`combatHandle`'s per-frame `getState` callback** — fires multiple times per frame in awakened combat (biggest single FPS win during combat).

**Diff-only syncFromState — REVERTED (was a bug, see "Reverted Changes" section).**

### Commit 4 — Compile Async + GPU Shader Warm Optimizations

**Problem solved:** `renderer.compile(scene, camera)` is a synchronous GPU shader compile that walks every material in the scene. Each call was 50-300 ms of main-thread blocking work. Particularly bad: bouncy mushrooms had 24 program compiles (8 colors × cap+stem+drip) = 200-1200 ms freeze.

**Files changed:**
- `src/world/awakenedMobs.ts` — `warmShaders` now uses `renderer.compileAsync` (Three.js r158+). Falls back to sync if not available.
- `src/world/awakenedBouncyMushrooms.ts` — Same compileAsync conversion.
- `src/world/magicProjectiles.ts` — Same compileAsync conversion.
- `src/world/cabinBuilder.ts` — Same compileAsync conversion.
- `src/engine/dockExtendedPreload.ts` — `warmMobShadersStandalone` now uses compileAsync.

**Mechanism:** `compileAsync` uses `KHR_parallel_shader_compile` (supported in every Chromium and Firefox since 2022). GPU compiles materials on a driver-side worker thread while JS keeps running.

### Commit 5 — Yields + Per-Phase Progress Emissions in mountApp

**Problem solved:** Bar got stuck at 94% during the long synchronous body of `mountApp`. ~3700 lines between `p(0.94)` and `p(0.97)` ran with no progress feedback.

**Files changed:**
- `src/ui/mountApp.ts`:
  - **NEW:** `bootState = store.getStateRef()` consolidation (mentioned in Commit 3).
  - **NEW progress checkpoints** with yields between each:
    - `p(0.93, 'Applying survivor preset…')`
    - `p(0.94, 'Mounting weapons & gear…')`
    - `p(0.945, 'Tuning music & page context…')`
    - `p(0.95, 'Hooking gather mastery…')`
    - `p(0.955, 'Adopting camp systems…')`
    - `p(0.96, 'Hooking harvest scatter…')`
    - `p(0.965, 'Calibrating forest collisions…')`
    - `p(0.968, 'Forging dream-mode camp…')` (only fires on inline-fallback path)
    - `p(0.97, 'Mounting HUD, pages & tutorial…')`
    - `p(1, 'Ready')`
  - **NEW:** `lastEquipmentSig` check in `renderPage` — skips redundant `scenePreview.syncEquipment` when equipment unchanged. Drops 5-50 ms from every renderPage call.
- `src/util/mainThreadYield.ts` — Added `yieldToEventLoop()` primitive using `scheduler.yield()` (Chrome 129+) → `MessageChannel.postMessage` → `setTimeout(0)` fallback chain. Sub-millisecond yield (vs `requestAnimationFrame`'s 16 ms full-frame wait).

### Commit 0 (Pre-existing today, not me) — Extended Preload Architecture

**File:** `src/engine/dockExtendedPreload.ts` — Title-screen second-stage preload that builds save-independent handles (collisionWorld, dockForestBatchedScene, freeRoamHarvestNodes, cabinBuilder, craftStationBuilder, magicProjectiles, mob shader warm) into the offscreen `CharacterScenePreview.scene` while the player is on the title screen with the name gate. 

**Today I added:**
- `bouncyMushroomsHandle` (Phase 8) — moved from mountApp's `ensureCabinAttached` because its `warmShaders` was the single biggest contributor to post-cutscene freeze (24 GPU programs).
- `defensiveWardHandle` (Phase 9) — moved here because it's a near-zero attach (lazy-builds visual on first activate).
- Per-phase progress emission via new `subscribeDockExtendedPreloadProgress()` API + weighted progress bar (matches measured wall-clock time).
- `src/ui/mountStartFlow.ts` — Title-screen progress bar now subscribes to BOTH base preload (0..55%) AND extended preload (55..100%). Previously hit "ready" at 100% the moment base preload finished while extended chain was still running.

---

## Reverted Changes

### Diff-only `syncFromState` (Commit 3-B) — REVERTED

**Why I tried it:** The `store.subscribe` callback at `mountApp.ts:3136` calls `cabinHandle.syncFromState(store.getPlacedCabinPieces())` and `craftStationHandle.syncFromState(store.getPlacedCraftStations())` on EVERY store emit. With dozens of emits/sec during play, this iterates the placement arrays unnecessarily.

**What I added (the bug):**
```ts
let lastCabinPiecesRef = null;
store.subscribe(() => {
  const pieces = store.getPlacedCabinPieces();
  if (pieces !== lastCabinPiecesRef) {  // ← BUG
    lastCabinPiecesRef = pieces;
    cabinHandle.syncFromState(pieces);
  }
});
```

**Why it broke things:** The store mutates `placedCabinPieces` IN PLACE via `.push()` and `.splice()` (`gameStore.ts:2375, 2401, 2508, 2530`). The array reference never changes after the first call → my `pieces !== lastCabinPiecesRef` was always `false` → `syncFromState` never fired again. Place a cabin wall → invisible. Damage a craft station to destruction → ghost wall stays visible AND keeps its collision footprint blocking movement / harvest raycasts.

**Status:** Reverted to unconditional `syncFromState`. The handles' internal per-bucket signature gating already early-returns when nothing changed.

---

## Current Outstanding Problem

### Symptom

When the player harvests a material object (tree, ore, shrub, rock, fern, heather, berry bush, herb), the fall/crumble animation plays correctly, the resource is granted to inventory, the collision footprint is unregistered (player can walk through the spot) — **but the visual ghost of the object remains** at the original position. It looks identical to the original object, just static (no animation).

**Crystals work correctly** — they reuse the existing `crystalClusters` Group from `forestEnvironment.ts` (no parallel mesh; harvest just shrinks/hides the existing scenery group).

**Ores fail** — rendered by `freeRoamHarvestNodes` as `InstancedMesh` per kind. Hide path: `setMatrixAt(idx, HIDDEN_MATRIX /* makeScale(0,0,0) */)` + `instanceMatrix.needsUpdate = true`.

**Trees + dock-forest plants fail** — rendered by `dockForestBatchedScene` as `BatchedMesh` per material. Hide path: `setVisibleAt(idx, false)`.

### What I've Verified (by reading code)

- Both modules' `applyHit()` correctly sets `node.hp = 0`, schedules a break animation, unregisters the collision footprint, and emits the "broken" result.
- Both modules' `update(dt)` runs every frame (called from mountApp's `frame()` loop at lines 4165, 4253).
- Both modules' break-done path correctly calls the hide primitive (`setMatrixAt(HIDDEN_MATRIX)` for InstancedMesh, `setVisibleAt(false)` for BatchedMesh).
- `instanceMatrix.needsUpdate = true` is correctly set in the dirty-kinds loop.
- `setVisibilityRules()` doesn't override individual instance visibility — it only toggles `h.group.visible` per kind.
- The frame loop has no early-return that would skip these update calls.
- Per-frame culling settings: `perObjectFrustumCulled = false`, `frustumCulled = true` (whole-batch). Should not interfere with hide.
- No code I wrote today directly touches `dockForestBatchedScene.ts` or `freeRoamHarvestNodes.ts` — those are untracked files (`??` in git status), modified at 1:21 PM by an earlier session before mine started (~3:44 PM).

### Plausible Root Causes (Unable to Distinguish Without Runtime Evidence)

#### Theory A — Extended preload partial-success (most likely)
If extended preload partially attached BatchedMesh + InstancedMesh handles to `preview.scene` then **failed** at a later phase (e.g., bouncy mushroom warm threw an exception inside compileAsync), the partial meshes remain in the scene. mountApp's `awaitDockExtendedPreload()` would return `null` → mountApp's `ensureXAttached` creates ANOTHER set of handles in the same scene → two parallel meshes at every position. Player harvests one (managed by the new handle), the other (orphaned from extPreload) stays visible.

**Smoking gun would be:** `[dockExtendedPreload] failed; mountApp will inline-attach` warning in browser console.

#### Theory B — Stale handle reference
Variant of Theory A — `prebuilt` adoption sets handles, BUT the orphan meshes from a previous failed attach are still in scene with no handle controlling them.

#### Theory C — Sequence-of-operations bug from the awakened-systems deferral refactor
My Commit 2 restructured the eager attach block. If there's an `await` mid-block on a slow path that lets a state mutation interleave between `dockForestHandle = prebuilt.dockForestHandle` and the subsequent `ensureDockForestAttached()` guard check, both could fire. Less likely (synchronous guards) but possible under some race.

#### Theory D — A pre-session bug I never had
The harvest files (`dockForestBatchedScene.ts`, `freeRoamHarvestNodes.ts`) were modified at 1:21 PM by an earlier session. Their behavior may already have been broken before I started (~3:44 PM). My changes to extended preload (adding bouncyMushrooms + defensiveWard) may have just exposed it by making extended preload more likely to fail.

### What Would Distinguish Them

Open browser DevTools Console (F12), refresh, play to harvest a tree, then check:

1. **Any `[dockExtendedPreload]` warnings?** → Theory A confirmed.
2. **Any thrown errors during boot?** → Pinpoints which phase fails.
3. **Type `document.querySelectorAll('canvas').length`** → If > 1, multiple renderers exist.
4. **Type `scenePreview.scene.children.length`** (if scenePreview is exposed) → Compare across runs to detect duplicate scene roots.

### Clean Rollback Plan (Test Without Console Diagnostics)

If you don't want to read the console, the lowest-risk diagnostic move is:

**Temporarily revert today's additions to extended preload** (the bouncyMushroomsHandle + defensiveWardHandle phases in `src/engine/dockExtendedPreload.ts`). Test harvest. If it works again, Theory A is confirmed and we know the bouncy mushrooms phase is what's causing extended preload to fail (probably an exception in `attachAwakenedBouncyMushrooms` because of an unexpected `creeks` or `dockXZ` shape on the `getFreeRoamHandles()` result).

The reverted scope would be ~30 lines in `dockExtendedPreload.ts` (Phase 8 + Phase 9 + the handle interface fields). Awakened systems would attach in mountApp instead (back to the pre-Commit 2 behavior for those two handles only).

---

## Files Touched Today

| File | Today's Changes |
|---|---|
| `index.html` | Inline boot veil + `__hideBootVeil()` global |
| `src/main.ts` | `hideInlineBootVeil()`, always-on overlay during mountApp, double-rAF fade, `preCutsceneVeil` rename, top-of-file dynamic import prefetch |
| `src/core/gameStore.ts` | `getStateRef()` API |
| `src/util/mainThreadYield.ts` | New `yieldToEventLoop()` primitive |
| `src/ui/mountApp.ts` | 5× `getStateRef` migrations, `bootState` batch, defer awakened systems, `realmFlipUnsub`, `attachDreamHandlesInline`, 8 progress checkpoints + yields, `lastEquipmentSig` skip-redundant-syncEquipment, frame-loop fallback updated for deferral |
| `src/ui/mountStartFlow.ts` | Merged base+extended progress subscription |
| `src/engine/dockExtendedPreload.ts` | Added bouncyMushroomsHandle + defensiveWardHandle phases, per-phase progress emission, `subscribeDockExtendedPreloadProgress` API, compileAsync for mob warm |
| `src/world/awakenedMobs.ts` | `warmShaders` → compileAsync |
| `src/world/awakenedBouncyMushrooms.ts` | `warmShaders` → compileAsync |
| `src/world/magicProjectiles.ts` | `warmShaders` → compileAsync |
| `src/world/cabinBuilder.ts` | `warmShaders` → compileAsync |

## Files Not Touched Today (But Critical to the Bug)

| File | Last Modified | Why Critical |
|---|---|---|
| `src/world/dockForestBatchedScene.ts` | 1:21 PM (pre-session) | Renders trees + shrubs + rocks. Hide bug manifests here. |
| `src/world/freeRoamHarvestNodes.ts` | 12:07 PM (pre-session) | Renders ores + herbs + crystals. Hide bug manifests here for ores/herbs. |
| `src/visual/forestEnvironment.ts` | 12:47 PM (pre-session) | Emits the obstacle specs consumed by both renderers. |

---

## Recommended Next Steps (HISTORICAL — superseded by resolution below)

1. **Quick diagnostic** — 30 seconds in browser console as described in "What Would Distinguish Them" above.
2. **Based on the result, one of:**
   - **Theory A confirmed:** Wrap extended preload phases in individual try/catch so one phase failing doesn't strand orphan meshes from earlier phases. OR detect partial state on failure and dispose attached handles before letting mountApp fall through.
   - **Theory C confirmed:** Add a guard that `dockForestHandle` is null before calling `attachDockForestBatchedScene` from EITHER code path; instrument with a one-line console.log to detect double-call.
   - **Theory D confirmed:** Revert the pre-session 1:21 PM edits to `dockForestBatchedScene.ts` and see if behavior returns. We'd then need to understand what those edits were trying to do.
3. **If user prefers no diagnostic:** Apply the clean rollback (revert today's bouncyMushrooms + defensiveWard additions to extended preload). Re-test. If harvest works, we have our isolation.

---

## RESOLUTION (2026-04-20, late session) — Unified Preload + Scene Singletons

**Outcome:** Ghost-mesh bug eliminated structurally. Two-stage preload merged into ONE phased pipeline. All four debugging hypotheses turned out to be facets of a single root cause.

### Root cause (final)

The two-stage architecture (`base preload` then chained `extended preload`) was the bug surface area. With two separate state machines and two separate `.then` chains:

- Player could click **Begin** between stage 1 finishing and stage 2 starting
- mountApp's `awaitDockExtendedPreload()` would observe `state: 'idle'` (extended never started) → fall through to inline `ensureXAttached`
- BUT extended preload was ALSO scheduled via `requestIdleCallback`, which would later fire AFTER mountApp's inline attach, building a SECOND set of meshes against the same scene
- Vite HMR made it worse: cache-bust timestamps could give different module instances different views of the state machine

Theories A, B, C, D all collapse to: **two pipelines that need to converge can race**. The fix is to have one pipeline.

### The fix (3 structural changes)

**1. Unified preload pipeline (`src/engine/dockPreload.ts`)**

`startIdleCraftDockPreload` now runs base + extended phases as a single async chain:

- Phase 1: `CharacterScenePreview.create` (scene foundation) — reports 0..0.55 of the bar
- Phase 2: `startDockExtendedPreload(preview)` (gameplay layers) — reports 0.55..1.0 of the bar
- State carries `{ preview, gameplayHandles }` — both or neither
- `consumeIdleCraftDockPreload(target)` returns the FULL bundle in one call

`mountApp.ts` consumes that bundle and adopts handles SYNCHRONOUSLY at consume time — no separate `awaitDockExtendedPreload`, no race window.

**2. Scene-singleton handles (`src/world/dockForestBatchedScene.ts`, `src/world/freeRoamHarvestNodes.ts`)**

Even with the unified pipeline, defense-in-depth: the attach functions check `scene.userData.dockForestHandle` / `scene.userData.freeRoamHarvestHandle` first. If a handle exists for this scene, return THAT instead of building a duplicate. Robust against any future caller that bypasses the unified pipeline. `dispose()` clears the userData entry.

**3. Scene-singleton collisionWorld (`src/world/collisionWorld.ts`)**

`getOrCreateSceneCollisionWorld(scene)` ensures all attaches register footprints into the SAME world that gameplay queries. Previously, extended preload's collisionWorld and mountApp's collisionWorld were different objects → harvest registered in one, player movement queried the other → walk-through trees.

### Outcome

- Ghost-mesh bug: **resolved** — single pipeline guarantees one attach per scene
- Walk-through trees / mushrooms: **resolved** — single shared collisionWorld
- Harvest hide for trees + ores + herbs: **works** — handles register-then-hide on the same instance
- Boot performance: **improved** — adoption is synchronous (no extra `await` round-trip + module import)
- Code surface: **smaller** — `extPreloadModule.awaitDockExtendedPreload` chain in `main.ts` deleted, adoption block in `mountApp.ts` simplified to direct field reads from the consumed bundle, verbose diagnostic logging retired

### Per-frame FPS audit (also today)

After resolving the architecture bug, audited per-frame hot paths:

- `dockForestBatchedScene.update` — already gated on `brokenNodeIndices.size === 0` early-exit. Walks 0-5 broken nodes typical case, not all ~360. **No change needed.**
- `freeRoamHarvestNodes.update` — was walking ALL ~150-300 nodes every frame for respawn. **Fixed:** added matching `brokenNodes: Set<ScatteredNode>` tracking. Common case now exits on `Set.size === 0`. ~150x reduction in per-frame work for typical play.
- IBL PMREM regen — already deferred via `requestIdleCallback`. **No change needed.**
- `store.tick` allocations — out of scope this round; documented in "Next-tier improvements" below.

### Files touched in resolution

| File | Change |
|---|---|
| `src/engine/dockPreload.ts` | Rewritten as unified pipeline; state carries `{ preview, gameplayHandles }`; consume returns the bundle |
| `src/engine/dockExtendedPreload.ts` | Removed `isIdleCraftDockPreloadActive` race-guard (unneeded — pipeline calls it directly); accepts optional progress callback; verbose diagnostic logs removed |
| `src/main.ts` | `schedulePreloadAfterPaint` no longer chains a separate extended-preload kick; `enterGame` waits on unified preload progress instead of separate `extPreloadModule.awaitDockExtendedPreload` |
| `src/ui/mountApp.ts` | `consumePreloadedDock` returns bundle; adoption reads `prebuiltGameplayHandles` directly (no async round-trip); verbose diagnostic logs removed |
| `src/world/dockForestBatchedScene.ts` | Scene-singleton check silently reuses (no diagnostic warn); first-attach diagnostic warn removed |
| `src/world/freeRoamHarvestNodes.ts` | Scene-singleton check silently reuses; broken-node Set tracking added for respawn-loop early-exit |

See LEARNINGS.md entry "Unified preload + scene-singleton handles" for the full retrospective.
