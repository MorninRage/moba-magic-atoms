export type MusicManifestEntry = {
  url: string;
  title: string;
  /** Same sources as `scripts/download-default-music.mjs` — used if local `url` 404s (e.g. before `npm install`). */
  fallbackUrl?: string;
};

/** Expedition ambient playlist (rotates 2–5 min slices or full short loops). */
export const MUSIC_FILE_MANIFEST: MusicManifestEntry[] = [
  {
    url: '/audio/music/track-01.ogg',
    title: 'Neon driftway',
    fallbackUrl: 'https://opengameart.org/sites/default/files/busy_cyberworld.ogg',
  },
  {
    url: '/audio/music/track-02.ogg',
    title: 'Vault haze',
    fallbackUrl: 'https://opengameart.org/sites/default/files/Ambient-Loop-isaiah658_0.ogg',
  },
  {
    url: '/audio/music/track-03.mp3',
    title: 'Ranger horizon',
    fallbackUrl:
      'https://opengameart.org/sites/default/files/space_ranger_seamless_loop_preview_no_watermark_0.mp3',
  },
  {
    url: '/audio/music/track-04.mp3',
    title: 'Clear orbit',
    fallbackUrl: 'https://opengameart.org/sites/default/files/outer_space_2.mp3',
  },
  {
    url: '/audio/music/track-05.mp3',
    title: 'Quiet haul',
    fallbackUrl: 'https://opengameart.org/sites/default/files/gravity_turn_calm_6.mp3',
  },
  {
    url: '/audio/music/track-06.mp3',
    title: 'Pine wind',
    fallbackUrl: 'https://opengameart.org/sites/default/files/Forest_Ambience.mp3',
  },
  {
    url: '/audio/music/track-07.mp3',
    title: 'Bright wire',
    fallbackUrl: 'https://opengameart.org/sites/default/files/virtual_rush_loop_0.mp3',
  },
];

/**
 * Title / menu bed — not in expedition playlist.
 *
 * Currently using "Quiet haul" (track-05.mp3 / gravity_turn_calm_6) — slow, calm,
 * minor-key ambient. Replaces the previous "Insistent" (menu-01.ogg) which was
 * tenser and felt mismatched with the dark-fantasy intro. If you change this,
 * also re-check `docs/CUTSCENE_PIPELINE.md` §9 which references this slot.
 */
export const MENU_MUSIC_ENTRY: MusicManifestEntry = {
  url: '/audio/music/track-05.mp3',
  title: 'Quiet haul',
  fallbackUrl: 'https://opengameart.org/sites/default/files/gravity_turn_calm_6.mp3',
};

/**
 * PvE combat only — **not** in {@link MUSIC_FILE_MANIFEST}. Crossfades over expedition audio;
 * uses its own looping stem (`loop: true` in `FilePlaylistMusic`), not the expedition slice timer.
 */
export const BATTLE_MUSIC_ENTRY: MusicManifestEntry = {
  url: '/audio/music/battle-01.ogg',
  title: 'Last stand',
  /** CC0 orchestral drama — skrjablin / OpenGameArt (“The Final Battle”). */
  fallbackUrl: 'https://opengameart.org/sites/default/files/the_final_battle.ogg',
};

export const MUSIC_LIBRARY_LINKS: { label: string; href: string }[] = [
  { label: 'OpenGameArt (CC0 / CC BY filter)', href: 'https://opengameart.org/' },
  { label: 'Free Music Archive', href: 'https://freemusicarchive.org/' },
  { label: 'Incompetech (attribution required)', href: 'https://incompetech.com/music/' },
];

export const SHIPPED_MUSIC_CREDITS: { line: string; href?: string }[] = [
  {
    line: '“Insistent: background loop” by yd — CC0 (OpenGameArt).',
    href: 'https://opengameart.org/content/insistent-background-loop',
  },
  {
    line: '“Sci-fi City — Busy cyberworld” ambient loop — CC0 (OpenGameArt).',
    href: 'https://opengameart.org/content/scifi-city-ambient-loop',
  },
  {
    line: '“Ambient Relaxing Loop” by isaiah658 — CC0 (OpenGameArt).',
    href: 'https://opengameart.org/content/ambient-relaxing-loop',
  },
  {
    line: '“Music loop, strong, downtempo” (preview) — CC0 (OpenGameArt).',
    href: 'https://opengameart.org/content/music-loop-strong-downtempo-seamless',
  },
  {
    line: '“Outer Space Loop” by wipics — CC0 (OpenGameArt).',
    href: 'https://opengameart.org/content/outer-space-loop',
  },
  {
    line: '“Gravity Turn” (calm) by Vitalezzz — CC0 (OpenGameArt).',
    href: 'https://opengameart.org/content/gravity-turn',
  },
  {
    line: '“Forest Ambience” by TinyWorlds — CC0 (OpenGameArt).',
    href: 'https://opengameart.org/content/forest-ambience',
  },
  {
    line: '“Virtual Rush” (loop) by Vitalezzz — CC0 (OpenGameArt).',
    href: 'https://opengameart.org/content/virtual-rush',
  },
  {
    line: '“The Final Battle” (orchestral) by skrjablin — CC0 (OpenGameArt); credit appreciated.',
    href: 'https://opengameart.org/content/the-final-battle',
  },
];
