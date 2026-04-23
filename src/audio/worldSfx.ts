/**
 * Short procedural "world" SFX — distinct profiles per gather / consume action.
 *
 * **Two-phase harvest (locked design — `docs/AWAKENING_AND_FREE_ROAM_PLAN.md` §8 supersession):**
 *   - Per-hit "progress" SFX fires every chop / pick / pluck during the multi-hit
 *     awakened-mode harvest loop. Tuned cheap (~80–150 ms, single-digit oscillator/noise
 *     nodes per call) and pitch-jittered ±8% so a sequence of 5–10 hits doesn't sound
 *     like a machine gun.
 *   - "Break" SFX fires on the FINAL hit when the node fully despawns. Heavier, longer,
 *     layered — the iconic tree-fall crash, boulder crumble, ore-shatter clang, crystal
 *     bell sweep. ~0.6–1.4 s. The dramatic punctuation that says "you destroyed it."
 *
 * **Performance budget:** each call allocates 3–8 Web Audio nodes that auto-disconnect
 * after their `stop()` time (Web Audio GC reclaims). Per-hit cost is sub-millisecond on
 * the audio thread; main-thread JS cost is the node creation only (~0.05 ms). Even a
 * 5-hit-per-second spam stays under 0.5% CPU on a low-end laptop.
 *
 * **Asset weight:** zero — fully procedural. Replace with sampled WAV/OGG later by
 * swapping `playGatherProgressSfx` / `playGatherBreakSfx` impls; call sites and exports
 * stay identical.
 */

export type GatherSfxId =
  | 'wood'
  | 'stone'
  | 'fiber'
  | 'berries'
  | 'water'
  | 'hunt'
  | 'tend_garden'
  | 'mine'
  | 'ley_residue';

/**
 * Free-roam-only material categories. These extend the gather-action universe with
 * per-ore-tier acoustic colors (lighter base metals → brighter precious metals) and the
 * crystal harvest. Mapped from a `FreeRoamHarvestKind` via `harvestKindToMaterialId`.
 */
export type HarvestMaterialId =
  | 'wood'
  | 'stone'
  | 'fiber'
  | 'berries'
  | 'metal_base'   /* iron / coal — dull low clang */
  | 'metal_alloy'  /* copper / tin / zinc — brighter mid clang */
  | 'metal_precious' /* silver / gold / platinum — bell-like high ring */
  | 'crystal';     /* magic crystal — multi-partial chime */

export type ConsumeSfxId = 'eat_meat' | 'eat_berries' | 'drink_water';

let noiseBuf: AudioBuffer | null = null;

function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  const len = Math.floor(ctx.sampleRate * 1.6); /* 1.6s — long enough for tree-fall crash tail */
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  noiseBuf = buf;
  return buf;
}

function envGain(
  ctx: AudioContext,
  out: AudioNode,
  peak: number,
  attack: number,
  sustain: number,
  release: number,
  t0: number,
): GainNode {
  const g = ctx.createGain();
  g.connect(out);
  const eps = 0.0001;
  g.gain.setValueAtTime(eps, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, eps), t0 + attack);
  g.gain.exponentialRampToValueAtTime(Math.max(peak * 0.7, eps), t0 + attack + sustain);
  g.gain.exponentialRampToValueAtTime(eps, t0 + attack + sustain + release);
  return g;
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
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f);
  f.connect(g);
  g.connect(out);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

/**
 * Filtered-noise sweep — for tree-fall whoosh, boulder-crumble wash. The filter slides
 * from `f0` to `f1` over the duration so we hear the "rush down" tonal motion without
 * needing dozens of stacked oscillators.
 */
function noiseSweep(
  ctx: AudioContext,
  out: AudioNode,
  t0: number,
  dur: number,
  peak: number,
  f0: number,
  f1: number,
  q = 1.6,
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
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.04);
  g.gain.exponentialRampToValueAtTime(Math.max(peak * 0.5, 0.0001), t0 + dur * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f);
  f.connect(g);
  g.connect(out);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

/** Sine partial helper — for bell / chime / metal-ring stacks. */
function sinePartial(
  ctx: AudioContext,
  out: AudioNode,
  t0: number,
  freq: number,
  peak: number,
  decay: number,
  type: OscillatorType = 'sine',
): void {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
  o.connect(g);
  g.connect(out);
  o.start(t0);
  o.stop(t0 + decay + 0.02);
}

/**
 * Wood-snap click — short transient at `freq` with very fast attack/decay. Stacked 2–4×
 * with offset times to make the "branch breaks" pre-roll on the tree-fall crash.
 */
function woodSnap(ctx: AudioContext, out: AudioNode, t0: number, freq: number, peak: number): void {
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(freq * 1.6, t0);
  o.frequency.exponentialRampToValueAtTime(freq, t0 + 0.012);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.045);
  o.connect(g);
  g.connect(out);
  o.start(t0);
  o.stop(t0 + 0.06);
  /* tiny noise blip co-located so it reads as "snap" not "ping" */
  noiseBurst(ctx, out, t0, 0.04, peak * 0.6, freq * 2, 1.4);
}

/** ±frac amplitude/pitch jitter; deterministic-feeling but Math.random keeps it cheap. */
function jitter(frac: number): number {
  return 1 + (Math.random() * 2 - 1) * frac;
}

/* ---------- Action → category map (legacy) ---------- */

/** Map any performGather action id to a world SFX category. */
export function gatherActionToSfxId(actionId: string): GatherSfxId | null {
  switch (actionId) {
    case 'wood':
      return 'wood';
    case 'stone':
      return 'stone';
    case 'fiber':
      return 'fiber';
    case 'berries':
      return 'berries';
    case 'water':
      return 'water';
    case 'hunt':
      return 'hunt';
    case 'tend_garden':
      return 'tend_garden';
    case 'ley_residue':
      return 'ley_residue';
    default:
      if (actionId.startsWith('mine_')) return 'mine';
      return null;
  }
}

/**
 * Map a free-roam scatter kind to a richer per-tier material id. Used for the per-hit
 * progress + final-break SFX in awakened mode where we want to acoustically distinguish
 * iron from gold (vs the legacy `mine` lump-everything category).
 */
export function harvestKindToMaterialId(kind: string): HarvestMaterialId | null {
  switch (kind) {
    case 'wood': return 'wood';
    case 'stone': return 'stone';
    case 'fiber': return 'fiber';
    case 'berries': return 'berries';
    case 'mine_iron_ore':
    case 'mine_coal':
      return 'metal_base';
    case 'mine_copper_ore':
    case 'mine_tin_ore':
    case 'mine_zinc_ore':
      return 'metal_alloy';
    case 'mine_silver_ore':
    case 'mine_gold_ore':
    case 'mine_platinum_ore':
      return 'metal_precious';
    case 'magic_crystal':
      return 'crystal';
    default:
      return null;
  }
}

/* ---------- Legacy single-shot (deck-mode performGather still calls this) ---------- */

export function playGatherWorldSfx(ctx: AudioContext, bus: GainNode, id: GatherSfxId): void {
  if (ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.92;
  master.connect(bus);

  switch (id) {
    case 'wood': {
      noiseBurst(ctx, master, t0, 0.12, 0.11, 420);
      noiseBurst(ctx, master, t0 + 0.04, 0.08, 0.06, 1800);
      const thump = ctx.createOscillator();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(95, t0);
      thump.frequency.exponentialRampToValueAtTime(55, t0 + 0.09);
      const g = envGain(ctx, master, 0.14, 0.004, 0.04, 0.1, t0);
      thump.connect(g);
      thump.start(t0);
      thump.stop(t0 + 0.2);
      break;
    }
    case 'stone': {
      const c1 = ctx.createOscillator();
      c1.type = 'triangle';
      c1.frequency.setValueAtTime(220, t0);
      c1.frequency.exponentialRampToValueAtTime(90, t0 + 0.045);
      const g1 = envGain(ctx, master, 0.11, 0.002, 0.02, 0.06, t0);
      c1.connect(g1);
      c1.start(t0);
      c1.stop(t0 + 0.12);
      const c2 = ctx.createOscillator();
      c2.type = 'square';
      c2.frequency.setValueAtTime(140, t0 + 0.028);
      c2.frequency.exponentialRampToValueAtTime(70, t0 + 0.05);
      const g2 = envGain(ctx, master, 0.045, 0.002, 0.015, 0.05, t0 + 0.028);
      c2.connect(g2);
      c2.start(t0 + 0.028);
      c2.stop(t0 + 0.11);
      noiseBurst(ctx, master, t0, 0.06, 0.05, 2400);
      break;
    }
    case 'fiber': {
      noiseBurst(ctx, master, t0, 0.14, 0.09, 2600);
      noiseBurst(ctx, master, t0 + 0.03, 0.1, 0.05, 900);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(1400, t0);
      o.frequency.exponentialRampToValueAtTime(880, t0 + 0.08);
      const g = envGain(ctx, master, 0.04, 0.01, 0.03, 0.06, t0);
      o.connect(g);
      o.start(t0);
      o.stop(t0 + 0.15);
      break;
    }
    case 'berries': {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(660, t0);
      o.frequency.exponentialRampToValueAtTime(990, t0 + 0.022);
      o.frequency.exponentialRampToValueAtTime(520, t0 + 0.055);
      const g = envGain(ctx, master, 0.09, 0.004, 0.02, 0.07, t0);
      o.connect(g);
      o.start(t0);
      o.stop(t0 + 0.14);
      const ping = ctx.createOscillator();
      ping.type = 'triangle';
      ping.frequency.setValueAtTime(2400, t0 + 0.02);
      ping.frequency.exponentialRampToValueAtTime(3200, t0 + 0.04);
      const gp = envGain(ctx, master, 0.025, 0.003, 0.015, 0.05, t0 + 0.02);
      ping.connect(gp);
      ping.start(t0 + 0.02);
      ping.stop(t0 + 0.1);
      break;
    }
    case 'water': {
      noiseBurst(ctx, master, t0, 0.18, 0.08, 700);
      const drip = ctx.createOscillator();
      drip.type = 'sine';
      drip.frequency.setValueAtTime(380, t0 + 0.05);
      drip.frequency.exponentialRampToValueAtTime(220, t0 + 0.14);
      const gd = envGain(ctx, master, 0.08, 0.02, 0.06, 0.12, t0 + 0.05);
      drip.connect(gd);
      drip.start(t0 + 0.05);
      drip.stop(t0 + 0.28);
      noiseBurst(ctx, master, t0 + 0.08, 0.12, 0.04, 5200);
      break;
    }
    case 'hunt': {
      noiseBurst(ctx, master, t0, 0.1, 0.12, 400);
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(180, t0);
      o.frequency.exponentialRampToValueAtTime(75, t0 + 0.1);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 900;
      const g = envGain(ctx, master, 0.06, 0.006, 0.04, 0.1, t0);
      o.connect(f);
      f.connect(g);
      o.start(t0);
      o.stop(t0 + 0.22);
      break;
    }
    case 'tend_garden': {
      const freqs = [523.25, 659.25, 783.99];
      freqs.forEach((fq, i) => {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = fq;
        const g = envGain(ctx, master, 0.045, 0.004, 0.05, 0.12, t0 + i * 0.055);
        o.connect(g);
        o.start(t0 + i * 0.055);
        o.stop(t0 + 0.35);
      });
      noiseBurst(ctx, master, t0, 0.15, 0.04, 1100);
      break;
    }
    case 'mine': {
      const clang = ctx.createOscillator();
      clang.type = 'square';
      clang.frequency.setValueAtTime(180, t0);
      clang.frequency.exponentialRampToValueAtTime(95, t0 + 0.04);
      const g0 = envGain(ctx, master, 0.07, 0.001, 0.03, 0.08, t0);
      clang.connect(g0);
      clang.start(t0);
      clang.stop(t0 + 0.15);
      const ring = ctx.createOscillator();
      ring.type = 'sine';
      ring.frequency.setValueAtTime(2480, t0 + 0.01);
      ring.frequency.exponentialRampToValueAtTime(880, t0 + 0.35);
      const fr = ctx.createBiquadFilter();
      fr.type = 'bandpass';
      fr.frequency.value = 2000;
      fr.Q.value = 8;
      const g1 = envGain(ctx, master, 0.055, 0.006, 0.08, 0.22, t0 + 0.01);
      ring.connect(fr);
      fr.connect(g1);
      ring.start(t0 + 0.01);
      ring.stop(t0 + 0.4);
      noiseBurst(ctx, master, t0, 0.07, 0.07, 1600);
      break;
    }
    case 'ley_residue': {
      const freqs = [440, 554.37, 659.25, 880];
      freqs.forEach((fq, i) => {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = fq;
        const g = envGain(ctx, master, 0.035 + i * 0.012, 0.05, 0.08, 0.2, t0 + i * 0.045);
        o.connect(g);
        o.start(t0 + i * 0.045);
        o.stop(t0 + 0.55);
      });
      noiseBurst(ctx, master, t0 + 0.1, 0.25, 0.06, 6000);
      break;
    }
    default:
      break;
  }
}

/* ---------- Per-hit progress (awakened-mode multi-hit harvest) ---------- */

/**
 * Per-hit "chop / pick / pluck" SFX. Tuned ~80–150 ms per call with ±8% pitch jitter so
 * a 5–10 hit sequence sounds varied (not a machine gun). Each call allocates 3–5 nodes
 * total. Designed to be safe to fire 5+ times per second without audible buildup.
 */
export function playGatherProgressWorldSfx(
  ctx: AudioContext,
  bus: GainNode,
  id: HarvestMaterialId,
): void {
  if (ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.95;
  master.connect(bus);

  const j = jitter(0.08); /* ±8% pitch jitter — kills repetition */

  switch (id) {
    case 'wood': {
      /* Axe-into-bark: bandpass noise burst (the chop's bite) + tonal body thump (the
       * trunk's resonance). Bark click on top reads as the impact transient. */
      noiseBurst(ctx, master, t0, 0.085, 0.13, 220 * j, 4.0);
      const body = ctx.createOscillator();
      body.type = 'sine';
      body.frequency.setValueAtTime(110 * j, t0 + 0.005);
      body.frequency.exponentialRampToValueAtTime(70 * j, t0 + 0.075);
      const gb = envGain(ctx, master, 0.13, 0.003, 0.025, 0.05, t0 + 0.005);
      body.connect(gb);
      body.start(t0 + 0.005);
      body.stop(t0 + 0.12);
      /* Bark crack — tiny triangle click at high freq, very brief. */
      const crack = ctx.createOscillator();
      crack.type = 'triangle';
      crack.frequency.setValueAtTime(380 * j, t0);
      const gc = envGain(ctx, master, 0.07, 0.001, 0.008, 0.02, t0);
      crack.connect(gc);
      crack.start(t0);
      crack.stop(t0 + 0.04);
      break;
    }
    case 'stone': {
      /* Pick-on-stone: sharp high click + gritty mid noise. */
      const click = ctx.createOscillator();
      click.type = 'square';
      click.frequency.setValueAtTime(820 * j, t0);
      click.frequency.exponentialRampToValueAtTime(420 * j, t0 + 0.022);
      const gc = envGain(ctx, master, 0.09, 0.001, 0.012, 0.025, t0);
      click.connect(gc);
      click.start(t0);
      click.stop(t0 + 0.05);
      noiseBurst(ctx, master, t0 + 0.005, 0.085, 0.09, 600 * j, 2.4);
      noiseBurst(ctx, master, t0, 0.04, 0.06, 2200 * j, 1.0);
      break;
    }
    case 'fiber': {
      /* Tearing grass — soft filtered noise sweep, no tonal body. */
      noiseSweep(ctx, master, t0, 0.12, 0.085, 900 * j, 380 * j, 1.4);
      break;
    }
    case 'berries': {
      /* Pluck — bright sine pluck, very short. */
      sinePartial(ctx, master, t0, 740 * j, 0.07, 0.06, 'sine');
      sinePartial(ctx, master, t0 + 0.012, 1180 * j, 0.04, 0.05, 'triangle');
      break;
    }
    case 'metal_base': {
      /* Iron / coal — dull metallic clang. Two slightly detuned low sines + transient
       * noise click. */
      sinePartial(ctx, master, t0, 280 * j, 0.09, 0.13, 'sine');
      sinePartial(ctx, master, t0, 295 * j, 0.07, 0.13, 'sine');
      noiseBurst(ctx, master, t0, 0.045, 0.08, 1800 * j, 1.6);
      break;
    }
    case 'metal_alloy': {
      /* Copper / tin / zinc — brighter mid clang. Higher partials, sharper attack. */
      sinePartial(ctx, master, t0, 380 * j, 0.085, 0.14, 'sine');
      sinePartial(ctx, master, t0, 575 * j, 0.05, 0.12, 'sine');
      noiseBurst(ctx, master, t0, 0.04, 0.07, 2400 * j, 1.8);
      break;
    }
    case 'metal_precious': {
      /* Silver / gold / platinum — bell-like multi-partial. Harmonic ratios 1 / 2 / 3
       * give a clean bell color; longer decay than the base/alloy clangs. */
      const f0 = 520 * j;
      sinePartial(ctx, master, t0, f0, 0.075, 0.22, 'sine');
      sinePartial(ctx, master, t0, f0 * 2, 0.04, 0.18, 'sine');
      sinePartial(ctx, master, t0, f0 * 3, 0.025, 0.14, 'sine');
      noiseBurst(ctx, master, t0, 0.03, 0.05, 3200, 2.2);
      break;
    }
    case 'crystal': {
      /* Magic crystal — clear chime. Three partials at slightly inharmonic ratios
       * (1, 2.05, 3.12) give a crystalline shimmer rather than a metal bell. */
      const f0 = 880 * j;
      sinePartial(ctx, master, t0, f0, 0.07, 0.28, 'sine');
      sinePartial(ctx, master, t0 + 0.01, f0 * 2.05, 0.045, 0.22, 'sine');
      sinePartial(ctx, master, t0 + 0.02, f0 * 3.12, 0.03, 0.18, 'sine');
      break;
    }
  }
}

/* ---------- Final-break climax (last hit on a fully-harvested node) ---------- */

/**
 * Climactic SFX when a node fully despawns — tree-fall crash, boulder crumble,
 * ore-shatter clang, crystal bell sweep. Significantly heavier than `progress` (10–20
 * nodes vs 3–5; 0.6–1.4 s tail vs 80–150 ms) but still all procedural — fires once per
 * node death, so call frequency is naturally low (player can't break trees faster than
 * 1/sec).
 */
export function playGatherBreakWorldSfx(
  ctx: AudioContext,
  bus: GainNode,
  id: HarvestMaterialId,
): void {
  if (ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 1.0;
  master.connect(bus);

  switch (id) {
    case 'wood': {
      /* TREE FALL — the iconic moment. Three layered phases:
       *   1. Pre-snap: 2 quick wood-snap clicks (branches breaking) at t0 .. t0+0.09.
       *   2. Whoosh: filtered noise sweep 800 → 200 Hz over 0.7s (the trunk falling
       *      through air; descending pitch sells the gravity).
       *   3. Crash: at t0+0.65 (when the trunk hits ground), low body thud at 60 Hz
       *      + broadband noise burst + 3 settling cracks over 0.4s.
       * Total tail ~1.2s. */
      woodSnap(ctx, master, t0, 320, 0.12);
      woodSnap(ctx, master, t0 + 0.08, 480, 0.09);
      noiseSweep(ctx, master, t0 + 0.05, 0.7, 0.18, 800, 200, 1.8);
      /* The crash itself — at t0+0.65. */
      const crashT = t0 + 0.65;
      const thud = ctx.createOscillator();
      thud.type = 'sine';
      thud.frequency.setValueAtTime(85, crashT);
      thud.frequency.exponentialRampToValueAtTime(45, crashT + 0.22);
      const gth = envGain(ctx, master, 0.32, 0.005, 0.12, 0.3, crashT);
      thud.connect(gth);
      thud.start(crashT);
      thud.stop(crashT + 0.5);
      noiseBurst(ctx, master, crashT, 0.18, 0.22, 280, 1.6);
      noiseBurst(ctx, master, crashT, 0.32, 0.12, 90, 1.2);
      /* Settling cracks — the "branches breaking under the trunk" tail. */
      woodSnap(ctx, master, crashT + 0.12, 260, 0.07);
      woodSnap(ctx, master, crashT + 0.22, 360, 0.05);
      woodSnap(ctx, master, crashT + 0.34, 220, 0.04);
      break;
    }
    case 'stone': {
      /* Boulder crumble — granular noise wash, no pitched body, low rumble underneath. */
      noiseSweep(ctx, master, t0, 0.55, 0.2, 1400, 220, 1.4);
      noiseBurst(ctx, master, t0, 0.5, 0.12, 110, 1.0);
      /* Settling rocks — small noise bursts spaced over 0.5s. */
      for (let i = 0; i < 5; i++) {
        const tt = t0 + 0.08 + i * 0.07 + Math.random() * 0.02;
        noiseBurst(ctx, master, tt, 0.04 + Math.random() * 0.03, 0.07, 600 + Math.random() * 400, 2.0);
      }
      /* Low rumble — the "weight" of stone collapsing. */
      const rum = ctx.createOscillator();
      rum.type = 'sawtooth';
      rum.frequency.setValueAtTime(55, t0);
      rum.frequency.exponentialRampToValueAtTime(35, t0 + 0.6);
      const fr = ctx.createBiquadFilter();
      fr.type = 'lowpass';
      fr.frequency.value = 180;
      const gr = envGain(ctx, master, 0.14, 0.02, 0.3, 0.3, t0);
      rum.connect(fr);
      fr.connect(gr);
      rum.start(t0);
      rum.stop(t0 + 0.7);
      break;
    }
    case 'fiber': {
      /* Bushel rip — short rip + tiny rustle tail. */
      noiseSweep(ctx, master, t0, 0.35, 0.12, 1200, 400, 1.6);
      noiseBurst(ctx, master, t0 + 0.18, 0.18, 0.06, 800, 1.2);
      break;
    }
    case 'berries': {
      /* Bush rustle + harvest jingle (bright pluck cluster). */
      noiseBurst(ctx, master, t0, 0.18, 0.08, 1800, 1.4);
      [880, 1180, 1480].forEach((fq, i) => {
        sinePartial(ctx, master, t0 + 0.04 + i * 0.04, fq * jitter(0.04), 0.06, 0.1, 'triangle');
      });
      break;
    }
    case 'metal_base': {
      /* Iron / coal node shatter — heavy clang + crumble tail. Sells the "deposit cracks
       * open" moment. */
      sinePartial(ctx, master, t0, 220, 0.16, 0.5, 'sine');
      sinePartial(ctx, master, t0, 235, 0.12, 0.45, 'sine');
      noiseBurst(ctx, master, t0, 0.08, 0.18, 1400, 1.8);
      noiseSweep(ctx, master, t0 + 0.05, 0.45, 0.13, 900, 200, 1.4);
      /* Settling pebbles. */
      for (let i = 0; i < 4; i++) {
        const tt = t0 + 0.15 + i * 0.08 + Math.random() * 0.03;
        noiseBurst(ctx, master, tt, 0.03, 0.05, 500 + Math.random() * 500, 2.4);
      }
      break;
    }
    case 'metal_alloy': {
      /* Brighter shatter — higher partials, ringing tail. */
      sinePartial(ctx, master, t0, 340, 0.14, 0.55, 'sine');
      sinePartial(ctx, master, t0, 510, 0.09, 0.5, 'sine');
      sinePartial(ctx, master, t0, 685, 0.06, 0.45, 'sine');
      noiseBurst(ctx, master, t0, 0.07, 0.16, 2200, 1.8);
      noiseSweep(ctx, master, t0 + 0.06, 0.4, 0.1, 1400, 320, 1.4);
      break;
    }
    case 'metal_precious': {
      /* Bell shimmer — long resonant decay + sparkly noise tail. Reads as "treasure". */
      const f0 = 520;
      sinePartial(ctx, master, t0, f0, 0.16, 0.9, 'sine');
      sinePartial(ctx, master, t0, f0 * 2, 0.1, 0.75, 'sine');
      sinePartial(ctx, master, t0, f0 * 3, 0.07, 0.6, 'sine');
      sinePartial(ctx, master, t0, f0 * 4.2, 0.05, 0.45, 'sine');
      noiseBurst(ctx, master, t0, 0.04, 0.1, 4000, 2.6);
      /* High shimmer — fast filtered noise tail. */
      noiseSweep(ctx, master, t0 + 0.05, 0.55, 0.06, 5200, 2200, 3.0);
      break;
    }
    case 'crystal': {
      /* Crystal harvest chime — descending shimmer cascade. */
      const partials = [1320, 1760, 2200, 2940];
      partials.forEach((fq, i) => {
        sinePartial(ctx, master, t0 + i * 0.06, fq * jitter(0.02), 0.09, 0.6, 'sine');
      });
      /* Sub bell underneath — adds weight to the chime. */
      sinePartial(ctx, master, t0, 440, 0.08, 0.7, 'sine');
      noiseBurst(ctx, master, t0, 0.04, 0.06, 6000, 3.0);
      break;
    }
  }
}

/* ---------- Water gathering (bucket fill at the river) ---------- */

/**
 * Awakened-mode water-gather SFX: a full bucket-fill cycle in ~0.9s. Three layered
 * phases:
 *   1. **Dip** (t0 .. t0+0.12) — bucket plunged into the water. Short bright splash:
 *      filtered noise burst at ~3 kHz + low body thud (the bucket displacing water).
 *   2. **Pour / fill** (t0+0.10 .. t0+0.75) — sustained running-water wash. Bandpass
 *      noise sweep that rises slightly in pitch as the bucket fills (water level
 *      climbs → resonance frequency climbs), with a mid bubble layer underneath.
 *   3. **Lift + drip tail** (t0+0.7 .. t0+1.0) — bucket pulled out, last drips fall
 *      back. Low-amplitude noise burst + 2 quick pitched drips.
 *
 * Cost: ~6-8 audio nodes total. Fires once per E press near water (player can't spam
 * faster than ~1/sec realistically). Designed to layer cleanly with footstep SFX so
 * the player hears both if they walk while filling.
 */
export function playWaterGatherWorldSfx(ctx: AudioContext, bus: GainNode): void {
  if (ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.92;
  master.connect(bus);

  /* Phase 1 — DIP: splash + bucket-into-water thud. */
  noiseBurst(ctx, master, t0, 0.12, 0.14, 2800, 1.2);
  const dipThud = ctx.createOscillator();
  dipThud.type = 'sine';
  dipThud.frequency.setValueAtTime(180, t0);
  dipThud.frequency.exponentialRampToValueAtTime(95, t0 + 0.09);
  const gdt = ctx.createGain();
  gdt.gain.setValueAtTime(0.0001, t0);
  gdt.gain.exponentialRampToValueAtTime(0.1, t0 + 0.005);
  gdt.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
  dipThud.connect(gdt);
  gdt.connect(master);
  dipThud.start(t0);
  dipThud.stop(t0 + 0.14);

  /* Phase 2 — POUR / FILL: sustained running-water wash that rises in resonance as
   * the bucket fills. Bandpass center sweeps 700 → 1400 Hz over the fill duration. */
  noiseSweep(ctx, master, t0 + 0.1, 0.65, 0.13, 700, 1400, 1.6);
  /* Bubble layer — a slightly lower bandpass at constant freq under the sweep, gives
   * the "running into a container" body weight. */
  noiseBurst(ctx, master, t0 + 0.15, 0.55, 0.08, 380, 1.0);

  /* Phase 3 — LIFT + DRIP: small noise burst (water settling) + 2 pitched drips. */
  noiseBurst(ctx, master, t0 + 0.72, 0.18, 0.06, 1200, 1.4);
  /* Drip 1 — short descending sine. */
  const drip1 = ctx.createOscillator();
  drip1.type = 'sine';
  drip1.frequency.setValueAtTime(620, t0 + 0.78);
  drip1.frequency.exponentialRampToValueAtTime(360, t0 + 0.86);
  const gd1 = ctx.createGain();
  gd1.gain.setValueAtTime(0.0001, t0 + 0.78);
  gd1.gain.exponentialRampToValueAtTime(0.05, t0 + 0.79);
  gd1.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.92);
  drip1.connect(gd1);
  gd1.connect(master);
  drip1.start(t0 + 0.78);
  drip1.stop(t0 + 0.94);
  /* Drip 2 — slightly higher, slightly later. */
  const drip2 = ctx.createOscillator();
  drip2.type = 'sine';
  drip2.frequency.setValueAtTime(740, t0 + 0.86);
  drip2.frequency.exponentialRampToValueAtTime(440, t0 + 0.94);
  const gd2 = ctx.createGain();
  gd2.gain.setValueAtTime(0.0001, t0 + 0.86);
  gd2.gain.exponentialRampToValueAtTime(0.035, t0 + 0.87);
  gd2.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.0);
  drip2.connect(gd2);
  gd2.connect(master);
  drip2.start(t0 + 0.86);
  drip2.stop(t0 + 1.02);
}

/* ---------- Consume (eat / drink) — unchanged ---------- */

export function playConsumeWorldSfx(ctx: AudioContext, bus: GainNode, id: ConsumeSfxId): void {
  if (ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.88;
  master.connect(bus);

  switch (id) {
    case 'eat_meat': {
      noiseBurst(ctx, master, t0, 0.08, 0.06, 600);
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(220, t0);
      o.frequency.linearRampToValueAtTime(160, t0 + 0.12);
      const g = envGain(ctx, master, 0.09, 0.015, 0.06, 0.1, t0);
      o.connect(g);
      o.start(t0);
      o.stop(t0 + 0.28);
      break;
    }
    case 'eat_berries': {
      noiseBurst(ctx, master, t0, 0.05, 0.05, 3500);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(900, t0);
      o.frequency.exponentialRampToValueAtTime(1200, t0 + 0.03);
      o.frequency.exponentialRampToValueAtTime(700, t0 + 0.08);
      const g = envGain(ctx, master, 0.075, 0.003, 0.02, 0.06, t0);
      o.connect(g);
      o.start(t0);
      o.stop(t0 + 0.12);
      break;
    }
    case 'drink_water': {
      noiseBurst(ctx, master, t0, 0.06, 0.07, 500);
      noiseBurst(ctx, master, t0 + 0.04, 0.14, 0.05, 2200);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(300, t0 + 0.06);
      o.frequency.exponentialRampToValueAtTime(450, t0 + 0.1);
      o.frequency.exponentialRampToValueAtTime(200, t0 + 0.22);
      const g = envGain(ctx, master, 0.08, 0.02, 0.08, 0.14, t0 + 0.06);
      o.connect(g);
      o.start(t0 + 0.06);
      o.stop(t0 + 0.32);
      break;
    }
    default:
      break;
  }
}
