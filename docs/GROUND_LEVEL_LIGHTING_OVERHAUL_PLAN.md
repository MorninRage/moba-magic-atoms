# Ground-Level Lighting Overhaul — Research-Driven Plan

**Date:** 2026-04-19
**Status:** Plan / proposal — implementation TBD in phases
**Goal:** Make idle-craft's ground-level lighting feel as visually "incredible" as Zelda Echoes of Wisdom / Genshin / BotW *while* respecting the documented Three.js shader-recompile invariants and consumer-GPU budget.

---

## Executive summary

The current setup is **engineering-strong** (stable `numDirLightShadows`, phantom-light pool, tile-merged forest, ACES tone-map, day/night curves, vegetation wind shader) but has **two underdone areas** the player feels at ground level:

1. **Noon avatar reads flat** — sun + hemi + ambient only, with bloom + SSAO **dropped** in awakened mode for fillrate. No camera-relative fill, no IBL specular, no rim. The avatar silhouette merges into the background.
2. **Moonlight reads as "blue daytime"** — moon directional intensity is intentionally low (~0.34 × moonStrength), but the post-stack doesn't desaturate or curve the night image, so it doesn't visually parse as "moonlight."

The plan below addresses both via **8 staged passes**, each:

- **Compatible with the LEARNINGS invariants** — never toggles light counts, uses `setPassEnabled` not dispose, hooks into `onBeforeCompile` rather than swapping materials at runtime, follows the phantom-light pool pattern for any new dynamic light.
- **Borrows GoE-validated recipes** where applicable — the sibling project at `C:\GameofEmpires` solved several of these in production and the docs at `C:\GameofEmpiresDocs\docs\` have the recipes written down.
- **Cites concrete industry references** (Zelda Echoes of Wisdom diorama recipe, BotW multi-diffuse cel, Genshin shadow-ramp + Sobel rim, Valve half-Lambert, Hillaire 2020 atmospheric scattering).

---

## What we're building toward — the "ground-level read" reference

Pulling from the industry research, "incredible ground-level lighting" in modern stylized fantasy games is a **recipe**, not a single technique:

```
ACES tone-map
+ bloom (low intensity, high threshold — emissive props only)
+ half-Lambert OR multi-diffuse character diffuse
+ hemisphere/sky-color wrap fill (not pure ambient)
+ camera-relative fill light tracking the player
+ rim light (post-process Sobel on depth/normal, OR per-character fresnel)
+ soft shadows (PCF radius, contact-hardening optional)
+ warm/cool color grade per time-of-day (not just sun-color swap)
+ atmospheric perspective via fog matched to horizon
+ subtle eye-adaptation
```

Idle-craft already has 4 of these 9 ingredients. The plan below adds the remaining 5 in priority order.

---

## Findings: where the current setup is strong vs underdone

### Strong (preserve as-is)

| Area | Where it lives | Why it's good |
|------|---------------|---------------|
| Stable `numDirLightShadows` | `idleCraftDockEnvironment.ts` ~167-171, ~480-482; LEARNINGS sunset-freeze entry | Both directional lights keep `castShadow = true` for the entire session. Avoids the documented 1→0→1 hash flip recompile. |
| Phantom point-light pool | `craftStationBuilder.ts` ~201-205; LEARNINGS phantom-light entry | 8 pre-allocated `PointLight`s, parked off-scene, claimed by placed campfires. `numPointLights` constant after attach. |
| Tile-merged vegetation | `forestEnvironment.ts` 3×3 grid + `freeRoamHarvestNodes.ts` per-kind | 3×3 frustum-cullable tiles, vegetation wind shared via WeakSet-deduped `onBeforeCompile`. |
| Day/night exposure smoothing | `idleCraftDockEnvironment.ts` `getExposureMultiplier()` ~260-264 | `(0.82 + dayMix * 0.34) * (1 - storm * 0.22)` smoothly modulates `renderer.toneMappingExposure`. |
| ACES tone-map by default | `rendererDisplaySettings.ts` ~99-125 | Right call for stylized fantasy; PR-validated highlight desaturation. |
| Awakened render budget | `characterScenePreview.ts` `setAwakenedRenderBudget` | DPR cap at 1.0 + bloom/SSAO drop for 3-5× FPS gain on integrated GPUs. |

### Underdone (the overhaul targets)

| Gap | Symptom user notices | Phase below |
|-----|---------------------|-------------|
| **No `scene.environment` / PMREM IBL** | Many `MeshPhysicalMaterial`s use `envMapIntensity` but have no env map → flat plastic specular at noon | **Phase 1** |
| **No camera-relative fill light** | Avatar back-lit by sun → silhouette flat; "I can't see my own character at noon" | **Phase 2** |
| **No half-Lambert / wrap shading** | Shadow side of avatar / mobs goes near-black instead of soft hemisphere falloff | **Phase 3** |
| **Moonlight doesn't read as moonlight** | Night looks like dim daytime; the cool-blue tint is in light color but post doesn't curve/desaturate the frame | **Phase 4** |
| **Atmospheric fog only matches sky color, not horizon** | World doesn't push back enough → no atmospheric perspective for the avatar to pop against | **Phase 5** |
| **No god-rays / sun shafts** | Cinematic moments (sun through canopy, magic in dust) feel ordinary | **Phase 6** |
| **No eye-adaptation; exposure step at dawn/dusk** | Sunrise/sunset have a perceptible exposure jump | **Phase 7** |
| **Bloom blooms everything** | Threshold 0.05 in `project.json` makes bright surfaces bloom; emissive props don't visually win | **Phase 8** |

---

## Phase 1 — PMREM IBL from the actual sky dome

**Status:** Highest visual ROI, lowest risk. **GoE has the exact recipe documented and validated.**

### The bug

`scene.environment` is currently **null**. But many materials carry `envMapIntensity` values (`pveEnemyLPCA`, `goeStyleHarvestLPCA`, `multiplayerAvatarStage`, `characterScenePreview`, `plasmaPortalLPCA`, `vanguardStaffOrbVfx`). With no environment map, those uniforms are dead — the materials get only the direct light terms, no specular IBL contribution. PBR materials look "plasticky" or "muddy" at certain angles because they're missing the entire environment-reflection term.

### The fix (per [`SKY_REFLECTION_FOG_RESEARCH.md` §2](C:\GameofEmpiresDocs\docs\SKY_REFLECTION_FOG_RESEARCH.md))

```typescript
// At dock attach time
const pmrem = new THREE.PMREMGenerator(this.renderer);
pmrem.compileEquirectangularShader();

// Per-render-update (every ~5 game minutes — NOT per frame)
function regenerateEnvironment(): void {
  // Build a TEMPORARY scene containing the actual sky dome + sun mesh + moon mesh.
  // Reuse meshes; don't add more lights. PMREM cares about emissive surfaces.
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(currentSkyColor);  // CRITICAL: scene.background, not setClearColor
  envScene.add(skyDome.clone());
  envScene.add(sunDisc.clone());
  envScene.add(moonDisc.clone());

  const envTarget = pmrem.fromScene(envScene, /* sigma */ 0, /* near */ 0.1, /* far */ 1000);
  if (this.scene.environment) (this.scene.environment as THREE.Texture).dispose();
  this.scene.environment = envTarget.texture;
}
```

### Why this is the right move

- **Validated**: the GoE `SKY_REFLECTION_FOG_RESEARCH.md` calls out the exact failure mode we have ("Replace fake HemisphereLight+DirectionalLight env scene with a clone of the actual sky dome + sun mesh") and labels it "the correct, research-validated approach."
- **Cheap**: `~2-5 ms per generation`, regenerated every ~5 minutes (or on big sky-color jumps).
- **Stylized-friendly**: the sky dome shader already paints the right gradient — IBL just propagates that into surface reflection, so character skin / cabin metal / crystal / orb all suddenly read as "lit by THIS sky" rather than "lit by no sky."

### Constraint compliance

- **Doesn't change `numDirLightShadows` / `numPointLights`** — IBL doesn't count as a Three.js light source.
- **No new shader compile per frame** — PMREM produces a texture; sampling a texture doesn't change shader hash.
- **One-time PMREM compile cost** at dock attach (warm window).

### Acceptance criteria

- Wizard staff orb + magic projectile midShell + cabin band metals + witch wand halo all show subtle env reflections that change color through the day.
- No frame-time regression in steady state (regen is throttled).
- First regen happens during boot warm window so initial reflections are correct on frame 1 of player view.

### Risk

- Low. PMREM is a built-in Three.js facility, well-documented, used heavily.

---

## Phase 2 — Camera-relative fill light (third-person "softbox")

**Status:** Direct fix for "avatar reads flat at noon."

### Why it works

Industry-validated technique used by every major third-person game (BotW, Genshin, Tunic, A Short Hike) but rarely documented:

> Attach a low-intensity `DirectionalLight` to the camera rig itself. It tracks the camera's right-side or front, intensity ~0.15-0.25 of the sun, hue lerped toward the current sky color.

This is a "fake softbox" — invisible to the player, gives the character form even when their back is to the sun. Nobody notices because it never moves relative to the camera; they just notice the character "pops."

### The fix

```typescript
// In characterScenePreview.ts, at attach time (NOT per-frame allocation)
this.cameraFillLight = new THREE.DirectionalLight(0xffffff, 0);  // intensity 0 = phantom slot
this.cameraFillLight.castShadow = false;  // never shadow-cast
this.camera.add(this.cameraFillLight);    // PARENTED to camera so it tracks
this.cameraFillLight.position.set(1.5, 0.5, 0);  // right-side over-the-shoulder
this.cameraFillLight.target.position.set(0, 0, -10);  // pointing forward
this.camera.add(this.cameraFillLight.target);

// In dockEnvironment.runDockEnvironmentUpdate (per-frame)
const sunStrength = sunKeyIntensity * lightMul.sun;
this.cameraFillLight.intensity = (0.18 * dayMix + 0.10 * nightMix * moonStrength) * lightMul.ambient;
this.cameraFillLight.color.lerpColors(this.skyColCool, this.skyColWarm, sunWarmth);  // matches sky tint
```

### Constraint compliance

- **Doesn't change light counts** — added once at attach, intensity goes to 0 when not needed (phantom-light pattern).
- **No shadows** — no shadow-map cost.
- **Cheap** — one extra directional contribution per fragment, no shader recompile.

### Acceptance criteria

- Standing with back to sun at noon: avatar's front-facing surfaces (chest, face, staff) catch a subtle cool fill — no longer pure silhouette.
- Hue follows sky color: midday neutral, sunset peach, night cool-blue.
- Player can't pinpoint the source — it just feels right.

### Reference

Industry-standard 3rd-person camera writeup: <https://www.unrealengine.com/en-US/tech-blog/six-ingredients-for-a-dynamic-third-person-camera> — calls out FOV/distance/DoF/lighting as readability tools. The "follow light" is the lighting half of that ingredient list.

### Risk

- Very low. One extra directional light, intensity-modulated, no shadow.

---

## Phase 3 — Half-Lambert wrap on hero materials (stylized soft fill)

**Status:** Highest "looks like a real game" upgrade for the dollar. Pattern is already proven in our codebase via `idleCraftVegetationWind.ts`.

### The math

Standard PBR diffuse uses `max(0, dot(N, L))`. Half-Lambert (originating in Valve's Source engine, 2004) uses `(dot(N, L) * 0.5 + 0.5) ^ 2`:

- The shadow side never goes pitch black — it falls off softly toward 0.25 (after the squaring), giving the character "form" even when fully facing away from the light.
- It's a **cheap fake GI** — every modern stylized game uses some flavor of this.
- It pairs perfectly with hemisphere lights (which add the sky-color wrap on top).

### The fix (`onBeforeCompile` patch — same pattern as vegetation wind)

```typescript
// New file: src/visual/halfLambertLighting.ts
import * as THREE from 'three';
const HALF_LAMBERT_KEY = '__halfLambertPatched__';

/**
 * Patch a MeshStandardMaterial / MeshPhysicalMaterial to use half-Lambert wrap
 * for diffuse direct lighting. Specular stays physical so metals still read.
 *
 * Pattern: WeakSet-gated onBeforeCompile, identical to `installVegetationWindOnMaterial`.
 */
export function installHalfLambertOnMaterial(mat: THREE.Material, weakSet: WeakSet<THREE.Material>): void {
  if (weakSet.has(mat)) return;
  weakSet.add(mat);
  const std = mat as THREE.MeshStandardMaterial;
  const prev = std.onBeforeCompile;
  std.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    // Patch the lighting model: replace `RECIPROCAL_PI * BRDF_Lambert(diffuseColor)`
    // with the half-Lambert wrap. The replacement targets `<lights_physical_pars_fragment>`
    // — Three.js's PBR lighting include — and patches the irradiance multiplier in
    // RE_Direct so dot(N,L) becomes (dot(N,L)*0.5+0.5)^2.
    shader.fragmentShader = shader.fragmentShader.replace(
      /float dotNL = saturate\( dot\( normal, directLight\.direction \) \);/,
      `float dotNLraw = dot( normal, directLight.direction );
       float dotNL = pow( dotNLraw * 0.5 + 0.5, 2.0 );`,
    );
  };
  // Bump cache key so Three.js doesn't share a program with the un-patched version.
  std.customProgramCacheKey = () => 'halfLambertWrap_v1';
}
```

Apply selectively — **only to hero / mob / cabin materials** that need the soft-form read. Don't apply to terrain, fog, water (those work better with standard Lambert).

### Constraint compliance

- **`onBeforeCompile` + custom cache key** — same pattern as vegetation wind, proven safe.
- **WeakSet dedup** — material patched once, shared across all instances.
- **No light count change** — pure shader patch.

### Acceptance criteria

- Mob (rat / wolf / wanderer) seen against bright sky: shadow side reads as "soft cool grey," not "black silhouette."
- Wizard staff body: backlit at sunset, the wood grain still reads (not pure shadow).
- Same view in a flat lighting test scene: visibly more "stylized" without losing material identity.

### Reference

- Valve Source Engine half-Lambert origin: <https://chetanjags.wordpress.com/2013/04/17/cheap-global-illumination-half-lambert/>
- BotW multi-diffuse + smoothstep band edge — alternative if we want full cel: <https://gamedev.stackexchange.com/questions/152412/how-can-i-replicate-the-look-of-zelda-botw-in-my-own-shaders>
- Genshin shadow-ramp pattern (skip for now — adds complexity): <https://adrianmendez.artstation.com/projects/wJZ4Gg>

### Risk

- Low. WeakSet pattern + customProgramCacheKey is documented; vegetation wind shader has done it for months.

---

## Phase 4 — Moonlight that reads as moonlight (post-process night grading)

**Status:** Direct fix for "moon doesn't illuminate enough / night looks like dim daytime."

### Why just brightening the moon doesn't work

Industry recipe (BotW, Genshin, Skyrim) for night lighting is **NOT** "make the moon brighter." It's:

1. **Cool blue moon directional** at low intensity (already correct).
2. **Screen-space desaturate** the night image (`mix(rgb, gray, 0.4)`).
3. **Cool tint** the entire frame (`rgb *= vec3(0.85, 0.92, 1.05)`).
4. **Brightness curve** to crush mid-shadows (`pow(rgb, 1.3)`).
5. **Bloom threshold rises** so only practical lights (lanterns, magic) bloom — moonlit terrain doesn't bloom.

The moon's role is to **define directionality and a key cool tint**, not to be a "second sun." The screen-space grading is what tells the brain "this is night."

### The fix — new post-process pass: night grade

Add a new `nightGrade` pass to the post-processing stack. Driven by `nightMix` (already exposed by the day-period state):

```glsl
// src/engine/passes/nightGradePass.glsl (new)
uniform sampler2D tDiffuse;
uniform float u_nightMix;          // 0=day, 1=full night
uniform float u_moonIllum;         // 0=new moon, 1=full moon
varying vec2 vUv;

vec3 nightGrade(vec3 c) {
  float n = u_nightMix * (1.0 - u_moonIllum * 0.4); // full moon eases the grade slightly
  // Desaturate
  float gray = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(c, vec3(gray), n * 0.45);
  // Cool tint
  c *= mix(vec3(1.0), vec3(0.85, 0.92, 1.08), n);
  // Crush mid-shadows
  c = pow(c, vec3(mix(1.0, 1.25, n)));
  return c;
}

void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  gl_FragColor = vec4(nightGrade(c), 1.0);
}
```

Wired via the existing `PostProcessingStack` pattern. **Use `setPassEnabled('nightGrade', nightMix > 0.05)`** so the pass runs only when needed but the program stays compiled (avoids the first-use compile freeze documented in LEARNINGS Phase 8 entry).

### Constraint compliance

- **`setPassEnabled` not dispose** — directly per the post-stack invariant from LEARNINGS.
- **No light count changes** — pure post-process pass.
- **Uniforms only per frame** — no shader recompile after first attach.

### Acceptance criteria

- Side-by-side day vs night screenshot: night image is clearly desaturated + cool-tinted, NOT just darker.
- Magic projectile orbs visibly bloom at night while the moonlit grass does not.
- Full moon vs new moon: full moon shows more saturation + slightly less crush; new moon is the "mysterious dark" extreme.

### Reference

- BotW screen-space night LUT recipe: <https://gamedev.stackexchange.com/questions/152412/how-can-i-replicate-the-look-of-zelda-botw-in-my-own-shaders>
- Industry research §4 in `web-researcher` report.

### Risk

- Low. New post pass added to the existing stack. `setPassEnabled` toggle keeps the program in cache.

---

## Phase 5 — Atmospheric perspective via horizon-matched fog

**Status:** Easy win for ground-level "depth + character pop." Mostly a tuning + a small color-curve change.

### The trick

Far objects in landscape painting **desaturate toward the sky color and lose contrast** ("aerial perspective"). It's how A Short Hike, Genshin, Tunic all push the world back so the character pops.

Idle-craft already has `THREE.Fog` with sky color matching, but the color matches the **zenith** (top of sky), not the **horizon** (where most objects sit). Fix:

```typescript
// In idleCraftDockEnvironment.ts, where fog color is updated:
// Compute horizon color = sky color at low elevation (orange near sun, dark near anti-sun)
const horizonColor = new THREE.Color().lerpColors(
  this.skyZenithColor,
  this.skyHorizonWarmColor,  // peach near sun, deep blue at night
  smoothstep(sunDir.y, 0.5, -0.05),  // more horizon-tinted when sun is low
);
this.scene.fog.color.copy(horizonColor);
```

Plus tune the fog density curve so daytime has loose far-fog (`near 60, far 200`) and night has tighter close-fog (`near 30, far 120`) — already partially in place; just lift the night near a bit so the ground-level read against fog is stronger.

### Constraint compliance

- **No light count change.**
- **`THREE.Fog` is a free uniform** — no shader hash impact.

### Acceptance criteria

- Looking out across the dock at sunset: distant trees clearly desaturate toward peach, the avatar's silhouette pops against them.
- Looking out at midnight: fog reads cool-blue and tighter, the lantern-lit camp pops against it.

### Reference

- A Short Hike "dozy sepia at the horizon": <https://www.eurogamer.net/articles/2019-08-12-a-short-hike-review-dreamy-brilliance>

### Risk

- Trivial. Color update.

---

## Phase 6 — Cheap volumetric god-rays through canopy

**Status:** Cinematic polish — biggest "looks like a movie" moment for low cost. Two implementation paths, prefer the cheap one.

### Path A — additive cone geometry (cheap, stylized)

Per [Three.js demos]: an open `THREE.ConeGeometry` with `MeshBasicMaterial({ transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false })` parented to the sun direction creates "god-rays" that are essentially free at runtime. Stylized fantasy (especially BotW / Echoes of Wisdom) uses this trick all the time. Cone width + opacity modulate by `sunDirectFrac` so it disappears at night.

### Path B — `three-good-godrays` (more accurate, more cost)

Postprocessing-based screen-space raymarched god-rays sampling the shadow map. ~2-4ms on consumer GPUs. Reserve for cinematic moments only.

### Recommendation

Ship Path A first. It's stylized, costs nothing, and per the GoE `SKY_REFLECTION_FOG_RESEARCH.md` is "perfect for stylized look, fits stylized fantasy." If we later want a cinematic Phase 6.5, add Path B behind a localStorage opt-in.

### Constraint compliance

- **No new lights.**
- **Single mesh + basic material** — already-compiled shader (basic + additive + transparent is one of the most common Three.js programs and is already in the cache).

### Acceptance criteria

- Standing under tree canopy at sunrise: visible warm shafts angling down through gaps.
- Same at noon: subtle vertical shafts (sun overhead).
- At night: cones invisible (opacity gated to 0).

### Reference

- Three.js god-rays demos: <https://threejsdemos.com/demos/lighting/godrays>
- `three-good-godrays` for the higher-fidelity path: <https://github.com/Ameobea/three-good-godrays>

### Risk

- Trivially low for Path A.

---

## Phase 7 — Eye-adaptation lite (smooth exposure jumps)

**Status:** Polish for sunrise/sunset. Already have most of the infrastructure.

### The bug

Current `getExposureMultiplier()` returns `(0.82 + dayMix * 0.34) * (1 - storm * 0.22)`. It's smooth in `dayMix` but doesn't account for the **player's view content** — entering a dark cave or stepping out of bright sun has no exposure response.

### The fix

Replace the formula with a target-toward exposure:

```typescript
private adaptedExposure = 1.0;

function update(dt: number): void {
  const target = (0.82 + dayMix * 0.34) * (1 - storm * 0.22);
  // Asymmetric speed: fast adapting TO bright (eyes pinch quick), slow FROM bright
  // (eyes adapt slower to darkness).
  const goingBrighter = target > this.adaptedExposure;
  const tau = goingBrighter ? 0.3 : 1.2;  // seconds
  const k = 1 - Math.exp(-dt / tau);
  this.adaptedExposure += (target - this.adaptedExposure) * k;
}

getExposureMultiplier(): number { return this.adaptedExposure; }
```

For a true content-aware adaptation (luminance-driven), we'd render to a 1×1 RT and read the average — defer to a later polish pass; the time-of-day target is enough to kill the visible step at dawn/dusk.

### Constraint compliance

- **Pure JS state** — no rendering or shader work.

### Acceptance criteria

- Dawn (5:30→7:00): no perceptible exposure jump; the brightening is smooth across multiple seconds.
- Sunset (17:30→19:30): same — no step.

### Reference

- Unity auto-exposure docs (asymmetric speed pattern): <https://docs.unity3d.com/Packages/com.unity.postprocessing@2.0/manual/Auto-Exposure.html>

### Risk

- Trivial.

---

## Phase 8 — Bloom tuning (raise threshold; emissive props pop)

**Status:** Quick tuning win. Currently `project.json` `postProcessing.bloom.threshold = 0.05` — way too aggressive.

### The problem

A threshold of 0.05 means anything brighter than 5% of white blooms. Result: **noon grass blooms**, **white clouds bloom**, **bright cabin wood blooms**. The magic projectile orb (which IS the thing that should look magical) doesn't visually win because the whole scene is already glowing.

### The fix

Raise threshold to **0.85** + cut intensity to **0.4**:

```jsonc
// project.json
"bloom": {
  "enabled": true,
  "threshold": 0.85,    // was 0.05 — only HDR-bright surfaces bloom
  "strength": 0.4,      // was probably higher
  "radius": 0.4
}
```

Then **boost emissive on the magic / orb / lantern / crystal materials** so they exceed 0.85 brightness in screen-linear space — they become the only things in the scene that bloom, which reads as "magic" rather than "everything is glowing."

### Constraint compliance

- **Pure config + emissive intensity tweaks.**
- **No shader recompile** — emissive uniforms.

### Acceptance criteria

- Noon scene: no general glow on mundane surfaces; sun-disc + magic orb still bloom.
- Night scene: lanterns + campfire + magic orb bloom strongly against dark backdrop — feels magical.

### Reference

- Industry research §6 + §"Pitfalls to avoid" #7 in `web-researcher` report.

### Risk

- Trivial. Roll back the JSON if it looks worse.

---

## Implementation order + estimated effort

| Phase | Effort | Visual impact at ground level | Risk |
|-------|--------|-------------------------------|------|
| 8 — Bloom tuning | 30 min | Medium (emissive props pop) | Trivial |
| 5 — Horizon fog | 1 hr | Medium (depth + character pop) | Trivial |
| 1 — PMREM IBL | 2-3 hr | **High** (PBR finally reads) | Low |
| 2 — Camera fill light | 1-2 hr | **High** (avatar reads at noon) | Very low |
| 4 — Night grade pass | 3-4 hr | **High** (moonlight reads as moonlight) | Low |
| 7 — Exposure smoothing | 1 hr | Low-medium (kills dawn/dusk step) | Trivial |
| 3 — Half-Lambert | 3-4 hr | **High** (stylized soft form) | Low |
| 6 — God-rays (Path A) | 2 hr | Medium (cinematic moments) | Trivial |

**Recommended ship order:** 8 → 5 → 1 → 2 → 4 → 3 → 7 → 6.

Phases 8 + 5 + 1 + 2 are sub-day quick wins that combined give the player a **dramatically better noon read** without any new shader patches. Phases 4 + 3 are the "looks like Echoes of Wisdom" passes that need a bit more care. Phases 6 + 7 are polish.

---

## What we're explicitly NOT doing (and why)

- **Cascaded shadow maps (CSM).** Three.js doesn't ship native CSM and adding it requires either a community lib or a custom multi-pass shadow renderer. The current single-cascade with `mapSize 2048` and the moon's frustum copied from sun is enough for the dock's small radius. Defer to Phase 4 of the master plan if open-world raids need it.
- **Lightmap baking** ([`GI_LPCA_LIGHTMAP_BAKE_SUBPLAN.md`](C:\GameofEmpiresDocs\docs\GI_LPCA_LIGHTMAP_BAKE_SUBPLAN.md)). 5-8 days of work for a feature that primarily helps **static buildings** in fixed configurations. The dock is mostly procedural / dynamic — the ROI is much lower than the runtime IBL win in Phase 1. Revisit if the Phase 1 + Phase 2 + Phase 3 stack still feels flat.
- **Volumetric froxel fog (Naughty Dog 2020 / TLOU2 pattern).** Massive engineering effort (3D texture management, async compute, temporal reuse) for a feature WebGL2 can only weakly approximate. The Phase 6 cone-geometry god-rays cover the "sun shaft" beat for free.
- **Multi-diffuse cel shader (BotW pattern).** Phase 3 half-Lambert already gets us 80% of the way. Multi-diffuse is the "we want full toon look" upgrade — defer until art direction asks for it specifically.
- **Genshin-style shadow-ramp + Sobel rim outline.** Same reasoning as multi-diffuse — Phase 3 + the camera fill from Phase 2 already give characters proper form. The Sobel rim is the "full anime" upgrade we don't need yet.
- **Eye-adaptation via real luminance histogram.** Phase 7 covers the time-of-day step; full luminance adaptation requires a 1×1 RT readback per frame and adds GPU/CPU cost. Defer until ducking into caves becomes a feature.

---

## Constraint compliance summary (the LEARNINGS gotchas)

Every phase above is checked against the existing `LEARNINGS.md` invariants:

| Invariant | Phase that could violate | How we avoid it |
|-----------|--------------------------|-----------------|
| `numDirLightShadows` constant | Phase 2 (camera fill) | New light has `castShadow = false`; doesn't add to shadow count. |
| `numPointLights` constant | None | No new point lights in this plan. (Future torch system would use phantom-light pool, same as campfire.) |
| `setPassEnabled` not dispose | Phase 4 (night grade), Phase 8 (bloom) | Both use `setPassEnabled` toggles; programs stay in cache. |
| First-use shader compile freeze | Phase 4 (new pass) | Pass program compiled at attach time via the existing post-stack warm window. |
| Vegetation wind WeakSet pattern | Phase 3 (half-Lambert) | Same WeakSet + customProgramCacheKey pattern; one program per material. |

---

## Sources / references

### Sibling project — `C:\GameofEmpiresDocs\docs\`

- [`LIGHTING_SYSTEM.md`](C:\GameofEmpiresDocs\docs\LIGHTING_SYSTEM.md) — full GoE lighting reference: 1024² shadow map, ACES tone-mapping, sun + ambient + hemi color/intensity tables per hour, storm dimming multipliers, moon point-light formula, terrain shader uniform sync.
- [`DAY_NIGHT_CYCLE_SYSTEM.md`](C:\GameofEmpiresDocs\docs\DAY_NIGHT_CYCLE_SYSTEM.md) — LPCA sky dome with Rayleigh + Mie scattering; cloud occlusion via renderOrder; moon phases; auto-torch on dark nights; fog sync to sky color.
- [`SKY_REFLECTION_FOG_RESEARCH.md`](C:\GameofEmpiresDocs\docs\SKY_REFLECTION_FOG_RESEARCH.md) — atmospheric scattering models (Bruneton, Hillaire 2020, Preetham, Hošek-Wilkie); PMREM IBL recipe; volumetric fog approaches; god-rays.
- [`GI_LPCA_LIGHTMAP_BAKE_SUBPLAN.md`](C:\GameofEmpiresDocs\docs\GI_LPCA_LIGHTMAP_BAKE_SUBPLAN.md) — deferred for ROI reasons (see "explicitly NOT doing" above).

### Industry references (citations used inline above)

- **Echoes of Wisdom diorama recipe:** <https://thegamer.com/tloz-links-awakening-remake-influence-zelda-echoes-of-wisdom>, <https://nintendosoup.com/eiji-aonuma-confirms-links-awakenings-art-style-was-inspired-by-dioramas-as-it-fit-the-games-setting/>
- **BotW multi-diffuse + brightness-shift + spec gate + bloom + night LUT:** <https://gamedev.stackexchange.com/questions/152412/how-can-i-replicate-the-look-of-zelda-botw-in-my-own-shaders>
- **Genshin Impact NPR pipeline:** <https://www.gdcvault.com/play/1027538/-Genshin-Impact-Crafting-an>, <https://adrianmendez.artstation.com/projects/wJZ4Gg>, <https://bjayers.com/blog/9oOD/blender-npr-recreating-the-genshin-impact-shader>
- **Wind Waker / toon + warm sky in Three.js:** <https://medium.com/@gordonnl/wind-waker-graphics-analysis-a0b575a31127>
- **Half-Lambert origin (Valve Source Engine):** <https://chetanjags.wordpress.com/2013/04/17/cheap-global-illumination-half-lambert/>
- **Stylized PBR pitfalls (Velan Studios):** <https://medium.com/velan-studios/tip-of-the-brush-creating-stylized-art-in-a-pbr-world-b803b91c082f>
- **Three.js ACES tone-map + PR #19621:** <https://threejs.org/docs/pages/module-ACESFilmicToneMappingShader.html>, <https://github.com/mrdoob/three.js/pull/19621>
- **Three.js PMREM `fromScene` gotcha:** <https://github.com/mrdoob/three.js/issues/20819>
- **Three.js god-rays:** <https://github.com/Ameobea/three-good-godrays>, <https://threejsdemos.com/demos/lighting/godrays>
- **Eye-adaptation reference:** <https://docs.unity3d.com/Packages/com.unity.postprocessing@2.0/manual/Auto-Exposure.html>
- **Third-person camera readability:** <https://www.unrealengine.com/en-US/tech-blog/six-ingredients-for-a-dynamic-third-person-camera>
- **A Short Hike "dozy sepia at the horizon":** <https://www.eurogamer.net/articles/2019-08-12-a-short-hike-review-dreamy-brilliance>

### Internal codebase references (for the implementer)

- `src/world/idleCraftDockEnvironment.ts` — main env driver: lights, fog, exposure, water, stars.
- `src/visual/forestEnvironment.ts` — terrain, hemi, fog, water, forest tile-merge.
- `src/visual/characterScenePreview.ts` — renderer, shadow setup, key light, post-stack, awakened budget, exposure loop.
- `src/engine/postProcessingFromProject.ts` — pass resolution + preview stripping.
- `src/engine/rendererDisplaySettings.ts` — tone-map + exposure + light multipliers.
- `src/visual/idleCraftVegetationWind.ts` — `onBeforeCompile` + WeakSet + `customProgramCacheKey` pattern that Phase 3 will mirror.
- `LEARNINGS.md` — invariants ("First-sunset hard freeze," "phantom-light rule," "View Transition canvas freeze").
- `project.json` — `graphics.*` + `postProcessing.*` for tuning Phase 8.
