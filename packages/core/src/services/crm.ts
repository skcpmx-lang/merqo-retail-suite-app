import type { Db } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import type { PriceLevel } from './products.js';
import { audit } from './audit.js';
import { getSettings } from './settings.js';

type Actor = { id: number; username: string } | null | undefined;

/* ------------------------------------------------------------------ *
 * Credit limit
 * ------------------------------------------------------------------ */

export interface CreditCheck {
  ok: boolean;
  limitPaisa: number;
  currentDuePaisa: number;
  addingPaisa: number;
  remainingPaisa: number;
  message: string | null;
}

/**
 * A customer's credit limit is stored in paisa; 0 means "no limit set".
 * Enforcement is a setting because many small shops deliberately sell over the
 * informal limit and only want a warning.
 */
export function creditCheck(db: Db, customerId: number, addingPaisa: number): CreditCheck {
  const row = db
    .prepare('SELECT name, balance_paisa, credit_limit_paisa FROM customers WHERE id = ?')
    .get(customerId) as { name: string; balance_paisa: number; credit_limit_paisa: number } | undefined;
  if (!row) throw new Error('কাস্টমার পাওয়া যায়নি।');
  const limitPaisa = Math.max(0, row.credit_limit_paisa ?? 0);
  const currentDuePaisa = Math.max(0, row.balance_paisa ?? 0);
  const adding = Math.max(0, Math.round(addingPaisa));
  if (limitPaisa === 0) {
    return { ok: true, limitPaisa, currentDuePaisa, addingPaisa: adding, remainingPaisa: Number.POSITIVE_INFINITY, message: null };
  }
  const projected = currentDuePaisa + adding;
  const remaining = limitPaisa - currentDuePaisa;
  if (projected > limitPaisa) {
    return {
      ok: false,
      limitPaisa,
      currentDuePaisa,
      addingPaisa: adding,
      remainingPaisa: remaining,
      message: `${row.name} এর বাকির সীমা ${(limitPaisa / 100).toFixed(2)} টাকা; এখন বাকি ${(currentDuePaisa / 100).toFixed(2)} টাকা — আরও ${(Math.max(0, remaining) / 100).toFixed(2)} টাকার বেশি বাকি দেওয়া যাবে না।`,
    };
  }
  return { ok: true, limitPaisa, currentDuePaisa, addingPaisa: adding, remainingPaisa: remaining, message: null };
}

/** Throws when the limit would be exceeded and enforcement is switched on. */
export function assertCreditLimit(db: Db, customerId: number, addingPaisa: number): void {
  const settings = getSettings(db);
  if (settings.credit_limit_enforced !== 1) return;
  const check = creditCheck(db, customerId, addingPaisa);
  if (!check.ok) throw new Error(check.message ?? 'বাকির সীমা ছাড়িয়ে যাচ্ছে।');
}

export function setCreditLimit(db: Db, customerId: number, limitPaisa: number, actor?: Actor): void {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const row = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId) as { name: string } | undefined;
    if (!row) throw new Error('কাস্টমার পাওয়া যায়নি।');
    const limit = Math.max(0, Math.round(limitPaisa));
    db.prepare('UPDATE customers SET credit_limit_paisa = ?, updated_at = ? WHERE id = ?').run(limit, nowLocal(), customerId);
    audit(db, {
      userId: actor?.id ?? null,
      username: actor?.username,
      action: 'customer.credit_limit',
      entity: 'customer',
      entityId: customerId,
      details: { name: row.name, limitPaisa: limit },
    });
  })();
}

/* ------------------------------------------------------------------ *
 * Loyalty points
 * ------------------------------------------------------------------ */

export interface LoyaltySummary {
  enabled: boolean;
  points: number;
  valuePaisa: number;
  minRedeemPoints: number;
  pointsPer100: number;
  redeemValuePaisa: number;
}

export function loyaltySummary(db: Db, customerId: number): LoyaltySummary {
  const settings = getSettings(db);
  const row = db.prepare('SELECT loyalty_points FROM customers WHERE id = ?').get(customerId) as
    | { loyalty_points: number }
    | undefined;
  if (!row) throw new Error('কাস্টমার পাওয়া যায়নি।');
  const points = Number(row.loyalty_points ?? 0);
  return {
    enabled: settings.loyalty_enabled === 1,
    points,
    valuePaisa: points * (settings.loyalty_redeem_value_paisa ?? 0),
    minRedeemPoints: settings.loyalty_min_redeem_points ?? 0,
    pointsPer100: settings.loyalty_points_per_100 ?? 0,
    redeemValuePaisa: settings.loyalty_redeem_value_paisa ?? 0,
  };
}

function writeLedger(
  db: Db,
  customerId: number,
  points: number,
  type: 'earn' | 'redeem' | 'reverse' | 'expire' | 'adjust',
  refType: string | null,
  refId: number | null,
  note: string | null,
  userId: number | null,
): void {
  db.prepare(
    `INSERT INTO loyalty_ledger (customer_id, points, type, ref_type, ref_id, note, user_id, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(customerId, points, type, refType, refId, note, userId, nowLocal());
  db.prepare('UPDATE customers SET loyalty_points = loyalty_points + ?, updated_at = ? WHERE id = ?').run(
    points,
    nowLocal(),
    customerId,
  );
}

/** Points earned = floor(total ÷ 100 taka) × pointsPer100 (never on due-paid value). */
export function earnLoyaltyForSale(db: Db, saleId: number, actor?: Actor): number {
  const settings = getSettings(db);
  if (settings.loyalty_enabled !== 1) return 0;
  const sale = db
    .prepare('SELECT id, customer_id, total_paisa, status FROM sales WHERE id = ?')
    .get(saleId) as { id: number; customer_id: number | null; total_paisa: number; status: string } | undefined;
  if (!sale || !sale.customer_id || sale.status !== 'completed') return 0;
  const customer = db.prepare('SELECT is_walkin FROM customers WHERE id = ?').get(sale.customer_id) as
    | { is_walkin: number }
    | undefined;
  if (customer?.is_walkin) return 0;
  const per100 = settings.loyalty_points_per_100 ?? 0;
  if (per100 <= 0) return 0;
  const already = db
    .prepare("SELECT COALESCE(SUM(points),0) AS v FROM loyalty_ledger WHERE ref_type = 'sale' AND ref_id = ? AND type = 'earn'")
    .get(saleId) as { v: number };
  if (Number(already.v) > 0) return 0; // idempotent
  const points = Math.floor(sale.total_paisa / 10_000) * per100;
  if (points <= 0) return 0;
  writeLedger(db, sale.customer_id, points, 'earn', 'sale', saleId, 'বিক্রয়ে পয়েন্ট', actor?.id ?? null);
  return points;
}

export function redeemLoyalty(
  db: Db,
  input: { customerId: number; points: number; saleId?: number | null; actor?: Actor },
): { points: number; valuePaisa: number } {
  const settings = getSettings(db);
  if (settings.loyalty_enabled !== 1) throw new Error('লয়্যালটি সুবিধা চালু নেই (সেটিংস দেখুন)।');
  const points = Math.round(input.points);
  if (!Number.isFinite(points) || points <= 0) throw new Error('রিডিম করার পয়েন্ট সঠিক নয়।');
  const summary = loyaltySummary(db, input.customerId);
  if (points < summary.minRedeemPoints) {
    throw new Error(`সর্বনিম্ন ${summary.minRedeemPoints} পয়েন্ট একসাথে রিডিম করা যায়।`);
  }
  if (points > summary.points) {
    throw new Error(`এই কাস্টমারের আছে মাত্র ${summary.points} পয়েন্ট।`);
  }
  writeLedger(db, input.customerId, -points, 'redeem', input.saleId ? 'sale' : 'manual', input.saleId ?? null, 'পয়েন্ট রিডিম', input.actor?.id ?? null);
  audit(db, {
    userId: input.actor?.id ?? null,
    username: input.actor?.username,
    action: 'loyalty.redeem',
    entity: 'customer',
    entityId: input.customerId,
    details: { points, valuePaisa: points * summary.redeemValuePaisa, saleId: input.saleId ?? null },
  });
  return { points, valuePaisa: points * summary.redeemValuePaisa };
}

/**
 * Undo the *whole* loyalty effect of a document (void / full return).
 *
 * A sale can both earn points and spend them (a redemption is written against
 * the same sale). Reversing only the "earn" rows would silently burn the points
 * the customer paid with, so this reverses the net of every sales-linked row:
 * earned points are taken back and redeemed points are handed back, leaving the
 * customer exactly where they were before the invoice.
 */
export function reverseLoyaltyForSale(db: Db, saleId: number, reason: string, actor?: Actor): number {
  const sale = db.prepare('SELECT customer_id FROM sales WHERE id = ?').get(saleId) as
    | { customer_id: number | null }
    | undefined;
  if (!sale?.customer_id) return 0;
  const net = Number(
    (
      db
        .prepare("SELECT COALESCE(SUM(points),0) AS v FROM loyalty_ledger WHERE ref_type = 'sale' AND ref_id = ?")
        .get(saleId) as { v: number }
    ).v,
  );
  if (net === 0) return 0;
  writeLedger(db, sale.customer_id, -net, 'reverse', 'sale', saleId, reason, actor?.id ?? null);
  return net;
}

/** Expire stale points: points earned more than `days` ago that are still held. */
export function expireLoyaltyPoints(db: Db, days = 365, actor?: Actor): { customers: number; points: number } {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT customer_id, SUM(points) AS net FROM loyalty_ledger
        WHERE created_at < ? GROUP BY customer_id HAVING net > 0`,
    )
    .all(cutoff) as { customer_id: number; net: number }[];
  let total = 0;
  for (const r of rows) {
    writeLedger(db, r.customer_id, -Number(r.net), 'expire', null, null, `${days} দিনের পুরোনো পয়েন্ট মেয়াদোত্তীর্ণ`, actor?.id ?? null);
    total += Number(r.net);
  }
  if (rows.length) {
    audit(db, {
      userId: actor?.id ?? null,
      username: actor?.username,
      action: 'loyalty.expire',
      entity: 'customer',
      details: { customers: rows.length, points: total, days },
    });
  }
  return { customers: rows.length, points: total };
}

export function loyaltyHistory(db: Db, customerId: number, limit = 200): any[] {
  return db
    .prepare(
      `SELECT l.*, u.username FROM loyalty_ledger l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.customer_id = ? ORDER BY l.created_at DESC, l.id DESC LIMIT ?`,
    )
    .all(customerId, limit) as any[];
}

/** Manual adjustment (goodwill, correction) — always audited with a reason. */
export function adjustLoyaltyPoints(
  db: Db,
  input: { customerId: number; points: number; reason: string; actor?: Actor },
): void {
  const points = Math.round(input.points);
  if (!Number.isFinite(points) || points === 0) throw new Error('পয়েন্ট সংখ্যা শূন্য হতে পারবে না।');
  if (!input.reason?.trim()) throw new Error('সমন্বয়ের কারণ লিখতে হবে।');
  const summary = loyaltySummary(db, input.customerId);
  if (summary.points + points < 0) throw new Error('কাস্টমারের পয়েন্ট শূন্যের নিচে যেতে পারবে না।');
  writeLedger(db, input.customerId, points, 'adjust', null, null, input.reason.trim(), input.actor?.id ?? null);
  audit(db, {
    userId: input.actor?.id ?? null,
    username: input.actor?.username,
    action: 'loyalty.adjust',
    entity: 'customer',
    entityId: input.customerId,
    details: { points, reason: input.reason.trim() },
  });
}

/* ------------------------------------------------------------------ *
 * Customer groups & price levels
 * ------------------------------------------------------------------ */

export const CUSTOMER_PRICE_LEVELS: PriceLevel[] = ['retail', 'wholesale', 'special'];

export function listCustomerGroups(db: Db): { group_name: string; customers: number; due_paisa: number; points: number }[] {
  return db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(group_name),''),'সাধারণ') AS group_name,
              COUNT(*) AS customers,
              COALESCE(SUM(CASE WHEN balance_paisa > 0 THEN balance_paisa ELSE 0 END),0) AS due_paisa,
              COALESCE(SUM(loyalty_points),0) AS points
         FROM customers WHERE is_active = 1 AND is_walkin = 0
        GROUP BY group_name ORDER BY due_paisa DESC`,
    )
    .all() as { group_name: string; customers: number; due_paisa: number; points: number }[];
}

export function assignCustomerGroup(db: Db, customerId: number, groupName: string | null, actor?: Actor): void {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const row = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId) as { name: string } | undefined;
    if (!row) throw new Error('কাস্টমার পাওয়া যায়নি।');
    const value = groupName?.trim() ? groupName.trim() : null;
    db.prepare('UPDATE customers SET group_name = ?, updated_at = ? WHERE id = ?').run(value, nowLocal(), customerId);
    audit(db, {
      userId: actor?.id ?? null,
      username: actor?.username,
      action: 'customer.group',
      entity: 'customer',
      entityId: customerId,
      details: { name: row.name, group: value },
    });
  })();
}

export function setCustomerPriceLevel(db: Db, customerId: number, level: PriceLevel, actor?: Actor): void {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    if (!CUSTOMER_PRICE_LEVELS.includes(level)) throw new Error('দামের স্তর সঠিক নয়।');
    const row = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId) as { name: string } | undefined;
    if (!row) throw new Error('কাস্টমার পাওয়া যায়নি।');
    db.prepare('UPDATE customers SET price_level = ?, updated_at = ? WHERE id = ?').run(level, nowLocal(), customerId);
    audit(db, {
      userId: actor?.id ?? null,
      username: actor?.username,
      action: 'customer.price_level',
      entity: 'customer',
      entityId: customerId,
      details: { name: row.name, level },
    });
  })();
}

/** The price level a sale should default to for this customer. */
export function customerPriceLevel(db: Db, customerId: number | null | undefined): PriceLevel {
  if (!customerId) return 'retail';
  const row = db.prepare('SELECT price_level FROM customers WHERE id = ?').get(customerId) as
    | { price_level: string | null }
    | undefined;
  const level = (row?.price_level ?? 'retail') as PriceLevel;
  return CUSTOMER_PRICE_LEVELS.includes(level) ? level : 'retail';
}

/* ------------------------------------------------------------------ *
 * Customer import / export (CSV)
 * ------------------------------------------------------------------ */

function csvEscape(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function customersToCsv(db: Db): string {
  const rows = db
    .prepare(
      `SELECT name, phone, address, group_name, credit_limit_paisa, balance_paisa, loyalty_points, note
         FROM customers WHERE is_walkin = 0 ORDER BY name_sort`,
    )
    .all() as any[];
  const header = 'name,phone,address,group,credit_limit_taka,balance_taka,loyalty_points,note';
  const lines = rows.map((r) =>
    [
      csvEscape(r.name),
      csvEscape(r.phone),
      csvEscape(r.address),
      csvEscape(r.group_name),
      csvEscape((Number(r.credit_limit_paisa) / 100).toFixed(2)),
      csvEscape((Number(r.balance_paisa) / 100).toFixed(2)),
      csvEscape(r.loyalty_points),
      csvEscape(r.note),
    ].join(','),
  );
  return [header, ...lines].join('\n');
}

export interface CustomerImportResult {
  created: number;
  updated: number;
  skipped: { line: number; reason: string }[];
}

/**
 * Import customers from CSV text. The header row may use either Bengali or the
 * English keys produced by `customersToCsv`. Rows are matched on phone number,
 * so re-importing the same file updates instead of duplicating.
 */
export function importCustomersCsv(db: Db, csv: string, actor?: Actor): CustomerImportResult {
  const lines = csv.replace(/\r/g, '').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { created: 0, updated: 0, skipped: [{ line: 1, reason: 'ফাইলে কোনো ডেটা নেই' }] };
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = !quoted;
      } else if (ch === ',' && !quoted) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out.map((c) => c.trim());
  };
  const header = split(lines[0]!).map((h) => h.toLowerCase());
  const col = (names: string[]): number => header.findIndex((h) => names.includes(h));
  const nameIdx = col(['name', 'নাম']);
  if (nameIdx < 0) throw new Error('CSV-তে নাম (name) কলাম নেই।');
  const phoneIdx = col(['phone', 'মোবাইল', 'ফোন']);
  const addressIdx = col(['address', 'ঠিকানা']);
  const groupIdx = col(['group', 'গ্রুপ']);
  const limitIdx = col(['credit_limit_taka', 'credit_limit', 'বাকির_সীমা']);
  const noteIdx = col(['note', 'নোট']);

  const result: CustomerImportResult = { created: 0, updated: 0, skipped: [] };
  db.transaction(() => {
    for (let i = 1; i < lines.length; i++) {
      const cells = split(lines[i]!);
      const name = cells[nameIdx] ?? '';
      if (!name) {
        result.skipped.push({ line: i + 1, reason: 'নাম নেই' });
        continue;
      }
      const phone = phoneIdx >= 0 ? cells[phoneIdx] || null : null;
      const limit = limitIdx >= 0 ? Math.round(Number(cells[limitIdx] || 0) * 100) : 0;
      try {
        const existing = phone
          ? (db.prepare('SELECT id FROM customers WHERE phone = ?').get(phone) as { id: number } | undefined)
          : undefined;
        if (existing) {
          db.prepare(
            `UPDATE customers SET name = ?, name_sort = ?, search_text = ?, address = COALESCE(?, address),
               group_name = COALESCE(?, group_name), credit_limit_paisa = ?, note = COALESCE(?, note), updated_at = ?
             WHERE id = ?`,
          ).run(
            name,
            name,
            `${name} ${phone ?? ''}`,
            addressIdx >= 0 ? cells[addressIdx] || null : null,
            groupIdx >= 0 ? cells[groupIdx] || null : null,
            Number.isFinite(limit) ? limit : 0,
            noteIdx >= 0 ? cells[noteIdx] || null : null,
            nowLocal(),
            existing.id,
          );
          result.updated++;
        } else {
          db.prepare(
            `INSERT INTO customers (name, name_sort, search_text, phone, address, group_name, credit_limit_paisa,
               opening_balance_paisa, balance_paisa, is_walkin, note, is_active, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,0,0,0,?,1,?,?)`,
          ).run(
            name,
            name,
            `${name} ${phone ?? ''}`,
            phone,
            addressIdx >= 0 ? cells[addressIdx] || null : null,
            groupIdx >= 0 ? cells[groupIdx] || null : null,
            Number.isFinite(limit) ? limit : 0,
            noteIdx >= 0 ? cells[noteIdx] || null : null,
            nowLocal(),
            nowLocal(),
          );
          result.created++;
        }
      } catch (err) {
        result.skipped.push({ line: i + 1, reason: (err as Error).message });
      }
    }
    audit(db, {
      userId: actor?.id ?? null,
      username: actor?.username,
      action: 'customer.import',
      entity: 'customer',
      details: { created: result.created, updated: result.updated, skipped: result.skipped.length },
    });
  })();
  return result;
}
