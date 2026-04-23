# Deploy: Netlify (game) + Fly.io (lobby WebSocket)

**MOBA fork:** Use **`docs/MOBA_HOSTING_SETUP.md`** for the MOBA-specific Git remote, Fly app **`moba-rooms`**, and Netlify site (**`moba.netlify.app`** target). This file is the generic split (Netlify static + Fly WSS).

**Using Cursor / an AI agent?** See **`docs/DEPLOY_WITH_CURSOR.md`** for what to ask, which npm scripts to run, and login limitations.

This doc locks the **transport and domain split** for IDLE-CRAFT: static **Vite** build on **Netlify**, **Node** room server on **Fly.io** with **WSS**. One HTML/JS origin, one WebSocket host.

## Quick reference

| What | Where | Command / URL |
|------|--------|----------------|
| Room server | Fly app **`idle-craft-rooms`** | `npm run deploy:fly` or `cd server` → `fly deploy` |
| Health | Same app | `https://idle-craft-rooms.fly.dev/health` → `ok` |
| Game static | Netlify **`idle-crafting`** | `npm run build` → `netlify deploy --dir=dist --prod` |
| Prod lobby URL (baked into build) | `netlify.toml` + `.env.production` | `wss://idle-craft-rooms.fly.dev` |

**Order when you ship protocol or server changes:** deploy **Fly** first, then **Netlify** (so new clients talk to the new server). If you only change client UI, Netlify alone is enough.

## Architecture

| Piece | Role | Host |
|--------|------|------|
| `npm run build` → `dist/` | Game client | Netlify (static) |
| `server/room-server.mjs` | Lobby **protocol v3**: rooms, phases, co-op shared stash, PvP vote/strikes/elimination, chat/voice relay | Fly (Dockerfile in `server/`) |

- **WebSocket only** for lobby: no CORS issues for normal play. Add CORS if you expose HTTPS APIs later.
- **Phases:** `lobby` → host **lock** → `locked` → host **launch** → `active`. Join rejected when not in `lobby`.

---

## Fly.io (room server) — review

### One-time setup

1. Install [flyctl](https://fly.io/docs/hands-on/install-flyctl/) (`fly version` to verify).
2. Log in: `fly auth login` (opens browser).
3. This repo already has **`server/fly.toml`** (`app = "idle-craft-rooms"`) and **`server/Dockerfile`**.
   - **New Fly app:** from `server/`, run `fly launch` once (follow prompts; align with this repo’s `fly.toml` / Dockerfile).
   - **Existing app (usual case):** only **`fly deploy`** from `server/` — no `fly launch` each time.

### Every deploy (from repo)

The Fly config and Dockerfile live under **`server/`**. Deploy **must** run with that directory as context (Fly reads `server/fly.toml`).

**PowerShell (Windows):**

```powershell
cd "C:\Users\Limin\idle deck\server"
fly deploy
```

**bash:**

```bash
cd server
fly deploy
```

Fly builds the image (Node22 Alpine, `PORT=8080`, matches `internal_port` in `fly.toml`) and rolls out the app.

### Verify

```powershell
curl https://idle-craft-rooms.fly.dev/health
```

Expect plain text: `ok`.

Optional: `fly status -a idle-craft-rooms` and `fly logs -a idle-craft-rooms`.

### If the lobby looks “down” from the browser

- Cold start: `fly.toml` allows **scale to zero**; first connection after idle can take a few seconds.
- Wrong URL: production builds use **`wss://idle-craft-rooms.fly.dev`** (see `netlify.toml`). If you rename the Fly app, update `VITE_ROOM_WS_URL` everywhere and redeploy Netlify.

### Secrets

This room server does not require Fly secrets for the current feature set. If you add API keys later, use `fly secrets set KEY=value` in `server/` context.

---

## Netlify (game)

**Typical site name:** `idle-crafting` → **https://idle-crafting.netlify.app**. Your machine may be linked to a different site; run **`netlify status`** from the repo root to see the **Production URL** and **Site name** actually in use.

1. Build: `npm run build` (root) — `netlify.toml` sets `VITE_ROOM_WS_URL=wss://idle-craft-rooms.fly.dev` for production builds.
2. Deploy: upload **`dist/`** (not repo root).

### Netlify CLI

**One-time:** `npm install -g netlify-cli` → `netlify login` → from repo root `netlify link --name idle-crafting`.

**Production deploy (recommended):**

```powershell
cd "C:\Users\Limin\idle deck"
npm run deploy:netlify
```

Equivalent to `npm run build` then `netlify deploy --dir=dist --prod`.

**Preview only (draft URL):**

```powershell
npm run build
netlify deploy --dir=dist
```

**Git-connected site:** pushes can auto-build; CLI is still useful to ship an exact local `dist/` immediately.

### After Fly URL or env changes

Update **`netlify.toml`** `[build.environment] VITE_ROOM_WS_URL` and **`.env.production`** if present, then redeploy Netlify. You do **not** need to change this when only the Netlify site domain changes — only when the **room server** host changes.

---

## Local dev

| Terminal | Command |
|----------|---------|
| Game | `npm run dev` → http://localhost:3000 |
| Lobby | `npm run rooms` or `cd server && npm start` → **ws://localhost:3334** |

Repo root **`.env.local`:** `VITE_ROOM_WS_URL=ws://localhost:3334` (optional; dev fallback in code targets port 3334).

---

## Go-live checklist

1. **Fly:** `cd server` → `fly deploy` → `curl …/health` → `ok`.
2. **Netlify:** `npm run deploy:netlify` (or push to git if CI builds).
3. **Smoke:** Open Netlify URL → online mode → lobby connects → create/join room → chat/voice if testing.

---

## Research notes (concise)

- **Fly:** Docker + `fly.toml`; single region (`iad` in this repo) keeps WS latency predictable.
- **Netlify:** Static SPA; realtime authority stays on Fly.
- Official: [Netlify env + build](https://docs.netlify.com/environment-variables/overview/), [Fly deploy](https://fly.io/docs/flyctl/deploy/).
