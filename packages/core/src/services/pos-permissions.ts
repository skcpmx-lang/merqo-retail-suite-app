/**
 * Which POS permissions a sale *request* implies.
 *
 * F-POS-01 (Phase 2 audit): the Electron IPC gate only looked at the order-level
 * `orderDiscountValue`, so a cashier without `pos.discount` could still send a
 * per-line `discountPaisa` and discount any line — including below cost. The
 * per-product cap (`max_discount_percent_x100`) only bites when a product has one
 * configured, and it is `NULL` by default, so nothing else stopped the request.
 *
 * The two predicates below keep that decision in one testable place: the IPC layer
 * asks "does this request need a permission?" and grants the override flags from the
 * logged-in user's real permissions, never from the request body.
 */
export interface PosSaleLineShape {
  /** Cashier-entered unit price (poisa). 0 / undefined means "use the catalogue price". */
  unitPricePaisa?: number | null;
  /** Per-line discount (poisa) — this is the field F-POS-01 was missing. */
  discountPaisa?: number | null;
}

export interface PosSaleRequestShape {
  orderDiscountType?: string | null;
  orderDiscountValue?: number | null;
  lines?: ReadonlyArray<PosSaleLineShape | null | undefined> | null;
}

const isPositiveAmount = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/** True when the request asks for any discount (order-level or per line). */
export function saleRequestsDiscount(input: PosSaleRequestShape | null | undefined): boolean {
  if (!input) return false;
  if (isPositiveAmount(input.orderDiscountValue)) return true;
  return (input.lines ?? []).some((line) => isPositiveAmount(line?.discountPaisa));
}

/** True when the request asks to override a unit price. */
export function saleRequestsPriceEdit(input: PosSaleRequestShape | null | undefined): boolean {
  if (!input) return false;
  return (input.lines ?? []).some((line) => isPositiveAmount(line?.unitPricePaisa));
}
