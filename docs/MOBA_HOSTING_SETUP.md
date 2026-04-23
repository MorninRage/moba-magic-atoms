# MOBA hosting: Git, Fly, Netlify

This repo is wired for **MOBA** (Magic Orbiting Brandished Atoms) only. IDLE-CRAFT keeps its own Git / Netlify / Fly stack; do not point this repo at those remotes or sites.

## Implemented production (2026-04-23)

| Piece | Value |
|--------|--------|
| **GitHub** | [https://github.com/MorninRage/moba-magic-atoms](https://github.com/MorninRage/moba-magic-atoms) (`main`) |
| **Netlify** | [https://moba-magic-atoms.netlify.app](https://moba-magic-atoms.netlify.app) — project slug **`moba-magic-atoms`**, team account slug **`morninrage`** |
| **Fly app** | **`moba-rooms`** — [https://moba-rooms.fly.dev](https://moba-rooms.fly.dev) |
| **Lobby WSS** | **`wss://moba-rooms.fly.dev`** (also `PROD_LOBBY_WSS` in `src/net/roomHub.ts` + `roomHubBridge.ts`; build env in `netlify.toml` + `.env.production`) |

**EmpireEngine on CI:** [`MOBA_EMPIRE_ENGINE_CI.md`](./MOBA_EMPIRE_ENGINE_CI.md).

---

## Routine updates (exact commands)

Assume repo root: **`C:\Users\Limin\MOBA`** (adjust path on your machine). Use **PowerShell** on Windows; **bash** variants are noted where different.

### Git — commit and push

```powershell
cd "C:\Users\Limin\MOBA"
git status
git add -A
git commit -m "Describe your change"
git push origin main
```

New branch:

```powershell
git checkout -b feature/your-branch
git push -u origin feature/your-branch
```

**New machine clone:**

```powershell
git clone https://github.com/MorninRage/moba-magic-atoms.git
cd moba-magic-atoms
npm install
```

---

### Fly — redeploy room server

After changing `server/room-server.mjs`, `server/Dockerfile`, or `server/fly.toml`:

```powershell
cd "C:\Users\Limin\MOBA\server"
fly deploy
```

Useful:

```powershell
fly status -a moba-rooms
fly logs -a moba-rooms
```

**Health check** (Windows `curl` may fail on cert revocation; use PowerShell):

```powershell
Invoke-WebRequest -Uri "https://moba-rooms.fly.dev/health" -UseBasicParsing | Select-Object -ExpandProperty Content
```

Expect: **`ok`**.

**Optional secret** (queue batch size; default in code is 6):

```powershell
cd "C:\Users\Limin\MOBA\server"
fly secrets set MOBA_3V3_QUEUE_SIZE=6 -a moba-rooms
```

**If you rename the Fly app:** update `server/fly.toml` `app`, `netlify.toml` and `.env.production` `VITE_ROOM_WS_URL`, and `PROD_LOBBY_WSS` in `src/net/roomHub.ts` and `src/net/roomHubBridge.ts`, then deploy Fly and Netlify again.

Or from repo root (same as `cd server && fly deploy`):

```powershell
cd "C:\Users\Limin\MOBA"
npm run deploy:fly
```

---

### Netlify — ship the static client

**CLI production deploy** (builds locally, uploads `dist/`):

```powershell
cd "C:\Users\Limin\MOBA"
npm run deploy:netlify
```

Equivalent: `npm run build` then `netlify deploy --dir=dist --prod`.

**Check which site is linked:**

```powershell
cd "C:\Users\Limin\MOBA"
netlify status
```

Expect **Current project: moba-magic-atoms** and **Project URL: https://moba-magic-atoms.netlify.app**.

**Preview deploy** (draft URL, not production):

```powershell
cd "C:\Users\Limin\MOBA"
npm run build
netlify deploy --dir=dist
```

**Connect GitHub in Netlify** (auto-build on push): Netlify dashboard → this site → **Site configuration** → **Build & deploy** → **Link repository** → `MorninRage/moba-magic-atoms`, branch `main`, build `npm run build`, publish `dist`. Set **`VITE_ROOM_WS_URL`** = `wss://moba-rooms.fly.dev` under **Environment variables** if you do not rely on `netlify.toml` alone.

**New CLI-only site** (recovery; account slug avoids interactive team picker):

```powershell
cd "C:\Users\Limin\MOBA"
netlify sites:create -n moba-magic-atoms -a morninrage
npm run deploy:netlify
```

---

## Ship order

1. **Fly** — `fly deploy` in `server/` → health `ok`.
2. **Netlify** — `npm run deploy:netlify` (or push if CI is linked).
3. **Smoke** — open [moba-magic-atoms.netlify.app](https://moba-magic-atoms.netlify.app) → online / matchmaking → DevTools → Network → WS to `moba-rooms.fly.dev`.

**Protocol or server changes:** Fly first, then Netlify. **Client-only:** Netlify only.

---

## One-time setup reference (already done for this project)

| Step | Command / action |
|------|------------------|
| GitHub repo | `gh repo create moba-magic-atoms --public --source=. --remote=origin --push` (from repo with initial commit) |
| Fly app | `fly apps create moba-rooms -o personal -y` then `fly deploy` from `server/` |
| Netlify site | `netlify sites:create -n moba-magic-atoms -a morninrage` (links `.netlify/state.json`) |
