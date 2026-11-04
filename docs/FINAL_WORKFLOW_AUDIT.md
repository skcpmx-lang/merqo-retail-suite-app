# FINAL WORKFLOW AUDIT (business logic)

Audited end to end, with the money and stock invariants that must hold after each
workflow. Evidence: `workflow.test.ts` (15), `audit.test.ts` (11),
`schema-audit.test.ts` (14). Baseline: `FINAL_AUDIT_BASELINE.md`.

## Global invariants asserted after every workflow

| # | Invariant | Where asserted |
|---|---|---|
| I-1 | `stock_qty` of a product equals the sum of its `stock_movements` | "keeps stock, dues, payables and cash consistent and free of orphans" |
| I-2 | `customers.balance_paisa` equals the sum of that customer's unpaid sale remainders minus collections and return credit | "keeps the customer statement in step with the stored balance" |
| I-3 | `suppliers.balance_paisa` equals unpaid purchases minus payments minus purchase-return credit | purchase workflow test |
| I-4 | Every invoice number is unique and gap-free within its series | "enforces unique invoice numbers and foreign keys" |
| I-5 | No financial row is ever deleted or updated to a smaller amount — corrections are void or reversal rows | `voidSale` / `voidPurchase` tests |
| I-6 | Every write is atomic: a failure leaves zero partial rows | "rolls back a failed sale completely" |
| I-7 | Cash drawer movement only happens for cash-type payment methods | "only moves drawer cash for cash payment methods" |

## 1. Sale (cash, card, mobile wallet, credit)

Steps: resolve lines → price with offer/level → compute discount (permission +
`max_discount_percent_x100`) → compute totals in poisa → `db.transaction`:
insert `sales`, `sale_items` (with `cost_total_paisa` from weighted average cost),
decrement stock via `applyMovement`, update customer balance, write cash movement,
increment invoice counter, `audit`.

Verified: profit = revenue − COGS; change = paid − total; change never negative;
payment above total is rejected with the excess returned as change; zero/negative
quantity rejected at the domain boundary; a 500-line invoice shows no rounding
drift; stock cannot go negative.

## 2. Credit sale and later collection

Due sale requires a real customer (`is_walkin` blocked). `receiveCustomerPayment`
reduces the balance, writes a payment row, a cash movement (if cash) and an audit
entry; overpayment is rejected.

Verified: "supports due sales, partial payment and later collection",
"refuses to delete a customer that has transactions or a balance".

## 3. Sale return / refund — **defect found and fixed**

**F1 (HIGH).** `createSaleReturn` computed the cash refund independently of the
credit the return created. On a credit invoice this paid cash *and* left the due
unchanged — the shop lost money and the customer's due was overstated by the
refund. Also, a refund line could exceed the amount actually paid on that
invoice.

Fixed behaviour:

1. Refund is clamped to the credit the return generates for that line.
2. If the invoice still carries a due, the return settles the due first
   (`refund_paisa = 0`, remainder reduces the balance).
3. Only the leftover becomes a cash refund, with a cash movement.
4. Cumulative returns can never exceed the sold quantity, even across repeated
   calls.

Verified by three tests: "applies a return against an outstanding due instead of
refunding cash", "pays out a cash refund only up to the credit created by the
return", "clamps a refund that exceeds the credit and reports the rest as due
relief", plus "never allows returning more than the invoice line, across repeated
calls".

## 4. Purchase and supplier payment

Steps: lines → landed-cost allocation (`computePurchase` distributes transport and
other costs by line value) → weighted average cost update → supplier payable →
audit. Partial payment reduces the payable. `voidPurchase` reverses stock,
payable and (if paid) cash.

Verified: "allocates transport cost into the landed cost", "tracks supplier
payable and partial payments", "handles purchase returns and reduces supplier
payable".

## 5. Purchase return

Reduces stock, reduces the supplier payable, and records an audit entry; the
return quantity is clamped to the received quantity for that line.

## 6. Expense, cash register and shift close

Expenses write a `cash_movements` row when paid in cash and appear in P&L.
The cash session tracks opening cash, expected cash (opening + cash sales +
collections − expenses − refunds − supplier cash payments) and the counted
amount; the difference is recorded, not silently adjusted.

Verified: "counts opening cash, sales, collections, expenses and refunds exactly
once" and "records expenses against cash and reflects them in P&L".

## 7. Stock adjustment, write-off and stock count

Adjustment requires a reason, writes a `stock_movements` row with `ref_id` and an
audit entry; a write-off is an adjustment with a loss reason so it lands in the
loss report rather than in COGS. Deleting a product that has moved is refused.

## 8. Void vs delete

`sales`, `purchases`, `expenses` and `returns` are never deleted. Void creates a
reversal (stock back, payment back, due corrected, `voided_at`/`voided_by` set)
and an audit entry. The UI offers no delete control for financial rows.

## 9. Backup and restore

Covered in `FINAL_DATABASE_AUDIT.md` §7. Workflow-level guarantee: after a
restore, the app is usable without restarting because the shell reopens the
connection in a `finally` block (**F3**), and a failed restore leaves the live
database untouched (**F2**).

## 10. Print and export workflows

Receipt, label, CSV, XLSX and PDF share one formatting path per artefact type, so
what is previewed is what is printed/saved. Actual printer output is `BLOCKED`
(no hardware) — see `FINAL_QA_CHECKLIST.md`.

## Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| F1 | HIGH | Refund could exceed the credit created by a return; credit invoices were refunded in cash while the due stayed | FIXED |
| F2 | HIGH | Restore replaced the live DB without validating the backup first | FIXED |
| F3 | MEDIUM | After a restore the shell kept a stale connection (app appeared broken until restart) | FIXED |
| F4 | LOW | Three UI strings contained characters from the wrong script | FIXED |
| W-4 | LOW | A sale may be recorded at zero price (a deliberate giveaway) — allowed by design, now covered by a test instead of being a silent surprise | DOCUMENTED + TESTED |

All financial workflows pass their invariant suite. No open `FAIL`.
