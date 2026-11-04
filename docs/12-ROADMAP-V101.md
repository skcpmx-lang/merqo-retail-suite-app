# SAUDA v1.0.1 — PHASE 4: ARCHITECTURE & DELIVERY ROADMAP

## Design principles for this release

1. **Additive schema only.** No destructive table rebuild in v1.0.1. New tables and
   new nullable columns; the existing 31 tables keep their shape so a shop can roll
   back to v1.0.0 by restoring the automatic pre-migration backup.
2. **One source of truth per number.** The accounting ledger *derives from*
   operational documents (sales, purchases, payments, returns, expenses, cash
   movements) — it never becomes a parallel set of numbers that can disagree.
   A reconciliation test asserts ledger totals equal the operational totals.
3. **Multi-location without touching the ledger.** `products.stock_base_milli` stays
   authoritative; `stock_levels` mirrors it per location, and a test asserts
   `sum(stock_levels) == products.stock_base_milli` after every operation family.
4. **Every new business rule gets a test before it gets a UI.**
5. **No feature ships without an IPC route, a permission and an audit entry.**

## Schema v2 (additive)

| Table | Purpose |
|---|---|
| `accounts` | chart of accounts (code, name, type, is_cash, is_bank, is_system) |
| `journal_entries` | one row per accounting event (date, source, ref, memo, status, reverses_id) |
| `journal_lines` | debit/credit lines (entry_id, account_id, debit, credit) |
| `locations` | warehouse / shop / godown |
| `stock_levels` | product × location quantity mirror |
| `stock_transfers` | transfer header (from, to, date, note, user) |
| `stock_transfer_items` | product, qty |
| `stock_counts` | physical count session |
| `stock_count_items` | product, system qty, counted qty, variance |
| `held_sales` | parked cart (JSON lines, customer, note, user) |
| `loyalty_ledger` | points earn / redeem / reverse / expire with reference |
| `serial_numbers` | IMEI / engine no. with status + sale/purchase link |
| `product_bundles` | parent product → child product + qty |
| `purchase_orders` | PO header with status |
| `purchase_order_items` | PO lines with received qty |
| `role_templates` | named permission sets (custom roles) |
| `attendance` | clock in / clock out per user |

New columns: `customers.credit\_limit\_paisa, group\_name, birthday, loyalty\_points, visit\_count, total\_spent\_paisa`;
`products.min_sale_price, max_discount_percent_x100, is_service, reorder_qty_base_milli, image\_path` (exists);
`suppliers.advance_paisa`; `users.role_template_id, pin_hash`; `sales.tender_summary` (JSON of tenders);
`settings` keys for loyalty, theme, tax register.

Migration `v2` runs inside a transaction, writes a backup path first, is idempotent
(`IF NOT EXISTS` / column presence check), and refuses to continue if the backup
could not be created.

## Delivery order (each step = commit + tests)

| Step | Content | Why now |
|---|---|---|
| S1 | Migration framework + schema v2 + v1→v2 upgrade test on a seeded v1 database | everything depends on it |
| S2 | Accounting: accounts, posting service, auto-post hooks, trial balance / P&L / balance sheet / ledger / day book / cash book + reconciliation tests | biggest commercial gap |
| S3 | Inventory: locations, transfers, stock count + variance, reorder/suggested qty, serials, bundles, dead/fast/slow reports | competitor parity |
| S4 | POS: hold/resume, split tender UI, favourites, duplicate-sale guard | daily-use ergonomics |
| S5 | CRM: credit limit, loyalty ledger, groups, LTV/visits, customer advance | due-khata depth |
| S6 | Products: variants, service items, min price / max discount enforcement, image display | catalogue depth |
| S7 | Licence: generator registry/history/revoke/reissue/audit, app activation history | professional licensing |
| S8 | UI: dark theme, empty/loading states, keyboard map, error boundary, report polish | premium feel |
| S9 | Reports: +9 reports, dashboard KPIs, exports | decision support |
| S10 | Docs, acceptance gate, packaging, `v1.0.1` release | delivery |

## Explicitly deferred to v1.1 (with reasons)

| Deferred | Reason |
|---|---|
| Purchase orders with partial receiving | state machine (draft → partial → closed) plus receiving UI; also needs supplier-price effects designed. Shipping the tables now without the workflow would be a stub. |
| Coupons / vouchers / gift cards | Requires a promotion engine with rules, stacking precedence and liability accounting (gift card = liability). Doing it half-way would corrupt balances. |
| Exchange flow (return + instant re-sale) | Can be done today as return + sale; a one-screen flow is UX work, not data work. |
| LAN multi-terminal | Needs a conflict/locking model; risk to financial integrity if rushed. |
| Bangla ⇄ English UI toggle | Full i18n extraction of 17 pages; better done once as a dedicated pass. |
| Customer-facing display | Hardware-dependent. |

Deferring these is a decision, not an omission: each is listed in
`docs/09-known-limits.md` and in the release notes.

## Risk control

- Every release gate from v1.0.0 stays: typecheck ×3, full test suite, UI wiring
  audit, secret scan, installer scan, packaging on Windows.
- New financial code must pass a *reconciliation* test (ledger vs operational
  totals) before the step is committed.
- Upgrade test: build a v1.0.0 database with trading data, migrate to v2, assert
  every row count and every money total is unchanged.
