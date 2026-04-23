/**
 * Awakened-mode magic projectiles — Phase 1.5 base + 2026-04 visual polish pass.
 *
 * Pool of preallocated multi-layer magical orbs fired from the staff tip when
 * the player casts (LMB with wand/staff equipped). Each projectile is a
 * miniature "magic missile" composed of:
 *
 *   - **innerCore** — bright white-cyan emissive sphere (the "soul" of the orb).
 *   - **midShell** — translucent glassy iridescent sphere (matches the staff
 *     orb's aesthetic in `vanguardStaffOrbVfx.ts` so the projectile reads as
 *     "the same magic that's been in your staff just got launched").
 *   - **outerHalo** — large additive aura that hue-cycles cyan → magenta →
 *     violet so the projectile feels alive and magical, not lava-lamp static.
 *   - **crystalFacets** — 4 small octahedrons orbiting the orb at staggered
 *     angles. Mirrors the staff-tip glitter; gives the projectile a sense of
 *     spin / energy flow as it travels.
 *   - **trail** — 6 fading ghost spheres at past positions, scaling down +
 *     fading alpha. Reads as a comet tail of magic energy.
 *
 * **Phantom-light invariant:** still no `THREE.PointLight` per projectile
 * (would flip `numPointLights` ~5/sec when sustained-firing → repeated
 * scene-wide shader recompile freezes; documented anti-pattern). Visible glow
 * comes from emissive on every layer + the post-processing bloom pass; the
 * additive halo + multi-layer composition is what makes the orb read as
 * "lit" without an actual light.
 *
 * **Speed tuning (2026-04):** dropped from 25 m/s → 14 m/s so the player can
 * actually SEE the magic in flight (was 1.6 s flight to a 40 m target →
 * now ~2.9 s — feels like a magic missile, not a hitscan beam).
 *
 * **Aim path (2026-04 v2):** standard 3rd-person-shooter "muzzle-to-reticle
 * convergence" pattern — the firing controller (`awakenedCombat.ts`) does a
 * `collisionWorld.raycastXZ` FROM THE CAMERA along camera-forward (skipping
 * the player's own footprint via `ignoreOwnerId: 'player'`), finds the first
 * non-player obstacle, and aims the projectile at THAT world point. Origin
 * is the staff tip, so the bolt leaves the staff visibly + converges on
 * whatever the reticle is pointing at. Long-range shots look near-parallel
 * to camera-forward; close-range shots angle visibly to land on target.
 * Same pattern as Gears of War / Fortnite / Last of Us / Skyrim 3P-mode.
 *
 * Critical detail: the camera-ray raycast MUST ignore the player's own
 * collision capsule. Without that, in 3rd-person view the ray hits 'player'
 * at distance ~0 (camera sits behind avatar) → aim collapses to camera
 * position → bolt fires from staff back AT the camera. See the docstring
 * on `reticleAimPoint` in `awakenedCombat.ts` for the full failure analysis.
 *
 * **Pool design unchanged:** N preallocated entries; on `fire()` the
 * controller picks the oldest free entry, sets velocity + visual state.
 * Per-frame `update(dt)` integrates position, advances animation phases,
 * checks `collisionWorld.raycastXZ` over the swept segment, applies damage
 * on mob hit, despawns on static hit / lifetime / out-of-bounds.
 *
 * **Homing behavior (unchanged):** when `homingTargetMobId` is set, each
 * frame the projectile's velocity bends toward the live mob position with
 * a max turn rate. Velocity magnitude re-normalised to `PROJECTILE_SPEED`
 * after each bend so homing doesn't slow the orb.
 */
import * as THREE from 'three';
import { playMagicImpactSound, playMobHitSound } from '../audio/audioBridge';

function emitMagicImpact(
  projectileAudio: ProjectileAudioHooks | null,
  scale: number,
): void {
  if (projectileAudio) projectileAudio.playMagicImpact(scale);
  else playMagicImpactSound(scale);
}

function emitMobHit(
  projectileAudio: ProjectileAudioHooks | null,
  kind: AwakenedMobKind,
  scale: number,
): void {
  if (projectileAudio) projectileAudio.playMobHit(kind, scale);
  else playMobHitSound(kind, scale);
}

type ProjectileAudioHooks = {
  playMagicImpact: (volumeScale: number) => void;
  playMobHit: (kind: AwakenedMobKind, volumeScale: number) => void;
};
import type { CollisionWorldHandle } from './collisionWorld';
import type { AwakenedMobsHandle } from './awakenedMobs';
import type { AwakenedMobKind } from '../core/types';

/* ============================================================================
 * Constants
 * ============================================================================ */

const POOL_SIZE = 16;
/** Magic projectile travel speed (world units / sec). Tuned 2026-04 from the
 * Phase-1.5 spec value of 25 m/s down to 14 m/s so the magic is actually
 * VISIBLE in flight. Modern fantasy "magic missile" benchmarks: Skyrim's
 * Firebolt ≈ 15 m/s, Diablo IV's basic spells ≈ 12-18 m/s. 14 sits in that
 * pocket — slow enough to read as a discrete magical event, fast enough that
 * mobs at melee range can still hit. Homing logic re-normalises velocity to
 * this same value each frame so the orb tracks at constant speed. */
const PROJECTILE_SPEED = 14;
/** Max lifetime per projectile (sec) — despawn if it hasn't hit anything by then.
 * Bumped 3.5 → 4.5 to keep the practical max range similar after the speed cut. */
const PROJECTILE_LIFE_SEC = 4.5;
/** Inner core radius — smallest, brightest, the "soul" of the orb. */
const INNER_CORE_RADIUS = 0.045;
/** Mid translucent shell radius — matches the staff-orb shell scale. */
const MID_SHELL_RADIUS = 0.10;
/** Outer additive halo radius — the magic aura. */
const OUTER_HALO_RADIUS = 0.18;
/** Crystal facet half-extent (octahedron). */
const CRYSTAL_RADIUS = 0.045;
/** How far from the orb centre the crystal facets orbit. */
const CRYSTAL_ORBIT_RADIUS = 0.18;
/** Number of orbiting crystal facets per projectile (matches staff glitter feel). */
const CRYSTAL_COUNT = 4;
/** Crystal orbit angular speed (rad / sec). */
const CRYSTAL_ORBIT_SPEED = 6.5;
/** Inner-core pulse frequency (Hz). */
const INNER_PULSE_HZ = 8;
/** Outer-halo hue-cycle frequency (full hue rotation per N seconds). */
const HALO_HUE_PERIOD_SEC = 1.4;
/** Trail history length — number of fading ghost spheres behind each orb. */
const TRAIL_LEN = 6;
/** How often (in seconds) the trail samples a new position. Lower = denser trail. */
const TRAIL_SAMPLE_INTERVAL = 0.045;
/** Homing turn rate (radians / sec) — max angular velocity the projectile can bend.
 * AGGRESSIVE for the locked-on case (was 3.2; bumped to 7.5) so a slow 14 m/s
 * bolt can still reliably track a moving target. The user expectation when
 * lock-on is engaged is "the bolt WILL hit" — anything slower than this lets
 * fast-moving wolves / wanderers dodge by changing direction faster than the
 * bolt can reorient. */
const HOMING_TURN_RATE = 7.5;
/**
 * Auto-hit radius around the locked target's chest. When the bolt's distance
 * to the target falls below this, the bolt counts as a hit (instead of
 * relying on the per-step XZ raycast catching the mob's footprint). This
 * fixes the "bolt grazes the mob and continues without damaging" case at
 * low speed — the mob's footprint radius is small (rats 0.4 m), and at
 * 14 m/s the bolt's swept segment per frame is only ~0.23 m, so the
 * raycast can miss by half a metre. The auto-hit gate guarantees a kill
 * once the bolt is genuinely on top of its locked target.
 */
const LOCKED_TARGET_AUTOHIT_RADIUS = 0.65;
/** Player owner id — projectiles ignore this so the player can't hit themselves. */
const PLAYER_OWNER_ID = 'player';

/* Hue palette for the outer halo cycle. 3 stops cycled smoothly via the
 * `_haloPhase` global below. Cyan → magenta → violet then loops. */
const HALO_HUE_STOPS = [0.52, 0.88, 0.74]; /* HSL hue (0..1) */

/* Per-crystal palette — each facet gets a distinct emissive colour so the
 * orbit reads as a multi-coloured magical ring rather than "four clones of
 * the same crystal". Cycled by index. */
const CRYSTAL_COLORS = [0x66e0ff, 0xff6ad8, 0xb37bff, 0xa9ffe0];

/* ============================================================================
 * Public handle
 * ============================================================================ */

export interface MagicProjectilesHandle {
  /**
   * Fire one magic projectile. Origin = the staff tip world position; aim =
   * the resolved aim point (camera-forward × 40 from staff tip for free-aim,
   * or the lock-on target's chest). When `homingTargetMobId` is set, the
   * projectile bends toward that mob's position each frame instead of flying
   * straight to the aim point.
   */
  fire(opts: {
    originX: number; originY: number; originZ: number;
    aimX: number; aimY: number; aimZ: number;
    homingTargetMobId: number | null;
    damage: number;
  }): void;
  /** Per-frame: integrate positions, advance visual animation, check collision,
   * spawn impacts, despawn dead. */
  update(dtSec: number): void;
  /**
   * Pre-compile every projectile-layer material's shader program so the
   * first cast doesn't trigger a synchronous main-thread shader compile
   * (typically 100-400 ms freeze on integrated GPUs). Same proven pattern
   * as `cabinBuilder.warmShaders` and `awakenedMobs.warmShaders`.
   *
   * Implementation: park one tiny placeholder mesh per shared material at
   * a far-off world position, call `renderer.compile(scene, camera)` to
   * JIT every program, then schedule disposal next tick. The far-off
   * coordinates ensure the placeholders don't appear in the player's view
   * even on the warm frame.
   *
   * Call ONCE at boot (typically right after `attachMagicProjectiles`)
   * during the existing warm-pipeline window. Cheap to re-call but only
   * the first call does meaningful work.
   */
  warmShaders(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void;
  /**
   * Late-bind / replace the on-static-hit callback. Used by the extended
   * preload to construct the handle (so its shaders warm during the title
   * screen) WITHOUT yet having access to mountApp's `harvestHandle`,
   * `dockForestHandle`, etc. — mountApp adopts the prebuilt handle and
   * wires the real callback after consume.
   */
  setOnStaticHit(cb: AttachOpts['onStaticHit'] | null): void;
  /**
   * Late-bind / replace the mobs handle. The projectile loop calls into
   * `mobs` for hit-tests against live mobs each frame; extended preload
   * passes a stub mobs handle (since the real one needs mountApp's
   * store callbacks) and mountApp swaps in the real one after construct.
   */
  setMobs(mobs: AwakenedMobsHandle): void;
  /** Worker / off-main: route magic SFX without importing `audioBridge`. */
  setProjectileAudio(hooks: ProjectileAudioHooks | null): void;
  dispose(): void;
}

interface AttachOpts {
  scene: THREE.Scene;
  collisionWorld: CollisionWorldHandle;
  mobs: AwakenedMobsHandle;
  /**
   * Heightfield sampler — same one the dock + free-roam controls use.
   * Per-frame the projectile checks `bolt.y < getTerrainHeight(bolt.x, bolt.z)`
   * to despawn cleanly when the bolt drives into the ground (e.g. player
   * aimed straight down). Without this, the bolt slides under terrain and
   * becomes invisible to the player while still consuming a pool slot
   * until lifetime expiry — reads as "the bolt was blocked by something".
   */
  getTerrainHeight: (x: number, z: number) => number;
  /**
   * Optional non-mob hit callback — fires when the bolt collides with any
   * non-mob, non-player footprint (harvest scatter, dock-forest scatter,
   * cabin pieces, craft stations). The owner-id encodes WHAT was hit
   * (`harvest:<kind>:<index>`, `dock-forest-batched:<kind>:<index>`,
   * `cabin:<pieceId>`, `craft_station:<stationId>`); the caller parses
   * the prefix to route to the right damage / harvest pipeline. The
   * projectile despawns at the hit point regardless of whether the
   * caller does anything with the event.
   *
   * **Why a generic callback instead of typed routes:** keeps the
   * projectile module agnostic about the world's harvest / building
   * topology. mountApp owns the routing because it's where all the
   * relevant handles live (harvestHandle, dockForestHandle, cabinHandle,
   * stationHandle); the projectile system just reports "the bolt
   * connected with X at world point Y." Same loose-coupling pattern as
   * `onMobDamaged`.
   */
  onStaticHit?: (
    ownerId: string,
    hitX: number,
    hitY: number,
    hitZ: number,
    damage: number,
  ) => void;
  /** When set, projectile impact / mob-hit sounds use these instead of audioBridge. */
  projectileAudio?: ProjectileAudioHooks;
}

interface PoolEntry {
  /** Group containing all visual layers for this projectile. */
  group: THREE.Group;
  innerCore: THREE.Mesh;
  /** Mid shell uses MeshPhysicalMaterial — its iridescence matches the staff orb. */
  midShell: THREE.Mesh;
  /** Outer halo uses an OWN material instance so we can hue-cycle each projectile
   * independently (so a salvo doesn't strobe in unison). */
  outerHalo: THREE.Mesh;
  /** Crystal facets orbiting the orb. */
  crystals: THREE.Mesh[];
  /** Ghost spheres at past positions; fade alpha + scale based on age. */
  trail: THREE.Mesh[];
  /** Past-position samples (index 0 = newest). */
  trailHistory: { x: number; y: number; z: number }[];
  /** Real-time accumulator since last trail sample. */
  trailSampleAccum: number;
  active: boolean;
  vx: number;
  vy: number;
  vz: number;
  ageSec: number;
  damage: number;
  homingTargetMobId: number | null;
  /** Per-orb phase offset so animations don't tick in lock-step. */
  phaseOffset: number;
}

/* ============================================================================
 * Implementation
 * ============================================================================ */

export function attachMagicProjectiles(opts: AttachOpts): MagicProjectilesHandle {
  const root = new THREE.Group();
  root.name = 'MagicProjectilesRoot';
  opts.scene.add(root);

  let projectileAudio: ProjectileAudioHooks | null = opts.projectileAudio ?? null;

  /* ---- Shared geometries (one of each, reused by every pool entry) ---- */

  const innerCoreGeo = new THREE.SphereGeometry(INNER_CORE_RADIUS, 14, 12);
  const midShellGeo = new THREE.SphereGeometry(MID_SHELL_RADIUS, 18, 14);
  const outerHaloGeo = new THREE.SphereGeometry(OUTER_HALO_RADIUS, 14, 10);
  const crystalGeo = new THREE.OctahedronGeometry(CRYSTAL_RADIUS, 0);
  const trailGeo = new THREE.SphereGeometry(MID_SHELL_RADIUS * 0.6, 10, 8);

  /* ---- Shared materials ---- */

  /* Inner core: bright white-cyan, super emissive. Animated `emissiveIntensity`
   * is read globally (`_innerPulse`) so all orbs pulse in sync — adds to the
   * "magic energy" feel. */
  const innerCoreMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });

  /* Mid shell: translucent iridescent. Same flavor as the staff-tip orb in
   * `vanguardStaffOrbVfx.ts` so the player reads "this is the same magic
   * that lived in my staff." */
  const midShellMat = new THREE.MeshPhysicalMaterial({
    color: 0xc0e8ff,
    emissive: 0x66c8ff,
    /* Bumped 0.9 → 1.6 so the orb visibly exceeds the new 0.85 bloom threshold
     * (Phase 8h lighting plan). With the threshold raised from 0.05 → 0.85,
     * mundane surfaces no longer bloom — emissive props need to be HDR-bright
     * to win the bloom pass and read as "magic." */
    emissiveIntensity: 1.6,
    metalness: 0.05,
    roughness: 0.18,
    transparent: true,
    opacity: 0.55,
    transmission: 0.55,
    thickness: 0.08,
    ior: 1.45,
    iridescence: 0.55,
    iridescenceIOR: 1.4,
    iridescenceThicknessRange: [120, 380],
    clearcoat: 0.5,
    clearcoatRoughness: 0.15,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  /* Crystal facets — each projectile carries CRYSTAL_COUNT facets, each with
   * its own colour from CRYSTAL_COLORS. Materials cached at module scope so
   * we don't re-allocate per orb. */
  const crystalMats: THREE.MeshStandardMaterial[] = CRYSTAL_COLORS.map((hex) =>
    new THREE.MeshStandardMaterial({
      color: hex,
      emissive: hex,
      emissiveIntensity: 2.4,
      metalness: 0.6,
      roughness: 0.22,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    })
  );

  /* ---- Pool allocation ---- */

  const pool: PoolEntry[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const group = new THREE.Group();
    group.visible = false;
    group.castShadow = false;

    const innerCore = new THREE.Mesh(innerCoreGeo, innerCoreMat);
    innerCore.castShadow = false;
    innerCore.receiveShadow = false;
    group.add(innerCore);

    const midShell = new THREE.Mesh(midShellGeo, midShellMat);
    midShell.castShadow = false;
    midShell.receiveShadow = false;
    group.add(midShell);

    /* Per-orb halo material so each projectile can hue-cycle on its OWN phase
     * — otherwise a salvo of 5 orbs would all strobe to the same colour at
     * the same time, which reads as one giant pulsing orb instead of a
     * volley of distinct missiles. */
    const outerHaloMat = new THREE.MeshBasicMaterial({
      color: 0x66e0ff,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const outerHalo = new THREE.Mesh(outerHaloGeo, outerHaloMat);
    outerHalo.castShadow = false;
    outerHalo.receiveShadow = false;
    group.add(outerHalo);

    /* Orbiting crystal facets. Position is set per-frame in `update()` based
     * on the orb's spin phase. */
    const crystals: THREE.Mesh[] = [];
    for (let c = 0; c < CRYSTAL_COUNT; c++) {
      const facet = new THREE.Mesh(crystalGeo, crystalMats[c % CRYSTAL_COLORS.length]!);
      facet.castShadow = false;
      facet.receiveShadow = false;
      group.add(facet);
      crystals.push(facet);
    }

    /* Trail ghost spheres — own group + own material per ghost so we can fade
     * each independently. Built lazily in update() to avoid allocating
     * 16 * 6 = 96 trail materials at boot when only a handful are ever in
     * flight at once. Pre-create the meshes here so they're ready to set
     * matrix on first use. */
    const trail: THREE.Mesh[] = [];
    for (let t = 0; t < TRAIL_LEN; t++) {
      /* Each trail ghost gets its OWN material so opacity can fade
       * independently per index. Shared geometry. */
      const trailMat = new THREE.MeshBasicMaterial({
        color: 0x88f0ff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const trailMesh = new THREE.Mesh(trailGeo, trailMat);
      trailMesh.visible = false;
      trailMesh.castShadow = false;
      trailMesh.receiveShadow = false;
      /* Trail ghosts attach to the ROOT (not the moving group) so they stay
       * at their captured world position while the projectile moves on. */
      root.add(trailMesh);
      trail.push(trailMesh);
    }

    root.add(group);
    pool.push({
      group,
      innerCore,
      midShell,
      outerHalo,
      crystals,
      trail,
      trailHistory: [],
      trailSampleAccum: 0,
      active: false,
      vx: 0, vy: 0, vz: 0,
      ageSec: 0,
      damage: 0,
      homingTargetMobId: null,
      phaseOffset: Math.random() * Math.PI * 2,
    });
  }

  /* Reusable scratch HSL colour for the halo hue cycle (avoids per-frame
   * allocation in the hot loop). */
  const _scratchColor = new THREE.Color();

  function fire(args: {
    originX: number; originY: number; originZ: number;
    aimX: number; aimY: number; aimZ: number;
    homingTargetMobId: number | null;
    damage: number;
  }): void {
    /* Find the oldest free entry. If pool is full, reuse the longest-lived
     * active one (matches GoE's projectile-pool overflow behaviour). */
    let entry = pool.find((p) => !p.active);
    if (!entry) {
      entry = pool.reduce((a, b) => (a.ageSec >= b.ageSec ? a : b));
    }
    const dx = args.aimX - args.originX;
    const dy = args.aimY - args.originY;
    const dz = args.aimZ - args.originZ;
    const len = Math.hypot(dx, dy, dz) || 1;
    entry.vx = (dx / len) * PROJECTILE_SPEED;
    entry.vy = (dy / len) * PROJECTILE_SPEED;
    entry.vz = (dz / len) * PROJECTILE_SPEED;
    entry.group.position.set(args.originX, args.originY, args.originZ);
    entry.group.visible = true;
    entry.group.rotation.set(0, 0, 0);
    entry.active = true;
    entry.ageSec = 0;
    entry.damage = args.damage;
    entry.homingTargetMobId = args.homingTargetMobId;
    entry.trailHistory.length = 0;
    entry.trailSampleAccum = 0;
    entry.phaseOffset = Math.random() * Math.PI * 2;
    /* Reset trail ghosts to invisible (they'll fill in as the orb moves). */
    for (const ghost of entry.trail) {
      ghost.visible = false;
      const m = ghost.material as THREE.MeshBasicMaterial;
      m.opacity = 0;
    }
  }

  function update(dtSec: number): void {
    for (const entry of pool) {
      if (!entry.active) continue;
      entry.ageSec += dtSec;
      if (entry.ageSec > PROJECTILE_LIFE_SEC) {
        deactivate(entry);
        continue;
      }
      /* ---- Homing + locked-target auto-hit ----
       *
       * When `homingTargetMobId` is set (player has T-locked a mob and fired):
       *   1. Bend velocity aggressively toward the target's chest.
       *   2. If the bolt is within `LOCKED_TARGET_AUTOHIT_RADIUS` of the
       *      target, count it as a hit IMMEDIATELY — don't wait for the
       *      per-step XZ raycast (which can miss at low speed because the
       *      bolt's per-frame swept distance is comparable to the mob's
       *      footprint radius). This makes lock-on ALWAYS deliver damage
       *      once the bolt is on top of its target.
       */
      if (entry.homingTargetMobId != null) {
        const target = opts.mobs.getMob(entry.homingTargetMobId);
        if (target && target.state !== 'dying') {
          const targetAimY = target.y + (target.kind === 'rat' ? 0.3 : 1.0);
          const dx = target.x - entry.group.position.x;
          const dy = targetAimY - entry.group.position.y;
          const dz = target.z - entry.group.position.z;
          const dLen = Math.hypot(dx, dy, dz);
          /* Auto-hit guard. Gives the bolt a generous "yes you reached the
           * target" radius around the chest; without this, slow bolts with
           * sub-metre per-frame motion can graze right past a small mob
           * (rat r=0.4 m + bolt swept segment of 0.23 m → real risk of miss). */
          if (dLen < LOCKED_TARGET_AUTOHIT_RADIUS) {
            const mobBefore = target;
            const killed = opts.mobs.damage(entry.homingTargetMobId, entry.damage, {
              x: entry.group.position.x, z: entry.group.position.z,
            }, 'magic');
            const scale = opts.mobs.getProximityVolumeScale(mobBefore.x, mobBefore.z);
            emitMagicImpact(projectileAudio, scale);
            if (!killed) emitMobHit(projectileAudio, mobBefore.kind, scale);
            deactivate(entry);
            continue;
          }
          if (dLen > 0.01) {
            const desVx = (dx / dLen) * PROJECTILE_SPEED;
            const desVy = (dy / dLen) * PROJECTILE_SPEED;
            const desVz = (dz / dLen) * PROJECTILE_SPEED;
            const k = 1 - Math.exp(-HOMING_TURN_RATE * dtSec);
            entry.vx += (desVx - entry.vx) * k;
            entry.vy += (desVy - entry.vy) * k;
            entry.vz += (desVz - entry.vz) * k;
            const newLen = Math.hypot(entry.vx, entry.vy, entry.vz) || 1;
            entry.vx = (entry.vx / newLen) * PROJECTILE_SPEED;
            entry.vy = (entry.vy / newLen) * PROJECTILE_SPEED;
            entry.vz = (entry.vz / newLen) * PROJECTILE_SPEED;
          }
        } else {
          entry.homingTargetMobId = null;
        }
      }
      /* ---- Position integration ---- */
      const prevX = entry.group.position.x;
      const prevY = entry.group.position.y;
      const prevZ = entry.group.position.z;
      entry.group.position.x += entry.vx * dtSec;
      entry.group.position.y += entry.vy * dtSec;
      entry.group.position.z += entry.vz * dtSec;
      /* ---- Terrain hit despawn ----
       *
       * If the bolt has driven below the terrain at its current XZ, despawn
       * cleanly. This is what makes "aim straight down at the ground" feel
       * right — the bolt visibly leaves the staff, flies down, and stops at
       * ground impact instead of clipping under terrain and silently
       * persisting until lifetime expiry. Small epsilon (-0.05) so frame-
       * boundary jitter at very-shallow angles doesn't flicker. */
      const terrainY = opts.getTerrainHeight(entry.group.position.x, entry.group.position.z);
      if (entry.group.position.y < terrainY - 0.05) {
        deactivate(entry);
        continue;
      }
      /* ---- Visual animation phases ---- */
      const t = entry.ageSec + entry.phaseOffset;
      /* Inner core pulse — scale + emissive opacity. */
      const innerPulse = 1 + Math.sin(t * INNER_PULSE_HZ * Math.PI * 2) * 0.18;
      entry.innerCore.scale.setScalar(innerPulse);
      /* Mid shell slow rotation — drives iridescent shimmer with view angle. */
      entry.midShell.rotation.y += dtSec * 1.6;
      entry.midShell.rotation.x += dtSec * 0.9;
      /* Outer halo hue cycle. Smooth interpolation between HALO_HUE_STOPS. */
      const huePos = (t / HALO_HUE_PERIOD_SEC) % HALO_HUE_STOPS.length;
      const hueIdxA = Math.floor(huePos);
      const hueT = huePos - hueIdxA;
      const hueA = HALO_HUE_STOPS[hueIdxA % HALO_HUE_STOPS.length]!;
      const hueB = HALO_HUE_STOPS[(hueIdxA + 1) % HALO_HUE_STOPS.length]!;
      /* Shortest-path hue lerp to avoid wrapping the long way around the colour
       * wheel (which produces an unwanted greenish flash mid-transition). */
      let hueDelta = hueB - hueA;
      if (hueDelta > 0.5) hueDelta -= 1;
      else if (hueDelta < -0.5) hueDelta += 1;
      const hue = (hueA + hueDelta * hueT + 1) % 1;
      _scratchColor.setHSL(hue, 0.85, 0.6);
      (entry.outerHalo.material as THREE.MeshBasicMaterial).color.copy(_scratchColor);
      /* Halo opacity pulse — slightly out of phase with inner core for organic feel. */
      (entry.outerHalo.material as THREE.MeshBasicMaterial).opacity =
        0.22 + Math.sin(t * 5.0) * 0.08;
      /* Crystal orbit — each facet orbits at the same angular speed but with
       * a phase offset of (i / N) * 2pi so they read as a "ring" of magic. */
      const orbitT = t * CRYSTAL_ORBIT_SPEED;
      for (let i = 0; i < entry.crystals.length; i++) {
        const facet = entry.crystals[i]!;
        const phase = orbitT + (i / entry.crystals.length) * Math.PI * 2;
        /* Slight vertical wobble so the orbit isn't a flat ring; reads as a
         * 3D sphere of crystals, not a circle. */
        const wobble = Math.sin(t * 3.1 + i) * 0.08;
        facet.position.set(
          Math.cos(phase) * CRYSTAL_ORBIT_RADIUS,
          wobble,
          Math.sin(phase) * CRYSTAL_ORBIT_RADIUS,
        );
        /* Each facet also spins on its own axis for the "tumbling crystal" feel. */
        facet.rotation.x += dtSec * 4.5;
        facet.rotation.z += dtSec * 3.2;
      }
      /* ---- Trail history sampling + render ---- */
      entry.trailSampleAccum += dtSec;
      if (entry.trailSampleAccum >= TRAIL_SAMPLE_INTERVAL) {
        entry.trailSampleAccum -= TRAIL_SAMPLE_INTERVAL;
        entry.trailHistory.unshift({
          x: entry.group.position.x,
          y: entry.group.position.y,
          z: entry.group.position.z,
        });
        if (entry.trailHistory.length > TRAIL_LEN) {
          entry.trailHistory.length = TRAIL_LEN;
        }
      }
      for (let i = 0; i < entry.trail.length; i++) {
        const ghost = entry.trail[i]!;
        const sample = entry.trailHistory[i];
        if (!sample) {
          ghost.visible = false;
          continue;
        }
        ghost.visible = true;
        ghost.position.set(sample.x, sample.y, sample.z);
        /* Older samples = smaller + fainter. Use a linear fade from
         * (front-of-trail) to invisible at the tail. */
        const fade = 1 - i / entry.trail.length;
        ghost.scale.setScalar(0.45 + fade * 0.55);
        const m = ghost.material as THREE.MeshBasicMaterial;
        m.opacity = 0.18 + fade * 0.32;
        /* Match halo colour so the trail feels like a continuation of the orb. */
        m.color.copy(_scratchColor);
      }
      /* Group spin — adds extra magical motion to the whole assembly. The
       * crystal orbit already provides the dominant motion; this layer adds
       * a subtle global wobble. */
      entry.group.rotation.y += dtSec * 1.2;
      /* ---- Collision check (Y-aware raycast over swept segment) ----
       *
       * **2026-04 fix.** Was XZ-only — that despawned bolts the moment
       * their flat footprint path crossed any tree / wall / station
       * even when the bolt was flying VERTICALLY OVER the canopy. The
       * user-reported "magic doesn't reach the reticle when shooting
       * from a tree" was this: stand 5 m up on a tree, fire at a target
       * 25 m away → bolt's XZ path crosses 3-4 other trees' footprints
       * en route; XZ-only raycast despawns at the first one even though
       * the bolt is flying 4 m above the canopies.
       *
       * Y-aware mode filters each candidate footprint by checking the
       * bolt's Y at the hit XZ vs the obstacle's `[bottomY, topY]`
       * extent — so a bolt at Y=9 flying over a tree topping at Y=8
       * sails clean past instead of detonating mid-air. `dirY` is the
       * Y change per unit XZ distance, computed from the bolt's
       * velocity. */
      const segDx = entry.group.position.x - prevX;
      const segDy = entry.group.position.y - prevY;
      const segDz = entry.group.position.z - prevZ;
      const segLen = Math.hypot(segDx, segDz);
      if (segLen > 0.001) {
        const ux = segDx / segLen;
        const uz = segDz / segLen;
        /* Y per unit XZ travelled (`dirY` in collision-world contract):
         * world-Y at hit = `originY + dirY * hitDist_xz`. */
        const dirY = segDy / segLen;
        const hit = opts.collisionWorld.raycastXZ(prevX, prevZ, ux, uz, segLen + INNER_CORE_RADIUS, {
          ignoreOwnerId: PLAYER_OWNER_ID,
          originY: prevY,
          dirY,
        });
        if (hit) {
          if (hit.ownerId.startsWith('mob:')) {
            const mobId = parseInt(hit.ownerId.slice(4), 10);
            if (!isNaN(mobId)) {
              const mobBefore = opts.mobs.getMob(mobId);
              const killed = opts.mobs.damage(mobId, entry.damage, { x: prevX, z: prevZ }, 'magic');
              const scale = mobBefore
                ? opts.mobs.getProximityVolumeScale(mobBefore.x, mobBefore.z)
                : opts.mobs.getProximityVolumeScale(entry.group.position.x, entry.group.position.z);
              emitMagicImpact(projectileAudio, scale);
              if (mobBefore && !killed) {
                emitMobHit(projectileAudio, mobBefore.kind, scale);
              }
            }
          } else {
            /* Non-mob hit (harvest scatter, dock-forest, cabin piece, craft
             * station). Route to the caller-provided handler so they can
             * apply the right damage/harvest pipeline. The bolt despawns
             * at the hit point either way — magic doesn't punch through
             * walls / trees in this build. Cyan crackle plays at full
             * volume because we don't have proximity-mob context here;
             * acceptable since static hits are typically near the player
             * (you're aiming at what's in your reticle). */
            emitMagicImpact(projectileAudio, 1.0);
            if (opts.onStaticHit) {
              const hx = prevX + ux * hit.dist;
              const hz = prevZ + uz * hit.dist;
              opts.onStaticHit(hit.ownerId, hx, entry.group.position.y, hz, entry.damage);
            }
          }
          deactivate(entry);
        }
      }
    }
  }

  function deactivate(entry: PoolEntry): void {
    entry.active = false;
    entry.group.visible = false;
    for (const ghost of entry.trail) ghost.visible = false;
    entry.trailHistory.length = 0;
  }

  function warmShaders(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    /* Park one placeholder mesh per UNIQUE material so every program in the
     * pool's shader cache gets compiled in advance. Three.js's `WebGLPrograms`
     * keys programs by material parameters (vertexColors, fog, blending,
     * lights, …), and all 16 pool halo materials share identical params, so
     * one halo placeholder warms ALL 16 halos. Same for trail materials.
     *
     * Crystal materials all share the SAME parameter set (just different
     * runtime colour values) so one crystal placeholder warms all four
     * crystal colours. We parent everything to a temporary helper Group at
     * far-off coords (10000 m below ground) so the warm frame is invisible
     * even on the slowest GPUs.
     */
    const warmGroup = new THREE.Group();
    warmGroup.position.set(10000, -10000, 10000);
    /* Use the first pool entry's per-orb materials as the canonical warm
     * targets — they're identical to every other pool entry's materials,
     * so warming these warms the program cache for the whole pool. */
    const sample = pool[0]!;
    const tinyGeo = new THREE.SphereGeometry(0.01, 4, 3);
    const placeholderMeshes: THREE.Mesh[] = [
      new THREE.Mesh(tinyGeo, innerCoreMat),
      new THREE.Mesh(tinyGeo, midShellMat),
      new THREE.Mesh(tinyGeo, sample.outerHalo.material as THREE.Material),
      new THREE.Mesh(tinyGeo, crystalMats[0]!),
      new THREE.Mesh(tinyGeo, sample.trail[0]!.material as THREE.Material),
    ];
    for (const m of placeholderMeshes) {
      m.castShadow = false;
      m.receiveShadow = false;
      warmGroup.add(m);
    }
    root.add(warmGroup);
    try {
      /* JIT every program. Synchronous on the main thread — best done once
       * during the existing boot warm-pipeline window, not later under
       * gameplay pressure.
       *
       * **Critical:** compile against `opts.scene` (NOT `root`). Three.js
       * `WebGLPrograms` keys lit-material programs by the SCENE's fog,
       * environment, and light counts — compiling against just `root` (a
       * Group with no fog inherited and no env) produces the WRONG variant
       * and the actual first cast still triggers a re-link when the bolt
       * renders inside the fogged scene. Audit-flagged in the 2026-04-19
       * preload review.
       *
       * === 2026-04-20 non-blocking GPU compile ===
       *
       * Use `renderer.compileAsync` (Three r158+) so the program JIT runs
       * on the GPU's parallel-compile worker without blocking the JS
       * thread. Falls back to sync `compile` if the renderer doesn't
       * expose async (older Three or non-WebGL2 contexts). */
      const r = renderer as THREE.WebGLRenderer & {
        compileAsync?: (s: THREE.Object3D, c: THREE.Camera) => Promise<void>;
      };
      const cleanupNow = (): void => {
        root.remove(warmGroup);
        tinyGeo.dispose();
      };
      if (typeof r.compileAsync === 'function') {
        r.compileAsync(opts.scene, camera)
          .then(() => requestAnimationFrame(cleanupNow))
          .catch(() => requestAnimationFrame(cleanupNow));
        return;
      }
      renderer.compile(opts.scene, camera);
    } catch {
      /* renderer.compile is best-effort — swallow context-loss / state errors. */
    }
    /* Schedule cleanup next frame so the GPU has had a chance to finish
     * compiling before we drop the placeholder geometry. The program cache
     * survives mesh removal so the actual orbs render with the warmed
     * programs from now on. */
    requestAnimationFrame(() => {
      root.remove(warmGroup);
      tinyGeo.dispose();
    });
  }

  function dispose(): void {
    innerCoreGeo.dispose();
    midShellGeo.dispose();
    outerHaloGeo.dispose();
    crystalGeo.dispose();
    trailGeo.dispose();
    innerCoreMat.dispose();
    midShellMat.dispose();
    for (const m of crystalMats) m.dispose();
    /* Per-entry halo + trail materials need disposal too — they were
     * allocated per pool entry. */
    for (const entry of pool) {
      (entry.outerHalo.material as THREE.MeshBasicMaterial).dispose();
      for (const ghost of entry.trail) {
        (ghost.material as THREE.MeshBasicMaterial).dispose();
      }
    }
    if (root.parent) root.parent.remove(root);
  }

  /* === 2026-04-20 late-bind setters for extended-preload adoption ===
   *
   * Allow `dockExtendedPreload` to construct + warm this handle during the
   * title screen with stub callbacks (since mountApp's real `mobs` /
   * `onStaticHit` aren't available until after consume), then swap the real
   * refs in once mountApp adopts the prebuilt handle. AttachOpts is mutated
   * directly because the closures in `update`, `fire` etc. read
   * `opts.mobs` / `opts.onStaticHit` on every call. */
  function setOnStaticHit(cb: AttachOpts['onStaticHit'] | null): void {
    opts.onStaticHit = cb ?? undefined;
  }
  function setMobs(mobs: AwakenedMobsHandle): void {
    opts.mobs = mobs;
  }
  function setProjectileAudio(hooks: ProjectileAudioHooks | null): void {
    projectileAudio = hooks;
  }

  return { fire, update, warmShaders, setOnStaticHit, setMobs, setProjectileAudio, dispose };
}
