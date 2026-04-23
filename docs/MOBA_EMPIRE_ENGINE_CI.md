# EmpireEngine in MOBA — parity with IDLE-CRAFT and CI/Netlify

## 0. Plain answer: **yes, EmpireEngine belongs in the “new” MOBA version**

MOBA is **supposed** to ship with the same **EmpireEngine** library IDLE-CRAFT uses (LPC, materials, renderer helpers, etc.). Nothing says “don’t put EmpireEngine in the new game.”

What **was** confusing is only **`package.json` paths**:

- `"empire-engine": "file:../EmpireEngine"` means: “install the engine from a folder **sitting next to** the game directory.”
- On your computer, that’s often `...\MOBA` and `...\EmpireEngine` as **siblings** — works locally.
- **Netlify** only clones **one** git repository. If that repo contains **only** the game files and **no** `EmpireEngine` folder beside them, `../EmpireEngine` **does not exist** in the build container → `npm install` fails.

**So you absolutely place EmpireEngine in the MOBA world** — by choosing **one** of these:

1. **Same repo, two folders** (e.g. `EmpireEngine/` + `moba-game/`) — still **one new git repo**, engine included.  
2. **Submodule** `vendor/EmpireEngine` — still **one new git repo**, engine pinned.  
3. **`git+https://...` dependency** — engine fetched by npm during install.

IDLE-CRAFT’s repo and deploy **stay separate**; you are **not** stealing its Fly/Netlify/Git. You’re only **copying the same engine source** (or the same version) into **MOBA’s** repo so MOBA builds on its own.

---

The MOBA fork is meant to keep the **same engine stack** as IDLE-CRAFT: runtime imports from **`empire-engine`**, the same **`three` dedupe** rules, and the same **`project.json` → forest/terrain** pipeline. Below: **what is wired today** and **repo layouts** that work on Netlify.

---

## 1. What the game actually depends on

| Piece | Role | Required for `npm run build`? |
|-------|------|------------------------------|
| **`empire-engine` npm package** | Resolved from `package.json` → `import 'empire-engine/...'` (e.g. [`idleCraftEngine.ts`](../src/engine/idleCraftEngine.ts), [`characterScenePreview.ts`](../src/visual/characterScenePreview.ts)). Bundled into the Vite output (`manualChunks` → `empire-engine`). | **Yes.** |
| **`vite.config.ts` `resolve.dedupe: ['three']`** | Forces a **single** `three` instance so linked `empire-engine` does not pull a second copy (breaks `instanceof` / materials). | **Yes** (keep as-is). |
| **`EmpireEditor` path** | `alias: { '@editor': resolve(__dirname, '../EmpireEditor/src') }` — used if something imports `@editor`. **MOBA `src/` has no `@editor` imports** today. | **No** for Netlify-only game build. |
| **`project.json`, `scenes/`, `recipes/`** | Copied to `dist/` in Vite `closeBundle`; terrain/forest read `project.json` at runtime. | **Yes** (ship with repo). |

**Correction:** The shipped **web bundle absolutely includes EmpireEngine code** — it is not optional for production. Any README line suggesting otherwise is wrong.

---

## 2. Why `file:../EmpireEngine` breaks on Netlify (only-MOBA repo)

Netlify clones **one** repository. If the repo root is **only** the game:

- `npm install` looks for **`../EmpireEngine`** **outside** the clone → **missing** → install or build fails.

On your machine, `file:../EmpireEngine` works because you keep **MOBA** and **EmpireEngine** as sibling folders — same as IDLE-CRAFT.

**Goal:** Reproduce that **sibling layout inside the CI workspace**, or replace `file:` with a **fetchable** dependency.

---

## 3. Recommended layouts (pick one)

### Option A — **Monorepo** (single new Git repo, closest to “everything like before”)

Put **both** trees in one repository so **`../EmpireEngine` from the game folder is inside the clone**:

```text
moba-platform/                 # one git repo
  EmpireEngine/                # full engine (subtree copy or submodule)
  moba-game/                   # this game (current MOBA root files live here)
    package.json               # "empire-engine": "file:../EmpireEngine"
    vite.config.ts
    ...
  netlify.toml                 # base = moba-game  OR  command cd moba-game && npm ci && npm run build
```

- **Netlify:** Set **Base directory** to `moba-game` (or run `cd moba-game && …` in build command). The clone still contains `EmpireEngine` at `moba-game/../EmpireEngine`.
- **Pros:** Same `file:` link as today; one PR can change engine + game; matches IDLE-CRAFT disk layout mentally.
- **Cons:** Larger repo; engine updates merge into MOBA history (or use submodule inside monorepo).

### Option B — **Git submodule** (MOBA-only repo + engine as submodule)

```text
moba-game/                     # git repo root (what you push to GitHub)
  vendor/
    EmpireEngine/              # git submodule → your EmpireEngine remote
  package.json                 # "empire-engine": "file:./vendor/EmpireEngine"
```

- After clone: `git submodule update --init --recursive` (Netlify: enable submodule checkout, or add to build command).
- **Pros:** MOBA repo stays “game-first”; engine revision pinned per commit.
- **Cons:** Submodule UX; must update submodule pointer when bumping engine.

### Option C — **`package.json` git dependency** (no submodule folder in tree)

```json
"empire-engine": "git+https://github.com/YOUR_ORG/EmpireEngine.git#COMMIT_OR_TAG"
```

- Works on Netlify if the repo is **public** or you use an **install token** (GitHub PAT in Netlify env + `.npmrc` for private deps).
- **Pros:** Simple clone; no monorepo.
- **Cons:** Must **publish/tag** EmpireEngine on GitHub; lock to a **commit SHA** for reproducible builds; `npm install` may be slower.

### Option D — **Netlify build: clone engine beside game** (quick fix, less elegant)

Keep MOBA as the only tracked repo; in **`netlify.toml`**:

```toml
[build]
  command = "git clone --depth 1 https://github.com/YOUR_ORG/EmpireEngine.git ../EmpireEngine && npm ci && npm run build"
```

- **Pros:** No monorepo migration day one.
- **Cons:** Two sources of truth; branch/tag must be explicit (`clone -b v1.2.3`); private engine needs credentials in env.

---

## 4. Keeping behavior identical to IDLE-CRAFT

1. **Same `empire-engine` revision** — Whatever IDLE-CRAFT ships, MOBA should pin the **same commit/tag** until you intentionally fork engine behavior.
2. **Same `three` version** — MOBA `package.json` should match IDLE-CRAFT’s `three` range; keep **`dedupe: ['three']`** in `vite.config.ts`.
3. **Same chunking** — Keep `manualChunks` rule that puts `empire-engine` in its own chunk (already in [`vite.config.ts`](../vite.config.ts)).
4. **`project.json` + hydrology/terrain** — Same format; MOBA already uses [`fetchEmpireProject`](../src/engine/fetchEmpireProject.ts) + [`forestEnvironment`](../src/visual/forestEnvironment.ts).

---

## 5. EmpireEditor (optional)

Local **EmpireEditor** + MCP is **not** required for Netlify. The Vite alias `@editor` points at `../EmpireEditor/src`; if you open MOBA alone, that path may 404 **only if** something imports `@editor` (currently **no** imports under `src/`). If you add editor-only tooling later, either:

- add **EmpireEditor** as another submodule/monorepo sibling, or  
- guard editor imports behind dev-only entrypoints.

---

## 6. Checklist when creating the **new** MOBA Git repo

- [ ] Choose **Option A, B, C, or D** above; update **`package.json`** `empire-engine` field accordingly.
- [ ] Run **`npm install`** in a **clean** directory (no sibling folder) and confirm **`npm run build`** passes.
- [ ] Regenerate **`package-lock.json`** after changing the engine spec; commit it.
- [ ] Netlify: set **Node** version, **build command**, **publish `dist`**, **`VITE_ROOM_WS_URL`**.
- [ ] If using **private** EmpireEngine: configure **Git credentials** for npm/git installs (Netlify docs: build environment + `.npmrc`).

---

## 7. Related docs

- [`MOBA_DEPLOY_REPO_AND_POST_MATCH_FLOW.md`](./MOBA_DEPLOY_REPO_AND_POST_MATCH_FLOW.md) — Netlify/Fly/repo overview (now references this file for engine detail).
- [`GAME_MASTER.md`](../GAME_MASTER.md) (IDLE-CRAFT) — full editor + MCP chain when both editor and game are local.

---

*EmpireEngine is a first-class dependency of the MOBA web build; CI must resolve it the same way your dev machine does.*
