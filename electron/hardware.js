// Hardware helpers for the desktop app (main process). Kept free of Electron
// imports so they can be unit-tested with plain Node.
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');

// ESC p m t1 t2: pulse drawer pin 2 (m=0) for 25*2ms on, 250*2ms off.
// Works with Epson-compatible (ESC/POS) receipt printers, which drive the
// drawer through their RJ11/RJ12 "DK" port.
const DRAWER_KICK = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);

const DRAWER_MODES = ['none', 'network', 'share'];

function defaultConfig(documentsDir) {
  return {
    receiptPrinter: '', reportPrinter: '', autoPrint: true,
    drawer: { mode: 'none', host: '', port: 9100, share: '' },
    kiosk: false, autostart: false,
    autoBackup: true, backupDir: path.join(documentsDir, 'POS Backups'),
  };
}

const isHost = h => typeof h === 'string' && h.length <= 253 && /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(h);
const isShare = s => typeof s === 'string' && /^[A-Za-z0-9 _.-]{1,80}$/.test(s);
const str = (v, max = 260) => (typeof v === 'string' ? v.slice(0, max) : '');

// Merge an untrusted partial config (from the renderer) into the current one.
function mergeConfig(current, input) {
  const out = JSON.parse(JSON.stringify(current));
  if (!input || typeof input !== 'object') return out;
  if ('receiptPrinter' in input) out.receiptPrinter = str(input.receiptPrinter);
  if ('reportPrinter' in input) out.reportPrinter = str(input.reportPrinter);
  for (const k of ['autoPrint', 'kiosk', 'autostart', 'autoBackup']) if (k in input) out[k] = !!input[k];
  if (input.drawer && typeof input.drawer === 'object') {
    const d = input.drawer;
    if (DRAWER_MODES.includes(d.mode)) out.drawer.mode = d.mode;
    if ('host' in d) out.drawer.host = str(d.host, 253).trim();
    if ('port' in d) {
      const p = Number(d.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Invalid port');
      out.drawer.port = p;
    }
    if ('share' in d) out.drawer.share = str(d.share, 80).trim();
    if (out.drawer.mode === 'network' && !isHost(out.drawer.host)) throw new Error('Invalid printer address');
    if (out.drawer.mode === 'share' && !isShare(out.drawer.share)) throw new Error('Invalid printer share name');
  }
  return out;
}

// Send raw bytes to a network receipt printer (port 9100 "RAW/JetDirect").
function sendRawNetwork(host, port, data, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    if (!isHost(host)) return reject(new Error('Invalid printer address'));
    const sock = net.createConnection({ host, port });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('Printer did not respond')); }, timeoutMs);
    sock.on('error', e => { clearTimeout(timer); reject(e); });
    sock.on('connect', () => sock.end(data));
    sock.on('close', hadError => { clearTimeout(timer); if (!hadError) resolve(); });
  });
}

// Windows: send raw bytes to a shared printer (\\localhost\ShareName), the
// same as `copy /b file \\localhost\ShareName`.
function sendRawShare(share, data) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Printer shares are only supported on Windows'));
  if (!isShare(share)) return Promise.reject(new Error('Invalid printer share name'));
  return fs.promises.writeFile(`\\\\localhost\\${share}`, data);
}

function openDrawer(cfg) {
  const d = cfg.drawer || {};
  if (d.mode === 'network') return sendRawNetwork(d.host, d.port || 9100, DRAWER_KICK);
  if (d.mode === 'share') return sendRawShare(d.share, DRAWER_KICK);
  return Promise.reject(new Error('No cash drawer configured'));
}

// Backup file names come from the renderer: allow only a plain .json name.
function safeBackupName(name) {
  const base = path.basename(String(name || ''));
  if (!/^[A-Za-z0-9._-]{1,120}\.json$/.test(base) || base.startsWith('.')) throw new Error('Invalid backup file name');
  return base;
}

// Write atomically: a crash mid-write never leaves a half-written backup.
async function writeBackup(dir, name, content) {
  if (typeof content !== 'string' || !content.length) throw new Error('Empty backup');
  JSON.parse(content); // must be valid JSON
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, safeBackupName(name));
  const tmp = file + '.tmp';
  await fs.promises.writeFile(tmp, content, 'utf8');
  await fs.promises.rename(tmp, file);
  return file;
}

module.exports = { DRAWER_KICK, DRAWER_MODES, defaultConfig, mergeConfig, sendRawNetwork, sendRawShare, openDrawer, safeBackupName, writeBackup };
