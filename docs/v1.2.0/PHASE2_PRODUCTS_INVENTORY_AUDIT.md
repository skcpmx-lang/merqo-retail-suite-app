# Phase 2 — Module 2: Products & Inventory — Functional Audit

**Date:** 2026-11-07
**Branch:** `arena/5db36292-merqo-retail-suite-app` (on `main` @ `4b03d1f`)
**Method:** code read + probes run against a real SQLite database, with the **renderer path** traced
(`Products.tsx`, `Inventory.tsx`) rather than assumed.
**Verdict for this pass: IN PROGRESS — 1 high defect fixed, 1 medium confirmed and open, 2 areas
inconclusive (harness), 8 areas verified pass.** Nothing below is inferred; the "INCONCLUSIVE" rows
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

## INCONCLUSIVE — my harness failed, not the application

| # | Check | What happened | Next step |
|---|---|---|---|
| 5 | Stock adjustment | probe sent `deltaMilli`; the API takes `newQtyBaseMilli` → `স্টক পরিবর্তনের পরিমাণ শূন্য হতে পারে না` | re-run with the real field |
| 7 | Stock transfer | probe sent `items:[{qtyMilli}]`; the API rejected it as "no product/quantity given" | read `createTransfer` input shape and re-run |
| 8 | Serial / IMEI | duplicate serials are **skipped by design** (`{added, skipped}`), so "accepted" was my misreading | assert `skipped` contents instead |

## Not yet executed (no claim made)

Multiple-unit pricing on one product, import/export round-trip, permission enforcement on
`stock.adjust` / `products.create`, batch-level stock deduction (FEFO), valuation cost basis per
product, and the UI label/placeholder review for the quantity fields (the form hint does say
"প্রাইমারি ইউনিট", which is now true — that was the intended label all along, and the code was the
thing that was wrong).
