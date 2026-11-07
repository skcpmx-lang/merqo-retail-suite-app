# Phase 2 — Module 2: Products & Inventory — Functional Audit

**Date:** 2026-11-07
**Branch:** `arena/5db36292-merqo-retail-suite-app` (on `main` @ `4b03d1f`)
**Method:** code read + probes run against a real SQLite database, with the **renderer path** traced
(`Products.tsx`, `Inventory.tsx`) rather than assumed.
**Verdict: COMPLETE FOR THIS PASS — 1 high defect fixed, 1 medium confirmed and open (owner
decision needed), 15 checks executed and passing, 1 check inconclusive-by-design (documented).** Nothing below is inferred; the "INCONCLUSIVE" rows
are failures of my own probe harness, kept visible rather than dressed up as passes.

---

## Findings

### F-INV-01 — Opening stock entered in the product form is stored 1000× (or 12×, 50×) too small — **HIGH — FIXED**

- **Module:** Products & Inventory / quantity scale at the renderer-core boundary
- **Files:** `packages/app/src/pages/Products.tsx` (opening stock, minimum stock, reorder quantity,
  variant stock), `packages/app/src/pages/Inventory.tsx` (stock count / adjustment / write-off),
  core contract `packages/core/src/services/products.ts` (`applyMovement({ qtyBaseMilli })`).
- **Evidence (measured):**

  | Product form input | Primary unit (factor) | Stored `stock_base_milli` | Correct value | Error |
  |---|---|---|---|---|
  | 10 | পিস (1000) | 10 000 | 10 000 | none — identity |
  | 10 | লিটার (1000) | 10 000 | 10 000 | none — identity |
  | 10 | গ্রাম (1000) | 10 000 | 10 000 | none — identity |
  | 10 কেজি | কেজি (1 000 000) | 10 000 | 10 000 000 | **1000× too small** |
  | 500 মিলিলিটার | মি.লি. (1) | 500 000 | 500 | **1000× too large** |
  | 2 ডজন | ডজন (12 000) | 2 000 | 24 000 | **12× too small** |
  | 1 বস্তা | বস্তা (50 000 000) | 1 000 | 50 000 000 | **50× too small** |

- **Root cause:** the core stores **base-unit** milli (`stock_base_milli`, `qty_base_move`), and the
  import path converts into it (`openQtyMilli * unitFactor / 1000`) — but the renderer sent the raw
  `QtyInput` value, which is **primary-unit** milli, straight into `openingStockMilli` / `minStockMilli`
  / `adjustStock({ newQtyBaseMilli })`. The two scales coincide whenever `factor_milli === 1000`
  (পিস, গ্রাম, লিটার), which is exactly why the defect survived: a shop working only in pieces never
  sees it.
- **Reproduction (before the fix):** create "মিনিকেট চাল" in কেজি with opening stock 10 → the product
  row holds 10 000 base milli (10 g). Then sell 250 গ্রাম → **refused**:
  `"মিনিকেট চাল" এর পর্যাপ্ত স্টক নেই। বর্তমান স্টক: 10.000।` The shop cannot sell rice it has in
  stock; buying 10 kg from a supplier later adds 10 000 000 and the stock jumps wildly.
- **Business impact:** opening inventory, minimum-stock alerts, stock counts and adjustments are all
  wrong for every unit that is not its own base unit — i.e. কেজি, মিলিলিটার, ডজন, বস্তা, বান্ডেল,
  কার্টন — the units a grocery actually uses. Valuations, low-stock alerts and "insufficient stock"
  refusals follow the wrong number.
- **Fix:** one conversion layer, `packages/app/src/lib/qty-units.ts`
  (`primaryToBaseMilli`, `baseToPrimaryMilli`, `primaryFactorOf`), used by the product form (opening,
  minimum, reorder, variant stock), the stock-count dialog (display + submit) and both stock
  displays. The core contract is unchanged: existing rows, imports and every other caller keep
  passing base-unit milli, so **no migration and no data rewrite** is involved.
- **Regression tests:** `packages/app/test/qty-units-v120.test.ts` — 8 tests: identity for
  পিস/গ্রাম/লিটার, কেজি, মিলিলিটার, ডজন/বস্তা, round-trip, unusable-factor guard, factor lookup, and
  an end-to-end case through the real `invokeRoute()` (10 কেজি opening stock → a 250 গ্রাম sale
  succeeds and stock lands on 9 999 750).
  **Fail-on-revert executed:** with the conversion replaced by identity, **5 of 8 fail** (including
  the end-to-end rice sale); restored → 8/8.
- **Status:** FIXED. Remaining screens that show stock (purchases, reports, POS cart badges) were
  audited for this pass only where they carry a primary-unit label; anything still showing raw
  `stock_base_milli` is tracked below.

### F-INV-02 — A barcode can be given to more than one product — **MEDIUM — CONFIRMED, OPEN**

- **Evidence (measured):** `createProduct({barcode:'BC-1'})` on one product, then the same barcode on
  a second product → **accepted**. `product_barcodes` has only `idx_barcodes_product(product_id)`;
  there is no unique index on `code`, and `saveBarcodes()` checks for duplicates only *within one
  product*.
- **Impact:** scanning that barcode cannot be resolved deterministically (`findByCode` returns the
  first match) — the POS can bill the wrong product at the wrong price, and stock leaves the wrong
  row. Barcode labels are printed by the shop itself, so a duplicated code is a realistic outcome of
  copy/paste during setup.
- **Why not fixed in this pass:** enforcing uniqueness needs (a) a `UNIQUE` index on
  `product_barcodes.code`, (b) a migration that would **fail on shops that already have duplicates**,
  and (c) a decision on what to do with those rows (refuse to start, or keep the oldest and blank the
  rest). That is a data-repair decision with customer data behind it, so it goes to the owner instead
  of being done silently. Proposed fix is in `STATUS_AND_PLAN.md` as the next module-2 work item.
- **Status:** OPEN (owner decision needed on duplicate repair).

---

## Checks that PASSED (executed)

| # | Check | Evidence |
|---|---|---|
| 1 | Product create / read / update | rename + price change applied (`name=পণ্য আপডেট, price=6000`) |
| 2 | SKU uniqueness (case-insensitive) | duplicate `sku-a` refused |
| 4 | Negative-stock protection | oversell refused: `পর্যাপ্ত স্টক নেই। বর্তমান স্টক…` |
| 6 | Damaged / lost write-off | 5 000 − 2 000 = 3 000, movement written |
| 9 | Inventory valuation | `stockValuePaisa()` returns a number |
| 10 | Concurrent stock updates (two live connections) | 10 000 − 2 × 1 000 = 8 000, 3 movements, no lost update |
| 11 | Batch + expiry | product created with both flags; `expiringBatches()` runs |
| 12 | Database integrity | orphan stock rows 0, negative stock 0, unbalanced journal entries 0 |

## Checks re-run with the real API shapes (first pass was inconclusive because of my probe)

The first round sent `deltaMilli` / `items:[{qtyMilli}]` — fields the services ignore — so those
results proved nothing about the application. Re-run in
`packages/core/test/inventory-audit-v120.test.ts` (6 tests) with the shapes the app uses:

| # | Check | Result |
|---|---|---|
| 5 | Stock adjustment (`newQtyBaseMilli`) | PASS — absolute set 1 000 → 4 000; negative target refused; **blank reason refused** (an unexplained adjustment is unauditable) |
| 7 | Stock transfer (`items:[{productId, qtyBaseMilli}]`) | PASS — src 10 000 → 7 000, dest 0 → 3 000, product total unchanged at 10 000; empty transfer refused |
| 8 | Serial / IMEI | PASS — `{added: 2}`, then `{added: 1, skipped: ['IMEI-1']}`; 3 rows stored. Duplicates are **skipped by design**, not silently duplicated |
| 13 | Multi-unit pricing | PASS — 250 g of a ৳1200/kg product = ৳300 (30 000 paisa); a 0.25 g line = ৳0.30, so sub-unit precision survives; stock moves by exactly the base milli |
| 14 | FEFO batch deduction | PASS — sale of 12 consumes the batch expiring 2026-01-31 to 0 and leaves 8 in the 2027-12-31 batch |
| 15 | Import round-trip | PASS — products CSV previews (0 errors) and commits: 1 created, `sale_price` 120 taka → 12 000 paisa |
| 16 | `stock.adjust` permission | PASS — refused for a cashier without it, nothing written; allowed for a manager, and the reason lands in the movement (`packages/app/test/stock-adjust-permission-v120.test.ts`) |

**Export:** `reports.exportCsv` exists for reports and `customers.exportCsv` for customers; there is
**no products export**, so a "round-trip" exists in one direction only. Recorded as a gap, not a
defect: nothing was broken, a feature was never built.

## F-INV-01 legacy data — review, never auto-correct

The fix is in the renderer, so **no existing row changes**. A stored number can be right or wrong
(10 000 base-milli is 10 g if the old form wrote it, and correct if a purchase wrote it), so the
product's value cannot be deduced from the data alone. What can be listed is where the mistake is
*possible*:

- `stockScaleSuspects(db)` (`packages/core/src/services/stock-scale-review.ts`, 4 tests) returns
  products whose primary unit factor ≠ 1000, that still hold stock, and that have stock movements
  before the fix — with the ratio, the opening/purchase/sale/adjustment counts, and a one-line
  reason ("whole quantity suspect" vs "mixed with correctly converted purchases").
- `scripts/audit-inventory-data.mjs --db <path> [--json out.json]` opens the database **read-only**
  and prints the same list plus duplicate barcodes (F-INV-02). Verified against a scratch database:
  it flagged the কেজি product with a pre-fix opening movement and ignored the one created after the
  fix, and found the duplicated `BC-1`.
- **Correction plan (owner-driven, no script):** verify the physical quantity, then use
  Inventory → সমন্বয়, which is reason-stamped, audited and reversible by another adjustment. No
  bulk UPDATE, no migration, no automatic rewrite.

## F-INV-02 — duplicate barcodes: inventory and policy

- **Policy proposed:** normalise first (trim, keep leading zeros, no case folding for digits-only
  codes), enforce uniqueness per product *and* across products, and allow the same code in different
  `kind`s (barcode vs QR) only if the scan flow can tell them apart — today it cannot, so the rule
  is one code → one product.
- **Safe way to stop new duplicates now:** the service can refuse a code that is already used by a
  different product, without touching a single existing row (a duplicate already in the database
  keeps working; no shop is bricked by the update).
- **Existing duplicates:** list them with `scripts/audit-inventory-data.mjs`, decide per code which
  product physically carries it, clear it on the others, and only then add
  `CREATE UNIQUE INDEX … ON product_barcodes(code)` (which would otherwise fail on shops that have
  duplicates). Nothing is deleted or rewritten without that review.
