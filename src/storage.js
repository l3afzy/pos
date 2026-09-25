// Persistence. Uses IndexedDB (large quota, atomic multi-record writes) and
// falls back to localStorage when IndexedDB is unavailable.
//
// Layout: 'kv' store holds the small app state under key 'state';
// 'sales' (keyPath id) and 'journal' (keyPath seq) hold one record each, so a
// sale and its journal entry are written together in one transaction.
(function () {
  'use strict';
  const DB_NAME = 'pos';
  const DB_VERSION = 1;
  const LS = { state: 'pos-v4-state', sales: 'pos-v4-sales', journal: 'pos-v4-journal' };

  const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const done = tx => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    tx.onerror = () => reject(tx.error);
  });

  async function openIDB() {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('sales')) db.createObjectStore('sales', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('journal')) db.createObjectStore('journal', { keyPath: 'seq' });
    };
    const db = await req(open);
    return {
      kind: 'indexeddb',
      async load() {
        const tx = db.transaction(['kv', 'sales', 'journal'], 'readonly');
        const [state, sales, journal] = await Promise.all([
          req(tx.objectStore('kv').get('state')), req(tx.objectStore('sales').getAll()), req(tx.objectStore('journal').getAll()),
        ]);
        return state ? { state, sales, journal } : null;
      },
      // Writes state + changed sales + new journal entries atomically.
      async commit({ state, sales = [], journal = [] }) {
        const tx = db.transaction(['kv', 'sales', 'journal'], 'readwrite');
        tx.objectStore('kv').put(state, 'state');
        for (const s of sales) tx.objectStore('sales').put(s);
        for (const e of journal) tx.objectStore('journal').add(e); // add: never overwrite an entry
        await done(tx);
      },
      async replaceAll({ state, sales, journal }) {
        const tx = db.transaction(['kv', 'sales', 'journal'], 'readwrite');
        for (const n of ['kv', 'sales', 'journal']) tx.objectStore(n).clear();
        tx.objectStore('kv').put(state, 'state');
        for (const s of sales) tx.objectStore('sales').put(s);
        for (const e of journal) tx.objectStore('journal').add(e);
        await done(tx);
      },
    };
  }

  function openLocal() {
    const read = k => JSON.parse(localStorage.getItem(k));
    const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));
    return {
      kind: 'localstorage',
      async load() {
        const state = read(LS.state);
        return state ? { state, sales: read(LS.sales) || [], journal: read(LS.journal) || [] } : null;
      },
      async commit({ state, allSales, allJournal }) {
        write(LS.sales, allSales); write(LS.journal, allJournal); write(LS.state, state);
      },
      async replaceAll({ state, sales, journal }) {
        write(LS.sales, sales); write(LS.journal, journal); write(LS.state, state);
      },
    };
  }

  async function open() {
    try {
      if (window.indexedDB) return await openIDB();
    } catch (e) { /* fall back */ }
    return openLocal();
  }

  // Ask the browser not to evict our data under storage pressure.
  async function persist() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        if (await navigator.storage.persisted()) return true;
        return await navigator.storage.persist();
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  async function estimate() {
    try { if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate(); } catch (e) { /* ignore */ }
    return null;
  }

  // Legacy data saved by earlier versions in localStorage.
  function readLegacy() {
    const out = {};
    for (const [k, key] of [['v3', 'pos-data-v3'], ['v2', 'pos-data-v2'], ['v1', 'pos-data-v1']]) {
      try { const v = JSON.parse(localStorage.getItem(key)); if (v) out[k] = v; } catch (e) { /* ignore */ }
    }
    return out;
  }

  window.POSStorage = { open, persist, estimate, readLegacy };
})();
