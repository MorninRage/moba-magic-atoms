# IDLE-CRAFT — Master reference (game systems & tooling)

Single document for **what is implemented**, **how the app is wired**, and **how Cursor + EmpireEditor + localhost** fit together.  
**New agents:** still read `.agent/00_READ_FIRST.md` and `AGENT_CONTEXT.md` first for mandatory workflow; use **this file** for a consolidated system map.  
**Narrative bible:** **`LORE.md`** (game root) — canonical names, characters, palette, and story arc. Read before writing any in-game text, card flavor, or new cutscene.
**Shipped roadmap / phases:** **`PLAN.md`** (game root) — checklist of delivered features, battle-dock notes, and file map. **Worker path vs legacy default, URL flags, gaps:** **`docs/WORKER_VS_LEGACY_PATH.md`**. **Uncommitted working tree vs `HEAD` (full multi-track review):** **`docs/WORKING_TREE_REVIEW_2026_04_UNCOMMITTED.md`**. **Worker path vs player expectations (preload, sky, camera):** **`docs/GAME_VISION_VS_IMPLEMENTATION_2026_04.md`**.
**Jam vs repo:** **`vibejam_portal_solo_battle.md`** — Vibe Jam 2026 widget + portal requirements mapped to implementation (done / partial / remaining).
**Full roadmap:** **`IDLE_CRAFT_CONTEST_AND_FEATURE_PLAN.md`** — contest compliance, solo vertical slice, multiplayer/Fly/lobbies/menus (Parts A–I, executive checklist).
**Cutscene production (currently unwired from boot):** **`docs/CUTSCENE_PIPELINE.md`** — the end-to-end zero-cost cinematic-cutscene pipeline (Pollinations + ComfyUI/Depthflow + Piper + Remotion). Companion: **`docs/CUTSCENE_BUILD_LOG.md`** — exhaustive runbook with every install command, every iteration, full file trees, and the actual command-by-command production log of every previously-shipped cutscene. Both `.mp4` files + the `src/cutscenes/*.ts` modules remain on disk; they are no longer imported from the boot graph as of 2026-04-22 (see `docs/SESSION_2026_04_22_CUTSCENE_REMOVAL_AND_BOOT_TIGHTENING.md`). Re-enabling the boot integration is a one-commit revert of `src/main.ts` + `index.html` + `vite.config.ts` + `netlify.toml`.

---

## 1. Product identity

| Field | Value |
|--------|--------|
| **Working title** | IDLE-CRAFT |
| **npm package** | `idle-craft` (`package.json`) |
| **Genre** | UI-first idle crafting / deck-unlock survival RPG |
| **Runtime entry** | `index.html` → `src/main.ts` → `GameStore` + title flow → click Begin → `mountApp()`. Intro cutscenes were unwired from the boot graph 2026-04-22 (see session doc); files preserved on disk for clean revert. |
| **Premise (one line)** | You are **the Vanguard Wizard**, sealed in a deep dream-prison by the **Witches Guild** who took your daughter **Mira**. The deck IS the curse — break the deck, break the spell, find Mira. See `LORE.md` for the full bible. |

The **playable loop** lives in **`src/`** (TypeScript): inventory, crafting, deck unlocks, manual gathering with timed preview, idle automation, PvE battle, helpers, equipment, durability.  
**EmpireEngine** is a **dependency** (`file:../EmpireEngine`) for alignment with the editor stack; the **current game entry does not bootstrap a full 3D world scene** from `main.ts`—the 3D you see in the browser is the **character dock** (Three.js) described below.

---

## 2. Tech stack

| Layer | Choice |
|--------|--------|
| Language | TypeScript (~5.7) |
| Bundler / dev server | Vite 5 |
| Dev URL | **http://localhost:3000** (`vite.config.ts` → `server.port: 3000`) |
| 3D (in-app) | **three** ^0.182 — procedural avatar, equipment meshes, gather props |
| State | `GameStore` class, `localStorage` persistence |
| Content | Large registry in `src/data/content.ts` + `src/data/metalConstants.ts` |
| Types | `src/core/types.ts` |

**Scripts:** `npm run dev` (Vite), `npm run build` (`tsc && vite build`), `npm run preview`.

**Build plugin:** `vite.config.ts` copies `project.json`, `scenes/`, `recipes/`, `data/`, `assets/` into `dist/` on bundle close (for deployment / editor-adjacent workflows).

**Contest (VibeJam 2026):** `index.html` loads `https://vibej.am/2026/widget.js` (async) for entrant tracking. Ship the web build on **one stable origin** (Netlify site **idle-crafting** → **https://idle-crafting.netlify.app**, or a custom domain on that site) so popularity tracking stays valid. Players only need the browser link; the hosted build connects to the Fly lobby automatically — no local server or CLI steps for players.

**Portals (optional jam feature):** On the **Portal** tab, the 3D `portal_enter` clip ends with a **full navigation** to `https://vibej.am/portal/2026` with query params (`ref`, `hp`, etc.) — the hub assigns the **next** game. See [jam portals section](https://vibej.am/2026). Incoming `?portal=true` adds a body class for styling.

---

## 3. Cursor + MCP + EmpireEditor + localhost viewport

This project is designed to work with **EmpireEditor** as the shell that **embeds the same Vite app** in a viewport.

### Connection chain

```
Cursor IDE
  └─ MCP (stdio): npx tsx mcp/server.ts  with cwd = EmpireEditor  (see .cursor/mcp.json)
       └─ WebSocket client → ws://localhost:3333  (bridge inside EmpireEditor)
            └─ EmpireEditor UI (Electron) also joins bridge as "editor"
                 └─ Viewport iframe/webview loads http://localhost:3000 (this game, `npm run dev`)
```

- **Port 3000:** Vite serves **this** game.
- **Port 3333:** **EmpireEditor’s bridge** (only one owner; zombie processes break MCP).
- **MCP does not talk to 3000 directly**; it sends commands to the editor over the bridge.

### Project MCP config

File: **`.cursor/mcp.json`**

- Server id: `empire-engine`
- Runs: `npx tsx mcp/server.ts` with **`cwd`: `C:\EmpireEditor`** (adjust if the editor lives elsewhere).

### When MCP tools work

1. **EmpireEditor** running (`npm run dev:electron` from editor repo).
2. Editor UI **connected** to the bridge (modern builds auto-connect; otherwise use Connect in toolbar).
3. **This game** running: `npm run dev` here → **localhost:3000**.
4. Editor **File → Open** this game folder so the viewport targets the right project.

Optional: open the game with **`?editor=1`** so the runtime can register as a **`game`** client on the bridge for live sync (“Game Live” in editor UI)—see `.agent/00_READ_FIRST.md`.

### Typical MCP tools (editor handles them)

| Area | Examples |
|------|-----------|
| Scene / camera | `scene_info`, `scene_camera_to` |
| Entities | `entity_create`, `entity_query` |
| Recipes (LPCA JSON) | `recipe_create` → `recipes/` |
| World config | `config_set`, `time_set`, `weather_set` |
| Learnings | `learning_record` → `LEARNINGS.md` |

Full tool list and troubleshooting (**timeouts, not connected**): **`.agent/00_READ_FIRST.md`**.

### Auto tasks (optional)

`.vscode/tasks.json` may run **Start EmpireEditor** + **Start Game Dev** on folder open. If disabled by shell policy, start both manually.

---

## 4. Repository layout

```
idle deck/                          # game root (folder name may contain space)
├── .agent/00_READ_FIRST.md       # MCP + editor + LPCA onboarding (read first)
├── .cursor/mcp.json              # MCP → EmpireEditor server
├── AGENT_START_HERE.md           # Ordered reading list for agents
├── AGENT_CONTEXT.md              # LPCA + editor context
├── GAME_MASTER.md                # This file — systems map
├── LORE.md                       # Narrative bible — characters, palette, voice, arc
├── PLAN.md                       # Delivered phases, battle dock, death/UI checklist
├── vibejam_portal_solo_battle.md # Vibe Jam widget + portal + solo PvE: spec vs shipped vs gaps
├── IDLE_CRAFT_CONTEST_AND_FEATURE_PLAN.md # Full contest + multiplayer roadmap + status (Parts A–I)
├── LEARNINGS.md                  # Project-specific fixes (append when you solve issues)
├── docs/
│   ├── CUTSCENE_PIPELINE.md      # End-to-end recipe for new cutscenes (Pollinations + ComfyUI + Piper + Remotion)
│   └── DEPLOY*.md                # Existing deploy guides
├── project.json                  # Engine-oriented project metadata (editor / EmpireEngine)
├── scenes/main.json              # Scene entities (editor workflow)
├── recipes/                      # LPCA recipe JSON (editor / MCP)
├── public/
│   ├── cutscenes/intro_the_curse.mp4       # Act 1 cutscene (51s, on disk; UNWIRED FROM BOOT 2026-04-22)
│   ├── cutscenes/intro_the_shattering.mp4  # Act 1b cutscene (76s, on disk; UNWIRED FROM BOOT 2026-04-22)
│   └── audio/music/              # CC0 music library
├── index.html
├── package.json
├── vite.config.ts                # port 3000, @editor alias → ../EmpireEditor/src
└── src/
    ├── main.ts                   # bootIntroExperience (5 lines): scheduleSecondaries → hideInlineBootVeil → schedulePreloadAfterPaint → showStartFlow → dumpRound5Measures
    ├── cutscenes/                # PRESERVED ON DISK BUT NO IMPORTER (unreferenced 2026-04-22)
    │   ├── introSplash.ts/.css   # "press anywhere" gate (was for cutscene autoplay-with-audio gesture)
    │   └── introCutscene.ts/.css # Cutscene overlay player (skip-able)
    ├── core/
    │   ├── gameStore.ts          # All gameplay logic + persistence
    │   └── types.ts              # GameState, cards, recipes, battle, etc.
    ├── data/
    │   ├── content.ts            # Cards, recipes, helpers, PvE, item IDs, merge rules
    │   └── metalConstants.ts     # Pick/axe tier order, yield & wear multipliers
    ├── ui/
    │   ├── mountApp.ts           # Shell, pages, HUD, wires store ↔ preview
    │   └── app.css
    └── visual/
        ├── characterScenePreview.ts  # Three.js dock: avatar, clips, page-based gear visibility
        ├── characterEquipment.ts     # Procedural axe / sword / pick / shield meshes
        └── forestEnvironment.ts      # Backdrop for preview
```

---

## 5. Game state model (`GameState` — see `types.ts`)

High-signal fields:

- **`inventory`:** Resource counts + tool item counts (axes, picks tiered, structures like `campfire`, `workbench`, `forge`, …).
- **`equipment`:** `{ weapon, armor, shield, pick }` — slots reference **item ids**; picks/weapons must exist in inventory to equip.
- **`unlockedCardIds`:** Deck progression; gates recipes and some gather actions.
- **`idleSlots`:** Automation cards (fixed slot count from content).
- **`combatDeck`:** Ordered list of battle card ids.
- **`hiredHelperIds`:** Active helpers (passive gather, idle bonus, battle assist, player feed).
- **`toolDurability`:** Per durable item id (tools break at 0).
- **`stations`:** Unlocked craft stations (`hand`, `campfire`, `workbench`, `forge`, `kitchen`).
- **`battle`:** Nullable PvE encounter state (enemy HP, turn, log).
- **Vitals:** `playerHp`, `hunger`, `thirst`, `mana`, `maxMana`, spoilage accumulator.
- **Death:** `lastDeathHeadline`, `lastDeathBody` → UI modal; reset clears run.

**Persistence:** `localStorage` key **`idle-deck-fusion-v1`**.  
**Migrations:** `migrateLoaded()` in `gameStore.ts`; bump **`STATE_VERSION`** when changing saved shape.

---

## 6. `GameStore` — implemented systems

### 6.1 Time loop — `tick(realDtMs)`

- Applies **idle automation** from slotted cards + **helper passive gather** + **helper idle bonus** (capped).
- **Spoilage** tick for relevant inventory keys.
- **Hunger / thirst** decay; helpers may **feed** the player from inventory rules.
- **Mana regen** (base + magic card bonuses).
- Emits subscribers for UI refresh.

### 6.2 Manual gathering — `listGatherActionGroups()` / `performGather(actionId)`

- **Animation sync:** UI uses `CharacterScenePreview.getGatherClipDurationMs(actionId)` so loot is granted **after** the preview clip (~4–5s typical). Yield uses **`MANUAL_GATHER_YIELD_MULT` (4.25)** so per-minute rates stay sane vs long clips.
- **Stone:** Always available; pick improves yield (`PICK_STONE_YIELD_MULT`); pick wear on use.
- **Iron ore & coal:** **Require owning any pick** in bag or equip (`effectivePickId()`). No bare-hands gather for these actions.
- **Copper / tin / zinc ores:** Require deck **`c_card_alloy_crucible`**. Pick optional: with pick → full tier mult + wear; without → **`ORE_BARE_HANDS_MULT`** fraction.
- **Silver / gold / platinum:** Require **`c_card_precious_arc`**; same pick optional pattern.
- **Wood / fiber / water / berries / hunt / garden / magic** (`ley_residue`): Each has own rules in store + UI groups.
- **Hunt:** Game rules can still scale with axe in bag/equip; **preview** is snare/meat only (no axe mesh in hunt clip).

Helpers: `effectivePickId()` prefers **equipped** pick if present and in inventory, else **best in bag** per `PICK_TIER_ORDER` in `metalConstants.ts`.

### 6.3 Crafting — `availableRecipes`, `canCraft`, `craft`

- Recipes from **`content.ts`** with `station`, `inputs`, `outputs`, `timeSeconds`, optional **`requiresCards`** / **`requiresItems`**.
- Stations merged into state; kitchen etc. unlock via cards.
- Spending inventory on craft; structures may be **preserved** for card unlock costs (see `CARD_UNLOCK_PRESERVE_IDS` in `gameStore.ts`).

### 6.4 Equipment — `equip(slot, itemId)`

- Valid weapons / picks / shields from content allowlists.
- Syncs to character preview via `mountApp` → `scenePreview.syncEquipment`.

### 6.5 Durability — `applyToolWear`, `repairItem`, `getToolDurabilityPercent`

- Wear on gather / battle use; **repair bench** recipe path repairs tools.

### 6.6 Decks — `canUnlockCard`, `unlockCard`, `setIdleSlot`

- Unlock costs: prior cards + item checks; may spend consumables.
- Idle slots: only **unlocked** automation cards eligible.

### 6.7 Battle (PvE) — `startPveBattle`, `battlePlayCard`, `battleEndTurn`, `battleUseBandage`, `battleUseStim`, `battleClose`, `finishBattlePermadeath`

- Turn-based; **energy** for physical cards, **mana** for spells (gated by magic unlock).
- Weapon style checks (`fist` / `weapon` / `spell`).
- Helpers add damage / block bonuses.
- **Player lethal hit:** `battleEndTurn` may set `turn: 'defeat'` and `pendingPermadeath` on `BattleState`; **`dieAndWipe`** runs after the dock **`battle_player_death`** clip (`battle-player-death-done` → `finishBattlePermadeath()`).
- **Manual reset:** `GameStore.reset()` (nav **Reset all progress**, after Hire / before Portal).

### 6.8 Hire — `canHireHelper`, `hireHelper`, `getHireBlockReason`

- Cost currency; requirements on cards/items; upkeep abstracted in helper defs.

### 6.9 Utilities

- `getEffectiveMaxMana`, `getMagicManaRegenBonus`, `getWeaponDamageBonus`, `getArmorMitigation`, `getArcaneSpellDamageBonus`, `getIdleAutomationMult`, `setCombatDeck`, `sortCombatDeckDisplayOrder`, `reset`, `clearDeathMessage`, `consumeFood`, `drinkWater`, etc.

**Exports from `gameStore.ts`:** `GameStore`, `createInitialState`, `allCards`, `allRecipes`, `allHelpers`, `allEnemies` (PvE list).

---

## 7. Data layer

### `src/data/content.ts`

- **Resources & item ids**, recipe list, card list, helper list, PvE enemies.
- **Card trees:** building, survival, combat, magic — unlock chains for forge, alloy, precious metals, magic entry, idle cards, etc.
- **Merge helpers** for station unlock aggregation.

### `src/data/metalConstants.ts`

- **`PICK_TIER_ORDER`**, **`PICK_ORE_YIELD_MULT`**, **`PICK_STONE_YIELD_MULT`**, **`PICK_WEAR_FACTOR`**
- **`AXE_TIER_ORDER`**, **`AXE_WOOD_MULT`**, axe battle wear / wood bonuses
- Sword damage bonuses where applicable

---

## 8. UI shell — `src/ui/mountApp.ts`

- **Layout:** Title, HUD (`#app-hud`), **nav** (pages + **Reset all progress** between Hire and Portal), **`#page-root`**, **character dock** (`#character-preview-root`).
- **Pages:** `gather` | `craft` | `inventory` | `decks` | `idle` | `battle` | `hire` | **`portal`**
- **Portal tab:** Nav label + callout stress **Vibe Jam hub only** (switching games), not normal play.
- On navigation: `scenePreview.syncEquipment(state.equipment)` and **`scenePreview.setPageContext(page)`**.
- **Gather:** grouped buttons from `listGatherActionGroups()`, disabled states, busy state during clip wait, then `performGather`.
- **Craft:** stations in `STATION_ORDER`, recipe rows, craft button.
- **Inventory:** equips, durability display, consumables, repair, hover → `setResourceHover` for preview rim light.
- **Decks / idle / battle / hire:** respective panels wired to store APIs.
- **Death modal** bound to `lastDeathHeadline` / `lastDeathBody`.

Styling: **`src/ui/app.css`**.

---

## 9. Character preview — `src/visual/characterScenePreview.ts`

**Purpose:** Persistent **Three.js** view in the dock: procedural **LPCA-style** avatar (no glTF), PBR materials, **action clips** aligned with gather timing.

**`AppPageContext`:** matches nav pages.

**Page poses:** Distinct stable poses for **decks / craft / battle** (and other contexts) with short blends when **`setPageContext`** runs — avoids awkward arms on tab changes.

**Idle equipment visibility (`showIdleGear` / gather vs combat)**

- **`battle`:** Weapon + shield only for combat idle; picks / belt / gather tools hidden.
- **`inventory`:** Show shield, belt pick, dual-wield layout (weapon right, pick left when no shield), etc.
- **`gather` (and other non-inventory pages at idle):** **Hide** idle carry (empty hands); tools appear **only inside relevant clips** (wood axe in `propAxeGroup`, mine pick in `minePickRight`, …).

**Dock props:** Campfire / workbench (and related) use hero-style decor with first-use moments where implemented — see craft tab integration in preview.

**Notable clips**

- **Travel-gather** pattern: approach prop, work phase, return (stone, wood, mine, fiber, berries, water, garden).
- **Mine:** dedicated pick mesh on right hand; per-ore **`MeshPhysicalMaterial`** presets on rock; iron/coal gated in **game** logic, not here.
- **Wood:** equipped axe uses `propAxeGroup`; else log mesh.
- **Hunt:** phased clip (trap → cut → pickup); meat prop (no axe on idle hunt).
- **Battle:** `battle_strike`, `battle_cast`, `battle_enemy_strike`; **damage floaters**, sparks, **combat blood** (pools, face/shirt/pants cascade, rat vs human presets); enemy/player hit and death reactions. **Lethal kill:** chain **`battle_enemy_death`** after strike/cast; **corpse** pose until next encounter; **`enemyRoot`** transform reset on rebuild so new fights start upright. Presentation is structured so **future server-driven** battle events can reuse the same hooks.
- **Permadeath:** **`battle_player_death`**; dock reset via **`resetDockAfterPermadeath`** + **`relevelAvatarFeetAfterEquipmentSync`** after `renderPage` (equipment meshes).
- **Hire / consume / craft hammer / equip adjust / portal_enter:** separate pose branches.

**Battle dock spacing:** `BATTLE_ENEMY_REST_*`, lunge constants, and strike anchors at top of `characterScenePreview.ts` (tune there; see **`PLAN.md`** §3).

**Equipment meshes:** `characterEquipment.ts` — `buildAxeMesh`, `buildSwordMesh`, `buildPickMesh` (grip at **haft bottom**), `buildShieldMesh`, `disposeGroupContents`.

**Environment:** `forestEnvironment.ts` — backdrop lighting/fill for the dock.

---

## 10. Design constants (quick reference)

| Constant | Role |
|----------|------|
| `MANUAL_GATHER_YIELD_MULT` | ~4.25 — scales manual yields to match long gather clips |
| `ORE_BARE_HANDS_MULT` | ~0.24 — alloy/precious ores without a pick |
| `SAVE_KEY` | `idle-deck-fusion-v1` |
| `STATE_VERSION` | Schema version for `migrateLoaded` |
| `IDLE_SLOT_COUNT` | From content |
| `MAGIC_ENTRY_CARD_ID` | `c_magic_awakening` |
| `IDLE_HELPER_BONUS_CAP` | Caps summed helper idle bonus |

---

## 11. Awakened-mode base building, crystal wraps, survival, PvP destruction

Awakened mode opens a piece-based log-cabin building system, multi-instance craft-station placement, a crystal-wrap magical defense layer, a 7 Days to Die-style mob/raid survival loop, a chest/crate storage system, and PvP-aware destruction (co-op friendly, 1v1 hostile). This is a multi-phase track:

- **Phase 1 + 1.5 (shipped):** core piece-based builder + material tier reskins (rough log → oak → copper → bronze → silver → gold → platinum); GoE-style snap pipeline; world-wide 2D collision; real-time combat with mob waves.
- **Phase 2 MVP (shipped 2026-04-19):** multi-instance craft-station placement. Player crafts the materials in dream mode → opens Build mode in awakened realm → grid-snapped placement of campfire / workbench / forge / kitchen anywhere on the map. Direct material spend (no inventory token round-trip — mirrors cabin pieces). Phantom-light pool gives placed campfires real surface glow matching the dream-mode dock-yard original. Dock-yard slots hidden in awakened mode (only player-placed stations show). See [`docs/SESSION_2026_04_19_STATIONS_AND_MAGIC.md`](docs/SESSION_2026_04_19_STATIONS_AND_MAGIC.md).
- **Phase 2 follow-ups:** forge / kitchen LPCAs (currently placeholder boxes); stations placeable on cabin floor / foundation tops via `findStationSnapY`; well / garden / cooler / repair_bench placement.
- **Phases 3-7 (future):** crystal wraps, raid cadence + damage / repair, storage, 1v1 PvP destruction, polish + tutorial.

Full specification (piece catalog, tier table, crystal wrap categories, mob roster, raid cadence, damage / repair UX, storage mechanics, network rules, 7-phase roadmap): **[`docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md`](docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md)**.

Engineering invariants that hold across all phases (do not violate):

- **Phantom-light pattern** (no fresh `THREE.PointLight` at runtime — same rule as the campfire / torch / sunset freezes in `LEARNINGS.md`).
- **Phantom-light pool** (Phase 2+) — for systems that need N lit instances at runtime (placed campfires, future placed forges), pre-allocate a small pool of phantom `PointLight`s at attach time. Pool exhaustion gracefully degrades to emissive-only. See `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` §10.
- **Awakened-mode gate** — building, crystal wraps, raids, PvP destruction, storage looting only run when `realmMode === 'awakened'`. Deck mode is unchanged.
- **InstancedMesh per (kind, tier)** for cabin pieces; **Group per instance** for craft stations (campfires need per-instance flame `tick()`).
- **Save schema forward compatibility** — Phase 1 already includes `crystalWrap: null` and `hp / maxHp` on placed pieces so Phases 3–4 don't trigger another `STATE_VERSION` bump. Phase 2 added `placedCraftStations` + `placedCraftStationCounter` at v24 (2026-04-19); the `awakenedStationPositions` field from the dead-on-arrival v23 single-position model is dropped by the v24 migration.
- **Co-op friendly-fire-OFF / 1v1 friendly-fire-ON** — single rule applied to player damage and structure damage. See [`docs/MULTIPLAYER_ROADMAP.md`](docs/MULTIPLAYER_ROADMAP.md) §3.

---

## 12. Related documentation (read order for agents)

1. **`.agent/00_READ_FIRST.md`** — MCP, bridge, viewport, LPCA primer, setup.
2. **`AGENT_CONTEXT.md`** — LPCA pipeline detail, editor doc paths under `C:/EmpireEditor/docs`.
3. **`LORE.md`** — Narrative bible (characters, palette, voice, arc). Read before writing any in-game text or new cutscene.
4. **`PLAN.md`** — Delivered phases, battle/death/UI checklist, key file map.
5. **`vibejam_portal_solo_battle.md`** — Jam widget/portals vs codebase; solo battle status.
6. **`IDLE_CRAFT_CONTEST_AND_FEATURE_PLAN.md`** — Contest + Fly/lobbies + menus/characters + solo scope (merged plan).
7. **`LEARNINGS.md`** — Append when fixing non-trivial bugs.
8. **`GAME_MASTER.md`** (this file) — **implementation map** for the idle game + tooling glue.
9. **`docs/CUTSCENE_PIPELINE.md`** — End-to-end zero-cost cutscene production recipe (Pollinations + ComfyUI/Depthflow + Piper + Remotion).
9b. **`docs/CUTSCENE_BUILD_LOG.md`** — Exhaustive runbook + complete production log of every shipped cutscene (every command, every iteration, full file trees).
10. **`docs/DEPLOY.md`** — Fly.io room server + Netlify static game; commands, URLs, checklist.
11. **`docs/DEPLOY_WITH_CURSOR.md`** — Same deploys from the **Cursor/agent** perspective (what to ask, script names, login limits).
12. **`docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md`** — master spec for awakened-mode building, stations, survival, PvP destruction. Phase 2 MVP shipped 2026-04-19.
13. **`docs/AWAKENING_AND_FREE_ROAM_PLAN.md`** — Acts 2/3 narrative bridge + free-roam controls + harvest/staff systems.
14. **Most recent session changelogs (read top-to-bottom for context):**
    - `docs/SESSION_2026_04_22_CUTSCENE_REMOVAL_AND_BOOT_TIGHTENING.md` — **most recent.** Intro cutscenes (splash + curse + shattering) unwired from the boot graph (files left on disk for one-commit revert). `bootIntroExperience` collapsed from ~150 lines to a 5-line synchronous function. Round 5 cutscene-tuned tradeoffs walked back: lifted `withConcurrencyLimit(2)` cap on the 7-way extended-preload `Promise.all` (~50–150 ms saved on warm cache), single continuous veil in `enterGame` instead of mount/unmount/remount, trimmed 5+1 inter-phase yields in `CharacterScenePreview.create` to 2, bumped chunkedYielding budget 8 → 16 ms, dropped two `yieldAnimationFrame` waits in `mountApp`, consolidated 4 micro-phase yields → 1. New `bindGameStoreToDockPreview(store)` in `dockPreload.ts` pre-applies equipment + character preset to the offscreen preview during the title flow — by click time `applyCharacterPreset` + `syncEquipment` early-return as no-ops (single biggest item moved off click → game critical path: `syncEquipment`'s ~10–100 ms LPCA mesh build). New `presetApplied` / `equipmentApplied` boolean sentinels guard the early-returns to prevent the constructor's placeholder field defaults from short-circuiting the first real apply (the Vanguard Wizard regression, fixed in-session). Net ~150–400 ms shaved off click → game window + ~30 MB of forced video download eliminated per page load.
    - `docs/SESSION_2026_04_21_PRELOAD_ROUND_5_IMPLEMENTATION.md` — round 5 (frame-spread sync blocks via `chunkedYieldingLoop` / `chunkedYieldingRange` at 8 ms budget, `scheduler.postTask` priority tags via new `schedulePostTask` / `schedulePostTaskCancellable`, concurrency-limited preload imports via `withConcurrencyLimit(2)`, View Transitions extended to 4 hard-cut scene swaps, `measureBlock` / `measureBlockAsync` audit scaffold). NOTE: several round-5 tradeoffs were specifically tuned for cutscene-decode protection and have been walked back in 2026-04-22 — see that session's doc for the diff.
    - `docs/SESSION_2026_04_21_PRELOAD_ROUND_4.md` — round 4 (Workbox SW + storage.persist + adaptive device profile + immutable headers + cutscene skip flag). Cutscene skip flag (`idle-craft-intro-cutscene-seen-v1`) is no longer consulted by the boot path as of 2026-04-22.
    - `docs/SESSION_2026_04_20_PRELOAD_ROUND_3.md` — round 3 (cutscene re-encode + staged forest backdrop + zero-alloc tick + awakened-only deferral). Re-encode + preload hints in `index.html` no longer apply (cutscenes unwired 2026-04-22) but the staged forest backdrop, zero-alloc `tick()`, and awakened-only deferral are all still in place and load-bearing.
    - `docs/SESSION_2026_04_20_PRELOAD_ROUND_2.md` — sub-ms inter-phase yields (`yieldToEventLoop` swapped in for `yieldAnimationFrame` at slots that don't produce a visual change), deferred `renderPage()` via `requestIdleCallback` (heavy gather-page DOM moved off post-cutscene critical path — invisible behind tutorial dialog), veil mounts via shattering cutscene's `onCleanupStart` (parallel to fade-out), 120 ms post-veil `setTimeout` dropped, pre-shattering `Promise.race` cap lowered 4500 → 2000 ms now that warm passes are `compileAsync`. NOTE: shattering-cutscene-specific timing (`onCleanupStart` veil mount + pre-shattering Promise.race) no longer applies (cutscenes unwired 2026-04-22). ~250–500 ms cut from happy-path post-cutscene-2 latency, +500–2500 ms cut from slow-device boots.
    - `docs/SESSION_2026_04_20_ANIMATION_AND_UX_POLISH.md` — walk-pose smooth fade, post-clip pose blend (no harvest→idle leap), fixed wall-clock harvest swing target (~0.55s), height-aware harvest picker, Controls reference moved from inline Esc panel to standalone popup.
    - `docs/SESSION_2026_04_20_PRELOAD_OPTIMIZATION.md` — unified preload pipeline (collapsed two-stage base+extended into one), scene-singleton handles for dock-forest + harvest + collisionWorld, ghost-mesh + walk-through-tree fix, harvest broken-node Set tracking, AbortError + pointer-capture defensive catches.
    - `docs/SESSION_2026_04_19_STATIONS_AND_MAGIC.md` — multi-instance stations, magic projectile overhaul, 3D aim, three.js dedupe.
    - `docs/SESSION_2026_04_19_LIGHTING_OVERHAUL.md` — half-Lambert lighting model patches.
    - `docs/SESSION_2026_04_19_COMBAT_HARVEST_POLISH.md` / `_R2.md` — combat reach, harvest mechanics, aim-assist polish.
    - `docs/SESSION_2026_04_19_CUTSCENE_AND_BLOOD.md` — cutscene timing, battle blood VFX.
    - `docs/SESSION_2026_04_18_BUILDING_AND_PENDING.md` — flush-snap fix, half-built scaffolding (now reverted in 2026-04-19).
    - `docs/SESSION_2026_04_18_HARVEST_AND_PHYSICS.md` — sapling-grow, step-up, predicted-XZ landing, mesh-measured tree tops.
    - `docs/TRIPPY_TERRAIN_AND_BOUNCE_MUSHROOMS_PLAN.md` — port plan + retrospective for the trippy palette + bouncy mushroom build.
    - `docs/GROUND_LEVEL_LIGHTING_OVERHAUL_PLAN.md` — Zelda-Echoes-of-Wisdom-inspired lighting plan.

EmpireEditor deep docs: **`C:/EmpireEditor/docs/DOCS_INDEX.md`** (or your install path).

**Game of Empires — doc corpus:** **`C:\gameofempiresDocs`** (not under `Users\…`). Main markdown lives in **`C:\gameofempiresDocs\docs`** — start from `README.md`, `AGENT_ONBOARDING.md`, or `LPCA_UNIFIED_PIPELINE.md` when researching LPCA / PBR / toolkit patterns.

---

## 13. Changelog discipline

When adding systems:

- Extend **`types.ts`** + **`STATE_VERSION`** + **`migrateLoaded`** if save shape changes.
- Register content in **`content.ts`**; tune combat/gather in **`metalConstants.ts`** / **`gameStore.ts`** as needed.
- Wire UI in **`mountApp.ts`**; new gather actions need **`actionIdToClip`** + clip duration + preview behavior in **`characterScenePreview.ts`** if user-visible.

---

*Last updated 2026-04-22: cutscene boot integration removed (splash + curse + shattering unwired; files preserved on disk); `bootIntroExperience` collapsed; round-5 cutscene-tuned tradeoffs walked back; new `bindGameStoreToDockPreview` pre-applies equipment + preset to the offscreen preview during the title flow so `syncEquipment` no longer lands on the click → game critical path. Vanguard wizard regression from a naive idempotency early-return identified and fixed in-session via `presetApplied` / `equipmentApplied` boolean sentinels. See `docs/SESSION_2026_04_22_CUTSCENE_REMOVAL_AND_BOOT_TIGHTENING.md` and the matching LEARNINGS.md entry. Earlier 2026-04-21: round 5 (frame-spread sync blocks + `scheduler.postTask` priorities + concurrency-limited preload imports + View Transitions; some tradeoffs walked back 2026-04-22) and round 4 (Workbox SW + storage.persist + adaptive device profile). Vite on port 3000; MCP via EmpireEngine on 3333; character-dock Three.js preview. `project.json` / `scenes/` remain for editor/MCP workflows.*
