<!-- impeccable:product-schema 1 -->
# POS Terminal

## Platform
web (installed as an Electron desktop app, also runs in a browser)

## Users and situation
Cashiers, servers and owners at small Thai cafés, restaurants and shops. They work standing at a counter touch screen or a cheap laptop, often under bright shop lighting, mid-rush, with a queue waiting. Owners come back after closing to run reports, day closes and tax exports.

## Purpose
Ring up a sale in seconds, run table service from a floor plan, and keep the books legal: Thai Revenue Department short-form tax invoices, a hash-chained journal, daily Z reports, and output tax reports. It also works in US and generic modes.

## What matters most
1. Speed at the counter: big targets, the total always visible, and Pay always one tap away.
2. Trust: numbers are exact and tabular, and every status (open table, day closed, offline) is obvious.
3. Calm: it gets used for eight hours a day, so no decoration competes with the order.

## Durable constraints
- Thai and English UI; Thai text must render well (Sarabun / Leelawadee UI / Noto Sans Thai).
- Touch-first, with targets ≥44px. It must also work with a mouse and keyboard.
- 80mm thermal receipts and A4 tax reports print from the same app.
- Works offline, with no external fonts or CDNs (strict CSP).
- Light and dark mode follow the OS.
