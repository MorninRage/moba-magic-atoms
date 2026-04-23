# Worker migration — Phase 3.x implementation plan (ordered)

## Scope (read first)

**This checklist is the solo worker dock migration:** the worker path is **opt-in** (`?worker=1` on capable browsers; default is **legacy** `CharacterScenePreview` — see [WORKER_VS_LEGACY_PATH.md](WORKER_VS_LEGACY_PATH.md)). When enabled, it uses `SharedArrayBuffer` + cross-origin isolation, with main-thread `GameStore`, DOM UI, and audio. Success here means **instant-feeling preload/enter** and **awakened gameplay parity** on the worker canvas — not lobby, presence, or multiplayer.

**Out of scope for Phase 3.x milestones:** moving `multiplayerAvatarStage`, `syncOnlinePresence`, or co-op rendering into `CharacterSceneHost` / the worker. Track those under the [multiplayer / presence session note](SESSION_2026_04_21_MULTIPLAYER_AVATAR_AND_AWAKENED_PRESENCE.md); **do not** block Step 10–11 here on that work.

---

This doc is the **actionable checklist** after the scaffold (`src/worker/*`, `CharacterSceneHost`, COOP/COEP, SAB). **Default product behavior:** [`CharacterScenePreview`](../src/visual/characterScenePreview.ts) on the main thread. The worker path runs only when **`?worker=1`** and the [capability gate](../src/worker/capabilityGate.ts) passes; `?worker=0` blocks the worker; if the browser cannot allocate SAB / isolation, the app stays on legacy.

**Rule:** complete steps in order; use **no flag** (legacy) or `?worker=0` / `?dockGame=0` to debug legacy paths; use **`?worker=1`** to test worker. Step 10 is parity + product gates for the **opt-in** worker path (and a possible future “ship worker as default” decision — not the current product default as of 2026-04-22).

---

## Status — Phase 3.x (Apr 2026)

**Shipped (solo path):**

- **Opt-in worker dock** — `isWorkerDockPreviewEnabled()` requires **`?worker=1`** and `isWorkerRenderCapable()`; `?worker=0` disables ([`capabilityGate.ts`](../src/worker/capabilityGate.ts)). **Policy doc:** [WORKER_VS_LEGACY_PATH.md](WORKER_VS_LEGACY_PATH.md).
- **Title:** `CharacterSceneHost` + worker render loop; parallel `mainThreadGamePreview` gets the **single** extended preload (`dockPreload.ts`).
- **Consume (`?dockGame` default):** retains host in `mountApp`, reparents worker canvas to the shell, parks shadow `CharacterScenePreview` off-screen for gameplay handles only (`consumeIdleCraftDockPreload`).
- **Awakened:** worker `WorkerAwakenedLocomotion` reads SAB input; mobs/projectiles + mob authority bridge; main proxies mobs when host is active; camera lock + damage floaters + hit blood hooks wired toward worker canvas.
- **Escape hatch:** `?dockGame=0` → legacy consume (dispose host, visible dock = main-thread preview).

**Still open (same checklist, not multiplayer):** single-scene / drop-shadow removal (**Wave 3 / 3.x-C** — main-thread shadow preview still built for handles; major preload cost), footstep + combat SFX via `workerAudioRouter` (**Step 8**), **gather f32 triple** in SAB until worker drives gather clips, **awakened camera framing parity** (worker third-person still uses simplified rig vs `idleCraftDockCameraCompass` + `applyCameraFraming`; see `docs/GAME_VISION_VS_IMPLEMENTATION_2026_04.md` §3.4), **sky / time-of-day visual parity** if reports differ from legacy (investigation checklist in same doc §3.2), VFX parity (e.g. hit blood), strict incapable-browser UX (**Step 10**), verification pass (**Step 11**). See steps below.

**Reality snapshot:** [GAME_VISION_VS_IMPLEMENTATION_2026_04.md](GAME_VISION_VS_IMPLEMENTATION_2026_04.md).

---

## Step 1 — Worker-safe WebGL bootstrap

- [x] Extend [`createIdleWebGLRenderer.ts`](../src/engine/createIdleWebGLRenderer.ts) so `canvas` is `HTMLCanvasElement | OffscreenCanvas` (Three.js accepts both).
- [x] In [`CharacterSceneController`](../src/worker/characterSceneController.ts), add `initWebGL()` → `createRendererAsync({ canvas })`, `setSize`, tone/clear defaults, minimal lighting / `scene.background`.
- [x] In [`renderWorker.ts`](../src/worker/renderWorker.ts), **`await initWebGL()` before `postMessage({ type: 'ready' })`**; call `start()` only after GL is up. If `runHeadless`, skip GL + rAF (parity with legacy preload flag).

## Step 2 — Resize parity

- [x] On `resize` messages, update `camera.aspect`, `renderer.setSize(canvas.width, canvas.height, false)` when renderer exists.

## Step 3 — Dock preload + consume

- [x] Add `isWorkerDockPreviewEnabled()` in [`capabilityGate.ts`](../src/worker/capabilityGate.ts): requires **`?worker=1`** and capability; `?worker=0` forces off (2026-04-22: default is legacy, worker opt-in).
- [x] Add `isWorkerDockGameEnabled()`: preview on and `?dockGame !== '0'` (retain host by default).
- [x] In [`dockPreload.ts`](../src/engine/dockPreload.ts), when preview enabled: Phase 1 via `CharacterSceneHost` (`CharacterDockPreview` union + `fetchEmpireProject` + worker tier map).
- [x] **`DockPreviewFacade` scaffold** — [`dockPreviewFacade.ts`](../src/engine/dockPreviewFacade.ts): type alias + `tryDockPreviewFacade` (`CharacterScenePreview` only). [`startDockExtendedPreload`](../src/engine/dockExtendedPreload.ts) accepts `CharacterScenePreview | CharacterSceneHost`; returns **`null`** immediately for the host.
- [x] **Parallel main-thread preview** — Worker title path builds `mainThreadGamePreview` for extended preload only; title display uses `CharacterSceneHost`. **Single extended attach** on that preview (not duplicated on the worker title scene). Host + preview `create()` in parallel (~max wall-clock).
- [x] **Retain host:** When dock game is enabled, [`consumeIdleCraftDockPreload`](../src/engine/dockPreload.ts) keeps `CharacterSceneHost` as the visible 3D view and parks the shadow preview for handles.
- [x] **Legacy consume:** `?dockGame=0` disposes the host and reparents main-thread preview as the visible dock (debug / fallback).
- [ ] **Phase 3.x-C:** Drop the shadow `CharacterScenePreview` entirely once a single worker-owned scene + handle surface is enough (see **§ Full migration**).

---

## Full migration — recommended waves (best risk/performance order)

**Goal:** One worker-owned dock scene in-game, main thread for DOM/audio/store only. Work in **vertical slices** with a **test gate** after each wave so perf and behavior stay measurable.

### Wave 0 — Prerequisites (short, non-optional)

Do this **before** treating mobs/projectiles as “done” on the worker; skipping it causes desync and double simulation.

1. **Worker consumes SAB input** for awakened movement (**Step 7** — awakened free roam shipped via `WorkerAwakenedLocomotion`; finish wheel zoom / title-dock gaps if any): avatar + camera driven in `CharacterSceneController.update` from keys / mouse / pointer-lock, aligned with main-thread free roam.
2. **Worker `collisionWorld` is authoritative** for the player footprint and static layers that mobs/projectiles already use on main (reuse the same attach sequence as [`dockGameplayAttachShared`](../src/engine/dockGameplayAttachShared.ts) on the worker scene — `attachGameplayLayers` already exists; wire **one** world, not main+worker duplicates).
3. **Store mutations from combat** stay on main: use `postMessage` (batched or event-shaped) for loot, HP, death, quest flags — never `SharedArrayBuffer` for complex state.

### Wave 1 — Mobs + projectiles first (your requested slice)

**Why this order:** Projectiles depend on **mobs** (`setMobs`), **collisionWorld**, and **terrain height**; both depend on a single scene + collision source of truth.

| Order | System | Notes |
|-------|--------|--------|
| 1a | **Awakened mobs** (`attachAwakenedMobs` / LPCA update loop) | Move spawn/update/render to worker; bridge wave spawns + store-driven clears from main. |
| 1b | **Magic projectiles** (`attachMagicProjectiles`) | Worker scene + worker collision; `onStaticHit` / mob hits → main for game rules + VFX spawn requests if needed. |
| 1c | **Combat glue that assumes main `scene`/`camera`** | `attachAwakenedCombat` pieces that raycast or attach meshes — either move with projectiles or thin RPC to worker. |

**Test gate (stop here until green):**

- Manual or automated: awakened entry, spawn wave, melee + magic kill, projectile vs static + vs mob, death cleanup, no duplicate mob meshes on main.
- Perf: one WebGL context in-game, main-thread time slice stable during combat (profile before/after).

### Wave 2 — Interaction + world systems

| Area | Examples |
|------|-----------|
| Lock-on | Reticle mesh in worker; optional SAB for screen hint |
| Defensive ward / bouncy mushrooms | Same pattern: worker scene + collision already there |
| Dock forest harvestables + free-roam harvest | Heavier store coupling; do after combat slice is stable |
| Cabin / craft placement + build mode | Ghost previews and grid snap; many main-thread UX assumptions |

### Wave 3 — Polish + single scene

- Footstep / combat SFX (**Step 8**), interaction budget flags if needed (**Step 9**).
- Retire parallel `mainThreadGamePreview` path: `consume` keeps host, `mountApp` uses `CharacterSceneHost` only (today: shadow preview still holds extended attach; remove when safe).
- **Step 10** — strict incapable-browser UX + trim legacy branches when parity checklist passes (if product later makes worker the default, revisit escape hatches).

### What “full migration” means at the end

- **In-game:** `CharacterSceneHost` + worker render loop; **no** second full `CharacterScenePreview` for dock 3D.
- **Main:** UI, audio, net, store, multiplayer carve-outs per `WORKER_ARCHITECTURE.md`.

## Step 4 — Scene construction slices (same order as legacy `create`)

1. [x] Project JSON parse + empire config in worker (`initWebGL(projectJson)` → `bootstrapDockEnvironmentAndSky`).
2. [x] `IdleCraftDockEnvironment` + procedural skydome + fog + key/ambient/fill + IBL + god-rays + per-frame `dockEnvironment.update`.
3. [x] Terrain disk — `buildTerrainGridGeometry` + trippy vertex bake (`trippyGroundBake.sync`) + skirt + creek ribbon water via `registerWater` (`attachWorkerDockTerrainWaterSlice`).
4. [x] Forest backdrop — `scatterWorldForestStrata` + trees / understory / merges + night magic (`attachDockForestBackdropForestPhases` after terrain/water; tickers + disposers wired in worker `update` / `dispose`).
5. [x] Dock hero LPCA — `buildDockHeroLpca` + default vanguard preset + dock spawn + solo camera + staff orb VFX (`attachWorkerDockHeroLpcaSlice`). **Remaining (3.x-B):** equipment attachments, gather rig, interaction props in worker.
6. [x] Post-processing stack (`PostProcessingStack` / composer) + night-grade pass + `applyDockRendererDisplay` / `applyDockPostProcessing` message handlers; per-frame `postProcessing.render()` when enabled.
7. [x] GPU warm / compile passes — worker `deferWorkerGpuWarm` → background `schedulePostTaskCancellable` → `WebGLRenderer.compile` + post stack or direct render (low = one pass; other tiers = two spaced passes; no craft/torch LPCA warm until those meshes exist in worker).

After each slice: verify with **`?worker=1`**; compare against **legacy** (no flag or `?worker=0`).

## Step 5 — SharedRenderState: real per-frame data

- [x] Worker `update()` writes avatar XYZ, camera yaw/pitch/forward XZ, staff tip (`vanguardWizardStaffRoot.localToWorld(0, 1.103, 0)`), water bank (`waterGatherBankXZ`), tone mapping exposure, and gameplay flags (`AIRBORNE` / `CAMERA_LOCKED` / `AWAKENED`) from scene + message mirrors. **`CAMERA_ZOOM`:** `syncSharedRenderState` publishes `userCameraZoom` via `setCameraState` (wheel deltas update targets in `CharacterSceneController`). **Gather f32 triple** still stubbed (`0, 1000, 200`) until worker plays gather clips.
- [ ] Optional dev mode: compare a subset to legacy when both run.

## Step 6 — Main-thread readers

- [x] **Damage floaters** — `mountApp` uses `getMainThreadActiveDockSharedState()` + `fillPerspectiveCameraFromSharedState` when a worker dock `WorkerBridge` is registered; otherwise `scenePreview.camera`. See `src/worker/dockSharedRenderReadback.ts`.
- [x] **Magical reticle (center HUD)** — DOM/SVG at screen center; **no camera / SAB read required** for the default crosshair.
- [ ] **Lock-on / combat helpers** — confirm any remaining paths still assume main-thread `scenePreview` as the **rendering** camera vs shadow-only preview; tighten as shadow’s role shrinks.
- [ ] **Explicit `host.sharedState` throughout `mountApp`** — optional cleanup as shadow duplication is removed (**3.x-C**).

## Step 7 — Input (finish)

- [x] **Main thread:** `attachWorkerInputForwarders` integrated into [`CharacterSceneHost`](../src/visual/characterSceneHost.ts) via `attachWindowKeyboardMouseForwarders: true` (used from [`dockPreload.ts`](../src/engine/dockPreload.ts) worker path). Pointer lock state + mouse deltas + key bitmask → SAB; detached in `host.dispose()`.
- [x] **Worker (awakened free roam):** `CharacterSceneController.update` runs [`WorkerAwakenedLocomotion`](../src/worker/workerAwakenedLocomotion.ts) from `SharedRenderState` when awakened roam is active — avatar + camera integrate on the worker; main `freeRoamControls` does not double-drive on that path.
- [ ] **Worker (dock title / non-awakened):** any remaining camera/movement that should mirror legacy title dock (if behavior still differs).
- [x] **Wheel zoom:** worker applies zoom to third-person distance / FOV; `syncSharedRenderState` writes live zoom into SAB. **Remaining:** title-dock (non-awakened) camera if behavior still differs from legacy.

## Step 8 — Audio (finish)

- [ ] Replace in-loop `playFootstepSound` etc. with `controller.emit({ type: 'audioSfx', ... })`; route via [`workerAudioRouter.ts`](../src/audio/workerAudioRouter.ts).

## Step 9 — Dock interaction budget + globals

- [x] **Current code:** worker bundle does **not** import [`idleCraftDockInteractionBudget`](../src/world/idleCraftDockInteractionBudget.ts). **No cross-thread read today.** Revisit when worker runs gather/craft travel clips (mirror or postMessage flags if needed).

## Step 10 — Strict gate + parity cleanup

**Solo scope only** — do not wait on lobby / multiplayer for this step.

- [x] `isWorkerDockPreviewEnabled` / `isWorkerDockGameEnabled` wired — **opt-in** `?worker=1` (2026-04-22); `?worker=0` / `?dockGame=0` for legacy / debugging. See [WORKER_VS_LEGACY_PATH.md](WORKER_VS_LEGACY_PATH.md).
- [ ] When parity proven: remove dead branches only where safe; keep escape hatches for broken environments.
- [ ] Capability fail: blocking “update browser” page (per original product decision), if still required.
- [ ] VFX / edge-case parity (e.g. hit blood, mushroom bounce audio parity listed in `WorkerAwakenedLocomotion` header).

## Step 11 — Verification + docs

- [ ] `?perf=audit`, save/load, audio, pointer lock on **worker** solo path (`?worker=1`) (extend checklist when Step 10 parity items close).
- [ ] Lobby / online smoke remains **main-thread** until multiplayer work explicitly targets host; not a Phase 3.x gate.
- [x] Docs updated for **Phase 3.x MVP** boundary (`WORKER_MIGRATION_PHASE_3X.md`, `PLAN.md` Phase 9, `WORKER_ARCHITECTURE.md` status).
- [ ] Update `LEARNINGS.md` and `WORKER_ARCHITECTURE.md` with **“parity achieved”** only after 3.x-B + Step 10.

---

## Related files

| Doc | Role |
|-----|------|
| [WORKER_VS_LEGACY_PATH.md](WORKER_VS_LEGACY_PATH.md) | **Default (legacy vs `?worker=1`)**, URL flags, runtime cost, 2026-04-22 product change |
| [WORKER_ARCHITECTURE.md](WORKER_ARCHITECTURE.md) | Architecture, SAB layout, carve-outs |
| [SESSION_2026_04_22_OFFSCREEN_CANVAS_SCAFFOLD.md](SESSION_2026_04_22_OFFSCREEN_CANVAS_SCAFFOLD.md) | What the scaffold shipped |
| [SESSION_2026_04_21_MULTIPLAYER_AVATAR_AND_AWAKENED_PRESENCE.md](SESSION_2026_04_21_MULTIPLAYER_AVATAR_AND_AWAKENED_PRESENCE.md) | **Separate product track:** lobby / presence on main today; not required for Phase 3.x solo migration checklist above. |
| [AGENT_CONTEXT.md](../AGENT_CONTEXT.md) §8.1 | High-level module split |
