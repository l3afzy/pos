// Pure POS logic. All money values are integers in the currency's minor unit
// (cents, satang, ...) to avoid floating-point errors.
(function (root) {
  'use strict';

  // Errors carry a code (+ params) so the UI can show them in any language.
  function fail(code, message, params) {
    const e = new Error(message);
    e.code = code;
    e.params = params || {};
    return e;
  }

  // ------------------------------------------------------------ money ---
  function currencyDecimals(code) {
    try {
      return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits;
    } catch (e) {
      throw fail('currency', 'Unknown currency code: ' + code, { v: code });
    }
  }

  // Parse a decimal string ("12.5") into minor units without floating point.
  function toMinor(value, decimals = 2) {
    const s = String(value).trim();
    const re = decimals > 0 ? new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`) : /^\d+$/;
    if (!re.test(s)) throw fail('amount', 'Invalid amount: ' + value, { v: value });
    const [whole, frac = ''] = s.split('.');
    return Number(whole) * 10 ** decimals + Number((frac + '0'.repeat(decimals)).slice(0, decimals) || 0);
  }

  const fmtCache = new Map();
  function formatMoney(minor, { currency = 'USD', locale = 'en-US', decimals } = {}) {
    const d = decimals != null ? decimals : currencyDecimals(currency);
    const key = locale + '|' + currency + '|' + d;
    let f = fmtCache.get(key);
    if (!f) {
      f = new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: d, maximumFractionDigits: d });
      fmtCache.set(key, f);
    }
    return f.format((minor || 0) / 10 ** d); // || 0 also turns -0 into 0
  }

  // Back-compat helpers for US dollars.
  const toCents = v => toMinor(v, 2);
  const formatCents = c => formatMoney(c, { currency: 'USD', locale: 'en-US', decimals: 2 });

  // Round half up for non-negative values.
  function roundDiv(n, d) {
    return Math.floor((n * 2 + d) / (2 * d));
  }

  function checkPct(pct, label) {
    if (typeof pct !== 'number' || !(pct >= 0 && pct <= 100)) throw fail('pct', label + ' must be 0-100%');
  }

  function pctOf(amount, pct) {
    return roundDiv(amount * Math.round(pct * 100), 10000);
  }

  // ------------------------------------------------------------- cart ---
  function addToCart(cart, product, qty = 1) {
    if (!Number.isInteger(qty) || qty <= 0) throw fail('qty', 'Quantity must be a positive integer');
    const existing = cart.find(l => l.id === product.id);
    const newQty = (existing ? existing.qty : 0) + qty;
    if (newQty > product.stock) throw fail('stock', `Only ${product.stock} of "${product.name}" in stock`, { n: product.stock, name: product.name });
    if (existing) {
      return cart.map(l => (l.id === product.id ? { ...l, qty: newQty } : l));
    }
    return [...cart, {
      id: product.id, sku: product.sku, name: product.name, price: product.price, qty, discountPct: 0,
      taxable: product.taxable !== false,
    }];
  }

  function setQty(cart, id, qty, stock) {
    if (!Number.isInteger(qty) || qty < 0) throw fail('qty', 'Quantity must be a non-negative integer');
    if (qty > stock) throw fail('stockN', `Only ${stock} in stock`, { n: stock });
    if (qty === 0) return cart.filter(l => l.id !== id);
    return cart.map(l => (l.id === id ? { ...l, qty } : l));
  }

  function setLineDiscount(cart, id, pct) {
    checkPct(pct, 'Line discount');
    return cart.map(l => (l.id === id ? { ...l, discountPct: pct } : l));
  }

  function lineTotals(line) {
    const gross = line.price * line.qty;
    const discount = pctOf(gross, line.discountPct || 0);
    return { gross, discount, net: gross - discount };
  }

  // tax: { rateBp, inclusive } or a plain number of basis points (exclusive).
  //  - exclusive (US sales tax): tax is added on top of prices.
  //  - inclusive (VAT/GST, e.g. Thailand 7%): prices already contain tax; the
  //    tax portion is extracted as amount * rate / (100% + rate).
  // Lines with taxable === false are exempt.
  function computeTotals(cart, orderDiscountPct = 0, tax = 0) {
    const { rateBp, inclusive } = typeof tax === 'number' ? { rateBp: tax, inclusive: false } : tax;
    checkPct(orderDiscountPct, 'Discount');
    if (!Number.isInteger(rateBp) || rateBp < 0) throw fail('taxRate', 'Tax rate must be non-negative');
    let gross = 0, itemDiscount = 0, taxableSub = 0, exemptSub = 0;
    for (const l of cart) {
      const t = lineTotals(l);
      gross += t.gross;
      itemDiscount += t.discount;
      if (l.taxable === false) exemptSub += t.net; else taxableSub += t.net;
    }
    const subtotal = gross - itemDiscount;
    const taxableDisc = pctOf(taxableSub, orderDiscountPct);
    const exemptDisc = pctOf(exemptSub, orderDiscountPct);
    const orderDiscount = taxableDisc + exemptDisc;
    const taxableAmount = taxableSub - taxableDisc; // incl. tax when inclusive
    const exemptAmount = exemptSub - exemptDisc;
    const taxAmt = inclusive ? roundDiv(taxableAmount * rateBp, 10000 + rateBp) : roundDiv(taxableAmount * rateBp, 10000);
    const total = subtotal - orderDiscount + (inclusive ? 0 : taxAmt);
    return {
      gross, itemDiscount, subtotal, orderDiscount, discount: itemDiscount + orderDiscount,
      taxInclusive: !!inclusive, taxRateBp: rateBp,
      taxBase: inclusive ? taxableAmount - taxAmt : taxableAmount, // value of taxable goods before tax
      exemptAmount, tax: taxAmt, total,
    };
  }

  // ---------------------------------------------------------- payment ---
  const METHODS = ['cash', 'card', 'promptpay'];

  // payments: [{ method, amount }]. Only cash may exceed the balance (change);
  // card/PromptPay together may not exceed the total.
  function settle(total, payments) {
    if (!payments.length) throw fail('noPayment', 'No payment entered');
    const byMethod = {};
    let paid = 0, nonCash = 0;
    for (const p of payments) {
      if (!METHODS.includes(p.method)) throw fail('method', 'Unknown payment method');
      if (!Number.isInteger(p.amount) || p.amount <= 0) throw fail('payPositive', 'Payment amounts must be positive');
      byMethod[p.method] = (byMethod[p.method] || 0) + p.amount;
      if (p.method !== 'cash') nonCash += p.amount;
      paid += p.amount;
    }
    if (nonCash > total) throw fail('nonCash', 'Card/QR payments cannot exceed the total');
    if (paid < total) throw fail('short', 'Payment is less than the total');
    const change = paid - total;
    if (change) byMethod.cash -= change; // change always comes out of cash
    if (byMethod.cash === 0) delete byMethod.cash;
    return { paid, change, byMethod };
  }

  // Net amount per tender for a sale, including sales saved by older versions.
  function saleTenders(s) {
    if (s.byMethod) return s.byMethod;
    if (s.cashNet != null || s.cardNet != null) {
      const r = {};
      if (s.cashNet) r.cash = s.cashNet;
      if (s.cardNet) r.card = s.cardNet;
      return r;
    }
    return s.method ? { [s.method]: s.total } : {};
  }

  function checkout({ cart, products, orderDiscountPct = 0, tax = 0, taxRateBp, payments, cashier, shiftId, currency = 'USD', now = Date.now(), id }) {
    if (!cart.length) throw fail('emptyCart', 'Cart is empty');
    if (taxRateBp != null) tax = taxRateBp;
    for (const line of cart) {
      const p = products.find(x => x.id === line.id);
      if (!p) throw fail('productGone', `Product "${line.name}" no longer exists`, { name: line.name });
      if (line.qty > p.stock) throw fail('stock', `Only ${p.stock} of "${p.name}" in stock`, { n: p.stock, name: p.name });
    }
    const totals = computeTotals(cart, orderDiscountPct, tax);
    const s = settle(totals.total, payments);
    const updatedProducts = products.map(p => {
      const line = cart.find(l => l.id === p.id);
      return line ? { ...p, stock: p.stock - line.qty } : p;
    });
    const sale = {
      id: id || 'S' + now,
      date: new Date(now).toISOString(),
      currency,
      lines: cart.map(l => ({ ...l, ...lineTotals(l) })),
      orderDiscountPct,
      payments: payments.map(p => ({ ...p })),
      cashier: cashier || null, shiftId: shiftId || null,
      refunded: false,
      ...totals, ...s,
    };
    return { sale, products: updatedProducts };
  }

  // Refunds go back to the original tenders.
  function refund(sale, products, { by, shiftId, id, now = Date.now() } = {}) {
    if (sale.refunded) throw fail('refunded', 'Sale already refunded');
    if (sale.voided) throw fail('voided', 'Sale was voided');
    const updatedProducts = products.map(p => {
      const line = sale.lines.find(l => l.id === p.id);
      return line ? { ...p, stock: p.stock + line.qty } : p;
    });
    return {
      sale: { ...sale, refunded: true, refund: { id: id || null, date: new Date(now).toISOString(), by: by || null, shiftId: shiftId || null } },
      products: updatedProducts,
    };
  }

  // Void (cancel) a receipt/abbreviated tax invoice that was issued in error.
  // The document number stays used and the record is kept, marked voided.
  function voidSale(sale, products, { by, reason, now = Date.now() } = {}) {
    if (sale.voided) throw fail('voided', 'Sale was voided');
    if (sale.refunded) throw fail('refunded', 'Sale already refunded');
    if (sale.fullInvoice) throw fail('replaced', 'Sale was replaced by a full tax invoice');
    if (!reason || !String(reason).trim()) throw fail('reason', 'A reason is required');
    const updatedProducts = products.map(p => {
      const line = sale.lines.find(l => l.id === p.id);
      return line ? { ...p, stock: p.stock + line.qty } : p;
    });
    return {
      sale: { ...sale, voided: { date: new Date(now).toISOString(), by: by || null, reason: String(reason).trim() } },
      products: updatedProducts,
    };
  }

  function saleStatus(s) {
    if (s.voided) return 'voided';
    if (s.refunded) return 'refunded';
    if (s.fullInvoice) return 'replaced';
    return 'completed';
  }

  // ------------------------------------------------------------ shifts ---
  function openShift({ id, cashier, float, currency = 'USD', now = Date.now() }) {
    if (!Number.isInteger(float) || float < 0) throw fail('float', 'Opening float must be ≥ 0');
    return { id, currency, openedBy: cashier, openedAt: new Date(now).toISOString(), float, movements: [], closedAt: null };
  }

  function addMovement(shift, { type, amount, reason, by, now = Date.now() }) {
    if (shift.closedAt) throw fail('shiftClosed', 'Shift is closed');
    if (type !== 'in' && type !== 'out') throw fail('movementType', 'Unknown movement type');
    if (!Number.isInteger(amount) || amount <= 0) throw fail('movement', 'Amount must be positive');
    if (!reason || !String(reason).trim()) throw fail('reason', 'A reason is required');
    return { ...shift, movements: [...shift.movements, { type, amount, reason: String(reason).trim(), by, date: new Date(now).toISOString() }] };
  }

  function addTo(map, tenders) {
    for (const [k, v] of Object.entries(tenders)) map[k] = (map[k] || 0) + v;
    return map;
  }

  function shiftReport(shift, sales) {
    const inShift = sales.filter(s => s.shiftId === shift.id && !s.voided);
    const voidCount = sales.filter(s => s.shiftId === shift.id && s.voided).length;
    const refundsInShift = sales.filter(s => s.refunded && s.refund && s.refund.shiftId === shift.id);
    const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
    const salesBy = inShift.reduce((m, s) => addTo(m, saleTenders(s)), {});
    const refundsBy = refundsInShift.reduce((m, s) => addTo(m, saleTenders(s)), {});
    const payIns = sum(shift.movements.filter(m => m.type === 'in'), m => m.amount);
    const payOuts = sum(shift.movements.filter(m => m.type === 'out'), m => m.amount);
    const cashSales = salesBy.cash || 0, cashRefunds = refundsBy.cash || 0;
    const expectedCash = shift.float + cashSales - cashRefunds + payIns - payOuts;
    const grossSales = sum(inShift, s => s.total);
    const refundTotal = sum(refundsInShift, s => s.total);
    return {
      transactions: inShift.length, grossSales, voidCount,
      tax: sum(inShift, s => s.tax) - sum(refundsInShift, s => s.tax),
      discounts: sum(inShift, s => s.discount || 0),
      salesBy, refundsBy,
      cashSales, cardSales: salesBy.card || 0, cashRefunds, cardRefunds: refundsBy.card || 0,
      refundCount: refundsInShift.length, refundTotal,
      netSales: grossSales - refundTotal,
      payIns, payOuts, float: shift.float, expectedCash,
      counted: shift.counted != null ? shift.counted : null,
      variance: shift.counted != null ? shift.counted - expectedCash : null,
    };
  }

  function closeShift(shift, sales, counted, { by, now = Date.now() } = {}) {
    if (shift.closedAt) throw fail('shiftClosed', 'Shift already closed');
    if (!Number.isInteger(counted) || counted < 0) throw fail('float', 'Counted cash must be ≥ 0');
    const closed = { ...shift, closedAt: new Date(now).toISOString(), closedBy: by || null, counted };
    return { ...closed, report: shiftReport(closed, sales) };
  }

  // ----------------------------------------------------------- reports ---
  // Sales report over [from, to) ISO dates, optionally for one currency.
  // Refunded sales are excluded from revenue.
  function salesReport(sales, { from, to, currency } = {}) {
    const inRange = sales.filter(s => (!from || s.date >= from) && (!to || s.date < to) && (!currency || (s.currency || 'USD') === currency));
    const valid = inRange.filter(s => !s.refunded && !s.voided);
    const byMethod = {};
    const byCashier = {};
    const byProduct = {};
    let revenue = 0, tax = 0, discounts = 0, items = 0;
    for (const s of valid) {
      revenue += s.total; tax += s.tax; discounts += s.discount || 0;
      addTo(byMethod, saleTenders(s));
      const c = s.cashier || 'Unknown';
      byCashier[c] = byCashier[c] || { count: 0, total: 0 };
      byCashier[c].count++; byCashier[c].total += s.total;
      for (const l of s.lines) {
        byProduct[l.id] = byProduct[l.id] || { name: l.name, qty: 0, net: 0 };
        byProduct[l.id].qty += l.qty;
        byProduct[l.id].net += l.net != null ? l.net : l.price * l.qty;
        items += l.qty;
      }
    }
    const topProducts = Object.values(byProduct).sort((a, b) => b.net - a.net || b.qty - a.qty);
    return {
      count: valid.length, refunds: inRange.filter(s => s.refunded).length, voids: inRange.filter(s => s.voided).length, revenue, tax, discounts, items,
      average: valid.length ? roundDiv(revenue, valid.length) : 0,
      byMethod, byCashier, topProducts,
    };
  }

  function csvEscape(v) {
    let s = v == null ? '' : String(v);
    // Guard against spreadsheet formula injection, but keep plain numbers
    // (including negatives such as credit note amounts) numeric.
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(rows) {
    return rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
  }

  function salesCSV(sales) {
    const rows = [['Sale ID', 'Date', 'Currency', 'Cashier', 'Items', 'Subtotal', 'Discount', 'Tax', 'Tax included', 'Total', 'Cash', 'Card', 'PromptPay', 'Status', 'Tax invoice', 'Refund doc']];
    for (const s of sales) {
      const cur = s.currency || 'USD';
      const d = currencyDecimals(cur);
      const amt = m => ((m || 0) / 10 ** d).toFixed(d);
      const t = saleTenders(s);
      rows.push([s.id, s.date, cur, s.cashier || '', s.lines.reduce((a, l) => a + l.qty, 0),
        amt(s.subtotal), amt(s.discount), amt(s.tax), s.taxInclusive ? 'yes' : 'no', amt(s.total),
        amt(t.cash), amt(t.card), amt(t.promptpay), { voided: 'Voided', refunded: 'Refunded', replaced: 'Completed', completed: 'Completed' }[saleStatus(s)],
        s.fullInvoice ? s.fullInvoice.no : '', s.refund && s.refund.id ? s.refund.id : '']);
    }
    return toCSV(rows);
  }

  // -------------------------------------------------- journal & hashing ---
  // SHA-256 in plain JS so it works synchronously everywhere (incl. file://
  // pages without WebCrypto). Constants are derived from primes as per FIPS 180-4.
  const SHA_K = [], SHA_H = [];
  (function () {
    const frac = x => ((x - Math.floor(x)) * 4294967296) >>> 0;
    for (let n = 2, found = 0; found < 64; n++) {
      let prime = true;
      for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
      if (!prime) continue;
      if (found < 8) SHA_H.push(frac(Math.sqrt(n)));
      SHA_K.push(frac(Math.cbrt(n)));
      found++;
    }
  })();
  const ror = (x, n) => (x >>> n) | (x << (32 - n));

  function sha256(str) {
    const bytes = new TextEncoder().encode(str);
    const len = Math.ceil((bytes.length + 9) / 64) * 64;
    const m = new Uint8Array(len);
    m.set(bytes);
    m[bytes.length] = 0x80;
    const dv = new DataView(m.buffer);
    const bits = bytes.length * 8;
    dv.setUint32(len - 8, Math.floor(bits / 4294967296));
    dv.setUint32(len - 4, bits >>> 0);
    const h = SHA_H.slice();
    const w = new Uint32Array(64);
    for (let off = 0; off < len; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) >>> 0;
        const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    return h.map(x => x.toString(16).padStart(8, '0')).join('');
  }

  // JSON with sorted keys, so a hash does not depend on property order.
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return v === undefined ? 'null' : JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }

  const GENESIS = '0'.repeat(64);

  // Electronic journal: an append-only list where each entry's hash covers the
  // previous hash, so any edit, deletion or reordering is detectable.
  function journalEntry(prev, { type, ref = null, amount = null, by = null, doc = null, now = Date.now() }) {
    const body = { seq: prev ? prev.seq + 1 : 1, at: new Date(now).toISOString(), type, ref, amount, by, doc };
    const prevHash = prev ? prev.hash : GENESIS;
    return { ...body, prev: prevHash, hash: sha256(prevHash + stableStringify(body)) };
  }

  function verifyJournal(entries) {
    let prevHash = GENESIS;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.seq !== i + 1) return { ok: false, seq: e.seq, reason: 'sequence' };
      if (e.prev !== prevHash) return { ok: false, seq: e.seq, reason: 'chain' };
      const { seq, at, type, ref, amount, by, doc } = e;
      if (sha256(prevHash + stableStringify({ seq, at, type, ref, amount, by, doc })) !== e.hash) return { ok: false, seq: e.seq, reason: 'hash' };
      prevHash = e.hash;
    }
    return { ok: true, count: entries.length, last: prevHash };
  }

  // ------------------------------------------------------ daily summary ---
  const docNo = id => Number(String(id).replace(/\D/g, '')) || 0;
  const byDocNo = (a, b) => docNo(a.id) - docNo(b.id);

  // Daily sales summary for one business day (dayOf maps an ISO timestamp to
  // the local 'YYYY-MM-DD'). Voided documents are listed but not counted.
  function daySummary({ sales, day, dayOf }) {
    const issued = sales.filter(s => dayOf(s.date) === day).sort(byDocNo);
    const voided = issued.filter(s => s.voided);
    const valid = issued.filter(s => !s.voided);
    const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
    const creditNotes = sales.filter(s => s.refunded && s.refund && dayOf(s.refund.date) === day)
      .map(s => ({ id: s.refund.id || s.id + '-R', saleId: s.id, total: s.total, taxBase: s.taxBase != null ? s.taxBase : s.total - s.tax, tax: s.tax, exempt: s.exemptAmount || 0, tenders: saleTenders(s) }))
      .sort(byDocNo);
    const invoices = sales.filter(s => s.fullInvoice && dayOf(s.fullInvoice.issuedAt || s.fullInvoice.date) === day)
      .map(s => ({ no: s.fullInvoice.no, saleId: s.id, total: s.total }));
    const paymentsBy = valid.reduce((m, s) => addTo(m, saleTenders(s)), {});
    const refundsBy = creditNotes.reduce((m, c) => addTo(m, c.tenders), {});
    const total = sum(valid, s => s.total);
    const cnTotal = sum(creditNotes, c => c.total);
    return {
      day, count: issued.length,
      firstNo: issued.length ? issued[0].id : null, lastNo: issued.length ? issued[issued.length - 1].id : null,
      voided: voided.map(s => ({ id: s.id, total: s.total, reason: s.voided.reason })),
      replaced: valid.filter(s => s.fullInvoice).map(s => ({ id: s.id, invoice: s.fullInvoice.no })),
      taxBase: sum(valid, s => (s.taxBase != null ? s.taxBase : s.total - s.tax - (s.exemptAmount || 0))),
      tax: sum(valid, s => s.tax), exempt: sum(valid, s => s.exemptAmount), discount: sum(valid, s => s.discount), total,
      creditNotes, cnTaxBase: sum(creditNotes, c => c.taxBase), cnTax: sum(creditNotes, c => c.tax), cnExempt: sum(creditNotes, c => c.exempt), cnTotal,
      invoices, paymentsBy, refundsBy, net: total - cnTotal,
    };
  }

  // Monthly output tax report (รายงานภาษีขาย) rows for month 'YYYY-MM'.
  // Abbreviated tax invoices are summarised per day as a number range; voided
  // ones and ones replaced by a full tax invoice are excluded from that range's
  // value and listed. Full tax invoices and credit notes get their own rows.
  function outputTaxReport({ sales, month, dayOf, currency }) {
    const cur = s => !currency || (s.currency || 'USD') === currency;
    const inMonth = iso => dayOf(iso).slice(0, 7) === month;
    const rows = [];
    const days = new Map();
    for (const s of sales.filter(x => cur(x) && inMonth(x.date))) {
      const kind = s.seller && s.seller.country === 'TH' && s.seller.taxId && s.seller.posRegNo ? 'abb' : 'receipt';
      const key = dayOf(s.date) + '|' + kind;
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(s);
    }
    for (const [key, list] of days) {
      const [day, kind] = key.split('|');
      list.sort(byDocNo);
      const counted = list.filter(s => !s.voided && !s.fullInvoice);
      const excluded = list.filter(s => s.voided || s.fullInvoice).map(s => ({ id: s.id, why: s.voided ? 'voided' : 'replaced', invoice: s.fullInvoice ? s.fullInvoice.no : null }));
      rows.push({
        type: kind, day, docNo: list.length > 1 ? `${list[0].id}-${list[list.length - 1].id}` : list[0].id, excluded,
        buyer: '', buyerTaxId: '', buyerBranch: '',
        taxBase: counted.reduce((a, s) => a + (s.taxBase != null ? s.taxBase : s.total - s.tax), 0),
        tax: counted.reduce((a, s) => a + s.tax, 0),
        exempt: counted.reduce((a, s) => a + (s.exemptAmount || 0), 0),
      });
    }
    for (const s of sales.filter(x => cur(x) && x.fullInvoice && !x.voided && inMonth(x.fullInvoice.date))) {
      const b = s.fullInvoice.buyer;
      rows.push({ type: 'invoice', day: dayOf(s.fullInvoice.date), docNo: s.fullInvoice.no, ref: s.id, buyer: b.name, buyerTaxId: b.taxId || '', buyerBranch: b.branch || '',
        taxBase: s.taxBase, tax: s.tax, exempt: s.exemptAmount || 0 });
    }
    for (const s of sales.filter(x => cur(x) && x.refunded && x.refund && inMonth(x.refund.date))) {
      const b = s.fullInvoice ? s.fullInvoice.buyer : null;
      rows.push({ type: 'credit', day: dayOf(s.refund.date), docNo: s.refund.id || s.id + '-R', ref: s.fullInvoice ? s.fullInvoice.no : s.id,
        buyer: b ? b.name : '', buyerTaxId: b ? b.taxId || '' : '', buyerBranch: b ? b.branch || '' : '',
        taxBase: -(s.taxBase != null ? s.taxBase : s.total - s.tax), tax: -s.tax, exempt: -(s.exemptAmount || 0) });
    }
    const order = { abb: 0, receipt: 1, invoice: 2, credit: 3 };
    rows.sort((a, b) => a.day.localeCompare(b.day) || order[a.type] - order[b.type] || docNo(a.docNo) - docNo(b.docNo));
    const totals = rows.reduce((t, r) => ({ taxBase: t.taxBase + r.taxBase, tax: t.tax + r.tax, exempt: t.exempt + r.exempt }), { taxBase: 0, tax: 0, exempt: 0 });
    return { month, rows, totals };
  }

  // --------------------------------------------------------- Thailand ---
  // Thai 13-digit tax/citizen ID checksum.
  function isValidThaiTaxId(id) {
    const s = String(id).replace(/[\s-]/g, '');
    if (!/^\d{13}$/.test(s)) return false;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(s[i]) * (13 - i);
    return (11 - (sum % 11)) % 10 === Number(s[12]);
  }

  // CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), as used by EMVCo QR.
  function crc16(str) {
    let crc = 0xffff;
    for (let i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i) << 8;
      for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
  }

  // Normalize a PromptPay ID: mobile (10 digits, starts with 0), tax/citizen
  // ID (13 digits) or e-Wallet ID (15 digits). Returns null when invalid.
  function parsePromptPayId(id) {
    const s = String(id || '').replace(/[\s-]/g, '');
    if (/^0\d{9}$/.test(s)) return { type: 'phone', tag: '01', value: ('0000000000000' + '66' + s.slice(1)).slice(-13) };
    if (/^\d{13}$/.test(s)) return { type: 'taxid', tag: '02', value: s };
    if (/^\d{15}$/.test(s)) return { type: 'ewallet', tag: '03', value: s };
    return null;
  }

  // EMVCo merchant-presented QR payload for Thai PromptPay (Bank of Thailand
  // spec). amount is in satang; omit for a static QR where the payer types it.
  function promptPayPayload(id, amountSatang) {
    const target = parsePromptPayId(id);
    if (!target) throw fail('promptpayId', 'Invalid PromptPay ID (use a 10-digit mobile, 13-digit tax ID or 15-digit e-Wallet ID)');
    const f = (tag, val) => tag + String(val.length).padStart(2, '0') + val;
    let out = f('00', '01') + f('01', amountSatang ? '12' : '11') +
      f('29', f('00', 'A000000677010111') + f(target.tag, target.value)) +
      f('58', 'TH') + f('53', '764');
    if (amountSatang) {
      if (!Number.isInteger(amountSatang) || amountSatang <= 0) throw fail('amount', 'Invalid amount', { v: amountSatang });
      out += f('54', (amountSatang / 100).toFixed(2));
    }
    out += '6304';
    return out + crc16(out).toString(16).toUpperCase().padStart(4, '0');
  }

  const api = {
    currencyDecimals, toMinor, formatMoney, toCents, formatCents,
    addToCart, setQty, setLineDiscount, lineTotals, computeTotals, METHODS, settle, saleTenders,
    checkout, refund, voidSale, saleStatus, openShift, addMovement, shiftReport, closeShift, salesReport, toCSV, salesCSV,
    isValidThaiTaxId, crc16, parsePromptPayId, promptPayPayload,
    sha256, stableStringify, journalEntry, verifyJournal, daySummary, outputTaxReport,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.POS = api;
})(this);
