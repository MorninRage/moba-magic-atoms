# Idle Craft — World, Terrain, Creek Network, Weather & Day/Night (Master Plan)

**Status:** Planning document (implementation follows this order)  
**Date:** 2026-04-12  
**Audience:** You + AI implementers — iterate together; neither polish nor correctness alone.

**Primary research (read before building):**

| Doc | Path |
|-----|------|
| LPCA pipeline | `C:/EmpireEditor/docs/LPCA_UNIFIED_PIPELINE.md`, `LPCA_METHOD.md` |
| Terrain plan | `C:/EmpireEditor/docs/LPCA_TERRAIN_PLAN.md` |
| Day / night | `C:/EmpireEditor/docs/DAY_NIGHT_CYCLE_SYSTEM.md` |
| Day/night + weather + GoE parity (Idle Craft plan) | [DAYNIGHT_WEATHER_GOE_PLAN.md](./DAYNIGHT_WEATHER_GOE_PLAN.md) |
| Weather + hydrology + water integration | `C:/EmpireEditor/docs/WEATHER_SYSTEM_DESIGN.md` |
| Puddle / stream studies | `C:/EmpireEditor/docs/LPCA_PUDDLE_STREAM_STUDY.md`, `LPCA_STORM_GROUND_SPLASH_STUDY.md` (if present) |
| Reference code pointers | `C:/EmpireEditor/docs/REFERENCE_SYSTEMS.md` → `GameofEmpires/src/systems/DayNightCycle.ts`, `WeatherSystem.ts`, `TerrainGenerator.ts`, `ParticleSystem.ts` |

**EmpireEngine (this repo’s dependency):** `getWaterPlaneMaterial()` + procedural water normal in `empire-engine/lpca` (`LPCAFoundation.ts`, `ProceduralTextures.ts`) — use for **river / creek surfaces** the same way GoE uses the water plane material stack (PBR water + normal map, no imported textures).

---

## 1. Objectives

1. **Larger world footprint** — ~8× the current dock “turf” extent (baseline: `CircleGeometry(5.5)` in `forestEnvironment.ts` → define linear8× as default unless design says area-8×).
2. **LPCA terrain** — elevation variation, **ground depth** (visible substrate / skirt, not a single thin disc), merged meshes where possible.
3. **Creek + tributaries** — a readable **main stem** and **2+ tributaries**, **always flowing** (animated surface), sitting in **carved lows** of the heightfield.
4. **Water techniques aligned with Game of Empires** — same *categories* as `WEATHER_SYSTEM_DESIGN.md` and GoE `TerrainGenerator` / `WeatherSystem` integration (not necessarily line-for-line port on first pass):
   - **Global / storm-driven water level** (`surfaceWater` → offset or uniform on water / terrain wetness).
   - **MAT_WATER / `getWaterPlaneMaterial()`**-class surface (shallow/deep tint, transmission, procedural normal).
   - **Rain → splash** on water via `hitWater` / `isWaterAt` pattern.
   - **Wind** affecting rain drift (and later foliage if any).
   - Optional **puddles / rivulets** on slopes after rain (thin Phase E — see §6).
5. **Day / night cycle** — time-driven sun, ambient + key light, fog, sky read; storm dimming hooks from weather.
6. **Hydrological cycle (phased)** — dual ground model (`surfaceWater`, `soilSaturation`) when you move beyond cosmetic weather.

---

## 2. Current baseline (Idle Craft)

- **Environment:** `src/visual/forestEnvironment.ts` — skydome, small ground disc, fog, LPCA trees/shrubs; **not** driven by `project.json` terrain block yet.
- **Config:** `project.json` has `time`, `weather`; character dock does not yet drive full atmosphere.
- **Gap:** No heightfield, no water network, no GoE-style `TerrainGenerator.setStormWaterOffset` analogue.

---

## 3. LPCA methodology (non-negotiable)

Follow **Research → Schematic → Build (layer-by-layer) → Materials → mergeByMaterial → Integrate** (`LPCA_UNIFIED_PIPELINE.md`).

**Terrain layer order (recommended):**

1. **Substrate / depth** — underside or vertical rim (soil tone), merged.
2. **Land surface** — displaced mesh (heightfield from code).
3. **Carved hydrology** — lower height along creek/tributary **buffer zones** (valley floors).
4. **Bank detail** — sparse rocks / grass clumps, merged by material.
5. **Water surfaces** — ribbons / planes using **EmpireEngine water material**; flow in shader or UV scroll.

---

## 4. Schematic: map, height, creek network

### 4.1 Scale

Choose **R0** = current visual turf radius (~5.5). **Default 8×:** **R = 44** (linear). If you prefer **area 8×**, radius is **5.5 * sqrt(8)** (about **15.6**) — **pick one** and document in `project.json`.

### 4.2 Heightfield

- **Macro:** 1–2 low-frequency components (broad swells) + **mid** FBM for natural variation.
- **Micro:** optional vertex color / detail noise (slope darkening, fringe).
- **Amplitude:** keep peaks modest so gather props, avatar, and camera framing still work (tune in-engine).

### 4.3 Creek + tributaries (authoring)

- **Data-driven polylines** in `project.json` (or `scenes/main.json`) e.g.:

  ```json
  "hydrology": {
    "creeks": [
      { "id": "main", "points": [[x,z], ...], "width": 0.35, "depth": 0.12 },
      { "id": "north_fork", "points": [[x,z], ...], "join": "main", "joinT": 0.42 }
    ]
  }
  ```

- **Join rules:** tributaries terminate on the main stem at a parameterized **T** along the main polyline; **flow direction** = downstream along decreasing elevation or fixed **graph direction** (designer-authored “downhill”).
- **Terrain carve:** for each polyline, **lower** height samples within radius **w_carve > water half-width** (smooth falloff: smoothstep / cosine).
- **Sampling:** implement `getHeightAt(x, z)` used for trees, props, and water **y** placement.

### 4.4 Flowing water (same *techniques* as Game of Empires)

| Technique | GoE reference (conceptual) | Idle Craft application |
|-----------|---------------------------|------------------------|
| Water surface material | `getWaterPlaneMaterial` / `waterClear` + procedural **water** normal map | Import `getWaterPlaneMaterial()` from `empire-engine/lpca`; one material instance; tune `normalScale`, IOR, attenuation |
| Surface motion | Shader time / UV offset / vertex ripple (GoE water plane + storm offset) | **Custom ShaderMaterial** extending same look, **or** `onBeforeCompile` patch on physical water; uniforms: `u_time`, `u_flowDir` (2D), `u_flowSpeed`, `u_stormWater` |
| River fill level | `TerrainGenerator.setStormWaterOffset(surfaceWater)` | **Dock-scale:** single `waterLevelOffset` from weather state lerped each frame; drives water mesh Y and optional **uniform** on terrain for wet banks |
| Rain on water | `isWaterAt` + `triggerSplashBurst` | Register creek ribbons in **`isWaterAt`**; pipe to particle splash when you add rain |
| Streams / rivulets | Winding `ShapeGeometry`, organic edges (`WEATHER_SYSTEM_DESIGN.md` §4) | **Tributaries** can use **narrow ribbon meshes** with same water shader; width noise for organic edge |

**Flow direction:** per-segment, **tangent** of polyline × downstream sign → pass to shader as **world-space flow vector** (XZ) for normal scrolling and foam hints.

### 4.5 Tributary topology (perennial creek)

- Build a **directed graph**: each creek has `downstreamId` or terminates at map edge / sink; **tributaries** are leaf-to-root toward the **main stem**.
- **Confluences:** at join, widen main channel slightly (blend width over 2–3 m) so the read is “two streams meet” not “Z-fight spike”.
- **Elevation:** enforce **monotone downhill** along each polyline after carve (post-process heights or author polylines with `sampleHeight` checks) so flow direction matches visuals.
- **Perennial vs storm:** baseline plan is **always-on** surface (small constant flow); **storm** adds `surfaceWater`-driven **level rise** and faster normal scroll / ripple amplitude (same uniform stack as GoE `setStormWaterOffset`).

### 4.6 Porting note (GameofEmpires on disk)

When `C:\GameofEmpires` (or your install path) exists, treat these as **source of truth** for water behavior and copy **interfaces**, not necessarily full map scale:

| GoE module | Reuse for Idle Craft |
|------------|---------------------|
| `TerrainGenerator.ts` | Water plane Y / `uStormWaterOffset`, `isWaterAt`, height sampling contract |
| `WeatherSystem.ts` | Dual-ground state, `waterLevel` formula (scaled to dock relief), cloud/rain/wind hooks |
| `ParticleSystem.ts` | Rain teardrop, `onLand`, `hitWater`, `triggerSplashBurst` |
| `DayNightCycle.ts` | Sun dir, fog, exposure, `stormDim` from weather |

If the repo is **not** present, implement from `WEATHER_SYSTEM_DESIGN.md` + `getWaterPlaneMaterial()` only; behavior should still match the **documented** GoE model.

---

## 5. Phased implementation

### Phase A — Project contract

- Add **`terrain`**, **`hydrology`**, optional **`environment`** (`timeScale`, fog limits) to `project.json`.
- Extend `fetchEmpireProject` / types as needed.
- **Single loader** that produces immutable **CreekNetwork** + height sampler config.

### Phase B — LPCA terrain + depth + carve

- Replace flat disc with **displaced surface** + **substrate skirt** (merged draw calls).
- Implement **polyline carve** + `getHeightAt`.
- **Re-scatter** trees/shrubs using height samples; push ring toward new **R**; cap count.

### Phase C — Water meshes (creek + tributaries)

- Build **centerline ribbons** (strip geometry or extruded shapes) per segment; **join** tributaries without z-fighting (small Y bias or stencil not needed if widths differ).
- Assign **EmpireEngine water material** + **flow uniforms**; verify in **WebGL** path used by Idle Craft.
- **Bank transition:** slightly darker / wetter material near carve (vertex color or decal mesh).

### Phase D — Day / night

- **MVP:** `time` → sun direction, directional + hemisphere + fog + exposure bounds.
- **Advanced:** LPCA sky dome shader (`DAY_NIGHT_CYCLE_SYSTEM.md`); cloud `renderOrder` vs sun/moon.
- Expose **`stormDim`** from weather for sky uniform when clouds ramp up.

### Phase E — Weather + hydrology (GoE-aligned)

1. **Thin weather:** `project.weather` + internal clock → cloud cover, rain intensity, wind vector, `surfaceWater` proxy.
2. **Water level:** `waterLevel = f(globalReliefDock, surfaceWater)` — dock-scale analogue of `WEATHER_SYSTEM_DESIGN.md` §6 (one-time min/max height scan on terrain build).
3. **Dual ground:** humidity ↔ clouds ↔ rain ↔ infiltration/runoff (full state machine optional).
4. **Particles:** rain + **splash** on `isWaterAt`; wind drift.
5. **Optional:** puddles in local depressions; **organic rivulets** on slopes (GoE-style `ShapeGeometry`) after rain.

### Phase F — Integration & perf

- **`CharacterScenePreview`:** `environment.update(dt)` in existing loop; dispose cleanly.
- **Post-processing:** ensure water renders correctly through `PostProcessingStack` when enabled.
- **Lobby stage:** minimal or shared lighting only.

---

## 6. Creek-specific risks & mitigations

| Risk | Mitigation |
|------|------------|
| Z-fight water / terrain | Slight Y offset; polygonOffset; carve deeper than water surface |
| Flow looks “sliding” wrong | Flow vector from polyline tangent; test downstream arrow in debug |
| Too many water draw calls | Merge strips per material; limit tributary count |
| Shader cost on water | Single shared material; cap ripple frequencies |
| Editor hot-reload | Rebuild height + water meshes when `project.json` changes |

---

## 7. Verification checklist

- [ ] Creek visible from default camera; tributaries read as joining main stem.
- [ ] Surface shows **continuous motion** along stream direction.
- [ ] Storm / dry changes **water level** or wetness (however implemented in Phase E).
- [ ] Rain produces **splash** on creek (when rain exists).
- [ ] Dawn / midday / dusk / night read clearly; no blown exposure.
- [ ] `npm run build` passes; frame time acceptable on target hardware.

---

## 8. Open decisions (fill before coding)

1. **8× linear vs area** — default proposal: **linear 8×** (radius 44).
2. **Time source** — editor `project.time` only vs continuous simulation in game loop.
3. **GoE code availability** — if `C:\GameofEmpires` is installed, **diff** `TerrainGenerator` / `WeatherSystem` for water uniforms and storm offset; otherwise implement from `WEATHER_SYSTEM_DESIGN.md` only.
4. **Scope of first ship** — creek + flow + day/night **before** full dual-ground FSM, or parallel thin weather only.

---

## 9. Related internal doc

- `docs/IDLE_CRAFT_ENGINE_AND_LPCA_ROADMAP.md` — engine bridge context; keep in sync when world systems land.
