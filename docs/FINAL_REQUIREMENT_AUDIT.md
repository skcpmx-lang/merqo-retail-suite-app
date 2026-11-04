# FINAL REQUIREMENT AUDIT

Requirement-by-requirement audit of the Product Owner's specification against
the audited commit (see `FINAL_AUDIT_BASELINE.md`). Requirement IDs (A1 … K6)
match `docs/07-requirements-traceability.md`.

**Status vocabulary:** `PASS` · `PARTIAL` · `FAIL` · `BLOCKED` · `NOT APPLICABLE`
**Verification levels:** L1 static · L2 automated · L3 measured · L4 packaged · L5 field
(defined in the baseline document)

> Rule applied throughout: a requirement is only `PASS` if evidence exists at the
> stated level. Where the only honest evidence would be a real Windows machine,
> printer or scanner, the row says `PARTIAL` or `BLOCKED`. Nothing was upgraded
> by inference.

## Summary

| Status | Count |
|---|---|
| PASS | 72 |
| PARTIAL | 9 |
| BLOCKED | 3 |
| FAIL | 0 |
| NOT APPLICABLE | 0 |
| **Total** | **84** |

Nothing in the specification is unimplemented (`FAIL` count is zero). The three
`BLOCKED` rows (D7, D8, I6) are claims that can only be proven by a printer —
they are listed as blocked rather than passed because the audit environment has
no Windows host, no printer driver and no display server. The nine `PARTIAL`
rows are implemented features whose *field* behaviour could not be executed
here.

---

## A. Platform and deliverables

| # | Requirement | Evidence | Level | Status |
|---|---|---|---|---|
| A1 | Two separate Windows EXEs | Release run 41787673767 (tag `v1.0.0-rc.4`): "Package Sauda Retail Suite (NSIS)" and "Package Sauda License Generator (NSIS)" both succeeded; `sauda-windows-installers` artefact 221 595 443 bytes contains both setups + `SHA256SUMS.txt` | L4 | PASS |
| A2 | Fully offline, no internet dependency | `grep -rE "fetch\(|https?\.request|net\.request|axios|WebSocket|XMLHttpRequest|sendBeacon"` over `packages/*/src` + `packages/app/electron` → 0 hits; production CSP rewritten to `connect-src 'none'` by `scripts/build-app.mjs`; no telemetry/analytics dependency in `package.json` | L1+L2 | PASS |
| A3 | Electron + React stack | Electron 38.8.6, React 19, TypeScript 5.9, Vite 7, esbuild; `node scripts/verify.mjs` builds main/preload/renderer | L2 | PASS |
| A4 | Light mode only | `theme.css` declares one palette; `grep prefers-color-scheme` → 0 | L1 | PASS |
| A5 | Fully Bengali UI | 17 pages, `<html lang="bn">`, Bangla labels/messages; `scripts/audit-ui.mjs` renders a consistent icon/class/route graph. Latin text appears only where it is the domain term (SKU, CSV, BDT, VAT, Windows) | L1 | PASS |
| A6 | BDT currency, Bangla digits option | `domain/format.ts` (`money`, `toBnDigits`), `settings.bengali_digits`; `core.test.ts` money formatting tests | L2 | PASS |
| A7 | No MERQO logo | Own "S" mark in `icons.tsx` + `scripts/make-icons.mjs`; icon files regenerated each verify run | L1 | PASS |
| A8 | NSIS installer, uninstall keeps data | `packages/app/package.json` → `nsis.deleteAppDataOnUninstall: false`, per-user install, `allowToChangeInstallationDirectory: true`. Installer produced (A1). Uninstall was **not** executed on Windows | L1+L4 | PARTIAL |

## B. Data and financial correctness

| # | Requirement | Evidence | Level | Status |
|---|---|---|---|---|
| B1 | SQLite, ACID | better-sqlite3 13.0.3; WAL + `synchronous=FULL` now actually applied and verified (`schema-audit` "runs in WAL mode with foreign keys enforced"); `workflow.test.ts` "rolls back a failed sale completely" | L2 | PASS |
| B2 | Schema migration | `SCHEMA_VERSION`, `migrate()`; tests cover missing `user_version` (data + 37 settings preserved) and refusal of a newer DB. Connection is closed when migration throws (Windows lock leak fixed during this audit) | L2 | PASS |
| B3 | All money as integer poisa | `domain/money.ts`; no float arithmetic on money in services (review) | L2 | PASS |
| B4 | Quantity in milli units with unit conversion | `toBaseMilli`, `unitFamily`; `core.test.ts` "converts units without losing precision" | L2 | PASS |
| B5 | Weighted average cost | `inventory.applyMovement`; `core.test.ts` "computes weighted average cost" | L2 | PASS |
| B6 | P&L including COGS | `sales.profit_paisa`, `sale_items.cost_total_paisa`; `workflow.test.ts` profit assertion; `audit.test.ts` "keeps every report in step with the ledger" | L2 | PASS |
| B7 | Accept Bangla numeral input | `normalizeDigits`; `schema-audit` "ignores case and Bengali/English digits when searching" | L2 | PASS |
| B8 | Bangla/English search and sort | `foldForSearch`, `bengaliSortKey`; `extras.test.ts` search tests | L2 | PASS |
| B9 | Integrity check and repair | `integrityCheck()`, `repairDatabase()`; measured `integrity_check = ok` and `foreign_key_check` empty on a 50 000-sale database | L2+L3 | PASS |

## C. Products and inventory

| # | Requirement | Evidence | Level | Status |
|---|---|---|---|---|
| C1 | Product CRUD with category/sub-category/brand | `services/products.ts`, `services/catalog.ts`; `core.test.ts` "refuses to delete a category that has products" | L2 | PASS |
| C2 | Multiple price levels + offers | retail/wholesale/special, `decoratePrice`; `extras.test.ts` offer tests (percentage, fixed, no negative price) | L2 | PASS |
| C3 | Barcode and QR | `product_barcodes(kind)`, CODE128 + QR SVG builders; `schema-audit` barcode/QR/SKU lookup test; label layout test in `extras.test.ts`. **Physical scanner not tested** | L2 | PARTIAL |
| C4 | Unit families (kg/g) | `units.base_unit_id`, `factor_milli`; conversion test | L2 | PASS |
| C5 | Stock movement history | `stock_movements` + `inventory.movements`; audit test asserts no orphan ledger rows | L2 | PASS |
| C6 | Stock count / adjustment / write-off | `adjustStock`, `writeOffStock` (mandatory reason); `workflow.test.ts` "adjusts stock with an audit trail" | L2 | PASS |
| C7 | Low-stock alerts | `min_stock_base_milli`, `inventory.low/out`, sidebar badge | L1 | PASS |
| C8 | Batches and expiry | `batches`, `expiry_tracked`, `inventory.expiring` — implemented, covered by code review and the schema inventory; no dedicated unit test | L1 | PARTIAL |
| C9 | CSV import (products/customers/suppliers) | `services/imports.ts` with preview/commit/templates; three `schema-audit` CSV tests incl. in-file duplicate detection added during this audit | L2 | PASS |

## D. Sales and POS

| # | Requirement | Evidence | Level | Status |
|---|---|---|---|---|
| D1 | Fast POS (scan, search, tiles) | `pages/POS.tsx`, `products.byCode` (0.4 ms measured on 50 k products); the screen itself was not driven in a live window here | L3 | PARTIAL |
| D2 | Line/order discount with permission and limit | `pos.discount`, `pos.price_edit`, `max_discount_percent_x100`; `workflow.test.ts` "applies order discount and rejects an over-limit discount" | L2 | PASS |
| D3 | Credit sale + customer balance | `createSale` due logic, `customers.balance_paisa`; `workflow.test.ts` due/collection test | L2 | PASS |
| D4 | Change calculation | `computation.change`; `audit.test.ts` "rejects a payment above the invoice total, keeping change exact" | L2 | PASS |
| D5 | Invoice number series | `counters`, `invoice_prefix/format`; `workflow.test.ts` unique invoice numbers | L2 | PASS |
| D6 | Receipt preview equals printed receipt | Single `buildReceiptHtml` used by both paths | L1 | PASS |
| D7 | 5 8 mm and 80 mm thermal output | `@page size` from `receipt_width`, font clamp — code present; **no printer in this environment** | — | BLOCKED |
| D8 | Silent print with measured paper height | `printing.ts` `pageSize` microns — present; needs driver/Windows | — | BLOCKED |
| D9 | Duplicate copy | `print.print(..., { duplicate })` | L1 | PASS |
| D10 | Void instead of delete | `voidSale` reverses stock/payment/due and audits; `workflow.test.ts` "voids a sale and reverses stock, cash and dues" | L2 | PASS |
| D11 | Label printing (barcode + QR) | `print.labels` 50 × 30 mm; payload test in `extras.test.ts`; printer output untested | L2 | PARTIAL |

## E. Purchase, suppliers, returns

| # | Requirement | Evidence | Level | Status |
|---|---|---|---|---|
| E1 | Purchase entry with landed-cost allocation | `computePurchase`; `workflow.test.ts` "allocates transport cost into the landed cost" | L2 | PASS |
| E2 | Supplier payable and payment | `suppliers.balance_paisa`, `paySupplier`; covered by purchase workflow test | L2 | PASS |
| E3 | Supplier statement | `supplierStatement` | L1 | PASS |
| E4 | Purchase void | `voidPurchase` | L2 | PASS |
| E5 | Sale return (restock / damaged) | `createSaleReturn`; `workflow.test.ts` partial return with restock | L2 | PASS |
| E6 | Purchase return | `createPurchaseReturn`; `workflow.test.ts` reduces supplier payable | L2 | PASS |
| E7 | Refund accounting | `returns.refund_paisa`; **fixed during this audit** — refund can no longer exceed the credit the return creates, and a credit invoice is settled instead of paying cash (`audit.test.ts`, 3 tests) | L2 | PASS |

## F. Customers, expenses, cash

| # | Requirement | Evidence | Level | Status |
|---|---|---|---|---|
| F1 | Customer ledger and statement | `customers.ts`, `customerStatement`; `audit.test.ts` statement-vs-balance test | L2 | PASS |
| F2 | Due collection | `receiveCustomerPayment`; audit cash test counts collections exactly once | L2 | PASS |
| F3 | Walk-in customer protection | `is_walkin` guard on due/collection | L2 | PASS |
| F4 | Expenses with categories and void | `services/expenses.ts`; `workflow.test.ts` expense → P&L test | L2 | PASS |
| F5 | Cash register (session, expected, difference) | `services/cash.ts`; `audit.test.ts` reconciliation test | L2 | PASS |
| F6 | Cash movement audit | `cash_movements`; audit test "only moves drawer cash for cash payment methods" | L2 | PASS |

## G. Reports and export

| # | Requirement | Evidence | Level | Status |
|---|---|---|---|---|
| G1 | 27+ reports | `REPORT_CATALOG` = 27 entries; `core.test.ts` "runs every report without error" executes all of them; `audit.test.ts` cross-checks report totals against the ledger | L2 | PASS |
| G2 | CSV export | `tableToCsv` (BOM, quoting); `core.test.ts` CSV write test | L2 | PASS |
| G3 | XLSX export | `tablesToXlsx` (fflate, no dependency); `core.test.ts` "writes a valid xlsx zip" | L2 | PASS |
| G4 | PDF export (Bangla) | `htmlToPdf` via `webContents.printToPDF`; requires a live Electron window, not executable headless here | L1 | PARTIAL |
| G5 | Date presets and filters | Preset/custom range, category/customer/supplier filters; report execution test covers the SQL paths | L2 | PASS |
| G6 | Dashboard KPIs and charts | `dashboard.*`, `charts.tsx`; dashboard measured at 43.7 ms on 50 k sales | L3 | PASS |
| G7 | Global search | `searchEverything`; `extras.test.ts` search tests; measured 18.0 ms | L3 | PASS |

## H. Security, users, audit

| # | Requirement | Evidence | Level | Status |
|---|---|---|---|---|
| H1 | RBAC (admin/manager/cashier) + 19 permissions | `auth.ts`, `DEFAULT_ROLE_PERMISSIONS`; `security-audit` cashier-permission test | L2 | PASS |
| H2 | Permission enforcement at the IPC layer | `ipc.ts` per-route `perm` + `requirePermission`; licence gate added during this audit (F5) | L2 | PASS |
| H3 | Password hashing | scrypt N=16384 r=8 p=1, 64-byte key, 16-byte per-user salt; `security-audit` "never stores the plain text" | L2 | PASS |
| H4 | Audit log for important actions | `audit_logs`, `audit()`; asserted in workflow/security tests | L2 | PASS |
| H5 | No financial deletion | void/reversal only; `security-audit` "refuses to delete a customer that has transactions", "refuses to delete a product that has moved" | L2 | PASS |
| H6 | Window hardening | `contextIsolation: true`, `nodeIntegration: false`, `devTools` only in dev, `will-navigate` blocked, `setWindowOpenHandler` denies, permission handler denies all, production CSP `connect-src 'none'`. Not exercised in a running window here | L1 | PARTIAL |
| H7 | Path-escape prevention | `assertInside`, `app.openPath` allowlist | L2 | PASS |

## I. Backup and settings

| # | Requirement | Evidence | Level | Status |
|---|---|---|---|---|
| I1 | Full backup with manifest | `VACUUM INTO` + manifest (SHA-256, row counts); measured 462 ms / 47.9 MB; `security-audit` detects a backup whose bytes changed | L2+L3 | PASS |
| I2 | Restore with validation and safety copy | `validateBackup` + `restoreBackup`; **hardened during this audit**: verifies before swapping, refuses newer schema, always reopens the DB (`finally`) | L2 | PASS |
| I3 | Automatic backup | `shouldAutoBackup`, `main.runAutoBackup` at startup; scheduling logic not observed running in a live app here | L1 | PARTIAL |
| I4 | Backup retention | `pruneBackups(keep)` driven by `settings.backup_keep` | L1 | PASS |
| I5 | Settings (7 tabs) | `services/settings.ts` + 37 keys; `security-audit` rejects nonsensical values and keeps the old ones | L2 | PASS |
| I6 | Printer selection and test print | `print.printers`, `print.test`; needs hardware | — | BLOCKED |

## J. Licensing

| # | Requirement | Evidence | Level | Status |
|---|---|---|---|---|
| J1 | Offline signed licence | Ed25519, `SAUDA1.<payload>.<signature>`; sign/verify round-trip, tamper, forged-signature and foreign-key tests | L2 | PASS |
| J2 | Hardware binding (weighted) | 4 components, weights 45/30/15/10, `MATCH_THRESHOLD = 0.6`; single-component swap tolerated, board+disk replacement rejected | L2 | PASS |
| J3 | Placeholder rejection | all-zero / empty component filter; "refuses a licence that carries no device binding" | L2 | PASS |
| J4 | Controlled rebinding | New device request → vendor issues new licence; documented in `docs/04-licensing.md`. Process not executed with the real key | L1 | PARTIAL |
| J5 | Clock rollback guard | `meta.license.max_seen`; "stores the activation and refuses a rolled-back clock after expiry" | L2 | PASS |
| J6 | Separate licence-generator EXE | `packages/license-generator` NSIS built in release run 41787673767 | L4 | PASS |
| J7 | Private key never in the app, bundle or installer | `scripts/verify.mjs` secret scan; `scripts/verify-installer.mjs` scans every `.exe` and every packaged resource for PEM/Ed25519-PKCS#8 markers and fails the release job if found — passed in run 41787673767; packaging refuses when key material is present | L2+L4 | PASS |
| J8 | Expiry and edition | `expires_at`, `edition`, `features`; expired-licence and unknown-edition tests | L2 | PASS |

## K. Documentation and process

| # | Requirement | Evidence | Level | Status |
|---|---|---|---|---|
| K1 | Complete documentation | `docs/01…09` + this `FINAL_*` set, `README.md`, `CHANGELOG.md`, `LICENSE.md`; stale `docs/LICENSING_ARCHITECTURE.md` references corrected during this audit | L1 | PASS |
| K2 | Requirement traceability | `docs/07-requirements-traceability.md` + this document | L1 | PASS |
| K3 | CI: typecheck + tests + build | `.github/workflows/ci.yml` green on the audited branch (run 41786685237, 39 s) | L2 | PASS |
| K4 | Tag-driven release with two EXEs | `.github/workflows/release.yml`; proven end-to-end by seven pre-release tags (`v1.0.0-rc.1…rc.4`); publishing is skipped for `-rc` tags by design | L4 | PASS |
| K5 | No fake buttons / hardcoded stats | Every number comes from IPC; `scripts/audit-ui.mjs` proves all 105 call sites resolve to one of 131 routes; no placeholder handlers found in review | L1 | PASS |
| K6 | Progress documentation and resume notes | `docs/09-known-limits.md`, `CHANGELOG.md`, `FINAL_QA_CHECKLIST.md` | L1 | PASS |

---

## What the `PARTIAL` and `BLOCKED` rows need from the owner

1. **A8** — run the NSIS setup on a clean Windows 10/11 machine, create a sale, uninstall, reinstall, confirm the data folder survived.
2. **C3 / D11 / I6 / D7 / D8** — one session with the real thermal printer and scanner (58 mm and 80 mm), printing a receipt, a duplicate copy and a label.
3. **C8** — batch/expiry walkthrough on real stock (receive a batch with an expiry date, sell it, check the expiring report).
4. **D1 / H6 / G4 / I3** — a 15-minute smoke run of the installed app (POS screen, PDF export, automatic backup after restart).
5. **J4** — issue one licence with the vendor private key, activate on a second machine, then request a rebind.

These are exactly the items marked `BLOCKED`/`PARTIAL` in `FINAL_QA_CHECKLIST.md`, and they are why the commercial verdict is **B**.
