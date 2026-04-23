# Idle Craft dock — performance plan (Empire Engine / GoE alignment)

**Status:** Living plan — review against engine + editor sources; execution is phased.  
**Date:** 2026-04-14  
**Note:** External doc path `C:\gameofempriesDocs` was not available in the workspace used for this review; content below is grounded in **`EmpireEngine`**, **`EmpireEditor`**, and **`EmpireEditor/docs`** checked out beside this repo.

---

## 1. Review — where LOD and budgets live

### 1.1 Empire Engine (npm: `empire-engine` / repo `EmpireEngine`)

| Piece | Location | Role |
|--------|----------|------|
| **LODRecipe** | `src/assets/LODRecipe.ts` | Data-driven tiers per asset: distance, **hysteresis**, triangle reduction, `mergeByMaterial`, **`castShadow` per tier**, impostor rules, `cullDistance`, optional `fadeDuration`. |
| **Tier evaluation** | `evaluateLODTier(recipe, distance, currentTier)` | Chooses tier with **hysteresis** so LOD does not flicker at boundaries. |
| **Presets** | `createStandardLODRecipe`, `createVegetationLODRecipe` | Buildings: 3 tiers; vegetation: 4 tiers ending in **billboard impostor**. |
| **Cell LOD** | `src/world/CellLODController.ts` | Per-cell tier 0/1/2 with **distance² thresholds** + **hysteresisSq**; **`CellLODSwapCallback`** rebuilds/swaps geometry when tier changes. |
| **Impostors** | `src/render/ImpostorGenerator.ts` | Billboard atlas or simplified proxy — mid/far LOD draw-call reduction. |
| **Shadows** | `src/render/ShadowSystem.ts` | **`maxCasterDistance`**, register casters; **far content uses non–shadow-casting LOD** to save fill rate. |

**Takeaway for Idle Craft:** The engine’s LOD story is **distance + hysteresis + shadow casting off on far tiers + merge + optional impostor**. Idle Craft’s dock is not cell-streamed like the full GoE world, but the **same rules** apply to dock foliage, night-magic density, and “hero” props (torch/campfire/workbench).

### 1.2 Empire Editor

| Piece | Location | Role |
|--------|----------|------|
| **LOD panel** | `src/panels/LODPanel.ts` | UI for **LODRecipe** presets (building / vegetation / custom), tier editing, impostor export snippet. |
| **Config tuner** | `src/panels/ConfigTunerPanel.ts` | Example key: `lod.buildingDistance` — LOD distances are **first-class tunables** alongside graphics. |
| **Pipeline doc** | `docs/FULL_ENGINE_PIPELINE.md` §8–§10 | GoE-style world: **LOD0→LOD1→LOD2** for buildings; separate vegetation distance; **`LPCALODManager`**, **`DetailBudgetManager`**, **`perf.targetFps`**, tuning order (LOD distances before heavy PP). |
| **Platform doc** | `docs/LPCA_PLATFORM_AND_PERFORMANCE.md` | **Merge for performance**, material cache, draw-call targets — matches dock `mergeByMaterial` usage in forest build. |

**Takeaway:** Editor and docs assume **config-driven LOD + adaptive budget**. Idle Craft should expose a small subset (`graphics.renderScale`, dock quality, LOD distances for ring vegetation) in `project.json` / engine config where possible.

### 1.3 Game of Empires (reference only)

Referenced in **EmpireEditor** docs, not fully in this workspace:

- **`LPCALODManager`** — building LOD switching at runtime.  
- **`DetailBudgetManager`** — scales NPC count, LOD distances, vegetation to hit **`config perf.targetFps`**.

Idle Craft does not need these managers verbatim for the **single-viewport dock**, but the **idea** (scale cost when FPS drops) is the right long-term match for **night magic**, **star layers**, and **forest ring** complexity.

---

## 2. Idle Craft dock — current state vs engine patterns

| Engine pattern | Idle Craft dock today | Gap |
|----------------|------------------------|-----|
| LOD tiers + hysteresis | Forest uses fixed dock ring; **no distance-based LOD** for trees/shrubs in preview | Could add **2-tier** ring: full LPCA near avatar, merged/instanced or culled far ring using `evaluateLODTier`-style thresholds from **camera–tree distance**. |
| `castShadow` per tier | Dock key light toggles shadow with day/moon; campfire/torch add lights | Align with **ShadowSystem** idea: **few shadow casters**, far vegetation **no castShadow**. |
| Impostor at far tier | Not used in dock | Optional **billboard/merged** impostor for **far forest** only (engine has `ImpostorGenerator`). |
| Stagger heavy GPU work | `queueCraftDecorMeshBuild`, reveal holds, skydome rAF defer | Good — extend with **explicit LOD swap queue** (max one tier change per frame). |
| Shader warm-up | `warmRenderPipeline()` | Warm-up should include **all night + craft + post** variants (see previous optimization notes). |

---

## 3. Updated phased plan (LOD first, then rest)

### Phase A — LOD & draw-call budget (this document’s priority)

1. **Define a dock `LODRecipe` (data)**  
   - Either embed in `project.json` / `environment` or a small `idleCraftDockLod.json`.  
   - Tiers for **vegetation ring** (and optionally **night-magic field** particle cap): near = current LPCA; far = **merged mesh** or **lower segment counts** / fewer instances.

2. **Implement distance evaluation**  
   - Reuse **`evaluateLODTier`** from `empire-engine` for consistency with editor recipes.  
   - Use **hysteresis** so dusk camera moves do not pop LOD every frame.

3. **Shadow alignment**  
   - Audit dock: ensure **only** avatar + nearby hero props cast shadows where needed; ring vegetation **`castShadow: false`** at tier ≥ 1 (matches `LODTierDef`).

4. **Editor workflow**  
   - When tuning in **Empire Editor**, export or hand-copy **LODRecipe** distances into Idle Craft env config so **one mental model** across GoE and jam dock.

### Phase B — Shader / transition hitches (from prior dock performance review)

- Extended **`warmRenderPipeline`** / async compile path for torch, campfire, moon, night magic, post stack.  
- Reduce **per-frame `castShadow` toggles** on sun/moon swap at twilight.  
- Cap **skydome Canvas2D** repaints during rapid `simHour` change.

### Phase C — Crafting + UI coupling

- Debounce `setCraftDecorAvailability`; align torch enable with **`dockHeavyVisualStaggerActive`**.

### Phase D — Adaptive quality (GoE-style)

- Lightweight **`DetailBudgetManager`-inspired** hook: if moving average frame time > budget, lower **night magic visibility cap**, **star opacity**, or **vegetation LOD tier** by one step until stable.

---

## 4. References (paths on dev machine)

- `EmpireEngine/src/assets/LODRecipe.ts`  
- `EmpireEngine/src/world/CellLODController.ts`  
- `EmpireEngine/src/render/ImpostorGenerator.ts`  
- `EmpireEngine/src/render/ShadowSystem.ts`  
- `EmpireEditor/src/panels/LODPanel.ts`  
- `EmpireEditor/docs/FULL_ENGINE_PIPELINE.md` (§8 LOD, §10 Performance)  
- `EmpireEditor/docs/LPCA_PLATFORM_AND_PERFORMANCE.md`  
- Idle Craft: `src/visual/forestEnvironment.ts`, `src/visual/characterScenePreview.ts`, `src/world/idleCraftDockEnvironment.ts`

---

## 5. Next step (proceed)

1. Implement **Phase A** skeleton: config type + `evaluateLODTier` for dock ring + shadow flags on merged vegetation.  
2. Add **devtools / debug** overlay (optional) showing current LOD tier — reuse **engine `DebugOverlay`** concept if wired later.  
3. Profile one session with Chrome Performance after Phase A to validate fewer draw calls and less shadow cost at night.

---

*Document version: 1.0 — aligned with Empire Engine / Editor sources reviewed 2026-04-14.*
