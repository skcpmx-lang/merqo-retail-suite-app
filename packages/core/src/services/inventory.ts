import type { Db } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import { costValuePaisa, weightedAverageCost } from '../domain/money.js';
import type { StockMovement, StockMovementType } from '../domain/types.js';
import { audit } from './audit.js';
import { isPostingEnabled, postStockAdjustment } from './accounting.js';

type Actor = { id: number; username: string } | null | undefined;

export interface MovementInput {
  productId: number;
  /** Location whose stock mirror moves. Defaults to the default location. */
  locationId?: number | null;
  type: StockMovementType;
  /** Signed change in BASE unit milli (+ in, − out). */
  qtyBaseMilli: number;
  unitLabel?: string | null;
  qtyInputMilli?: number | null;
  refType?: string | null;
  refId?: string | number | null;
  reason?: string | null;
  note?: string | null;
  userId?: number | null;
  /** Cost of the incoming lot, micro poisa per BASE unit. Drives the WAC. */
  incomingCostMicro?: number | null;
  batchId?: number | null;
  createdAt?: string;
  /** Skip the negative-stock guard (used by corrections/returns). */
  force?: boolean;
  allowNegative?: boolean;
}

export interface MovementResult {
  balanceAfterMilli: number;
  avgCostMicro: number;
}

/**
 * The default location id, created on demand. Stored in `meta` so a shop that
 * renames its shop keeps the same id.
 */
export function defaultLocationId(db: Db): number {
  const meta = db.prepare("SELECT value FROM meta WHERE key = 'default_location_id'").get() as
    | { value: string }
    | undefined;
  if (meta) {
    const id = Number(meta.value);
    const row = db.prepare('SELECT id FROM locations WHERE id = ?').get(id) as { id: number } | undefined;
    if (row) return row.id;
  }
  const existing = db.prepare('SELECT id FROM locations WHERE is_default = 1 ORDER BY id LIMIT 1').get() as
    | { id: number }
    | undefined;
  const id =
    existing?.id ??
    Number(
      db
        .prepare("INSERT INTO locations (name, kind, is_default, created_at) VALUES ('প্রধান দোকান','shop',1,?)")
        .run(nowLocal()).lastInsertRowid,
    );
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('default_location_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(id));
  return id;
}

export function mirrorLocation(db: Db, productId: number, locationId: number, deltaMilli: number): void {
  db.prepare(
    `INSERT INTO stock_levels (product_id, location_id, qty_base_milli) VALUES (?,?,?)
     ON CONFLICT(product_id, location_id) DO UPDATE SET qty_base_milli = qty_base_milli + excluded.qty_base_milli`,
  ).run(productId, locationId, deltaMilli);
}

/**
 * The ONLY function that mutates product stock. Every sale, purchase, return,
 * adjustment and write-off goes through here so the movement ledger and the
 * cached product balance can never diverge.
 */
export function applyMovement(db: Db, input: MovementInput): MovementResult {
  const product = db
    .prepare('SELECT id, name, stock_base_milli, avg_cost_micro FROM products WHERE id = ?')
    .get(input.productId) as
    | { id: number; name: string; stock_base_milli: number; avg_cost_micro: number }
    | undefined;
  if (!product) throw new Error('প্রোডাক্ট পাওয়া যায়নি।');
  if (!Number.isFinite(input.qtyBaseMilli) || input.qtyBaseMilli === 0) {
    throw new Error('স্টক পরিবর্তনের পরিমাণ শূন্য হতে পারবে না।');
  }

  const before = product.stock_base_milli;
  const after = before + input.qtyBaseMilli;
  if (after < 0 && !input.force) {
    const allow = input.allowNegative ?? false;
    if (!allow) {
      throw new Error(
        `"${product.name}" এর পর্যাপ্ত স্টক নেই। বর্তমান স্টক: ${(before / 1000).toFixed(3)}।`,
      );
    }
  }

  let avgCost = product.avg_cost_micro;
  if (input.qtyBaseMilli > 0 && input.incomingCostMicro != null && input.incomingCostMicro >= 0) {
    avgCost = weightedAverageCost(before > 0 ? before : 0, avgCost, input.qtyBaseMilli, input.incomingCostMicro);
  }
  if (after <= 0 && avgCost < 0) avgCost = 0;

  db.prepare('UPDATE products SET stock_base_milli = ?, avg_cost_micro = ?, updated_at = ? WHERE id = ?').run(
    after,
    avgCost,
    nowLocal(),
    input.productId,
  );

  const locationId = input.locationId ?? defaultLocationId(db);
  mirrorLocation(db, input.productId, locationId, input.qtyBaseMilli);

  db.prepare(
    `INSERT INTO stock_movements
       (product_id, type, qty_base_milli, balance_after_milli, unit_label, qty_input_milli,
        ref_type, ref_id, reason, note, user_id, batch_id, created_at, location_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    input.productId,
    input.type,
    input.qtyBaseMilli,
    after,
    input.unitLabel ?? null,
    input.qtyInputMilli ?? null,
    input.refType ?? null,
    input.refId == null ? null : String(input.refId),
    input.reason ?? null,
    input.note ?? null,
    input.userId ?? null,
    input.batchId ?? null,
    input.createdAt ?? nowLocal(),
    locationId,
  );

  return { balanceAfterMilli: after, avgCostMicro: avgCost };
}

export interface AdjustInput {
  productId: number;
  newQtyBaseMilli: number;
  reason: string;
  note?: string | null;
  type?: 'adjustment' | 'damage' | 'expiry';
  actor?: Actor;
  costMicro?: number | null;
}

/** Set stock to an exact counted value (stock take), recording the delta. */
export function adjustStock(db: Db, input: AdjustInput): MovementResult {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(input.productId) as any;
  if (!product) throw new Error('প্রোডাক্ট পাওয়া যায়নি।');
  if (!input.reason || !input.reason.trim()) throw new Error('সমন্বয়ের কারণ লিখতে হবে।');
  const target = Math.round(input.newQtyBaseMilli);
  if (target < 0) throw new Error('স্টক ঋণাত্মক হতে পারবে না।');
  const delta = target - product.stock_base_milli;
  if (delta === 0) return { balanceAfterMilli: target, avgCostMicro: product.avg_cost_micro };
  const res = applyMovement(db, {
    productId: input.productId,
    type: input.type ?? 'adjustment',
    qtyBaseMilli: delta,
    reason: input.reason,
    note: input.note ?? null,
    userId: input.actor?.id ?? null,
    incomingCostMicro: input.costMicro ?? product.avg_cost_micro,
    force: true,
  });
  audit(db, {
    userId: input.actor?.id ?? null,
    username: input.actor?.username,
    action: 'stock.adjust',
    entity: 'product',
    entityId: input.productId,
    details: {
      productName: product.name,
      before: product.stock_base_milli,
      after: target,
      delta,
      reason: input.reason,
      type: input.type ?? 'adjustment',
    },
  });
  if (isPostingEnabled(db)) {
    postStockAdjustment(db, {
      productId: input.productId,
      deltaBaseMilli: delta,
      costMicro: input.costMicro ?? product.avg_cost_micro ?? 0,
      userId: input.actor?.id ?? null,
      reason: input.reason,
    });
  }
  return res;
}

/** Write off damaged / expired stock without touching the sales ledger. */
export function writeOffStock(
  db: Db,
  input: { productId: number; qtyBaseMilli: number; type: 'damage' | 'expiry'; reason: string; note?: string; actor?: Actor },
): MovementResult {
  const qty = Math.abs(Math.round(input.qtyBaseMilli));
  if (qty <= 0) throw new Error('পরিমাণ দিতে হবে।');
  const res = applyMovement(db, {
    productId: input.productId,
    type: input.type,
    qtyBaseMilli: -qty,
    reason: input.reason,
    note: input.note ?? null,
    userId: input.actor?.id ?? null,
    force: true,
  });
  audit(db, {
    userId: input.actor?.id ?? null,
    username: input.actor?.username,
    action: `stock.${input.type}`,
    entity: 'product',
    entityId: input.productId,
    details: { qty, reason: input.reason },
  });
  if (isPostingEnabled(db)) {
    postStockAdjustment(db, {
      productId: input.productId,
      deltaBaseMilli: -qty,
      costMicro: res.avgCostMicro,
      userId: input.actor?.id ?? null,
      reason: input.reason,
    });
  }
  return res;
}

export interface MovementFilter {
  productId?: number | null;
  type?: string | null;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export function listMovements(db: Db, f: MovementFilter = {}): { rows: StockMovement[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.productId) {
    where.push('m.product_id = ?');
    params.push(f.productId);
  }
  if (f.type) {
    where.push('m.type = ?');
    params.push(f.type);
  }
  if (f.from) {
    where.push('m.created_at >= ?');
    params.push(`${f.from} 00:00:00`);
  }
  if (f.to) {
    where.push('m.created_at <= ?');
    params.push(`${f.to} 23:59:59`);
  }
  if (f.search) {
    where.push('(p.search_text LIKE ? OR m.ref_id LIKE ? OR m.reason LIKE ?)');
    const like = `%${f.search.toLowerCase()}%`;
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db
      .prepare(`SELECT COUNT(*) c FROM stock_movements m JOIN products p ON p.id = m.product_id ${clause}`)
      .get(...params) as { c: number }
  ).c;
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(500, Math.max(10, f.pageSize ?? 50));
  const rows = db
    .prepare(
      `SELECT m.*, p.name AS product_name, u.username
         FROM stock_movements m
         JOIN products p ON p.id = m.product_id
         LEFT JOIN users u ON u.id = m.user_id
         ${clause}
        ORDER BY m.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as StockMovement[];
  return { rows, total };
}

export function stockValuePaisa(db: Db): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN stock_base_milli > 0 THEN
          CAST(ROUND(stock_base_milli * avg_cost_micro / 1000000000.0) AS INTEGER) ELSE 0 END), 0) v
         FROM products WHERE is_active = 1`,
    )
    .get() as { v: number };
  return row.v;
}

export function lowStockProducts(db: Db, limit = 50): any[] {
  return db
    .prepare(
      `SELECT p.id, p.name, p.stock_base_milli, p.min_stock_base_milli, u.short_name AS unit_short_name,
              COALESCE(ub.short_name, u.short_name) AS base_unit_short
         FROM products p
         LEFT JOIN units u ON u.id = COALESCE(p.primary_unit_id, p.unit_id)
         LEFT JOIN units ub ON ub.id = p.unit_id
        WHERE p.is_active = 1 AND p.stock_base_milli <= p.min_stock_base_milli AND p.stock_base_milli > 0
        ORDER BY (CAST(p.stock_base_milli AS REAL) / NULLIF(p.min_stock_base_milli,0)) ASC, p.name_sort
        LIMIT ?`,
    )
    .all(limit);
}

export function outOfStockProducts(db: Db, limit = 50): any[] {
  return db
    .prepare(
      `SELECT p.id, p.name, p.stock_base_milli, p.min_stock_base_milli, u.short_name AS unit_short_name
         FROM products p
         LEFT JOIN units u ON u.id = COALESCE(p.primary_unit_id, p.unit_id)
        WHERE p.is_active = 1 AND p.stock_base_milli <= 0
        ORDER BY p.name_sort LIMIT ?`,
    )
    .all(limit);
}

/** Expiry watch-list from the batch ledger. */
export function expiringBatches(db: Db, withinDays = 30): any[] {
  const row = db
    .prepare(
      `SELECT b.id, b.batch_no, b.expiry_date, b.qty_base_milli, p.name AS product_name, p.id AS product_id,
              CAST(julianday(b.expiry_date) - julianday('now','localtime') AS INTEGER) AS days_left
         FROM batches b JOIN products p ON p.id = b.product_id
        WHERE b.expiry_date IS NOT NULL AND b.qty_base_milli > 0
          AND julianday(b.expiry_date) <= julianday('now','localtime') + ?
        ORDER BY b.expiry_date`,
    )
    .all(withinDays);
  return row;
}

export function productValuationRow(db: Db, productId: number): { qty: number; value: number } {
  const p = db
    .prepare('SELECT stock_base_milli, avg_cost_micro FROM products WHERE id = ?')
    .get(productId) as { stock_base_milli: number; avg_cost_micro: number } | undefined;
  if (!p) return { qty: 0, value: 0 };
  return { qty: p.stock_base_milli, value: costValuePaisa(Math.max(0, p.stock_base_milli), p.avg_cost_micro) };
}
