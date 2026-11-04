# SAUDA v1.0.1 — PHASE 1: EXISTING PRODUCT AUDIT

Audited commit: `cb0dfa4` (merge of v1.0.0). Environment: Linux container, Node 22.22.3,
better-sqlite3 13.0.3 / SQLite 3.53.4. Tests at audit time: **99 / 99 pass**.

Status vocabulary: `COMPLETE` · `PARTIAL` · `MISSING` · `BROKEN` · `NEEDS IMPROVEMENT` · `NOT APPLICABLE`

> The previous audit documents were re-checked, not trusted. Every `COMPLETE` below
> was re-verified by reading the code and, where possible, executing it. Where the
> v1.0.0 report said "PASS" but the feature is only representative (e.g. "shipment
> of stock between shops"), it is downgraded here.

## 1. Verified inventory of what exists

| Layer | Reality |
|---|---|
| Tables | 31 (`meta, settings, users, sessions_log, audit_logs, payment_methods, units, categories, brands, products, product_barcodes, batches, stock_movements, customers, suppliers, counters, cash_sessions, sales, sale_items, purchases, purchase_items, payments, returns, return_items, expense_categories, expenses, cash_movements, price_history, backups, activations, restore_log`) |
| Services | 23 (`sales, purchases, returns, payments, customers, suppliers, inventory, products, catalog, cash, expenses, reports, search, settings, auth, audit, backup, imports, dashboard, invoice, appInfo, setup, licensing`) |
| IPC routes | 131 |
| Pages | 17 (`Dashboard, POS, Products, Inventory, Purchases, Sales, Returns, Parties, Expenses, Cash, Reports, Backup, Settings, About, Activation, Login, Setup`) |
| Reports | 27 in `REPORT_CATALOG` |
| Permissions | 19 discrete, 3 fixed roles (`admin/manager/cashier`) |
| Accounting | **none** — profit is derived (`sales.total − cost_total − expenses`) |

## 2. Requirement-by-requirement status (84 traceable requirements)

### A. Platform & delivery
| # | Status | Evidence / gap |
|---|---|---|
| A1 two EXEs | COMPLETE | release run 41788965176 published both installers |
| A2 fully offline | COMPLETE | zero network calls; prod CSP `connect-src 'none'` |
| A3 stack | COMPLETE | Electron 38 / React 19 / TS 5.9 |
| A4 light theme only | NEEDS IMPROVEMENT | v1.0.1 brief demands Light **and** Dark |
| A5 Bangla UI | COMPLETE | 17 pages, `lang="bn"` |
| A6 BDT poisa | COMPLETE | integer arithmetic throughout |
| A7 own logo | COMPLETE | generated icons |
| A8 NSIS keeps data | COMPLETE (config) | install not executed on Windows (BLOCKED field) |

### B. Data & financial accuracy
| # | Status | Evidence / gap |
|---|---|---|
| B1 SQLite ACID + WAL | COMPLETE | pragmas verified (F5b fix) |
| B2 migrations | PARTIAL | v1 only, additive; **no versioned migration framework for v2** |
| B3 poisa integers | COMPLETE | |
| B4 milli quantities | COMPLETE | |
| B5 weighted average cost | COMPLETE | |
| B6 profit with COGS | COMPLETE | but **no true accounting** (see E/Part 5 of brief) |
| B7 Bangla digits | COMPLETE | |
| B8 search/sort folding | COMPLETE | |
| B9 integrity check/repair | COMPLETE | |

### C. Products & inventory
| # | Status | Evidence / gap |
|---|---|---|
| C1 product CRUD + category/brand | COMPLETE | |
| C2 price levels + offer | PARTIAL | retail/wholesale/special exist; **no minimum selling price, no per-product max discount** |
| C3 barcode/QR | COMPLETE | multiple barcodes supported |
| C4 unit families | COMPLETE | |
| C5 stock ledger | COMPLETE | |
| C6 adjustment/write-off | COMPLETE | |
| C7 low-stock alert | COMPLETE | **no reorder level / suggested purchase qty** |
| C8 batches/expiry | PARTIAL | schema + expiry report; no receiving UI per batch |
| C9 CSV import | COMPLETE | |
| — variants | MISSING | `variant_parent_id`/`variant_attributes` columns exist, **no service, no UI** |
| — bundles / composite | MISSING | — |
| — service / non-stock items | MISSING | every product must hold stock |
| — serial / IMEI | MISSING | — |
| — multiple warehouses / transfer | MISSING | single global stock figure |
| — physical stock count session | PARTIAL | adjustment only, no count session + variance |

### D. Sales & POS
| # | Status | Evidence / gap |
|---|---|---|
| D1 fast POS | COMPLETE | F2/F4 keys, barcode box, tiles |
| D2 discounts w/ permission + limit | COMPLETE | |
| D3 credit sale | COMPLETE | **no credit limit enforcement** |
| D4 change | COMPLETE | |
| D5 invoice series | COMPLETE | |
| D6 preview = print | COMPLETE | |
| D7 58/80 mm | BLOCKED (hardware) | code path exists |
| D8 silent print | BLOCKED (hardware) | |
| D9 duplicate copy | COMPLETE | |
| D10 void | COMPLETE | |
| D11 labels | BLOCKED (hardware) | |
| — hold / resume sale | MISSING | |
| — split payment (multi-tender) | PARTIAL | `createSale` accepts a payments array, **UI sends only one tender** |
| — favourites / quick keys | MISSING | |
| — customer-facing display | MISSING | out of scope (hardware) |
| — exchange flow | PARTIAL | return + new sale must be done manually |

### E. Purchase, supplier, returns
| # | Status | Evidence / gap |
|---|---|---|
| E1 purchase + landed cost | COMPLETE | |
| E2 supplier payable/payment | COMPLETE | |
| E3 statement | COMPLETE | |
| E4 purchase void | COMPLETE | |
| E5 sale return | COMPLETE | refund clamped (v1.0.0 fix) |
| E6 purchase return | COMPLETE | |
| E7 refund accounting | COMPLETE | |
| — purchase order / partial receiving | MISSING | purchase is direct-entry only |
| — supplier advance | MISSING | |
| — supplier-price history report | PARTIAL | `price_history` table exists; no report |

### F. Customers, expenses, cash
| # | Status | Evidence / gap |
|---|---|---|
| F1 ledger/statement | COMPLETE | |
| F2 due collection | COMPLETE | |
| F3 walk-in protection | COMPLETE | |
| F4 expenses | COMPLETE | |
| F5 cash register | COMPLETE | |
| F6 cash movement audit | COMPLETE | |
| — credit limit | MISSING | |
| — customer groups / tier pricing | MISSING | |
| — loyalty points | MISSING | |
| — advances | MISSING | |
| — visit history / LTV / birthday | MISSING | |

### G. Reports & export
| # | Status | Evidence / gap |
|---|---|---|
| G1 27 reports | COMPLETE | every report executes (test) |
| G2 CSV | COMPLETE | |
| G3 XLSX | COMPLETE | |
| G4 PDF | PARTIAL | needs live window |
| G5 filters | COMPLETE | |
| G6 dashboard | COMPLETE | |
| G7 global search | COMPLETE | |
| — accounting reports (trial balance, P&L, balance sheet, day book, cash book, ledger) | MISSING | |
| — dead / fast / slow moving stock | MISSING | |
| — employee performance, shift report | PARTIAL | data exists (`sales.user_id`, `cash_sessions`), no report |
| — tax/VAT register | MISSING | `vat_percent_x100` computed, no register |

### H. Security, users, audit
| # | Status | Evidence / gap |
|---|---|---|
| H1 RBAC | NEEDS IMPROVEMENT | 3 hard-coded roles (`CHECK (role IN …)`), **no custom roles** |
| H2 IPC permission enforcement | COMPLETE | |
| H3 password hashing | COMPLETE | scrypt |
| H4 audit log | COMPLETE | |
| H5 no financial deletion | COMPLETE | |
| H6 window hardening | PARTIAL | `sandbox:false` (accepted) |
| H7 path escape | COMPLETE | |
| — employee attendance / clock in-out | MISSING | `sessions_log` records logins only |
| — approval workflow (discount/refund/void) | PARTIAL | permission-gated, no approve-after-the-fact |

### I. Backup & settings
| # | Status | Evidence / gap |
|---|---|---|
| I1 backup + manifest | COMPLETE | |
| I2 restore verify + safety copy | COMPLETE | |
| I3 auto backup | COMPLETE | |
| I4 retention | COMPLETE | |
| I5 settings | COMPLETE | 37 keys |
| I6 printer picker | BLOCKED (hardware) | |

### J. Licensing
| # | Status | Evidence / gap |
|---|---|---|
| J1 Ed25519 offline licence | COMPLETE | |
| J2 weighted fingerprint | COMPLETE | |
| J3 placeholder rejection | COMPLETE | |
| J4 rebinding process | COMPLETE (documented) | |
| J5 clock rollback guard | COMPLETE | |
| J6 generator EXE | COMPLETE | |
| J7 key containment | COMPLETE | installer byte-scan |
| J8 expiry/edition/features | COMPLETE | |
| — licence history in generator | MISSING | generator is stateless |
| — customer registry / search | MISSING | |
| — revoke / reissue management | MISSING | |
| — generator audit log | MISSING | |
| — activation history in app | PARTIAL | `activations` table only keeps current |

### K. Documentation & process
| # | Status | Evidence / gap |
|---|---|---|
| K1 docs | COMPLETE | 01–09 + FINAL_* |
| K2 traceability | COMPLETE | |
| K3 CI | COMPLETE | |
| K4 tag release | COMPLETE | |
| K5 no fake buttons | COMPLETE | `audit-ui.mjs` |
| K6 progress log | NEEDS IMPROVEMENT | v1.0.1 needs a live progress log (this file set) |

## 3. Counts at v1.0.0

| Status | Count |
|---|---|
| COMPLETE | 52 |
| PARTIAL | 13 |
| MISSING | 22 |
| NEEDS IMPROVEMENT | 4 |
| BROKEN | 0 |
| BLOCKED (hardware) | 3 |

Nothing is broken; the product's real gaps are **depth**, not stubs: no accounting
layer, no multi-location stock, no variants/bundles/serials, no loyalty/credit
limits, no hold-sale, no custom roles, a stateless licence generator, and only a
light theme.

## 4. Defects observed while auditing (beyond the v1.0.0 register)

| ID | Severity | Observation |
|---|---|---|
| A-1 | MEDIUM | `createSale` accepts several tenders but the POS UI can only send one → split payments impossible in practice |
| A-2 | MEDIUM | `products.image_path` is stored but never rendered as an image anywhere in the UI |
| A-3 | LOW | `price_history` is written but has no report and no UI |
| A-4 | LOW | `sessions_log` records logins but there is no login-history screen |
| A-5 | LOW | `REPORT_CATALOG` has 27 entries, but the brief lists 32 report types; 9 are absent (see G) |
| A-6 | LOW | Batch receiving is not exposed in the purchase UI, so `batches` stays empty in real use |

These are scheduled in `docs/12-ROADMAP-V101.md`.
