# Idle Craft — Day/Night, Scene Lighting & Hydrology (GoE-Aligned Plan)

**Mode:** Planning document — implementation follows phases below.  
**Date:** 2026-04-12  
**Audience:** You + implementers; iterate on thresholds together after each phase.

**Related docs**

| Doc | Role |
|-----|------|
| [WORLD_TERRAIN_WATER_DAYNIGHT_PLAN.md](./WORLD_TERRAIN_WATER_DAYNIGHT_PLAN.md) | Terrain, creeks, water materials, phased world build |
| `C:/EmpireEditor/docs/DAY_NIGHT_CYCLE_SYSTEM.md` | Game of Empires (GoE) canonical day/night spec |
| `C:/EmpireEditor/docs/REFERENCE_SYSTEMS.md` | Pointers to `DayNightCycle.ts`, `WeatherSystem.ts` |
| `C:/EmpireEditor/docs/WEATHER_SYSTEM_DESIGN.md` | Weather + hydrology concepts (when present) |

**Sky v1 (unified procedural):** Dock sky is **one** full-sphere mesh (`createUnifiedSkyDomeMesh` in `src/visual/idleCraftSkyStack.ts`): gradient, aurora (3D noise only — no azimuth seam), and clouds in one opaque shader; the lower cavity lerps to `uHorizon` so there is no open “bowl” hole at the rim. Stars, moon, and plasma sun are unchanged. `environment.sky` in `project.json` is reserved / ignored by the forest attach path. Optional later: fullscreen sky pass or precomputed scattering.

---

## 1. Objectives

1. **Daylight that reads “normal”** — Midday holds at full intensity long enough to feel like a real day; **twilight compresses** into a distinct sunset → dusk transition (red/orange sky, purple opposite limb).
2. **Night that reads “full”** — Stars, moon disc + fill (directional and/or moon-attached light), faster transition into night acceptable if night content is rich.
3. **Lighting without fake ground sources** — Remove or strictly gate **world-fixed warm point lights** near the ground; scene read should come from **sun/moon/hemi/ambient**, **torch/campfire**, and weather.
4. **Hydrological cycle** — **Random rain periods** (duration, gap, intensity) driving `stormDim`, `surfaceWater`, fog/sky, and later particles + water splashes (`isWaterAt`).
5. **GoE parity where sensible** — Reuse *structure* (time periods, layer order, fog/light sync), not necessarily full map-scale systems.

---

## 2. GoE reference summary (what we’re aligning to)

From **`DAY_NIGHT_CYCLE_SYSTEM.md`**:

| Area | GoE pattern |
|------|-------------|
| Sky | LPCA **shader dome**: Rayleigh + Mie, sunset/sunrise bands, night gradient, `u_stormDim`; `scene.background = null` |
| Layers | **renderOrder**: sky → stars (2× Points) → sun/moon meshes → **cloud dome** on top. **Idle Craft:** `idleCraftSkyStack.ts` — **upper-hemisphere sky dome** (LPCA shader: gradient + aurora; rim at horizon, not a full sphere below ground) + **upper-hemisphere cloud dome** (slightly larger radius; over celestials; can dim sun). |
| Time | **Named periods** with different lengths (midday plateau, sunset 17:30–19:00, dusk purple, etc.) — not one smoothstep on sun height |
| Sun | Directional: **0 at night**, ramped dawn, **plateau midday**, sunset fade; warm → orange |
| Moon | Mesh + **phase**; **`PointLight` on moon** (cool, × elevation × illumination) |
| Ambient | Low at night; **moon phase** adds fill (new vs full moon) |
| Stars | Two layers, opacity **time windows** (fade in evening) |
| Fog | Synced to sky palette; **tighter** at night |
| Torch | **Player-height** point light when very dark — not foot-level scene fill |

From **`REFERENCE_SYSTEMS.md`** / world plan:

- **`WeatherSystem`**: rain/snow, particles, intensity for post FX  
- **`TerrainGenerator`**: `surfaceWater` / storm water offset, `isWaterAt`  
- **`DayNightCycle`**: sun dir, fog, exposure, `stormDim` from weather  

---

## 3. Current Idle Craft baseline (gaps)

| Piece | Today | Gap |
|--------|--------|-----|
| Day curve | `dayMix = smoothstep(sunH, -0.12, 0.35)` + `hourPerRealSecond` | **No long midday plateau**; sun spends little time at “full day” |
| Sunset / red sky | Fog + hemi; **canvas skydome** mostly static | Weak **horizon sunset band** and **dusk** opposite limb |
| Stars | None | No GoE-style night sky |
| Moon | Directional moon + simple far disc | Optional **phase mesh**, **moon point fill**, billboard polish |
| Ground lights | **`rim` + `groundFill` PointLights** in `characterScenePreview.ts` | Read as **artificial fill on/near ground** — remove or strictly gate |
| Weather | Static `project.json` `weather` | **No random rain** or runtime hydrology |
| Hydrology data | `hydrology.creeks` + carve + ribbons | **No** storm-driven `surfaceWater` animation or rain coupling |

---

## 4. Phased implementation plan

### Phase A — Time model & periods (fixes “day too short”)

**Goal:** Decouple “how fast the clock runs” from “how long midday *feels*.”

- Introduce **`idleCraftDayPeriods.ts`** (or equivalent) that maps `simHour` →:
  - `dayMix` (with **extended plateau** near solar noon)
  - `sunsetMix`, `duskMix`, `nightMix` (or a small enum `TimePeriod`)
  - `starOpacity` schedule (fade in/out windows, GoE-inspired)
- Optionally: **separate** real-time scale for **twilight** vs **midday** via curve shaping (not only lowering `hourPerRealSecond` globally).
- **Acceptance:** Midday holds near full directional + fog “day” values for a **documented** in-game hour band; sunset/dusk transition is **narrower** in hours than midday.

**Files (expected):** new `src/world/idleCraftDayPeriods.ts`; wire into `IdleCraftDockEnvironment.update`.

---

### Phase B — Sky & sunset (GoE “lite”)

**Goal:** Red/orange **sunset** and **purple dusk** without full GoE shader port on day one.

- **v1:** Extend **canvas skydome** with time-driven gradients / blobs (sun low → warm rim) **or** add a **small ShaderMaterial** sphere with uniforms: `sunDir`, `sunElevation`, `nightFactor`, `stormDim`, sunset band strength.
- **v2:** Match GoE **renderOrder** sketch when clouds exist: sky → stars → celestials → clouds.
- **Acceptance:** Visible **warm horizon** at sunset; **cool/purple** read in opposite sky; fog color **lerps from same palette** as sky (see GoE legacy palette table in `DAY_NIGHT_CYCLE_SYSTEM.md`).

**Files (expected):** `forestEnvironment.ts` and/or new `src/visual/idleCraftSkyDome.ts`.

---

### Phase C — Stars & moon

**Goal:** Full night read.

- **Stars:** 2× `THREE.Points` (bright + dim), upper hemisphere, `sizeAttenuation: false`, opacity from Phase A; `renderOrder` below future cloud layer.
- **Moon:** Keep **moon directional** for shadows; enhance **disc** (emissive / phase optional); consider **PointLight** on moon path × elevation × phase (GoE pattern).
- **Acceptance:** Stars visible when `starOpacity > 0`; moon reads as primary night celestial; torch still matters on darkest nights if phase is low (future).

**Files (expected):** `idleCraftDockEnvironment.ts`, possible `idleCraftStars.ts`.

---

### Phase D — Lighting cleanup (remove wrong ground sources)

**Goal:** No unexplained warm lights on the turf.

- **Remove** or **zero by default** `rim` / `groundFill` **world** `PointLight`s in `characterScenePreview.ts`, **or**:
  - drive intensity to **0** in daylight and at night except **camera-attached** or **UI-hover-only** micro-accent; never as primary ground fill.
- Compensate with **hemi/ambient curves** (GoE tables) + moon directional + torch.
- **Acceptance:** Scene at noon/midnight looks lit only by documented sources; no fixed warm pool near camp unless it’s a **campfire/torch** prop.

**Files (expected):** `characterScenePreview.ts`, possibly `idleCraftDockEnvironment.ts`.

---

### Phase E — Weather runtime & hydrological cycle

**Goal:** **Random rain** and wet/dry driving visuals and water level.

- New **`IdleCraftWeatherRuntime`** (or extension of dock env): internal state `{ type, intensity, phaseRemaining, nextEventIn }`.
- **RNG:** Random **inter-storm gap** and **storm duration** (tunable min/max); smooth **fade in/out** of `intensity`.
- **Outputs:**
  - `stormDim` → sky shader + fog (existing pattern in `IdleCraftDockEnvironment`)
  - `surfaceWater` lerp dry ↔ wet (`readEnvironmentConfig` + project overrides)
  - Water ribbon **Y** or **shader uniform** (per `WORLD_TERRAIN_WATER_DAYNIGHT_PLAN.md` §4)
- **Later:** Rain particles + **`isWaterAt`** splashes (GoE `ParticleSystem` patterns).
- **Optional:** Persist weather state in save.
- **Acceptance:** Over multiple real minutes, player sees **clear → rain → clear** without manual `project.json` edits.

**Files (expected):** new `src/world/idleCraftWeatherRuntime.ts` (or `gameStore` tick); `idleCraftDockEnvironment.ts`; `gameStore.ts` if persistence.

---

### Phase F — Post-processing & exposure

**Goal:** Match mood to period (GoE / `FULL_ENGINE_PIPELINE.md`).

- Tie **`toneMappingExposure`** (and optional bloom) to **period** + `stormDim`.
- **Acceptance:** Blue hour / storm reads darker and controlled; noon not blown out.

**Files (expected):** `characterScenePreview.ts` (renderer), `postProcessingFromProject` if needed.

---

### Phase G — Documentation & parity checklist

- Update **`WORLD_TERRAIN_WATER_DAYNIGHT_PLAN.md`** Phase D/E with links to this doc and **period table** once frozen.
- Maintain a **GoE parity table** (below) in this file or in agent context.

---

## 5. GoE parity checklist (living)

| Item | GoE | Idle Craft target |
|------|-----|-------------------|
| Shader sky dome | Full | Phase B v1→v2 |
| Cloud layer over celestials | Yes | Phase B v2 + Weather |
| Discrete time periods | Yes | Phase A |
| Sun directional curve | Tabulated | Phase A |
| Moon phase | Yes | Phase C (optional v2) |
| Moon point light | Yes | Phase C |
| Stars (2 layers) | Yes | Phase C |
| Fog ↔ sky sync | Yes | Phase A–B |
| Night tighter fog | Yes | Tune in env |
| `stormDim` in sky | Yes | Partial today → Phase E |
| Random storms | WeatherSystem | Phase E |
| No fake ground fill | N/A | Phase D |
| Torch at player height | Yes | Already hand torch; verify vs GoE “very dark” |

---

## 6. Recommended execution order

1. **Phase A + D** — Largest perceived improvement: **day curve** + **remove gate ground lights**.  
2. **Phase C** — Stars + moon polish.  
3. **Phase B** — Sunset / dusk sky.  
4. **Phase E** — Random rain + `surfaceWater`.  
5. **Phase F** — Exposure polish.

---

## 7. Risks & notes

- **Performance:** Stars = 2 draw calls; shader sky = 1; keep allocations out of the frame loop (GoE preallocates colors).  
- **Multiplayer / dock:** Weather state should be **deterministic from seed** or **host-authoritative** if online parity matters later.  
- **Balance:** Faster **game** night is OK if **night content** (stars, moon, torch) is strong — tune `hourPerRealSecond` separately from **period curve**.

---

## 8. Open decisions (fill in during implementation)

- [ ] Midday plateau: in-game **hour span** (e.g. 10:00–15:00 at full `dayMix`)?  
- [ ] Sunset/dusk: in-game **hour span** (e.g. 17:30–20:00)?  
- [ ] Rain: average **real-time** between storms? max **duration**?  
- [ ] Remove `rim`/`groundFill` entirely vs **camera-parented** rim only?

---

*End of plan. Next step: implement Phase A + D or adjust §8 with your preferred timings.*
