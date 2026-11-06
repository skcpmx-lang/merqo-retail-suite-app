import crypto from 'node:crypto';
import type { Db } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import { normalizeText } from '../domain/text.js';
import { ACCOUNT_CODES, accountIdByCode, isPostingEnabled, postEntry } from './accounting.js';
import { audit } from './audit.js';
import { getSettings } from './settings.js';
import { GIFT_CARD_METHOD_NAME } from '../db/migration-v3.js';

type Actor = { id: number; username: string };


/* ------------------------------------------------------------------ */
/* Coupons — percentage / fixed discount codes                        */
/* ------------------------------------------------------------------ */

export interface Coupon {
  id: number;
  code: string;
  label: string | null;
  kind: 'percent' | 'fixed';
  /** percent: basis points (10% = 1000) · fixed: poisa */
  value: number;
  min_purchase_paisa: number;
  max_discount_paisa: number;
  starts_at: string | null;
  expires_at: string | null;
  usage_limit: number;
  used_count: number;
  per_customer_limit: number;
  is_active: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface CouponInput {
  code: string;
  label?: string | null;
  kind: 'percent' | 'fixed';
  value: number;
  minPurchasePaisa?: number;
  maxDiscountPaisa?: number;
  startsAt?: string | null;
  expiresAt?: string | null;
  usageLimit?: number;
  perCustomerLimit?: number;
  note?: string | null;
}

export function normalizeCode(code: string): string {
  return String(code ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function assertPercent(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 10_000) {
    throw new Error('শতকরা ছাড় ০ থেকে ১০০%-এর মধ্যে হতে হবে।');
  }
}

export function createCoupon(db: Db, input: CouponInput, actor?: Actor | null): Coupon {
  const code = normalizeCode(input.code);
  if (code.length < 3) throw new Error('কুপন কোড অন্তত ৩ অক্ষরের হতে হবে।');
  if (!/^[A-Z0-9_-]+$/.test(code)) throw new Error('কুপন কোডে শুধু ইংরেজি অক্ষর, সংখ্যা, - এবং _ চলবে।');
  const value = Math.round(input.value);
  if (input.kind === 'percent') assertPercent(value);
  else if (value <= 0) throw new Error('নির্দিষ্ট ছাড়ের পরিমাণ শূন্যের বেশি হতে হবে।');
  if (db.prepare('SELECT id FROM coupons WHERE code = ?').get(code)) {
    throw new Error(`"${code}" কোডটি আগেই ব্যবহার হয়েছে।`);
  }
  const now = nowLocal();
  const res = db
    .prepare(
      `INSERT INTO coupons (code, label, kind, value, min_purchase_paisa, max_discount_paisa, starts_at, expires_at,
         usage_limit, used_count, per_customer_limit, is_active, note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,0,?,1,?,?,?)`,
    )
    .run(
      code,
      input.label ?? null,
      input.kind,
      value,
      Math.max(0, Math.round(input.minPurchasePaisa ?? 0)),
      Math.max(0, Math.round(input.maxDiscountPaisa ?? 0)),
      input.startsAt ?? null,
      input.expiresAt ?? null,
      Math.max(0, Math.round(input.usageLimit ?? 0)),
      Math.max(0, Math.round(input.perCustomerLimit ?? 0)),
      input.note ?? null,
      now,
      now,
    );
  const coupon = getCoupon(db, Number(res.lastInsertRowid))!;
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username ?? null,
    action: 'coupon.create',
    entity: 'coupon',
    entityId: coupon.id,
    details: { code, kind: coupon.kind, value: coupon.value },
  });
  return coupon;
}

export function getCoupon(db: Db, id: number): Coupon | null {
  return (db.prepare('SELECT * FROM coupons WHERE id = ?').get(id) as Coupon | undefined) ?? null;
}

export function getCouponByCode(db: Db, code: string): Coupon | null {
  return (db.prepare('SELECT * FROM coupons WHERE code = ?').get(normalizeCode(code)) as Coupon | undefined) ?? null;
}

export function listCoupons(
  db: Db,
  filter: { q?: string; activeOnly?: boolean; limit?: number } = {},
): { rows: (Coupon & { redemptions: number; discount_total_paisa: number })[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.q) {
    where.push('(code LIKE ? OR label LIKE ?)');
    const like = `%${normalizeText(filter.q)}%`;
    params.push(like, like);
  }
  if (filter.activeOnly) where.push('is_active = 1');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM coupons ${clause}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM coupon_redemptions r WHERE r.coupon_id = c.id) AS redemptions,
              (SELECT COALESCE(SUM(r.discount_paisa),0) FROM coupon_redemptions r WHERE r.coupon_id = c.id) AS discount_total_paisa
         FROM coupons c ${clause}
        ORDER BY c.is_active DESC, c.created_at DESC
        LIMIT ?`,
    )
    .all(...params, filter.limit ?? 200) as any[];
  return { rows, total };
}

export function updateCoupon(db: Db, id: number, patch: Partial<CouponInput> & { isActive?: boolean }, actor?: Actor | null): Coupon {
  const current = getCoupon(db, id);
  if (!current) throw new Error('কুপন পাওয়া যায়নি।');
  const kind = patch.kind ?? current.kind;
  const value = patch.value != null ? Math.round(patch.value) : current.value;
  if (kind === 'percent') assertPercent(value);
  else if (value <= 0) throw new Error('নির্দিষ্ট ছাড়ের পরিমাণ শূন্যের বেশি হতে হবে।');
  db.prepare(
    `UPDATE coupons SET kind=?, value=?, label=?, min_purchase_paisa=?, max_discount_paisa=?, starts_at=?, expires_at=?,
       usage_limit=?, per_customer_limit=?, is_active=?, note=?, updated_at=? WHERE id=?`,
  ).run(
    kind,
    value,
    patch.label !== undefined ? patch.label : current.label,
    patch.minPurchasePaisa != null ? Math.max(0, Math.round(patch.minPurchasePaisa)) : current.min_purchase_paisa,
    patch.maxDiscountPaisa != null ? Math.max(0, Math.round(patch.maxDiscountPaisa)) : current.max_discount_paisa,
    patch.startsAt !== undefined ? patch.startsAt : current.starts_at,
    patch.expiresAt !== undefined ? patch.expiresAt : current.expires_at,
    patch.usageLimit != null ? Math.max(0, Math.round(patch.usageLimit)) : current.usage_limit,
    patch.perCustomerLimit != null ? Math.max(0, Math.round(patch.perCustomerLimit)) : current.per_customer_limit,
    patch.isActive === undefined ? current.is_active : patch.isActive ? 1 : 0,
    patch.note !== undefined ? patch.note : current.note,
    nowLocal(),
    id,
  );
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username ?? null,
    action: 'coupon.update',
    entity: 'coupon',
    entityId: id,
    details: { before: { kind: current.kind, value: current.value }, after: { kind, value } },
  });
  return getCoupon(db, id)!;
}

export function couponRedemptions(db: Db, couponId: number) {
  return db
    .prepare(
      `SELECT r.*, s.invoice_no, c.name AS customer_name
         FROM coupon_redemptions r
         JOIN sales s ON s.id = r.sale_id
         LEFT JOIN customers c ON c.id = r.customer_id
        WHERE r.coupon_id = ?
        ORDER BY r.id DESC`,
    )
    .all(couponId) as any[];
}

export interface CouponCheck {
  ok: boolean;
  coupon: Coupon | null;
  discountPaisa: number;
  reason: string | null;
}

/**
 * Validate a coupon against a basket and work out the discount. Never throws so
 * the POS can show a friendly inline message while typing the code.
 */
export function checkCoupon(
  db: Db,
  args: { code: string; subtotalPaisa: number; customerId?: number | null; at?: string },
): CouponCheck {
  const code = normalizeCode(args.code);
  if (!code) return { ok: false, coupon: null, discountPaisa: 0, reason: 'কুপন কোড লিখুন।' };
  const coupon = getCouponByCode(db, code);
  if (!coupon) return { ok: false, coupon: null, discountPaisa: 0, reason: 'এই কোডের কোনো কুপন নেই।' };
  if (!coupon.is_active) return { ok: false, coupon, discountPaisa: 0, reason: 'কুপনটি নিষ্ক্রিয় করা হয়েছে।' };
  const at = args.at ?? nowLocal();
  if (coupon.starts_at && at < coupon.starts_at) {
    return { ok: false, coupon, discountPaisa: 0, reason: 'কুপনের সময় এখনো শুরু হয়নি।' };
  }
  if (coupon.expires_at && at > coupon.expires_at) {
    return { ok: false, coupon, discountPaisa: 0, reason: 'কুপনের মেয়াদ শেষ হয়েছে।' };
  }
  if (coupon.usage_limit > 0 && coupon.used_count >= coupon.usage_limit) {
    return { ok: false, coupon, discountPaisa: 0, reason: 'কুপনের ব্যবহারের সীমা শেষ।' };
  }
  if (coupon.min_purchase_paisa > 0 && args.subtotalPaisa < coupon.min_purchase_paisa) {
    return {
      ok: false,
      coupon,
      discountPaisa: 0,
      reason: `কমপক্ষে ${(coupon.min_purchase_paisa / 100).toFixed(0)} টাকার কেনাকাটা লাগবে।`,
    };
  }
  if (coupon.per_customer_limit > 0) {
    if (!args.customerId) {
      return { ok: false, coupon, discountPaisa: 0, reason: 'এই কুপন কাস্টমার নির্বাচন করলেই ব্যবহার করা যাবে।' };
    }
    const used = (
      db
        .prepare('SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ? AND customer_id = ?')
        .get(coupon.id, args.customerId) as { n: number }
    ).n;
    if (used >= coupon.per_customer_limit) {
      return { ok: false, coupon, discountPaisa: 0, reason: 'এই কাস্টমার কুপনটি সর্বোচ্চ বার ব্যবহার করেছেন।' };
    }
  }
  let discount =
    coupon.kind === 'percent' ? Math.floor((args.subtotalPaisa * coupon.value) / 10_000) : Math.round(coupon.value);
  if (coupon.max_discount_paisa > 0) discount = Math.min(discount, coupon.max_discount_paisa);
  discount = Math.max(0, Math.min(discount, args.subtotalPaisa));
  if (discount <= 0) return { ok: false, coupon, discountPaisa: 0, reason: 'এই বাস্কেটে কুপনের ছাড় শূন্য দাঁড়াচ্ছে।' };
  return { ok: true, coupon, discountPaisa: discount, reason: null };
}

/** Records a redemption. Called inside the sale transaction only. */
export function recordCouponRedemption(
  db: Db,
  args: { couponId: number; saleId: number; customerId: number | null; code: string; discountPaisa: number; userId: number | null },
): void {
  const res = db
    .prepare(
      'UPDATE coupons SET used_count = used_count + 1, updated_at = ? WHERE id = ? AND (usage_limit = 0 OR used_count < usage_limit)',
    )
    .run(nowLocal(), args.couponId);
  if (res.changes !== 1) throw new Error('কুপনের ব্যবহারের সীমা এইমাত্র শেষ হয়েছে।');
  db.prepare(
    'INSERT INTO coupon_redemptions (coupon_id, sale_id, customer_id, code, discount_paisa, user_id, created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(args.couponId, args.saleId, args.customerId, args.code, args.discountPaisa, args.userId, nowLocal());
}

/**
 * Reverses the coupon a sale consumed.
 *
 * v1.1.3 fix: voiding an invoice used to leave `coupons.used_count` incremented
 * and the `coupon_redemptions` row in place, so a cancelled sale permanently burnt
 * one use of a limited coupon (and one use of a customer's allowance). The
 * redemption row is removed and the counter is decremented exactly once — the
 * `UNIQUE (sale_id)` row is the idempotency guard, so a repeated void is a no-op.
 */
export function restoreCouponsForSale(
  db: Db,
  args: { saleId: number; userId?: number | null; note?: string | null },
): { restored: boolean; code: string | null; discountPaisa: number } {
  const row = db
    .prepare('SELECT id, coupon_id, code, discount_paisa FROM coupon_redemptions WHERE sale_id = ?')
    .get(args.saleId) as { id: number; coupon_id: number; code: string; discount_paisa: number } | undefined;
  if (!row) return { restored: false, code: null, discountPaisa: 0 };

  db.prepare('DELETE FROM coupon_redemptions WHERE id = ?').run(row.id);
  db.prepare('UPDATE coupons SET used_count = MAX(used_count - 1, 0), updated_at = ? WHERE id = ?').run(
    nowLocal(),
    row.coupon_id,
  );
  return { restored: true, code: row.code, discountPaisa: row.discount_paisa };
}

/* ------------------------------------------------------------------ */
/* Stored value — gift cards and vouchers                             */
/* ------------------------------------------------------------------ */

export type GiftCardKind = 'gift_card' | 'voucher';
export type GiftCardStatus = 'active' | 'used' | 'expired' | 'void';

export interface GiftCard {
  id: number;
  code: string;
  kind: GiftCardKind;
  initial_paisa: number;
  balance_paisa: number;
  customer_id: number | null;
  issued_at: string;
  expires_at: string | null;
  status: GiftCardStatus;
  note: string | null;
  created_at: string;
  updated_at: string;
}

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomCode(prefix: string): string {
  const chars: string[] = [];
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) chars.push(CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]!);
  return `${prefix}-${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
}

export function giftCardMethodId(db: Db): number | null {
  const row = db.prepare('SELECT id FROM payment_methods WHERE name = ?').get(GIFT_CARD_METHOD_NAME) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

export function giftCardLiabilityAccountId(db: Db): number {
  return accountIdByCode(db, ACCOUNT_CODES.giftCard);
}

export function getGiftCardByCode(db: Db, code: string): GiftCard | null {
  return (db.prepare('SELECT * FROM gift_cards WHERE code = ?').get(normalizeCode(code)) as GiftCard | undefined) ?? null;
}

export function getGiftCard(db: Db, id: number): GiftCard | null {
  return (db.prepare('SELECT * FROM gift_cards WHERE id = ?').get(id) as GiftCard | undefined) ?? null;
}

export function giftCardTransactions(db: Db, cardId: number) {
  return db
    .prepare(
      `SELECT t.*, s.invoice_no FROM gift_card_transactions t
         LEFT JOIN sales s ON s.id = t.sale_id
        WHERE t.gift_card_id = ? ORDER BY t.id`,
    )
    .all(cardId) as any[];
}

export function listGiftCards(
  db: Db,
  filter: { q?: string; status?: GiftCardStatus | 'all'; kind?: GiftCardKind | 'all'; limit?: number } = {},
): { rows: GiftCard[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.q) {
    where.push('(code LIKE ? OR note LIKE ?)');
    const like = `%${normalizeCode(filter.q)}%`;
    params.push(like, like);
  }
  if (filter.status && filter.status !== 'all') {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.kind && filter.kind !== 'all') {
    where.push('kind = ?');
    params.push(filter.kind);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM gift_cards ${clause}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM gift_cards ${clause} ORDER BY id DESC LIMIT ?`)
    .all(...params, filter.limit ?? 200) as GiftCard[];
  return { rows, total };
}

/**
 * Issue a stored-value card.
 *
 * `paid` = the customer handed over money for it (cash/bank debit against the
 * liability). Otherwise it is a complimentary voucher and the cost lands in the
 * sales-discount account, so the liability is never created out of thin air.
 */
export function issueGiftCard(
  db: Db,
  input: {
    amountPaisa: number;
    kind?: GiftCardKind;
    customerId?: number | null;
    expiresAt?: string | null;
    note?: string | null;
    /** Payment method used to buy it. Omitted ⇒ complimentary voucher. */
    methodId?: number | null;
    code?: string | null;
  },
  actor: Actor,
): GiftCard {
  const amount = Math.round(input.amountPaisa);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('গিফট কার্ডের পরিমাণ শূন্যের বেশি হতে হবে।');
  const kind: GiftCardKind = input.kind ?? 'gift_card';
  if (db.prepare('SELECT 1 FROM payment_methods WHERE id = ? AND is_active = 1').get(input.methodId ?? 0) == null && input.methodId) {
    throw new Error('পেমেন্ট মেথড পাওয়া যায়নি।');
  }
  const code = input.code ? normalizeCode(input.code) : randomCode(kind === 'voucher' ? 'VC' : 'GC');
  if (getGiftCardByCode(db, code)) throw new Error(`"${code}" কোডটি আগেই ব্যবহার হয়েছে।`);
  const settings = getSettings(db);
  const now = nowLocal();
  const expiryDays = settings.gift_card_expiry_days ?? 0;
  const expiresAt =
    input.expiresAt ??
    (expiryDays > 0 ? new Date(Date.now() + expiryDays * 86_400_000).toISOString().slice(0, 19).replace('T', ' ') : null);

  return db.transaction(() => {
    const res = db
      .prepare(
        `INSERT INTO gift_cards (code, kind, initial_paisa, balance_paisa, customer_id, issued_at, expires_at, status, note, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,'active',?,?,?)`,
      )
      .run(code, kind, amount, amount, input.customerId ?? null, now, expiresAt, input.note ?? null, now, now);
    const id = Number(res.lastInsertRowid);
    db.prepare(
      `INSERT INTO gift_card_transactions (gift_card_id, sale_id, type, amount_paisa, balance_after_paisa, note, user_id, created_at)
       VALUES (?,NULL,'issue',?,?,?,?,?)`,
    ).run(id, amount, amount, input.note ?? null, actor.id, now);

    if (isPostingEnabled(db)) {
      const liability = giftCardLiabilityAccountId(db);
      const debitAccount = input.methodId
        ? (db.prepare('SELECT account_id FROM payment_methods WHERE id = ?').get(input.methodId) as { account_id: number | null })
            .account_id ?? accountIdByCode(db, ACCOUNT_CODES.cash)
        : accountIdByCode(db, ACCOUNT_CODES.salesDiscount);
      postEntry(db, {
        date: now,
        source: 'gift_card',
        sourceId: id,
        memo: `${kind === 'voucher' ? 'ভাউচার' : 'গিফট কার্ড'} ইস্যু ${code}`,
        userId: actor.id,
        lines: [
          { accountId: debitAccount, debit: amount, memo: 'গ্রহণ' },
          { accountId: liability, credit: amount, memo: 'দায় সৃষ্টি' },
        ],
      });
    }
    audit(db, {
      userId: actor.id,
      username: actor.username,
      action: `giftcard.issue.${kind}`,
      entity: 'gift_card',
      entityId: id,
      details: { code, amount, customerId: input.customerId ?? null },
    });
    return getGiftCard(db, id)!;
  })();
}

/** Non-throwing balance/validity probe used by the POS. */
export function checkGiftCard(
  db: Db,
  args: { code: string; amountPaisa: number; at?: string; forKind?: GiftCardKind | 'any' },
): { ok: boolean; card: GiftCard | null; usablePaisa: number; reason: string | null } {
  const code = normalizeCode(args.code);
  if (!code) return { ok: false, card: null, usablePaisa: 0, reason: 'কার্ডের কোড লিখুন।' };
  const card = getGiftCardByCode(db, code);
  if (!card) return { ok: false, card: null, usablePaisa: 0, reason: 'এই কোডের কোনো কার্ড নেই।' };
  if (args.forKind && args.forKind !== 'any' && card.kind !== args.forKind) {
    return { ok: false, card, usablePaisa: 0, reason: 'কার্ডের ধরন মিলছে না।' };
  }
  if (card.status === 'void') return { ok: false, card, usablePaisa: 0, reason: 'কার্ডটি বাতিল করা হয়েছে।' };
  if (card.status === 'used' || card.balance_paisa <= 0) {
    return { ok: false, card, usablePaisa: 0, reason: 'কার্ডের ব্যালেন্স শেষ।' };
  }
  if (card.expires_at && (args.at ?? nowLocal()) > card.expires_at) {
    return { ok: false, card, usablePaisa: 0, reason: 'কার্ডের মেয়াদ শেষ হয়েছে।' };
  }
  const usable = Math.min(card.balance_paisa, Math.max(0, Math.round(args.amountPaisa)));
  if (usable <= 0) return { ok: false, card, usablePaisa: 0, reason: 'এই বিলে কার্ড ব্যবহারের পরিমাণ শূন্য।' };
  return { ok: true, card, usablePaisa: usable, reason: null };
}

/**
 * Spend stored value against a sale. Must run inside the caller's transaction;
 * the conditional UPDATE makes a double-spend impossible even if two terminals
 * (or two clicks) race.
 */
export function consumeGiftCard(
  db: Db,
  args: { code: string; amountPaisa: number; saleId: number; userId: number | null },
): { card: GiftCard; applied: number } {
  const probe = checkGiftCard(db, { code: args.code, amountPaisa: args.amountPaisa });
  if (!probe.ok || !probe.card) throw new Error(probe.reason ?? 'কার্ড ব্যবহার করা যাচ্ছে না।');
  const applied = probe.usablePaisa;
  const res = db
    .prepare(
      `UPDATE gift_cards SET balance_paisa = balance_paisa - ?, updated_at = ?,
              status = CASE WHEN balance_paisa - ? <= 0 THEN 'used' ELSE status END
        WHERE id = ? AND balance_paisa >= ? AND status = 'active'`,
    )
    .run(applied, nowLocal(), applied, probe.card.id, applied);
  if (res.changes !== 1) throw new Error('কার্ডের ব্যালেন্স এইমাত্র বদলে গেছে — আবার চেষ্টা করুন।');
  const after = getGiftCard(db, probe.card.id)!;
  db.prepare(
    `INSERT INTO gift_card_transactions (gift_card_id, sale_id, type, amount_paisa, balance_after_paisa, note, user_id, created_at)
     VALUES (?,?,'redeem',?,?,NULL,?,?)`,
  ).run(after.id, args.saleId, applied, after.balance_paisa, args.userId, nowLocal());
  return { card: after, applied };
}

/**
 * Give back every stored-value amount a sale took from a card.
 *
 * Used when an invoice is voided: "void" means the document never happened, so
 * the card the customer paid with must be exactly as it was. Any earlier refund
 * already recorded for the same sale is subtracted, so calling this twice is a
 * no-op instead of minting money.
 */
export function restoreGiftCardsForSale(
  db: Db,
  args: { saleId: number; note?: string | null; userId: number | null },
): { cards: number; amountPaisa: number } {
  const rows = db
    .prepare(
      `SELECT gift_card_id,
              COALESCE(SUM(CASE WHEN type = 'redeem' THEN amount_paisa ELSE 0 END),0) AS redeemed,
              COALESCE(SUM(CASE WHEN type IN ('refund','void') THEN amount_paisa ELSE 0 END),0) AS restored
         FROM gift_card_transactions WHERE sale_id = ? GROUP BY gift_card_id`,
    )
    .all(args.saleId) as { gift_card_id: number; redeemed: number; restored: number }[];
  let cards = 0;
  let amountPaisa = 0;
  for (const row of rows) {
    const delta = Math.round(row.redeemed - row.restored);
    if (delta <= 0) continue;
    // The card may have been voided by hand after the sale; never resurrect it.
    const upd = db
      .prepare(
        `UPDATE gift_cards SET balance_paisa = balance_paisa + ?, status = CASE
             WHEN status = 'used' THEN 'active' ELSE status END,
             updated_at = ? WHERE id = ? AND status <> 'void'`,
      )
      .run(delta, nowLocal(), row.gift_card_id);
    if (upd.changes !== 1) continue;
    const after = getGiftCard(db, row.gift_card_id);
    if (!after) continue;
    db.prepare(
      `INSERT INTO gift_card_transactions (gift_card_id, sale_id, type, amount_paisa, balance_after_paisa, note, user_id, created_at)
       VALUES (?,?,'void',?,?,?,?,?)`,
    ).run(
      after.id,
      args.saleId,
      delta,
      after.balance_paisa,
      args.note ?? 'ইনভয়েস বাতিল — স্টোরড ভ্যালু ফেরত',
      args.userId,
      nowLocal(),
    );
    cards += 1;
    amountPaisa += delta;
  }
  return { cards, amountPaisa };
}

/** Put money back on a card (used when a sale paid by card is voided/returned). */
export function refundToGiftCard(
  db: Db,
  args: { cardId: number; amountPaisa: number; saleId?: number | null; note?: string | null; userId: number | null },
): GiftCard {
  const card = getGiftCard(db, args.cardId);
  if (!card) throw new Error('কার্ড পাওয়া যায়নি।');
  const amount = Math.max(0, Math.round(args.amountPaisa));
  if (amount <= 0) throw new Error('ফেরতের পরিমাণ শূন্যের বেশি হতে হবে।');
  // Balance and history are one fact: a card whose statement does not add up to its balance is
  // a stored-value dispute nobody can settle. Nested as a savepoint when a void/return already
  // holds a transaction.
  const run = db.transaction((): GiftCard => {
    db.prepare(
      `UPDATE gift_cards SET balance_paisa = balance_paisa + ?, status = CASE WHEN status = 'used' THEN 'active' ELSE status END,
              updated_at = ? WHERE id = ?`,
    ).run(amount, nowLocal(), card.id);
    const after = getGiftCard(db, card.id)!;
    db.prepare(
      `INSERT INTO gift_card_transactions (gift_card_id, sale_id, type, amount_paisa, balance_after_paisa, note, user_id, created_at)
       VALUES (?,?,'refund',?,?,?,?,?)`,
    ).run(after.id, args.saleId ?? null, amount, after.balance_paisa, args.note ?? null, args.userId, nowLocal());
    return after;
  });
  return run();
}

export function adjustGiftCard(
  db: Db,
  args: { cardId: number; deltaPaisa: number; reason: string; userId: number | null },
): GiftCard {
  const card = getGiftCard(db, args.cardId);
  if (!card) throw new Error('কার্ড পাওয়া যায়নি।');
  const delta = Math.round(args.deltaPaisa);
  if (!Number.isFinite(delta) || delta === 0) throw new Error('সমন্বয়ের পরিমাণ শূন্য হতে পারবে না।');
  if (card.balance_paisa + delta < 0) throw new Error('সমন্বয়ের পরে ব্যালেন্স ঋণাত্মক হয়ে যাবে।');
  if (!args.reason?.trim()) throw new Error('সমন্বয়ের কারণ লিখুন।');
  // A manual adjustment is a money movement: the new balance, the line that explains it and the
  // audit row that says who did it are written together or not at all.
  const run = db.transaction((): GiftCard => {
    db.prepare(
      `UPDATE gift_cards SET balance_paisa = balance_paisa + ?, status = CASE
          WHEN balance_paisa + ? <= 0 THEN 'used'
          WHEN status = 'used' AND balance_paisa + ? > 0 THEN 'active'
          ELSE status END, updated_at = ? WHERE id = ?`,
    ).run(delta, delta, delta, nowLocal(), card.id);
    const after = getGiftCard(db, card.id)!;
    db.prepare(
      `INSERT INTO gift_card_transactions (gift_card_id, sale_id, type, amount_paisa, balance_after_paisa, note, user_id, created_at)
       VALUES (?,NULL,'adjust',?,?,?,?,?)`,
    ).run(after.id, delta, after.balance_paisa, args.reason, args.userId, nowLocal());
    audit(db, {
      userId: args.userId,
      username: null,
      action: 'giftcard.adjust',
      entity: 'gift_card',
      entityId: card.id,
      details: { delta, reason: args.reason },
    });
    return after;
  });
  return run();
}

export function voidGiftCard(db: Db, args: { cardId: number; reason: string; actor: Actor }): GiftCard {
  const card = getGiftCard(db, args.cardId);
  if (!card) throw new Error('কার্ড পাওয়া যায়নি।');
  if (card.status === 'void') throw new Error('কার্ডটি আগেই বাতিল করা হয়েছে।');
  if (!args.reason?.trim()) throw new Error('বাতিলের কারণ লিখুন।');
  return db.transaction(() => {
    db.prepare('UPDATE gift_cards SET status = ?, balance_paisa = 0, updated_at = ? WHERE id = ?').run(
      'void',
      nowLocal(),
      card.id,
    );
    db.prepare(
      `INSERT INTO gift_card_transactions (gift_card_id, sale_id, type, amount_paisa, balance_after_paisa, note, user_id, created_at)
       VALUES (?,NULL,'void',?,0,?,?,?)`,
    ).run(card.id, -card.balance_paisa, args.reason, args.actor.id, nowLocal());
    if (isPostingEnabled(db) && card.balance_paisa > 0) {
      postEntry(db, {
        date: nowLocal(),
        source: 'gift_card_void',
        sourceId: card.id,
        memo: `কার্ড বাতিল ${card.code}`,
        userId: args.actor.id,
        lines: [
          { accountId: giftCardLiabilityAccountId(db), debit: card.balance_paisa, memo: 'দায় বাতিল' },
          { accountId: accountIdByCode(db, ACCOUNT_CODES.otherIncome), credit: card.balance_paisa, memo: 'অন্যান্য আয়' },
        ],
      });
    }
    audit(db, {
      userId: args.actor.id,
      username: args.actor.username,
      action: 'giftcard.void',
      entity: 'gift_card',
      entityId: card.id,
      details: { code: card.code, balance: card.balance_paisa, reason: args.reason },
    });
    return getGiftCard(db, card.id)!;
  })();
}

export function giftCardSummary(db: Db): {
  active: number;
  outstanding_paisa: number;
  issued_paisa: number;
  redeemed_paisa: number;
  expired: number;
} {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status='active' THEN balance_paisa ELSE 0 END) AS outstanding,
         SUM(initial_paisa) AS issued,
         COALESCE((SELECT SUM(amount_paisa) FROM gift_card_transactions WHERE type='redeem'),0) AS redeemed,
         SUM(CASE WHEN status='expired' THEN 1 ELSE 0 END) AS expired
       FROM gift_cards`,
    )
    .get() as any;
  return {
    active: Number(row?.active ?? 0),
    outstanding_paisa: Number(row?.outstanding ?? 0),
    issued_paisa: Number(row?.issued ?? 0),
    redeemed_paisa: Number(row?.redeemed ?? 0),
    expired: Number(row?.expired ?? 0),
  };
}

/** Marks expired cards. Safe to call on every app start. */
export function expireGiftCards(db: Db): number {
  const res = db
    .prepare(
      `UPDATE gift_cards SET status = 'expired', updated_at = ?
        WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?`,
    )
    .run(nowLocal(), nowLocal());
  return res.changes;
}
