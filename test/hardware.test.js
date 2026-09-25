const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('../electron/hardware.js');

test('drawer kick is the ESC/POS pulse command', () => {
  assert.deepEqual([...H.DRAWER_KICK], [0x1b, 0x70, 0x00, 0x19, 0xfa]);
});

test('mergeConfig validates untrusted input', () => {
  const base = H.defaultConfig('/docs');
  assert.equal(base.backupDir, path.join('/docs', 'POS Backups'));
  const c = H.mergeConfig(base, { autoPrint: 0, kiosk: 'yes', drawer: { mode: 'network', host: '192.168.1.50', port: '9100' }, backupDir: '/etc', evil: 1 });
  assert.equal(c.autoPrint, false);
  assert.equal(c.kiosk, true);
  assert.deepEqual(c.drawer, { mode: 'network', host: '192.168.1.50', port: 9100, share: '' });
  assert.equal(c.backupDir, base.backupDir, 'backupDir is not settable from the renderer');
  assert.equal('evil' in c, false);
  assert.throws(() => H.mergeConfig(base, { drawer: { mode: 'network', host: 'bad host;rm' } }));
  assert.throws(() => H.mergeConfig(base, { drawer: { mode: 'network', host: 'p1', port: 70000 } }));
  assert.throws(() => H.mergeConfig(base, { drawer: { mode: 'share', share: '..\\\\x' } }));
  assert.equal(H.mergeConfig(base, { drawer: { mode: 'bogus' } }).drawer.mode, 'none');
});

test('network drawer kick sends the bytes to port 9100-style printers', async () => {
  const got = [];
  const server = net.createServer(s => s.on('data', d => got.push(...d)));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await H.openDrawer({ drawer: { mode: 'network', host: '127.0.0.1', port } });
  await new Promise(r => setTimeout(r, 50));
  server.close();
  assert.deepEqual(got, [...H.DRAWER_KICK]);
  await assert.rejects(H.openDrawer({ drawer: { mode: 'none' } }));
  await assert.rejects(H.sendRawNetwork('127.0.0.1', 1, H.DRAWER_KICK, 1000));
});

test('backups: safe names only, atomic write, valid JSON', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posbk-'));
  assert.equal(H.safeBackupName('../../ok-1.json'), 'ok-1.json'); // path parts are stripped
  assert.throws(() => H.safeBackupName('x.exe'));
  assert.throws(() => H.safeBackupName('.hidden.json'));
  const file = await H.writeBackup(dir, 'pos-backup-2026-09-25.json', '{"a":1}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
  assert.equal(fs.existsSync(file + '.tmp'), false);
  await assert.rejects(H.writeBackup(dir, 'b.json', 'not json'));
});
