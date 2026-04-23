/**
 * Build Windows multi-size favicon.ico from build/icon-source.png (PBR artwork).
 * Uses sharp for crisp downscales; png-to-ico packs sizes Squirrel / Explorer expect.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico');

const root = path.join(__dirname, '..');
const src = path.join(root, 'build', 'icon-source.png');
const out = path.join(root, 'build', 'icon.ico');

const SIZES = [256, 128, 64, 48, 32, 16];

async function main() {
  if (!fs.existsSync(src)) {
    console.error('Missing', src, '— add icon-source.png to build/ first.');
    process.exit(1);
  }
  const bufs = await Promise.all(
    SIZES.map((s) =>
      sharp(src)
        .resize(s, s, { kernel: sharp.kernel.lanczos3, fit: 'cover' })
        .png({ compressionLevel: 9 })
        .toBuffer(),
    ),
  );
  const ico = await pngToIco(bufs);
  fs.writeFileSync(out, ico);
  console.log('Wrote', out, `(${SIZES.join(', ')} px)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
