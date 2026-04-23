import type { MusicManifestEntry } from './musicManifest';
import { resolvePublicAudioUrl } from './resolvePublicUrl';
import { yieldAnimationFrame } from '../util/mainThreadYield';

export interface GameMusicTransport {
  start(): void;
  stop(): void;
  setTheme(t: number): void;
  refreshTheme(): void;
  getTheme(): number;
  getTrackCount(): number;
  getTrackTitle(index: number): string;
  setMainMenuMode(menu: boolean): void;
  getDisplayLabel(): string;
  /** PvE combat bed — fades over the expedition playlist; no-op if no battle file / title flow. */
  setBattleMode(on: boolean): void;
}

type DecodedTrack = { title: string; buffer: AudioBuffer };
type LoadedTrack = { title: string; buffer: AudioBuffer; levelTrim: number };

const CROSSFADE_SEC = 4;
const MIN_SEGMENT_SEC = 120;
const MAX_SEGMENT_SEC = 300;

function segmentDurationSec(buffer: AudioBuffer): number {
  const d = buffer.duration;
  if (!Number.isFinite(d) || d <= 0) return MIN_SEGMENT_SEC;
  if (d < MIN_SEGMENT_SEC) return d;
  const cap = Math.min(MAX_SEGMENT_SEC, d);
  if (cap <= MIN_SEGMENT_SEC) return cap;
  return MIN_SEGMENT_SEC + Math.random() * (cap - MIN_SEGMENT_SEC);
}

function fadeLeadSec(segmentSec: number): number {
  return Math.min(CROSSFADE_SEC, Math.max(0.25, segmentSec - 0.05));
}

/** Whole-buffer RMS (all channels) — for loudness matching between expedition tracks. */
function bufferRms(buf: AudioBuffer): number {
  let acc = 0;
  let n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i]!;
      acc += x * x;
    }
    n += ch.length;
  }
  return Math.sqrt(acc / Math.max(1, n));
}

function medianRms(values: number[]): number {
  const v = values.filter((x) => x > 1e-9).sort((a, b) => a - b);
  if (v.length === 0) return 0.08;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

function trimFromRef(rms: number, ref: number): number {
  return Math.max(0.4, Math.min(2.4, ref / Math.max(1e-6, rms)));
}

type Chain = {
  src: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  trim: GainNode;
  gain: GainNode;
};

/**
 * Menu bed + rotating game playlist: each game piece plays for a 2–5 minute slice on long beds,
 * or until the file ends on short loops, then crossfades to the next track. Menu uses its own loop * and crossfades when entering or leaving the title flow.
 */
export class FilePlaylistMusic implements GameMusicTransport {
  private readonly gameTracks: LoadedTrack[];
  private readonly menuTrack: LoadedTrack;
  private mainMenu = true;
  private gameIndex = 0;
  private running = false;
  private advanceTimer: number | null = null;
   private menuChain: Chain | null = null;
  private gameChain: Chain | null = null;
  private battleChain: Chain | null = null;
  private readonly battleTrack: LoadedTrack | null;
  private inBattle = false;
  /** When leaving expedition for battle: resume same track from this buffer offset for this long (wall-clock slice). */
  private expeditionResumeAfterBattle: { offsetSec: number; remainingSec: number } | null = null;
  /** Current expedition slice length and context time at slice start (for computing resume offset). */
  private gameSegmentSliceSec = 0;
  private gameSegmentStartedAtCtx = 0;
  /** Sources fading out after a crossfade — must be hard-stopped on the next transition or they stack. */
  private fadeOutChains: Chain[] = [];
  private fadeTimeouts: number[] = [];
  private onGameIndexChanged: ((index: number) => void) | null = null;

  constructor(
    private readonly ac: AudioContext,
    private readonly out: AudioNode,
    game: LoadedTrack[],
    menu: LoadedTrack | null,
    battle: LoadedTrack | null,
  ) {
    this.gameTracks = game;
    /* Never reuse a game buffer for menu — same PCM sounds “stuck” on one track. Use a short silent loop if menu file failed. */
    this.menuTrack = menu ?? {
      title: 'Frontier desk',
      buffer: FilePlaylistMusic.makeSilentLoopBuffer(ac, 2),
      levelTrim: 1,
    };
    this.battleTrack = battle;
  }

  /** Keep UI / localStorage in sync when the playlist auto-advances. */
  setGameIndexChangeHandler(handler: ((index: number) => void) | null): void {
    this.onGameIndexChanged = handler;
  }

  private static makeSilentLoopBuffer(ac: AudioContext, durationSec: number): AudioBuffer {
    const sr = ac.sampleRate;
    const frames = Math.max(1, Math.floor(sr * durationSec));
    return ac.createBuffer(2, frames, sr);
  }

  static async tryCreate(
    ac: AudioContext,
    out: AudioNode,
    gameManifest: MusicManifestEntry[],
    menuEntry: MusicManifestEntry | null,
    battleEntry: MusicManifestEntry | null,
  ): Promise<FilePlaylistMusic | null> {
    const raw: DecodedTrack[] = [];
    for (let i = 0; i < gameManifest.length; i++) {
      const m = gameManifest[i]!;
      const t = await FilePlaylistMusic.fetchDecode(ac, m);
      if (t) raw.push(t);
      /* Let GPU / dock warm / input run between decodes — avoids one giant task. */
      if ((i + 1) % 2 === 0 && i + 1 < gameManifest.length) await yieldAnimationFrame();
    }
    if (raw.length === 0) return null;
    if (raw.length < gameManifest.length && import.meta.env.DEV) {
      console.warn(
        `[music] Expedition: ${raw.length}/${gameManifest.length} tracks decoded. Missing files under public/audio/music/? Run: node scripts/download-default-music.mjs — then resume audio (or refresh).`,
      );
    }
    const gameRms: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      gameRms.push(bufferRms(raw[i]!.buffer));
      if ((i + 1) % 2 === 0 && i + 1 < raw.length) await yieldAnimationFrame();
    }
    const ref = medianRms(gameRms);
    const loaded: LoadedTrack[] = raw.map((t, i) => ({
      title: t.title,
      buffer: t.buffer,
      levelTrim: trimFromRef(gameRms[i]!, ref),
    }));
    await yieldAnimationFrame();
    /* === 2026-04-21 Preload Round 4 — dedupe menu / battle decode ===
     *
     * If the menu bed (or battle stem) reuses a URL already loaded for the
     * expedition playlist, skip the second fetch + decode pass. As of today
     * `MENU_MUSIC_ENTRY` points at `track-05.mp3` (also entry 5 of the
     * expedition manifest) → without this we did TWO fetches of a 6.9 MB
     * file + TWO `decodeAudioData` passes + TWO `bufferRms` walks on the
     * first user gesture, blocking the audio-context unlock for hundreds
     * of milliseconds extra. Battle currently doesn't overlap, but check
     * symmetrically so future manifest changes can't reintroduce the leak.
     *
     * Reuse rule: same buffer + recomputed `levelTrim` from the existing
     * RMS (cheaper than re-running `bufferRms`); only the display title
     * differs so "now playing" labels remain correct. */
    const findDupe = (url: string): LoadedTrack | null => {
      const i = gameManifest.findIndex((m) => m.url === url);
      return i >= 0 && loaded[i] ? loaded[i]! : null;
    };
    let menu: LoadedTrack | null = null;
    if (menuEntry) {
      const dupe = findDupe(menuEntry.url);
      if (dupe) {
        menu = { title: menuEntry.title, buffer: dupe.buffer, levelTrim: dupe.levelTrim };
      } else {
        const m = await FilePlaylistMusic.fetchDecode(ac, menuEntry);
        if (m) {
          menu = {
            title: m.title,
            buffer: m.buffer,
            levelTrim: trimFromRef(bufferRms(m.buffer), ref),
          };
        }
      }
    }
    let battle: LoadedTrack | null = null;
    if (battleEntry) {
      const dupe = findDupe(battleEntry.url);
      if (dupe) {
        battle = { title: battleEntry.title, buffer: dupe.buffer, levelTrim: dupe.levelTrim };
      } else {
        const b = await FilePlaylistMusic.fetchDecode(ac, battleEntry);
        if (b) {
          battle = {
            title: b.title,
            buffer: b.buffer,
            levelTrim: trimFromRef(bufferRms(b.buffer), ref),
          };
        }
      }
    }
    if (!battle && battleEntry && import.meta.env.DEV) {
      console.warn(
        '[music] Battle stem failed to load — PvE will keep expedition music. Check public/audio/music/battle-01.ogg (run download-default-music) or fallbackUrl.',
      );
    }
    return new FilePlaylistMusic(ac, out, loaded, menu, battle);
  }

  private static async fetchDecode(ac: AudioContext, entry: MusicManifestEntry): Promise<DecodedTrack | null> {
    const urls = [resolvePublicAudioUrl(entry.url)];
    if (entry.fallbackUrl) urls.push(entry.fallbackUrl);
    for (const fetchUrl of urls) {
      try {
        let res = await fetch(fetchUrl);
        if (!res.ok) {
          res = await fetch(fetchUrl, { cache: 'reload' });
        }
        if (!res.ok) continue;
        const ab = await res.arrayBuffer();
        const buf = await ac.decodeAudioData(ab.slice(0));
        return { title: entry.title, buffer: buf };
      } catch {
        /* try next URL */
      }
    }
    return null;
  }

  getTrackCount(): number {
    return this.gameTracks.length;
  }

  getTrackTitle(index: number): string {
    const n = this.gameTracks.length;
    const i = ((index % n) + n) % n;
    return this.gameTracks[i]?.title ?? '';
  }

  getTheme(): number {
    return this.gameIndex;
  }

  setTheme(t: number): void {
    const n = this.gameTracks.length;
    this.gameIndex = ((t % n) + n) % n;
  }

  getDisplayLabel(): string {
    if (this.mainMenu) return this.menuTrack.title;
    if (this.inBattle && this.battleTrack) return this.battleTrack.title;
    return this.getTrackTitle(this.gameIndex);
  }

  setBattleMode(on: boolean): void {
    if (this.mainMenu || !this.battleTrack) return;
    if (on === this.inBattle) return;
    this.inBattle = on;
    if (!this.running) return;
    if (on) this.enterBattleMusic();
    else this.leaveBattleMusic();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.mainMenu) {
      this.startMenuVoice(true);
    } else {
      this.beginGamePlaylist(true);
      if (this.inBattle && this.battleTrack) this.enterBattleMusic();
    }
  }

  stop(): void {
    this.running = false;
    this.inBattle = false;
    this.expeditionResumeAfterBattle = null;
    this.gameSegmentSliceSec = 0;
    this.gameSegmentStartedAtCtx = 0;
    this.clearAdvance();
    this.flushAllFadeOuts();
    this.teardownBattle();
    this.teardownMenu();
    this.teardownGame();
  }

  refreshTheme(): void {
    if (!this.running || this.mainMenu || this.inBattle) return;
    this.swapGameTrack(false);
  }

  setMainMenuMode(menu: boolean): void {
    if (menu === this.mainMenu) return;
    this.mainMenu = menu;
    if (menu) this.inBattle = false;
    if (!this.running) return;
    if (menu) this.crossfadeToMenu();
    else this.crossfadeToGame();
  }

  private clearAdvance(): void {
    if (this.advanceTimer != null) {
      clearTimeout(this.advanceTimer);
      this.advanceTimer = null;
    }
  }

  /**
   * @param playDurationSec when not looping: play this many seconds from buffer (after offset). Omitted = play to buffer end.
   * @param bufferOffsetSec start position inside the PCM buffer (expedition resume after battle).
   */
  private makeChain(
    buffer: AudioBuffer,
    loop: boolean,
    playDurationSec?: number,
    bufferOffsetSec = 0,
    levelTrim = 1,
  ): Chain {
    const src = this.ac.createBufferSource();
    src.buffer = buffer;
    src.loop = loop;
    const f = this.ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 11800;
    f.Q.value = 0.25;
    const trim = this.ac.createGain();
    trim.gain.value = levelTrim;
    const g = this.ac.createGain();
    g.gain.value = 0;
    src.connect(f);
    f.connect(trim);
    trim.connect(g);
    g.connect(this.out);
    const t0 = this.ac.currentTime;
    const dur = buffer.duration;
    if (!Number.isFinite(dur) || dur <= 0) {
      src.start(t0);
      return { src, filter: f, trim, gain: g };
    }
    const off = Math.max(0, Math.min(dur - 0.001, bufferOffsetSec));

    if (loop) {
      if (off > 0.001) {
        src.start(t0, off);
      } else {
        src.start(t0);
      }
    } else if (playDurationSec != null && Number.isFinite(playDurationSec)) {
      const len = Math.min(playDurationSec, Math.max(0.04, dur - off));
      src.start(t0, off, len);
    } else {
      src.start(t0, off);
    }
    return { src, filter: f, trim, gain: g };
  }

  private armExpeditionSegment(sliceWallClockSec: number): void {
    this.gameSegmentSliceSec = sliceWallClockSec;
    this.gameSegmentStartedAtCtx = this.ac.currentTime;
  }

  private teardownChain(c: Chain | null): void {
    if (!c) return;
    try {
      c.src.stop();
    } catch {
      /* */
    }
    c.src.disconnect();
    c.filter.disconnect();
    c.trim.disconnect();
    c.gain.disconnect();
  }

  private teardownMenu(): void {
    this.teardownChain(this.menuChain);
    this.menuChain = null;
  }

  private teardownGame(): void {
    this.teardownChain(this.gameChain);
    this.gameChain = null;
  }

  private teardownBattle(): void {
    this.teardownChain(this.battleChain);
    this.battleChain = null;
  }

  private ramp(c: Chain, from: number, to: number, dur: number): void {
    const now = this.ac.currentTime;
    c.gain.gain.cancelScheduledValues(now);
    c.gain.gain.setValueAtTime(from, now);
    c.gain.gain.linearRampToValueAtTime(to, now + dur);
  }

  private scheduleFadeOutDispose(ch: Chain, delayMs: number): void {
    this.fadeOutChains.push(ch);
    const tid = window.setTimeout(() => {
      const i = this.fadeOutChains.indexOf(ch);
      if (i >= 0) this.fadeOutChains.splice(i, 1);
      this.teardownChain(ch);
      const j = this.fadeTimeouts.indexOf(tid);
      if (j >= 0) this.fadeTimeouts.splice(j, 1);
    }, delayMs);
    this.fadeTimeouts.push(tid);
  }

  private flushAllFadeOuts(): void {
    for (const tid of this.fadeTimeouts) {
      clearTimeout(tid);
    }
    this.fadeTimeouts = [];
    for (const ch of this.fadeOutChains) {
      this.teardownChain(ch);
    }
    this.fadeOutChains = [];
  }

  private startMenuVoice(instant: boolean): void {
    this.flushAllFadeOuts();
    this.clearAdvance();
    this.inBattle = false;
    this.expeditionResumeAfterBattle = null;
    this.gameSegmentSliceSec = 0;
    this.teardownBattle();
    this.teardownGame();
    this.teardownMenu();
    const ch = this.makeChain(this.menuTrack.buffer, true, undefined, 0, this.menuTrack.levelTrim);
    this.menuChain = ch;
    if (instant) {
      ch.gain.gain.value = 1;
    } else {
      this.ramp(ch, 0, 1, 0.05);
    }
  }

  private beginGamePlaylist(instant: boolean): void {
    this.flushAllFadeOuts();
    this.clearAdvance();
    this.expeditionResumeAfterBattle = null;
    this.teardownBattle();
    this.teardownMenu();
    this.teardownGame();
    const tr = this.gameTracks[this.gameIndex];
    if (!tr) return;
    const seg = segmentDurationSec(tr.buffer);
    const ch = this.makeChain(tr.buffer, false, seg, 0, tr.levelTrim);
    this.gameChain = ch;
    this.armExpeditionSegment(seg);
    if (instant) ch.gain.gain.value = 1;
    else this.ramp(ch, 0, 1, CROSSFADE_SEC);
    this.scheduleGameAdvance(seg);
  }

  private scheduleGameAdvance(segmentSec: number): void {
    this.clearAdvance();
    const lead = fadeLeadSec(segmentSec);
    const ms = Math.max(0, (segmentSec - lead) * 1000);
    this.advanceTimer = window.setTimeout(() => {
      this.advanceTimer = null;
      if (!this.running || this.mainMenu || this.inBattle) return;
      this.advancePlaylistAndCrossfade();
    }, ms);
  }

  /** Next track in rotation (timer). */
  private advancePlaylistAndCrossfade(): void {
    const n = this.gameTracks.length;
    this.gameIndex = (this.gameIndex + 1) % n;
    this.onGameIndexChanged?.(this.gameIndex);
    this.swapGameTrack(true);
  }

  /**
   * Replace game voice, optionally crossfading from the previous chain.
   * @param fromPlaylist true when advancing playlist (previous chain exists); false = user skip / theme change
   */
  private swapGameTrack(fromPlaylist: boolean): void {
    if (!this.running || this.mainMenu || this.inBattle) return;
    this.flushAllFadeOuts();
    this.clearAdvance();
    this.expeditionResumeAfterBattle = null;
    const prev = this.gameChain;
    const tr = this.gameTracks[this.gameIndex];
    if (!tr) return;
    const seg = segmentDurationSec(tr.buffer);
    const next = this.makeChain(tr.buffer, false, seg, 0, tr.levelTrim);
    this.gameChain = next;
    this.armExpeditionSegment(seg);
    const now = this.ac.currentTime;
    if (prev) {
      const pv = Math.max(0, Math.min(1, prev.gain.gain.value));
      this.ramp(prev, pv, 0, CROSSFADE_SEC);
      next.gain.gain.setValueAtTime(0, now);
      this.ramp(next, 0, 1, CROSSFADE_SEC);
      this.scheduleFadeOutDispose(prev, CROSSFADE_SEC * 1000 + 80);
    } else if (fromPlaylist) {
      next.gain.gain.value = 1;
    } else {
      this.ramp(next, 0, 1, CROSSFADE_SEC);
    }
    this.scheduleGameAdvance(seg);
  }

  private crossfadeToMenu(): void {
    this.flushAllFadeOuts();
    this.clearAdvance();
    this.inBattle = false;
    this.expeditionResumeAfterBattle = null;
    this.gameSegmentSliceSec = 0;
    const prevGame = this.gameChain;
    const prevBattle = this.battleChain;
    this.gameChain = null;
    this.battleChain = null;
    const prev = prevBattle ?? prevGame;
    const ch = this.makeChain(this.menuTrack.buffer, true, undefined, 0, this.menuTrack.levelTrim);
    this.menuChain = ch;
    const now = this.ac.currentTime;
    if (prev) {
      const pv = Math.max(0, Math.min(1, prev.gain.gain.value));
      this.ramp(prev, pv, 0, CROSSFADE_SEC);
      ch.gain.gain.setValueAtTime(0, now);
      this.ramp(ch, 0, 1, CROSSFADE_SEC);
      this.scheduleFadeOutDispose(prev, CROSSFADE_SEC * 1000 + 80);
    } else {
      this.ramp(ch, 0, 1, 0.05);
    }
  }

  private crossfadeToGame(): void {
    this.flushAllFadeOuts();
    this.clearAdvance();
    this.teardownBattle();
    this.inBattle = false;
    this.expeditionResumeAfterBattle = null;
    const prev = this.menuChain;
    this.menuChain = null;
    const tr = this.gameTracks[this.gameIndex]!;
    const seg = segmentDurationSec(tr.buffer);
    const ch = this.makeChain(tr.buffer, false, seg, 0, tr.levelTrim);
    this.gameChain = ch;
    this.armExpeditionSegment(seg);
    const now = this.ac.currentTime;
    if (prev) {
      const pv = Math.max(0, Math.min(1, prev.gain.gain.value));
      this.ramp(prev, pv, 0, CROSSFADE_SEC);
      ch.gain.gain.setValueAtTime(0, now);
      this.ramp(ch, 0, 1, CROSSFADE_SEC);
      this.scheduleFadeOutDispose(prev, CROSSFADE_SEC * 1000 + 80);
    } else {
      this.ramp(ch, 0, 1, 0.05);
    }
    this.scheduleGameAdvance(seg);
  }

  private enterBattleMusic(): void {
    if (!this.battleTrack || this.mainMenu) return;
    this.flushAllFadeOuts();
    this.clearAdvance();
    let resume: { offsetSec: number; remainingSec: number } | null = null;
    if (this.gameChain && this.gameSegmentSliceSec > 0.05) {
      const elapsed = this.ac.currentTime - this.gameSegmentStartedAtCtx;
      const off = Math.max(0, Math.min(this.gameSegmentSliceSec - 0.02, elapsed));
      const rem = Math.max(0.25, this.gameSegmentSliceSec - off);
      resume = { offsetSec: off, remainingSec: rem };
    }
    this.expeditionResumeAfterBattle = resume;
    const prev = this.gameChain;
    this.gameChain = null;
    const ch = this.makeChain(this.battleTrack.buffer, true, undefined, 0, this.battleTrack.levelTrim);
    this.battleChain = ch;
    const now = this.ac.currentTime;
    if (prev) {
      const pv = Math.max(0, Math.min(1, prev.gain.gain.value));
      this.ramp(prev, pv, 0, CROSSFADE_SEC);
      ch.gain.gain.setValueAtTime(0, now);
      this.ramp(ch, 0, 1, CROSSFADE_SEC);
      this.scheduleFadeOutDispose(prev, CROSSFADE_SEC * 1000 + 80);
    } else {
      ch.gain.gain.value = 1;
    }
  }

  private leaveBattleMusic(): void {
    if (!this.battleTrack) return;
    this.flushAllFadeOuts();
    const prev = this.battleChain;
    this.battleChain = null;
    const tr = this.gameTracks[this.gameIndex];
    if (!tr) return;
    const resume = this.expeditionResumeAfterBattle;
    this.expeditionResumeAfterBattle = null;
    const bufDur = tr.buffer.duration;
    let sliceSec: number;
    let offsetSec = 0;
    if (
      resume &&
      resume.remainingSec > 0.2 &&
      Number.isFinite(bufDur) &&
      resume.offsetSec < bufDur - 0.03
    ) {
      offsetSec = Math.max(0, Math.min(bufDur - 0.04, resume.offsetSec));
      sliceSec = Math.min(resume.remainingSec, Math.max(0.15, bufDur - offsetSec));
    } else {
      sliceSec = segmentDurationSec(tr.buffer);
    }
    const ch = this.makeChain(tr.buffer, false, sliceSec, offsetSec, tr.levelTrim);
    this.gameChain = ch;
    this.armExpeditionSegment(sliceSec);
    const now = this.ac.currentTime;
    if (prev) {
      const pv = Math.max(0, Math.min(1, prev.gain.gain.value));
      this.ramp(prev, pv, 0, CROSSFADE_SEC);
      ch.gain.gain.setValueAtTime(0, now);
      this.ramp(ch, 0, 1, CROSSFADE_SEC);
      this.scheduleFadeOutDispose(prev, CROSSFADE_SEC * 1000 + 80);
    } else {
      this.ramp(ch, 0, 1, 0.05);
    }
    this.scheduleGameAdvance(sliceSec);
  }
}
