/**
 * Copy icon to %TEMP% with a fixed filename (no spaces).
 * electron-winstaller's bundled rcedit.exe often fails when setupIcon path contains
 * spaces — desktop shortcuts point at Update.exe, which gets that icon.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const src = path.join(__dirname, '..', 'build', 'icon.ico');
const dest = path.join(os.tmpdir(), 'idlecraft-squirrel-icon.ico');

if (!fs.existsSync(src)) {
  console.error('Missing', src, '— run npm run build:icons first.');
  process.exit(1);
}
fs.copyFileSync(src, dest);
console.log('[stage-squirrel-icon] Copied to', dest);
