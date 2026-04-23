/**
 * Electron Forge — Windows Squirrel installer (same stack as SpaceBell / C:\Docs\ELECTRON_PACKAGING.md).
 *
 * Desktop shortcuts target Squirrel's Update.exe. electron-winstaller runs vendor rcedit.exe with
 * `setupIcon`; paths with spaces (e.g. project folder "idle deck") break that step → Electron icon.
 * Fix: `npm run make` runs scripts/stage-squirrel-icon.cjs first — copies .ico to %TEMP% (no spaces).
 *
 * NuGet metadata still wants iconUrl (Programs & Features). Override default GitHub electron.ico via
 * IDLECRAFT_ICON_URL (https URL to your .ico) when you have hosting; optional.
 */
const path = require('path');
const os = require('os');

/** Must match scripts/stage-squirrel-icon.cjs destination basename. */
const SQUIRREL_SETUP_ICON = path.join(os.tmpdir(), 'idlecraft-squirrel-icon.ico');

module.exports = {
  packagerConfig: {
    executableName: 'moba-magic-atoms',
    icon: path.resolve(__dirname, 'build', 'icon'),
    asar: true,
    win32metadata: {
      CompanyName: 'MOBA — Magic Orbiting Brandished Atoms',
      FileDescription: 'MOBA — Magic Orbiting Brandished Atoms',
      ProductName: 'MOBA — Magic Orbiting Brandished Atoms',
      InternalName: 'moba-magic-atoms',
      OriginalFilename: 'moba-magic-atoms.exe',
    },
    ignore: [
      /^\/src($|\/)/,
      /^\/\.git($|\/)/,
      /^\/out($|\/)/,
      /^\/\.cursor($|\/)/,
      /^\/node_modules\/\.cache($|\/)/,
      /^\/build\/icon-source\.png$/,
      /^\/build\/README\.md$/,
      /^\/scripts\/uninstall-squirrel\.ps1$/,
    ],
  },
  rebuildConfig: {},
  hooks: {
    /**
     * Forge order: package → preMake → makers (Squirrel).
     * Staging here guarantees %TEMP% icon exists even when someone runs `electron-forge make`
     * without `npm run make` (skips scripts/stage-squirrel-icon.cjs).
     */
    preMake: async () => {
      const fs = require('fs');
      const src = path.join(__dirname, 'build', 'icon.ico');
      if (!fs.existsSync(src)) {
        throw new Error(
          'Missing build/icon.ico. Run: npm run build:icons (or npm run make from package.json).',
        );
      }
      fs.copyFileSync(src, SQUIRREL_SETUP_ICON);
      console.log('[forge] preMake: Squirrel setupIcon staged at', SQUIRREL_SETUP_ICON);
    },
    postPackage: async (_forgeConfig, { platform, outputPaths }) => {
      if (platform !== 'win32') return;
      const fs = require('fs');
      const rcedit = require('rcedit');
      const iconPath = path.resolve(__dirname, 'build', 'icon.ico');
      if (!fs.existsSync(iconPath)) {
        console.warn('[forge] postPackage: missing', iconPath, '— run npm run build:icons');
        return;
      }
      for (const dir of outputPaths) {
        const exe = path.join(dir, 'idle-craft.exe');
        if (fs.existsSync(exe)) {
          await rcedit(exe, { icon: iconPath });
          console.log('[forge] Embedded icon resource in', exe);
        }
      }
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'idlecraft',
        authors: 'IDLE-CRAFT',
        description: 'IDLE-CRAFT — idle crafting / deck survival (EmpireEngine)',
        exe: 'idle-craft.exe',
        setupExe: 'IDLE-CRAFT-Setup.exe',
        noMsi: true,
        /* Local path without spaces — see stage-squirrel-icon.cjs */
        setupIcon: SQUIRREL_SETUP_ICON,
        ...(process.env.IDLECRAFT_ICON_URL
          ? { iconUrl: process.env.IDLECRAFT_ICON_URL }
          : {}),
      },
    },
  ],
};
