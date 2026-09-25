// Desktop app (Electron main process): window, silent printing, cash drawer,
// automatic backups, kiosk mode and start-at-login.
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const H = require('./hardware');

const ROOT = path.join(__dirname, '..');
const PRINT_PDF_DIR = process.env.POS_PRINT_PDF_DIR || ''; // testing: print to PDF files instead of a printer

if (process.env.POS_USER_DATA) app.setPath('userData', process.env.POS_USER_DATA);

// One running copy per computer: two copies could issue the same document number.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let config = null;
const configFile = () => path.join(app.getPath('userData'), 'pos-config.json');

function loadConfig() {
  const defaults = H.defaultConfig(app.getPath('documents'));
  try {
    const saved = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    const merged = H.mergeConfig(defaults, saved);
    if (typeof saved.backupDir === 'string' && path.isAbsolute(saved.backupDir)) merged.backupDir = saved.backupDir;
    return merged;
  } catch (e) {
    return defaults;
  }
}

function saveConfig() {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  const tmp = configFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, configFile());
}

function applyAutostart() {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: !!config.autostart });
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1366, height: 900, minWidth: 900, minHeight: 600,
    title: 'POS Terminal', backgroundColor: '#eef1f5', show: false, autoHideMenuBar: true,
    kiosk: !!config.kiosk,
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
    },
  });
  win.loadFile(path.join(ROOT, 'index.html'));
  win.once('ready-to-show', () => { win.show(); if (!config.kiosk) win.maximize(); });
  // Never open other windows or navigate away from the app.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) e.preventDefault(); });
  win.on('closed', () => { win = null; });
}

// Render a receipt or A4 report in a hidden window and print it.
async function printHTML(kind, html) {
  const w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  try {
    await w.loadFile(path.join(__dirname, 'print.html'));
    await w.webContents.executeJavaScript(`(() => {
      document.body.classList.toggle('receipt-mode', ${kind === 'receipt'});
      document.getElementById('report-print').innerHTML = ${JSON.stringify(html)};
      return document.fonts.ready.then(() => true);
    })()`);
    if (PRINT_PDF_DIR) {
      const pdf = await w.webContents.printToPDF({
        printBackground: true, margins: { marginType: 'none' },
        pageSize: kind === 'receipt' ? { width: 3.15, height: 11 } : 'A4',
      });
      fs.mkdirSync(PRINT_PDF_DIR, { recursive: true });
      const file = path.join(PRINT_PDF_DIR, `${kind}-${Date.now()}.pdf`);
      fs.writeFileSync(file, pdf);
      return { ok: true, file };
    }
    const printers = await w.webContents.getPrintersAsync();
    const wanted = kind === 'receipt' ? config.receiptPrinter : config.reportPrinter;
    const known = !!wanted && printers.some(p => p.name === wanted);
    const opts = {
      // Receipts go straight to the chosen receipt printer; reports always
      // show the print dialog (page setup, copies).
      silent: kind === 'receipt' && known,
      printBackground: true,
      margins: { marginType: kind === 'receipt' ? 'none' : 'default' },
    };
    if (known) opts.deviceName = wanted;
    return await new Promise(resolve => {
      w.webContents.print(opts, (ok, reason) => resolve({ ok, error: ok ? null : reason || 'Print failed' }));
    });
  } finally {
    if (!w.isDestroyed()) w.destroy();
  }
}

const str = v => (typeof v === 'string' ? v : '');

function registerIPC() {
  ipcMain.handle('pos:info', () => ({ version: app.getVersion(), platform: process.platform, config }));

  ipcMain.handle('pos:printers', async e => {
    const list = await e.sender.getPrintersAsync();
    return list.map(p => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
  });

  ipcMain.handle('pos:setConfig', (e, partial) => {
    const next = H.mergeConfig(config, partial);
    const kioskChanged = next.kiosk !== config.kiosk;
    config = next;
    saveConfig();
    applyAutostart();
    if (kioskChanged && win) win.setKiosk(config.kiosk);
    return config;
  });

  ipcMain.handle('pos:print', async (e, payload) => {
    const kind = payload && payload.kind === 'report' ? 'report' : 'receipt';
    const html = str(payload && payload.html);
    if (!html || html.length > 5e6) return { ok: false, error: 'Nothing to print' };
    try { return await printHTML(kind, html); } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('pos:openDrawer', async () => {
    try { await H.openDrawer(config); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('pos:saveBackup', async (e, payload) => {
    try {
      const file = await H.writeBackup(config.backupDir, str(payload && payload.name), str(payload && payload.content));
      return { ok: true, file };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('pos:chooseBackupDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: config.backupDir });
    if (r.canceled || !r.filePaths[0]) return config;
    config.backupDir = r.filePaths[0];
    saveConfig();
    return config;
  });

  ipcMain.handle('pos:openBackupDir', async () => {
    fs.mkdirSync(config.backupDir, { recursive: true });
    return shell.openPath(config.backupDir);
  });

  ipcMain.handle('pos:quit', () => { app.quit(); });
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  config = loadConfig();
  applyAutostart();
  // The app needs no browser permissions (camera, location, ...).
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'persistent-storage'));
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  } else {
    Menu.setApplicationMenu(null);
  }
  registerIPC();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
