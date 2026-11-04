import type { Db } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import type { Payment } from '../domain/types.js';
import { audit } from './audit.js';
import { addCashMovement } from './cash.js';
import { isPostingEnabled, postPayment, reverseDocument } from './accounting.js';

export interface InsertPaymentInput {
  kind: string;
  partyType: 'customer' | 'supplier' | 'none';
  customerId?: number | null;
  supplierId?: number | null;
  saleId?: number | null;
  purchaseId?: number | null;
  amount: number;
  methodId: number;
  reference?: string | null;
  note?: string | null;
  userId: number | null;
  date?: string;
  direction: 'in' | 'out';
  /** When true the party's outstanding balance is adjusted by this payment. */
  affectsBalance: boolean;
  /** Suppress the cash-register entry (used when a refund goes to credit). */
  skipCash?: boolean;
  reversesId?: number | null;
  status?: 'active' | 'reversed';
}

export function isCashMethod(db: Db, methodId: number): boolean {
  const row = db.prepare('SELECT is_cash, is_active, name FROM payment_methods WHERE id = ?').get(methodId) as
    | { is_cash: number; is_active: number; name: string }
    | undefined;
  if (!row) throw new Error('পেমেন্ট মেথড পাওয়া যায়নি।');
  if (!row.is_active) throw new Error(`"${row.name}" পেমেন্ট মেথড বর্তমানে নিষ্ক্রিয়।`);
  return row.is_cash === 1;
}

export function insertPayment(db: Db, input: InsertPaymentInput): number {
  const amount = Math.round(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('পেমেন্টের পরিমাণ ০ এর চেয়ে বড় হতে হবে।');
  if (!input.methodId) throw new Error('পেমেন্ট মেথড নির্বাচন করুন।');
  const cash = isCashMethod(db, input.methodId);

  const res = db
    .prepare(
      `INSERT INTO payments
        (kind, party_type, customer_id, supplier_id, sale_id, purchase_id, amount_paisa, method_id,
         reference, note, user_id, payment_date, direction, status, reverses_id, cash_session_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)`,
    )
    .run(
      input.kind,
      input.partyType,
      input.customerId ?? null,
      input.supplierId ?? null,
      input.saleId ?? null,
      input.purchaseId ?? null,
      amount,
      input.methodId,
      input.reference ?? null,
      input.note ?? null,
      input.userId ?? null,
      input.date ?? nowLocal(),
      input.direction,
      input.status ?? 'active',
      input.reversesId ?? null,
      nowLocal(),
    );
  const paymentId = Number(res.lastInsertRowid);
  if (isPostingEnabled(db) && !input.reversesId) postPayment(db, paymentId);

  if (input.affectsBalance) {
    if (input.partyType === 'customer' && input.customerId) {
      const delta = input.direction === 'in' ? -amount : amount;
      db.prepare('UPDATE customers SET balance_paisa = balance_paisa + ?, updated_at = ? WHERE id = ?').run(
        delta,
        nowLocal(),
        input.customerId,
      );
    } else if (input.partyType === 'supplier' && input.supplierId) {
      const delta = input.direction === 'out' ? -amount : amount;
      db.prepare('UPDATE suppliers SET balance_paisa = balance_paisa + ?, updated_at = ? WHERE id = ?').run(
        delta,
        nowLocal(),
        input.supplierId,
      );
    }
  }

  if (cash && !input.skipCash && input.userId && (input.status ?? 'active') === 'active') {
    addCashMovement(db, {
      userId: input.userId,
      direction: input.direction,
      amount,
      source: input.kind,
      sourceId: paymentId,
      note: input.note ?? null,
    });
  }
  return paymentId;
}

/** Reverse a payment by appending a counter-entry — never deletes history. */
export function reversePayment(
  db: Db,
  paymentId: number,
  reason: string,
  actor: { id: number; username: string },
): { reversalId: number } {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as Payment | undefined;
  if (!p) throw new Error('পেমেন্ট পাওয়া যায়নি।');
  if (p.status === 'reversed') throw new Error('এই পেমেন্ট আগেই বাতিল করা হয়েছে।');
  if (!reason || !reason.trim()) throw new Error('বাতিল করার কারণ লিখতে হবে।');
  const cash = p.method_id ? isCashMethod(db, p.method_id) : false;
  const now = nowLocal();

  const run = db.transaction(() => {
    db.prepare("UPDATE payments SET status = 'reversed' WHERE id = ?").run(paymentId);
    const res = db
      .prepare(
        `INSERT INTO payments
          (kind, party_type, customer_id, supplier_id, sale_id, purchase_id, amount_paisa, method_id,
           reference, note, user_id, payment_date, direction, status, reverses_id, cash_session_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,NULL,?)`,
      )
      .run(
        `${p.kind}_reversal`,
        p.party_type,
        p.customer_id,
        p.supplier_id,
        p.sale_id,
        p.purchase_id,
        p.amount_paisa,
        p.method_id,
        p.reference,
        `বাতিল: ${reason}`,
        actor.id,
        now,
        p.direction === 'in' ? 'out' : 'in',
        paymentId,
        now,
      );
    const reversalId = Number(res.lastInsertRowid);

    if (p.party_type === 'customer' && p.customer_id) {
      const delta = p.direction === 'in' ? p.amount_paisa : -p.amount_paisa;
      db.prepare('UPDATE customers SET balance_paisa = balance_paisa + ?, updated_at = ? WHERE id = ?').run(
        delta,
        now,
        p.customer_id,
      );
    } else if (p.party_type === 'supplier' && p.supplier_id) {
      const delta = p.direction === 'out' ? p.amount_paisa : -p.amount_paisa;
      db.prepare('UPDATE suppliers SET balance_paisa = balance_paisa + ?, updated_at = ? WHERE id = ?').run(
        delta,
        now,
        p.supplier_id,
      );
    }

    if (cash) {
      addCashMovement(db, {
        userId: actor.id,
        direction: p.direction === 'in' ? 'out' : 'in',
        amount: p.amount_paisa,
        source: 'manual_out',
        sourceId: reversalId,
        note: `পেমেন্ট বাতিল #${paymentId}`,
      });
    }
    if (isPostingEnabled(db)) {
      reverseDocument(db, p.direction === 'in' ? 'payment_in' : 'payment_out', paymentId, {
        userId: actor.id,
        memo: `পেমেন্ট বাতিল: ${reason}`,
      });
    }
    return reversalId;
  });
  const reversalId = run();
  audit(db, {
    userId: actor.id,
    username: actor.username,
    action: 'payment.reverse',
    entity: 'payment',
    entityId: paymentId,
    details: { amount: p.amount_paisa, reason, reversalId },
  });
  return { reversalId };
}

export interface PaymentFilter {
  partyType?: 'customer' | 'supplier' | 'all';
  customerId?: number | null;
  supplierId?: number | null;
  from?: string;
  to?: string;
  methodId?: number | null;
  status?: 'active' | 'reversed' | 'all';
  search?: string;
  page?: number;
  pageSize?: number;
}

export function listPayments(db: Db, f: PaymentFilter = {}): { rows: Payment[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.partyType && f.partyType !== 'all') {
    where.push('pm.party_type = ?');
    params.push(f.partyType);
  }
  if (f.customerId) {
    where.push('pm.customer_id = ?');
    params.push(f.customerId);
  }
  if (f.supplierId) {
    where.push('pm.supplier_id = ?');
    params.push(f.supplierId);
  }
  if (f.from) {
    where.push('date(pm.payment_date) >= date(?)');
    params.push(f.from);
  }
  if (f.to) {
    where.push('date(pm.payment_date) <= date(?)');
    params.push(f.to);
  }
  if (f.methodId) {
    where.push('pm.method_id = ?');
    params.push(f.methodId);
  }
  if (f.status && f.status !== 'all') {
    where.push('pm.status = ?');
    params.push(f.status);
  }
  if (f.search) {
    const like = `%${f.search}%`;
    where.push('(c.name LIKE ? OR s.name LIKE ? OR pm.reference LIKE ? OR sa.invoice_no LIKE ?)');
    params.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const base = `FROM payments pm
    LEFT JOIN customers c ON c.id = pm.customer_id
    LEFT JOIN suppliers s ON s.id = pm.supplier_id
    LEFT JOIN payment_methods m ON m.id = pm.method_id
    LEFT JOIN users u ON u.id = pm.user_id
    LEFT JOIN sales sa ON sa.id = pm.sale_id
    ${clause}`;
  const total = (db.prepare(`SELECT COUNT(*) c ${base}`).get(...params) as { c: number }).c;
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(500, Math.max(10, f.pageSize ?? 50));
  const rows = db
    .prepare(
      `SELECT pm.*, m.name AS method_name, u.username,
              COALESCE(c.name, s.name) AS party_name, sa.invoice_no
       ${base} ORDER BY pm.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as Payment[];
  return { rows, total };
}

export function paymentsForCustomer(db: Db, customerId: number, limit = 200): Payment[] {
  return db
    .prepare(
      `SELECT pm.*, m.name AS method_name, u.username FROM payments pm
        LEFT JOIN payment_methods m ON m.id = pm.method_id
        LEFT JOIN users u ON u.id = pm.user_id
       WHERE pm.customer_id = ? AND pm.status = 'active' ORDER BY pm.id DESC LIMIT ?`,
    )
    .all(customerId, limit) as Payment[];
}

export function paymentsForSupplier(db: Db, supplierId: number, limit = 200): Payment[] {
  return db
    .prepare(
      `SELECT pm.*, m.name AS method_name, u.username FROM payments pm
        LEFT JOIN payment_methods m ON m.id = pm.method_id
        LEFT JOIN users u ON u.id = pm.user_id
       WHERE pm.supplier_id = ? AND pm.status = 'active' ORDER BY pm.id DESC LIMIT ?`,
    )
    .all(supplierId, limit) as Payment[];
}
