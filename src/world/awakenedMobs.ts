/**
 * Awakened-mode hostile mob system (Phase 1.5 — see
 * `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` §13.4).
 *
 * Spawns + renders + AI-ticks a wave of mobs (rats / wolves / wanderers) that path
 * toward the player and attack in melee range. Reuses the existing PvE LPCA visuals
 * (`createPveEnemyLPCA('e_rat' | 'e_wolf' | 'e_rival')`) so the awakened mobs visually
 * match the deck-mode battle enemies.
 *
 * **Lifecycle:**
 *   - `update(dt, playerXZ)` runs the wave timer (spawns one mob every `WAVE_INTERVAL_MS`
 *     while alive count < `MAX_ALIVE`, 25 m+ from the player), advances each mob's AI
 *     state machine, applies movement, syncs collision footprints, animates death.
 *   - `damage(id, amount, fromXZ)` reduces a mob's HP via the store; mob enters `dying`
 *     state at 0 HP, plays the death animation for `DEATH_ANIM_MS`, then despawns.
 *   - `dispose()` clears all mobs + footprints.
 *
 * **AI state machine** (per mob):
 *   - `idle`: wander a random short distance every ~3 s.
 *   - `chase`: walk toward player at walkSpeed when within aggro range.
 *   - `attack`: when within melee range, apply damage every `attackCooldownMs`.
 *   - `dying`: HP=0, freeze animation, despawn after `DEATH_ANIM_MS` elapsed.
 *
 * **Collision integration:**
 *   - Each mob registers a circle footprint with `collisionWorld` (tag: 'mob') so the
 *     player's movement resolves around them AND the player's combat raycasts can hit
 *     mobs by ownerId.
 *   - On death, footprint is unregistered so the corpse fade doesn't block movement.
 *   - Mob movement itself doesn't collide-resolve against pieces this session — they
 *     path direct toward the player. Phase 4 polish adds proper navigation around
 *     player walls / fortifications.
 *
 * **Phantom-light rule:** mobs use only emissive accents (e.g. dream_hound's cyan
 * eye-glow when added later). No `THREE.PointLight` per mob.
 */
import * as THREE from 'three';
import type { AwakenedMobInstance, AwakenedMobKind } from '../core/types';
import { AWAKENED_MOB_STATS } from '../core/gameStore';
import { createPveEnemyLPCA, type PveEnemyLPCA } from '../visual/pveEnemyLPCA';
import { playMobDeathSound, playMobFootstepSound } from '../audio/audioBridge';
import type { CollisionWorldHandle } from './collisionWorld';

/* ============================================================================
 * Constants
 * ============================================================================ */

const MAX_ALIVE = 6;
/**
 * Wave spawn cadence (ms). Cut from 25 s → 12 s in Phase 8h pending pass — at
 * 25 s + a heavy 60/30/10 rat/wolf/wanderer weighting at `pveWave = 0`, a
 * typical 90 s session would only see 3 spawns, all rats with high probability.
 * Players were reporting "I never see wolves or wanderers in awakened mode."
 * 12 s lets the wave fill to MAX_ALIVE in ~75 s and gives the kind-variety
 * bias (`pickMobKind`'s recent-spawn anti-clump) enough samples to actually
 * vary the mix.
 */
const WAVE_INTERVAL_MS = 12_000;
const SPAWN_MIN_DIST = 25;
const SPAWN_MAX_DIST = 32;
/** Death animation window (ms) — fall-over + scale-fade plays during this window.
 * After it elapses, mobs with loot transition to the `corpse` state (see below);
 * mobs without loot (wanderer) despawn immediately. */
const DEATH_ANIM_MS = 1500;
/**
 * How long a mob corpse stays around for the player to skin (E interaction).
 * 60 s is plenty of time to walk over, square up, and press E without feeling
 * rushed. After this elapses the corpse despawns whether or not the player got
 * to it — keeps the world clean during long sessions.
 */
const CORPSE_PERSIST_MS = 60_000;
/**
 * Per-mob-kind loot table — currency dropped on kill (immediately credited to
 * the player) + meat dropped via E-skin interaction (only awarded when the
 * player actually walks over and skins the corpse).
 *
 * Wanderer drops more currency (humanoid raider) but no meat — the existing
 * inventory schema only has `cooked_meat` / `raw_meat` for animal sources.
 * Adding human-loot variety (cloth scraps, herbs, stolen coin) is a future
 * polish pass; the current table covers the player's "kill rats / wolves to
 * cook" flow.
 */
export interface MobLoot {
  currency: number;
  /** Raw meat units dropped on skin. 0 = mob can't be skinned (no corpse persist). */
  meat: number;
}
export const MOB_LOOT: Record<AwakenedMobKind, MobLoot> = {
  rat:      { currency: 1,  meat: 1 },
  wolf:     { currency: 3,  meat: 3 },
  wanderer: { currency: 10, meat: 0 },
};
/** Per-mob collision footprint radius (world units). */
const MOB_FOOTPRINT_RADII: Record<AwakenedMobKind, number> = {
  rat: 0.32,
  wolf: 0.5,
  wanderer: 0.45,
};
/**
 * Per-mob shoulder height above `mob.y` (which is at the mob's feet). Used as the
 * `topY` on the collision footprint so the player can:
 *   - jump over a rat trivially (single hop apex ~1.84 m clears 0.45 m),
 *   - jump over a wolf with a normal jump,
 *   - need to dodge sideways around a wanderer (1.8 m tall = harder to clear).
 */
const MOB_HEIGHT: Record<AwakenedMobKind, number> = {
  rat: 0.45,
  wolf: 1.1,
  wanderer: 1.8,
};
/**
 * Aggro hysteresis padding (meters) — once a mob has aggro'd, it KEEPS aggro until the
 * player escapes `aggroRange + AGGRO_RELEASE_PAD`. Without this, mobs flicker chase↔idle
 * at the aggro boundary every frame and look schizophrenic. Mirrors the lock-on
 * acquire/release hysteresis at `lockOnController.ts`.
 *
 * Tightened from 8 → 5 m: a player sprinting away (1.8 m/s faster than wolf walk)
 * crosses 5 m of post-aggroRange escape in ~3 s, so de-aggro feels prompt instead
 * of taking forever. Combined with the smaller AGGRO_LEASE_MS, the player can
 * outrun a mob and feel them disengage cleanly.
 */
const AGGRO_RELEASE_PAD = 5;
/**
 * If a mob has been "aggro'd but not making progress" for this long, it gives up and
 * resets to passive. Was 12 s — too long; the player asked for "outrun and turn passive
 * again" feel. 5 s lease means a sprinting player who breaks line-of-sight or distance
 * will see the mob disengage in roughly the time it takes to count to five. Still long
 * enough that a player who momentarily dodges (1-2 s gap) doesn't get a free unaggro.
 */
const AGGRO_LEASE_MS = 5_000;
/**
 * Audio attenuation curve — full volume within FULL_RANGE m, falls off via
 * `1 / (1 + (d - FULL_RANGE) / FALLOFF_SCALE)` past it, hard-clamps to silence past
 * SILENT_RANGE. Steepened in the player-feedback pass so distant mobs are nearly
 * silent — was "wolf at 25 m audible at 35 %" which made it impossible to tell from
 * audio whether a mob was THREATENING or just present. New curve:
 *   - 0-5 m   : full volume (mob is right there).
 *   - 10 m   : 50 % (audibly closer/farther — "approaching").
 *   - 18 m   : 33 % (background presence — "they're around").
 *   - 30 m   : 20 % (faint — "something's out there").
 *   - 38-45 m : linear fade to zero.
 * Combined with the new tighter aggro ranges (rat 8 m / wolf 14 m / wanderer 12 m),
 * the audio crescendo lines up with the aggro engagement: as a mob gets close enough
 * to aggro, you can clearly hear them. Same curve drives footstep + hit + death + cast SFX.
 */
const AUDIO_FULL_RANGE = 5;
const AUDIO_FALLOFF_SCALE = 5;
const AUDIO_SILENT_RANGE = 45;

/**
 * Maps a mob-to-listener distance (XZ) to a [0..1] volume scale. Cheap; called per SFX
 * trigger (a few times per second per mob in worst case). Inlined math for the hot path.
 */
function distanceVolumeScale(distXZ: number): number {
  if (distXZ >= AUDIO_SILENT_RANGE) return 0;
  if (distXZ <= AUDIO_FULL_RANGE) return 1;
  /* Inverse-distance falloff past full-volume range. */
  const past = distXZ - AUDIO_FULL_RANGE;
  const inv = 1 / (1 + past / AUDIO_FALLOFF_SCALE);
  /* Linear fade over the last 7 m to reach exact zero at SILENT_RANGE — keeps the
   * tail clean instead of leaving a faint inv-curve residue out to infinity. */
  const fadeStart = AUDIO_SILENT_RANGE - 7;
  const fade = distXZ > fadeStart ? Math.max(0, 1 - (distXZ - fadeStart) / 7) : 1;
  return inv * fade;
}
/**
 * Distance per audible footstep, per kind. Smaller = more footsteps per meter walked.
 * Tuned so a chasing rat skitters fast (~3 steps/sec at 4.5 m/s = 1.5 m / step), a
 * wolf pads at ~2 steps/sec (5.5 m/s, 2.75 m / step), a wanderer thuds at ~1.5
 * steps/sec (3.5 m/s, 2.3 m / step). Wander state's slower walk-speed naturally
 * spaces the cadence out further. */
const MOB_STEP_LENGTH: Record<AwakenedMobKind, number> = {
  rat: 1.5,
  wolf: 2.75,
  wanderer: 2.3,
};
/** Map AwakenedMobKind -> existing PveEnemy id (so we can reuse the LPCAs as-is). */
const MOB_KIND_TO_PVE_ID: Record<AwakenedMobKind, string> = {
  rat: 'e_rat',
  wolf: 'e_wolf',
  wanderer: 'e_rival',
};
/**
 * Per-kind authored-yaw offset baked into the PVE LPCAs. The dream-mode battle path
 * pre-rotates the rat / wolf root by `Math.PI * 1.5` so they face the player
 * correctly when the dream `enemyRoot` carries `gatherFaceY` yaw (see
 * `pveEnemyLPCA.ts` lines 583-587 — the comment there explains the +X authoring).
 *
 * In awakened mode we OWN the LPCA group's `rotation.y` directly (we use it to face
 * the player every frame), which means we must add the same offset back in or the
 * model renders sideways. Wanderer (`e_rival`) is authored along +Z so its offset is 0.
 *
 * Without this fix the rat/wolf chase the player but visually face perpendicular to
 * their motion — exactly the "they're following you sideways" bug reported.
 */
const MOB_MODEL_YAW_OFFSET: Record<AwakenedMobKind, number> = {
  rat: Math.PI * 1.5,
  wolf: Math.PI * 1.5,
  wanderer: 0,
};

/**
 * Attack cycle phases — every melee attack now goes WIND-UP -> STRIKE -> RECOVER
 * instead of "instantly dealing damage at the moment cooldown clears". The phases give
 * the player a visible telegraph (lunge in, bite, lunge back) and a chance to dodge or
 * back away during wind-up.
 *
 * Total cycle = WINDUP_MS + STRIKE_MS + RECOVER_MS. Damage fires ONCE at the start of
 * STRIKE — and only if the player is still inside `meleeRange + LUNGE_REACH` at that
 * moment. If the player dodged, the bite hits empty air and the mob recovers + retries.
 *
 * Lunge offset (m) — how far the LPCA group visually pushes forward from the mob's
 * resting position at strike-peak. Combined with `meleeRange` to compute the bite
 * envelope. Same value drives the visual + the damage gate so they stay in sync.
 */
const ATTACK_WINDUP_MS = 220;
const ATTACK_STRIKE_MS = 110;
const ATTACK_RECOVER_MS = 230;
const ATTACK_LUNGE_REACH = 0.5;
type AttackPhase = 'idle' | 'windup' | 'strike' | 'recover';
/** Wave kind weighting by `pveWave`.
 *
 * Awakened-mode players who haven't progressed dream-mode battles sit at
 * `pveWave = 0` indefinitely — the old "rats only until wave 2" / "wanderers
 * only at wave 5+" gates meant most players never saw a wolf or wanderer in
 * awakened. ALL three kinds appear from wave 0; the `recentSpawns` history
 * array fed in by the caller biases AGAINST kinds we've spawned recently so
 * the player sees variety even in short sessions.
 *
 * **Anti-clump algorithm (Phase 8h pending pass):** count occurrences of each
 * kind in the last N spawns. Multiply the kind's base weight by
 * `1 / (1 + 0.6 * recentCount)` so a kind that spawned twice in the last
 * window has its weight cut to ~45 %, three times to ~30 %. After ~3-4
 * spawns of a single kind, even with rat-heavy base weights, wolves and
 * wanderers become significantly more likely. Player gets variety quickly
 * without losing the "starter zone is rats" tonal anchor.
 */
function pickMobKind(
  pveWave: number,
  rand: () => number,
  recentSpawns: ReadonlyArray<AwakenedMobKind>,
): AwakenedMobKind {
  /* Base weights (unbiased) — from the original 60/30/10 rat-heavy starter,
   * 40/40/20 mid, 30/35/35 late. Same totals; just exposed as a record so
   * the anti-clump pass can apply a per-kind multiplier cleanly. */
  let baseRat: number, baseWolf: number, baseWanderer: number;
  if (pveWave < 2) {
    baseRat = 0.60; baseWolf = 0.30; baseWanderer = 0.10;
  } else if (pveWave < 5) {
    baseRat = 0.40; baseWolf = 0.40; baseWanderer = 0.20;
  } else {
    baseRat = 0.30; baseWolf = 0.35; baseWanderer = 0.35;
  }
  /* Anti-clump: penalise kinds we've seen recently. */
  let countRat = 0, countWolf = 0, countWanderer = 0;
  for (const k of recentSpawns) {
    if (k === 'rat') countRat++;
    else if (k === 'wolf') countWolf++;
    else countWanderer++;
  }
  const wRat = baseRat / (1 + 0.6 * countRat);
  const wWolf = baseWolf / (1 + 0.6 * countWolf);
  const wWanderer = baseWanderer / (1 + 0.6 * countWanderer);
  const total = wRat + wWolf + wWanderer;
  const r = rand() * total;
  if (r < wRat) return 'rat';
  if (r < wRat + wWolf) return 'wolf';
  return 'wanderer';
}

/* ============================================================================
 * Public handle
 * ============================================================================ */

export interface AwakenedMobsHandle {
  /**
   * Per-frame: advance wave spawning + AI ticks. `playerPos` includes Y so the AI can
   * detect when the player has jumped above the mob (jump-immunity gate — see §13.6 of
   * the master plan + the AI implementation below). Cheap when no mobs are alive.
   */
  update(dtSec: number, playerPos: { x: number; y: number; z: number }): void;
  /**
   * Apply damage to a mob. Returns true if the hit took the mob to 0 HP. Caller can
   * spawn impact VFX / SFX based on the result.
   */
  /**
   * Apply damage. `source` defaults to `'melee'` (legacy callers preserved); pass
   * `'magic'` from the projectile system so kill rewards can route differently —
   * magic kills auto-grant meat at impact + skip the corpse-persist phase (the
   * player is too far away to walk over and skin), while melee kills keep the
   * existing "leaves a corpse for E-skin" loop. Returns true on lethal hit.
   */
  damage(
    id: number,
    amount: number,
    fromXZ: { x: number; z: number },
    source?: 'melee' | 'magic',
  ): boolean;
  /** Lookup mob by id (used by lock-on target snapshots + projectile homing). */
  getMob(id: number): AwakenedMobInstance | null;
  /** All currently-alive mobs (lock-on cone scan + targeting UI). */
  getAllMobs(): ReadonlyArray<AwakenedMobInstance>;
  /**
   * Find the nearest mob `corpse` within `radius` meters of the given avatar XZ.
   * Returns the mob (still in the store list, `state === 'corpse'`) so the caller
   * can read its kind for loot lookups + render the "Press E to skin" prompt.
   * Null when no corpse is in range.
   */
  getCorpseNearAvatar(avatarXZ: { x: number; z: number }, radius?: number): AwakenedMobInstance | null;
  /**
   * Skin a corpse — despawn its render + remove from the store list. Returns the
   * mob's loot (currency already credited at kill-time, so just `meat` here) so
   * the caller can grant the reward + play SFX. No-op when the mob isn't a
   * corpse (e.g., it's still dying or already despawned). Returns null on no-op.
   */
  skinCorpse(id: number): { kind: AwakenedMobKind; meat: number } | null;
  /** Pre-compile mob shader programs at boot to avoid first-spawn freeze. */
  warmShaders(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void;
  /**
   * Returns the proximity-audio volume scale (0..1) for an SFX emitted at world `(x, z)`,
   * using the mob system's last-known listener position (refreshed each `update`).
   * Lets sibling combat modules (`magicProjectiles`, `awakenedCombat`) attenuate their
   * impact / hit voices without each one having to plumb the listener position
   * separately. Returns 1 if the listener position hasn't been set yet.
   */
  getProximityVolumeScale(x: number, z: number): number;
  /**
   * Despawn ALL live mob renders + footprints + reset internal state. Called when the
   * player dies (so post-respawn the world is peaceful) or when the realm flips back
   * to deck mode. The store-side mob list is cleared by `gameStore.clearAwakenedMobs()`
   * separately — this handle just cleans up the visual + collision side. Idempotent
   * (safe to call when no mobs are alive).
   */
  clearAll(): void;
  /** Detach + dispose every mob LPCA + footprint. */
  dispose(): void;
}

interface AttachOpts {
  scene: THREE.Scene;
  /** Heightfield sampler — same one the dock + free-roam controls use. */
  getTerrainHeight: (x: number, z: number) => number;
  mapRadius: number;
  /** Live store reference — used for spawn / damage / read mob state. */
  store: {
    spawnAwakenedMob: (kind: AwakenedMobKind, x: number, y: number, z: number) => AwakenedMobInstance;
    damageAwakenedMob: (id: number, amount: number) => boolean;
    removeAwakenedMob: (id: number) => void;
    getActiveAwakenedMobs: () => ReadonlyArray<AwakenedMobInstance>;
    damagePlayerInAwakened: (amount: number, sourceKind: string) => void;
    getState: () => { pveWave: number };
  };
  /** Optional collision world; when provided, mob footprints are registered. */
  collisionWorld?: CollisionWorldHandle;
  /**
   * Optional audio hooks — when set (e.g. render worker), footstep/death SFX route
   * here instead of `audioBridge` (workers must not import main-thread audio).
   */
  mobAudio?: {
    playFootstep: (kind: AwakenedMobKind, volumeScale: number) => void;
    playDeath: (kind: AwakenedMobKind, volumeScale: number) => void;
  };
  /**
   * Optional damage-dealt observer — fires every time the player damages a mob, with
   * the actual amount applied (after any future resists) and the mob's world position
   * at the moment of the hit. Used by `damageFloaters` to spawn world-anchored
   * floating damage numbers above the mob's head. Pure side-channel; mob behavior
   * is unaffected by whether this callback is provided. The mob's chest is at
   * roughly `y + 1.0` for rats and `y + 1.4` for wolves/wanderers — the consumer
   * can add a small Y offset for visual headroom.
   */
  onMobDamaged?: (
    mob: AwakenedMobInstance,
    amount: number,
    killed: boolean,
    /** `'magic'` for projectile/spell hits, `'melee'` for swings (default). Lets
     * mountApp route ranged kills to auto-loot + spawn a meat floater while
     * keeping melee kills on the legacy walk-over-and-press-E corpse loop. */
    source?: 'melee' | 'magic',
  ) => void;
}

/* ============================================================================
 * Implementation
 * ============================================================================ */

export function attachAwakenedMobs(opts: AttachOpts): AwakenedMobsHandle {
  const root = new THREE.Group();
  root.name = 'AwakenedMobsRoot';
  opts.scene.add(root);

  /** Per-mob LPCA + scratch state (separate from store-side `AwakenedMobInstance`). */
  interface MobRender {
    lpca: PveEnemyLPCA;
    /** Wander target XZ for `idle` state. */
    wanderTargetX: number;
    wanderTargetZ: number;
    /** Real-time ms when the next wander destination should be picked. */
    nextWanderAtMs: number;
    /**
     * Footstep cadence — accumulates distance traveled since the last footstep SFX.
     * When the accumulated distance exceeds the per-kind step length, fires one
     * footstep + resets. Frame-rate independent + naturally scales footstep frequency
     * with how fast the mob is moving (chase fires faster than wander).
     */
    distSinceLastStep: number;
    /**
     * Hysteresis "aggro latch" — once true, the mob will chase / attack until the
     * player escapes past `aggroRange + AGGRO_RELEASE_PAD`. Without this, mobs
     * flicker in-and-out at the aggro boundary every frame. Mirrors the lock-on
     * acquire/release pattern. Initialized false (mob spawns passive).
     */
    aggro: boolean;
    /**
     * Real-time ms when the current aggro "lease" expires. Refreshed each frame the
     * mob makes progress toward the player; if the timer runs out, aggro is forcibly
     * released (covers the parkour-onto-the-roof case where the mob can't path).
     */
    aggroLeaseExpiresMs: number;
    /**
     * Last frame's distance to the player — used to detect "no progress" (mob is
     * blocked). When this stays within ~0.05 m for several frames while aggro'd, the
     * lease is allowed to drain naturally instead of being refreshed.
     */
    lastDistToPlayer: number;
    /**
     * LPCA-internal grounding offset. The PVE LPCA factory positions its root at
     * `y = -groundBox.min.y` so the model's feet sit at world Y = 0 of its own frame
     * (see `pveEnemyLPCA.ts` line 591). When awakened mode set
     * `lpca.group.position.set(x, terrainY, z)` directly, that offset was CLOBBERED —
     * meaning the wanderer (taller than rats / wolves) sank into the terrain by its
     * grounding offset (~1 m). Capture the offset at spawn time and re-add it every
     * frame's position sync so the wanderer's feet land on terrain, not its waist.
     */
    groundOffsetY: number;
    /**
     * Attack-cycle phase. Drives the lunge animation + gates when damage actually fires.
     * Replaces the old "damage on cooldown" instant-hit pattern. Lifecycle:
     *   - `idle`   : mob is in melee range but not attacking; ready to start when
     *                `attackReadyMs` elapses.
     *   - `windup` : 220 ms telegraph; mob slowly leans forward (small forward offset).
     *                Player can back off during this window to dodge.
     *   - `strike` : 110 ms bite; mob lunges to peak forward offset (`ATTACK_LUNGE_REACH`).
     *                Damage fires ONCE on entry to this phase — gated by a fresh distance
     *                check using the lunge-extended reach (so a dodging player ESCAPES).
     *   - `recover`: 230 ms wind-down; mob lerps back to neutral. Cannot start a new
     *                attack until recovery ends.
     */
    attackPhase: AttackPhase;
    /** Real-time ms when the current attack phase began. */
    attackPhaseStartMs: number;
  }
  const renderById = new Map<number, MobRender>();
  /**
   * Mob ids killed by ranged magic that should SKIP the corpse-persist phase
   * (despawn immediately when the death animation completes instead of leaving
   * a 60 s "press E to skin" body). Marked in `damage()` when `source === 'magic'`
   * AND `killed === true`; consumed in the per-frame dying→corpse transition.
   * Cleared on consume + on `clearAll()`. Idempotent set semantics so duplicate
   * kill calls (shouldn't happen, but defensive) don't leak. */
  const rangedKillNoCorpse = new Set<number>();
  /**
   * Far-passive tick phase counter (Phase 8j optimization). 0..2 ring counter
   * incremented per `update` frame. Distant non-aggro'd mobs only tick when
   * `farPassiveTickPhase === mob.id % 3` — staggers the work so 3 distant
   * passive mobs don't all skip the same frame and produce a visible "jitter
   * 1 frame, 3 frames smooth" pattern.
   *
   * Aggro'd mobs ignore this and always tick every frame so combat stays
   * responsive. `FAR_PASSIVE_TICK_DIST` is the threshold below which mobs
   * tick every frame regardless of aggro state — keeps mobs near the player
   * snappy even before they aggro. */
  let farPassiveTickPhase = 0;
  const FAR_PASSIVE_TICK_DIST = 22;
  /**
   * Last known player XZ — refreshed every `update()` call. Used by `damage()` (which
   * fires from the combat system, NOT from inside the AI tick) to compute proximity-
   * audio attenuation for the mob hit/death voice without needing the caller to thread
   * the listener position through. Defaults to (0, 0) until the first update.
   */
  let lastPlayerX = 0;
  let lastPlayerZ = 0;

  /** Wall-clock ms when the next wave-spawn check fires. */
  let nextSpawnCheckAtMs = Date.now() + WAVE_INTERVAL_MS;
  /**
   * Ring buffer of the last N spawned mob kinds — fed into `pickMobKind` so
   * its anti-clump bias can penalise repeats. 5 deep is enough to ensure
   * the player sees all three kinds within ~6-8 spawns even at the rat-heavy
   * starter weighting (60/30/10 base) — without it, a streak of "rat rat
   * rat rat rat" was perfectly possible and matched the user-reported
   * "I never see wolves or wanderers in awakened mode."
   */
  const recentSpawnKinds: AwakenedMobKind[] = [];
  const RECENT_SPAWN_HISTORY = 5;

  function mobOwnerId(id: number): string {
    return `mob:${id}`;
  }

  /**
   * Spawn one mob at a random angle around the player at SPAWN_MIN_DIST..SPAWN_MAX_DIST.
   * Picks the mob kind based on `pveWave` weighting. Builds the LPCA, parents it, syncs
   * the position. Registers a collision footprint.
   */
  function spawnOne(playerXZ: { x: number; z: number }): void {
    /* Retry up to N times if the random ring-pick lands off-map (player near the
     * edge case). Without retries, the wave attempt was silently wasted whenever
     * the player was within ~30 m of the boundary — and that's exactly when fights
     * tend to happen because players explore the perimeter. 6 tries gives us very
     * high odds of finding a valid spawn while still bounding the worst-case CPU
     * cost. After 6 fails we just give up this wave attempt (the next wave check
     * fires WAVE_INTERVAL_MS later). */
    let x = 0;
    let z = 0;
    let foundSpawn = false;
    const safeR = opts.mapRadius - 1.5;
    for (let attempt = 0; attempt < 6; attempt++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = SPAWN_MIN_DIST + Math.random() * (SPAWN_MAX_DIST - SPAWN_MIN_DIST);
      const tx = playerXZ.x + Math.cos(ang) * dist;
      const tz = playerXZ.z + Math.sin(ang) * dist;
      if (Math.hypot(tx, tz) <= safeR) {
        x = tx;
        z = tz;
        foundSpawn = true;
        break;
      }
    }
    if (!foundSpawn) return;
    const y = opts.getTerrainHeight(x, z);
    const kind = pickMobKind(opts.store.getState().pveWave, Math.random, recentSpawnKinds);
    /* Track in the recent-spawns ring buffer so the next pick can bias against
     * this kind (anti-clump). */
    recentSpawnKinds.push(kind);
    if (recentSpawnKinds.length > RECENT_SPAWN_HISTORY) recentSpawnKinds.shift();
    const mob = opts.store.spawnAwakenedMob(kind, x, y, z);
    const lpca = createPveEnemyLPCA(MOB_KIND_TO_PVE_ID[kind]);
    /* Capture the LPCA's internal grounding offset BEFORE we overwrite the position.
     * The factory set `root.position.y = -groundBox.min.y` so that y=0 in its local
     * frame puts the model's feet on the ground. We need to re-add that every frame
     * we set the position (otherwise wanderer sinks into terrain). */
    const groundOffsetY = lpca.group.position.y;
    lpca.group.position.set(x, y + groundOffsetY, z);
    root.add(lpca.group);
    renderById.set(mob.id, {
      lpca,
      wanderTargetX: x,
      wanderTargetZ: z,
      nextWanderAtMs: Date.now() + 1000 + Math.random() * 2000,
      distSinceLastStep: 0,
      aggro: false,
      aggroLeaseExpiresMs: 0,
      lastDistToPlayer: Infinity,
      groundOffsetY,
      attackPhase: 'idle',
      attackPhaseStartMs: 0,
    });
    if (opts.collisionWorld) {
      opts.collisionWorld.register({
        kind: 'circle',
        x, z,
        r: MOB_FOOTPRINT_RADII[kind],
        ownerId: mobOwnerId(mob.id),
        blocking: true,
        tag: 'mob',
        bottomY: y,
        topY: y + MOB_HEIGHT[kind],
      });
    }
  }

  function despawnRender(id: number): void {
    const render = renderById.get(id);
    if (render) {
      root.remove(render.lpca.group);
      render.lpca.dispose();
      renderById.delete(id);
    }
    if (opts.collisionWorld) opts.collisionWorld.unregister(mobOwnerId(id));
  }

  /**
   * Move the mob from `(preX, preZ)` toward `(toX, toZ)` and have the collision world
   * push it out of any blocking footprint (cabin pieces, trees, ore nodes, the player,
   * other mobs). When `collisionWorld` is absent (test/headless), falls through to
   * a direct write. Always clamps the final XZ inside `mapRadius` so a chase or wander
   * can't drift the mob off the playable disc — without this clamp, a wolf chasing a
   * player who circled near the edge could end up beyond the map and walk forever
   * looking for a way back (the user reported "wolf spawning off map and can't get
   * back on" — the spawn check was correct, but wander/chase drift wasn't).
   */
  function moveMobWithCollision(
    mob: AwakenedMobInstance,
    preX: number,
    preZ: number,
    toX: number,
    toZ: number,
  ): void {
    let nx = toX;
    let nz = toZ;
    if (opts.collisionWorld) {
      const resolved = opts.collisionWorld.resolveCircleMove(
        mobOwnerId(mob.id),
        preX, preZ,
        nx, nz,
        MOB_FOOTPRINT_RADII[mob.kind],
      );
      nx = resolved.x;
      nz = resolved.z;
    }
    /* Clamp to map disc — same `mapRadius - footprint - margin` rule the spawn uses,
     * so a wolf at the edge slides along the boundary instead of walking through it. */
    const r = Math.hypot(nx, nz);
    const safeR = opts.mapRadius - MOB_FOOTPRINT_RADII[mob.kind] - 0.5;
    if (r > safeR) {
      const k = safeR / r;
      nx *= k;
      nz *= k;
    }
    mob.x = nx;
    mob.z = nz;
  }

  function update(dtSec: number, playerPos: { x: number; y: number; z: number }): void {
    const nowMs = Date.now();
    const mobs = opts.store.getActiveAwakenedMobs();
    /* Cache the listener position so `damage()` and other ad-hoc SFX triggers can
     * compute proximity-audio attenuation without callers having to thread it
     * through every code path. */
    lastPlayerX = playerPos.x;
    lastPlayerZ = playerPos.z;
    /* Orphan cleanup — if the store's mob list was cleared externally (e.g.
     * `dieAndWipe` -> `clearAwakenedMobs`) but our render map still has entries,
     * despawn them now. Without this, dead-and-respawned players would see ghost
     * mob renders that no longer correspond to any AI state. Cheap when there
     * are no orphans (the renderById set check is O(1)). */
    if (mobs.length === 0 && renderById.size > 0) {
      for (const id of Array.from(renderById.keys())) despawnRender(id);
    }

    /* Wave spawn check — only when alive count is below cap. */
    if (nowMs >= nextSpawnCheckAtMs) {
      nextSpawnCheckAtMs = nowMs + WAVE_INTERVAL_MS;
      const aliveCount = mobs.filter((m) => m.state !== 'dying').length;
      if (aliveCount < MAX_ALIVE) {
        spawnOne({ x: playerPos.x, z: playerPos.z });
      }
    }

    /* Per-mob AI tick + render sync. Iterate by index BACKWARDS so despawns
     * (which call `mobs.splice(i, 1)` via `removeAwakenedMob`) don't shift the
     * indices of mobs we haven't visited yet. Avoids the per-frame `[...mobs]`
     * allocation that the snapshot approach used.
     *
     * **Passive far-mob throttle (Phase 8j optimization).** Mobs that are
     * BOTH not aggro'd AND further than `FAR_PASSIVE_TICK_DIST` from the
     * player only tick every 3rd frame. Saves ~66% of steady-state CPU
     * when several passive mobs are wandering at the edge of the map —
     * each tick still runs `moveMobWithCollision` (spatial-hash query +
     * footprint resolve) which dominates the cost. Aggro'd mobs always
     * tick every frame so combat responsiveness is preserved. */
    farPassiveTickPhase = (farPassiveTickPhase + 1) % 3;
    for (let mobIdx = mobs.length - 1; mobIdx >= 0; mobIdx--) {
      const mob = mobs[mobIdx]!;
      const render = renderById.get(mob.id);
      if (!render) continue; /* race: spawned in store but not yet in renderer */

      if (mob.state === 'dying') {
        /* Death animation phases — see comment block below. For loot-yielding mobs
         * (rat / wolf), the dying clip ENDS by parking the body face-down on the
         * terrain — no scale-fade — and transitions to `corpse` state so the
         * player can walk over and skin it. Non-loot mobs (wanderer) keep the
         * old fall-then-scale-fade despawn behavior since there's nothing to loot.
         *
         * The fall animation:
         *   - Phase 1 (0%..60%): pitch forward on X axis, ease-in-quad (gravity
         *     feel + weighty impact at the end). Companion body-thud SFX fires
         *     during this window via combatSfx death profile.
         *   - Phase 2 (60%..100%):
         *     - If meat > 0: hold the prone pose (rotation locked at -π·0.51,
         *       scale stays at 1). Body sits on the ground waiting for the player.
         *     - If meat === 0: scale-fade from 1.0 to 0 (existing despawn flow). */
        const meatYield = MOB_LOOT[mob.kind].meat;
        if (nowMs >= mob.diesAtMs) {
          /* Magic kills already auto-looted the meat at impact (via the
           * `onMobDamaged` source='magic' route in mountApp); skip the
           * corpse persist phase entirely so the player isn't asked to walk
           * 30 m to skin a body whose loot is already in their inventory.
           * Same despawn path as wanderer (no-meat) kills. */
          const skipCorpse = rangedKillNoCorpse.has(mob.id);
          if (meatYield > 0 && !skipCorpse) {
            /* Transition to corpse — keep the LPCA rendered, lock the prone pose,
             * arm the persist timer. The render handle stays in `renderById` so
             * `getCorpseNearAvatar` can find it; the collision footprint stays
             * registered so the player can't walk through the corpse. */
            mob.state = 'corpse';
            mob.corpseExpiresAtMs = nowMs + CORPSE_PERSIST_MS;
            render.lpca.group.rotation.x = -(Math.PI * 0.51);
            render.lpca.group.scale.setScalar(1);
          } else {
            if (skipCorpse) rangedKillNoCorpse.delete(mob.id);
            despawnRender(mob.id);
            opts.store.removeAwakenedMob(mob.id);
          }
        } else {
          const elapsedMs = DEATH_ANIM_MS - (mob.diesAtMs - nowMs);
          const t = Math.max(0, Math.min(1, elapsedMs / DEATH_ANIM_MS));
          if (t < 0.6) {
            const fallT = t / 0.6;
            const eased = fallT * fallT;
            render.lpca.group.rotation.x = -eased * (Math.PI * 0.51);
            render.lpca.group.scale.setScalar(1);
          } else if (meatYield > 0) {
            /* Lootable mob — hold the final fall pose, no fade. The corpse is
             * about to enter `corpse` state once `diesAtMs` elapses. */
            render.lpca.group.rotation.x = -(Math.PI * 0.51);
            render.lpca.group.scale.setScalar(1);
          } else {
            const fadeT = (t - 0.6) / 0.4;
            render.lpca.group.rotation.x = -(Math.PI * 0.51);
            render.lpca.group.scale.setScalar(Math.max(0, 1 - fadeT));
          }
        }
        continue;
      }
      if (mob.state === 'corpse') {
        /* Corpse persistence — the prone body sits in place until the player skins
         * it (E interaction handled in mountApp -> store.skinAwakenedCorpse) OR
         * the persist timer expires. Render-side: pose is already locked from the
         * dying-state transition, no per-frame work. We just check the timer. */
        if (nowMs >= mob.corpseExpiresAtMs) {
          despawnRender(mob.id);
          opts.store.removeAwakenedMob(mob.id);
        }
        continue;
      }

      const stats = AWAKENED_MOB_STATS[mob.kind];
      /* Snapshot pre-AI position so we can compute moved-distance after the AI tick
       * for the footstep cadence integrator below. */
      const preX = mob.x;
      const preZ = mob.z;
      const dx = playerPos.x - mob.x;
      const dz = playerPos.z - mob.z;
      const distXZ = Math.hypot(dx, dz);
      /* Far-passive tick throttle (Phase 8j). Skip the entire AI tick on 2 of
       * every 3 frames for distant non-aggro'd mobs. The `mob.id % 3` stagger
       * spreads which mobs tick on which frame so the AI work distributes
       * evenly across frames instead of bunching. Aggro'd mobs and any mob
       * within `FAR_PASSIVE_TICK_DIST` always tick every frame. */
      if (
        !render.aggro &&
        distXZ > FAR_PASSIVE_TICK_DIST &&
        (mob.id % 3) !== farPassiveTickPhase
      ) {
        continue;
      }
      /* Vertical separation — used to prevent the "latch" bug where a mob keeps hitting
       * the player even if the player jumps straight up over the mob. If the player is
       * more than 1.5 m above the mob's head (rough mob-height + a margin), the mob can
       * still chase / track but CAN'T apply damage this frame. */
      const distY = playerPos.y - mob.y;
      const playerInAirAboveMob = distY > 1.5;

      /* === Aggro state machine (passive ⇄ active hysteresis) ===
       *
       * Replaces the old "every frame: redo the if-distance-then-state ladder" pattern,
       * which made mobs flicker between chase and idle exactly at `aggroRange` because
       * floating-point distance bounced across the threshold each frame.
       *
       *   - PASSIVE → ACTIVE: when player gets within `aggroRange`.
       *   - ACTIVE → PASSIVE: when player escapes past `aggroRange + AGGRO_RELEASE_PAD`,
       *     OR when the lease timer expires (mob has been aggro'd but unable to make
       *     meaningful progress for AGGRO_LEASE_MS — e.g. trapped behind a wall the
       *     player parkour'd onto). Either path resets the mob to wander cleanly.
       *
       * The lease timer refreshes each frame the mob makes progress (distance to player
       * decreased by ≥0.05 m). If progress stalls, the lease drains naturally and the
       * mob de-aggros after AGGRO_LEASE_MS — predictable, no infinite chase.
       */
      const acquireRange = stats.aggroRange;
      const releaseRange = stats.aggroRange + AGGRO_RELEASE_PAD;
      if (!render.aggro) {
        if (distXZ <= acquireRange) {
          render.aggro = true;
          render.aggroLeaseExpiresMs = nowMs + AGGRO_LEASE_MS;
          render.lastDistToPlayer = distXZ;
        }
      } else {
        /* Drop aggro on escape OR lease expiry. */
        if (distXZ > releaseRange || nowMs >= render.aggroLeaseExpiresMs) {
          render.aggro = false;
          /* Reset attack cooldown on de-aggro so the player isn't punished by a stale
           * windup the next time the mob re-aggros. */
          if (mob.attackReadyMs > nowMs) mob.attackReadyMs = nowMs + stats.attackCooldownMs;
          /* Pick a fresh wander destination AWAY from the player so the mob visibly
           * disengages instead of standing still at point-blank range. */
          const awayAng = Math.atan2(-dz, -dx);
          render.wanderTargetX = mob.x + Math.cos(awayAng) * (3 + Math.random() * 3);
          render.wanderTargetZ = mob.z + Math.sin(awayAng) * (3 + Math.random() * 3);
          render.nextWanderAtMs = nowMs + 1500 + Math.random() * 2000;
        } else {
          /* Refresh the lease iff the mob is making progress — closing distance, OR
           * the player has stayed close (no escape). Stagnation (player out of reach
           * AND mob can't path closer) drains the lease so the mob eventually gives up. */
          const closingProgress = render.lastDistToPlayer - distXZ;
          if (closingProgress > 0.05 || distXZ <= stats.meleeRange + 1.0) {
            render.aggroLeaseExpiresMs = nowMs + AGGRO_LEASE_MS;
          }
          render.lastDistToPlayer = distXZ;
        }
      }

      /* Always face the player while aggro'd (player-perception goal: "head face the
       * player face on"). The LPCA rig has no separate head bone in our setup so the
       * full body yaws to match — reads identically to the player. */
      if (render.aggro) {
        mob.rotY = Math.atan2(dx, dz);
      }

      /* Behavior derives from aggro + distance. attack ⊂ chase ⊂ idle in transition
       * cost — switching states is just an enum write, no animation reset needed. */
      if (render.aggro && distXZ <= stats.meleeRange) {
        mob.state = 'attack';

        /* === Attack cycle: windup -> strike -> recover ===
         *
         * Replaces the old "instant damage on cooldown" pattern with a 3-phase swing
         * so the player gets a visible telegraph (and a dodge window). Damage fires
         * ONCE at the start of `strike`, gated by a fresh distance check using the
         * lunge-extended reach. If the player back-pedaled during windup, the bite
         * misses and the mob still has to play out recovery before retrying. */
        const elapsedInPhase = nowMs - render.attackPhaseStartMs;
        switch (render.attackPhase) {
          case 'idle':
            /* Start a new attack only when the cooldown lock has cleared AND the
             * player is reachable (not airborne above us — same jump-immunity gate
             * that the old code had). */
            if (nowMs >= mob.attackReadyMs && !playerInAirAboveMob) {
              render.attackPhase = 'windup';
              render.attackPhaseStartMs = nowMs;
            }
            break;
          case 'windup':
            if (elapsedInPhase >= ATTACK_WINDUP_MS) {
              render.attackPhase = 'strike';
              render.attackPhaseStartMs = nowMs;
              /* Damage gate at strike-peak: re-test reach with the lunge extension.
               * If player escaped past `meleeRange + ATTACK_LUNGE_REACH` during
               * windup, the bite hits empty air. Same vertical guard. */
              const biteReach = stats.meleeRange + ATTACK_LUNGE_REACH;
              if (distXZ <= biteReach && !playerInAirAboveMob) {
                opts.store.damagePlayerInAwakened(stats.damage, mob.kind);
              }
            }
            break;
          case 'strike':
            if (elapsedInPhase >= ATTACK_STRIKE_MS) {
              render.attackPhase = 'recover';
              render.attackPhaseStartMs = nowMs;
            }
            break;
          case 'recover':
            if (elapsedInPhase >= ATTACK_RECOVER_MS) {
              render.attackPhase = 'idle';
              render.attackPhaseStartMs = nowMs;
              /* Cooldown gates the NEXT cycle — total cycle time + cooldown =
               * effective attack rate. Tuned so a wolf bites every ~1.7 s. */
              mob.attackReadyMs = nowMs + stats.attackCooldownMs;
            }
            break;
        }
        /* Micro-adjust position during attack so the player can't simply sidestep to
         * cheese it. 50 % walk speed during the cycle. Skipped if we're already
         * point-blank to avoid the mob grinding INTO the player (collision push-out
         * would fight us → visual jitter). */
        if (distXZ > 0.15) {
          const ux = dx / distXZ;
          const uz = dz / distXZ;
          const safeStop = stats.meleeRange * 0.7;
          if (distXZ > safeStop) {
            const desiredX = mob.x + ux * stats.walkSpeed * 0.5 * dtSec;
            const desiredZ = mob.z + uz * stats.walkSpeed * 0.5 * dtSec;
            moveMobWithCollision(mob, preX, preZ, desiredX, desiredZ);
            mob.y = opts.getTerrainHeight(mob.x, mob.z);
          }
        }
      } else if (render.aggro) {
        mob.state = 'chase';
        /* Reset attack cooldown on escape — next time we close to melee, the player
         * gets a clean cooldown window. Prevents "drive-by hit" the instant the mob
         * re-enters range. Also abort any in-flight attack cycle so the mob doesn't
         * keep its windup pose while jogging toward the player. */
        if (mob.attackReadyMs > nowMs) {
          mob.attackReadyMs = nowMs + stats.attackCooldownMs;
        }
        if (render.attackPhase !== 'idle') {
          render.attackPhase = 'idle';
          render.attackPhaseStartMs = nowMs;
        }
        /* Walk toward player at full speed. */
        const ux = dx / distXZ;
        const uz = dz / distXZ;
        const desiredX = mob.x + ux * stats.walkSpeed * dtSec;
        const desiredZ = mob.z + uz * stats.walkSpeed * dtSec;
        moveMobWithCollision(mob, preX, preZ, desiredX, desiredZ);
        mob.y = opts.getTerrainHeight(mob.x, mob.z);
      } else {
        /* Passive: out of aggro entirely. Wander a random short distance every ~3 s. */
        mob.state = 'idle';
        if (nowMs >= render.nextWanderAtMs) {
          /* Pick new wander destination within ~6 m of current spot. */
          const wAng = Math.random() * Math.PI * 2;
          const wDist = 2 + Math.random() * 4;
          render.wanderTargetX = mob.x + Math.cos(wAng) * wDist;
          render.wanderTargetZ = mob.z + Math.sin(wAng) * wDist;
          render.nextWanderAtMs = nowMs + 2500 + Math.random() * 3500;
        }
        const wdx = render.wanderTargetX - mob.x;
        const wdz = render.wanderTargetZ - mob.z;
        const wd = Math.hypot(wdx, wdz);
        if (wd > 0.15) {
          /* Wander at half walk speed. */
          const ux = wdx / wd;
          const uz = wdz / wd;
          const desiredX = mob.x + ux * stats.walkSpeed * 0.4 * dtSec;
          const desiredZ = mob.z + uz * stats.walkSpeed * 0.4 * dtSec;
          moveMobWithCollision(mob, preX, preZ, desiredX, desiredZ);
          mob.y = opts.getTerrainHeight(mob.x, mob.z);
          /* While passive, face wander direction (player not relevant). */
          mob.rotY = Math.atan2(ux, uz);
        }
      }

      /* === Attack lunge offset ===
       *
       * Visual companion to the windup/strike/recover state machine above. Pushes the
       * LPCA forward along the mob's facing during an attack cycle:
       *   - windup : ease-in to ~25 % of LUNGE_REACH (slow lean)
       *   - strike : peak full LUNGE_REACH at strike midpoint, with a slight overshoot
       *              shape (sin(πt)) so the bite reads as a snap, not a drift
       *   - recover: lerp linearly back to 0 (mob rocks back to neutral)
       * The offset is computed in WORLD space using `(sin(rotY), cos(rotY))` as the
       * forward vector. NOT applied through `moveMobWithCollision` because it's a
       * visual-only animation — `mob.x/z` (the AI authoritative position) doesn't
       * move during the lunge. */
      let lungeOffset = 0;
      if (render.attackPhase !== 'idle') {
        const elapsedInPhase = nowMs - render.attackPhaseStartMs;
        switch (render.attackPhase) {
          case 'windup': {
            const t = Math.min(1, elapsedInPhase / ATTACK_WINDUP_MS);
            lungeOffset = ATTACK_LUNGE_REACH * 0.25 * t;
            break;
          }
          case 'strike': {
            const t = Math.min(1, elapsedInPhase / ATTACK_STRIKE_MS);
            /* sin(πt) peaks at t=0.5 — gives the snap-and-pull shape. Starts from the
             * 25% windup position so there's no discontinuity at the phase boundary. */
            lungeOffset = ATTACK_LUNGE_REACH * (0.25 + 0.75 * Math.sin(Math.PI * t));
            break;
          }
          case 'recover': {
            const t = Math.min(1, elapsedInPhase / ATTACK_RECOVER_MS);
            lungeOffset = ATTACK_LUNGE_REACH * 0.25 * (1 - t);
            break;
          }
        }
      }
      const lungeForwardX = Math.sin(mob.rotY) * lungeOffset;
      const lungeForwardZ = Math.cos(mob.rotY) * lungeOffset;

      /* Sync the LPCA's world transform from the AI state. The kind-specific yaw
       * offset compensates for the authored-axis difference between rat/wolf (built
       * along +X) and wanderer (built along +Z). Without it the rat/wolf "follow
       * sideways" — they move in the right direction but render perpendicular.
       *
       * `groundOffsetY` re-applies the LPCA's internal grounding offset that was
       * captured at spawn (otherwise wanderer's feet sink into terrain — see
       * `groundOffsetY` field comment for the full explanation). */
      render.lpca.group.position.set(
        mob.x + lungeForwardX,
        mob.y + render.groundOffsetY,
        mob.z + lungeForwardZ,
      );
      render.lpca.group.rotation.y = mob.rotY + MOB_MODEL_YAW_OFFSET[mob.kind];

      /* Update footprint position. Use movePosition (cheap in-place update) instead
       * of register() to avoid the per-frame unregister + re-bucket churn. With up
       * to 6 alive mobs each moving every frame, this saves ~6× spatial-hash list
       * operations per frame in active combat. */
      if (opts.collisionWorld) {
        opts.collisionWorld.movePosition(
          mobOwnerId(mob.id),
          mob.x, mob.z,
          mob.y,
          mob.y + MOB_HEIGHT[mob.kind],
        );
      }

      /* Footstep cadence — accumulate XZ distance moved this frame; when it exceeds
       * the per-kind step length, fire one footstep SFX + reset. Naturally scales
       * with how fast the mob is moving (chase fires faster than wander, attack
       * micro-adjustments fire occasionally). Volume is scaled by listener distance
       * so a wolf padding through the woods at 30 m fades into the ambient bed. */
      const movedThisFrame = Math.hypot(mob.x - preX, mob.z - preZ);
      render.distSinceLastStep += movedThisFrame;
      const stepLen = MOB_STEP_LENGTH[mob.kind];
      if (render.distSinceLastStep >= stepLen) {
        render.distSinceLastStep = 0;
        const vol = distanceVolumeScale(distXZ);
        if (opts.mobAudio) opts.mobAudio.playFootstep(mob.kind, vol);
        else playMobFootstepSound(mob.kind, vol);
      }
    }
  }

  function damage(
    id: number,
    amount: number,
    fromXZ: { x: number; z: number },
    source: 'melee' | 'magic' = 'melee',
  ): boolean {
    void fromXZ; /* future: knockback direction; Phase 1.5 ignores */
    /* Snapshot mob kind BEFORE the store mutates it — we need the kind to fire the
     * death voice on a kill shot (the mob enters `dying` state inside the store). */
    const mobBefore = opts.store.getActiveAwakenedMobs().find((m) => m.id === id);
    const killed = opts.store.damageAwakenedMob(id, amount);
    if (killed && mobBefore) {
      /* Death voice — long descending vocalization + body thud, fires once at the
       * moment of death. The fall-over animation (in `update`) plays in sync over
       * the next ~1.5 s so the audio body-thud lands roughly when the visual body
       * lands on the ground (timing aligned in `combatSfx.ts` death profiles).
       * Proximity-attenuated using the last-known player XZ (see `lastPlayerX/Z`
       * — refreshed every `update()` tick from the per-frame player position). */
      const distXZ = Math.hypot(mobBefore.x - lastPlayerX, mobBefore.z - lastPlayerZ);
      const deathVol = distanceVolumeScale(distXZ);
      if (opts.mobAudio) opts.mobAudio.playDeath(mobBefore.kind, deathVol);
      else playMobDeathSound(mobBefore.kind, deathVol);
      /* Magic kills mark the mob to skip the corpse-persist phase. The death
       * animation still plays for visual closure (~1.5 s); at the moment the
       * fall-over completes, the dying→corpse transition checks this set and
       * despawns immediately instead of holding a 60 s "press E to skin"
       * corpse. The auto-loot grant happens via the `onMobDamaged` callback
       * with `source === 'magic'` — mountApp grants the meat at impact time
       * so the player gets satisfying "+N meat" feedback the moment the bolt
       * lands, not 1.5 s later. */
      if (source === 'magic') {
        rangedKillNoCorpse.add(id);
      }
    }
    /* Notify the floater layer (or any other observer) AFTER the store mutation so
     * `mobBefore` carries the position from the moment of impact and `killed` is
     * accurate. We pass `mobBefore` even on lethal hits so the floater can anchor
     * to the death point — the corpse render is still at that XZ for the duration
     * of the death animation, so the floater stays visually attached. The
     * `source` parameter lets mountApp route magic kills to auto-loot. */
    if (mobBefore && opts.onMobDamaged) {
      opts.onMobDamaged(mobBefore, amount, killed, source);
    }
    return killed;
  }

  function getMob(id: number): AwakenedMobInstance | null {
    return opts.store.getActiveAwakenedMobs().find((m) => m.id === id) ?? null;
  }

  function getAllMobs(): ReadonlyArray<AwakenedMobInstance> {
    return opts.store.getActiveAwakenedMobs();
  }

  function getCorpseNearAvatar(
    avatarXZ: { x: number; z: number },
    radius = 1.8,
  ): AwakenedMobInstance | null {
    let best: AwakenedMobInstance | null = null;
    let bestDist = radius;
    const r2 = radius * radius;
    for (const mob of opts.store.getActiveAwakenedMobs()) {
      if (mob.state !== 'corpse') continue;
      const dx = mob.x - avatarXZ.x;
      const dz = mob.z - avatarXZ.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2);
      if (d < bestDist) {
        bestDist = d;
        best = mob;
      }
    }
    return best;
  }

  function skinCorpse(id: number): { kind: AwakenedMobKind; meat: number } | null {
    const mob = opts.store.getActiveAwakenedMobs().find((m) => m.id === id);
    if (!mob || mob.state !== 'corpse') return null;
    const loot = MOB_LOOT[mob.kind];
    despawnRender(mob.id);
    opts.store.removeAwakenedMob(mob.id);
    return { kind: mob.kind, meat: loot.meat };
  }

  function getProximityVolumeScale(x: number, z: number): number {
    return distanceVolumeScale(Math.hypot(x - lastPlayerX, z - lastPlayerZ));
  }

  function warmShaders(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    /* Build one of each kind offscreen + render once so the program cache is warm.
     * Same pattern as `cabinBuilder.warmShaders`. Disposed on next rAF.
     *
     * === 2026-04-20 non-blocking GPU compile ===
     *
     * Uses `renderer.compileAsync` (Three r158+) which leverages the
     * `KHR_parallel_shader_compile` WebGL extension — supported in every
     * Chromium + Firefox since 2022. The GPU compiles materials on a
     * driver-side worker thread while JS keeps running. Without this, the
     * sync `renderer.compile(scene, camera)` was a 100-300 ms main-thread
     * block that frozе the page right after the shattering cutscene
     * (every material in the scene — dock-forest BatchedMesh, cabin,
     * mushrooms, stations — gets walked even when programs are cached).
     *
     * Fire-and-forget; if the async compile errors, we just don't get
     * the warm and the first mob spawn pays a one-time 50-100 ms compile
     * (rare and far less visible than freezing on the welcome screen). */
    const placeholders: THREE.Group[] = [];
    for (const kind of ['rat', 'wolf', 'wanderer'] as AwakenedMobKind[]) {
      const lpca = createPveEnemyLPCA(MOB_KIND_TO_PVE_ID[kind]);
      lpca.group.position.set(10000, -10000, 10000);
      root.add(lpca.group);
      placeholders.push(lpca.group);
    }
    const cleanup = (): void => {
      for (const g of placeholders) {
        root.remove(g);
        g.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && m.geometry) m.geometry.dispose();
        });
      }
    };
    /* `compileAsync` is the post-r158 non-blocking path. Fall back to the
     * legacy sync `compile` if the renderer doesn't expose it (older
     * Three builds). */
    const r = renderer as THREE.WebGLRenderer & {
      compileAsync?: (scene: THREE.Object3D, camera: THREE.Camera) => Promise<void>;
    };
    if (typeof r.compileAsync === 'function') {
      r.compileAsync(opts.scene, camera)
        .then(() => {
          requestAnimationFrame(cleanup);
        })
        .catch(() => {
          requestAnimationFrame(cleanup);
        });
    } else {
      try {
        renderer.compile(opts.scene, camera);
      } catch {
        /* best-effort */
      }
      requestAnimationFrame(cleanup);
    }
  }

  function clearAll(): void {
    /* Despawn every render + unregister every footprint without tearing down the
     * root container. After this call, the next `update()` tick starts fresh —
     * any new mobs the store spawns will land in a clean renderById map.
     * Idempotent: if nothing is alive, the loop is a no-op. */
    for (const id of Array.from(renderById.keys())) despawnRender(id);
    rangedKillNoCorpse.clear();
    /* Reset wave timer too so the post-respawn world has a brief grace period
     * before the next spawn check fires (instead of immediately repopulating
     * mobs the moment the player respawns). */
    nextSpawnCheckAtMs = Date.now() + WAVE_INTERVAL_MS;
  }

  function dispose(): void {
    for (const id of Array.from(renderById.keys())) despawnRender(id);
    if (root.parent) root.parent.remove(root);
  }

  return {
    update, damage, getMob, getAllMobs, warmShaders,
    getProximityVolumeScale, getCorpseNearAvatar, skinCorpse, clearAll, dispose,
  };
}
