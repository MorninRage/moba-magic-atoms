# Session 2026-04-19 — Awakened combat + harvest reliability pass

**Companion:** [LEARNINGS.md "Awakened combat + harvest polish"](../LEARNINGS.md), [PLAN.md Phase 8f](../PLAN.md).

## TL;DR — what shipped

Followup pass to Phase 8e. The user reported four overlapping problems:

1. Magic shots don't go where the reticle is pointing — especially when zoomed out, jumping, or standing on a tree.
2. Harvesting is unreliable — water hijacks "press E" near the creek; big trees can't be reached; resources get gathered behind the player's back.
3. Combat freezes / stutters when animals attack and the player attacks back.
4. Picker modals (spell, consumable) render UNDER the inventory overlay — player has to close inventory first.

All fixed in one session. Per-issue root causes + fixes are below.

---

## The pipeline that needed to align

The bolt path involves four stages, each with its own sense of "what is Y at this point in space." When any one of them lies, the bolt visibly misses:

1. **Reticle** — DOM overlay at screen center.
2. **Camera-forward** — `getWorldDirection()` reads from `camera.matrixWorld` (set by the last `lookAt` call).
3. **Aim point** — `camera.position + forward × distance`, where `distance` comes from a raycast vs the world.
4. **Bolt** — fires from staff tip in world space, integrates each frame, collision-checks against the world per step.

If any stage is computing in 2D when it should be 3D, or assuming flat ground when the player is on a tree, the visible bolt path diverges from the visible reticle. This pass fixed every stage.

---

## Fixes in detail

### 1. `getStaffTipWorldPosition` — wrist → real finial

Bolts visibly leaked from the avatar's WRIST, not the glowing staff tip. At long range the wrong origin Y also tilted the bolt's flight vector enough to read as "magic landing below where I'm aiming."

```ts
// before
const v = new THREE.Vector3();
this.handR.getWorldPosition(v);
v.y += 0.4;

// after
if (this.vanguardWizardStaffRoot) {
  v.set(0, 1.103, 0);
  this.vanguardWizardStaffRoot.localToWorld(v);
  return { x: v.x, y: v.y, z: v.z };
}
```

Magic number `1.103` matches `orbCenterY = crownBaseY + 0.085` in `vanguardWizardLPCA.ts`. The staff is parented to `handR`, so per-frame hand pose (idle sway, cast clip arm raise, sprint arm swing) is fully respected.

**File:** `src/visual/characterScenePreview.ts`.

### 2. `reticleAimPoint` — three-candidate, mob-priority, fine terrain step

**Symptoms before:** "Magic lands way below my reticle target." "Magic flies way too fast." Both were the same bug — when aim collapsed from 22 m → 4 m, flight time at 14 m/s collapsed from 1.6 s → 0.3 s.

**Root cause:** Walked the camera ray in **1.0 m terrain steps** and picked `min(terrainHit, obstacleHit)`. Tiny terrain bumps produced false ground crossings that beat real mob hits. No mob preference either.

**Fix:** Three independent candidates, mob unconditionally wins:

1. **Mob hit** (Y-aware, `hitMobsOnly: true`) — promoted to top priority. Returns `mobOwnerId`.
2. **Static obstacle hit** (Y-aware, mobs filtered) — trees, walls, stations.
3. **Terrain hit** with **0.4 m step** + 6-iteration binary refine to ~6 mm precision.

`MIN_AIM_DIST = 1.2 m` (static) / `0.4 m` (mob) prevents degenerate near-camera collapses.

`castMagic` reads the resolved `mobOwnerId` and soft-homes free-aim bolts onto crosshaired creatures (so a moving mob can't dodge between cast and impact).

**File:** `src/world/awakenedCombat.ts` (`reticleAimPoint`, `castMagic`, `AimResult`, `resolveReticleAim` exposed).

### 3. Camera floor-clamp parallel-translate — fixes zoom + elevation aim

**Symptoms before:** "Zoom out misses the target." "Magic shot drifts left when high in a tree." Different surface, same bug.

**Root cause:** `applyCameraFraming` did:

```ts
this.camera.position.set(...);
if (camera.position.y < floorY) camera.position.y = floorY;  // bumps Y up
this.camera.fov = ...;
this.camera.lookAt(lx0 + sdx, ly0 + sdy, lz0 + sdz);  // unchanged
```

When `position.y` was bumped up but `lookAt` was unchanged, `forward = (lookAt - position).normalize()` rotated. Camera-forward no longer matched the player's intended yaw/pitch.

**Fix:** Apply the same `deltaY` to lookAt:

```ts
let lookAtBumpY = 0;
if (camera.position.y < floorY) {
  lookAtBumpY = floorY - camera.position.y;
  camera.position.y = floorY;
}
this.camera.lookAt(lx0 + sdx, ly0 + sdy + lookAtBumpY, lz0 + sdz);
```

Parallel translation of the eye frame — camera-forward direction is mathematically preserved. Same idiom we already use for the right-shoulder offset (shift both endpoints, not one).

**File:** `src/visual/characterScenePreview.ts` (`applyCameraFraming`).

### 4. Combat-ready avatar facing — staff visibly toward reticle

**Symptom:** "Magic goes where character is looking, not where camera is pointing." Bolt visually exited the staff at a weird angle, then line-straightened to the aim point. Looked wrong even though it landed correctly.

**Root cause:** Avatar yaw was driven only by movement velocity. Standing still on a tree to snipe = avatar held its last-walked yaw. Staff is on the avatar's right hand, so its world position depends on avatar facing.

**Fix:** When `isCameraLocked()`, snap-slerp `avatar.rotation.y` to camera-forward yaw at 12 rad/s every frame. Free-cursor mode keeps the legacy "facing follows velocity" path; the velocity branch is gated `if (!isCameraLocked)` to prevent fighting.

**File:** `src/world/freeRoamControls.ts` (per-frame `update` — combat-ready facing block + skip velocity-facing when locked).

### 5. Y-aware bolt collision — bolts no longer despawn on trees they fly OVER

**Symptom:** "Magic doesn't reach the reticle when shooting from a tree." Bolt detonated mid-air a few metres in front of the player.

**Root cause:** Per-frame collision was 2D-only:

```ts
opts.collisionWorld.raycastXZ(prevX, prevZ, ux, uz, segLen, { ignoreOwnerId: PLAYER_OWNER_ID });
```

That treats every blocking footprint as INFINITELY TALL. A bolt at Y=9 flying over a tree topping at Y=8 still "hit" the tree's flat XZ footprint and despawned.

**Fix:** Pass `originY` + `dirY` (the Y-aware mode added in Phase 8e on `collisionWorld.raycastXZ`):

```ts
const prevY = entry.group.position.y - segDy;
const dirY = segDy / segLen;
const hit = opts.collisionWorld.raycastXZ(prevX, prevZ, ux, uz, segLen + INNER_CORE_RADIUS, {
  ignoreOwnerId: PLAYER_OWNER_ID,
  originY: prevY,
  dirY,
});
```

Now the bolt's actual world-Y at the candidate footprint's XZ is checked against the footprint's `[bottomY, topY]` band. Bolts above the canopy sail clean past.

**File:** `src/world/magicProjectiles.ts`.

### 6. Magic-as-universal-damage / magic-as-harvest

User: "Shots from magic need to do damage to building, enemies, character, trees, rocks, everything — and just as when we harvest, that object has an animation as it despawns; from a distance the player gets the resource added to their inventory. The harvest is equal to the stone pick or axe in terms of damage and yield."

**Plumbing:** generic `onStaticHit(ownerId, hx, hy, hz, damage)` callback on `MagicProjectilesHandle`. Bolt's existing collision handler dispatches non-mob hits to the callback (mob hits keep their existing path).

**Routing in `mountApp.ts`:**

| Owner-id prefix                | Handler                                                                 |
|--------------------------------|-------------------------------------------------------------------------|
| `mob:<id>`                     | Existing damage path (unchanged).                                       |
| `harvest:<kind>:<idx>`         | `harvestHandle.applyHit(node, store.getHarvestHitsMultiplier(kind))` — same chip yield + final yield + tool wear + despawn animation as melee press. |
| `dock-forest-batched:<kind>:<idx>` | `dockForestHandle.getNodeByIndex(idx)` then same flow with `yieldKindForObsKind` mapping. |
| `cabin:` / `craft_station:`    | Silent despawn (no player-build HP system yet).                         |

Added `getNodeByIndex(idx)` on `DockForestHandle` so the routing avoids scanning the full nodes array. Cyan `-N` damage floater spawns at the hit point for distance feedback.

**Files:** `src/world/magicProjectiles.ts`, `src/world/dockForestBatchedScene.ts`, `src/world/freeRoamHarvestNodes.ts`, `src/ui/mountApp.ts`.

### 7. Reticle-only harvest dispatch

**Symptoms before:** Standing in the creek next to a tree → press E always filled the bucket (water won by proximity), never harvested the tree. Mixed-resource clusters were unpredictable; the player would chop a fern when they wanted the rock right next to it.

**Fix:** In awakened + camera-locked mode, the reticle is the SOLE target picker. Two gates BOTH have to pass:

1. **Reticle gate** — camera-ray world hit lands on a harvestable thing.
2. **Physical-reach gate** — `surfaceDist = max(0, centerDist - collisionRadius) <= HARVEST_AVATAR_REACH (1.3 m)`.

If either fails, the press is consumed silently — NO proximity fallback. "Press E" prompts hidden in awakened mode (universal-harvest contract = "anything visible is harvestable"). Free-cursor mode keeps the legacy proximity dispatch for non-combat dock interaction.

**Files:** `src/ui/mountApp.ts` (`onInteract`), `src/world/awakenedCombat.ts` (`resolveReticleAim` exposed).

### 8. Tree collision = trunk only — big trees harvestable

**Symptoms before:** "Lots of trees won't let me harvest, won't let me get close enough." Max-scale dock-forest oaks (`radius * sm` reaching 1.6 m+) pushed the player out at center-distance > the legacy 1.8 m harvest gate.

**Fix:** Two compounding changes:

- Per-species collision radii cut to actual TRUNK silhouette (not canopy edge):
  - apple 0.40 → 0.24
  - pine 0.32 → 0.20
  - birch 0.28 → 0.18
  - fir 0.34 → 0.22
  - oak 0.42 → 0.26
  - awakened-scatter `apple_tree` 0.45 → 0.30
- SURFACE distance instead of CENTER distance in the reach gate. Required exposing `collisionRadius` on `ScatteredNode` and `DockForestHarvestNode` public types.

Player can now walk *under* the canopy and stand right next to the bark to harvest. Visible canopy stays as decoration.

**Files:** `src/visual/forestEnvironment.ts`, `src/world/freeRoamHarvestNodes.ts`, `src/world/dockForestBatchedScene.ts`, `src/ui/mountApp.ts`.

### 9. Combat freeze — debounced `saveState`

**Symptom:** "When animals attack me and I attack them, aspects freeze."

**Root cause:** `saveState()` is called from 23 mutating store methods. Each is a synchronous `JSON.stringify(state)` + `localStorage.setItem` of a multi-KB object — 15-50 ms of main-thread block per call. Awakened combat fires saves at high frequency:

| Event                       | Save call                       |
|-----------------------------|---------------------------------|
| Player cast (LMB)           | `useMana` → save                |
| Each mob hits player        | `damagePlayerInAwakened` → save |
| Each mob takes damage       | `damageAwakenedMob` → save      |
| Mob kill                    | `grantCurrency` → save          |

With 6 mobs alive that's 7-10 saves per second of a multi-KB state — visible stutter on every event.

**Fix:** Coalesce all `saveState` calls within a `SAVE_DEBOUNCE_MS = 250 ms` window into a single deferred write. The latest snapshot reference always wins (one write of the final state instead of 20 sequential writes of intermediates). `pagehide` / `beforeunload` / `visibilitychange` flush the pending save synchronously so a normal browser close persists everything.

Worst-case crash loss is 250 ms of state changes — invisible for combat ticks, irrelevant for purchases (subsequent mutations refresh the timer anyway).

**File:** `src/core/gameStore.ts`.

### 10. Picker modal z-index — spell + consumable pickers float above inventory

**Symptom:** Click an empty spell or consumable slot from the inventory page (Tab → Inventory) and the picker rendered UNDER the inventory overlay.

**Root cause:** Both pickers used `position: absolute; z-index: 95`. Mounted as a child of `shell`, they were stuck in the shell's stacking context. The awakened menu overlay (`.awakened-menu-overlay`) is `position: fixed; z-index: 9100` — that creates a higher stacking context the absolute pickers can never escape.

**Fix:** Change both to `position: fixed; z-index: 9300`. They now participate in the global stacking context and float above any open page overlay.

**Files:** `src/ui/spellPickerModal.ts`, `src/ui/consumableSlotPickerModal.ts`.

---

## Cross-cutting "do NOT" rules learned this pass

- **Don't** read `camera.getWorldDirection()` after mutating `camera.position` if you haven't called `lookAt()` again — the matrix is stale.
- **Don't** clamp `camera.position.y` without applying the same bump to `lookAt` — you'll silently rotate the camera-forward vector and break aim.
- **Don't** use 2D-only `raycastXZ` for any swept-3D query (projectiles, line-of-sight, etc.). Always pass `originY` + `dirY`. The 2D mode treats footprints as infinitely tall and produces ghost hits on anything the ray flies above.
- **Don't** call `saveState` synchronously in any high-frequency hot path. The debounced version is now the only correct choice; if you need a guaranteed flush (death, page unload), call `flushPendingSave()` directly.
- **Don't** mount picker modals with `position: absolute` if they need to float over `position: fixed` overlays — different stacking contexts. Always `position: fixed` for true overlay modals.

---

## Pending work / known follow-ups

- **Player-build HP system.** Magic currently despawns silently on `cabin:` / `craft_station:` hits. If the player wants to tear down their own walls with magic, add HP + a destroy animation per piece kind. Out of scope for this pass.
- **First-cast freeze investigation.** `magicProjectiles.warmShaders` already pre-bakes the orb shaders, so the first cast itself shouldn't freeze. If a freeze still appears on the FIRST mob death (or first impact SFX, or first damage floater), instrument before guessing — likely audio decode or first-time floater DOM allocation.
- **Tighter reticle-pick radius for ground cover.** Current `getNodeNearAvatar(hitXZ)` uses a generous 1.5 m search around the hit point. Dense ground-cover clusters could feel less precise. Tune if user reports it.
