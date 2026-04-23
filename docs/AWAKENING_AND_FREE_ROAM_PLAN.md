# Awakening — shards, witches, free-roam mode

**Status:** Phase A–D in flight (single session, 2026-04-17). Cutscene work deferred.
**Companion docs:** [`LORE.md`](../LORE.md) (narrative bible — Acts 2 & 3), [`PLAN.md`](../PLAN.md) (delivery log), [`GAME_MASTER.md`](../GAME_MASTER.md) (systems map). When this doc is silent on a detail, treat it as not-yet-locked and propose an addition before locking.

This document captures the locked design + scope for the **central narrative bridge** of IDLE-CRAFT — the deck-prison → 3D world transition explicitly framed in [`LORE.md`](../LORE.md) §6 + §10.

---

## 1. Lore alignment (why this matters)

This system implements the entire **Act 2 → Act 3** arc:

- **Act 1 (shipped, `intro_the_curse`)** — the deck IS the prison.
- **Act 2 (this work)** — defeat the three Witches Guild members from the shattering cutscene (`s7b`/`s7c`/`s7d`). Each drops a fragment of the silver talisman. The shattering cutscene's title card — **"RECLAIM THE SHARDS"** — is the literal player objective the whole game has been pointing at.
- **Act 3 (this work)** — third shard restores the talisman, the spell breaks, the Vanguard wakes into the 3D world. The unimplemented cutscene anchor `awakening_break_the_spell` (LORE §10) lives at this transition; this doc stubs it as a fade-to-white for now (real production deferred to a later session per `docs/CUTSCENE_PIPELINE.md`).
- Act 4 future: descend into the deeper dream to find Mira. **Out of scope.**

The three witches use the canonical voices from LORE §8: **cori** (eastern coven, sneering), **jenny** (iron-box, procedural), **kristin** (mocking, cackling). Encounter order matches cutscene order.

---

## 2. Locked design decisions

These were nailed down across the session's design conversation. Do not silently revise — open a discussion if you need to change one.

| # | Decision | Locked value |
|---|---|---|
| 1 | Battles between witches | **Every 15 PvE wins** the next encounter is a witch (cori → jenny → kristin in order). 45 wins total to free yourself. |
| 2 | Witch difficulty curve | Same scaling formula as regular PvE (`pveWave`-based: `Math.pow(1.18, cycles) * (1 + wave * 0.028)`). Higher base HP / damage than wolf. |
| 3 | Free-roam input scheme | **WASD only** (no click-to-move). Mouse for camera yaw. |
| 4 | In-world harvest input | **`E` key** to interact when within proximity of a harvestable node. Hint label "Press E" floats above the node. |
| 5 | Mode toggle direction | **Two-way.** Player can return to deck-mode after awakening. Lets us test both modes without resetting the save. |
| 6 | Magic crystals | Reuse the existing **ground crystal props from `idleCraftCrystalProps.ts`** (already on the map as the sky-crystal seal scatter). Do NOT create a parallel module. |
| 7 | Map content | **Every metal + every harvestable item visible on the map.** In deck mode they're hidden until unlocked by deck progression; in awakened mode they're always visible. For **dev/testing** an `idleCraft.devUnlockAllNodes` flag forces all visible. |
| 8 | Crystal-driven crafting | Crystals fuel a **new staff/wand crafting tree** that produces upgraded magic weapons (more powerful than current spell cards alone). Becomes the primary post-awakening progression vector. |
| 9 | Render budget | All scattered nodes go through `mergeByMaterial()`. Target: scattering ~50-150 new instances should add ≤ 5 draw calls. |
| 10 | Cutscene `awakening_break_the_spell` | **Stub as fade-to-white** for now. Real cutscene production deferred to a future session. |
| 11 | Inventory continuity across modes | All inventory + equipment + helpers carry over both directions. Cards/decks/idle-slots stay accessible (player put work into them; we don't punish the awakening with a wipe). |
| 12 | Awakening tab visibility | Tab is **always visible** during dev (`idleCraft.devUnlockAwakening` defaults to `'1'`). For final ship, gate to `shards.cori || shards.jenny || shards.kristin`. |
| 13 | Save migration | Bump `STATE_VERSION`; new fields default-safe. Existing saves continue to work in deck mode. |

---

## 3. State model

```ts
// src/core/types.ts additions
export type RealmMode = 'deck' | 'awakened';
export type WitchShardId = 'cori' | 'jenny' | 'kristin';
export type ShardState = Record<WitchShardId, boolean>;

// New GameState fields
realmMode: RealmMode;            // default 'deck'
shards: ShardState;              // default { cori: false, jenny: false, kristin: false }
witchBattlesUntilNext: number;   // default 15; decremented on PvE win when a witch is still pending
witchOrder: WitchShardId[];      // default ['cori', 'jenny', 'kristin']; pop from front when one is defeated
magicCrystalsHarvested: number;  // default 0; contributes +0.5 max mana per crystal (Phase D)
```

**Computed fields (no storage):**
- `getCanBreakFree()` → true when `shards.cori && shards.jenny && shards.kristin`, OR when `idleCraft.devUnlockAwakening === '1'`.
- `getNextWitchEnemyId()` → first id in `witchOrder` that isn't already defeated, or `null`.

---

## 4. Battle scheduling rule

Inside `startPveBattle`:

```text
if (witchBattlesUntilNext <= 0 && getNextWitchEnemyId() != null) {
  → spawn witch (e_witch_cori | e_witch_jenny | e_witch_kristin)
  → mode stays 'pve' but enemy uses witch stats + spell-attack VFX
} else {
  → existing rat / deserter / wolf rotation
}
```

Decrement happens on `endBattleVictory` (existing path) only when the next encounter would still be a regular enemy AND a witch is still pending. When a witch is defeated, reset counter to 15 and pop from `witchOrder`.

---

## 5. Realm-mode UI rules

| `realmMode` | Nav tabs | Dock | Input | Notes |
|---|---|---|---|---|
| `'deck'` | All visible (gather, craft, inventory, decks, idle, rpg, battle, hire, awakening, portal) | Sticky bottom dock as today; click-driven gather | Existing click flow | Awakening tab shown; everything else identical to today |
| `'awakened'` | **Hidden** by default | Full-screen 3D | **WASD** moves avatar; **E** harvests; **Tab** opens menu overlay; **ESC** opens system menu | Tab-overlay re-exposes inventory/decks/etc. as full-screen panels above the world. ESC unchanged. |

The "Return to dream-prison" toggle lives in the system menu in both modes for round-trip testing.

---

## 6. Witch enemies

Three new `EnemyDef`s in `src/data/witchEnemies.ts` (kept separate from `pveEnemies` for clarity):

| Id | Name | Base HP | Base damage | Voice (LORE §8) | Visual notes (LORE §4) |
|---|---|---:|---:|---|---|
| `e_witch_cori` | Witch of the Eastern Coven | 60 | 8 | en_GB-cori-medium | hooded, moss-green robe, green witch-fire wand |
| `e_witch_jenny` | Iron-Box Witch | 90 | 11 | en_GB-jenny_dioco-medium | bone-white robe, silver thread runes |
| `e_witch_kristin` | The Mocking Witch | 130 | 14 | en_US-kristin-medium | mixed palette, cackle posture |

These scale with `pveWave` exactly like other PvE enemies (so a player who hits 15 wins early gets an easier cori; a player who grinds gets a tougher one).

**LPCA:** `src/visual/witchEnemyLPCA.ts` (parallel to `pveEnemyLPCA.ts`) — single shared body proportions with three palette variants. Hooded silhouette + wand reads as the same archetype trio from `intro_the_shattering`.

---

## 7. Free-roam controls (Phase C)

`src/world/freeRoamControls.ts` exposes:

```ts
attachFreeRoamControls(opts: {
  canvas: HTMLCanvasElement;
  avatar: THREE.Group;
  camera: THREE.PerspectiveCamera;
  getTerrainHeight: (x: number, z: number) => number;
  mapRadius: number;
  isAwakened: () => boolean;
  onInteract: () => void;  // E-key handler (Phase D wires up harvest)
}): { detach: () => void };
```

Behavior:
- WASD = forward/strafe relative to camera yaw. ~3.5 units/sec base walk.
- Mouse moves yaw the avatar; pitch limited so we never look straight up/down (third-person preserved).
- Avatar `y` snapped via `getTerrainHeight()` per frame (existing `relevelAvatarFeet` pattern).
- Position clamped inside `mapRadius` (no falling off the dock).
- `E` press fires `onInteract()` callback.
- `Tab` press is intercepted (`preventDefault()`) when no input field is focused → opens menu overlay.
- Detaches cleanly on dispose / mode-back-to-deck.

Camera: extend the existing `refreshSoloDockFramingFromAvatar()` so it runs **every frame** in awakened mode (instead of snapping once at spawn). Same offset/lookAt math; the dock's third-person framing carries straight over.

---

## 8. Map harvest (Phase D)

**Scatter approach:** new `src/world/freeRoamHarvestNodes.ts` reads from a static config (mirrors gather actions in `gameStore.ts`), scatters merged-by-material instances on the heightfield, exposes:

```ts
type HarvestNodeKind = 'wood' | 'fiber' | 'stone' | 'mine_iron_ore' | 'mine_coal' |
  'mine_copper_ore' | 'mine_tin_ore' | 'mine_zinc_ore' | 'mine_silver_ore' |
  'mine_gold_ore' | 'mine_platinum_ore' | 'magic_crystal';

attachFreeRoamHarvestNodes(scene, project, graphicsBudget, store): {
  getNodeNearAvatar(avatarPos: THREE.Vector3): { kind: HarvestNodeKind; index: number; node: THREE.Object3D } | null;
  consumeNode(kind: HarvestNodeKind, index: number): boolean;  // hides / regrows
  setVisibility(visibilityRules: { [K in HarvestNodeKind]?: boolean }): void;
  dispose: () => void;
};
```

Per kind: 5-15 cluster nodes scattered with `mulberry32`-seeded XZ inside `mapRadius`, away from the central camp clearing. Each cluster groups N geometry instances that share materials so `mergeByMaterial` produces 1-2 draw calls per kind.

**Visibility rule:** in deck mode, hide nodes whose unlock isn't satisfied (e.g. iron ore nodes hidden until `c_card_alloy_crucible` or its precursor is unlocked). In awakened mode, show all (you've recovered your full powers — the world's secrets are visible). Dev flag `idleCraft.devUnlockAllNodes` overrides to always-show.

**Proximity check:** every frame in awakened mode, find nearest node within 1.5 units of avatar. Show floating "Press E" hint via a CSS overlay positioned by projecting the node's world position into screen space (same technique as the existing `presenceHud`).

**Harvest action — multi-hit (supersedes original "single-press" design, 2026-04-18).**
`E` press → `harvestHandle.applyHit(node, mult)` where `mult = store.getHarvestHitsMultiplier(node.kind)` (1.0 bare-hand → 5.0 platinum pickaxe). Each hit:
- decrements the node's in-memory `hp` by `mult`,
- deposits a small chip yield via `store.freeRoamHarvestChip()` (no mastery / wear),
- fires `playHarvestProgressSound()` (cheap procedural per-material SFX).

On the FINAL hit (`hp <= 0`):
- the node enters its visual break animation (tree-fall pivot for `apple_tree`, scale-collapse with wobble for `stone`/`ore`/`bush`/`fiber`, no visual for `magic_crystal`),
- `playHarvestBreakSound()` fires the climactic SFX (tree-fall crash, boulder crumble, bell sweep, etc.),
- `store.freeRoamHarvest()` runs the full `performGather` pipeline for the bulk yield + currency + tool wear + mastery (with `skipSfx: true` so the legacy single-shot doesn't step on the climax),
- `availableAtMs` is set to `now + 420 s` (long real-time respawn — map stays populated across a session but the area visibly empties).

Per-kind base hit counts (bare hand): `wood 8, fiber 5, stone 8, berries 5, base ores 10, precious ores 12, crystal 7`. Tool-tier table in `gameStore.getHarvestHitsMultiplier()` reduces this (e.g. iron axe = 2.22× → ~4 hits on a tree; steel = 4× → ~2 hits).

**Per-instance visibility (replaces the old `mergeByMaterialTiled` decision).**
The original implementation merged every instance of a kind into one static merged mesh per material — great for draw calls but it made it impossible to hide a single broken node. The new module uses **`THREE.InstancedMesh` per material**: build the LPCA template once, run `mergeByMaterial` on the template (yielding ~1-3 sub-meshes per kind), and create one `InstancedMesh(geom, mat, cfg.count)` per sub-mesh. Per-instance visibility is then a single `setMatrixAt(i, zeroOrFallMatrix)` call. Trade-off: every node of a kind is a clone of one template (no per-tree LPCA variation); variation comes from per-instance Y rotation + scale (±15%). Total draw calls for the whole scatter: ~26 — well under the locked ≤5-per-kind budget.

Scatter density bumped (~150 → ~210 nodes total) to compensate for the slower harvest pace; counts in `KIND_CFG` of [src/world/freeRoamHarvestNodes.ts](src/world/freeRoamHarvestNodes.ts).

---

## 9. Crystal staff/wand crafting (Phase D)

**New crafting tree:** add to `src/data/content.ts`:

| Recipe id | Inputs | Outputs | Station | Requires |
|---|---|---|---|---|
| `r_crystal_focus` | 1 magic_crystal + 2 silver_ingot | 1 crystal_focus | forge | — |
| `r_apprentice_wand` | 1 wood + 1 crystal_focus | 1 apprentice_wand | workbench | — |
| `r_journeyman_staff` | 3 wood + 2 crystal_focus + 1 silver_ingot | 1 journeyman_staff | workbench | `apprentice_wand` ever-crafted |
| `r_archmage_staff` | 5 wood + 5 crystal_focus + 3 gold_ingot + 1 platinum_ingot | 1 archmage_staff | forge | `journeyman_staff` ever-crafted |

The new weapons enter the `EQUIPPABLE_WEAPON_IDS` allowlist, slot into the existing `equipment.weapon` field, and grant escalating `getArcaneSpellDamageBonus` so spells (which are gated behind `MAGIC_ENTRY_CARD_ID`) become the dominant attack style post-awakening.

**Mana growth:** `magicCrystalsHarvested` adds **+0.5 max mana per crystal** to `getEffectiveMaxMana()` so each crystal harvested visibly grows the player's spell pool.

---

## 10. Reset, persistence, and the round-trip toggle

- `GameStore.reset()` clears `realmMode → 'deck'`, all shards, witch counter, crystal counter. Standard wipe.
- `setRealmMode('awakened')` is the canonical entry; called by `breakTheSpell()` (which checks gates) and by the system-menu debug toggle (which doesn't).
- Mode flip emits + saves immediately. Reload preserves whichever mode you were in.
- `setRealmMode('deck')` is the round-trip back; nav reappears, free-roam controls detach, scattered nodes' deck-mode visibility rules re-apply.

---

## 11. Files (modified vs new)

```
NEW:
src/data/witchEnemies.ts                    # 3 EnemyDefs + voice metadata
src/visual/witchEnemyLPCA.ts                # 3 procedural witch builds (shared body)
src/ui/awakeningPage.ts                     # renderAwakening() — shard slots + Break button
src/world/freeRoamControls.ts               # WASD + mouse-yaw + E + Tab capture
src/world/freeRoamHarvestNodes.ts           # scattered metals + crystals + proximity check
docs/AWAKENING_AND_FREE_ROAM_PLAN.md        # this file

MODIFIED:
src/core/types.ts                           # RealmMode, WitchShardId, GameState additions
src/core/gameStore.ts                       # state defaults, methods, migration, scheduling
src/data/content.ts                         # talisman_shard_*, magic_crystal items, 4 staff/wand recipes
src/ui/mountApp.ts                          # 'awakening' tab, mode-aware nav, Tab key, free-roam wiring
src/visual/characterScenePreview.ts         # 'awakening' AppPageContext + awakened follow camera
src/visual/pveEnemyLPCA.ts                  # dispatch witch ids to new module
LEARNINGS.md                                # new entry per phase
```

---

## 12. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Free-roam camera collides with trees | Medium | Raycast avatar→camera; pull camera in if blocked. Phase C polish. |
| Scattered ore meshes blow draw-call budget | High → Low | `mergeByMaterial` per kind cluster. If still high, instance via `InstancedMesh` (vegetation wind precedent in `LEARNINGS.md` says skip InstancedMesh for vegetation; ores are simpler — instancing safe). |
| Tab key conflicts with browser focus | Medium | `e.preventDefault()` only when `realmMode === 'awakened'` AND no input is focused. |
| Save migration breaks existing players | Low | Default-safe new fields in `migrateLoaded`; `STATE_VERSION` bump. |
| Witch shader compile freezes first encounter | Low | Matches existing PvE enemy material flag set so program cache reuses (see `LEARNINGS.md` first-sunset / campfire freeze entries — same pattern). |
| Awakened-mode UI overlay (Tab menu) blocks E-harvest | Low | Disable proximity check when overlay is open. |
| Going `awakened → deck` mid-fight leaves orphan battle state | Medium | Block mode toggle when `state.battle != null`. Show "Finish your fight first" toast. |

---

## 13. Verification checklist (per phase)

**Phase A (state + tab placeholder):**
- [ ] Awakening tab appears in nav between Hire and Portal.
- [ ] Page renders three empty shard slots + locked Break button.
- [ ] `idleCraft.devUnlockAwakening = '1'` (default) makes Break button enabled.
- [ ] Clicking Break flips `realmMode` in state and shows debug "AWAKENED" banner.
- [ ] Page-reload preserves realmMode.

**Phase B (witches):**
- [ ] After 15 PvE wins, next "Start battle" spawns Witch of the Eastern Coven.
- [ ] Defeating cori grants `talisman_shard_cori`, sets `shards.cori = true`, refills counter.
- [ ] Same for jenny (after another 15) and kristin (after another 15).
- [ ] All 3 shards collected → Break button works without dev flag.

**Phase C (free-roam):**
- [ ] Click Break → fade-to-white → realm flips → nav hides → WASD moves avatar.
- [ ] Camera follows avatar in third-person, mouse moves yaw.
- [ ] Tab key opens overlay menu re-exposing inventory/decks/craft/idle/hire.
- [ ] ESC opens system menu (unchanged).
- [ ] System menu has "Return to dream-prison" toggle.

**Phase D (harvest + staff crafting):**
- [ ] Scattered ore + crystal nodes visible on map.
- [ ] In deck mode, only unlocked-tier nodes show (iron hidden until pickaxe known).
- [ ] In awakened mode, all nodes show.
- [ ] Walking near a node shows "Press E" hint.
- [ ] E harvests → inventory updates → node hides for 30-60s then regrows.
- [ ] Crystal harvest also bumps `magicCrystalsHarvested` and increases max mana.
- [ ] New 4 staff/wand recipes appear in craft page; produce equippable weapons.

---

## 14. Out of scope for this work

- `awakening_break_the_spell` cinematic cutscene (stubbed as fade-to-white — real production deferred).
- Multiplayer / co-op interaction with awakened mode (probably solo-only for first ship).
- Mira rescue arc (Act 4 — see `LORE.md` §10).
- World expansion beyond current dock `mapRadius` (could revisit per `docs/WORLD_TERRAIN_WATER_DAYNIGHT_PLAN.md`).
- Witch dialog / VO baking — voice metadata is in `EnemyDef` for later wiring.

---

## 15. Base building, crystal wraps, survival, PvP destruction

Awakened mode opens a piece-based log-cabin building system, a crystal-wrap magical defense layer, a 7 Days to Die-style mob/raid survival loop, a chest/crate storage system, and PvP-aware destruction rules (co-op friendly, 1v1 hostile). All of this is specified end-to-end in [`BASE_BUILDING_AND_SURVIVAL_PLAN.md`](BASE_BUILDING_AND_SURVIVAL_PLAN.md). That doc owns the piece catalog, material tier table, crystal wrap categories, mob roster, raid cadence, damage / repair UX, storage mechanics, and the 7-phase implementation roadmap (Phase 1 = log cabin pieces + tiers in flight at the time of writing).

Phase 2 of that plan (placeable crafting stations: workbench / forge / kitchen / well / garden / cooler / repair_bench) **supersedes** the prior `station_placement_system` plan — when stations land, they live inside the same placement controller as cabin pieces, separately tracked (no architectural fold; player can put a forge inside a cabin OR out in the open).

The same engineering invariants from this doc carry over (phantom-light pattern, `mergeByMaterial` / `InstancedMesh` per-kind render strategy, awakened-mode-only gating, save schema forward-compatibility).

---

*Last updated: 2026-04-18 — Phase A–D in flight; §15 base-building added (single session).*
