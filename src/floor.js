// Restaurant floor plan (pure logic, no DOM).
//
// Coordinates are logical units on a W x H floor. A table's (x, y) is its
// centre. Every chair belongs to exactly one table and stores its position
// RELATIVE to that table (dx, dy): moving or rotating a table therefore
// carries its chairs along, while a chair itself can be placed anywhere and
// stays linked ("coupled") to its table.
(function (root) {
  'use strict';

  const W = 1200, H = 800, GRID = 10, CHAIR = 34;
  const SIZES = { square: { w: 90, h: 90 }, round: { w: 100, h: 100 }, long: { w: 190, h: 84 } };
  const SHAPES = Object.keys(SIZES);
  const DEFAULT_CHAIRS = {
    square: [[0, -75], [75, 0], [0, 75], [-75, 0]],
    round: [[0, -80], [80, 0], [0, 80], [-80, 0]],
    long: [[-60, -72], [0, -72], [60, -72], [-60, 72], [0, 72], [60, 72]],
  };
  const MAX_NAME = 20;

  function fail(code, message, params) {
    const e = new Error(message);
    e.code = code;
    e.params = params || {};
    return e;
  }

  const clamp = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
  const snap = v => Math.round(v / GRID) * GRID;
  const rid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function emptyFloor(areaName = 'Main') {
    return { areas: [{ id: 'a1', name: areaName }], tables: [], chairs: [] };
  }

  function tableSize(t) {
    const s = SIZES[t.shape] || SIZES.square;
    return (t.rot || 0) % 180 ? { w: s.h, h: s.w } : { w: s.w, h: s.h };
  }

  // Rotate an offset 90° clockwise `times` times (screen coordinates, y down).
  function rot90([dx, dy], times) {
    let p = [dx, dy];
    for (let i = 0; i < ((times % 4) + 4) % 4; i++) p = [-p[1], p[0]];
    return p;
  }

  const tableById = (floor, id) => floor.tables.find(t => t.id === id);
  const chairsOf = (floor, tableId) => floor.chairs.filter(c => c.tableId === tableId);
  const seats = (floor, tableId) => chairsOf(floor, tableId).length;

  function chairPos(floor, chair) {
    const t = tableById(floor, chair.tableId);
    return { x: t.x + chair.dx, y: t.y + chair.dy };
  }

  // Keep a table AND all its chairs inside the floor.
  function clampTable(table, chairs, x, y) {
    const { w, h } = tableSize(table);
    let left = -w / 2, right = w / 2, top = -h / 2, bottom = h / 2;
    for (const c of chairs) {
      left = Math.min(left, c.dx - CHAIR / 2); right = Math.max(right, c.dx + CHAIR / 2);
      top = Math.min(top, c.dy - CHAIR / 2); bottom = Math.max(bottom, c.dy + CHAIR / 2);
    }
    return { x: clamp(snap(x), -left, W - right), y: clamp(snap(y), -top, H - bottom) };
  }

  function nextTableName(floor) {
    const n = floor.tables.reduce((m, t) => Math.max(m, Number((/^T(\d+)$/i.exec(t.name) || [])[1]) || 0), 0);
    return 'T' + (n + 1);
  }

  function checkName(floor, name, exceptId) {
    const nm = String(name || '').trim();
    if (!nm || nm.length > MAX_NAME) throw fail('tableName', 'Table name must be 1-20 characters');
    if (floor.tables.some(t => t.id !== exceptId && t.name.toLowerCase() === nm.toLowerCase())) throw fail('tableDup', 'A table with that name exists', { name: nm });
    return nm;
  }

  function addTable(floor, { id = rid('t'), areaId, shape = 'square', x = W / 2, y = H / 2, name, chairIds = [], withChairs = true } = {}) {
    if (!SHAPES.includes(shape)) throw fail('tableShape', 'Unknown table shape');
    if (!floor.areas.some(a => a.id === areaId)) throw fail('area', 'Unknown area');
    const table = { id, areaId, name: checkName(floor, name || nextTableName(floor)), shape, x: 0, y: 0, rot: 0 };
    const chairs = withChairs ? DEFAULT_CHAIRS[shape].map(([dx, dy], i) => ({ id: chairIds[i] || `${id}-c${i + 1}`, tableId: id, dx, dy })) : [];
    Object.assign(table, clampTable(table, chairs, x, y));
    return { ...floor, tables: [...floor.tables, table], chairs: [...floor.chairs, ...chairs] };
  }

  function moveTable(floor, id, x, y) {
    const t = tableById(floor, id);
    if (!t) throw fail('noTable', 'Table not found');
    const pos = clampTable(t, chairsOf(floor, id), x, y);
    return { ...floor, tables: floor.tables.map(o => (o.id === id ? { ...o, ...pos } : o)) };
  }

  // Rotate a table 90° clockwise; its chairs turn with it.
  function rotateTable(floor, id) {
    const t = tableById(floor, id);
    if (!t) throw fail('noTable', 'Table not found');
    const rotated = { ...t, rot: ((t.rot || 0) + 90) % 360 };
    const chairs = floor.chairs.map(c => {
      if (c.tableId !== id) return c;
      const [dx, dy] = rot90([c.dx, c.dy], 1);
      return { ...c, dx, dy };
    });
    const pos = clampTable(rotated, chairs.filter(c => c.tableId === id), t.x, t.y);
    return { ...floor, chairs, tables: floor.tables.map(o => (o.id === id ? { ...rotated, ...pos } : o)) };
  }

  function nearestTable(floor, areaId, x, y) {
    let best = null;
    for (const t of floor.tables) {
      if (t.areaId !== areaId) continue;
      const dist = Math.hypot(t.x - x, t.y - y);
      if (!best || dist < best.dist) best = { table: t, dist };
    }
    return best;
  }

  // Put a chair at an absolute position. It couples to `tableId` when given,
  // otherwise to the nearest table in the area. Existing chairs keep their id.
  function placeChair(floor, { id = rid('c'), areaId, x, y, tableId } = {}) {
    const existing = floor.chairs.find(c => c.id === id);
    const area = areaId || (existing && tableById(floor, existing.tableId).areaId);
    let table;
    if (tableId) {
      table = tableById(floor, tableId);
      if (!table || (area && table.areaId !== area)) throw fail('noTable', 'Table not found');
    } else {
      const near = nearestTable(floor, area, x, y);
      if (!near) throw fail('needTable', 'Add a table first');
      table = near.table;
    }
    const ax = clamp(snap(x), CHAIR / 2, W - CHAIR / 2);
    const ay = clamp(snap(y), CHAIR / 2, H - CHAIR / 2);
    const chair = { id, tableId: table.id, dx: ax - table.x, dy: ay - table.y };
    const chairs = existing ? floor.chairs.map(c => (c.id === id ? chair : c)) : [...floor.chairs, chair];
    return { ...floor, chairs };
  }

  // Link a chair to another table without moving it.
  function relinkChair(floor, chairId, tableId) {
    const c = floor.chairs.find(o => o.id === chairId);
    if (!c) throw fail('noChair', 'Chair not found');
    const p = chairPos(floor, c);
    return placeChair(floor, { id: chairId, x: p.x, y: p.y, tableId, areaId: tableById(floor, tableId) && tableById(floor, tableId).areaId });
  }

  // Add a chair to a table at the first free spot around it.
  function addChairToTable(floor, tableId, id = rid('c')) {
    const t = tableById(floor, tableId);
    if (!t) throw fail('noTable', 'Table not found');
    const mine = chairsOf(floor, tableId);
    const free = ([dx, dy]) => {
      const ax = t.x + dx, ay = t.y + dy;
      if (ax < CHAIR / 2 || ay < CHAIR / 2 || ax > W - CHAIR / 2 || ay > H - CHAIR / 2) return false;
      return mine.every(c => Math.hypot(c.dx - dx, c.dy - dy) >= CHAIR);
    };
    const { w, h } = tableSize(t);
    const candidates = DEFAULT_CHAIRS[t.shape].map(p => rot90(p, (t.rot || 0) / 90));
    for (let r = Math.max(w, h) / 2 + 35; r < 400; r += 40) {
      for (let a = 0; a < 360; a += 30) candidates.push([snap(r * Math.sin((a * Math.PI) / 180)), snap(-r * Math.cos((a * Math.PI) / 180))]);
    }
    const spot = candidates.find(free);
    if (!spot) throw fail('noSpace', 'No free space for another chair');
    return { ...floor, chairs: [...floor.chairs, { id, tableId, dx: spot[0], dy: spot[1] }] };
  }

  function deleteChair(floor, id) {
    return { ...floor, chairs: floor.chairs.filter(c => c.id !== id) };
  }

  function deleteTable(floor, id) {
    return { ...floor, tables: floor.tables.filter(t => t.id !== id), chairs: floor.chairs.filter(c => c.tableId !== id) };
  }

  function renameTable(floor, id, name) {
    const nm = checkName(floor, name, id);
    return { ...floor, tables: floor.tables.map(t => (t.id === id ? { ...t, name: nm } : t)) };
  }

  function setTableShape(floor, id, shape) {
    if (!SHAPES.includes(shape)) throw fail('tableShape', 'Unknown table shape');
    const t = tableById(floor, id);
    if (!t) throw fail('noTable', 'Table not found');
    const next = { ...t, shape };
    const pos = clampTable(next, chairsOf(floor, id), t.x, t.y);
    return { ...floor, tables: floor.tables.map(o => (o.id === id ? { ...next, ...pos } : o)) };
  }

  function addArea(floor, { id = rid('a'), name }) {
    const nm = String(name || '').trim();
    if (!nm || nm.length > MAX_NAME) throw fail('areaName', 'Area name must be 1-20 characters');
    return { ...floor, areas: [...floor.areas, { id, name: nm }] };
  }

  function renameArea(floor, id, name) {
    const nm = String(name || '').trim();
    if (!nm || nm.length > MAX_NAME) throw fail('areaName', 'Area name must be 1-20 characters');
    return { ...floor, areas: floor.areas.map(a => (a.id === id ? { ...a, name: nm } : a)) };
  }

  function deleteArea(floor, id) {
    if (floor.areas.length <= 1) throw fail('lastArea', 'At least one area is required');
    if (floor.tables.some(t => t.areaId === id)) throw fail('areaNotEmpty', 'Move or delete the tables in this area first');
    return { ...floor, areas: floor.areas.filter(a => a.id !== id) };
  }

  // Repair data loaded from storage/backups: every chair must have a table,
  // every table an area, and there must be at least one area.
  function normalizeFloor(f) {
    const ok = f && Array.isArray(f.areas) && Array.isArray(f.tables) && Array.isArray(f.chairs);
    const floor = ok ? f : emptyFloor();
    const areas = floor.areas.filter(a => a && a.id && a.name);
    if (!areas.length) areas.push({ id: 'a1', name: 'Main' });
    const tables = floor.tables.filter(t => t && t.id && SHAPES.includes(t.shape))
      .map(t => ({ ...t, areaId: areas.some(a => a.id === t.areaId) ? t.areaId : areas[0].id, rot: (t.rot || 0) % 360 }));
    const chairs = floor.chairs.filter(c => c && tables.some(t => t.id === c.tableId) && Number.isFinite(c.dx) && Number.isFinite(c.dy));
    return { areas, tables, chairs };
  }

  // A starter layout so a new restaurant is not empty.
  function sampleFloor(areaName = 'Main') {
    let f = emptyFloor(areaName);
    const spots = [['square', 180, 170], ['square', 420, 170], ['square', 660, 170], ['round', 180, 470], ['round', 420, 470], ['long', 800, 470]];
    spots.forEach(([shape, x, y], i) => { f = addTable(f, { id: 't' + (i + 1), areaId: 'a1', shape, x, y }); });
    return f;
  }

  const api = {
    W, H, GRID, CHAIR, SIZES, SHAPES, DEFAULT_CHAIRS,
    emptyFloor, sampleFloor, normalizeFloor, tableSize, chairsOf, seats, chairPos, nearestTable, nextTableName,
    addTable, moveTable, rotateTable, placeChair, relinkChair, addChairToTable, deleteChair, deleteTable,
    renameTable, setTableShape, addArea, renameArea, deleteArea,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Floor = api;
})(this);
