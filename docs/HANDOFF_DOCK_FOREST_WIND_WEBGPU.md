# Handoff: Dock visuals, forest wind, WebGL stability, WebGPU status

**Audience:** Next agent or new Cursor window — full context for rendering, vegetation wind, and diagnostics without re-deriving from chat history.

**Last updated:** 2026-04-15

---

## 1. What was implemented (not always covered elsewhere)

### 1.1 Forest & LPCA (dock ring + strata)

- **Species mix:** Apple (0), pine (1), birch (2), balsam fir (3), round oak (4). Ring and scatter biased toward deciduous + balsam; birches toned down; balsam reads as spire fir with connected foliage tiers (see `goeStyleHarvestLPCA.ts`).
- **`forestEnvironment.ts`:** Terrain heightfield, creek ribbons, merged tree ring, understory merge, rocks, water registration with `IdleCraftDockEnvironment`, night-magic attach.
- **`mergeByMaterial`:** World transforms baked into geometry; materials are **shared references** until explicitly cloned (important for wind — see §3).

### 1.2 Vegetation wind (`idleCraftVegetationWind.ts`)

- **Mechanism:** `onBeforeCompile` chains prior hooks; injects after `#include <begin_vertex>`; shared uniforms `uVegetationWindTime`, `uVegetationWindGust`; per-material `uVegetationWindFlex`.
- **Height weighting:** Motion favors **canopy** (world `y` after merge) over trunk base — tunable in the injected GLSL block.
- **`updateVegetationWind(time, stormGust01)`** called from `IdleCraftDockEnvironment.update` each frame.
- **`installVegetationWindOnMergedGroup`:** Skips **`InstancedMesh`** (fairy PBR + custom `onBeforeCompile` must not chain wind).
- **Material clone before wind:** `cloneMaterialsForVegetationWind` runs on merged forest trees, merged understory, merged night fungi, merged night ground — so **LPCA singleton materials** (`STD_BARK`, `physLeaf` caches in `goeStyleHarvestLPCA.ts`) are **not** patched on the copies still used by gather props in `CharacterScenePreview`.
- **Night magic:** Wind installed only on **`mergedFungi`** and **`mergedGround`** (not whole `root`), after clone — avoids walking fairies/lights and keeps installs scoped.

### 1.3 Shader / uniform fix (critical)

- **Problem:** Assigning `shader.uniforms.*` in `onBeforeCompile` does **not** emit GLSL `uniform` declarations in the vertex shader on the WebGL path (Three r182).
- **Fix:** After `#include <common>`, inject:
  `uniform float uVegetationWindTime;` / `uVegetationWindGust` / `uVegetationWindFlex` (with fallback prepend if `<common>` missing).
- **Foliage:** `MeshPhysicalMaterial` (`physLeaf`) is included again (`isMeshStandardMaterial` is true for subclasses). Trunks + tops sway; cache key suffix `:vegWind2` helps force fresh programs after changes.

### 1.4 Skydome canvas (`idleCraftSkyPaint.ts` + dock env)

- **Chrome hint:** `getImageData` in `sealEquirectHorizontalSeam` — create 2D context with `{ willReadFrequently: true }` in:
  - `forestEnvironment.ts` (`attachSkydome`)
  - `IdleCraftDockEnvironment.registerSkydomeTexture`

### 1.5 WebGL bootstrap (`createIdleWebGLRenderer.ts`)

- WebGL-only `WebGLRenderer`; tries antialias on then off; `stencil: false`, `failIfMajorPerformanceCaveat: false`; validates context with `isContextLost()`.
- **`preferWebGPU`:** Accepted for API parity but **ignored** here (always WebGL).

### 1.6 Lifecycle / context churn

- **`disposeIdleCraftDockScene()`** in `mountApp.ts` — disposes `CharacterScenePreview` when leaving game or before creating a new one; **`main.ts` `returnToTitle`** calls it before clearing DOM.
- **Vite HMR:** `import.meta.hot.dispose` calls `disposeIdleCraftDockScene()` to avoid stacking WebGL contexts on hot reload.

### 1.7 Other related systems (pointers)

- **Night bioluminescence / fairies:** `idleCraftNightMagicLPCA.ts` — merged batches + instanced fairy swarm; wind only on merged fungus/ground clones.
- **Day/night / weather / moon / plasma sun:** `idleCraftDockEnvironment.ts`, `idleCraftDayPeriods.ts`, `idleCraftWeatherRuntime.ts`, celestial materials — see existing plans under `docs/DAYNIGHT_WEATHER_GOE_PLAN.md`, etc.
- **Hydrology / gather:** `project.json` `hydrology.creeks`, `idleCraftHeightfield.ts`, `idleCraftGatherWorld.ts`.

---

## 2. Problems encountered and how they were solved

| Problem | Cause | Solution |
|--------|--------|----------|
| `customProgramCacheKey` / `onBeforeCompile` crash (`this` undefined) | Wrapper called prior key/compile without binding `this` | `bind(mat)` on previous functions; use normal `function` handlers; forward `(shader, renderer)` to chained compile |
| WebGL “context loss / blocked” | Leaked contexts on remount / HMR | Dispose dock preview before recreate; HMR `dispose`; robust `WebGLRenderer` params; user may still need full tab close if GPU blocks origin |
| Vertex shader not compiled; only some batches drew | Wind patched **shared** LPCA singletons used by forest **and** gather tree | `cloneMaterialsForVegetationWind` on merged groups **before** `installVegetationWindOnMergedGroup` |
| Fairy / instanced PBR broke compile | Wind traversed whole night `root` and patched fairy `MeshPhysicalMaterial` + custom tint shader | Skip `InstancedMesh` in wind installer; install wind only on `mergedFungi` / `mergedGround` |
| Only trunks swayed | Wind excluded `MeshPhysicalMaterial` while debugging | Re-include Physical (subclass of Standard); uniform injection fixed real compile failure |
| `uVegetationWindTime` undeclared in GLSL | `shader.uniforms` alone doesn’t declare vertex uniforms in WebGL build | Explicit `uniform float` lines after `#include <common>` |
| Canvas2D `getImageData` performance warning | Default 2D backing store not tuned for readback | `getContext('2d', { willReadFrequently: true })` for skydome canvas |

---

## 3. File map (quick reference)

| Area | Files |
|------|--------|
| Wind | `src/visual/idleCraftVegetationWind.ts` |
| Forest attach | `src/visual/forestEnvironment.ts` |
| LPCA trees / materials | `src/visual/goeStyleHarvestLPCA.ts` |
| Night magic | `src/visual/idleCraftNightMagicLPCA.ts` |
| Dock env + wind tick + skydome paint trigger | `src/world/idleCraftDockEnvironment.ts` |
| Skydome 2D paint | `src/world/idleCraftSkyPaint.ts` |
| WebGL create | `src/engine/createIdleWebGLRenderer.ts` |
| Engine exports + WebGPU compat re-export | `src/engine/idleCraftEngine.ts` |
| Preview lifecycle | `src/ui/mountApp.ts`, `src/main.ts` |
| Preview renderer options | `src/visual/characterScenePreview.ts` (`preferWebGPU: false`) |

---

## 4. WebGPU: current state (reviewed in repo)

### 4.1 What exists today

- **`getWebGPUCompat` / `checkWebGPUAsync` / `isWebGPUAvailableSync`** re-exported from `empire-engine/render/WebGPUCompat` in `idleCraftEngine.ts`.
- **`logIdleCraftWebGPUCompat()`** runs at startup from `main.ts` (dev console: `[IdleCraftEngine] WebGPU available: true/false (reason)`). This is **diagnostic only** — it does **not** select WebGPU for the game canvas.
- **Actual rendering:** `createRendererAsync` in `createIdleWebGLRenderer.ts` always constructs **`THREE.WebGLRenderer`**. Comments note EmpireEngine’s factory pulls `three/webgpu` and can duplicate Three builds if used from the main app bundle.

### 4.2 What is *not* implemented

- No `WebGPURenderer` / `three/webgpu` path in Idle Craft’s `CharacterScenePreview` or `createIdleWebGLRenderer`.
- No TSL/node-material migration for dock materials; existing wind uses **WebGL `onBeforeCompile`** string injection — that stack is **not** portable to WebGPU without a rewrite (TSL or custom nodes).
- Post-processing, shadows, and some material features still have **gaps or differences** in Three’s WebGPU backend; migrating would be a dedicated project.

### 4.3 Suggested direction if “full WebGPU” is a goal

1. **Isolate** a second entry or feature flag that uses `WebGPURenderer` only after scene graph and materials are audited.
2. **Replace** `onBeforeCompile` wind with a WebGPU-safe approach (e.g. TSL displacement, or CPU/morph on foliage-only meshes).
3. **Keep** `empire-engine/lpca` import path as today (`idleCraftEngine` comment) to avoid pulling `three/webgpu` into the default bundle until ready.
4. Re-run **compat** logging on target GPUs; treat XR and some post effects as unsupported on WebGPU until Three version catches up.

---

## 5. Checklist for the next agent

- [ ] Read `.agent/00_READ_FIRST.md`, `AGENT_CONTEXT.md`, `project.json`, `scenes/main.json`, `LEARNINGS.md` per workspace rules.
- [ ] After wind/material changes: run `npm run build`; watch console for WebGL program errors on first `warmRenderPipeline` / first frame.
- [ ] If users report blank 3D: ask about **shared materials** + **cloneMaterialsForVegetationWind** and **vertex uniform declarations**.
- [ ] Do not reintroduce `installVegetationWindOnMergedGroup(entireNightMagicRoot)` without skipping instanced meshes and without material clones on merged batches.

---

## 6. Related docs

- `docs/DAYNIGHT_WEATHER_GOE_PLAN.md` — day/night / weather direction
- `docs/WORLD_TERRAIN_WATER_DAYNIGHT_PLAN.md` — terrain / water
- `docs/LPCA_IDLE_CRAFT_REFERENCE.md` — LPCA conventions
- `LEARNINGS.md` — short dated entries; see new entry linking here
