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

  function addToCart(cart, product, qty = 1) {
    if (!Number.isInteger(qty) || qty <= 0) throw new Error('Quantity must be a positive integer');
    const existing = cart.find(l => l.id === product.id);
    const newQty = (existing ? existing.qty : 0) + qty;
    if (newQty > product.stock) throw new Error(`Only ${product.stock} of "${product.name}" in stock`);
    if (existing) {
      return cart.map(l => (l.id === product.id ? { ...l, qty: newQty } : l));
    }
    return [...cart, { id: product.id, name: product.name, price: product.price, qty }];
  }

  function setQty(cart, id, qty, stock) {
    if (!Number.isInteger(qty) || qty < 0) throw new Error('Quantity must be a non-negative integer');
    if (qty > stock) throw new Error(`Only ${stock} in stock`);
    if (qty === 0) return cart.filter(l => l.id !== id);
    return cart.map(l => (l.id === id ? { ...l, qty } : l));
  }

  // discountPct: 0..100 (whole percent), taxRateBp: basis points (e.g. 825 = 8.25%)
  function computeTotals(cart, discountPct = 0, taxRateBp = 0) {
    if (!(discountPct >= 0 && discountPct <= 100)) throw new Error('Discount must be 0-100%');
    if (!(taxRateBp >= 0)) throw new Error('Tax rate must be non-negative');
    const subtotal = cart.reduce((s, l) => s + l.price * l.qty, 0);
    const discount = roundDiv(subtotal * Math.round(discountPct * 100), 10000);
    const taxable = subtotal - discount;
    const tax = roundDiv(taxable * taxRateBp, 10000);
    return { subtotal, discount, tax, total: taxable + tax };
  }

  function checkout({ cart, products, discountPct, taxRateBp, method, tendered, now = Date.now(), id }) {
    if (!cart.length) throw new Error('Cart is empty');
    for (const line of cart) {
      const p = products.find(x => x.id === line.id);
      if (!p) throw new Error(`Product "${line.name}" no longer exists`);
      if (line.qty > p.stock) throw new Error(`Only ${p.stock} of "${p.name}" in stock`);
    }
    const totals = computeTotals(cart, discountPct, taxRateBp);
    let paid = totals.total, change = 0;
    if (method === 'cash') {
      if (!Number.isInteger(tendered) || tendered < totals.total) throw new Error('Insufficient cash tendered');
      paid = tendered;
      change = tendered - totals.total;
    } else if (method !== 'card') {
      throw new Error('Unknown payment method');
    }
    const updatedProducts = products.map(p => {
      const line = cart.find(l => l.id === p.id);
      return line ? { ...p, stock: p.stock - line.qty } : p;
    });
    const sale = {
      id: id || 'S' + now,
      date: new Date(now).toISOString(),
      lines: cart.map(l => ({ ...l })),
      discountPct, taxRateBp, method, paid, change, refunded: false,
      ...totals,
    };
    return { sale, products: updatedProducts };
  }

  function refund(sale, products) {
    if (sale.refunded) throw new Error('Sale already refunded');
    const updatedProducts = products.map(p => {
      const line = sale.lines.find(l => l.id === p.id);
      return line ? { ...p, stock: p.stock + line.qty } : p;
    });
    return { sale: { ...sale, refunded: true }, products: updatedProducts };
  }

  function summarize(sales) {
    const valid = sales.filter(s => !s.refunded);
    return {
      count: valid.length,
      revenue: valid.reduce((s, x) => s + x.total, 0),
      tax: valid.reduce((s, x) => s + x.tax, 0),
      refunds: sales.length - valid.length,
    };
  }

  const api = { toCents, formatCents, addToCart, setQty, computeTotals, checkout, refund, summarize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.POS = api;
})(this);
