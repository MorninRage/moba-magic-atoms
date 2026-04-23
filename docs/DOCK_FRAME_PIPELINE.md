# Dock / forest frame — code structure

Use this map to **isolate stalls** (Chrome DevTools → Performance → bottom-up / call tree). Pair with `localStorage.setItem('idleCraft.perfDockFrame', '1')` for split timings in the console.

## One animation frame (solo forest dock)

Order is **fixed** in `CharacterScenePreview`’s RAF loop (see `characterScenePreview.ts` near `dockEnvironment?.update`):

1. **Avatar / clips / idle / battle / portal / craft ticks** — animation, IK, travel.
2. **VFX** — e.g. `vanguardStaffOrbVfx.update`, torches, campfire.
3. **Terrain / camera** — `syncAvatarFeetToTerrain`, solo dock framing, `applyCameraFraming`.
4. **`IdleCraftDockEnvironment.update(dt, project, camera)`** — day/night, fog, lights, moon/plasma sun, stars, night magic field, **GoE sky dome + cloud dome** (upper hemispheres; uniforms only).
5. **Exposure** — `renderer.toneMappingExposure` from `getExposureMultiplier()`.
6. **`postProcessing.render()`** or **`renderer.render(scene, camera)`** — WebGL + shadows + SSAO/bloom if enabled.

Anything that blocks **step 4** delays the whole frame before GPU work in step 6.

## Inside `IdleCraftDockEnvironment.update` (rough phases)

| Phase | What runs |
|--------|-----------|
| Clock / weather | Sim hour, lunar phase, weather runtime, `computeDayPeriodState`, EMA blend of day/sunset/dusk/star targets |
| Blend + wind | `updateVegetationWind` (uniforms only) |
| Lighting body | Fog, moon + sun key, shadow handoff, moon disc shader, **plasma sun** mesh, hemi, ambient, water scroll |
| Stars | Star layer opacities / visibility |
| Night magic | `nightMagicField.update` (fairies, trails, emissive lights) |
| Skydome | `paintIdleCraftSkydome` (Canvas2D) then `tex.needsUpdate = true` |

**Likely hitch buckets**

- **Skydome**: three lightweight shader passes (no Canvas2D upload).
- **Night magic**: many instanced matrices + trail buffer updates when visibility is high.
- **Shadows**: toggling sun vs moon `castShadow` around twilight (smoothed, but still work for the renderer).
- **Post stack**: SSAO / bloom cost scales with resolution and scene depth complexity — *after* env update, not inside it.

## Outside this repo’s game code

- **Audio**: `FilePlaylistMusic` crossfade / teardown uses ~4s wall-clock ramps (`CROSSFADE_SEC`) — unrelated to sun angle unless you correlate by accident.
- **Extensions**: ad blockers / devtools can inject long tasks — test incognito if unsure.

## What the probes showed (typical)

With `idleCraft.perfDockFrame` enabled, **`envUpdate` is often &lt;1ms** — the skydome Canvas2D path is cheap on CPU. **`postStackRender`** or **`directRender`** is usually **7–12ms** and can **spike to hundreds of ms or worse** — that time is **inside `postProcessing.render()` or `renderer.render()`**: drawing the forest, shadows, and post passes (SSAO, bloom, FXAA, vignette).

So “freezes after sunset” that **do not** show up in `envUpdate` are **GPU / compositor** issues, not the day/night JS. Next steps:

1. **Chrome Performance** → select a long frame → **Bottom-Up** / **Main** → look for `render`, `compile`, `Program`, or GPU wait.
2. **Turn down post-processing** in `project.json` → `config.postProcessing`: set **`ssao`: false** and/or **`bloom`: false** and reload (SSAO is usually the heaviest pass). Optional: lower `ssaoResolutionScale` (e.g. `0.5`) if you keep SSAO.
3. **Low tier** already disables bloom+SSAO unless `?pp=heavy` or `localStorage idleCraft.postProcessing.heavy` — see `src/engine/postProcessingFromProject.ts`.

### Embedded previews (dock + lobby) — default lighter stack

The character dock and multiplayer lobby use **`getEffectivePostProcessingOptionsForPreview`**: **bloom + SSAO are off by default** (vignette/FXAA still follow project + Esc). Full project PP on those small canvases: `?previewPP=full` or `localStorage.setItem('idleCraft.previewPostProcessing.full','1')`.

## Related files

- `src/visual/characterScenePreview.ts` — RAF loop, `dockEnvironment.update`, render.
- `src/world/idleCraftDockEnvironment.ts` — environment update.
- `src/visual/idleCraftSkyStack.ts` — upper-hemisphere sky dome + cloud dome; `idleCraftSkyPaint.ts` — band colors for moon/fog.
- `src/visual/forestEnvironment.ts` — builds scene, `attachSkydome`, returns `dockEnvironment`.
- `src/debug/idleCraftDockFrameProbe.ts` — opt-in `idleCraft.perfDockFrame` probes.
- `src/engine/postProcessingFromProject.ts` — which passes run per tier / `project.json`.
