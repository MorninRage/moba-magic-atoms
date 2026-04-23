# Idle Craft — Plasma Sun & 28-Day Lunar Cycle (LPCA Plan)

**Mode:** Planning document — implement only after this plan is reviewed.  
**Date:** 2026-04-12  
**Audience:** You + implementers; tune visuals per phase.

**Related docs**

| Doc | Role |
|-----|------|
| [DAYNIGHT_WEATHER_GOE_PLAN.md](./DAYNIGHT_WEATHER_GOE_PLAN.md) | Day/night periods, fog, stars, moon baseline |
| [WORLD_TERRAIN_WATER_DAYNIGHT_PLAN.md](./WORLD_TERRAIN_WATER_DAYNIGHT_PLAN.md) | World / env integration |
| [LPCA_IDLE_CRAFT_REFERENCE.md](./LPCA_IDLE_CRAFT_REFERENCE.md) | LPCA usage in this repo |
| `C:/EmpireEditor/docs/LPCA_UNIFIED_PIPELINE.md` | Schematic → layers → materials → merge → integrate |
| `C:/EmpireEditor/docs/FULL_ENGINE_PIPELINE.md` | Bloom, exposure, post stack (plasma sun tuning) |

**Code touchpoints (today)**

| File | Role |
|------|------|
| `src/world/idleCraftDockEnvironment.ts` | `simHour`, sun/moon dirs, moon mesh, lights, skydome tick |
| `src/world/idleCraftSkyPaint.ts` | Canvas sun (radial gradients) |
| `src/world/idleCraftDayPeriods.ts` | `dayMix`, night, sunset, dusk (no lunar calendar) |
| `src/world/idleCraftWorldTypes.ts` | `readEnvironmentConfig` — optional new lunar/plasma keys |

---

## 1. Objectives

1. **Plasma sun (sci-fi, not generic)** — Procedural, layered “fusion shell” read: filaments, corona, non-stock orange disc; LPCA-friendly (code-driven, minimal texture reliance).
2. **Moon follows a 28-“day” synodic-style cycle** — **One full simulated day–night cycle (24h `simHour`) advances the lunar phase by exactly 1/28 of a full cycle.** After **28** such days, the moon has completed **one** wax/wane loop (new → waxing → full → waning → new).
3. **Phase-visible sky** — Wax/wane, full, and new read clearly (shader lighting + optional earthshine); moon position consistent with sun direction and phase (no permanent `simHour + 12` “always full” cheat).
4. **Performance** — Web-friendly: at most one extra additive sun draw + shader moon; no heavy raymarch in v1.

---

## 2. Time model: coupling lunar phase to day–night

### 2.1 Definitions

- **`simHour`** — 0–24, one **simulated day** from midnight to midnight (same as today in `IdleCraftDockEnvironment`).
- **`simDayIndex`** — Integer count of **completed** full days since session start (or since a configurable epoch — see §6).
- **lunarPhase** — Scalar in **[0, 1)** wrapping: **0 = new moon**, **0.25 = first quarter**, **0.5 = full moon**, **0.75 = last quarter**, approaching **1** back to new.

### 2.2 Advance rule (your requirement)

Each time the game completes **one** full **24h** cycle (day → night → back to the same `simHour` origin, or a defined **midnight crossing**), advance lunar phase by **1/28**:

```
lunarPhase = (simDayIndex mod 28) / 28
```

Equivalently, maintain a fractional accumulator:

```
lunarPhaseAccum += simHourDelta / (24 * 28)
lunarPhase = lunarPhaseAccum mod 1
```

Prefer **midnight-crossing detection** or **unwrapped `totalSimHours`** so wrapping `simHour` in `[0,24)` does not lose progress:

- Track `totalSimHours` (monotonic, float) += `dt * hourPerRealSecond` when time flows, **or** increment `simDayIndex` whenever `simHour` crosses **0** going forward (with epsilon for float noise).

### 2.3 Moon direction from phase

Replace the fixed **`computeSunDirection(simHour + 12)`** with a direction derived from **`sunDir`** and **`lunarPhase`** so that:

- **New moon** — Moon near **sun** (same side of sky; often daylight / invisible).
- **Full moon** — Moon near **opposite** sun (rises around sunset).

Minimal art-directable mapping (v1):

- Build `moonDir` by rotating `sunDir` about **world up** (or a fixed **ecliptic tilt axis**) by angle **`2π * lunarPhase`** (phase 0 aligned with sun, 0.5 opposite).
- Optionally add small fixed tilt so the path is not coplanar with the solar arc.

Lighting on the moon mesh uses the **same sun direction** as the key light so **N·L** produces crescent / gibbous without a phase texture.

---

## 3. LPCA workflow (both celestial bodies)

Follow **`LPCA_UNIFIED_PIPELINE.md`**: **Research → Schematic → Build (layer-by-layer) → Materials → Merge → Integrate.**

### 3.1 Plasma sun — layers (schematic)

| Layer | Intent |
|-------|--------|
| L0 Orientation | **“Helios conduit”** — stabilized fusion, readable sci-fi silhouette |
| L1 Core | Bright core disc (controlled HDR / tone map discipline) |
| L2 Corona shell | Inverse-square falloff, additive rim |
| L3 Filaments | 2–3 octaves procedural noise, slow temporal drift (`celestialTime`) |
| L4 Polar / aniso accents | Cheap directional warp (not generic radial-only glow) |
| L5 Weather merge | Scale intensity with `stormDim`, `dayMix` (dimmed, not removed) |

**Implementation bias:** Hybrid — keep **canvas skydome** for broad gradient/clouds; move **sun disk + corona** to a **small Three.js mesh** (`ShaderMaterial`, additive, `depthWrite: false`) to escape “generic radial gradient” look. Reduce or remove overlapping sun paint in `idleCraftSkyPaint.ts` once the mesh reads well.

### 3.2 Moon — layers (schematic)

| Layer | Intent |
|-------|--------|
| L0 Orientation | **“Silver regulator”** — cool base, subtle violet rim |
| L1 Sphere / disc | Same far shell concept as today; optional slightly higher segment count for silhouette |
| L2 Albedo variation | Low-frequency procedural noise (maria) |
| L3 Phase lighting | Diffuse N·L from sun + **earthshine** on dark limb |
| L4 Specular | Tight sun glint, phase-aware |
| L5 Calendar merge | `lunarPhase` drives orbit angle; visibility rules respect `nightMix` / elevation |

---

## 4. Implementation phases (ordered)

### Phase A — Lunar calendar + moon motion (no new shaders yet)

1. Add **`totalSimHours`** or **`simDayIndex` + midnight detection** in `idleCraftDockEnvironment` (or small helper module e.g. `idleCraftLunarPhase.ts`).
2. Compute **`lunarPhase`** from §2.2; expose for debug HUD if useful.
3. Replace **`computeSunDirection(simHour + 12)`** with **`moonDir(sunDir, lunarPhase)`** per §2.3.
4. Keep existing `MeshBasicMaterial` temporarily; verify **full** near phase 0.5 and **thin/near sun** near phase 0.

**Exit criteria:** Over 28 fast-forwarded days, phase ticks 1/28 per day; moon crosses expected sky positions.

### Phase B — Moon shader (wax / wane / full / new)

1. Replace moon material with **`ShaderMaterial`**: normals from sphere, **sun direction uniform**, earthshine, noise albedo.
2. Tune edge softness and earthshine so **new moon** is nearly invisible at night when appropriate.
3. Sync uniforms every frame from existing key light / sun direction.

**Exit criteria:** Crescent and gibbous read clearly; full moon reads bright; new moon does not look like a white golf ball.

### Phase C — Plasma sun mesh

1. Add sun mesh (billboard or camera-facing hemisphere) parented or positioned along **`sunDir`** at far distance.
2. Implement fragment shader: core + corona + filaments + slow animation; **additive** blend.
3. In `idleCraftSkyPaint.ts`, **disable or shrink** canvas sun so there is a **single** dominant sun read.
4. Tie brightness caps to **`getExposureMultiplier()`** / storm so bloom does not clip the whole frame.

**Exit criteria:** Distinct non-generic sun; acceptable cost on integrated GPU.

### Phase D — Skydome + ordering polish

1. Confirm draw order: skydome → stars → **moon** → **additive sun** (align with GoE layer notes in `DAYNIGHT_WEATHER_GOE_PLAN.md`).
2. Ensure fog / `stormDim` still match mood.

### Phase E — Config & persistence (optional but recommended)

1. Extend `IdleCraftEnvironmentConfig` / `project.json` (see §6).
2. Document behavior when **`project.time`** jumps (snap vs interpolate phase).

### Phase F — Knowledge capture

1. Short entry in `LEARNINGS.md`: lunar–day coupling, midnight detection, render order.

---

## 5. Edge cases & decisions

| Topic | Decision to document in code comments |
|-------|----------------------------------------|
| `hourPerRealSecond === 0` and only `project.time` | Derive phase from **`project.time`** if a **day counter** exists; else **freeze** phase or derive from **integer day field** when added |
| `simHour` wrap | Never infer days from wrapped hour alone without **crossing counter** |
| Loading save | **`lunarPhaseOffset`** or **`simDayIndex`** in save/project so phase is reproducible |
| Double sun | Canvas + mesh — **only one** primary disk |

---

## 6. Config knobs (proposal)

| Key | Default | Purpose |
|-----|---------|---------|
| `environment.lunarCycleDays` | `28` | Days per full phase loop |
| `environment.lunarPhase0` | `0` | Starting phase [0,1) for new worlds |
| `environment.plasmaSunEnabled` | `true` | Toggle mesh sun |
| `environment.eclipticTiltDeg` | small | Art tilt for moon path |

---

## 7. Verification checklist

- [ ] Advance **28** simulated days → phase returns to start (wrap).
- [ ] Phase **0.5** + night: moon reads **full**; phase **0** / **~0**: **new** / thin.
- [ ] Sun reads **plasma / sci-fi** at midday; **storms** tame corona.
- [ ] `npm run build` clean; no extra texture assets required for v1.

---

## 8. Out of scope (v1)

- Physically accurate precomputed atmospheric scattering (Bruneton-style).
- True ephemeris / inclined orbit moon rise tables.
- Ray-marched volumetric corona.

---

*Next step after approval: implement **Phase A** only, then review motion before Phase B.*
