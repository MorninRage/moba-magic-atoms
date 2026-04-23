# Session 2026-04-19 — Shattering-cutscene smoothness + awakened-mode hit blood restore

**Companion:** [LEARNINGS.md](../LEARNINGS.md), [PLAN.md](../PLAN.md). Late-evening polish pass on top of the lighting overhaul + balanced-default work.

## TL;DR — what shipped

| # | Item                                                   | Files |
|---|--------------------------------------------------------|-------|
| 1 | HTTP-cache pre-fetch of the SHATTERING video MP4       | `src/main.ts` |
| 2 | Defer `mountApp` + audio module parses BEFORE cutscene | `src/main.ts` |
| 3 | Awakened-mode hit blood restored (face-spew → ground)  | `src/visual/characterScenePreview.ts`, `src/ui/mountApp.ts` |

All changes type-check clean. No schema bumps, no new GPU allocations, no new deps. Reuses the existing dream-mode blood-mesh pool for awakened gore.

---

## 1. Shattering-cutscene smoothness

**Symptom (player report):** "the second cutscene is still horrible / not smooth."

**Root causes (three, compounding):**

1. **Video file fetched on first frame.** `playIntroCutscene` set `<video>.src = 'cutscenes/intro_the_shattering.mp4'` at the moment of playback. The browser started its HTTP fetch then, then started decoding while the file was still streaming. Buffer underruns showed as user-visible stutter.
2. **`mountApp` chunk parse running in parallel with cutscene playback.** Previous `enterGame` order kicked `loadMountAppModule()` non-awaited so the chunk's JS parse cost hit the main thread DURING the cutscene's video decode loop.
3. **`loadAudioModule()` fired in synchronous `enterGame`.** Same root cause as (2) — module parse cost during cutscene playback.

**Fix — three compounding changes:**

### 1a. Pre-fetch the shattering MP4 during the curse cutscene + title window

New helper in `src/main.ts`:

```ts
function preloadVideoFile(href: string): void {
  if (typeof fetch !== 'function') return;
  void fetch(href, { cache: 'force-cache', credentials: 'same-origin' }).catch(() => {
    /* opportunistic — never blocking */
  });
}
```

Called once in `bootIntroExperience`, RIGHT after the splash dismisses and BEFORE the long curse cutscene starts:

```ts
preloadVideoFile(cutscene.INTRO_VIDEOS.shattering);
```

**Why `fetch` instead of `<link rel="preload" as="video">`:** the Fetch spec does NOT include `video` in the valid `as` enum. Chrome / Firefox / Safari all log `<link rel=preload> uses an unsupported 'as' value` and IGNORE the hint. A plain `fetch()` with `cache: 'force-cache'` populates the HTTP cache the same way (browser dedups in-flight requests by cache-key). The body is intentionally never read — we only care about cache population, not memory.

By the time `enterGame` runs and `playIntroCutscene` assigns `<video>.src`, the file is already on disk; `<video>` reads it from cache with zero network round-trip and the decoder has stable frames from frame 1.

### 1b. Fold `mountApp` + audio module parses INTO the pre-cutscene wait

`enterGame` async block now awaits all heavy module fetches BEFORE the cutscene starts:

```ts
const mountAppPromise = loadMountAppModule();
const preloadModulePromise = loadDockPreloadModule();
const audioPromise = loadAudioModule();
const [preloadModule, audioModule] = await Promise.all([
  preloadModulePromise,
  audioPromise,
  mountAppPromise,
]);
await preloadModule.startIdleCraftDockPreload();
audioModule.setMusicMainMenuMode(false); // safe sync call now
```

**Worst-case extra wait before cutscene:** ~200-400 ms on a cold cache, invisible because `appRoot` is already a black screen at that moment. Total time-to-game is unchanged or slightly better — the wait was previously hidden inside cutscene playback as stutter.

### 1c. Music-mode flip moved out of synchronous `enterGame`

The fire-and-forget `void loadAudioModule().then((m) => m.setMusicMainMenuMode(false))` was removed from synchronous `enterGame`. The audio module is now resolved + the music-mode flip is a synchronous call inside the awaited block above. No more Promise resolving mid-cutscene.

**Net effect:** by the time the shattering `<video>` plays, the file is in HTTP cache, all chunks are parsed, the dock scene is fully built, and the only thing the main thread is doing is video decode + the rIC-deferred secondaries (audio init, system menu) which already ran during the FIRST (curse) cutscene.

---

## 2. Awakened-mode hit blood restore

**Symptom (player report):** "you deleted all the blood — when I hit an enemy / pvp player there should be the blood we had, just not when I'm not actually hitting something."

**Root cause history:**

- The dream-mode blood VFX system (`updateBattleBlood`) was originally fired from any swing/cast clip transition, including in awakened mode. In awakened mode this caused blood to spawn at the dream `enemyRoot` position (wherever it was last parked in the world), producing the "blood appears anywhere on the map after a kill" bug.
- A previous fix added an awakened-mode early-return at the top of `updateBattleBlood`. This eliminated the wrong-position blood — but ALSO eliminated all blood in awakened mode, which is what the player is reporting now.

**The right model:** blood == damage applied. Fire from the confirmed-hit codepath (`onMobDamaged` with `amount > 0`), not from the swing-button press.

### 2a. New public method on `CharacterScenePreview`

`spawnAwakenedHitBlood(x, faceY, z, intensity)`:

- Awakened-only (early-returns if `awakenedFreeRoam === false`)
- Reuses the dream `enemy_human_face_drip` preset's geometry: face burst at the hit point, drip strips falling DOWN, ground pool melding in as drips reach the floor
- Anchors at the actual mob's face/feet in world space:
  - `bloodAnchorWorld` = mob's footprint on ground (for floor pool)
  - `bloodFaceSnapshotWorld` = mob's face position (for burst + drip origin)
  - `bloodDripFallDist` = `faceY − BLOOD_GROUND_Y` (drip length scales with body height)
- Cloth-stain layer forced off (no dream rig sockets to attach shirt/pants meshes to)
- `bloodDripElapsed = BLOOD_FACE_DRIP_HEAD_START` so the burst + proto-drip read from frame 1 (no "blink in" pop)

### 2b. Wired into `mountApp.ts onMobDamaged`

```ts
if (amount > 0) {
  const maxHp = mob.maxHp || 1;
  const chipFrac = Math.min(1, amount / maxHp);
  const intensity = killed ? 1 : Math.max(0.4, chipFrac * 1.5);
  const faceOffset =
    mob.kind === 'rat' ? 0.5 : mob.kind === 'wolf' ? 0.95 : 1.55;
  scenePreview.spawnAwakenedHitBlood(
    mob.x,
    mob.y + faceOffset,
    mob.z,
    intensity,
  );
}
```

Per-kind face heights tuned to body silhouettes:

| Kind     | Face Y offset (m) |
|----------|-------------------|
| rat      | 0.5               |
| wolf     | 0.95              |
| wanderer | 1.55              |

Killing blows pin to `intensity = 1.0` (max gore); chips scale by HP fraction with a 0.4 floor so even a 1-damage chip still produces visible blood.

### 2c. Dream-mode path PRESERVED for review

The dream `updateBattleBlood` is unchanged. All dream battle hooks (`battle_strike`, `battle_cast`, `battle_enemy_strike`, `battle_enemy_death`, `battle_player_death`) still route through it. The dream-only gate (`if (this.awakenedFreeRoam) return;`) stays in place so the dream path can never accidentally fire in awakened mode.

**Verification matrix:**

| Action                                  | Blood? | Where                |
|-----------------------------------------|--------|----------------------|
| Press swing button at empty air         | NO     | (was the bug)        |
| Melee-hit a rat                         | YES    | At rat's face → ground |
| Melee-hit a wolf                        | YES    | At wolf's face → ground |
| Magic-bolt hits a wanderer              | YES    | At wanderer's face → ground (drip is taller) |
| Killing-blow on any mob                 | YES    | Maxed intensity      |
| Dream battle: card resolves with damage | YES    | Dream rig (unchanged) |
| Dream battle: card misses               | NO     | Unchanged            |

---

## Pending / known follow-ups

- **PvP awakened blood:** the `spawnAwakenedHitBlood` API is general (any world position + face Y), so when PvP gets a confirmed-hit awakened path it can call the same method. Today's PvP is dream-mode-only (turn-based card battles).
- **Cloth stains for awakened humanoid mobs:** the wanderer is humanoid and could carry shirt/pants stains with rig surface projection. Skipped for now (no rig sockets exposed); added complexity not justified given face/floor blood already reads clearly.
- **Non-mob hit blood (PvP turret, dummy):** same `spawnAwakenedHitBlood` API works — caller passes the target's face Y. No code change needed in `characterScenePreview` when those hooks land.

---

## Files touched

- `src/main.ts` — `preloadVideoFile()` helper, call in `bootIntroExperience`, fold module parses into pre-cutscene wait, removed sync audio fire-and-forget in `enterGame`
- `src/visual/characterScenePreview.ts` — new public `spawnAwakenedHitBlood()` method
- `src/ui/mountApp.ts` — `onMobDamaged` callback now spawns awakened blood on `amount > 0`

Type-check: green.
