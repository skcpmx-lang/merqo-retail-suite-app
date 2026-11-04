import type { Db } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import { bengaliSortKey, foldForSearch, normalizeText } from '../domain/text.js';
import type { Customer, Payment } from '../domain/types.js';
import { audit } from './audit.js';
import { isPostingEnabled, postEntry } from './accounting.js';
import { insertPayment } from './payments.js';

type Actor = { id: number; username: string } | null | undefined;

export interface CustomerFilter {
  search?: string;
  onlyDue?: boolean;
  includeInactive?: boolean;
  page?: number;
  pageSize?: number;
  sort?: 'name' | 'due' | 'created';
  direction?: 'asc' | 'desc';
}

export function listCustomers(db: Db, f: CustomerFilter = {}): { rows: Customer[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!f.includeInactive) where.push('is_active = 1');
  if (f.search && f.search.trim()) {
    where.push('(search_text LIKE ? OR phone LIKE ?)');
    const like = `%${foldForSearch(f.search)}%`;
    params.push(like, like);
  }
  if (f.onlyDue) where.push('balance_paisa > 0');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) c FROM customers ${clause}`).get(...params) as { c: number }).c;
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(500, Math.max(5, f.pageSize ?? 50));
  const sortMap: Record<string, string> = { name: 'name_sort', due: 'balance_paisa', created: 'id' };
  const sortCol = sortMap[f.sort ?? 'name'] ?? 'name_sort';
  const dir = (f.direction ?? (f.sort === 'due' ? 'desc' : 'asc')).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const rows = db
    .prepare(`SELECT * FROM customers ${clause} ORDER BY is_walkin DESC, ${sortCol} ${dir} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as Customer[];
  return { rows, total };
}

export function getCustomer(db: Db, id: number): (Customer & { stats: CustomerStats }) | null {
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Customer | undefined;
  if (!row) return null;
  return { ...row, stats: customerStats(db, id) };
}

export interface CustomerStats {
  total_sales_paisa: number;
  total_paid_paisa: number;
  sales_count: number;
  last_sale_at: string | null;
  returns_paisa: number;
  due_paisa: number;
}

export function customerStats(db: Db, id: number): CustomerStats {
  const sales = db
    .prepare(
      `SELECT COALESCE(SUM(total_paisa),0) total, COALESCE(SUM(paid_paisa),0) paid, COUNT(*) c, MAX(sale_date) last
         FROM sales WHERE customer_id = ? AND status <> 'voided'`,
    )
    .get(id) as { total: number; paid: number; c: number; last: string | null };
  const payments = db
    .prepare(
      `SELECT COALESCE(SUM(amount_paisa),0) v FROM payments
        WHERE customer_id = ? AND direction = 'in' AND status = 'active'`,
    )
    .get(id) as { v: number };
  const returns = db
    .prepare(
      `SELECT COALESCE(SUM(total_paisa),0) v FROM returns
        WHERE customer_id = ? AND kind = 'sale' AND status = 'completed'`,
    )
    .get(id) as { v: number };
  const bal = db.prepare('SELECT balance_paisa FROM customers WHERE id = ?').get(id) as { balance_paisa: number };
  return {
    total_sales_paisa: sales.total,
    total_paid_paisa: payments.v,
    sales_count: sales.c,
    last_sale_at: sales.last,
    returns_paisa: returns.v,
    due_paisa: bal?.balance_paisa ?? 0,
  };
}

export interface CustomerInput {
  name: string;
  phone?: string | null;
  address?: string | null;
  openingBalance?: number;
  note?: string | null;
}

export function buildCustomerSearch(name: string, phone?: string | null, address?: string | null): string {
  return foldForSearch([name, phone ?? '', address ?? ''].join(' '));
}

export function createCustomer(db: Db, input: CustomerInput, actor?: Actor): Customer {
  const name = normalizeText(input.name);
  if (!name) throw new Error('কাস্টমারের নাম দিতে হবে।');
  if (input.phone && !/^[0-9+\-\s]{5,20}$/.test(input.phone.trim()))
    throw new Error('মোবাইল নম্বর সঠিক নয়।');
  const dup = input.phone
    ? db.prepare('SELECT id FROM customers WHERE phone = ? AND is_active = 1').get(input.phone.trim())
    : null;
  if (dup && !input.name) throw new Error('এই মোবাইল নম্বর আগেই নিবন্ধিত।');
  const now = nowLocal();
  const opening = Math.round(input.openingBalance ?? 0);
  const res = db
    .prepare(
      `INSERT INTO customers (name, name_sort, search_text, phone, address, opening_balance_paisa, balance_paisa,
         is_walkin, note, is_active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,0,?,1,?,?)`,
    )
    .run(
      name,
      bengaliSortKey(name),
      buildCustomerSearch(name, input.phone, input.address),
      input.phone ? normalizeText(input.phone) : null,
      input.address ? normalizeText(input.address) : null,
      opening,
      opening,
      input.note ? normalizeText(input.note) : null,
      now,
      now,
    );
  const id = Number(res.lastInsertRowid);
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username,
    action: 'customer.create',
    entity: 'customer',
    entityId: id,
    details: { name, opening },
  });
  if (opening > 0 && isPostingEnabled(db)) {
    postEntry(db, {
      date: now,
      source: 'opening_customer',
      sourceId: id,
      memo: `প্রারম্ভিক বাকি: ${name}`,
      userId: actor?.id ?? null,
      idempotent: true,
      lines: [
        { code: '1100', debit: opening, memo: 'কাস্টমার বাকি' },
        { code: '3100', credit: opening, memo: 'প্রারম্ভিক ব্যালেন্স' },
      ],
    });
  }
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Customer;
}

export function updateCustomer(db: Db, id: number, input: CustomerInput, actor?: Actor): Customer {
  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Customer | undefined;
  if (!existing) throw new Error('কাস্টমার পাওয়া যায়নি।');
  if (existing.is_walkin && input.name && normalizeText(input.name) !== existing.name)
    throw new Error('ওয়াক-ইন কাস্টমারের নাম পরিবর্তন করা যাবে না।');
  const name = normalizeText(input.name) || existing.name;
  const opening = input.openingBalance === undefined ? existing.opening_balance_paisa : Math.round(input.openingBalance);
  const openingDelta = opening - existing.opening_balance_paisa;
  db.prepare(
    `UPDATE customers SET name = ?, name_sort = ?, search_text = ?, phone = ?, address = ?, opening_balance_paisa = ?,
       balance_paisa = balance_paisa + ?, note = ?, updated_at = ? WHERE id = ?`,
  ).run(
    name,
    bengaliSortKey(name),
    buildCustomerSearch(name, input.phone ?? existing.phone, input.address ?? existing.address),
    input.phone ? normalizeText(input.phone) : existing.phone,
    input.address !== undefined ? normalizeText(input.address) : existing.address,
    opening,
    openingDelta,
    input.note !== undefined ? normalizeText(input.note) : existing.note,
    nowLocal(),
    id,
  );
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username,
    action: 'customer.update',
    entity: 'customer',
    entityId: id,
    details: { name, openingDelta },
  });
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Customer;
}

export function setCustomerActive(db: Db, id: number, active: boolean, actor?: Actor): void {
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Customer | undefined;
  if (!row) throw new Error('কাস্টমার পাওয়া যায়নি।');
  if (row.is_walkin) throw new Error('ওয়াক-ইন কাস্টমার নিষ্ক্রিয় করা যাবে না।');
  if (!active && row.balance_paisa !== 0) throw new Error('বাকি থাকা অবস্থায় কাস্টমার নিষ্ক্রিয় করা যাবে না।');
  db.prepare('UPDATE customers SET is_active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, nowLocal(), id);
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username,
    action: active ? 'customer.restore' : 'customer.archive',
    entity: 'customer',
    entityId: id,
  });
}

export function deleteCustomer(db: Db, id: number, actor?: Actor): void {
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Customer | undefined;
  if (!row) throw new Error('কাস্টমার পাওয়া যায়নি।');
  if (row.is_walkin) throw new Error('ওয়াক-ইন কাস্টমার ডিলিট করা যাবে না।');
  if (row.balance_paisa !== 0) throw new Error('বাকি থাকা অবস্থায় কাস্টমার ডিলিট করা যাবে না।');
  const used =
    (db.prepare('SELECT COUNT(*) c FROM sales WHERE customer_id = ?').get(id) as { c: number }).c +
    (db.prepare('SELECT COUNT(*) c FROM payments WHERE customer_id = ?').get(id) as { c: number }).c;
  if (used > 0) throw new Error('এই কাস্টমারের লেনদেন আছে — ডিলিট করা যাবে না, আর্কাইভ করুন।');
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  audit(db, { userId: actor?.id ?? null, username: actor?.username, action: 'customer.delete', entity: 'customer', entityId: id });
}

export function ensureWalkInCustomer(db: Db): Customer {
  const row = db.prepare('SELECT * FROM customers WHERE is_walkin = 1 LIMIT 1').get() as Customer | undefined;
  if (row) return row;
  const now = nowLocal();
  const res = db
    .prepare(
      `INSERT INTO customers (name, name_sort, search_text, opening_balance_paisa, balance_paisa, is_walkin, is_active,
         created_at, updated_at) VALUES (?,?,'',0,0,1,1,?,?)`,
    )
    .run('ওয়াক-ইন কাস্টমার', bengaliSortKey('ওয়াক-ইন কাস্টমার'), now, now);
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(res.lastInsertRowid)) as Customer;
}

/* ------------------------------------------------------------------ */
/* Due collection & statements                                        */
/* ------------------------------------------------------------------ */

export function receiveCustomerPayment(
  db: Db,
  input: {
    customerId: number;
    amount: number;
    methodId: number;
    reference?: string | null;
    note?: string | null;
    date?: string;
  },
  actor: { id: number; username: string },
): { paymentId: number; newBalance: number } {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(input.customerId) as Customer | undefined;
  if (!customer) throw new Error('কাস্টমার পাওয়া যায়নি।');
  const amount = Math.round(input.amount);
  if (amount <= 0) throw new Error('টাকার পরিমাণ ০ এর চেয়ে বড় হতে হবে।');
  if (customer.is_walkin) throw new Error('ওয়াক-ইন কাস্টমারের বাকি গ্রহণ করা যায় না।');
  const run = db.transaction(() => {
    const paymentId = insertPayment(db, {
      kind: 'customer_payment',
      partyType: 'customer',
      customerId: input.customerId,
      amount,
      methodId: input.methodId,
      reference: input.reference ?? null,
      note: input.note ?? null,
      userId: actor.id,
      date: input.date,
      direction: 'in',
      affectsBalance: true,
    });
    const bal = db.prepare('SELECT balance_paisa FROM customers WHERE id = ?').get(input.customerId) as {
      balance_paisa: number;
    };
    audit(db, {
      userId: actor.id,
      username: actor.username,
      action: 'customer.payment',
      entity: 'customer',
      entityId: input.customerId,
      details: { amount, paymentId, balanceAfter: bal.balance_paisa },
    });
    return { paymentId, newBalance: bal.balance_paisa };
  });
  return run();
}

export interface StatementRow {
  date: string;
  type: 'sale' | 'payment' | 'return' | 'refund' | 'opening' | 'adjustment';
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  method?: string | null;
}

export interface Statement {
  customer: Customer;
  from: string | null;
  to: string | null;
  opening_balance: number;
  closing_balance: number;
  total_debit: number;
  total_credit: number;
  rows: StatementRow[];
}

interface LedgerEvent {
  at: string;
  type: StatementRow['type'];
  reference: string;
  description: string;
  debit: number;
  credit: number;
  method?: string | null;
}

export function customerLedgerEvents(db: Db, customerId: number): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  const sales = db
    .prepare(
      `SELECT id, invoice_no, sale_date, total_paisa, paid_paisa, due_paisa FROM sales
        WHERE customer_id = ? AND status <> 'voided'`,
    )
    .all(customerId) as any[];
  for (const s of sales) {
    events.push({
      at: s.sale_date,
      type: 'sale',
      reference: s.invoice_no,
      description: `বিক্রয় (মোট ৳${(s.total_paisa / 100).toFixed(2)}, পরিশোধ ৳${(s.paid_paisa / 100).toFixed(2)})`,
      debit: s.due_paisa,
      credit: 0,
    });
  }
  const payments = db
    .prepare(
      `SELECT pm.*, m.name AS method_name FROM payments pm LEFT JOIN payment_methods m ON m.id = pm.method_id
        WHERE pm.customer_id = ? AND pm.status = 'active' AND pm.party_type = 'customer'
          AND pm.kind NOT IN ('sale')`,
    )
    .all(customerId) as (Payment & { method_name: string | null })[];
  for (const p of payments) {
    if (p.kind.startsWith('customer_payment') && p.direction === 'in') {
      events.push({
        at: p.payment_date,
        type: 'payment',
        reference: p.reference || `PAY-${p.id}`,
        description: p.kind.includes('reversal') ? 'পেমেন্ট বাতিল' : 'বাকি গ্রহণ',
        debit: 0,
        credit: p.amount_paisa,
        method: p.method_name,
      });
    } else if (p.direction === 'out') {
      events.push({
        at: p.payment_date,
        type: 'refund',
        reference: p.reference || `RFD-${p.id}`,
        description: 'রিফান্ড পরিশোধ',
        debit: p.amount_paisa,
        credit: 0,
        method: p.method_name,
      });
    }
  }
  const returns = db
    .prepare(
      `SELECT id, return_no, return_date, total_paisa FROM returns
        WHERE customer_id = ? AND kind = 'sale' AND status = 'completed'`,
    )
    .all(customerId) as any[];
  for (const r of returns) {
    events.push({
      at: r.return_date,
      type: 'return',
      reference: r.return_no,
      description: 'সেলস রিটার্ন',
      debit: 0,
      credit: r.total_paisa,
    });
  }
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return events;
}

export function customerStatement(
  db: Db,
  customerId: number,
  from?: string,
  to?: string,
): Statement {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) as Customer | undefined;
  if (!customer) throw new Error('কাস্টমার পাওয়া যায়নি।');
  const events = customerLedgerEvents(db, customerId);
  let opening = customer.opening_balance_paisa;
  for (const e of events) {
    if (from && e.at.slice(0, 10) < from) opening += e.debit - e.credit;
  }
  const inRange = events.filter((e) => {
    const d = e.at.slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
  let balance = opening;
  let totalDebit = 0;
  let totalCredit = 0;
  const rows: StatementRow[] = [];
  if (opening !== 0 && !from) {
    rows.push({
      date: customer.created_at.slice(0, 10),
      type: 'opening',
      reference: '—',
      description: 'পূর্বের বাকি (ওপেনিং ব্যালেন্স)',
      debit: opening > 0 ? opening : 0,
      credit: opening < 0 ? -opening : 0,
      balance: opening,
    });
  }
  for (const e of inRange) {
    balance += e.debit - e.credit;
    totalDebit += e.debit;
    totalCredit += e.credit;
    rows.push({
      date: e.at,
      type: e.type,
      reference: e.reference,
      description: e.description,
      debit: e.debit,
      credit: e.credit,
      balance,
      method: e.method ?? null,
    });
  }
  return {
    customer,
    from: from ?? null,
    to: to ?? null,
    opening_balance: opening,
    closing_balance: balance,
    total_debit: totalDebit,
    total_credit: totalCredit,
    rows,
  };
}

export function totalDuePaisa(db: Db): number {
  const row = db.prepare('SELECT COALESCE(SUM(balance_paisa),0) v FROM customers WHERE balance_paisa > 0').get() as {
    v: number;
  };
  return row.v;
}

export function customerCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) c FROM customers WHERE is_active = 1 AND is_walkin = 0').get() as { c: number }).c;
}
