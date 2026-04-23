# MOBA V1 — game plan (Magic Orbiting Brandished Atoms)

**Scope:** Pure-magic hero brawler / classic MOBA slice on the existing forest tech. This doc is the source of truth for what **ships in MOBA** vs what stays in the parent IDLE-CRAFT repo.

**Related:** [Deploy, new repo, Netlify, post-match flow](./MOBA_DEPLOY_REPO_AND_POST_MATCH_FLOW.md) · [EmpireEngine + CI/Netlify](./MOBA_EMPIRE_ENGINE_CI.md) · [Implementation tracker](./MOBA_IMPLEMENTATION_TRACKER.md) · [Forge/workbench brainstorm](./MOBA_FORGE_WORKBENCH_BRAINSTORM.md) · [Deferred tuning](./MOBA_DEFERRED_TUNING.md) · [Matchmaking](./MOBA_MATCHMAKING.md)

---

## 1. Product pillars

| Keep | Remove (from MOBA codebase path) |
|------|-----------------------------------|
| Vanguard wizard + staff magic, projectile + ward systems from awakened combat | Dream / **deck** realm, tabbed idle shell, **idle automation** tick |
| Forest map, bioluminescence, elongated MOBA layout (later), tree + mushroom objectives | **Idle** crafting / deck-gated recipes, **ores**, gather nodes, dream **cabin** builder (MOBA uses **team forge + workbench** instead — see [`MOBA_FORGE_WORKBENCH_BRAINSTORM.md`](./MOBA_FORGE_WORKBENCH_BRAINSTORM.md)) |
| LPCA heroes, `CharacterScenePreview` / worker optional | **Non-magic gear** (sword / axe / pick / generic melee), battle **deck** card UI |
| Rats, wolves, wanderer-style mobs as **lane/ jungle NPCs** with team faction | PvE **turn-based battle** page, permadeath idle narrative |

**Magic-first combat:** Spells (projectiles, wards, buffs) are the main ranged and tactical layer — MOBA-style cooldowns / mana, not a card deck. **Staff (and future magic weapons)** stay as **close-range magical strikes** — part of the hero kit, not separate “sword/axe” survival gear.

**Early match feel:** **Spells start weak against enemy heroes** (high mitigation or low base numbers on `Player` targets) so fights are not instantly decided at range. Players still threaten each other **up close** via **magic-weapon melee** (staff thwack / imbued strike) until progression and unlocks make nukes and spell pressure real. Tune explicitly: `heroSpellEfficiency` curve over match time or essence spent.

---

## 2. New RPG / progression system (replaces deck + crafting)

**Essence sources (all feed the same progression track unless you split currencies later):**

- Damaging **objectives** (trees, mushroom cores).
- Killing **enemy-aligned wave NPCs** (rats, wolves, wanderers).
- Killing **enemy players** (typically the **largest** burst reward — exact numbers TBD vs snowball risk).

**Spend / unlock:**

- **Spell power** — scalar or per-school boosts (e.g. water bolt damage vs heroes, ward strength).
- **New spells** — gated tiers: offensive (bolts, AoE) vs defensive (wards, shields, cleanses).
- **Optional:** short passive nodes (max mana, regen, cooldown) — keep minimal for jam.

**Implementation sketch:**

- New module e.g. `src/moba/mobaProgression.ts` + small state slice (could start as a refactored subset of `GameStore` or a parallel `MobaMatchState`).
- **No** `content.ts` recipe graph for gear; **yes** reusing **spell IDs / effect definitions** extracted from current magic cards (numbers only, not “cards” in UI).

**UI:** One **progress / loadout** panel in match or between deaths/respawn: current spells, next unlock preview, essence bar.

---

## 2b. Economy design — one currency vs two; last-hit vs shared

**Option A — Single currency (essence)**  
Everything you do feeds one visible number. Unlocks and power purchases spend essence. **Pros:** one HUD row, trivial to explain (“get strong by playing”), no shop confusion. **Cons:** you can’t separate “permanent feeling growth” (XP) from “spendable this match” (gold) unless you add spend sinks; snowballing can feel harsh if kills pay too much essence.

**Option B — Split XP + gold**  
**XP** levels the hero within the match (or account, if you add persistence) and gates spell unlock tiers. **Gold** buys immediate power (damage, regen, consumables). **Pros:** classic MOBA clarity — level = kit breadth, gold = item power — easier to tune comebacks (gold on death, cheaper wards). **Cons:** two meters + possible shop UI; more work for a jam slice.

**Recommendation for v1:** Start with **single essence** if you have **no item shop**; introduce **gold** only when you add buyable consumables or a fountain shop.

---

**Option L — Last-hit credit (MOBA lane standard)**  
Only the player who **deals the killing blow** on a minion gets the full essence reward (assist rules optional: small share). **Pros:** rewards lane skill and last-hitting; familiar to MOBA players. **Cons:** frustrating for new players and for mages with slower projectiles; encourages “stealing” wave farm from teammates.

**Option S — Shared / team credit**  
When a friendly minion dies to **any** enemy source, **nearby teammates** (or the whole team) split a fixed payout, or everyone in range gets **full** smaller amount. **Pros:** cooperative, less CS toxicity; better for casual jam audience. **Cons:** harder to reward individual lane dominance; can hide feeding if payouts are too global.

**Hybrid:** Last-hit for **most** of the reward + **small team aura** so supports don’t starve — common in modern titles.

**Recommendation for v1 jam:** **Shared or generous assist split** if your audience is broad; **last-hit** if you want hardcore lane identity early.

---

## 3. Heroes (V1 roster)

| Role | Preset / build | Notes |
|------|----------------|--------|
| **Launch playable** | `vanguard` + `vanguard_wizard` LPCA | Full kit migration first. |
| **Witch (stand-in)** | `artisan` — **Ember Wright** (`artisanFemaleLPCA`) | UI label e.g. **“Ember — Witch (WIP)”** — forgehand female LPCA as silhouette/palette stand-in until bespoke witch + PBR pass. |
| **Goblin (placeholder)** | New preset id e.g. `goblin_wip` | v1: **palette swap / scale tweak on `vanguard_wizard` or male default** + UI flag “PLACEHOLDER” — no new mesh until scheduled. |
| **Sorcerer (placeholder)** | New preset id e.g. `sorcerer_wip` | Same approach: **visual clone** + distinct colors/silhouette params. |
| **Future** | Full **goblin LPCA**, **sorcerer LPCA**, **witch** matching cutscene art | After MOBA shell + one lane playable. |

**Lobby / room:** Extend `CharacterPresetId` in [`src/core/types.ts`](src/core/types.ts) and [`src/data/characterPresets.ts`](src/data/characterPresets.ts); mirror allowlist in any new server.

---

## 4. MOBA waves — per-team NPCs

**Design:** Two **spawn directors** (team 0 / team 1). Each spawns **waves** of **rats**, **wolves**, and **wanderer**-class mobs that:

- Are **allied** to their team (don’t aggro friendly heroes).
- **Aggro** enemy heroes + enemy-aligned wave units.
- Grant **essence/gold** to the **killer’s team** (or last-hit rules — decide in implementation).

**Tech reuse:**

- [`src/world/awakenedMobs.ts`](src/world/awakenedMobs.ts), [`src/visual/pveEnemyLPCA.ts`](src/visual/pveEnemyLPCA.ts) — mesh + animation.
- Add **faction** field: `teamId: 0 | 1` on spawn; filter `applyDamage` / AI target selection by faction.
- **Spawn points:** lane endpoints or side camps (mirror symmetric for fairness).

**v1 simplification:** Fixed timer waves (every N seconds); no complex camp respawn clock until objectives are stable.

---

## 5. Objectives (reminder)

- **Trees** — destroyable lane “towers” (health, team ownership).
- **Giant mushrooms** — team cores; win when enemy core destroyed.
- Mushroom **count / placement** — choke map; separate tuning doc or constants in `project.json` / world module.

### 5b Base economy — locked rules

Aligned with [`MOBA_FORGE_WORKBENCH_BRAINSTORM.md`](./MOBA_FORGE_WORKBENCH_BRAINSTORM.md):

- **Death drops:** Heroes **drop part of their carried crystals/materials** on death (percent and loot rules still to tune).
- **Station craft:** Forge and workbench use **channeled crafts** (not instant UI); **interruptible** by movement or enemy pressure.

---

## 6. Boot & shell (no dream mode)

**Target flow:** Title / brief legal → **Play** → **hero select** → **match load** → **3D match** (HUD: spells, progression, minimap later).

- Remove or bypass: `realmMode === 'deck'`, awakening page, gather/craft/inventory/deck tabs.
- **Single “match” realm** or always `awakened`-equivalent free roam with MOBA HUD.
- Preserve [`src/main.ts`](src/main.ts) **instant-entry** pattern (dynamic imports, preload).

---

## 7. Implementation phases (suggested order)

1. **Shell strip** — Hide idle pages; default to MOBA match scene; remove crafting/gather hooks from `mountApp` hot path.
2. **Combat strip** — Remove sword/axe/pick survival gear; **keep staff / magic-weapon melee** + spell hotbar; map **deck spell** stats to **fixed abilities** (no card UI).
3. **Progression v0** — Essence from minions, objectives, **player kills**; tune **weak spells vs heroes** early + staff threat up close; one upgrade + one unlock slot.
4. **Vanguard only** — Ship playable wizard; tune move/jump for MOBA.
5. **Waves v0** — One mob type per side, then add rat/wolf/wanderer mix with `teamId`.
6. **Roster** — Ember stand-in (`artisan`) selectable; add `goblin_wip` / `sorcerer_wip` presets (visual placeholders).
7. **Objectives** — Tree + mushroom health + win condition.
8. **Polish** — Vibe Jam widget, deploy origin, perf pass.

---

## 8. File map (likely touch list)

| Area | Files |
|------|--------|
| Shell / nav | [`src/ui/mountApp.ts`](src/ui/mountApp.ts), [`src/ui/mountStartFlow.ts`](src/ui/mountStartFlow.ts), [`src/main.ts`](src/main.ts) |
| State | [`src/core/gameStore.ts`](src/core/gameStore.ts) (shrink or branch), new `src/moba/*` |
| Magic | [`src/world/magicProjectiles.ts`](src/world/magicProjectiles.ts), [`src/world/defensiveWard.ts`](src/world/defensiveWard.ts), [`src/world/awakenedCombat.ts`](src/world/awakenedCombat.ts) |
| Mobs | [`src/world/awakenedMobs.ts`](src/world/awakenedMobs.ts), spawn wiring from `mountApp` or new `mobaWaveDirector.ts` |
| Heroes | [`src/data/characterPresets.ts`](src/data/characterPresets.ts), [`src/visual/vanguardWizardLPCA.ts`](src/visual/vanguardWizardLPCA.ts), [`src/visual/artisanFemaleLPCA.ts`](src/visual/artisanFemaleLPCA.ts) |
| Data | Extract spell stats from [`src/data/content.ts`](src/data/content.ts) into `src/moba/mobaSpells.ts` (no card UI) |

---

## 9. Open decisions (resolve in first implementation week)

- **Currency:** See **§2b** — essence-only vs XP + gold (add gold when you add a shop).
- **Minion rewards:** See **§2b** — last-hit vs shared vs hybrid.
- **Player kill bounty:** Flat vs scaling with victim streak / match time (anti-snowball).
- **Death drop tuning:** Drop **%**, minimum floor, who can loot (enemies vs FFA).
- **Channel tuning:** Craft duration per tier, interrupt on any damage vs only hard CC.
- **Respawn** timers and fountain heal (if any).

**Locked:** death drops mats; **non-instant** channeled forge/workbench craft (**§5b**).

---

*Last updated: **§5b** death drops + channeled station craft; progression from objectives, NPCs, player kills; Ember stand-in; §2b economy options.*
