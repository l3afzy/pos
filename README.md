# POS

A point-of-sale terminal for retail and quick-service stores that runs in the browser. There's no build step, no dependencies and no server.

## Install

### Desktop app (recommended for a shop)
Download the installer from the repository's **Releases** page (newest version at the top). Every change is also built by GitHub Actions (**Actions → Test and build desktop app → Artifacts**, kept 30 days).

| System | File | How to install |
|---|---|---|
| Windows 10/11 | `POS-Terminal-<version>-win-x64.exe` | Run it and follow the setup wizard; it creates a desktop and Start-menu shortcut |
| macOS | `POS-Terminal-<version>-mac-<arch>.dmg` | Open it and drag POS Terminal to Applications |
| Linux | `POS-Terminal-<version>-linux-x86_64.AppImage` | Make it executable and run it |

First start: sign in as **Manager** with PIN **1234**, pick your country, then set a new PIN under **Staff**. Then open **Settings → Hardware** to set up the printers and cash drawer.

The desktop app adds, compared with the browser version:
- **Silent receipt printing:** receipts, void slips, credit notes, full tax invoices and Z reports print straight to the receipt printer with no dialog. A4 reports open the print dialog with the report printer already selected.
- **Cash drawer:** opens on cash sales, cash refunds and voids, pay-ins and pay-outs, opening a shift, and the shift-close count. **Open drawer (no sale)** needs a manager and is recorded in the journal. It sends the standard ESC/POS drawer command (`ESC p`) either
  - to a **network receipt printer** (IP address, port 9100), or
  - on Windows, to a **USB receipt printer shared in Windows** (share it under Printer properties → Sharing and enter the share name).

  With **None**, set the printer driver to open the drawer when it prints (most Epson/Xprinter drivers have this option).
- **Automatic backups:** after every day close, a full backup file is written to `Documents/POS Backups` (you can change the folder). Copy this folder somewhere safe regularly; tax records must be kept 5 years.
- **Kiosk mode** (full screen, no desktop) and **start with the computer**, per machine.
- **One copy per computer,** so two windows can never issue the same document number.
- Hardware settings belong to the computer (`pos-config.json` in the app data folder); store data stays in the app's own database.

#### Code signing
The installers are **not code-signed**. Windows SmartScreen shows "Windows protected your PC": click **More info → Run anyway**. On macOS, right-click the app and choose **Open** the first time. To remove these warnings, buy a code-signing certificate and add it to the build (see the electron-builder docs on code signing).

### Browser (quick try-out)
Open `index.html` in Chrome, Edge or Firefox. Everything works except silent printing, the cash drawer and automatic backup files.

### Build it yourself
```
npm install
npm start          # run the desktop app from source
npm run dist:win   # build the Windows installer (run this on Windows)
npm run dist:mac   # build the macOS .dmg (run this on a Mac)
npm run dist:linux # build the Linux AppImage
```

### Publishing a release
Set `version` in `package.json` (e.g. `4.2.0`), commit, then push a matching tag:
```
git tag v4.2.0
git push origin v4.2.0
```
GitHub Actions tests the code, builds the Windows, macOS and Linux installers and publishes them as a Release. A tag that doesn't match `package.json` is refused.

## Features
**Checkout**
- Product grid with category tabs, search, and barcode/SKU scanning (type or scan the SKU and press Enter)
- Change quantities in the cart, per-item % discounts, and a % discount on the whole order
- Split payments across cash, card and PromptPay, quick-cash buttons for your notes, and automatic change
- Hold a sale and recall it later (recalled items are re-priced from the current catalog)
- Printable 80mm receipts with your store header and footer, the cashier's name and the savings. Thai and other scripts line up correctly

**Staff and controls**
- Staff sign in with a PIN, with Manager and Cashier roles; the terminal locks after 5 wrong PINs and after 5 minutes idle
- A manager must approve voids, refunds, cash pay-outs, and discounts above the cashier limit
- Cashiers only see Register, Sales and Shift

**Cash management**
- Shifts with an opening float, cash pay-ins and pay-outs, and a blind cash count at close
- Mid-shift and shift-close reports showing expected vs. counted cash and whether the drawer is over or short
- Shift history
- Daily sales report (Z) per business day, with a running grand total

**Back office (managers)**
- Products: SKU, category, price, stock, low-stock alerts, and receiving new stock
- Reports: revenue, transaction count, average sale, tax, discounts, top products, totals by payment type and by cashier, and CSV export
- Settings: tax rate, receipt text, cashier discount limit, and backup/restore (JSON)
- Journal: a tamper-evident record of every document and cash event, which can be verified and exported

**Keyboard shortcuts:** F1 Register · F2 Sales · F3 Shift & day close · F4 Search · F12 Pay · Ctrl+L Lock

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

### Thailand: Revenue Department requirements
What the software does for each requirement:

| Requirement | Source | What the POS does |
|---|---|---|
| POS approval before issuing short-form tax invoices | Revenue Code s.86/6, DG Notice on VAT No. 46 (amended by No. 218), form ภ.พ.06 | Until a **POS registration number** is entered, receipts print as ใบเสร็จรับเงิน (not tax invoices) and a banner warns the manager. **Settings → Print ภ.พ.06 attachments** prints the machine specification sheet with a sample short-form invoice and a sample daily report. |
| Short-form invoice content | s.86/6 | "ใบกำกับภาษีอย่างย่อ / TAX INV (ABB)", seller name, tax ID, branch, POS number, running number, items, "ราคารวมภาษีมูลค่าเพิ่มแล้ว (VAT INCLUDED)", date. VAT-exempt items are shown separately. |
| Copy of every document (journal) | Notice No. 46 | An **electronic journal** records every sale, void, full invoice, credit note, reprint, daily report, cash event and settings change. Each entry is chained to the previous one with SHA-256, so any edit or deletion is detected and reported. |
| Daily sales summary per machine | Notice No. 46 | **Daily sales report (Z):** first and last document number, count, voided and replaced documents, value before VAT, VAT, exempt sales, credit notes, full invoices, payments, and a running grand total. A day with activity is closed automatically on the next day, or by a manager with **Close day**. No sales can be made on a closed day. |
| Sales tax report | s.87, Notice No. 89 | **Reports → Output tax report** (print or CSV): short-form invoices totalled per day as "S…-S…" with voided/replaced numbers listed, full tax invoices and credit notes on their own lines, plus a ภ.พ.30 summary. |
| Cancelling a short-form invoice | RD practice | **Void** needs a manager, a reason, and the current shift. The number stays used, the record is kept, and a void slip is printed. |
| Full tax invoice | s.86/4, DG Notice No. 199 | Buyer name and address, the buyer's tax ID and branch when VAT-registered, "สำนักงานใหญ่" or "สาขาที่ 00001", VAT shown separately. It carries **the same date** as the short-form invoice it replaces and states that it cancels it. It can't be issued for an earlier tax month. |
| Credit note | s.86/10 | Refers to the original document; shows the original value, the correct value, the difference, the VAT on the difference, and the reason. |
| Thai language and baht | s.86/4, s.86/6 | With a Thai VAT tax ID set, receipt language is forced to Thai and the currency must be THB. |
| Keep records 5 years | s.87/3 | Data is kept in IndexedDB, and the browser is asked for persistent storage. Managers are reminded to download a backup every 7 days. Reset always downloads a full backup first. A restore is refused if it would lose documents already issued, or if the backup was edited. |

Other safeguards:
- Document numbers (`S`, `INV`, `CN`, `RF`, `Z`) have no gaps and never repeat.
- Refused if the computer clock is set earlier than the last document.
- Only one browser tab per terminal, so two tabs can't hand out the same number.

**PromptPay:** a Thai QR code for the exact amount (EMVCo payload with CRC, checked against the `promptpay-qr` reference library). The cashier confirms the transfer in their banking app before accepting it.

> **Not certified.** The Revenue Department approves each machine at your local office (ภ.พ.06), and they have not reviewed this software. The requirements above were compiled from the Revenue Code and DG notices as summarised in public sources. The full text of the notices (rd.go.th) could not be fetched while building this, so ask your accountant or Revenue office to check a printed short-form invoice, a daily report and the sales tax report before you apply. You must draw the shop layout and connection diagrams for ภ.พ.06 yourself.

## Correctness
- All money is stored as whole cents and rounded half-up to the cent, so there are no floating-point errors.
- Stock can never go negative. A refund returns the items to stock and pays back the original payment types.
- The CSV export escapes values that a spreadsheet could run as formulas.

## Limitations
- Data is kept in this browser's IndexedDB on this one device. Download backups regularly and keep them for at least 5 years.
- PINs are hashed, but anyone with access to the device could still edit the stored data. The journal **detects** such edits but can't prevent them. Treat this as a single-terminal system, not a secure multi-store one.
- Card payments are recorded only. Nothing is connected to a card reader or payment processor.
- PromptPay payments must be checked by hand in the banking app. A static QR can't confirm by itself that the money arrived.
- Changing currency doesn't convert product prices. Sales keep their original currency, and reports only show the current one (the CSV has everything).

## Third-party code
`electron/` contains the desktop app: `main.js` (window, printing, drawer, backups), `preload.js` (the small API the page can call; the page has no Node access) and `hardware.js`.

`src/storage.js` handles persistence (IndexedDB, with localStorage as a fallback).

`src/vendor/qrcode.js`: QR Code Generator by Kazuhiko Arase (MIT licence; the licence text is at the top of the file).

## Tests
```
npm test
```
Unit tests cover money, tax, payments, shifts, the journal, daily and monthly tax reports, PromptPay payloads, and the desktop hardware helpers (drawer command, config validation, backup files).
