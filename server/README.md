# MOBA / IDLE-CRAFT room server

Node **WebSocket** hub for **co-op / PvP / 3v3** lobbies: up to **6 players**, **phases** (`lobby` → `locked` → `active`), **deterministic seed** per room, **browse + create + join + queue**.

**Protocol v4:** `deathmatch` **FIFO matchmaking** drains the queue in batches of **6** (configurable via `MOBA_3V3_QUEUE_SIZE`). **`pvp`** drains **2** at a time. Messages: `queueLeave`, `left_queue`, `queue_status` includes `queueSize`.

Uses **HTTP + WS upgrade** so **Fly.io** reverse proxies work (`GET /health` → `ok`).

## Run locally

```bash
cd server
npm install
npm start
```

Default port **3334**. Set `PORT` to override.

## Protocol v2 (summary)

All client messages include `"v":2`. Server responds with the same `v`.

1. **welcome** — server sends first after connect.
2. **hello** `{ "t":"hello","v":2 }` → **hello_ok** `{ "v":2 }`.
3. **listRooms** `{ "t":"listRooms", "gameMode"?: "coop"|"pvp"|"deathmatch" }` → **room_list** `{ "rooms":[{ id, gameMode, phase, playerCount, maxPlayers, isPublic }] }`.
4. **createRoom** `{ "t":"createRoom", "gameMode", "displayName", "characterPresetId", "team"?:0|1, "isPublic"?:true }` → **room_snapshot** (you are host). `solo` is rejected.
5. **joinRoom** `{ "t":"joinRoom", "roomId", "displayName", "characterPresetId", "team"?:0|1 }` → **room_snapshot** to everyone in room. Fails if `room_locked`, `room_full`, etc.
6. **leaveRoom** → **left_room**; others get **room_snapshot**.
7. **setReady** `{ "ready":boolean }` → **room_snapshot** to room.
8. **lockStart** (host, lobby, all ready, min2 players) → phase **locked**, **room_snapshot**.
9. **beginActive** (host, after locked) → phase **active**, **room_snapshot**.
10. **queueJoin** `{ "gameMode":"pvp"|"deathmatch", ... }` → **queue_status**; when ≥2 waiting, **queue_matched** + **room_snapshot** (co-op should use create/join instead).
11. **battleIntent** — stub: **battle_intent_ok** when room phase is **active** (co-op shared vs PvP validated string placeholder).
12. **roomChat** `{ "t":"roomChat", "text":"..." }` (in a room) → server broadcasts **room_chat** `{ fromSessionId, displayName, text, ts }` to everyone in that room.
13. **voiceSignal** `{ "t":"voiceSignal", "toSessionId", "kind":"offer"|"answer"|"candidate", "sdp"?, "candidate"? }` — relayed to that peer as **voice_signal** `{ fromSessionId, kind, sdp, candidate }` (WebRTC signaling only; media is peer‑to‑peer).

**room_snapshot.room** includes: `id`, `gameMode`, `phase`, `seed`, `maxPlayers`, `isPublic`, `players[]` (`sessionId`, `displayName`, `characterPresetId`, `team`, `ready`, `isHost`), `yourSessionId`.

## Game client (Vite)

Repo root `.env.local`:

- `VITE_ROOM_WS_URL=ws://localhost:3334` — connects from the title screen; lobby UI drives create/join/queue.

Production: `VITE_ROOM_WS_URL=wss://your-fly-app.fly.dev` (set at **build** time on Netlify or CI).

## Fly.io

`Dockerfile` + `fly.toml` live in this folder.

```bash
cd server
fly launch --no-deploy
fly deploy
```

Use the deployed host in `VITE_ROOM_WS_URL` for static builds. See **`docs/DEPLOY.md`** in the repo for Netlify + Fly checklist.
