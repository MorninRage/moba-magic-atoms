# Base building, crystal wraps, survival, PvP destruction — master plan

**Status:** Phase 1 in flight (single session, 2026-04-18). Phases 2–7 are docs-only at this point.

**Companion docs:** [`AWAKENING_AND_FREE_ROAM_PLAN.md`](AWAKENING_AND_FREE_ROAM_PLAN.md) (the realm-mode bridge that gates building behind awakened state), [`MULTIPLAYER_ROADMAP.md`](MULTIPLAYER_ROADMAP.md) (co-op vs 1v1 friendly-fire rules), [`LORE.md`](../LORE.md) §11 (the Vanguard Wizard's pre-curse mastery of magical log construction). When this doc is silent on a detail, treat it as not-yet-locked and propose an addition before locking.

This is the canonical specification for awakened-mode base building, the crystal-wrap magical-defense system, the 7 Days to Die-style survival loop (mob waves, raids, damage, repair), the storage system (chests + crates), and the PvP destruction ruleset. Other docs link here; do not duplicate sections elsewhere.

---

## 1. Vision

The Vanguard Wizard's awakening into the 3D world recovers an ancient craft buried by the curse: **magical log construction**. The player establishes a base wherever they choose on the awakened-mode dock map, builds it piece by piece (foundation → walls → roof → doors), reskins each piece with progressively rarer materials (rough log → oak → copper-banded → bronze → silver → gold → platinum) for greater durability, and infuses individual pieces with **crystal wraps** (parallel to the staff-crystal upgrade tree) to add magical defensive properties.

The reward loop is survival: the Witches Guild's hunters arrive in escalating mob waves — sparse during the day, dense at night, peaking on a "blood moon" raid every Nth in-game day. Mobs path toward the player and damage placed pieces in the way. Higher-tier materials and crystal wraps stretch the player's defensive runway between repairs.

In multiplayer, **co-op** teammates' pieces and chests are friendly (no damage from teammates, shared chest access). **1v1 PvP** allows the opposing player to damage the other player AND their pieces; destroyed pieces drop a fraction of their material cost as loot.

This loop only activates in **awakened mode**. Deck mode remains unchanged — no building, no raids, no chest looting in the dream-prison.

---

## 2. Piece catalog (locked for Phase 1)

| `kind` | Category | Snap rules | Prerequisites | Default base cost | Default base HP |
|---|---|---|---|---|---|
| `foundation` | Structural | Snaps to 1.5 m XZ grid; needs flat-ish ground (slope < 18°) | none | 4 logs | 100 |
| `pillar` | Structural | Snaps to foundation corners | foundation directly below | 2 logs | 80 |
| `wall_solid` | Structural | Snaps to foundation/wall edges | foundation OR wall directly below | 4 logs | 80 |
| `wall_window` | Structural | Same as wall_solid | foundation OR wall directly below | 4 logs (window cutout) | 70 |
| `wall_doorway` | Structural | Same as wall_solid | foundation OR wall directly below | 3 logs (smaller piece) | 60 |
| `door` | Functional | Snaps into a `wall_doorway` opening | wall_doorway present | 2 logs + 1 iron_ingot | 50 |
| `floor` | Structural | Snaps onto foundation top, between walls | foundation + 2 walls adjacent | 3 logs | 60 |
| `ceiling` | Structural | Snaps onto wall tops | walls forming an enclosed footprint | 4 logs | 70 |
| `roof_slope` | Structural | Snaps to wall tops or other roof_slope | wall directly below OR roof_slope adjacent | 5 logs | 90 |
| `roof_peak` | Structural | Snaps to two opposing roof_slope | two roof_slope adjacent | 3 logs | 80 |
| `stairs` | Functional | Snaps to foundation top; rotates to face | foundation directly below | 4 logs | 60 |
| `gate` | Functional | Same as door but 2× width; needs `wall_doorway` × 2 | 2 adjacent wall_doorway | 4 logs + 2 iron_ingot | 100 |
| `ladder` | Functional | Snaps to wall side | wall_solid present | 2 logs | 40 |

All pieces use the dock's existing 1.5 m XZ grid for placement. Vertical stacking uses an AABB raycast against the nearest piece below.

### 2.1 Snap point system (Phase 1.5 — locked; tightened 2026-04-18)

Each piece kind defines a **`snapPoints: SnapPoint[]`** array (data shape and pipeline ported from GoE's `BUILDING_SYSTEM.md`). A snap point is `{ offset: piece-local Vector3; direction: 'top'|'bottom'|'north'|'south'|'east'|'west'; accepts: CabinPieceKind[] }`. The build-mode controller's per-frame target pipeline runs:

1. **Center-ray raycast** from the camera (NDC `(0,0)` — i.e. screen center) against (a) terrain plane via heightfield sampler, (b) AABBs of all placed pieces; pick closest hit within `MAX_PLACE_DIST = 30 m`.
2. **Grid-snap** XZ to the 1.5 m grid.
3. **`findSnapXZ`** — lateral cardinal-direction snaps (N/S/E/W) on existing pieces; closest beating **`LATERAL_SNAP_DIST = GRID_SIZE * 1.5 = 2.25 m`** distance overrides XZ. Returns `sameKind: boolean` so the choose-between rule below can short-circuit.
4. **`findSnapY`** — top-stack snaps with wall-on-foundation alignment rule + AABB-overlap fallback. Threshold **`TOP_SNAP_DIST = 1.0 m` euclidean** so the top-stack only competes when the cursor is genuinely OVER the placed piece's footprint (matches GoE's "ghost OVERLAPS top snap point" intent).
5. **Choose-between rule (GoE flush-extension):**
   - If `findSnapXZ` matched a **same-kind** placed piece (floor next to floor, wall next to wall, ceiling next to ceiling, foundation next to foundation, roof_slope next to roof_slope) → use the lateral snap, SKIP top-snap competition entirely. This is the "deck extension" rule — same-kind pieces always extend flush at the same Y level.
   - Otherwise, if both lateral and top matched, pick the closer-to-cursor candidate (closer-to-cursor preference matches GoE for mixed-kind cases).
   - No snap matched → fall back to grid-snapped XZ on terrain.
6. **Validation** — collision-world overlap test (replaces the previous 0.5 m proximity hack).
7. **LMB** confirms placement (swapped from the earlier E binding for parity with GoE).

> **2026-04-18 update:** the prior 3.0 m euclidean lateral threshold + 4.5 m manhattan top-snap threshold caused new floors to stack on the foundation underneath an existing floor instead of extending flush. The same-kind-lateral-wins rule + tighter thresholds restore GoE-style behavior. See `LEARNINGS.md` → *"GoE-style flush snap"* and `docs/SESSION_2026_04_18_BUILDING_AND_PENDING.md`.

Per-kind snap point arrays:
- `foundation`: 4 cardinal-edge snaps (accept walls), 1 top-center (accept floor / pillar).
- `wall_solid` / `wall_window` / `wall_doorway`: 1 top-center snap (accept ceiling / next-row wall), 2 side snaps (accept adjacent wall).
- `pillar`: 4 cardinal mid-height snaps + top.
- `floor` / `ceiling`: 4 cardinal-edge snaps.
- `roof_slope`: 1 top-center snap (accept roof_peak), 2 side snaps (accept adjacent roof_slope).

---

## 3. Material tier system

| Tier | id | Cost multiplier | HP multiplier | Unlock card | Notes |
|---|---|---|---|---|---|
| T0 | `rough_log` | 1.0 (logs only) | 1.0 | none (boot default) | Baseline; cheapest, weakest |
| T1 | `oak` | 1.0 (logs only — different palette) | 1.4 | `c_card_carpentry` (TBD if not present) | Tighter grain, darker palette |
| T2 | `copper_band` | 1.5× logs + 1 copper_ingot | 2.0 | `c_card_alloy_crucible` | Copper banding around joints |
| T3 | `bronze_band` | 1.6× logs + 1 bronze_ingot | 2.8 | `c_card_alloy_crucible` | Bronze banding |
| T4 | `silver_band` | 1.8× logs + 1 silver_ingot | 4.0 | `c_card_precious_arc` | Silver banding + faint cyan rune trace |
| T5 | `gold_band` | 2.0× logs + 1 gold_ingot | 5.5 | `c_card_precious_arc` | Gold banding + brighter rune emissive |
| T6 | `platinum_band` | 2.2× logs + 1 platinum_ingot | 8.0 | `c_card_precious_arc` | Platinum banding + vivid bioluminescent runes |

**Visual continuity rule:** every tier still reads as "log cabin" — logs stay the dominant silhouette across all tiers; bands and runes are accents, not replacements. A platinum-tier wall is still recognizably a log wall, just with bioluminescent platinum joinery.

**Unlock UI:** the Build tab shows all tiers in the picker; locked tiers are greyed out with a tooltip naming the unlock card requirement.

**Balance disclaimer:** the cost multipliers and HP values above are starting points. Final balance will be tuned in Phase 4 once the damage system exists and we can measure how many T2 walls survive a Wave-3 raid vs how many T6 walls survive a Wave-10 raid.

---

## 4. Crystal wrap system (Phase 3)

Mirror of the staff-crystal upgrade pattern from `vanguardWizardLPCA.ts`. Each placed piece has ONE `crystalWrap` slot (the field exists from Phase 1 in the state model so adding wraps doesn't require a save migration).

### 4.1 Wrap categories

| Category | Property | Visual signature |
|---|---|---|
| `defense` | +50% HP shield (recharges out of combat); 25% incoming damage resistance | Cyan crystal nodules + cyan emissive rim |
| `regen` | Auto-heal 1 HP/sec while undamaged for 10 sec; faster repair-tool restoration | Green-blue crystal nodules + green emissive rim |
| `offense` | Radiates damage to mobs within 3 m every 1.5 sec | Violet crystal nodules + violet emissive rim |
| `utility_light` | Acts as a constant low-intensity area light (still emissive-only — see §10 phantom-light rule) | Amber crystal nodules + amber emissive glow |
| `utility_ward` | Deters specific mob kind (e.g. `dream_hound` won't target this piece) | Pale-grey crystal nodules + faint white emissive |

### 4.2 Wrap mechanics

- **Crafting:** at the forge. Recipe table TBD in Phase 3 — each wrap consumes 1 magic_crystal + tier-appropriate ingot + a category-specific catalyst.
- **Application:** in awakened mode, equip the wrap as the active hotbar item, walk near the target piece, press E. Wrap consumed; piece's `crystalWrap` field updates.
- **Removal:** holding the right modifier + E removes the wrap permanently (no refund — commitment cost). HP shield collapses immediately.
- **Stacking:** one wrap per piece. To change wraps, remove the existing one first.

### 4.3 Wrap visual

Each wrap appends 2-4 small crystal nodules (octahedron geometry, 6-10 cm) to the piece's exterior at predetermined anchor points (corners for walls, peaks for roofs, centers for floors). Each nodule uses `bioluminescentCrystal(color)` material from `magicalCabinMaterials.ts`. The piece's existing rune-inlay material gets a tinted emissive boost in the wrap's signature color while a wrap is active.

---

## 5. Survival dynamic — mob waves & raids (Phase 4)

### 5.1 Mob roster

| id | Tier | Base HP | Base damage | Spawn behavior | Visual |
|---|---|---|---|---|---|
| `dream_hound` | 1 | 25 | 4 | Pack of 2-3, sparse during day, dense at night | Quadruped LPCA, dark fur with cyan eye-glow |
| `shadow_warden` | 2 | 60 | 9 | Solo, only at night | Tall hooded humanoid, smoke-wreathed |
| `witch_thrall` | 3 | 110 | 14 | Solo or pair, blood-moon raids only | Cursed villager, pale skin + bound runes |

### 5.2 Spawn cadence

- **Day:** 1 dream_hound every 4 in-game minutes, max 3 alive at once. Ambient threat only.
- **Night:** 1 dream_hound every 1.5 minutes + 1 shadow_warden every 6 minutes; max 6 alive.
- **Blood moon (every 7 in-game days):** 6 dream_hounds + 3 shadow_wardens + 1 witch_thrall arrive in a co-ordinated raid wave, pathing toward the player's nearest base footprint. If the player has no base, they path toward the player directly.

### 5.3 Pathing & target selection

- Mobs initial target: the avatar's current XZ.
- If the path to the avatar is blocked by a placed piece (collision check — Phase 4 introduces piece collision), mob switches target to that piece. Damage applied via melee attack on contact.
- Pieces destroyed at 0 HP collapse visually (scale tween 1→0 over 0.4s + dust puff) and drop **40% of their material cost** as a loot pile at the piece's XZ.
- Repaired pieces: HP restored at the workbench using a fraction of the original material per HP point.

### 5.4 Difficulty scaling

Mobs scale with `pveWave` using the existing PvE formula `Math.pow(1.18, cycles) * (1 + wave * 0.028)`. Same scaling for HP and damage. The blood-moon timing is tied to in-game days (existing day/night cycle from `dayNightWeather` system).

---

## 6. Damage / durability / repair (Phase 4)

### 6.1 Damage events

- **Source:** mob melee, PvP-player projectiles/melee (1v1 only), explosives (TBD if added).
- **Application:** `store.damageCabinPiece(id, amount)` — clamped to 0; emits.
- **Visual feedback:** damaged pieces show a per-tier emissive crack (red-orange, intensity scales with damage %). Pieces below 30% HP also show a slow particle drip (sparks for metal-band tiers, splinters for wood tiers).
- **Destruction event:** at 0 HP, fire `cabinPieceDestroyed(id, byMob | byPlayer)`. Visual collapse animation runs in `cabinBuilder.ts` (similar to the harvest fall VFX); then the piece is removed from state and a loot pile spawns at its XZ.

### 6.2 Repair UX

- Walk near a damaged piece in awakened mode with the workbench in proximity (within 6 m of any owned workbench).
- "Repair" prompt appears (Press E to repair; cost: X logs + Y ingot per HP point).
- Repair cost per HP = `materialCost * 0.012` per point — so a wall with maxHp=80 and base cost 4 logs costs ~3.84 logs to fully repair. Always rounds up to whole units.
- The workbench requirement gates repair to "you have a base" players, not "you can repair from anywhere".

### 6.3 Crystal wrap interaction with damage

- `defense` wrap: incoming damage reduced 25% AFTER it would land; the wrap's HP shield (50% of base maxHp) absorbs the rest before piece HP ticks down.
- `regen` wrap: while no damage event for >5 sec, piece HP regens 1/sec up to maxHp.

---

## 7. PvP destruction (Phase 6)

### 7.1 Co-op (no friendly fire)

- Co-op session players' pieces are tagged `{ ownerSessionId }`. Damage events from other players in the same co-op session are dropped at the engine boundary (zero damage, no SFX).
- Same rule for player-on-player damage: co-op players cannot damage each other.
- Chests in co-op are SHARED — any teammate can open and take. No locking.

### 7.2 1v1 PvP

- Both players can damage each other AND each other's pieces.
- Destroyed pieces drop the same 40% material loot the mob system uses.
- Chests in 1v1 are LOCKABLE — a chest with a lock requires sustained melee/projectile attack to break open (separate `chestLock_HP` field). Once broken, contents are visible to and takeable by either player.
- Loot from destroyed pieces does NOT belong to either player by default — first player to walk into the loot pile picks it up.

### 7.3 1v1 victory & state

- 1v1 doesn't currently have a "destroy enemy base to win" condition; the existing PvP duel resolves by HP. Building destruction in 1v1 is purely additional loot pressure.
- Future Phase 7 may add a "destroy 50% of enemy base" optional victory condition for the Hunter game mode. Out of scope for Phase 6 ship.

---

## 8. Storage system (Phase 5)

Ported (slimmed) from GoE's `BuildingSystem` storage methods.

### 8.1 Chests + crates

| id | Slots | Cost | HP (T0 wood / T6 platinum) | Lockable in 1v1 |
|---|---|---|---|---|
| `wooden_chest` | 12 | 6 logs | 60 / 360 | Yes |
| `iron_crate` | 24 | 4 logs + 2 iron_ingot | 90 / 540 | Yes |

Each is its own `kind` in the placement system (treated like cabin pieces — same ghost preview, same per-tier reskin pipeline, same persistence).

### 8.2 Storage state

Each chest/crate carries a `contents: Record<string, number>` of inventory items. Capped by slot count (each unique resource = 1 slot regardless of qty within slot — matches GoE).

### 8.3 Carry mechanic

- Empty chest/crate can be picked up (added back to player inventory as `wooden_chest` × 1).
- Non-empty chest/crate cannot be picked up (must empty first or break it).
- Pickup UX: walk near the chest, hold E for 1 sec → chest disappears, inventory ticks up.

### 8.4 Open / take UX

- Walk near a chest, press E → opens a side-panel showing the chest's contents.
- Click an item to take 1; shift-click to take all of that resource.
- Co-op visibility: chest UI shows everyone's transactions in a tiny activity log at the bottom of the panel.

---

## 9. Implementation phases

| Phase | Scope | Status |
|---|---|---|
| **Phase 1** | Piece-based log-cabin builder; material tier reskins; ghost preview; persistence; render | **Shipped** |
| **Phase 1.5** | Camera-lock toggle (Q); GoE-style snap pipeline (snap points + findSnapXZ + findSnapY + center-ray); world-wide lightweight 2D collision; real-time combat (LMB attack / RMB block / T lock-on / magic projectile from staff tip / mob waves of rats / wolves / wanderers) | **Shipped** |
| **Phase 2 (MVP)** | Multi-instance station placement (campfire + workbench real LPCAs; forge + kitchen placeholder boxes for now). Build mode picks kind → grid-snapped placement → direct material spend. Phantom-light pool gives placed campfires real surface glow. Dock-yard slots hidden in awakened mode (B1). See [SESSION_2026_04_19_STATIONS_AND_MAGIC.md](SESSION_2026_04_19_STATIONS_AND_MAGIC.md). | **Shipped (MVP — 2026-04-19)** |
| Phase 2 follow-ups | Forge / kitchen LPCAs (replace placeholders); stations placeable on cabin floor / foundation tops via `findStationSnapY` + extended `accepts` arrays; well / garden / cooler / repair_bench placement | Future |
| Phase 3 | Crystal wrap system (categories, recipes, application UX, visuals) | Future |
| Phase 4 | Full raid cadence (blood-moon waves, escalating difficulty); piece HP damage + repair UX; BVH upgrade for vertical/slope collision | Future |
| Phase 5 | Storage (chests + crates + carry mechanic + slot UI) | Future |
| Phase 6 | PvP destruction in 1v1; co-op friendly-piece rules; chest locking | Future |
| Phase 7 | Polish + balance pass + tutorial + (optional) "destroy 50% enemy base" 1v1 victory | Future |

Each future phase will get its own dedicated planning pass before implementation; this doc captures the locked design surface they all conform to.

---

## 10. Engineering invariants (locked, do not violate in any phase)

These rules hold across all phases of this work and must be honored by future implementations:

- **Phantom-light rule.** No phase ever creates fresh `THREE.PointLight`s at runtime. All "lit" effects (forge fire, crystal wrap glow, blood-moon ambience, magic projectile glow, impact flash, etc.) use emissive materials + the existing post-processing bloom. Re-references LEARNINGS.md "Campfire 5-second freeze — point-light count churn (2026-04-17)" and the related sunset / torch entries.
- **Phantom-light pool pattern (Phase 2+).** When a system needs N lit instances at runtime where N is unbounded but small (e.g. multiple placed campfires), pre-allocate a SMALL POOL of phantom `PointLight`s at attach/boot time, parked off-scene with intensity 0. Each instance claims a slot from the pool when it spawns and releases it on dispose. The pool's `numPointLights` contribution is constant for the session (no recompile freeze). Pool exhaustion gracefully falls back to emissive-only. See LEARNINGS.md "Phantom-light pool — multi-instance lit objects without recompile freeze (2026-04-19)" + `craftStationBuilder.ts` for the canonical implementation.
- **Awakened-mode gate.** Building, crystal wraps, raids, PvP destruction, storage looting, camera-lock, real-time combat, mob waves all require `realmMode === 'awakened'`. Deck mode never sees any of these systems. The `craftDecorGroup` deck-mode camp slot stays as it is (no migration of deck-mode state into the new system).
- **Save schema additions are forward-compatible.** The Phase 1 state model already includes `crystalWrap: null` and `hp / maxHp` fields so Phases 3 and 4 don't trigger another `STATE_VERSION` bump. Future fields follow the same pattern: add now, default-safe in `migrateLoaded`, leave unused until the relevant phase.
- **Co-op friendly-fire-OFF, 1v1 friendly-fire-ON.** Single rule, applied identically to player damage and structure damage. See `MULTIPLAYER_ROADMAP.md` §3 for the network-layer specifics.
- **InstancedMesh per (kind, tier).** Render strategy stays flat — large bases are common, draw-call growth must stay sublinear in piece count.
- **Collision applies to EVERYTHING.** Every world-space entity (cabin pieces, trees, crystals, ore nodes, stations, mobs, player) registers a 2D footprint with the awakened-mode collision world. Player and mobs cannot walk through anything. Build-mode placement validates against the same world (no two pieces occupy the same footprint). See §12 below.
- **Awakened-mode runtime state is NOT persisted.** Spawned mobs, in-flight projectiles, lock-on target — all reset on reload. Matches the existing `activeGather` runtime pattern. Save schema stays small.

---

## 12. Camera-lock toggle (Q) — Phase 1.5

Awakened mode adds a Q-toggle that swaps the input contract between two stable modes:

| Mode | Cursor | Mouse motion | LMB | RMB | Camera | Double-click reset |
|---|---|---|---|---|---|---|
| **Free cursor** (default) | visible, free | not consumed | no-op (canvas drag still orbits camera in dock-style) | no-op (canvas drag still pans) | dock's solo orbit, wheel zoom | yes (resets framing) |
| **Camera-locked** (after Q) | hidden via Pointer Lock API | drives camera yaw + pitch (FPS-style) | combat or build confirm (see §13 + §2.1) | block (combat) or no-op (build) | distance frozen at lock-time; follows avatar from that fixed offset | DISABLED — won't fight the lock |

**Avatar facing.** Camera-locked mode uses **free-yaw**: the avatar's body rotates only when WASD movement is input (or when the lock-on system re-orients to face a target). The camera can look around without dragging the avatar's facing — you can strafe-walk forward (W) while looking 90° to the left.

**Pointer-lock release.** Browser releases pointer-lock on `Esc` or alt-tab; the controller listens for `pointerlockchange` and exits camera-lock automatically when released.

**Trigger contexts.** Q works any time in awakened mode. Build mode auto-engages camera-lock when the player picks a piece (cursor → ghost preview); combat/exploration uses Q manually.

---

## 13. Real-time combat (Phase 4 prep — early ship)

Combat in awakened mode runs in real time (not the deck's turn-based battle screen). All combat input is gated on **camera-lock active AND not in build mode**.

### 13.1 Inputs

- **LMB** — attack. Action dispatched by `state.equipment.weapon`:
  - **Wand / staff** (`apprentice_wand` / `journeyman_staff` / `archmage_staff`): cast a magic projectile from the staff-tip world position. Mana cost per shot via `useMana()`. Animation: `battle_cast` clip in place.
  - **Axe / sword** (any `EQUIPPABLE_WEAPON_IDS` melee item): center-ray cone-cast (2.5 m, 30° cone) — first mob in cone takes damage. Animation: `battle_strike` clip in place.
  - **Bare hand**: 1 damage, 1.0 m range, melee path.
- **RMB** — block. Only meaningful with a shield equipped: incoming damage reduced by 60% while RMB is held.
- **T** — lock-on toggle (Z-targeting). See §13.3.

### 13.2 Magic projectile

Pool of 16 emissive cyan orbs (no `THREE.PointLight` — emissive material + bloom). Origin AND visual at the staff-tip world position. Travels at 25 m/s. Per-frame: integrate position; XZ raycast against the collision world; on mob hit → apply damage + spawn impact sprite; on static hit → impact + free; out-of-range → free.

### 13.3 Lock-on system (T)

Press T to acquire the **nearest mob in the 30° forward cone within 25 m**. While locked:
- Camera yaw lerps toward the target (slow, ~3 rad/s slerp).
- Magic projectiles **home** toward the locked target with a limited turn rate (so jumping enemies still get hit, but not instantly).
- A/D become **strafe-around-target** (strafe-circle the target instead of camera-relative strafe).
- A small reticle renders on the target's chest.
- Lock releases on T, target death, or target leaving the 25 m radius.

### 13.4 Mob waves

Reuses existing `pveEnemyLPCA.ts` builds (rats, wolves, wanderers/deserters). Each mob is its own `THREE.Group` (count is small enough that InstancedMesh isn't needed; per-mob bone animation matters more).

| Mob | Base HP | Damage | Aggro | Melee range | Speed |
|---|---:|---:|---:|---:|---:|
| `rat` | 12 | 3 | 18 m | 1.0 m | 4.5 m/s |
| `wolf` | 28 | 6 | 22 m | 1.4 m | 5.5 m/s |
| `wanderer` | 55 | 11 | 18 m | 1.6 m | 3.5 m/s |

**Spawn cadence (Phase 1.5 ship — simple wave system; full raid cadence stays Phase 4).** Every 25 sec while alive count < 6 in awakened mode, spawn one mob 25 m+ away from the player at a random angle. Mob kind weighted by `pveWave` — early waves favor rats; later waves favor wolves and wanderers.

**AI tick (per mob, per frame).** State machine: `idle` (wander random within spawn region) → `chase` (when player within aggro range, walk toward player) → `attack` (when player within melee range, play attack clip + apply damage on contact frame, then cooldown 1.2 s) → `dying` (HP=0, death clip plays, despawn after 1.5 s).

### 13.5 Damage exchange

- Mob → player: `store.damagePlayerInAwakened(amount, sourceKind)`. Reduces existing `playerHp`. Block reduces by 60%. Permadeath path unchanged at 0 HP.
- Player → mob: `awakenedMobsHandle.damage(id, amount, fromXZ)`. Reduces mob HP. Mob enters `dying` state at 0.

### 13.6 Mid-air combat

LMB while airborne fires from the staff-tip's CURRENT world position (which moves with the body during the jump arc). Magic projectile inherits zero vertical velocity from the player jump (so aim doesn't get throw off by jumping). Lock-on targeting still applies. Result: jumping while shooting feels acrobatic but predictable.

---

## 14. Out of scope

- World expansion beyond the current dock `mapRadius` — base building uses the existing dock map only. Larger world is a separate `WORLD_TERRAIN_*` track.
- Vehicles or mounts. Players walk.
- Player-built pathfinding (the mob AI uses simple "go toward target; if blocked, attack blocker") — no full nav-mesh on Phase 4 ship.
- Trading between players. Chests are the only player-to-player item transfer mechanism.

---

*Last updated: 2026-04-18 — Phase 1 in flight (single session).*
