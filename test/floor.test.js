const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/floor.js');

const base = () => F.addTable(F.emptyFloor(), { id: 't1', areaId: 'a1', shape: 'square', x: 300, y: 300 });
const abs = (f, id) => F.chairPos(f, f.chairs.find(c => c.id === id));

test('new table gets default chairs coupled to it', () => {
  const f = base();
  assert.equal(f.tables[0].name, 'T1');
  assert.equal(F.seats(f, 't1'), 4);
  assert.deepEqual(abs(f, 't1-c1'), { x: 300, y: 225 });
  const f2 = F.addTable(f, { id: 't2', areaId: 'a1', shape: 'long', x: 700, y: 300 });
  assert.equal(f2.tables[1].name, 'T2');
  assert.equal(F.seats(f2, 't2'), 6);
  assert.throws(() => F.addTable(f, { areaId: 'nope' }), /area/i);
  assert.throws(() => F.addTable(f, { areaId: 'a1', shape: 'hexagon' }));
});

test('moving a table carries its chairs (synced)', () => {
  const f = F.moveTable(base(), 't1', 503, 404); // snaps to grid
  assert.deepEqual([f.tables[0].x, f.tables[0].y], [500, 400]);
  assert.deepEqual(abs(f, 't1-c1'), { x: 500, y: 325 });
  assert.deepEqual(abs(f, 't1-c2'), { x: 575, y: 400 });
});

test('table + chairs are kept inside the floor', () => {
  const f = F.moveTable(base(), 't1', -500, 5000);
  const t = f.tables[0];
  for (const c of F.chairsOf(f, 't1')) {
    const p = F.chairPos(f, c);
    assert.ok(p.x - F.CHAIR / 2 >= 0 && p.x + F.CHAIR / 2 <= F.W, 'x inside');
    assert.ok(p.y - F.CHAIR / 2 >= 0 && p.y + F.CHAIR / 2 <= F.H, 'y inside');
  }
  assert.ok(t.x > 0 && t.y < F.H);
});

test('a chair can be placed anywhere but stays coupled to a table', () => {
  let f = F.addTable(base(), { id: 't2', areaId: 'a1', shape: 'round', x: 900, y: 300 });
  // drag chair far away, nearer to T2 -> couples to T2
  f = F.placeChair(f, { id: 't1-c2', x: 820, y: 300 });
  assert.equal(f.chairs.find(c => c.id === 't1-c2').tableId, 't2');
  assert.equal(F.seats(f, 't1'), 3);
  assert.equal(F.seats(f, 't2'), 5);
  // moving T2 now moves that chair too
  const before = abs(f, 't1-c2');
  f = F.moveTable(f, 't2', 900, 500);
  assert.deepEqual(abs(f, 't1-c2'), { x: before.x, y: before.y + 200 });
  // explicit link keeps the chair where it is
  const here = abs(f, 't1-c2');
  f = F.relinkChair(f, 't1-c2', 't1');
  assert.equal(f.chairs.find(c => c.id === 't1-c2').tableId, 't1');
  assert.deepEqual(abs(f, 't1-c2'), here);
  // new chair from the toolbox couples to the nearest table
  f = F.placeChair(f, { id: 'cx', areaId: 'a1', x: 310, y: 420 });
  assert.equal(f.chairs.find(c => c.id === 'cx').tableId, 't1');
  // no table in the area -> refused
  assert.throws(() => F.placeChair(F.emptyFloor(), { areaId: 'a1', x: 10, y: 10 }), /table first/);
});

test('rotating a table turns its chairs with it', () => {
  let f = F.addTable(F.emptyFloor(), { id: 'L', areaId: 'a1', shape: 'long', x: 600, y: 400 });
  const c1 = f.chairs.find(c => c.id === 'L-c1');
  assert.deepEqual([c1.dx, c1.dy], [-60, -72]);
  f = F.rotateTable(f, 'L');
  assert.equal(f.tables[0].rot, 90);
  assert.deepEqual(F.tableSize(f.tables[0]), { w: 84, h: 190 });
  const r1 = f.chairs.find(c => c.id === 'L-c1');
  assert.deepEqual([r1.dx, r1.dy], [72, -60]);
  for (let i = 0; i < 3; i++) f = F.rotateTable(f, 'L');
  assert.equal(f.tables[0].rot, 0);
  assert.deepEqual([f.chairs[0].dx, f.chairs[0].dy], [-60, -72]);
});

test('add chair finds a free spot; delete table removes its chairs', () => {
  let f = base();
  f = F.addChairToTable(f, 't1', 'extra');
  const e = f.chairs.find(c => c.id === 'extra');
  for (const c of F.chairsOf(f, 't1')) if (c.id !== 'extra') assert.ok(Math.hypot(c.dx - e.dx, c.dy - e.dy) >= F.CHAIR);
  f = F.deleteChair(f, 'extra');
  assert.equal(F.seats(f, 't1'), 4);
  f = F.deleteTable(f, 't1');
  assert.equal(f.tables.length, 0);
  assert.equal(f.chairs.length, 0);
});

test('names and areas are validated', () => {
  let f = F.addTable(base(), { id: 't2', areaId: 'a1', x: 800, y: 300 });
  assert.throws(() => F.renameTable(f, 't2', 't1'), /exists/);
  assert.throws(() => F.renameTable(f, 't2', '  '));
  f = F.renameTable(f, 't2', 'VIP 1');
  assert.equal(f.tables[1].name, 'VIP 1');
  f = F.addArea(f, { id: 'a2', name: 'Terrace' });
  assert.throws(() => F.deleteArea(f, 'a1'), /tables/);
  f = F.deleteArea(f, 'a2');
  assert.throws(() => F.deleteArea(f, 'a1'));
  assert.equal(F.nextTableName(f), 'T2');
});

test('normalizeFloor repairs broken data', () => {
  const f = F.normalizeFloor({ areas: [], tables: [{ id: 'x', shape: 'round', areaId: 'zz', x: 1, y: 1 }, { id: 'bad', shape: 'hex' }],
    chairs: [{ id: 'c1', tableId: 'x', dx: 1, dy: 2 }, { id: 'c2', tableId: 'gone', dx: 0, dy: 0 }] });
  assert.equal(f.areas.length, 1);
  assert.deepEqual(f.tables.map(t => [t.id, t.areaId]), [['x', 'a1']]);
  assert.deepEqual(f.chairs.map(c => c.id), ['c1']);
  assert.deepEqual(F.normalizeFloor(null), F.emptyFloor());
  assert.equal(F.sampleFloor().tables.length, 6);
});
