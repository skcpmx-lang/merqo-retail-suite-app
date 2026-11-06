import type { Db } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import { audit } from './audit.js';
import { computeSale, createSale, getSale, type SaleInput } from './sales.js';
import { getSettings } from './settings.js';
import { createSaleReturn, type ReturnItemInput } from './returns.js';

type Actor = { id: number; username: string };

/* ------------------------------------------------------------------ *
 * Hold / resume sales (park a cart while another customer is served)
 * ------------------------------------------------------------------ */

export interface HeldSaleRow {
  id: number;
  ref_no: string;
  customer_id: number | null;
  customer_name: string | null;
  lines_json: string;
  note: string | null;
  total_paisa: number;
  status: 'held' | 'resumed' | 'cancelled';
  user_id: number | null;
  username: string | null;
  created_at: string;
  resumed_at: string | null;
  item_count: number;
}

export interface HoldInput {
  customerId?: number | null;
  lines: { productId: number; unitId?: number | null; qtyMilli: number; unitPricePaisa?: number | null; discountPaisa?: number | null }[];
  note?: string | null;
  totalPaisa?: number;
  actor: Actor;
}

export function holdSale(db: Db, input: HoldInput): HeldSaleRow {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const lines = (input.lines ?? []).filter((l) => l && l.qtyMilli > 0);
    if (lines.length === 0) throw new Error('হোল্ড করার জন্য অন্তত একটি পণ্য দরকার।');
    const date = nowLocal();
    const refNo = `HOLD-${date.slice(2, 4)}${date.slice(5, 7)}-${String(
      Number(
        (
          db
            .prepare("SELECT COUNT(*) AS c FROM held_sales WHERE substr(created_at,1,7) = ?")
            .get(date.slice(0, 7)) as { c: number }
        ).c,
      ) + 1,
    ).padStart(4, '0')}`;
    const total = Math.round(input.totalPaisa ?? 0);
    const id = Number(
      db
        .prepare(
          `INSERT INTO held_sales (ref_no, customer_id, lines_json, note, total_paisa, status, user_id, created_at)
           VALUES (?,?,?,?,?, 'held', ?, ?)`,
        )
        .run(refNo, input.customerId ?? null, JSON.stringify(lines), input.note ?? null, total, input.actor.id, nowLocal())
        .lastInsertRowid,
    );
    audit(db, {
      userId: input.actor.id,
      username: input.actor.username,
      action: 'pos.hold',
      entity: 'held_sale',
      entityId: id,
      details: { refNo, lines: lines.length, total },
    });
    return getHeldSale(db, id)!;
  })();
}

export function getHeldSale(db: Db, id: number): HeldSaleRow | null {
  const row = db
    .prepare(
      `SELECT h.*, c.name AS customer_name, u.username,
              (SELECT COUNT(*) FROM json_each(h.lines_json)) AS item_count
         FROM held_sales h
         LEFT JOIN customers c ON c.id = h.customer_id
         LEFT JOIN users u ON u.id = h.user_id
        WHERE h.id = ?`,
    )
    .get(id) as HeldSaleRow | undefined;
  return row ?? null;
}

export function listHeldSales(db: Db, status: 'held' | 'resumed' | 'cancelled' | 'all' = 'held'): HeldSaleRow[] {
  const where = status === 'all' ? '' : 'WHERE h.status = ?';
  const params = status === 'all' ? [] : [status];
  return db
    .prepare(
      `SELECT h.*, c.name AS customer_name, u.username,
              (SELECT COUNT(*) FROM json_each(h.lines_json)) AS item_count
         FROM held_sales h
         LEFT JOIN customers c ON c.id = h.customer_id
         LEFT JOIN users u ON u.id = h.user_id
         ${where}
        ORDER BY h.created_at DESC, h.id DESC`,
    )
    .all(...params) as HeldSaleRow[];
}

/** Mark a held cart as resumed and hand the lines back to the POS screen. */
export function resumeHeldSale(db: Db, id: number, actor: Actor): HeldSaleRow {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const row = getHeldSale(db, id);
    if (!row) throw new Error('হোল্ড করা বিক্রয় পাওয়া যায়নি।');
    if (row.status !== 'held') throw new Error('এই বিক্রয় আর হোল্ড অবস্থায় নেই।');
    db.prepare("UPDATE held_sales SET status = 'resumed', resumed_at = ? WHERE id = ?").run(nowLocal(), id);
    audit(db, {
      userId: actor.id,
      username: actor.username,
      action: 'pos.resume',
      entity: 'held_sale',
      entityId: id,
      details: { refNo: row.ref_no },
    });
    return getHeldSale(db, id)!;
  })();
}

export function cancelHeldSale(db: Db, id: number, reason: string | null, actor: Actor): void {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const row = getHeldSale(db, id);
    if (!row) throw new Error('হোল্ড করা বিক্রয় পাওয়া যায়নি।');
    if (row.status === 'resumed') throw new Error('রিসিউম করা বিক্রয় বাতিল করা যাবে না।');
    if (!reason || !reason.trim()) throw new Error('বাতিলের কারণ লিখতে হবে।');
    db.prepare("UPDATE held_sales SET status = 'cancelled', note = ? WHERE id = ?").run(
      `${row.note ? `${row.note} — ` : ''}বাতিল: ${reason.trim()}`,
      id,
    );
    audit(db, {
      userId: actor.id,
      username: actor.username,
      action: 'pos.hold.cancel',
      entity: 'held_sale',
      entityId: id,
      details: { refNo: row.ref_no, reason },
    });
  })();
}

/* ------------------------------------------------------------------ *
 * POS favourites / quick-pick tiles
 * ------------------------------------------------------------------ */

const FAVOURITES_KEY = 'pos_favourites';

export function listFavourites(db: Db): number[] {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(FAVOURITES_KEY) as { value: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.map(Number).filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

export function toggleFavourite(db: Db, productId: number): { favourites: number[]; added: boolean } {
  const exists = db.prepare('SELECT 1 FROM products WHERE id = ?').get(productId);
  if (!exists) throw new Error('প্রোডাক্ট পাওয়া যায়নি।');
  const current = listFavourites(db);
  const added = !current.includes(productId);
  const next = added ? [productId, ...current].slice(0, 40) : current.filter((id) => id !== productId);
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(FAVOURITES_KEY, JSON.stringify(next));
  return { favourites: next, added };
}

/** Quick-pick tiles for the POS grid: favourites first, then best sellers. */
export function posQuickPicks(db: Db, limit = 24): any[] {
  const favourites = listFavourites(db);
  const topSellers = db
    .prepare(
      `SELECT si.product_id AS id, SUM(si.qty_base_milli) AS qty
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE s.status = 'completed'
        GROUP BY si.product_id ORDER BY qty DESC LIMIT 40`,
    )
    .all() as { id: number; qty: number }[];
  const ordered = [...favourites, ...topSellers.map((t) => t.id)];
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const id of ordered) {
    if (seen.has(id) || ids.length >= limit) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) {
    ids.push(
      ...(
        db.prepare('SELECT id FROM products WHERE is_active = 1 ORDER BY name_sort LIMIT ?').all(limit) as {
          id: number;
        }[]
      ).map((r) => r.id),
    );
  }
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.sale_price, p.stock_base_milli, p.sku,
              COALESCE(u.short_name, u2.short_name) AS unit_short
         FROM products p
         LEFT JOIN units u ON u.id = COALESCE(p.primary_unit_id, p.unit_id)
         LEFT JOIN units u2 ON u2.id = p.unit_id
        WHERE p.id IN (${placeholders}) AND p.is_active = 1`,
    )
    .all(...ids) as any[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean).map((r) => ({ ...r, is_favourite: favourites.includes(r.id) }));
}

/* ------------------------------------------------------------------ *
 * Credit note (return settled as store credit instead of cash)
 * ------------------------------------------------------------------ */

export function createCreditNote(
  db: Db,
  input: { saleId: number; items: ReturnItemInput[]; note?: string | null; actor: Actor },
): { returnId: number; returnNo: string; total: number; creditPaisa: number } {
  const sale = getSale(db, input.saleId);
  if (!sale) throw new Error('ইনভয়েস পাওয়া যায়নি।');
  if (!sale.customer_id) {
    throw new Error('ক্রেডিট নোটের জন্য ইনভয়েসে কাস্টমার থাকতে হবে।');
  }
  const res = createSaleReturn(db, {
    saleId: input.saleId,
    items: input.items,
    refundPaisa: 0,
    refundMethodId: null,
    note: `${input.note ?? ''}${input.note ? ' — ' : ''}ক্রেডিট নোট`,
    actor: input.actor,
  });
  // createSaleReturn already reduced the customer's balance by the returned
  // value; with no cash refund that value stays as store credit (a negative
  // balance is an advance the shop owes the customer).
  audit(db, {
    userId: input.actor.id,
    username: input.actor.username,
    action: 'pos.credit_note',
    entity: 'return',
    entityId: res.returnId,
    details: { returnNo: res.returnNo, total: res.total, customerId: sale.customer_id },
  });
  return { returnId: res.returnId, returnNo: res.returnNo, total: res.total, creditPaisa: res.total };
}

/* ------------------------------------------------------------------ *
 * Exchange (return items + buy replacements in one step)
 * ------------------------------------------------------------------ */

/**
 * Exchange = a return plus a fresh sale.
 *
 * With a customer on the invoice the returned value becomes store credit that
 * automatically offsets the new bill; without one the drawer handles both
 * sides in cash (the customer gets the returned value back and pays for the
 * replacement), which keeps the till report exact either way.
 */
export function createExchange(
  db: Db,
  input: {
    saleId: number;
    returnItems: ReturnItemInput[];
    newLines: SaleInput['lines'];
    methodId?: number | null;
    customerId?: number | null;
    note?: string | null;
    actor: Actor;
  },
): {
  returnId: number;
  returnNo: string;
  saleId: number;
  invoiceNo: string;
  returnedTotal: number;
  newTotal: number;
  /** What the customer actually owes on top of the returned value. */
  differencePaisa: number;
  customerId: number | null;
} {
  const sale = getSale(db, input.saleId);
  if (!sale) throw new Error('মূল ইনভয়েস পাওয়া যায়নি।');
  if (!input.returnItems?.length) throw new Error('ফেরত দেওয়ার পণ্য নির্বাচন করুন।');
  if (!input.newLines?.length) throw new Error('নতুন পণ্য নির্বাচন করুন।');
  const customerId = input.customerId ?? sale.customer_id ?? null;
  if (!customerId && !input.methodId) {
    throw new Error('এক্সচেঞ্জের জন্য কাস্টমার অথবা পেমেন্ট মেথড নির্বাচন করুন।');
  }

  const settings = getSettings(db);
  // Pre-compute the replacement bill so a walk-in exchange can pay it in full.
  const preview = computeSale(db, { lines: input.newLines, customerId, actor: input.actor } as any, settings);

  return db.transaction(() => {
    const ret = createSaleReturn(db, {
      saleId: input.saleId,
      items: input.returnItems,
      // With a customer the value stays as store credit; without one the money
      // leaves the drawer (default refund = the full returned value).
      refundPaisa: customerId ? 0 : undefined,
      refundMethodId: customerId ? null : input.methodId ?? null,
      note: input.note ? `এক্সচেঞ্জ — ${input.note}` : 'এক্সচেঞ্জ',
      actor: input.actor,
    });
    // The invoice being exchanged may belong to a walk-in; when the cashier
    // names a customer, the credit must land on that customer's account.
    if (customerId && !sale.customer_id && ret.total > 0) {
      db.prepare('UPDATE customers SET balance_paisa = balance_paisa - ?, updated_at = ? WHERE id = ?').run(
        ret.total,
        nowLocal(),
        customerId,
      );
    }
    const sold = createSale(db, {
      customerId,
      lines: input.newLines,
      // A walk-in pays the full new bill in cash; a registered customer's bill
      // is settled first by the credit created above.
      payments:
        customerId || !input.methodId ? [] : [{ methodId: input.methodId, amount: preview.total }],
      defaultMethodId: input.methodId ?? null,
      note: input.note ? `এক্সচেঞ্জ (${ret.returnNo}) — ${input.note}` : `এক্সচেঞ্জ (${ret.returnNo})`,
      actor: input.actor,
    });
    const difference = Math.max(0, sold.computation.total - ret.total);
    audit(db, {
      userId: input.actor.id,
      username: input.actor.username,
      action: 'pos.exchange',
      entity: 'sale',
      entityId: sold.saleId,
      details: {
        returnNo: ret.returnNo,
        invoiceNo: sold.invoiceNo,
        returned: ret.total,
        newTotal: sold.computation.total,
        customerId,
      },
    });
    return {
      returnId: ret.returnId,
      returnNo: ret.returnNo,
      saleId: sold.saleId,
      invoiceNo: sold.invoiceNo,
      returnedTotal: ret.total,
      newTotal: sold.computation.total,
      differencePaisa: difference,
      customerId,
    };
  })();
}
