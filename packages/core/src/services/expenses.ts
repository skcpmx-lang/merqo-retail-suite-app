import type { Db } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import type { Expense } from '../domain/types.js';
import { audit } from './audit.js';
import { addCashMovement } from './cash.js';
import { isPostingEnabled, postExpense, reverseDocument } from './accounting.js';
import { isCashMethod } from './payments.js';

type Actor = { id: number; username: string };

export interface ExpenseInput {
  categoryId: number | null;
  amountPaisa: number;
  methodId: number;
  description: string;
  reference?: string | null;
  note?: string | null;
  expenseDate?: string;
}

export function createExpense(db: Db, input: ExpenseInput, actor: Actor): Expense {
  const amount = Math.round(input.amountPaisa);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('এক্সপেন্সের পরিমাণ ০ এর চেয়ে বড় হতে হবে।');
  if (!input.description || !input.description.trim()) throw new Error('এক্সপেন্সের বিবরণ লিখতে হবে।');
  if (!input.methodId) throw new Error('পেমেন্ট মেথড নির্বাচন করুন।');
  const cash = isCashMethod(db, input.methodId);
  if (input.categoryId) {
    const cat = db.prepare('SELECT id FROM expense_categories WHERE id = ?').get(input.categoryId);
    if (!cat) throw new Error('এক্সপেন্স ক্যাটাগরি পাওয়া যায়নি।');
  }

  const run = db.transaction(() => {
    const res = db
      .prepare(
        `INSERT INTO expenses (category_id, amount_paisa, method_id, description, reference, note, expense_date,
           user_id, status, cash_session_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,'active',NULL,?)`,
      )
      .run(
        input.categoryId,
        amount,
        input.methodId,
        input.description.trim(),
        input.reference ?? null,
        input.note ?? null,
        input.expenseDate ?? nowLocal(),
        actor.id,
        nowLocal(),
      );
    const id = Number(res.lastInsertRowid);
    if (isPostingEnabled(db)) postExpense(db, id);
    if (cash) {
      addCashMovement(db, {
        userId: actor.id,
        direction: 'out',
        amount,
        source: 'expense',
        sourceId: id,
        note: input.description,
      });
    }
    audit(db, {
      userId: actor.id,
      username: actor.username,
      action: 'expense.create',
      entity: 'expense',
      entityId: id,
      details: { amount, description: input.description, categoryId: input.categoryId },
    });
    return id;
  });
  const id = run();
  return db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as Expense;
}

export function updateExpense(db: Db, id: number, input: ExpenseInput, actor: Actor): Expense {
  const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as Expense | undefined;
  if (!existing) throw new Error('এক্সপেন্স পাওয়া যায়নি।');
  if (existing.status === 'voided') throw new Error('বাতিল করা এক্সপেন্স সম্পাদনা করা যাবে না।');
  const amount = Math.round(input.amountPaisa);
  if (amount <= 0) throw new Error('এক্সপেন্সের পরিমাণ ০ এর চেয়ে বড় হতে হবে।');
  const run = db.transaction(() => {
    db.prepare(
      `UPDATE expenses SET category_id = ?, amount_paisa = ?, method_id = ?, description = ?, reference = ?,
         note = ?, expense_date = ? WHERE id = ?`,
    ).run(
      input.categoryId,
      amount,
      input.methodId,
      input.description.trim(),
      input.reference ?? null,
      input.note ?? null,
      input.expenseDate ?? existing.expense_date,
      id,
    );
    // Recalculate the cash impact if the amount or method changed.
    const wasCash = existing.method_id ? isCashMethod(db, existing.method_id) : false;
    const isCash = isCashMethod(db, input.methodId);
    if (wasCash && existing.amount_paisa !== amount) {
      const delta = amount - existing.amount_paisa;
      addCashMovement(db, {
        userId: actor.id,
        direction: delta > 0 ? 'out' : 'in',
        amount: Math.abs(delta),
        source: delta > 0 ? 'expense' : 'manual_in',
        sourceId: id,
        note: `এক্সপেন্স সংশোধন #${id}`,
      });
    }
    if (wasCash && !isCash) {
      addCashMovement(db, {
        userId: actor.id,
        direction: 'in',
        amount: existing.amount_paisa,
        source: 'manual_in',
        sourceId: id,
        note: `এক্সপেন্স ক্যাশ সংশোধন #${id}`,
      });
    }
    if (!wasCash && isCash) {
      addCashMovement(db, {
        userId: actor.id,
        direction: 'out',
        amount,
        source: 'expense',
        sourceId: id,
        note: `এক্সপেন্স ক্যাশ সংশোধন #${id}`,
      });
    }
    audit(db, {
      userId: actor.id,
      username: actor.username,
      action: 'expense.update',
      entity: 'expense',
      entityId: id,
      details: { before: existing.amount_paisa, after: amount },
    });
  });
  run();
  return db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as Expense;
}

export function voidExpense(db: Db, id: number, reason: string, actor: Actor): void {
  const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as Expense | undefined;
  if (!existing) throw new Error('এক্সপেন্স পাওয়া যায়নি।');
  if (existing.status === 'voided') throw new Error('এই এক্সপেন্স আগেই বাতিল করা হয়েছে।');
  if (!reason || !reason.trim()) throw new Error('বাতিল করার কারণ লিখতে হবে।');
  const run = db.transaction(() => {
    db.prepare("UPDATE expenses SET status = 'voided' WHERE id = ?").run(id);
    if (isPostingEnabled(db)) {
      reverseDocument(db, 'expense', id, { userId: actor.id, memo: `খরচ বাতিল: ${reason}` });
    }
    const cash = existing.method_id ? isCashMethod(db, existing.method_id) : false;
    if (cash) {
      addCashMovement(db, {
        userId: actor.id,
        direction: 'in',
        amount: existing.amount_paisa,
        source: 'manual_in',
        sourceId: id,
        note: `এক্সপেন্স বাতিল #${id}`,
      });
    }
    audit(db, {
      userId: actor.id,
      username: actor.username,
      action: 'expense.void',
      entity: 'expense',
      entityId: id,
      details: { amount: existing.amount_paisa, reason },
    });
  });
  run();
}

export interface ExpenseFilter {
  from?: string;
  to?: string;
  categoryId?: number | null;
  methodId?: number | null;
  search?: string;
  status?: 'active' | 'voided' | 'all';
  page?: number;
  pageSize?: number;
}

export function listExpenses(db: Db, f: ExpenseFilter = {}): { rows: Expense[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.from) {
    where.push('date(e.expense_date) >= date(?)');
    params.push(f.from);
  }
  if (f.to) {
    where.push('date(e.expense_date) <= date(?)');
    params.push(f.to);
  }
  if (f.categoryId) {
    where.push('e.category_id = ?');
    params.push(f.categoryId);
  }
  if (f.methodId) {
    where.push('e.method_id = ?');
    params.push(f.methodId);
  }
  if (f.search) {
    const like = `%${f.search}%`;
    where.push('(e.description LIKE ? OR e.reference LIKE ? OR ec.name LIKE ?)');
    params.push(like, like, like);
  }
  if (!f.status || f.status === 'all') {
    /* keep both */
  } else {
    where.push('e.status = ?');
    params.push(f.status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const base = `FROM expenses e LEFT JOIN expense_categories ec ON ec.id = e.category_id
    LEFT JOIN payment_methods m ON m.id = e.method_id LEFT JOIN users u ON u.id = e.user_id ${clause}`;
  const total = (db.prepare(`SELECT COUNT(*) c ${base}`).get(...params) as { c: number }).c;
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(500, Math.max(10, f.pageSize ?? 50));
  const rows = db
    .prepare(
      `SELECT e.*, ec.name AS category_name, m.name AS method_name, u.username ${base}
        ORDER BY e.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as Expense[];
  return { rows, total };
}

export function expenseTotal(db: Db, from?: string, to?: string): number {
  const where = ["status = 'active'"];
  const params: unknown[] = [];
  if (from) {
    where.push('date(expense_date) >= date(?)');
    params.push(from);
  }
  if (to) {
    where.push('date(expense_date) <= date(?)');
    params.push(to);
  }
  const row = db
    .prepare(`SELECT COALESCE(SUM(amount_paisa),0) v FROM expenses WHERE ${where.join(' AND ')}`)
    .get(...params) as { v: number };
  return row.v;
}

export function expensesByCategory(db: Db, from?: string, to?: string): { name: string; total: number }[] {
  const where = ["e.status = 'active'"];
  const params: unknown[] = [];
  if (from) {
    where.push('date(e.expense_date) >= date(?)');
    params.push(from);
  }
  if (to) {
    where.push('date(e.expense_date) <= date(?)');
    params.push(to);
  }
  return db
    .prepare(
      `SELECT COALESCE(ec.name, 'অন্যান্য') AS name, COALESCE(SUM(e.amount_paisa),0) AS total
         FROM expenses e LEFT JOIN expense_categories ec ON ec.id = e.category_id
        WHERE ${where.join(' AND ')} GROUP BY COALESCE(ec.name,'অন্যান্য') ORDER BY total DESC`,
    )
    .all(...params) as { name: string; total: number }[];
}
