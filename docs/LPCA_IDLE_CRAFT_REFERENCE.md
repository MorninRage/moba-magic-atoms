# LPCA in IDLE-CRAFT — full method and cross-repo map

This document ties **Layered Procedural Construction Approach (LPCA)** in this project to **EmpireEngine**, **EmpireEditor**, **Game of Empires** (GoE), and GoE documentation. Use it when extending the dock world, adding props, or explaining the pipeline to collaborators.

---

## What LPCA is

All geometry is built **at runtime from Three.js primitives** (and similar code paths). No `.glb`, `.fbx`, `.obj`, or external mesh imports for authored content.

**Pipeline (canonical order):**

1. **Research** — real proportions, references, category (terrain, architecture, organic, etc.).
2. **Schematic** — game-scale units, layer stack, attachment points.
3. **Build** — layer by layer: foundation → structure → openings → ornament → detail.
4. **Materials** — PBR-style `MeshStandardMaterial` (metalness, roughness, color).
5. **Merge** — `mergeByMaterial()` (or equivalent) so draw calls stay low (typical target: a small number of merged meshes per prop).
6. **Integrate** — hook into scene graph, height queries, game state.
7. **Iterate** — user feedback; mold, fix, enhance.

Shorter mnemonic from `.agent/00_READ_FIRST.md`: **Research → Schematic → Build (layer-by-layer) → Materials → Merge → Integrate**.

---

## How IDLE-CRAFT uses LPCA

| Area | Role |
|------|------|
| Character / dock preview | LPCA body and gear in `src/visual/characterScenePreview.ts` and related builders. |
| Forest dock backdrop | `src/visual/forestEnvironment.ts` — trees, shrubs, ground cover, water ribbons; helpers like `scatterGroundCoverLPCA`, apple-tree rings. |
| World height + creeks | `src/world/idleCraftHeightfield.ts` — heightfield from `project.json` `terrain` + `hydrology`; continuous creek carve along polylines. |
| Project schema | `project.json` — `terrain`, `hydrology.creeks`, optional `dock.homeX` / `dock.homeZ`; parsed in `src/world/idleCraftWorldTypes.ts`, `src/engine/fetchEmpireProject.ts`. |

**Grounding the character (GoE-style):** The preview samples terrain height via the dock heightfield’s `getHeightAt(x, z)` and applies a per-frame vertical correction so feet stay on the surface (same **idea** as GoE NPC ground snap: terrain height minus foot offset). See `syncAvatarFeetToTerrain` / `relevelAvatarFeet` in `characterScenePreview.ts` and compare with `NPC.snapToGround` / `getGroundOffset` in the GoE repo.

---

## EmpireEngine + EmpireEditor (this workspace)

- **Onboarding:** `.agent/00_READ_FIRST.md`, `AGENT_CONTEXT.md`, `LEARNINGS.md`.
- **Flow:** Cursor MCP ↔ EmpireEditor (e.g. `C:\EmpireEditor`) ↔ game running from **this** repo (`npm run dev`, often `http://localhost:3000`). Editor tools write `project.json`, `scenes/`, `recipes/`; the game hot-reloads.
- **LPCA in editor context:** Recipes created via MCP (`recipe_create`) follow the same LPCA rules; entities land in `scenes/main.json`.

When you change `project.json` `hydrology` or `dock` here, the dock scene’s heightfield and spawn read those values through `fetchEmpireProject` / `parseWorldFromProject`.

---

## Game of Empires (reference implementation)

On your machine, GoE typically lives beside this work (e.g. `C:\GameofEmpires`). Use it to compare:

- **Terrain / height sampling** — how play mode resolves ground height.
- **NPC grounding** — `src/entities/NPC.ts` (or equivalent path): `snapToGround`, `getGroundOffset`, alignment to `TerrainGenerator` / height queries.
- **LPCA content** — procedural meshes and merged groups patterns in entities and builders.

**GameofEmpiresDocs** (or your internal GoE docs folder) should describe the same LPCA pipeline and naming; treat those docs as the **authoritative prose** for GoE; this file connects that prose to **IDLE-CRAFT’s** files and Empire tooling.

---

## Quick checklist for new LPCA content in the dock

- [ ] Research + schematic written down (even briefly) before code.
- [ ] Build bottom-up; one material group per merge pass where possible.
- [ ] No new mesh imports.
- [ ] If it sits on the ground, position Y from `getHeightAt` or parent group that already follows terrain.
- [ ] Scatter logic avoids creek corridors (see `COVER_MIN_DIST_RIVER` / `minDistToCreekNetwork` in world code).
- [ ] After changing `project.json`, run the game and confirm hydrology + `dock` spawn match expectations.

---

## Related files in this repo

- `src/world/idleCraftWorldTypes.ts` — `defaultCreeks()`, `readDockSpawn()`, hydrology parsing.
- `src/world/idleCraftHeightfield.ts` — creek network carve, `getHeightAt`.
- `src/visual/forestEnvironment.ts` — backdrop, LPCA scatter, apple trees.
- `src/visual/characterScenePreview.ts` — avatar grounding and framing.

For the editor bridge and MCP tool list, start with `.agent/00_READ_FIRST.md` §3–4.
