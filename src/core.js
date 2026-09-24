// Pure POS logic. All money values are integer cents to avoid float errors.
(function (root) {
  'use strict';

  function toCents(value) {
    const s = String(value).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('Invalid amount: ' + value);
    const [whole, frac = ''] = s.split('.');
    return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  }

  function formatCents(cents) {
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return sign + '$' + whole + '.' + String(abs % 100).padStart(2, '0');
  }

  // Round half up for non-negative values.
  function roundDiv(n, d) {
    return Math.floor((n * 2 + d) / (2 * d));
  }

  function checkPct(pct, label) {
    if (typeof pct !== 'number' || !(pct >= 0 && pct <= 100)) throw new Error(label + ' must be 0-100%');
  }

  function pctOf(amount, pct) {
    return roundDiv(amount * Math.round(pct * 100), 10000);
  }

  function addToCart(cart, product, qty = 1) {
    if (!Number.isInteger(qty) || qty <= 0) throw new Error('Quantity must be a positive integer');
    const existing = cart.find(l => l.id === product.id);
    const newQty = (existing ? existing.qty : 0) + qty;
    if (newQty > product.stock) throw new Error(`Only ${product.stock} of "${product.name}" in stock`);
    if (existing) {
      return cart.map(l => (l.id === product.id ? { ...l, qty: newQty } : l));
    }
    return [...cart, { id: product.id, sku: product.sku, name: product.name, price: product.price, qty, discountPct: 0 }];
  }

  function setQty(cart, id, qty, stock) {
    if (!Number.isInteger(qty) || qty < 0) throw new Error('Quantity must be a non-negative integer');
    if (qty > stock) throw new Error(`Only ${stock} in stock`);
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

  // orderDiscountPct: 0..100, taxRateBp: basis points (825 = 8.25%)
  function computeTotals(cart, orderDiscountPct = 0, taxRateBp = 0) {
    checkPct(orderDiscountPct, 'Discount');
    if (!Number.isInteger(taxRateBp) || taxRateBp < 0) throw new Error('Tax rate must be non-negative');
    let gross = 0, itemDiscount = 0;
    for (const l of cart) {
      const t = lineTotals(l);
      gross += t.gross;
      itemDiscount += t.discount;
    }
    const subtotal = gross - itemDiscount;
    const orderDiscount = pctOf(subtotal, orderDiscountPct);
    const taxable = subtotal - orderDiscount;
    const tax = roundDiv(taxable * taxRateBp, 10000);
    return { gross, itemDiscount, subtotal, orderDiscount, discount: itemDiscount + orderDiscount, tax, total: taxable + tax };
  }

  // payments: [{ method: 'cash'|'card', amount: cents }]
  // Card payments may not exceed the remaining balance; any overpayment must be
  // cash and is returned as change.
  function settle(total, payments) {
    if (!payments.length) throw new Error('No payment entered');
    let paid = 0, cash = 0, card = 0;
    for (const p of payments) {
      if (!Number.isInteger(p.amount) || p.amount <= 0) throw new Error('Payment amounts must be positive');
      if (p.method === 'cash') cash += p.amount;
      else if (p.method === 'card') card += p.amount;
      else throw new Error('Unknown payment method');
      paid += p.amount;
    }
    if (card > total) throw new Error('Card payments cannot exceed the total');
    if (paid < total) throw new Error(`Balance due: ${formatCents(total - paid)}`);
    const change = paid - total;
    return { paid, change, cashNet: cash - change, cardNet: card };
  }

  function checkout({ cart, products, orderDiscountPct = 0, taxRateBp = 0, payments, cashier, shiftId, now = Date.now(), id }) {
    if (!cart.length) throw new Error('Cart is empty');
    for (const line of cart) {
      const p = products.find(x => x.id === line.id);
      if (!p) throw new Error(`Product "${line.name}" no longer exists`);
      if (line.qty > p.stock) throw new Error(`Only ${p.stock} of "${p.name}" in stock`);
    }
    const totals = computeTotals(cart, orderDiscountPct, taxRateBp);
    const s = settle(totals.total, payments);
    const updatedProducts = products.map(p => {
      const line = cart.find(l => l.id === p.id);
      return line ? { ...p, stock: p.stock - line.qty } : p;
    });
    const sale = {
      id: id || 'S' + now,
      date: new Date(now).toISOString(),
      lines: cart.map(l => ({ ...l, ...lineTotals(l) })),
      orderDiscountPct, taxRateBp,
      payments: payments.map(p => ({ ...p })),
      cashier: cashier || null, shiftId: shiftId || null,
      refunded: false,
      ...totals, ...s,
    };
    return { sale, products: updatedProducts };
  }

  // Refunds go back to the original tenders (cash portion in cash, card to card).
  function refund(sale, products, { by, shiftId, now = Date.now() } = {}) {
    if (sale.refunded) throw new Error('Sale already refunded');
    const updatedProducts = products.map(p => {
      const line = sale.lines.find(l => l.id === p.id);
      return line ? { ...p, stock: p.stock + line.qty } : p;
    });
    return {
      sale: { ...sale, refunded: true, refund: { date: new Date(now).toISOString(), by: by || null, shiftId: shiftId || null } },
      products: updatedProducts,
    };
  }

  function saleCash(s) { return s.cashNet != null ? s.cashNet : (s.method === 'cash' ? s.total : 0); }
  function saleCard(s) { return s.cardNet != null ? s.cardNet : (s.method === 'card' ? s.total : 0); }

  function openShift({ id, cashier, float, now = Date.now() }) {
    if (!Number.isInteger(float) || float < 0) throw new Error('Opening float must be ≥ 0');
    return { id, openedBy: cashier, openedAt: new Date(now).toISOString(), float, movements: [], closedAt: null };
  }

  function addMovement(shift, { type, amount, reason, by, now = Date.now() }) {
    if (shift.closedAt) throw new Error('Shift is closed');
    if (type !== 'in' && type !== 'out') throw new Error('Unknown movement type');
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('Amount must be positive');
    if (!reason || !String(reason).trim()) throw new Error('A reason is required');
    return { ...shift, movements: [...shift.movements, { type, amount, reason: String(reason).trim(), by, date: new Date(now).toISOString() }] };
  }

  function shiftReport(shift, sales) {
    const inShift = sales.filter(s => s.shiftId === shift.id);
    const refundsInShift = sales.filter(s => s.refunded && s.refund && s.refund.shiftId === shift.id);
    const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
    const cashSales = sum(inShift, saleCash);
    const cardSales = sum(inShift, saleCard);
    const cashRefunds = sum(refundsInShift, saleCash);
    const cardRefunds = sum(refundsInShift, saleCard);
    const payIns = sum(shift.movements.filter(m => m.type === 'in'), m => m.amount);
    const payOuts = sum(shift.movements.filter(m => m.type === 'out'), m => m.amount);
    const expectedCash = shift.float + cashSales - cashRefunds + payIns - payOuts;
    return {
      transactions: inShift.length,
      grossSales: sum(inShift, s => s.total),
      tax: sum(inShift, s => s.tax),
      discounts: sum(inShift, s => s.discount || 0),
      cashSales, cardSales, cashRefunds, cardRefunds,
      refundCount: refundsInShift.length,
      refundTotal: sum(refundsInShift, s => s.total),
      netSales: sum(inShift, s => s.total) - sum(refundsInShift, s => s.total),
      payIns, payOuts, float: shift.float, expectedCash,
      counted: shift.counted != null ? shift.counted : null,
      variance: shift.counted != null ? shift.counted - expectedCash : null,
    };
  }

  function closeShift(shift, sales, counted, { by, now = Date.now() } = {}) {
    if (shift.closedAt) throw new Error('Shift already closed');
    if (!Number.isInteger(counted) || counted < 0) throw new Error('Counted cash must be ≥ 0');
    const closed = { ...shift, closedAt: new Date(now).toISOString(), closedBy: by || null, counted };
    return { ...closed, report: shiftReport(closed, sales) };
  }

  // Sales report over [from, to) ISO dates. Refunded sales are excluded from revenue.
  function salesReport(sales, { from, to } = {}) {
    const inRange = sales.filter(s => (!from || s.date >= from) && (!to || s.date < to));
    const valid = inRange.filter(s => !s.refunded);
    const byMethod = { cash: 0, card: 0 };
    const byCashier = {};
    const byProduct = {};
    let revenue = 0, tax = 0, discounts = 0, items = 0;
    for (const s of valid) {
      revenue += s.total; tax += s.tax; discounts += s.discount || 0;
      byMethod.cash += saleCash(s); byMethod.card += saleCard(s);
      const c = s.cashier || 'Unknown';
      byCashier[c] = byCashier[c] || { count: 0, total: 0 };
      byCashier[c].count++; byCashier[c].total += s.total;
      for (const l of s.lines) {
        const k = l.id;
        byProduct[k] = byProduct[k] || { name: l.name, qty: 0, net: 0 };
        byProduct[k].qty += l.qty;
        byProduct[k].net += l.net != null ? l.net : l.price * l.qty;
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
    const money = c => (c / 100).toFixed(2);
    const rows = [['Sale ID', 'Date', 'Cashier', 'Items', 'Subtotal', 'Discount', 'Tax', 'Total', 'Cash', 'Card', 'Status']];
    for (const s of sales) {
      rows.push([s.id, s.date, s.cashier || '', s.lines.reduce((a, l) => a + l.qty, 0),
        money(s.subtotal), money(s.discount || 0), money(s.tax), money(s.total),
        money(saleCash(s)), money(saleCard(s)), s.refunded ? 'Refunded' : 'Completed']);
    }
    return toCSV(rows);
  }

  const api = {
    toCents, formatCents, addToCart, setQty, setLineDiscount, lineTotals, computeTotals, settle,
    checkout, refund, openShift, addMovement, shiftReport, closeShift, salesReport, toCSV, salesCSV,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.POS = api;
})(this);
