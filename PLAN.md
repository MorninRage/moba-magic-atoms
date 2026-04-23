# IDLE-CRAFT — Project plan & delivery log

**Location:** game root (`idle deck/PLAN.md`).  
**Companion docs:** `GAME_MASTER.md` (systems map), **`vibejam_portal_solo_battle.md`** (jam portal + solo PvE status vs [vibej.am/2026](https://vibej.am/2026)), **`IDLE_CRAFT_CONTEST_AND_FEATURE_PLAN.md`** (full contest + multiplayer roadmap + Part H checklist), `AGENT_CONTEXT.md`, `.agent/00_READ_FIRST.md`.

This document records **what was planned, what shipped, and where it lives in code**. Update it when you finish a major slice of work.

---

## 1. Product pillars (stable)

| Pillar | Summary |
|--------|---------|
| Idle crafting | Deck unlocks, recipes, stations, automation slots, spoilage |
| Survival vitals | Hunger, thirst, HP — shared in world and battle |
| Manual gather | Timed 3D preview clips; loot synced to clip duration |
| PvE battle | Turn-based combat, helpers, gear, permadeath on 0 HP |
| Character dock | Three.js procedural avatar + page-aware equipment |
| Vibe Jam 2026 | Widget, portal exit URL, Portal tab for hub handoff |
| Narrative framing | Cinematic intro cutscenes (`intro_the_curse` + `intro_the_shattering`) **were** wired through the boot graph; **unwired 2026-04-22** to drop ~30 MB of forced video download per page load and ~30-50 s of mandatory playback before first interaction. Files preserved on disk; `LORE.md` arc unchanged. See `docs/SESSION_2026_04_22_CUTSCENE_REMOVAL_AND_BOOT_TIGHTENING.md`. |

---

## 2. Delivered phases (feature checklist)

### Phase 1 — Vibe Jam & deploy

- [x] Vibe Jam widget (`index.html` / official snippet)
- [x] Portal exit: `portal_enter` clip → `vibejam-portal-exit` → hub URL with `ref`, `hp`, etc. (`src/main.ts`, `src/vibeJamPortal.ts`)

### Phase 2 — Gear & poses

- [x] Equipment visibility by page (inventory vs gather vs battle)
- [x] **Combat vs gather visibility** (`showIdleGear`, `hideGearForClip`, `pageContext`): battle shows weapon + shield, not tools; gather idle hides weapon; inventory optional full carry
- [x] **Page-specific poses** (decks / craft / battle); awkward arms fixed; **blends on `setPageContext`** (`characterScenePreview.ts` + `mountApp.ts`)

### Phase 3 — Battle dock & FX

- [x] `syncBattleContext(enemyId)` — procedural PvE enemy (rat, wolf, deserter) from `pveEnemyLPCA.ts`
- [x] Battle clips: `battle_strike`, `battle_cast`, `battle_enemy_strike`
- [x] Combat blood VFX: procedural liquid materials, ground pool, face → shirt → pants → ground cascade, presets for rat / human (`characterScenePreview.ts`)
- [x] Damage floaters, spark on cast; **hit FX**; **enemy / player** strike & death reactions
- [x] Presentation structured so **future server-driven battle events** can drive the same dock visuals (solo complete; multiplayer dispatch TBD)

### Phase 4 — Portal tab

- [x] Portal page in nav; copy explains webring / hub (`mountApp.ts`, `app.css`)
- [x] `portal_enter` animation + plasma VFX where applicable

### Phase 5 — World props / polish

- [x] **Hunt / meat phased clip** (trap → cut → pickup timing); meat visuals
- [x] **Campfire / workbench / structure** hero visuals + **first-use** moments (particles/light); `craftStationDecorLPCA`, etc.

### Phase 6 — Online lobby + Fly

- [x] Fly WebSocket **protocol v2** (`server/room-server.mjs`): rooms, phases, seed, list/create/join, ready/lock/launch, queue stub, chat/voice relay
- [x] Client `roomHub` + `mountOnlineLobby` + `multiplayerAvatarStage`; **fresh expedition** on launch via `GameStore.beginOnlineSession` (room + seed); HUD session chip
- [x] Player-facing start flow copy — **no** npm/localhost instructions (jam link only)
- [x] Lobby teardown **`leaveRoom: false`** on launch — players stay in the active Fly room (WS session) until title return, reset, or permadeath; co-op idle bonus + PvP/deathmatch battle scaling + HUD team/party

### Phase 6b — Online avatar fidelity & awakened co-op presence (2026-04-21)

**Session doc:** [docs/SESSION_2026_04_21_MULTIPLAYER_AVATAR_AND_AWAKENED_PRESENCE.md](docs/SESSION_2026_04_21_MULTIPLAYER_AVATAR_AND_AWAKENED_PRESENCE.md)

- [x] **Lobby carousel** — Six-slot stage uses **`buildLobbyDockHeroFromPreset`** (full `buildDockHeroLpca` + preset palette / build kind), not blocky `buildLobbyMiniFigure` (`multiplayerAvatarStage.ts`, `lobbyDockHeroFromPreset.ts`).
- [x] **Gather mini-ghosts** — Party-nearby ghosts use the same LPCA builder with gather-scale multiplier (`characterScenePreview.ts`).
- [x] **Awakened co-op world peers** — `presence` / `presence_update` carry `realm` + `wx/wy/wz/wyaw`; `room-server.mjs` forwards; `GameStore` holds `RemotePresenceEntry`; `mountApp` throttles sends; `characterScenePreview` renders + **smooths** remote peers in `awakenedCoopPeerRoot`.
- [ ] **Follow-up (not shipped)** — Full **animation / clip** replication over the network; `CharacterSceneHost` parity for `syncOnlinePresence` (multiplayer track — **not** a Phase 9 solo migration gate; worker dock is already default-on for capable browsers).

### Phase 7 — Intro cutscenes & narrative framing

> **2026-04-22 — boot integration UNWIRED.** Re-encoded `.mp4` files + `src/cutscenes/*.ts` modules + the production pipeline (`docs/CUTSCENE_PIPELINE.md` + `docs/CUTSCENE_BUILD_LOG.md`) are all preserved on disk for a clean revert, but `src/main.ts` no longer imports either cutscene module, `index.html` no longer prefetches the .mp4 files, `vite.config.ts` no longer routes them through Workbox runtime cache, and `netlify.toml` no longer applies immutable cache headers to `/cutscenes/*`. Re-enabling is a one-commit revert. Player feedback was that the cutscenes were "too heavy and not working anymore" — removing them dropped ~30 MB of forced download per page load and made room for the click → game critical-path tightening pass in the same session. **The narrative arc in `LORE.md` is unchanged** — Acts 1-3 still anchor on these cutscenes as canonical reference; if a future session re-enables the boot integration, all the lore alignment still holds. See `docs/SESSION_2026_04_22_CUTSCENE_REMOVAL_AND_BOOT_TIGHTENING.md`.

- [x] **`intro_the_curse.mp4`** (~51s, 1080p30, ~12 MB after round 3 re-encode) — Act 1 premise cutscene. Establishes Vanguard / Mira / Witches Guild / dream-prison conceit. Music bed enabled (continues into the title screen). Stored at `public/cutscenes/intro_the_curse.mp4`. **Currently unreferenced from the boot graph.**
- [x] **`intro_the_shattering.mp4`** (~76s, 1080p30, ~17 MB after round 3 re-encode) — Act 1b objective cutscene. Shows the bloodline water-magic in full, the talisman shattering, three witches scattering the shards each with a distinct female voice, ends on the explicit player objective: **RECLAIM THE SHARDS**. **No music bed** (game audio plays under). Real CC0 cackle SFX baked into the mocking witch's line. Stored at `public/cutscenes/intro_the_shattering.mp4`. **Currently unreferenced from the boot graph.**
- [x] **Both cutscenes produced via the zero-cost pipeline** (Pollinations FLUX stills + ComfyUI Depthflow parallax + Piper TTS narration with FFmpeg pitch shift + Remotion composition). Total cost: $0. Pipeline still canonical for any future cutscene production; see `docs/CUTSCENE_PIPELINE.md`.
- [x] **Splash gate** — `src/cutscenes/introSplash.ts` + `.css`. "Press anywhere to begin" overlay captures one user gesture that unlocked autoplay-with-audio for the curse cutscene. **Source preserved; no longer mounted from `main.ts`.**
- [x] **Cutscene player overlay** — `src/cutscenes/introCutscene.ts` + `.css`. Generalized to take `videoSrc` + `ariaLabel`. Skip via Skip button (350 ms grace), Esc, Space, Enter; resolves on `ended` or skip. **Source preserved; no longer mounted from `main.ts`.**
- [~] **Boot integration** — `src/main.ts:bootIntroExperience()` previously ran splash → curse → start flow → enterGame → shattering → mountApp. **Now runs:** scheduleSecondaries → hideInlineBootVeil → schedulePreloadAfterPaint → showStartFlow → dumpRound5Measures (~5 lines). Click → enterGame → forging veil → mountApp → game.
- [~] **Reset hook** — `GameStore.reset()` previously cleared `idle-craft-intro-cutscene-seen-v1` so the intro chain replayed after Reset All Progress. The flag still exists in localStorage from prior boot completions but is no longer consulted by the boot path.
- [x] **Per-shot voice overrides** — `gen_narration.py` extended to read per-shot `voice` / `voice_length` / `voice_pitch` fields from the shot list JSON. Enables the witch trio (cori GB / jenny GB / kristin US) on `s7b` / `s7c` / `s7d`.
- [x] **Real CC0 SFX integration** — Piper can't synthesize realistic laughter from "ha ha ha" text. Solved with FFmpeg concat-demuxer recipe layering a CC0 cackle (`ghostly_cackle_laugh_1.ogg` from OpenGameArt) onto the witch's spoken line. The same recipe applies to any future scream/gasp/laugh moment.
- [x] **Narrative bible** — **`LORE.md`** at game root. Canonical names, palette, three-act arc, voice/tone rules, witch-trio voice mapping.
- [x] **Pipeline doc** — **`docs/CUTSCENE_PIPELINE.md`** — high-level "how to make a new cutscene" recipe.
- [x] **Build log / runbook** — **`docs/CUTSCENE_BUILD_LOG.md`** — exhaustive command-by-command record of every install step, every script, every iteration, with full file trees and worked examples for both shipped cutscenes. Use as a runbook to reproduce or debug any output.

### Phase 8 — Awakened-mode base building (Phase 1 of the survival vision)

- [x] **Master plan** — **`docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md`** — full vision: piece catalog, material tier table, crystal wraps, mob roster, raid cadence, damage/repair, storage, PvP destruction, 7-phase implementation roadmap.
- [x] **Doc cross-links** — `docs/AWAKENING_AND_FREE_ROAM_PLAN.md` §15, `GAME_MASTER.md` §11, `docs/MULTIPLAYER_ROADMAP.md` §3 (base damage rules), `LORE.md` §11 (magical construction & wards).
- [x] **State model** — `PlacedCabinPiece`, `CabinPieceKind`, `CabinMaterialTier` types + `STATE_VERSION` 18 → 19 with default-safe migration. `crystalWrap` slot reserved for Phase 3 so it won't bump the schema again.
- [x] **Store methods** — `placeCabinPiece` / `removeCabinPiece` (50% material refund) / `cabinPieceCost` / `cabinPieceMaxHp` / `getPlacedCabinPieces` in `gameStore.ts`. Per-tier wood multiplier + ingot tables locked.
- [x] **Magical PBR palette** — `src/visual/magicalCabinMaterials.ts`: `cabinLog` (per-tier wood color), `cabinBand` (per-tier metal — `MeshPhysicalMaterial` with iridescence + clearcoat at silver/gold/platinum), `cabinRune` (warm amber on copper/bronze, bioluminescent cyan on silver/gold/platinum). All cached per tier.
- [x] **Per-kind LPCAs** — `src/visual/cabinPieceLPCA.ts`: foundation, wall_solid, wall_window, wall_doorway, door, floor, roof_slope (MVP set with detailed log construction); pillar, ceiling, roof_peak, stairs, gate, ladder (placeholder geometry — Phase 1.5 polish target). Log silhouette held across all tiers.
- [x] **Render handle** — `src/world/cabinBuilder.ts`: `THREE.InstancedMesh` per (kind, tier, material) bucket, diff sync from store with per-bucket signature gating. Capacity grows by powers of 2; cleanup of empty buckets. Far-off-coords shader-warm pass at boot via `cabinHandle.warmShaders`.
- [x] **Build mode controller** — `src/world/buildModeController.ts`: ghost preview anchored 1.5 m ahead of avatar, snap to 1.5 m grid, rotation R/wheel, validation (map radius / water / overlap / inventory), green/red tint, confirm/cancel. Stays active across successive placements for fast wall-stacking.
- [x] **Input wiring** — `src/world/freeRoamControls.ts`: build-mode-active intercept of R / wheel / Esc / E. WASD + Space + Tab still pass through normally so the player can position + jump while in build mode.
- [x] **Build tab** — `src/ui/mountApp.ts` + `src/ui/app.css`: new "Build" entry in the awakened menu, two-step picker (kind grid × tier row), affordability + unlock-card gating per tier, click → enter build mode + auto-close menu so the ghost is visible.
- [x] **Engineering invariants** — phantom-light rule preserved (no new `THREE.PointLight`s anywhere in the cabin pipeline; all glow is emissive + bloom). Awakened-mode-only gating preserved. Save schema forward-compatible for Phases 3 + 4.

### Phase 8d — GoE-style flush snap (2026-04-18)

**Single-session changelog:** [docs/SESSION_2026_04_18_BUILDING_AND_PENDING.md](docs/SESSION_2026_04_18_BUILDING_AND_PENDING.md). Per-issue deep notes in `LEARNINGS.md` ("GoE-style flush snap" entry).

- [x] **Flush same-kind lateral snap (GoE-style "deck extension")** — `src/world/buildModeController.ts`. Same-kind lateral matches (floor next to floor, wall next to wall, ceiling next to ceiling, foundation next to foundation, roof_slope next to roof_slope) ALWAYS win over top-snap competition; new floors / walls / etc. extend flush at the same Y level instead of stacking. Lateral threshold tightened to `1.5 × GRID_SIZE = 2.25 m` (matches `gameofempiresDocs/docs/BUILDING_SYSTEM.md`); top-stack threshold tightened to 1.0 m euclidean (was 4.5 m manhattan). Top-stack still works for genuine vertical attachments (wall on foundation top, ceiling on wall top, etc.).

### Phase 8l — Trippy terrain palette + bouncy drip-mushrooms (2026-04-20)

**Plan + research + locked decisions:** [docs/TRIPPY_TERRAIN_AND_BOUNCE_MUSHROOMS_PLAN.md](docs/TRIPPY_TERRAIN_AND_BOUNCE_MUSHROOMS_PLAN.md). Per-issue deep notes in `LEARNINGS.md` ("Bouncy drip-mushrooms + trippy terrain palette").

Six-phase ship that pulls two assets out of the sibling `C:\stick man` project (which shares the EmpireEngine/EmpireEditor stack with idle craft) and re-homes them into idle craft's awakened world. Mycelium / drip simulation / LivingTerrain paint were explicitly excluded from the port per the user's spec.

- [x] **Phase 1 — Trippy terrain palette (full replacement, locked decision §4.1).** Awakened ground is now a `MeshPhysicalMaterial({ vertexColors: true, transmission: 0.18, emissive: 0x111122, … })` with per-vertex colors picked by slope + height (cyan grass `0x2effcc`, magenta dirt `0xff7fbf`, amber rock `0xffb030`). Slope sampler `computeSlopeAt(sampleHeight, x, z, eps)` added to `idleCraftHeightfield.ts` (finite-difference, eps=0.5m). Vertex colors baked once at attach time → zero per-frame cost. `LORE.md` §1 framing addendum: "Mira's water-magic dreamscape leaks neon into the awakened world."
- [x] **Phase 2 — Bouncy mushroom prop builder (`src/visual/bouncyMushroomLPCA.ts`).** Direct port of stick man's `MushroomBuilder.buildMushroom` (cap + stem + drip blobs, neon palette, transmissive cap with emissive lift). Three idle-craft-specific changes: (1) cap mesh wrapped in a `capPivot` group whose origin is at the rim, so squash via `capPivot.scale.set(sxz, sy, sxz)` keeps the rim glued to the stem top; (2) materials cached per `colorIndex` in module scope (8 cap + 8 stem + 8 drip programs total instead of 90+ unique materials → no first-use compile freeze); (3) builder return shape exposes `capPivot` + `dripGroups` + `capRestTopY` so the bounce controller has direct refs without traversing.
- [x] **Phase 3 — Scatter + collision footprints (`src/world/awakenedBouncyMushrooms.ts`).** 18 mushrooms scattered via deterministic hash-seeded uniform-disk rejection sampling (max 64 retries per slot; reject within 4 m of dock home / 2 m of any creek / 1.5 m of any other mushroom). Each registers a circle footprint with `topY = baseY + capRestTopY` so the existing `getGroundY` + predicted-XZ landing pipeline handles "stand on cap" with no per-mushroom code in `freeRoamControls`. Per-mushroom runtime state: `squash`, `squashVel`, `lastBounceAtSec`, `chainCount`, `hp`, `state ∈ {mature, broken, growing}`, `respawnTimer`, `growT`. Damped-spring squash integration (Hooke `K = 64` + linear damping `C = 7.5` integrated explicitly per frame; rest-state early-out skips the matrix update when both displacement + velocity are tiny).
- [x] **Phase 4 — Landing-triggered bounce + visual sync.** `collisionWorld.getGroundY` extended to `getGroundYAndOwner` returning `{ y, ownerId }`; legacy `getGroundY` is now a one-line wrapper (no caller migration). `freeRoamControls.sampleGroundYAndOwner` tracks the owner across the predicted-XZ comparison so the airborne landing branch knows what surface produced the win. New `mushroomBounce` callback in `FreeRoamOptions`; landing branch matches `ownerId.startsWith('mushroom:')` + invokes the callback. On non-null result: `vy = bounceVy`, `isAirborne = true`, `usedDoubleJump = false`, skip the standard `landed = true` branch. **Visual sync**: squash impulse fires the SAME frame as the upward kick; player launches BEFORE the cap finishes wobbling, so "feet-glued-to-wobbly-cap" never happens. Mario-rules boosted bounce: hold Space at landing → `BOUNCE_BOOSTED_VY = 16.0` (apex ~5.8 m, nearly clears mid-tier trees) instead of `BOUNCE_VY = 11.5` (apex ~3.0 m). Multi-bounce chain bonus `+1.0 m/s` per consecutive bounce within 0.6 s, capped at `+3.0`. Squash velocity scales with impact: `squashVel = 6 + impactSpeed * 0.3` so heavy drops produce visibly bigger squishes.
- [x] **Phase 4.5 — Magic-bolt damage + sapling-grow respawn.** `applyMagicHit(ownerId, damage)` decrements HP (`MUSHROOM_HP_MAX = 5`); on death the mushroom enters `'broken'` state (group hidden, footprint unregistered, 180 s respawn timer starts — matches Phase 8c `REGROW_WAIT_SEC`). After the wait, `'growing'` state pops the visible group back at `SAPLING_START_SCALE = 0.10` and animates up over 25 s via easeOutQuad. Sapling collision NOT registered until mature (Phase 8c invariant). Wired to `magicProjectiles.onStaticHit` in `mountApp.ts` via a `mushroom:` owner-id branch (parity with the existing `cabin:` / `craft_station:` branches from Phase 8h).
- [x] **Phase 5 — Boot warm shaders.** `bouncyMushroomsHandle.warmShaders(renderer, camera)` builds one mushroom of each color offscreen + calls `renderer.compile`, then disposes via `requestAnimationFrame`. Same pattern as `cabinHandle.warmShaders` and `mobsHandle.warmShaders`. Eliminates the 100-400 ms freeze on the first mushroom in camera.
- [x] **Phase 6 — Polish (drip wobble + procedural bounce SFX).** Drip groups (children of `capPivot`) inherit the squash but ALSO get an extra `scale.y = 1 + 0.45 × squash` so the wax visibly stretches downward during the compress and snaps back on the rebound — reads as "the cap is being squeezed and the drips are getting pulled out." `playMushroomBounceWorldSfx(ctx, bus, intensity)` in `movementSfx.ts`: triangle-wave pitch sweep (220 → 660 Hz over 80 ms then back to 420 Hz, the spring overshoot voice) + low-pass-swept noise burst (squish texture) + sub-bass thump for heavy bounces only. Routed through the existing `jumpLandSfxGain` bus so the player's existing "Jump / land sounds" volume slider controls it.
- **Engineering invariants respected:** No new `THREE.PointLight`s (cap glow is `emissive × 0.45` × bloom). `numDirLightShadows` / `numPointLights` constant after boot (group `.visible` toggles only on broken/growing transitions; cap material lives in program cache from boot via `warmShaders`). Footprint Y-band semantics fit cleanly into existing predicted-XZ landing + auto-step-up. Save state untouched — bounce / damage / respawn are all RUNTIME state. `saveState` debounce respected — bounce events never write to the store. CPU `mesh.scale` writes for squash (not vertex-shader displacement). Realm-flip lifecycle parity with mobs / projectiles / combat.

### Phase 9 — OffscreenCanvas render worker (2026-04 ongoing)

**Scope:** Solo dock + awakened gameplay on the worker path. **Not part of Phase 9 acceptance:** lobby, `syncOnlinePresence`, or multiplayer rendering on `CharacterSceneHost` — see migration doc “Scope” and multiplayer session note.

**Actionable checklist:** [docs/WORKER_MIGRATION_PHASE_3X.md](docs/WORKER_MIGRATION_PHASE_3X.md) · **Architecture map:** [docs/WORKER_ARCHITECTURE.md](docs/WORKER_ARCHITECTURE.md) · **Vision vs implementation (preload, sky, camera gaps):** [docs/GAME_VISION_VS_IMPLEMENTATION_2026_04.md](docs/GAME_VISION_VS_IMPLEMENTATION_2026_04.md)

- [x] **Scaffold** — COOP/COEP headers, `SharedRenderState` SAB, `CharacterSceneHost` + `WorkerBridge`, typed `protocol.ts`, `renderWorker.ts` entry, capability probe in `main.ts`.
- [x] **Worker dock scene (opt-in `?worker=1` when capable; default is legacy main-thread dock)** — `IdleCraftDockEnvironment` + procedural sky, terrain/water (`bootstrapDockSceneSlice.ts`), forest backdrop phases (`attachDockForestBackdropForestPhases`), vanguard hero + staff orb (`attachWorkerDockHeroLpcaSlice.ts`), `PostProcessingStack` + night-grade pass, deferred GPU warm passes. **URL / default policy:** [docs/WORKER_VS_LEGACY_PATH.md](docs/WORKER_VS_LEGACY_PATH.md).
- [x] **SharedRenderState Step 5** — `CharacterSceneController.syncSharedRenderState()` after each draw: avatar position, camera yaw/pitch + forward XZ, staff tip from `vanguardWizardStaffRoot`, water bank via `waterGatherBankXZ`, `renderer.toneMappingExposure`, gameplay flags from worker message mirrors. **Stubbed:** gather-clip f32 triple until worker runs harvest clips; **`CAMERA_ZOOM` fixed at `1`** until wheel zoom is mirrored.
- [x] **Step 6** — SAB camera world pose + FOV + aspect; `WorkerBridge` registers main readback; `mountApp` damage floaters use `fillPerspectiveCameraFromSharedState` when the host is live. Center magical reticle needs no camera read. Remaining: audit lock-on / combat helpers vs shadow-only `scenePreview` as **3.x-C** removes duplication.
- [x] **Step 7** — Main: `CharacterSceneHost.attachWindowKeyboardMouseForwarders` wires [`workerInputForwarder.ts`](../src/world/workerInputForwarder.ts) during worker preload; dispose detaches. Worker: awakened free roam uses [`WorkerAwakenedLocomotion`](../src/worker/workerAwakenedLocomotion.ts) + SAB; wheel zoom mirrored on worker. **Remaining:** title-dock (non-awakened) camera parity if any; **third-person framing** vs legacy compass (`GAME_VISION_VS_IMPLEMENTATION_2026_04.md` §3.4).
- [x] **Phase 3.x progress** — Documented in [`docs/WORKER_MIGRATION_PHASE_3X.md`](docs/WORKER_MIGRATION_PHASE_3X.md) (status + Steps 8–11). **Backlog on the solo migration only:**
  1. **3.x-C — Drop shadow duplicate** — retire parallel `mainThreadGamePreview` once handles + attach live entirely on the worker/host surface.
  2. **Step 8 audio** + **Step 10** strict gate / parity + **Step 11** verification.

### Phase 8k — Awakened fullscreen FPS parity (2026-04-20)

**Single-session changelog:** see `LEARNINGS.md` → *"Awaken-mode FPS round 4 — fullscreen / large-monitor total-pixel cap + aspect-preserving DPR shrink"*.

Round 3 (Phase 8e ancestor work, 2026-04-18) lifted **windowed** awakened FPS from 30-40 → 100+ on a 1080p × DPR 2 laptop via DPR cap to 1.0 + bloom/SSAO drop. Players on 1440p / 4K / ultrawide reported **fullscreen** still dropped to 30-50 FPS even at the `'perf'` tier — the round-3 optimisation implicitly assumed a 1080p target and didn't follow the canvas as it grew.

- [x] **Total-pixel budget on top of the DPR cap.** `computeEffectivePixelRatio(cssW, cssH)` now multiplies `dpr` by `sqrt(budget / naturalPixels)` whenever `cssW * cssH * dpr²` exceeds the awakened tier's pixel ceiling. Tier targets: `'perf'` ≈ 2.07 MP (1920×1080), `'balanced'` ≈ 3.11 MP (1.5× headroom for bloom), `'full'` no cap. Same multiplier on both dimensions → buffer aspect ratio preserved → no scene distortion. The browser does the (free) upscale to the displayed CSS box.
- [x] **Drop the `1680` width-only cap from `dockPreviewDrawSize`.** The legacy cap (a) was dead code in deck mode (`.character-preview-root` already enforces `max-width: 1680px` in CSS) and (b) actively harmed awakened mode by clamping width while leaving height uncapped — buffer aspect ≠ CSS aspect → browser stretched the rendered scene horizontally on screens > 1680 wide.
- [x] **Caller plumbing.** Constructor + `onResize` thread their already-known `(w, h)` into `computeEffectivePixelRatio(w, h)`. Without dims the area cap is skipped (safe fallback for paths that haven't fetched container size yet).
- [x] **Esc-menu help honesty.** `graphicsHelpCopy.ts:'lit-awakened-quality'` now states each tier's pixel cap so players understand what they're picking.
- **Result:** On 1440p / 4K / ultrawide fullscreen awakened canvases at the `'perf'` tier, fragment work is now bounded to ~2 MP regardless of canvas size — fullscreen FPS now matches windowed FPS. Aspect-ratio distortion gone. `'balanced'` same idea with 1.5× headroom. `'full'` unchanged.
- **Files:** `src/visual/characterScenePreview.ts` (`dockPreviewDrawSize`, `computeEffectivePixelRatio`, constructor + `onResize` call sites), `src/ui/graphicsHelpCopy.ts`.

### Phase 8j — Cutscene smoothness + awakened-mode hit blood restore (2026-04-19)

**Single-session changelog:** [docs/SESSION_2026_04_19_CUTSCENE_AND_BLOOD.md](docs/SESSION_2026_04_19_CUTSCENE_AND_BLOOD.md). Per-issue deep notes in `LEARNINGS.md` ("Cutscene smoothness" and "Awakened-mode hit blood").

Late-evening polish on top of the lighting overhaul + balanced-default ESC menu work. Closed two outstanding player reports.

- [x] **Shattering cutscene smoothness.** Pre-fetch the shattering MP4 via `fetch(href, { cache: 'force-cache' })` right after splash dismiss, so the file lands in HTTP cache during the LONG curse-cutscene + title-flow window. By the time `enterGame` fires the file is on disk and `<video>.src = ...` reads from cache (zero round-trip). Also folded `mountApp` + audio + dock-preload module promises into a `Promise.all` BEFORE the cutscene plays so no JS chunk parses run on the main thread during video decode. (Note: `<link rel="preload" as="video">` is NOT a valid `as` value per Fetch spec — browsers warn and ignore. `fetch` with `force-cache` is the universal alternative.)
- [x] **Awakened-mode hit blood restore.** New public `spawnAwakenedHitBlood(x, faceY, z, intensity)` on `CharacterScenePreview` reuses the dream `enemy_human_face_drip` preset (face burst → drip strips → ground pool) but anchors at the mob's actual world-space position. Wired into `mountApp.ts onMobDamaged` callback gated on `amount > 0` so blood == damage applied is structurally guaranteed (no blood from swing-button presses at empty air). Per-kind face-Y offsets (rat 0.5m / wolf 0.95m / wanderer 1.55m) so drip length matches body silhouette. Killing blows pin to max intensity. Dream-mode `updateBattleBlood` is unchanged — the awakened-only early-return stays in place so dream paths can never accidentally fire from awakened swings.

### Phase 8i — Ground-level lighting overhaul (2026-04-19)

**Single-session changelog:** [docs/SESSION_2026_04_19_LIGHTING_OVERHAUL.md](docs/SESSION_2026_04_19_LIGHTING_OVERHAUL.md). Per-issue deep notes in `LEARNINGS.md` ("Ground-level lighting overhaul"). Plan source: [docs/GROUND_LEVEL_LIGHTING_OVERHAUL_PLAN.md](docs/GROUND_LEVEL_LIGHTING_OVERHAUL_PLAN.md).

Eight-phase research-driven lighting pass implementing every recommendation from the overhaul plan. Inspired by Echoes of Wisdom / BotW / Genshin recipes + the sibling GoE project's lighting docs (`C:\GameofEmpiresDocs\docs\`).

- [x] **§8 Bloom tuning.** `project.json` threshold 0.05 → 0.85, strength 0.04 → 0.45. Magic projectile emissive bumped (midShell 0.9 → 1.6, crystals 1.6 → 2.4) so they reliably exceed the new threshold.
- [x] **§5 Horizon-matched fog.** Added `horizonWarm` / `horizonCool` colors to `IdleCraftDockEnvironment`. `horizonInfluence = 1 - smoothstep(sun.y, 0, 0.45)` blends warm-or-cool horizon tint into fog when sun is near horizon. Tightened night fog band (×0.42 / ×0.55).
- [x] **§1 PMREM IBL from gradient sky.** `attachIbl(renderer)` builds a 3-color gradient sphere env scene, regenerates `scene.environment` every ~4 s. PBR materials' `envMapIntensity` finally activates (avatar skin, pve enemy bodies, witch wands, projectile midShell, all wake up).
- [x] **§2 Camera-relative fill light.** Phantom `DirectionalLight` parented to camera, `castShadow=false`. Color tracks sky tone (cool→warm by sunWarmth, → moonBase at night). Stops the avatar going silhouette-flat.
- [x] **§4 Night-grade post-process pass.** New `nightGradePass.ts` ShaderPass injected into the composer before vignette. Desaturates 45 %, cool-tints, gamma-crushes mid-shadows. Strength = `nightMix × (1 - moonIllum × 0.30)`. Toggled via `setPassEnabled(nightMix > 0.05)` to keep the program in cache.
- [x] **§3 Half-Lambert wrap.** New `halfLambertLighting.ts`. Same WeakSet + `customProgramCacheKey` pattern as vegetation wind. Replaces `irradiance = dotNL * directLight.color` with `(pow(dotNL * 0.5 + 0.5, 2.0)) * directLight.color`. Applied to all player-avatar materials + every PVE enemy.
- [x] **§7 Eye-adaptation lite.** `getExposureMultiplier()` returns smoothed `adaptedExposure`. Asymmetric tau (0.3 s brighter, 1.2 s darker). First-tick snap to target so boot has no fade-from-neutral.
- [x] **§6 Cone-geometry god-rays.** New `sunGodRays.ts`. Open `ConeGeometry` mesh oriented along sun direction, additive material. Opacity `sunDirectFrac × 0.06 × (1 - storm × 0.6)`, color cool→peach by sunWarmth. Free at runtime — additive program already in cache.

### Phase 8h — Pending-work cleanup: spawn variety, wolf howl, station-on-floor, build HP (2026-04-19)

**Single-session changelog:** [docs/SESSION_2026_04_19_PENDING_CLEANUP.md](docs/SESSION_2026_04_19_PENDING_CLEANUP.md). Per-issue deep notes in `LEARNINGS.md` ("Pending-work cleanup").

Closed all four open pending items from Phases 8e + 8f + 8g.

- [x] **Wanderer / wolf spawn variety.** `WAVE_INTERVAL_MS` 25s → 12s + anti-clump bias in `pickMobKind` (recent-spawns ring buffer penalises a kind's weight by `1 / (1 + 0.6 * recentCount)`). All three mob kinds now appear within a typical 90 s session.
- [x] **Wolf death howl SFX.** Procedural rewrite of the `wolf` case in `playMobDeathWorldSfx` — proper iconic howl arc (rising 280→540 Hz, descending to 140 Hz over ~0.85 s) with a triangle sub one octave down + breath-noise texture, then the body thud at 0.95 s. Zero audio-file deps.
- [x] **Stations placeable on cabin floors.** `createStationBuildModeController.update` now calls a new `findCabinFloorTopAt(x, z)` helper that walks placed foundation / floor pieces (rotation-aware) and returns the highest top-Y of any piece covering the snapped XZ. Restricting to foundation/floor avoids "campfire snaps to a wall mid-air."
- [x] **Player-build HP system (magic damages cabin pieces + craft stations).** New store methods `damageCabinPiece(id, amount)` and `damageCraftStation(id, amount)` decrement HP, and on `hp <= 0` route through the existing `removeCabinPiece` / `removeCraftStation` flow (which keeps the standard 50% material refund — magic destruction is destructive intent, not punitive). `magicProjectiles.onStaticHit` in mountApp now routes `cabin:` and `craft_station:` owner-id prefixes to these methods with `MAGIC_BUILD_DAMAGE = 1` per hit so a single accidental shot doesn't wipe a foundation; full destruction takes many deliberate hits. Cyan damage floater shows `"wall -1"` / `"station -1"` (or `"wall destroyed"` / `"station destroyed"` on the killing hit) for clear feedback.

### Phase 8g — Combat polish round 2: aim-assist, magic auto-loot, harvest labels, lock-on warm (2026-04-19)

**Single-session changelog:** [docs/SESSION_2026_04_19_COMBAT_POLISH_R2.md](docs/SESSION_2026_04_19_COMBAT_POLISH_R2.md). Per-issue deep notes in `LEARNINGS.md` ("Combat polish round 2").

Followup to 8f. After 8f the bolt reliably reached the reticle target; this pass fixes the residual "I shoot the fern instead of the rat sitting on top" / "I have to walk 30 m to skin a magic kill" / "first lock-on freezes" complaints.

- [x] **3D mob aim-assist.** `reticleAimPoint` adds a 3D ray-vs-mob-center scan after the precise Y-aware raycast. Any mob within `MOB_AIM_ASSIST_RADIUS_3D = 1.6 m` of the camera ray (and closer along the ray than other candidates) wins aim. Solves both "rat on top of fern" (mob's small footprint missed by the precise raycast) and "shooting from a tall tree at a ground mob" (mob's vertical extent below the ray's Y-band). Effective angular tolerance is generous up close (18° at 5 m), tight at range (3° at 30 m).
- [x] **Magic kill = instant meat + corpse skip.** `mobs.damage(id, amount, fromXZ, source?)` now takes an optional `source: 'melee' | 'magic'`. `magicProjectiles` passes `'magic'` on both hit paths. On magic kills the dying-state machine still plays the 1.5 s fall-over but skips the corpse-persist phase via a `rangedKillNoCorpse` set; `onMobDamaged` now passes `source` to mountApp which auto-grants `MOB_LOOT[kind].meat` + spawns a `'+meat'` gold floater above the mob the moment the bolt lands. Melee kills unchanged (legacy E-skin loop preserved).
- [x] **Resource label on harvest floaters.** `damageFloaters.spawn(..., label?)` extended with optional label. `onStaticHit` routes `node.kind` (awakened scatter) or `result.yieldKind` (dock-forest) so the floater reads e.g. `"wood -3"` instead of just `"-3"` — distance harvests are now legible.
- [x] **Eager-build lock-on reticle (first-T-press freeze fix).** `lockOnController` was lazy-building its MeshStandardMaterial ring and the program compiled on first render = 100-400 ms freeze on first T-press. Now built at attach time, parked at `Y=-10000` so boot's warm pass compiles it with everything else. Reinforces the project-wide warmShaders pattern for all first-interaction freezes.

### Phase 8f — Awakened combat + harvest reliability pass (2026-04-19)

**Single-session changelog:** [docs/SESSION_2026_04_19_COMBAT_HARVEST_POLISH.md](docs/SESSION_2026_04_19_COMBAT_HARVEST_POLISH.md). Per-issue deep notes in `LEARNINGS.md` ("Awakened combat + harvest polish — staff tip, reticle aim, magic-as-harvest, freeze").

Followup pass to 8e — fixes the "magic doesn't actually go where the reticle is pointing" / "I can't reliably harvest stuff" / "combat causes freezes" complaints. Each item is a root-cause fix; the symptoms were overlapping which is why they're grouped.

- [x] **Bolt origin = real staff tip** — `getStaffTipWorldPosition()` now uses `vanguardWizardStaffRoot.localToWorld(0, 1.103, 0)` (the glowing finial) instead of `handR + 0.4 m` (the wrist). Hand-pose / staff-tilt fully respected per frame. Falls back to legacy hand+offset when the staff root isn't available.
- [x] **`reticleAimPoint` rewrite — three-candidate, mob-priority, fine terrain step.** Mob hit (Y-aware, `hitMobsOnly: true`) is promoted to top priority; static obstacle hit (Y-aware, mobs filtered) and terrain hit (0.4 m step + binary refine) are the fallback layers. `MIN_AIM_DIST = 1.2 m` (static) / `0.4 m` (mob) prevents degenerate near-camera collapses. `castMagic` reads the resolved `mobOwnerId` and soft-homes free-aim bolts onto the crosshaired creature.
- [x] **Camera floor-clamp parallel-translate.** When `camera.position.y` is bumped to clear terrain, the SAME `deltaY` is applied to the lookAt target. Camera-forward direction preserved → reticle aim stays aligned with screen-center across zoom levels and at any avatar Y (tree top, mid-jump, etc.). Same idiom we use for the right-shoulder offset.
- [x] **Combat-ready avatar facing.** Whenever `isCameraLocked()` is true, the avatar's yaw snap-slerps toward `cameraForward` at 12 rad/s. Standard third-person shooter behaviour — staff stays on screen-right so the bolt visibly leaves the tip toward the reticle. The legacy "facing follows movement velocity" path still runs in free-cursor mode and is gated `if (!isCameraLocked)` in the camera-locked branch to avoid fighting.
- [x] **Y-aware bolt collision.** `magicProjectiles.update()` passes `originY: prevY` + `dirY: segDy / segLen` to `collisionWorld.raycastXZ`. Bolts no longer falsely despawn on tree / wall / station footprints they're flying VERTICALLY OVER (the canopy bug).
- [x] **Magic-as-universal-damage / magic-as-harvest.** New `onStaticHit` callback on `MagicProjectilesHandle`. `mountApp.ts` parses owner-id prefix and routes:
  - `harvest:<kind>:<idx>` → `harvestHandle.applyHit(node, store.getHarvestHitsMultiplier(kind))` — same pipeline / yield / despawn animation as melee press, with the player's currently-equipped tool tier.
  - `dock-forest-batched:<kind>:<idx>` → `dockForestHandle.getNodeByIndex(idx)` then same flow.
  - `cabin:` / `craft_station:` → silent despawn (no player-build HP system yet).
  
  Added `getNodeByIndex(idx)` on `DockForestHandle`; cyan damage floater spawns at the hit point for distance feedback.
- [x] **Reticle-only harvest dispatch when camera-locked.** `onInteract` does reticle-pick + surface-distance avatar gate (1.3 m); proximity fallback removed in camera-locked mode. "Press E" prompts hidden in awakened mode (universal-harvest contract = "anything visible is harvestable"). Free-cursor mode keeps the legacy proximity dispatch.
- [x] **Tree collision = trunk only.** Per-species `TREE_SPECIES_RADIUS_PER_SM` cut ~40% (apple 0.40 → 0.24, pine 0.32 → 0.20, birch 0.28 → 0.18, fir 0.34 → 0.22, oak 0.42 → 0.26). Awakened-scatter `apple_tree` 0.45 → 0.30. Player can walk under canopies and stand right next to the bark to harvest. `collisionRadius` exposed on both public node types so the harvest gate uses surface-distance — giant oaks now reachable.
- [x] **Debounced `saveState` (combat-freeze fix).** Single `SAVE_DEBOUNCE_MS = 250` window coalesces all 23 store-mutation save call sites into one deferred write. Eliminates the 7-10 saves/sec stutter during combat (`useMana` + `damageAwakenedMob` + `damagePlayerInAwakened` chain). `pagehide` / `beforeunload` / `visibilitychange` flush synchronously.
- [x] **Picker modal z-index 9300.** `spellPickerModal` + `consumableSlotPickerModal` switched from `position: absolute; z-index: 95` (stuck under awakened menu overlay) to `position: fixed; z-index: 9300`. Equip-from-inventory works without closing inventory first.

### Phase 8e — Multi-instance stations + magic projectile overhaul + 3D aim + dedupe (2026-04-19)

**Single-session changelog:** [docs/SESSION_2026_04_19_STATIONS_AND_MAGIC.md](docs/SESSION_2026_04_19_STATIONS_AND_MAGIC.md). Per-issue deep notes in `LEARNINGS.md`.

- [x] **Reverted half-built single-position scaffolding (Option R).** STATE_VERSION 23 → 24; v24 migration `delete`s the dead `awakenedStationPositions` field + initialises `placedCraftStations: []` / `placedCraftStationCounter: 0`. Setters / getters / `setAwakenedCraftStationXZ` / `applyAwakenedStationOverrides` / `restoreDreamStationSlots` removed.
- [x] **Multi-instance craft-station placement via build mode (A2' direct-spend choice).** New shape mirrors `placedCabinPieces`:
  - `PlacedCraftStation` + `PlacedCraftStationKind` (`'campfire' | 'workbench' | 'forge' | 'kitchen'`) types.
  - Store API: `craftStationCost(kind)` / `craftStationMaxHp(kind)` / `placeCraftStation(kind, x, y, z, rotY)` / `removeCraftStation(id)` / `getPlacedCraftStations()` — direct material spend at placement (no inventory token round-trip).
  - Renderer `src/world/craftStationBuilder.ts`: one `THREE.Group` per placed entry (campfire needs per-instance flame `tick()`); reuses `createCampfireLPCA` / `createWorkbenchLPCA` from `craftStationDecorLPCA.ts`; rect collision footprint per instance via `collisionWorld`.
  - Sibling build-mode controller `createStationBuildModeController` in `src/world/buildModeController.ts`: same R/wheel/Esc/LMB UX as cabin pieces; grid-only snap (no lateral / top-stack pipeline yet); validity gate via `collisionWorld.overlaps(candidateRectFootprint)`.
  - Build tab `Stations` sub-section in `src/ui/mountApp.ts` with affordability + unlock-card gating; mutual-exclusion cancel between cabin + station ghosts; per-frame ghost update + campfire flame tick wired to the awakened-mode loop. Forge / kitchen ship as visible placeholder boxes (kind LPCAs pending) so placement is testable now.
- [x] **Hide dock-yard campfire/workbench in awakened mode (B1 choice).** `craftDecorGroup.visible` + `craftCampfireSlot.visible` + `craftBenchSlot.visible` all gate on `!this.awakenedFreeRoam` in `applyIdle`. Dream mode untouched — dock-yard slots render exactly as before.
- [x] **Phantom-light pool for placed campfires** — `src/world/craftStationBuilder.ts` pre-allocates 4 `PointLight` pairs at attach time, parked off-scene with intensity 0. Each placed campfire claims a pair and the LPCA's `tick()` drives intensity to a real value — visually identical to the dream-mode dock-yard original (orange light bath on logs / stones). Phantom-light invariant respected; `numPointLights` constant after the one-time pool allocation. Pool overflow (5+ campfires) gracefully falls back to emissive-only.
- [x] **Build ghost cancels on every menu open** — `openAwakenedPanel(view)` in `mountApp.ts` calls `buildModeCtl?.cancel()` + `stationBuildModeCtl?.cancel()`. Tab-open and intra-menu nav both leave build mode cleanly.
- [x] **Magic projectile visual overhaul** — `src/world/magicProjectiles.ts` full rewrite of rendering layer. 5-layer magical orb (innerCore + iridescent shell + hue-cycling additive halo + 4 orbiting crystal facets + 6-frame fading trail). Speed dropped 25 → 14 m/s so the bolt is visible in flight. Phantom-light invariant respected — zero new `PointLight`s per projectile; glow is emissive + bloom.
- [x] **`magicProjectiles.warmShaders`** — pre-bakes all 5 projectile material programs at attach time so the first cast doesn't trigger a 100-400 ms shader compile freeze. Same proven pattern as `cabinBuilder.warmShaders` and `awakenedMobs.warmShaders`.
- [x] **Genuine 3D scene aim via `reticleAimPoint` rewrite** — `src/world/awakenedCombat.ts`. Two parallel raycasts (terrain heightfield walk + Y-aware obstacle raycast); pick the closer hit. Bolt fires from staff tip TO that 3D world point — matches AAA 3rd-person shooter "muzzle convergence" convention. Solves "shoots wrong direction", "barely visible", and "blocked when shooting down" simultaneously.
- [x] **Y-aware `collisionWorld.raycastXZ`** — new optional `originY` + `dirY` opts. Each candidate footprint's hit is filtered against the ray's Y at the hit XZ vs the footprint's `[bottomY, topY]` extent. Backwards-compatible (callers without `originY`/`dirY` get legacy 2D-only behaviour). Fixes tree-top false-positives + Y-mismatched mob hits in the aim raycast.
- [x] **Lock-on auto-hit gate** — `LOCKED_TARGET_AUTOHIT_RADIUS = 0.65 m`. When a homing bolt is within 0.65 m of its locked target, damage applies UNCONDITIONALLY — no reliance on the per-step XZ raycast catching the mob's footprint. Fixes "bolt grazes the wolf and continues" at low speed. Homing turn rate also bumped 3.2 → 7.5 rad/s for aggressive tracking.
- [x] **Terrain-hit despawn for projectiles** — `magicProjectiles.update()` checks `bolt.y < terrainY - 0.05` per frame and despawns. Aiming straight down now feels right (bolt visibly stops at the ground instead of clipping under terrain and persisting invisibly until lifetime expiry).
- [x] **Three.js dedupe** — `vite.config.ts` `resolve.dedupe: ['three']`. Eliminated duplicate Three.js shipping from the `empire-engine` workspace dep (`file:../EmpireEngine`). Main chunk dropped from **1,073 kB → 940 kB** (~37 kB gzipped saved). Cross-bundle `instanceof THREE.Mesh` checks now succeed reliably.
- [x] **Stations placeable on cabin floors** (Phase 8h pending pass). `createStationBuildModeController.update` now calls a new `findCabinFloorTopAt(x, z)` helper that walks placed `foundation` / `floor` pieces (rotation-aware via `-rotY` local-space transform) and returns the highest top-Y of any piece whose XZ footprint contains the snapped point. Falls through to terrain when nothing qualifies. No `accepts`-array surgery needed — restricting the snap to foundation/floor only avoids the "campfire snaps to a wall mid-air" problem the original deferral note worried about.
- [x] **Wanderer / wolf spawn variety** (Phase 8h pending pass). Cut `WAVE_INTERVAL_MS` 25s → 12s + added an anti-clump bias to `pickMobKind`: a recent-spawns ring buffer (last 5 kinds) penalises a kind's weight by `1 / (1 + 0.6 * recentCount)`. After 2-3 rats in a row, the next spawn is statistically much more likely to be a wolf or wanderer. Player sees variety within a typical 90 s session instead of streaks of pure rats.
- [x] **Wolf death howl SFX** (Phase 8h pending pass). Procedural in `combatSfx.ts` — replaces the previous "long whimper descending" with a proper iconic howl: rising sawtooth carrier 280→540 Hz over 0.25 s, descending to 140 Hz by 0.85 s, with a triangle sub one octave down for chest resonance, plus band-passed noise for breath texture. Body thud follows at 0.95 s. Zero file deps; same `playMobDeathSound('wolf', volumeScale)` entry point.

### Phase 8c — Universal harvest respawn + player-physics polish (2026-04-18)

**Single-session changelog:** [docs/SESSION_2026_04_18_HARVEST_AND_PHYSICS.md](docs/SESSION_2026_04_18_HARVEST_AND_PHYSICS.md). Per-issue deep notes in `LEARNINGS.md`.

- [x] **Universal sapling-grow respawn cycle** — every harvestable resource (trees, shrubs, berries, ferns, heather, rocks, ore, fiber tufts, grass / vine / moss patches, magic crystals) respawns from a tiny seedling/pebble/sprout and visibly grows to its full mature size. Cycle time cut from 7 min snap-back to 3 min wait + per-kind grow duration (12-60 s). Saplings are non-blocking and non-harvestable until fully mature. Files: `src/world/dockForestBatchedScene.ts`, `src/world/freeRoamHarvestNodes.ts`. New `GrowAnim` archetypes: `tree_grow` / `bush_grow` / `stone_form` / `fiber_grow` / `crystal_emerge`.
- [x] **Auto step-up onto floors / foundations / stairs (`STEP_UP_HEIGHT = 0.55 m`)** — `collisionWorld.inYBand` skips obstacles whose top is within step height above player feet; the post-move walk-off check snaps `avatar.y` up to the new surface. Stairs climb in one W-press. Walls / doors / trees still block normally. Files: `src/world/collisionWorld.ts`, `src/world/freeRoamControls.ts`.
- [x] **Predicted-XZ landing for airborne tree top catches** — airborne `sampleGroundY` checks BOTH current XZ AND `(x + velX*dt, z + velZ*dt)` and takes the higher surface Y. Cheap continuous collision detection so jumping forward toward a tree actually lands on the canopy. File: `src/world/freeRoamControls.ts`.
- [x] **Collision-aware foot-snap** — `characterScenePreview.syncAvatarFeetToTerrain` now consults a wired `surfaceYProvider` (set by `mountApp` to the controls' last-grounded surface Y). Player no longer gets yanked back to terrain Y while standing on a foundation / stair / canopy. Cleared on realm flip back to deck. Files: `src/visual/characterScenePreview.ts`, `src/ui/mountApp.ts`, `src/world/freeRoamControls.ts`.
- [x] **Mesh-measured tree-top `topY`** — both harvest paths now derive collision `topY` from the **actual LPCA mesh bounding box** (`max(subMesh.boundingBox.max.y) * scale`) instead of trusting hand-tuned per-species constants that drifted with `sm`. Player feet land exactly on the visual canopy top across all sizes. Files: `src/world/dockForestBatchedScene.ts` (`VariantTemplate.maxYAtUnitScale` per LPCA variant), `src/world/freeRoamHarvestNodes.ts` (`KindHandle.maxYAtUnitScale` per kind template).
- **Known limit (intentional, not a bug):** giant trees (`sm` ~ 4-5, canopy 6-8 m) exceed the player's max double-jump apex of ~6 m. Smaller / medium trees (`sm ≤ 2`) are landable. If "land on giants" becomes a goal, the answer is taller jump physics or climbable trunks, not a further collision tweak.

### Phase 8b — Camera-lock + GoE snap pipeline + collision + real-time combat

- [x] **Doc updates** — `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` §2.1 (snap point system), §10 (collision invariant + emissive-only VFX), §12 (camera-lock toggle Q), §13 (real-time combat — LMB/RMB/T/lock-on/projectile/mob waves).
- [x] **State + runtime** — `SnapPoint` / `SnapDirection` / `AwakenedMobInstance` / `AwakenedMobKind` types; gameStore runtime `activeAwakenedMobs[]` (NOT persisted) + `spawnAwakenedMob` / `damageAwakenedMob` / `removeAwakenedMob` / `useMana` / `damagePlayerInAwakened` / `clearAwakenedMobs`. `AWAKENED_MOB_STATS` table (rats / wolves / wanderers).
- [x] **Lightweight 2D collision world** — `src/world/collisionWorld.ts`: footprint registry (circle / rect), 4 m spatial hash, `resolveCircleMove` (push-out for player + mob movement), `overlaps` (build-mode placement gate), `raycastXZ` (melee + projectile collision). NO `three-mesh-bvh` dep.
- [x] **Footprint registration** — every cabin piece (rotated rect), every harvest scatter node (circle), every mob (circle), the player (circle) registers with the collision world. Player + mob movement resolves overlaps each frame.
- [x] **Camera-lock toggle (Q)** — `src/world/cameraLockController.ts`: pointer-lock + FPS mouse-look. Snapshots dock camera offset, integrates `movementX/Y` deltas into `dockCamYaw`/`dockCamPitch`. Auto-deactivates on browser-released pointer-lock. Disables dock orbit drag + double-click reset while active.
- [x] **GoE snap pipeline** — `src/world/buildModeController.ts` rewrite: center-ray raycast against terrain plane + placed-piece AABBs (within 30 m), 1.5 m grid snap, `findSnapXZ` (lateral cardinal-direction snap with 90°-corner bias), `findSnapY` (top-stack with wall-on-foundation alignment), closer-to-cursor preference. Per-piece snap point data in `getCabinPieceSnapPoints` + `getCabinPieceHalfExtents`. LMB confirms (E still works as accessibility carry-over).
- [x] **Real-time combat** — `src/world/awakenedCombat.ts` (LMB/RMB dispatcher reading equipment), `src/world/awakenedMobs.ts` (mob spawn + AI + render reusing existing `pveEnemyLPCA`), `src/world/magicProjectiles.ts` (16-orb pool, emissive only, free-aim or homing), `src/world/lockOnController.ts` (T toggle + cone scan + camera-yaw lerp). Block reduces incoming damage by 60% when shield equipped + RMB held.
- [x] **Mob wave system** — every 25 sec while alive count < 6, spawn one mob (rat / wolf / wanderer weighted by `pveWave`) 25-32 m from player. AI state machine (idle/wander → chase → attack → dying).
- [x] **Mid-air combat** — magic projectile spawn origin = staff tip world position (which moves with the body during the jump arc). Projectile inherits zero vertical velocity from jump for predictable aim; lock-on still applies in flight.
- [x] **Realm-flip cleanup** — flipping back to deck cancels build mode, deactivates camera-lock, drops lock-on, clears mob roster.

---

## 3. Battle dock — spacing & tuning

**Intent:** Player and enemy read at a believable duel distance; humanoid (deserter) especially needs clear separation.

| Constant | Role | Current values (verify in source) |
|----------|------|-------------------------------------|
| `BATTLE_ENEMY_REST_X` / `Z` | Enemy anchor in dock space | See `characterScenePreview.ts` top-of-file |
| `enemyStrikeAnchorX` / `Z` | Initial snapshot for enemy lunge | Kept in sync with rest constants |
| `BATTLE_PLAYER_LUNGE` / `BATTLE_ENEMY_LUNGE` | Contact motion | Same file |

> **Note:** Values were iterated in-session; always treat the **source file** as canonical, not this table.

---

## 4. Defeat & death presentation

### Enemy killed (victory path)

- [x] `queueBattleEnemyDeathAfterKill()` when a player card drops enemy HP to 0
- [x] After `battle_strike` / `battle_cast` ends, chain **`battle_enemy_death`**
- [x] **Rat / wolf:** side roll (barrel around Z), mild pitch, slight Y lift — avoids snout in floor
- [x] **Human deserter:** fall + limp rig via `PveBattleRig`
- [x] Extra blood during death clip; corpse pose held for victory UI (`battleEnemyCorpseFallen`)
- [x] `syncBattleContext` skips rebuild when **same `enemyId`** so corpse stays; **full rebuild resets** `enemyRoot` world transform (fixes “spawned already dead”)

### Player killed (permadeath path)

- [x] `battleEndTurn` sets `turn: 'defeat'` + `pendingPermadeath` instead of immediate wipe (`types.ts`, `gameStore.ts`)
- [x] **`battle_player_death`** clip; on end → `battle-player-death-done`
- [x] `finishBattlePermadeath()` → `dieAndWipe`
- [x] `resetDockAfterPermadeath()` — clip flags, canonical `(-0.06, 0)` travel home, pose reset, enemy root reset, `syncedBattleEnemyId` sentinel for next sync
- [x] `relevelAvatarFeetAfterEquipmentSync()` **after** `renderPage()` so equipment rebuild matches foot grounding (`mountApp.ts` listener)

---

## 5. UI / navigation

- [x] **Reset all progress** moved from Hire page to **main nav**, **after Hire, before Portal** (`mountApp.ts`, `.nav-reset-btn` in `app.css`)
- [x] Portal nav label + page callout: **Vibe Jam portal — use only for switching games** (jam hub handoff, not normal play)
- [x] Tab active state uses `data-nav-page` so reset button is not treated as a page

---

## 6. Key source files (quick map)

| Area | Files |
|------|--------|
| State & battle rules | `src/core/gameStore.ts`, `src/core/types.ts` |
| UI shell | `src/ui/mountApp.ts`, `src/ui/app.css` |
| Dock / clips / blood / death | `src/visual/characterScenePreview.ts` |
| Lobby LPCA + online presence types | `src/visual/lobbyDockHeroFromPreset.ts`, `src/visual/multiplayerAvatarStage.ts`, `src/net/roomTypes.ts`, `server/room-server.mjs` |
| PvE enemy LPCA | `src/visual/pveEnemyLPCA.ts` |
| Equipment meshes | `src/visual/characterEquipment.ts` |
| Entry / portal URL | `src/main.ts`, `src/vibeJamPortal.ts` |
| Content | `src/data/content.ts`, `src/data/metalConstants.ts` |

---

## 7. Maintenance habits

- Bump **`STATE_VERSION`** + **`migrateLoaded`** when save shape changes.
- After avatar or equipment mesh changes, any “full reset” path should **relevel feet** if equipment sync runs after pose reset.
- After battle clips that mutate **`enemyRoot`**, any **teardown / rebuild** must reset **`enemyRoot` position/rotation/order** before attaching a new enemy group.
- **Directional shadow lights stay `castShadow = true` for the session.** Toggling either `keyLight.castShadow` or `moonLight.castShadow` at runtime reintroduces the first-sunset hard freeze (WebGL program hash change → recompile of every lit material). See `LEARNINGS.md` → *"First-sunset hard freeze — directional shadow light count churn"* and `docs/DAYNIGHT_LIGHTING_AND_COLLABORATION.md` → *"Policy: both directional lights keep castShadow = true for the session"*.

---

## 8. Revision history (high level)

| When (approx) | What |
|---------------|------|
| 2026-04-22 | **Worker path product default** — Legacy main-thread `CharacterScenePreview` is the default dock; `?worker=1` opts into `CharacterSceneHost` + `renderWorker` when capable. Rationale: dream/deck parity incomplete on worker (gather/battle handlers still stubbed). **Doc:** `docs/WORKER_VS_LEGACY_PATH.md`. **Code:** `src/worker/capabilityGate.ts` (`isWorkerDockPreviewEnabled` requires `?worker=1`). Updated `WORKER_MIGRATION_PHASE_3X.md`, `WORKER_ARCHITECTURE.md`, `GAME_VISION_VS_IMPLEMENTATION_2026_04.md`, `LEARNINGS.md`, `GAME_MASTER.md`, `src/worker/AGENTS.md`, `src/visual/characterSceneHost.ts` file header, `docs/SESSION_2026_04_22_OFFSCREEN_CANVAS_SCAFFOLD.md` URL section. |
| 2026-04-21 | **Phase 6b (multiplayer avatar + awakened presence)** — Lobby carousel + gather ghosts use **`buildLobbyDockHeroFromPreset`** (preset-accurate LPCA). Co-op **awakened** mode streams **`realm` + world pose** over existing presence messages; server forwards; clients **smooth** remote peers in-scene. Doc: `docs/SESSION_2026_04_21_MULTIPLAYER_AVATAR_AND_AWAKENED_PRESENCE.md`. **Deploy:** update `room-server.mjs` with presence extensions. |
| 2026-04-21 | **Phase 9 (worker migration)** — documented Step 4 dock slices + **Step 5 live SAB writes** in `CharacterSceneController` (gather clip fields + camera zoom still stubbed). Updated `WORKER_MIGRATION_PHASE_3X.md`, `WORKER_ARCHITECTURE.md`, `AGENT_CONTEXT.md` §8.1, `src/worker/AGENTS.md`, `LEARNINGS.md`. |
| 2026-04-21 | **Phase 9 — 3.x MVP boundary** — `CharacterSceneHost.attachWindowKeyboardMouseForwarders` wires `workerInputForwarder` during worker title preload; dispose detaches. Migration doc adds explicit **MVP vs 3.x-B backlog** (worker input consumption, audio, default-on, drop shadow). `PLAN.md` Phase 9 + `WORKER_ARCHITECTURE.md` migration status refreshed. |
| 2026-04-21 | **Vision vs implementation doc** — Added `docs/GAME_VISION_VS_IMPLEMENTATION_2026_04.md` (shadow preload cost, sky/time-of-day investigation, missing-world triage, worker vs `idleCraftDockCameraCompass` camera gap). Updated migration doc Step 5/7 for live wheel zoom in SAB; corrected `AGENT_CONTEXT.md` §8.1 default-on worker note. |
| 2026-04-22 | Cutscene boot integration **removed** (splash + curse + shattering unwired from `main.ts`; .mp4 files + `src/cutscenes/*.ts` modules + `docs/CUTSCENE_PIPELINE.md` preserved on disk for one-commit revert). `bootIntroExperience` collapsed from ~150 lines to 5. ~30 MB of forced video download per page load eliminated. Round 5 cutscene-tuned tradeoffs walked back: lifted `withConcurrencyLimit(2)` cap on the 7-way extended-preload `Promise.all` (~50–150 ms saved on warm cache), single continuous veil in `enterGame` instead of mount/unmount/remount (visual flicker eliminated), trimmed 5+1 inter-phase yields in `CharacterScenePreview.create` to 2, bumped chunkedYielding budget 8 → 16 ms (one full paint frame), dropped two `yieldAnimationFrame` waits in `mountApp`, consolidated 4 micro-phase yields → 1. New `bindGameStoreToDockPreview(store)` in `dockPreload.ts` pre-applies equipment + character preset to the offscreen preview during the title flow — by click time `applyCharacterPreset` + `syncEquipment` early-return as no-ops (single biggest item moved off click → game critical path: `syncEquipment`'s ~10–100 ms LPCA mesh build). New `presetApplied` / `equipmentApplied` boolean sentinels guard the early-returns to prevent the constructor's placeholder field defaults from short-circuiting the first real apply (Vanguard Wizard regression identified + fixed in-session). Net ~150–400 ms shaved off click → game window. See `docs/SESSION_2026_04_22_CUTSCENE_REMOVAL_AND_BOOT_TIGHTENING.md` and `LEARNINGS.md`. |
| 2026 Q2 | Phases 1–6; battle blood + death; page poses + gear rules; hunt/structure hero pass; FX/reactions + server-ready presentation notes |
| 2026-04-18 | Phase 8c — universal sapling-grow respawn cycle, auto step-up, predicted-XZ tree landing, mesh-measured tree-top `topY`, collision-aware foot-snap. See `docs/SESSION_2026_04_18_HARVEST_AND_PHYSICS.md`. |
| 2026-04-18 | Phase 8d — GoE-style flush snap (same-kind lateral always wins; tighter thresholds). Half-built single-position station scaffolding flagged for revert. See `docs/SESSION_2026_04_18_BUILDING_AND_PENDING.md`. |
| 2026-04-20 | Phase 8l — Trippy terrain palette + bouncy drip-mushrooms ported from sibling `C:\stick man` project. Awakened ground now renders as `MeshPhysicalMaterial({ vertexColors: true, transmission: 0.18, emissive: 0x111122 })` with cyan/magenta/amber per-vertex colors picked by slope+height; vertex colors baked once at attach time (zero per-frame cost). 18 sparse drip-mushrooms (deterministic seed-derived placement, rejection-sampled away from creeks / dock / each other) act as Mario-rules trampolines: landing on a cap fires `vy = BOUNCE_VY = 11.5` (apex ~3 m), holding Space at landing fires `BOUNCE_BOOSTED_VY = 16.0` (apex ~5.8 m), multi-bounce chain bonus `+1 m/s` per consecutive bounce within 0.6 s up to `+3.0`. Cap squash is a damped harmonic spring (Hooke `K=64` + linear damping `C=7.5`) that fires the SAME frame as the upward kick → player launches before the cap finishes wobbling, so visual sync to player movement holds without any "feet-glued" problem. Drips visibly elongate during the compress (`scale.y = 1 + 0.45 × squash`). Magic bolts deal 1 dmg each (5 HP per mushroom); on death the mushroom enters the universal Phase 8c sapling-grow respawn cycle (180 s wait + 25 s visible regrowth from `SAPLING_START_SCALE = 0.10`). Procedural bounce SFX (triangle pitch sweep 220→660→420 Hz + low-pass-swept noise + sub-bass thump on heavy hits) routed through existing `jumpLandSfxGain` bus. New: `bouncyMushroomLPCA.ts`, `awakenedBouncyMushrooms.ts`, `TRIPPY_TERRAIN_AND_BOUNCE_MUSHROOMS_PLAN.md`. `collisionWorld.getGroundY` extended to `getGroundYAndOwner` (legacy method now a one-line wrapper); `freeRoamControls.update` got a `mushroomBounce` callback that the landing branch routes when `ownerId.startsWith('mushroom:')`. No `STATE_VERSION` bump (runtime-only). See `LEARNINGS.md` → *"Bouncy drip-mushrooms + trippy terrain palette"*. |
| 2026-04-20 | Phase 8k — Awakened fullscreen FPS parity. Round-3 (2026-04-18) capped DPR to 1.0 in awakened mode and lifted **windowed** FPS from 30-40 → 100+ on a 1080p laptop, but **fullscreen on 1440p / 4K / ultrawide monitors** still dropped to 30-50 FPS at the `'perf'` tier — the cap implicitly assumed a 1080p canvas. Round 4 adds a tier-aware **total-pixel budget** in `computeEffectivePixelRatio(cssW, cssH)`: when natural buffer pixels (`cssW * cssH * dpr²`) exceed the budget (`'perf'` 2.07 MP, `'balanced'` 3.11 MP, `'full'` uncapped), `dpr` is multiplied by `sqrt(budget / natural)` — same scale on both dims preserves aspect ratio, browser upscales the smaller buffer to fill the displayed CSS box for free. Also drops the legacy `min(1680, w)` width-only cap from `dockPreviewDrawSize` that was breaking aspect ratio on screens > 1680px wide (deck-mode CSS already enforces `max-width: 1680px` so it was dead code there). See `LEARNINGS.md` → *"Awaken-mode FPS round 4"*. |
| 2026-04-19 | Phase 8j — Cutscene smoothness + awakened-mode hit blood restore. Pre-fetch the shattering MP4 via `fetch(href, { cache: 'force-cache' })` during the long curse-cutscene + title window so `<video>.src = ...` reads from cache (zero round-trip; `<link rel="preload" as="video">` is NOT a valid `as` value per Fetch spec — browsers warn and ignore). Folded `mountApp` + audio + dock-preload module promises into a `Promise.all` BEFORE the cutscene so no JS chunk parses run on the main thread during video decode. New public `spawnAwakenedHitBlood(x, faceY, z, intensity)` reuses the dream `enemy_human_face_drip` preset (face burst → drip strips → ground pool) but anchors at the mob's actual position; wired into `onMobDamaged` gated on `amount > 0` so blood == damage applied (no blood from swing-button-only presses). Per-kind face-Y offsets so drip length matches body silhouette. Dream-mode `updateBattleBlood` is unchanged. See `docs/SESSION_2026_04_19_CUTSCENE_AND_BLOOD.md`. |
| 2026-04-19 | Phase 8i — Ground-level lighting overhaul (8 phases). PMREM IBL from a procedural gradient sky (regenerates every 4 s — PBR materials finally have environment specular). Camera-relative fill light parented to camera, sky-color-tracking (avatar pops at noon). Half-Lambert wrap on hero materials via `onBeforeCompile` + `customProgramCacheKey` (same pattern as vegetation wind) — shadow side reads soft cool grey, not pitch black. New `nightGradePass` ShaderPass desaturates + cool-tints + gamma-crushes the night frame so moonlight reads as moonlight, not blue daytime. Horizon-matched fog colors with `sun.y`-driven blend. Asymmetric eye-adaptation exposure smoothing (eyes pinch fast, adapt slow). Cheap cone-geometry god-rays oriented toward sun. Bloom threshold 0.05 → 0.85 + emissive props bumped so magic blooms but mundane surfaces don't. All 8 phases preserve `numDirLightShadows` / `numPointLights` invariants. See `docs/SESSION_2026_04_19_LIGHTING_OVERHAUL.md`. |
| 2026-04-19 | Phase 8h — Pending-work cleanup. Wave spawn cadence 25 s → 12 s + anti-clump bias in `pickMobKind` (recent-spawns ring buffer penalises kinds we just spawned). Wolf death is now a proper procedural howl (sawtooth carrier 280→540→140 Hz, triangle sub, breath noise, then body thud). Stations snap to placed foundation / floor tops via new `findCabinFloorTopAt(x, z)` (rotation-aware). Player-build HP system: `damageCabinPiece` + `damageCraftStation` store methods decrement HP and route to existing `removeXxx` (50% refund) on destroy; magic bolts deal 1 dmg per hit through the `cabin:` / `craft_station:` owner-id branches in `onStaticHit`. See `docs/SESSION_2026_04_19_PENDING_CLEANUP.md`. |
| 2026-04-19 | Phase 8g — Combat polish round 2. 3D mob aim-assist (1.6 m off-ray cone) so reticle picks up rats sitting on plants and ground mobs visible from tall trees. Magic kills auto-grant meat + skip corpse persist (`mobs.damage` source param + `rangedKillNoCorpse` set + `onMobDamaged` source-aware in mountApp). Resource label on harvest damage floaters (`damageFloaters.spawn(..., label?)`). Eager-build lock-on reticle at attach time so first T-press doesn't trigger a 100-400 ms shader compile freeze. See `docs/SESSION_2026_04_19_COMBAT_POLISH_R2.md`. |
| 2026-04-19 | Phase 8f — Awakened combat + harvest reliability. Real staff-tip bolt origin (`vanguardWizardStaffRoot.localToWorld(0, 1.103, 0)`). `reticleAimPoint` rewrite: mob-priority + 0.4 m terrain step + min-aim distance. Camera floor-clamp now parallel-translates lookAt (preserves camera-forward → aim correct across zoom + at high avatar Y). Combat-ready avatar facing follows camera yaw at 12 rad/s when locked. Y-aware bolt collision raycast — bolts no longer despawn on trees they fly over. Magic-as-universal-damage: `onStaticHit` callback routes harvest/dock-forest hits through the same `applyHit` pipeline as melee with the player's tool tier (yield / despawn animation match). Reticle-only harvest dispatch when locked (surface-distance gate, "Press E" prompts hidden). Tree collision shrunk to trunk silhouette so big oaks are harvestable; `collisionRadius` exposed on public node types. `saveState` debounced 250 ms — eliminates 7-10 saves/sec combat stutter. Spell + consumable picker modals fixed to `position: fixed; z-index: 9300` so they float above the inventory overlay. See `docs/SESSION_2026_04_19_COMBAT_HARVEST_POLISH.md`. |
| 2026-04-19 | Phase 8e — Multi-instance craft-station placement shipped (campfire / workbench real LPCAs; forge / kitchen placeholder boxes). Dock-yard slots hidden in awakened mode. Phantom-light pool gives placed campfires real orange glow. Magic projectile rewrite: 5-layer animated orb, 14 m/s, hue-cycling halo, orbiting crystal facets, comet trail. 3D scene aim raycast — bolt lands at the world point under the reticle (terrain heightfield walk + Y-aware collision world raycast, take closer). Lock-on auto-hit gate. Terrain-hit despawn. `magicProjectiles.warmShaders` pre-bake. `vite.config.ts` `resolve.dedupe: ['three']` — eliminated duplicate Three.js, main chunk -133 kB. Build ghost cancels on every menu open. See `docs/SESSION_2026_04_19_STATIONS_AND_MAGIC.md`. |

---

*End of plan. For engine/editor/MCP workflow, see `GAME_MASTER.md` §3–4.*
