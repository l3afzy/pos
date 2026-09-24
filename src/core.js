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
    const updatedProducts = products.map(p => {
      const line = sale.lines.find(l => l.id === p.id);
      return line ? { ...p, stock: p.stock + line.qty } : p;
    });
    return {
      sale: { ...sale, refunded: true, refund: { id: id || null, date: new Date(now).toISOString(), by: by || null, shiftId: shiftId || null } },
      products: updatedProducts,
    };
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
    const inShift = sales.filter(s => s.shiftId === shift.id);
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
      transactions: inShift.length, grossSales,
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
    const valid = inRange.filter(s => !s.refunded);
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
      count: valid.length, refunds: inRange.length - valid.length, revenue, tax, discounts, items,
      average: valid.length ? roundDiv(revenue, valid.length) : 0,
      byMethod, byCashier, topProducts,
    };
  }

  function csvEscape(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // guard against spreadsheet formula injection
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
        amt(t.cash), amt(t.card), amt(t.promptpay), s.refunded ? 'Refunded' : 'Completed',
        s.fullInvoice ? s.fullInvoice.no : '', s.refund && s.refund.id ? s.refund.id : '']);
    }
    return toCSV(rows);
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
    checkout, refund, openShift, addMovement, shiftReport, closeShift, salesReport, toCSV, salesCSV,
    isValidThaiTaxId, crc16, parsePromptPayId, promptPayPayload,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.POS = api;
})(this);
