/**
 * Encode the three full-screen UI background PNGs to WebP for ship.
 *
 * **Why:** The painted dark-fantasy backdrops (`start-hero-bg`, `game-shell-bg`,
 * `system-menu-bg`) total ~4.7 MB as PNG. WebP at quality 90 cuts them to
 * ~1.0–1.4 MB combined while staying visually indistinguishable on the
 * low-frequency painted brushwork they contain (no sharp edges, no text, no
 * fine detail that lossy codecs damage). See `LEARNINGS.md` for full diagnosis.
 *
 * **Idempotent:** Each output is regenerated only when the source PNG is
 * newer than the existing WebP (mtime comparison). Wired into both `prepare`
 * (post-install) and `build` (pre-Vite) so dev installs get the converted
 * files automatically and CI/Netlify always rebuilds them on the latest art.
 *
 * **Source-of-truth stays PNG.** The generated `.webp` files live next to the
 * sources in `assets/ui/` and are imported by `mountStartFlow.ts`,
 * `mountApp.ts`, `expeditionLoadingOverlay.ts`, and `systemMenu.ts`. The PNG
 * is the authoring format; WebP is the shipped artifact. If you ever need to
 * regenerate from scratch, delete the `.webp` files and rerun this script.
 */
import sharp from 'sharp';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(__dirname, '..', 'assets', 'ui');

/**
 * @type {Array<{ name: string; quality: number }>}
 *
 * `quality: 90` is the safe ceiling for painted/photographic art — visually
 * indistinguishable from the PNG source at typical display resolutions.
 * Lowering to 80 saves another ~30% but starts to show faint blocking on
 * smooth gradients; do not go below 85 without a side-by-side compare.
 *
 * `effort: 6` (set on the encoder below) is sharp's max compression effort:
 * slower encode, smaller file. Build-time cost is ~1–2 s per image — only
 * paid when a PNG is newer than its WebP, so steady-state builds are free.
 */
const IMAGES = [
  { name: 'start-hero-bg', quality: 90 },
  { name: 'game-shell-bg', quality: 90 },
  { name: 'system-menu-bg', quality: 90 },
];

async function fileMtime(path) {
  try {
    const s = await stat(path);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

async function fileSize(path) {
  try {
    const s = await stat(path);
    return s.size;
  } catch {
    return null;
  }
}

function fmtKB(bytes) {
  if (bytes == null) return '—';
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function encodeOne({ name, quality }) {
  const srcPng = join(assetsDir, `${name}.png`);
  const dstWebp = join(assetsDir, `${name}.webp`);

  const pngMtime = await fileMtime(srcPng);
  if (pngMtime == null) {
    console.warn(`[compress-hero-backgrounds] missing source: ${srcPng}`);
    return;
  }

  const webpMtime = await fileMtime(dstWebp);
  if (webpMtime != null && webpMtime >= pngMtime) {
    /* WebP is up-to-date with PNG source — nothing to do. */
    return;
  }

  await sharp(srcPng).webp({ quality, effort: 6 }).toFile(dstWebp);

  const before = await fileSize(srcPng);
  const after = await fileSize(dstWebp);
  const pct =
    before && after ? `${Math.round((1 - after / before) * 100)}% smaller` : '';
  console.log(
    `[compress-hero-backgrounds] ${name}.webp  (q${quality})  ${fmtKB(before)} → ${fmtKB(after)}  ${pct}`,
  );
}

async function main() {
  for (const img of IMAGES) {
    await encodeOne(img);
  }
}

main().catch((err) => {
  console.error('[compress-hero-backgrounds] failed:', err);
  process.exit(1);
});
