import type { Db } from '../db/connection.js';
import { nextCounter } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import { costValuePaisa } from '../domain/money.js';
import { audit } from './audit.js';
import { isPostingEnabled, postStockAdjustment } from './accounting.js';
import { applyMovement, defaultLocationId, mirrorLocation } from './inventory.js';

type Actor = { id: number; username: string } | null | undefined;

/* ------------------------------------------------------------------ *
 * Locations (shop / godown / warehouse)
 * ------------------------------------------------------------------ */

export interface LocationRow {
  id: number;
  name: string;
  kind: 'shop' | 'godown' | 'warehouse';
  address: string | null;
  is_default: number;
  is_active: number;
  created_at: string;
  qty_base_milli?: number;
  sku_count?: number;
}

export function listLocations(db: Db): LocationRow[] {
  // A shop that upgrades from v1.0.0 may have no location row yet.
  defaultLocationId(db);
  return db
    .prepare(
      `SELECT l.*,
              COALESCE((SELECT SUM(sl.qty_base_milli) FROM stock_levels sl WHERE sl.location_id = l.id),0) AS qty_base_milli,
              COALESCE((SELECT COUNT(*) FROM stock_levels sl WHERE sl.location_id = l.id AND sl.qty_base_milli <> 0),0) AS sku_count
         FROM locations l ORDER BY l.is_default DESC, l.name`,
    )
    .all() as LocationRow[];
}

export function createLocation(
  db: Db,
  input: { name: string; kind?: 'shop' | 'godown' | 'warehouse'; address?: string | null },
  actor?: Actor,
): LocationRow {
  const name = (input.name ?? '').trim();
  if (!name) throw new Error('লোকেশনের নাম দিতে হবে।');
  const dup = db.prepare('SELECT id FROM locations WHERE name = ?').get(name);
  if (dup) throw new Error('এই নামে আরেকটি লোকেশন আছে।');
  const info = db
    .prepare('INSERT INTO locations (name, kind, address, is_default, is_active, created_at) VALUES (?,?,?,0,1,?)')
    .run(name, input.kind ?? 'godown', input.address ?? null, nowLocal());
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username,
    action: 'location.create',
    entity: 'location',
    entityId: Number(info.lastInsertRowid),
    details: { name, kind: input.kind ?? 'godown' },
  });
  return listLocations(db).find((l) => l.id === Number(info.lastInsertRowid))!;
}

export function updateLocation(
  db: Db,
  id: number,
  input: { name?: string; kind?: 'shop' | 'godown' | 'warehouse'; address?: string | null; isActive?: boolean },
  actor?: Actor,
): LocationRow {
  const row = db.prepare('SELECT * FROM locations WHERE id = ?').get(id) as LocationRow | undefined;
  if (!row) throw new Error('লোকেশন পাওয়া যায়নি।');
  if (row.is_default && input.isActive === false) throw new Error('প্রধান লোকেশন নিষ্ক্রিয় করা যাবে না।');
  const name = input.name?.trim() || row.name;
  if (name !== row.name) {
    const dup = db.prepare('SELECT id FROM locations WHERE name = ? AND id <> ?').get(name, id);
    if (dup) throw new Error('এই নামে আরেকটি লোকেশন আছে।');
  }
  db.prepare('UPDATE locations SET name = ?, kind = ?, address = ?, is_active = ? WHERE id = ?').run(
    name,
    input.kind ?? row.kind,
    input.address === undefined ? row.address : input.address,
    input.isActive === false ? 0 : 1,
    id,
  );
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username,
    action: 'location.update',
    entity: 'location',
    entityId: id,
    details: { name, isActive: input.isActive !== false },
  });
  return listLocations(db).find((l) => l.id === id)!;
}

/** Per-location stock for one product (falls back to the total for the default shop). */
export function locationStock(db: Db, productId: number): { location_id: number; name: string; qty_base_milli: number }[] {
  return db
    .prepare(
      `SELECT l.id AS location_id, l.name, COALESCE(sl.qty_base_milli,0) AS qty_base_milli
         FROM locations l
         LEFT JOIN stock_levels sl ON sl.location_id = l.id AND sl.product_id = ?
        WHERE l.is_active = 1
        ORDER BY l.is_default DESC, l.name`,
    )
    .all(productId) as { location_id: number; name: string; qty_base_milli: number }[];
}

/* ------------------------------------------------------------------ *
 * Stock transfers between locations
 * ------------------------------------------------------------------ */

export interface TransferItemInput {
  productId: number;
  qtyBaseMilli: number;
}

export interface TransferRow {
  id: number;
  transfer_no: string;
  from_location: number;
  from_name: string;
  to_location: number;
  to_name: string;
  transfer_date: string;
  note: string | null;
  created_at: string;
  total_qty: number;
  item_count: number;
}

function assertLocation(db: Db, id: number, label: string): LocationRow {
  const row = db.prepare('SELECT * FROM locations WHERE id = ?').get(id) as LocationRow | undefined;
  if (!row) throw new Error(`${label} পাওয়া যায়নি।`);
  if (!row.is_active) throw new Error(`${label} নিষ্ক্রিয় আছে।`);
  return row;
}

/**
 * Move stock between two locations. The product's total stock does not change —
 * only the per-location mirror — so this can never create or destroy inventory.
 */
export function createTransfer(
  db: Db,
  input: {
    fromLocationId: number;
    toLocationId: number;
    items: TransferItemInput[];
    note?: string | null;
    date?: string;
    actor?: Actor;
  },
): TransferRow {
  if (input.fromLocationId === input.toLocationId) throw new Error('একই লোকেশনে ট্রান্সফার করা যাবে না।');
  const from = assertLocation(db, input.fromLocationId, 'প্রেরকের লোকেশন');
  const to = assertLocation(db, input.toLocationId, 'গন্তব্যের লোকেশন');
  const items = (input.items ?? []).filter((i) => i && Number.isFinite(i.qtyBaseMilli) && i.qtyBaseMilli > 0);
  if (items.length === 0) throw new Error('অন্তত একটি পণ্য ও পরিমাণ দিন।');

  // Merge duplicate lines so the same product cannot be sent twice.
  const merged = new Map<number, number>();
  for (const it of items) merged.set(it.productId, (merged.get(it.productId) ?? 0) + Math.round(it.qtyBaseMilli));

  return db.transaction(() => {
    const date = input.date ?? nowLocal();
    const no = `TRF-${date.slice(2, 4)}${date.slice(5, 7)}-${String(nextCounter(db, 'stock_transfer')).padStart(4, '0')}`;
    const transferId = Number(
      db
        .prepare(
          `INSERT INTO stock_transfers (transfer_no, from_location, to_location, transfer_date, note, user_id, created_at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(no, from.id, to.id, date, input.note ?? null, input.actor?.id ?? null, nowLocal()).lastInsertRowid,
    );

    for (const [productId, qty] of merged) {
      const product = db
        .prepare('SELECT id, name, stock_base_milli FROM products WHERE id = ?')
        .get(productId) as { id: number; name: string; stock_base_milli: number } | undefined;
      if (!product) throw new Error('প্রোডাক্ট পাওয়া যায়নি।');
      const have = Number(
        (
          db
            .prepare('SELECT COALESCE(qty_base_milli,0) AS q FROM stock_levels WHERE product_id = ? AND location_id = ?')
            .get(productId, from.id) as { q: number } | undefined
        )?.q ?? 0,
      );
      if (have < qty) {
        throw new Error(
          `"${product.name}" — ${from.name} এ মাত্র ${(have / 1000).toFixed(3)} আছে, ${(qty / 1000).toFixed(3)} পাঠানো যাবে না।`,
        );
      }
      db.prepare(
        `INSERT INTO stock_transfer_items (transfer_id, product_id, qty_base_milli) VALUES (?,?,?)`,
      ).run(transferId, productId, qty);
      // Mirror moves only — products.stock_base_milli stays untouched.
      mirrorLocation(db, productId, from.id, -qty);
      mirrorLocation(db, productId, to.id, qty);
      const balance = product.stock_base_milli;
      const mv = db.prepare(
        `INSERT INTO stock_movements
           (product_id, type, qty_base_milli, balance_after_milli, ref_type, ref_id, reason, note, user_id, created_at, location_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      );
      mv.run(productId, 'transfer', -qty, balance, 'stock_transfer_out', String(transferId), `${from.name} → ${to.name}`, input.note ?? null, input.actor?.id ?? null, date, from.id);
      mv.run(productId, 'transfer', qty, balance, 'stock_transfer_in', String(transferId), `${from.name} → ${to.name}`, input.note ?? null, input.actor?.id ?? null, date, to.id);
    }

    audit(db, {
      userId: input.actor?.id ?? null,
      username: input.actor?.username,
      action: 'stock.transfer',
      entity: 'stock_transfer',
      entityId: transferId,
      details: { no, from: from.name, to: to.name, lines: merged.size },
    });
    return listTransfers(db).rows.find((t) => t.id === transferId)!;
  })();
}

export function listTransfers(
  db: Db,
  f: { from?: string; to?: string; locationId?: number; search?: string; page?: number; pageSize?: number } = {},
): { rows: TransferRow[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.from) {
    where.push('t.transfer_date >= ?');
    params.push(f.from);
  }
  if (f.to) {
    where.push('t.transfer_date <= ?');
    params.push(f.to);
  }
  if (f.locationId) {
    where.push('(t.from_location = ? OR t.to_location = ?)');
    params.push(f.locationId, f.locationId);
  }
  if (f.search) {
    where.push('(t.transfer_no LIKE ? OR lf.name LIKE ? OR lt.name LIKE ?)');
    params.push(`%${f.search}%`, `%${f.search}%`, `%${f.search}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, f.pageSize ?? 50));
  const total = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM stock_transfers t
             JOIN locations lf ON lf.id = t.from_location
             JOIN locations lt ON lt.id = t.to_location ${clause}`,
        )
        .get(...params) as { c: number }
    ).c,
  );
  const rows = db
    .prepare(
      `SELECT t.*, lf.name AS from_name, lt.name AS to_name,
              COALESCE((SELECT SUM(i.qty_base_milli) FROM stock_transfer_items i WHERE i.transfer_id = t.id),0) AS total_qty,
              COALESCE((SELECT COUNT(*) FROM stock_transfer_items i WHERE i.transfer_id = t.id),0) AS item_count
         FROM stock_transfers t
         JOIN locations lf ON lf.id = t.from_location
         JOIN locations lt ON lt.id = t.to_location
         ${clause}
        ORDER BY t.transfer_date DESC, t.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as TransferRow[];
  return { rows, total };
}

export function transferItems(db: Db, transferId: number): any[] {
  return db
    .prepare(
      `SELECT i.*, p.name AS product_name, COALESCE(u.short_name, u2.short_name) AS unit_short
         FROM stock_transfer_items i
         JOIN products p ON p.id = i.product_id
         LEFT JOIN units u ON u.id = COALESCE(p.primary_unit_id, p.unit_id)
         LEFT JOIN units u2 ON u2.id = p.unit_id
        WHERE i.transfer_id = ?`,
    )
    .all(transferId) as any[];
}

/* ------------------------------------------------------------------ *
 * Physical stock count (stock take)
 * ------------------------------------------------------------------ */

export interface StockCountRow {
  id: number;
  count_no: string;
  location_id: number;
  location_name: string;
  status: 'draft' | 'posted' | 'cancelled';
  note: string | null;
  created_at: string;
  posted_at: string | null;
  item_count: number;
  diff_count: number;
}

export function createStockCount(
  db: Db,
  input: { locationId?: number; note?: string | null; productIds?: number[]; all?: boolean; actor?: Actor },
): StockCountRow {
  return db.transaction(() => {
    const locationId = input.locationId ?? defaultLocationId(db);
    const location = assertLocation(db, locationId, 'লোকেশন');
    const date = nowLocal();
    const no = `CNT-${date.slice(2, 4)}${date.slice(5, 7)}-${String(nextCounter(db, 'stock_count')).padStart(4, '0')}`;
    const countId = Number(
      db
        .prepare('INSERT INTO stock_counts (count_no, location_id, status, note, user_id, created_at) VALUES (?,?,?,?,?,?)')
        .run(no, locationId, 'draft', input.note ?? null, input.actor?.id ?? null, nowLocal()).lastInsertRowid,
    );
    // Default scope: every active product that has stock at this location.
    const rows = db
      .prepare(
        `SELECT p.id AS product_id, COALESCE(sl.qty_base_milli,0) AS qty
           FROM products p
           LEFT JOIN stock_levels sl ON sl.product_id = p.id AND sl.location_id = ?
          WHERE p.is_active = 1
            AND (? = 1 OR COALESCE(sl.qty_base_milli,0) <> 0)
          ORDER BY p.name_sort`,
      )
      .all(locationId, input.all ? 1 : 0) as { product_id: number; qty: number }[];
    const wanted = input.productIds?.length ? new Set(input.productIds) : null;
    const ins = db.prepare(
      'INSERT OR REPLACE INTO stock_count_items (count_id, product_id, system_qty_milli, counted_qty_milli) VALUES (?,?,?,?)',
    );
    let n = 0;
    for (const r of rows) {
      if (wanted && !wanted.has(r.product_id)) continue;
      ins.run(countId, r.product_id, r.qty, r.qty);
      n++;
    }
    if (n === 0) throw new Error('গণনার জন্য কোনো পণ্য পাওয়া যায়নি।');
    audit(db, {
      userId: input.actor?.id ?? null,
      username: input.actor?.username,
      action: 'stock.count.create',
      entity: 'stock_count',
      entityId: countId,
      details: { no, location: location.name, lines: n },
    });
    return listStockCounts(db).rows.find((c) => c.id === countId)!;
  })();
}

export function listStockCounts(
  db: Db,
  f: { status?: string; locationId?: number; page?: number; pageSize?: number } = {},
): { rows: StockCountRow[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.status) {
    where.push('c.status = ?');
    params.push(f.status);
  }
  if (f.locationId) {
    where.push('c.location_id = ?');
    params.push(f.locationId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((db.prepare(`SELECT COUNT(*) AS c FROM stock_counts c ${clause}`).get(...params) as { c: number }).c);
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, f.pageSize ?? 50));
  const rows = db
    .prepare(
      `SELECT c.*, l.name AS location_name,
              (SELECT COUNT(*) FROM stock_count_items i WHERE i.count_id = c.id) AS item_count,
              (SELECT COUNT(*) FROM stock_count_items i WHERE i.count_id = c.id AND i.counted_qty_milli <> i.system_qty_milli) AS diff_count
         FROM stock_counts c JOIN locations l ON l.id = c.location_id ${clause}
        ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as StockCountRow[];
  return { rows, total };
}

export function stockCountItems(db: Db, countId: number): any[] {
  return db
    .prepare(
      `SELECT i.*, p.name AS product_name, COALESCE(u.short_name, u2.short_name) AS unit_short,
              p.avg_cost_micro,
              (i.counted_qty_milli - i.system_qty_milli) AS diff_milli
         FROM stock_count_items i
         JOIN products p ON p.id = i.product_id
         LEFT JOIN units u ON u.id = COALESCE(p.primary_unit_id, p.unit_id)
         LEFT JOIN units u2 ON u2.id = p.unit_id
        WHERE i.count_id = ? ORDER BY p.name_sort`,
    )
    .all(countId) as any[];
}

export function setCountedQty(db: Db, countId: number, productId: number, countedQtyMilli: number): void {
  const count = db.prepare('SELECT status FROM stock_counts WHERE id = ?').get(countId) as { status: string } | undefined;
  if (!count) throw new Error('গণনা পাওয়া যায়নি।');
  if (count.status !== 'draft') throw new Error('পোস্ট হওয়া গণনা আর পরিবর্তন করা যাবে না।');
  const qty = Math.round(countedQtyMilli);
  if (!Number.isFinite(qty) || qty < 0) throw new Error('গণনার পরিমাণ সঠিক নয়।');
  const info = db.prepare('UPDATE stock_count_items SET counted_qty_milli = ? WHERE count_id = ? AND product_id = ?').run(qty, countId, productId);
  if (info.changes === 0) throw new Error('গণনার লাইন পাওয়া যায়নি।');
}

/** Post a count: every difference becomes a stock adjustment + journal entry. */
export function postStockCount(db: Db, countId: number, actor?: Actor): { adjusted: number; created: number } {
  return db.transaction(() => {
    const count = db.prepare('SELECT * FROM stock_counts WHERE id = ?').get(countId) as
      | { id: number; count_no: string; location_id: number; status: string }
      | undefined;
    if (!count) throw new Error('গণনা পাওয়া যায়নি।');
    if (count.status !== 'draft') throw new Error('এই গণনা আগেই পোস্ট বা বাতিল হয়েছে।');
    const location = assertLocation(db, count.location_id, 'লোকেশন');
    const items = stockCountItems(db, countId);
    let adjusted = 0;
    let created = 0;
    for (const it of items) {
      // The delta is measured against the location's CURRENT mirror, not the
      // snapshot taken when the sheet was created, so sales during the count
      // do not get double-counted.
      const currentRow = db
        .prepare('SELECT COALESCE(qty_base_milli,0) AS q FROM stock_levels WHERE product_id = ? AND location_id = ?')
        .get(it.product_id, count.location_id) as { q: number } | undefined;
      const current = Number(currentRow?.q ?? 0);
      const diff = Math.round(it.counted_qty_milli) - current;
      if (diff === 0) continue;
      const product = db.prepare('SELECT id, name, stock_base_milli, avg_cost_micro FROM products WHERE id = ?').get(it.product_id) as any;
      // The counted quantity is authoritative for THIS location; the product
      // total changes only by the difference recorded here.
      const res = applyMovement(db, {
        productId: it.product_id,
        locationId: count.location_id,
        type: 'adjustment',
        qtyBaseMilli: diff,
        reason: `স্টক গণনা ${count.count_no}`,
        note: `সিস্টেম ${(it.system_qty_milli / 1000).toFixed(3)} → গণনা ${(it.counted_qty_milli / 1000).toFixed(3)}`,
        refType: 'stock_count',
        refId: countId,
        userId: actor?.id ?? null,
        incomingCostMicro: product.avg_cost_micro,
        force: true,
      });
      if (isPostingEnabled(db)) {
        postStockAdjustment(db, {
          sourceId: countId * 1000 + Number(it.product_id),
          productId: it.product_id,
          deltaBaseMilli: diff,
          costMicro: product.avg_cost_micro,
          date: nowLocal(),
          userId: actor?.id ?? null,
          reason: `স্টক গণনা ${count.count_no}`,
        });
      }
      void res;
      adjusted++;
    }
    created = items.length - adjusted;
    db.prepare("UPDATE stock_counts SET status = 'posted', posted_at = ?, user_id = COALESCE(user_id, ?) WHERE id = ?").run(
      nowLocal(),
      actor?.id ?? null,
      countId,
    );
    audit(db, {
      userId: actor?.id ?? null,
      username: actor?.username,
      action: 'stock.count.post',
      entity: 'stock_count',
      entityId: countId,
      details: { no: count.count_no, location: location.name, adjusted, unchanged: created },
    });
    return { adjusted, created };
  })();
}

export function voidStockCount(db: Db, countId: number, actor?: Actor): void {
  const count = db.prepare('SELECT status FROM stock_counts WHERE id = ?').get(countId) as { status: string } | undefined;
  if (!count) throw new Error('গণনা পাওয়া যায়নি।');
  if (count.status === 'posted') throw new Error('পোস্ট হওয়া গণনা বাতিল করা যাবে না — সমন্বয় এন্ট্রি ব্যবহার করুন।');
  db.prepare("UPDATE stock_counts SET status = 'cancelled' WHERE id = ?").run(countId);
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username,
    action: 'stock.count.cancel',
    entity: 'stock_count',
    entityId: countId,
  });
}

/* ------------------------------------------------------------------ *
 * Reorder levels, suggested purchase quantity, valuation, dead stock
 * ------------------------------------------------------------------ */

/**
 * Reorder suggestions. Velocity comes from the last 30 days of sales so the
 * suggestion explains itself: need = target level − current stock, where the
 * target is max(min_stock, 30-day daily rate × lead days + minimum).
 */
export function reorderSuggestions(
  db: Db,
  opts: { leadDays?: number; days?: number; limit?: number; locationId?: number } = {},
): any[] {
  const leadDays = Math.max(1, opts.leadDays ?? 7);
  const days = Math.max(1, opts.days ?? 30);
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare(
      `WITH sold AS (
         SELECT si.product_id,
                SUM(si.qty_base_milli) AS sold_base_milli
           FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE s.status = 'completed' AND substr(s.created_at,1,10) >= ?
          GROUP BY si.product_id
       )
       SELECT p.id, p.name, p.stock_base_milli, p.min_stock_base_milli, p.avg_cost_micro,
              COALESCE(u.short_name, u2.short_name) AS unit_short,
              COALESCE(sold.sold_base_milli,0) AS sold_base_milli,
              CAST(COALESCE(sold.sold_base_milli,0) / ? AS INTEGER) AS daily_sales_milli,
              CAST(MAX(p.min_stock_base_milli, COALESCE(sold.sold_base_milli,0) / ? * ?) AS INTEGER) AS target_base_milli,
              (SELECT sp.name FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id JOIN suppliers sp ON sp.id = pu.supplier_id
                WHERE pi.product_id = p.id ORDER BY pu.purchase_date DESC, pu.id DESC LIMIT 1) AS supplier_name
         FROM products p
         LEFT JOIN units u ON u.id = COALESCE(p.primary_unit_id, p.unit_id)
         LEFT JOIN units u2 ON u2.id = p.unit_id
         LEFT JOIN sold ON sold.product_id = p.id
        WHERE p.is_active = 1
          AND p.stock_base_milli <= MAX(p.min_stock_base_milli, CAST(COALESCE(sold.sold_base_milli,0) / ? * ? AS INTEGER))
        ORDER BY (CAST(p.stock_base_milli AS REAL) / NULLIF(MAX(p.min_stock_base_milli,1),0)) ASC, p.name_sort
        LIMIT ?`,
    )
    .all(from, days, days, leadDays, days, leadDays, Math.min(500, opts.limit ?? 100))
    .map((r: any) => {
      const target = Math.max(Number(r.target_base_milli) || 0, Number(r.min_stock_base_milli) || 0);
      const need = Math.max(0, target - (Number(r.stock_base_milli) || 0));
      return {
        ...r,
        suggested_base_milli: need,
        estimated_value_paisa: costValuePaisa(need, Number(r.avg_cost_micro) || 0),
        reason:
          Number(r.sold_base_milli) > 0
            ? `গত ${days} দিনে বিক্রি ${(Number(r.sold_base_milli) / 1000).toFixed(2)} — ${leadDays} দিনের চাহিদা ধরে রাখতে হবে`
            : 'স্টক সর্বনিম্ন সীমার নিচে বা সমান, সাম্প্রতিক বিক্রি নেই',
      };
    });
}

/**
 * Inventory valuation at weighted average cost. The engine stores one moving
 * average cost per product, so FIFO/LIFO views are explicitly NOT offered —
 * the method is reported as WAC instead of pretending otherwise.
 */
export function inventoryValuation(
  db: Db,
  f: { search?: string; categoryId?: number; locationId?: number; includeZero?: boolean; page?: number; pageSize?: number } = {},
): { rows: any[]; total: number; totals: { qty_base_milli: number; value_paisa: number; sku_count: number }; method: string } {
  const where: string[] = ['p.is_active = 1'];
  const params: unknown[] = [];
  if (!f.includeZero) where.push('p.stock_base_milli <> 0');
  if (f.search) {
    where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.product_code LIKE ?)');
    params.push(`%${f.search}%`, `%${f.search}%`, `%${f.search}%`);
  }
  if (f.categoryId) {
    where.push('p.category_id = ?');
    params.push(f.categoryId);
  }
  const clause = `WHERE ${where.join(' AND ')}`;
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, f.pageSize ?? 100));
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.sku, p.stock_base_milli, p.avg_cost_micro, p.sale_price, p.min_stock_base_milli,
              COALESCE(u.short_name, u2.short_name) AS unit_short,
              CAST(ROUND(p.stock_base_milli * p.avg_cost_micro / 1000000000.0) AS INTEGER) AS value_paisa,
              CAST(ROUND(p.stock_base_milli * p.sale_price / 1000.0) AS INTEGER) AS retail_value_paisa
         FROM products p
         LEFT JOIN units u ON u.id = COALESCE(p.primary_unit_id, p.unit_id)
         LEFT JOIN units u2 ON u2.id = p.unit_id
         ${clause}
        ORDER BY p.name_sort LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as any[];
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS sku_count,
              COALESCE(SUM(p.stock_base_milli),0) AS qty_base_milli,
              COALESCE(SUM(CAST(ROUND(p.stock_base_milli * p.avg_cost_micro / 1000000000.0) AS INTEGER)),0) AS value_paisa
         FROM products p ${clause}`,
    )
    .get(...params) as { sku_count: number; qty_base_milli: number; value_paisa: number };
  return { rows, total: agg.sku_count, totals: agg, method: 'moving-average (WAC)' };
}

/** Stock that has not sold at all in `days` — money sitting on the shelf. */
export function deadStock(db: Db, days = 60, limit = 100): any[] {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT p.id, p.name, p.stock_base_milli, p.avg_cost_micro,
              CAST(ROUND(p.stock_base_milli * p.avg_cost_micro / 1000000000.0) AS INTEGER) AS value_paisa,
              (SELECT MAX(substr(s.created_at,1,10)) FROM sale_items si JOIN sales s ON s.id = si.sale_id
                WHERE si.product_id = p.id AND s.status='completed') AS last_sold_on
         FROM products p
        WHERE p.is_active = 1 AND p.stock_base_milli > 0
          AND NOT EXISTS (
            SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id
             WHERE si.product_id = p.id AND s.status='completed' AND substr(s.created_at,1,10) >= ?)
        ORDER BY value_paisa DESC LIMIT ?`,
    )
    .all(cutoff, Math.min(500, limit)) as any[];
}

/* ------------------------------------------------------------------ *
 * Serial numbers (IMEI, engine number, warranty tracking)
 * ------------------------------------------------------------------ */

export function registerSerials(
  db: Db,
  input: { productId: number; serials: string[]; locationId?: number | null; purchaseId?: number | null; note?: string | null; actor?: Actor },
): { added: number; skipped: string[] } {
  const product = db.prepare('SELECT id, name FROM products WHERE id = ?').get(input.productId) as
    | { id: number; name: string }
    | undefined;
  if (!product) throw new Error('প্রোডাক্ট পাওয়া যায়নি।');
  const list = (input.serials ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (list.length === 0) throw new Error('অন্তত একটি সিরিয়াল নম্বর দিন।');
  const locationId = input.locationId ?? defaultLocationId(db);
  const ins = db.prepare(
    `INSERT INTO serial_numbers (product_id, serial, status, location_id, purchase_id, note, created_at, updated_at)
     VALUES (?,?, 'in_stock', ?, ?, ?, ?, ?)`,
  );
  const skipped: string[] = [];
  let added = 0;
  const now = nowLocal();
  for (const serial of list) {
    try {
      ins.run(input.productId, serial, locationId, input.purchaseId ?? null, input.note ?? null, now, now);
      added++;
    } catch {
      skipped.push(serial);
    }
  }
  audit(db, {
    userId: input.actor?.id ?? null,
    username: input.actor?.username,
    action: 'serial.register',
    entity: 'product',
    entityId: input.productId,
    details: { product: product.name, added, skipped: skipped.length },
  });
  return { added, skipped };
}

export function listSerials(
  db: Db,
  f: { productId?: number; status?: string; search?: string; page?: number; pageSize?: number } = {},
): { rows: any[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.productId) {
    where.push('s.product_id = ?');
    params.push(f.productId);
  }
  if (f.status) {
    where.push('s.status = ?');
    params.push(f.status);
  }
  if (f.search) {
    where.push('(s.serial LIKE ? OR p.name LIKE ?)');
    params.push(`%${f.search}%`, `%${f.search}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS c FROM serial_numbers s JOIN products p ON p.id = s.product_id ${clause}`).get(...params) as { c: number }).c,
  );
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, f.pageSize ?? 50));
  const rows = db
    .prepare(
      `SELECT s.*, p.name AS product_name, l.name AS location_name, sa.invoice_no
         FROM serial_numbers s
         JOIN products p ON p.id = s.product_id
         LEFT JOIN locations l ON l.id = s.location_id
         LEFT JOIN sales sa ON sa.id = s.sale_id
         ${clause}
        ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as any[];
  return { rows, total };
}

/** Sell serials; throws when a requested serial is not available. */
export function markSerialsSold(
  db: Db,
  serials: string[],
  saleId: number,
  actor?: Actor,
  options: { productId?: number | null } = {},
): number {
  if (!serials?.length) return 0;
  const now = nowLocal();
  // `serial_numbers` is UNIQUE(product_id, serial), so the same IMEI-style string can exist for two
  // products. Without the product in the WHERE clause, selling one marked *every* product's row with
  // that serial as sold — and a serial belonging to another product was accepted on any line (A-13).
  const scoped = options.productId != null;
  const upd = db.prepare(
    scoped
      ? "UPDATE serial_numbers SET status = 'sold', sale_id = ?, updated_at = ? WHERE serial = ? AND product_id = ? AND status = 'in_stock'"
      : "UPDATE serial_numbers SET status = 'sold', sale_id = ?, updated_at = ? WHERE serial = ? AND status = 'in_stock'",
  );
  const productName = scoped
    ? (
        db.prepare('SELECT name FROM products WHERE id = ?').get(Number(options.productId)) as
          | { name: string }
          | undefined
      )?.name
    : undefined;
  let n = 0;
  for (const s of serials) {
    const serial = String(s).trim();
    const info = scoped
      ? upd.run(saleId, now, serial, Number(options.productId))
      : upd.run(saleId, now, serial);
    if (info.changes === 0) {
      throw new Error(
        productName
          ? `সিরিয়াল "${serial}" "${productName}" এর জন্য পাওয়া যায়নি (আগেই বিক্রি হয়েছে বা অন্য প্রোডাক্টের সিরিয়াল?)।`
          : `সিরিয়াল "${serial}" বিক্রয়ের জন্য পাওয়া যায়নি (আগেই বিক্রি হয়েছে?)।`,
      );
    }
    if (info.changes > 1) {
      throw new Error(`সিরিয়াল "${serial}" একাধিক প্রোডাক্টে নিবন্ধিত — ডেটা ঠিক করুন, তারপর বিক্রয় করুন।`);
    }
    n++;
  }
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username,
    action: 'serial.sold',
    entity: 'sale',
    entityId: saleId,
    details: { serials: n },
  });
  return n;
}

/**
 * Serials a POS terminal may attach to a line right now (v1.1.3).
 *
 * Before this there was no way to sell a serialised item through the POS at all:
 * the sale service accepted serials, the stock screen could register them, but the
 * till could never pick one — so phones/IMEIs silently bypassed tracking.
 */
export function listAvailableSerials(
  db: Db,
  args: { productId: number; limit?: number; search?: string | null },
): { rows: { id: number; serial: string; location_id: number | null }[]; total: number } {
  const limit = Math.min(200, Math.max(1, Math.round(args.limit ?? 50)));
  const search = (args.search ?? '').trim();
  const clause = search ? 'AND s.serial LIKE ?' : '';
  const params: unknown[] = [args.productId];
  if (search) params.push(`%${search}%`);
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM serial_numbers s WHERE s.product_id = ? AND s.status = 'in_stock' ${clause}`)
      .get(...params) as { c: number }
  ).c;
  const rows = db
    .prepare(
      `SELECT s.id, s.serial, s.location_id FROM serial_numbers s
        WHERE s.product_id = ? AND s.status = 'in_stock' ${clause}
        ORDER BY s.id LIMIT ?`,
    )
    .all(...params, limit) as { id: number; serial: string; location_id: number | null }[];
  return { rows, total };
}

/**
 * Returns every serial/IMEI this invoice sold to the sellable pool.
 *
 * v1.1.3 fix: a voided sale left its serials at `status='sold'` forever, so the
 * same phone could never be sold again and stock reports disagreed with reality.
 * Only rows this sale actually sold are touched (`sale_id = ? AND status='sold'`),
 * so a repeated void is a no-op and a serial sold by another invoice is untouched.
 */
export function releaseSerialsForSale(
  db: Db,
  saleId: number,
  opts: { actor?: Actor; note?: string | null } = {},
): number {
  const rows = db
    .prepare("SELECT id, serial FROM serial_numbers WHERE sale_id = ? AND status = 'sold'")
    .all(saleId) as { id: number; serial: string }[];
  if (!rows.length) return 0;
  const now = nowLocal();
  const upd = db.prepare(
    "UPDATE serial_numbers SET status = 'in_stock', updated_at = ?, note = COALESCE(?, note) WHERE id = ? AND status = 'sold'",
  );
  let n = 0;
  for (const row of rows) {
    if (upd.run(now, opts.note ?? null, row.id).changes === 1) n += 1;
  }
  if (n > 0) {
    audit(db, {
      userId: opts.actor?.id ?? null,
      username: opts.actor?.username,
      action: 'serial.sale_reversed',
      entity: 'sale',
      entityId: saleId,
      details: { serials: n, note: opts.note ?? null },
    });
  }
  return n;
}

/**
 * Puts specific serials from an invoice back into stock after a return.
 *
 * A good, restocked unit becomes sellable again (`in_stock`); a damaged or
 * non-restocked unit becomes `damaged`/`returned` so it can never be sold silently.
 * The serial must belong to the invoice being returned against — this is what stops
 * a made-up or already-returned serial from being "returned" a second time.
 */
export function returnSerialsFromSale(
  db: Db,
  args: {
    saleId: number;
    productId: number;
    serials: string[];
    condition?: 'good' | 'damaged' | 'expired';
    restock?: boolean;
    actor?: Actor;
    note?: string | null;
  },
): { returned: number; status: 'in_stock' | 'damaged' | 'returned' } {
  const list = (args.serials ?? []).map((s) => String(s).trim()).filter(Boolean);
  const target: 'in_stock' | 'damaged' | 'returned' =
    args.condition && args.condition !== 'good' ? 'damaged' : args.restock === false ? 'returned' : 'in_stock';
  if (!list.length) return { returned: 0, status: target };
  const now = nowLocal();
  let returned = 0;
  for (const serial of list) {
    const row = db
      .prepare('SELECT id, status, sale_id, product_id FROM serial_numbers WHERE serial = ?')
      .get(serial) as
      | { id: number; status: string; sale_id: number | null; product_id: number }
      | undefined;
    if (!row) throw new Error(`সিরিয়াল "${serial}" পাওয়া যায়নি।`);
    if (row.product_id !== args.productId) {
      throw new Error(`সিরিয়াল "${serial}" এই লাইনের পণ্য নয় — ভুল লাইনে ফেরত দেওয়া হচ্ছে।`);
    }
    if (row.sale_id !== args.saleId || row.status !== 'sold') {
      throw new Error(`সিরিয়াল "${serial}" এই ইনভয়েসের বিক্রীত তালিকায় নেই — ফেরত নেওয়া যাবে না।`);
    }
    db.prepare('UPDATE serial_numbers SET status = ?, updated_at = ?, note = COALESCE(?, note) WHERE id = ?').run(
      target,
      now,
      args.note ?? null,
      row.id,
    );
    returned += 1;
  }
  audit(db, {
    userId: args.actor?.id ?? null,
    username: args.actor?.username,
    action: 'serial.returned',
    entity: 'sale',
    entityId: args.saleId,
    details: { serials: returned, status: target },
  });
  return { returned, status: target };
}

/* ------------------------------------------------------------------ *
 * Bundles / combo packs
 * ------------------------------------------------------------------ */

export interface BundleLine {
  child_id: number;
  child_name: string;
  qty_base_milli: number;
  available_base_milli: number;
}

export function setBundle(
  db: Db,
  parentId: number,
  lines: { childId: number; qtyBaseMilli: number }[],
  actor?: Actor,
): BundleLine[] {
  const parent = db.prepare('SELECT id, name FROM products WHERE id = ?').get(parentId) as
    | { id: number; name: string }
    | undefined;
  if (!parent) throw new Error('প্রোডাক্ট পাওয়া যায়নি।');
  const clean = (lines ?? []).filter((l) => l && l.childId !== parentId && l.qtyBaseMilli > 0);
  return db.transaction(() => {
    db.prepare('DELETE FROM product_bundles WHERE parent_id = ?').run(parentId);
    const ins = db.prepare('INSERT INTO product_bundles (parent_id, child_id, qty_base_milli) VALUES (?,?,?)');
    for (const l of clean) {
      if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(l.childId)) {
        throw new Error('বান্ডলের একটি পণ্য পাওয়া যায়নি।');
      }
      ins.run(parentId, l.childId, Math.round(l.qtyBaseMilli));
    }
    audit(db, {
      userId: actor?.id ?? null,
      username: actor?.username,
      action: 'bundle.set',
      entity: 'product',
      entityId: parentId,
      details: { parent: parent.name, lines: clean.length },
    });
    return getBundle(db, parentId);
  })();
}

export function getBundle(db: Db, parentId: number): BundleLine[] {
  return db
    .prepare(
      `SELECT b.child_id, p.name AS child_name, b.qty_base_milli, p.stock_base_milli AS available_base_milli
         FROM product_bundles b JOIN products p ON p.id = b.child_id
        WHERE b.parent_id = ? ORDER BY p.name_sort`,
    )
    .all(parentId) as BundleLine[];
}

/** How many complete bundles can be built from current child stock. */
export function bundleCapacity(db: Db, parentId: number): number {
  const lines = getBundle(db, parentId);
  if (lines.length === 0) return 0;
  return Math.max(
    0,
    Math.floor(Math.min(...lines.map((l) => Math.floor(l.available_base_milli / l.qty_base_milli)))),
  );
}

/**
 * Assemble bundles: consume child stock and build parent stock, keeping the
 * inventory value identical (the parent inherits exactly the value of the
 * children consumed). No journal entry is needed because nothing is gained or
 * lost — the same money simply sits in a different SKU.
 */
export function assembleBundle(
  db: Db,
  input: { parentId: number; count?: number; actor?: Actor },
): { parentQtyMilli: number; children: { productId: number; qtyMilli: number }[] } {
  const parent = db.prepare('SELECT id, name, avg_cost_micro, stock_base_milli FROM products WHERE id = ?').get(input.parentId) as
    | { id: number; name: string; avg_cost_micro: number; stock_base_milli: number }
    | undefined;
  if (!parent) throw new Error('প্রোডাক্ট পাওয়া যায়নি।');
  const lines = getBundle(db, parent.id);
  if (lines.length === 0) throw new Error('এই পণ্যের কোনো বান্ডল সংজ্ঞা নেই।');
  const count = Math.max(1, Math.round(input.count ?? 1));

  return db.transaction(() => {
    let totalValuePaisa = 0;
    const children: { productId: number; qtyMilli: number }[] = [];
    for (const line of lines) {
      const need = line.qty_base_milli * count;
      const row = db.prepare('SELECT id, name, stock_base_milli, avg_cost_micro FROM products WHERE id = ?').get(line.child_id) as any;
      if (Number(row.stock_base_milli) < need) {
        throw new Error(
          `"${row.name}" এর স্টক যথেষ্ট নয় — দরকার ${(need / 1000).toFixed(3)}, আছে ${(Number(row.stock_base_milli) / 1000).toFixed(3)}।`,
        );
      }
      const value = costValuePaisa(need, Number(row.avg_cost_micro) || 0);
      totalValuePaisa += value;
      applyMovement(db, {
        productId: line.child_id,
        type: 'adjustment',
        qtyBaseMilli: -need,
        reason: `বান্ডল তৈরি: ${parent.name}`,
        refType: 'bundle_assembly',
        refId: parent.id,
        userId: input.actor?.id ?? null,
        force: true,
      });
      children.push({ productId: line.child_id, qtyMilli: need });
    }

    const parentQty = 1000 * count; // parent "piece" bundles are whole units
    const incomingCostMicro = parentQty > 0 ? Math.round((totalValuePaisa * 1_000_000_000) / parentQty) : 0;
    const res = applyMovement(db, {
      productId: parent.id,
      type: 'adjustment',
      qtyBaseMilli: parentQty,
      reason: `বান্ডল তৈরি: ${children.length}টি উপকরণ থেকে`,
      refType: 'bundle_assembly',
      refId: parent.id,
      userId: input.actor?.id ?? null,
      incomingCostMicro,
      force: true,
    });

    audit(db, {
      userId: input.actor?.id ?? null,
      username: input.actor?.username,
      action: 'bundle.assemble',
      entity: 'product',
      entityId: parent.id,
      details: { parent: parent.name, count, valuePaisa: totalValuePaisa },
    });
    return { parentQtyMilli: res.balanceAfterMilli, children };
  })();
}
