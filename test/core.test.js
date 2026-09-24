const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/core.js');

const products = [
  { id: 'a', name: 'Coffee', price: 350, stock: 5 },
  { id: 'b', name: 'Bagel', price: 199, stock: 2 },
];

test('toCents parses exactly', () => {
  assert.equal(P.toCents('0.1'), 10);
  assert.equal(P.toCents('19.99'), 1999);
  assert.equal(P.toCents('3'), 300);
  assert.throws(() => P.toCents('1.999'));
  assert.throws(() => P.toCents('-1'));
  assert.throws(() => P.toCents('abc'));
});

test('formatCents', () => {
  assert.equal(P.formatCents(123456), '$1,234.56');
  assert.equal(P.formatCents(5), '$0.05');
  assert.equal(P.formatCents(-250), '-$2.50');
});

test('cart add merges and enforces stock', () => {
  let c = P.addToCart([], products[1]);
  c = P.addToCart(c, products[1]);
  assert.equal(c.length, 1);
  assert.equal(c[0].qty, 2);
  assert.throws(() => P.addToCart(c, products[1]));
  assert.deepEqual(P.setQty(c, 'b', 0, 2), []);
});

test('totals with order discount and tax', () => {
  const cart = [{ id: 'a', price: 350, qty: 3 }, { id: 'b', price: 199, qty: 1 }];
  const t = P.computeTotals(cart, 10, 825);
  assert.equal(t.subtotal, 1249);
  assert.equal(t.orderDiscount, 125); // 124.9 -> 125
  assert.equal(t.tax, 93);            // 1124 * 8.25% = 92.73 -> 93
  assert.equal(t.total, 1217);
});

test('line discounts apply before order discount', () => {
  let cart = P.addToCart([], products[0], 2);          // 700
  cart = P.setLineDiscount(cart, 'a', 50);             // -350
  const t = P.computeTotals(cart, 10, 0);
  assert.equal(t.itemDiscount, 350);
  assert.equal(t.orderDiscount, 35);
  assert.equal(t.total, 315);
  assert.throws(() => P.setLineDiscount(cart, 'a', 101));
});

test('settle: split tender, change only from cash', () => {
  assert.deepEqual(P.settle(1000, [{ method: 'card', amount: 600 }, { method: 'cash', amount: 500 }]),
    { paid: 1100, change: 100, cashNet: 400, cardNet: 600 });
  assert.throws(() => P.settle(1000, [{ method: 'card', amount: 1100 }]), /Card payments/);
  assert.throws(() => P.settle(1000, [{ method: 'cash', amount: 999 }]), /Balance due: \$0.01/);
  assert.throws(() => P.settle(1000, []));
  assert.throws(() => P.settle(1000, [{ method: 'cash', amount: 0 }]));
});

test('checkout decrements stock and does not mutate input', () => {
  const cart = P.addToCart([], products[0], 2);
  const r = P.checkout({ cart, products, payments: [{ method: 'cash', amount: 1000 }], now: 0, cashier: 'Ann', shiftId: 'X' });
  assert.equal(r.sale.total, 700);
  assert.equal(r.sale.change, 300);
  assert.equal(r.sale.cashNet, 700);
  assert.equal(r.products[0].stock, 3);
  assert.equal(products[0].stock, 5);
  assert.throws(() => P.checkout({ cart: [], products, payments: [{ method: 'card', amount: 1 }] }));
});

test('shift reconciliation accounts for sales, refunds and pay in/out', () => {
  let shift = P.openShift({ id: 'X', cashier: 'Ann', float: 10000, now: 0 });
  const cart = P.addToCart([], products[0], 2); // 700
  const s1 = P.checkout({ cart, products, payments: [{ method: 'cash', amount: 2000 }], shiftId: 'X', id: 's1' });
  const s2 = P.checkout({ cart, products, payments: [{ method: 'card', amount: 300 }, { method: 'cash', amount: 400 }], shiftId: 'X', id: 's2' });
  const r = P.refund(s2.sale, s2.products, { shiftId: 'X' });
  shift = P.addMovement(shift, { type: 'out', amount: 500, reason: 'Supplies' });
  shift = P.addMovement(shift, { type: 'in', amount: 200, reason: 'Change' });
  assert.throws(() => P.addMovement(shift, { type: 'out', amount: 1, reason: ' ' }));
  const sales = [s1.sale, r.sale];
  const rep = P.shiftReport(shift, sales);
  // 10000 + 700 + 400 - 400 (refund cash) + 200 - 500
  assert.equal(rep.expectedCash, 10400);
  assert.equal(rep.cardSales, 300);
  assert.equal(rep.netSales, 700);
  const closed = P.closeShift(shift, sales, 10350);
  assert.equal(closed.report.variance, -50);
  assert.throws(() => P.closeShift(closed, sales, 0));
  assert.throws(() => P.addMovement(closed, { type: 'in', amount: 1, reason: 'x' }));
});

test('refund restores stock once', () => {
  const cart = P.addToCart([], products[1], 2);
  const r = P.checkout({ cart, products, payments: [{ method: 'card', amount: 398 }] });
  const rf = P.refund(r.sale, r.products, { by: 'Mgr' });
  assert.equal(rf.products[1].stock, 2);
  assert.equal(rf.sale.refund.by, 'Mgr');
  assert.throws(() => P.refund(rf.sale, rf.products));
});

test('sales report aggregates and filters by date', () => {
  const cart = P.addToCart([], products[0], 1);
  const a = P.checkout({ cart, products, payments: [{ method: 'cash', amount: 350 }], cashier: 'Ann', now: Date.UTC(2026, 0, 1) }).sale;
  const b = P.checkout({ cart, products, payments: [{ method: 'card', amount: 350 }], cashier: 'Bob', now: Date.UTC(2026, 0, 2) }).sale;
  const rep = P.salesReport([a, b]);
  assert.equal(rep.revenue, 700);
  assert.deepEqual(rep.byMethod, { cash: 350, card: 350 });
  assert.equal(rep.topProducts[0].qty, 2);
  assert.equal(rep.average, 350);
  assert.equal(P.salesReport([a, b], { from: '2026-01-02' }).count, 1);
});

test('CSV escapes quotes and formula injection', () => {
  assert.equal(P.toCSV([['a,b', 'say "hi"', '=SUM(A1)']]), '"a,b","say ""hi""",\'=SUM(A1)');
  const cart = P.addToCart([], products[0], 1);
  const s = P.checkout({ cart, products, payments: [{ method: 'cash', amount: 350 }], id: 'S1', now: 0 }).sale;
  assert.match(P.salesCSV([s]).split('\r\n')[1], /^S1,1970-01-01T00:00:00.000Z,,1,3.50,0.00,0.00,3.50,3.50,0.00,Completed$/);
});
