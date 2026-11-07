import { describe, expect, it } from 'vitest';
import { saleRequestsDiscount, saleRequestsPriceEdit } from '../src/index.js';

/**
 * F-POS-01 regression: a per-line `discountPaisa` must count as "asking for a
 * discount" so the IPC gate can demand `pos.discount`. Before the fix the gate only
 * looked at `orderDiscountValue`, and a cashier could discount any line — below cost
 * included — with no permission and no product cap.
 */
describe('POS permission requests (F-POS-01)', () => {
  it('treats an order-level discount as needing pos.discount', () => {
    expect(saleRequestsDiscount({ orderDiscountType: 'percent', orderDiscountValue: 1_000 })).toBe(true);
    expect(saleRequestsDiscount({ orderDiscountType: 'fixed', orderDiscountValue: 5_000 })).toBe(true);
  });

  it('treats a line-level discountPaisa as needing pos.discount (the regression)', () => {
    expect(
      saleRequestsDiscount({
        orderDiscountType: 'none',
        orderDiscountValue: 0,
        lines: [{ unitPricePaisa: null, discountPaisa: 9_500 }],
      }),
    ).toBe(true);
  });

  it('detects a line discount among undiscounted lines', () => {
    expect(
      saleRequestsDiscount({ lines: [{ discountPaisa: 0 }, { discountPaisa: null }, { discountPaisa: 100 }] }),
    ).toBe(true);
  });

  it('does not ask for pos.discount on an ordinary sale', () => {
    expect(
      saleRequestsDiscount({ orderDiscountType: 'none', orderDiscountValue: 0, lines: [{ discountPaisa: 0 }] }),
    ).toBe(false);
    expect(saleRequestsDiscount({ lines: [] })).toBe(false);
    expect(saleRequestsDiscount(null)).toBe(false);
  });

  it('ignores negative / non-finite values instead of demanding a permission', () => {
    expect(saleRequestsDiscount({ orderDiscountValue: -5_000, lines: [{ discountPaisa: -1 }] })).toBe(false);
    expect(saleRequestsDiscount({ orderDiscountValue: Number.NaN })).toBe(false);
    expect(saleRequestsPriceEdit({ lines: [{ unitPricePaisa: Number.POSITIVE_INFINITY }] })).toBe(false);
  });

  it('treats a positive unit price override as needing pos.price_edit', () => {
    expect(saleRequestsPriceEdit({ lines: [{ unitPricePaisa: 1 }] })).toBe(true);
    expect(saleRequestsPriceEdit({ lines: [{ unitPricePaisa: null }, { unitPricePaisa: 0 }] })).toBe(false);
    expect(saleRequestsPriceEdit({ lines: [{ discountPaisa: 500 }] })).toBe(false);
  });
});
