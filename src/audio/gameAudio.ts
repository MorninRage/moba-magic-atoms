/**
 * Audio bus: UI SFX, world SFX (gather / consume), optional file-based score + procedural fallback.
 */
import './audioDock.css';
import { FilePlaylistMusic, type GameMusicTransport } from './fileMusic';
import { yieldAnimationFrame } from '../util/mainThreadYield';
import { BATTLE_MUSIC_ENTRY, MENU_MUSIC_ENTRY, MUSIC_FILE_MANIFEST } from './musicManifest';
import {
  gatherActionToSfxId,
  harvestKindToMaterialId,
  playConsumeWorldSfx,
  playGatherBreakWorldSfx,
  playGatherProgressWorldSfx,
  playGatherWorldSfx,
  playWaterGatherWorldSfx,
  type ConsumeSfxId,
  type HarvestMaterialId,
} from './worldSfx';
import {
  playDoubleJumpWorldSfx,
  playFootstepWorldSfx,
  playJumpWorldSfx,
  playLandWorldSfx,
  playMushroomBounceWorldSfx,
} from './movementSfx';
import {
  playMagicImpactWorldSfx,
  playMeleeImpactWorldSfx,
  playMobDeathWorldSfx,
  playMobFootstepWorldSfx,
  playMobHitWorldSfx,
  playPlayerMagicCastWorldSfx,
  playPlayerSwingWorldSfx,
  type CombatMobKind,
} from './combatSfx';

export type UiSoundKind = 'tap' | 'primary' | 'secondary' | 'danger' | 'card' | 'tab';

const LS_SFX = 'idlecraft-audio-sfx';
const LS_MUSIC = 'idlecraft-audio-music';
const LS_THEME = 'idlecraft-audio-theme';
const LS_VOL_MUSIC = 'idlecraft-vol-music-pct';
const LS_VOL_SFX = 'idlecraft-vol-sfx-pct';
/* Per-category sub-bus volumes (multiply on top of the master Effects slider). Stored
 * 0–200 so a player who wants a category louder than the master can push it. */
const LS_VOL_HARVEST = 'idlecraft-vol-harvest-pct';
const LS_VOL_FOOTSTEP = 'idlecraft-vol-footstep-pct';
const LS_VOL_JUMPLAND = 'idlecraft-vol-jumpland-pct';

/** Effects slider goes to 200% (stored0–200); gain uses pct/100 so max is 2× former “100%”. */
const SFX_VOL_SLIDER_MAX = 200;
const DEFAULT_MUSIC_VOL_PCT = 42;
const DEFAULT_SFX_VOL_PCT = 200;
/* Per-category default volumes (the user can override these in the ESC audio panel).
 * Footsteps tuned to 104% — the procedural profile in `movementSfx.ts` was lowered to
 * a restrained baseline (peak ~0.06) so this mild boost lands the cadence at the
 * "perfect" mix level for the default scene without overpowering harvest/jump SFX. */
const DEFAULT_HARVEST_VOL_PCT = 100;
const DEFAULT_FOOTSTEP_VOL_PCT = 104;
const DEFAULT_JUMPLAND_VOL_PCT = 100;
/**
 * Music slider0–100 maps through this exponent before × MUSIC_BASE.
 * 100% = same peak as legacy linear; low settings get much quieter (usable bed without mute).
 */
const MUSIC_VOL_CURVE_EXP = 2.2;

/** Peak gain into master before user volume (music vs SFX balance). */
const MUSIC_BASE = 0.19;
const SFX_UI_BASE = 0.3;
const SFX_WORLD_BASE = 0.24;

export const AMBIENT_THEME_NAMES = [
  'Frontier drift',
  'Ember pulse',
  'Deep salvage',
  'Ion bloom',
] as const;

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let masterComp: DynamicsCompressorNode | null = null;
let sfxGain: GainNode | null = null;
let worldSfxGain: GainNode | null = null;
/* Per-category sub-busses (route through `worldSfxGain` so the master Effects slider
 * still scales them as a group, but each has its own user-controllable level on top). */
let harvestSfxGain: GainNode | null = null;
let footstepSfxGain: GainNode | null = null;
let jumpLandSfxGain: GainNode | null = null;
let musicGain: GainNode | null = null;
let musicShelf: BiquadFilterNode | null = null;
let musicTransport: GameMusicTransport | null = null;
let musicBackendReady = false;
/** Title / start flow vs in-game — drives menu bed vs rotating playlist. */
let musicMainMenuMode = true;
/** PvE combat bed — applied when transport starts if still true (e.g. reload mid-fight). */
let musicBattleMode = false;

let sfxEnabled = true;
let musicEnabled = true;
let musicThemeIndex = 0;
/** 0–100 — multiplied with *BASE into gain nodes. */
let musicVolumePct = DEFAULT_MUSIC_VOL_PCT;
let sfxVolumePct = DEFAULT_SFX_VOL_PCT;
let harvestVolumePct = DEFAULT_HARVEST_VOL_PCT;
let footstepVolumePct = DEFAULT_FOOTSTEP_VOL_PCT;
let jumpLandVolumePct = DEFAULT_JUMPLAND_VOL_PCT;

function readBool(key: string, defaultVal: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return defaultVal;
    return v === '1';
  } catch {
    return defaultVal;
  }
}

function writeBool(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function readTheme(key: string, def: number): number {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return def;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return def;
    return n;
  } catch {
    return def;
  }
}

function writeTheme(n: number): void {
  try {
    localStorage.setItem(LS_THEME, String(n));
  } catch {
    /* ignore */
  }
}

function readVolumePct(key: string, defaultPct: number, maxPct = 100): number {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return defaultPct;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return defaultPct;
    return Math.max(0, Math.min(maxPct, n));
  } catch {
    return defaultPct;
  }
}

function writeVolumePct(key: string, pct: number, maxPct = 100): void {
  try {
    localStorage.setItem(key, String(Math.max(0, Math.min(maxPct, Math.round(pct)))));
  } catch {
    /* ignore */
  }
}

function musicLevelMul(): number {
  const t = musicVolumePct / 100;
  return Math.pow(t, MUSIC_VOL_CURVE_EXP);
}

function sfxLevelMul(): number {
  return sfxVolumePct / 100;
}

function renderAmbientBuffer(context: AudioContext, theme: number): AudioBuffer {
  const duration = 10;
  const sr = context.sampleRate;
  const frames = Math.floor(sr * duration);
  const buf = context.createBuffer(2, frames, sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);

  const presets: { freqs: number[]; lfo: number; pulse: number }[] = [
    { freqs: [55, 82.5, 110], lfo: 0.11, pulse: 0.33 },
    { freqs: [65.41, 98, 146.83], lfo: 0.2, pulse: 1.05 },
    { freqs: [49, 73.5, 98], lfo: 0.08, pulse: 0.5 },
    { freqs: [82.41, 123.47, 164.81], lfo: 0.15, pulse: 0.75 },
  ];
  const p = presets[theme % 4];
  const { freqs, lfo, pulse } = p;

  for (let i = 0; i < frames; i++) {
    const t = i / sr;
    let s = 0;
    const trem = 0.55 + 0.45 * Math.sin(t * 2 * Math.PI * lfo);
    const beat = 0.88 + 0.12 * Math.sin(t * 2 * Math.PI * pulse);
    for (let k = 0; k < freqs.length; k++) {
      const ph = k * 1.7;
      s += Math.sin(2 * Math.PI * freqs[k] * t + ph) * (0.22 / freqs.length);
    }
    s = Math.tanh(s * trem * beat * 2.2) * 0.34;
    L[i] = s;
    R[i] = s * (0.78 + 0.22 * Math.sin(2 * Math.PI * 0.09 * t + theme * 0.7));
  }
  return buf;
}

class ProceduralAmbient implements GameMusicTransport {
  private source: AudioBufferSourceNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private theme = 0;
  private running = false;
  private mainMenu = true;

  constructor(
    private readonly ac: AudioContext,
    private readonly out: AudioNode,
  ) {}

  getTrackCount(): number {
    return AMBIENT_THEME_NAMES.length;
  }

  getTrackTitle(index: number): string {
    const n = AMBIENT_THEME_NAMES.length;
    const i = ((index % n) + n) % n;
    return AMBIENT_THEME_NAMES[i];
  }

  setTheme(t: number): void {
    const n = AMBIENT_THEME_NAMES.length;
    this.theme = ((t % n) + n) % n;
  }

  setBattleMode(_on: boolean): void {
    /* Procedural fallback has no separate combat bed. */
  }

  setMainMenuMode(menu: boolean): void {
    if (menu === this.mainMenu) return;
    this.mainMenu = menu;
    if (!this.running) return;
    this.spawnLoop();
  }

  getDisplayLabel(): string {
    if (this.mainMenu) return 'Frontier desk';
    return this.getTrackTitle(this.theme);
  }

  getTheme(): number {
    return this.theme;
  }

  start(): void {
    if (this.source) return;
    this.running = true;
    this.spawnLoop();
  }

  stop(): void {
    this.running = false;
    this.teardown();
  }

  refreshTheme(): void {
    if (!this.running || this.mainMenu) return;
    this.spawnLoop();
  }

  private teardown(): void {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        /* already stopped */
      }
      this.source.disconnect();
      this.source = null;
    }
    if (this.filter) {
      this.filter.disconnect();
      this.filter = null;
    }
  }

  private spawnLoop(): void {
    if (!this.running || this.ac.state !== 'running') return;
    this.teardown();
    const t = this.mainMenu ? 0 : this.theme;
    const buf = renderAmbientBuffer(this.ac, t);
    const src = this.ac.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const f = this.ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 820 + t * 260;
    f.Q.value = 0.4;
    src.connect(f);
    f.connect(this.out);
    src.start();
    this.source = src;
    this.filter = f;
  }
}

function ensureContext(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();

    masterComp = ctx.createDynamicsCompressor();
    masterComp.threshold.value = -20;
    masterComp.knee.value = 18;
    masterComp.ratio.value = 2.2;
    masterComp.attack.value = 0.004;
    masterComp.release.value = 0.2;
    masterComp.connect(ctx.destination);

    masterGain = ctx.createGain();
    masterGain.gain.value = 0.82;
    masterGain.connect(masterComp);

    musicShelf = ctx.createBiquadFilter();
    musicShelf.type = 'lowshelf';
    musicShelf.frequency.value = 300;
    musicShelf.gain.value = 2;

    musicGain = ctx.createGain();
    musicGain.gain.value = musicEnabled ? MUSIC_BASE * musicLevelMul() : 0;
    musicShelf.connect(musicGain);
    musicGain.connect(masterGain);

    sfxGain = ctx.createGain();
    sfxGain.gain.value = sfxEnabled ? SFX_UI_BASE * sfxLevelMul() : 0;
    sfxGain.connect(masterGain);

    worldSfxGain = ctx.createGain();
    worldSfxGain.gain.value = sfxEnabled ? SFX_WORLD_BASE * sfxLevelMul() : 0;
    worldSfxGain.connect(masterGain);

    /* Per-category sub-busses. Each routes through `worldSfxGain` so the master
     * "Effects level" still scales them as a group (a player who turns the master
     * down to 50% gets 50% of every category). The per-category gain is a pure
     * 0–2× multiplier on top, persisted to localStorage independently. */
    harvestSfxGain = ctx.createGain();
    harvestSfxGain.gain.value = harvestVolumePct / 100;
    harvestSfxGain.connect(worldSfxGain);
    footstepSfxGain = ctx.createGain();
    footstepSfxGain.gain.value = footstepVolumePct / 100;
    footstepSfxGain.connect(worldSfxGain);
    jumpLandSfxGain = ctx.createGain();
    jumpLandSfxGain.gain.value = jumpLandVolumePct / 100;
    jumpLandSfxGain.connect(worldSfxGain);

    return ctx;
  } catch {
    return null;
  }
}

async function ensureMusicBackend(): Promise<void> {
  if (!ctx || !musicShelf) return;

  const expeditionExpected = MUSIC_FILE_MANIFEST.length;
  if (
    musicBackendReady &&
    musicTransport instanceof FilePlaylistMusic &&
    musicTransport.getTrackCount() < expeditionExpected
  ) {
    musicTransport.stop();
    musicTransport = null;
    musicBackendReady = false;
    if (import.meta.env.DEV) {
      console.info('[music] Rebuilding playlist — more expedition files available than last init.');
    }
  }

  if (musicBackendReady) return;

  musicBackendReady = true;
  const file = await FilePlaylistMusic.tryCreate(
    ctx,
    musicShelf,
    MUSIC_FILE_MANIFEST,
    MENU_MUSIC_ENTRY,
    BATTLE_MUSIC_ENTRY,
  );
  /** After decode — user may have tapped Continue while awaits were in flight. */
  const onTitle = isOnTitleFlow();
  if (file) {
    musicTransport = file;
    musicThemeIndex = musicThemeIndex % file.getTrackCount();
    file.setTheme(musicThemeIndex);
    file.setMainMenuMode(onTitle);
    file.setGameIndexChangeHandler((i) => {
      musicThemeIndex = i;
      writeTheme(i);
      refreshAudioControlLabels();
    });
    writeTheme(musicThemeIndex);
  } else {
    const proc = new ProceduralAmbient(ctx, musicShelf);
    musicThemeIndex = ((musicThemeIndex % AMBIENT_THEME_NAMES.length) + AMBIENT_THEME_NAMES.length) % AMBIENT_THEME_NAMES.length;
    proc.setTheme(musicThemeIndex);
    proc.setMainMenuMode(onTitle);
    musicTransport = proc;
    writeTheme(musicThemeIndex);
  }
  musicMainMenuMode = onTitle;
}

/** Main shell mounted — when absent, start flow / title is showing. */
export function isOnTitleFlow(): boolean {
  return typeof document !== 'undefined' && document.querySelector('#app-shell') == null;
}

/** Resume AudioContext and ensure music backend (for UI after first gesture). */
export async function resumeAndStartMusic(): Promise<void> {
  const c = ensureContext();
  if (!c) return;
  await c.resume();
  await ensureMusicBackend();
  /* One frame after decode/RMS so transport.start does not stack in the same tick as heavy GPU work. */
  await yieldAnimationFrame();
  const onTitle = isOnTitleFlow();
  musicMainMenuMode = onTitle;
  musicTransport?.setMainMenuMode(onTitle);
  if (!onTitle && musicBattleMode) {
    musicTransport?.setBattleMode(true);
  }
  if (musicTransport && musicEnabled) {
    musicTransport.start();
  }
}

function syncMusicGain(): void {
  if (musicGain) musicGain.gain.value = musicEnabled ? MUSIC_BASE * musicLevelMul() : 0;
}

function syncSfxGain(): void {
  const m = sfxLevelMul();
  if (sfxGain) sfxGain.gain.value = sfxEnabled ? SFX_UI_BASE * m : 0;
  if (worldSfxGain) worldSfxGain.gain.value = sfxEnabled ? SFX_WORLD_BASE * m : 0;
}

/**
 * Sync the per-category sub-bus gains from the current `*VolumePct` state. Called when
 * a slider moves. Each sub-bus is a pure 0–2× multiplier on top of `worldSfxGain`'s
 * master Effects level — so the master slider still scales the whole group, while these
 * sliders let the player dial individual categories up or down independently.
 *
 * The `sfxEnabled` mute is applied at the master `worldSfxGain` (not here), so the sub-
 * busses stay at their user-set levels and re-enabling SFX restores everything cleanly.
 */
function syncCategorySfxGains(): void {
  if (harvestSfxGain) harvestSfxGain.gain.value = harvestVolumePct / 100;
  if (footstepSfxGain) footstepSfxGain.gain.value = footstepVolumePct / 100;
  if (jumpLandSfxGain) jumpLandSfxGain.gain.value = jumpLandVolumePct / 100;
}

function currentTrackLabel(): string {
  const t = musicTransport;
  if (t) return t.getDisplayLabel();
  return musicMainMenuMode
    ? 'Frontier desk'
    : AMBIENT_THEME_NAMES[musicThemeIndex % AMBIENT_THEME_NAMES.length];
}

/** After auto-advance or before showing audio UI, align persisted theme with transport. */
export function syncMusicThemeFromTransport(): void {
  if (musicTransport) {
    musicThemeIndex = musicTransport.getTheme();
    writeTheme(musicThemeIndex);
  }
}

/** Call when switching between title flow and in-game shell (crossfades file music). */
export function setBattleMusicMode(on: boolean): void {
  musicBattleMode = on;
  musicTransport?.setBattleMode(on);
  refreshAudioControlLabels();
}

export function setMusicMainMenuMode(inMenu: boolean): void {
  musicMainMenuMode = inMenu;
  if (inMenu) {
    musicBattleMode = false;
    musicTransport?.setBattleMode(false);
  }
  musicTransport?.setMainMenuMode(inMenu);
  refreshAudioControlLabels();
}

/** First user gesture resumes AudioContext and starts music backend if enabled. */
export function initGameAudio(): void {
  sfxEnabled = readBool(LS_SFX, true);
  musicEnabled = readBool(LS_MUSIC, true);
  musicThemeIndex = readTheme(LS_THEME, 0);
  musicVolumePct = readVolumePct(LS_VOL_MUSIC, DEFAULT_MUSIC_VOL_PCT);
  sfxVolumePct = readVolumePct(LS_VOL_SFX, DEFAULT_SFX_VOL_PCT, SFX_VOL_SLIDER_MAX);
  harvestVolumePct = readVolumePct(LS_VOL_HARVEST, DEFAULT_HARVEST_VOL_PCT, SFX_VOL_SLIDER_MAX);
  footstepVolumePct = readVolumePct(LS_VOL_FOOTSTEP, DEFAULT_FOOTSTEP_VOL_PCT, SFX_VOL_SLIDER_MAX);
  jumpLandVolumePct = readVolumePct(LS_VOL_JUMPLAND, DEFAULT_JUMPLAND_VOL_PCT, SFX_VOL_SLIDER_MAX);

  const kick = () => {
    void resumeAndStartMusic();
  };
  window.addEventListener('pointerdown', kick, { capture: true, passive: true });
  window.addEventListener('touchend', kick, { capture: true, passive: true });
  window.addEventListener('keydown', kick, { capture: true, passive: true });
}

export function playUiSound(kind: UiSoundKind): void {
  const c = ctx;
  const sg = sfxGain;
  if (!c || !sg || !sfxEnabled) return;
  if (c.state !== 'running') return;

  const now = c.currentTime;
  const o = c.createOscillator();
  const g = c.createGain();
  o.connect(g);
  g.connect(sg);

  let f0 = 520;
  let f1 = 380;
  let dur = 0.072;
  o.type = 'sine';

  switch (kind) {
    case 'primary':
      f0 = 920;
      f1 = 520;
      dur = 0.085;
      break;
    case 'secondary':
      f0 = 660;
      f1 = 440;
      dur = 0.09;
      break;
    case 'danger':
      f0 = 200;
      f1 = 95;
      o.type = 'triangle';
      dur = 0.13;
      break;
    case 'card':
      f0 = 740;
      f1 = 590;
      dur = 0.052;
      break;
    case 'tab':
      f0 = 1180;
      f1 = 860;
      dur = 0.038;
      break;
    default:
      break;
  }

  o.frequency.setValueAtTime(f0, now);
  o.frequency.exponentialRampToValueAtTime(Math.max(45, f1), now + dur);
  const peak = kind === 'danger' ? 0.13 : kind === 'tab' ? 0.065 : 0.095;
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(peak, now + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur + 0.025);
  o.start(now);
  o.stop(now + dur + 0.06);
}

export function playWorldSoundForGather(actionId: string): void {
  const id = gatherActionToSfxId(actionId);
  if (!id || !ctx || !worldSfxGain || !sfxEnabled) return;
  if (ctx.state !== 'running') return;
  playGatherWorldSfx(ctx, worldSfxGain, id);
}

/**
 * Per-hit "chop / pick / pluck" SFX during the awakened-mode multi-hit harvest loop.
 * Routes through `harvestSfxGain` so the player's "Harvest" slider scales it
 * independently of footsteps / jump-land / other world SFX. Cheap (3-5 audio nodes per
 * call); safe to fire 5+ times per second.
 */
export function playHarvestProgressSound(harvestKind: string): void {
  if (!ctx || !harvestSfxGain || !sfxEnabled) return;
  if (ctx.state !== 'running') return;
  const id = harvestKindToMaterialId(harvestKind);
  if (!id) return;
  playGatherProgressWorldSfx(ctx, harvestSfxGain, id);
}

/**
 * Climactic "node fully broken" SFX — tree-fall crash, boulder crumble, ore shatter,
 * crystal bell sweep. Routes through `harvestSfxGain` (same slider as progress hits).
 * Heavier than progress but fires once per node death so call frequency is naturally low.
 */
export function playHarvestBreakSound(harvestKind: string): void {
  if (!ctx || !harvestSfxGain || !sfxEnabled) return;
  if (ctx.state !== 'running') return;
  const id = harvestKindToMaterialId(harvestKind);
  if (!id) return;
  playGatherBreakWorldSfx(ctx, harvestSfxGain, id);
}

/**
 * Awakened-mode water-gather SFX — bucket-fill cycle (dip → pour → lift + drip tail).
 * Routes through `harvestSfxGain` so the player's "Harvest" slider scales it (water
 * gathering IS a kind of harvest action — same UX category). Fires once per E press
 * near water; profile is ~1s so two presses in quick succession will overlap cleanly.
 */
export function playWaterGatherSound(): void {
  if (!ctx || !harvestSfxGain || !sfxEnabled) return;
  if (ctx.state !== 'running') return;
  playWaterGatherWorldSfx(ctx, harvestSfxGain);
}

/** Direct material-id variants for callers that already have a `HarvestMaterialId`. */
export function playHarvestProgressSoundById(id: HarvestMaterialId): void {
  if (!ctx || !harvestSfxGain || !sfxEnabled) return;
  if (ctx.state !== 'running') return;
  playGatherProgressWorldSfx(ctx, harvestSfxGain, id);
}
export function playHarvestBreakSoundById(id: HarvestMaterialId): void {
  if (!ctx || !harvestSfxGain || !sfxEnabled) return;
  if (ctx.state !== 'running') return;
  playGatherBreakWorldSfx(ctx, harvestSfxGain, id);
}

/* ---------- Movement SFX (awakened-mode WASD walk + jump system) ---------- */

/**
 * One footstep on alternating L/R foot. Routes through `footstepSfxGain` so the
 * player's "Footsteps" slider scales it independently — important because footsteps
 * fire ~2 Hz during sustained walk and otherwise dominate the bus over sparse harvest /
 * jump SFX. Cheap (3-4 audio nodes per call); safe at 3+ Hz.
 */
export function playFootstepSound(foot: 'L' | 'R'): void {
  if (!ctx || !footstepSfxGain || !sfxEnabled) return;
  if (ctx.state !== 'running') return;
  playFootstepWorldSfx(ctx, footstepSfxGain, foot);
}

/** First jump (no flip) — light upward whoof + push-off click. Routes through `jumpLandSfxGain`. */
export function playJumpSound(): void {
  if (!ctx || !jumpLandSfxGain || !sfxEnabled) return;
  if (ctx.state !== 'running') return;
  playJumpWorldSfx(ctx, jumpLandSfxGain);
}

/** Double jump (front flip). Routes through `jumpLandSfxGain` (same slider as jump/land). */
export function playDoubleJumpSound(): void {
  if (!ctx || !jumpLandSfxGain || !sfxEnabled) return;
  if (ctx.state !== 'running') return;
  playDoubleJumpWorldSfx(ctx, jumpLandSfxGain);
}

/**
 * Landing — heavy thud + grit burst + (for hard landings) settling click. Routes through
 * `jumpLandSfxGain` so the same slider that controls jumps controls landings.
 * @param intensity 0..1 — scales the thud peak. Caller maps fall velocity to this.
 */
export function playLandSound(intensity = 0.7): void {
  if (!ctx || !jumpLandSfxGain || !sfxEnabled) return;
  if (ctx.state !== 'running') return;
  playLandWorldSfx(ctx, jumpLandSfxGain, intensity);
}

/**
 * Bouncy-mushroom trampoline boing (Phase 8l). Routes through `jumpLandSfxGain`
 * so the existing "Jump / land sounds" volume slider controls it. `intensity`
 * 0..1.5 scales weight (heavy drop louder than a light brush).
 */
export function playMushroomBounceSound(intensity = 0.8): void {
  if (!ctx || !jumpLandSfxGain || !sfxEnabled) return;
  if (ctx.state !== 'running') return;
  playMushroomBounceWorldSfx(ctx, jumpLandSfxGain, intensity);
}

/* ---------- Awakened-mode combat SFX (Phase 1.5 — see BASE_BUILDING_AND_SURVIVAL_PLAN §13) ---------- */

/**
 * Per-mob hit SFX (squeak / yelp / grunt). Routed through `harvestSfxGain` so it
 * shares the player's "Harvest sounds" volume slider — combat audio is sparse enough
 * that adding a fourth slider would clutter the audio panel for marginal control gain.
 */
export function playMobHitSound(kind: CombatMobKind, volumeScale = 1.0): void {
  if (!ctx || !harvestSfxGain || !sfxEnabled) return;
  if (ctx.state !== 'running') return;
  playMobHitWorldSfx(ctx, harvestSfxGain, kind, volumeScale);
}

/** Per-mob death SFX — long descending voice + body thud. Same routing as hit. */
export function playMobDeathSound(kind: CombatMobKind, volumeScale = 1.0): void {
  if (!ctx || !harvestSfxGain || !sfxEnabled) return;
  if (ctx.state !== 'running') return;
  playMobDeathWorldSfx(ctx, harvestSfxGain, kind, volumeScale);
}

/** Player melee swing (axe/sword/staff) — wood-shaft swing whoosh. */
export function playPlayerSwingSound(): void {
  if (!ctx || !harvestSfxGain || !sfxEnabled) return;
  if (ctx.state !== 'running') return;
  playPlayerSwingWorldSfx(ctx, harvestSfxGain);
}

/** Player magic cast (LMB with wand/staff equipped) — cyan whoosh + harmonic chime. */
export function playPlayerMagicCastSound(): void {
  if (!ctx || !harvestSfxGain || !sfxEnabled) return;
  if (ctx.state !== 'running') return;
  playPlayerMagicCastWorldSfx(ctx, harvestSfxGain);
}

/**
 * Player melee impact — wood/blade THUNK fired when a swing's raycast lands on a mob.
 * Layered on top of the mob's hit voice (`playMobHitSound`) for an ARPG-style audio mix.
 */
export function playMeleeImpactSound(volumeScale = 1.0): void {
  if (!ctx || !harvestSfxGain || !sfxEnabled) return;
  if (ctx.state !== 'running') return;
  playMeleeImpactWorldSfx(ctx, harvestSfxGain, volumeScale);
}

/**
 * Magic projectile impact — cyan crackle when an orb lands on a mob. Layered with
 * the mob's hit voice + (for kill shots) death voice.
 */
export function playMagicImpactSound(volumeScale = 1.0): void {
  if (!ctx || !harvestSfxGain || !sfxEnabled) return;
  if (ctx.state !== 'running') return;
  playMagicImpactWorldSfx(ctx, harvestSfxGain, volumeScale);
}

/**
 * Per-mob footstep (rat skitter / wolf paw / wanderer boot). Routed through
 * `footstepSfxGain` so the same player-side "Footsteps" volume slider controls it —
 * mobs and player are both "creatures walking", same audio category.
 */
export function playMobFootstepSound(kind: CombatMobKind, volumeScale = 1.0): void {
  if (!ctx || !footstepSfxGain || !sfxEnabled) return;
  if (ctx.state !== 'running') return;
  playMobFootstepWorldSfx(ctx, footstepSfxGain, kind, volumeScale);
}

export function playConsumeSound(kind: 'meat' | 'berries' | 'water'): void {
  if (!ctx || !worldSfxGain || !sfxEnabled) return;
  if (ctx.state !== 'running') return;
  const map: Record<typeof kind, ConsumeSfxId> = {
    meat: 'eat_meat',
    berries: 'eat_berries',
    water: 'drink_water',
  };
  playConsumeWorldSfx(ctx, worldSfxGain, map[kind]);
}

/** Re-export for tests / tooling */
export { gatherActionToSfxId };

/** Capture-phase clicks: UI blips (skips `[data-audio-skip]`). */
export function installDelegatedUiSounds(root: HTMLElement = document.body): () => void {
  const handler = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    if (!sfxEnabled) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('[data-audio-skip]')) return;

    const el = target.closest(
      'button, [role="button"], .start-card, .nav-page-btn, .nav-reset-btn',
    ) as HTMLElement | null;
    if (!el) return;
    if ('disabled' in el && (el as HTMLButtonElement).disabled) return;
    /* Gather uses dedicated world SFX when the action completes */
    if (el.classList.contains('gather-action-btn')) return;
    if (el.classList.contains('btn-use-consume')) return;

    let kind: UiSoundKind = 'tap';
    if (el.classList.contains('idlecraft-confirm__btn--danger') || el.classList.contains('nav-reset-btn')) {
      kind = 'danger';
    } else if (el.classList.contains('start-card')) {
      kind = 'card';
    } else if (el.classList.contains('nav-page-btn')) {
      kind = 'tab';
    } else if (el.classList.contains('start-btn--neon-ghost')) {
      kind = 'secondary';
    } else if (
      el.classList.contains('start-btn--neon-primary') ||
      el.classList.contains('btn-primary') ||
      el.classList.contains('idlecraft-confirm__btn--ok') ||
      el.classList.contains('idlecraft-confirm__btn--cancel')
    ) {
      kind = 'primary';
    }

    playUiSound(kind);
  };
  root.addEventListener('click', handler, true);
  return () => root.removeEventListener('click', handler, true);
}

let audioPanelSync: (() => void) | null = null;

export function refreshAudioControlLabels(): void {
  audioPanelSync?.();
}

/** Audio controls (SFX / music / track). Mount inside ESC menu — not a floating dock. */
export function mountAudioPanel(host: HTMLElement): void {
  const dock = document.createElement('div');
  dock.className = 'audio-dock audio-dock--menu';
  dock.setAttribute('data-audio-skip', '');
  dock.setAttribute('aria-label', 'Sound and music');
  dock.innerHTML = `
    <span class="audio-dock-title">Audio</span>
    <div class="audio-dock-balance" data-audio-skip>
      <div class="audio-dock-balance__row">
        <label class="audio-dock-balance__label" for="audio-vol-music">Music level</label>
        <span class="audio-dock-balance__pct" data-audio-pct-music>${DEFAULT_MUSIC_VOL_PCT}%</span>
      </div>
      <input type="range" id="audio-vol-music" class="audio-dock-range" min="0" max="100" step="1" value="${DEFAULT_MUSIC_VOL_PCT}" data-audio-vol-music data-audio-skip aria-valuemin="0" aria-valuemax="100" />
      <div class="audio-dock-balance__row">
        <label class="audio-dock-balance__label" for="audio-vol-sfx">Effects level (master)</label>
        <span class="audio-dock-balance__pct" data-audio-pct-sfx>${DEFAULT_SFX_VOL_PCT}%</span>
      </div>
      <input type="range" id="audio-vol-sfx" class="audio-dock-range" min="0" max="200" step="1" value="${DEFAULT_SFX_VOL_PCT}" data-audio-vol-sfx data-audio-skip aria-valuemin="0" aria-valuemax="200" />
      <div class="audio-dock-balance__row">
        <label class="audio-dock-balance__label" for="audio-vol-harvest">Harvest sounds</label>
        <span class="audio-dock-balance__pct" data-audio-pct-harvest>${DEFAULT_HARVEST_VOL_PCT}%</span>
      </div>
      <input type="range" id="audio-vol-harvest" class="audio-dock-range" min="0" max="200" step="1" value="${DEFAULT_HARVEST_VOL_PCT}" data-audio-vol-harvest data-audio-skip aria-valuemin="0" aria-valuemax="200" />
      <div class="audio-dock-balance__row">
        <label class="audio-dock-balance__label" for="audio-vol-footstep">Footsteps</label>
        <span class="audio-dock-balance__pct" data-audio-pct-footstep>${DEFAULT_FOOTSTEP_VOL_PCT}%</span>
      </div>
      <input type="range" id="audio-vol-footstep" class="audio-dock-range" min="0" max="200" step="1" value="${DEFAULT_FOOTSTEP_VOL_PCT}" data-audio-vol-footstep data-audio-skip aria-valuemin="0" aria-valuemax="200" />
      <div class="audio-dock-balance__row">
        <label class="audio-dock-balance__label" for="audio-vol-jumpland">Jump &amp; landing</label>
        <span class="audio-dock-balance__pct" data-audio-pct-jumpland>${DEFAULT_JUMPLAND_VOL_PCT}%</span>
      </div>
      <input type="range" id="audio-vol-jumpland" class="audio-dock-range" min="0" max="200" step="1" value="${DEFAULT_JUMPLAND_VOL_PCT}" data-audio-vol-jumpland data-audio-skip aria-valuemin="0" aria-valuemax="200" />
      <p class="audio-dock-balance__hint">Music fader is softer at the low end (same 100% peak as before). Effects: 0–200%. Per-category sliders multiply on top of the master Effects level. Mute toggles still apply.</p>
    </div>
    <button type="button" class="audio-dock-btn" data-audio-sfx data-audio-skip title="Toggle UI sounds">SFX</button>
    <button type="button" class="audio-dock-btn" data-audio-amb data-audio-skip title="Toggle music">Music</button>
    <button type="button" class="audio-dock-btn" data-audio-next data-audio-skip title="Next track">Track</button>
    <span class="audio-dock-theme" data-audio-theme aria-live="polite"></span>
  `;

  const sfxBtn = dock.querySelector('[data-audio-sfx]') as HTMLButtonElement;
  const ambBtn = dock.querySelector('[data-audio-amb]') as HTMLButtonElement;
  const themeEl = dock.querySelector('[data-audio-theme]') as HTMLElement;
  const volMusicEl = dock.querySelector('[data-audio-vol-music]') as HTMLInputElement;
  const volSfxEl = dock.querySelector('[data-audio-vol-sfx]') as HTMLInputElement;
  const pctMusicEl = dock.querySelector('[data-audio-pct-music]') as HTMLElement;
  const pctSfxEl = dock.querySelector('[data-audio-pct-sfx]') as HTMLElement;
  const volHarvestEl = dock.querySelector('[data-audio-vol-harvest]') as HTMLInputElement;
  const volFootstepEl = dock.querySelector('[data-audio-vol-footstep]') as HTMLInputElement;
  const volJumpLandEl = dock.querySelector('[data-audio-vol-jumpland]') as HTMLInputElement;
  const pctHarvestEl = dock.querySelector('[data-audio-pct-harvest]') as HTMLElement;
  const pctFootstepEl = dock.querySelector('[data-audio-pct-footstep]') as HTMLElement;
  const pctJumpLandEl = dock.querySelector('[data-audio-pct-jumpland]') as HTMLElement;

  function syncVolumeUi(): void {
    volMusicEl.value = String(musicVolumePct);
    volSfxEl.value = String(sfxVolumePct);
    pctMusicEl.textContent = `${musicVolumePct}%`;
    pctSfxEl.textContent = `${sfxVolumePct}%`;
    volMusicEl.setAttribute('aria-valuenow', String(musicVolumePct));
    volSfxEl.setAttribute('aria-valuenow', String(sfxVolumePct));
    volHarvestEl.value = String(harvestVolumePct);
    volFootstepEl.value = String(footstepVolumePct);
    volJumpLandEl.value = String(jumpLandVolumePct);
    pctHarvestEl.textContent = `${harvestVolumePct}%`;
    pctFootstepEl.textContent = `${footstepVolumePct}%`;
    pctJumpLandEl.textContent = `${jumpLandVolumePct}%`;
    volHarvestEl.setAttribute('aria-valuenow', String(harvestVolumePct));
    volFootstepEl.setAttribute('aria-valuenow', String(footstepVolumePct));
    volJumpLandEl.setAttribute('aria-valuenow', String(jumpLandVolumePct));
  }

  function syncLabels(): void {
    themeEl.textContent = currentTrackLabel();
    sfxBtn.classList.toggle('audio-dock-btn--off', !sfxEnabled);
    ambBtn.classList.toggle('audio-dock-btn--off', !musicEnabled);
    syncVolumeUi();
  }
  syncLabels();
  audioPanelSync = syncLabels;

  volMusicEl.addEventListener('input', () => {
    musicVolumePct = Math.max(0, Math.min(100, parseInt(volMusicEl.value, 10) || 0));
    writeVolumePct(LS_VOL_MUSIC, musicVolumePct, 100);
    pctMusicEl.textContent = `${musicVolumePct}%`;
    volMusicEl.setAttribute('aria-valuenow', String(musicVolumePct));
    syncMusicGain();
  });

  volSfxEl.addEventListener('input', () => {
    sfxVolumePct = Math.max(0, Math.min(SFX_VOL_SLIDER_MAX, parseInt(volSfxEl.value, 10) || 0));
    writeVolumePct(LS_VOL_SFX, sfxVolumePct, SFX_VOL_SLIDER_MAX);
    pctSfxEl.textContent = `${sfxVolumePct}%`;
    volSfxEl.setAttribute('aria-valuenow', String(sfxVolumePct));
    syncSfxGain();
  });

  /* Per-category sliders — each scales its own sub-bus on top of the master Effects
   * level. Persists to localStorage so the player's mix survives reload. */
  volHarvestEl.addEventListener('input', () => {
    harvestVolumePct = Math.max(0, Math.min(SFX_VOL_SLIDER_MAX, parseInt(volHarvestEl.value, 10) || 0));
    writeVolumePct(LS_VOL_HARVEST, harvestVolumePct, SFX_VOL_SLIDER_MAX);
    pctHarvestEl.textContent = `${harvestVolumePct}%`;
    volHarvestEl.setAttribute('aria-valuenow', String(harvestVolumePct));
    syncCategorySfxGains();
  });

  volFootstepEl.addEventListener('input', () => {
    footstepVolumePct = Math.max(0, Math.min(SFX_VOL_SLIDER_MAX, parseInt(volFootstepEl.value, 10) || 0));
    writeVolumePct(LS_VOL_FOOTSTEP, footstepVolumePct, SFX_VOL_SLIDER_MAX);
    pctFootstepEl.textContent = `${footstepVolumePct}%`;
    volFootstepEl.setAttribute('aria-valuenow', String(footstepVolumePct));
    syncCategorySfxGains();
  });

  volJumpLandEl.addEventListener('input', () => {
    jumpLandVolumePct = Math.max(0, Math.min(SFX_VOL_SLIDER_MAX, parseInt(volJumpLandEl.value, 10) || 0));
    writeVolumePct(LS_VOL_JUMPLAND, jumpLandVolumePct, SFX_VOL_SLIDER_MAX);
    pctJumpLandEl.textContent = `${jumpLandVolumePct}%`;
    volJumpLandEl.setAttribute('aria-valuenow', String(jumpLandVolumePct));
    syncCategorySfxGains();
  });

  sfxBtn.addEventListener('click', () => {
    void (async () => {
      await resumeAndStartMusic();
      sfxEnabled = !sfxEnabled;
      writeBool(LS_SFX, sfxEnabled);
      syncSfxGain();
      syncLabels();
    })();
  });

  ambBtn.addEventListener('click', () => {
    void (async () => {
      await resumeAndStartMusic();
      musicEnabled = !musicEnabled;
      writeBool(LS_MUSIC, musicEnabled);
      syncMusicGain();
      if (musicTransport) {
        if (musicEnabled) musicTransport.start();
        else musicTransport.stop();
      }
      syncLabels();
    })();
  });

  dock.querySelector('[data-audio-next]')?.addEventListener('click', () => {
    void (async () => {
      await resumeAndStartMusic();
      const n = musicTransport?.getTrackCount() ?? AMBIENT_THEME_NAMES.length;
      musicThemeIndex = (musicThemeIndex + 1) % n;
      writeTheme(musicThemeIndex);
      musicTransport?.setTheme(musicThemeIndex);
      /* Use shell presence — must match expedition audio, not title flow. */
      const inExpedition = document.querySelector('#app-shell') != null;
      if (inExpedition) musicTransport?.refreshTheme();
      syncLabels();
    })();
  });

  host.appendChild(dock);
}
