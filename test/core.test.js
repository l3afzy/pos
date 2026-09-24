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
    { paid: 1100, change: 100, byMethod: { card: 600, cash: 400 } });
  assert.throws(() => P.settle(1000, [{ method: 'card', amount: 1100 }]), /cannot exceed/);
  assert.throws(() => P.settle(1000, [{ method: 'cash', amount: 999 }]), /less than the total/);
  assert.throws(() => P.settle(1000, []));
  assert.throws(() => P.settle(1000, [{ method: 'cash', amount: 0 }]));
});

test('checkout decrements stock and does not mutate input', () => {
  const cart = P.addToCart([], products[0], 2);
  const r = P.checkout({ cart, products, payments: [{ method: 'cash', amount: 1000 }], now: 0, cashier: 'Ann', shiftId: 'X' });
  assert.equal(r.sale.total, 700);
  assert.equal(r.sale.change, 300);
  assert.deepEqual(r.sale.byMethod, { cash: 700 });
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
  assert.match(P.salesCSV([s]).split('\r\n')[1], /^S1,1970-01-01T00:00:00.000Z,USD,,1,3.50,0.00,0.00,no,3.50,3.50,0.00,0.00,Completed,,$/);
});

test('currency parsing and formatting per locale', () => {
  assert.equal(P.currencyDecimals('THB'), 2);
  assert.equal(P.currencyDecimals('JPY'), 0);
  assert.throws(() => P.currencyDecimals('XXXX'));
  assert.equal(P.toMinor('1500', 0), 1500);
  assert.throws(() => P.toMinor('15.5', 0));
  assert.equal(P.toMinor('12.345', 3), 12345);
  assert.equal(P.formatMoney(1381, { currency: 'THB', locale: 'th-TH' }), '฿13.81');
  assert.equal(P.formatMoney(-250, { currency: 'USD', locale: 'en-US' }), '-$2.50');
  assert.equal(P.formatMoney(-0, { currency: 'USD', locale: 'en-US' }), '$0.00');
  assert.equal(P.formatMoney(1500, { currency: 'JPY', locale: 'en-US' }), '¥1,500');
});

test('VAT-inclusive pricing extracts tax (Thailand 7%)', () => {
  const vat = { rateBp: 700, inclusive: true };
  const t = P.computeTotals([{ id: 'x', price: 10700, qty: 1 }], 0, vat);
  assert.equal(t.total, 10700);
  assert.equal(t.tax, 700);
  assert.equal(t.taxBase, 10000);
  const t2 = P.computeTotals([{ id: 'x', price: 5500, qty: 1 }], 0, vat);
  assert.equal(t2.tax, 360); // 55 * 7/107 = 3.598 -> 3.60
  assert.equal(t2.total, 5500);
});

test('tax-exempt items are not taxed, discounts split proportionally', () => {
  const cart = [{ id: 'a', price: 1000, qty: 1 }, { id: 'veg', price: 1000, qty: 1, taxable: false }];
  const ex = P.computeTotals(cart, 10, 1000); // 10% exclusive
  assert.equal(ex.orderDiscount, 200);
  assert.equal(ex.tax, 90);
  assert.equal(ex.exemptAmount, 900);
  assert.equal(ex.total, 1890);
  const inc = P.computeTotals(cart, 0, { rateBp: 700, inclusive: true });
  assert.equal(inc.tax, 65); // 10.00 * 7/107 = 0.654
  assert.equal(inc.total, 2000);
  assert.equal(inc.taxBase + inc.tax + inc.exemptAmount, inc.total);
});

test('PromptPay tender cannot exceed total; cash change handled', () => {
  assert.deepEqual(P.settle(1000, [{ method: 'promptpay', amount: 600 }, { method: 'cash', amount: 1000 }]),
    { paid: 1600, change: 600, byMethod: { promptpay: 600, cash: 400 } });
  assert.deepEqual(P.settle(1000, [{ method: 'cash', amount: 1500 }, { method: 'card', amount: 1000 }]),
    { paid: 2500, change: 1500, byMethod: { card: 1000 } });
  assert.throws(() => P.settle(1000, [{ method: 'promptpay', amount: 700 }, { method: 'card', amount: 400 }]));
  assert.throws(() => P.settle(1000, [{ method: 'bitcoin', amount: 1000 }]));
});

test('legacy sales map to tenders', () => {
  assert.deepEqual(P.saleTenders({ method: 'cash', total: 500 }), { cash: 500 });
  assert.deepEqual(P.saleTenders({ cashNet: 300, cardNet: 0, total: 300 }), { cash: 300 });
});

test('CRC-16/CCITT-FALSE check value', () => {
  assert.equal(P.crc16('123456789'), 0x29b1);
});

test('PromptPay payloads match the reference implementation', () => {
  // Expected values generated with the promptpay-qr npm package.
  assert.equal(P.promptPayPayload('081-234-5678', 1381), '00020101021229370016A000000677010111011300668123456785802TH5303764540513.8163046AC1');
  assert.equal(P.promptPayPayload('0812345678'), '00020101021129370016A000000677010111011300668123456785802TH530376463045D82');
  assert.equal(P.promptPayPayload('1234567890123', 5500), '00020101021229370016A000000677010111021312345678901235802TH5303764540555.006304F592');
  assert.equal(P.promptPayPayload('004999000288505', 100), '00020101021229390016A00000067701011103150049990002885055802TH530376454041.006304B540');
  assert.throws(() => P.promptPayPayload('12345'));
});

test('Thai tax ID checksum', () => {
  // 1-2345-67890-12-? : weights 13..2 -> sum 352, 352 % 11 = 0, (11-0)%10 = 1
  assert.equal(P.isValidThaiTaxId('1234567890121'), true);
  assert.equal(P.isValidThaiTaxId('1-2345-67890-12-1'), true);
  assert.equal(P.isValidThaiTaxId('1234567890122'), false);
  assert.equal(P.isValidThaiTaxId('123'), false);
});

test('refund carries document number', () => {
  const cart = P.addToCart([], products[0], 1);
  const r = P.checkout({ cart, products, payments: [{ method: 'card', amount: 350 }], currency: 'THB' });
  assert.equal(r.sale.currency, 'THB');
  assert.equal(P.refund(r.sale, r.products, { id: 'CN000001' }).sale.refund.id, 'CN000001');
});
