# Vibe Jam 2026 — Portal & solo battle (IDLE-CRAFT)

**Game root:** this file lives next to `package.json` as `vibejam_portal_solo_battle.md`.  
**Jam rules (source of truth):** [vibej.am/2026](https://vibej.am/2026) — Widget (required), Portals (optional).  
**Companion:** `PLAN.md` (delivery checklist), `GAME_MASTER.md` (systems map), **`IDLE_CRAFT_CONTEST_AND_FEATURE_PLAN.md`** (full merged roadmap including Fly/lobbies/menus).

This document ties **official jam expectations** to **this repo**: what we implemented, what is partial, and what is intentionally out of scope or still to do.

---

## 1. Terminology

| Term | Meaning here |
|------|----------------|
| **Portal (jam)** | Optional webring: exit redirects to `https://vibej.am/portal/2026` with query params; hub sends players to the next game with `?portal=true`. |
| **Solo battle** | This project’s **single-player PvE** combat (turn-based, one player vs procedural dock enemies — rat, wolf, deserter). Not a separate jam category; it’s our combat pillar for the entry. |
| **Widget** | Required jam snippet (`widget.js`) for entrant / popularity tracking. |

---

## 2. Official requirements vs this build

### 2.1 Required — Widget

| Requirement | Status | Notes |
|-------------|--------|--------|
| Load official widget JS | **Done** | `index.html` — `https://vibej.am/2026/widget.js` (async) |
| Single stable public origin | **Ops** | Deploy to one domain (e.g. Netlify); jam tracks by host |

### 2.2 Optional — Portals (exit)

| Requirement | Status | Notes |
|-------------|--------|--------|
| Exit to `https://vibej.am/portal/2026` | **Done** | `src/vibeJamPortal.ts` — `buildVibeJamPortalExitUrl`; `src/main.ts` listens for `vibejam-portal-exit` |
| Forward `ref` (origin) | **Done** | `ref: window.location.host` |
| Forward continuity params | **Partial** | We send `username` (from lobby **Callsign** / `idlecraft-display-name` when set, else `Survivor`), `color` (`amber`), `hp` (1–100% from run). Jam also documents `speed`, `avatar_url`, `team`, velocity/rotation — **not sent** |
| Player walks into portal | **Done (UX)** | Portal tab → `portal_enter` clip walks avatar into dock portal VFX; on clip end → redirect |
| 3D portal presentation | **Done** | `plasmaPortalLPCA.ts` + `characterScenePreview.ts` |

### 2.3 Optional — Portals (incoming / return)

| Requirement | Status | Notes |
|-------------|--------|--------|
| Detect `?portal=true` | **Partial** | `applyVibeJamPortalArrivalClass()` — adds `vibejam-from-portal` on `<body>` for styling only |
| Spawn / label **return portal** using `ref` + params | **Not done** | Jam asks for a portal back to the previous game, re-forwarding query params. UI copy on Portal tab still says this can be added later |
| Instant load / no blocking gate | **Done** | No extra portal gate screen; game loads into main shell |

### 2.4 General jam fit (web, Three.js, no heavy load)

| Requirement | Status | Notes |
|-------------|--------|--------|
| Web, no login in core loop | **Done** | Vite SPA |
| Three.js usage | **Done** | Character dock + portal + battle + gather props |
| Avoid heavy downloads | **Done** | Procedural geometry; no large asset bundles for core play |

---

## 3. Solo battle (PvE) — implementation status

### 3.1 Core systems

| Item | Status | Where |
|------|--------|--------|
| Turn-based PvE | **Done** | `gameStore.ts` — energy, mana, cards, enemy HP, log |
| Enemy scaling / waves | **Done** | `pveWave`, rewards, meat loot |
| Equipment & helpers in combat | **Done** | Damage, block, armor, weapons |
| Permadeath on 0 HP (battle or world) | **Done** | `dieAndWipe`; battle death uses `pendingPermadeath` + dock clip first |
| PvP / `battle.mode === 'pvp'` | **Not implemented** | Type exists in `types.ts`; no live PvP flow |

### 3.2 Character dock (battle presentation)

| Item | Status | Where |
|------|--------|--------|
| Procedural enemies (rat, wolf, deserter) | **Done** | `pveEnemyLPCA.ts`, `syncBattleContext` |
| Strike / cast / enemy strike clips | **Done** | `characterScenePreview.ts` |
| Combat blood VFX | **Done** | Pools, face/shirt/pants cascade, rat vs human presets |
| Enemy death animation + corpse | **Done** | `battle_enemy_death`, `battleEnemyCorpseFallen`, root reset on new encounter |
| Player death animation | **Done** | `battle_player_death` → wipe + dock reset + relevel feet |
| Dock spacing (player vs enemy) | **Done (tuned)** | `BATTLE_ENEMY_REST_*`, lunge constants — verify in source |

---

## 4. Summary scorecard

| Area | Approx. completion | Comment |
|------|-------------------|---------|
| Jam widget | **100%** | Required snippet present |
| Portal **exit** | **~85%** | Redirect + core params; optional jam params not all forwarded |
| Portal **return / incoming** | **~15%** | Detection stub only; no return portal or param echo |
| Solo PvE battle (gameplay) | **~95%** | Full loop; PvP unused |
| Solo battle (dock / juice) | **~95%** | Page poses, gear rules, phased hunt/structures, hit FX + reactions; server dispatch later |
| Multiplayer (jam “preferred”) | **Lobby + parallel play** | Fly **protocol v2** + in-browser lobby (chat/voice, 6-slot stage); host launch → **fresh local expedition** per player with shared room/seed HUD. **Not** shared inventory or live PvP combat vs peer decks |

---

## 5. Recommended backlog (jam-aligned)

Priority order if you want to **close gaps** to the portal spec:

1. **Return portal (incoming)** — When URL has `portal=true` and `ref`, show a dock or UI affordance that redirects back to `ref` with the same params jam recommends (and document behavior in Portal tab).
2. **Forward optional hub params** — e.g. `speed` from game state if you add a meaningful stat; avoid inventing data the game doesn’t have.
3. ~~**Dynamic `username`**~~ — **Done** for portal exit when the player set a **Callsign** in the online lobby (stored in `idlecraft-display-name`).
4. **PvP** — Only if you expand scope; types are ready-ish, product is not.

Non-jam polish (solo battle / idle) can continue in parallel — see `PLAN.md`.

---

## 6. Source index (quick)

| Topic | Files |
|--------|--------|
| Widget | `index.html` |
| Exit URL & arrival class | `src/vibeJamPortal.ts`, `src/main.ts` |
| Portal tab UI | `src/ui/mountApp.ts`, `src/ui/app.css` |
| Portal clip & VFX | `src/visual/characterScenePreview.ts`, `src/visual/plasmaPortalLPCA.ts` |
| Battle & permadeath | `src/core/gameStore.ts`, `src/core/types.ts` |
| Battle dock | `src/visual/characterScenePreview.ts`, `src/visual/pveEnemyLPCA.ts` |
| Optional WS scaffold | `server/room-server.mjs`, `server/README.md` |

---

## 7. Keeping this doc honest

When you ship a backlog item, update **§2**, **§3**, and **§4** in the same PR. Link to `PLAN.md` for granular phase checklists.

---

*Last reviewed: aligns with IDLE-CRAFT repo layout; jam rules as published at vibej.am/2026 (Portals + Widget sections).*
