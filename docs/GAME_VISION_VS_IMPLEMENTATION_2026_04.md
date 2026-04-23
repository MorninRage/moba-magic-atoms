# Game vision vs implementation — honest status (2026-04-21)

**Purpose:** Single place for “what IDLE-CRAFT is supposed to be” vs “what players see today,” especially when comparing **legacy** main-thread `CharacterScenePreview` to the **opt-in** worker path (`?worker=1` + `CharacterSceneHost` + `renderWorker`). **Default (2026-04-22+):** most players are on **legacy**; use **`?worker=1`** to test worker behavior. **Flags / default policy:** [WORKER_VS_LEGACY_PATH.md](WORKER_VS_LEGACY_PATH.md). Use this doc when triaging “preload got slower,” “sky/night is wrong,” “camera feels off in lock mode,” or “pieces of the world vanished.”

**Canonical product pillars:** `PLAN.md` §1, `GAME_MASTER.md` §1–3. **Worker checklist:** `docs/WORKER_MIGRATION_PHASE_3X.md`. **Architecture:** `docs/WORKER_ARCHITECTURE.md`.

---

## 1. What the game is supposed to be (stable intent)

| Area | Intent |
|------|--------|
| **Core loop** | Idle crafting, deck unlocks, gather clips, PvE battle, survival vitals, character dock with page-aware gear and poses (`PLAN.md` §1–2). |
| **3D dock** | Three.js procedural hero, terrain, forest backdrop, water, **time-of-day sky** (sun/moon, fog, night grade, god-rays), post-processing — readable as a living place, not a gray box. |
| **Awakened mode** | Free roam + combat + building; camera modes: **orbit / third-person** with wheel zoom and **pointer-lock FPS**; world systems (harvest, mobs, projectiles, mushrooms, cabin pieces) feel like one coherent scene. |
| **Multiplayer** | Lobby + Fly rooms + optional co-op presence; **full LPCA animation sync is not shipped** (`PLAN.md` Phase 6b). Worker host does **not** yet mirror all preview-only presence APIs. |

Narrative cutscenes exist on disk but **boot integration was removed** 2026-04-22 to cut weight on first load (`docs/SESSION_2026_04_22_CUTSCENE_REMOVAL_AND_BOOT_TIGHTENING.md`). Lore in `LORE.md` is unchanged.

---

## 2. What is implemented today (high level)

| Area | Status |
|------|--------|
| **Default (no `?worker=1`)** | **Legacy** main-thread dock — full `CharacterScenePreview` (dream/gather/battle expressiveness). |
| **`?worker=1` + capable** | Worker-owned WebGL + scene loop; main thread: DOM, `GameStore`, audio, input forwarders, overlays. See gaps below — dream/gather still incomplete on worker. |
| **Dock construction on worker** | `IdleCraftDockEnvironment`, skydome bootstrap, terrain/water, forest phases, hero LPCA, post stack, night-grade pass — **wired in code** (`bootstrapDockSceneSlice.ts`, `characterSceneController.ts`). |
| **Awakened locomotion** | `WorkerAwakenedLocomotion` integrates avatar + camera from SAB; collision, mobs, projectiles, harvest, mushrooms have substantial worker parity work behind them. |
| **Pointer lock / Q modes** | Main forwards lock + mouse deltas; worker applies FPS vs orbit; dock orbit yaw/pitch live in `SharedRenderState` for readback. **Third-person *framing* still differs from legacy** (see §4). |
| **Wheel zoom** | Worker maintains `userCameraZoom` / target, applies to third-person distance and FOV; `syncSharedRenderState` publishes zoom via `setCameraState` (SAB). |
| **Shadow `CharacterScenePreview`** | Still built on main for **gameplay handles** and extended preload attach until **Phase 3.x-C** removes it (`dockPreload.ts`). Not “finished” — intentional interim cost. |

---

## 3. Known gaps (player-visible or architectural)

### 3.1 Shadow path + longer preload

**Not done:** Retire the parallel **main-thread** `CharacterScenePreview` used as a “shadow” while the worker shows the real canvas. Until 3.x-C:

- The capable path may pay for **worker GL init + full dock** *and* a **hidden preview** that exists so `dockExtendedPreload` / gameplay attach can reuse the same code paths as legacy.
- Parallelizing host `create` + shadow `create` **reduces** wall-clock vs strict sequencing but does **not** remove the second foundation; total work can still feel “~10×” worse than a minimal title if you compare to an older build that skipped worker bootstrap or shadow.

**Doc:** `LEARNINGS.md` → *Worker preload felt slower*; `WORKER_MIGRATION_PHASE_3X.md` Step 3 / Wave 3.

### 3.2 Sky, night, sun/moon “missing” or flat

**Code claims parity** (same environment module + `dockEnvironment.update(dt, project, camera)` each frame). If the **visible** result is wrong (no night sky, no sun/moon read, flat fog):

1. Compare **legacy** (no `worker` param or `?worker=0`) vs **`?worker=1`** on the same machine/tier — isolates worker vs global regression.
2. Check **graphics tier** (`graphicsTier.ts`) — low tiers may strip or simplify passes.
3. Verify **project/time state** reaches the worker (`empireProject` / clock fields) the same as legacy preview.
4. Confirm **night-grade + exposure** uniforms track `getNightMix()` / moon illum — if stuck at day mix, lighting matches “always noon.”

Treat as an **open investigation** until a session traces uniforms frame-by-frame on both paths.

### 3.3 “Pieces missing” in the world

Common causes (not mutually exclusive):

- **Worker attach set ≠ full legacy attach** — some decor/gather/craft slices still main-only or behind flags.
- **Graphics tier** culling meshes or LOD.
- **Shadow preview** holds some state while the **visible** worker scene is authoritative — desync can look like “missing” objects if comparing to memory of the old single preview.
- **Extended preload** timing — objects appearing late if attach order differs.

File a repro with `?worker=0` comparison and tier label.

### 3.4 Camera “off” in awakening / lock mode

**Root cause (technical):** Legacy solo framing uses **`idleCraftDockCameraCompass.ts`** (`DOCK_SOLO_CAM_OFFSET_*`, shoulder offset, terrain floor clamp, spherical yaw/pitch with user zoom) inside **`CharacterScenePreview.applyCameraFraming`**. Worker third-person in **`workerAwakenedLocomotion.ts`** still uses **hardcoded** `CAM_DIST = 4.25`, `CAM_HEIGHT = 1.35`, `CAM_LOOK_AT_Y = 1.05` and a simplified behind-avatar rig — **not** the same math as `applyCameraFraming`.

Pointer-lock **FPS** pitch clamps also differ slightly between `cameraLockController.ts` and locomotion (`ORBIT_PITCH_*` vs locomotion max pitch in locked branch). Aligning constants and sharing a single framing helper (or porting compass offsets into the worker) is **open work**.

### 3.5 Audio / VFX / gather SAB stubs

- **Step 8:** Many footstep/combat sounds still want full `audioSfx` routing (`WORKER_MIGRATION_PHASE_3X.md`).
- **Gather f32 triple** in SAB may still be stubbed where worker does not yet drive gather clips — HUD/readback edge cases.

---

## 4. Git / legacy reference for “correct” third-person

For **solo dock** camera offsets and look-at chest bias, treat these as authoritative until shared with the worker:

- `src/world/idleCraftDockCameraCompass.ts` — `DOCK_SOLO_CAM_OFFSET_X/Y/Z`, framing pan, zoom coupling.
- `src/visual/characterScenePreview.ts` — `applyCameraFraming`, `refreshSoloDockFramingFromAvatar`.

Worker should converge on these numbers (or an extracted shared module) so lock/orbit **feel** matches **legacy** (no `?worker=1`).

---

## 5. What to update when parity moves

When shadow is dropped, sky investigation closes, or camera math is unified:

1. Check boxes in `docs/WORKER_MIGRATION_PHASE_3X.md`.
2. Short entry in `LEARNINGS.md`.
3. Trim or rewrite §3 in **this** file so it stays honest.

---

*End. **URL flags and product default (legacy vs `?worker=1`):** `docs/WORKER_VS_LEGACY_PATH.md`. For multiplayer-only gaps, see `docs/SESSION_2026_04_21_MULTIPLAYER_AVATAR_AND_AWAKENED_PRESENCE.md`.*
