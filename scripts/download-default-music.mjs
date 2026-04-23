/**
 * Fetches bundled CC0 / public-domain loops into public/audio/music/ (idempotent).
 * Run automatically via npm `prepare`; safe offline if files already exist.
 */
import { mkdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { get } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'public', 'audio', 'music');

const TRACKS = [
  {
    file: 'menu-01.ogg',
    url: 'https://opengameart.org/sites/default/files/Insistent.ogg',
    minBytes: 400_000,
  },
  {
    file: 'battle-01.ogg',
    url: 'https://opengameart.org/sites/default/files/the_final_battle.ogg',
    /* Force re-fetch if an older shorter battle file is present. */
    minBytes: 2_400_000,
  },
  {
    file: 'track-01.ogg',
    url: 'https://opengameart.org/sites/default/files/busy_cyberworld.ogg',
    minBytes: 100_000,
  },
  {
    file: 'track-02.ogg',
    url: 'https://opengameart.org/sites/default/files/Ambient-Loop-isaiah658_0.ogg',
    minBytes: 500_000,
  },
  {
    file: 'track-03.mp3',
    url: 'https://opengameart.org/sites/default/files/space_ranger_seamless_loop_preview_no_watermark_0.mp3',
    minBytes: 500_000,
  },
  {
    file: 'track-04.mp3',
    url: 'https://opengameart.org/sites/default/files/outer_space_2.mp3',
    minBytes: 1_200_000,
  },
  {
    file: 'track-05.mp3',
    url: 'https://opengameart.org/sites/default/files/gravity_turn_calm_6.mp3',
    minBytes: 3_500_000,
  },
  {
    file: 'track-06.mp3',
    url: 'https://opengameart.org/sites/default/files/Forest_Ambience.mp3',
    minBytes: 500_000,
  },
  {
    file: 'track-07.mp3',
    url: 'https://opengameart.org/sites/default/files/virtual_rush_loop_0.mp3',
    minBytes: 3_500_000,
  },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (!loc) {
          reject(new Error('Redirect without location'));
          return;
        }
        res.resume();
        download(new URL(loc, url).href, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const file = createWriteStream(dest);
      pipeline(res, file).then(resolve).catch(reject);
    });
    req.on('error', reject);
  });
}

async function needDownload(path, minBytes) {
  try {
    const s = await stat(path);
    return s.size < minBytes;
  } catch {
    return true;
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });
  for (const t of TRACKS) {
    const dest = join(outDir, t.file);
    if (!(await needDownload(dest, t.minBytes))) {
      console.log(`[music] skip (ok): ${t.file}`);
      continue;
    }
    console.log(`[music] fetch: ${t.file}`);
    await download(t.url, dest);
  }
  console.log('[music] done');
}

main().catch((e) => {
  console.warn('[music] warning:', e.message);
  process.exit(0);
});
