/**
 * Preload — extend with safe IPC if the game needs Node APIs later.
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('idleCraftElectron', {
  platform: process.platform,
});
