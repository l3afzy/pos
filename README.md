# POS

A self-contained, browser-based point-of-sale system. No build step and no dependencies.

## Run
Open `index.html` in a browser. Data is saved in the browser's `localStorage`.

## Features
- **Register:** tap product tiles or type/scan a SKU and press Enter. Edit quantities, apply a % discount, and take cash (with change) or card payments.
- **Receipts:** a printable receipt for every sale.
- **Products:** add, edit and delete products (SKU, name, price, stock). Stock goes down on each sale and can't go below zero.
- **Sales:** history, revenue and tax totals, and refunds (a refund puts the stock back).
- **Settings:** store name and tax rate.

All money is stored as integer cents, so there are no floating-point rounding errors. Discount and tax are rounded half-up to the cent.

## Tests
```
npm test
```
The core logic in `src/core.js` is covered by `test/core.test.js`.
