# Deploy with Cursor (Fly + Netlify)

This doc explains **how to ship updates** to the **Fly** room server and **Netlify** static game, including what you can ask **Cursor** (or another coding agent) to run for you.

**Full command reference and architecture:** **`docs/DEPLOY.md`** — read that for URLs, health checks, cold-start notes, and checklist order.

---

## What lives where

| Target | Code / config | Typical update command (repo root) |
|--------|----------------|-------------------------------------|
| **Fly** — WebSocket lobby | `server/room-server.mjs`, `server/Dockerfile`, `server/fly.toml` | `npm run deploy:fly` or `cd server && fly deploy` |
| **Netlify** — browser game | Everything under `src/`, `npm run build` → `dist/` | `npm run deploy:netlify` |

Production lobby URL baked into the client: **`wss://idle-craft-rooms.fly.dev`** (`netlify.toml`, `.env.production`). Change those only if the Fly app hostname changes.

---

## One-time setup (you, not the agent)

The agent runs **your** terminal; it cannot complete OAuth in your browser for you.

1. **Fly:** Install [flyctl](https://fly.io/docs/hands-on/install-flyctl/), then `fly auth login` (browser).
2. **Netlify:** `npm install -g netlify-cli`, then `netlify login`, then from the game repo: `netlify link` to the correct site (see `netlify status` for **Site name** / **URL**).

After this, Cursor can run deploy commands that reuse your saved credentials.

---

## What to ask Cursor

Examples:

- *“Deploy the room server to Fly.”*  
  → Agent should run **`npm run deploy:fly`** from **`c:\Users\Limin\idle deck`** (or `cd server && fly deploy`).

- *“Build and deploy the game to Netlify production.”*  
  → Agent should run **`npm run deploy:netlify`** (runs `tsc`, Vite build, then `netlify deploy --dir=dist --prod`).

- *“We changed the lobby protocol / `room-server.mjs` — ship everything.”*  
  → **Fly first**, then **Netlify** (so new JS talks to the new server). Agent order:
 1. `npm run deploy:fly`
  2. `npm run deploy:netlify`

If you **only** changed client UI/TS (no server), **Netlify alone** is enough.

---

## What Cursor can and cannot do

| Can | Cannot |
|-----|--------|
| Run `fly deploy`, `npm run build`, `netlify deploy` in the integrated terminal | Log you into Fly/Netlify without your browser/session |
| Read `fly.toml`, Dockerfile, `netlify.toml`, and confirm URLs | Create a new Fly app for you without `fly launch` / account decisions (it can guide you) |
| Hit **`curl https://idle-craft-rooms.fly.dev/health`** and expect `ok` | Guarantee which Netlify site is linked — **you** run `netlify link` so `deploy:netlify` targets the right project |

---

## Quick verify after deploy

1. **Fly:** `curl https://idle-craft-rooms.fly.dev/health` → `ok`.
2. **Netlify:** Open your production URL → start flow → online mode → lobby should connect (not stuck on “connecting” forever; cold start may take a few seconds).

---

## Scripts (root `package.json`)

- **`npm run deploy:fly`** — `cd server && fly deploy`
- **`npm run deploy:netlify`** — `npm run build && netlify deploy --dir=dist --prod`

---

## Related docs

- **`docs/DEPLOY.md`** — authoritative deploy guide (Netlify site names, checklist, local dev).
- **`GAME_MASTER.md`** §11 — doc index for agents.
