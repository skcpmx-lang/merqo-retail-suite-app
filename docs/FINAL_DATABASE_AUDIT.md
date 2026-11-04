# FINAL DATABASE AUDIT

Engine: SQLite via `better-sqlite3` 13.0.3. Schema version **1**.
Evidence: `packages/core/test/schema-audit.test.ts` (14 tests),
`packages/core/test/audit.test.ts`, `scripts/bench.mjs` (instrumented run on a
fresh 50 000-sale database). Baseline: `FINAL_AUDIT_BASELINE.md`.

## 1. Inventory (measured from the live schema)

| Item | Count |
|---|---|
| Tables | 31 |
| Tables with a primary key | 31 / 31 |
| Indexes (explicit, `CREATE INDEX`) | 43 |
| Foreign-key references | 56 |
| Triggers | 0 |
| Views | 0 |
| Settings keys in a fresh database | 37 |

Design note: no triggers. Every derived value (stock, balance, profit) is
maintained by the service layer inside an explicit transaction. That is a
deliberate trade — triggers are invisible to the TypeScript code and would make
the "core owns the arithmetic" rule unprovable. The cost is that a hand-edited
database could drift; `integrityCheck()` and the `stock_movements` ledger make
that detectable.

## 2. Durability settings — the most serious finding of this audit

**F5b (CRITICAL, fixed).** `PRAGMAS` in `packages/core/src/db/connection.ts`
passed strings like `'PRAGMA journal_mode = WAL'` to `db.pragma()`. better-sqlite3
prepends `PRAGMA` itself, so every entry was a syntax error and **all of them
were silently discarded** — every database shipped before this audit ran in
rollback-journal mode with the default temporary store and a 2 MB page cache.

After the fix the values are applied and then read back on every open:

| Pragma | Value | Verified by |
|---|---|---|
| `journal_mode` | `wal` | test asserts `journal_mode = 'wal'` on a file DB |
| `synchronous` | `2` (FULL) | test asserts `synchronous = 2` |
| `foreign_keys` | `1` | test asserts `foreign_keys = 1`; open **throws** if it cannot be enabled |
| `busy_timeout` | `8000` | test asserts 8000 |
| `temp_store` | `2` (memory) | test asserts 2 |
| `cache_size` | `-16000` (16 MB) | test asserts -16000 |
| `wal_autocheckpoint` | `512` pages | checkpoint executed by test without error |

Measured effect of the fix on the same hardware and dataset: `createSale`
median **2.32 ms → 1.03 ms**, startup (open + migrate + seed) **114 ms → 93 ms**.

Note: `:memory:` databases report `journal_mode = 'memory'`, so the WAL
assertion deliberately uses a real file.

## 3. Migrations

| Scenario | Behaviour | Evidence |
|---|---|---|
| Fresh file | creates schema, stamps `user_version = 1` | test |
| Existing DB with `user_version = 0` | migrates in place, **all data and 37 settings preserved** | test |
| DB stamped `user_version = 99` (written by a newer build) | refuses to open with `…নতুন ভার্সনের…`, connection closed | test |
| Backup created by a newer schema | restore refused before the live DB is touched | `security-audit` test |

Migrations are additive and idempotent (`CREATE TABLE/INDEX IF NOT EXISTS`); no
`ALTER`, `INSERT` or destructive statement exists in `schema.ts`.

## 4. Referential integrity

`foreign_key_check` on the 50 000-sale benchmark database: **0 rows**.
`integrity_check`: **ok**.

Deliberately blocked deletions (all covered by tests): deleting a customer with
transactions or a non-zero balance, deleting a product that has moved, deleting a
category that still has products, hard-deleting a user who made sales, and
deactivating the last administrator.

## 5. Query plans (measured with `EXPLAIN QUERY PLAN`)

| Query | Plan | Verdict |
|---|---|---|
| Barcode lookup | `SEARCH product_barcodes USING INDEX sqlite_autoindex_product_barcodes_1 (code=?)` | good — 0.4 ms |
| SKU / product code lookup | index seek | good |
| Product list pagination | `SEARCH products USING INDEX idx_products_active` then filter | acceptable — 16.7 ms for page 1 of 50 000 |
| Product search | `idx_products_active` + `LIKE` filter | acceptable — 27.9 ms |
| Sale items for a sale | `SEARCH sale_items USING INDEX idx_sale_items_sale (sale_id=?)` | good |
| **Report date filters** | `SCAN sales` | **open finding** |

**Finding D-1 (open, documented, not changed).** Report predicates use
`date(sale_date) = ?`. A function on the column defeats `idx_sales_date`, so the
sales-based reports scan the table. Measured on 200 000 sales: **20.3 ms with
`date()` vs 5.55 ms with a range predicate + index**. The rewrite
(`sale_date >= ? AND sale_date < ?` with a timestamp literal) touches every
report query and changes rounding semantics at day boundaries, so it was
deliberately **not** bundled into a release-blocking audit. Current cost is
already inside budget: the slowest report (`stock_valuation`) measures 101 ms on
50 000 sales. Recommended as the first post-release optimisation, behind the
existing report tests.

## 6. Data-volume behaviour

Measured with `scripts/bench.mjs` (see `FINAL_PERFORMANCE_REPORT.md`):

| Dataset | DB size | Backup time | Integrity |
|---|---|---|---|
| 1 000 products / 2 000 sales | 1.8 MB | 27.6 ms | ok |
| 50 000 products / 2 000 customers / 50 000 sales | 47.9 MB | 462 ms | ok |

A shop doing 200 sales/day reaches 50 000 sales in about 8 months; storage and
query cost therefore stay inside the profile that was measured here for well
over a year of trading on the same machine.

## 7. Backup and restore

- Backup = `VACUUM INTO` (a consistent snapshot even while WAL is active) plus a
  manifest with SHA-256 and row counts.
- Restore = validate manifest + `integrity_check` + `user_version` gate →
  write a `pre_restore` safety copy → swap → **always** reopen the connection in
  a `finally` block.
- Byte-level corruption between manifest and restore is detected (`security-audit`
  flips one byte and the restore is refused).

## 8. Findings summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| F5b | CRITICAL | All PRAGMAs silently rejected → no WAL, no 16 MB cache, no FK enforcement | FIXED |
| F2 | HIGH | Restore could replace a live database without validating the copy first | FIXED |
| D-1 | MEDIUM | `date()` in report predicates defeats `idx_sales_date` | OPEN — documented, measured, non-blocking |
| D-2 | LOW | No triggers/views (by design); derived data depends on service-layer discipline | ACCEPTED |

Nothing in the database layer is `FAIL`. D-1 is the only open database item and
it is a performance finding, not a correctness one.
