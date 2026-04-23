# MOBA — new repo, Netlify, Fly, testing, and post-match entry

This doc is the **runbook** for splitting **Magic Orbiting Brandished Atoms** fully away from IDLE-CRAFT: **new Git repo**, **new Netlify site**, **new Fly app**, plus **what to build next** after matchmaking finds a match.

### Implemented (2026-04-23)

| Piece | Value |
|--------|--------|
| Git | [github.com/MorninRage/moba-magic-atoms](https://github.com/MorninRage/moba-magic-atoms) (`main`) |
| Netlify | [moba-magic-atoms.netlify.app](https://moba-magic-atoms.netlify.app) |
| Fly | [moba-rooms.fly.dev](https://moba-rooms.fly.dev) · WSS `wss://moba-rooms.fly.dev` |

**Exact update commands:** [`MOBA_HOSTING_SETUP.md`](./MOBA_HOSTING_SETUP.md).

---

## 0. Two games, two stacks (IDLE-CRAFT unchanged)

You are building **two separate products**. They do **not** have to share hosting or git history.

| | **IDLE-CRAFT** (existing) | **MOBA** (new) |
|--|---------------------------|----------------|
| **Git** | Current idle-deck repo — **leave as-is** | **New repo** — copy MOBA tree; no requirement to link remotes |
| **Netlify** | e.g. `idle-craft1.netlify.app` — **unchanged** | **moba-magic-atoms.netlify.app** (live) |
| **Fly (rooms)** | e.g. `idle-craft-rooms.fly.dev` — **unchanged** | **moba-rooms.fly.dev** (live) |
| **Env** | Existing `VITE_ROOM_WS_URL` if any | **Must** set `VITE_ROOM_WS_URL=wss://<moba-fly-app>.fly.dev` on MOBA Netlify |
| **Players** | Old URL → old lobby server | New URL → **only** MOBA queue/rooms |

**Why say anything about EmpireEngine at all?**  
MOBA still **uses** the same **EmpireEngine code** (the library). That is **not** the same as sharing Fly/Netlify/Git with IDLE-CRAFT. You **can** (and should) put a copy of EmpireEngine **inside the MOBA project’s repo** (monorepo folder, submodule, or git dependency) so MOBA builds anywhere — **without** touching the idle-deck repo. See [`MOBA_EMPIRE_ENGINE_CI.md`](./MOBA_EMPIRE_ENGINE_CI.md).

**What “`file:../EmpireEngine`” confused**  
That line in `package.json` means: “look for a folder named `EmpireEngine` **next to** the game folder.” On your PC that’s `C:\Users\Limin\EmpireEngine` next to `C:\Users\Limin\MOBA`. In a **new** git repo, Netlify only downloads **that** repo — so unless **EmpireEngine is also inside that download** (same repo layout, submodule, or install from git), npm won’t find `../EmpireEngine`. **Fix:** put EmpireEngine **in** the MOBA repo layout or switch to `git+https://...` for `empire-engine`. It does **not** mean EmpireEngine is forbidden — it means the **path must be valid on the build machine**.

---

## 1. Repository strategy

| Item | Decision |
|------|----------|
| **Git** | **New repository** (not the idle-deck monorepo). Copy or push the current `C:\Users\Limin\MOBA` tree as the initial commit; remove or archive any references that assume sibling `idle deck` except where you intentionally document the fork lineage. |
| **EmpireEngine** | Required for production bundles (LPC, render, physics). `file:../EmpireEngine` only works when that folder exists next to the game in the clone. **See [`MOBA_EMPIRE_ENGINE_CI.md`](./MOBA_EMPIRE_ENGINE_CI.md)** for monorepo, submodule, git dependency, or Netlify clone strategies — match IDLE-CRAFT engine parity by pinning the same engine revision + `three` + Vite `dedupe`. |
| **Branches** | `main` = production-shaped; feature branches for map + match entry. |

---

## 2. Netlify (site **moba-magic-atoms**)

| Item | Notes |
|------|--------|
| **Site** | **https://moba-magic-atoms.netlify.app** — slug **`moba-magic-atoms`**, team **`morninrage`**. Link GitHub **MorninRage/moba-magic-atoms** in the dashboard for CI builds. |
| **Build** | Root = game repo root. **Build command:** `npm run build`. **Publish directory:** `dist`. |
| **Node** | Match `netlify.toml` / `NODE_VERSION` (e.g. 20) with local. |
| **Env vars** | **`VITE_ROOM_WS_URL`** = `wss://<your-fly-app>.fly.dev` (production room server). Do **not** rely on dev fallback in production. |
| **Jam** | Vibe Jam needs **one stable origin** — the Netlify URL you submit. Update `index.html` widget if jam rules require verification of domain. |

---

## 3. Fly.io (room server) — **new app for MOBA**

| Item | Notes |
|------|--------|
| **Deploy** | From MOBA repo **`server/`** (Dockerfile + `fly.toml`). |
| **App name** | Use a **new** Fly app (e.g. `moba-rooms`) — **do not** reuse `idle-craft-rooms` if you want IDLE-CRAFT’s lobby to keep working exactly as today on its own URL. |
| **Client** | Done: **`moba-rooms`**, **`wss://moba-rooms.fly.dev`** in `fly.toml`, `netlify.toml`, `.env.production`, and **`PROD_LOBBY_WSS`** in [`src/net/roomHub.ts`](../src/net/roomHub.ts) / [`roomHubBridge.ts`](../src/net/roomHubBridge.ts). |
| **Health** | `GET /health` → `ok` (used by platforms / smoke tests). |
| **Optional env** | `MOBA_3V3_QUEUE_SIZE=6` (default is 6). |

See [`server/README.md`](../server/README.md) for protocol summary.

---

## 4. Testing checklist (before “everything in place” deploy)

Run locally with **server + client** so queue behavior matches production.

### 4.1 Local room server

```bash
cd server
npm install
npm start
# listens on PORT or 3334
```

### 4.2 Local game

```bash
# repo root
echo "VITE_ROOM_WS_URL=ws://127.0.0.1:3334" > .env.local
npm run dev
```

### 4.3 Matchmaking smoke tests

| # | Test | Pass criteria |
|---|------|----------------|
| 1 | Open **6** browser profiles/tabs to same lobby URL, same mode **Forge clash (3v3)**, **Find match** | All six receive **`queue_matched`** + same **`roomId`**; teams alternate A/B; **`queue_status`** shows growing **`queueSize`** until 6. |
| 2 | **Leave queue** | **`left_queue`**; **`queueSize`** decrements for others. |
| 3 | **Room code** create/join | Player leaves queue implicitly when creating/joining a room (server **`dequeueSessionEverywhere`**). |
| 4 | **1v1** queue | Two players **`pvp`** queue → one room, two players. |
| 5 | **Ready → Lock → Launch** | Host can **lock** when all ready; **Launch** sets phase **active**; client **`onEnterGame`** fires (current behavior: still IDLE-CRAFT shell until map work lands). |

### 4.4 Production dry run

After Netlify + Fly deploy: repeat test 1 with **wss** URL and real devices (mobile + desktop).

---

## 5. Documentation index (related)

| Doc | Purpose |
|-----|---------|
| [`MOBA_MATCHMAKING.md`](./MOBA_MATCHMAKING.md) | FIFO queue, room code, future tiers |
| [`MOBA_IMPLEMENTATION_TRACKER.md`](./MOBA_IMPLEMENTATION_TRACKER.md) | Phased task checklist |
| [`MOBA_V1_GAMEPLAN.md`](./MOBA_V1_GAMEPLAN.md) | Product scope |
| [`MOBA_FORGE_WORKBENCH_BRAINSTORM.md`](./MOBA_FORGE_WORKBENCH_BRAINSTORM.md) | Economy + stations |

---

## 6. Next build phase — **map** + **entering the game** after match found

Today, **`onEnterGame`** in [`src/ui/mountOnlineLobby.ts`](../src/ui/mountOnlineLobby.ts) still hands off to the **legacy** flow (`store.beginOnlineSession` → `mountApp` idle shell). For MOBA you need a **dedicated entry pipeline**.

### 6.1 Goals

1. **Deterministic match load** — `roomId`, `seed`, `team`, roster from [`OnlineLaunchSession`](../src/ui/mountOnlineLobby.ts) drive one **MOBA match** scene, not dream/deck tabs.
2. **Map** — elongated forest / lane layout, team bases (forge + workbench props), objectives (trees + mushroom cores), spawn points; reuse [`project.json`](../project.json) + [`forestEnvironment`](../src/visual/forestEnvironment.ts) pipeline where possible.
3. **Minimal HUD** — team, HP/mana/XP placeholders, minimap later.
4. **No idle deck** — skip `realmMode === 'deck'` path for this session type (new flag e.g. `sessionKind: 'moba_match'` on store or parallel `MobaSessionState`).

### 6.2 Suggested implementation order

| Step | Work |
|------|------|
| **A** | Add **`beginMobaOnlineSession(session)`** (or extend `beginOnlineSession`) that sets a flag and **skips** idle nav; boot **directly** into awakened-style 3D with MOBA HUD shell. |
| **B** | **`mountMobaMatch.ts`** (new): owns canvas, `CharacterScenePreview` or host, `freeRoamControls`, and reads **`seed`** for procedural params. |
| **C** | **Map v0** — tune `project.json` / terrain aspect for **lane length**; place **team spawn** + **forge/workbench** volumes from constants or small **`mobaMap.json`**. |
| **D** | **Gate old UI** — if `sessionKind === 'moba_match'`, `mountApp` does not render gather/craft/deck pages (or bypass `mountApp` entirely for match route). |
| **E** | **Multiplayer replication** — positions/casts/objectives sync (thin server or host-authoritative); out of scope for first vertical slice but hooks should live next to match entry. |

### 6.3 Files likely touched

- [`src/main.ts`](../src/main.ts) / [`src/ui/mountStartFlow.ts`](../src/ui/mountStartFlow.ts) — branch after `onEnterGame`.
- [`src/core/gameStore.ts`](../src/core/gameStore.ts) — session shape + `beginOnlineSession` refactor.
- [`src/ui/mountApp.ts`](../src/ui/mountApp.ts) — conditional strip or bypass.
- New: `src/moba/mountMobaMatch.ts`, `src/moba/mobaMapConfig.ts` (or JSON).

---

## 7. One-time migration checklist (when “everything in place”)

- [ ] New **GitHub/GitLab** repo created; MOBA tree pushed; **EmpireEngine** dependency resolved for CI.
- [ ] **Fly** room app deployed (**v4** server).
- [ ] **Netlify** site **MOBA** created; **`VITE_ROOM_WS_URL`** set; **`npm run build`** green on Netlify.
- [ ] **Smoke:** 6-client queue → room → ready → launch → **MOBA map** visible (post step 6).
- [ ] **Jam:** Submit **MOBA.netlify.app** (or final URL) to Vibe Jam; widget loads.

---

*Last updated: deploy/runbook + post-matchmaking map/entry roadmap for MOBA-only repo and Netlify.*
