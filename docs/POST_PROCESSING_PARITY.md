# Post-processing parity — idle-craft vs Game of Empires / EmpireEditor

Source: `EmpireEditor/docs/FULL_ENGINE_PIPELINE.md` and `empire-engine` `PostProcessingStack`.

## Implemented in idle-craft (EmpireEngine stack)

| Pass / control | Notes |
|----------------|--------|
| RenderPass | Always (composer) |
| SSAOPass | Toggle + intensity, kernel radius, min/max distance, resolution scale, kernel size (JSON / load) |
| UnrealBloomPass | Toggle + strength, threshold, radius |
| Vignette | Toggle + darkness, offset |
| FXAA | Toggle |

Esc menu: quality **presets** (Low → Ultra) match the doc’s FXAA / bloom / SSAO / vignette rows; **shadows** still follow graphics tier + reload.

Config: `project.json` → `config.postProcessing` (all keys above). User overrides: `localStorage` `idleCraft.postProcessing.user`.

## Not in `empire-engine` PostProcessingStack (full GoE only)

These are called out in `FULL_ENGINE_PIPELINE.md` as additional passes — they are **not** part of the shared engine composer idle-craft uses:

| Pass | Purpose |
|------|---------|
| RainOnLens | Weather droplets on camera |
| NightVision / ThermalVision / GlareReduction | Helmet / visor modes |
| Colorblind | Accessibility matrix |

Adding them would require new `ShaderPass` types in **EmpireEngine** (or a game-specific composer), not only idle-craft UI.

## References

- `C:/EmpireEditor/docs/FULL_ENGINE_PIPELINE.md` — pass order and quality table  
- `EmpireEngine/src/render/PostProcessingStack.ts` — WebGL implementation  
