# FINAL Feature Matrix — v1.1.0

Status vocabulary (fixed for this project):

- **PASS** — exercised by an automated test or a verified run in this session.
- **PARTIAL** — implemented and wired, but a part of the claim cannot be proven here.
- **BLOCKED** — requires hardware/OS/network this environment does not have.
- **N/A** — out of scope for v1.1.0.

Every "PASS" below has an evidence line. Nothing is marked PASS because the code
"looks right".

## A. Core retail

| Feature | Working | DB | UI | Perm | Tested | Report | Print |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Product create/edit/variants/barcodes | ✅ | ✅ | ✅ | product.manage | PASS (`products-advanced`, `core`) | ✅ | label sheet |
| Categories/brands/units | ✅ | ✅ | ✅ | product.manage | PASS (`core`) | ✅ | — |
| Stock in/out/adjust/transfer/count/write-off | ✅ | ✅ | ✅ | stock.adjust | PASS (`stock-ops`, `workflows-v101`) | ✅ | ✅ |
| Weighted-average costing | ✅ | ✅ | — | — | PASS (`accounting`) | ✅ | ✅ |
| Low/out-of-stock alerts | ✅ | ✅ | ✅ | product.view | PASS (`v110-core`) | ✅ | — |
| POS sale, multi-payment, hold/resume | ✅ | ✅ | ✅ | pos.sell | PASS (`pos`, `workflows-v101`) | ✅ | receipt |
| Discounts, price floor, negative-stock override | ✅ | ✅ | ✅ | pos.discount / pos.price_edit | PASS (`pos`) | ✅ | ✅ |
| Returns, partial returns, refunds | ✅ | ✅ | ✅ | return.manage | PASS (`workflows-v101`) | ✅ | ✅ |
| Exchange of a sold item | ✅ | ✅ | ✅ | return.manage | PASS (`workflows-v101`) | ✅ | ✅ |

## B. Purchasing (v1.1)

| Feature | Status | Evidence |
| --- | --- | --- |
| Purchase order create (multi-line, costs, expected date) | PASS | `v110-core.test.ts` |
| Partial receiving against an order | PASS | `v110-core.test.ts` (order → receive part → remaining → receive rest → `received`) |
| Over-receipt refused | PASS | `v110-core.test.ts` |
| Cancel order with reason + audit | PASS | `v110-core.test.ts` |
| PO document / receipt document | PASS (HTML) / **BLOCKED** (printer) | `print.test.ts`, docs/16 |
| AP posting on receipt | PASS | `v110-core.test.ts` (supplier payable increases by the received value) |

## C. Promotions (v1.1)

| Feature | Status | Evidence |
| --- | --- | --- |
| Percentage coupon (basis points) + fixed coupon | PASS | `v110-core.test.ts` |
| Min purchase, max discount, expiry, usage limit, per-customer limit | PASS | `v110-core.test.ts` |
| Coupon applied inside a sale + redemption recorded | PASS | `v110-core.test.ts` |
| Gift card issue for cash (liability 2150) | PASS | `v110-core.test.ts` |
| Gift card as tender, partial balance kept | PASS | `v110-core.test.ts` |
| Voucher issued with no payment (promotional) | PASS | `v110-core.test.ts` |
| Void / adjust with audit trail | PASS | `v110-core.test.ts` |
| Expiry run | PASS | `v110-core.test.ts` |
| Outstanding balance ties to account 2150 | PASS | `v110-core.test.ts` |

## D. Accounting

| Feature | Status | Evidence |
| --- | --- | --- |
| Every entry balances (debit = credit) | PASS | `accounting.test.ts` — `postEntry` rejects unbalanced input; all flows asserted |
| Reversal instead of edit | PASS | `accounting.test.ts` |
| Trial balance ties to GL | PASS | `accounting.test.ts`, `reports-v101.test.ts` |
| Balance sheet balances | PASS | `reports-v101.test.ts` |
| P&L from real entries | PASS | `reports-v101.test.ts` |
| AR/AP from customer/supplier ledgers | PASS | `crm.test.ts`, `v110-core.test.ts` |
| COGS on sale, restock on return | PASS | `accounting.test.ts` |
| Cash register open/close/denominations | PASS | `workflows-v101.test.ts` |
| Expense → cash → journal | PASS | `workflows-v101.test.ts` |

## E. Reports

54 report ids implemented; each is asserted to return rows/columns on a live test
database (`reports-v101.test.ts`, `v110-core.test.ts`). Printing a report uses
`buildReportHtml` (PASS, unit-tested); physical output **BLOCKED**.

## F. v1.1 platform features

| Feature | Status | Evidence / limit |
| --- | --- | --- |
| Bangla ⇄ English toggle | PASS (shell + v1.1 screens + documents) / PARTIAL overall (older screens Bengali-only, documented) | `i18n.tsx`, docs/18 |
| Light / dark / system theme with persistence | PASS (wired, setting persisted) / PARTIAL (no screenshot diffing in sandbox) | `theme.ts`, Settings → Appearance |
| Customer display (second window) | PASS at code/IPC level / **BLOCKED** (second monitor) | `display.*`, `#display` window |
| LAN host + terminal | PASS at transport level (11 tests) / **BLOCKED** (two physical PCs) | `lan.test.ts`, docs/17 |
| Purchase orders + partial receiving | PASS | above |
| Coupons/vouchers/gift cards | PASS | above |
| Optional software lock chosen at setup | PASS | `auth-lock.test.ts`, Setup step 2 |
| Login attempt protection | PASS | `auth-lock.test.ts` (5 failures → 5-minute cool-down, persisted, no plain text) |
| A4/A5/58/80 print layer | PASS (HTML) / **BLOCKED** (printer, PDF pixel check) | `print.test.ts`, docs/16 |

## G. Honest gaps carried into v1.1.0

1. English translation of the pre-v1.1 screens.
2. Licence **revocation** requires the generator to sign a new licence; there is
   no online check (offline product by design) — documented as PARTIAL.
3. Signed Windows installers (code signing certificate not available).
4. Every hardware claim: thermal/label printers, cash drawer, barcode scanner,
   customer display, second PC.
5. Real-shop pilot with live data.
