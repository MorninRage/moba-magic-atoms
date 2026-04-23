# Trippy Terrain + Bouncy Mushrooms — Plan

**Status:** Plan only. No code changed yet.
**Owner:** future implementing agent (use `LEARNINGS.md` and the cross-references here as the canonical sources).
**Cross-refs:** `docs/AWAKENING_AND_FREE_ROAM_PLAN.md`, `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` (collision invariants §10), `LEARNINGS.md` (all per-issue gotchas), `LORE.md` (palette + tone), `PLAN.md` (Phase 8c — universal sapling-grow respawn cycle).

---

## 0. TL;DR — what we are pulling in

From the sibling project at `C:\stick man` (which shares the EmpireEngine/EmpireEditor stack with idle craft), bring two things into idle craft's awakened/free-roam realm:

1. **Trippy terrain look.** Vivid neon palette (cyan/magenta/lime/orange) driven by slope-aware vertex colors, on top of a `MeshPhysicalMaterial` with subtle transmission + emissive lift. Source: `C:\EmpireEditor\src\builders\TerrainBuilder.ts` (`style: 'trippy'` branch).
2. **Bouncy mushrooms.** The neon mushrooms with cap + stem + drip blobs. Source: `C:\EmpireEditor\src\builders\MushroomBuilder.ts`. **Mycelium is explicitly out of scope** — only the mushroom prop itself.

The mushrooms in idle craft must:
- **Be standable** (player can land on top of the cap, like landing on a tree top via the existing `topY` footprint pipeline).
- **Squash like jello on landing** (cap only — stem stays put). Animated as a damped spring so the squash overshoots back, wobbles, and settles.
- **Act as trampolines** (landing fires an immediate upward bounce). Mario-rules: hold Space at landing for a higher bounce.
- **Visually sync to player movement** (the cap's squash compresses the same frame the player's `vy` zeroes; the player's launch happens the same frame the cap rebounds — no perceptible lag).

---

## 1. What's in stick man (research summary)

Read directly from the EmpireEditor builders shared with the stick man project:

### 1a. `TerrainBuilder.ts` — trippy palette branch
- One `THREE.PlaneGeometry` rotated to the XZ plane, FBM noise heights baked into the position attribute.
- Per-vertex colors picked by **slope + height**:
  - `slope > 0.7` → `rock` (deep)
  - `slope > 0.4` → `rockLight`
  - `slope > 0.28` → `dirt`
  - `slope > 0.15` → `dirtLight`
  - flat & high → `grassDark`
  - flat & low  → `grass`
- Two palettes — `GROUND_COLORS_NATURAL` (forest greens / browns / greys) and `GROUND_COLORS_TRIPPY` (`grass: 0x2effcc`, `dirt: 0xff7fbf`, `rock: 0xffb030` etc — chosen for color-theory complementary pairings with the neon mushroom drips).
- **Trippy material**: `MeshPhysicalMaterial({ vertexColors, roughness: 0.4, metalness: 0.05, transmission: 0.15, thickness: 0.2, ior: 1.2, emissive: 0x111122 })`. The transmission + emissive give the surface its "glowing wet candy" feel under bloom; the natural variant is plain `MeshStandardMaterial` with `roughness: 0.9`.

### 1b. `MushroomBuilder.ts` — mushroom anatomy
- Each mushroom is a `THREE.Group` named `mushroom.lpca` with three sub-parts:
  1. **Stem** — tapered `CylinderGeometry`, `MeshStandardMaterial` with cap-paired stem color and `emissive = stemColor × 0.3`.
  2. **Cap** — half-`SphereGeometry` (top hemisphere, phi 0..π/2), per-vertex displacement on the rim creates `dripCount` "melting wax" lobes. `MeshPhysicalMaterial` with `transmission: 0.55, ior: 1.25, emissive = capColor × 0.45` — the cap is the hero of the visual.
  3. **Drip blobs** — for each rim lobe a child `THREE.Group` named `drip.anim` with a blend sphere + tapered drip body cylinder. The `drip.anim` group's pivot is at the cap rim so animating its `scale.y` stretches the drip downward.
- Vivid 8-color palette (`MUSHROOM_COLORS`): hot pink, cyan, magenta, lime, orange, purple, golden, sky blue.
- `buildMushroomScatter(config, sampleTerrainHeight)` deterministically scatters N mushrooms over a `width × depth` rect with `seed`-derived size / cap shape / stem thickness / drip amount / color / Y rotation. Returns the group + per-drip splat data + the world-space mushroom positions.
- **Mycelium / drip-paint / LivingTerrain are siblings of the mushroom builder.** Stick man wires them together in `GameSceneRunner.ts`. **We are not bringing those over** per the user's spec.

### 1c. Game-design research — Mario / Hollow Knight bounce conventions
- **Mario-style bouncy mushroom**: bounce fires on landing impact. Holding the jump button at the moment of landing yields a higher bounce (held = "boosted bounce"). Ground-pound = even bigger.
- **Hollow Knight pogo**: directional input below the player when an attack lands triggers an upward pogo. Different idiom; not what we want here, but worth noting that the visual squash is universally "compress on impact, overshoot back, settle".
- **Standard implementation (Lucas Van Mol, three.js journey wobbly-sphere lesson)**: damped harmonic oscillator (Hooke spring + linear damping). One impulse per landing event; the spring evolves on its own each frame after that. Cheap (one float per mushroom for displacement, one for velocity).
- **GPU vs CPU**: vertex-shader squash (THREE.BAS / wobbly sphere) is the visual gold standard but adds shader complexity. **CPU `mesh.scale` swap on the cap mesh is plenty** for our use — we already squash the entire cap as a single rigid body, no per-vertex deformation needed for the "jello" read.

---

## 2. What we are bringing into idle craft

| Stick-man asset | Idle-craft target | Notes |
|---|---|---|
| `TerrainBuilder.GROUND_COLORS_TRIPPY` palette | New optional vertex-color path on `forestEnvironment.ts`'s ground mesh | Idle craft's ground is currently a flat `0x314a3a` `MeshStandardMaterial`. We add an alternate trippy path keyed off a new `terrain.style` config field. |
| `TerrainBuilder` slope-color routine | Re-implemented inside `idleCraftHeightfield.ts` (where the idle-craft heightfield + mesh live) so we don't need to touch the shared EmpireEditor source | Same algorithm (slope from finite-differences of height samples), idle-craft's circular grid topology. |
| Trippy `MeshPhysicalMaterial` (transmission + emissive) | Wrap existing `turfMat` swap on the trippy branch | Keep `vertexColors: true` only when trippy — otherwise the current turf material stays. |
| `MushroomBuilder.buildMushroom` (single cap+stem+drips group) | New `src/visual/bouncyMushroomLPCA.ts` | Direct port. Geometry and materials copy stick man's 1:1 (this is the "trippy look" the user picked). Add a `cap` reference returned from the builder so the bounce controller can squash it. |
| `MushroomBuilder.buildMushroomScatter` | New `src/world/awakenedBouncyMushrooms.ts` (mirrors `freeRoamHarvestNodes.ts`) | Owns the InstancedMesh-style scatter + per-mushroom collision footprint registration + bounce state per mushroom. |
| **NOT** `MyceliumBuilder` | — | Out of scope. |
| **NOT** `DripSimulation` / `LivingTerrain` paint | — | Out of scope. The trippy palette stays static. |

---

## 3. Engineering invariants (DO NOT violate)

These are consolidated from `LEARNINGS.md`. Any plan revision must cross-check against them.

1. **No new `THREE.PointLight`s for mushroom glow.** All glow stays emissive + bloom (`'pp-bloom'` is on by default in awakened `'balanced'` tier). The phantom-light pool pattern (`craftStationBuilder.ts`) is for legacy point-lit campfires and does not extend here.
2. **`numDirLightShadows` / `numPointLights` constant after boot.** Don't `.visible = false` then `true` on shadow casters anywhere along the mushroom or trippy-terrain path. (See first-sunset hard-freeze entry in LEARNINGS.)
3. **All collision footprints use the existing `bottomY` / `topY` API.** Mushroom caps are short (~0.5-2 m tall depending on scale); the player must be able to walk under them when crouched would never happen here, so `bottomY = mushroomBaseY` (terrain surface) and `topY = mushroomBaseY + capTopAtRest` works fine. No special small-mushroom skip needed because the player's auto step-up height is 0.55 m (small mushrooms < 0.55 tall walk-overable, big mushrooms blocking — same rules as low rocks vs giant trees today).
4. **Material identity preservation across tile merges.** If we batch-merge mushroom geometry per tile (Phase 2 perf), the cap material must still be one shared instance per color so we don't spawn 80 unique programs (round-2 vegetation tile-merge LEARNING). For Phase 1 we ship one `THREE.Group` per mushroom (no merge); Phase 2 audit covers tile-merge if FPS drops.
5. **Awakened-mode-only.** Bouncy mushrooms attach inside the awakened/free-roam scene only. Dream mode (the dock idle preview) does not spawn them — the dream camera is fixed and the player can't jump. Same realm-flip lifecycle as `awakenedMobs` / build mode.
6. **`saveState` debounce respected.** Bounce events fire at high frequency (~6/sec during a sustained bounce loop). Bounce state is **runtime only** — never persisted. The mushroom POSITIONS / catalog need NO save-state because they're deterministic from a seed (same as harvest node placement is today).
7. **First-use shader compile freeze.** Cap squash uses CPU `mesh.scale` writes only — no shader-program variant. The mushroom material is bound once at scatter time; warm pass (Phase 5 spawn-and-camera in `characterScenePreview.ts`) compiles it like every other awakened material.

---

## 4. Locked design decisions (2026-04-20 user review)

User reviewed §4's open questions and locked in the following. **Implementation is bound by these — any deviation needs a follow-up review.**

1. **Trippy terrain scope: FULL REPLACEMENT (option a).** Awakened ground always renders with the trippy palette + transmissive material. Naturalistic palette is gone from awakened. **Lore framing:** Mira's water-magic dreamscape leaks neon into the awakened world — `LORE.md` should get a one-line addendum noting the visual shift after the awakening event. **No Esc-menu palette toggle needed** (simplifies Phase 1 — drop the systemMenu work; project.json `terrain.style` field also unnecessary, the awakened terrain is hard-wired to trippy).
2. **Mushroom population: SPARSE (15-20).** Spawn budget = **18 mushrooms** scattered across the awakened map. Sparse density keeps each one as a real landmark / traversal beat rather than visual noise. Same deterministic-seed placement; same exclusion rules (no creek overlap, no dock-home overlap, no foundation overlap if any).
3. **Bounce input: AUTO-BOUNCE ON LANDING (option a, Mario-style).** Landing on a mushroom cap fires the bounce immediately. Holding Space at the moment of landing fires the boosted bounce.
4. **Bounce ceilings: DEFAULT (base 11.5 / boosted 16.0).**
   - `BOUNCE_VY = 11.5` m/s, hop apex ≈ 3.0 m above the cap top.
   - `BOUNCE_BOOSTED_VY = 16.0` m/s, hop apex ≈ 5.8 m above the cap top — clears mid-tier trees, almost reaches giant-tree canopy.
   - Multi-bounce chain bonus: `+1.0 m/s` per consecutive bounce within 0.6 s, capped at `+3.0 m/s`. Skill expression: a tight 3-bounce chain ending in a boosted bounce nets ~7-8 m apex.
5. **Mushroom HP: DESTROYABLE.** Magic bolts deal damage. **Phase 4.5 added below** wires this through `magicProjectiles.onStaticHit` (same `mushroom:` owner-id branch the bounce intercept already touches) using the existing `damageCabinPiece`-style HP pipeline. **Respawn:** uses the Phase 8c universal sapling-grow cycle — destroyed mushroom → 3-minute wait → tiny seedling pops in → grows over ~25 s back to full size + collision restored. **HP table:** `MUSHROOM_HP = 5` per mushroom (5 magic-bolt hits at the standard `MAGIC_BUILD_DAMAGE = 1`). Smaller than a tree (which has tier-dependent HP via tools); chosen so a player who *wants* the bounce field gone can clear one in a few shots, but accidental crossfire doesn't wipe the field.
6. **Audio.** Procedural bounce SFX in `src/audio/movementSfx.ts` (extending the existing module): `playMushroomBounceSound(intensity)` — triangle wave 220 → 660 Hz over 80 ms (squish), then a low-pass-swept noise burst (boing). `intensity` scales gain. Zero file deps, same idiom as the wolf-howl rewrite (Phase 8h).

---

## 5. Phased implementation plan

### Phase 1 — terrain palette swap (FULL REPLACEMENT, 1 hr, isolated)

**Goal:** ground mesh in awakened mode always renders with the trippy palette + transmissive material. **No toggle, no per-project config, no Esc-menu UI** — locked decision §4.1. Dream mode (deck preview) stays naturalistic.

1. In `src/world/idleCraftHeightfield.ts`, add a `computeSlopeAt(x, z)` helper using the existing height sampler with finite differences (offsets ±0.5 m). Returns the same `slope` magnitude stick man's `TerrainBuilder` uses.
2. In `src/visual/forestEnvironment.ts` ~line 426 (where `turfMat` is built):
   - Build per-vertex colors on the existing `terrainGeo` using the slope routine + idle craft's existing height field. Stick man's slope thresholds (0.7 / 0.4 / 0.28 / 0.15) work as-is — verify visually and tune if needed.
   - Replace `turfMat` with `new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.05, transmission: 0.18, thickness: 0.25, ior: 1.2, emissive: 0x111122 })`.
   - Vertex colors are baked once at attach time (no per-frame churn).
3. **Verify deck-mode preview is unaffected.** The dock idle preview uses its own much smaller terrain — confirm by visual inspection that this change doesn't bleed into the deck (it shouldn't; `forestEnvironment.ts` is awakened-only).
4. **Smoke test:** `npm run dev` → enter awakened mode → ground reads as cyan/magenta/lime under daylight, glowing under bloom. FPS unchanged (vertex colors are free; transmission cost is ~5% on the ground mesh which is a single draw call).
5. **`LORE.md` addendum:** add a one-liner under §1 or §4 noting "Awakening leaves the world tinted by the dream — surfaces refract neon where Mira's water-magic still pools." Soft narrative cover for the visual shift.

### Phase 2 — port the mushroom prop builder (2-3 hr, isolated)

**Goal:** `src/visual/bouncyMushroomLPCA.ts` exists and `buildBouncyMushroom(config)` returns a `THREE.Group` matching stick man's visual exactly.

1. Copy `MushroomBuilder.buildMushroom` from `C:\EmpireEditor\src\builders\MushroomBuilder.ts` into `src/visual/bouncyMushroomLPCA.ts`. Keep the same param shape (`scale`, `capShape`, `stemThickness`, `dripAmount`, `colorIndex`, `seed`).
2. **Diff vs source:**
   - Add `castShadow = true` on every mesh (already in source).
   - Return shape: `{ group, capMesh, stemMesh, dripGroups: THREE.Group[], capRestY: number, capRestTopY: number }` — the bounce controller needs the cap reference to write `cap.scale` and the rest-Y so it knows where to interpolate back to.
   - Ensure all materials are SHARED across mushrooms of the same `colorIndex` (cache by color index in module scope) — stick man builds fresh materials per mushroom; for our 30-40 spawn count that's 30-40 unique programs → would freeze first-use. Cache → 8 unique programs max (one per `MUSHROOM_COLORS` entry).
3. Verify the cap pivot: stick man builds `cap.position.y = capY = stemH`. For `cap.scale.y = 0.5` to squash the cap downward without sinking through the stem, **shift the cap geometry so its bottom rim sits at y=0 in local coords**. Two options:
   - (a) Recenter cap geometry: `capGeo.translate(0, capR * 0.5, 0)` (shift the dome up by half its radius so y=0 is at the rim). Then `cap.position.y = stemH` keeps the rim at stem-top, and `cap.scale.y = 0.5` shrinks the dome upward (top moves down toward the rim). Bottom stays put.
   - (b) Wrap cap in a `capPivotGroup` whose pivot is at the rim; scale the group instead. Cleaner separation, easier to read.
   - **Recommendation: (b).** Same idiom as the `drip.anim` groups already use.
4. **No bounce wiring yet** in this phase. Just a static mushroom you can drop into a scene file via `scene.add(buildBouncyMushroom({ scale: 1.5 }).group)` to verify it builds, has proper shadows, no shader warnings.

### Phase 3 — scatter + collision footprints (2 hr, depends on 2)

**Goal:** `src/world/awakenedBouncyMushrooms.ts` scatters 30-40 mushrooms across the awakened map and registers each one's collision footprint so the player can stand on the cap (Y-aware just like trees).

1. New module mirroring `freeRoamHarvestNodes.ts`'s shape:
   ```ts
   export interface BouncyMushroomsHandle {
     readonly group: THREE.Group;
     update(dtSec: number, playerXZ?: { x: number; z: number }): void;
     warmShaders(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void;
     onPlayerLanded(mushroomId: string, impactSpeed: number, jumpHeld: boolean): { bounceVy: number };
     dispose(): void;
   }
   export interface BouncyMushroomsOpts { /* terrain + collisionWorld + getTerrainHeight + seed + count */ }
   export function attachAwakenedBouncyMushrooms(scene, opts): BouncyMushroomsHandle;
   ```
2. **Placement:** deterministic hash seed from `project.json` `mushrooms.seed` (default 42 to match stick man). **Spawn budget = 18 mushrooms** (locked §4.2 — sparse). Per-mushroom XZ: rejection-sample inside the awakened circle (radius `terrain.radius - 2 m` so they don't clip the skirt), reject within 4 m of the dock home XZ + within 2 m of any creek polyline (read from the resolved hydrology) + within 1.5 m of any other already-placed mushroom (so they don't clump). Per-mushroom seed-derived: `scale ∈ [0.6, 2.4]`, `capShape`, `stemThickness`, `dripAmount`, `colorIndex`, `rotY`.
3. **Collision footprint per mushroom** (this is the "stand on top like a tree" mechanic):
   - Circle, `r = capR * 0.85` (cap rim, slightly tucked so the player's foot circle has to genuinely overlap the cap, not just brush past).
   - `bottomY = terrainY` (player's circle ALSO blocks at the stem's Y so the player can't walk through the stem at ground level — same as trees today).
   - `topY = terrainY + stemH + capR` (top of the rest-position cap dome). This is the surface the player lands on via `getGroundY`.
   - `tag: 'static'`, `blocking: true`, `ownerId: 'mushroom:<idx>'`.
4. **Per-mushroom bounce state** (runtime, not persisted):
   ```ts
   interface MushroomState {
     squash: number;          // 0 = rest, 1 = max compressed (cap.scale.y = 0.5)
     squashVel: number;       // damped-spring velocity
     lastBounceAtSec: number; // for bounce-chain detection
     chainCount: number;      // 0..3
   }
   ```
5. **Spring update (per frame, all mushrooms):**
   ```ts
   const SPRING_K = 64;     // stiffness — controls oscillation period
   const SPRING_C = 7.5;    // damping — controls how fast the wobble dies
   for (const m of mushrooms) {
     const accel = -SPRING_K * m.squash - SPRING_C * m.squashVel;
     m.squashVel += accel * dt;
     m.squash += m.squashVel * dt;
     // Apply visually (cap pivot group from Phase 2):
     const sy = 1 - 0.45 * m.squash;     // squash 0..1 → scale.y 1..0.55
     const sxz = 1 + 0.22 * m.squash;    // bulge widthwise as it compresses
     m.capPivot.scale.set(sxz, sy, sxz);
     // Optional: drip blobs droop (their pivots are at the rim) — extend by similar factor.
     // Update top-Y in collision footprint to match visual (tiny — just use rest topY for stability; cap squashes BELOW player feet which already launched, so player never sees the gap).
   }
   ```
   Tunable: `SPRING_K = 64` gives ~0.78 s settle time at zeta 0.45 (lightly underdamped — overshoots once before settling). Matches stick man's "wax drip" vibe.
6. **`update(dt, playerXZ)` runs the spring update** for every mushroom every frame. Cost at 40 mushrooms is ~5 floats × 40 = 200 ops per frame — sub-microsecond. The cap mesh `.scale` write is the only real cost (matrix recompute on the mushroom's local transform, ~40 matrix updates). Negligible.
7. **`warmShaders`**: render the mushroom group offscreen once at boot (same pattern as `cabinBuilder.warmShaders` and `magicProjectiles.warmShaders`). Avoids the first-mushroom-in-camera frame freeze.
8. **Lifecycle**: `mountApp.ts` attaches the handle on awakened-mode flip + disposes on flip back to deck (mirrors `awakenedMobs`).

### Phase 4 — landing-triggered bounce (3 hr, depends on 3)

**Goal:** when the player lands on a mushroom cap, the cap squashes AND the player launches up. Holding Space at landing yields a higher bounce. Visually synced — the squash starts the same frame the player launches.

1. Wire `onPlayerLanded` from the bouncy-mushroom handle into `freeRoamControls.ts`'s landing branch. `freeRoamControls.update` already detects landing via `if (opts.avatar.position.y <= groundY)`. We need:
   - The owner-id of the footprint that produced `groundY`. **Today `getGroundY` returns only the Y, not the owner.** Either:
     - **(a)** Extend `collisionWorld.getGroundY` to optionally return `{ y, ownerId }`. Backwards-compatible via overload or an `out` param.
     - **(b)** Add a sibling `getGroundOwnerId(x, z, currY, terrainY, radius, snapUpHeight)` that runs the same scan and returns the owner. Slight duplication, no API drift.
   - **Recommendation: (a)** — it's a 5-line change, keeps the single scan, and the call site already wants the Y.
2. New collision-world API (sketch):
   ```ts
   getGroundYAndOwner(x, z, currentY, terrainY, radius, snapUpHeight?): { y: number; ownerId: string | null };
   ```
   Idempotent with `getGroundY` — implement `getGroundY` as `getGroundYAndOwner(...).y` so existing call sites are unaffected.
3. In `freeRoamControls.update` landing branch (~line 562):
   ```ts
   const { y: groundY, ownerId } = opts.collisionWorld.getGroundYAndOwner(...);
   if (opts.avatar.position.y <= groundY) {
     impactSpeed = Math.abs(vy);
     opts.avatar.position.y = groundY;
     // Mushroom bounce intercept:
     if (ownerId?.startsWith('mushroom:')) {
       const jumpHeld = keys.has(' ') /* or check the buffered-jump window */;
       const result = opts.bouncyMushrooms?.onPlayerLanded(ownerId, impactSpeed, jumpHeld);
       if (result) {
         vy = result.bounceVy;     // upward kick — STAY airborne
         isAirborne = true;
         usedDoubleJump = false;   // restore double-jump for the next arc
         landed = false;           // skip the standard "land" branch below
         playMushroomBounceSound(impactSpeed / 14);
         continue; // skip the rest of the substep — cap squash starts on the bouncy-mushroom side
       }
     }
     opts.avatar.position.y = groundY;
     landed = true;
     break;
   }
   ```
4. `onPlayerLanded` impl in `awakenedBouncyMushrooms.ts`:
   ```ts
   const m = mushroomsById[ownerId];
   m.squash = 0;            // start from rest so the impulse reads cleanly
   m.squashVel = 6 + impactSpeed * 0.3;  // bigger drop → bigger squish
   const inChain = (elapsedSec - m.lastBounceAtSec) < 0.6;
   m.chainCount = inChain ? Math.min(3, m.chainCount + 1) : 0;
   m.lastBounceAtSec = elapsedSec;
   const baseVy = jumpHeld ? BOUNCE_BOOSTED_VY : BOUNCE_VY;
   const chainBonus = m.chainCount * 1.0;
   return { bounceVy: baseVy + chainBonus };
   ```
5. **Visual sync proof.** The squash is started on the SAME frame as the player's `vy` is set to `bounceVy`. Player visibly leaves the mushroom upward; cap visibly compresses below them; cap rebounds while player is mid-arc; cap is back at rest (or close to it) by the time player lands again on the next mushroom. This is the user's "match player movement" requirement.
6. **Edge case — bounce off an already-squashed mushroom.** If chain bouncing fast, the cap might still be at `squash > 0.4` when the next bounce fires. We RESET `squash = 0` first so the new impulse fully expresses (no "weak bounce because the cap was still down"). Player doesn't see a gap because the player is mid-arc above.
7. **Edge case — bounce vs sprint+jump.** The user's existing jump pipeline still works as-is (Space → `tryJump`). The mushroom's launch is INSTEAD of a normal landing — we never fall through to the standard `landed = true` path on a mushroom landing.
8. **Edge case — landing on the cap edge with low impact.** If `impactSpeed < 1.0` (player walked off something tiny right next to the mushroom), the bounce is gentle (cap squishes a little, player launches at minimum vy ~7 m/s — still higher than walking but not a full jump). Smooth scaling: `bounceVy = max(BOUNCE_MIN, baseVy * (impactSpeed / 12))` for `impactSpeed < 12`, full `baseVy + chainBonus` above.

### Phase 4.5 — magic-bolt damage + sapling-grow respawn (1 hr, depends on 4)

**Goal:** mushrooms can be destroyed by magic bolts (locked §4.5) and respawn through the existing Phase 8c universal sapling-grow cycle, just like trees / berries / crystals.

1. **HP per mushroom.** Add `hp` field to `MushroomState` initialised at `MUSHROOM_HP = 5` (5 magic-bolt hits at the standard `MAGIC_BUILD_DAMAGE = 1`).
2. **Damage routing.** In `mountApp.ts`'s `magicProjectiles.onStaticHit` callback (which already routes `cabin:` / `craft_station:` / `harvest:` prefixes), add a `mushroom:` branch:
   ```ts
   if (ownerId.startsWith('mushroom:')) {
     bouncyMushroomsHandle.applyMagicHit(ownerId, MAGIC_BUILD_DAMAGE);
     damageFloaters.spawn(hitXZ, 'mushroom -1'); // cyan floater, label parity with cabin/station
   }
   ```
3. **`applyMagicHit(ownerId, dmg)` impl.** Decrement `hp`. On `hp <= 0`:
   - Hide the mushroom group (set `visible = false` for all sub-meshes; do NOT toggle scene-attach to avoid the documented light-count freeze pattern).
   - Unregister the collision footprint (`collisionWorld.unregister(ownerId)`).
   - Trigger a small "pop" VFX — reuse the existing harvest-break particle pool with the cap's color tint.
   - Set `state = 'broken'`, `respawnTimer = 180` (3 min, matches Phase 8c `REGROW_WAIT_SEC`).
4. **Respawn loop in `update()`.** Per mushroom in `'broken'` state, decrement `respawnTimer`. On reaching 0, transition to `'growing'` with `growT = 0`, `growDuration = 25` (similar to `tree_grow` 60s but smaller-prop fast-grow — closer to `bush_grow`'s 30s). `'growing'` mushrooms set group `visible = true` and animate `group.scale = lerp(0.10, 1.0, easeOut(growT / growDuration))` per frame; collision footprint is NOT re-registered yet (saplings are non-blocking by design — Phase 8c invariant). On `growT >= growDuration`, transition to `'mature'`, scale snapped to `1.0`, collision footprint re-registered, ready to bounce again.
5. **Bounce gating.** In `onPlayerLanded`, if `state !== 'mature'`, return `null` so the standard landing path runs instead — you can't bounce off a sapling or a destroyed (invisible) mushroom. Belt-and-suspenders: footprint is unregistered for non-mature states anyway, so `getGroundY` won't return that owner-id in the first place; the gate is defensive against any race during the registration window.
6. **Reset on realm flip / dispose.** Same lifecycle as harvest nodes — flipping back to deck disposes the handle (footprints clear); flipping back into awakened spawns a fresh batch from the same seed (positions are deterministic).
7. **Save state.** Mushroom destruction is RUNTIME ONLY (matches every other awakened combat / harvest mutation). Reload page → all mushrooms back to mature. **No `STATE_VERSION` bump.** This matches user expectations from harvest respawn.

### Phase 5 — boot warm + perf audit + spawn-budget tuning (1 hr, depends on 4.5)

1. Add `bouncyMushroomsHandle.warmShaders(renderer, camera)` to `characterScenePreview.finalWarmCompileAndRender()`. Compiles all 8 cap material variants + stem variants + drip variants. Gone are the first-bounce visible compile freezes.
2. Smoke-test FPS impact:
   - Embedded preview (deck): unchanged — handle isn't attached.
   - Awakened mode `'perf'` tier: ≥ 100 FPS at 30 mushrooms in view (target). Each mushroom is ~80 verts (cap dome + stem + 4 drips × 24). 30 × 80 = 2400 verts. Cost is dominated by the 30 cap-material draw calls. If FPS drops, batch-merge by color (Phase 5b — only if needed).
3. Smoke-test bounce:
   - Walk off a stair onto a small mushroom → light squash, low bounce.
   - Drop from giant-tree apex (~6 m) onto a tall mushroom → big squash, big bounce, possibly enough to reach the trippy sky bloom.
   - Chain-bounce 4 mushrooms in a row → cap chain visibly increasing.
   - Bounce while holding Space → boosted bounce visibly higher.
   - Bounce with no Space → standard bounce.
   - Land on the rim of a mushroom (off-center) → bounces normally (we don't model edge falloff in v1; that's a v2 polish item).
4. Smoke-test palette swap:
   - Esc menu → Terrain palette → Trippy → ground re-renders neon. Switch back to Natural → ground re-renders standard.
5. Smoke-test save state:
   - Reload page mid-bounce. Mushroom positions identical (deterministic seed). Bounce state resets to rest (correct — never persisted).

### Phase 6 — polish (1-2 hr, after smoke-test)

1. **Bounce SFX.** Procedural in `combatSfx.ts` (or new `world/movementSfx.ts` extension): 200 ms `playMushroomBounceSound(intensity)` — triangle wave 220 Hz → 660 Hz over 80 ms (squish), then a soft `BiquadFilterNode` low-pass swept noise burst (boing). `intensity` scales gain.
2. **Drip wobble during squash.** Each `drip.anim` group's `scale.y` extends by `0.3 * squash` so the drips visibly elongate as the cap compresses. Adds personality, costs nothing.
3. **Damage-floater style label** on bounce — `+5m` showing the bounce apex. Reuses `damageFloaters` infra. Optional / debug-mode-only.
4. **Mushroom-on-foundation parity check.** Does a placed cabin foundation under a mushroom break anything? It shouldn't (mushroom collision is its own footprint, foundation is a rect footprint). Verify the player can bounce off a mushroom that sits on a foundation, with `topY = foundationTop + stemH + capR`. Tweak the spawn placer to skip XZs that overlap any foundation footprint at attach time (foundations exist at attach time only if the player loaded into a save with builds — check `placedCabinPieces` length).

---

## 6. Files to create / modify (locked decisions applied)

| File | Action | Phase |
|---|---|---|
| `docs/TRIPPY_TERRAIN_AND_BOUNCE_MUSHROOMS_PLAN.md` | **NEW** (this doc) | 0 |
| `src/world/idleCraftHeightfield.ts` | EDIT — add `computeSlopeAt` helper exported for the trippy palette routine | 1 |
| `src/visual/forestEnvironment.ts` | EDIT — replace `turfMat` with trippy `MeshPhysicalMaterial` + vertex-color bake | 1 |
| `LORE.md` | APPEND — one-line addendum framing the neon-trippy awakened world | 1 |
| `src/visual/bouncyMushroomLPCA.ts` | **NEW** — port of `MushroomBuilder.buildMushroom` w/ pivot-group capPivot | 2 |
| `src/world/awakenedBouncyMushrooms.ts` | **NEW** — scatter (18 mushrooms) + footprint reg + spring update + `onPlayerLanded` + `applyMagicHit` + sapling-grow respawn | 3, 4.5 |
| `src/world/collisionWorld.ts` | EDIT — add `getGroundYAndOwner` (refactor `getGroundY` to delegate) | 4 |
| `src/world/freeRoamControls.ts` | EDIT — landing branch routes through `bouncyMushrooms?.onPlayerLanded` (auto-bounce, jump-held boost) | 4 |
| `src/visual/characterScenePreview.ts` | EDIT — `setAwakenedFreeRoam(true)` attaches the handle + `finalWarmCompileAndRender` warms | 3, 5 |
| `src/ui/mountApp.ts` | EDIT — own the `bouncyMushroomsHandle`, dispose on realm flip; add `mushroom:` branch in `magicProjectiles.onStaticHit` | 3, 4.5 |
| `src/audio/movementSfx.ts` | EDIT — add `playMushroomBounceSound(intensity)` | 6 |
| `project.json` | EDIT — add `"mushrooms": { "count": 18, "seed": 42 }` | 3 |
| `LEARNINGS.md` | APPEND on completion — entries for trippy palette swap, bouncy-mushroom collision/footprint, jello cap spring, magic-bolt destroy + sapling respawn | end of each phase |
| `PLAN.md` | APPEND on completion — Phase 8l rolling-log entry | end |

**Files NOT touched** (locked decisions removed them from scope):
- ❌ `src/world/idleCraftWorldTypes.ts` — no `terrain.style` field needed (full replacement, no toggle).
- ❌ `src/ui/systemMenuLightingPanel.ts` — no Esc-menu palette radio.
- ❌ `src/engine/rendererDisplaySettings.ts` — no `terrainPalette` patch.

---

## 7. Risks + open mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Trippy palette clashes with the witch / Vanguard tone | medium | Make it toggleable (Q1 in §4 → option (c)). Default = natural; players opt in. |
| Mushroom material shader compile freeze on first cast | low | `warmShaders` at boot (Phase 5 step 1). Same pattern as every other scene-attach. |
| 30-40 cap draw calls drop FPS on integrated GPUs | medium | Phase 5 step 2 measures. Fallback: batch-merge by color (8 draws max) using the `mergeByMaterialTiled` helper from `spatialTileMerge.ts`. |
| Player gets stuck inside a giant mushroom (falls into it from above sideways) | medium | Predicted-XZ landing already in place (Phase 8c). Verify under playtest. The footprint is a CIRCLE so sideways slide-off is the natural failure mode (player slides off the cap edge), not a stuck condition. |
| Bounce out of bounds / through the awakened map skirt | low | `terrain.radius - 2 m` placement margin. Bounces are vertical only — XZ velocity is preserved from the player's last grounded velocity, so overshooting the map requires sustained sprint-jump-bounce which is an intentional skill expression, not a bug. |
| Save-state migration | none | Mushrooms are runtime-only, deterministic from seed. **No `STATE_VERSION` bump needed.** |
| LivingTerrain / Mycelium creep | n/a | Explicitly out of scope per user. Don't port them. |
| Esc-menu palette toggle requires forest rebuild | low | Worst case: dirty-flag triggers a `reload()` (same as graphics tier). Better case: live material swap on the ground mesh. Try the live swap first (10 lines) — it's the same `THREE.Mesh.material = ...` pattern that already works for awakened-mode tier flips. |

---

## 8. Why this is the right architecture

- **Reuses the existing tree-collision pipeline.** Mushrooms get a footprint with `bottomY` / `topY`; the player's `getGroundY` + predicted-XZ land detection already handles "land on top". No new collision primitive.
- **Reuses the existing realm-flip lifecycle.** Awakened-only attach via `setAwakenedFreeRoam` — same pattern as harvest nodes / build mode / mob waves.
- **Reuses the existing warm-shaders pattern.** Same `warmShaders` interface as `cabinBuilder` / `magicProjectiles`. No new freeze patterns.
- **Reuses the existing emissive + bloom invariant.** No new point lights — the cap glow is `emissive × 0.45 × bloomThreshold` (post-Phase-8h tuning).
- **Damped-spring squash is one float per mushroom.** No vertex shader, no GPU compute, no per-vertex deformation. Cheap, robust, frame-rate independent (Hooke + damping integrate cleanly at any dt).
- **Bounce is an INTERCEPT in the existing landing branch.** The change to `freeRoamControls.update` is a 10-line diff; the cap-squash and bounce calculation live in their own module. Easy to roll back if it doesn't feel right in playtest.

---

## 9. What this plan does NOT do

- **No mycelium / drip simulation / LivingTerrain paint.** Per user's explicit "not the mycelium". Ground stays static-vertex-colored at attach time.
- **No Esc-menu palette toggle / no `terrain.style` config field.** Full replacement is locked — awakened ground is always trippy.
- **No Hollow-Knight pogo (downward attack to bounce).** Standard Mario landing-bounce only.
- **No multiplayer sync.** Per-client deterministic placement (same seed everywhere); bounce state doesn't propagate (each player bounces their own copy). Destruction state isn't synced either — each client sees their own destruction independently. Adding sync is a v2 if the game ever ships PvP-on-mushrooms.

---

## 10. Implementation status

**Plan locked 2026-04-20.** All §4 design questions answered. Ready to begin Phase 1 on next agent turn.

Phases 1-4.5 are about 8-10 hours of focused work; Phase 5-6 add 2-3 hours of polish. Total ≈ one solid session.

**Phase order (with cross-phase dependencies marked):**
1. Phase 1 — terrain palette swap (isolated)
2. Phase 2 — bouncy mushroom prop builder (isolated)
3. Phase 3 — scatter + collision footprints (depends on 2)
4. Phase 4 — landing-triggered bounce + jello spring (depends on 3)
5. **Phase 4.5 — magic-bolt damage + sapling-grow respawn** (depends on 4)
6. Phase 5 — boot warm + perf audit (depends on 4.5)
7. Phase 6 — polish (SFX, drip wobble, foundation parity) (depends on 5)
