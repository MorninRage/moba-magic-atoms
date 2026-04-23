# Brainstorm — team forge + workbench, magic-forged weapons, dual progression

**Locked design (authoritative):**

- **Death drop:** On hero death, the victim drops **a portion of carried crystals / materials** (exact % TBD — tune for snowball vs recovery). Enemies and teammates can pick up **per team rules** (e.g. enemies only, or free-for-all — TBD).
- **Crafting is channeled, not instant:** Forge and workbench actions require the player to **stand at the station** and **hold a channel** (e.g. 3–8 s per recipe tier). **Moving, taking damage, or hard CC** cancels or pauses the channel — base dives are a real risk.

**Intent:** Each team has a **forge** and **workbench** at base. Players farm **crystals / materials** by **hitting things with magic** (minions, objectives, maybe crystal nodes). They **return to base** to **craft** the next **magic weapon** tier and to **upgrade** what they already own. **Offense and defense** are expressed through **weapon identity** (staff vs wand lines, each with imbued spells / wards). Separate **XP** levels the hero; **mana** fuels casts; **health** is survival.

This replaces a generic “MOBA shop gold” loop with a **physically grounded, magic-themed economy** that fits the forest + LPCA fantasy.

---

## 1. Core loop (minute-to-minute)

1. **Lane / fight** — Cast magic at enemies and objectives; **on-hit or on-kill** drops **crystal shards** (auto-pickup in radius or manual `E` at base only — TBD).
2. **Recall / walk back** — Risk window: leaving lane to spend resources.
3. **Forge** — **Weapon** progression: new **staff / wand** recipes, **reforge** (damage tier), **socket** offensive patterns (bolts, cones).
4. **Workbench** — **Defensive / utility** side: wards, bracers, **off-hand** wands, consumable charges, or “armor” that only affects magic mitigation — keep split clear so players know where to go.
5. **XP** still rises from **combat participation** (kills, assists, objective damage) and gates **which tier of blueprint** you can *equip* or *craft* — avoids a pure material rush ignoring levels.

**Crafting:** Uses **channeled interaction** at the station (see header locks). Duration scales with recipe tier if needed.

---

## 2. Meters on HUD

| Meter | Role |
|-------|------|
| **Health** | Standard. |
| **Mana** | Cast budget; regen scales lightly with level or a cheap workbench tonic. |
| **Magic** (rename?) | If distinct from mana: e.g. **“Ley charge”** for staff **empowered melee** or **weapon active** — avoids overloading one bar. Alternative: **drop “magic” bar v1** and use **weapon heat** or **cooldowns only** to reduce HUD clutter. |
| **XP** | Level; unlocks **craft tier cap** (e.g. can’t equip Tier III wand until L6). |

**Brainstorm resolution:** Either **3 bars** (HP, Mana, XP as level number + bar) or **4** if weapon kit needs a second resource — playtest on 1080p mobile later.

---

## 3. Two ways to get stronger (your ask, formalized)

| Track | What it is | Where |
|-------|------------|--------|
| **A — New weapon rung** | Forge **4 progressive options** per hero (see §4). Each rung changes **base damage**, **spell package**, or **defensive passive**. | Forge + materials + XP gate |
| **B — Upgrade existing piece** | Same weapon **+1 / +2** (damage, mana cost reduction, shorter CD on bound spell). Costs **fewer rare mats**, more **common shards**. | Forge (reforge) or workbench (infuse) |

**Feel:** **A** is a **spike** (“I finished my Tier-2 staff”). **B** is **smooth power** between spikes — prevents dry stretches with nothing to spend.

---

## 4. Four progressive options per character (pattern)

Not necessarily four *separate* meshes — could be **four recipe nodes** on one visual staff that **swap LPCA attachments** (orb, blade, cage, crescent).

Example template for **Vanguard**:

1. **Initiate rod** — baseline bolt + staff poke; cheap mats.
2. **Ley-thread staff** — second bolt pattern or pierce; needs blue crystals from objectives.
3. **Warden staff** — defensive: stronger ward bind on block / RMB; needs rare drop from **tree** objective.
4. **High arcanist** — capstone: AoE or dash-strike; needs **mushroom core** fragment + high XP.

**Ember (witch stand-in):** parallel tree but **wand-primary**, faster cadence, different defensive bind.

**Placeholders (goblin / sorcerer):** reuse **same four-node structure** with **recolor + stat skew** until bespoke LPCA.

**Balance knob:** Options **2–3** sidegrade horizontally (off vs def) if you want choice, not only linear vertical — but jam scope may prefer **strict linear** four steps.

---

## 5. Materials from “shooting magic at things”

**Sources (stackable):**

- **Minions** — common shards; tuned with **last-hit vs shared** rule from main gameplan.
- **Objectives (trees)** — mid-tier; rewards **siege** play.
- **Mushroom core phases** — rare; only after outer trees fall (if you gate).
- **Ambient crystal props** — optional regrowing nodes on map; magic damage “mines” them (reuse existing crystal scatter tech).

**Anti-AFK farm:** Diminishing returns on **same camp** per minute, or **team-shared** crystal cap on passive nodes.

---

## 6. Forge vs workbench split (clarity for players)

| Station | Fiction | Mechanics |
|---------|---------|-----------|
| **Forge** | Heat, shaping, binding offensive ley | **Staff / wand bodies**, **reforge damage**, **unlock cast patterns** |
| **Workbench** | Fine runes, leather, corked vials | **Off-hand**, **trinket mitigation**, **charges** (heal, cleanse), **trap** or **ward totem** |

If **one station** is simpler for v1: merge into **“Arcane bench”** with two UI tabs — ship **two props** in base for **readability** either way.

---

## 7. Ties to earlier MOBA doc

- **No ores / pickaxe** — materials are **magic-derived**, not mining nodes.
- **No idle deck** — progression is **XP + mats + stations**.
- **Staff melee** stays relevant — weapon tier can scale **melee arcane strike** separately from **bolt** damage (two upgrade sliders = depth).

---

## 8. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Too much walking sim | **Recall** button with channel; or **cheap waystones** near inner lane |
| Base dives feel unfair | **Brief invuln** on spawn + **turret-tree** peel until first weapon craft |
| UI overload | Start with **3** meters; fold “magic” into weapon cooldown UI |
| Scope creep | **One** forge recipe tree for Vanguard only; Ember copies numbers |

---

## 9. Next decisions (still open)

1. **Materials inventory** — grid slots vs single stack per crystal type (latter easier).
2. **Death drop %** — e.g. 30–50% of stacks, floor/ceiling per mat type, anti-grief rules.
3. **Who can loot death bags** — enemies only vs anyone; ally secure vs steal meta.
4. **Channel rules** — interrupt on any damage vs only hard staggers; whether partial progress is saved.
5. **Linear 4 tiers** vs **branch at tier 2** (off/def).

---

*Locked: death drops mats; channeled station craft. Fold other stable choices into `MOBA_V1_GAMEPLAN.md` as they settle.*
