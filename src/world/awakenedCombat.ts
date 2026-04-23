/**
 * Awakened-mode combat input dispatcher (Phase 1.5 — see
 * `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` §13.1).
 *
 * Wired from `freeRoamControls.ts` LMB/RMB callbacks while camera-locked + NOT in build
 * mode. Reads `state.equipment.weapon` and dispatches the right action:
 *
 *   - **Wand / staff** (`apprentice_wand` / `journeyman_staff` / `archmage_staff`):
 *     fires a magic projectile from the staff tip toward the camera-aim point (or
 *     toward the locked-on target if lock-on is active). Mana cost per shot.
 *   - **Axe / sword** (any other `EQUIPPABLE_WEAPON_IDS`): center-ray cone-cast melee.
 *     First mob in the cone within `MELEE_RANGE` takes damage. Cooldown gated.
 *   - **Bare hand**: 1 dmg, 1.0 m range, melee path.
 *
 * **Block (RMB):** held while shield is equipped; reduces incoming damage 60%. Caller
 * (`mountApp`) wraps `damagePlayerInAwakened` to apply the reduction when block is
 * active.
 *
 * **Targeting (locked vs free):** when `lockOn.getTarget()` returns a mob, magic
 * projectiles ALWAYS home toward it (set `homingTargetMobId` on the projectile fire).
 * Melee swings always center-ray (lock-on doesn't auto-aim melee — too punishing if
 * the target moves out of arc mid-swing).
 *
 * **Animations:** `scenePreview.playInPlaceCombatClip('cast' | 'strike')` is called
 * for visual feedback (avatar plays `battle_cast` or `battle_strike` clip in place).
 */
import * as THREE from 'three';
import { EQUIPPABLE_SHIELD_IDS } from '../data/content';
import {
  playMeleeImpactSound,
  playMobHitSound,
  playPlayerMagicCastSound,
  playPlayerSwingSound,
} from '../audio/audioBridge';
import type { CollisionWorldHandle } from './collisionWorld';
import type { AwakenedMobsHandle } from './awakenedMobs';
import type { LockOnHandle } from './lockOnController';
import type { MagicProjectilesHandle } from './magicProjectiles';
import type { DefensiveWardHandle } from './defensiveWard';

/* ============================================================================
 * Constants
 * ============================================================================ */

const MELEE_RANGE = 2.5;
/** Staff swing range — slightly longer than bare-hand because the staff IS visibly long
 * (the Vanguard's wizard staff). Used when no weapon is equipped. */
const STAFF_RANGE = 2.2;
/** Cooldown between LMB attacks (ms). */
const ATTACK_COOLDOWN_MS = 600;
/** Default mana cost per magic projectile cast. */
const MAGIC_MANA_COST = 4;
/** Block damage reduction (multiplier on incoming damage). */
const BLOCK_DAMAGE_FACTOR = 0.4; /* 60% reduction */
/** Player owner id — projectiles + raycasts ignore this. */
const PLAYER_OWNER_ID = 'player';


/* Wand/staff item ids — readable subset of EQUIPPABLE_WEAPON_IDS. */
const WAND_STAFF_IDS = new Set(['apprentice_wand', 'journeyman_staff', 'archmage_staff']);

/**
 * Dev override: when `localStorage.idleCraft.devAwakenedMagic === '1'`, LMB with no
 * weapon equipped fires a magic projectile from the Vanguard's always-visible silver
 * staff (built into the avatar rig in `vanguardWizardLPCA.ts`). This lets us test the
 * magic projectile / lock-on / damage-floater stack without grinding up wand crafts.
 *
 * Read once per session (not per click) — same pattern as `idleCraft.devUnlockAllNodes`
 * + `idleCraft.devUnlockAwakening`. Toggle on at the JS console:
 *
 *     localStorage.setItem('idleCraft.devAwakenedMagic', '1'); location.reload();
 *
 * No UI surface yet — dev-only hatch. Not committed to a card-system unlock because
 * the magic-deck design is still TBD (LEARNINGS Phase 1.5 caveats).
 */
function readDevAwakenedMagicFlag(): boolean {
  try {
    return localStorage.getItem('idleCraft.devAwakenedMagic') === '1';
  } catch {
    return false;
  }
}

/* ============================================================================
 * Public handle
 * ============================================================================ */

export interface AwakenedCombatHandle {
  /** LMB pressed while camera-locked (and not in build mode). */
  onLMB(): void;
  /** RMB pressed (start block). */
  onRMBDown(): void;
  /** RMB released (end block). */
  onRMBUp(): void;
  /** True while the player is actively blocking (shield + RMB held). */
  isBlocking(): boolean;
  /**
   * Wraps incoming player damage with the block reduction. Call this from anywhere a
   * mob/player damage event lands (currently `awakenedMobs.update` calls
   * `store.damagePlayerInAwakened` directly — pre-multiplied here so block-aware
   * damage is the authoritative value).
   */
  applyDamageMultiplier(amount: number): number;
  /**
   * Camera-ray aim resolution — surfaces what the reticle is currently
   * crosshairing in 3D world space (mob, static obstacle, terrain) plus
   * the genuine 3D hit point. Reused by the universal-harvest picker
   * (`mountApp.ts`) so "press E to harvest whatever the reticle is on"
   * shares the same ray-vs-world math as the magic-cast path. The
   * `mobOwnerId` / `staticOwnerId` outputs let callers route to the
   * right harvest path (mob corpse skin / scattered node hit / dock-
   * forest hit) without duplicating the ray query.
   */
  resolveReticleAim(maxDist: number): {
    x: number;
    y: number;
    z: number;
    distFromCamera: number;
    mobOwnerId: string | null;
    staticOwnerId: string | null;
  };
  dispose(): void;
}

interface AttachOpts {
  scene: THREE.Scene;
  camera: THREE.Camera;
    /** Live store reference — read equipment + mana, mutate. */
  store: {
    getState: () => {
      equipment: { weapon: string | null; offhand?: string | null };
      mana: number;
      equippedOffensiveSpellId: string | null;
      equippedDefensiveSpellId: string | null;
      combatMode: 'hit' | 'magic';
    };
    useMana: (amount: number) => boolean;
    /**
     * Returns the live `CardDef`-shaped object (pulled from `cardDefs`) for the
     * equipped offensive spell, or null when no slot is set. Used by `castMagic` to
     * read damage + manaCost. Kept as a hook (not a direct cardDefs lookup) so the
     * combat module stays free of the cards-data dependency. Same for defense.
     */
    getOffensiveSpellCard: () => { id: string; battle?: { damage?: number; manaCost?: number } } | null;
    getDefensiveSpellCard: () => { id: string; battle?: { wardFlat?: number; manaCost?: number } } | null;
  };
  /** Scene preview hook — used to read staff tip + play in-place clips. */
  scenePreview: {
    getStaffTipWorldPosition(): { x: number; y: number; z: number };
    playInPlaceCombatClip(kind: 'cast' | 'strike'): void;
  };
  collisionWorld: CollisionWorldHandle;
  /**
   * Terrain heightfield sampler — used by the 3D aim raycast to find where
   * the camera ray hits the ground. Without this, "aim at the spot on the
   * map under my reticle" can't resolve to a 3D point because the collision
   * world only knows about discrete obstacle footprints (trees, walls,
   * mobs), not the heightfield. Same sampler the dock + free-roam use.
   */
  getTerrainHeight: (x: number, z: number) => number;
  mobs: AwakenedMobsHandle;
  lockOn: LockOnHandle;
  magicProjectiles: MagicProjectilesHandle;
  /**
   * Optional defensive-ward handle. When provided, RMB-Down + a defensive spell
   * equipped engages the ward (replaces the legacy shield-block flat reduction).
   * Without a defensive spell, RMB still falls back to shield-block as before.
   */
  defensiveWard?: DefensiveWardHandle;
}

/* ============================================================================
 * Implementation
 * ============================================================================ */

export function attachAwakenedCombat(opts: AttachOpts): AwakenedCombatHandle {
  let blocking = false;
  let nextAttackReadyMs = 0;
  /* Latched at attach so a session-long hot-reload of localStorage doesn't disturb
   * an in-flight combat session. Restart picks up the new value. */
  const devAwakenedMagic = readDevAwakenedMagicFlag();

  const tmpForward = new THREE.Vector3();

  function isShieldEquipped(): boolean {
    const oh = opts.store.getState().equipment.offhand;
    return !!oh && (EQUIPPABLE_SHIELD_IDS as readonly string[]).includes(oh);
  }

  /**
   * Resolve the magic projectile's free-aim target as the GENUINE 3D WORLD
   * POINT under the reticle — wherever the camera ray from screen centre
   * actually intersects the world (creature, tree, wall, ground). The
   * bolt then fires from the staff tip TO that 3D point, so it visibly
   * converges on whatever the reticle is over: long-range shots look
   * near-parallel to camera-forward; close-range shots angle visibly to
   * land on target. This is the standard "muzzle convergence" pattern
   * used by every mainstream 3rd-person shooter.
   *
   * **2026-04 robustness pass.** Earlier algorithm picked
   * `min(terrainHit, obstacleHit)`. Two failure modes that produced the
   * "magic lands way below my reticle target" + "magic flies way too
   * fast" complaints:
   *
   *   1. **Coarse terrain stepping (1 m).** A small terrain bump between
   *      camera and target produced a false ground crossing at e.g. 4 m.
   *      That hit beat the real obstacle at 22 m → bolt slammed into
   *      dirt right in front of the player. The "too fast" complaint is
   *      the same bug — bolt at constant 14 m/s feels hitscan when its
   *      flight distance collapses from 22 m → 4 m.
   *
   *   2. **No mob preference.** A mob hit at 20 m always lost to ANY
   *      closer terrain/static hit, even when the reticle was clearly
   *      crosshaired on the creature. AAA shooters auto-promote enemy
   *      hits to authoritative aim within a tolerance — without this,
   *      tracking a moving mob across an uneven hillside misses
   *      constantly because terrain noise wins the race.
   *
   * **New algorithm — three independent candidates, mob-preferred:**
   *
   *   1. **Mob hit.** Y-aware collision raycast filtered to mob
   *      footprints (`hitMobsOnly: true`). Whatever mob the camera ray
   *      genuinely intersects in 3D space wins aim, even if a closer
   *      terrain bump exists in front. This is what makes the bolt
   *      reliably hit creatures the reticle is on, regardless of
   *      undulating ground between you and them.
   *
   *   2. **Static obstacle hit.** Y-aware raycast over trees / walls /
   *      stations / cabin pieces (excludes mobs — those are handled
   *      above). Used when no mob is in the line of sight.
   *
   *   3. **Terrain hit.** Walks the camera ray in fine 0.4 m steps,
   *      finds the first ray.y < ground.y crossing, binary-refines to
   *      ~5 mm precision. The fine step kills the false-crossing failure
   *      mode at noisy terrain edges.
   *
   * Final aim distance: prefer the mob hit unconditionally if one
   * exists; otherwise pick `min(staticT, terrainT)` for the standard
   * "closest blocker wins" behaviour. Falls back to camera-forward at
   * `maxDist` when nothing fires (open-air shot into the distance).
   *
   * Also enforces a small `MIN_AIM_DIST` so degenerate near-camera hits
   * (the player's own footprint, a station the camera is partially
   * inside) can't collapse aim to the player's feet.
   *
   * **Lock-on still wins:** when `lockOn.getTarget()` returns a mob, the
   * caller bypasses this function entirely and aims at the target chest;
   * the projectile module's homing logic takes over.
   */
  /**
   * Aim resolution result. `mobOwnerId` is set when the camera ray
   * intersected a mob footprint — callers can use this to soft-home
   * even free-aim casts onto the creature the player is crosshairing
   * (so a moving target can't dodge a free-aim bolt by sidestepping).
   */
  interface AimResult {
    x: number;
    y: number;
    z: number;
    /** Distance from camera along forward (3D). */
    distFromCamera: number;
    /** When set, the camera ray hit this mob (e.g. `'mob:7'`). */
    mobOwnerId: string | null;
    /** When set, the camera ray hit a static obstacle owner (`'harvest:tree:3'`, ...). */
    staticOwnerId: string | null;
  }

  function reticleAimPoint(maxDist: number): AimResult {
    opts.camera.getWorldDirection(tmpForward);
    const camPos = new THREE.Vector3();
    opts.camera.getWorldPosition(camPos);
    const fx = tmpForward.x;
    const fy = tmpForward.y;
    const fz = tmpForward.z;
    const xzLen = Math.hypot(fx, fz);

    /* Minimum aim distance for STATIC hits — anything closer is treated
     * as "no hit" so a camera intersecting its own player footprint
     * (3rd-person camera sits behind the avatar; the capsule extends a
     * fraction of a metre forward of the actual mesh) or partially
     * inside a station/wall doesn't collapse aim to the muzzle. Mobs
     * use a much smaller floor so point-blank creature shots still land. */
    const MIN_AIM_DIST = 1.2;
    const MIN_AIM_DIST_MOB = 0.4;

    /* === 1. MOB HIT (Y-aware raycast + 3D aim-assist) ===
     * Promoted to top priority so the reticle tracking a creature lands
     * the bolt on that creature even when terrain noise / nearby plants
     * would otherwise hijack the closest-hit pick.
     *
     * Two complementary picks:
     *   1a. **Y-aware XZ raycast** — direct precise hit on a mob the
     *       camera ray actually pierces (chest height matches ray Y).
     *       Returns the EXACT 3D distance to the mob's footprint edge.
     *   1b. **3D aim-assist** — for each live mob, compute the closest
     *       point on the camera ray to the mob's chest. If that distance
     *       is within `MOB_AIM_ASSIST_RADIUS_3D` (1.6 m) AND no closer
     *       static obstacle blocks the line of sight, snap aim to the
     *       mob. Solves two reported failure modes:
     *         - "Rat on top of a fern, I shoot the fern instead of the
     *           rat" — the camera ray's XZ raycast hits the fern's
     *           footprint; aim-assist picks up the rat overhead anyway.
     *         - "Standing on a tall tree, can't hit the wolf below" —
     *           camera ray's Y at wolf's XZ is way above wolf.topY, so
     *           Y-aware raycast skips the wolf; aim-assist's 3D
     *           ray-vs-point distance still flags the wolf as in the
     *           reticle's neighbourhood.
     *
     * Aim-assist's effective angular tolerance scales with distance:
     * 1.6 m off the ray at 5 m = 18° wide; at 30 m = 3° wide. Generous
     * up close (where mobs swarm), tight at range (where the player
     * has to deliberately track a far target). */
    const MOB_AIM_ASSIST_RADIUS_3D = 1.6;
    let mobT: number | null = null;
    let mobOwnerId: string | null = null;
    if (xzLen >= 0.001) {
      const ux = fx / xzLen;
      const uz = fz / xzLen;
      const dirY = fy / xzLen;
      const mobHit = opts.collisionWorld.raycastXZ(
        camPos.x, camPos.z, ux, uz, maxDist * xzLen,
        {
          hitMobsOnly: true,
          ignoreOwnerId: 'player',
          originY: camPos.y,
          dirY,
        },
      );
      if (mobHit) {
        const d3d = mobHit.dist / xzLen;
        if (d3d >= MIN_AIM_DIST_MOB) {
          mobT = d3d;
          mobOwnerId = mobHit.ownerId;
        }
      }
    }
    /* 3D aim-assist scan — runs even when the precise raycast hit, so a
     * closer mob next to the ray can still win over a farther mob the
     * raycast happened to slice through. Comparison is strictly by 3D
     * distance from camera so the closer mob wins regardless of which
     * pick produced it. */
    {
      const mobs = opts.mobs.getAllMobs();
      let bestT = mobT ?? Infinity;
      let bestOwner = mobOwnerId;
      for (const mob of mobs) {
        if (mob.state === 'dying' || mob.state === 'corpse') continue;
        /* Mob center for ray-distance: chest height per kind. Same offsets
         * the lock-on auto-hit uses so the assist target matches what the
         * homing logic considers "the mob's body." */
        const cx = mob.x;
        const cy = mob.y + (mob.kind === 'rat' ? 0.2 : 0.7);
        const cz = mob.z;
        const dx = cx - camPos.x;
        const dy = cy - camPos.y;
        const dz = cz - camPos.z;
        /* Project mob position onto the camera-forward ray to get the
         * distance ALONG the ray. Negative t = mob is behind the camera;
         * skip. */
        const t = dx * fx + dy * fy + dz * fz;
        if (t < MIN_AIM_DIST_MOB || t > maxDist) continue;
        /* Closest point on ray to mob center; perpendicular distance. */
        const px = camPos.x + fx * t;
        const py = camPos.y + fy * t;
        const pz = camPos.z + fz * t;
        const perp = Math.hypot(cx - px, cy - py, cz - pz);
        if (perp >= MOB_AIM_ASSIST_RADIUS_3D) continue;
        if (t < bestT) {
          bestT = t;
          bestOwner = `mob:${mob.id}`;
        }
      }
      if (bestT !== Infinity) {
        mobT = bestT;
        mobOwnerId = bestOwner;
      }
    }

    /* === 2. STATIC OBSTACLE HIT (Y-aware, mobs excluded) ===
     * Ordinary world geometry — trees, walls, stations, foundations.
     * Cheaper than trying to filter mobs out of a unified hit list
     * (the collision-world `hitMobsOnly` short-circuits in the inner
     * loop, so the two queries together visit every footprint at most
     * once each). */
    let staticT: number | null = null;
    let staticOwnerId: string | null = null;
    if (xzLen >= 0.001) {
      const ux = fx / xzLen;
      const uz = fz / xzLen;
      const dirY = fy / xzLen;
      /* `raycastXZ` with no `hitMobsOnly` returns the first hit on ANY
       * footprint — including mobs. We filter mobs out below by ignoring
       * the result if it matches the mob hit we already have. Slightly
       * wasteful but simple; mob hits are already promoted above so this
       * just makes sure a static hit BEHIND the mob doesn't pick up. */
      const hit = opts.collisionWorld.raycastXZ(
        camPos.x, camPos.z, ux, uz, maxDist * xzLen,
        {
          ignoreOwnerId: 'player',
          originY: camPos.y,
          dirY,
        },
      );
      if (hit && !hit.ownerId.startsWith('mob:')) {
        const d3d = hit.dist / xzLen;
        if (d3d >= MIN_AIM_DIST) {
          staticT = d3d;
          staticOwnerId = hit.ownerId;
        }
      }
    }

    /* === 3. TERRAIN HIT (fine-grained ray march + binary refine) ===
     * 0.4 m step (was 1.0 m) so a small terrain bump can no longer
     * register a false crossing. Binary search bracket is correspondingly
     * tighter — 6 iters from 0.4 m gives ~6 mm precision. */
    let terrainT: number | null = null;
    {
      const STEP = 0.4;
      let prevT = 0;
      let prevDelta = camPos.y - opts.getTerrainHeight(camPos.x, camPos.z);
      if (prevDelta < 0) {
        /* Camera underground — pathological; bail and let obstacle/far
         * fallback handle the shot. */
        terrainT = null;
      } else {
        for (let t = STEP; t <= maxDist; t += STEP) {
          const x = camPos.x + fx * t;
          const y = camPos.y + fy * t;
          const z = camPos.z + fz * t;
          const groundY = opts.getTerrainHeight(x, z);
          const delta = y - groundY;
          if (delta < 0) {
            let lo = prevT;
            let hi = t;
            for (let i = 0; i < 6; i++) {
              const mid = (lo + hi) * 0.5;
              const mx = camPos.x + fx * mid;
              const my = camPos.y + fy * mid;
              const mz = camPos.z + fz * mid;
              const mGround = opts.getTerrainHeight(mx, mz);
              if (my < mGround) hi = mid;
              else lo = mid;
            }
            terrainT = (lo + hi) * 0.5;
            break;
          }
          prevT = t;
          prevDelta = delta;
        }
      }
    }

    /* === Pick aim point ===
     * Mob hit always wins when present (creature the player is
     * crosshairing). Otherwise the standard "closest blocker" pick
     * across static obstacles + terrain. */
    let t: number;
    let resolvedMob: string | null = mobOwnerId;
    let resolvedStatic: string | null = null;
    if (mobT != null) {
      t = mobT;
    } else if (staticT != null && terrainT != null) {
      if (staticT <= terrainT) {
        t = staticT;
        resolvedStatic = staticOwnerId;
      } else {
        t = terrainT;
      }
    } else if (staticT != null) {
      t = staticT;
      resolvedStatic = staticOwnerId;
    } else if (terrainT != null) {
      t = terrainT;
    } else {
      t = maxDist;
    }
    return {
      x: camPos.x + fx * t,
      y: camPos.y + fy * t,
      z: camPos.z + fz * t,
      distFromCamera: t,
      mobOwnerId: resolvedMob,
      staticOwnerId: resolvedStatic,
    };
  }

  /** Melee weapon damage by id — reads from existing weapon stats. Phase 1.5 uses
   * provisional values matching deck-mode battle damage tiers.
   *
   * **Staff fallback** — when no weapon is equipped, the Vanguard ALWAYS visibly
   * carries his staff (`vanguardWizardLPCA.ts` builds it as part of the avatar rig).
   * Swinging the staff in melee is the player's "always-available" baseline attack —
   * even with zero crafted weapons + zero magic deck unlocked, the player can hit.
   * Damage tuned just below a basic axe so crafted weapons still feel like an upgrade.
   */
  function meleeDamageFor(weaponId: string | null): number {
    switch (weaponId) {
      case null:
      case undefined: return 3; /* staff swing — always available */
      case 'axe': return 4;
      case 'copper_axe': return 5;
      case 'bronze_axe': return 6;
      case 'brass_axe': return 7;
      case 'iron_axe': return 8;
      case 'steel_axe': return 10;
      case 'bronze_sword': return 7;
      case 'iron_sword': return 9;
      case 'steel_sword': return 12;
      case 'silver_sword': return 14;
      case 'gold_sword': return 16;
      case 'platinum_sword': return 19;
      default: return 3; /* unknown weapon */
    }
  }

  /** Magic damage by staff id — provisional. */
  function magicDamageFor(weaponId: string): number {
    switch (weaponId) {
      case 'apprentice_wand': return 6;
      case 'journeyman_staff': return 11;
      case 'archmage_staff': return 18;
      default: return 5;
    }
  }

  function castMagic(staffId: string): void {
    /* Equipped offensive spell wins over the staff's intrinsic baseline — that's the
     * whole point of the spell-equipment system. The CardDef carries both the damage
     * AND the mana cost, so equipping a higher-tier spell automatically scales both
     * the burn and the bite. Falls back to the staff's baseline (`magicDamageFor` +
     * `MAGIC_MANA_COST`) only when no spell is equipped — keeps the dev-magic flag
     * + first-time staff use functional even before the player picks a spell. */
    const equippedSpell = opts.store.getOffensiveSpellCard();
    const damage = equippedSpell?.battle?.damage ?? magicDamageFor(staffId);
    const manaCost = equippedSpell?.battle?.manaCost ?? MAGIC_MANA_COST;
    if (!opts.store.useMana(manaCost)) {
      /* Insufficient mana — silent fail; future polish: empty-cast SFX. */
      return;
    }
    const origin = opts.scenePreview.getStaffTipWorldPosition();
    const target = opts.lockOn.getTarget();
    /* Aim resolution (standard 3rd-person-shooter convergence pattern —
     * Gears of War / Fortnite / Last of Us / Skyrim 3P all do this):
     *
     *   1. LOCK-ON target (T-toggle) — fly straight to the locked mob's
     *      chest; per-frame homing bend takes over via the projectile
     *      module's own logic.
     *   2. FREE-AIM (default) — raycast from the camera through the
     *      reticle, pick the genuine 3D world point under the crosshair
     *      (mob > static > terrain priority), and fire the bolt from
     *      the staff tip TO that point. If the camera ray clearly
     *      intersected a mob, ALSO set the projectile's
     *      `homingTargetMobId` so the bolt soft-homes onto that mob
     *      mid-flight — protects against "mob sidestepped between cast
     *      and impact" misses without making free-aim feel as sticky as
     *      hard lock-on (the homing only engages because the player
     *      genuinely had the creature crosshaired at cast time).
     *   3. FALLBACK (no obstacle within 40 m) — straight line from
     *      camera forward × 40 m. Bolt flies into open space toward the
     *      reticle.
     */
    let aimX: number, aimY: number, aimZ: number;
    let homingTargetMobId: number | null;
    if (target) {
      aimX = target.x;
      aimY = target.y + (target.kind === 'rat' ? 0.3 : 1.0);
      aimZ = target.z;
      homingTargetMobId = target.id;
    } else {
      const aim = reticleAimPoint(40);
      aimX = aim.x;
      aimY = aim.y;
      aimZ = aim.z;
      /* Free-aim mob soft-snap: if the camera ray passed through a mob
       * footprint, surface that mob's id to the projectile so its homing
       * loop can bend the bolt onto the live target position. The mob's
       * collision-world owner-id is `mob:<id>`; parse the numeric tail. */
      homingTargetMobId = null;
      if (aim.mobOwnerId && aim.mobOwnerId.startsWith('mob:')) {
        const id = parseInt(aim.mobOwnerId.slice(4), 10);
        if (!isNaN(id)) homingTargetMobId = id;
      }
    }
    opts.magicProjectiles.fire({
      originX: origin.x,
      originY: origin.y,
      originZ: origin.z,
      aimX, aimY, aimZ,
      homingTargetMobId,
      damage,
    });
    opts.scenePreview.playInPlaceCombatClip('cast');
    /* Cast SFX — fires every shot regardless of hit. The corresponding magic-IMPACT
     * SFX fires from `magicProjectiles.ts` when the orb actually lands on a target. */
    playPlayerMagicCastSound();
  }

  function meleeSwing(weaponId: string | null): void {
    /* Two-stage hit detection so point-blank attacks ALWAYS register:
     *   (1) Forward camera raycast vs collision world — the canonical FPS-style hit.
     *       Captures hits where the player is aiming at a mob 1-3 m ahead.
     *   (2) FALLBACK: 360° proximity scan within a tight bite radius. Catches the
     *       case where a mob is so close to the avatar that the camera's forward
     *       ray (which originates ~1.7 m above ground) doesn't intersect the mob's
     *       footprint at the player's feet, OR where the mob has flanked the player
     *       (rats love to circle). Resolves the "hit doesn't engage when they're
     *       right up against the character" report.
     *
     * Range scales with weapon: no-weapon → STAFF_RANGE (2.2 m, the Vanguard's
     * always-visible wizard staff); crafted melee weapon → MELEE_RANGE (2.5 m).
     * The proximity fallback uses a tighter `BITE_RADIUS` so it doesn't auto-aim
     * at distant flanking enemies — only true point-blank threats.
     */
    const range = weaponId == null ? STAFF_RANGE : MELEE_RANGE;
    /* Bite-radius for the proximity fallback. Slightly bigger than the avatar's
     * collision radius (~0.4 m) plus a typical mob footprint (~0.5 m), so any mob
     * in physical contact with the avatar is captured. */
    const BITE_RADIUS = 1.6;
    opts.camera.getWorldDirection(tmpForward);
    const camPos = new THREE.Vector3();
    opts.camera.getWorldPosition(camPos);
    const ux = tmpForward.x;
    const uz = tmpForward.z;
    const ulen = Math.hypot(ux, uz) || 1;

    let hitMobId: number | null = null;
    /* Stage 1: forward raycast. */
    const hit = opts.collisionWorld.raycastXZ(
      camPos.x, camPos.z,
      ux / ulen, uz / ulen,
      range,
      { hitMobsOnly: true, ignoreOwnerId: PLAYER_OWNER_ID },
    );
    if (hit && hit.ownerId.startsWith('mob:')) {
      const id = parseInt(hit.ownerId.slice(4), 10);
      if (!isNaN(id)) hitMobId = id;
    }

    /* Stage 2: proximity fallback — only runs if stage 1 missed. Picks the closest
     * non-dying mob within BITE_RADIUS using the avatar's XZ as origin (NOT the
     * camera's, since the avatar is what's being mauled). Uses the mobs handle's
     * full live snapshot — cheap (≤ MAX_ALIVE = 6 entries). */
    if (hitMobId == null) {
      const allMobs = opts.mobs.getAllMobs();
      const ax = opts.scenePreview.getStaffTipWorldPosition().x;
      const az = opts.scenePreview.getStaffTipWorldPosition().z;
      let bestDist = BITE_RADIUS;
      for (const m of allMobs) {
        if (m.state === 'dying') continue;
        const dist = Math.hypot(m.x - ax, m.z - az);
        if (dist < bestDist) {
          bestDist = dist;
          hitMobId = m.id;
        }
      }
    }

    /* Always play the swing whoosh — the staff/blade arc reads in audio even on
     * misses so the player feels their action committed. The IMPACT thud + mob
     * pain voice only fire when a hit lands. */
    playPlayerSwingSound();
    if (hitMobId != null) {
      const mobBefore = opts.mobs.getMob(hitMobId);
      const killed = opts.mobs.damage(hitMobId, meleeDamageFor(weaponId), { x: camPos.x, z: camPos.z });
      playMeleeImpactSound();
      if (mobBefore && !killed) {
        /* Fire the mob's hit voice only on non-killing hits — the kill shot's death
         * voice (fired by the mob system on state transition to dying) replaces it. */
        playMobHitSound(mobBefore.kind);
      }
    }
    opts.scenePreview.playInPlaceCombatClip('strike');
  }

  function onLMB(): void {
    const nowMs = Date.now();
    if (nowMs < nextAttackReadyMs) return;
    nextAttackReadyMs = nowMs + ATTACK_COOLDOWN_MS;
    const state = opts.store.getState();
    const weapon = state.equipment.weapon;

    /* === Dispatch priority (with combat-mode toggle) ===
     *
     * The `combatMode` flag (`'hit'` vs `'magic'`) is the player's "what does my
     * LMB do" preference. Flipped via M hotkey or the shortcut-bar toggle button.
     *
     *   1. EQUIPPED OFFENSIVE SPELL + `'magic'` mode — cast the spell AND swing
     *      melee in the SAME LMB press. The spell handles long-range damage;
     *      the swing chips anyone who closed in (close-range insurance). Both
     *      animations layer naturally — the cast clip plays its arms while the
     *      melee hit registers via raycast. Combined attack reads as "I cast
     *      and someone got too close, so I also smacked them."
     *   2. EQUIPPED OFFENSIVE SPELL + `'hit'` mode — melee only. Spell stays
     *      equipped (re-engages instantly on mode flip back to magic) but doesn't
     *      fire. Use to conserve mana while still keeping the spell loadout ready.
     *   3. WAND / STAFF EQUIPPED + no spell slotted — cast with the staff's
     *      baseline damage. Combat mode is ignored here — the player has no spell
     *      slotted, so there's nothing to toggle off.
     *   4. DEV MAGIC FLAG + no weapon + no spell — cast with apprentice baseline.
     *   5. DEFAULT — melee swing with whatever weapon (or bare hand).
     *
     * The `combatMode` toggle only matters on branches 1+2; everywhere else the
     * dispatch is unambiguous from equipment alone.
     */
    if (state.equippedOffensiveSpellId) {
      if (state.combatMode === 'magic') {
        /* Cast spell + melee swing — both fire from this single LMB. The cast
         * spawns the projectile from the staff tip; the swing's center-ray
         * raycast lands the close-range hit. Audio + animation overlap cleanly
         * because the cast clip uses arms + battleSpark while the swing clip
         * is a separate one-shot. */
        castMagic(weapon ?? 'apprentice_wand');
        meleeSwing(weapon);
      } else {
        meleeSwing(weapon);
      }
      return;
    }
    if (weapon && WAND_STAFF_IDS.has(weapon)) {
      castMagic(weapon);
      return;
    }
    if (devAwakenedMagic && weapon == null) {
      /* Dev override: bare-hand silver-staff casts magic instead of swinging.
       * Apprentice-wand damage tier so the test feels like the lowest crafted
       * staff. Cast SFX + projectile orb + lock-on homing identical to real cast. */
      castMagic('apprentice_wand');
      return;
    }
    meleeSwing(weapon);
  }

  function onRMBDown(): void {
    /* Defensive-spell first, shield-block fallback. The spell-ward is a more
     * interesting mechanic (mana cost, capacity, big visual) so it takes priority
     * when a card is slotted; if no spell is equipped, the shield's old flat
     * reduction is still useful and stays available. */
    const def = opts.store.getDefensiveSpellCard();
    if (opts.defensiveWard && def && typeof def.battle?.wardFlat === 'number' && def.battle.wardFlat > 0) {
      opts.defensiveWard.setActive(true, def.battle.wardFlat);
      return;
    }
    if (!isShieldEquipped()) return;
    blocking = true;
  }

  function onRMBUp(): void {
    /* Drop both the spell ward AND the shield-block on release. Either may be active
     * depending on which path engaged on RMB-Down; both being safe-no-op when not
     * active means we don't need to track which one started. */
    if (opts.defensiveWard) opts.defensiveWard.setActive(false);
    blocking = false;
  }

  function applyDamageMultiplier(amount: number): number {
    /* Order matters: ward absorbs first (capacity-based), then shield reduces
     * the remainder. This way a player with both equipped gets the ward's full
     * absorb plus shield reduction on whatever bleeds through. */
    let remaining = amount;
    if (opts.defensiveWard?.isActive()) {
      remaining = opts.defensiveWard.absorbDamage(remaining);
    }
    if (blocking) remaining *= BLOCK_DAMAGE_FACTOR;
    return remaining;
  }

  return {
    onLMB,
    onRMBDown,
    onRMBUp,
    isBlocking: () => blocking,
    applyDamageMultiplier,
    resolveReticleAim: (maxDist: number) => reticleAimPoint(maxDist),
    dispose: () => {
      blocking = false;
    },
  };
}
