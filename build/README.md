# IDLE-CRAFT — Windows icons

## Files

| File | Role |
|------|------|
| **`icon-source.png`** | Master PBR-style artwork (high-res square). Replace to rebrand; then rebuild `.ico`. |
| **`icon.ico`** | Multi-size Windows icon for **`idle-craft.exe`**, **Setup.exe**, taskbar, and desktop shortcut. **Generated — do not edit by hand.** |

## Regenerate `icon.ico`

From the project root:

```bash
npm run build:icons
```

`npm run make` runs this automatically after the Vite build.

Requires `build/icon-source.png` to exist.

## Why the window looked right but the desktop shortcut did not

1. **Title bar** — `BrowserWindow` loads `build/icon.ico` (works even when the project path has spaces).

2. **`idle-craft.exe`** — `postPackage` runs **Node `rcedit`** to embed your icon (works with spaces in paths).

3. **Desktop / Start menu shortcuts** — Squirrel points them at **`Update.exe`**, not `idle-craft.exe`. **electron-winstaller** patches **`Squirrel.exe`** (shipped as `Update.exe`) using its **bundled `rcedit.exe`**. That subprocess **breaks if `setupIcon` contains spaces** (e.g. project folder `idle deck`). Then **Update.exe** keeps the default icon → wrong desktop icon.

**Fix:** Before `electron-forge make`, **`scripts/stage-squirrel-icon.cjs`** copies `build/icon.ico` to **`%TEMP%\idlecraft-squirrel-icon.ico`** (usually no spaces). **`forge.config.cjs`** sets **`setupIcon`** to that path (same pattern as SpaceBell using a simple `./assets/icon.ico` path when the repo lives in a folder **without** spaces).

### Programs & Features icon (`iconUrl`)

**electron-winstaller** defaults **`iconUrl`** in the NuSpec to **GitHub’s `electron.ico`** (wrong branding in Settings → Apps). To override, set an **HTTPS** URL to your `.ico` before `make`:

```powershell
$env:IDLECRAFT_ICON_URL = "https://your.cdn.example/idle-craft.ico"
npm run make
```

### If the desktop icon is still stale

Clear the icon cache: **Win+R** → `ie4uinit.exe -ClearIconCache` → Enter, or remove the old shortcut and reinstall.

## Uninstall before reinstalling (new icon / clean test)

Close the game, then in **PowerShell**:

```powershell
& "$env:LOCALAPPDATA\idlecraft\Update.exe" --uninstall
```

Or: **Windows Settings → Apps → IDLE-CRAFT → Uninstall**.

Then run the new **`IDLE-CRAFT-Setup.exe`** from `out\make\squirrel.windows\x64\`.

## SpaceBell parity

SpaceBell keeps sources under `assets/icon` (`.png` / `.ico`). This project uses **`build/icon`** (Forge `packagerConfig.icon: ./build/icon`) so the packaged app and Squirrel pick up the same artwork.
