(function () {
  'use strict';
  const P = window.POS;
  const native = window.posNative || null; // present when running as the desktop app
  let hw = null;                           // desktop hardware config (per computer)
  const APP_NAME = 'POS Terminal';
  const APP_VERSION = '4.1';
  const LANG_KEY = 'pos-ui-lang';
  const IDLE_LOCK_MS = 5 * 60 * 1000;
  const MAX_PIN_TRIES = 5;
  const CLOCK_TOLERANCE_MS = 60 * 1000;
  const BACKUP_REMIND_DAYS = 7;
  const HEAD_OFFICE = 'สำนักงานใหญ่';
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  // ------------------------------------------------------------- regions ---
  const PRESETS = {
    TH: { country: 'TH', language: 'th', locale: 'th-TH', currency: 'THB', taxMode: 'inclusive', taxLabel: 'VAT', taxRateBp: 700,
      cashDenoms: [2000, 5000, 10000, 50000, 100000] },
    US: { country: 'US', language: 'en', locale: 'en-US', currency: 'USD', taxMode: 'exclusive', taxLabel: 'Sales tax', taxRateBp: 825,
      cashDenoms: [500, 1000, 2000, 5000, 10000] },
  };

  const CATALOGS = {
    US: [
      ['1001', 'Coffee', 'Drinks', 350, 50, 10], ['1002', 'Tea', 'Drinks', 275, 40, 10], ['1003', 'Orange Juice', 'Drinks', 425, 8, 10],
      ['2001', 'Bagel', 'Bakery', 199, 25, 5], ['2002', 'Muffin', 'Bakery', 325, 20, 5], ['2003', 'Croissant', 'Bakery', 375, 15, 5],
      ['3001', 'Sandwich', 'Food', 895, 12, 4], ['3002', 'Salad', 'Food', 1050, 10, 4],
    ],
    TH: [
      ['1001', 'อเมริกาโน่', 'เครื่องดื่ม', 5000, 50, 10], ['1002', 'ลาเต้เย็น', 'เครื่องดื่ม', 6000, 40, 10],
      ['1003', 'ชาไทยเย็น', 'เครื่องดื่ม', 4500, 40, 10], ['1004', 'น้ำดื่ม', 'เครื่องดื่ม', 1000, 8, 10],
      ['2001', 'ครัวซองต์', 'เบเกอรี่', 6500, 15, 5], ['2002', 'เค้กกล้วยหอม', 'เบเกอรี่', 5500, 15, 5],
      ['3001', 'ข้าวกะเพราไก่', 'อาหาร', 6000, 20, 5], ['3002', 'ผัดไทยกุ้ง', 'อาหาร', 8000, 20, 5],
      ['4001', 'ผักสลัดสด', 'ผักสด', 3500, 10, 3, false],
    ],
  };

  function sampleProducts(country) {
    return (CATALOGS[country] || CATALOGS.US).map(([sku, name, category, price, stock, lowStock, taxable = true], i) =>
      ({ id: 'p' + (i + 1), sku, name, category, price, stock, lowStock, taxable }));
  }

  // ---------------------------------------------------------------- dates ---
  function dayInput(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  const localDay = iso => dayInput(new Date(iso)); // business day in the terminal's time zone
  const today = () => dayInput(new Date());
  function parseDay(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  // ---------------------------------------------------------------- data ----
  const EXTRA_SETTINGS = { machineBrand: '', machineModel: '', machineSerial: '' };

  function defaults() {
    return {
      version: 4,
      settings: {
        ...PRESETS.US, storeName: 'My Store', header: '123 Main St\n(555) 010-0000', footer: 'Thank you!',
        cashierMaxDiscount: 10, taxId: '', branch: HEAD_OFFICE, posRegNo: '', promptpayId: '', regionChosen: false, ...EXTRA_SETTINGS,
      },
      staff: [{ id: 'u1', name: 'Manager', role: 'manager', pinHash: null, defaultPin: true }],
      products: sampleProducts('US'), sampleCatalog: true,
      sales: [], shifts: [], currentShiftId: null, held: [],
      zReports: [], journal: [], complianceFrom: today(), lastBackupAt: null,
      seq: { sale: 0, shift: 0, refund: 0, cn: 0, inv: 0, z: 0 },
    };
  }

  function migrateV1(old) {
    const d = defaults();
    d.version = 2;
    d.settings.storeName = (old.settings && old.settings.storeName) || d.settings.storeName;
    if (old.settings && Number.isInteger(old.settings.taxRateBp)) d.settings.taxRateBp = old.settings.taxRateBp;
    d.products = old.products.map(p => ({ category: 'General', lowStock: 5, ...p }));
    d.sales = old.sales.map(s => ({ ...s, payments: s.payments || [{ method: s.method, amount: s.paid }] }));
    d.seq.sale = d.sales.length;
    return d;
  }

  // v2 data was US-format only; stamp it as USD so it keeps displaying correctly.
  function migrateV2(d) {
    const s = d.settings;
    return {
      ...d, version: 3, sampleCatalog: false,
      settings: {
        ...PRESETS.US, taxRateBp: s.taxRateBp, storeName: s.storeName, header: s.header || '', footer: s.footer || '',
        cashierMaxDiscount: s.cashierMaxDiscount != null ? s.cashierMaxDiscount : 10,
        taxId: '', branch: HEAD_OFFICE, posRegNo: '', promptpayId: '', regionChosen: false,
      },
      products: d.products.map(p => ({ taxable: true, ...p })),
      sales: d.sales.map(x => ({ currency: 'USD', taxLabel: 'Sales tax', ...x })),
      shifts: d.shifts.map(x => ({ currency: 'USD', ...x })),
      seq: { refund: 0, inv: 0, ...d.seq },
    };
  }

  // v3 -> v4: electronic journal, daily Z reports. Days before the upgrade are
  // not auto-closed (complianceFrom).
  function migrateV3(d) {
    return {
      ...d, version: 4, settings: { ...EXTRA_SETTINGS, ...d.settings },
      zReports: [], journal: [], complianceFrom: today(), lastBackupAt: null,
      seq: { z: 0, ...d.seq },
    };
  }

  function isValidData(d) {
    return !!(d && typeof d === 'object' && d.settings && Array.isArray(d.staff) && d.staff.some(s => s.role === 'manager') &&
      Array.isArray(d.products) && Array.isArray(d.sales) && Array.isArray(d.shifts) && Array.isArray(d.held) && d.seq);
  }

  function upgrade(d) {
    if (!isValidData(d)) return null;
    if (d.version === 4) return (Array.isArray(d.journal) && Array.isArray(d.zReports)) ? d : null;
    if (d.version === 3) return migrateV3(d);
    if (d.version === 2) return migrateV3(migrateV2(d));
    return null;
  }

  const docNum = id => Number(String(id).replace(/\D/g, '')) || 0;

  // Counters must never fall behind numbers already issued (e.g. after a
  // migration), or a document number could repeat.
  function repairSeq(d) {
    const max = (ids, prefix) => ids.filter(id => id && String(id).startsWith(prefix)).reduce((m, id) => Math.max(m, docNum(id)), 0);
    const saleIds = d.sales.map(s => s.id);
    const refundIds = d.sales.map(s => s.refund && s.refund.id);
    const floor = {
      sale: max(saleIds, 'S'), cn: max(refundIds, 'CN'), refund: max(refundIds, 'RF'),
      inv: max(d.sales.map(s => s.fullInvoice && s.fullInvoice.no), 'INV'),
      shift: max(d.shifts.map(s => s.id), 'SH'), z: max((d.zReports || []).map(z => z.no), 'Z'),
    };
    for (const [k, v] of Object.entries(floor)) d.seq[k] = Math.max(d.seq[k] || 0, v);
  }

  function normalize(d) {
    d.sales.sort((a, b) => docNum(b.id) - docNum(a.id)); // newest first
    d.journal.sort((a, b) => a.seq - b.seq);
    repairSeq(d);
    return d;
  }

  let store = null;       // storage adapter
  let data = null;
  let integrity = { ok: true };
  let persisted = false;
  const dirtySales = new Set();
  let newJournal = [];
  let saving = Promise.resolve();
  let appInfo = null;

  let user = null;
  let cart = [];
  let orderDiscountPct = 0;
  let category = null;
  let uiLang = null;
  try { uiLang = localStorage.getItem(LANG_KEY); } catch (e) { /* ignore */ }

  const S = () => data.settings;
  const lang = () => (uiLang === 'th' || uiLang === 'en' ? uiLang : S().language);

  function stateOf(d) {
    const { sales, journal, ...rest } = d; // eslint-disable-line no-unused-vars
    return rest;
  }

  // Persist changed sales, new journal entries and the app state in one
  // atomic write. Writes are queued so they land in order.
  function save() {
    const payload = {
      state: JSON.parse(JSON.stringify(stateOf(data))),
      sales: [...dirtySales].map(id => data.sales.find(s => s.id === id)).filter(Boolean),
      journal: newJournal,
      allSales: data.sales, allJournal: data.journal,
    };
    dirtySales.clear();
    newJournal = [];
    saving = saving.then(() => store.commit(payload)).catch(e => { console.error(e); toast(t('save.err', { msg: e.message }), true); });
    return saving;
  }

  function saveAll() {
    dirtySales.clear();
    newJournal = [];
    const snapshot = { state: JSON.parse(JSON.stringify(stateOf(data))), sales: data.sales, journal: data.journal };
    saving = saving.then(() => store.replaceAll(snapshot)).catch(e => { console.error(e); toast(t('save.err', { msg: e.message }), true); });
    return saving;
  }

  function upsertSale(sale) {
    const i = data.sales.findIndex(s => s.id === sale.id);
    if (i >= 0) data.sales[i] = sale; else data.sales.unshift(sale);
    dirtySales.add(sale.id);
  }

  function journalAdd(type, { ref = null, amount = null, doc = null } = {}) {
    const prev = data.journal[data.journal.length - 1];
    const e = P.journalEntry(prev, { type, ref, amount, by: user ? user.name : 'system', doc: doc ? JSON.parse(JSON.stringify(doc)) : null });
    data.journal.push(e);
    newJournal.push(e);
    return e;
  }

  // Documents must be in time order: refuse if the clock went backwards.
  function checkClock() {
    const last = data.journal[data.journal.length - 1];
    if (last && Date.now() < Date.parse(last.at) - CLOCK_TOLERANCE_MS) throw new Error(t('err.clock', { at: fmtDate(last.at) }));
  }

  // ---------------------------------------------------------------- i18n ---
  function tr(l, key, vars) {
    const d = window.I18N[l] || window.I18N.en;
    let s = d[key] != null ? d[key] : window.I18N.en[key] != null ? window.I18N.en[key] : key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
    return s;
  }
  const t = (k, v) => tr(lang(), k, v);         // UI language
  const rt = (k, v) => tr(S().language, k, v);   // receipt language

  function applyI18n() {
    document.documentElement.lang = lang();
    for (const e of $$('[data-i18n]')) e.textContent = t(e.dataset.i18n);
    for (const e of $$('[data-i18n-ph]')) e.placeholder = t(e.dataset.i18nPh);
    for (const b of $$('.lang-toggle')) b.textContent = t('lang.toggle');
    $('#prompt-ok').textContent = t('btn.ok');
  }

  function toggleLang() {
    uiLang = lang() === 'th' ? 'en' : 'th';
    try { localStorage.setItem(LANG_KEY, uiLang); } catch (e) { /* ignore */ }
    applyI18n();
    renderLogin();
    if (user) { applyRole(); renderAll(); }
  }

  // ---------------------------------------------------------------- money ---
  const decimals = () => P.currencyDecimals(S().currency);
  const money = v => P.formatMoney(v, { currency: S().currency, locale: S().locale });
  const moneyIn = cur => v => P.formatMoney(v, { currency: cur || 'USD', locale: S().locale });
  const parseAmount = str => P.toMinor(str, decimals());
  const taxSpec = () => ({ rateBp: S().taxRateBp, inclusive: S().taxMode === 'inclusive' });
  const fmtRate = bp => String(Number((bp / 100).toFixed(2)));
  const isThaiVat = s => s.country === 'TH' && !!s.taxId;           // VAT registered in Thailand
  const isAbb = s => isThaiVat(s) && !!s.posRegNo;                   // approved POS: may issue ABB
  const wasTaxInvoice = sale => { const s = sale.seller || sellerSnapshot(); return isAbb(s) || (isThaiVat(s) && !!sale.fullInvoice); };
  const promptPayOn = () => !!S().promptpayId && S().currency === 'THB';

  // ---------------------------------------------------------------- utils ---
  let toastTimer;
  function toast(msg, isError) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = ''), 3500);
  }

  function el(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'onclick' || k === 'onchange' || k === 'oninput') e.addEventListener(k.slice(2), v);
      else e[k] = v;
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }

  const errText = e => (e && e.code ? t('err.' + e.code, e.params) : (e && e.message) || String(e));
  const guard = fn => async (...args) => {
    try { await fn(...args); } catch (e) { toast(errText(e), true); }
  };

  const fmtDate = iso => new Date(iso).toLocaleString(S().locale);
  const fmtDay = day => parseDay(day).toLocaleDateString(S().locale);

  function download(name, text, type) {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Document numbers must be continuous (no gaps), so a number is only
  // consumed once the document is actually created.
  const peekId = (kind, prefix, width) => prefix + String((data.seq[kind] || 0) + 1).padStart(width, '0');
  const commitId = kind => { data.seq[kind] = (data.seq[kind] || 0) + 1; };
  const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const currentShift = () => data.shifts.find(s => s.id === data.currentShiftId && !s.closedAt) || null;
  const productById = id => data.products.find(p => p.id === id);
  const isManager = () => !!user && user.role === 'manager';
  const validBranch = b => b === HEAD_OFFICE || /^\d{5}$/.test(b);

  // PINs are stored hashed. This deters casual snooping only: all data lives
  // in this browser, so anyone with device access could edit it.
  async function hashPin(pin, salt) {
    const input = salt + ':' + pin;
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
      return 'sha256:' + Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
    }
    return 'sha256:' + P.sha256(input);
  }
  async function checkPin(staff, pin) {
    if (staff.defaultPin && !staff.pinHash) return pin === '1234';
    return (await hashPin(pin, staff.id)) === staff.pinHash;
  }

  // ------------------------------------------------------------- dialogs ---
  function ask({ title, text = '', fields = [], ok }) {
    return new Promise(resolve => {
      const dlg = $('#prompt-dialog');
      $('#prompt-title').textContent = title;
      $('#prompt-text').textContent = text;
      $('#prompt-ok').textContent = ok || t('btn.ok');
      const box = $('#prompt-fields');
      box.replaceChildren();
      const inputs = {};
      for (const f of fields) {
        let input;
        if (f.type === 'select') {
          input = el('select', { name: f.name }, ...f.options.map(o => el('option', { value: o.value, textContent: o.label })));
          if (f.value != null) input.value = f.value;
        } else {
          input = el('input', { name: f.name, type: f.type || 'text', value: f.value != null ? f.value : '', autocomplete: 'off' });
          if (f.inputmode) input.inputMode = f.inputmode;
        }
        inputs[f.name] = input;
        box.append(el('label', {}, el('span', { textContent: f.label }), input));
      }
      const onClose = () => {
        dlg.removeEventListener('close', onClose);
        resolve(dlg.returnValue === 'ok' ? Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value])) : null);
      };
      dlg.returnValue = '';
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      const first = box.querySelector('input, select');
      if (first) first.focus();
    });
  }

  async function confirmBox(title, text) {
    return (await ask({ title, text, ok: t('btn.confirm') })) !== null;
  }

  async function managerApproval(reason) {
    if (isManager()) return user;
    const managers = data.staff.filter(s => s.role === 'manager');
    const r = await ask({
      title: t('approve.title'), text: reason, ok: t('approve.ok'),
      fields: [
        { name: 'id', label: t('approve.manager'), type: 'select', options: managers.map(m => ({ value: m.id, label: m.name })) },
        { name: 'pin', label: t('approve.pin'), type: 'password', inputmode: 'numeric' },
      ],
    });
    if (!r) return null;
    const m = managers.find(x => x.id === r.id);
    if (!m || !(await checkPin(m, r.pin))) { toast(t('approve.denied'), true); return null; }
    return m;
  }

  // ----------------------------------------------------------- documents ---
  // A document is a list of lines rendered as a narrow receipt:
  // { c } centered · { l, r } left/right · { t } text · { hr: 1|2 } rule · { gap }
  function renderDocLines(lines) {
    return lines.map(L => {
      const cls = L.cls ? ' ' + L.cls : '';
      if (L.hr) return el('div', { className: 'r-hr' + (L.hr === 2 ? ' double' : '') });
      if (L.gap) return el('div', { className: 'r-gap' });
      if (L.c != null) return el('div', { className: 'r-c' + cls, textContent: L.c });
      if (L.l != null) return el('div', { className: 'r-lr' + cls }, el('span', { textContent: L.l }), el('span', { textContent: L.r != null ? L.r : '' }));
      return el('div', { className: 'r-t' + cls, textContent: L.t });
    });
  }

  // print: true for newly issued originals, which the desktop app prints
  // straight to the receipt printer when auto-print is on.
  function showDoc(lines, { print = false } = {}) {
    $('#receipt').replaceChildren(...renderDocLines(lines));
    $('#receipt-dialog').showModal();
    if (print && native && hw && hw.autoPrint) printReceipt();
  }

  async function printReceipt() {
    if (!native) { window.print(); return; }
    const r = await native.print('receipt', $('#receipt').outerHTML);
    if (!r || !r.ok) toast(t('hw.printFailed', { err: (r && r.error) || '?' }), true);
  }

  // Open the cash drawer (desktop app with a drawer configured).
  async function kickDrawer() {
    if (!native || !hw || hw.drawer.mode === 'none') return;
    const r = await native.openDrawer();
    if (!r.ok) toast(t('hw.drawerFailed', { err: r.error }), true);
  }

  // Desktop app: write a backup file to disk (after each day close).
  async function autoBackup() {
    if (!native || !hw || !hw.autoBackup) return;
    const r = await native.saveBackup(`pos-backup-${S().taxId || 'store'}-${today()}.json`, backupJSON());
    if (r.ok) { data.lastBackupAt = new Date().toISOString(); save(); renderAlerts(); renderStorageInfo(); }
    else toast(t('hw.backupFailed', { err: r.error }), true);
  }

  const MODE_MARK = {
    copy: 'สำเนา / COPY', journal: 'สำเนาจากบันทึกรายการ / JOURNAL COPY', sample: 'ตัวอย่าง / SAMPLE', preview: 'ตัวอย่างก่อนปิดยอด / PREVIEW',
  };
  const modeLines = mode => (MODE_MARK[mode] ? [{ c: MODE_MARK[mode], cls: 'mark' }] : []);

  function sellerSnapshot() {
    const s = S();
    return { country: s.country, name: s.storeName, header: s.header, footer: s.footer, taxId: s.taxId, branch: s.branch, posRegNo: s.posRegNo, language: s.language };
  }

  function branchText(b) {
    return !b || b === HEAD_OFFICE || b === '00000' ? rt('doc.headOffice') : rt('doc.branchNo', { n: b });
  }

  function sellerHeader(seller) {
    const out = [{ c: seller.name, cls: 'big' }];
    for (const line of (seller.header || '').split('\n').filter(Boolean)) out.push({ c: line });
    if (seller.taxId) out.push({ c: `${rt('doc.taxId')} ${seller.taxId}` });
    if (isThaiVat(seller)) out.push({ c: branchText(seller.branch) });
    if (isAbb(seller)) out.push({ c: `${rt('doc.posReg')} ${seller.posRegNo}` });
    return out;
  }

  function itemLines(sale, m) {
    const out = [];
    for (const l of sale.lines) {
      const lt = P.lineTotals(l);
      out.push({ t: l.name + (l.taxable === false ? rt('doc.exemptMark') : '') });
      out.push({ l: `   ${l.qty} × ${m(l.price)}`, r: m(lt.gross) });
      if (lt.discount) out.push({ l: `   ${rt('doc.orderDiscount', { p: l.discountPct })}`, r: m(-lt.discount) });
    }
    return out;
  }

  function receiptDoc(sale, mode = 'original') {
    const m = moneyIn(sale.currency);
    const seller = sale.seller || sellerSnapshot();
    const abb = isAbb(seller);
    const label = sale.taxLabel || 'Tax';
    const out = sellerHeader(seller);
    out.push({ gap: 1 });
    if (abb) out.push({ c: 'ใบกำกับภาษีอย่างย่อ', cls: 'title' }, { c: 'TAX INV (ABB)', cls: 'small' });
    else out.push({ c: rt('doc.receipt'), cls: 'title' });
    out.push(...modeLines(mode));
    out.push({ l: rt('doc.no'), r: sale.id }, { l: rt('doc.date'), r: fmtDate(sale.date) });
    if (sale.cashier) out.push({ l: rt('doc.cashier'), r: sale.cashier });
    out.push({ hr: 1 }, ...itemLines(sale, m), { hr: 1 }, { l: rt('doc.subtotal'), r: m(sale.subtotal) });
    if (sale.orderDiscount) out.push({ l: rt('doc.orderDiscount', { p: sale.orderDiscountPct }), r: m(-sale.orderDiscount) });
    if (!sale.taxInclusive && (sale.tax || sale.taxRateBp)) out.push({ l: `${label} ${fmtRate(sale.taxRateBp || 0)}%`, r: m(sale.tax) });
    out.push({ hr: 2 }, { l: rt('doc.total'), r: m(sale.total), cls: 'grand' }, { hr: 2 });
    if (sale.taxInclusive && sale.taxRateBp > 0) {
      out.push({ c: abb ? 'ราคารวมภาษีมูลค่าเพิ่มแล้ว (VAT INCLUDED)' : rt('doc.vatIncluded', { label }), cls: 'small' });
      out.push({ l: rt('doc.taxBase', { label }), r: m(sale.taxBase) }, { l: `${label} ${fmtRate(sale.taxRateBp)}%`, r: m(sale.tax) });
    }
    if (sale.exemptAmount) out.push({ l: rt('doc.exempt'), r: m(sale.exemptAmount) });
    for (const p of sale.payments || []) out.push({ l: rt('method.' + p.method), r: m(p.amount) });
    if (sale.change) out.push({ l: rt('doc.change'), r: m(sale.change) });
    if (sale.discount) out.push({ gap: 1 }, { c: rt('doc.saved', { amt: m(sale.discount) }) });
    if (mode !== 'journal') {
      if (sale.voided) out.push({ gap: 1 }, { c: rt('doc.voidedMark'), cls: 'title' }, { c: fmtDate(sale.voided.date) });
      if (sale.refunded) out.push({ gap: 1 }, { c: rt('doc.refunded'), cls: 'title' }, { c: `${sale.refund.id || ''} ${fmtDate(sale.refund.date)}`.trim() });
      if (sale.fullInvoice) out.push({ gap: 1 }, { c: rt('doc.replacedBy', { no: sale.fullInvoice.no }), cls: 'bold' });
    }
    out.push({ gap: 1 }, ...(seller.footer || '').split('\n').filter(Boolean).map(c => ({ c })));
    return out;
  }

  function voidDoc(sale, mode = 'original') {
    const m = moneyIn(sale.currency);
    const seller = sale.seller || sellerSnapshot();
    const out = sellerHeader(seller);
    out.push({ gap: 1 }, { c: isAbb(seller) ? 'ยกเลิกใบกำกับภาษีอย่างย่อ' : rt('doc.voidTitle'), cls: 'title' }, { c: 'VOID', cls: 'small' }, ...modeLines(mode),
      { l: rt('doc.voidOf'), r: sale.id }, { l: rt('doc.origDate'), r: fmtDate(sale.date) },
      { l: rt('doc.voidDate'), r: fmtDate(sale.voided.date) }, { t: `${rt('doc.reason')}: ${sale.voided.reason}` },
      { hr: 1 }, ...itemLines(sale, m), { hr: 2 }, { l: rt('doc.voidTotal'), r: m(sale.total), cls: 'grand' }, { hr: 2 });
    for (const [method, amt] of Object.entries(P.saleTenders(sale))) out.push({ l: rt('doc.refundedTo', { method: rt('method.' + method) }), r: m(amt) });
    if (sale.voided.by) out.push({ l: rt('doc.approvedBy'), r: sale.voided.by });
    return out;
  }

  // Full tax invoice (ใบกำกับภาษีเต็มรูป, Revenue Code s.86/4 and DG notice
  // no. 199). Thai legal wording is always printed, English alongside.
  function invoiceDoc(sale, mode = 'original') {
    const m = moneyIn(sale.currency);
    const inv = sale.fullInvoice;
    const seller = sale.seller || sellerSnapshot();
    const label = sale.taxLabel || 'VAT';
    const out = sellerHeader(seller);
    const branch = b => (!b || b === HEAD_OFFICE ? 'สำนักงานใหญ่ / Head office' : `สาขาที่ ${b} / Branch ${b}`);
    out.push({ gap: 1 }, { c: 'ใบกำกับภาษี / ใบเสร็จรับเงิน', cls: 'title' }, { c: 'TAX INVOICE / RECEIPT', cls: 'small' },
      { c: mode === 'original' ? 'ต้นฉบับ / ORIGINAL' : MODE_MARK[mode] || MODE_MARK.copy, cls: 'mark' },
      { l: 'เลขที่ / No.', r: inv.no }, { l: 'วันที่ / Date', r: fmtDate(inv.date) });
    if (isAbb(seller)) out.push({ t: `ยกเลิกใบกำกับภาษีอย่างย่อเลขที่ ${sale.id} และออกใบกำกับภาษีเต็มรูปนี้แทน`, cls: 'small' }, { t: `Replaces abbreviated tax invoice ${sale.id}`, cls: 'small' });
    else out.push({ t: `อ้างอิงใบเสร็จรับเงินเลขที่ ${sale.id} / Ref. receipt ${sale.id}`, cls: 'small' });
    out.push({ hr: 1 }, { t: `ผู้ซื้อ / Customer: ${inv.buyer.name}` }, { t: `ที่อยู่ / Address: ${inv.buyer.address}` });
    if (inv.buyer.taxId) {
      out.push({ t: `เลขประจำตัวผู้เสียภาษีอากร / Tax ID: ${inv.buyer.taxId}` });
      out.push({ t: branch(inv.buyer.branch) });
    }
    out.push({ hr: 1 }, ...itemLines(sale, m), { hr: 1 }, { l: 'รวมเป็นเงิน / Subtotal', r: m(sale.subtotal) });
    if (sale.orderDiscount) out.push({ l: `ส่วนลด / Discount ${sale.orderDiscountPct}%`, r: m(-sale.orderDiscount) });
    out.push({ l: `มูลค่าสินค้า (ก่อน ${label}) / Value`, r: m(sale.taxBase) },
      { l: `ภาษีมูลค่าเพิ่ม / ${label} ${fmtRate(sale.taxRateBp)}%`, r: m(sale.tax) });
    if (sale.exemptAmount) out.push({ l: 'สินค้ายกเว้นภาษี / Exempt', r: m(sale.exemptAmount) });
    out.push({ hr: 2 }, { l: 'รวมทั้งสิ้น / TOTAL', r: m(sale.total), cls: 'grand' }, { hr: 2 },
      { gap: 1 }, { gap: 1 }, { c: '________________________' }, { c: 'ผู้รับเงิน / Received by', cls: 'small' });
    return out;
  }

  // Credit note (ใบลดหนี้, s.86/10) when the sale was a tax invoice; otherwise
  // a refund slip.
  function refundDoc(sale, mode = 'original') {
    const m = moneyIn(sale.currency);
    const seller = sale.seller || sellerSnapshot();
    const credit = wasTaxInvoice(sale);
    const rf = sale.refund;
    const label = sale.taxLabel || 'Tax';
    const out = sellerHeader(seller);
    out.push({ gap: 1 });
    if (credit) out.push({ c: 'ใบลดหนี้', cls: 'title' }, { c: 'CREDIT NOTE', cls: 'small' });
    else out.push({ c: rt('doc.refund'), cls: 'title' });
    out.push(...modeLines(mode), { l: rt('doc.no'), r: rf.id || sale.id + '-R' }, { l: rt('doc.date'), r: fmtDate(rf.date) });
    if (sale.fullInvoice) {
      const b = sale.fullInvoice.buyer;
      out.push({ t: `อ้างอิงใบกำกับภาษีเลขที่ / Ref. tax invoice ${sale.fullInvoice.no} (${fmtDate(sale.fullInvoice.date)})` },
        { t: `ผู้ซื้อ / Customer: ${b.name}` }, { t: `ที่อยู่ / Address: ${b.address}` });
      if (b.taxId) out.push({ t: `เลขประจำตัวผู้เสียภาษีอากร / Tax ID: ${b.taxId}` });
    } else if (credit) {
      out.push({ t: `อ้างอิงใบกำกับภาษีอย่างย่อเลขที่ / Ref. ABB ${sale.id} (${fmtDate(sale.date)})` });
    } else {
      out.push({ t: rt('doc.refundOf', { id: sale.id }) + ` (${fmtDate(sale.date)})` });
    }
    if (rf.reason) out.push({ t: `${rt('doc.reason')}: ${rf.reason}` });
    out.push({ hr: 1 }, ...itemLines(sale, m), { hr: 1 });
    if (credit) {
      out.push({ l: 'มูลค่าสินค้าตามใบกำกับภาษีเดิม', r: m(sale.taxBase) }, { l: 'มูลค่าที่ถูกต้อง', r: m(0) },
        { l: 'ผลต่าง', r: m(sale.taxBase) }, { l: `ภาษีมูลค่าเพิ่มของผลต่าง ${fmtRate(sale.taxRateBp)}%`, r: m(sale.tax) });
      if (sale.exemptAmount) out.push({ l: 'สินค้ายกเว้นภาษี / Exempt', r: m(sale.exemptAmount) });
    } else if (sale.tax) {
      out.push({ l: `${label} ${fmtRate(sale.taxRateBp || 0)}%`, r: m(sale.tax) });
    }
    out.push({ hr: 2 }, { l: rt('doc.refundTotal'), r: m(sale.total), cls: 'grand' }, { hr: 2 });
    for (const [method, amt] of Object.entries(P.saleTenders(sale))) out.push({ l: rt('doc.refundedTo', { method: rt('method.' + method) }), r: m(amt) });
    if (rf.by) out.push({ l: rt('doc.approvedBy'), r: rf.by });
    return out;
  }

  function shiftDoc(shift, final) {
    const m = moneyIn(shift.currency);
    const r = final && shift.report ? shift.report : P.shiftReport(shift, data.sales);
    const out = [{ c: S().storeName, cls: 'big' }, { c: rt(final ? 'z.z' : 'z.x'), cls: 'title' }, { gap: 1 },
      { l: rt('z.shift'), r: shift.id }, { l: rt('z.opened'), r: fmtDate(shift.openedAt) }, { l: rt('z.openedBy'), r: shift.openedBy }];
    if (shift.closedAt) out.push({ l: rt('z.closed'), r: fmtDate(shift.closedAt) }, { l: rt('z.closedBy'), r: shift.closedBy || '' });
    out.push({ hr: 1 }, { l: rt('z.transactions'), r: String(r.transactions) });
    if (r.voidCount) out.push({ l: rt('z.voids'), r: String(r.voidCount) });
    out.push({ l: rt('z.gross'), r: m(r.grossSales) },
      { l: rt('z.discounts'), r: m(r.discounts) }, { l: rt('z.refunds', { n: r.refundCount }), r: m(-r.refundTotal) },
      { l: rt('z.net'), r: m(r.netSales), cls: 'bold' }, { l: rt('z.tax'), r: m(r.tax) }, { hr: 1 });
    const salesBy = r.salesBy || { cash: r.cashSales, card: r.cardSales };
    const refundsBy = r.refundsBy || { cash: r.cashRefunds, card: r.cardRefunds };
    for (const method of P.METHODS.filter(x => x !== 'cash')) {
      if (salesBy[method] || refundsBy[method]) {
        out.push({ l: rt('z.salesBy', { method: rt('method.' + method) }), r: m(salesBy[method] || 0) },
          { l: rt('z.refundsBy', { method: rt('method.' + method) }), r: m(-(refundsBy[method] || 0)) });
      }
    }
    out.push({ hr: 1 }, { t: rt('z.drawer'), cls: 'bold' }, { l: rt('z.float'), r: m(r.float) },
      { l: rt('z.salesBy', { method: rt('method.cash') }), r: m(r.cashSales) },
      { l: rt('z.refundsBy', { method: rt('method.cash') }), r: m(-r.cashRefunds) },
      { l: rt('z.payIns'), r: m(r.payIns) }, { l: rt('z.payOuts'), r: m(-r.payOuts) },
      { hr: 2 }, { l: rt('z.expected'), r: m(r.expectedCash), cls: 'bold' });
    if (r.counted != null) {
      out.push({ l: rt('z.counted'), r: m(r.counted) },
        { l: rt(r.variance === 0 ? 'z.balanced' : r.variance > 0 ? 'z.over' : 'z.short'), r: m(Math.abs(r.variance)), cls: 'bold' });
    }
    if (shift.movements.length) {
      out.push({ hr: 1 }, { t: rt('z.movements'), cls: 'bold' });
      for (const mv of shift.movements) out.push({ l: `${rt(mv.type === 'in' ? 'z.in' : 'z.out')} ${mv.reason}`, r: m(mv.type === 'in' ? mv.amount : -mv.amount) });
    }
    out.push({ gap: 1 }, { c: rt('z.printed', { date: fmtDate(new Date().toISOString()) }), cls: 'small' });
    return out;
  }

  // Daily sales summary report (รายงานสรุปยอดขายประจำวัน, "Z report").
  function zDoc(z, mode = 'original') {
    const m = moneyIn(z.currency);
    const sm = z.summary;
    const seller = z.seller || sellerSnapshot();
    const label = z.taxLabel || S().taxLabel;
    const out = sellerHeader(seller);
    out.push({ gap: 1 }, { c: rt('day.title'), cls: 'title' }, { c: 'DAILY SALES REPORT (Z)', cls: 'small' }, ...modeLines(mode));
    if (z.no) out.push({ l: rt('day.zNo'), r: z.no });
    out.push({ l: rt('day.date'), r: fmtDay(z.day) });
    if (z.closedAt) out.push({ l: rt('day.closedAt'), r: fmtDate(z.closedAt) }, { l: rt('day.closedBy'), r: z.auto ? rt('day.auto') : z.by || '' });
    out.push({ hr: 1 }, { t: rt(isAbb(seller) ? 'day.abb' : 'day.receipts'), cls: 'bold' },
      { l: rt('day.range'), r: sm.firstNo ? `${sm.firstNo} – ${sm.lastNo}` : '-' }, { l: rt('day.count'), r: String(sm.count) },
      { l: rt('day.voided', { n: sm.voided.length }), r: m(-sm.voided.reduce((a, v) => a + v.total, 0)) });
    for (const v of sm.voided) out.push({ l: `   ${v.id}`, r: m(v.total) });
    if (sm.replaced.length) {
      out.push({ t: rt('day.replaced', { n: sm.replaced.length }) });
      for (const r of sm.replaced) out.push({ l: `   ${r.id}`, r: r.invoice });
    }
    out.push({ hr: 1 }, { l: rt('doc.taxBase', { label }), r: m(sm.taxBase) }, { l: `${label} ${fmtRate(z.taxRateBp)}%`, r: m(sm.tax) },
      { l: rt('doc.exempt'), r: m(sm.exempt) }, { l: rt('day.discounts'), r: m(sm.discount) },
      { l: rt('day.sales'), r: m(sm.total), cls: 'bold' }, { hr: 1 },
      { t: rt(isThaiVat(seller) ? 'day.creditNotes' : 'day.refunds', { n: sm.creditNotes.length }), cls: 'bold' });
    for (const c of sm.creditNotes) out.push({ l: `   ${c.id} (${c.saleId})`, r: m(-c.total) });
    out.push({ l: rt('doc.taxBase', { label }), r: m(-sm.cnTaxBase) }, { l: label, r: m(-sm.cnTax) }, { l: rt('day.cnTotal'), r: m(-sm.cnTotal) });
    if (sm.invoices.length) {
      out.push({ hr: 1 }, { t: rt('day.invoices', { n: sm.invoices.length }), cls: 'bold' });
      for (const i of sm.invoices) out.push({ l: `   ${i.no} (${i.saleId})`, r: m(i.total) });
    }
    out.push({ hr: 2 }, { l: rt('day.net'), r: m(sm.net), cls: 'grand' }, { hr: 2 }, { t: rt('day.payments'), cls: 'bold' });
    for (const k of P.METHODS) {
      if (sm.paymentsBy[k] || sm.refundsBy[k]) out.push({ l: rt('method.' + k), r: m((sm.paymentsBy[k] || 0) - (sm.refundsBy[k] || 0)) });
    }
    if (z.gtAfter != null) out.push({ hr: 1 }, { l: rt('day.gtBefore'), r: m(z.gtBefore) }, { l: rt('day.gtAfter'), r: m(z.gtAfter), cls: 'bold' });
    if (z.journalSeq) out.push({ hr: 1 }, { l: rt('day.journal'), r: `#${z.journalSeq} · ${z.journalHash.slice(0, 12)}`, cls: 'small' });
    out.push({ gap: 1 }, { c: rt('z.printed', { date: fmtDate(new Date().toISOString()) }), cls: 'small' });
    return out;
  }

  // --------------------------------------------------------- day closing ---
  function activityDays() {
    const set = new Set();
    for (const s of data.sales) {
      set.add(localDay(s.date));
      if (s.refund) set.add(localDay(s.refund.date));
      if (s.voided) set.add(localDay(s.voided.date));
      if (s.fullInvoice) set.add(localDay(s.fullInvoice.issuedAt || s.fullInvoice.date));
    }
    return [...set].filter(d => d >= data.complianceFrom).sort();
  }
  const isDayClosed = day => data.zReports.some(z => z.day === day);

  function closeDay(day, auto) {
    if (isDayClosed(day)) throw new Error(t('day.alreadyClosed', { day: fmtDay(day) }));
    const summary = P.daySummary({ sales: data.sales, day, dayOf: localDay });
    const last = data.zReports[data.zReports.length - 1];
    const gtBefore = last ? last.gtAfter : 0;
    const lastJ = data.journal[data.journal.length - 1];
    const z = {
      no: peekId('z', 'Z', 4), day, closedAt: new Date().toISOString(), by: user ? user.name : null, auto: !!auto,
      currency: S().currency, taxLabel: S().taxLabel, taxRateBp: S().taxRateBp, seller: sellerSnapshot(),
      summary, gtBefore, gtAfter: gtBefore + summary.total,
      journalSeq: lastJ ? lastJ.seq : 0, journalHash: lastJ ? lastJ.hash : '',
    };
    commitId('z');
    data.zReports.push(z);
    journalAdd('z', { ref: z.no, amount: summary.total, doc: z });
    return z;
  }

  // Close every earlier day that had activity but no Z report yet.
  function autoCloseDays() {
    const closed = [];
    for (const d of activityDays()) if (d < today() && !isDayClosed(d)) closed.push(closeDay(d, true));
    if (closed.length) {
      save();
      toast(t('day.autoClosed', { days: closed.map(z => fmtDay(z.day)).join(', ') }));
      autoBackup();
    }
    return closed;
  }

  // Call before creating any tax document.
  function ensureDayOpen() {
    checkClock();
    autoCloseDays();
    if (isDayClosed(today())) throw new Error(t('day.closedToday'));
  }

  // --------------------------------------------------------------- login ---
  let loginSel = null, pinBuf = '', failed = 0, lockedUntil = 0;

  function renderLogin() {
    $('#login-store').textContent = S().storeName;
    const box = $('#login-staff');
    box.replaceChildren();
    if (!loginSel || !data.staff.some(s => s.id === loginSel.id)) loginSel = data.staff[0];
    else loginSel = data.staff.find(s => s.id === loginSel.id);
    for (const s of data.staff) {
      box.append(el('button', {
        type: 'button', textContent: s.name, className: s === loginSel ? 'active' : '',
        onclick: () => { loginSel = s; pinBuf = ''; renderLogin(); $('#pin-display').focus(); },
      }));
    }
    $('#pin-display').value = pinBuf;
    const def = data.staff.find(s => s.defaultPin && !s.pinHash);
    $('#login-hint').textContent = def ? t('login.hint', { name: def.name }) : '';
  }

  function buildKeypad() {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'OK'];
    $('#keypad').replaceChildren(...keys.map(k => el('button', {
      type: 'button', textContent: k, className: k === 'OK' ? 'primary' : '',
      onclick: () => {
        if (k === 'C') pinBuf = '';
        else if (k === 'OK') return attemptLogin();
        else if (pinBuf.length < 8) pinBuf += k;
        $('#pin-display').value = pinBuf;
      },
    })));
    $('#pin-display').addEventListener('input', e => { pinBuf = e.target.value.replace(/\D/g, '').slice(0, 8); e.target.value = pinBuf; });
    $('#pin-display').addEventListener('keydown', e => { if (e.key === 'Enter') attemptLogin(); });
  }

  async function attemptLogin() {
    if (Date.now() < lockedUntil) return toast(t('login.locked', { s: Math.ceil((lockedUntil - Date.now()) / 1000) }), true);
    if (!loginSel) return;
    const ok = await checkPin(loginSel, pinBuf);
    pinBuf = ''; $('#pin-display').value = '';
    if (!ok) {
      if (++failed >= MAX_PIN_TRIES) { lockedUntil = Date.now() + 30000; failed = 0; }
      return toast(t('login.wrong'), true);
    }
    failed = 0;
    user = loginSel;
    $('#login').hidden = true;
    $('#app').hidden = false;
    applyRole();
    toast(t('login.welcome', { name: user.name }));
    try { autoCloseDays(); } catch (e) { toast(errText(e), true); }
    renderAll();
    showView(currentShift() ? 'register' : 'shift');
    resetIdle();
    if (isManager() && !S().regionChosen) await guard(chooseRegion)();
  }

  function lock() {
    user = null;
    for (const d of $$('dialog')) if (d.open) d.close();
    $('#app').hidden = true;
    $('#login').hidden = false;
    renderLogin();
    $('#pin-display').focus();
  }

  let idleTimer;
  function resetIdle() {
    clearTimeout(idleTimer);
    if (user) idleTimer = setTimeout(() => { if (user) { lock(); toast(t('login.idle')); } }, IDLE_LOCK_MS);
  }

  function applyRole() {
    for (const b of $$('nav button[data-role=manager]')) b.hidden = !isManager();
    $('#user-badge').textContent = `${user.name} · ${t('role.' + user.role)}`;
  }

  function showView(name) {
    const btn = $(`nav button[data-view="${name}"]`);
    if (!btn || btn.hidden) return;
    for (const b of $$('nav button')) b.classList.toggle('active', b === btn);
    for (const v of $$('.view')) v.classList.toggle('active', v.id === 'view-' + name);
    if (name === 'register') $('#search').focus();
    if (name === 'journal') renderJournal();
  }

  // --------------------------------------------------------------- alerts ---
  function renderAlerts() {
    const box = $('#alerts');
    const items = [];
    if (!integrity.ok) items.push(['danger', t('alert.integrity', { seq: integrity.seq })]);
    if (isDayClosed(today())) items.push(['info', t('alert.dayClosed')]);
    if (isManager()) {
      if (isThaiVat(S()) && !S().posRegNo) items.push(['warn', t('alert.noPosReg')]);
      if (store && store.kind !== 'indexeddb') items.push(['danger', t('alert.fallbackStorage')]);
      else if (!persisted) items.push(['info', t('alert.notPersisted')]);
      const last = data.lastBackupAt ? Date.parse(data.lastBackupAt) : 0;
      if (data.sales.length && Date.now() - last > BACKUP_REMIND_DAYS * 864e5) {
        items.push(['warn', data.lastBackupAt ? t('alert.backupOld', { date: fmtDate(data.lastBackupAt) }) : t('alert.backupNever')]);
      }
    }
    box.replaceChildren(...items.map(([kind, text]) => el('div', { className: 'alert ' + kind, textContent: text })));
    box.hidden = !items.length;
  }

  // ----------------------------------------------------------- region ---
  function applyPreset(country) {
    const preset = PRESETS[country];
    const next = preset ? { ...S(), ...preset } : { ...S(), country: 'OTHER' };
    if (next.currency !== S().currency && (currentShift() || activityDays().some(d => !isDayClosed(d)))) { toast(t('set.curShift'), true); return false; }
    if (!preset) next.country = 'OTHER';
    if (next.country !== 'TH') next.promptpayId = next.currency === 'THB' ? next.promptpayId : '';
    if (country === 'TH' && next.footer === 'Thank you!') next.footer = 'ขอบคุณที่ใช้บริการ';
    if (country !== 'TH' && next.footer === 'ขอบคุณที่ใช้บริการ') next.footer = 'Thank you!';
    data.settings = { ...next, regionChosen: true };
    if (data.sampleCatalog) {
      data.products = sampleProducts(country);
      cart = [];
    }
    journalAdd('settings', { doc: { country: next.country, currency: next.currency, taxMode: next.taxMode, taxRateBp: next.taxRateBp } });
    save();
    return true;
  }

  async function chooseRegion() {
    const r = await ask({
      title: t('setup.title'), text: t('setup.text'),
      fields: [{ name: 'country', label: t('setup.country'), type: 'select', value: lang() === 'th' ? 'TH' : 'US',
        options: ['TH', 'US', 'OTHER'].map(c => ({ value: c, label: t('country.' + c) })) }],
    });
    if (!r) return;
    if (!applyPreset(r.country)) return;
    uiLang = null;
    try { localStorage.removeItem(LANG_KEY); } catch (e) { /* ignore */ }
    applyI18n(); applyRole(); renderAll();
    if (r.country !== 'US') showView('settings');
  }

  // ------------------------------------------------------------ register ---
  function renderCategories() {
    const cats = [...new Set(data.products.map(p => p.category || 'General'))].sort((a, b) => a.localeCompare(b));
    if (category && !cats.includes(category)) category = null;
    $('#categories').replaceChildren(
      el('button', { textContent: t('cat.all'), className: category ? '' : 'active', onclick: () => { category = null; renderCategories(); renderGrid(); } }),
      ...cats.map(c => el('button', {
        textContent: c, className: c === category ? 'active' : '',
        onclick: () => { category = c; renderCategories(); renderGrid(); },
      })));
    $('#category-list').replaceChildren(...cats.map(c => el('option', { value: c })));
  }

  function renderGrid() {
    const q = $('#search').value.trim().toLowerCase();
    const list = data.products.filter(p =>
      (!category || (p.category || 'General') === category) &&
      (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)));
    const grid = $('#product-grid');
    grid.replaceChildren();
    if (!list.length) grid.append(el('p', { className: 'muted', textContent: t('reg.noProducts') }));
    for (const p of list) {
      const inCart = (cart.find(l => l.id === p.id) || { qty: 0 }).qty;
      const low = p.stock <= (p.lowStock || 0);
      grid.append(el('button', {
        className: 'tile', disabled: p.stock - inCart <= 0, title: p.sku,
        onclick: guard(() => addProduct(p)),
      },
      el('strong', { textContent: p.name }),
      el('span', { className: 'price', textContent: money(p.price) }),
      el('small', { className: low ? 'low' : '', textContent: p.stock <= 0 ? t('reg.outOfStock') : t('reg.inStock', { n: p.stock }) + (low ? ' · ' + t('reg.low') : '') })));
    }
  }

  function addProduct(p) {
    cart = P.addToCart(cart, p);
    renderGrid(); renderCart();
  }

  async function changeDiscount(pct, apply, whatKey) {
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error(t('err.pct'));
    if (pct > S().cashierMaxDiscount && !isManager()) {
      const m = await managerApproval(t('reg.discLimit', { what: t(whatKey), pct, max: S().cashierMaxDiscount }));
      if (!m) return;
    }
    apply(pct);
  }

  function renderCart() {
    const tb = $('#cart-lines');
    tb.replaceChildren();
    if (!cart.length) tb.append(el('tr', {}, el('td', { colSpan: 5, className: 'muted', textContent: t('reg.empty') })));
    for (const line of cart) {
      const lt = P.lineTotals(line);
      tb.append(el('tr', {},
        el('td', {}, el('div', { textContent: line.name }), el('small', { className: 'muted', textContent: t('reg.each', { p: money(line.price) }) })),
        el('td', {}, el('input', {
          type: 'number', min: '0', step: '1', value: String(line.qty), ariaLabel: t('col.qty'),
          onchange: guard(async e => {
            try { cart = P.setQty(cart, line.id, Number(e.target.value), productById(line.id).stock); }
            finally { renderCart(); renderGrid(); }
          }),
        })),
        el('td', {}, el('input', {
          type: 'number', min: '0', max: '100', step: '1', value: String(line.discountPct || 0), ariaLabel: t('col.disc'),
          onchange: guard(async e => {
            try { await changeDiscount(Number(e.target.value), pct => { cart = P.setLineDiscount(cart, line.id, pct); }, 'reg.lineDisc'); }
            finally { renderCart(); }
          }),
        })),
        el('td', { className: 'num' }, lt.discount ? el('s', { className: 'muted small', textContent: money(lt.gross) }) : null, lt.discount ? el('br') : null, money(lt.net)),
        el('td', {}, el('button', { className: 'x ghost', textContent: '✕', title: t('reg.remove'), onclick: () => { cart = cart.filter(l => l.id !== line.id); renderCart(); renderGrid(); } }))));
    }
    $('#order-discount').value = String(orderDiscountPct);
    const tot = P.computeTotals(cart, orderDiscountPct, taxSpec());
    const s = S();
    const rows = [[t('reg.items'), String(cart.reduce((a, l) => a + l.qty, 0))], [t('reg.subtotal'), money(tot.gross)]];
    if (tot.itemDiscount) rows.push([t('reg.itemDiscounts'), money(-tot.itemDiscount)]);
    if (tot.orderDiscount) rows.push([t('reg.orderDisc', { p: orderDiscountPct }), money(-tot.orderDiscount)]);
    if (!tot.taxInclusive && s.taxRateBp) rows.push([`${s.taxLabel} (${fmtRate(s.taxRateBp)}%)`, money(tot.tax)]);
    rows.push([t('reg.total'), money(tot.total), 'grand']);
    if (tot.taxInclusive && s.taxRateBp) rows.push([t('reg.inclTax', { label: s.taxLabel, rate: fmtRate(s.taxRateBp) }), money(tot.tax), 'sub']);
    if (tot.exemptAmount) rows.push([t('reg.exempt'), money(tot.exemptAmount), 'sub']);
    $('#totals').replaceChildren(...rows.flatMap(([k, v, cls = '']) => [el('dt', { className: cls, textContent: k }), el('dd', { className: cls, textContent: v })]));
    const shift = currentShift();
    const closed = isDayClosed(today());
    $('#no-shift').hidden = !!shift;
    $('#pay').disabled = !cart.length || !shift || closed;
    $('#void-sale').disabled = !cart.length;
    $('#hold').disabled = !cart.length;
    $('#held-count').textContent = data.held.length ? `(${data.held.length})` : '';
    $('#recall').disabled = !data.held.length;
  }

  function resetSale() {
    cart = []; orderDiscountPct = 0;
    renderCart(); renderGrid();
  }

  // --------------------------------------------------------------- payment ---
  let payments = [];
  let payTotals = null;
  let ppPending = null;

  function openPayment() {
    if (!cart.length) return;
    if (!currentShift()) throw new Error(t('shift.needOpen'));
    ensureDayOpen();
    for (const l of cart) {
      const p = productById(l.id);
      if (!p || l.qty > p.stock) throw new Error(t('pay.stock', { name: l.name }));
    }
    payTotals = P.computeTotals(cart, orderDiscountPct, taxSpec());
    payments = [];
    closePromptPay();
    $('#add-promptpay').hidden = !promptPayOn();
    renderPayment();
    $('#pay-dialog').showModal();
    $('#pay-amount').select();
  }

  const paidSoFar = () => payments.reduce((a, p) => a + p.amount, 0);

  function renderPayment() {
    const due = payTotals.total - paidSoFar();
    $('#pay-total').textContent = money(payTotals.total);
    $('#pay-paid').textContent = money(paidSoFar());
    $('#pay-due-label').textContent = due > 0 ? t('pay.due') : t('pay.change');
    $('#pay-due').textContent = money(Math.abs(due));
    $('#pay-list').replaceChildren(...payments.map((p, i) => el('li', {},
      el('span', { textContent: `${t('method.' + p.method)} ${money(p.amount)}` }),
      el('button', { className: 'small ghost', textContent: t('reg.remove'), onclick: () => { payments.splice(i, 1); renderPayment(); } }))));
    $('#pay-amount').value = due > 0 ? (due / 10 ** decimals()).toFixed(decimals()) : '';
    for (const id of ['#add-cash', '#add-card', '#add-promptpay']) $(id).disabled = due <= 0;
    $('#pay-complete').disabled = due > 0 || !!ppPending;
    const quick = new Set();
    if (due > 0) {
      quick.add(due);
      for (const note of S().cashDenoms || []) {
        const v = Math.ceil(due / note) * note;
        if (v > due) quick.add(v);
      }
    }
    $('#quick-cash').replaceChildren(...[...quick].sort((a, b) => a - b).slice(0, 5).map(v => el('button', {
      textContent: v === due ? t('pay.exact', { amt: money(v) }) : money(v),
      onclick: guard(() => addPayment('cash', v)),
    })));
    if (due <= 0) $('#pay-complete').focus();
  }

  function enteredAmount() {
    const raw = $('#pay-amount').value.trim();
    if (!raw) throw new Error(t('pay.enterAmount'));
    const amount = parseAmount(raw);
    if (amount <= 0) throw new Error(t('err.payPositive'));
    return amount;
  }

  function addPayment(method, amount) {
    const due = payTotals.total - paidSoFar();
    if (amount == null) amount = enteredAmount();
    if (method !== 'cash' && amount > due) throw new Error(t('pay.nonCashMax', { method: t('method.' + method), amt: money(due) }));
    payments.push({ method, amount });
    renderPayment();
  }

  function drawQR(text) {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount(), q = 4, size = n + q * 2;
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q},${r + q}h1v1h-1z`;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'PromptPay QR');
    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', size); bg.setAttribute('height', size); bg.setAttribute('fill', '#fff');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d); path.setAttribute('fill', '#000');
    svg.append(bg, path);
    return svg;
  }

  function openPromptPay() {
    const due = payTotals.total - paidSoFar();
    const amount = enteredAmount();
    if (amount > due) throw new Error(t('pay.nonCashMax', { method: t('method.promptpay'), amt: money(due) }));
    const payload = P.promptPayPayload(S().promptpayId, amount);
    ppPending = amount;
    const id = S().promptpayId.replace(/\D/g, '');
    $('#pp-qr').replaceChildren(drawQR(payload));
    $('#pp-amount').textContent = money(amount);
    $('#pp-target').textContent = t('pp.to', { id: id.slice(0, -4).replace(/\d/g, 'x') + id.slice(-4) });
    $('#pay-entry').hidden = true;
    $('#pp-panel').hidden = false;
    $('#pay-complete').disabled = true;
    $('#pp-ok').focus();
  }

  function closePromptPay() {
    ppPending = null;
    $('#pp-panel').hidden = true;
    $('#pay-entry').hidden = false;
    $('#pp-qr').replaceChildren();
  }

  function completeSale() {
    const shift = currentShift();
    if (!shift) throw new Error(t('shift.noOpen'));
    ensureDayOpen();
    const s = S();
    const r = P.checkout({
      cart, products: data.products, orderDiscountPct, tax: taxSpec(), currency: s.currency,
      payments, cashier: user.name, shiftId: shift.id, id: peekId('sale', 'S', 6),
    });
    commitId('sale');
    r.sale.taxLabel = s.taxLabel;
    r.sale.seller = sellerSnapshot();
    data.products = r.products;
    upsertSale(r.sale);
    journalAdd('sale', { ref: r.sale.id, amount: r.sale.total, doc: r.sale });
    save();
    $('#pay-dialog').close();
    resetSale();
    renderAll();
    showDoc(receiptDoc(r.sale), { print: true });
    if (payments.some(p => p.method === 'cash')) kickDrawer();
    if (r.sale.change) toast(t('pay.changeDue', { amt: money(r.sale.change) }));
  }

  // ---------------------------------------------------------------- hold ---
  function holdSale() {
    if (!cart.length) return;
    data.held.push({ id: uid('h'), cart, orderDiscountPct, by: user.name, date: new Date().toISOString() });
    save(); resetSale(); toast(t('reg.held'));
  }

  async function recallSale() {
    if (cart.length) throw new Error(t('reg.holdFirst'));
    if (!data.held.length) return;
    const r = await ask({
      title: t('reg.recallTitle'),
      fields: [{ name: 'id', label: t('reg.heldSale'), type: 'select', options: data.held.map(h => ({
        value: h.id,
        label: `${new Date(h.date).toLocaleTimeString(S().locale)} · ${h.by} · ${t('reg.heldItems', { n: h.cart.reduce((a, l) => a + l.qty, 0) })}`,
      })) }],
    });
    if (!r) return;
    const h = data.held.find(x => x.id === r.id);
    if (!h) return;
    cart = h.cart.map(l => { const p = productById(l.id); return p && { ...l, name: p.name, price: p.price, taxable: p.taxable !== false }; }).filter(Boolean);
    orderDiscountPct = h.orderDiscountPct;
    data.held = data.held.filter(x => x.id !== h.id);
    save(); renderCart(); renderGrid();
    if (cart.length < h.cart.length) toast(t('reg.heldRemoved'), true);
  }

  // ---------------------------------------------------------------- sales ---
  function reprint(kind, sale, lines) {
    journalAdd('reprint', { ref: kind === 'invoice' ? sale.fullInvoice.no : kind === 'credit' ? sale.refund.id : sale.id, doc: { kind, saleId: sale.id } });
    save();
    showDoc(lines);
  }

  function renderSales() {
    const q = $('#sale-search').value.trim().toLowerCase();
    const list = data.sales.filter(s => !q || s.id.toLowerCase().includes(q) || (s.cashier || '').toLowerCase().includes(q) ||
      (s.fullInvoice && s.fullInvoice.no.toLowerCase().includes(q)) || (s.refund && s.refund.id && s.refund.id.toLowerCase().includes(q)));
    const tb = $('#sale-rows');
    tb.replaceChildren();
    if (!list.length) tb.append(el('tr', {}, el('td', { colSpan: 7, className: 'muted', textContent: t('sales.none') })));
    const shift = currentShift();
    for (const sale of list.slice(0, 500)) {
      const m = moneyIn(sale.currency);
      const seller = sale.seller || sellerSnapshot();
      const status = P.saleStatus(sale);
      const tender = Object.keys(P.saleTenders(sale)).map(k => t('method.' + k)).join(' + ');
      const actions = el('td', { className: 'actions' },
        el('button', { className: 'small', textContent: t('sales.receipt'), onclick: guard(() => reprint('receipt', sale, receiptDoc(sale, 'copy'))) }));
      if (sale.voided) actions.append(el('button', { className: 'small', textContent: t('sales.voidDoc'), onclick: guard(() => reprint('void', sale, voidDoc(sale, 'copy'))) }));
      if (sale.fullInvoice) actions.append(el('button', { className: 'small', textContent: sale.fullInvoice.no, onclick: guard(() => reprint('invoice', sale, invoiceDoc(sale, 'copy'))) }));
      else if (isThaiVat(seller) && status === 'completed') actions.append(el('button', { className: 'small', textContent: t('sales.taxInvoice'), onclick: guard(() => issueInvoice(sale.id)) }));
      if (sale.refunded) actions.append(el('button', { className: 'small', textContent: wasTaxInvoice(sale) ? t('sales.creditNote') : t('sales.refundDoc'), onclick: guard(() => reprint('credit', sale, refundDoc(sale, 'copy'))) }));
      else if (!sale.voided) {
        if (!sale.fullInvoice && shift && sale.shiftId === shift.id && !isDayClosed(localDay(sale.date))) {
          actions.append(el('button', { className: 'small danger', textContent: t('sales.void'), onclick: guard(() => voidFlow(sale.id)) }));
        }
        actions.append(el('button', { className: 'small danger', textContent: t('sales.refund'), onclick: guard(() => refundSale(sale.id)) }));
      }
      tb.append(el('tr', { className: sale.refunded || sale.voided ? 'refunded' : '' },
        el('td', { textContent: sale.id }), el('td', { textContent: fmtDate(sale.date) }),
        el('td', { textContent: sale.cashier || '—' }), el('td', { textContent: tender }),
        el('td', { className: 'num', textContent: m(sale.total) }),
        el('td', { textContent: t('status.' + status) }),
        actions));
    }
  }

  async function voidFlow(id) {
    const sale = data.sales.find(s => s.id === id);
    const shift = currentShift();
    if (!shift || sale.shiftId !== shift.id) throw new Error(t('void.otherShift'));
    if (isDayClosed(localDay(sale.date))) throw new Error(t('void.dayClosed'));
    const m = moneyIn(sale.currency);
    const mgr = await managerApproval(t('void.approve', { id: sale.id, amt: m(sale.total) }));
    if (!mgr) return;
    const r0 = await ask({ title: t('void.title', { id: sale.id }), text: t('void.text', { amt: m(sale.total) }), ok: t('sales.void'),
      fields: [{ name: 'reason', label: t('refund.reason') }] });
    if (!r0) return;
    checkClock();
    const r = P.voidSale(sale, data.products, { by: mgr.name, reason: r0.reason });
    data.products = r.products;
    upsertSale(r.sale);
    journalAdd('void', { ref: sale.id, amount: -sale.total, doc: { saleId: sale.id, voided: r.sale.voided } });
    save(); renderAll(); toast(t('void.done'));
    showDoc(voidDoc(r.sale), { print: true });
    if (P.saleTenders(sale).cash) kickDrawer();
  }

  async function issueInvoice(id) {
    const sale = data.sales.find(s => s.id === id);
    if (!sale) return;
    const status = P.saleStatus(sale);
    if (status !== 'completed') throw new Error(t('inv.notAllowed'));
    const seller = sale.seller || sellerSnapshot();
    if (!isThaiVat(seller)) throw new Error(t('inv.needSeller'));
    if (!(seller.header || '').trim()) throw new Error(t('inv.needAddress'));
    // The full invoice carries the sale's date; it must be issued within the
    // same tax month so the VAT return is not affected.
    if (localDay(sale.date).slice(0, 7) !== today().slice(0, 7)) throw new Error(t('inv.month'));
    ensureDayOpen();
    const r = await ask({
      title: t('inv.title'), text: `${sale.id} · ${moneyIn(sale.currency)(sale.total)}`,
      fields: [
        { name: 'name', label: t('inv.buyer') }, { name: 'address', label: t('inv.address') },
        { name: 'taxId', label: t('inv.taxId'), inputmode: 'numeric' }, { name: 'branch', label: t('inv.branch'), value: HEAD_OFFICE },
      ],
    });
    if (!r) return;
    const buyer = { name: r.name.trim(), address: r.address.trim(), taxId: r.taxId.replace(/[\s-]/g, ''), branch: r.branch.trim() };
    if (!buyer.name || !buyer.address) throw new Error(t('inv.required'));
    if (buyer.taxId && !P.isValidThaiTaxId(buyer.taxId)) throw new Error(t('inv.badTaxId'));
    if (buyer.taxId && !validBranch(buyer.branch)) throw new Error(t('inv.badBranch'));
    if (!buyer.taxId) buyer.branch = '';
    checkClock();
    const fullInvoice = { no: peekId('inv', 'INV', 6), date: sale.date, issuedAt: new Date().toISOString(), buyer, by: user.name };
    commitId('inv');
    const updated = { ...sale, fullInvoice };
    upsertSale(updated);
    journalAdd('invoice', { ref: fullInvoice.no, amount: sale.total, doc: { saleId: sale.id, fullInvoice } });
    save(); renderAll();
    showDoc(invoiceDoc(updated), { print: true });
  }

  async function refundSale(id) {
    const shift = currentShift();
    if (!shift) throw new Error(t('refund.needShift'));
    const sale = data.sales.find(s => s.id === id);
    if ((sale.currency || 'USD') !== (shift.currency || 'USD')) throw new Error(t('refund.curMismatch', { cur: sale.currency || 'USD' }));
    ensureDayOpen();
    const m = moneyIn(sale.currency);
    const cash = P.saleTenders(sale).cash || 0;
    if (cash > P.shiftReport(shift, data.sales).expectedCash) throw new Error(t('refund.noCash'));
    const mgr = await managerApproval(t('refund.approve', { id: sale.id, amt: m(sale.total) }));
    if (!mgr) return;
    const r0 = await ask({
      title: t('refund.title'), text: t('refund.text', { amt: m(sale.total) }) + (cash ? t('refund.cashPart', { amt: m(cash) }) : ''),
      ok: t('btn.confirm'), fields: [{ name: 'reason', label: t('refund.reason') }],
    });
    if (!r0) return;
    const reason = r0.reason.trim();
    if (!reason) throw new Error(t('err.reason'));
    checkClock();
    const credit = wasTaxInvoice(sale);
    // Credit notes and refund slips are separate numbered series.
    const kind = credit ? 'cn' : 'refund';
    const r = P.refund(sale, data.products, { by: mgr.name, shiftId: shift.id, id: peekId(kind, credit ? 'CN' : 'RF', 6) });
    commitId(kind);
    r.sale.refund.reason = reason;
    data.products = r.products;
    upsertSale(r.sale);
    journalAdd('refund', { ref: r.sale.refund.id, amount: -sale.total, doc: { saleId: sale.id, refund: r.sale.refund } });
    save(); renderAll(); toast(t('refund.done'));
    showDoc(refundDoc(r.sale), { print: true });
    if (cash) kickDrawer();
  }

  // ---------------------------------------------------------------- shift ---
  function kpi(label, value) {
    return el('div', {}, el('span', { textContent: label }), el('strong', { textContent: String(value) }));
  }

  function renderShift() {
    const shift = currentShift();
    const panel = $('#shift-panel');
    panel.replaceChildren();
    const badge = $('#shift-badge');
    badge.textContent = shift ? t('shift.badgeOpen', { id: shift.id }) : t('shift.badgeNone');
    badge.className = 'badge ' + (shift ? 'ok' : 'warn');
    if (!shift) {
      panel.append(el('div', { className: 'shift-box' },
        el('p', { textContent: t('shift.none') }),
        el('button', { className: 'primary big', textContent: t('shift.open'), onclick: guard(openShiftFlow) })));
    } else {
      const m = moneyIn(shift.currency);
      const r = P.shiftReport(shift, data.sales);
      const nonCash = Object.entries(r.salesBy).filter(([k]) => k !== 'cash').reduce((a, [, v]) => a + v, 0) -
        Object.entries(r.refundsBy).filter(([k]) => k !== 'cash').reduce((a, [, v]) => a + v, 0);
      panel.append(el('div', { className: 'shift-box' },
        el('p', { textContent: t('shift.info', { id: shift.id, date: fmtDate(shift.openedAt), name: shift.openedBy }) }),
        el('div', { className: 'kpis' },
          kpi(t('shift.transactions'), r.transactions), kpi(t('shift.netSales'), m(r.netSales)),
          kpi(t('shift.nonCash'), m(nonCash)), kpi(t('shift.expected'), m(r.expectedCash))),
        el('div', { className: 'row wrap' },
          el('button', { textContent: t('shift.payIn'), onclick: guard(() => movementFlow('in')) }),
          el('button', { textContent: t('shift.payOut'), onclick: guard(() => movementFlow('out')) }),
          el('button', { textContent: t('shift.x'), onclick: () => showDoc(shiftDoc(shift, false)) }),
          native && hw && hw.drawer.mode !== 'none' ? el('button', { textContent: t('hw.noSale'), onclick: guard(noSaleFlow) }) : null,
          el('button', { className: 'danger', textContent: t('shift.close'), onclick: guard(closeShiftFlow) }))));
    }
    const tb = $('#shift-rows');
    tb.replaceChildren();
    const closed = data.shifts.filter(s => s.closedAt).slice().reverse();
    if (!closed.length) tb.append(el('tr', {}, el('td', { colSpan: 8, className: 'muted', textContent: t('shift.noneClosed') })));
    for (const s of closed.slice(0, 100)) {
      const r = s.report, m = moneyIn(s.currency);
      tb.append(el('tr', {},
        el('td', { textContent: fmtDate(s.openedAt) }), el('td', { textContent: fmtDate(s.closedAt) }),
        el('td', { textContent: s.openedBy }), el('td', { className: 'num', textContent: m(r.netSales) }),
        el('td', { className: 'num', textContent: m(r.expectedCash) }), el('td', { className: 'num', textContent: m(r.counted) }),
        el('td', { className: 'num ' + (r.variance < 0 ? 'neg' : r.variance > 0 ? 'pos' : ''), textContent: m(r.variance) }),
        el('td', {}, el('button', { className: 'small', textContent: t('shift.z'), onclick: () => showDoc(shiftDoc(s, true)) }))));
    }
    renderDayClose();
  }

  function renderDayClose() {
    const panel = $('#day-panel');
    const d = today();
    const closed = isDayClosed(d);
    panel.replaceChildren(el('div', { className: 'shift-box' },
      el('p', { textContent: closed ? t('day.todayClosed', { day: fmtDay(d) }) : t('day.todayOpen', { day: fmtDay(d) }) }),
      el('div', { className: 'row wrap' },
        el('button', { textContent: t('day.preview'), disabled: closed, onclick: guard(() => {
          const summary = P.daySummary({ sales: data.sales, day: d, dayOf: localDay });
          showDoc(zDoc({ day: d, summary, currency: S().currency, taxLabel: S().taxLabel, taxRateBp: S().taxRateBp }, 'preview'));
        }) }),
        isManager() ? el('button', { className: 'danger', textContent: t('day.close'), disabled: closed, onclick: guard(closeTodayFlow) }) : null)));
    const tb = $('#z-rows');
    tb.replaceChildren();
    const list = data.zReports.slice().reverse();
    if (!list.length) tb.append(el('tr', {}, el('td', { colSpan: 7, className: 'muted', textContent: t('day.none') })));
    for (const z of list.slice(0, 400)) {
      const m = moneyIn(z.currency);
      tb.append(el('tr', {},
        el('td', { textContent: z.no }), el('td', { textContent: fmtDay(z.day) }),
        el('td', { textContent: z.summary.firstNo ? `${z.summary.firstNo} – ${z.summary.lastNo}` : '-' }),
        el('td', { className: 'num', textContent: m(z.summary.net) }), el('td', { className: 'num', textContent: m(z.summary.tax - z.summary.cnTax) }),
        el('td', { textContent: z.auto ? t('day.auto') : z.by || '' }),
        el('td', {}, el('button', { className: 'small', textContent: t('sales.receipt'), onclick: guard(() => {
          journalAdd('reprint', { ref: z.no, doc: { kind: 'z' } }); save(); showDoc(zDoc(z, 'copy'));
        }) }))));
    }
  }

  async function closeTodayFlow() {
    if (!isManager()) return;
    checkClock();
    autoCloseDays();
    const d = today();
    if (currentShift() && !(await confirmBox(t('day.close'), t('day.shiftOpenWarn')))) return;
    if (!(await confirmBox(t('day.close'), t('day.closeText', { day: fmtDay(d) })))) return;
    const z = closeDay(d, false);
    save(); renderAll();
    showDoc(zDoc(z), { print: true });
    autoBackup();
  }

  // Open the drawer without a sale: needs a manager and is journaled.
  async function noSaleFlow() {
    const shift = currentShift();
    if (!shift) throw new Error(t('shift.noOpen'));
    const r = await ask({ title: t('hw.noSale'), ok: t('hw.noSale'), fields: [{ name: 'reason', label: t('shift.reason') }] });
    if (!r) return;
    if (!r.reason.trim()) throw new Error(t('err.reason'));
    const m = await managerApproval(t('hw.noSale') + ': ' + r.reason.trim());
    if (!m) return;
    journalAdd('drawer', { ref: shift.id, doc: { reason: r.reason.trim(), approvedBy: m.name } });
    save();
    await kickDrawer();
  }

  async function openShiftFlow() {
    if (currentShift()) throw new Error(t('shift.alreadyOpen'));
    const r = await ask({ title: t('shift.open'), text: t('shift.openText'), ok: t('shift.open'),
      fields: [{ name: 'float', label: t('shift.float'), inputmode: 'decimal', value: '0' }] });
    if (!r) return;
    checkClock();
    const shift = P.openShift({ id: peekId('shift', 'SH', 4), cashier: user.name, float: parseAmount(r.float), currency: S().currency });
    commitId('shift');
    data.shifts.push(shift);
    data.currentShiftId = shift.id;
    journalAdd('shift-open', { ref: shift.id, amount: shift.float });
    save(); renderAll(); showView('register'); toast(t('shift.opened', { id: shift.id }));
    kickDrawer();
  }

  async function movementFlow(type) {
    const shift = currentShift();
    if (!shift) throw new Error(t('shift.noOpen'));
    const r = await ask({ title: t(type === 'in' ? 'shift.payInTitle' : 'shift.payOutTitle'), ok: t('shift.record'),
      fields: [{ name: 'amount', label: t('shift.amount'), inputmode: 'decimal' }, { name: 'reason', label: t('shift.reason') }] });
    if (!r) return;
    const amount = parseAmount(r.amount);
    if (type === 'out') {
      if (amount > P.shiftReport(shift, data.sales).expectedCash) throw new Error(t('shift.outTooMuch'));
      const m = await managerApproval(t('shift.payOutApprove', { amt: money(amount), reason: r.reason }));
      if (!m) return;
    }
    const updated = P.addMovement(shift, { type, amount, reason: r.reason, by: user.name });
    data.shifts = data.shifts.map(s => (s.id === shift.id ? updated : s));
    journalAdd(type === 'in' ? 'pay-in' : 'pay-out', { ref: shift.id, amount, doc: { reason: r.reason.trim() } });
    save(); renderAll(); toast(t('shift.recorded'));
    kickDrawer();
  }

  async function closeShiftFlow() {
    const shift = currentShift();
    if (!shift) return;
    if (data.held.length && !(await confirmBox(t('shift.heldTitle'), t('shift.heldText', { n: data.held.length })))) return;
    kickDrawer(); // open the drawer so the cash can be counted
    const r = await ask({ title: t('shift.close'), text: t('shift.closeText'), ok: t('shift.close'),
      fields: [{ name: 'counted', label: t('shift.counted'), inputmode: 'decimal' }] });
    if (!r) return;
    const closed = P.closeShift(shift, data.sales, parseAmount(r.counted), { by: user.name });
    data.shifts = data.shifts.map(s => (s.id === shift.id ? closed : s));
    data.currentShiftId = null;
    journalAdd('shift-close', { ref: shift.id, amount: closed.counted, doc: { expected: closed.report.expectedCash, variance: closed.report.variance } });
    save(); renderAll();
    showDoc(shiftDoc(closed, true), { print: true });
  }

  // -------------------------------------------------------------- reports ---
  function reportRange() {
    const f = $('#rep-from').value, to = $('#rep-to').value;
    const range = {};
    if (f) range.from = parseDay(f).toISOString();
    if (to) { const d = parseDay(to); d.setDate(d.getDate() + 1); range.to = d.toISOString(); }
    return range;
  }

  function renderReports() {
    const range = reportRange();
    const r = P.salesReport(data.sales, { ...range, currency: S().currency });
    const all = P.salesReport(data.sales, range);
    const other = (all.count + all.refunds + all.voids) - (r.count + r.refunds + r.voids);
    $('#rep-note').textContent = other ? t('rep.otherCur', { n: other }) : '';
    $('#rep-kpis').replaceChildren(
      kpi(t('rep.revenue'), money(r.revenue)), kpi(t('rep.transactions'), r.count), kpi(t('rep.average'), money(r.average)),
      kpi(t('rep.items'), r.items), kpi(t('rep.tax'), money(r.tax)), kpi(t('rep.discounts'), money(r.discounts)),
      kpi(t('rep.refunds'), r.refunds), kpi(t('rep.voids'), r.voids));
    $('#rep-products').replaceChildren(...(r.topProducts.length ? r.topProducts.slice(0, 20).map(p => el('tr', {},
      el('td', { textContent: p.name }), el('td', { className: 'num', textContent: String(p.qty) }), el('td', { className: 'num', textContent: money(p.net) })))
      : [el('tr', {}, el('td', { colSpan: 3, className: 'muted', textContent: t('rep.none') }))]));
    const methods = P.METHODS.filter(k => k !== 'promptpay' || r.byMethod.promptpay || promptPayOn());
    $('#rep-methods').replaceChildren(...methods.map(k => el('tr', {},
      el('td', { textContent: t('method.' + k) }), el('td', { className: 'num', textContent: money(r.byMethod[k] || 0) }))));
    $('#rep-cashiers').replaceChildren(...Object.entries(r.byCashier).sort((a, b) => b[1].total - a[1].total).map(([n, v]) => el('tr', {},
      el('td', { textContent: n }), el('td', { className: 'num', textContent: String(v.count) }), el('td', { className: 'num', textContent: money(v.total) }))));
    $('#otr-box').hidden = !isThaiVat(S());
    if (!$('#otr-month').value) $('#otr-month').value = today().slice(0, 7);
  }

  function setRange(days) {
    const to = new Date(), from = new Date();
    from.setDate(from.getDate() - (days - 1));
    $('#rep-from').value = dayInput(from);
    $('#rep-to').value = dayInput(to);
    renderReports();
  }

  // Monthly output tax report (รายงานภาษีขาย), laid out like the Revenue
  // Department form, for A4 printing.
  function outputTaxData() {
    const month = $('#otr-month').value;
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(t('otr.pickMonth'));
    return P.outputTaxReport({ sales: data.sales, month, dayOf: localDay, currency: S().currency });
  }

  const otrBuyer = r => (r.type === 'abb' ? 'ขายปลีก (ใบกำกับภาษีอย่างย่อ)' : r.type === 'receipt' ? 'ขายปลีก (ไม่ได้ออกใบกำกับภาษี)' : r.buyer || (r.type === 'credit' ? `ใบลดหนี้ อ้างอิง ${r.ref}` : ''));
  const otrBranch = r => (!r.buyerTaxId ? '' : !r.buyerBranch || r.buyerBranch === HEAD_OFFICE ? 'สำนักงานใหญ่' : `สาขาที่ ${r.buyerBranch}`);
  const otrNote = r => [
    ...(r.excluded || []).map(x => (x.why === 'voided' ? `ไม่รวม ${x.id} (ยกเลิก)` : `ไม่รวม ${x.id} (ออก ${x.invoice} แทน)`)),
    r.type === 'invoice' ? `แทน ${r.ref}` : '', r.type === 'credit' ? `อ้างอิง ${r.ref}` : '',
  ].filter(Boolean).join('; ');

  function printOutputTax() {
    const rep = outputTaxData();
    const s = S();
    const d = decimals();
    const num = v => (v / 10 ** d).toLocaleString('th-TH', { minimumFractionDigits: d, maximumFractionDigits: d });
    const [y, mo] = rep.month.split('-').map(Number);
    const monthName = new Date(y, mo - 1, 1).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });
    const head = el('div', { className: 'rp-head' },
      el('h1', { textContent: 'รายงานภาษีขาย' }),
      el('div', { textContent: `เดือนภาษี ${monthName}` }),
      el('div', { textContent: `ชื่อผู้ประกอบการ ${s.storeName}` }),
      el('div', { textContent: `เลขประจำตัวผู้เสียภาษีอากร ${s.taxId}` }),
      el('div', { textContent: `ชื่อสถานประกอบการ ${s.storeName}   ${!s.branch || s.branch === HEAD_OFFICE ? '☑ สำนักงานใหญ่' : '☑ สาขาที่ ' + s.branch}` }),
      s.posRegNo ? el('div', { textContent: `หมายเลขเครื่องบันทึกการเก็บเงิน ${s.posRegNo}` }) : null);
    const cols = ['ลำดับที่', 'วัน เดือน ปี', 'เลขที่ใบกำกับภาษี', 'ชื่อผู้ซื้อสินค้า/ผู้รับบริการ', 'เลขประจำตัวผู้เสียภาษีอากรของผู้ซื้อ', 'สถานประกอบการ', 'มูลค่าสินค้าหรือบริการ', 'จำนวนเงินภาษีมูลค่าเพิ่ม', 'สินค้ายกเว้นภาษี', 'หมายเหตุ'];
    const table = el('table', { className: 'rp-table' },
      el('thead', {}, el('tr', {}, ...cols.map(c => el('th', { textContent: c })))),
      el('tbody', {}, ...rep.rows.map((r, i) => el('tr', {},
        el('td', { textContent: String(i + 1) }), el('td', { textContent: fmtDay(r.day) }), el('td', { textContent: r.docNo }),
        el('td', { textContent: otrBuyer(r) }), el('td', { textContent: r.buyerTaxId }), el('td', { textContent: otrBranch(r) }),
        el('td', { className: 'num', textContent: num(r.taxBase) }), el('td', { className: 'num', textContent: num(r.tax) }),
        el('td', { className: 'num', textContent: num(r.exempt) }), el('td', { textContent: otrNote(r) })))),
      el('tfoot', {}, el('tr', {}, el('td', { colSpan: 6, textContent: 'รวม' }),
        el('td', { className: 'num', textContent: num(rep.totals.taxBase) }), el('td', { className: 'num', textContent: num(rep.totals.tax) }),
        el('td', { className: 'num', textContent: num(rep.totals.exempt) }), el('td', {}))));
    const pp30 = el('div', { className: 'rp-summary' },
      el('h2', { textContent: 'สรุปยอดสำหรับกรอกแบบ ภ.พ.30 (โปรดตรวจสอบกับผู้ทำบัญชี)' }),
      el('div', { textContent: `ยอดขายในเดือนนี้: ${num(rep.totals.taxBase + rep.totals.exempt)}` }),
      el('div', { textContent: `ยอดขายที่ได้รับยกเว้น: ${num(rep.totals.exempt)}` }),
      el('div', { textContent: `ยอดขายที่ต้องเสียภาษี: ${num(rep.totals.taxBase)}` }),
      el('div', { textContent: `ภาษีขายเดือนนี้: ${num(rep.totals.tax)}` }));
    printPage([head, table, pp30, el('p', { className: 'rp-foot', textContent: `${APP_NAME} ${APP_VERSION} · พิมพ์เมื่อ ${fmtDate(new Date().toISOString())}` })]);
  }

  function csvOutputTax() {
    const rep = outputTaxData();
    const d = decimals();
    const num = v => (v / 10 ** d).toFixed(d);
    const rows = [['ลำดับที่', 'วันที่', 'เลขที่ใบกำกับภาษี', 'ชื่อผู้ซื้อ', 'เลขประจำตัวผู้เสียภาษีผู้ซื้อ', 'สถานประกอบการ', 'มูลค่าสินค้าหรือบริการ', 'ภาษีมูลค่าเพิ่ม', 'สินค้ายกเว้นภาษี', 'หมายเหตุ']];
    rep.rows.forEach((r, i) => rows.push([i + 1, r.day, r.docNo, otrBuyer(r), r.buyerTaxId, otrBranch(r), num(r.taxBase), num(r.tax), num(r.exempt), otrNote(r)]));
    rows.push(['', '', '', 'รวม', '', '', num(rep.totals.taxBase), num(rep.totals.tax), num(rep.totals.exempt), '']);
    download(`output-tax-${rep.month}.csv`, '﻿' + P.toCSV(rows), 'text/csv;charset=utf-8');
  }

  // Print an A4 page (reports) instead of a receipt.
  function printPage(nodes) {
    const box = $('#report-print');
    box.replaceChildren(...nodes.filter(Boolean));
    if (native) {
      native.print('report', box.innerHTML).then(r => { if (!r.ok && r.error !== 'cancelled') toast(t('hw.printFailed', { err: r.error }), true); });
      return;
    }
    document.body.classList.add('print-report');
    const done = () => { document.body.classList.remove('print-report'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
    setTimeout(done, 1000);
  }

  // ------------------------------------------------ ภ.พ.06 application pack ---
  function pp06Pack() {
    const s = S();
    if (!isThaiVat(s)) throw new Error(t('inv.needSeller'));
    const products = data.products.slice(0, 2);
    const cart = products.reduce((c, p) => P.addToCart(c, { ...p, stock: 99 }), []);
    const tot = P.computeTotals(cart, 0, taxSpec());
    const sample = {
      ...P.checkout({ cart, products: products.map(p => ({ ...p, stock: 99 })), tax: taxSpec(), currency: s.currency,
        payments: [{ method: 'cash', amount: tot.total }], cashier: user.name, id: 'S000000' }).sale,
      taxLabel: s.taxLabel, seller: { ...sellerSnapshot(), posRegNo: s.posRegNo || '(หมายเลขที่ได้รับอนุมัติ)' },
    };
    const sampleZ = {
      no: 'Z0000', day: today(), closedAt: new Date().toISOString(), by: user.name, currency: s.currency, taxLabel: s.taxLabel, taxRateBp: s.taxRateBp,
      seller: sample.seller, summary: P.daySummary({ sales: [sample], day: localDay(sample.date), dayOf: localDay }), gtBefore: 0, gtAfter: sample.total,
      journalSeq: 0, journalHash: '',
    };
    const spec = [
      ['ชื่อโปรแกรม / รุ่น', `${APP_NAME} เวอร์ชัน ${APP_VERSION}`],
      ['ประเภท', 'โปรแกรมขายหน้าร้าน (POS) ทำงานบนเว็บเบราว์เซอร์ บันทึกข้อมูลในเครื่อง (ทำงานได้โดยไม่ต้องต่ออินเทอร์เน็ต)'],
      ['ยี่ห้อ / รุ่นเครื่อง', `${s.machineBrand || '-'} / ${s.machineModel || '-'}`],
      ['หมายเลขประจำเครื่อง (Serial No.)', s.machineSerial || '-'],
      ['เครื่องพิมพ์', 'เครื่องพิมพ์ใบเสร็จความร้อน กระดาษม้วนกว้าง 80 มม.'],
      ['ภาษาที่ใช้ในการออกใบกำกับภาษี', 'ภาษาไทย (มีภาษาอังกฤษประกอบ) สกุลเงินบาท'],
      ['เลขที่ใบกำกับภาษีอย่างย่อ', 'เรียงลำดับต่อเนื่อง ไม่ซ้ำ ไม่สามารถแก้ไขหรือลบได้ (S000001, S000002, ...)'],
      ['การบันทึกรายการ (Journal)', 'บันทึกสำเนาเอกสารทุกฉบับในบันทึกรายการอิเล็กทรอนิกส์ เรียงลำดับ ป้องกันการแก้ไขด้วยค่าแฮช SHA-256 แบบต่อเนื่อง'],
      ['รายงานสรุปยอดขายประจำวัน', 'พิมพ์รายงาน Z แยกตามวันและเครื่อง แสดงเลขที่เริ่มต้น-สิ้นสุด มูลค่าก่อน VAT, VAT, ยอดยกเว้น, การยกเลิก, ใบลดหนี้ และยอดขายสะสม'],
      ['การยกเลิกใบกำกับภาษีอย่างย่อ', 'ต้องได้รับอนุมัติจากผู้จัดการและระบุเหตุผล เอกสารที่ยกเลิกยังคงอยู่ในระบบและแสดงในรายงานประจำวัน'],
      ['ใบกำกับภาษีเต็มรูป / ใบลดหนี้', 'ออกได้จากระบบ โดยอ้างอิงเลขที่ใบกำกับภาษีอย่างย่อเดิม'],
      ['การเก็บรักษาข้อมูล', 'เก็บในเครื่อง และสำรองข้อมูลเป็นไฟล์ เก็บรักษาไม่น้อยกว่า 5 ปี'],
    ];
    const attach = [
      'แบบ ภ.พ.06 (ยื่นแยกเป็นรายสถานประกอบการ)',
      'เอกสารฉบับนี้: คุณสมบัติโดยย่อของเครื่องบันทึกการเก็บเงิน',
      'ตัวอย่างใบกำกับภาษีอย่างย่อ และตัวอย่างรายงานสรุปยอดขายประจำวัน (ด้านล่าง)',
      'แผนผังแสดงตำแหน่งการวางเครื่องบันทึกการเก็บเงิน (จัดทำเอง)',
      'แผนผังระบบการต่อเชื่อมเครื่องกับอุปกรณ์อื่น เช่น เครื่องพิมพ์ ลิ้นชักเงินสด (จัดทำเอง)',
    ];
    const receipt = lines => el('div', { className: 'receipt rp-receipt' }, ...renderDocLines(lines));
    printPage([
      el('div', { className: 'rp-head' }, el('h1', { textContent: 'คุณสมบัติโดยย่อของเครื่องบันทึกการเก็บเงิน' }),
        el('div', { textContent: `ผู้ประกอบการ ${s.storeName} · เลขประจำตัวผู้เสียภาษีอากร ${s.taxId} · ${!s.branch || s.branch === HEAD_OFFICE ? 'สำนักงานใหญ่' : 'สาขาที่ ' + s.branch}` })),
      el('table', { className: 'rp-table' }, el('tbody', {}, ...spec.map(([k, v]) => el('tr', {}, el('th', { textContent: k }), el('td', { textContent: v }))))),
      el('h2', { textContent: 'เอกสารที่ต้องยื่นประกอบ' }),
      el('ol', {}, ...attach.map(a => el('li', { textContent: a }))),
      el('div', { className: 'rp-samples' }, receipt(receiptDoc(sample, 'sample')), receipt(zDoc(sampleZ, 'sample'))),
    ]);
  }

  // ------------------------------------------------------------- journal ---
  function renderJournal() {
    integrity = P.verifyJournal(data.journal);
    const badge = $('#journal-status');
    badge.textContent = integrity.ok ? t('journal.ok', { n: integrity.count }) : t('alert.integrity', { seq: integrity.seq });
    badge.className = 'alert ' + (integrity.ok ? 'ok' : 'danger');
    const day = $('#journal-day').value;
    const list = data.journal.filter(e => !day || localDay(e.at) === day).slice().reverse().slice(0, 1000);
    const tb = $('#journal-rows');
    tb.replaceChildren();
    if (!list.length) tb.append(el('tr', {}, el('td', { colSpan: 7, className: 'muted', textContent: t('journal.none') })));
    for (const e of list) {
      const viewable = (e.type === 'sale' || e.type === 'z') && e.doc;
      tb.append(el('tr', {},
        el('td', { textContent: String(e.seq) }), el('td', { textContent: fmtDate(e.at) }),
        el('td', { textContent: t('jtype.' + e.type) }), el('td', { textContent: e.ref || '' }),
        el('td', { className: 'num', textContent: e.amount != null ? money(e.amount) : '' }),
        el('td', { textContent: e.by || '' }),
        el('td', { className: 'mono', textContent: e.hash.slice(0, 10) },
          viewable ? el('button', { className: 'small', textContent: t('journal.view'), onclick: () => showDoc(e.type === 'z' ? zDoc(e.doc, 'journal') : receiptDoc(e.doc, 'journal')) }) : null)));
    }
    renderAlerts();
  }

  // ------------------------------------------------------------- products ---
  function renderProducts() {
    const q = $('#product-filter').value.trim().toLowerCase();
    const lowOnly = $('#low-only').checked;
    const list = data.products.filter(p => (!q || `${p.sku} ${p.name} ${p.category}`.toLowerCase().includes(q)) && (!lowOnly || p.stock <= (p.lowStock || 0)));
    const tb = $('#product-rows');
    tb.replaceChildren();
    if (!list.length) tb.append(el('tr', {}, el('td', { colSpan: 7, className: 'muted', textContent: t('prod.none') })));
    for (const p of list) {
      tb.append(el('tr', {},
        el('td', { textContent: p.sku }), el('td', { textContent: p.name }), el('td', { textContent: p.category || 'General' }),
        el('td', { className: 'num', textContent: money(p.price) }),
        el('td', { textContent: p.taxable === false ? t('prod.exempt') : t('prod.taxable') }),
        el('td', { className: 'num' + (p.stock <= (p.lowStock || 0) ? ' low' : ''), textContent: String(p.stock) }),
        el('td', { className: 'actions' },
          el('button', { className: 'small', textContent: t('btn.edit'), onclick: () => editProduct(p) }),
          el('button', { className: 'small', textContent: t('prod.receive'), onclick: guard(() => receiveStock(p.id)) }),
          el('button', { className: 'small danger', textContent: t('btn.delete'), onclick: guard(() => deleteProduct(p.id)) }))));
    }
  }

  function editProduct(p) {
    const f = $('#product-form');
    const d = decimals();
    f.elements.id.value = p.id; f.sku.value = p.sku; f.elements.name.value = p.name; f.category.value = p.category || '';
    f.price.value = (p.price / 10 ** d).toFixed(d); f.stock.value = p.stock; f.lowStock.value = p.lowStock || 0;
    f.taxable.checked = p.taxable !== false;
    f.sku.focus();
  }

  async function receiveStock(id) {
    const p = productById(id);
    const r = await ask({ title: t('prod.receiveTitle', { name: p.name }), text: t('prod.current', { n: p.stock }), ok: t('prod.add'),
      fields: [{ name: 'qty', label: t('prod.qtyReceived'), type: 'number' }] });
    if (!r) return;
    const qty = Number(r.qty);
    if (!Number.isInteger(qty) || qty <= 0) throw new Error(t('prod.qtyErr'));
    data.products = data.products.map(x => (x.id === id ? { ...x, stock: x.stock + qty } : x));
    data.sampleCatalog = false;
    save(); renderAll(); toast(t('prod.received', { name: p.name, n: p.stock + qty }));
  }

  async function deleteProduct(id) {
    const p = productById(id);
    if (!(await confirmBox(t('prod.deleteTitle'), t('prod.deleteText', { name: p.name })))) return;
    data.products = data.products.filter(x => x.id !== id);
    data.sampleCatalog = false;
    cart = cart.filter(l => l.id !== id);
    save(); renderAll();
  }

  function saveProduct(e) {
    e.preventDefault();
    const f = e.target;
    const id = f.elements.id.value;
    const sku = f.sku.value.trim(), name = f.elements.name.value.trim(), cat = f.category.value.trim() || 'General';
    const stock = Number(f.stock.value), lowStock = f.lowStock.value === '' ? 0 : Number(f.lowStock.value);
    const taxable = f.taxable.checked;
    if (!sku || !name) throw new Error(t('prod.required'));
    if (!Number.isInteger(stock) || stock < 0) throw new Error(t('prod.stockErr'));
    if (!Number.isInteger(lowStock) || lowStock < 0) throw new Error(t('prod.lowErr'));
    const price = parseAmount(f.price.value);
    if (data.products.some(p => p.sku.toLowerCase() === sku.toLowerCase() && p.id !== id)) throw new Error(t('prod.skuExists'));
    const fields = { sku, name, category: cat, price, stock, lowStock, taxable };
    if (id) {
      data.products = data.products.map(p => (p.id === id ? { ...p, ...fields } : p));
      cart = cart.map(l => (l.id === id ? { ...l, sku, name, price, taxable, qty: Math.min(l.qty, stock) } : l)).filter(l => l.qty > 0);
    } else {
      data.products.push({ id: uid('p'), ...fields });
    }
    data.sampleCatalog = false;
    save(); f.reset(); f.elements.id.value = '';
    renderAll(); toast(t('prod.saved'));
  }

  // ---------------------------------------------------------------- staff ---
  const managerCount = () => data.staff.filter(s => s.role === 'manager').length;

  function renderStaff() {
    $('#staff-rows').replaceChildren(...data.staff.map(s => el('tr', {},
      el('td', { textContent: s.name + (user && s.id === user.id ? ' ' + t('staff.you') : '') }),
      el('td', { textContent: t('role.' + s.role) }),
      el('td', { className: 'actions' },
        el('button', { className: 'small', textContent: t('btn.edit'), onclick: () => {
          const f = $('#staff-form');
          f.elements.id.value = s.id; f.elements.name.value = s.name; f.role.value = s.role; f.pin.value = '';
          f.pin.placeholder = t('staff.pinKeep');
          f.elements.name.focus();
        } }),
        el('button', { className: 'small danger', textContent: t('btn.delete'), onclick: guard(() => deleteStaff(s.id)) })))));
  }

  async function saveStaff(e) {
    e.preventDefault();
    const f = e.target;
    const id = f.elements.id.value, name = f.elements.name.value.trim(), role = f.role.value, pin = f.pin.value.trim();
    if (!name) throw new Error(t('staff.nameReq'));
    if (data.staff.some(s => s.name.toLowerCase() === name.toLowerCase() && s.id !== id)) throw new Error(t('staff.dup'));
    if ((!id || pin) && !/^\d{4,8}$/.test(pin)) throw new Error(t('staff.pinErr'));
    if (pin === '1234') throw new Error(t('staff.pinDefault'));
    const existing = data.staff.find(s => s.id === id);
    if (existing && existing.role === 'manager' && role !== 'manager' && managerCount() === 1) throw new Error(t('staff.needManager'));
    const sid = id || uid('u');
    const patch = { name, role };
    if (pin) Object.assign(patch, { pinHash: await hashPin(pin, sid), defaultPin: false });
    if (existing) data.staff = data.staff.map(s => (s.id === id ? { ...s, ...patch } : s));
    else data.staff.push({ id: sid, ...patch });
    if (user && user.id === sid) { user = data.staff.find(s => s.id === sid); applyRole(); if (!isManager()) showView('register'); }
    save(); f.reset(); f.elements.id.value = ''; f.pin.placeholder = t('staff.pin');
    renderAll(); toast(t('staff.saved'));
  }

  async function deleteStaff(id) {
    const s = data.staff.find(x => x.id === id);
    if (id === user.id) throw new Error(t('staff.self'));
    if (s.role === 'manager' && managerCount() === 1) throw new Error(t('staff.needManager'));
    if (!(await confirmBox(t('staff.deleteTitle'), t('staff.deleteText', { name: s.name })))) return;
    data.staff = data.staff.filter(x => x.id !== id);
    save(); renderAll();
  }

  // ------------------------------------------------------------- settings ---
  function fillSettingsForm(s) {
    const f = $('#settings-form');
    const d = P.currencyDecimals(s.currency);
    f.country.value = s.country; f.language.value = s.language; f.currency.value = s.currency; f.locale.value = s.locale;
    f.taxMode.value = s.taxMode; f.taxLabel.value = s.taxLabel; f.taxRate.value = fmtRate(s.taxRateBp);
    f.taxId.value = s.taxId || ''; f.cashDenoms.value = (s.cashDenoms || []).map(v => String(Number((v / 10 ** d).toFixed(d)))).join(', ');
    f.branch.value = s.branch || HEAD_OFFICE; f.posRegNo.value = s.posRegNo || ''; f.promptpayId.value = s.promptpayId || '';
    f.machineBrand.value = s.machineBrand || ''; f.machineModel.value = s.machineModel || ''; f.machineSerial.value = s.machineSerial || '';
    f.storeName.value = s.storeName; f.header.value = s.header; f.footer.value = s.footer; f.cashierMaxDiscount.value = s.cashierMaxDiscount;
    $('#th-fields').hidden = s.country !== 'TH';
  }

  async function renderStorageInfo() {
    const box = $('#storage-info');
    if (!box || !store) return;
    const est = await window.POSStorage.estimate();
    const mb = v => (v / 1048576).toFixed(1) + ' MB';
    box.textContent = [
      t('storage.kind', { kind: store.kind === 'indexeddb' ? 'IndexedDB' : 'localStorage' }),
      persisted ? t('storage.persisted') : t('storage.notPersisted'),
      est && est.quota ? t('storage.usage', { used: mb(est.usage || 0), quota: mb(est.quota) }) : '',
      t('storage.docs', { sales: data.sales.length, journal: data.journal.length }),
      data.lastBackupAt ? t('storage.lastBackup', { date: fmtDate(data.lastBackupAt) }) : t('alert.backupNever'),
    ].filter(Boolean).join(' · ');
  }

  function renderSettings() {
    fillSettingsForm(S());
    renderHardware();
    $('#store-name').textContent = S().storeName;
    document.title = `${S().storeName} · POS`;
    renderStorageInfo();
  }

  function onCountryChange(e) {
    const f = $('#settings-form');
    const preset = PRESETS[e.target.value];
    if (preset) {
      const d = P.currencyDecimals(preset.currency);
      f.language.value = preset.language; f.currency.value = preset.currency; f.locale.value = preset.locale;
      f.taxMode.value = preset.taxMode; f.taxLabel.value = preset.taxLabel; f.taxRate.value = fmtRate(preset.taxRateBp);
      f.cashDenoms.value = preset.cashDenoms.map(v => String(v / 10 ** d)).join(', ');
    }
    $('#th-fields').hidden = e.target.value !== 'TH';
  }

  const TAX_FIELDS = ['country', 'currency', 'taxMode', 'taxRateBp', 'taxLabel', 'taxId', 'branch', 'posRegNo', 'storeName', 'header', 'language'];

  async function saveSettings(e) {
    e.preventDefault();
    const f = e.target;
    const cur = f.currency.value.trim().toUpperCase();
    const d = P.currencyDecimals(cur);
    const locale = f.locale.value.trim();
    try { new Intl.NumberFormat(locale); if (!Intl.NumberFormat.supportedLocalesOf([locale]).length) throw new Error(); }
    catch (_) { throw new Error(t('set.localeErr')); }
    const rate = Number(f.taxRate.value), maxD = Number(f.cashierMaxDiscount.value);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error(t('set.taxRateErr'));
    if (!Number.isInteger(maxD) || maxD < 0 || maxD > 100) throw new Error(t('set.maxDiscErr'));
    const denoms = f.cashDenoms.value.split(',').map(x => x.trim()).filter(Boolean).map(x => {
      let v;
      try { v = P.toMinor(x, d); } catch (_) { throw new Error(t('set.denomErr')); }
      if (v <= 0) throw new Error(t('set.denomErr'));
      return v;
    });
    const country = f.country.value;
    let language = f.language.value;
    const taxId = f.taxId.value.replace(/[\s-]/g, '');
    const thaiVat = country === 'TH' && !!taxId;
    if (country === 'TH' && taxId && !P.isValidThaiTaxId(taxId)) throw new Error(t('set.taxIdErr'));
    if (thaiVat && cur !== 'THB') throw new Error(t('set.thbRequired'));
    if (thaiVat && !f.header.value.trim()) throw new Error(t('set.addressRequired'));
    if (thaiVat) language = 'th'; // tax invoices must be in Thai
    const branch = f.branch.value.trim() || HEAD_OFFICE;
    if (country === 'TH' && !validBranch(branch)) throw new Error(t('inv.badBranch'));
    const promptpayId = country === 'TH' ? f.promptpayId.value.replace(/[\s-]/g, '') : '';
    if (promptpayId && !P.parsePromptPayId(promptpayId)) throw new Error(t('set.ppErr'));
    if (promptpayId && cur !== 'THB') throw new Error(t('set.ppCurrency'));
    const prev = S();
    if (cur !== prev.currency) {
      if (currentShift() || activityDays().some(day => !isDayClosed(day))) throw new Error(t('set.curShift'));
      if (!(await confirmBox(t('set.curTitle'), t('set.curText', { from: prev.currency, to: cur })))) return;
    }
    const next = {
      ...prev, country, language, currency: cur, locale,
      taxMode: f.taxMode.value, taxLabel: f.taxLabel.value.trim() || 'Tax', taxRateBp: Math.round(rate * 100),
      cashDenoms: [...new Set(denoms)].sort((a, b) => a - b),
      taxId: country === 'TH' ? taxId : f.taxId.value.trim(), branch, posRegNo: f.posRegNo.value.trim(), promptpayId,
      machineBrand: f.machineBrand.value.trim(), machineModel: f.machineModel.value.trim(), machineSerial: f.machineSerial.value.trim(),
      storeName: f.storeName.value.trim() || 'My Store', header: f.header.value.trim(), footer: f.footer.value.trim(),
      cashierMaxDiscount: maxD, regionChosen: true,
    };
    const changed = Object.fromEntries(TAX_FIELDS.filter(k => next[k] !== prev[k]).map(k => [k, next[k]]));
    data.settings = next;
    if (Object.keys(changed).length) journalAdd('settings', { doc: changed });
    save(); applyI18n(); applyRole(); renderAll(); toast(t('set.saved'));
    if (thaiVat && f.language.value !== 'th') toast(t('set.thaiForced'));
  }

  // ------------------------------------------------ desktop hardware ---
  function syncDrawerFields() {
    const mode = $('#hw-form').drawerMode.value;
    for (const e of $$('.hw-net')) e.hidden = mode !== 'network';
    for (const e of $$('.hw-share')) e.hidden = mode !== 'share';
  }

  async function renderHardware() {
    const f = $('#hw-form');
    f.hidden = !native || !isManager();
    if (!native || !hw) return;
    let printers = [];
    try { printers = await native.listPrinters(); } catch (e) { console.error(e); }
    const opts = (sel, value) => {
      sel.replaceChildren(el('option', { value: '', textContent: t('hw.printerAsk') }),
        ...printers.map(p => el('option', { value: p.name, textContent: p.displayName + (p.isDefault ? ' ★' : '') })));
      if (value && !printers.some(p => p.name === value)) sel.append(el('option', { value, textContent: value + ' ' + t('hw.missing') }));
      sel.value = value || '';
    };
    opts(f.receiptPrinter, hw.receiptPrinter);
    opts(f.reportPrinter, hw.reportPrinter);
    f.autoPrint.checked = hw.autoPrint; f.kiosk.checked = hw.kiosk; f.autostart.checked = hw.autostart; f.autoBackup.checked = hw.autoBackup;
    f.drawerMode.value = hw.drawer.mode; f.drawerHost.value = hw.drawer.host; f.drawerPort.value = hw.drawer.port; f.drawerShare.value = hw.drawer.share;
    syncDrawerFields();
    $('#hw-backup-dir').textContent = hw.backupDir;
    $('#hw-version').textContent = appInfo ? `${APP_NAME} ${appInfo.version} · ${appInfo.platform}` : '';
  }

  async function saveHardware(e) {
    e.preventDefault();
    const f = e.target;
    const port = Number(f.drawerPort.value || 9100);
    try {
      hw = await native.setConfig({
        receiptPrinter: f.receiptPrinter.value, reportPrinter: f.reportPrinter.value, autoPrint: f.autoPrint.checked,
        kiosk: f.kiosk.checked, autostart: f.autostart.checked, autoBackup: f.autoBackup.checked,
        drawer: { mode: f.drawerMode.value, host: f.drawerHost.value.trim(), port, share: f.drawerShare.value.trim() },
      });
    } catch (err) {
      throw new Error(t('hw.invalid', { err: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }));
    }
    renderHardware(); renderShift(); toast(t('hw.saved'));
  }

  async function testPrint() {
    const s = S();
    showDoc([...sellerHeader(sellerSnapshot()), { gap: 1 }, { c: 'TEST PRINT / ทดสอบการพิมพ์', cls: 'title' },
      { l: 'ภาษาไทย', r: 'กขคงจ ๑๒๓' }, { l: 'Currency', r: money(123456) }, { l: rt('doc.date'), r: fmtDate(new Date().toISOString()) },
      { hr: 2 }, { c: s.footer || '' }]);
    await printReceipt();
  }

  function backupJSON() {
    return JSON.stringify({ ...data, exportedAt: new Date().toISOString(), app: `${APP_NAME} ${APP_VERSION}` });
  }

  function downloadBackup() {
    download(`pos-backup-${S().taxId || 'store'}-${today()}.json`, backupJSON(), 'application/json');
    data.lastBackupAt = new Date().toISOString();
    save(); renderAlerts(); renderStorageInfo();
  }

  async function restore(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let d;
    try { d = upgrade(JSON.parse(await file.text())); } catch (_) { d = null; }
    if (!d) throw new Error(t('set.badBackup'));
    normalize(d);
    const v = P.verifyJournal(d.journal);
    if (!v.ok) throw new Error(t('restore.broken', { seq: v.seq }));
    // Never roll back issued documents: the backup must contain everything
    // this terminal has already recorded.
    const cur = data.journal;
    const extends_ = d.journal.length >= cur.length && cur.every((e2, i) => d.journal[i] && d.journal[i].hash === e2.hash);
    const hasDocs = data.sales.length > 0;
    if (hasDocs && !extends_) throw new Error(t('restore.rollback'));
    if (!(await confirmBox(t('set.restore'), t('set.restoreText')))) return;
    delete d.exportedAt; delete d.app;
    data = d;
    journalAdd('restore', { doc: { entries: d.journal.length - 1, sales: d.sales.length } });
    await saveAll();
    integrity = P.verifyJournal(data.journal);
    cart = []; orderDiscountPct = 0; lock(); applyI18n(); toast(t('set.restored'));
  }

  async function resetAll() {
    // Always hand the user a full backup first; tax records must be kept 5 years.
    if (data.sales.length) downloadBackup();
    const r = await ask({ title: t('set.reset'), text: t(data.sales.length ? 'set.resetTextDocs' : 'set.resetText'), ok: t('set.reset'), fields: [{ name: 'c', label: t('set.confirmField') }] });
    if (!r || r.c.trim().toUpperCase() !== 'RESET') return;
    data = defaults();
    journalAdd('init', { doc: { app: `${APP_NAME} ${APP_VERSION}`, reason: 'reset' } });
    await saveAll();
    integrity = P.verifyJournal(data.journal);
    cart = []; orderDiscountPct = 0;
    uiLang = null;
    try { localStorage.removeItem(LANG_KEY); } catch (_) { /* ignore */ }
    lock(); applyI18n(); toast(t('set.resetDone'));
  }

  // --------------------------------------------------------------- wiring ---
  function renderAll() {
    renderSettings(); renderCategories(); renderGrid(); renderCart(); renderSales(); renderShift(); renderAlerts();
    if (isManager()) { renderReports(); renderProducts(); renderStaff(); if ($('#view-journal').classList.contains('active')) renderJournal(); }
  }

  function wire() {
    buildKeypad();
    for (const b of $$('.lang-toggle')) b.addEventListener('click', toggleLang);
    for (const b of $$('nav button')) b.addEventListener('click', () => showView(b.dataset.view));
    $('#lock').addEventListener('click', lock);
    $('#goto-shift').addEventListener('click', () => showView('shift'));
    $('#prompt-cancel').addEventListener('click', () => { $('#prompt-dialog').returnValue = 'cancel'; $('#prompt-dialog').close(); });

    $('#search').addEventListener('input', renderGrid);
    $('#search').addEventListener('keydown', guard(e => {
      if (e.key !== 'Enter') return;
      const q = e.target.value.trim();
      if (!q) return;
      const lq = q.toLowerCase();
      const p = data.products.find(x => x.sku.toLowerCase() === lq);
      const matches = data.products.filter(x => x.name.toLowerCase().includes(lq) && (!category || x.category === category));
      const target = p || (matches.length === 1 ? matches[0] : null);
      if (!target) throw new Error(t('reg.noMatch', { q }));
      e.target.value = '';
      addProduct(target);
    }));
    $('#order-discount').addEventListener('change', guard(async e => {
      try { await changeDiscount(Number(e.target.value), pct => { orderDiscountPct = pct; }, 'reg.orderDiscW'); }
      finally { renderCart(); }
    }));
    $('#void-sale').addEventListener('click', guard(async () => {
      if (cart.length && (await confirmBox(t('reg.voidTitle'), t('reg.voidText')))) resetSale();
    }));
    $('#hold').addEventListener('click', guard(holdSale));
    $('#recall').addEventListener('click', guard(recallSale));
    $('#pay').addEventListener('click', guard(openPayment));

    $('#add-cash').addEventListener('click', guard(() => addPayment('cash')));
    $('#add-card').addEventListener('click', guard(() => addPayment('card')));
    $('#add-promptpay').addEventListener('click', guard(openPromptPay));
    $('#pp-ok').addEventListener('click', guard(() => {
      const amount = ppPending;
      closePromptPay();
      if (amount) addPayment('promptpay', amount);
    }));
    $('#pp-cancel').addEventListener('click', () => { closePromptPay(); renderPayment(); });
    $('#pay-amount').addEventListener('keydown', guard(e => { if (e.key === 'Enter') { e.preventDefault(); addPayment('cash'); } }));
    $('#pay-cancel').addEventListener('click', () => $('#pay-dialog').close());
    $('#pay-dialog').addEventListener('close', closePromptPay);
    $('#pay-complete').addEventListener('click', guard(completeSale));
    $('#print-receipt').addEventListener('click', guard(printReceipt));
    $('#hw-form').addEventListener('submit', guard(saveHardware));
    $('#hw-form').drawerMode.addEventListener('change', syncDrawerFields);
    $('#hw-test-print').addEventListener('click', guard(testPrint));
    $('#hw-test-drawer').addEventListener('click', guard(async () => {
      const r = await native.openDrawer();
      toast(r.ok ? t('hw.drawerOk') : t('hw.drawerFailed', { err: r.error }), !r.ok);
    }));
    $('#hw-choose-dir').addEventListener('click', guard(async () => { hw = await native.chooseBackupDir(); renderHardware(); }));
    $('#hw-open-dir').addEventListener('click', guard(() => native.openBackupDir()));
    $('#hw-quit').addEventListener('click', guard(async () => {
      if (await confirmBox(t('hw.quit'), t('hw.quitText'))) { await saving; native.quit(); }
    }));
    $('#close-receipt').addEventListener('click', () => { $('#receipt-dialog').close(); if ($('#view-register').classList.contains('active')) $('#search').focus(); });

    $('#sale-search').addEventListener('input', renderSales);
    $('#rep-from').addEventListener('change', renderReports);
    $('#rep-to').addEventListener('change', renderReports);
    $('#rep-today').addEventListener('click', () => setRange(1));
    $('#rep-7').addEventListener('click', () => setRange(7));
    $('#rep-30').addEventListener('click', () => setRange(30));
    $('#rep-csv').addEventListener('click', guard(() => {
      const { from, to } = reportRange();
      const rows = data.sales.filter(s => (!from || s.date >= from) && (!to || s.date < to));
      download(`sales-${today()}.csv`, '﻿' + P.salesCSV(rows), 'text/csv;charset=utf-8');
    }));
    $('#otr-print').addEventListener('click', guard(printOutputTax));
    $('#otr-csv').addEventListener('click', guard(csvOutputTax));

    $('#journal-day').addEventListener('change', renderJournal);
    $('#journal-verify').addEventListener('click', () => { renderJournal(); toast(integrity.ok ? t('journal.ok', { n: integrity.count }) : t('alert.integrity', { seq: integrity.seq }), !integrity.ok); });
    $('#journal-export').addEventListener('click', () => download(`pos-journal-${S().posRegNo || 'terminal'}-${today()}.json`, JSON.stringify(data.journal), 'application/json'));

    $('#product-filter').addEventListener('input', renderProducts);
    $('#low-only').addEventListener('change', renderProducts);
    $('#product-form').addEventListener('submit', guard(saveProduct));
    $('#product-form').addEventListener('reset', e => { e.target.elements.id.value = ''; });
    $('#staff-form').addEventListener('submit', guard(saveStaff));
    $('#staff-form').addEventListener('reset', e => { e.target.elements.id.value = ''; e.target.pin.placeholder = t('staff.pin'); });
    $('#settings-form').addEventListener('submit', guard(saveSettings));
    $('#settings-form').country.addEventListener('change', onCountryChange);
    $('#pp06').addEventListener('click', guard(pp06Pack));
    $('#backup').addEventListener('click', downloadBackup);
    $('#restore').addEventListener('change', guard(restore));
    $('#reset-data').addEventListener('click', guard(resetAll));

    document.addEventListener('keydown', e => {
      resetIdle();
      if (!user || $$('dialog').some(d => d.open)) return;
      const keys = { F1: 'register', F2: 'sales', F3: 'shift' };
      if (keys[e.key]) { e.preventDefault(); showView(keys[e.key]); }
      else if (e.key === 'F4') { e.preventDefault(); showView('register'); $('#search').focus(); }
      else if (e.key === 'F12') { e.preventDefault(); if (!$('#pay').disabled) guard(openPayment)(); }
      else if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); lock(); }
    });
    for (const ev of ['pointerdown', 'touchstart']) document.addEventListener(ev, resetIdle, { passive: true });

    const tick = () => { $('#clock').textContent = new Date().toLocaleTimeString(S().locale, { hour: '2-digit', minute: '2-digit' }); };
    tick(); setInterval(tick, 15000);
  }

  // ----------------------------------------------------------------- boot ---
  async function boot() {
    store = await window.POSStorage.open();
    const loaded = await store.load();
    let fullWrite = false;
    if (loaded) {
      data = upgrade({ ...loaded.state, sales: loaded.sales, journal: loaded.journal });
      if (!data) throw new Error('Stored data is unreadable');
      fullWrite = loaded.state.version !== 4;
    } else {
      const legacy = window.POSStorage.readLegacy();
      data = upgrade(legacy.v3) || upgrade(legacy.v2) ||
        (legacy.v1 && Array.isArray(legacy.v1.products) ? migrateV3(migrateV2(migrateV1(legacy.v1))) : null) || defaults();
      fullWrite = true;
    }
    normalize(data);
    if (!data.journal.length) {
      journalAdd('init', { doc: { app: `${APP_NAME} ${APP_VERSION}`, existingSales: data.sales.length } });
      fullWrite = true;
    }
    if (fullWrite) await saveAll();
    integrity = P.verifyJournal(data.journal);
    persisted = native ? true : await window.POSStorage.persist(); // the desktop app's storage is never evicted
    if (native) {
      try { const info = await native.info(); hw = info.config; appInfo = info; } catch (e) { console.error(e); }
    }
    wire();
    applyI18n();
    lock();
  }

  function fatal(msg) {
    const hint = document.querySelector('#login-hint');
    if (hint) { hint.textContent = msg; hint.className = 'alert danger'; }
    for (const b of document.querySelectorAll('#keypad button, #pin-display')) b.disabled = true;
  }

  // One tab per terminal: two tabs could otherwise hand out the same
  // document number.
  function start() {
    const run = () => boot().catch(e => { console.error(e); fatal('Could not start: ' + e.message); });
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request('pos-terminal', { ifAvailable: true }, lockObj => {
        if (!lockObj) { fatal('POS เปิดอยู่ในแท็บหรือหน้าต่างอื่นแล้ว / POS is already open in another tab.'); return; }
        return run().then(() => new Promise(() => {})); // hold the lock while this tab lives
      });
    } else run();
  }

  start();
})();
