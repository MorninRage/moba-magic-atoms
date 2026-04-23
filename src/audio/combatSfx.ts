/**
 * Awakened-mode combat SFX (Phase 1.5 — see
 * `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` §13.5).
 *
 * Procedural per-mob hit + death sounds + player swing/cast SFX. Same procedural style
 * as the rest of `worldSfx.ts` / `movementSfx.ts` — zero binary asset weight, sub-1ms
 * cost per call.
 *
 * **Per-mob audio identity:**
 *   - **Rat** — high-pitched squeak on hit; sharp crunch on death. Small, frantic.
 *   - **Wolf** — low snarl + wet bite-yelp on hit; long whimper-thud on death.
 *   - **Wanderer** — human grunt on hit; low groan + body-thud on death. Heavier weight.
 *
 * **Player swing:**
 *   - **Magic cast** — cyan whoosh + airy harmonic (matches the staff's mana resonance).
 *   - **Melee swing** — wood-shaft swing (whoosh) + soft impact thud at the end if it
 *     was a connecting hit. The mob hit SFX layers ON TOP of this when it lands.
 *
 * **Mid-air audio:** all of the above use 2D positional audio (no panning) — the player
 * is always the listener; mobs at any range report with the same loudness. Phase 4
 * polish may add 3D positional via `THREE.PositionalAudio` once we have proper world
 * audio anchors.
 */

let noiseBuf: AudioBuffer | null = null;

function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  const len = Math.floor(ctx.sampleRate * 0.8);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  noiseBuf = buf;
  return buf;
}

function noiseBurst(
  ctx: AudioContext,
  out: AudioNode,
  t0: number,
  dur: number,
  peak: number,
  filterFreq: number,
  q = 0.85,
): void {
  const src = ctx.createBufferSource();
  src.buffer = getNoiseBuffer(ctx);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = filterFreq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f);
  f.connect(g);
  g.connect(out);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

function noiseSweep(
  ctx: AudioContext,
  out: AudioNode,
  t0: number,
  dur: number,
  peak: number,
  f0: number,
  f1: number,
  q = 1.5,
): void {
  const src = ctx.createBufferSource();
  src.buffer = getNoiseBuffer(ctx);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.setValueAtTime(f0, t0);
  f.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t0 + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.025);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f);
  f.connect(g);
  g.connect(out);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

/** Tonal voice — for grunts, yelps, whimpers. Sine + filter. */
function voicePulse(
  ctx: AudioContext,
  out: AudioNode,
  t0: number,
  freqStart: number,
  freqEnd: number,
  dur: number,
  peak: number,
  type: OscillatorType = 'triangle',
): void {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freqStart, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g);
  g.connect(out);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

/** ±frac pitch jitter (per-call variation so hits don't sound mechanical). */
function jitter(frac: number): number {
  return 1 + (Math.random() * 2 - 1) * frac;
}

/* ============================================================================
 * Mob hit SFX (per-kind)
 * ============================================================================ */

export type CombatMobKind = 'rat' | 'wolf' | 'wanderer';

export function playMobHitWorldSfx(
  ctx: AudioContext,
  bus: GainNode,
  kind: CombatMobKind,
  volumeScale = 1.0,
): void {
  if (ctx.state !== 'running') return;
  if (volumeScale <= 0) return;
  const t0 = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.92 * volumeScale;
  master.connect(bus);
  const j = jitter(0.08);

  switch (kind) {
    case 'rat': {
      /* High-pitched squeak — sine partial that shoots up then collapses. Plus a tiny
       * impact transient (thin noise burst @ 1.5 kHz). */
      voicePulse(ctx, master, t0, 1450 * j, 1900 * j, 0.06, 0.13, 'triangle');
      voicePulse(ctx, master, t0 + 0.05, 1700 * j, 800 * j, 0.09, 0.07, 'sine');
      noiseBurst(ctx, master, t0, 0.04, 0.06, 1500, 1.4);
      break;
    }
    case 'wolf': {
      /* Snarl + wet bite-yelp — low growl partial + sharp transient. */
      voicePulse(ctx, master, t0, 280 * j, 220 * j, 0.12, 0.13, 'sawtooth');
      voicePulse(ctx, master, t0 + 0.03, 520 * j, 360 * j, 0.1, 0.1, 'triangle');
      noiseBurst(ctx, master, t0, 0.08, 0.09, 800, 1.6);
      break;
    }
    case 'wanderer': {
      /* Human grunt — low triangle wave + filtered noise body for the breath. */
      voicePulse(ctx, master, t0, 220 * j, 160 * j, 0.16, 0.14, 'triangle');
      noiseBurst(ctx, master, t0 + 0.02, 0.1, 0.06, 600, 1.2);
      /* Tiny tonal vowel for the "uhh" character. */
      voicePulse(ctx, master, t0 + 0.04, 320 * j, 240 * j, 0.1, 0.06, 'sine');
      break;
    }
  }
}

/* ============================================================================
 * Mob death SFX (per-kind)
 * ============================================================================ */

export function playMobDeathWorldSfx(
  ctx: AudioContext,
  bus: GainNode,
  kind: CombatMobKind,
  volumeScale = 1.0,
): void {
  if (ctx.state !== 'running') return;
  if (volumeScale <= 0) return;
  const t0 = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 1.0 * volumeScale;
  master.connect(bus);
  const j = jitter(0.06);

  switch (kind) {
    case 'rat': {
      /* Sharp final squeak then a tiny crunch as the body falls. */
      voicePulse(ctx, master, t0, 1700 * j, 700 * j, 0.18, 0.16, 'triangle');
      noiseBurst(ctx, master, t0 + 0.16, 0.1, 0.08, 380, 1.0);
      noiseBurst(ctx, master, t0 + 0.18, 0.06, 0.05, 1200, 1.6);
      break;
    }
    case 'wolf': {
      /* Death HOWL — iconic mournful "ahhhwooooo" arc that resolves into the
       * body thud. Three layered partials build the texture:
       *   1. Carrier: rises from ~280 Hz → peaks ~540 Hz at ~0.25 s → descends
       *      to ~140 Hz by 0.85 s. Sawtooth gives the throaty edge.
       *   2. Sub: low triangle following the same arc one octave down — adds
       *      chest resonance so the howl reads as "big animal" not "yelp."
       *   3. Air: tight band-passed noise riding the carrier for the breath
       *      texture. Without this the howl sounds like a synth pad.
       * Then a body thud at 0.95 s when the fall-over animation lands. */
      const howl = ctx.createOscillator();
      howl.type = 'sawtooth';
      howl.frequency.setValueAtTime(280 * j, t0);
      howl.frequency.exponentialRampToValueAtTime(540 * j, t0 + 0.25);
      howl.frequency.exponentialRampToValueAtTime(180 * j, t0 + 0.65);
      howl.frequency.exponentialRampToValueAtTime(140 * j, t0 + 0.85);
      const ghowl = ctx.createGain();
      ghowl.gain.setValueAtTime(0.0001, t0);
      ghowl.gain.exponentialRampToValueAtTime(0.22, t0 + 0.06);
      ghowl.gain.linearRampToValueAtTime(0.18, t0 + 0.55);
      ghowl.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9);
      howl.connect(ghowl);
      ghowl.connect(master);
      howl.start(t0);
      howl.stop(t0 + 0.92);

      const sub = ctx.createOscillator();
      sub.type = 'triangle';
      sub.frequency.setValueAtTime(140 * j, t0);
      sub.frequency.exponentialRampToValueAtTime(270 * j, t0 + 0.25);
      sub.frequency.exponentialRampToValueAtTime(90 * j, t0 + 0.65);
      sub.frequency.exponentialRampToValueAtTime(72 * j, t0 + 0.85);
      const gsub = ctx.createGain();
      gsub.gain.setValueAtTime(0.0001, t0);
      gsub.gain.exponentialRampToValueAtTime(0.14, t0 + 0.08);
      gsub.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9);
      sub.connect(gsub);
      gsub.connect(master);
      sub.start(t0);
      sub.stop(t0 + 0.92);

      /* Breath texture — band-passed noise, low gain, riding the howl. */
      noiseBurst(ctx, master, t0, 0.85, 0.05, 600, 1.4);

      /* Body thud at 0.95 s — wolf hits the ground after the howl trails off. */
      const thud = ctx.createOscillator();
      thud.type = 'sine';
      thud.frequency.setValueAtTime(95, t0 + 0.95);
      thud.frequency.exponentialRampToValueAtTime(48, t0 + 1.10);
      const gth = ctx.createGain();
      gth.gain.setValueAtTime(0.0001, t0 + 0.95);
      gth.gain.exponentialRampToValueAtTime(0.20, t0 + 0.955);
      gth.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.15);
      thud.connect(gth);
      gth.connect(master);
      thud.start(t0 + 0.95);
      thud.stop(t0 + 1.18);
      noiseBurst(ctx, master, t0 + 0.95, 0.12, 0.1, 250, 1.2);
      break;
    }
    case 'wanderer': {
      /* Long human groan + heavy body thud. */
      voicePulse(ctx, master, t0, 220 * j, 110 * j, 0.45, 0.18, 'triangle');
      voicePulse(ctx, master, t0 + 0.1, 180 * j, 80 * j, 0.5, 0.1, 'sine');
      /* Body thud at 0.5 s — heavier than wolf because human-mass. */
      const thud = ctx.createOscillator();
      thud.type = 'sine';
      thud.frequency.setValueAtTime(75, t0 + 0.5);
      thud.frequency.exponentialRampToValueAtTime(40, t0 + 0.7);
      const gth = ctx.createGain();
      gth.gain.setValueAtTime(0.0001, t0 + 0.5);
      gth.gain.exponentialRampToValueAtTime(0.26, t0 + 0.508);
      gth.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.78);
      thud.connect(gth);
      gth.connect(master);
      thud.start(t0 + 0.5);
      thud.stop(t0 + 0.8);
      noiseBurst(ctx, master, t0 + 0.5, 0.18, 0.13, 180, 1.0);
      break;
    }
  }
}

/* ============================================================================
 * Player swing / cast SFX
 * ============================================================================ */

export function playPlayerSwingWorldSfx(ctx: AudioContext, bus: GainNode): void {
  if (ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.85;
  master.connect(bus);
  /* Wood-shaft / blade swing — quick filtered-noise sweep low → high → low (the arc). */
  noiseSweep(ctx, master, t0, 0.18, 0.09, 380, 1100, 1.4);
  noiseSweep(ctx, master, t0 + 0.05, 0.12, 0.06, 1200, 600, 1.6);
}

export function playPlayerMagicCastWorldSfx(ctx: AudioContext, bus: GainNode): void {
  if (ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.95;
  master.connect(bus);
  /* Cyan whoosh — sine sweep up + filtered noise body + harmonic chime. */
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(440, t0);
  o.frequency.exponentialRampToValueAtTime(880, t0 + 0.15);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
  o.connect(g);
  g.connect(master);
  o.start(t0);
  o.stop(t0 + 0.25);
  /* Airy noise body — gives the cast a "magic vapor" texture. */
  noiseSweep(ctx, master, t0, 0.22, 0.08, 1600, 4400, 2.0);
  /* Harmonic chime — high partial that says "spell". */
  const ch = ctx.createOscillator();
  ch.type = 'sine';
  ch.frequency.setValueAtTime(1760, t0 + 0.04);
  const gch = ctx.createGain();
  gch.gain.setValueAtTime(0.0001, t0 + 0.04);
  gch.gain.exponentialRampToValueAtTime(0.05, t0 + 0.06);
  gch.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
  ch.connect(gch);
  gch.connect(master);
  ch.start(t0 + 0.04);
  ch.stop(t0 + 0.22);
}

/* ============================================================================
 * Impact SFX (weapon-on-target THUD — separate from the mob's voice reaction)
 *
 * The split: every melee or magic hit fires TWO sounds at the same time:
 *   1. The IMPACT (this section) — the weapon-side thunk: a wood-shaft hit, a metal
 *      blade chop, a cyan-orb crackle. Same regardless of which mob got hit.
 *   2. The MOB VOICE (`playMobHitWorldSfx`) — the target's pain reaction (squeak / yelp
 *      / grunt). Different per mob kind.
 * Layered together they read as "weapon-hits-flesh + mob-cries-out" the way ARPG combat
 * audio normally does. Either alone feels thin.
 * ============================================================================ */

/** Melee impact — wood-shaft / blade THUNK. Fires when a swing's raycast lands on a mob. */
export function playMeleeImpactWorldSfx(ctx: AudioContext, bus: GainNode, volumeScale = 1.0): void {
  if (ctx.state !== 'running') return;
  if (volumeScale <= 0) return;
  const t0 = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.95 * volumeScale;
  master.connect(bus);
  /* Low body thud — the meaty contact. */
  const thud = ctx.createOscillator();
  thud.type = 'sine';
  thud.frequency.setValueAtTime(180, t0);
  thud.frequency.exponentialRampToValueAtTime(85, t0 + 0.07);
  const gth = ctx.createGain();
  gth.gain.setValueAtTime(0.0001, t0);
  gth.gain.exponentialRampToValueAtTime(0.16, t0 + 0.005);
  gth.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
  thud.connect(gth);
  gth.connect(master);
  thud.start(t0);
  thud.stop(t0 + 0.12);
  /* Sharp transient — "crack" of weapon-on-impact. */
  const crack = ctx.createOscillator();
  crack.type = 'triangle';
  crack.frequency.setValueAtTime(620, t0);
  crack.frequency.exponentialRampToValueAtTime(280, t0 + 0.025);
  const gcr = ctx.createGain();
  gcr.gain.setValueAtTime(0.0001, t0);
  gcr.gain.exponentialRampToValueAtTime(0.085, t0 + 0.003);
  gcr.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.04);
  crack.connect(gcr);
  gcr.connect(master);
  crack.start(t0);
  crack.stop(t0 + 0.05);
  /* Mid noise body for the "soft tissue" feel. */
  noiseBurst(ctx, master, t0, 0.06, 0.07, 700, 1.4);
}

/** Magic projectile impact — cyan crackle / shimmer when the orb lands on a mob. */
export function playMagicImpactWorldSfx(ctx: AudioContext, bus: GainNode, volumeScale = 1.0): void {
  if (ctx.state !== 'running') return;
  if (volumeScale <= 0) return;
  const t0 = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 1.0 * volumeScale;
  master.connect(bus);
  /* Bright crackle — multiple high partials plus a mid bell. Reads as "magic
   * splashes against the target". */
  const partials = [880, 1320, 1760, 2640];
  partials.forEach((fq, i) => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(fq, t0 + i * 0.012);
    o.frequency.exponentialRampToValueAtTime(fq * 0.6, t0 + 0.18 + i * 0.012);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0 + i * 0.012);
    g.gain.exponentialRampToValueAtTime(0.06 - i * 0.012, t0 + 0.02 + i * 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22 + i * 0.012);
    o.connect(g);
    g.connect(master);
    o.start(t0 + i * 0.012);
    o.stop(t0 + 0.26 + i * 0.012);
  });
  /* Bright noise dust for the splash. */
  noiseBurst(ctx, master, t0, 0.06, 0.08, 4200, 2.2);
  /* Low rumble underneath — gives the impact mass. */
  const rum = ctx.createOscillator();
  rum.type = 'triangle';
  rum.frequency.setValueAtTime(140, t0);
  rum.frequency.exponentialRampToValueAtTime(60, t0 + 0.18);
  const gr = ctx.createGain();
  gr.gain.setValueAtTime(0.0001, t0);
  gr.gain.exponentialRampToValueAtTime(0.07, t0 + 0.008);
  gr.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
  rum.connect(gr);
  gr.connect(master);
  rum.start(t0);
  rum.stop(t0 + 0.24);
}

/* ============================================================================
 * Mob footstep SFX (per-kind audible movement)
 *
 * Different from the player's footsteps in `movementSfx.ts` — these are quieter, more
 * "creature-y", and meant to layer against ambient + combat audio without dominating.
 * Player-perception goal: hear a wolf/wanderer approaching from offscreen so the
 * encounter has the same audible-tension as battle mode.
 *
 * Cadence is driven by `awakenedMobs.ts` AI tick — fires once per simulated step
 * contact (every ~0.3 s for rat, ~0.5 s for wolf, ~0.6 s for wanderer at chase speed).
 * ============================================================================ */

export function playMobFootstepWorldSfx(
  ctx: AudioContext,
  bus: GainNode,
  kind: CombatMobKind,
  volumeScale = 1.0,
): void {
  if (ctx.state !== 'running') return;
  if (volumeScale <= 0) return;
  const t0 = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.65 * volumeScale; /* quieter than player footsteps — these layer in */
  master.connect(bus);
  const j = jitter(0.08);

  switch (kind) {
    case 'rat': {
      /* Skitter — high-pitched click + tiny grit dust. Quick. */
      const click = ctx.createOscillator();
      click.type = 'triangle';
      click.frequency.setValueAtTime(1200 * j, t0);
      const gc = ctx.createGain();
      gc.gain.setValueAtTime(0.0001, t0);
      gc.gain.exponentialRampToValueAtTime(0.04, t0 + 0.002);
      gc.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.025);
      click.connect(gc);
      gc.connect(master);
      click.start(t0);
      click.stop(t0 + 0.04);
      noiseBurst(ctx, master, t0, 0.025, 0.025, 1800 * j, 2.0);
      break;
    }
    case 'wolf': {
      /* Padded paw — soft thump + light claw click. Heavier than rat, lighter than
       * human boot. */
      const thud = ctx.createOscillator();
      thud.type = 'sine';
      thud.frequency.setValueAtTime(135 * j, t0);
      thud.frequency.exponentialRampToValueAtTime(75 * j, t0 + 0.05);
      const gth = ctx.createGain();
      gth.gain.setValueAtTime(0.0001, t0);
      gth.gain.exponentialRampToValueAtTime(0.05, t0 + 0.005);
      gth.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
      thud.connect(gth);
      gth.connect(master);
      thud.start(t0);
      thud.stop(t0 + 0.08);
      /* Claw click — very brief high transient. */
      noiseBurst(ctx, master, t0, 0.02, 0.025, 2200 * j, 2.4);
      /* Soft fur-on-grass body. */
      noiseBurst(ctx, master, t0, 0.06, 0.022, 600 * j, 1.4);
      break;
    }
    case 'wanderer': {
      /* Human boot on dirt — heavy heel thud + grit scrape. Slowest cadence. */
      const thud = ctx.createOscillator();
      thud.type = 'sine';
      thud.frequency.setValueAtTime(160 * j, t0);
      thud.frequency.exponentialRampToValueAtTime(60 * j, t0 + 0.08);
      const gth = ctx.createGain();
      gth.gain.setValueAtTime(0.0001, t0);
      gth.gain.exponentialRampToValueAtTime(0.075, t0 + 0.006);
      gth.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
      thud.connect(gth);
      gth.connect(master);
      thud.start(t0);
      thud.stop(t0 + 0.12);
      noiseBurst(ctx, master, t0 + 0.005, 0.075, 0.05, 580 * j, 1.2);
      break;
    }
  }
}
