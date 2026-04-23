/**
 * Lazy façade over `./gameAudio`.
 *
 * **Why this exists:** `gameAudio.ts` pulls in `./audioDock.css`, the music
 * transport (file decode + procedural fallback), the world SFX library, and
 * an AudioContext. It is heavy and only needed once the player produces a
 * gesture / enters the game shell.
 *
 * `core/gameStore.ts` and `ui/mountStartFlow.ts` are statically imported by
 * `src/main.ts`, so any module they statically import lands in the **main**
 * boot chunk. Routing them through this façade replaces those static paths
 * with a true dynamic `import()`, letting Vite emit `gameAudio` and its
 * dependencies as a separate chunk that loads after first paint.
 *
 * Every method is fire-and-forget; if the module hasn't loaded yet the call
 * is queued via the module promise's microtask and runs in the order issued.
 * `gameAudio` itself early-returns if the AudioContext isn't running, so a
 * sound issued before the user's first gesture is silently dropped — the
 * same behavior as calling the real module directly.
 */
type GameAudioModule = typeof import('./gameAudio');

let modulePromise: Promise<GameAudioModule> | null = null;

function loadGameAudio(): Promise<GameAudioModule> {
  return (modulePromise ??= import('./gameAudio'));
}

/**
 * Force the gameAudio chunk to load + parse NOW, returning the module
 * promise so callers can `await` if they want — but the typical caller
 * (the dock attach pipeline) just fires this and lets it run in parallel
 * with other preload work.
 *
 * **Why this exists (Phase 8j preload optimization):** the bridge defers
 * the gameAudio import until first SFX call (mob hit, swing, magic cast).
 * Without prewarm, the FIRST mob-encounter or first-cast pays the full
 * module-load + parse + AudioContext init cost mid-gameplay — visible as
 * a 100-300 ms hitch. Calling `prewarmAudioModule()` during the loading
 * veil window pulls that cost into the time the player is already waiting,
 * so combat starts instantly.
 *
 * Idempotent — repeated calls share the same promise.
 */
export function prewarmAudioModule(): Promise<unknown> {
  return loadGameAudio();
}

export function playWorldSoundForGather(actionId: string): void {
  void loadGameAudio().then((m) => m.playWorldSoundForGather(actionId));
}

/**
 * Per-hit chop/pick/pluck SFX during awakened-mode multi-hit harvest. Pass the
 * `FreeRoamHarvestKind` (e.g. `'wood'`, `'mine_iron_ore'`, `'magic_crystal'`) — the
 * audio module maps to the right material profile. Safe to fire 5+ times per second.
 */
export function playHarvestProgressSound(harvestKind: string): void {
  void loadGameAudio().then((m) => m.playHarvestProgressSound(harvestKind));
}

/**
 * Climactic break SFX (tree-fall crash, boulder crumble, etc.) when a node is fully
 * harvested and despawning. Fires once per node death.
 */
export function playHarvestBreakSound(harvestKind: string): void {
  void loadGameAudio().then((m) => m.playHarvestBreakSound(harvestKind));
}

/**
 * Bucket-fill water-gather SFX — dip + sustained pour + drip tail. Fires once per
 * E press near water in awakened mode. Routes through the harvest sub-bus so the
 * "Harvest sounds" slider controls volume.
 */
export function playWaterGatherSound(): void {
  void loadGameAudio().then((m) => m.playWaterGatherSound());
}

/* ---- Movement SFX (awakened free-roam: footsteps, jump, double jump, landing) ---- */

export function playFootstepSound(foot: 'L' | 'R'): void {
  void loadGameAudio().then((m) => m.playFootstepSound(foot));
}
export function playJumpSound(): void {
  void loadGameAudio().then((m) => m.playJumpSound());
}
export function playDoubleJumpSound(): void {
  void loadGameAudio().then((m) => m.playDoubleJumpSound());
}
/** @param intensity 0..1 — scales landing weight; map fall velocity to this. */
export function playLandSound(intensity?: number): void {
  void loadGameAudio().then((m) => m.playLandSound(intensity));
}
/**
 * Bouncy-mushroom trampoline boing (Phase 8l). Triangle wave squish (220 → 660 Hz
 * over 80 ms) + low-pass-swept noise burst. `intensity` 0..1.5 scales gain so a
 * heavy drop reads heavier than a light brush. Routed through the movement-SFX
 * sub-bus alongside footsteps / jump / land.
 */
export function playMushroomBounceSound(intensity?: number): void {
  void loadGameAudio().then((m) => m.playMushroomBounceSound(intensity));
}

/* ---- Awakened-mode combat SFX (Phase 1.5) ---- */

/**
 * Per-mob hit SFX (rat squeak / wolf yelp / wanderer grunt). `volumeScale` is the
 * proximity-audio attenuation factor (0..1) — see `awakenedMobs.ts distanceVolumeScale`
 * for the curve. Defaults to 1.0 for legacy / non-positional callers.
 *
 * Volume-zero short-circuit: when proximity attenuation evaluates to zero (mob is
 * past `AUDIO_SILENT_RANGE`), we skip the lazy-load + Promise.then chain entirely.
 * Avoids 30-50 microtasks per second of fully-attenuated mob SFX during steady-state
 * combat with 6 mobs alive — small wins that compound when everything else is
 * already efficient.
 */
export function playMobHitSound(kind: 'rat' | 'wolf' | 'wanderer', volumeScale = 1.0): void {
  if (volumeScale <= 0) return;
  void loadGameAudio().then((m) => m.playMobHitSound(kind, volumeScale));
}
/** Per-mob death SFX — long descending voice + body thud. `volumeScale` see above. */
export function playMobDeathSound(kind: 'rat' | 'wolf' | 'wanderer', volumeScale = 1.0): void {
  if (volumeScale <= 0) return;
  void loadGameAudio().then((m) => m.playMobDeathSound(kind, volumeScale));
}
/** Player melee swing whoosh — fires every LMB with no-weapon / axe / sword. */
export function playPlayerSwingSound(): void {
  void loadGameAudio().then((m) => m.playPlayerSwingSound());
}
/** Player magic cast — fires every LMB with wand/staff equipped + mana available. */
export function playPlayerMagicCastSound(): void {
  void loadGameAudio().then((m) => m.playPlayerMagicCastSound());
}
/** Melee impact — fires when a swing's raycast lands on a mob (separate from the mob's voice). */
export function playMeleeImpactSound(volumeScale = 1.0): void {
  if (volumeScale <= 0) return;
  void loadGameAudio().then((m) => m.playMeleeImpactSound(volumeScale));
}
/** Magic impact — fires when an orb lands on a mob. */
export function playMagicImpactSound(volumeScale = 1.0): void {
  if (volumeScale <= 0) return;
  void loadGameAudio().then((m) => m.playMagicImpactSound(volumeScale));
}
/** Per-mob footstep (rat / wolf / wanderer) — mob walk-cycle audio. `volumeScale` see above. */
export function playMobFootstepSound(kind: 'rat' | 'wolf' | 'wanderer', volumeScale = 1.0): void {
  if (volumeScale <= 0) return;
  void loadGameAudio().then((m) => m.playMobFootstepSound(kind, volumeScale));
}

export function playConsumeSound(kind: 'meat' | 'berries' | 'water'): void {
  void loadGameAudio().then((m) => m.playConsumeSound(kind));
}

export function setBattleMusicMode(on: boolean): void {
  void loadGameAudio().then((m) => m.setBattleMusicMode(on));
}

/**
 * Resolves once the audio module is loaded and `resumeAndStartMusic` has run.
 * Callers that don't await are still ordered correctly via the module promise.
 */
export function resumeAndStartMusic(): Promise<void> {
  return loadGameAudio().then((m) => m.resumeAndStartMusic());
}
