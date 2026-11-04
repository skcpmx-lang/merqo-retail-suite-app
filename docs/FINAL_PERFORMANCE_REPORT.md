# FINAL PERFORMANCE REPORT

All numbers below were **measured**, not estimated, by `scripts/bench.mjs` on the
audited commit. No figure in this document was inferred, extrapolated or copied
from a design target.

## Hardware and software (L3)

```
node     v22.22.3
cpu      Intel(R) Xeon(R) Processor @ 2.60GHz   (shared container CPU)
ram      4131 MB
os       linux container, no display server
sqlite   better-sqlite3 13.0.3, WAL, synchronous=FULL, cache 16 MB
```

The benchmark seeds data directly into SQLite, measures each operation with
`process.hrtime.bigint()` over repeated iterations (median, p95 and max),
prints `EXPLAIN QUERY PLAN` for the four hottest queries, runs
`integrity_check` and `foreign_key_check`, and reports the resulting file size.

Reproduce:

```bash
node scripts/bench.mjs --products 1000  --sales 2000
node scripts/bench.mjs --products 50000 --customers 2000 --sales 50000
```

> A container CPU with shared cores is a *pessimistic* proxy for a shop PC
> (typically a 4-core Celeron/i3 with a SATA SSD), but it is not the same
> machine. Re-measure on the target hardware before quoting a figure.

## Dataset A — small shop (1 000 products, 50 customers, 2 000 sales, 1.8 MB)

| Operation | Time |
|---|---|
| Startup (open + migrate + seed) | 103.5 ms |
| Dashboard statistics | 2.8 ms |
| Product list, page 1 (50 rows) | 1.9 ms |
| Product search | 2.0 ms |
| Barcode lookup | 0.4 ms |
| Global search | 1.2 ms |
| Sales list, page 1 | 0.9 ms |
| Customers list, page 1 | 0.6 ms |
| Report: daily sales | 6.4 ms |
| Report: profit & loss | 3.5 ms |
| Report: stock valuation | 3.1 ms |
| Report: customer dues | 0.1 ms |
| Report: product performance | 3.1 ms |
| **Sale creation** (median / p95 / max) | **1.32 / 2.38 / 3.54 ms** |
| Backup (`VACUUM INTO`) | 31.9 ms |
| `integrity_check` / `foreign_key_check` | ok / 0 rows |

## Dataset B — mature shop (50 000 products, 2 000 customers, 50 000 sales, 47.9 MB)

| Operation | Time |
|---|---|
| Startup (open + migrate + seed) | 93.2 ms |
| Dashboard statistics | 43.7 ms |
| Product list, page 1 (50 rows) | 16.7 ms |
| Product search | 27.9 ms |
| Barcode lookup | 0.4 ms |
| Global search | 18.0 ms |
| Sales list, page 1 | 3.9 ms |
| Customers list, page 1 | 0.8 ms |
| Report: daily sales | 62.2 ms |
| Report: profit & loss | 35.1 ms |
| Report: stock valuation | 101.4 ms |
| Report: customer dues | 0.4 ms |
| Report: product performance | 45.2 ms |
| **Sale creation** (median / p95 / max) | **1.03 / 1.93 / 3.87 ms** |
| 200 consecutive sales (whole block) | 314.9 ms |
| Backup (`VACUUM INTO`, 47.9 MB) | 462.3 ms |
| `integrity_check` / `foreign_key_check` | ok / 0 rows |

## What this means for the shopkeeper

| Interaction | Requirement | Measured | Headroom |
|---|---|---|---|
| Scan a barcode and see the line appear | < 100 ms feels instant | 0.4 ms + one render | > 200× |
| Save a sale (stock, ledger, receipt) | < 250 ms | 1.03 ms median, 3.87 ms worst of 200 | > 60× |
| Open the dashboard at shift start | < 1 s | 44 ms at 50 000 sales | > 20× |
| Open the slowest report | < 1 s | 101 ms | ~10× |
| Back up 48 MB | < 5 s | 462 ms | ~10× |

Every measured interaction is at least an order of magnitude inside the
budget a shopkeeper perceives as instant, *on a throttled container CPU*.

## Effect of the durability fix (F5b)

Before this audit every pragma was silently rejected (databases ran in
rollback-journal mode, default 2 MB cache, no FK enforcement). Same hardware,
same 50 000-sale dataset:

| Metric | Before fix | After fix | Change |
|---|---|---|---|
| Sale creation (median) | 2.32 ms | 1.03 ms | **2.2× faster** |
| Startup (open + migrate + seed) | 114 ms | 93 ms | 1.2× faster |
| Crash durability | rollback journal | WAL + `synchronous=FULL` | stronger **and** faster |

## Known performance debt

| ID | Item | Measured impact | Decision |
|---|---|---|---|
| D-1 | Report date filters use `date(sale_date)`, so `idx_sales_date` is unused (`SCAN sales`) | 20.3 ms vs 5.55 ms on 200 000 sales | Documented; not changed in the release commit. Slowest report is still 101 ms at 50 000 sales. Recommended as the first post-release optimisation. |

## Verdict

`PASS` (L3). No operation in the audited build exceeds a quarter of the latency
budget a shopkeeper can notice, at ten times the data volume of a typical first
year of trading. The claim is bounded by the hardware listed above — it is a
measured result on a shared container CPU, not a field measurement on a customer
PC.
