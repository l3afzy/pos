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

test('totals with discount and tax', () => {
  const cart = [{ id: 'a', price: 350, qty: 3 }, { id: 'b', price: 199, qty: 1 }];
  const t = P.computeTotals(cart, 10, 825);
  assert.equal(t.subtotal, 1249);
  assert.equal(t.discount, 125);   // 124.9 -> 125
  assert.equal(t.tax, 93);         // 1124 * 8.25% = 92.73 -> 93
  assert.equal(t.total, 1217);
});

test('checkout cash computes change and decrements stock', () => {
  const cart = P.addToCart([], products[0], 2);
  const r = P.checkout({ cart, products, discountPct: 0, taxRateBp: 0, method: 'cash', tendered: 1000, now: 0 });
  assert.equal(r.sale.total, 700);
  assert.equal(r.sale.change, 300);
  assert.equal(r.products[0].stock, 3);
  assert.equal(products[0].stock, 5, 'input not mutated');
  assert.throws(() => P.checkout({ cart, products, discountPct: 0, taxRateBp: 0, method: 'cash', tendered: 699 }));
  assert.throws(() => P.checkout({ cart: [], products, method: 'card' }));
});

test('refund restores stock once', () => {
  const cart = P.addToCart([], products[1], 2);
  const r = P.checkout({ cart, products, discountPct: 0, taxRateBp: 0, method: 'card' });
  const rf = P.refund(r.sale, r.products);
  assert.equal(rf.products[1].stock, 2);
  assert.throws(() => P.refund(rf.sale, rf.products));
  assert.deepEqual(P.summarize([r.sale, rf.sale]), { count: 1, revenue: 398, tax: 0, refunds: 1 });
});
