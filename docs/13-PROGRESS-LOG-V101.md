# v1.0.1 PROGRESS LOG

Live log so a new session can resume exactly here. Update at the end of every step.

| Step | Status | Notes |
|---|---|---|
| Phase 1 audit | DONE | `docs/10-V101-AUDIT.md` — 52 COMPLETE / 13 PARTIAL / 22 MISSING / 4 NEEDS IMPROVEMENT |
| Phase 2 competitor research | DONE | `docs/11-COMPETITIVE-MATRIX.md` (Loyverse, uniCenta, RetailPro BD, Nexchar, Smart POS) |
| Phase 3 gap matrix | DONE | same document, §2 |
| Phase 4 roadmap | DONE | `docs/12-ROADMAP-V101.md` |
| S1 migration + schema v2 | **DONE** | 17 new tables, 13 new columns, default location + stock mirror, chart of accounts; 5 migration tests incl. real v1→v2 with trading data; 104/104 |
| S2 accounting | **DONE (core)** | double-entry ledger, 22-account chart, auto-posting for sale/purchase/payment/expense/return/void/cash/opening, trial balance, P&L, balance sheet, ledger, day book, cash book, reconciliation; 12 tests; **found+fixed a 1000× cost scale bug** |
| S3 inventory | **DONE (core)** | locations/godown, stock transfers (mirror-only, total untouched), physical count with posting, reorder + suggested qty with stated reason, WAC valuation, dead stock, serial/IMEI register + sell-once, bundles with value-preserving assembly; 11 tests |
| S4 POS | **DONE (core + UI)** | hold/resume/cancel cart (F3/F4), quick-pick favourites (right-click to pin), split payment rows, credit note, exchange (walk-in + credit), permission-checked discounts/price edits, cash session + difference reporting |
| S5 CRM | IN PROGRESS | |
| S6 products | PENDING | |
| S7 licensing | PENDING | |
| S8 UI | PENDING | |
| S9 reports | PENDING | |
| S10 docs + release | PENDING | |

## Environment notes for a fresh session

```bash
cd /home/user/merqo-retail-suite-app
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm_config_nodedir=/usr/local npm_config_build_from_source=true npm ci
npx vitest run          # 99 tests at v1.0.0 baseline
node scripts/verify.mjs # full gate
```
