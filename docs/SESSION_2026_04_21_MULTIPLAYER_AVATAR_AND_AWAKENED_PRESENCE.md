# Session log — Multiplayer avatar fidelity & awakened co-op presence (2026-04-21)

This document records **online lobby / gather visuals** and **awakened-mode co-op peer replication**: what shipped, which files changed, protocol notes, and explicit **non-goals / follow-ups**.

---

## 1. Goals

1. **Lobby & in-game consistency** — Whatever `CharacterPresetId` a player picks (Vanguard, Artisan, Wayfarer, etc.) should drive **visible character builds**, not a single generic mini-mesh.
2. **Awakened co-op** — While both players are in **awakened free-roam** in the **same co-op room**, each client should **see the other’s survivor in the world** with **smooth motion** (network updates are sparse; interpolation runs every frame).

---

## 2. Lobby carousel — full dock LPCA per preset

**Problem:** `multiplayerAvatarStage.ts` used procedural `buildLobbyMiniFigure` (blocky primitives) for the six-slot lobby.

**Change:**

- New module: `src/visual/lobbyDockHeroFromPreset.ts`
  - Builds the same **dock hero** as the main game via `buildDockHeroLpca`.
  - Applies palette + **build kind** (`default` / `artisan_female` / `vanguard_wizard`) aligned with `CharacterScenePreview.applyCharacterPreset` visibility rules (no orb VFX; staff visibility rules for wizard build).
  - Base scale constant for carousel footprint; optional `sceneScale` multiplier for other uses.
  - Team tint on jerkin emissive (parity with old mini).
  - `userData.disposeGhost` for mesh/material teardown.
- `src/visual/multiplayerAvatarStage.ts`
  - `setSlots` now uses `buildLobbyDockHeroFromPreset(presetId, team)`.
  - **Removed** `buildLobbyMiniFigure` (dead export eliminated).

**Still main-thread only:** `CSS2DRenderer` nametags require DOM; this module remains **outside** the render worker (see `WORKER_ARCHITECTURE.md` lobby carve-out).

---

## 3. Gather “party nearby” mini-ghosts

**Problem:** Co-op gather presence used `buildLobbyMiniFigure` + manual scale.

**Change:** `src/visual/characterScenePreview.ts` — ghosts now use `buildLobbyDockHeroFromPreset(preset, 0, 0.78)` (third argument replaces the old extra `scale.setScalar(0.78)`). Disposal uses the root’s `disposeGhost` from the builder.

---

## 4. Awakened co-op — world pose over `presence` / `presence_update`

### 4.1 Protocol (client + server)

**Wire format** (extends existing v3 presence; backward compatible if fields omitted):

| Field | Meaning |
|--------|---------|
| `realm` | `'deck'` \| `'awakened'` — whether the sender is in awakened free-roam. |
| `wx`, `wy`, `wz` | World-space avatar position (only meaningful when `realm === 'awakened'`). |
| `wyaw` | Avatar body yaw (`avatar.rotation.y`). |

**Files:**

- `src/net/roomTypes.ts` — `PresenceRealmMode`, `RemotePresenceEntry`, extended `presence_update` event shape.
- `src/net/roomHub.ts` / `src/net/roomHubBridge.ts` — `sendPresence` accepts `realm` + pose fields; inbound parse clamps world coords.
- `server/room-server.mjs` — `presence` handler forwards `realm` and, when awakened, `wx/wy/wz/wyaw` (clamped). **Production deploy must include this server change.**

Rate limit: existing **`PRESENCE_MIN_INTERVAL_MS` (85)** still applies server-side.

### 4.2 Store

- `src/core/gameStore.ts` — `remotePresence` map values are now **`RemotePresenceEntry`** (includes `realm` + nullable pose fields). `presence_update` handler merges full row.

### 4.3 Send path

- `src/ui/mountApp.ts`
  - `sendOnlinePresence()` always sends **`realm`** from `store.getRealmMode()`.
  - When awakened, attaches **`getAwakenPresencePose()`** from the dock preview (`x,y,z,yaw`).
  - **~88 ms client throttle** in the main `frame()` loop (co-op + online + awakened) so awakened pose streams without spamming the socket layer; server still enforces 85 ms.

### 4.4 Render path

- `src/visual/characterScenePreview.ts`
  - **`getAwakenPresencePose()`** — public; returns `null` when not `awakenedFreeRoam`.
  - **`syncOnlinePresence`** — new option `awakenCoopPeers` (from `mountApp` when `gameMode === 'coop'`, room connected, local realm awakened, not Hunter shared-camp).
  - **`awakenedCoopPeerRoot`** — scene group for remote peers.
  - **`applyAwakenCoopPeersFromPresence`** — for each remote session with `realm === 'awakened'` and full pose, ensures an LPCA via `buildLobbyDockHeroFromPreset(..., LOBBY_DOCK_HERO_WORLD_SCALE)` (world-scale multiplier exported from `lobbyDockHeroFromPreset.ts`).
  - **`smoothAwakenCoopPeers(dt)`** — exponential smoothing on position + yaw (snap threshold for teleports); runs in the same per-frame path as `smoothHunterPeerFigure`.
  - **`disposeAwakenCoopPeerFigs()`** — teardown when disabled or on `dispose()`.

### 4.5 Scope & limits (important)

| In scope | Out of scope (v1) |
|----------|-------------------|
| Co-op rooms, local awakened, remote also `realm === 'awakened'` with pose | **Full animation sync** (walk cycle phase, clips, combat) — only **position + body yaw** |
| Smooth interpolation between network samples | PvP Hunter duel (already has **`peerDuoRoot` / `buildFullTorsoPeerFigure`** — separate path) |
| All presets via roster `characterPresetId` | `CharacterSceneHost` / worker: **`syncOnlinePresence` not implemented on host** — live game remains **`CharacterScenePreview`** for this feature today |

---

## 5. File checklist (quick reference)

| Area | Files |
|------|--------|
| Lobby LPCA | `src/visual/lobbyDockHeroFromPreset.ts`, `src/visual/multiplayerAvatarStage.ts` |
| Gather ghosts + awaken peers | `src/visual/characterScenePreview.ts` |
| Send + throttle | `src/ui/mountApp.ts` |
| Types + store | `src/net/roomTypes.ts`, `src/core/gameStore.ts` |
| Client WS | `src/net/roomHub.ts`, `src/net/roomHubBridge.ts` |
| Server | `server/room-server.mjs` |

---

## 6. Verification

- `npx tsc --noEmit` — pass after these changes.
- Manual: two clients, co-op room, both **Break → awakened**; move one client — other should see LPCA peer sliding smoothly (not full gait sync).
- Deploy: confirm Fly / self-hosted **room server** matches `room-server.mjs` with `realm` + pose forwarding.

---

## 7. Related plans

- **Worker migration (opt-in `?worker=1` + checklist):** `docs/WORKER_MIGRATION_PHASE_3X.md` · product default **legacy** — `docs/WORKER_VS_LEGACY_PATH.md` — see **§ What’s left** in `PLAN.md` Phase 9.
- **Lobby carve-out (CSS2D):** `docs/WORKER_ARCHITECTURE.md`.
