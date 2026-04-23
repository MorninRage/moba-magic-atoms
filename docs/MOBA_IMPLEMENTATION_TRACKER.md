# MOBA implementation tracker

**Goal:** Executable checklist from current IDLE-CRAFT fork → playable match slice. Update this file as tasks complete.

**MOBA repo scope:** **`C:\Users\Limin\MOBA`** — online UI is **3v3 only** (`deathmatch`). Co-op caravan and Hunter (1v1) are **not** offered in the start flow; the server may still speak protocol for other modes, but this product does not surface them.

**Enough to start?** **Yes.** Specs in [`MOBA_V1_GAMEPLAN.md`](./MOBA_V1_GAMEPLAN.md), forge loop in [`MOBA_FORGE_WORKBENCH_BRAINSTORM.md`](./MOBA_FORGE_WORKBENCH_BRAINSTORM.md), tuning postponed in [`MOBA_DEFERRED_TUNING.md`](./MOBA_DEFERRED_TUNING.md). Matchmaking: [`MOBA_MATCHMAKING.md`](./MOBA_MATCHMAKING.md). **New repo, Netlify MOBA, Fly deploy, testing, map + match entry:** [`MOBA_DEPLOY_REPO_AND_POST_MATCH_FLOW.md`](./MOBA_DEPLOY_REPO_AND_POST_MATCH_FLOW.md). **EmpireEngine monorepo/submodule/git-dep:** [`MOBA_EMPIRE_ENGINE_CI.md`](./MOBA_EMPIRE_ENGINE_CI.md).

---

## Phase A — Shell & single-player vertical slice

- [x] **A1** Strip or bypass dream/deck UI: new runs + Continue call `resumeIntoMobaShell()`; online launch uses `sessionKind: 'moba_match'` → `realmMode: 'awakened'` (fullscreen 3D + Tab menu; idle nav hidden).
- [x] **A2** Force **3D match** path for MOBA: `beginSoloMobaMatch`, `beginOnlineSession({ sessionKind: 'moba_match' })`, and Continue shim above.
- [ ] **A3** Magic-only combat path: hide sword/axe/pick; keep staff melee + spells.
- [ ] **A4** HUD: HP, Mana, XP (stub level), optional placeholder for mat inventory.
- [ ] **A5** One team’s **forge + workbench** props in base zone + **interaction trigger** (no full recipe graph yet).
- [ ] **A6** **Channeled craft** stub: hold `E` at station → progress bar → grant dummy upgrade (tune later per `MOBA_DEFERRED_TUNING.md`).
- [ ] **A7** **Death drop** stub: on death, spawn pickup pile with test crystal count (tune % later).

## Phase B — Progression & data

- [ ] **B1** Extract spell/weapon stats from `content.ts` into `src/moba/mobaSpells.ts` (or similar) — no deck UI.
- [ ] **B2** XP from kills / objective damage / minions; gate craft **tier** by level.
- [ ] **B3** Crystal types + inventory (start with **2–3** stack types).
- [ ] **B4** **Four-tier weapon ladder** for Vanguard only; Ember copies after.

## Phase C — World & AI

- [ ] **C1** Team **spawn** + base colliders; symmetric second base (or mirror for 1v1 test).
- [ ] **C2** Wave spawner: one mob type + `teamId`; then rat/wolf/wanderer mix.
- [ ] **C3** Objectives: tree HP + mushroom core HP + win condition.

## Phase D — Multiplayer & matchmaking

- [ ] **D1** Transport: WebSocket room (new minimal server or evolve `server/room-server.mjs`).
- [x] **D2** **Matchmaking v1:** FIFO 3v3 (6 players) + 1v1 (2) on `room-server.mjs` v4; `queueLeave`; client **Find 3v3 match**, `?queue=3v3`, auto-queue in lobby (see `MOBA_MATCHMAKING.md`).
- [ ] **D3** Sync: positions, casts, objective state, pickups (authoritative rules TBD).
- [ ] **D4** Optional: public queue (FIFO) after room code works.

## Phase E — Jam / ship

- [x] **E1** Separate deploy origin (Netlify **moba-magic-atoms** + Fly **moba-rooms**); widget in `index.html`; title MOBA copy in start flow.
- [ ] **E2** Perf pass on forest + combat; defer worker path if unstable.

---

## Done (historical)

- [x] Fork repo to `C:\Users\Limin\MOBA`, branding, storage keys isolated from IDLE-CRAFT.
- [x] `npm run build` passes on fork.
- [x] **Post-match entry (§6):** `OnlineSessionMeta.sessionKind`, `beginOnlineSession` + `beginSoloMobaMatch` + `resumeIntoMobaShell`; `#app-shell.moba-match` status chip; `src/moba/mobaMapConfig.ts` stub for map v0.
