# Phase 2 — Module 1: POS / Sales — Functional Audit

**Date:** 2026-11-07
**Branch:** `arena/5db36292-merqo-retail-suite-app`, based on `main` @ `4b03d1f`
**Method:** code read + **executed probes against a real SQLite database** — never a screen-only
review. Every PASS below is a check that ran; every FAIL was reproduced before it was fixed, and
the fix was then re-checked with the fix removed (revert check).
**Verdict:** **PASS with 1 defect fixed** (F-POS-01, high). No financial data lost, no workflow
broken, no working feature removed.

All sixteen checks are now a permanent regression test:
`packages/core/test/pos-sales-audit-v120.test.ts` (16/16 pass on this branch).

---

## 1. What was audited

| Area | Files read |
|---|---|
| Sale commit (totals, discounts, price floor, stock, journal) | `packages/core/src/services/sales.ts` |
| Cart revalidation / conflict detection | `packages/core/src/services/sale-conflicts.ts`, `pos.ts` |
| Returns (partial, full, refunds, restock) | `packages/core/src/services/returns.ts`, `stock-ops.ts` |
| Void / reversal | `packages/core/src/services/sales.ts` (`voidSale`) |
| Permission gate at the trust boundary | `packages/app/electron/ipc.ts` (`pos.createSale`, `pos.compute`, `sales.void`, `invokeRoute`) |
| POS screen payload shape | `packages/app/src/pages/POS.tsx` |
| Automated coverage | `packages/core/test/{workflow,invariants,integrity-v113,accounting,audit,coupon-counters-v115}.test.ts` |

---

## 2. Findings

### F-POS-01 — Line-level discount bypasses the `pos.discount` permission — **HIGH — FIXED**

- **Module:** POS / Sales (authorisation)
- **File / function:** `packages/app/electron/ipc.ts` → route `pos.createSale`
- **Evidence (before fix):** the gate was
  ```ts
  if (input.orderDiscountValue > 0 && !hasPermission(ctx.user, 'pos.discount')) throw …
  if (input.lines?.some((l: any) => l.unitPricePaisa) && !hasPermission(ctx.user, 'pos.price_edit')) throw …
  ```
  Only the **order-level** discount was inspected. A sale request carrying one ৳100 line with
  `discountPaisa: 9500` and no order-level discount was **committed** for a cashier holding only
  `pos.sell`: `total ৳5`, profit ৳5 against a ৳80 cost. The per-product cap
  (`max_discount_percent_x100`) is `NULL` by default, so nothing else stopped it either.
- **Root cause:** the gate enumerated one *field* instead of the *intent*. Any new or
  non-standard client (LAN terminal, restored draft, script) could express the same intent
  through a field the gate did not know about.
- **Reachability:** the packaged POS screen never sets a positive `line.discountPaisa` (it
  initialises it to 0 and forwards it), so the stock UI cannot do this by hand. The **LAN API can**:
  it goes through the same `invokeRoute()` dispatcher, so a cashier token on any device on the shop
  LAN could commit a discounted sale with no permission, no audit flag and no override marker.
- **Business impact:** silent revenue loss that looks like an ordinary sale; a cashier could
  under-charge at will, below cost if desired.
- **Fix (root cause):** new pure predicates in `packages/core/src/services/pos-permissions.ts` —
  `saleRequestsDiscount()` (order-level **or** per line) and `saleRequestsPriceEdit()`. The IPC gate
  now asks the intent question, and continues to grant `allowBelowMinPrice` /
  `allowDiscountOverride` **from the user record only** — the request body is never trusted.
- **Regression tests (2 layers):**
  - `packages/core/test/pos-permissions.test.ts` — 6 unit tests on the predicates.
  - `packages/app/test/pos-sale-permissions-v120.test.ts` — 6 tests driving the **real
    `invokeRoute()`** (the same dispatcher the LAN transport uses) with real user rows: the exploit
    is refused and **nothing is written**; a plain sale by the same cashier still succeeds (the gate
    is not a blanket ban); a manager holding the permission can discount; override flags smuggled
    in the request body are ignored.
  - **Revert checks executed:** predicates reverted → `2 failed`; IPC gate reverted to
    `orderDiscountValue > 0` → the end-to-end exploit test fails (`1 failed | 11 passed`). Restored
    → `12 passed`.
- **Status:** FIXED.

### F-POS-02 — `unitPricePaisa: 0` is silently ignored, not rejected — **LOW — ACCEPTED (documented)**

- **File / function:** `packages/core/src/services/sales.ts` (`unitPricePaisa != null && > 0`).
- **Evidence:** a line sent with `unitPricePaisa: 0` is charged at the catalogue price; it does not
  become a free item, and the zero-paid request is then refused as an unpaid sale without customer.
- **Why accepted:** `0` is the established "no override" sentinel for imports, restored drafts and
  the UI (which sends `null`). Rejecting it would break restoring older drafts. The behaviour is
  fail-safe: the customer is charged the normal price, never nothing.
- **Follow-up (optional):** reject an explicit `unitPricePaisa: 0` at the IPC layer only, where the
  sentinel is never legitimate.

### F-POS-03 — Negative order discount accepted and clamped to zero — **LOW — ACCEPTED (documented)**

- **Evidence:** `orderDiscountType: 'percent' | 'fixed'` with a negative value completes the sale at
  full price (`discount: 0`, `total` unchanged). No surcharge, no negative total.
- **Impact:** none on money (`sales` rows with `total_paisa < 0` = 0 across all probes). It is a
  validation gap, not a revenue hole.
- **Follow-up:** reject negatives the next time the sales validator changes; doing it now would
  touch the import path for no financial gain.

### F-POS-04 — Unknown fields are silently dropped from the sale payload — **INFO — ACCEPTED**

- **Evidence:** an *order-level* `discountPaisa` (a field name that exists per line) is ignored
  rather than rejected; the sale completes at full price.
- **Assessment:** deliberate leniency for forward/backward compatibility. The dangerous variant of
  "silently ignored" is F-POS-01, which is now gated. Recorded so the probe log is not
  mis-read as a discount bug.

### F-POS-05 — Discount percentages are basis points; UI and service agree — **PASS (recorded because it looks like a bug)**

- **Evidence:** `orderDiscountValue: 1000` with `type: 'percent'` → `discount 1000` on a ৳100
  subtotal = 10 %. `POS.tsx` stores `Math.round(n * 100)` and displays `discountValue / 100`, so a
  user typing `10` sends `1000`. **No mismatch.** A 200 % discount clamps to the subtotal
  (`total 0`, change returned) — no negative total.

### F-POS-06 — `sales.void` is admin-only; returned invoices cannot be voided — **PASS**

- `ipc.ts` hard-checks `ctx.user.role !== 'admin'` for `sales.void` (role, not a permission list).
- Void on an invoice with any return is refused (`এই ইনভয়েসে রিটার্ন হয়েছে — বাতিল করা যাবে না।`);
  stock stayed at 97 000 milli after the refused void — the double-restock path does not exist.

---

## 3. The sixteen checks (all executed on this branch)

| # | Check | Result | Measured |
|---|---|---|---|
| 1 | Split payment across methods | PASS | ৳100 = 50 + 50, `due 0` |
| 2 | Overpayment → change, no phantom due | PASS | ৳150 on ৳100 → `change 5000`, `due 0` |
| 3 | Credit sale without a customer | PASS (refused) | `বাকিতে বিক্রয়ের জন্য কাস্টমার নির্বাচন করতে হবে।` |
| 4 | Sale of more than stock on hand | PASS (refused) | `পর্যাপ্ত স্টক নেই`, stock unchanged at 98 000 |
| 5 | Zero-quantity line | PASS (refused) | `পরিমাণ সঠিক নয়।` |
| 6 | Negative-quantity line | PASS (refused) | `পরিমাণ সঠিক নয়।` |
| 7 | Invoice numbering | PASS | `INV-2611-0001…0003` sequential |
| 8 | Second live connection | PASS | got `INV-2611-0004`; duplicate invoice numbers = 0 |
| 9 | Line discount larger than the line | PASS (clamped) | `total 0`, never negative |
| 10 | Price floor (`min_sale_price`) | PASS (refused) | `সর্বনিম্ন বিক্রয়মূল্য ৯০.০০ টাকা …` |
| 11 | Void restores stock exactly once | PASS | 96 000 → 97 000 |
| 12 | Duplicate void | PASS (refused) | `এই ইনভয়েস আগেই বাতিল করা হয়েছে।` |
| 13 | Void after a return | PASS (refused) | no double restock |
| 14 | Return more than sold | PASS (refused) | `সর্বোচ্চ 1.000 ফেরত দেওয়া সম্ভব।` |
| 15 | Partial returns accumulate, third refused | PASS | refunds 4 000 + 6 000, stock +1 000 |
| 16 | Accounting integrity after all of it | PASS | unbalanced journal entries 0, negative sale totals 0 |

---

## 4. Automated coverage

Existing suites already exercise `createSale` / `voidSale` / `createSaleReturn`:
`workflow`, `invariants`, `integrity-v113`, `accounting`, `audit`, `coupon-counters-v115`.
Added by this module: `pos-permissions.test.ts` (6), `pos-sale-permissions-v120.test.ts` (6,
end-to-end through `invokeRoute`), `pos-sales-audit-v120.test.ts` (the 16 checks above).

**Remaining coverage gaps (recorded, not fabricated):**

1. No load/concurrency test with realistic multi-terminal write pressure; only a second connection
   is covered (invoice numbering).
2. Receipt rendering is read, not printed — 58 mm / 80 mm layout is unverified until owner testing.
3. `pos.compute` (cart preview) is covered indirectly through `pos.createSale` only.

---

## 5. Not tested — deferred by owner policy

- Physical POS flow on the shop's own device (T01–T45 owner testing) — **NOT TESTED — OWNER
  TESTING DEFERRED**.
- Thermal printer, cash drawer, barcode gun, weighing scale — hardware, deferred.
- VM installer run — deferred.

## 6. Limits of this audit

- The LAN variant of F-POS-01 is proven at the dispatcher (`invokeRoute`), not replayed over a live
  TLS socket; transport authentication is covered separately by the Phase 4 security audit.
- No performance claims are made.
