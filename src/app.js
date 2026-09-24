(function () {
  'use strict';
  const P = window.POS;
  const { toCents, formatCents: money } = P;
  const KEY = 'pos-data-v2';
  const LEGACY_KEY = 'pos-data-v1';
  const IDLE_LOCK_MS = 5 * 60 * 1000;
  const MAX_PIN_TRIES = 5;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  // ---------------------------------------------------------------- data ----
  function defaults() {
    return {
      version: 2,
      settings: { storeName: 'My Store', header: '123 Main St\n(555) 010-0000', footer: 'Thank you for shopping with us!', taxRateBp: 825, cashierMaxDiscount: 10 },
      staff: [{ id: 'u1', name: 'Manager', role: 'manager', pinHash: null, defaultPin: true }],
      products: [
        { id: 'p1', sku: '1001', name: 'Coffee', category: 'Drinks', price: 350, stock: 50, lowStock: 10 },
        { id: 'p2', sku: '1002', name: 'Tea', category: 'Drinks', price: 275, stock: 40, lowStock: 10 },
        { id: 'p3', sku: '1003', name: 'Orange Juice', category: 'Drinks', price: 425, stock: 8, lowStock: 10 },
        { id: 'p4', sku: '2001', name: 'Bagel', category: 'Bakery', price: 199, stock: 25, lowStock: 5 },
        { id: 'p5', sku: '2002', name: 'Muffin', category: 'Bakery', price: 325, stock: 20, lowStock: 5 },
        { id: 'p6', sku: '2003', name: 'Croissant', category: 'Bakery', price: 375, stock: 15, lowStock: 5 },
        { id: 'p7', sku: '3001', name: 'Sandwich', category: 'Food', price: 895, stock: 12, lowStock: 4 },
        { id: 'p8', sku: '3002', name: 'Salad', category: 'Food', price: 1050, stock: 10, lowStock: 4 },
      ],
      sales: [], shifts: [], currentShiftId: null, held: [],
      seq: { sale: 0, shift: 0 },
    };
  }

  function migrateV1(old) {
    const d = defaults();
    d.settings.storeName = (old.settings && old.settings.storeName) || d.settings.storeName;
    if (old.settings && Number.isInteger(old.settings.taxRateBp)) d.settings.taxRateBp = old.settings.taxRateBp;
    d.products = old.products.map(p => ({ category: 'General', lowStock: 5, ...p }));
    d.sales = old.sales.map(s => ({ ...s, payments: s.payments || [{ method: s.method, amount: s.paid }] }));
    d.seq.sale = d.sales.length;
    return d;
  }

  function isValidData(d) {
    return d && typeof d === 'object' && d.settings && Array.isArray(d.staff) && d.staff.some(s => s.role === 'manager') &&
      Array.isArray(d.products) && Array.isArray(d.sales) && Array.isArray(d.shifts) && Array.isArray(d.held) && d.seq;
  }

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (isValidData(d)) return d;
      const old = JSON.parse(localStorage.getItem(LEGACY_KEY));
      if (old && Array.isArray(old.products) && Array.isArray(old.sales)) return migrateV1(old);
    } catch (e) { /* ignore and use defaults */ }
    return defaults();
  }

  let data = load();
  let user = null;           // logged-in staff member
  let cart = [];
  let orderDiscountPct = 0;
  let category = 'All';

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); }
    catch (e) { toast('Could not save data: ' + e.message, true); }
  }

  const currentShift = () => data.shifts.find(s => s.id === data.currentShiftId && !s.closedAt) || null;
  const productById = id => data.products.find(p => p.id === id);
  const isManager = () => user && user.role === 'manager';
  const nextId = (kind, prefix, width) => prefix + String(++data.seq[kind]).padStart(width, '0');
  const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------------------------------------------------------------- utils ---
  let toastTimer;
  function toast(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = ''), 2800);
  }

  function el(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'onclick' || k === 'onchange' || k === 'oninput') e.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else e[k] = v;
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }

  // Wrap handlers so any thrown error (sync or async) shows as a toast.
  const guard = fn => async (...args) => {
    try { await fn(...args); } catch (e) { toast(e.message, true); }
  };

  const localDate = iso => new Date(iso).toLocaleString();
  function parseDay(str) { // 'YYYY-MM-DD' -> local midnight Date
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
  const validPin = pin => /^\d{4,8}$/.test(pin);

  // ------------------------------------------------------------- dialogs ---
  // Generic form dialog. fields: [{name,label,type,value,options,placeholder}]
  function ask({ title, text = '', fields = [], ok = 'OK' }) {
    return new Promise(resolve => {
      const dlg = $('#prompt-dialog');
      $('#prompt-title').textContent = title;
      $('#prompt-text').textContent = text;
      $('#prompt-form button[value=ok]').textContent = ok;
      const box = $('#prompt-fields');
      box.replaceChildren();
      const inputs = {};
      for (const f of fields) {
        let input;
        if (f.type === 'select') {
          input = el('select', { name: f.name }, ...f.options.map(o => el('option', { value: o.value, textContent: o.label })));
          if (f.value != null) input.value = f.value;
        } else {
          input = el('input', { name: f.name, type: f.type || 'text', value: f.value != null ? f.value : '', placeholder: f.placeholder || '', autocomplete: 'off' });
          if (f.inputmode) input.inputMode = f.inputmode;
        }
        inputs[f.name] = input;
        box.append(el('label', {}, f.label, input));
      }
      const finish = val => {
        dlg.removeEventListener('close', onClose);
        $('#prompt-cancel').onclick = null;
        if (dlg.open) dlg.close();
        resolve(val);
      };
      const onClose = () => finish(dlg.returnValue === 'ok' ? Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value])) : null);
      dlg.returnValue = '';
      dlg.addEventListener('close', onClose);
      $('#prompt-cancel').onclick = () => { dlg.returnValue = 'cancel'; dlg.close(); };
      dlg.showModal();
      const first = box.querySelector('input, select');
      if (first) first.focus();
    });
  }

  async function confirmBox(title, text) {
    return (await ask({ title, text, ok: 'Confirm' })) !== null;
  }

  // Returns the approving manager, or null. Managers approve themselves.
  async function managerApproval(reason) {
    if (isManager()) return user;
    const managers = data.staff.filter(s => s.role === 'manager');
    const r = await ask({
      title: 'Manager approval', text: reason, ok: 'Approve',
      fields: [
        { name: 'id', label: 'Manager', type: 'select', options: managers.map(m => ({ value: m.id, label: m.name })) },
        { name: 'pin', label: 'PIN', type: 'password', inputmode: 'numeric' },
      ],
    });
    if (!r) return null;
    const m = managers.find(x => x.id === r.id);
    if (!m || !(await checkPin(m, r.pin))) { toast('Approval denied: wrong PIN', true); return null; }
    return m;
  }

  function showText(text) {
    $('#receipt').textContent = text;
    $('#receipt-dialog').showModal();
  }

  // --------------------------------------------------------------- login ---
  let loginSel = null, pinBuf = '', failed = 0, lockedUntil = 0;

  function renderLogin() {
    $('#login-store').textContent = data.settings.storeName;
    const box = $('#login-staff');
    box.replaceChildren();
    if (!data.staff.some(s => s.id === (loginSel && loginSel.id))) loginSel = data.staff[0];
    for (const s of data.staff) {
      box.append(el('button', {
        textContent: s.name, className: s === loginSel ? 'active' : '',
        onclick: () => { loginSel = s; pinBuf = ''; renderLogin(); $('#pin-display').focus(); },
      }));
    }
    $('#pin-display').value = pinBuf;
    const def = data.staff.find(s => s.defaultPin && !s.pinHash);
    $('#login-hint').textContent = def ? `First run: "${def.name}" PIN is 1234. Change it under Staff.` : '';
  }

  function buildKeypad() {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'OK'];
    $('#keypad').replaceChildren(...keys.map(k => el('button', {
      textContent: k, className: k === 'OK' ? 'primary' : '',
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
    if (Date.now() < lockedUntil) return toast(`Too many attempts. Try again in ${Math.ceil((lockedUntil - Date.now()) / 1000)}s`, true);
    if (!loginSel) return;
    const ok = await checkPin(loginSel, pinBuf);
    pinBuf = ''; $('#pin-display').value = '';
    if (!ok) {
      if (++failed >= MAX_PIN_TRIES) { lockedUntil = Date.now() + 30000; failed = 0; }
      return toast('Wrong PIN', true);
    }
    failed = 0;
    user = loginSel;
    $('#login').hidden = true;
    $('#app').hidden = false;
    applyRole();
    renderAll();
    showView(currentShift() ? 'register' : 'shift');
    $('#search').focus();
    toast(`Welcome, ${user.name}`);
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
    if (user) idleTimer = setTimeout(() => { if (user) { lock(); toast('Locked due to inactivity'); } }, IDLE_LOCK_MS);
  }

  function applyRole() {
    for (const b of $$('nav button[data-role=manager]')) b.hidden = !isManager();
    $('#user-badge').textContent = `${user.name} · ${user.role}`;
  }

  function showView(name) {
    const btn = $(`nav button[data-view="${name}"]`);
    if (!btn || btn.hidden) return;
    for (const b of $$('nav button')) b.classList.toggle('active', b === btn);
    for (const v of $$('.view')) v.classList.toggle('active', v.id === 'view-' + name);
    if (name === 'register') $('#search').focus();
  }

  // ------------------------------------------------------------ register ---
  function renderCategories() {
    const cats = ['All', ...new Set(data.products.map(p => p.category || 'General'))].sort((a, b) => (a === 'All' ? -1 : b === 'All' ? 1 : a.localeCompare(b)));
    if (!cats.includes(category)) category = 'All';
    $('#categories').replaceChildren(...cats.map(c => el('button', {
      textContent: c, className: c === category ? 'active' : '',
      onclick: () => { category = c; renderCategories(); renderGrid(); },
    })));
    $('#category-list').replaceChildren(...cats.filter(c => c !== 'All').map(c => el('option', { value: c })));
  }

  function renderGrid() {
    const q = $('#search').value.trim().toLowerCase();
    const list = data.products.filter(p =>
      (category === 'All' || (p.category || 'General') === category) &&
      (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)));
    const grid = $('#product-grid');
    grid.replaceChildren();
    if (!list.length) grid.append(el('p', { className: 'muted', textContent: 'No products found.' }));
    for (const p of list) {
      const inCart = (cart.find(l => l.id === p.id) || { qty: 0 }).qty;
      const left = p.stock - inCart;
      const low = p.stock <= (p.lowStock || 0);
      grid.append(el('button', {
        className: 'tile', disabled: left <= 0, title: `SKU ${p.sku}`,
        onclick: guard(() => addProduct(p)),
      },
      el('strong', { textContent: p.name }),
      el('span', { className: 'price', textContent: money(p.price) }),
      el('small', { className: low ? 'low' : '', textContent: p.stock <= 0 ? 'Out of stock' : `${p.stock} in stock${low ? ' · low' : ''}` })));
    }
  }

  function addProduct(p) {
    cart = P.addToCart(cart, p);
    renderGrid(); renderCart();
  }

  async function changeDiscount(pct, apply, what) {
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('Discount must be 0-100%');
    if (pct > data.settings.cashierMaxDiscount && !isManager()) {
      const m = await managerApproval(`${what} of ${pct}% exceeds the cashier limit of ${data.settings.cashierMaxDiscount}%.`);
      if (!m) return false;
    }
    apply(pct);
    return true;
  }

  function renderCart() {
    const tb = $('#cart-lines');
    tb.replaceChildren();
    if (!cart.length) tb.append(el('tr', {}, el('td', { colSpan: 5, className: 'muted', textContent: 'Scan or tap an item to start a sale.' })));
    for (const line of cart) {
      const lt = P.lineTotals(line);
      tb.append(el('tr', {},
        el('td', {}, el('div', { textContent: line.name }), el('small', { className: 'muted', textContent: `${money(line.price)} ea` })),
        el('td', {}, el('input', {
          type: 'number', min: '0', step: '1', value: String(line.qty), ariaLabel: `Quantity of ${line.name}`,
          onchange: guard(async e => {
            try { cart = P.setQty(cart, line.id, Number(e.target.value), productById(line.id).stock); }
            finally { renderCart(); renderGrid(); }
          }),
        })),
        el('td', {}, el('input', {
          type: 'number', min: '0', max: '100', step: '1', value: String(line.discountPct || 0), ariaLabel: `Discount on ${line.name}`,
          onchange: guard(async e => {
            try { await changeDiscount(Number(e.target.value), pct => { cart = P.setLineDiscount(cart, line.id, pct); }, 'A line discount'); }
            finally { renderCart(); }
          }),
        })),
        el('td', { className: 'num' }, lt.discount ? el('s', { className: 'muted small', textContent: money(lt.gross) }) : null, lt.discount ? el('br') : null, money(lt.net)),
        el('td', {}, el('button', { className: 'x ghost', textContent: '✕', title: 'Remove', onclick: () => { cart = cart.filter(l => l.id !== line.id); renderCart(); renderGrid(); } }))));
    }
    $('#order-discount').value = String(orderDiscountPct);
    const t = P.computeTotals(cart, orderDiscountPct, data.settings.taxRateBp);
    const rows = [['Items', String(cart.reduce((a, l) => a + l.qty, 0))], ['Subtotal', money(t.gross)]];
    if (t.itemDiscount) rows.push(['Item discounts', money(-t.itemDiscount)]);
    if (t.orderDiscount) rows.push([`Order discount (${orderDiscountPct}%)`, money(-t.orderDiscount)]);
    rows.push([`Tax (${(data.settings.taxRateBp / 100).toFixed(2)}%)`, money(t.tax)], ['Total', money(t.total)]);
    $('#totals').replaceChildren(...rows.flatMap(([k, v]) => {
      const cls = k === 'Total' ? 'grand' : '';
      return [el('dt', { className: cls, textContent: k }), el('dd', { className: cls, textContent: v })];
    }));
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

  function openPayment() {
    if (!cart.length) return;
    if (!currentShift()) throw new Error('Open a shift before taking payments');
    for (const l of cart) {
      const p = productById(l.id);
      if (!p || l.qty > p.stock) throw new Error(`Not enough stock for "${l.name}"`);
    }
    payTotals = P.computeTotals(cart, orderDiscountPct, data.settings.taxRateBp);
    payments = [];
    renderPayment();
    $('#pay-dialog').showModal();
    $('#pay-amount').select();
  }

  function renderPayment() {
    const paid = payments.reduce((a, p) => a + p.amount, 0);
    const due = payTotals.total - paid;
    $('#pay-total').textContent = money(payTotals.total);
    $('#pay-paid').textContent = money(paid);
    $('#pay-due-label').textContent = due > 0 ? 'Balance due' : 'Change';
    $('#pay-due').textContent = money(Math.abs(due));
    $('#pay-list').replaceChildren(...payments.map((p, i) => el('li', {},
      el('span', { textContent: `${p.method === 'cash' ? 'Cash' : 'Card'} ${money(p.amount)}` }),
      el('button', { className: 'small ghost', textContent: 'Remove', onclick: () => { payments.splice(i, 1); renderPayment(); } }))));
    $('#pay-amount').value = due > 0 ? (due / 100).toFixed(2) : '';
    $('#add-cash').disabled = $('#add-card').disabled = due <= 0;
    $('#pay-complete').disabled = due > 0;
    const quick = new Set();
    if (due > 0) {
      quick.add(due);
      for (const bill of [500, 1000, 2000, 5000, 10000]) {
        const v = Math.ceil(due / bill) * bill;
        if (v > due) quick.add(v);
      }
    }
    $('#quick-cash').replaceChildren(...[...quick].sort((a, b) => a - b).slice(0, 5).map(v => el('button', {
      textContent: v === due ? `Exact ${money(v)}` : money(v),
      onclick: () => addPayment('cash', v),
    })));
    if (due <= 0) $('#pay-complete').focus();
  }

  function addPayment(method, amount) {
    const paid = payments.reduce((a, p) => a + p.amount, 0);
    const due = payTotals.total - paid;
    if (amount == null) {
      const raw = $('#pay-amount').value.trim();
      if (!raw) throw new Error('Enter an amount');
      amount = toCents(raw);
    }
    if (amount <= 0) throw new Error('Amount must be positive');
    if (method === 'card' && amount > due) throw new Error(`Card amount cannot exceed balance of ${money(due)}`);
    payments.push({ method, amount });
    renderPayment();
  }

  function completeSale() {
    const shift = currentShift();
    if (!shift) throw new Error('No open shift');
    const r = P.checkout({
      cart, products: data.products, orderDiscountPct, taxRateBp: data.settings.taxRateBp,
      payments, cashier: user.name, shiftId: shift.id, id: nextId('sale', 'S', 6),
    });
    data.products = r.products;
    data.sales.unshift(r.sale);
    save();
    $('#pay-dialog').close();
    resetSale();
    renderAll();
    showText(receiptText(r.sale));
    if (r.sale.change) toast(`Change due: ${money(r.sale.change)}`);
  }

  // --------------------------------------------------------------- receipts ---
  const W = 40;
  const center = s => { s = s.slice(0, W); return ' '.repeat(Math.floor((W - s.length) / 2)) + s; };
  const lr = (l, r) => { l = String(l); r = String(r); return l.slice(0, Math.max(0, W - r.length - 1)).padEnd(W - r.length) + r; };
  const rule = (c = '-') => c.repeat(W);

  function receiptText(sale) {
    const s = data.settings;
    const out = [center(s.storeName), ...s.header.split('\n').filter(Boolean).map(center), '',
      lr(`Sale ${sale.id}`, sale.cashier ? `Cashier: ${sale.cashier}` : ''), localDate(sale.date), rule()];
    for (const l of sale.lines) {
      const lt = P.lineTotals(l);
      out.push(l.name.slice(0, W));
      out.push(lr(`  ${l.qty} x ${money(l.price)}`, money(lt.gross)));
      if (lt.discount) out.push(lr(`  Discount ${l.discountPct}%`, money(-lt.discount)));
    }
    out.push(rule(), lr('Subtotal', money(sale.subtotal)));
    if (sale.orderDiscount) out.push(lr(`Order discount ${sale.orderDiscountPct}%`, money(-sale.orderDiscount)));
    out.push(lr(`Tax ${(sale.taxRateBp / 100).toFixed(2)}%`, money(sale.tax)), rule('='), lr('TOTAL', money(sale.total)), rule('='));
    for (const p of sale.payments || []) out.push(lr(p.method === 'cash' ? 'Cash' : 'Card', money(p.amount)));
    if (sale.change) out.push(lr('Change', money(sale.change)));
    if (sale.discount) out.push('', center(`You saved ${money(sale.discount)}`));
    if (sale.refunded) out.push('', center('*** REFUNDED ***'), center(localDate(sale.refund.date)));
    out.push('', ...s.footer.split('\n').filter(Boolean).map(center));
    return out.join('\n');
  }

  function shiftReportText(shift, final) {
    const r = final && shift.report ? shift.report : P.shiftReport(shift, data.sales);
    const out = [center(data.settings.storeName), center(final ? 'Z REPORT (SHIFT CLOSE)' : 'X REPORT (MID-SHIFT)'), '',
      lr('Shift', shift.id), lr('Opened', localDate(shift.openedAt)), lr('Opened by', shift.openedBy)];
    if (shift.closedAt) out.push(lr('Closed', localDate(shift.closedAt)), lr('Closed by', shift.closedBy || ''));
    out.push(rule(), lr('Transactions', r.transactions), lr('Gross sales', money(r.grossSales)), lr('Discounts given', money(r.discounts)),
      lr('Tax collected', money(r.tax)), lr(`Refunds (${r.refundCount})`, money(-r.refundTotal)), lr('Net sales', money(r.netSales)),
      rule(), lr('Card sales', money(r.cardSales)), lr('Card refunds', money(-r.cardRefunds)),
      rule(), 'CASH DRAWER', lr('Opening float', money(r.float)), lr('Cash sales', money(r.cashSales)),
      lr('Cash refunds', money(-r.cashRefunds)), lr('Pay ins', money(r.payIns)), lr('Pay outs', money(-r.payOuts)),
      rule('='), lr('Expected in drawer', money(r.expectedCash)));
    if (r.counted != null) out.push(lr('Counted', money(r.counted)), lr(r.variance === 0 ? 'Balanced' : r.variance > 0 ? 'Over' : 'Short', money(Math.abs(r.variance))));
    if (shift.movements.length) {
      out.push(rule(), 'CASH MOVEMENTS');
      for (const m of shift.movements) out.push(lr(`${m.type === 'in' ? 'IN ' : 'OUT'} ${m.reason}`, money(m.type === 'in' ? m.amount : -m.amount)));
    }
    out.push('', center(`Printed ${new Date().toLocaleString()}`));
    return out.join('\n');
  }

  // ---------------------------------------------------------------- hold ---
  function holdSale() {
    if (!cart.length) return;
    data.held.push({ id: uid('h'), cart, orderDiscountPct, by: user.name, date: new Date().toISOString() });
    save(); resetSale(); toast('Sale held');
  }

  async function recallSale() {
    if (cart.length) throw new Error('Hold or void the current sale first');
    if (!data.held.length) return;
    const r = await ask({
      title: 'Recall held sale', ok: 'Recall',
      fields: [{ name: 'id', label: 'Held sale', type: 'select', options: data.held.map(h => ({
        value: h.id, label: `${new Date(h.date).toLocaleTimeString()} · ${h.by} · ${h.cart.reduce((a, l) => a + l.qty, 0)} items · ${money(P.computeTotals(h.cart, h.orderDiscountPct, data.settings.taxRateBp).total)}`,
      })) }],
    });
    if (!r) return;
    const h = data.held.find(x => x.id === r.id);
    // Re-price from the current catalog; drop items that no longer exist.
    cart = h.cart.map(l => { const p = productById(l.id); return p && { ...l, name: p.name, price: p.price }; }).filter(Boolean);
    orderDiscountPct = h.orderDiscountPct;
    data.held = data.held.filter(x => x.id !== h.id);
    save(); renderCart(); renderGrid();
    if (cart.length < h.cart.length) toast('Some held items are no longer sold and were removed', true);
  }

  // ---------------------------------------------------------------- sales ---
  function renderSales() {
    const q = $('#sale-search').value.trim().toLowerCase();
    const list = data.sales.filter(s => !q || s.id.toLowerCase().includes(q) || (s.cashier || '').toLowerCase().includes(q));
    const tb = $('#sale-rows');
    tb.replaceChildren();
    if (!list.length) tb.append(el('tr', {}, el('td', { colSpan: 7, className: 'muted', textContent: 'No sales.' })));
    for (const sale of list.slice(0, 500)) {
      const tender = [...new Set((sale.payments || []).map(p => p.method))].join(' + ') || sale.method || '';
      tb.append(el('tr', { className: sale.refunded ? 'refunded' : '' },
        el('td', { textContent: sale.id }), el('td', { textContent: localDate(sale.date) }),
        el('td', { textContent: sale.cashier || '—' }), el('td', { textContent: tender }),
        el('td', { className: 'num', textContent: money(sale.total) }),
        el('td', { textContent: sale.refunded ? 'Refunded' : 'Completed' }),
        el('td', {},
          el('button', { className: 'small', textContent: 'Receipt', onclick: () => showText(receiptText(sale)) }), ' ',
          sale.refunded ? null : el('button', { className: 'small danger', textContent: 'Refund', onclick: guard(() => refundSale(sale.id)) }))));
    }
  }

  async function refundSale(id) {
    const shift = currentShift();
    if (!shift) throw new Error('Open a shift to process refunds');
    const sale = data.sales.find(s => s.id === id);
    const cash = sale.cashNet != null ? sale.cashNet : (sale.method === 'cash' ? sale.total : 0);
    if (cash > P.shiftReport(shift, data.sales).expectedCash) throw new Error('Not enough cash in the drawer for this refund');
    const m = await managerApproval(`Refund sale ${sale.id} for ${money(sale.total)}.`);
    if (!m) return;
    if (!(await confirmBox('Confirm refund', `Refund ${money(sale.total)}${cash ? ` (${money(cash)} cash from drawer)` : ''} and return items to stock?`))) return;
    const r = P.refund(sale, data.products, { by: m.name, shiftId: shift.id });
    data.products = r.products;
    data.sales = data.sales.map(s => (s.id === id ? r.sale : s));
    save(); renderAll(); toast('Refund complete');
    showText(receiptText(r.sale));
  }

  // ---------------------------------------------------------------- shift ---
  function renderShift() {
    const shift = currentShift();
    const panel = $('#shift-panel');
    panel.replaceChildren();
    const badge = $('#shift-badge');
    badge.textContent = shift ? `Shift ${shift.id} open` : 'No shift';
    badge.className = 'badge ' + (shift ? 'ok' : 'warn');
    if (!shift) {
      panel.append(el('div', { className: 'shift-box' },
        el('p', { textContent: 'No shift is open. Count the starting cash in the drawer to open a shift.' }),
        el('button', { className: 'primary big', textContent: 'Open shift', onclick: guard(openShiftFlow) })));
    } else {
      const r = P.shiftReport(shift, data.sales);
      panel.append(el('div', { className: 'shift-box' },
        el('p', { textContent: `Shift ${shift.id} opened ${localDate(shift.openedAt)} by ${shift.openedBy}.` }),
        el('div', { className: 'kpis' },
          kpi('Transactions', r.transactions), kpi('Net sales', money(r.netSales)),
          kpi('Card', money(r.cardSales - r.cardRefunds)), kpi('Expected cash', money(r.expectedCash))),
        el('div', { className: 'row wrap' },
          el('button', { textContent: 'Pay in', onclick: guard(() => movementFlow('in')) }),
          el('button', { textContent: 'Pay out', onclick: guard(() => movementFlow('out')) }),
          el('button', { textContent: 'X report', onclick: () => showText(shiftReportText(shift, false)) }),
          el('button', { className: 'danger', textContent: 'Close shift', onclick: guard(closeShiftFlow) }))));
    }
    const tb = $('#shift-rows');
    tb.replaceChildren();
    const closed = data.shifts.filter(s => s.closedAt).slice().reverse();
    if (!closed.length) tb.append(el('tr', {}, el('td', { colSpan: 8, className: 'muted', textContent: 'No closed shifts yet.' })));
    for (const s of closed.slice(0, 100)) {
      const r = s.report;
      tb.append(el('tr', {},
        el('td', { textContent: localDate(s.openedAt) }), el('td', { textContent: localDate(s.closedAt) }),
        el('td', { textContent: s.openedBy }), el('td', { className: 'num', textContent: money(r.netSales) }),
        el('td', { className: 'num', textContent: money(r.expectedCash) }), el('td', { className: 'num', textContent: money(r.counted) }),
        el('td', { className: 'num ' + (r.variance < 0 ? 'neg' : r.variance > 0 ? 'pos' : ''), textContent: money(r.variance) }),
        el('td', {}, el('button', { className: 'small', textContent: 'Z report', onclick: () => showText(shiftReportText(s, true)) }))));
    }
  }

  function kpi(label, value) {
    return el('div', {}, el('span', { textContent: label }), el('strong', { textContent: String(value) }));
  }

  async function openShiftFlow() {
    if (currentShift()) throw new Error('A shift is already open');
    const r = await ask({ title: 'Open shift', text: 'Count the cash in the drawer.', ok: 'Open shift',
      fields: [{ name: 'float', label: 'Opening float', inputmode: 'decimal', value: '100.00' }] });
    if (!r) return;
    const shift = P.openShift({ id: nextId('shift', 'SH', 4), cashier: user.name, float: toCents(r.float) });
    data.shifts.push(shift);
    data.currentShiftId = shift.id;
    save(); renderAll(); showView('register'); toast(`Shift ${shift.id} opened`);
  }

  async function movementFlow(type) {
    const shift = currentShift();
    if (!shift) throw new Error('No open shift');
    const r = await ask({ title: type === 'in' ? 'Pay in (add cash)' : 'Pay out (remove cash)', ok: 'Record',
      fields: [{ name: 'amount', label: 'Amount', inputmode: 'decimal' }, { name: 'reason', label: 'Reason' }] });
    if (!r) return;
    const amount = toCents(r.amount);
    if (type === 'out') {
      if (amount > P.shiftReport(shift, data.sales).expectedCash) throw new Error('Pay out exceeds cash in drawer');
      const m = await managerApproval(`Pay out ${money(amount)}: ${r.reason}`);
      if (!m) return;
    }
    const updated = P.addMovement(shift, { type, amount, reason: r.reason, by: user.name });
    data.shifts = data.shifts.map(s => (s.id === shift.id ? updated : s));
    save(); renderAll(); toast('Recorded');
  }

  async function closeShiftFlow() {
    const shift = currentShift();
    if (!shift) return;
    if (data.held.length && !(await confirmBox('Held sales', `${data.held.length} held sale(s) will stay held across shifts. Continue?`))) return;
    const r = await ask({ title: 'Close shift', text: 'Count all cash in the drawer (blind count).', ok: 'Close shift',
      fields: [{ name: 'counted', label: 'Counted cash', inputmode: 'decimal' }] });
    if (!r) return;
    const closed = P.closeShift(shift, data.sales, toCents(r.counted), { by: user.name });
    data.shifts = data.shifts.map(s => (s.id === shift.id ? closed : s));
    data.currentShiftId = null;
    save(); renderAll();
    showText(shiftReportText(closed, true));
  }

  // -------------------------------------------------------------- reports ---
  function reportRange() {
    const f = $('#rep-from').value, t = $('#rep-to').value;
    const from = f ? parseDay(f).toISOString() : undefined;
    let to;
    if (t) { const d = parseDay(t); d.setDate(d.getDate() + 1); to = d.toISOString(); }
    return { from, to };
  }

  function renderReports() {
    const range = reportRange();
    const r = P.salesReport(data.sales, range);
    $('#rep-kpis').replaceChildren(
      kpi('Revenue', money(r.revenue)), kpi('Transactions', r.count), kpi('Average sale', money(r.average)),
      kpi('Items sold', r.items), kpi('Tax collected', money(r.tax)), kpi('Discounts', money(r.discounts)), kpi('Refunded sales', r.refunds));
    $('#rep-products').replaceChildren(...(r.topProducts.length ? r.topProducts.slice(0, 20).map(p => el('tr', {},
      el('td', { textContent: p.name }), el('td', { className: 'num', textContent: String(p.qty) }), el('td', { className: 'num', textContent: money(p.net) })))
      : [el('tr', {}, el('td', { colSpan: 3, className: 'muted', textContent: 'No sales in range.' }))]));
    $('#rep-methods').replaceChildren(
      el('tr', {}, el('td', { textContent: 'Cash' }), el('td', { className: 'num', textContent: money(r.byMethod.cash) })),
      el('tr', {}, el('td', { textContent: 'Card' }), el('td', { className: 'num', textContent: money(r.byMethod.card) })));
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
    if (!list.length) tb.append(el('tr', {}, el('td', { colSpan: 6, className: 'muted', textContent: 'No products.' })));
    for (const p of list) {
      tb.append(el('tr', {},
        el('td', { textContent: p.sku }), el('td', { textContent: p.name }), el('td', { textContent: p.category || 'General' }),
        el('td', { className: 'num', textContent: money(p.price) }),
        el('td', { className: 'num' + (p.stock <= (p.lowStock || 0) ? ' low' : ''), textContent: String(p.stock) }),
        el('td', {},
          el('button', { className: 'small', textContent: 'Edit', onclick: () => editProduct(p) }), ' ',
          el('button', { className: 'small', textContent: 'Receive', title: 'Add received stock', onclick: guard(() => receiveStock(p.id)) }), ' ',
          el('button', { className: 'small danger', textContent: 'Delete', onclick: guard(() => deleteProduct(p.id)) }))));
    }
  }

  function editProduct(p) {
    const f = $('#product-form');
    f.elements.id.value = p.id; f.sku.value = p.sku; f.elements.name.value = p.name; f.category.value = p.category || '';
    f.price.value = (p.price / 100).toFixed(2); f.stock.value = p.stock; f.lowStock.value = p.lowStock || 0;
    f.sku.focus();
  }

  async function receiveStock(id) {
    const p = productById(id);
    const r = await ask({ title: `Receive stock: ${p.name}`, text: `Currently ${p.stock} in stock.`, ok: 'Add',
      fields: [{ name: 'qty', label: 'Quantity received', type: 'number' }] });
    if (!r) return;
    const qty = Number(r.qty);
    if (!Number.isInteger(qty) || qty <= 0) throw new Error('Quantity must be a positive whole number');
    data.products = data.products.map(x => (x.id === id ? { ...x, stock: x.stock + qty } : x));
    save(); renderAll(); toast(`${p.name}: ${p.stock + qty} in stock`);
  }

  async function deleteProduct(id) {
    const p = productById(id);
    if (!(await confirmBox('Delete product', `Delete "${p.name}"? Past sales keep their records.`))) return;
    data.products = data.products.filter(x => x.id !== id);
    cart = cart.filter(l => l.id !== id);
    save(); renderAll();
  }

  function saveProduct(e) {
    e.preventDefault();
    const f = e.target;
    const id = f.elements.id.value;
    const sku = f.sku.value.trim(), name = f.elements.name.value.trim(), cat = f.category.value.trim() || 'General';
    const stock = Number(f.stock.value), lowStock = f.lowStock.value === '' ? 0 : Number(f.lowStock.value);
    if (!sku || !name) throw new Error('SKU and name are required');
    if (!Number.isInteger(stock) || stock < 0) throw new Error('Stock must be a whole number ≥ 0');
    if (!Number.isInteger(lowStock) || lowStock < 0) throw new Error('Low-stock level must be a whole number ≥ 0');
    const price = toCents(f.price.value);
    if (data.products.some(p => p.sku.toLowerCase() === sku.toLowerCase() && p.id !== id)) throw new Error('SKU already exists');
    const fields = { sku, name, category: cat, price, stock, lowStock };
    if (id) {
      data.products = data.products.map(p => (p.id === id ? { ...p, ...fields } : p));
      cart = cart.map(l => (l.id === id ? { ...l, sku, name, price, qty: Math.min(l.qty, stock) } : l)).filter(l => l.qty > 0);
    } else {
      data.products.push({ id: uid('p'), ...fields });
    }
    save(); f.reset(); f.elements.id.value = '';
    renderAll(); toast('Product saved');
  }

  // ---------------------------------------------------------------- staff ---
  function renderStaff() {
    const tb = $('#staff-rows');
    tb.replaceChildren(...data.staff.map(s => el('tr', {},
      el('td', { textContent: s.name + (s.id === (user && user.id) ? ' (you)' : '') }),
      el('td', { textContent: s.role }),
      el('td', {},
        el('button', { className: 'small', textContent: 'Edit', onclick: () => {
          const f = $('#staff-form');
          f.elements.id.value = s.id; f.elements.name.value = s.name; f.role.value = s.role; f.pin.value = '';
          f.pin.placeholder = 'New PIN (blank = keep)';
          f.elements.name.focus();
        } }), ' ',
        el('button', { className: 'small danger', textContent: 'Delete', onclick: guard(() => deleteStaff(s.id)) })))));
  }

  const managerCount = () => data.staff.filter(s => s.role === 'manager').length;

  async function saveStaff(e) {
    e.preventDefault();
    const f = e.target;
    const id = f.elements.id.value, name = f.elements.name.value.trim(), role = f.role.value, pin = f.pin.value.trim();
    if (!name) throw new Error('Name is required');
    if (data.staff.some(s => s.name.toLowerCase() === name.toLowerCase() && s.id !== id)) throw new Error('A staff member with that name exists');
    if ((!id || pin) && !validPin(pin)) throw new Error('PIN must be 4-8 digits');
    if (pin === '1234') throw new Error('Choose a PIN other than the default 1234');
    const existing = data.staff.find(s => s.id === id);
    if (existing && existing.role === 'manager' && role !== 'manager' && managerCount() === 1) throw new Error('At least one manager is required');
    const sid = id || uid('u');
    const patch = { name, role };
    if (pin) Object.assign(patch, { pinHash: await hashPin(pin, sid), defaultPin: false });
    if (existing) data.staff = data.staff.map(s => (s.id === id ? { ...s, ...patch } : s));
    else data.staff.push({ id: sid, ...patch });
    if (user && user.id === sid) { user = data.staff.find(s => s.id === sid); applyRole(); if (!isManager()) showView('register'); }
    save(); f.reset(); f.elements.id.value = ''; f.pin.placeholder = 'PIN (4-8 digits)';
    renderAll(); toast('Staff saved');
  }

  async function deleteStaff(id) {
    const s = data.staff.find(x => x.id === id);
    if (id === user.id) throw new Error("You can't delete yourself");
    if (s.role === 'manager' && managerCount() === 1) throw new Error('At least one manager is required');
    if (!(await confirmBox('Delete staff', `Remove ${s.name}?`))) return;
    data.staff = data.staff.filter(x => x.id !== id);
    save(); renderAll();
  }

  // ------------------------------------------------------------- settings ---
  function renderSettings() {
    const f = $('#settings-form'), s = data.settings;
    f.storeName.value = s.storeName; f.header.value = s.header; f.footer.value = s.footer;
    f.taxRate.value = (s.taxRateBp / 100).toFixed(2); f.cashierMaxDiscount.value = s.cashierMaxDiscount;
    $('#store-name').textContent = s.storeName;
    document.title = `${s.storeName} · POS`;
  }

  function saveSettings(e) {
    e.preventDefault();
    const f = e.target;
    const rate = Number(f.taxRate.value), maxD = Number(f.cashierMaxDiscount.value);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error('Tax rate must be 0-100');
    if (!Number.isInteger(maxD) || maxD < 0 || maxD > 100) throw new Error('Discount limit must be a whole number 0-100');
    data.settings = { storeName: f.storeName.value.trim() || 'My Store', header: f.header.value.trim(), footer: f.footer.value.trim(),
      taxRateBp: Math.round(rate * 100), cashierMaxDiscount: maxD };
    save(); renderAll(); toast('Settings saved');
  }

  async function restore(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let d;
    try { d = JSON.parse(await file.text()); } catch (_) { throw new Error('Not a valid backup file'); }
    if (!isValidData(d)) throw new Error('Not a valid backup file');
    if (!(await confirmBox('Restore backup', 'This replaces ALL current data on this terminal. Continue?'))) return;
    data = d; save(); resetSale(); lock(); toast('Backup restored. Please sign in.');
  }

  async function resetAll() {
    const r = await ask({ title: 'Reset all data', text: 'This permanently deletes all products, sales, shifts and staff. Type RESET to confirm.',
      ok: 'Reset', fields: [{ name: 'c', label: 'Confirmation' }] });
    if (!r || r.c !== 'RESET') return;
    data = defaults(); save(); resetSale(); lock(); toast('Data reset');
  }

  // --------------------------------------------------------------- wiring ---
  function renderAll() {
    renderSettings(); renderCategories(); renderGrid(); renderCart(); renderSales(); renderShift();
    if (isManager()) { renderReports(); renderProducts(); renderStaff(); }
  }

  function wire() {
    buildKeypad();
    for (const b of $$('nav button')) b.addEventListener('click', () => showView(b.dataset.view));
    $('#lock').addEventListener('click', lock);
    $('#goto-shift').addEventListener('click', () => showView('shift'));

    $('#search').addEventListener('input', renderGrid);
    $('#search').addEventListener('keydown', guard(e => {
      if (e.key !== 'Enter') return;
      const q = e.target.value.trim();
      if (!q) return;
      const p = data.products.find(x => x.sku.toLowerCase() === q.toLowerCase());
      const matches = data.products.filter(x => x.name.toLowerCase().includes(q.toLowerCase()) && (category === 'All' || x.category === category));
      const target = p || (matches.length === 1 ? matches[0] : null);
      if (!target) throw new Error(`No unique product for "${q}"`);
      e.target.value = '';
      addProduct(target);
    }));
    $('#order-discount').addEventListener('change', guard(async e => {
      try { await changeDiscount(Number(e.target.value), pct => { orderDiscountPct = pct; }, 'An order discount'); }
      finally { renderCart(); }
    }));
    $('#void-sale').addEventListener('click', guard(async () => {
      if (cart.length && (await confirmBox('Void sale', 'Remove all items from this sale?'))) resetSale();
    }));
    $('#hold').addEventListener('click', guard(holdSale));
    $('#recall').addEventListener('click', guard(recallSale));
    $('#pay').addEventListener('click', guard(openPayment));

    $('#add-cash').addEventListener('click', guard(() => addPayment('cash')));
    $('#add-card').addEventListener('click', guard(() => addPayment('card')));
    $('#pay-amount').addEventListener('keydown', guard(e => { if (e.key === 'Enter') { e.preventDefault(); addPayment('cash'); } }));
    $('#pay-cancel').addEventListener('click', () => $('#pay-dialog').close());
    $('#pay-complete').addEventListener('click', guard(completeSale));
    $('#close-receipt').addEventListener('click', () => { $('#receipt-dialog').close(); if ($('#view-register').classList.contains('active')) $('#search').focus(); });

    $('#sale-search').addEventListener('input', renderSales);
    $('#rep-from').addEventListener('change', renderReports);
    $('#rep-to').addEventListener('change', renderReports);
    $('#rep-today').addEventListener('click', () => setRange(1));
    $('#rep-7').addEventListener('click', () => setRange(7));
    $('#rep-30').addEventListener('click', () => setRange(30));
    $('#rep-csv').addEventListener('click', () => {
      const { from, to } = reportRange();
      const rows = data.sales.filter(s => (!from || s.date >= from) && (!to || s.date < to));
      download(`sales-${dayInput(new Date())}.csv`, P.salesCSV(rows), 'text/csv');
    });

    $('#product-filter').addEventListener('input', renderProducts);
    $('#low-only').addEventListener('change', renderProducts);
    $('#product-form').addEventListener('submit', guard(saveProduct));
    $('#product-form').addEventListener('reset', e => { e.target.elements.id.value = ''; });
    $('#staff-form').addEventListener('submit', guard(saveStaff));
    $('#staff-form').addEventListener('reset', e => { e.target.elements.id.value = ''; e.target.pin.placeholder = 'PIN (4-8 digits)'; });
    $('#settings-form').addEventListener('submit', guard(saveSettings));
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

    // Keep multiple tabs of the same terminal from overwriting each other silently.
    window.addEventListener('storage', e => {
      if (e.key !== KEY || !e.newValue) return;
      try { const d = JSON.parse(e.newValue); if (isValidData(d)) { data = d; if (user) { user = data.staff.find(s => s.id === user.id) || null; if (!user) lock(); else renderAll(); } } } catch (_) { /* ignore */ }
    });

    const tick = () => { $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
    tick(); setInterval(tick, 15000);
  }

  wire();
  save();
  lock();
})();
