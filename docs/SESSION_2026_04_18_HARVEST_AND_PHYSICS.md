# Session changelog — 2026-04-18

**Continued in:** [docs/SESSION_2026_04_18_BUILDING_AND_PENDING.md](SESSION_2026_04_18_BUILDING_AND_PENDING.md) — covers the building-snap fix (flush extension), half-built single-position station scaffolding (superseded), and the still-pending requests (multi-instance stations, wanderer/wolf visibility, wolf death howl).

**Scope:** harvest respawn (universal sapling-grow lifecycle) + player physics (auto step-up, predicted-XZ landing, mesh-measured tree tops).

**Audience:** future agents and Limin returning after context rotation. This doc is the single readable index of everything that shipped in this session. Per-feature deep notes live in `LEARNINGS.md`; this doc is the at-a-glance map.

---

## TL;DR — what changed and why

| Feature | Before | After |
|---|---|---|
| Resource respawn | 7-min wait, then snap back at full size | 3-min wait + visible sapling-to-mature growth animation |
| Walk on a floor / foundation / stair | Bonk into it like a wall | Auto step-up to the surface top |
| Land on top of a tree (jumping forward) | Fall straight past it | Predicted-XZ catches the canopy mid-jump |
| Standing height on a tree top | Player feet ~1 body length above visual canopy on medium / big trees | Feet land exactly on the visual canopy (mesh-measured) |
| Foot-snap when standing on built pieces | Dock yanks player back to terrain Y every frame | Foot-snap respects the surface the player walked onto |

---

## Feature 1 — Universal sapling-grow respawn cycle

### What it does
Every harvestable resource (trees, shrubs, berry bushes, rocks / ore, ferns, heather, grass / vine / moss patches, magic crystals) now follows a four-stage lifecycle:

1. **Mature** — visible at full size, harvestable, collision registered
2. **Broken** — invisible, no collision, hp = 0; waits `REGROW_WAIT_SEC = 180 s` (3 min)
3. **Growing** — pops in at a tiny seedling/pebble/sprout scale, visibly grows to full size over a per-kind duration
4. **Mature again** — collision and hp restored, fully harvestable

### Per-kind growth durations and starting sizes

| Archetype | Wait | Grow duration | Start scale | Notes |
|---|---|---|---|---|
| `tree_grow` | 3 min | 60 s | 8% | seedling → giant oak in one minute, smooth ease-out |
| `bush_grow` | 3 min | 30 s | 14% | shrubs / berry bushes / heather |
| `stone_form` | 3 min | 12 s | 30% | rocks "rise" with a small settling wobble in first half |
| `fiber_grow` | 3 min | 18 s | 18% | ferns / grass / vine / moss patches |
| `crystal_emerge` | 3 min | 14 s | 20% | magic crystals — runs on the external Group with a slow upward rotate |

Total cycle: ~3-4 min per resource, down from the prior 7-min snap-back.

### Why it works the way it does
- **No collision during growth** — a 0.08-scale sapling has a 1.5 cm trunk radius. Registering full collision there would block the player from a spot that visually appears empty. Saplings are non-blocking by design; collision re-registers at full radius when growth completes.
- **No harvest during growth** — `getNodeNearAvatar` and `applyHit` gate on `isGrowing` (or rely on `hp == 0` which stays true throughout growth). A sapling can't yield wood. Player has to wait for full maturity to chop again — that's what makes growth feel meaningful.
- **All BatchedMesh / InstancedMesh batching, wind sway, fall animations, and prior performance optimizations preserved.** Growth is just another `setMatrixAt` per frame on the same machinery.

### Files
- `src/world/dockForestBatchedScene.ts` — BatchedMesh path (dock forest trees, shrubs, ferns, patches)
- `src/world/freeRoamHarvestNodes.ts` — InstancedMesh + external-Group path (awakened-mode scatter: apple trees, ore, fiber tufts, crystals)
- Deep notes: `LEARNINGS.md` → *"Universal sapling-grow respawn cycle"*

---

## Feature 2 — Auto step-up + predicted-XZ landing

### Problems fixed
1. **Can't walk onto a floor / foundation / stair.** The cabin floor's collision footprint sat *above* player feet (`topY = 0.05 m` over terrain). The Y-band test treated it as a wall and pushed the player back. Even if the player got past collision, the dock's per-frame `syncAvatarFeetToTerrain` forced `avatar.y = terrainY`, immediately undoing any step-up effect.
2. **Can't land on top of a tree.** When jumping forward toward a tree, the airborne vertical substep only sampled `getGroundY` at `avatar.position.x/z` — which holds the *pre-horizontal* XZ at frame start. The substep never sees the tree (player isn't over it yet). Then horizontal phase moves the player past it, and the next frame's substep rejects the tree because the player has already fallen below the canopy.

### Solutions (four coordinated changes)

#### 2a — Auto step-up in `collisionWorld.inYBand`
New optional `stepUp` parameter (default 0). When `obstacle.topY <= playerBottomY + stepUp + epsilon`, the obstacle is skipped by horizontal push-out. Caller (`freeRoamControls`) passes `STEP_UP_HEIGHT = 0.55 m` while grounded, 0 while airborne (no auto-climb mid-fall — that's what the predicted-XZ lander is for).

`STEP_UP_HEIGHT = 0.55 m` was chosen to match the cabin stair top exactly. Industry references: Unity CharacterController default 0.3, Unreal CMC default 0.45, Minecraft 0.6, Source engine 0.46. Walls (2.4 m), doors (1.8 m), trees (1.6 m+) all far exceed step-up so they continue to block normally.

#### 2b — `getGroundY` accepts a `snapUpHeight`
Old behavior used a fixed 10 cm tolerance, which rejected anything more than 10 cm above feet. So foundations (15 cm) were unreachable for snap-up. Caller now passes `STEP_UP_HEIGHT` for grounded snap-up, while the airborne lander still uses the 10 cm landing slop so the player doesn't get yanked up onto trees mid-fall.

#### 2c — Surface-Y provider on the dock's foot-snap
`characterScenePreview.syncAvatarFeetToTerrain` previously forced `avatar.y = terrainY` every frame, undoing any step-up. New `surfaceYProvider` callback (wired by `mountApp` to `() => freeRoamHandle.getGroundedSurfaceY()`) returns the actual surface Y under the player's feet — terrain OR the top of the foundation / floor / stair / rock the player walked onto. `freeRoamControls.lastGroundedSurfaceY` is written from the post-move `getGroundY` sample so the dock and the controls always agree on "where are the feet?". Provider is cleared on realm flip back to deck (deck mode keeps the simple terrain-only path).

#### 2d — Predicted-XZ in airborne lander
`sampleGroundY` now also samples at `(avatar.x + velX*dt, avatar.z + velZ*dt)` and takes the higher of the two surface Ys. When jumping forward toward a tree, the substep sees the tree on the predicted next-frame position even though the current XZ isn't over it yet. This is the cheap version of full continuous collision detection (Source / Unity sweep tests); fine at our scale.

### Why predicted-XZ rather than swapping phase order
Both vertical-first and horizontal-first orderings have failure modes:
- **Vertical-first** (current order): can't catch trees the player is *about to* reach.
- **Horizontal-first** (the previous order before this fix lineage): when player feet drop below `tree.topY` mid-fall, the Y-band push slides them sideways OFF the tree before the vertical lander snaps them on top.

Predicted-XZ keeps vertical-first (which solves the slide-off bug) AND solves the look-ahead bug — strictly better than either ordering alone.

### Known limit
Giant trees with `sm` ~ 4-5 (canopy 6-8 m above terrain) exceed the player's max apex of ~6 m with double-jump. Smaller and medium trees (apple, birch, pine, balsam at `sm ≤ 2`) are now landable. If "land on giants" becomes a goal the answer is taller jump physics or climbable trunks, not a further collision tweak.

### Files
- `src/world/collisionWorld.ts` — `inYBand` step-up gate, `getGroundY` `snapUpHeight` param, `DEFAULT_STEP_UP_HEIGHT` export
- `src/world/freeRoamControls.ts` — `STEP_UP_HEIGHT` constant, `lastGroundedSurfaceY` state, `getGroundedSurfaceY()` API method, predicted-XZ inside `sampleGroundY`, snap-up in walk-off check
- `src/visual/characterScenePreview.ts` — `surfaceYProvider` field + `setSurfaceYProvider()` setter + collision-aware `syncAvatarFeetToTerrain`
- `src/ui/mountApp.ts` — wires the provider on awakened entry, clears it on awakened exit
- Deep notes: `LEARNINGS.md` → *"Auto step-up + predicted-XZ landing"*

---

## Feature 3 — Tree-top landing height (mesh-measured topY)

### Problem
Even after Feature 2 made tree landing functional, the player's feet stood ~1 body length above the visual canopy on medium and large trees. Smaller trees were perfect. The error scaled linearly with the per-instance scale `sm`.

### Cause
Both harvest paths registered the collision footprint's `topY` from a hand-tuned per-species/per-shape constant multiplied by `sm`:
- `forestEnvironment.ts` → `TREE_SPECIES_TOP_Y_PER_SM` (e.g. apple = 1.6, oak = 1.3, balsam = 1.7)
- `freeRoamHarvestNodes.ts` → `HARVEST_TOP_Y_OFFSET` (e.g. apple_tree = 1.8)

Those numbers were rough estimates that didn't match the actual LPCA-built mesh height. The mismatch scales linearly with `sm`, so an `sm = 2` medium tree had ~1 body length of error.

### Solution — measure the mesh, don't trust the constants

Same idiom Unity / Unreal use to derive collision capsule heights from rendered meshes:

- **`dockForestBatchedScene.ts` `VariantTemplate.maxYAtUnitScale`** — after `mergeByMaterial` and `computeBoundingBox()` per sub-mesh (which we already do for frustum culling), take `max(subMesh.boundingBox.max.y)` across the variant. Each instance's collision `topY` becomes `spec.baseY + variant.maxYAtUnitScale * spec.scale` instead of the prior hand-tuned constant. **Per-variant** measurement (3 LPCA variants per tree species) so each variant's actual canopy max drives its instances' landing surface. Per-variant is essentially free since the bounding box is already computed.
- **`freeRoamHarvestNodes.ts` `KindHandle.maxYAtUnitScale`** — measured the same way after the per-kind merged template is built. Used everywhere the collision footprint is registered: initial scatter, respawn re-register, and grow-finalize re-register, so the surface stays accurate across the full broken → growing → mature lifecycle.
- **Magic-crystal external Group keeps its hand-tuned 1.6 m** (no merged mesh available; was already correct per user feedback).
- 1.0 m fallback if the bounding box is degenerate (`!Number.isFinite`) — defensive, keeps collision sane while making any future LPCA bug obvious.

### Lesson
Any time a hand-tuned size/height constant duplicates data the LPCA mesh already knows about, just measure the mesh. Drift is inevitable with constants because the mesh evolves but the constant doesn't.

### Files
- `src/world/dockForestBatchedScene.ts` — `VariantTemplate.maxYAtUnitScale`, computed in `buildVariantFromTemplate`, used as `measuredTopY` in scatter loop
- `src/world/freeRoamHarvestNodes.ts` — `KindHandle.maxYAtUnitScale`, used in scatter + respawn re-register + grow finalize
- Deep notes: `LEARNINGS.md` → *"Tree-top landing height — measure mesh, don't trust constants"*

---

## How the systems interact (one-frame walk-through)

**Player jumps forward toward a small birch:**
1. `freeRoamControls.update(dt)` runs.
2. Vertical substep loop: `vy += GRAVITY * sub`, `avatar.y += vy * sub`. When `vy < 0` (descending), `sampleGroundY()` checks BOTH current XZ AND predicted next-frame XZ. The predicted XZ is over the birch, so `getGroundY` returns `birchVariant.maxYAtUnitScale * sm + baseY` — the **measured** canopy top.
3. Player descends past that Y → land at the measured canopy top. `lastGroundedSurfaceY` is written.
4. Horizontal phase moves player onto the canopy. `inYBand` skips the birch (player feet now equal `birch.topY`, so they're "on top").
5. Walk-off check finds `groundY == avatar.y` → still grounded; updates `lastGroundedSurfaceY`.
6. Render frame: dock's `syncAvatarFeetToTerrain` consults `surfaceYProvider` → returns `lastGroundedSurfaceY` (canopy top) → snaps feet exactly to canopy. No yank back to terrain.

**Player walks onto a foundation piece:**
1. Horizontal phase: `inYBand` sees foundation `topY = 0.15 m`, player feet at terrain Y = 0. `topY <= playerBottomY + STEP_UP_HEIGHT` → SKIP push-out. Player walks freely onto the foundation's XZ.
2. Walk-off check: `getGroundY` with `snapUpHeight = STEP_UP_HEIGHT` finds foundation top (0.15 m) > current Y (0). Snaps `avatar.y = 0.15`. Updates `lastGroundedSurfaceY = 0.15`.
3. Dock foot-snap consults `surfaceYProvider` → keeps feet at 0.15 m.

**Player chops a tree (broken → growing → mature):**
1. `applyHit` drops `hp` to 0, sets `availableAtMs = now + 180_000`, unregisters collision, pushes a fall animation, marks node in `brokenNodeIndices`.
2. Fall animation runs, instance hidden via `setVisibleAt(false)` (BatchedMesh) or `HIDDEN_MATRIX` (InstancedMesh).
3. After 3 minutes: respawn loop pushes a `tree_grow` animation. Instance becomes visible at `8% * sm` scale (sapling). `isGrowing = true`. No collision yet (sapling is non-blocking).
4. `getNodeNearAvatar` and `applyHit` skip the node while `isGrowing` (or `hp == 0`).
5. After 60 seconds of grow animation: finalizer snaps to full matrix, restores `hp = maxHp`, registers collision at full radius (with mesh-measured `topY`!), clears `isGrowing`, removes from `brokenNodeIndices`. Tree is fully harvestable again.

---

## Test checklist

After any change to the systems above, sanity-check:

- [ ] Walk onto a placed cabin floor → player stands ON it, doesn't bonk
- [ ] Walk onto a foundation (15 cm) → auto step-up
- [ ] Walk up the stairs (55 cm step) → climbs each piece in one W-press
- [ ] Walk into a wall (2.4 m) → still blocks (step-up doesn't apply)
- [ ] Walk into a tree (1.6 m+) → still blocks
- [ ] Jump forward onto a small/medium birch / apple / pine → lands on canopy top, feet visually on the leaves (not above)
- [ ] Walk off the canopy → walk-off detection triggers airborne fall
- [ ] Chop a tree → falls, despawns, 3 min later a sapling pops in and visibly grows over ~60 s into a full tree
- [ ] During growth → can walk THROUGH the sapling, can't chop it
- [ ] Once mature → can chop again, repeat cycle
- [ ] Same flow for shrubs, berries, ferns, heather, rocks, patches, ore, crystals (each kind animates its own grow archetype)

---

## Forward links (related docs)

- `LEARNINGS.md` — detailed per-issue notes (cause / solution / files for each fix)
- `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` §10 — collision invariant origin (Phase 1.5 of the survival plan)
- `docs/AWAKENING_AND_FREE_ROAM_PLAN.md` §7 — free-roam control architecture
- `PLAN.md` Phase 8c — delivery log entry for this session

---

*End of session changelog.*
