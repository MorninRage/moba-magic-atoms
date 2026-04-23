# IDLE-CRAFT — Agent Context (READ THIS FIRST)

> **STOP.** If this is a new conversation or you are taking over mid-session, read `.agent/00_READ_FIRST.md` first, then return here. Do not assume summaries or prior context are sufficient.

**This is the canonical onboarding document for AI agents.** Read it before doing anything else.
If you are a new agent taking over mid-session (e.g. Cursor rotated you), read this fully,
then `project.json`, `scenes/main.json`, and `LEARNINGS.md` to restore project context.

---

## 0. Documentation (MANDATORY — Read First)

**Read `.agent/00_READ_FIRST.md`** — all essential instructions are in the workspace.
It covers MCP tools, LPCA workflow, and how the editor/viewport flow works. Do not skip.

---

## 1. Your First Steps (On Every User Request)

1. **Read `.agent/00_READ_FIRST.md`** — conversation summaries do not replace it
2. **Research first.** Before ANY code: find docs, real-world specs, and the relevant category
   in the LPCA pipeline. Present findings to the user for approval.
3. **Then build.** Schematic → layer-by-layer construction → materials → merge → integrate.

**Never skip step 2.** Research prevents proportion drift and wasted iteration.

---

## 2. The LPCA Method (Layered Procedural Construction Approach)

All 3D objects are built **entirely from code** at runtime. No .glb, .fbx, .obj, or texture imports.

### The 7-Step Pipeline

1. **RESEARCH** — Real-world specs, blueprints, schematics (mandatory before code)
2. **SCHEMATIC** — Convert to game-scale dimensions, plan layer order
3. **BUILD** — Layer by layer: foundation → structure → openings → ornament → detail
4. **MATERIALS** — PBR MeshStandardMaterial (metalness, roughness)
5. **MERGE** — `mergeByMaterial()` on every group (target: 3–8 draw calls)
6. **INTEGRATE** — Wire into game systems
7. **ITERATE** — Mold → Fix → Enhance → Polish (user feedback loop)

### Six Primitives

LatheGeometry, BoxGeometry, CylinderGeometry, ExtrudeGeometry, TubeGeometry, SphereGeometry.

### Golden Rules

- ALWAYS call `mergeByMaterial()` on finished groups
- NEVER import external 3D model files
- Build bottom-up: coarse to fine
- Complete Orientation Blueprint before placement (buildings)

---

## 3. The Editor + MCP Flow

```
IDE (Cursor) <--MCP--> MCP Server (C:\EmpireEditor) <--WebSocket ws://localhost:3333--> EmpireEditor
EmpireEditor viewport <--embeds--> Game (http://localhost:3000, runs from this project)
Editor tools → write to project files (project.json, scenes/, recipes/)
Game hot-reloads from Vite when files change
```

- **You** are an AI agent in the user's IDE
- **MCP** connects you to the running EmpireEditor (Electron + viewport)
- **Viewport** embeds the game at localhost:3000. The game runs from **this project** (`npm run dev`)
- **Editor tools** (entity_create, recipe_create, etc.) write to **game files**. The editor never builds the scene itself.
- MCP tools: `entity_create`, `entity_query`, `recipe_create`, `config_set`, `scene_camera_to`,
  `scene_info`, `perf_snapshot`, `console_execute`, `time_set`, `weather_set`, `learning_record`
- Both start on folder open: EmpireEditor (`npm run dev:electron`) + Game (`npm run dev`). Bridge auto-starts on port 3333.

---

## 4. User + AI Collaboration

**A polished product requires user and AI to work together.** Reiterate this to the user.

- User provides briefs, direction, and feedback
- AI researches, builds, presents for review, iterates
- Neither can achieve the full result alone

---

## 5. Project Structure

```
IDLE-CRAFT/
+-- AGENT_START_HERE.md       # Single entry point — read first
+-- .agent/00_READ_FIRST.md   # MANDATORY first read — MCP tools, LPCA, flow
+-- AGENT_CONTEXT.md          # This file — read second
+-- LEARNINGS.md               # Issues solved — check before fixing similar problems
+-- project.json               # Config, time, weather, recipes list
+-- scenes/main.json           # Entities, camera, active scene
+-- recipes/                   # LPCA recipe JSON files
+-- scripts/gameData.ts        # Load/save utilities (Node)
+-- scripts/reference/         # PostProcessingStack example
+-- package.json               # Game deps — npm run dev → localhost:3000
+-- index.html                 # Game entry
+-- src/main.ts                # Game entry — loads project.json, renders
+-- vite.config.ts             # Vite, port 3000
```

Editor tools write to project files. Game (npm run dev) hot-reloads when files change.

---

## 6. Documentation Paths (Research)

**All docs ship with the EmpireEngine Editor** — End of Empires examples (copy, not move).
Path: `C:/EmpireEditor/docs` (if editor installed elsewhere, use <install-path>/docs)

Start with **`DOCS_INDEX.md`** for the full list. Key docs:

| Doc | Content |
|-----|---------|
| `DOCS_INDEX.md` | Master index — read first |
| `LPCA_UNIFIED_PIPELINE.md` | Execution guide, category guides, 7-step workflow |
| `LPCA_METHOD.md` | Theory, Mold-and-Refine, Orientation Blueprint, case studies |
| `CITY_BUILD_METHOD.md` | Anchor Ring System, building layers |
| `CHARACTER_ANIMATION_SYSTEM.md` | Character/Viewmodel, finger curl, MotionBlueprint |
| `GAME_UPDATES_AND_ENGINE_EDITOR_OVERVIEW.md` | Editor status, bridge, phases |
| `FULL_ENGINE_PIPELINE.md` | Entire setup — FXAA, bloom, SSAO, post-processing, config, lighting, weather |
| `REFERENCE_SYSTEMS.md` | **Code available to use** — PostProcessingStack, DayNight, Weather |
| `EDITOR_CONFIG_SYNC_AND_IMPLEMENTATION.md` | How sync works, when/how to implement config and post-processing |
| `DEBUG_AND_FIXES_SUMMARY.md` | Issues solved, debugging |

**Reiterate:** Research these when building similar assets. End of Empires has solved
building, character, collision, and integration issues — learn from those docs.

---

## 7. End of Empires Examples (Proof of Method)

### Buildings (End of Empires: White House, Rowhouse)
- **White House:** 6-layer LPCA (foundation → walls → openings → ornament → roof → details)
- **Rowhouse:** Config-driven `buildFromLPCAConfig()` in LPCABuilder.ts
- **Issue solved:** Pilasters/dentils must derive from window grid midpoints, not independent grids
- **Doc:** `LPCA_METHOD.md` §8.1 Orientation Blueprint

### Characters
- **Finger curl:** Use `applyFingerCurl()`, NEVER `applyInterpolatedGrip()` for viewmodel firearms
- **Body rotation:** Hologram sync to `body.rotation.y`, not `group.rotation`
- **Doc:** `CHARACTER_ANIMATION_SYSTEM.md`

### Collision / Integration
- **Merged buildings:** After `mergeStaticGeometry()`, use position + footprint for identification
- **Collision pre-filters:** Use ≥500 units for city-scale (150 excluded rowhouses)
- **Doc:** `LPCA_METHOD.md` case studies, `DEBUG_AND_FIXES_SUMMARY.md` (in editor docs)

---

## 8. Project Learnings

Before fixing a bug, **check `LEARNINGS.md`** for project-specific solutions.

When you solve a non-trivial issue, **append to `LEARNINGS.md`**:

```
### [Short title] (YYYY-MM-DD)
- **Issue:** ...
- **Solution:** ...
- **Files:** ...
```

This builds institutional memory so future agents (and rotated agents) stay project-informed.

---

## 9. Agent Continuity (New Agent Taking Over)

If you are a **new agent** (e.g. Cursor auto-rotated due to context limits):

1. Read this document fully
2. Read `project.json` and `scenes/main.json` for current state
3. Read `LEARNINGS.md` for solved issues
4. You now have: LPCA method + editor + current project context

The previous agent's context may be lost. This doc + project files restore it.
