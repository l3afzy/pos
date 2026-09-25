// Exposes a small, fixed API to the page. The page never gets Node access.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('posNative', {
  info: () => ipcRenderer.invoke('pos:info'),
  listPrinters: () => ipcRenderer.invoke('pos:printers'),
  setConfig: partial => ipcRenderer.invoke('pos:setConfig', partial),
  print: (kind, html) => ipcRenderer.invoke('pos:print', { kind, html }),
  openDrawer: () => ipcRenderer.invoke('pos:openDrawer'),
  saveBackup: (name, content) => ipcRenderer.invoke('pos:saveBackup', { name, content }),
  chooseBackupDir: () => ipcRenderer.invoke('pos:chooseBackupDir'),
  openBackupDir: () => ipcRenderer.invoke('pos:openBackupDir'),
  quit: () => ipcRenderer.invoke('pos:quit'),
});
