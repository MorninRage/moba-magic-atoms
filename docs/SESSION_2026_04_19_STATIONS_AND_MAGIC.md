# Session changelog — 2026-04-19

**Continuation of:** [docs/SESSION_2026_04_18_BUILDING_AND_PENDING.md](SESSION_2026_04_18_BUILDING_AND_PENDING.md) — that session's "Pending work" §1-3 (multi-instance station placement + B1 dock-yard hide) ship in this session, plus a major magic-projectile overhaul + a Three.js dedupe in `vite.config.ts`.

**Audience:** Limin returning to the project, or any agent picking up where this left off. Top-level index of every player-visible change in this session, with file pointers + the rationale behind each.

---

## TL;DR — what changed and why

| Feature | Before | After |
|---|---|---|
| Awakened-mode camp building | Cabin pieces only; campfire / workbench locked to dream-mode dock yard at fixed XZ | Player crafts the materials in dream mode → places campfire / workbench / forge / kitchen anywhere via Build mode |
| Dock-yard campfire / workbench in awakened mode | Visible at the dock yard centre even after awakening (looked like phantom camp) | Hidden in awakened mode — only player-placed stations show |
| Build ghost when opening menu | Stayed active behind the overlay; could be confusing | Cancels on every menu open; player re-picks a kind to re-enter |
| Placed campfires | Look flat — only emissive flame mesh, no orange light bath on logs / stones | Phantom-light pool: up to 4 lit campfires cast real orange glow on surroundings (matches dream-mode dock-yard exactly) |
| Magic projectile visual | Single cyan sphere, fast (25 m/s), brief flash before despawn | 5-layer magical assembly (inner core + iridescent shell + hue-cycling halo + 4 orbiting crystal facets + 6-frame trail), slower (14 m/s), looks like a "magic missile" |
| Magic projectile aim | Camera-forward direction × 40 m fallback; tree-top + steep-pitch failure modes; bolt would fly into ground or off-target | Genuine 3D scene raycast — terrain heightfield + Y-aware obstacle world. Bolt lands at the WORLD POINT under the reticle, no matter how steep the camera pitches |
| Lock-on (T) reliability | Slow bolt grazed past targets without registering damage | Auto-hit gate: within 0.65 m of locked target = guaranteed hit. Aggressive homing (3.2 → 7.5 rad/s) keeps the bolt on track |
| Bolt vs terrain | Slid silently under terrain when shooting down → looked "blocked" | Despawns cleanly at terrain contact |
| First cast of session | 100-400 ms shader-compile freeze | Pre-warmed via `magicProjectiles.warmShaders` |
| Bundle size | ~1,073 kB main chunk (duplicate Three.js from EmpireEngine workspace dep) | ~940 kB main chunk after `vite.config.ts` `resolve.dedupe: ['three']`. ~37 kB gzipped saved |

---

## Feature 1 — Multi-instance craft-station placement (Phase 2 ship)

### Problem

The previous session's TL;DR called this out as the still-pending P1 of base-building. Crafting a campfire / workbench in dream mode put the station at the dock yard, but the awakened world had no equivalent — the dock-yard slots stayed visible at the map centre even after the realm flip, looking like a "phantom camp" the player couldn't customise. A half-built single-position model (`awakenedStationPositions: { campfire: { x; z } | null }`) was scaffolded but never wired (the v23 migration added the field; nothing wrote to it).

### Decision recap (from prior session)

| Question | Locked choice |
|---|---|
| Crafting flow | **A2'** — Build mode picks a kind + spends materials directly at placement, mirroring how cabin pieces work. No "campfire token in inventory" round-trip. |
| Dock-yard slots in awakened mode | **B1** — hide them; only player-placed stations show. |
| First-ship station kinds | Campfire + workbench (real LPCAs); forge + kitchen (placeholder boxes for testing) |
| Floor-top snap | Deferred — ship grid-only snap first |

### What shipped

#### Reverted Option R (the dead single-position model)

- `src/core/types.ts` — dropped `awakenedStationPositions` field.
- `src/core/gameStore.ts` — bumped `STATE_VERSION` 23 → 24. The new v24 migration block `delete o.awakenedStationPositions` (silent no-op when missing) and seeds `placedCraftStations: []` + `placedCraftStationCounter: 0`. Saves loaded at v23 strip the dead field; pre-v23 saves get the new fields default-initialised. Removed the three setters/getters that touched the dead field.
- `src/visual/characterScenePreview.ts` — removed `craftCampfireSlotDreamX/Z` snapshot fields, `awakenedCampfireXZ` / `awakenedWorkbenchXZ` overrides, `setAwakenedCraftStationXZ` / `clearAwakenedCraftStationXZ` API, `applyAwakenedStationOverrides` / `restoreDreamStationSlots` private helpers, and their calls in `setAwakenedFreeRoam`.

#### Multi-instance state model

`src/core/types.ts`:

```ts
export type PlacedCraftStationKind = 'campfire' | 'workbench' | 'forge' | 'kitchen';

export interface PlacedCraftStation {
  id: number;
  kind: PlacedCraftStationKind;
  x: number; y: number; z: number;
  rotY: number;
  hp: number;
  maxHp: number;
}

// Added to GameState:
placedCraftStations: PlacedCraftStation[];
placedCraftStationCounter: number;
```

#### Store API (mirror of cabin-piece pattern)

`src/core/gameStore.ts`:

- `craftStationCost(kind)` — materials per placement (numbers mirror dream-mode `r_campfire` / `r_workbench` / `r_forge` recipes so player intuition transfers).
- `craftStationMaxHp(kind)` — frozen at place-time so future balance retunes don't break existing saves.
- `placeCraftStation(kind, x, y, z, rotY)` — atomic: `hasItems` gate → decrement materials → push fresh entry → save + emit. Returns null on insufficient materials.
- `removeCraftStation(id)` — 50% material refund (anti-grief, matches cabin pattern).
- `getPlacedCraftStations()` — read-only snapshot for renderers + UI.

#### Renderer

`src/world/craftStationBuilder.ts` (NEW — ~340 LOC):

- One `THREE.Group` per placed station (campfire needs per-instance flame `tick()`, so InstancedMesh consolidation isn't worth the lock-step animation cost at expected counts of 1-10 per camp).
- Reuses the existing `createCampfireLPCA` / `createWorkbenchLPCA` factories from `craftStationDecorLPCA.ts` so the visual is IDENTICAL to the dock-yard versions.
- **Phantom-light pool** — see Feature 4 below. The headline detail: pre-allocates 4 phantom `PointLight` pairs at attach time, so multi-campfire camps cast real orange glow on surrounding logs / stones (matches dream-mode dock-yard exactly).
- Rect collision footprint per instance: campfire 0.34 × 0.34, workbench 0.30 × 0.18, forge 0.45 × 0.45, kitchen 0.40 × 0.30 (sized from LPCA bounding boxes).
- `tick(timeSec)` advances every campfire's flame animation each frame (cheap when no campfires placed).
- `buildPieceTemplate(kind)` returns a fresh ghost-preview group for the build-mode controller's overlay.
- `dispose()` tears down both per-instance groups and the phantom-light pool.

#### Build-mode controller (sibling)

`src/world/buildModeController.ts`:

- New `createStationBuildModeController` alongside the cabin `createBuildModeController`. Shares the constants (`GRID_SIZE`, `MAP_EDGE_BUFFER`, `MAX_PLACE_DIST`, the GHOST materials).
- Stations don't snap to each other (each campfire is a discrete camp item) so no `findSnapXZ` / `findSnapY` pipeline — just grid-snap.
- Validity gate uses `collisionWorld.overlaps(candidateRectFootprint)` so trees / cabin walls / other stations / mobs all reject the placement (no overlapping placements possible).
- Same R-rotate / wheel-rotate / LMB-confirm / Esc-cancel UX as cabin pieces.
- Cursor raycasts against placed cabin pieces + placed stations so the ghost sits on top visually when aimed at one (placement still rejected by overlap test).

#### UI

`src/ui/mountApp.ts`:

- Lazy-attach `craftStationHandle` + `stationBuildModeCtl` inside `ensureCabinAttached` (same pattern as cabin handles).
- Subscribe to store emits → `craftStationHandle.syncFromState(store.getPlacedCraftStations())`.
- Per-frame ghost update + campfire flame `tick(now/1000)` in the awakened-mode loop.
- Input dispatch (LMB / Esc / R / wheel) routes to whichever build mode is active. Mutual exclusion: clicking a cabin kind cancels any in-flight station ghost and vice versa.
- Build tab gets a new **Stations** sub-section below the cabin pieces: campfire, workbench, forge (placeholder), kitchen (placeholder). Each card shows kind, max HP, cost; affordability + unlock-card gating mirrors the cabin tier picker.
- Realm flip back to deck cancels the station build mode (matching the existing cabin cancel).
- `src/ui/app.css` — new `.awakened-build-section-header` rule for the visual divider between cabin pieces and stations.

#### B1 — hide dock-yard slots in awakened mode

`src/visual/characterScenePreview.ts` `applyIdle`:

```ts
const showDockCampDecor =
  (this.hasCraftCampfire || this.hasCraftWorkbench)
  && this.pageContext !== 'portal'
  && !this.awakenedFreeRoam;          // <-- new gate
this.craftDecorGroup.visible = showDockCampDecor;
this.craftCampfireSlot.visible = … && !this.awakenedFreeRoam;
this.craftBenchSlot.visible = … && !this.awakenedFreeRoam;
```

Dream mode untouched — dock-yard slots render exactly as before.

### Test list

- [ ] Awakened mode → Tab → Build → Stations → Campfire → place → campfire appears at the ghost spot. Materials decremented. Build mode stays active.
- [ ] Place a workbench. Walk into it; collision blocks.
- [ ] Place 4 campfires in a row. All 4 cast real orange light on nearby logs / stones (light-pool slots claimed). Place a 5th — appears as a campfire mesh with glowing flames but no surface glow (graceful pool overflow).
- [ ] Reload page. Both placements persist. Light pool re-claims slots on reload.
- [ ] Flip to deck mode. Dock-yard campfire / workbench reappear at the centre of the dock. Awakened placements still persist (just hidden).
- [ ] Open Tab menu while a ghost is active → ghost disappears.
- [ ] Click cabin kind while station ghost active → station ghost cancels, cabin ghost takes over.

---

## Feature 2 — Magic projectile overhaul

### Problem

The Phase 1.5 magic projectile was a single emissive cyan sphere flying at 25 m/s. Visually flat ("lava lamp orb"); functionally noisy:

- Aim used `cameraAimPoint(40)` = camera + forward × 40 m. With the staff tip offset from the camera, the bolt's trajectory had a visible angle off-camera-forward, looking like the bolt fired sideways at close range.
- When the camera pitched down (default 3rd-person framing tilts ~10° down to keep the avatar in frame), the aim Y went deep underground → bolt fired steeply down → terrain swallowed it within 0.6 s. Player saw barely a flash.
- Lock-on (T) "homed" the bolt toward the target, but the slow 14 m/s + small mob footprints (rat r=0.4 m) + per-frame swept distance ~0.23 m meant the per-step XZ raycast could graze right past the target without registering damage.

### What shipped

#### 5-layer magical orb

`src/world/magicProjectiles.ts` — full rewrite of the rendering layer:

- **innerCore** — 0.045r bright white sphere, pulses at 8 Hz (the "soul" of the orb).
- **midShell** — 0.10r translucent iridescent `MeshPhysicalMaterial` (same `transmission` + `iridescence` recipe as the staff orb in `vanguardStaffOrbVfx.ts`, so the bolt reads as "the same magic that lives in your staff").
- **outerHalo** — 0.18r additive-blended sphere whose color smoothly cycles cyan → magenta → violet → loop over 1.4 s. Per-orb material instance with a per-orb phase offset so a salvo of 5 orbs reads as 5 distinct missiles, not one giant pulsing ball.
- **crystalFacets** — 4 small octahedrons (cyan / magenta / violet / mint green) orbit the orb at 6.5 rad/s with a vertical wobble. Each facet also tumbles on its own axis. Mirrors the staff-tip glitter aesthetic.
- **trail** — 6-frame fading ghost-sphere comet tail, color-matched to the live halo so it reads as a continuation of the orb's energy.

Phantom-light invariant respected — zero new `PointLight`s per projectile. Glow is carried entirely by emissive materials + the post-processing bloom pass.

#### Speed + homing tuning

- `PROJECTILE_SPEED` 25 → 14 m/s. Skyrim's Firebolt ≈ 15 m/s; Diablo IV's basic spells ≈ 12-18 m/s. Slow enough to read as a discrete magical event; fast enough that mobs at melee range can still hit.
- `PROJECTILE_LIFE_SEC` 3.5 → 4.5 s to keep practical max range similar after the speed cut.
- `HOMING_TURN_RATE` 3.2 → 7.5 rad/s. Aggressive turn rate so a slow 14 m/s bolt can still reliably track a moving wolf / wanderer.

#### Lock-on auto-hit gate

```ts
const LOCKED_TARGET_AUTOHIT_RADIUS = 0.65;
// in update() inside the homing block:
if (dLen < LOCKED_TARGET_AUTOHIT_RADIUS) {
  // guaranteed damage to locked mob; despawn bolt
}
```

When the bolt is within 0.65 m of the locked target, damage applies UNCONDITIONALLY — no reliance on the per-step XZ raycast catching the mob's footprint. Fixes the "bolt grazes the wolf and continues without damaging" case at low speed.

#### Terrain-hit despawn

```ts
const terrainY = opts.getTerrainHeight(entry.group.position.x, entry.group.position.z);
if (entry.group.position.y < terrainY - 0.05) {
  deactivate(entry);
  continue;
}
```

When the bolt drives below the terrain at its current XZ, despawn cleanly. This is what makes "aim straight down" feel right — the bolt visibly leaves the staff, flies down, and stops at the ground instead of clipping under terrain and silently persisting until lifetime expiry.

#### `warmShaders` pre-bake

`magicProjectiles.warmShaders(renderer, camera)` — same proven pattern as `cabinBuilder.warmShaders` and `awakenedMobs.warmShaders`. Parks one placeholder mesh per UNIQUE material at far-off coords (10000 m below ground), calls `renderer.compile(scene, camera)` to JIT every program, drops the placeholders next frame. Wired in `mountApp.ts` right after `attachMagicProjectiles`.

Without this, the first cast of a fresh session triggered a 100-400 ms main-thread shader compile freeze (5 distinct programs: innerCore basic, midShell physical, outerHalo additive basic, crystal standard, trail additive basic).

### Files

- `src/world/magicProjectiles.ts` — full rewrite (renderer + animation + warmShaders + auto-hit + terrain despawn).
- `src/world/awakenedCombat.ts` — `castMagic` aim function rewritten (see Feature 3).
- `src/ui/mountApp.ts` — wires `getTerrainHeight` to projectiles handle + warmShaders call after attach.

---

## Feature 3 — 3D-aware reticle aim (the real one)

### Problem

After several iterations of "raycast aim → camera-forward direction → raycast aim again", the user clarified the actual requirement: **the bolt should land at the genuine 3D world point under the reticle**, not parallel to it. That's proper convergence — find where the camera ray actually intersects the world (terrain, tree, mob, wall), and fire the bolt to THAT 3D point.

The previous iterations failed because:

1. First attempt — `raycastXZ` from camera, no `ignoreOwnerId`. Player capsule was hit at distance 0 → aim collapsed to camera position → bolt fired back at viewport.
2. Second attempt — added `ignoreOwnerId: 'player'` but kept 2D raycast. Y-reconstruction `dist3d = hit.dist / xzLen` became wrong at steep camera pitches (aim Y deep underground).
3. Third attempt — pure camera-forward direction (no raycast). Lost convergence; bolt flew parallel to reticle but missed close targets.
4. Fourth attempt — short-range raycast convergence + camera-forward fallback. Better but still failed when the natural framing tilt (camera looks 10° down at avatar's chest) made aim Y dive into the ground.

### Solution — proper 3D scene raycast

`src/world/awakenedCombat.ts` `reticleAimPoint(maxDist)`:

Two parallel raycasts, take the closer hit:

#### Terrain raycast

Walk the camera ray in coarse 1 m steps. At each sample, check `ray.y < heightField(ray.x, ray.z)`. When the ray crosses below terrain, binary-search the bracket (6 iterations → ~0.015 m precision) to refine the crossing point. This is what makes "aim at the ground in front of me" land the bolt at the exact spot the reticle is on.

#### Y-aware obstacle raycast

`collisionWorld.raycastXZ` extended with new `originY` + `dirY` opts. When provided, each candidate footprint's hit is filtered against the ray's Y at the hit XZ distance against the footprint's `[bottomY, topY]` extent. So:

- Aiming OVER a tree's canopy → ray's Y at the tree's XZ is above the tree's `topY` → tree skipped (no false-positive on its 2D footprint).
- Aiming AT a mob's chest → ray's Y at the mob's XZ falls within the mob's `[bottomY, topY]` → mob registered as a hit.
- Aiming UNDER a roof tile → ray's Y is below the tile's `bottomY` → tile skipped (you can shoot through the air under a high roof).

The Y-aware mode is fully backwards-compatible: callers that don't pass `originY` / `dirY` get the legacy 2D-only behaviour (existing callers like the projectile per-step raycast and melee cone-cast keep working without changes).

#### Pick the closer

Whichever of the two raycasts returns the closer hit (in 3D distance along camera-forward) is the aim point. If neither hits within `maxDist`, fall back to `camera + forward × maxDist` (open-air shot).

Origin = staff tip; direction = (aim - origin).normalize(). Bolt visibly leaves the staff and lands at the world point under the reticle. Standard 3rd-person-shooter "muzzle convergence" behaviour.

### Files

- `src/world/awakenedCombat.ts` — full rewrite of `reticleAimPoint`. New `getTerrainHeight` field on `AttachOpts`.
- `src/world/collisionWorld.ts` — `raycastXZ` extended with optional `originY` + `dirY` for Y-aware filtering. Backwards-compatible.
- `src/ui/mountApp.ts` — wires `h.getTerrainHeight` into both `attachMagicProjectiles` (for terrain despawn) AND `attachAwakenedCombat` (for the aim raycast).

---

## Feature 4 — Phantom-light pool for placed campfires

### Problem

Placed campfires looked dead compared to the dream-mode dock-yard original. The dock-yard campfire keeps two permanent `PointLight`s in the scene with `intensity = 0` from boot, and the LPCA's `tick()` animates them to a real value when the campfire renders (see `characterScenePreview.campfirePhantomFireLight`). That orange glow on nearby logs / stones / ground is what makes the dream campfire feel alive.

The first multi-instance campfire shipped with off-scene dummy `PointLight`s passed to `createCampfireLPCA`. The factory's `tick()` animated their intensity, but the lights weren't in the scene → no surface glow → "fire-shaped lava lamp" with no warm bath of light around it.

But adding fresh `PointLight`s per campfire would flip `numPointLights` and trigger the documented "Campfire 5-second freeze" anti-pattern (see `LEARNINGS.md` "Campfire 5-second freeze — point-light count churn").

### Solution — pool of N pre-allocated phantom pairs

`src/world/craftStationBuilder.ts`:

```ts
const STATION_LIGHT_POOL_SIZE = 4;
const lightPool: { fire: THREE.PointLight; hot: THREE.PointLight; ownerId: number }[] = [];
// Allocate at attach time, park at (10000, -10000, 10000) with intensity 0.
// numPointLights is constant for the rest of the session.
```

When a placed campfire is created, claim a free pool slot, move the phantom pair to the campfire's pit position. The LPCA's `tick()` drives intensity exactly like the dream-mode dock-yard version — visually indistinguishable. When the campfire is removed, return the pair to the pool (intensity → 0, parked off-scene).

Color / distance / decay match the dream-mode phantoms exactly (`0xff8833` / 2.4 / 1.35 for fire; `0xffcc66` / 1.2 / 1.8 for hot).

Pool exhaustion (5+ campfires) gracefully falls back to off-scene dummy lights — those campfires still glow via emissive flame meshes + bloom, just without the surface light bath. Pool size of 4 is a deliberate choice: balances "enough lit campfires for a typical camp" against "8 PointLights in scene is the per-frame lighting budget".

### Engineering invariant

Honors the project-wide phantom-light rule (per `BASE_BUILDING_AND_SURVIVAL_PLAN.md` §10): no fresh `THREE.PointLight` is added to the scene after the one-time pool allocation at builder attach. `numPointLights` stays constant across the entire session — no shader recompile freeze on placement.

### Files

- `src/world/craftStationBuilder.ts` — pool allocation + claim / release helpers + integration into `createInstance` / `disposeInstance` / `dispose`.

---

## Feature 5 — Build ghost cancels on every menu open

### Problem

Tab opened the awakened menu overlay, but the build ghost stayed active behind it. Player would Tab to check inventory, navigate to a different sub-tab, eventually close the menu — and the ghost would still be floating in the world. Confusing UX; player wasn't sure what state they were in.

### Solution

`src/ui/mountApp.ts` `openAwakenedPanel(view)` now drops both build ghosts at the top of the function:

```ts
buildModeCtl?.cancel();
stationBuildModeCtl?.cancel();
```

Covers every "leaving build mode" path:
- Tab pressed to open menu.
- Navigating from Build sub-tab to any other tab (each tab nav is another `openAwakenedPanel(view)` call).

Esc / realm flip / mutual-exclusion (clicking a different kind in the picker) were already cancelling.

To resume building, the player re-opens the Build picker and clicks a kind — same flow as the first time.

### Files

- `src/ui/mountApp.ts` — added the two `cancel()` calls in `openAwakenedPanel`.

---

## Feature 6 — Three.js dedupe in `vite.config.ts`

### Problem

Browser console reported `THREE.WARNING: Multiple instances of Three.js being imported.` More importantly: the bundle shipped TWO copies of Three.js (~150 KB extra). The `empire-engine` workspace dep (`file:../EmpireEngine`) declared `three` as a `peerDependency: ">=0.160.0"` (correct) AND as a `devDependency` install for typechecking. Vite's resolver walked up from each source file's location; the project's source resolved against `idle-deck/node_modules/three` while EmpireEngine's source resolved against `EmpireEngine/node_modules/three`. Two distinct ES module instances → the warning, plus silent failures of cross-bundle `instanceof THREE.Mesh` checks.

### Solution

`vite.config.ts`:

```ts
resolve: {
  dedupe: ['three'],
  alias: { ... }
}
```

Forces Vite to collapse all `'three'` imports to one canonical resolution (the consuming project's `node_modules/three`). Standard pattern for monorepo / workspace setups.

### Result

- Warning gone.
- Main chunk dropped from **1,073 kB → 940 kB** (~133 kB raw, ~37 kB gzipped saved).
- `instanceof THREE.Mesh` checks across the EmpireEngine boundary now succeed reliably.

### Files

- `vite.config.ts` — added `resolve.dedupe: ['three']` with a long header comment explaining the workspace-dep duplication root cause.

---

## Architectural decisions confirmed in this session

| Question | Choice | Implication |
|---|---|---|
| Bolt aim resolution | **3D scene raycast** (terrain + Y-aware obstacles), pick closer hit | Bolt visibly converges on the world point under the reticle. Matches AAA 3rd-person shooter convention (Gears, Fortnite, Last of Us, Skyrim 3P). |
| Magic projectile speed | **14 m/s** (was 25) | Bolt is visible in flight (~3 s to a 40 m target). Skyrim Firebolt / Diablo basic-spell range. |
| Lock-on hit reliability | **Auto-hit within 0.65 m of target** | Slow bolt + small mob footprints made the per-step XZ raycast unreliable; auto-hit gate guarantees damage once the bolt is genuinely on top of its locked target. |
| Phantom-light pool size | **4 pairs** (= 8 `PointLight`s added to scene at boot) | Enough lit campfires for a typical camp; per-frame lighting budget stays tight. Overflow falls back to emissive-only. |
| Multi-instance station crafting flow | **A2'** — direct material spend at placement (not inventory token round-trip) | Mirrors cabin pieces. No "wait, do I have a campfire token in my bag?" confusion. |

---

## Files touched (this session)

### Shipped — keep as-is

- `src/core/types.ts` — `PlacedCraftStationKind` + `PlacedCraftStation` types added; `awakenedStationPositions` removed.
- `src/core/gameStore.ts` — `STATE_VERSION` 23 → 24 + v24 migration; `craftStationCost` / `craftStationMaxHp` / `placeCraftStation` / `removeCraftStation` / `getPlacedCraftStations` API; removed dead single-position setters/getters.
- `src/world/craftStationBuilder.ts` — NEW. Group-per-instance renderer + phantom-light pool.
- `src/world/buildModeController.ts` — `createStationBuildModeController` sibling controller.
- `src/world/collisionWorld.ts` — `raycastXZ` Y-aware mode (optional `originY` + `dirY`).
- `src/world/awakenedCombat.ts` — full rewrite of `reticleAimPoint` (3D scene raycast); `getTerrainHeight` added to `AttachOpts`.
- `src/world/magicProjectiles.ts` — full rewrite of rendering layer (5-layer orb + animation + trail); `warmShaders` added; auto-hit gate for lock-on; terrain-hit despawn; `getTerrainHeight` added to `AttachOpts`.
- `src/visual/characterScenePreview.ts` — removed dead `setAwakenedCraftStationXZ` scaffolding; awakened-mode dock-yard slot visibility gate.
- `src/ui/mountApp.ts` — wires station builder + station build-mode controller; wires `getTerrainHeight` into projectiles + combat handles; build-ghost cancel on menu open; `warmShaders` call.
- `src/ui/app.css` — `.awakened-build-section-header` rule.
- `vite.config.ts` — `resolve.dedupe: ['three']` for workspace-dep three-js dedupe.

### Docs

- `docs/SESSION_2026_04_19_STATIONS_AND_MAGIC.md` — this file.
- `PLAN.md` — Phase 8e entry.
- `LEARNINGS.md` — entries for "3D-aware aim raycast", "phantom-light pool", "Three.js workspace dep dedupe", "lock-on slow-bolt auto-hit gate".
- `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` — Phase 2 status flipped to "Shipped (MVP)"; phantom-light pool documented as part of §10 invariants.
- `docs/SESSION_2026_04_18_BUILDING_AND_PENDING.md` — pending items §1-3 marked done.
- `GAME_MASTER.md` — §11 mentions multi-instance stations.

---

## Still pending (from the prior session, unchanged)

- **Stations placeable on cabin floors.** Future polish: extend `floor` / `foundation` snap-points' `accepts` arrays + add `findStationSnapY` to the station controller.
- **Investigate wanderer / wolf not appearing in awakened mode.** Diagnostic logging in `awakenedMobs.ts` spawn path still needed.
- **Wolf death howl SFX.** CC0 howl + `playWolfDeath()` façade + trigger in `awakenedMobs.ts` on `'dying'` transition.

---

## Forward links

- `docs/SESSION_2026_04_18_BUILDING_AND_PENDING.md` — previous session that scoped the multi-instance work shipped here.
- `docs/SESSION_2026_04_18_HARVEST_AND_PHYSICS.md` — earlier session work (sapling-grow, step-up, predicted-XZ landing, mesh-measured tree tops).
- `LEARNINGS.md` — per-issue deep notes for every fix in this session.
- `PLAN.md` Phase 8e — delivery log entry.
- `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` — master spec; Phase 2 status updated.

---

*End of session 2026-04-19 changelog. Next agent: read top-to-bottom + check the Test list under each Feature before introducing changes to the same files.*
