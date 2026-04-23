/**
 * Procedural movement SFX — footsteps, jump, double-jump (flip), landing.
 *
 * **Why a separate module from `worldSfx.ts`:** these fire on a totally different cadence
 * (footsteps at ~2 Hz during sustained walk; jump+land in tight bursts) and have their
 * own per-call cost profile. Keeping them in their own module prevents the harvest SFX
 * file from ballooning and makes it trivial to swap to sample-based playback later
 * (just replace this file's impls; all callers go through the audio facade).
 *
 * **Performance budget (locked):**
 *   - Footstep: 3-4 audio nodes per call. At ~2 steps/sec sustained, sub-1% audio CPU.
 *   - Jump / double-jump: 4-5 nodes per call, fires once per Space press.
 *   - Landing: 5-6 nodes per call, fires once per touchdown.
 *
 * **Design rationale per sound:**
 *   - **Footstep:** alternates slight pitch L/R so the cadence reads as two-legged
 *     locomotion (not a single repeating thump). Low body thud + brief grit noise.
 *   - **Jump (first):** light upward whoof — filtered noise sweep low → mid + a tiny
 *     push-off click. Conveys effort without being heavy.
 *   - **Double jump (flip):** brighter, more energetic — wider sweep + a sine-bell
 *     shimmer that says "magic / acrobatic". Distinct from the first jump so the player
 *     can hear the flip happened.
 *   - **Landing:** heavy body thud + grit burst. Scales with `intensity` (0..1) so a
 *     long-fall lands harder than a hop.
 *
 * **Asset weight:** zero — fully procedural. No `.wav` / `.ogg` files. A future swap to
 * sampled audio is one-function-replace per kind, no caller refactor.
 */

let noiseBuf: AudioBuffer | null = null;

function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  const len = Math.floor(ctx.sampleRate * 0.6);
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

/** ±frac amplitude/pitch jitter; deterministic-feeling but Math.random keeps it cheap. */
function jitter(frac: number): number {
  return 1 + (Math.random() * 2 - 1) * frac;
}

/* ============================================================================
 * Footstep
 * ============================================================================ */

/**
 * One footstep — a soft heel thud + dirt scuff, with subtle L/R alternation so the
 * cadence reads as two-legged walking. Cost: 4 audio nodes per call (one envelope, one
 * sine, one noise source, one filter). Safe to fire 3+ times per second.
 *
 * Tuned RESTRAINED: footsteps fire ~2 Hz during sustained walk, so they need to feel
 * present without dominating sparse SFX (harvest hits, ambient world). The per-category
 * "Footsteps" slider in the audio panel multiplies on top of these peaks (defaults to
 * 60%) — so a player who wants louder/quieter footsteps can dial it without affecting
 * harvest or jump audio.
 *
 * @param foot 'L' = slightly lower pitch (heavier); 'R' = slightly higher.
 */
export function playFootstepWorldSfx(ctx: AudioContext, bus: GainNode, foot: 'L' | 'R'): void {
  if (ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.78;
  master.connect(bus);

  const j = jitter(0.06);
  /* Per-foot pitch bias: left foot ~6% lower, right foot ~3% higher. Subtle but reads
   * as alternation rather than a single repeating thump. */
  const footMult = foot === 'L' ? 0.94 : 1.03;
  const baseFreq = 165 * j * footMult; /* lower = more grounded "thud" feel */

  /* Heel thud — low body thump with a quick downward pitch bend. Slightly slower attack
   * (0.005s vs 0.003s) so it reads as "soft soil compression" not "click". */
  const thud = ctx.createOscillator();
  thud.type = 'sine';
  thud.frequency.setValueAtTime(baseFreq, t0);
  thud.frequency.exponentialRampToValueAtTime(baseFreq * 0.5, t0 + 0.06);
  const gth = ctx.createGain();
  gth.gain.setValueAtTime(0.0001, t0);
  gth.gain.exponentialRampToValueAtTime(0.06, t0 + 0.005);
  gth.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.085);
  thud.connect(gth);
  gth.connect(master);
  thud.start(t0);
  thud.stop(t0 + 0.1);

  /* Scuff — bandpass-filtered noise burst at ~600-700Hz for the dirt/grass texture.
   * Lower center freq + softer peak than before so it reads as fabric/leaf rustle
   * rather than a sharp click. Slight start delay (0.004s) creates a tiny "step lands
   * then slides" articulation that makes each footstep feel like contact, not a tap. */
  noiseBurst(ctx, master, t0 + 0.004, 0.07, 0.038, 650 * j * footMult, 1.2);
}

/* ============================================================================
 * Jump / double jump / landing
 * ============================================================================ */

/**
 * First jump (no flip). Light upward "whoof" + tiny push-off click.
 */
export function playJumpWorldSfx(ctx: AudioContext, bus: GainNode): void {
  if (ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.95;
  master.connect(bus);

  /* Push-off click — a tiny shoe-leaving-ground transient. */
  const click = ctx.createOscillator();
  click.type = 'triangle';
  click.frequency.setValueAtTime(280, t0);
  click.frequency.exponentialRampToValueAtTime(180, t0 + 0.025);
  const gc = ctx.createGain();
  gc.gain.setValueAtTime(0.0001, t0);
  gc.gain.exponentialRampToValueAtTime(0.06, t0 + 0.002);
  gc.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.04);
  click.connect(gc);
  gc.connect(master);
  click.start(t0);
  click.stop(t0 + 0.06);

  /* Whoof — noise sweep low → mid, the upward exertion. */
  noiseSweep(ctx, master, t0 + 0.005, 0.18, 0.08, 320, 720, 1.4);
}

/**
 * Double jump (front flip). Brighter, more energetic — wider sweep + sine bell shimmer
 * so the player can audibly distinguish the flip from a regular jump.
 */
export function playDoubleJumpWorldSfx(ctx: AudioContext, bus: GainNode): void {
  if (ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 1.0;
  master.connect(bus);

  /* Brighter push — square click with higher freq. */
  const click = ctx.createOscillator();
  click.type = 'square';
  click.frequency.setValueAtTime(420, t0);
  click.frequency.exponentialRampToValueAtTime(220, t0 + 0.03);
  const gc = ctx.createGain();
  gc.gain.setValueAtTime(0.0001, t0);
  gc.gain.exponentialRampToValueAtTime(0.07, t0 + 0.002);
  gc.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
  click.connect(gc);
  gc.connect(master);
  click.start(t0);
  click.stop(t0 + 0.07);

  /* Whoosh — wider sweep than a regular jump (more air movement). */
  noiseSweep(ctx, master, t0 + 0.005, 0.28, 0.1, 480, 1400, 1.8);

  /* Shimmer — rising sine that says "acrobatic / magical". */
  const sh = ctx.createOscillator();
  sh.type = 'sine';
  sh.frequency.setValueAtTime(880, t0 + 0.02);
  sh.frequency.exponentialRampToValueAtTime(1480, t0 + 0.18);
  const gsh = ctx.createGain();
  gsh.gain.setValueAtTime(0.0001, t0 + 0.02);
  gsh.gain.exponentialRampToValueAtTime(0.045, t0 + 0.04);
  gsh.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
  sh.connect(gsh);
  gsh.connect(master);
  sh.start(t0 + 0.02);
  sh.stop(t0 + 0.24);
}

/**
 * Landing on the ground after a jump. Heavier than a footstep — a full body thud + grit
 * burst + a low rumble underneath.
 *
 * @param intensity 0..1 — scales the thud peak and adds settling clicks for hard
 *                  landings. 0.4 = light hop landing, 1.0 = high-fall landing.
 */
export function playLandWorldSfx(ctx: AudioContext, bus: GainNode, intensity = 0.7): void {
  if (ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.95;
  master.connect(bus);

  const k = Math.max(0.3, Math.min(1.0, intensity));

  /* Heavy heel thud — bigger than a footstep. */
  const thud = ctx.createOscillator();
  thud.type = 'sine';
  thud.frequency.setValueAtTime(140, t0);
  thud.frequency.exponentialRampToValueAtTime(60, t0 + 0.1);
  const gth = ctx.createGain();
  gth.gain.setValueAtTime(0.0001, t0);
  gth.gain.exponentialRampToValueAtTime(0.18 * k, t0 + 0.005);
  gth.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
  thud.connect(gth);
  gth.connect(master);
  thud.start(t0);
  thud.stop(t0 + 0.2);

  /* Grit burst — wider band than a footstep so it reads as "impact" not "step". */
  noiseBurst(ctx, master, t0, 0.12 * k, 0.12 * k, 480, 1.0);
  noiseBurst(ctx, master, t0, 0.06, 0.07 * k, 1800, 1.4);

  /* Hard-landing settling clicks — only when intensity > 0.6 (proper jumps, not light hops). */
  if (intensity > 0.6) {
    const settle = ctx.createOscillator();
    settle.type = 'triangle';
    settle.frequency.setValueAtTime(220, t0 + 0.05);
    settle.frequency.exponentialRampToValueAtTime(140, t0 + 0.12);
    const gs = ctx.createGain();
    gs.gain.setValueAtTime(0.0001, t0 + 0.05);
    gs.gain.exponentialRampToValueAtTime(0.04 * k, t0 + 0.06);
    gs.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
    settle.connect(gs);
    gs.connect(master);
    settle.start(t0 + 0.05);
    settle.stop(t0 + 0.18);
  }
}

/**
 * Bouncy-mushroom trampoline boing (Phase 8l). Two-stage: a fast triangle-wave
 * pitch sweep (220 → 660 Hz over 80 ms then back to 420 Hz) reads as the cap
 * compressing then springing back; a low-pass-swept noise burst layered
 * underneath gives the squish / wet-rubber texture so it doesn't sound like a
 * clean musical note. A sub-bass thump kicks in only on heavy bounces (chest
 * resonance feel) so light hops stay subtle.
 *
 * `intensity` 0..1.5 scales gain — heavy drops sound heavier than a light
 * brush. Total audio cost: 5-7 nodes per call, < 0.4 s decay. Cheap enough at
 * chain-bounce rate (~3 Hz).
 *
 * Routed through the same `jumpLandSfxGain` bus as jump + land + double-jump
 * so the existing "Jump / land sounds" volume slider controls it.
 */
export function playMushroomBounceWorldSfx(
  ctx: AudioContext,
  bus: GainNode,
  intensity = 0.8,
): void {
  if (ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  const k = Math.max(0.3, Math.min(1.5, intensity));
  const master = ctx.createGain();
  master.gain.value = 0.95 * k;
  master.connect(bus);

  /* Boing — triangle pitch sweep up + brief settle-back so the sweep feels
   * like a real spring overshoot, not a one-way slide. */
  const boing = ctx.createOscillator();
  boing.type = 'triangle';
  boing.frequency.setValueAtTime(220, t0);
  boing.frequency.exponentialRampToValueAtTime(660, t0 + 0.08);
  boing.frequency.exponentialRampToValueAtTime(420, t0 + 0.18);
  const gb = ctx.createGain();
  gb.gain.setValueAtTime(0.0001, t0);
  gb.gain.exponentialRampToValueAtTime(0.18, t0 + 0.01);
  gb.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
  boing.connect(gb);
  gb.connect(master);
  boing.start(t0);
  boing.stop(t0 + 0.34);

  /* Squish — low-pass-swept noise burst layered under the boing. */
  const squishSrc = ctx.createBufferSource();
  squishSrc.buffer = getNoiseBuffer(ctx);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.85;
  lp.frequency.setValueAtTime(900, t0);
  lp.frequency.exponentialRampToValueAtTime(2400, t0 + 0.07);
  const gs = ctx.createGain();
  gs.gain.setValueAtTime(0.0001, t0);
  gs.gain.exponentialRampToValueAtTime(0.10, t0 + 0.008);
  gs.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
  squishSrc.connect(lp);
  lp.connect(gs);
  gs.connect(master);
  squishSrc.start(t0);
  squishSrc.stop(t0 + 0.2);

  /* Sub-thump — low sine for chest-resonance feel on heavy bounces only. */
  if (intensity > 0.7) {
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(95, t0);
    sub.frequency.exponentialRampToValueAtTime(60, t0 + 0.12);
    const gsub = ctx.createGain();
    gsub.gain.setValueAtTime(0.0001, t0);
    gsub.gain.exponentialRampToValueAtTime(0.12 * k, t0 + 0.005);
    gsub.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
    sub.connect(gsub);
    gsub.connect(master);
    sub.start(t0);
    sub.stop(t0 + 0.18);
  }
}
