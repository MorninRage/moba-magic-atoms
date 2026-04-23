/**
 * Awakened-mode defensive ward (Phase 1.5 player-feedback addition).
 *
 * Magical shield bubble that surrounds the player when they hold the defensive-cast
 * input (RMB while a defensive spell is equipped). Visually a translucent emissive
 * sphere with TWO rotating equator rings of dotted runes — reads as "actively woven
 * mana", not a static shell. Phantom-light rule honored: pure emissive material, no
 * `THREE.PointLight`.
 *
 * **Behavior contract:**
 *   - `setActive(true)` while a defensive spell is equipped engages the ward; ward
 *     drains mana at `MANA_DRAIN_PER_SEC` (consumed via `useMana` per frame). When
 *     mana hits zero, the ward auto-disengages.
 *   - `applyDamageMultiplier(amount)` returns the post-ward damage. The ward absorbs
 *     `wardCapacity` total damage before falling. After capacity is spent, the ward
 *     auto-disengages and incoming damage is unmodified (caller must re-equip after
 *     a cooldown — handled at the spell layer when implemented).
 *   - `update(dt, playerXYZ)` follows the player + animates rings.
 *
 * **Pool size:** 1 — only one defensive ward can be active at a time. Created lazily
 * on first attach.
 */
import * as THREE from 'three';

const SPHERE_RADIUS = 1.05;
const RING_INNER = 1.05;
const RING_OUTER = 1.18;
/** Per-second rotation rate of the inner / outer rune rings (rad/sec). */
const RING_SPIN_INNER = 0.6;
const RING_SPIN_OUTER = -0.4;
const SPHERE_COLOR = 0xff7afe;     /* magenta — matches the lock-on reticle palette */
const RING_COLOR = 0xffd2ff;       /* lighter glow for the runes — pops against the dome */

/* ============================================================================
 * Public handle
 * ============================================================================ */

export interface DefensiveWardHandle {
  /** True when the ward is currently active + visible. */
  isActive(): boolean;
  /**
   * Engage / disengage the ward. Engage requires `wardCapacity > 0`; pass the spell's
   * `wardFlat` so the ward knows how much damage it can absorb before failing.
   */
  setActive(on: boolean, wardCapacity?: number): void;
  /**
   * Per-frame: position the ward at the player's XYZ + animate ring rotation. Drains
   * mana via the provided `useMana` callback; auto-deactivates when mana runs out.
   */
  update(dtSec: number, playerPos: { x: number; y: number; z: number }, useMana: (amt: number) => boolean): void;
  /**
   * Apply incoming-damage absorption. Returns the post-ward damage that should reach
   * the player. Reduces remaining capacity by the absorbed amount; auto-deactivates
   * when capacity hits zero.
   */
  absorbDamage(amount: number): number;
  /** Detach + dispose meshes / materials. */
  dispose(): void;
}

interface AttachOpts {
  scene: THREE.Scene;
}

/**
 * How much mana the ward drains per second while active. Tuned so a 30-mana pool
 * gives ~10 s of cover from a tier-1 ward — enough to wait out one wolf bite cycle
 * but not stand-still-forever invincible. Re-cast to refresh.
 */
const MANA_DRAIN_PER_SEC = 3;
/**
 * Minimum mana chunk consumed per `useMana` call. Without this, the ward would call
 * `useMana(MANA_DRAIN_PER_SEC * dtSec)` at frame rate (144/sec on high-refresh
 * monitors). Each call triggers `saveState` (localStorage write) + `emit()` (entire
 * store-subscriber storm — HUD redraw etc.). At 144 Hz that's a major perf bomb that
 * the user reported as "whole-screen stutter / freeze when ... enemies doing stuff".
 *
 * Batching to 0.25-mana chunks drops `useMana` traffic from ~144/sec to ~12/sec while
 * active (3 mana/sec ÷ 0.25 = 12 chunks/sec). The mana bar visual still updates
 * smoothly because the subscriber storm fires on every chunk.
 */
const MANA_DRAIN_CHUNK = 0.25;

/* ============================================================================
 * Implementation
 * ============================================================================ */

export function attachDefensiveWard(opts: AttachOpts): DefensiveWardHandle {
  /* Lazy-built — no allocation until first activate. */
  let group: THREE.Group | null = null;
  let sphereMat: THREE.MeshStandardMaterial | null = null;
  let sphereGeo: THREE.SphereGeometry | null = null;
  let ringInnerMat: THREE.MeshStandardMaterial | null = null;
  let ringInnerGeo: THREE.RingGeometry | null = null;
  let ringInner: THREE.Mesh | null = null;
  let ringOuterMat: THREE.MeshStandardMaterial | null = null;
  let ringOuterGeo: THREE.RingGeometry | null = null;
  let ringOuter: THREE.Mesh | null = null;
  let active = false;
  let capacityRemaining = 0;
  let clockSec = 0;
  /** Mana drain accumulator — see `MANA_DRAIN_CHUNK` for the why. */
  let manaDrainAccum = 0;

  function ensureBuilt(): void {
    if (group) return;
    group = new THREE.Group();
    group.name = 'DefensiveWard';
    group.visible = false;
    /* Translucent sphere — back-side renders so the player sees the inner curve too. */
    sphereGeo = new THREE.SphereGeometry(SPHERE_RADIUS, 32, 24);
    sphereMat = new THREE.MeshStandardMaterial({
      color: SPHERE_COLOR,
      emissive: SPHERE_COLOR,
      emissiveIntensity: 0.55,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    group.add(sphere);
    /* Equator ring — flat dashed-rune ring rotating slowly. RingGeometry built in XY,
     * rotated -90° on X to lay flat (y-up) at the player's mid-height. */
    ringInnerGeo = new THREE.RingGeometry(RING_INNER, RING_OUTER, 64);
    ringInnerGeo.rotateX(-Math.PI / 2);
    ringInnerMat = new THREE.MeshStandardMaterial({
      color: RING_COLOR,
      emissive: RING_COLOR,
      emissiveIntensity: 1.4,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    ringInner = new THREE.Mesh(ringInnerGeo, ringInnerMat);
    ringInner.position.y = 0.95;
    group.add(ringInner);
    /* Second ring — slightly above, slightly bigger, spinning the OTHER way for that
     * "two phase-shifted glyph rings counter-rotating" magical feel. */
    ringOuterGeo = new THREE.RingGeometry(RING_INNER * 1.02, RING_OUTER * 1.04, 64);
    ringOuterGeo.rotateX(-Math.PI / 2);
    ringOuterMat = new THREE.MeshStandardMaterial({
      color: RING_COLOR,
      emissive: RING_COLOR,
      emissiveIntensity: 1.0,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    ringOuter = new THREE.Mesh(ringOuterGeo, ringOuterMat);
    ringOuter.position.y = 1.4;
    group.add(ringOuter);
    opts.scene.add(group);
  }

  function setActive(on: boolean, wardCapacity?: number): void {
    if (on === active) {
      /* Re-cast: refresh capacity if a new value is provided. */
      if (on && typeof wardCapacity === 'number' && wardCapacity > capacityRemaining) {
        capacityRemaining = wardCapacity;
      }
      return;
    }
    if (on) {
      ensureBuilt();
      capacityRemaining = wardCapacity ?? capacityRemaining;
      if (capacityRemaining <= 0) return; /* nothing to absorb — refuse to engage */
      active = true;
      manaDrainAccum = 0; /* fresh accumulator on engage */
      if (group) group.visible = true;
    } else {
      active = false;
      manaDrainAccum = 0;
      if (group) group.visible = false;
    }
  }

  function update(
    dtSec: number,
    playerPos: { x: number; y: number; z: number },
    useMana: (amt: number) => boolean,
  ): void {
    if (!active || !group) return;
    /* Drain mana — BATCHED in 0.25-mana chunks instead of frame-rate calls. The store's
     * `useMana` returns false on insufficient, which we read as "mana ran out, drop the
     * ward". See `MANA_DRAIN_CHUNK` comment for the perf-bomb context. We accumulate
     * fractional drain and only call `useMana` when the accumulator reaches a chunk —
     * cuts store traffic by ~12× during active wards. */
    manaDrainAccum += MANA_DRAIN_PER_SEC * dtSec;
    if (manaDrainAccum >= MANA_DRAIN_CHUNK) {
      const chunk = manaDrainAccum;
      manaDrainAccum = 0;
      if (!useMana(chunk)) {
        setActive(false);
        return;
      }
    }
    /* Follow player; lift the group center to roughly chest height so the sphere
     * encloses head + torso (and grazes the ground at the player's feet). */
    group.position.set(playerPos.x, playerPos.y + 0.95, playerPos.z);
    /* Animate ring spin — opposing directions read as "stable interlocking glyphs". */
    clockSec += dtSec;
    if (ringInner) ringInner.rotation.y += RING_SPIN_INNER * dtSec;
    if (ringOuter) ringOuter.rotation.y += RING_SPIN_OUTER * dtSec;
    /* Subtle emissive pulse on the sphere — gives the surface a "breathing" feel
     * instead of pasted-on. Pulse range chosen so the dome stays visible at trough. */
    if (sphereMat) {
      sphereMat.emissiveIntensity = 0.45 + 0.18 * (0.5 + 0.5 * Math.sin(clockSec * 1.6));
    }
  }

  function absorbDamage(amount: number): number {
    if (!active || amount <= 0) return amount;
    if (capacityRemaining >= amount) {
      capacityRemaining -= amount;
      if (capacityRemaining <= 0) setActive(false);
      return 0; /* fully absorbed */
    }
    /* Partial absorb — ward eats what it can, falls, the remainder bleeds through. */
    const passed = amount - capacityRemaining;
    capacityRemaining = 0;
    setActive(false);
    return passed;
  }

  function dispose(): void {
    if (group && group.parent) group.parent.remove(group);
    sphereGeo?.dispose();
    sphereMat?.dispose();
    ringInnerGeo?.dispose();
    ringInnerMat?.dispose();
    ringOuterGeo?.dispose();
    ringOuterMat?.dispose();
    group = null;
    active = false;
  }

  return {
    isActive: () => active,
    setActive,
    update,
    absorbDamage,
    dispose,
  };
}
