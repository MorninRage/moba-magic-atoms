/**
 * IDLE-CRAFT — Electron main (Windows desktop + Squirrel installer).
 * Squirrel passes special args on install/update; quit immediately so Setup.exe can finish.
 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

if (require('electron-squirrel-startup')) {
  app.quit();
}

const isDev = !app.isPackaged;

function windowIconPath() {
  const ico = path.join(__dirname, '..', 'build', 'icon.ico');
  if (fs.existsSync(ico)) return ico;
  return undefined;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    icon: windowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const indexHtml = path.join(__dirname, '..', 'dist', 'index.html');
  win.loadFile(indexHtml).catch((err) => {
    console.error('Failed to load game:', err);
  });
  win.once('ready-to-show', () => win.show());
  /* Dock to the game window — 'detach' can leave a stray DevTools window (with its own close box) on another monitor. */
  if (isDev && process.env.ELECTRON_OPEN_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'right' });
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
