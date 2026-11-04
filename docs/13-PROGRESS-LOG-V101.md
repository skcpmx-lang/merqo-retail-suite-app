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
| S5 CRM | **DONE (core + UI)** | loyalty earn/redeem/reverse/expire/adjust with ledger, credit-limit enforcement in the write path, groups, price levels, CSV import/export, POS redemption; 11 tests |
| S6 products | **DONE** | service/non-stock items (no stock movement), price floor + per-product discount cap enforced in the write path, variants with inherited pricing and own stock, multiple barcodes (string or object input), reorder quantity, price history; 6 tests |
| S7 licensing | **DONE (core + generator)** | Ed25519 signing (already in v1.0.0), hardware fingerprint + weighted match, generator issue ledger (JSONL), revoke with reason, re-issue (revokes old + signs new), history UI; limitation documented: offline apps never learn about a revocation |
| S8 UI | DONE | accounting/stock-op/CRM screens, POS hold+split+favourites, report groups |
| S9 reports | **DONE** | 46 reports (19 new: trial balance, ledger P&L, balance sheet, cash flow, day book, journal, account balances, loyalty, credit limits, AR/AP aging, transfers, count variance, reorder, dead stock, serial register, hourly, discount, tax) + CSV/Excel/PDF export |
| S10 docs + release | **DONE** | `docs/14-RELEASE-NOTES-V101.md`, CHANGELOG, এই লগ, ভার্সন ১.০.১, PR → CI → ট্যাগ `v1.0.1` → ইনস্টলার বিল্ড |

## Environment notes for a fresh session

```bash
cd /home/user/merqo-retail-suite-app
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm_config_nodedir=/usr/local npm_config_build_from_source=true npm ci
npx vitest run          # 164 tests (14 files) at the v1.0.1 baseline
node scripts/verify.mjs # full gate
```

## v1.0.1 final state (this session)

- **Tests**: 164/164 in 14 files. New files: `accounting`, `stock-ops`, `pos`, `crm`,
  `products-advanced`, `reports-v101`, `workflows-v101`, `migration-v2`.
- **Type-check**: clean for `packages/core`, `packages/app`, `packages/license-generator`.
- **Gates**: `node scripts/verify.mjs` ✔ (build + tests + ui wiring + secret scan),
  `node scripts/audit-ui.mjs` ✔ (191 IPC routes / 151 call sites).
- **Reports**: 46 (19 new). Every catalog id is executed by a test.
- **Accounting invariants**: debit = credit, ledger vs operational reconcile, no re-post,
  reversal-only corrections, `accounting_enabled=0` disables posting without touching data.
- **Known limits (unchanged honesty)**: thermal/label printing + cash drawer are BLOCKED
  (no hardware here), licence revocation is PARTIAL (offline), signed installers and a
  two-week pilot are BLOCKED. Deferred to v1.1: PO + partial receiving, coupons/vouchers/gift
  cards, one-screen exchange, LAN multi-terminal, Bangla⇄English toggle, customer display.

## Released (2026-11-04)

- PR **#3** → `main`, CI `Type-check, test and build` pass (36s), merge commit `e326dc7`.
- Annotated tag **`v1.0.1`** pushed; Release workflow run **41795021867** → success.
- Assets verified via Releases API:
  - `Sauda-Retail-Suite-Setup-1.0.1.exe` — 110 925 778 B — `6ba347da371341f7…9405283b`
  - `Sauda-License-Generator-1.0.1.exe` — 110 695 747 B — `6790d8244afa8b53…98473066`
  - `SHA256SUMS.txt` — 201 B — `aa798cc6fe7adde3…26f9b6dc81`
- Acceptance gate recorded in `docs/15-ACCEPTANCE-GATE-V101.md`: Critical 0 / High 0,
  four BLOCKED and one PARTIAL item carried into the release notes rather than hidden.
