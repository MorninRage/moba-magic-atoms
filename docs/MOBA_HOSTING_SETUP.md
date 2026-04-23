# MOBA hosting: Git, Fly (rooms), Netlify (static)

MOBA uses **one Git repo**, **one Fly app** for the WebSocket lobby (`server/`), and **one Netlify site** for the Vite client (`dist/`). Defaults in this repo assume:

| Piece | Name / URL |
|--------|------------|
| Fly app | `moba-rooms` → `https://moba-rooms.fly.dev`, WSS `wss://moba-rooms.fly.dev` |
| Netlify | Target site slug **`moba`** → `https://moba.netlify.app` (pick another slug if taken) |

If you rename the Fly app, update **`server/fly.toml` `app`**, **`netlify.toml`** and **`.env.production`** `VITE_ROOM_WS_URL`, and **`PROD_LOBBY_WSS`** in `src/net/roomHub.ts` and `src/net/roomHubBridge.ts` to match `wss://<your-app>.fly.dev`, then redeploy both.

**EmpireEngine on CI:** see [`MOBA_EMPIRE_ENGINE_CI.md`](./MOBA_EMPIRE_ENGINE_CI.md).

---

## 1. Git (new remote)

From the MOBA repo root (not `idle deck`):

```powershell
git status
git remote -v
```

Create an empty repository on GitHub (or another host), then:

```powershell
git remote add origin https://github.com/<you>/<moba-repo>.git
git branch -M main
git push -u origin main
```

Use a **MOBA-only** remote; do not point this at the IDLE-CRAFT Netlify/Fly stack.

---

## 2. Fly.io (room server)

1. Install [flyctl](https://fly.io/docs/hands-on/install-flyctl/) and run `fly auth login`.
2. Deploy from **`server/`** (Dockerfile + `fly.toml` live there):

```powershell
cd path\to\MOBA\server
fly launch
```

- When prompted, use app name **`moba-rooms`** (or change `app` in `fly.toml` and client URLs to match).
- Prefer the existing **`fly.toml`** in this folder over generating conflicting config; you can cancel wizard edits and keep the committed file, then `fly deploy`.

**Routine deploys:**

```powershell
cd path\to\MOBA\server
fly deploy
```

**Verify:**

```powershell
curl https://moba-rooms.fly.dev/health
```

Expect plain text `ok`. First request after scale-to-zero may take a few seconds.

**Optional secrets** (see `server/room-server.mjs` / `server/README.md`):

```powershell
fly secrets set MOBA_3V3_QUEUE_SIZE=6 -a moba-rooms
```

---

## 3. Netlify (static site)

1. In [Netlify](https://app.netlify.com): **Add new site** → **Import an existing project** → connect the **MOBA** Git repo.
2. Build settings (should match `netlify.toml`):
   - **Build command:** `npm run build`
   - **Publish directory:** `dist`
   - **Node:** 20 (set in `netlify.toml` `[build.environment]`)
3. **Environment variables** (Site settings → Environment variables):
   - **`VITE_ROOM_WS_URL`** = `wss://moba-rooms.fly.dev` (must match your Fly app hostname if you renamed it).

The committed `netlify.toml` already sets `VITE_ROOM_WS_URL` for builds; the dashboard value overrides or duplicates that for clarity across branches.

4. Optional: set site name to **`moba`** for `moba.netlify.app`, or attach a custom domain.

**CLI alternative** (after `netlify login` and `netlify link` to the new site):

```powershell
cd path\to\MOBA
npm run deploy:netlify
```

---

## 4. Ship order

1. **Fly** — deploy room server; confirm `/health`.
2. **Netlify** — build with correct `VITE_ROOM_WS_URL`; deploy.
3. **Smoke** — open the Netlify URL → online / find match → confirm WebSocket connects (browser devtools → Network → WS).

Protocol or server changes: **Fly first**, then **Netlify**. Client-only UI: Netlify alone is enough.
