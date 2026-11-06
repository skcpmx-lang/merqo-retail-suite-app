import type { Db } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import { bengaliSortKey, foldForSearch, normalizeText } from '../domain/text.js';
import type { Supplier } from '../domain/types.js';
import { audit } from './audit.js';
import { insertPayment } from './payments.js';

type Actor = { id: number; username: string } | null | undefined;

export interface SupplierFilter {
  search?: string;
  onlyPayable?: boolean;
  includeInactive?: boolean;
  page?: number;
  pageSize?: number;
  sort?: 'name' | 'payable' | 'created';
  direction?: 'asc' | 'desc';
}

export function listSuppliers(db: Db, f: SupplierFilter = {}): { rows: Supplier[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!f.includeInactive) where.push('is_active = 1');
  if (f.search && f.search.trim()) {
    where.push('(search_text LIKE ? OR phone LIKE ? OR company LIKE ?)');
    const like = `%${foldForSearch(f.search)}%`;
    params.push(like, like, like);
  }
  if (f.onlyPayable) where.push('balance_paisa > 0');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) c FROM suppliers ${clause}`).get(...params) as { c: number }).c;
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(500, Math.max(5, f.pageSize ?? 50));
  const sortMap: Record<string, string> = { name: 'name_sort', payable: 'balance_paisa', created: 'id' };
  const sortCol = sortMap[f.sort ?? 'name'] ?? 'name_sort';
  const dir = (f.direction ?? (f.sort === 'payable' ? 'desc' : 'asc')).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const rows = db
    .prepare(`SELECT * FROM suppliers ${clause} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as Supplier[];
  return { rows, total };
}

export interface SupplierStats {
  total_purchase_paisa: number;
  total_paid_paisa: number;
  purchase_count: number;
  last_purchase_at: string | null;
  returns_paisa: number;
  payable_paisa: number;
}

export function supplierStats(db: Db, id: number): SupplierStats {
  const pur = db
    .prepare(
      `SELECT COALESCE(SUM(total_paisa),0) total, COUNT(*) c, MAX(purchase_date) last
         FROM purchases WHERE supplier_id = ? AND status <> 'voided'`,
    )
    .get(id) as { total: number; c: number; last: string | null };
  const paid = db
    .prepare(
      `SELECT COALESCE(SUM(amount_paisa),0) v FROM payments
        WHERE supplier_id = ? AND direction = 'out' AND status = 'active'`,
    )
    .get(id) as { v: number };
  const ret = db
    .prepare(
      `SELECT COALESCE(SUM(total_paisa),0) v FROM returns
        WHERE supplier_id = ? AND kind = 'purchase' AND status = 'completed'`,
    )
    .get(id) as { v: number };
  const bal = db.prepare('SELECT balance_paisa FROM suppliers WHERE id = ?').get(id) as { balance_paisa: number };
  return {
    total_purchase_paisa: pur.total,
    total_paid_paisa: paid.v,
    purchase_count: pur.c,
    last_purchase_at: pur.last,
    returns_paisa: ret.v,
    payable_paisa: bal?.balance_paisa ?? 0,
  };
}

export function getSupplier(db: Db, id: number): (Supplier & { stats: SupplierStats }) | null {
  const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as Supplier | undefined;
  if (!row) return null;
  return { ...row, stats: supplierStats(db, id) };
}

export interface SupplierInput {
  name: string;
  company?: string | null;
  phone?: string | null;
  address?: string | null;
  email?: string | null;
  contactPerson?: string | null;
  openingBalance?: number;
  note?: string | null;
}

function buildSearch(input: SupplierInput): string {
  return foldForSearch(
    [input.name, input.company ?? '', input.phone ?? '', input.email ?? '', input.contactPerson ?? ''].join(' '),
  );
}

export function createSupplier(db: Db, input: SupplierInput, actor?: Actor): Supplier {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const name = normalizeText(input.name);
    if (!name) throw new Error('সাপ্লায়ারের নাম দিতে হবে।');
    if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) throw new Error('ইমেইল ঠিকানা সঠিক নয়।');
    const now = nowLocal();
    const opening = Math.round(input.openingBalance ?? 0);
    const res = db
      .prepare(
        `INSERT INTO suppliers (name, name_sort, search_text, company, phone, address, email, contact_person,
           opening_balance_paisa, balance_paisa, note, is_active, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      )
      .run(
        name,
        bengaliSortKey(name),
        buildSearch(input),
        input.company ? normalizeText(input.company) : null,
        input.phone ? normalizeText(input.phone) : null,
        input.address ? normalizeText(input.address) : null,
        input.email ? normalizeText(input.email) : null,
        input.contactPerson ? normalizeText(input.contactPerson) : null,
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
      action: 'supplier.create',
      entity: 'supplier',
      entityId: id,
      details: { name, opening },
    });
    return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as Supplier;
  })();
}

export function updateSupplier(db: Db, id: number, input: SupplierInput, actor?: Actor): Supplier {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as Supplier | undefined;
    if (!existing) throw new Error('সাপ্লায়ার পাওয়া যায়নি।');
    const name = normalizeText(input.name) || existing.name;
    const opening = input.openingBalance === undefined ? existing.opening_balance_paisa : Math.round(input.openingBalance);
    const openingDelta = opening - existing.opening_balance_paisa;
    db.prepare(
      `UPDATE suppliers SET name = ?, name_sort = ?, search_text = ?, company = ?, phone = ?, address = ?, email = ?,
         contact_person = ?, opening_balance_paisa = ?, balance_paisa = balance_paisa + ?, note = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      name,
      bengaliSortKey(name),
      buildSearch(input),
      input.company ? normalizeText(input.company) : null,
      input.phone ? normalizeText(input.phone) : null,
      input.address ? normalizeText(input.address) : null,
      input.email ? normalizeText(input.email) : null,
      input.contactPerson ? normalizeText(input.contactPerson) : null,
      opening,
      openingDelta,
      input.note !== undefined ? normalizeText(input.note) : existing.note,
      nowLocal(),
      id,
    );
    audit(db, {
      userId: actor?.id ?? null,
      username: actor?.username,
      action: 'supplier.update',
      entity: 'supplier',
      entityId: id,
      details: { name, openingDelta },
    });
    return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as Supplier;
  })();
}

export function setSupplierActive(db: Db, id: number, active: boolean, actor?: Actor): void {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as Supplier | undefined;
    if (!row) throw new Error('সাপ্লায়ার পাওয়া যায়নি।');
    if (!active && row.balance_paisa > 0) throw new Error('পরিশোধযোগ্য বাকি থাকা অবস্থায় নিষ্ক্রিয় করা যাবে না।');
    db.prepare('UPDATE suppliers SET is_active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, nowLocal(), id);
    audit(db, {
      userId: actor?.id ?? null,
      username: actor?.username,
      action: active ? 'supplier.restore' : 'supplier.archive',
      entity: 'supplier',
      entityId: id,
    });
  })();
}

export function deleteSupplier(db: Db, id: number, actor?: Actor): void {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as Supplier | undefined;
    if (!row) throw new Error('সাপ্লায়ার পাওয়া যায়নি।');
    if (row.balance_paisa !== 0) throw new Error('বাকি থাকা অবস্থায় সাপ্লায়ার ডিলিট করা যাবে না।');
    const used =
      (db.prepare('SELECT COUNT(*) c FROM purchases WHERE supplier_id = ?').get(id) as { c: number }).c +
      (db.prepare('SELECT COUNT(*) c FROM payments WHERE supplier_id = ?').get(id) as { c: number }).c;
    if (used > 0) throw new Error('এই সাপ্লায়ারের লেনদেন আছে — ডিলিট করা যাবে না, আর্কাইভ করুন।');
    db.prepare('DELETE FROM suppliers WHERE id = ?').run(id);
    audit(db, { userId: actor?.id ?? null, username: actor?.username, action: 'supplier.delete', entity: 'supplier', entityId: id });
  })();
}

export function paySupplier(
  db: Db,
  input: {
    supplierId: number;
    amount: number;
    methodId: number;
    reference?: string | null;
    note?: string | null;
    date?: string;
  },
  actor: { id: number; username: string },
): { paymentId: number; newBalance: number } {
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(input.supplierId) as Supplier | undefined;
  if (!supplier) throw new Error('সাপ্লায়ার পাওয়া যায়নি।');
  const amount = Math.round(input.amount);
  if (amount <= 0) throw new Error('টাকার পরিমাণ ০ এর চেয়ে বড় হতে হবে।');
  const run = db.transaction(() => {
    const paymentId = insertPayment(db, {
      kind: 'supplier_payment',
      partyType: 'supplier',
      supplierId: input.supplierId,
      amount,
      methodId: input.methodId,
      reference: input.reference ?? null,
      note: input.note ?? null,
      userId: actor.id,
      date: input.date,
      direction: 'out',
      affectsBalance: true,
    });
    const bal = db.prepare('SELECT balance_paisa FROM suppliers WHERE id = ?').get(input.supplierId) as {
      balance_paisa: number;
    };
    audit(db, {
      userId: actor.id,
      username: actor.username,
      action: 'supplier.payment',
      entity: 'supplier',
      entityId: input.supplierId,
      details: { amount, paymentId, balanceAfter: bal.balance_paisa },
    });
    return { paymentId, newBalance: bal.balance_paisa };
  });
  return run();
}

export interface SupplierLedgerRow {
  date: string;
  type: 'purchase' | 'payment' | 'return' | 'refund' | 'opening';
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  method?: string | null;
}

export function supplierStatement(
  db: Db,
  supplierId: number,
  from?: string,
  to?: string,
): {
  supplier: Supplier;
  from: string | null;
  to: string | null;
  opening_balance: number;
  closing_balance: number;
  total_purchase: number;
  total_paid: number;
  rows: SupplierLedgerRow[];
} {
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId) as Supplier | undefined;
  if (!supplier) throw new Error('সাপ্লায়ার পাওয়া যায়নি।');
  const events: { at: string; row: Omit<SupplierLedgerRow, 'balance'> }[] = [];
  const purchases = db
    .prepare(
      `SELECT purchase_no, purchase_date, total_paisa, paid_paisa FROM purchases
        WHERE supplier_id = ? AND status <> 'voided'`,
    )
    .all(supplierId) as any[];
  for (const p of purchases) {
    events.push({
      at: p.purchase_date,
      row: {
        date: p.purchase_date,
        type: 'purchase',
        reference: p.purchase_no,
        description: `পারচেজ (মোট ৳${(p.total_paisa / 100).toFixed(2)})`,
        debit: 0,
        credit: p.total_paisa,
      },
    });
  }
  const payments = db
    .prepare(
      `SELECT pm.*, m.name AS method_name FROM payments pm LEFT JOIN payment_methods m ON m.id = pm.method_id
        WHERE pm.supplier_id = ? AND pm.status = 'active' AND pm.party_type = 'supplier'
          AND NOT (pm.kind IN ('purchase','purchase_reversal') AND pm.direction = 'out' AND pm.note IS NULL)`,
    )
    .all(supplierId) as any[];
  for (const p of payments) {
    if (p.kind === 'purchase') continue; // captured by the purchase document itself
    if (p.direction === 'out') {
      events.push({
        at: p.payment_date,
        row: {
          date: p.payment_date,
          type: 'payment',
          reference: p.reference || `PAY-${p.id}`,
          description: p.kind.includes('reversal') ? 'পেমেন্ট বাতিল' : 'সাপ্লায়ার পেমেন্ট',
          debit: p.amount_paisa,
          credit: 0,
          method: p.method_name,
        },
      });
    } else {
      events.push({
        at: p.payment_date,
        row: {
          date: p.payment_date,
          type: 'refund',
          reference: p.reference || `RFD-${p.id}`,
          description: 'সাপ্লায়ার অ্যাডভান্স',
          debit: 0,
          credit: p.amount_paisa,
          method: p.method_name,
        },
      });
    }
  }
  const returns = db
    .prepare(
      `SELECT return_no, return_date, total_paisa FROM returns
        WHERE supplier_id = ? AND kind = 'purchase' AND status = 'completed'`,
    )
    .all(supplierId) as any[];
  for (const r of returns) {
    events.push({
      at: r.return_date,
      row: {
        date: r.return_date,
        type: 'return',
        reference: r.return_no,
        description: 'পারচেজ রিটার্ন',
        debit: r.total_paisa,
        credit: 0,
      },
    });
  }
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  let opening = supplier.opening_balance_paisa;
  for (const e of events) {
    if (from && e.at.slice(0, 10) < from) opening += e.row.credit - e.row.debit;
  }
  let balance = opening;
  let totalPurchase = 0;
  let totalPaid = 0;
  const rows: SupplierLedgerRow[] = [];
  if (opening !== 0 && !from) {
    rows.push({
      date: supplier.created_at.slice(0, 10),
      type: 'opening',
      reference: '—',
      description: 'পূর্বের বাকি (ওপেনিং ব্যালেন্স)',
      debit: 0,
      credit: opening,
      balance: opening,
    });
  }
  for (const e of events) {
    const d = e.at.slice(0, 10);
    if (from && d < from) continue;
    if (to && d > to) continue;
    balance += e.row.credit - e.row.debit;
    if (e.row.type === 'purchase') totalPurchase += e.row.credit;
    if (e.row.type === 'payment') totalPaid += e.row.debit;
    rows.push({ ...e.row, balance });
  }
  return {
    supplier,
    from: from ?? null,
    to: to ?? null,
    opening_balance: opening,
    closing_balance: balance,
    total_purchase: totalPurchase,
    total_paid: totalPaid,
    rows,
  };
}

export function supplierCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) c FROM suppliers WHERE is_active = 1').get() as { c: number }).c;
}

export function totalPayablePaisa(db: Db): number {
  const row = db.prepare('SELECT COALESCE(SUM(balance_paisa),0) v FROM suppliers WHERE balance_paisa > 0').get() as {
    v: number;
  };
  return row.v;
}
