(function () {
  'use strict';
  const { toCents, formatCents, addToCart, setQty, computeTotals, checkout, refund, summarize } = window.POS;
  const KEY = 'pos-data-v1';
  const $ = s => document.querySelector(s);

  const defaults = () => ({
    settings: { storeName: 'My Store', taxRateBp: 825 },
    products: [
      { id: 'p1', sku: '1001', name: 'Coffee', price: 350, stock: 50 },
      { id: 'p2', sku: '1002', name: 'Tea', price: 275, stock: 40 },
      { id: 'p3', sku: '1003', name: 'Bagel', price: 199, stock: 25 },
      { id: 'p4', sku: '1004', name: 'Muffin', price: 325, stock: 20 },
    ],
    sales: [],
  });

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && Array.isArray(d.products) && Array.isArray(d.sales) && d.settings) return d;
    } catch (e) { /* fall through */ }
    return defaults();
  }
  let data = load();
  let cart = [];

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); }
    catch (e) { toast('Could not save data: ' + e.message, true); }
  }

  let toastTimer;
  function toast(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = ''), 2500);
  }

  function el(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    for (const c of children) e.append(c);
    return e;
  }

  const product = id => data.products.find(p => p.id === id);
  function guard(fn) {
    return (...args) => { try { fn(...args); } catch (e) { toast(e.message, true); } };
  }

  // ---------- Register ----------
  function renderGrid() {
    const q = $('#search').value.trim().toLowerCase();
    const grid = $('#product-grid');
    grid.replaceChildren();
    const list = data.products.filter(p => !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
    if (!list.length) grid.append(el('p', { className: 'muted', textContent: 'No products found.' }));
    for (const p of list) {
      const b = el('button', { className: 'tile', disabled: p.stock <= 0 },
        el('strong', { textContent: p.name }),
        el('span', { textContent: formatCents(p.price) }),
        el('small', { textContent: p.stock > 0 ? `${p.stock} in stock` : 'Out of stock' }));
      b.addEventListener('click', guard(() => { cart = addToCart(cart, p); renderCart(); }));
      grid.append(b);
    }
  }

  function discountPct() {
    const v = Number($('#discount').value);
    return Number.isFinite(v) ? v : NaN;
  }

  function renderCart() {
    const ul = $('#cart-lines');
    ul.replaceChildren();
    if (!cart.length) ul.append(el('li', { className: 'muted', textContent: 'No items yet.' }));
    for (const line of cart) {
      const qty = el('input', { type: 'number', min: '0', step: '1', value: String(line.qty), ariaLabel: 'Quantity' });
      qty.addEventListener('change', () => {
        try {
          const n = Number(qty.value);
          cart = setQty(cart, line.id, n, product(line.id).stock);
        } catch (e) { toast(e.message, true); }
        renderCart();
      });
      ul.append(el('li', {},
        el('span', { textContent: line.name }),
        qty,
        el('span', { textContent: formatCents(line.price * line.qty) })));
    }
    const dl = $('#totals');
    dl.replaceChildren();
    let t;
    try { t = computeTotals(cart, discountPct(), data.settings.taxRateBp); }
    catch (e) { dl.append(el('dt', { textContent: e.message })); return updatePayButtons(null); }
    const rows = [['Subtotal', t.subtotal], ['Discount', -t.discount],
      [`Tax (${(data.settings.taxRateBp / 100).toFixed(2)}%)`, t.tax], ['Total', t.total]];
    for (const [k, v] of rows) {
      const cls = k === 'Total' ? 'grand' : '';
      dl.append(el('dt', { className: cls, textContent: k }), el('dd', { className: cls, textContent: formatCents(v) }));
    }
    updatePayButtons(t);
  }

  function updatePayButtons(t) {
    const disabled = !t || !cart.length;
    $('#pay-cash').disabled = disabled;
    $('#pay-card').disabled = disabled;
  }

  function pay(method) {
    let tendered;
    if (method === 'cash') {
      const raw = $('#tendered').value.trim();
      if (!raw) throw new Error('Enter cash tendered');
      tendered = toCents(raw);
    }
    const r = checkout({ cart, products: data.products, discountPct: discountPct(),
      taxRateBp: data.settings.taxRateBp, method, tendered, id: nextSaleId() });
    data.products = r.products;
    data.sales.unshift(r.sale);
    save();
    cart = [];
    $('#tendered').value = '';
    $('#discount').value = '0';
    renderAll();
    showReceipt(r.sale);
  }

  function nextSaleId() {
    const max = data.sales.reduce((m, s) => Math.max(m, Number(String(s.id).replace(/\D/g, '')) || 0), 0);
    return 'S' + String(max + 1).padStart(5, '0');
  }

  function showReceipt(sale) {
    const w = 32;
    const line = (l, r) => l.slice(0, w - r.length - 1).padEnd(w - r.length) + r;
    const out = [data.settings.storeName.slice(0, w).padStart(Math.floor((w + data.settings.storeName.length) / 2)),
      `Sale ${sale.id}`, new Date(sale.date).toLocaleString(), '-'.repeat(w)];
    for (const l of sale.lines) {
      out.push(l.name.slice(0, w));
      out.push(line(`  ${l.qty} x ${formatCents(l.price)}`, formatCents(l.qty * l.price)));
    }
    out.push('-'.repeat(w), line('Subtotal', formatCents(sale.subtotal)));
    if (sale.discount) out.push(line(`Discount ${sale.discountPct}%`, '-' + formatCents(sale.discount)));
    out.push(line(`Tax ${(sale.taxRateBp / 100).toFixed(2)}%`, formatCents(sale.tax)),
      line('TOTAL', formatCents(sale.total)),
      line(sale.method === 'cash' ? 'Cash' : 'Card', formatCents(sale.paid)));
    if (sale.method === 'cash') out.push(line('Change', formatCents(sale.change)));
    if (sale.refunded) out.push('', '*** REFUNDED ***');
    out.push('', 'Thank you!');
    $('#receipt').textContent = out.join('\n');
    $('#receipt-dialog').showModal();
  }

  // ---------- Products ----------
  function renderProducts() {
    const tb = $('#product-rows');
    tb.replaceChildren();
    for (const p of data.products) {
      const edit = el('button', { textContent: 'Edit' });
      edit.addEventListener('click', () => {
        const f = $('#product-form');
        f.id.value = p.id; f.sku.value = p.sku; f.name.value = p.name;
        f.price.value = (p.price / 100).toFixed(2); f.stock.value = p.stock;
        f.sku.focus();
      });
      const del = el('button', { textContent: 'Delete', className: 'danger' });
      del.addEventListener('click', () => {
        if (!confirm(`Delete "${p.name}"?`)) return;
        data.products = data.products.filter(x => x.id !== p.id);
        cart = cart.filter(l => l.id !== p.id);
        save(); renderAll();
      });
      tb.append(el('tr', {},
        el('td', { textContent: p.sku }), el('td', { textContent: p.name }),
        el('td', { className: 'num', textContent: formatCents(p.price) }),
        el('td', { className: 'num', textContent: String(p.stock) }),
        el('td', {}, edit, ' ', del)));
    }
  }

  $('#product-form').addEventListener('submit', guard(e => {
    e.preventDefault();
    const f = e.target;
    const sku = f.sku.value.trim(), name = f.name.value.trim();
    const stock = Number(f.stock.value);
    if (!sku || !name) throw new Error('SKU and name are required');
    if (!Number.isInteger(stock) || stock < 0) throw new Error('Stock must be a whole number ≥ 0');
    const price = toCents(f.price.value);
    const id = f.id.value;
    if (data.products.some(p => p.sku === sku && p.id !== id)) throw new Error('SKU already exists');
    if (id) {
      data.products = data.products.map(p => (p.id === id ? { ...p, sku, name, price, stock } : p));
      // Keep cart consistent with edited product.
      cart = cart.map(l => (l.id === id ? { ...l, name, price, qty: Math.min(l.qty, stock) } : l)).filter(l => l.qty > 0);
    } else {
      data.products.push({ id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), sku, name, price, stock });
    }
    save(); f.reset(); f.id.value = '';
    renderAll();
    toast('Product saved');
  }));
  $('#product-form').addEventListener('reset', e => { e.target.id.value = ''; });

  // ---------- Sales ----------
  function renderSales() {
    const s = summarize(data.sales);
    $('#summary').replaceChildren(
      el('div', { textContent: `Sales: ${s.count}` }),
      el('div', { textContent: `Revenue: ${formatCents(s.revenue)}` }),
      el('div', { textContent: `Tax collected: ${formatCents(s.tax)}` }),
      el('div', { textContent: `Refunds: ${s.refunds}` }));
    const tb = $('#sale-rows');
    tb.replaceChildren();
    if (!data.sales.length) tb.append(el('tr', {}, el('td', { colSpan: 6, className: 'muted', textContent: 'No sales yet.' })));
    for (const sale of data.sales) {
      const view = el('button', { textContent: 'Receipt' });
      view.addEventListener('click', () => showReceipt(sale));
      const cell = el('td', {}, view);
      if (!sale.refunded) {
        const rf = el('button', { textContent: 'Refund', className: 'danger' });
        rf.addEventListener('click', guard(() => {
          if (!confirm(`Refund sale ${sale.id} for ${formatCents(sale.total)}?`)) return;
          const r = refund(sale, data.products);
          data.products = r.products;
          data.sales = data.sales.map(x => (x.id === sale.id ? r.sale : x));
          save(); renderAll(); toast('Sale refunded');
        }));
        cell.append(' ', rf);
      }
      tb.append(el('tr', {},
        el('td', { textContent: sale.id }),
        el('td', { textContent: new Date(sale.date).toLocaleString() }),
        el('td', { textContent: sale.method }),
        el('td', { className: 'num', textContent: formatCents(sale.total) }),
        el('td', { textContent: sale.refunded ? 'Refunded' : 'Completed' }),
        cell));
    }
  }

  // ---------- Settings ----------
  function renderSettings() {
    const f = $('#settings-form');
    f.storeName.value = data.settings.storeName;
    f.taxRate.value = (data.settings.taxRateBp / 100).toFixed(2);
  }
  $('#settings-form').addEventListener('submit', guard(e => {
    e.preventDefault();
    const f = e.target;
    const rate = Number(f.taxRate.value);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error('Tax rate must be 0–100');
    data.settings = { storeName: f.storeName.value.trim() || 'My Store', taxRateBp: Math.round(rate * 100) };
    save(); renderAll(); toast('Settings saved');
  }));
  $('#reset-data').addEventListener('click', () => {
    if (!confirm('Delete ALL products, sales and settings?')) return;
    data = defaults(); cart = []; save(); renderAll(); toast('Data reset');
  });

  // ---------- Wiring ----------
  function renderAll() { renderGrid(); renderCart(); renderProducts(); renderSales(); renderSettings(); }

  document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + b.dataset.view));
  }));
  $('#search').addEventListener('input', renderGrid);
  $('#search').addEventListener('keydown', guard(e => {
    if (e.key !== 'Enter') return;
    const q = e.target.value.trim();
    const p = data.products.find(x => x.sku === q);
    if (!p) return;
    cart = addToCart(cart, p);
    e.target.value = '';
    renderGrid(); renderCart();
  }));
  $('#discount').addEventListener('input', renderCart);
  $('#pay-cash').addEventListener('click', guard(() => pay('cash')));
  $('#pay-card').addEventListener('click', guard(() => pay('card')));
  $('#clear-cart').addEventListener('click', () => { cart = []; renderCart(); });
  $('#close-receipt').addEventListener('click', () => $('#receipt-dialog').close());

  renderAll();
})();
