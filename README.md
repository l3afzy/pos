# POS

A point-of-sale terminal for retail and quick-service stores that runs in the browser. There's no build step, no dependencies and no server.

## Run
Open `index.html` in a browser. On first run, sign in as **Manager** with PIN **1234**, pick your country, then set a new PIN under **Staff**.

## Country profiles
Choose a profile at first sign-in or under **Settings → Region & tax**. After picking one you can still change any field yourself.

| | Thailand | United States | Other / custom |
|---|---|---|---|
| Currency | THB (฿) | USD ($) | Any ISO code (EUR, JPY, …); currencies with 0 or 3 decimal places work too |
| Prices | Include 7% VAT | Sales tax added at checkout | Your choice |
| Language | Thai (Buddhist-era dates) | English | Your choice |
| Quick cash | ฿20 / 50 / 100 / 500 / 1000 | $5 / 10 / 20 / 50 / 100 | Your notes |
| Documents | Short-form tax invoice, full tax invoice, credit note | Receipt, refund receipt | Receipt, refund receipt |
| Payments | Cash, card, PromptPay QR | Cash, card | Cash, card |

The screen language can be switched between Thai and English on each terminal with the ไทย/EN button. Receipts always use the store's receipt language.

### Thailand
- **Short-form tax invoice (ใบกำกับภาษีอย่างย่อ):** prints the seller's tax ID, branch, POS registration number, running document number and "VAT included" statement, and shows VAT extracted from the price (price × 7/107).
- **Full tax invoice (ใบกำกับภาษีเต็มรูป):** issued from **Sales** with the buyer's name, address, tax ID and branch. It shows VAT on a separate line and refers to the short-form invoice it replaces.
- **Credit note (ใบลดหนี้):** issued for every refund, with the reason, the original document numbers, the original value, the correct value, the difference and the VAT.
- **PromptPay:** generates a Thai QR for the exact amount (EMVCo payload with CRC, checked against the `promptpay-qr` reference library). The cashier confirms the transfer in their banking app before accepting it.
- Tax IDs are checked with the 13-digit checksum. Products can be marked **VAT-exempt** (e.g. fresh produce).
- Document numbers (`S…`, `INV…`, `CN…`) run with no gaps and can't be edited. Each document keeps a copy of the seller details from when it was issued, so a reprint matches the original. Reprints are marked สำเนา / COPY.

> Registering the POS with the Revenue Department (for approval to issue short-form tax invoices) is still up to you. This software provides the document formats, but it has **not** been certified.

## Features
**Checkout**
- Product grid with category tabs, search, and barcode/SKU scanning (type or scan the SKU and press Enter)
- Change quantities in the cart, per-item % discounts, and a % discount on the whole order
- Split payments across cash, card and PromptPay, quick-cash buttons for your notes, and automatic change
- Hold a sale and recall it later (recalled items are re-priced from the current catalog)
- Printable 80mm receipts with your store header and footer, the cashier's name and the savings. Thai and other scripts line up correctly

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
- PromptPay payments must be checked by hand in the banking app. A static QR can't confirm by itself that the money arrived.
- Changing currency doesn't convert product prices. Sales keep their original currency, and reports only show the current one (the CSV has everything).

## Third-party code
`src/vendor/qrcode.js`: QR Code Generator by Kazuhiko Arase (MIT licence; the licence text is at the top of the file).

## Tests
```
npm test
```
