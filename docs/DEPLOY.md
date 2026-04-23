# Deploy: MOBA — Netlify (game) + Fly.io (lobby WebSocket)

**Authoritative MOBA runbook (URLs + copy-paste commands):** [`docs/MOBA_HOSTING_SETUP.md`](./MOBA_HOSTING_SETUP.md).

**Using Cursor / an AI agent?** [`docs/DEPLOY_WITH_CURSOR.md`](./DEPLOY_WITH_CURSOR.md).

**IDLE-CRAFT** (sibling project in `idle deck`) uses different hosts (`idle-craft-rooms.fly.dev`, `idle-craft1.netlify.app`, etc.). This file describes **only** the MOBA repo.

## Quick reference

| What | Where | Command / URL |
|------|--------|----------------|
| Room server | Fly app **`moba-rooms`** | `npm run deploy:fly` or `cd server` → `fly deploy` |
| Health | Same app | `https://moba-rooms.fly.dev/health` → `ok` |
| Game static | Netlify **`moba-magic-atoms`** | `npm run deploy:netlify` |
| Production URL | — | **https://moba-magic-atoms.netlify.app** |
| Prod lobby WSS | `netlify.toml` + `.env.production` + client fallback | **`wss://moba-rooms.fly.dev`** |

**Order when you ship protocol or server changes:** deploy **Fly** first, then **Netlify**. Client-only UI: Netlify alone.

## Architecture

| Piece | Role | Host |
|--------|------|------|
| `npm run build` → `dist/` | Game client | Netlify (static) |
| `server/room-server.mjs` | Lobby **protocol v4** (rooms, phases, matchmaking, chat/voice relay) | Fly (Dockerfile in `server/`) |

- **WebSocket** for lobby: `wss://moba-rooms.fly.dev` in production.

---

## Fly.io (room server)

### One-time (already provisioned)

- **`server/fly.toml`** — `app = "moba-rooms"`.
- **`server/Dockerfile`** — Node 22 Alpine, `PORT=8080`.

### Every deploy

**PowerShell:**

```powershell
cd "C:\Users\Limin\MOBA\server"
fly deploy
```

**bash:**

```bash
cd server
fly deploy
```

### Verify

**PowerShell** (preferred on Windows):

```powershell
Invoke-WebRequest -Uri "https://moba-rooms.fly.dev/health" -UseBasicParsing | Select-Object -ExpandProperty Content
```

Optional: `fly status -a moba-rooms`, `fly logs -a moba-rooms`.

### Secrets

```powershell
fly secrets set MOBA_3V3_QUEUE_SIZE=6 -a moba-rooms
```

---

## Netlify (game)

1. Build: `npm run build` (root) — `VITE_ROOM_WS_URL` from `netlify.toml`.
2. Deploy: **`dist/`** to site **moba-magic-atoms**.

### Netlify CLI

**Production:**

```powershell
cd "C:\Users\Limin\MOBA"
npm run deploy:netlify
```

**Check link:**

```powershell
netlify status
```

**Preview:**

```powershell
npm run build
netlify deploy --dir=dist
```

### After Fly hostname or env changes

Update **`netlify.toml`** `[build.environment] VITE_ROOM_WS_URL`, **`.env.production`**, and **`PROD_LOBBY_WSS`** in `src/net/roomHub.ts` and `roomHubBridge.ts`, then redeploy Netlify.

---

## Local dev

| Terminal | Command |
|----------|---------|
| Game | `npm run dev` → http://localhost:3000 |
| Lobby | `npm run rooms` or `cd server && npm start` → **ws://localhost:3334** |

**`.env.local`:** `VITE_ROOM_WS_URL=ws://localhost:3334` (optional).

---

## Go-live checklist

1. **Fly:** `cd server` → `fly deploy` → `/health` → `ok`.
2. **Netlify:** `npm run deploy:netlify` (or push with CI).
3. **Smoke:** Open **https://moba-magic-atoms.netlify.app** → online → lobby / queue → WS connects.

---

## References

- [Netlify env + build](https://docs.netlify.com/environment-variables/overview/)
- [Fly deploy](https://fly.io/docs/flyctl/deploy/)
