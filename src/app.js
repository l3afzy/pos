(function () {
  'use strict';
  const P = window.POS;
  const KEY = 'pos-data-v3';
  const OLD_KEYS = { v2: 'pos-data-v2', v1: 'pos-data-v1' };
  const LANG_KEY = 'pos-ui-lang';
  const IDLE_LOCK_MS = 5 * 60 * 1000;
  const MAX_PIN_TRIES = 5;
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

  // ---------------------------------------------------------------- data ----
  function defaults() {
    return {
      version: 3,
      settings: {
        ...PRESETS.US, storeName: 'My Store', header: '123 Main St\n(555) 010-0000', footer: 'Thank you!',
        cashierMaxDiscount: 10, taxId: '', branch: HEAD_OFFICE, posRegNo: '', promptpayId: '', regionChosen: false,
      },
      staff: [{ id: 'u1', name: 'Manager', role: 'manager', pinHash: null, defaultPin: true }],
      products: sampleProducts('US'), sampleCatalog: true,
      sales: [], shifts: [], currentShiftId: null, held: [],
      seq: { sale: 0, shift: 0, refund: 0, inv: 0 },
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

  function isValidData(d) {
    return !!(d && typeof d === 'object' && d.settings && Array.isArray(d.staff) && d.staff.some(s => s.role === 'manager') &&
      Array.isArray(d.products) && Array.isArray(d.sales) && Array.isArray(d.shifts) && Array.isArray(d.held) && d.seq);
  }

  function upgrade(d) {
    if (!isValidData(d)) return null;
    if (d.version === 3) return d;
    if (d.version === 2) return migrateV2(d);
    return null;
  }

  function load() {
    try {
      const d = upgrade(JSON.parse(localStorage.getItem(KEY)));
      if (d) return d;
      const v2 = upgrade(JSON.parse(localStorage.getItem(OLD_KEYS.v2)));
      if (v2) return v2;
      const v1 = JSON.parse(localStorage.getItem(OLD_KEYS.v1));
      if (v1 && Array.isArray(v1.products) && Array.isArray(v1.sales)) return migrateV2(migrateV1(v1));
    } catch (e) { /* ignore and use defaults */ }
    return defaults();
  }

  let data = load();
  let user = null;
  let cart = [];
  let orderDiscountPct = 0;
  let category = null; // null = all
  let uiLang = null;
  try { uiLang = localStorage.getItem(LANG_KEY); } catch (e) { /* ignore */ }

  const S = () => data.settings;
  const lang = () => (uiLang === 'th' || uiLang === 'en' ? uiLang : S().language);

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); }
    catch (e) { toast(t('save.err', { msg: e.message }), true); }
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
  const isThaiTax = s => s.country === 'TH' && !!s.taxId;
  const promptPayOn = () => !!S().promptpayId && S().currency === 'THB';

  // ---------------------------------------------------------------- utils ---
  let toastTimer;
  function toast(msg, isError) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = ''), 3000);
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
  function parseDay(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function dayInput(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

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
    let h = 0x811c9dc5; // FNV-1a fallback for contexts without WebCrypto
    for (let i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return 'fnv:' + h.toString(16);
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
  function showDoc(lines) {
    $('#receipt').replaceChildren(...lines.map(L => {
      const cls = L.cls ? ' ' + L.cls : '';
      if (L.hr) return el('div', { className: 'r-hr' + (L.hr === 2 ? ' double' : '') });
      if (L.gap) return el('div', { className: 'r-gap' });
      if (L.c != null) return el('div', { className: 'r-c' + cls, textContent: L.c });
      if (L.l != null) return el('div', { className: 'r-lr' + cls }, el('span', { textContent: L.l }), el('span', { textContent: L.r != null ? L.r : '' }));
      return el('div', { className: 'r-t' + cls, textContent: L.t });
    }));
    $('#receipt-dialog').showModal();
  }

  function sellerSnapshot() {
    const s = S();
    return { country: s.country, name: s.storeName, header: s.header, footer: s.footer, taxId: s.taxId, branch: s.branch, posRegNo: s.posRegNo, language: s.language };
  }

  function sellerHeader(seller) {
    const out = [{ c: seller.name, cls: 'big' }];
    for (const line of (seller.header || '').split('\n').filter(Boolean)) out.push({ c: line });
    if (seller.taxId) out.push({ c: `${rt('doc.taxId')} ${seller.taxId}` });
    if (seller.country === 'TH' && seller.taxId) {
      const b = !seller.branch || seller.branch === HEAD_OFFICE ? rt('doc.headOffice') : seller.branch;
      out.push({ c: `${rt('doc.branch')} ${b}` });
    }
    if (seller.country === 'TH' && seller.posRegNo) out.push({ c: `${rt('doc.posReg')} ${seller.posRegNo}` });
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

  function taxLines(sale, m) {
    const label = sale.taxLabel || 'Tax';
    const out = [];
    if (sale.taxInclusive) {
      if (sale.taxRateBp > 0) {
        out.push({ c: rt('doc.vatIncluded', { label }), cls: 'small' });
        out.push({ l: rt('doc.taxBase', { label }), r: m(sale.taxBase) });
        out.push({ l: `${label} ${fmtRate(sale.taxRateBp)}%`, r: m(sale.tax) });
      }
    }
    if (sale.exemptAmount) out.push({ l: rt('doc.exempt'), r: m(sale.exemptAmount) });
    return out;
  }

  function receiptDoc(sale, copy) {
    const m = moneyIn(sale.currency);
    const seller = sale.seller || sellerSnapshot();
    const out = sellerHeader(seller);
    out.push({ gap: 1 });
    if (isThaiTax(seller)) out.push({ c: 'ใบกำกับภาษีอย่างย่อ', cls: 'title' }, { c: 'ABB. TAX INVOICE', cls: 'small' });
    else out.push({ c: rt('doc.receipt'), cls: 'title' });
    if (copy) out.push({ c: isThaiTax(seller) ? 'สำเนา / COPY' : rt('doc.copy'), cls: 'small' });
    out.push({ l: rt('doc.no'), r: sale.id }, { l: rt('doc.date'), r: fmtDate(sale.date) });
    if (sale.cashier) out.push({ l: rt('doc.cashier'), r: sale.cashier });
    out.push({ hr: 1 }, ...itemLines(sale, m), { hr: 1 }, { l: rt('doc.subtotal'), r: m(sale.subtotal) });
    if (sale.orderDiscount) out.push({ l: rt('doc.orderDiscount', { p: sale.orderDiscountPct }), r: m(-sale.orderDiscount) });
    if (!sale.taxInclusive && (sale.tax || sale.taxRateBp)) out.push({ l: `${sale.taxLabel || 'Tax'} ${fmtRate(sale.taxRateBp || 0)}%`, r: m(sale.tax) });
    out.push({ hr: 2 }, { l: rt('doc.total'), r: m(sale.total), cls: 'grand' }, { hr: 2 });
    out.push(...taxLines(sale, m));
    for (const p of sale.payments || []) out.push({ l: rt('method.' + p.method), r: m(p.amount) });
    if (sale.change) out.push({ l: rt('doc.change'), r: m(sale.change) });
    if (sale.discount) out.push({ gap: 1 }, { c: rt('doc.saved', { amt: m(sale.discount) }) });
    if (sale.refunded) out.push({ gap: 1 }, { c: rt('doc.refunded'), cls: 'title' }, { c: `${sale.refund.id || ''} ${fmtDate(sale.refund.date)}`.trim() });
    out.push({ gap: 1 }, ...(seller.footer || '').split('\n').filter(Boolean).map(c => ({ c })));
    return out;
  }

  // Full tax invoice (ใบกำกับภาษีเต็มรูป, Revenue Code s.86/4). Thai legal
  // wording is always printed, with English alongside.
  function invoiceDoc(sale, copy) {
    const m = moneyIn(sale.currency);
    const inv = sale.fullInvoice;
    const seller = sale.seller || sellerSnapshot();
    const label = sale.taxLabel || 'VAT';
    const out = sellerHeader(seller);
    out.push({ gap: 1 }, { c: 'ใบกำกับภาษี / ใบเสร็จรับเงิน', cls: 'title' }, { c: 'TAX INVOICE / RECEIPT', cls: 'small' },
      { c: copy ? 'สำเนา / COPY' : 'ต้นฉบับ / ORIGINAL', cls: 'small' },
      { l: 'เลขที่ / No.', r: inv.no }, { l: 'วันที่ / Date', r: fmtDate(inv.date) },
      { t: `ออกแทนใบกำกับภาษีอย่างย่อเลขที่ ${sale.id} (${fmtDate(sale.date)})`, cls: 'small' },
      { hr: 1 },
      { t: `ผู้ซื้อ / Customer: ${inv.buyer.name}` }, { t: `ที่อยู่ / Address: ${inv.buyer.address}` });
    if (inv.buyer.taxId) out.push({ t: `เลขประจำตัวผู้เสียภาษี / Tax ID: ${inv.buyer.taxId}` });
    if (inv.buyer.branch) out.push({ t: `สาขา / Branch: ${inv.buyer.branch === HEAD_OFFICE ? 'สำนักงานใหญ่ / Head office' : inv.buyer.branch}` });
    out.push({ hr: 1 }, ...itemLines(sale, m), { hr: 1 }, { l: 'รวมเป็นเงิน / Subtotal', r: m(sale.subtotal) });
    if (sale.orderDiscount) out.push({ l: `ส่วนลด / Discount ${sale.orderDiscountPct}%`, r: m(-sale.orderDiscount) });
    out.push({ l: `มูลค่าสินค้า (ก่อน ${label}) / Value`, r: m(sale.taxBase) },
      { l: `ภาษีมูลค่าเพิ่ม / ${label} ${fmtRate(sale.taxRateBp)}%`, r: m(sale.tax) });
    if (sale.exemptAmount) out.push({ l: 'สินค้ายกเว้นภาษี / Exempt', r: m(sale.exemptAmount) });
    out.push({ hr: 2 }, { l: 'รวมทั้งสิ้น / TOTAL', r: m(sale.total), cls: 'grand' }, { hr: 2 },
      { gap: 1 }, { gap: 1 }, { c: '________________________' }, { c: 'ผู้รับเงิน / Received by', cls: 'small' });
    return out;
  }

  // Refund slip, or credit note (ใบลดหนี้, s.86/10) for Thai VAT sellers.
  function refundDoc(sale, copy) {
    const m = moneyIn(sale.currency);
    const seller = sale.seller || sellerSnapshot();
    const thai = isThaiTax(seller);
    const rf = sale.refund;
    const label = sale.taxLabel || 'Tax';
    const out = sellerHeader(seller);
    out.push({ gap: 1 });
    if (thai) out.push({ c: 'ใบลดหนี้', cls: 'title' }, { c: 'CREDIT NOTE', cls: 'small' });
    else out.push({ c: rt('doc.refund'), cls: 'title' });
    if (copy) out.push({ c: thai ? 'สำเนา / COPY' : rt('doc.copy'), cls: 'small' });
    out.push({ l: rt('doc.no'), r: rf.id || sale.id + '-R' }, { l: rt('doc.date'), r: fmtDate(rf.date) },
      { t: rt('doc.refundOf', { id: sale.id }) + ` (${fmtDate(sale.date)})` });
    if (sale.fullInvoice) out.push({ t: `อ้างอิงใบกำกับภาษีเลขที่ / Ref. tax invoice ${sale.fullInvoice.no}` });
    if (rf.reason) out.push({ t: `${rt('doc.reason')}: ${rf.reason}` });
    out.push({ hr: 1 }, ...itemLines(sale, m), { hr: 1 });
    if (thai) {
      out.push({ l: 'มูลค่าตามใบกำกับภาษีเดิม', r: m(sale.taxBase) }, { l: 'มูลค่าที่ถูกต้อง', r: m(0) },
        { l: 'ผลต่าง', r: m(sale.taxBase) }, { l: `${label} ${fmtRate(sale.taxRateBp)}%`, r: m(sale.tax) });
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
    out.push({ hr: 1 }, { l: rt('z.transactions'), r: String(r.transactions) }, { l: rt('z.gross'), r: m(r.grossSales) },
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
    renderAll();
    showView(currentShift() ? 'register' : 'shift');
    toast(t('login.welcome', { name: user.name }));
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
  }

  // ----------------------------------------------------------- region ---
  // Apply a country preset. Returns false if blocked (open shift + currency change).
  function applyPreset(country) {
    const preset = PRESETS[country];
    const next = preset ? { ...S(), ...preset } : { ...S(), country: 'OTHER' };
    if (next.currency !== S().currency && currentShift()) { toast(t('set.curShift'), true); return false; }
    if (!preset) next.country = 'OTHER';
    if (next.country !== 'TH') next.promptpayId = next.currency === 'THB' ? next.promptpayId : '';
    if (country === 'TH' && next.footer === 'Thank you!') next.footer = 'ขอบคุณที่ใช้บริการ';
    if (country !== 'TH' && next.footer === 'ขอบคุณที่ใช้บริการ') next.footer = 'Thank you!';
    data.settings = { ...next, regionChosen: true };
    if (data.sampleCatalog) {
      data.products = sampleProducts(country);
      cart = [];
    }
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
    if (r.country === 'OTHER') showView('settings');
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
    $('#no-shift').hidden = !!shift;
    $('#pay').disabled = !cart.length || !shift;
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
    const s = S();
    const r = P.checkout({
      cart, products: data.products, orderDiscountPct, tax: taxSpec(), currency: s.currency,
      payments, cashier: user.name, shiftId: shift.id, id: peekId('sale', 'S', 6),
    });
    commitId('sale');
    r.sale.taxLabel = s.taxLabel;
    r.sale.seller = sellerSnapshot();
    data.products = r.products;
    data.sales.unshift(r.sale);
    save();
    $('#pay-dialog').close();
    resetSale();
    renderAll();
    showDoc(receiptDoc(r.sale, false));
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
    // Re-price from the current catalog; drop items that no longer exist.
    cart = h.cart.map(l => { const p = productById(l.id); return p && { ...l, name: p.name, price: p.price, taxable: p.taxable !== false }; }).filter(Boolean);
    orderDiscountPct = h.orderDiscountPct;
    data.held = data.held.filter(x => x.id !== h.id);
    save(); renderCart(); renderGrid();
    if (cart.length < h.cart.length) toast(t('reg.heldRemoved'), true);
  }

  // ---------------------------------------------------------------- sales ---
  function renderSales() {
    const q = $('#sale-search').value.trim().toLowerCase();
    const list = data.sales.filter(s => !q || s.id.toLowerCase().includes(q) || (s.cashier || '').toLowerCase().includes(q) ||
      (s.fullInvoice && s.fullInvoice.no.toLowerCase().includes(q)) || (s.refund && s.refund.id && s.refund.id.toLowerCase().includes(q)));
    const tb = $('#sale-rows');
    tb.replaceChildren();
    if (!list.length) tb.append(el('tr', {}, el('td', { colSpan: 7, className: 'muted', textContent: t('sales.none') })));
    for (const sale of list.slice(0, 500)) {
      const m = moneyIn(sale.currency);
      const seller = sale.seller || sellerSnapshot();
      const tender = Object.keys(P.saleTenders(sale)).map(k => t('method.' + k)).join(' + ');
      const actions = el('td', { className: 'actions' },
        el('button', { className: 'small', textContent: t('sales.receipt'), onclick: () => showDoc(receiptDoc(sale, true)) }));
      if (sale.fullInvoice) actions.append(el('button', { className: 'small', textContent: sale.fullInvoice.no, onclick: () => showDoc(invoiceDoc(sale, true)) }));
      else if (isThaiTax(seller) && !sale.refunded) actions.append(el('button', { className: 'small', textContent: t('sales.taxInvoice'), onclick: guard(() => issueInvoice(sale.id)) }));
      if (sale.refunded) actions.append(el('button', { className: 'small', textContent: isThaiTax(seller) ? t('sales.creditNote') : t('sales.refundDoc'), onclick: () => showDoc(refundDoc(sale, true)) }));
      else actions.append(el('button', { className: 'small danger', textContent: t('sales.refund'), onclick: guard(() => refundSale(sale.id)) }));
      tb.append(el('tr', { className: sale.refunded ? 'refunded' : '' },
        el('td', { textContent: sale.id }), el('td', { textContent: fmtDate(sale.date) }),
        el('td', { textContent: sale.cashier || '—' }), el('td', { textContent: tender }),
        el('td', { className: 'num', textContent: m(sale.total) }),
        el('td', { textContent: t(sale.refunded ? 'status.refunded' : 'status.completed') }),
        actions));
    }
  }

  async function issueInvoice(id) {
    const sale = data.sales.find(s => s.id === id);
    if (!sale) return;
    if (sale.refunded) throw new Error(t('inv.refunded'));
    if (!isThaiTax(sale.seller || sellerSnapshot())) throw new Error(t('inv.needSeller'));
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
    const fullInvoice = { no: peekId('inv', 'INV', 6), date: new Date().toISOString(), buyer, by: user.name };
    commitId('inv');
    data.sales = data.sales.map(s => (s.id === id ? { ...s, fullInvoice } : s));
    save(); renderSales();
    showDoc(invoiceDoc(data.sales.find(s => s.id === id), false));
  }

  async function refundSale(id) {
    const shift = currentShift();
    if (!shift) throw new Error(t('refund.needShift'));
    const sale = data.sales.find(s => s.id === id);
    if ((sale.currency || 'USD') !== (shift.currency || 'USD')) throw new Error(t('refund.curMismatch', { cur: sale.currency || 'USD' }));
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
    const thai = isThaiTax(sale.seller || sellerSnapshot());
    const r = P.refund(sale, data.products, { by: mgr.name, shiftId: shift.id, id: peekId('refund', thai ? 'CN' : 'RF', 6) });
    commitId('refund');
    r.sale.refund.reason = reason;
    data.products = r.products;
    data.sales = data.sales.map(s => (s.id === id ? r.sale : s));
    save(); renderAll(); toast(t('refund.done'));
    showDoc(refundDoc(r.sale, false));
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
  }

  async function openShiftFlow() {
    if (currentShift()) throw new Error(t('shift.alreadyOpen'));
    const r = await ask({ title: t('shift.open'), text: t('shift.openText'), ok: t('shift.open'),
      fields: [{ name: 'float', label: t('shift.float'), inputmode: 'decimal', value: '0' }] });
    if (!r) return;
    const shift = P.openShift({ id: peekId('shift', 'SH', 4), cashier: user.name, float: parseAmount(r.float), currency: S().currency });
    commitId('shift');
    data.shifts.push(shift);
    data.currentShiftId = shift.id;
    save(); renderAll(); showView('register'); toast(t('shift.opened', { id: shift.id }));
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
    save(); renderAll(); toast(t('shift.recorded'));
  }

  async function closeShiftFlow() {
    const shift = currentShift();
    if (!shift) return;
    if (data.held.length && !(await confirmBox(t('shift.heldTitle'), t('shift.heldText', { n: data.held.length })))) return;
    const r = await ask({ title: t('shift.close'), text: t('shift.closeText'), ok: t('shift.close'),
      fields: [{ name: 'counted', label: t('shift.counted'), inputmode: 'decimal' }] });
    if (!r) return;
    const closed = P.closeShift(shift, data.sales, parseAmount(r.counted), { by: user.name });
    data.shifts = data.shifts.map(s => (s.id === shift.id ? closed : s));
    data.currentShiftId = null;
    save(); renderAll();
    showDoc(shiftDoc(closed, true));
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
    const other = all.count + all.refunds - r.count - r.refunds;
    $('#rep-note').textContent = other ? t('rep.otherCur', { n: other }) : '';
    $('#rep-kpis').replaceChildren(
      kpi(t('rep.revenue'), money(r.revenue)), kpi(t('rep.transactions'), r.count), kpi(t('rep.average'), money(r.average)),
      kpi(t('rep.items'), r.items), kpi(t('rep.tax'), money(r.tax)), kpi(t('rep.discounts'), money(r.discounts)), kpi(t('rep.refunds'), r.refunds));
    $('#rep-products').replaceChildren(...(r.topProducts.length ? r.topProducts.slice(0, 20).map(p => el('tr', {},
      el('td', { textContent: p.name }), el('td', { className: 'num', textContent: String(p.qty) }), el('td', { className: 'num', textContent: money(p.net) })))
      : [el('tr', {}, el('td', { colSpan: 3, className: 'muted', textContent: t('rep.none') }))]));
    const methods = P.METHODS.filter(k => k !== 'promptpay' || r.byMethod.promptpay || promptPayOn());
    $('#rep-methods').replaceChildren(...methods.map(k => el('tr', {},
      el('td', { textContent: t('method.' + k) }), el('td', { className: 'num', textContent: money(r.byMethod[k] || 0) }))));
    $('#rep-cashiers').replaceChildren(...Object.entries(r.byCashier).sort((a, b) => b[1].total - a[1].total).map(([n, v]) => el('tr', {},
      el('td', { textContent: n }), el('td', { className: 'num', textContent: String(v.count) }), el('td', { className: 'num', textContent: money(v.total) }))));
  }

  function setRange(days) {
    const to = new Date(), from = new Date();
    from.setDate(from.getDate() - (days - 1));
    $('#rep-from').value = dayInput(from);
    $('#rep-to').value = dayInput(to);
    renderReports();
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
    f.storeName.value = s.storeName; f.header.value = s.header; f.footer.value = s.footer; f.cashierMaxDiscount.value = s.cashierMaxDiscount;
    $('#th-fields').hidden = s.country !== 'TH';
  }

  function renderSettings() {
    fillSettingsForm(S());
    $('#store-name').textContent = S().storeName;
    document.title = `${S().storeName} · POS`;
  }

  // Changing the profile in the form fills in that country's defaults (not saved yet).
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

  async function saveSettings(e) {
    e.preventDefault();
    const f = e.target;
    const cur = f.currency.value.trim().toUpperCase();
    const d = P.currencyDecimals(cur); // throws for unknown codes
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
    const taxId = f.taxId.value.replace(/[\s-]/g, '');
    if (country === 'TH' && taxId && !P.isValidThaiTaxId(taxId)) throw new Error(t('set.taxIdErr'));
    const branch = f.branch.value.trim() || HEAD_OFFICE;
    if (country === 'TH' && !validBranch(branch)) throw new Error(t('inv.badBranch'));
    const promptpayId = country === 'TH' ? f.promptpayId.value.replace(/[\s-]/g, '') : '';
    if (promptpayId && !P.parsePromptPayId(promptpayId)) throw new Error(t('set.ppErr'));
    if (promptpayId && cur !== 'THB') throw new Error(t('set.ppCurrency'));
    const prev = S();
    if (cur !== prev.currency) {
      if (currentShift()) throw new Error(t('set.curShift'));
      if (!(await confirmBox(t('set.curTitle'), t('set.curText', { from: prev.currency, to: cur })))) return;
    }
    data.settings = {
      ...prev, country, language: f.language.value, currency: cur, locale,
      taxMode: f.taxMode.value, taxLabel: f.taxLabel.value.trim() || 'Tax', taxRateBp: Math.round(rate * 100),
      cashDenoms: [...new Set(denoms)].sort((a, b) => a - b),
      taxId: country === 'TH' ? taxId : f.taxId.value.trim(), branch, posRegNo: f.posRegNo.value.trim(), promptpayId,
      storeName: f.storeName.value.trim() || 'My Store', header: f.header.value.trim(), footer: f.footer.value.trim(),
      cashierMaxDiscount: maxD, regionChosen: true,
    };
    save(); applyI18n(); applyRole(); renderAll(); toast(t('set.saved'));
  }

  async function restore(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let d;
    try { d = upgrade(JSON.parse(await file.text())); } catch (_) { d = null; }
    if (!d) throw new Error(t('set.badBackup'));
    if (!(await confirmBox(t('set.restore'), t('set.restoreText')))) return;
    data = d; save(); cart = []; orderDiscountPct = 0; lock(); applyI18n(); toast(t('set.restored'));
  }

  async function resetAll() {
    const r = await ask({ title: t('set.reset'), text: t('set.resetText'), ok: t('set.reset'), fields: [{ name: 'c', label: t('set.confirmField') }] });
    if (!r || r.c.trim().toUpperCase() !== 'RESET') return;
    data = defaults(); save(); cart = []; orderDiscountPct = 0;
    uiLang = null;
    try { localStorage.removeItem(LANG_KEY); } catch (_) { /* ignore */ }
    lock(); applyI18n(); toast(t('set.resetDone'));
  }

  // --------------------------------------------------------------- wiring ---
  function renderAll() {
    renderSettings(); renderCategories(); renderGrid(); renderCart(); renderSales(); renderShift();
    if (isManager()) { renderReports(); renderProducts(); renderStaff(); }
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
      // BOM so Excel opens UTF-8 (Thai text) correctly.
      download(`sales-${dayInput(new Date())}.csv`, '﻿' + P.salesCSV(rows), 'text/csv;charset=utf-8');
    }));

    $('#product-filter').addEventListener('input', renderProducts);
    $('#low-only').addEventListener('change', renderProducts);
    $('#product-form').addEventListener('submit', guard(saveProduct));
    $('#product-form').addEventListener('reset', e => { e.target.elements.id.value = ''; });
    $('#staff-form').addEventListener('submit', guard(saveStaff));
    $('#staff-form').addEventListener('reset', e => { e.target.elements.id.value = ''; e.target.pin.placeholder = t('staff.pin'); });
    $('#settings-form').addEventListener('submit', guard(saveSettings));
    $('#settings-form').country.addEventListener('change', onCountryChange);
    $('#backup').addEventListener('click', () => download(`pos-backup-${dayInput(new Date())}.json`, JSON.stringify(data, null, 2), 'application/json'));
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

    // Pick up changes saved by another tab of this terminal.
    window.addEventListener('storage', e => {
      if (e.key !== KEY || !e.newValue) return;
      try {
        const d = upgrade(JSON.parse(e.newValue));
        if (!d) return;
        data = d;
        if (user) { user = data.staff.find(s => s.id === user.id) || null; if (!user) lock(); else { applyRole(); renderAll(); } }
        else renderLogin();
      } catch (_) { /* ignore */ }
    });

    const tick = () => { $('#clock').textContent = new Date().toLocaleTimeString(S().locale, { hour: '2-digit', minute: '2-digit' }); };
    tick(); setInterval(tick, 15000);
  }

  wire();
  applyI18n();
  save();
  lock();
})();
