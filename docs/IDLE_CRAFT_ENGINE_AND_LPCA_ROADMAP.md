# Idle Craft — EmpireEngine integration & LPCA roadmap

**Purpose:** Single reference for how Idle Craft uses EmpireEngine today, the full LPCA toolkit (primitives, materials, techniques) available in code, and a phased plan toward a larger “compact Game of Empires” experience: terrain, creek water, village buildings, enterable structures, raids, and eventually interior character control.

**Canonical engine import in this repo:** `src/engine/idleCraftEngine.ts` re-exports **`empire-engine/lpca`** and **`WebGPUCompat`** only. **`createRendererAsync`** is implemented in **`src/engine/createIdleWebGLRenderer.ts`** (WebGL only, single **`three`** build). Do not use EmpireEngine’s **`RendererFactory`** in the main app — it references **`three/webgpu`**, which duplicates Three and breaks Vite dev (500 / HMR drop) in the editor iframe. `main.ts` calls **`bootstrapIdleCraftEngineRuntime()`** (procedural texture warm-up).

---

## 1. Engine connection status

| Area | Status | Notes |
|------|--------|--------|
| **Package** | `empire-engine`: `file:../EmpireEngine` | Run `npm run build` in `EmpireEngine` after engine changes; `package.json` uses `types` → `dist/index.d.ts` for strict TS consumers. |
| **Renderer** | `createRendererAsync` | Character dock + lobby stage use engine factory (`preferWebGPU: false` until you opt in). |
| **LPCA / materials** | Available via `idleCraftEngine` | Same exports as Game of Empires’ synced engine (see §3–5). |
| **Procedural textures** | `ProceduralTextures.warmUp(256)` on boot | Stone, brick, wood, metal, concrete, plaster, grass, dirt, rock, sand, water + fire/smoke/muzzle/spark atlases. |
| **Post / WebGPU** | Not wired to main UI yet | See `scripts/reference/postProcessingExample.ts`; optional next step: `PostProcessingStack` + `project.json` flags. |
| **World / cells / physics** | Imported but unused | `CellManager`, `PhysicsWorld`, etc. available when you add streaming terrain or character controller. |

---

## 2. Product vision (concise)

1. **Scale up** Idle Craft toward a **smaller-scope Game of Empires**: same LPCA discipline (no external meshes), procedural materials, performance merges.
2. **Environment:** terrain grading, **small creek** (river profile techniques at modest scale), shared **water / transmission** policy (test with your renderer path).
3. **Crafting in the viewport:** build **giant enterable cabin** (and later buildings) in the **character scene** so the avatar **performs construction** (LPCA layers + clips).
4. **Village:** multiple LPCA structures, instancing/merge strategy as count grows.
5. **Raids:** defense phase once the settlement exists (game design TBD; engine provides networking/physics hooks if needed).
6. **Long-term differentiation:** **interior mode** — leave “button-choice” gather/craft flows for macro actions; **inside buildings**, **camera attached to character** with **normal movement** (Game of Empires–style third/first-person). Requires interior collision, doors, room graph, and input routing.

---

## 3. Geometry primitives (full inventory)

### 3.1 Core Six (documented in `LPCA_METHOD.md`)

Lathe, Extrude, Tube, Box, Cylinder, Sphere.

### 3.2 EmpireEngine helpers (`LPCAFoundation` — import from `idleCraftEngine`)

| Function | Typical use |
|----------|-------------|
| `addPart` | Universal mesh placement on a group |
| `latheFromProfile` / `latheFromVector2` | Columns, limbs, barrels |
| `createArchGeo` | Arches / voussoir-style merges |
| `createDomeGeo` | Domes, hemisphere caps |
| `createSpiralGeo` | Spiral stairs, helices |
| `createMoldingGeo` | Extruded crown/base profiles |
| `createStarGeo` | Flat stars / insignia |
| `createTorusGeo` | Rings, pipes |
| `createRingGeo` | Washers, discs with hole |
| `createRopeGeo` | Cables along a path |
| `createConeGeo` | Spires, cones |
| `createCapsuleGeo` | Bollards, pills |
| `createShard*` + `generateRubbleFragments` | Debris / destruction |
| `posGeo` / `rotPosGeo` | Bake transforms before merge |
| `mergeByMaterial` | **Required** performance pass (target few draw calls) |
| `bakeVertexAO` / `applyGroupVertexAO` / `bakeGroundContactAO` | Cheap grounding |

### 3.3 Profile & graphs

- **`profileToGeometry`**, **`sampleProfile`**, **`PROFILE_EASINGS`**, **`RIVER_CROSS_SECTION_PROFILE`** — profile-driven lathe/extrude and creek/river banks when you add watercourses.
- **`executeLPCANodeGraph`**, **`generateTypeScriptFromGraph`** — node authoring; graph supports Box, Cylinder, Sphere, Lathe, Extrude, Tube, Arch, Dome, Ring, Torus (extend editor later for Spiral, Cone, Capsule, etc.).
- **`LPCAFragmentLibrary`**, **`createVoronoiFragmentGroup`**, **`generateVoronoiSeedsInBox`** — fragmentation presets.

### 3.4 Game of Empires reference (copy patterns, not the repo)

**`ClassicalArchitecture.ts`**-style composites: Ionic columns, entablatures, pediments, punched windows, balustrades, steps, hip roofs, dormers, chimneys, curved walls, dome shells. For Idle Craft cabin/village, start with **engine primitives + merge**; pull architectural helpers over only when you need classical detail.

---

## 4. Materials

### 4.1 `LPCA_MATERIALS` (MeshStandard-style registry)

Broad palette: metals (including weathered), stone/masonry, wood, polymers, glass (transparent standard), naturals, roofing, fabric, ceramic, paint, skin, hair, emissives. Use **`smat` / `litMat`** or named keys.

### 4.2 `LPCA_PHYSICAL` (MeshPhysicalMaterial)

Clearcoat, sheen, transmission-grade glass/water, iridescence where needed. **Heavier on GPU** — use for hero props, water, glass.

### 4.3 `getWaterPlaneMaterial`

Shared physical water surface; pair with renderer/post tests for transmission.

### 4.4 Procedural texture types

`ProceduralTextures`: **stone, brick, wood, metalBrushed, concrete, plaster, grass, dirt, rock, sand, water** — normal + roughness maps cached after warm-up. Use **`texturedSmat`** or **`applyToMaterial`** patterns (see Game of Empires `ClassicalArchitecture` + `ProceduralTextures`).

### 4.5 Glass / transmission policy (from Game of Empires learnings)

- **Windows / see-through gameplay:** prefer **`transparent` + `opacity`** (and `depthWrite: false` where appropriate) so dynamic characters always composite correctly.
- **`transmission`:** use for water, optics, hero glass where you accept renderer cost and verify behavior (especially future WebGPU).

---

## 5. Techniques to carry forward

| Technique | Why |
|-----------|-----|
| Research → schematic → layered build → materials → **merge** → integrate | Core LPCA pipeline |
| **Punched openings** vs texture fake | Enterable buildings need real holes |
| **`mergeByMaterial`** per finished group | Keeps village scale feasible |
| **Profile-driven creek** | `RIVER_CROSS_SECTION_PROFILE` + shallow `profileToGeometry` extrude or terrain carve |
| **Scale discipline** | Idle Craft can define `GAME_SCALE` in one module (GoE uses `ScaleConfig`) |
| **Interior camera later** | Engine `InputActionMap`, `PhysicsWorld`, character controller patterns when you leave dock-only UX |

---

## 6. Implementation phases (recommended order)

### Phase A — Engine parity (now / next)

- [x] `idleCraftEngine` barrel + renderer factory + procedural warm-up.
- [ ] Optional: `PostProcessingStack` driven by `project.json` `postProcessing` block.
- [ ] Optional: `MaterialLibrary` from palette if editor sync matters.

### Phase B — Environment shell

- Terrain chunk or heightfield under dock/world (engine `CellManager` or simple mesh).
- **Small creek:** narrow channel, `getWaterPlaneMaterial` or physical plane + bank profiles.
- Lighting/time-of-day hooks if you align with `project.json` `time` / `weather`.

### Phase C — LPCA cabin in viewport

- Research + schematic (footprint, storey height, porch, roof).
- Build layers in code: foundation → frame → walls → openings → roof → merge.
- Hook crafting progression to **visible layers** + character clips (construction animation).

### Phase D — Village

- Multiple buildings with shared material buckets + instancing where repeats exist.
- Enterable flag + interior shell (floor, walls, ceiling, door volume).

### Phase E — Raids

- Spawn waves, damage to structures (optional: `generateRubbleFragments` / fragment presets).

### Phase F — Interior control

- Input mode switch: exterior “dock” vs interior **follow camera + movement** (reuse engine input/physics as needed).
- Collision: simplified AABB/mesh per room phase1.

---

## 7. File map (Idle Craft)

| File | Role |
|------|------|
| `src/engine/idleCraftEngine.ts` | Re-export `empire-engine` + `bootstrapIdleCraftEngineRuntime` |
| `src/main.ts` | Calls bootstrap + dev WebGPU log |
| `src/visual/characterScenePreview.ts` | Main LPCA avatar + world props (extend for cabin) |
| `scripts/reference/postProcessingExample.ts` | Reference for post stack |

---

## 8. External references

- **Engine source:** `C:\EmpireEngine\src\`
- **Method docs (copy on machine):** `C:\gameofempiresDocs\docs\LPCA_METHOD.md`, `LPCA_UNIFIED_PIPELINE.md`
- **Game patterns:** `C:\gameofempires\src\systems\ClassicalArchitecture.ts`, `TerrainGenerator.ts` (water), `LPCABuilder.ts`
- **Sync story:** `gameofempiresDocs\docs\ENGINE_GAME_SYNC_COMPREHENSIVE_REVIEW.md`

---

## 9. Collaboration note

Polished LPCA content needs **your briefs** (dimensions, style, priority) and **iterative review** in the viewport; the AI/agent implements research, scaffolding, and integration. Neither side substitutes for the other on proportion and game feel.
