# 16 — Printing (A4 / A5 / 58 mm / 80 mm)

Sauda Retail Suite prints every document from a single, shared HTML layer that
lives in `packages/core/src/print/`. The renderer never builds markup; the main
process asks core for a document string and hands it to Electron, which either
opens the system print dialog, prints silently to a named printer, writes a PDF,
or shows a preview window.

## 1. Where the code lives

| File | Responsibility |
| --- | --- |
| `packages/core/src/print/base.ts` | `DocFormat`, `BrandInfo`, page CSS, escaping, money/qty helpers, `buildReportHtml` |
| `packages/core/src/print/receipt.ts` | 58/80 mm thermal receipt (`buildReceiptDocument`) |
| `packages/core/src/print/documents.ts` | invoice, purchase, purchase order, statement, stock document, licence, label sheet |
| `packages/app/electron/ipc.ts` | `print.document` (picks the builder), `print.render`, `print.print`, `print.pdf`, `print.printers` |
| `packages/app/electron/printing.ts` | Electron plumbing: hidden window, `webContents.print`, `printToPDF` |

Because the builders are pure functions over plain data they are unit tested in
`packages/core/test/print.test.ts` (10 tests) — no Electron, no printer, no OS
dependency.

## 2. Formats

| Format | CSS | Used by |
| --- | --- | --- |
| A4 portrait | `@page { size: A4; margin: 12mm }` | invoices, statements, ledgers, financial statements, PO |
| A4 landscape | `@page { size: A4 landscape }` | wide reports (stock valuation, sales register) |
| A5 | `@page { size: A5 }` | small invoices, delivery notes |
| 58 mm | `@page { size: 58mm auto }` | handheld/thermal receipt printers |
| 80 mm | `@page { size: 80mm auto }` | counter thermal printers |

`DocFormat` carries the currency symbol and the Bengali-digit preference, so the
same builder produces `1,234.50` or `১,২৩৪.৫০` without branching at call sites.

## 3. The 20 print rules

1. Every document has a title, the business identity block and a timestamp.
2. The logo is optional, printed at its native aspect ratio, never stretched.
3. Page documents use real page margins; roll documents use a measured width.
4. Money is right aligned and never wrapped.
5. Quantities print in the unit actually sold, with the base conversion hidden.
6. Totals are repeated once, in a single summary block.
7. Discounts always print the coupon code next to the amount.
8. Tax prints only when non-zero.
9. Gift-card tender prints separately from cash/card tender.
10. Change due prints in a box, never inline with the total.
11. Duplicate copies are marked — the original is never reprinted as an original.
12. Voided documents print a diagonal VOID band and keep their number.
13. Statements print opening balance, movements and closing balance.
14. Financial statements print debit/credit columns that visibly balance.
15. PO/receipt documents print ordered vs received quantities.
16. Label sheets print a barcode/QR only when a real value exists.
17. Bengali text uses a font stack that ships with Windows (Nirmala UI, Noto Sans Bengali, Vrinda).
18. Nothing relies on colour alone; state is also written in words.
19. Printing never mutates data — builders are read-only.
20. A PDF copy of any document can be produced without a printer installed.

## 4. Printing from the UI

```ts
const html = await call<string>('print.document', 'invoice', { saleId });
await call('print.render', html, {});        // preview window
await call('print.pdf', html, 'C:\\out.pdf'); // silent PDF
await call('print.print', saleId);            // configured thermal printer
```

`print.document` kinds: `invoice`, `purchase`, `po`, `statement`, `report`,
`transfer`, `count`, `valuation`, `labels`, `license`.

## 5. Terminal behaviour

In LAN terminal mode the print routes stay **local** (`print.` is in
`LOCAL_PREFIXES`). A terminal prints on the printer physically attached to it,
while the document data still comes from the host — this is the only correct
behaviour for a shop with two counters.

## 6. Verification status

| Check | Status |
| --- | --- |
| Builders produce well-formed HTML with escaped hostile input | PASS (unit tests) |
| A4/landscape/58/80 page CSS present | PASS (unit tests) |
| Real printer output on Windows | **BLOCKED** — no printer or Windows in the build environment |
| Cash drawer kick via printer | **BLOCKED** — hardware dependent |
| PDF visual check (rendered pages) | **BLOCKED** — no Chromium print pipeline in CI; requires manual run on Windows |

Blocked items are re-tested on a real installation before a shop goes live; they
are never reported as PASS from a sandbox.
