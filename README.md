# POS

A point-of-sale terminal for retail and quick-service stores that runs in the browser. There's no build step, no dependencies and no server.

## Run
Open `index.html` in a browser. On first run, sign in as **Manager** with PIN **1234**, then set a new PIN under **Staff**.

## Features
**Checkout**
- Product grid with category tabs, search, and barcode/SKU scanning (type or scan the SKU and press Enter)
- Change quantities in the cart, per-item % discounts, and a % discount on the whole order
- Split payments across cash and card, quick-cash buttons ($5/$10/$20/$50/$100), and automatic change
- Hold a sale and recall it later (recalled items are re-priced from the current catalog)
- Printable receipts with your store header and footer, the cashier's name and the savings

**Staff and controls**
- Staff sign in with a PIN, with Manager and Cashier roles; the terminal locks after 5 wrong PINs and after 5 minutes idle
- A manager must approve refunds, cash pay-outs, and discounts above the cashier limit
- Cashiers only see Register, Sales and Shift

**Cash management**
- Shifts with an opening float, cash pay-ins and pay-outs, and a blind cash count at close
- X report (mid-shift) and Z report (at close) showing expected vs. counted cash and whether the drawer is over or short
- Shift history

**Back office (managers)**
- Products: SKU, category, price, stock, low-stock alerts, and receiving new stock
- Reports: revenue, transaction count, average sale, tax, discounts, top products, totals by payment type and by cashier, and CSV export
- Settings: tax rate, receipt text, cashier discount limit, and backup/restore (JSON)

**Keyboard shortcuts:** F1 Register · F2 Sales · F3 Shift · F4 Search · F12 Pay · Ctrl+L Lock

## Correctness
- All money is stored as whole cents and rounded half-up to the cent, so there are no floating-point errors.
- Stock can never go negative. A refund returns the items to stock and pays back the original payment types.
- The CSV export escapes values that a spreadsheet could run as formulas.

## Limitations
- Data is kept in this browser's `localStorage` on this one device. Download backups regularly.
- PINs are hashed, but anyone with access to the device could still edit the stored data. Treat this as a single-terminal system, not a secure multi-store one.
- Card payments are recorded only. Nothing is connected to a card reader or payment processor.

## Tests
```
npm test
```
