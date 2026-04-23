# Session 2026-04-19 — Ground-level lighting overhaul (Phase 8i)

**Plan source:** [docs/GROUND_LEVEL_LIGHTING_OVERHAUL_PLAN.md](GROUND_LEVEL_LIGHTING_OVERHAUL_PLAN.md)
**Companion:** [LEARNINGS.md "Ground-level lighting overhaul"](../LEARNINGS.md), [PLAN.md Phase 8i](../PLAN.md).

## TL;DR — what shipped

All 8 phases from the lighting overhaul plan, in the recommended ship order:

| Order | Phase | What | Files |
|-------|-------|------|-------|
| 1 | §8 | Bloom tuning + magic emissive bumps | `project.json`, `magicProjectiles.ts` |
| 2 | §5 | Horizon-matched fog colors | `idleCraftDockEnvironment.ts` |
| 3 | §1 | PMREM IBL from gradient sky | `idleCraftDockEnvironment.ts`, `characterScenePreview.ts` |
| 4 | §2 | Camera-relative fill light | `characterScenePreview.ts`, `idleCraftDockEnvironment.ts` |
| 5 | §4 | Night-grade post-process pass | `nightGradePass.ts` (new), `characterScenePreview.ts`, `idleCraftDockEnvironment.ts` |
| 6 | §3 | Half-Lambert wrap on hero materials | `halfLambertLighting.ts` (new), `characterScenePreview.ts`, `pveEnemyLPCA.ts` |
| 7 | §7 | Eye-adaptation lite | `idleCraftDockEnvironment.ts` |
| 8 | §6 | Cone-geometry god-rays | `sunGodRays.ts` (new), `idleCraftDockEnvironment.ts`, `characterScenePreview.ts` |

Type-check is green. All 8 phases compose with the existing `numDirLightShadows` / `numPointLights` / `setPassEnabled` / `onBeforeCompile` invariants from prior LEARNINGS entries.

---

## Phases (in ship order)

### Phase 8 — Bloom tuning + magic emissive bumps

**Before:** `bloomThreshold = 0.05` made everything brighter than 5% bloom. Noon grass blooms, white clouds bloom, bright cabin wood blooms. The magic projectile orb (which IS the thing that should look magical) got lost in the general glow.

**After:** `bloomThreshold = 0.85`, `bloomStrength = 0.45`. Only HDR-bright surfaces bloom. Magic projectile midShell `emissiveIntensity` 0.9 → 1.6, crystal facets 1.6 → 2.4 so they reliably exceed 0.85 in screen-linear space. Reads as "magic" rather than "everything is glowing."

### Phase 5 — Horizon-matched fog colors

**Before:** `scene.fog.color` lerped toward `dayBg` (zenith blue). Distant trees matched the sky-top but felt disconnected from the warm sunset / cool moonlit horizon bands. No atmospheric perspective → character pop suffered.

**After:** Two new private colors on `IdleCraftDockEnvironment`: `horizonWarm = 0xf3c6a0` (peach) and `horizonCool = 0x2a3a5c` (deep cool blue). Per-frame:

```ts
const horizonInfluence = 1.0 - THREE.MathUtils.smoothstep(sun.y, 0.0, 0.45);
if (horizonInfluence > 0.02) {
  this._tmpHorizonFog.copy(this.horizonCool).lerp(this.horizonWarm, sunWarmth);
  this.scene.fog.color.lerp(this._tmpHorizonFog, horizonInfluence * 0.55);
}
```

Sun above 0.45 → tint ≈ 0, sky-zenith match preserved. Sun near horizon → strong warm/cool tint. Plus tightened night fog band (`near × 0.42`, `far × 0.55`) so distant objects desaturate harder at night.

### Phase 1 — PMREM IBL from a gradient sky

**Before:** `scene.environment` was null. Many `MeshPhysicalMaterial`s carried `envMapIntensity` values (0.5–1.1) but had no env map. PBR materials read "plasticky" or "muddy."

**After:** New `IdleCraftDockEnvironment.attachIbl(renderer)` builds a tiny env scene with one inside-out gradient sphere. The shader has 5 uniforms:

- `uZenith` — top-of-sky color
- `uHorizon` — horizon-band color
- `uNadir` — ground-bounce color
- `uSunDir` — sun direction
- `uSunGlow` — warm sun-glow color near sun direction

Per-frame `updateIbl(opts)` syncs uniforms. PMREM regenerates the prefiltered env target every `IBL_REGEN_INTERVAL_MS = 4000`. `scene.environment` swaps to the new texture; previous target is disposed AFTER swap.

**Why a gradient sphere instead of cloning the actual skydome:** the actual skydome has a multi-band shader + cloud occlusion via `renderOrder`. Cloning would risk material-state desync. The 3-color gradient + sun-glow captures the ~5 most important sky directions which is more than enough for IBL specular.

### Phase 2 — Camera-relative fill light

**Before:** Standing with back to sun at noon → avatar silhouette-flat. No camera-relative fill, no IBL specular, no rim. The character merged into the background.

**After:** Phantom `DirectionalLight` allocated once at `_phaseLighting`, parented to `this.camera`. Position `(1.4, 0.6, 0)` = right-shoulder over-the-eye-line, target forward. `castShadow = false` so it doesn't add to the shadow-light count.

Per-frame drive in `IdleCraftDockEnvironment.update`:

```ts
const fillBase = 0.20 * dayMix + 0.10 * nightMix * moonStrength;
this.cameraFillLight.intensity = fillBase * this.lightMul.ambient;
this._tmpFillCol
  .copy(this.colCool)
  .lerp(this.colWarm, sunWarmth * (1 - storm * 0.4))
  .lerp(this.colMoonBase, nightMix * 0.55);
this.cameraFillLight.color.copy(this._tmpFillCol);
```

Color always tracks the sky so the fill never reads as "fake studio light." Player can't pinpoint the source — it just feels right.

### Phase 4 — Night-grade post-process pass

**Before:** Just dimming the moon → "blue daytime in dim form." The brain doesn't read "night."

**After:** New `nightGradePass.ts` exports `createNightGradePass()` and `syncNightGradeUniforms(pass, nightMix, moonIllum)`. The pass is a standard `ShaderPass` injected via `EffectComposer.insertPass` BEFORE the vignette pass. Shader logic:

```glsl
float n = u_nightMix * (1.0 - u_moonIllum * 0.30);
if (n > 0.001) {
  float gray = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(c, vec3(gray), n * 0.45);          // desaturate
  c *= mix(vec3(1.0), vec3(0.85, 0.92, 1.08), n);  // cool tint
  c = pow(c, vec3(mix(1.0, 1.25, n)));        // mid-shadow gamma crush
}
```

Full moon eases the grade by 30 % — full-moon nights stay readable, new-moon nights are the "mysterious dark" extreme.

`pass.enabled = nightMix > 0.05` so it doesn't run at noon. `setPassEnabled` keeps the program in the composer's cache (no first-use compile freeze per LEARNINGS post-stack invariant).

`IdleCraftDockEnvironment` got two new public getters: `getNightMix()` and `getMoonIllum()` — drive the pass uniforms from the same state the dock env already computes.

### Phase 3 — Half-Lambert wrap on hero materials

**Before:** Standard PBR `max(0, dot(N, L))` produces near-black shadow sides on stylized characters/mobs at noon. Avatar shadow side just disappears against bright sky.

**After:** New `installHalfLambertOnMaterial(mat)` and `installHalfLambertOnTree(root)` in `src/visual/halfLambertLighting.ts`. Patches the lighting model via `onBeforeCompile` + `customProgramCacheKey` (mirrors `installVegetationWindOnMaterial` exactly):

```ts
mat.onBeforeCompile = function halfLambertOnBeforeCompile(shader, renderer) {
  prevCompileBound(shader, renderer);
  if (shader.fragmentShader.includes('vec3 irradiance = dotNL * directLight.color;')) {
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec3 irradiance = dotNL * directLight.color;',
      'vec3 irradiance = (pow(dotNL * 0.5 + 0.5, 2.0)) * directLight.color;',
    );
  } else if (shader.fragmentShader.includes('irradiance = dotNL * directLight.color;')) {
    shader.fragmentShader = shader.fragmentShader.replace(
      'irradiance = dotNL * directLight.color;',
      'irradiance = (pow(dotNL * 0.5 + 0.5, 2.0)) * directLight.color;',
    );
  }
};
```

Shadow side never goes pitch-black — it falls off softly toward 0.25 (after squaring). Specular path (`geometry.dotNL`) untouched, so metals still read.

**Applied to:** every player-avatar material (skin, undertunic, jerkin, trim, pants, boots, hair, hat band/top/brim, artisan hair) + every PVE enemy via `installHalfLambertOnTree(root)` after build. Terrain, fog, water deliberately NOT patched — those work better with standard Lambert.

### Phase 7 — Eye-adaptation lite (asymmetric exposure smoothing)

**Before:** `getExposureMultiplier()` returned `(0.82 + dayMix * 0.34) * (1 - storm * 0.22)` per frame. Dawn/dusk had perceptible exposure steps when `dayMix` swept through its smoothstep band.

**After:** Smoothed-toward-target `adaptedExposure`. Asymmetric `tau`: 0.3 s when going brighter (eyes pinch fast), 1.2 s when going darker (eyes adapt slowly to shadow). First-tick snap to target so boot doesn't slow-fade from "neutral" to actual.

Removed obsolete `lastExposureDayMix` / `lastExposureStorm` state fields — they were only used by the old direct path.

### Phase 6 — Cheap cone-geometry god-rays

**Before:** Sun-shaft moments (canopy gaps at sunrise, magic in dust) felt ordinary.

**After:** New `src/visual/sunGodRays.ts` exports `attachSunGodRays(scene)` returning a handle. Builds an open `ConeGeometry(18, 60, 24, 1, true)` translated so apex is at world origin, base extends upward. `MeshBasicMaterial` (additive blending, depth-write off, transparent, double-sided).

Per-frame `update({sunDir, sunDirectFrac, sunWarmth, storm})`:

```ts
if (sunDir.lengthSq() > 1e-6) {
  _scratchQuat.setFromUnitVectors(_scratchUp, sunDir);
  mesh.quaternion.copy(_scratchQuat);
}
mat.opacity = sunDirectFrac * 0.06 * (1 - storm * 0.6);
_scratchTmpCol.copy(_neutralColor).lerp(_peachColor, sunWarmth);
mat.color.copy(_scratchTmpCol);
```

Cost is essentially free — the additive transparent program is one of the most common Three.js shaders, already cached from countless other VFX (orbs, magic projectiles, witch wand halos, etc).

---

## Constraint compliance summary

Every phase was designed to compose with the existing `LEARNINGS.md` invariants. No phase introduces a new `numDirLightShadows` / `numPointLights` count change, no first-use shader compile that wasn't covered by the existing warm pipeline, no shader-hash thrashing.

| Invariant | Phases that could violate | How we avoided it |
|-----------|---------------------------|-------------------|
| `numDirLightShadows` constant | §2 (camera fill light) | New light has `castShadow = false`. |
| `numPointLights` constant | None | No new point lights this pass. |
| `setPassEnabled` not dispose | §4 (night grade) | `pass.enabled = nightMix > 0.05` toggle. Program stays in cache. |
| First-use shader compile | §1 (PMREM), §4 (night grade) | PMREM compile happens during `attachIbl()` in dock attach sequence (boot warm window). NightGrade pass is allocated at composer-build time, program compiles in the existing post-stack warm. |
| Vegetation wind WeakSet pattern | §3 (half-Lambert) | Mirrors that pattern exactly with bumped `customProgramCacheKey`. |

All 8 phases gracefully no-op when their feature is disabled (post stack off, no renderer, no dock env, etc.).

---

## Testing recipe

To verify the overhaul is doing what it should:

1. **PMREM IBL (§1):** load awakened mode, look at the wizard staff orb in different hours — environment reflections should subtly change color (warm at sunset, cool at night, neutral at noon). Before this phase: orb specular was identical regardless of time of day.
2. **Camera fill (§2):** stand at noon with back to sun. Avatar's chest + face should still catch a subtle cool fill. Before: pure silhouette.
3. **Half-Lambert (§3):** put a rat against bright sky — shadow side reads as soft cool grey instead of black silhouette.
4. **Night grade (§4):** screenshot midnight before vs after — after should be visibly desaturated + cool-tinted, not just darker. Magic projectile orbs should still bloom strongly against the darker night.
5. **Horizon fog (§5):** sunset against forest — distant trees should desaturate toward peach instead of zenith blue.
6. **Cone god-rays (§6):** sunrise looking up at sun — soft warm shaft visible angling from sun.
7. **Eye adapt (§7):** rapidly cycle dawn → noon (`setTime(5)` → `setTime(12)` via dev console) — should see smooth ramp, not step.
8. **Bloom (§8):** noon scene should NOT have general glow on grass / cloth. Only the sun disc + magic orbs / lanterns / crystals should bloom.

---

## Pending / future polish

The plan called these out as deferred — listed here for future passes:

- **Cascaded shadow maps (CSM).** Three.js doesn't ship native; current single-cascade is sufficient for the dock's ~50 m radius.
- **Lightmap baking.** 5-8 days of work for static buildings; runtime IBL (§1) gets us most of the win for hours not days.
- **Volumetric froxel fog.** Massive engineering for WebGL2; cone god-rays (§6) cover the "sun shaft" beat for free.
- **Multi-diffuse cel + Genshin shadow ramp + Sobel rim outline.** Half-Lambert (§3) + camera fill (§2) get us 80% of the stylized form. Full toon would be the "art direction asks for it" upgrade.
- **Eye-adaptation via real luminance histogram.** §7 covers the time-of-day step; full luminance adaptation requires 1×1 RT readback per frame. Defer until ducking into caves becomes a feature.

---

## Files touched

- **New:**
  - `src/visual/halfLambertLighting.ts`
  - `src/visual/sunGodRays.ts`
  - `src/engine/nightGradePass.ts`
- **Modified:**
  - `src/world/idleCraftDockEnvironment.ts` (heavily — 8 of 8 phases touch it)
  - `src/visual/characterScenePreview.ts` (camera fill alloc, IBL attach, god-rays attach, night-grade pass injection + per-frame sync, half-Lambert on avatar materials)
  - `src/visual/pveEnemyLPCA.ts` (half-Lambert on mob trees)
  - `src/world/magicProjectiles.ts` (emissive bumps for new bloom threshold)
  - `project.json` (bloom threshold + strength + radius)

Type-check is green (`npx tsc --noEmit` exit 0).
