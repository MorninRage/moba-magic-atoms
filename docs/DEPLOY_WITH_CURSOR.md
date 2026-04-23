# Deploy with Cursor (MOBA — Fly + Netlify)

How to ship updates to the **Fly** room server and **Netlify** static game from **Cursor** (or another agent). **Command reference:** [`docs/MOBA_HOSTING_SETUP.md`](./MOBA_HOSTING_SETUP.md) · [`docs/DEPLOY.md`](./DEPLOY.md).

---

## What lives where

| Target | Code / config | Update command (repo root) |
|--------|----------------|----------------------------|
| **Fly** — WebSocket lobby | `server/room-server.mjs`, `server/Dockerfile`, `server/fly.toml` | `npm run deploy:fly` or `cd server && fly deploy` |
| **Netlify** — browser game | `src/`, `npm run build` → `dist/` | `npm run deploy:netlify` |

Production lobby WSS: **`wss://moba-rooms.fly.dev`** (`netlify.toml`, `.env.production`, `roomHub.ts`, `roomHubBridge.ts`).

---

## One-time setup (you, not the agent)

1. **Fly:** [flyctl](https://fly.io/docs/hands-on/install-flyctl/) → `fly auth login`.
2. **Netlify:** `npm install -g netlify-cli` → `netlify login` → from **`C:\Users\Limin\MOBA`**, confirm `netlify status` shows **moba-magic-atoms** (or run `netlify link` / `netlify sites:create -n moba-magic-atoms -a morninrage` per hosting doc).

---

## What to ask Cursor

- *“Deploy the room server to Fly.”*  
  → From **`C:\Users\Limin\MOBA`**: **`npm run deploy:fly`** (or `cd server && fly deploy`).

- *“Build and deploy the game to Netlify production.”*  
  → **`npm run deploy:netlify`**.

- *“We changed the lobby protocol / `room-server.mjs` — ship everything.”*  
  1. `npm run deploy:fly`  
  2. `npm run deploy:netlify`

Client-only changes: **Netlify** only.

---

## What Cursor can and cannot do

| Can | Cannot |
|-----|--------|
| Run `fly deploy`, `npm run build`, `netlify deploy` in the terminal | Complete OAuth without your browser session |
| Read `fly.toml`, Dockerfile, `netlify.toml` | Choose Fly app names / Netlify slugs without you (it can run the commands you approve) |

**Health:** `Invoke-WebRequest -Uri "https://moba-rooms.fly.dev/health" -UseBasicParsing` → content **`ok`**.

---

## Quick verify after deploy

1. **Fly:** health URL above → `ok`.
2. **Netlify:** **https://moba-magic-atoms.netlify.app** → online → lobby / queue connects (cold start may take a few seconds).

---

## Scripts (`package.json`)

- **`npm run deploy:fly`** — `cd server && fly deploy`
- **`npm run deploy:netlify`** — `npm run build && netlify deploy --dir=dist --prod`
