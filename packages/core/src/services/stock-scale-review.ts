import type { Db } from '../db/connection.js';

/**
 * Read-only review of stock that may have been stored on the wrong scale (F-INV-01 follow-up).
 *
 * Before v1.2.0 the product form and the stock-count dialog sent the quantity the shop typed
 * (primary-unit milli) where the core expects base-unit milli. The fix is in the renderer, so
 * **existing rows are untouched** — and they must stay untouched until a human decides, because
 * the same stored number can be right or wrong:
 *
 *   stock_base_milli = 10 000 for a কেজি product is correct if it came from a purchase or a sale
 *   (those always converted), and 1000× too small if it came from the broken form.
 *
 * So this function does not guess a product's value. It lists the products where the mistake is
 * *possible* — a primary unit whose factor is not 1000 (কেজি, মিলিলিটার, ডজন, বস্তা), a positive
 * stock, and at least one stock movement that predates the fix — together with the movement history
 * that a human needs to judge each row. Nothing is written; there is no "auto-correct".
 */

export interface StockScaleSuspect {
  productId: number;
  name: string;
  sku: string | null;
  primaryUnit: string;
  primaryFactorMilli: number;
  storedBaseMilli: number;
  /** The same number read back as primary units — what the shop would see today. */
  asPrimaryMilli: number;
  /** What a 1:1 mis-entry would have produced for the same typed number. */
  scaleRatio: number;
  openingMovements: number;
  purchaseMovements: number;
  saleMovements: number;
  adjustmentMovements: number;
  reason: string;
}

/**
 * @param db      the shop database
 * @param opts.fixedFromIso  first timestamp written by the fixed renderer; movements at or after it
 *                           are trusted, earlier ones are candidates. Defaults to the v1.2.0 date.
 */
export function stockScaleSuspects(
  db: Db,
  opts: { fixedFromIso?: string; limit?: number } = {},
): { suspects: StockScaleSuspect[]; scanned: number } {
  const fixedFrom = opts.fixedFromIso ?? '2026-11-07';
  const limit = Math.max(1, Math.min(5_000, opts.limit ?? 1_000));
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.sku, p.stock_base_milli,
              COALESCE(u.name, '') AS unit_name,
              COALESCE(u.factor_milli, 1000) AS factor_milli,
              SUM(CASE WHEN m.type = 'opening' THEN 1 ELSE 0 END) AS opening_moves,
              SUM(CASE WHEN m.type IN ('purchase','purchase_return') THEN 1 ELSE 0 END) AS purchase_moves,
              SUM(CASE WHEN m.type IN ('sale','sale_return') THEN 1 ELSE 0 END) AS sale_moves,
              SUM(CASE WHEN m.type IN ('adjustment','damage','expiry','transfer') THEN 1 ELSE 0 END) AS adjust_moves
         FROM products p
         LEFT JOIN units u ON u.id = COALESCE(p.primary_unit_id, p.unit_id)
         LEFT JOIN stock_movements m ON m.product_id = p.id AND m.created_at < ?
        WHERE p.stock_base_milli > 0
          AND COALESCE(u.factor_milli, 1000) <> 1000
        GROUP BY p.id
        -- Only products that actually have history from before the fix: a product created by the
        -- fixed renderer must never appear in this review.
        HAVING COUNT(m.id) > 0
        ORDER BY p.stock_base_milli DESC
        LIMIT ?`,
    )
    .all(fixedFrom, limit) as any[];

  const suspects: StockScaleSuspect[] = rows.map((r) => {
    const factor = Number(r.factor_milli) || 1000;
    const ratio = factor / 1000;
    const opening = Number(r.opening_moves ?? 0);
    const purchases = Number(r.purchase_moves ?? 0);
    const reason =
      opening > 0 && purchases === 0
        ? 'opening stock was entered on the old form and nothing has been purchased since — the whole quantity is suspect'
        : opening > 0
          ? 'opening stock from the old form is mixed with correctly converted purchases — a human must reconcile the two'
          : 'stock predates the fix but no opening movement is recorded — check the count/adjustment history';
    return {
      productId: Number(r.id),
      name: String(r.name),
      sku: r.sku ?? null,
      primaryUnit: String(r.unit_name),
      primaryFactorMilli: factor,
      storedBaseMilli: Number(r.stock_base_milli),
      asPrimaryMilli: Math.round((Number(r.stock_base_milli) * 1000) / factor),
      scaleRatio: ratio,
      openingMovements: opening,
      purchaseMovements: purchases,
      saleMovements: Number(r.sale_moves ?? 0),
      adjustmentMovements: Number(r.adjust_moves ?? 0),
      reason,
    };
  });

  return { suspects, scanned: rows.length };
}
