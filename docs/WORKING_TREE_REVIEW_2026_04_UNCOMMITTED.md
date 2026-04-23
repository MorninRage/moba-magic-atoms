# Working tree review — uncommitted changes vs `HEAD` (2026-04-22)

**Purpose:** Single artifact capturing a **read-only** comparison of the **current working tree** (including uncommitted and untracked files) to **last committed git state**, so scope and themes are clear before a commit or split into PRs. **No value judgment** on whether to land everything together — this is an inventory and analysis.

**Reference commit (at time of review):** `0d0b41e` — *Move Controls reference from inline Esc panel to standalone popup* (`main…origin/main`).

**How to refresh this doc:** Re-run `git status`, `git diff --stat HEAD`, `git ls-files --others --exclude-standard` after large local changes; update the “Reference commit” and section counts if the baseline moves.

---

## 1. Executive summary

The uncommitted work is **not** a single feature (e.g. “only cutscenes + terrain + mycelium”). It bundles several **parallel tracks**:

| Track | What changed (high level) |
|------|---------------------------|
| **A. Boot & cutscenes** | Cutscene-driven boot reduced or removed; intro MP4s recompressed; game reset no longer re-arms the “must watch intro” flag. |
| **B. World & environment** | Async / staged forest attach; trippy ground bake extracted and chunked; fog near distance increased; **random weather runtime removed**. |
| **C. Awakened world play** | Bouncy drip-mushrooms expanded (mycelium, drip wobble, collision glue); heightfield / magic / free-roam touchpoints. |
| **D. Render worker (opt-in)** | Full `src/worker/*`, `CharacterSceneHost`, SAB, COOP/COEP, `capabilityGate` (product default: **legacy** dock; `?worker=1` to test worker — see [WORKER_VS_LEGACY_PATH.md](WORKER_VS_LEGACY_PATH.md)). |
| **E. Multiplayer & presence** | Room server + `roomTypes`: realm + world pose for awakened co-op; `GameStore` presence shape; lobby hero preset visuals. |
| **F. Performance & tooling** | GameStore `tick()` allocation reduction; `mainThread` yield / LoAF audit; graphics tier / renderer display; heavy `package-lock` churn. |
| **G. Documentation** | Many new or updated `docs/*` (sessions, worker architecture, vision vs implementation, this review). |

---

## 2. Scale metrics

| Metric | Approximate value (at review) |
|--------|--------------------------------|
| **Tracked file changes** | ~50 files |
| **Line delta (tracked, excluding lockfile detail)** | On the order of **+13k / −7k** lines in source/docs (per `git diff --stat HEAD`; `package-lock.json` contributes a very large line churn on its own). |
| **Untracked paths** | ~**40** files/directories (includes entire `src/worker/`, new docs, `trippyGroundBake`, `characterSceneHost`, etc.) |
| **New worker TypeScript (approx.)** | `src/worker` alone **~4,000+** lines of new code (rough LOC count). |

**Interpretation:** This is **multi-PR** or **stacked PR** material if the team wants reviewable, revertible history. A single monolithic commit would be hard to bisect.

---

## 3. Cutscenes, boot, and media (Track A)

### 3.1 Code / boot graph

- **`src/main.ts`:** Large diff. Historically: dynamic imports of `./cutscenes/introCutscene` and `introSplash`, cutscene-timed work, boot veil tied to video decode. **Current tree:** “post–cutscene-removal” path — earlier dock preload kick, less work gated on long first-visit video windows; comments document the **long-animation-frame** / main-thread budget motivation.
- **`src/cutscenes/introCutscene.ts`:** Modified; still part of the tree but boot integration changed vs always-on first-run chain.
- **`src/ui/mountStartFlow.ts`:** Substantial changes in line with the new boot/title flow.

### 3.2 Binary assets

| File | Direction (working tree vs `HEAD`) |
|------|--------------------------------------|
| `public/cutscenes/intro_the_curse.mp4` | **Smaller** on disk (roughly **34.4 MB → ~12.9 MB** — re-encode or replacement). |
| `public/cutscenes/intro_the_shattering.mp4` | **Smaller** (roughly **50.0 MB → ~18.3 MB**). |

**Note:** Smaller files reduce first-load bandwidth; they do not by themselves define when the app **plays** those videos (see boot code).

### 3.3 Save / reset semantics

- **`src/core/gameStore.ts`:** On full “reset expedition”, the working tree **does not** remove `idle-craft-intro-cutscene-seen-v1` from `localStorage`. **Previously:** that removal forced the full intro (curse + shatter, ~2 minutes) on every new expedition after reset — called out in comments as bad for Vibe Jam judges and repeat runs.

### 3.4 Related documentation

- [SESSION_2026_04_22_CUTSCENE_REMOVAL_AND_BOOT_TIGHTENING.md](SESSION_2026_04_22_CUTSCENE_REMOVAL_AND_BOOT_TIGHTENING.md) (if present) — session narrative.
- [README.md](../README.md) — notes cutscenes *unwired* from boot; files kept for revert.

**vs `HEAD` summary:** **Less** cutscene on the **critical path** to “game interactive”; **different** localStorage story on reset; **smaller** MP4 payloads.

---

## 4. Terrain, forest, fog, and weather (Track B)

### 4.1 `src/visual/forestEnvironment.ts` (large diff)

- **Trippy ground:** In `HEAD`, **inline** `TRIPPY_GROUND_COLORS` + `bakeTrippyGroundVertexColors()` lived in this file. In the working tree, baking goes through **`bakeTrippyGroundVertexColorsChunked`** from **`src/visual/trippyGroundBake.ts`** (untracked at review) — chunked work + integration with **long-animation-frame** / `measureBlockAsync` style auditing.
- **`attachForestBackdrop`:** Became **`async`**, split into **staged sub-phases** with **`yieldToEventLoop()`** between heavy steps (terrain + water, then `scatterWorldForestStrata`, then crystals/shrubs, then merges, etc.) — **Tier B** intent: avoid one 150–300 ms uninterruptible main-thread block.
- **Fog:** **Day fog “near”** distance **0.85 → 1.4 × `mapRadius`** (both initial `scene.fog` in `attachForestBackdrop` and comments tying to dock disk tree clarity — “blur around trees at distance” player report).
- **Imports:** e.g. `computeSlopeAt` may move with the bake; `bakeTrippyGroundVertexColorsChunked` added.

### 4.2 `src/world/idleCraftDockEnvironment.ts`

- **Fog near** aligned to **1.4 × `mapRadius`** (matches forest comments).
- **`IdleCraftWeatherRuntime` removed** — class field deleted; `syncProjectWeather` + static project config remain.
- **PMREG / IBL scheduling:** `requestIdleCallback` for regen path replaced with **`schedulePostTask(..., 'background')`** (Round 5 / tagged scheduler).
- **Per-frame `update`:** No `weatherRuntime.tick()`. **`stormDim`** is no longer driven by a random clear/rain cycle; comment explains removal of **invisible** storm (no rain particles / audio) while keeping shader hooks for a possible future system.

### 4.3 Deleted file

- **`src/world/idleCraftWeatherRuntime.ts`:** **Removed** in the working tree — random weather timing and storm wetness that drove `stormDim` / surface water wobble.

### 4.4 `src/world/idleCraftHeightfield.ts`

- New export **`isWaterAtFromResolvedCreeks`()` — point-in-channel test shared with environment / worker-friendly placement rules.

**vs `HEAD` summary:** **Richer** trippy ground pipeline (chunked + measurable), **async** forest construction, **clearer** mid-distance fog, **no** fake storm cycle.

---

## 5. Bouncy mushrooms & mycelium (Track C)

- **`src/world/awakenedBouncyMushrooms.ts`:** **Large positive delta** (on the order of **+200 lines** in `git diff --stat`) on top of a file that **already existed** in `HEAD`. Not a brand-new file from zero — an **expansion**.
- **Themes in the diff (conceptual):** **Mycelium** thread + node materials, understory / under-cap affordances, **drip wobble** (stretch on squash), pre-compile / warm notes, integration with `collisionWorld` / landing / magic hits as wired in sibling files.

**vs `HEAD` summary:** “Mycelium under mushroom” and drip polish are **real** and localized; they sit **beside** the much larger **terrain async** and **weather** changes.

**Related file deltas:** `src/world/collisionWorld.ts`, `src/world/freeRoamControls.ts`, `src/world/magicProjectiles.ts`, `src/world/idleCraftWorldTypes.ts` — touch bounce, owner IDs, or harvest paths.

---

## 6. Render worker & dock architecture (Track D) — untracked / large

This is the **largest new surface area** in the working tree.

| Area | Examples |
|------|----------|
| **Worker entry & controller** | `src/worker/renderWorker.ts`, `characterSceneController.ts`, `protocol.ts`, `sharedState.ts` |
| **Main thread shell** | `src/visual/characterSceneHost.ts` (untracked) |
| **Bridges** | `workerBridge.ts`, `workerAudioRouter.ts`, `workerInputForwarder.ts`, `workerProxyAwakenedMobs.ts` |
| **Shared gameplay attach** | `src/engine/dockGameplayAttachShared.ts`, `dockPreviewFacade.ts` |
| **Preload** | `src/engine/dockPreload.ts`, `dockExtendedPreload.ts` — `CharacterSceneHost` vs `CharacterScenePreview` branching |
| **Build / deploy** | `vite.config.ts`, `netlify.toml`, `index.html` — COOP/COEP, worker bundle |
| **Camera** | `src/world/dockSoloCameraFraming.ts` (untracked), worker + `mountApp` SAB sync (tracked edits) |

**Product policy (current tree):** default dock is **legacy** main-thread `CharacterScenePreview`; worker path is **`?worker=1`**. Full URL semantics and gap analysis: **[WORKER_VS_LEGACY_PATH.md](WORKER_VS_LEGACY_PATH.md)**.

**vs `HEAD` summary:** `HEAD` has **no** `src/worker` tree; the working tree is a **full experimental render-worker** stack + docs.

---

## 7. Multiplayer, presence, and lobby (Track E)

- **`src/net/roomTypes.ts`:** `RemotePresenceEntry`, `PresenceRealmMode`, `presence_update` fields: **`realm`**, world **`wx` / `wy` / `wz` / `wyaw`** for awakened co-op replication.
- **`src/core/gameStore.ts`:** Presence map typed to `RemotePresenceEntry`; `presence_update` handler fills realm + pose; **Tier D** `tick()` alloc reductions (reused `rates` object, cached `Set` of unlocked card IDs, `for…in` vs `Object.entries` where safe); **`applyAwakenedMobsAuthorityFromWorker`** for worker mob sync.
- **`server/room-server.mjs`:** Forwards new presence fields.
- **`src/net/roomHub.ts`**, **`roomHubBridge.ts`:** Wiring for the above.
- **`src/visual/multiplayerAvatarStage.ts`**, **lobby** — `lobbyDockHeroFromPreset.ts` (untracked) and related: preset-accurate dock mini-figures.

**vs `HEAD` summary:** **Awakened** co-op **pose + realm** not present in the same form on `HEAD`.

---

## 8. Performance, graphics, and idle loop (Track F)

- **`src/engine/graphicsTier.ts`**, **`src/engine/rendererDisplaySettings.ts`:** Tier / display pipeline changes (awakened pixel budget, DPR, post stack) — see individual file comments and `LEARNINGS.md` / round-5 / round-4 session docs.
- **`src/util/mainThreadYield.ts`:** Expanded (scheduler, yields, `schedulePostTask`).
- **`src/util/longAnimationFramesAudit.ts`** (untracked): `?perf=audit` / LoAF-style attribution.
- **`package.json` / `package-lock.json`:** Dependency and tooling updates (PWA, etc.); **lockfile line count dominates** “lines changed” stats — treat as **infrastructure**, not hand-written game logic.
- **`src/ui/mountApp.ts`:** **Very large** diff (worker branches, SAB, mob proxy, co-op, camera, harvest routing, etc.).

**vs `HEAD` summary:** **Measurable** main-thread and GC work reduction in hot paths, plus **optional** worker path complexity in `mountApp`.

---

## 9. Documentation & meta (Track G)

New or heavily updated (non-exhaustive):

- [WORKER_VS_LEGACY_PATH.md](WORKER_VS_LEGACY_PATH.md) — default vs `?worker=1` / `?worker=0`
- [WORKER_ARCHITECTURE.md](WORKER_ARCHITECTURE.md), [WORKER_MIGRATION_PHASE_3X.md](WORKER_MIGRATION_PHASE_3X.md)
- [GAME_VISION_VS_IMPLEMENTATION_2026_04.md](GAME_VISION_VS_IMPLEMENTATION_2026_04.md)
- Session notes: `SESSION_2026_04_20_*`, `SESSION_2026_04_21_*`, `SESSION_2026_04_22_*`
- [PLAN.md](../PLAN.md), [LEARNINGS.md](../LEARNINGS.md), [GAME_MASTER.md](../GAME_MASTER.md), [README.md](../README.md), [AGENT_CONTEXT.md](../AGENT_CONTEXT.md)

**vs `HEAD`:** Substantial **authoritative** write-ups for migration and product intent that did not exist on `0d0b41e`.

---

## 10. Other tracked files (quick index)

Worth a direct `git diff HEAD -- <path>` before commit:

| Path | Note |
|------|------|
| `src/visual/idleCraftNightMagicLPCA.ts` | Very large diff — night / mushroom-adjacent LPCA. |
| `src/visual/characterScenePreview.ts` | Large — yields, camera, co-op, tier, etc. |
| `src/audio/fileMusic.ts` | Worker / routing + music behavior. |
| `scenes/main.json`, `project.json` | Data/config drift. |
| `docs/CUTSCENE_*.md` | Cutscene pipeline docs updated. |
| `LORE.md` | Minor. |

---

## 11. Risk / review checklist (for whoever commits)

- [ ] **Split or stack:** Worker + co-op + world + boot may deserve **separate** PRs for bisect and review focus.
- [ ] **Lockfile:** Review `package.json` **intent**; accept lockfile in its own commit if policy allows.
- [ ] **COOP/COEP:** Verify third-party resources still load in dev and prod when touching `vite.config` / `netlify.toml`.
- [ ] **Binary MP4s:** Confirm licensing and **quality** of re-encoded cutscenes if shipped.
- [ ] **Weather removal:** Product sign-off on **no** random storm dimming until a real VFX system exists.
- [ ] **Worker default:** Confirmed **legacy default** in `capabilityGate.ts` matches [WORKER_VS_LEGACY_PATH.md](WORKER_VS_LEGACY_PATH.md).

---

## 12. Changelog of this document

| Date | Change |
|------|--------|
| 2026-04-22 | Initial version — full inventory from working tree vs `0d0b41e` (uncommitted + untracked). |

*End. For ongoing worker product policy, see [WORKER_VS_LEGACY_PATH.md](WORKER_VS_LEGACY_PATH.md). For migration checkboxes, see [WORKER_MIGRATION_PHASE_3X.md](WORKER_MIGRATION_PHASE_3X.md).*
