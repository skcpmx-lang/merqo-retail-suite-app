import type { Db } from '../db/connection.js';
import { nextCounter } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import { costValuePaisa } from '../domain/money.js';
import { audit } from './audit.js';

/**
 * Double-entry accounting.
 *
 * Design rules (see docs/12-ROADMAP-V101.md):
 *  1. The ledger is DERIVED from operational documents. Nothing is entered twice
 *     by hand and every auto-posting is idempotent — the unique index on
 *     (source, source_id) makes a second post of the same document impossible.
 *  2. Every entry must balance: sum(debit) === sum(credit) > 0. A posting that
 *     does not balance throws, which rolls the whole document back.
 *  3. Financial history is never edited. Corrections are reversing entries.
 */

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

/** Auto-posting can be switched off in settings; the operational data is unaffected. */
export function isPostingEnabled(db: Db): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'accounting_enabled'").get() as
    | { value: string }
    | undefined;
  return row ? row.value !== '0' : true;
}

export interface Account {
  id: number;
  code: string;
  name: string;
  name_bn: string;
  type: AccountType;
  parent_id: number | null;
  is_cash: number;
  is_bank: number;
  is_system: number;
  is_active: number;
  note: string | null;
  created_at: string;
}

export interface JournalLineInput {
  accountId?: number;
  code?: string;
  debit?: number;
  credit?: number;
  memo?: string;
}

export interface PostInput {
  date: string;
  source: string;
  sourceId?: number | null;
  memo?: string;
  lines: JournalLineInput[];
  userId?: number | null;
  /** When set, posting an already-posted (source, sourceId) is a no-op. */
  idempotent?: boolean;
}

export const ACCOUNT_CODES = {
  cash: '1000',
  bank: '1010',
  receivable: '1100',
  inventory: '1200',
  supplierAdvance: '1300',
  payable: '2000',
  customerAdvance: '2100',
  giftCard: '2150',
  taxPayable: '2200',
  equity: '3000',
  openingEquity: '3100',
  drawings: '3200',
  revenue: '4000',
  salesReturns: '4050',
  salesDiscount: '4100',
  otherIncome: '4200',
  inventoryGain: '4300',
  cogs: '5000',
  operatingExpense: '5100',
  purchaseReturns: '5200',
  inventoryLoss: '5300',
  miscExpense: '5900',
} as const;

/* ------------------------------------------------------------------ */
/* Chart of accounts                                                  */
/* ------------------------------------------------------------------ */

export function listAccounts(db: Db, opts: { activeOnly?: boolean } = {}): Account[] {
  const where = opts.activeOnly ? 'WHERE is_active = 1' : '';
  return db.prepare(`SELECT * FROM accounts ${where} ORDER BY code`).all() as Account[];
}

export function getAccountByCode(db: Db, code: string): Account {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code) as Account | undefined;
  if (!row) throw new Error(`হিসাব খাত পাওয়া যায়নি (${code})।`);
  return row;
}

export function accountIdByCode(db: Db, code: string): number {
  return getAccountByCode(db, code).id;
}

export interface AccountInput {
  code: string;
  name: string;
  nameBn?: string;
  type: AccountType;
  isCash?: boolean;
  isBank?: boolean;
  parentId?: number | null;
  note?: string | null;
}

export function createAccount(
  db: Db,
  input: AccountInput,
  actor?: { id: number; username: string } | null,
): Account {
  const code = (input.code ?? '').trim();
  if (!/^[0-9]{3,6}$/.test(code)) throw new Error('হিসাব কোড ৩–৬ সংখ্যার হতে হবে।');
  if (!input.name?.trim()) throw new Error('হিসাবের নাম দিতে হবে।');
  const exists = db.prepare('SELECT id FROM accounts WHERE code = ?').get(code);
  if (exists) throw new Error('এই কোডে আরেকটি হিসাব আছে।');
  const res = db
    .prepare(
      `INSERT INTO accounts (code, name, name_bn, type, parent_id, is_cash, is_bank, is_system, created_at)
       VALUES (?,?,?,?,?,?,?,0,?)`,
    )
    .run(
      code,
      input.name.trim(),
      input.nameBn?.trim() ?? '',
      input.type,
      input.parentId ?? null,
      input.isCash ? 1 : 0,
      input.isBank ? 1 : 0,
      nowLocal(),
    );
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username ?? 'system',
    action: 'accounting.account_create',
    entity: 'account',
    entityId: Number(res.lastInsertRowid),
    details: { code, name: input.name },
  });
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(res.lastInsertRowid) as Account;
}

export function updateAccount(
  db: Db,
  id: number,
  patch: { name?: string; nameBn?: string; note?: string | null; isActive?: boolean },
  actor?: { id: number; username: string } | null,
): Account {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Account | undefined;
  if (!row) throw new Error('হিসাব খাত পাওয়া যায়নি।');
  if (row.is_system === 1 && patch.isActive === false) {
    throw new Error('সিস্টেম হিসাব বন্ধ করা যাবে না।');
  }
  db.prepare('UPDATE accounts SET name = ?, name_bn = ?, note = ?, is_active = ? WHERE id = ?').run(
    patch.name?.trim() || row.name,
    patch.nameBn?.trim() ?? row.name_bn,
    patch.note === undefined ? row.note : patch.note,
    patch.isActive === undefined ? row.is_active : patch.isActive ? 1 : 0,
    id,
  );
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username ?? 'system',
    action: 'accounting.account_update',
    entity: 'account',
    entityId: id,
  });
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Account;
}

/** The account money lands in for a given payment method (cash vs bank/wallet). */
export function methodAccountId(db: Db, methodId: number | null | undefined): number {
  if (methodId) {
    const row = db.prepare('SELECT account_id, is_cash FROM payment_methods WHERE id = ?').get(methodId) as
      | { account_id: number | null; is_cash: number }
      | undefined;
    if (row?.account_id) return row.account_id;
    if (row) return accountIdByCode(db, row.is_cash === 1 ? ACCOUNT_CODES.cash : ACCOUNT_CODES.bank);
  }
  return accountIdByCode(db, ACCOUNT_CODES.cash);
}

/* ------------------------------------------------------------------ */
/* Posting                                                            */
/* ------------------------------------------------------------------ */

export interface JournalEntryRow {
  id: number;
  entry_no: string;
  entry_date: string;
  source: string;
  source_id: number | null;
  memo: string | null;
  status: 'posted' | 'reversed';
  reverses_id: number | null;
  user_id: number | null;
  created_at: string;
}

function nextEntryNo(db: Db): string {
  const seq = nextCounter(db, 'journal_entry');
  const d = nowLocal().slice(0, 7).replace('-', '');
  return `JV-${d}-${String(seq).padStart(5, '0')}`;
}

/**
 * Post one balanced journal entry. Throws (rolling back the caller's
 * transaction) if the lines do not balance — this is the guard that keeps the
 * books honest.
 */
export function postEntry(db: Db, input: PostInput): JournalEntryRow | null {
  const lines = input.lines
    .map((l) => ({
      accountId: l.accountId ?? (l.code ? accountIdByCode(db, l.code) : 0),
      debit: Math.round(l.debit ?? 0),
      credit: Math.round(l.credit ?? 0),
      memo: l.memo ?? null,
    }))
    .filter((l) => l.debit !== 0 || l.credit !== 0);

  if (!lines.length) return null;
  for (const l of lines) {
    if (!l.accountId) throw new Error('জার্নাল লাইনে হিসাব খাত নেই।');
    if (l.debit < 0 || l.credit < 0) throw new Error('জার্নালে ঋণাত্মক অঙ্ক চলবে না।');
    if (l.debit > 0 && l.credit > 0) throw new Error('একই লাইনে ডেবিট ও ক্রেডিট দুটোই চলবে না।');
  }
  const debitSum = lines.reduce((s, l) => s + l.debit, 0);
  const creditSum = lines.reduce((s, l) => s + l.credit, 0);
  if (debitSum !== creditSum) {
    throw new Error(`জার্নাল এন্ট্রি সমতুল্য নয় (ডেবিট ${debitSum} ≠ ক্রেডিট ${creditSum})।`);
  }
  if (debitSum === 0) return null;

  if (input.sourceId != null) {
    const existing = db
      .prepare('SELECT * FROM journal_entries WHERE source = ? AND source_id = ?')
      .get(input.source, input.sourceId) as JournalEntryRow | undefined;
    if (existing) {
      if (input.idempotent) return existing;
      throw new Error('এই ডকুমেন্টের হিসাব আগেই পোস্ট করা হয়েছে।');
    }
  }

  const res = db
    .prepare(
      `INSERT INTO journal_entries (entry_no, entry_date, source, source_id, memo, status, user_id, created_at)
       VALUES (?,?,?,?,?,'posted',?,?)`,
    )
    .run(
      nextEntryNo(db),
      input.date,
      input.source,
      input.sourceId ?? null,
      input.memo ?? null,
      input.userId ?? null,
      nowLocal(),
    );
  const entryId = Number(res.lastInsertRowid);
  const insertLine = db.prepare(
    'INSERT INTO journal_lines (entry_id, account_id, debit_paisa, credit_paisa, memo, line_no) VALUES (?,?,?,?,?,?)',
  );
  lines.forEach((l, i) => insertLine.run(entryId, l.accountId, l.debit, l.credit, l.memo, i + 1));
  return db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(entryId) as JournalEntryRow;
}

/** Reversing entry for an existing document entry (used by voids). */
export function reverseDocument(
  db: Db,
  source: string,
  sourceId: number,
  opts: { date?: string; memo?: string; userId?: number | null; reversalSource?: string } = {},
): JournalEntryRow | null {
  const original = db
    .prepare('SELECT * FROM journal_entries WHERE source = ? AND source_id = ?')
    .get(source, sourceId) as JournalEntryRow | undefined;
  if (!original) return null;
  const reversalSource = opts.reversalSource ?? `${source}_void`;
  const already = db
    .prepare('SELECT id FROM journal_entries WHERE source = ? AND source_id = ?')
    .get(reversalSource, sourceId);
  if (already) return null;

  const lines = db.prepare('SELECT * FROM journal_lines WHERE entry_id = ?').all(original.id) as {
    account_id: number;
    debit_paisa: number;
    credit_paisa: number;
    memo: string | null;
  }[];
  const entry = postEntry(db, {
    date: opts.date ?? nowLocal(),
    source: reversalSource,
    sourceId,
    memo: opts.memo ?? `বাতিল: ${original.entry_no}`,
    userId: opts.userId ?? null,
    lines: lines.map((l) => ({
      accountId: l.account_id,
      debit: l.credit_paisa,
      credit: l.debit_paisa,
      memo: l.memo ?? undefined,
    })),
  });
  if (entry) {
    db.prepare("UPDATE journal_entries SET status = 'reversed' WHERE id = ?").run(original.id);
    db.prepare('UPDATE journal_entries SET reverses_id = ? WHERE id = ?').run(original.id, entry.id);
  }
  return entry;
}

/* ------------------------------------------------------------------ */
/* Document postings                                                  */
/* ------------------------------------------------------------------ */

interface SaleRow {
  id: number;
  invoice_no: string;
  sale_date: string;
  subtotal_paisa: number;
  discount_paisa: number;
  tax_paisa: number;
  total_paisa: number;
  paid_paisa: number;
  due_paisa: number;
  cost_total_paisa: number;
  customer_id: number | null;
  user_id: number | null;
}

/** Cash/bank split of a sale from its tenders (or a single fallback method). */
function tenderSplit(
  db: Db,
  saleId: number,
  paid: number,
  fallbackMethodId: number | null,
): Map<number, number> {
  const out = new Map<number, number>();
  const payments = db
    .prepare(
      `SELECT method_id, SUM(amount_paisa) AS amount FROM payments
       WHERE sale_id = ? AND status = 'active' AND direction = 'in' GROUP BY method_id`,
    )
    .all(saleId) as { method_id: number | null; amount: number }[];
  for (const p of payments) {
    if (!p.amount) continue;
    const acc = methodAccountId(db, p.method_id);
    out.set(acc, (out.get(acc) ?? 0) + p.amount);
  }
  const sum = [...out.values()].reduce((a, b) => a + b, 0);
  if (sum < paid && paid > 0) {
    const acc = methodAccountId(db, fallbackMethodId);
    out.set(acc, (out.get(acc) ?? 0) + (paid - sum));
  }
  return out;
}

export function postSale(db: Db, saleId: number, opts: { idempotent?: boolean } = {}): JournalEntryRow | null {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId) as SaleRow | undefined;
  if (!sale) return null;
  const lines: JournalLineInput[] = [];

  const paidCash = tenderSplit(db, sale.id, sale.paid_paisa, null);
  for (const [accountId, amount] of paidCash) lines.push({ accountId, debit: amount, memo: sale.invoice_no });
  if (sale.due_paisa > 0) {
    lines.push({ accountId: accountIdByCode(db, ACCOUNT_CODES.receivable), debit: sale.due_paisa, memo: 'বাকি' });
  }
  if (sale.discount_paisa > 0) {
    lines.push({
      accountId: accountIdByCode(db, ACCOUNT_CODES.salesDiscount),
      debit: sale.discount_paisa,
      memo: 'ডিসকাউন্ট',
    });
  }
  lines.push({ accountId: accountIdByCode(db, ACCOUNT_CODES.revenue), credit: sale.subtotal_paisa, memo: 'বিক্রয়' });
  if (sale.tax_paisa > 0) {
    lines.push({ accountId: accountIdByCode(db, ACCOUNT_CODES.taxPayable), credit: sale.tax_paisa, memo: 'ভ্যাট' });
  }
  if (sale.cost_total_paisa > 0) {
    lines.push({ accountId: accountIdByCode(db, ACCOUNT_CODES.cogs), debit: sale.cost_total_paisa, memo: 'COGS' });
    lines.push({
      accountId: accountIdByCode(db, ACCOUNT_CODES.inventory),
      credit: sale.cost_total_paisa,
      memo: 'স্টক বহির্গমন',
    });
  }

  return postEntry(db, {
    date: sale.sale_date,
    source: 'sale',
    sourceId: sale.id,
    memo: `বিক্রয় ${sale.invoice_no}`,
    userId: sale.user_id,
    lines,
    idempotent: opts.idempotent ?? true,
  });
}

interface PurchaseRow {
  id: number;
  purchase_no: string;
  purchase_date: string;
  subtotal_paisa: number;
  discount_paisa: number;
  other_cost_paisa: number;
  total_paisa: number;
  paid_paisa: number;
  due_paisa: number;
  supplier_id: number | null;
  user_id: number | null;
}

export function postPurchase(
  db: Db,
  purchaseId: number,
  opts: { idempotent?: boolean } = {},
): JournalEntryRow | null {
  const p = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId) as PurchaseRow | undefined;
  if (!p) return null;
  const lines: JournalLineInput[] = [];
  lines.push({ accountId: accountIdByCode(db, ACCOUNT_CODES.inventory), debit: p.total_paisa, memo: 'স্টক আগমন' });
  if (p.due_paisa > 0) {
    lines.push({ accountId: accountIdByCode(db, ACCOUNT_CODES.payable), credit: p.due_paisa, memo: 'পাওনা' });
  }
  if (p.paid_paisa > 0) {
    const payments = db
      .prepare(
        `SELECT method_id, SUM(amount_paisa) AS amount FROM payments
         WHERE purchase_id = ? AND status = 'active' AND direction = 'out' GROUP BY method_id`,
      )
      .all(p.id) as { method_id: number | null; amount: number }[];
    let counted = 0;
    for (const pay of payments) {
      if (!pay.amount) continue;
      counted += pay.amount;
      lines.push({ accountId: methodAccountId(db, pay.method_id), credit: pay.amount, memo: 'পরিশোধ' });
    }
    if (counted < p.paid_paisa) {
      lines.push({
        accountId: methodAccountId(db, null),
        credit: p.paid_paisa - counted,
        memo: 'পরিশোধ',
      });
    }
  }
  return postEntry(db, {
    date: p.purchase_date,
    source: 'purchase',
    sourceId: p.id,
    memo: `ক্রয় ${p.purchase_no}`,
    userId: p.user_id,
    lines,
    idempotent: opts.idempotent ?? true,
  });
}

export function postPayment(db: Db, paymentId: number, opts: { idempotent?: boolean } = {}): JournalEntryRow | null {
  const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as
    | {
        id: number;
        amount_paisa: number;
        direction: 'in' | 'out';
        method_id: number | null;
        customer_id: number | null;
        supplier_id: number | null;
        sale_id: number | null;
        purchase_id: number | null;
        payment_date: string;
        user_id: number | null;
        status: string;
        reverses_id: number | null;
      }
    | undefined;
  if (!pay || pay.status !== 'active') return null;
  // Reversal rows are represented by reversing the original entry instead.
  if (pay.reverses_id != null) return null;
  // A tender that belongs to a sale/purchase is already inside that document's
  // entry; posting again would double count the cash.
  if (pay.sale_id != null || pay.purchase_id != null) return null;

  const money = methodAccountId(db, pay.method_id);
  const lines: JournalLineInput[] = [];
  if (pay.direction === 'in') {
    lines.push({ accountId: money, debit: pay.amount_paisa, memo: 'আদায়' });
    const customer = pay.customer_id
      ? (db.prepare('SELECT balance_paisa FROM customers WHERE id = ?').get(pay.customer_id) as
          | { balance_paisa: number }
          | undefined)
      : undefined;
    // Balance after the collection: anything beyond the due becomes an advance.
    const dueBefore = customer?.balance_paisa ?? 0;
    const againstDue = Math.max(0, Math.min(pay.amount_paisa, dueBefore));
    const advance = pay.amount_paisa - againstDue;
    if (againstDue > 0) {
      lines.push({ accountId: accountIdByCode(db, ACCOUNT_CODES.receivable), credit: againstDue, memo: 'বাকি পরিশোধ' });
    }
    if (advance > 0) {
      lines.push({ accountId: accountIdByCode(db, ACCOUNT_CODES.customerAdvance), credit: advance, memo: 'অগ্রিম' });
    }
    if (againstDue === 0 && advance === 0) {
      lines.push({ accountId: accountIdByCode(db, ACCOUNT_CODES.receivable), credit: pay.amount_paisa });
    }
  } else {
    const supplier = pay.supplier_id
      ? (db.prepare('SELECT balance_paisa FROM suppliers WHERE id = ?').get(pay.supplier_id) as
          | { balance_paisa: number }
          | undefined)
      : undefined;
    const dueBefore = supplier?.balance_paisa ?? 0;
    const againstDue = Math.max(0, Math.min(pay.amount_paisa, dueBefore));
    const advance = pay.amount_paisa - againstDue;
    if (againstDue > 0) {
      lines.push({ accountId: accountIdByCode(db, ACCOUNT_CODES.payable), debit: againstDue, memo: 'পাওনা পরিশোধ' });
    }
    if (advance > 0) {
      lines.push({ accountId: accountIdByCode(db, ACCOUNT_CODES.supplierAdvance), debit: advance, memo: 'অগ্রিম' });
    }
    if (againstDue === 0 && advance === 0) {
      lines.push({ accountId: accountIdByCode(db, ACCOUNT_CODES.payable), debit: pay.amount_paisa });
    }
    lines.push({ accountId: money, credit: pay.amount_paisa, memo: 'পরিশোধ' });
  }
  return postEntry(db, {
    date: pay.payment_date,
    source: pay.direction === 'in' ? 'payment_in' : 'payment_out',
    sourceId: pay.id,
    memo: pay.direction === 'in' ? 'কাস্টমার পেমেন্ট' : 'সাপ্লায়ার পেমেন্ট',
    userId: pay.user_id,
    lines,
    idempotent: opts.idempotent ?? true,
  });
}

export function postExpense(db: Db, expenseId: number, opts: { idempotent?: boolean } = {}): JournalEntryRow | null {
  const exp = db.prepare('SELECT * FROM expenses WHERE id = ?').get(expenseId) as
    | {
        id: number;
        amount_paisa: number;
        method_id: number | null;
        category_id: number | null;
        description: string;
        expense_date: string;
        user_id: number | null;
        status: string;
      }
    | undefined;
  if (!exp || exp.status !== 'active') return null;
  const categoryAccount = exp.category_id
    ? (db.prepare('SELECT account_id FROM expense_categories WHERE id = ?').get(exp.category_id) as
        | { account_id: number | null }
        | undefined)
    : undefined;
  const expenseAccount =
    categoryAccount?.account_id ?? accountIdByCode(db, ACCOUNT_CODES.operatingExpense);
  return postEntry(db, {
    date: exp.expense_date,
    source: 'expense',
    sourceId: exp.id,
    memo: `খরচ: ${exp.description}`.slice(0, 160),
    userId: exp.user_id,
    lines: [
      { accountId: expenseAccount, debit: exp.amount_paisa, memo: exp.description.slice(0, 80) },
      { accountId: methodAccountId(db, exp.method_id), credit: exp.amount_paisa, memo: 'পরিশোধ' },
    ],
    idempotent: opts.idempotent ?? true,
  });
}

interface ReturnRow {
  id: number;
  return_no: string;
  kind: 'sale' | 'purchase';
  return_date: string;
  total_paisa: number;
  cost_total_paisa: number;
  refund_paisa: number;
  refund_method_id: number | null;
  restock: number;
  user_id: number | null;
  status: string;
}

export function postSaleReturn(
  db: Db,
  returnId: number,
  opts: { idempotent?: boolean } = {},
): JournalEntryRow | null {
  const r = db.prepare('SELECT * FROM returns WHERE id = ?').get(returnId) as ReturnRow | undefined;
  if (!r || r.kind !== 'sale') return null;
  const lines: JournalLineInput[] = [
    { accountId: accountIdByCode(db, ACCOUNT_CODES.salesReturns), debit: r.total_paisa, memo: 'ফেরত' },
  ];
  const toCustomer = r.total_paisa - r.refund_paisa;
  if (toCustomer > 0) {
    lines.push({ accountId: accountIdByCode(db, ACCOUNT_CODES.receivable), credit: toCustomer, memo: 'বাকি সমন্বয়' });
  }
  if (r.refund_paisa > 0) {
    lines.push({ accountId: methodAccountId(db, r.refund_method_id), credit: r.refund_paisa, memo: 'ফেরত প্রদান' });
  }
  if (r.cost_total_paisa > 0) {
    if (r.restock === 1) {
      lines.push({ accountId: accountIdByCode(db, ACCOUNT_CODES.inventory), debit: r.cost_total_paisa });
    } else {
      lines.push({ accountId: accountIdByCode(db, ACCOUNT_CODES.inventoryLoss), debit: r.cost_total_paisa });
    }
    lines.push({ accountId: accountIdByCode(db, ACCOUNT_CODES.cogs), credit: r.cost_total_paisa, memo: 'COGS ফেরত' });
  }
  return postEntry(db, {
    date: r.return_date,
    source: 'return_sale',
    sourceId: r.id,
    memo: `বিক্রয় ফেরত ${r.return_no}`,
    userId: r.user_id,
    lines,
    idempotent: opts.idempotent ?? true,
  });
}

export function postPurchaseReturn(
  db: Db,
  returnId: number,
  opts: { idempotent?: boolean } = {},
): JournalEntryRow | null {
  const r = db.prepare('SELECT * FROM returns WHERE id = ?').get(returnId) as ReturnRow | undefined;
  if (!r || r.kind !== 'purchase') return null;
  const lines: JournalLineInput[] = [];
  const fromSupplier = r.total_paisa - r.refund_paisa;
  if (fromSupplier > 0) {
    lines.push({ accountId: accountIdByCode(db, ACCOUNT_CODES.payable), debit: fromSupplier, memo: 'পাওনা সমন্বয়' });
  }
  if (r.refund_paisa > 0) {
    lines.push({ accountId: methodAccountId(db, r.refund_method_id), debit: r.refund_paisa, memo: 'ফেরত গ্রহণ' });
  }
  lines.push({ accountId: accountIdByCode(db, ACCOUNT_CODES.inventory), credit: r.total_paisa, memo: 'স্টক ফেরত' });
  return postEntry(db, {
    date: r.return_date,
    source: 'return_purchase',
    sourceId: r.id,
    memo: `ক্রয় ফেরত ${r.return_no}`,
    userId: r.user_id,
    lines,
    idempotent: opts.idempotent ?? true,
  });
}

/** Manual cash in/out (drawer top-up, owner withdrawal, misc income). */
export function postCashMovement(
  db: Db,
  movementId: number,
  opts: { idempotent?: boolean } = {},
): JournalEntryRow | null {
  const mv = db.prepare('SELECT * FROM cash_movements WHERE id = ?').get(movementId) as
    | {
        id: number;
        direction: 'in' | 'out';
        amount_paisa: number;
        source: string;
        note: string | null;
        user_id: number | null;
        created_at: string;
      }
    | undefined;
  if (!mv) return null;
  // Document-driven movements are already inside their document's entry.
  const derived = ['sale', 'payment', 'expense', 'return', 'refund', 'purchase'];
  if (derived.includes(mv.source)) return null;

  const cash = accountIdByCode(db, ACCOUNT_CODES.cash);
  const other = mv.source === 'income' ? accountIdByCode(db, ACCOUNT_CODES.otherIncome) : accountIdByCode(db, ACCOUNT_CODES.equity);
  const lines: JournalLineInput[] =
    mv.direction === 'in'
      ? [
          { accountId: cash, debit: mv.amount_paisa, memo: mv.note ?? 'ক্যাশ ইন' },
          { accountId: other, credit: mv.amount_paisa },
        ]
      : [
          { accountId: accountIdByCode(db, ACCOUNT_CODES.drawings), debit: mv.amount_paisa, memo: mv.note ?? 'ক্যাশ আউট' },
          { accountId: cash, credit: mv.amount_paisa },
        ];
  return postEntry(db, {
    date: mv.created_at,
    source: mv.direction === 'in' ? 'cash_in' : 'cash_out',
    sourceId: mv.id,
    memo: mv.note ?? (mv.direction === 'in' ? 'ক্যাশ ইন' : 'ক্যাশ আউট'),
    userId: mv.user_id,
    lines,
    idempotent: opts.idempotent ?? true,
  });
}

/** Stock adjustment / damage / expiry: value the loss or gain in the books. */
export function postStockAdjustment(
  db: Db,
  input: {
    sourceId?: number;
    productId: number;
    deltaBaseMilli: number;
    costMicro: number;
    date?: string;
    userId?: number | null;
    reason?: string;
  },
): JournalEntryRow | null {
  if (input.deltaBaseMilli === 0) return null;
  // costMicro is micro-poisa per BASE unit and quantities are milli units, so the
  // paisa value is qty × cost / (1000 × 1e6) — use the shared money helper instead
  // of re-deriving the scale (a wrong divisor puts the books 1000× off).
  const value = costValuePaisa(Math.abs(input.deltaBaseMilli), Math.max(0, input.costMicro));
  if (value === 0) return null;
  const inventory = accountIdByCode(db, ACCOUNT_CODES.inventory);
  const lines: JournalLineInput[] =
    input.deltaBaseMilli < 0
      ? [
          { accountId: accountIdByCode(db, ACCOUNT_CODES.inventoryLoss), debit: value, memo: input.reason ?? 'স্টক ঘাটতি' },
          { accountId: inventory, credit: value },
        ]
      : [
          { accountId: inventory, debit: value },
          { accountId: accountIdByCode(db, ACCOUNT_CODES.inventoryGain), credit: value, memo: input.reason ?? 'স্টক উদ্বৃত্ত' },
        ];
  return postEntry(db, {
    date: input.date ?? nowLocal(),
    source: 'stock_adjust',
    sourceId: input.sourceId ?? nextCounter(db, 'stock_adjustment'),
    memo: `${input.reason ?? 'স্টক সমন্বয়'} (#${input.productId})`,
    userId: input.userId ?? null,
    lines,
    idempotent: true,
  });
}

/** Opening stock / opening balances belong to the opening equity account. */
export function postOpeningBalance(
  db: Db,
  input: {
    source: string;
    sourceId: number;
    amount: number;
    kind: 'asset' | 'liability';
    date?: string;
    memo?: string;
  },
): JournalEntryRow | null {
  if (input.amount === 0) return null;
  const opening = accountIdByCode(db, ACCOUNT_CODES.openingEquity);
  const lines: JournalLineInput[] =
    input.kind === 'asset'
      ? [
          { accountId: accountIdByCode(db, ACCOUNT_CODES.inventory), debit: input.amount },
          { accountId: opening, credit: input.amount },
        ]
      : [
          { accountId: opening, debit: input.amount },
          { accountId: accountIdByCode(db, ACCOUNT_CODES.payable), credit: input.amount },
        ];
  return postEntry(db, {
    date: input.date ?? nowLocal(),
    source: input.source,
    sourceId: input.sourceId,
    memo: input.memo ?? 'প্রারম্ভিক ব্যালেন্স',
    lines,
    idempotent: true,
  });
}

/* ------------------------------------------------------------------ */
/* Reports                                                            */
/* ------------------------------------------------------------------ */

export interface TrialBalanceRow {
  account_id: number;
  code: string;
  name: string;
  name_bn: string;
  type: AccountType;
  debit: number;
  credit: number;
  balance: number;
}

function sumByAccount(db: Db, from: string, to: string): Map<number, { debit: number; credit: number }> {
  const rows = db
    .prepare(
      `SELECT l.account_id, SUM(l.debit_paisa) AS debit, SUM(l.credit_paisa) AS credit
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.entry_date >= ? AND e.entry_date <= ?
       GROUP BY l.account_id`,
    )
    .all(from, to) as { account_id: number; debit: number; credit: number }[];
  return new Map(rows.map((r) => [r.account_id, { debit: r.debit ?? 0, credit: r.credit ?? 0 }]));
}

const FAR_FUTURE = '9999-12-31 23:59:59';
const FAR_PAST = '0000-01-01 00:00:00';

export function trialBalance(db: Db, range: { from?: string; to?: string } = {}): {
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
} {
  const from = range.from ?? FAR_PAST;
  const to = range.to ?? FAR_FUTURE;
  const sums = sumByAccount(db, from, to);
  const accounts = listAccounts(db);
  const rows: TrialBalanceRow[] = accounts
    .map((a) => {
      const s = sums.get(a.id) ?? { debit: 0, credit: 0 };
      return {
        account_id: a.id,
        code: a.code,
        name: a.name,
        name_bn: a.name_bn,
        type: a.type,
        debit: s.debit,
        credit: s.credit,
        balance: s.debit - s.credit,
      };
    })
    .filter((r) => r.debit !== 0 || r.credit !== 0);
  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  return { rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}

export interface ProfitAndLoss {
  from: string;
  to: string;
  income: { code: string; name: string; nameBn: string; amount: number }[];
  expenses: { code: string; name: string; nameBn: string; amount: number }[];
  totalIncome: number;
  totalExpense: number;
  grossProfit: number;
  netProfit: number;
  sales: number;
  cogs: number;
}

export function profitAndLoss(db: Db, range: { from: string; to: string }): ProfitAndLoss {
  const sums = sumByAccount(db, range.from, range.to);
  const accounts = listAccounts(db);
  const income: ProfitAndLoss['income'] = [];
  const expenses: ProfitAndLoss['expenses'] = [];
  let totalIncome = 0;
  let totalExpense = 0;
  for (const a of accounts) {
    const s = sums.get(a.id);
    if (!s) continue;
    if (a.type === 'income') {
      const amount = s.credit - s.debit; // contra-income accounts (discount/returns) reduce
      if (amount !== 0) {
        income.push({ code: a.code, name: a.name, nameBn: a.name_bn, amount });
        totalIncome += amount;
      }
    } else if (a.type === 'expense') {
      const amount = s.debit - s.credit;
      if (amount !== 0) {
        expenses.push({ code: a.code, name: a.name, nameBn: a.name_bn, amount });
        totalExpense += amount;
      }
    }
  }
  const byCode = (code: string) => {
    const s = sums.get(accountIdByCode(db, code)) ?? { debit: 0, credit: 0 };
    return { debit: s.debit, credit: s.credit };
  };
  const revenue = byCode(ACCOUNT_CODES.revenue);
  const salesReturns = byCode(ACCOUNT_CODES.salesReturns);
  const salesDiscount = byCode(ACCOUNT_CODES.salesDiscount);
  const cogs = byCode(ACCOUNT_CODES.cogs);
  const salesNet = revenue.credit - revenue.debit - salesReturns.debit - salesDiscount.debit;
  const grossProfit = salesNet - (cogs.debit - cogs.credit);
  return {
    from: range.from,
    to: range.to,
    income,
    expenses,
    totalIncome,
    totalExpense,
    grossProfit,
    netProfit: totalIncome - totalExpense,
    sales: salesNet,
    cogs: cogs.debit - cogs.credit,
  };
}

export interface BalanceSheetSection {
  code: string;
  name: string;
  nameBn: string;
  amount: number;
}

export function balanceSheet(db: Db, asOf: string): {
  assets: BalanceSheetSection[];
  liabilities: BalanceSheetSection[];
  equity: BalanceSheetSection[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  retainedEarnings: number;
  balanced: boolean;
  difference: number;
} {
  const sums = sumByAccount(db, FAR_PAST, asOf);
  const accounts = listAccounts(db);
  const assets: BalanceSheetSection[] = [];
  const liabilities: BalanceSheetSection[] = [];
  const equity: BalanceSheetSection[] = [];
  let totalAssets = 0;
  let totalLiabilities = 0;
  let totalEquity = 0;
  let retained = 0;

  for (const a of accounts) {
    const s = sums.get(a.id);
    if (!s) continue;
    if (a.type === 'asset') {
      const amount = s.debit - s.credit;
      if (amount !== 0) {
        assets.push({ code: a.code, name: a.name, nameBn: a.name_bn, amount });
        totalAssets += amount;
      }
    } else if (a.type === 'liability') {
      const amount = s.credit - s.debit;
      if (amount !== 0) {
        liabilities.push({ code: a.code, name: a.name, nameBn: a.name_bn, amount });
        totalLiabilities += amount;
      }
    } else if (a.type === 'equity') {
      const amount = s.credit - s.debit;
      if (amount !== 0) {
        equity.push({ code: a.code, name: a.name, nameBn: a.name_bn, amount });
        totalEquity += amount;
      }
    } else if (a.type === 'income') {
      retained += s.credit - s.debit;
    } else if (a.type === 'expense') {
      retained -= s.debit - s.credit;
    }
  }
  // Current-period profit is presented inside equity as retained earnings.
  const equityWithProfit = totalEquity + retained;
  return {
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity: equityWithProfit,
    retainedEarnings: retained,
    balanced: totalAssets === totalLiabilities + equityWithProfit,
    difference: totalAssets - (totalLiabilities + equityWithProfit),
  };
}

export interface LedgerRow {
  entry_id: number;
  entry_no: string;
  entry_date: string;
  memo: string | null;
  source: string;
  debit: number;
  credit: number;
  running: number;
}

export function generalLedger(
  db: Db,
  accountId: number,
  range: { from?: string; to?: string; limit?: number } = {},
): { account: Account; opening: number; rows: LedgerRow[]; closing: number; totalDebit: number; totalCredit: number } {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as Account | undefined;
  if (!account) throw new Error('হিসাব খাত পাওয়া যায়নি।');
  const from = range.from ?? FAR_PAST;
  const to = range.to ?? FAR_FUTURE;
  const normalDebit = account.type === 'asset' || account.type === 'expense';

  const openingRow = db
    .prepare(
      `SELECT COALESCE(SUM(l.debit_paisa),0) AS debit, COALESCE(SUM(l.credit_paisa),0) AS credit
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = ? AND e.entry_date < ?`,
    )
    .get(accountId, from) as { debit: number; credit: number };
  let running = normalDebit ? openingRow.debit - openingRow.credit : openingRow.credit - openingRow.debit;
  const opening = running;

  const raw = db
    .prepare(
      `SELECT e.id AS entry_id, e.entry_no, e.entry_date, COALESCE(l.memo, e.memo) AS memo, e.source,
              l.debit_paisa AS debit, l.credit_paisa AS credit
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = ? AND e.entry_date >= ? AND e.entry_date <= ?
       ORDER BY e.entry_date, e.id, l.line_no
       ${range.limit ? 'LIMIT ' + Math.max(1, Math.floor(range.limit)) : ''}`,
    )
    .all(accountId, from, to) as Omit<LedgerRow, 'running'>[];

  const rows: LedgerRow[] = raw.map((r) => {
    const delta = normalDebit ? r.debit - r.credit : r.credit - r.debit;
    running += delta;
    return { ...r, running };
  });
  return {
    account,
    opening,
    rows,
    closing: running,
    totalDebit: rows.reduce((s, r) => s + r.debit, 0),
    totalCredit: rows.reduce((s, r) => s + r.credit, 0),
  };
}

export function journalEntries(
  db: Db,
  range: { from?: string; to?: string; source?: string; limit?: number } = {},
): {
  id: number;
  entry_no: string;
  entry_date: string;
  source: string;
  source_id: number | null;
  memo: string | null;
  status: string;
  total: number;
  lines: { code: string; name: string; debit: number; credit: number }[];
}[] {
  const where: string[] = ['e.entry_date >= ?', 'e.entry_date <= ?'];
  const params: unknown[] = [range.from ?? FAR_PAST, range.to ?? FAR_FUTURE];
  if (range.source) {
    where.push('e.source = ?');
    params.push(range.source);
  }
  const entries = db
    .prepare(
      `SELECT e.* FROM journal_entries e WHERE ${where.join(' AND ')}
       ORDER BY e.entry_date DESC, e.id DESC LIMIT ?`,
    )
    .all(...params, Math.max(1, Math.min(range.limit ?? 200, 2000))) as JournalEntryRow[];
  const lineStmt = db.prepare(
    `SELECT a.code, a.name, l.debit_paisa, l.credit_paisa FROM journal_lines l
     JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.line_no`,
  );
  return entries.map((e) => {
    const lines = lineStmt.all(e.id) as { code: string; name: string; debit_paisa: number; credit_paisa: number }[];
    return {
      id: e.id,
      entry_no: e.entry_no,
      entry_date: e.entry_date,
      source: e.source,
      source_id: e.source_id,
      memo: e.memo,
      status: e.status,
      total: lines.reduce((s, l) => s + l.debit_paisa, 0),
      lines: lines.map((l) => ({ code: l.code, name: l.name, debit: l.debit_paisa, credit: l.credit_paisa })),
    };
  });
}

/** Cash + bank book: every movement through cash-type or bank-type accounts. */
export function cashBook(db: Db, range: { from: string; to: string }): {
  accounts: { id: number; code: string; name: string; opening: number; in: number; out: number; closing: number }[];
  total: { opening: number; in: number; out: number; closing: number };
} {
  const moneyAccounts = listAccounts(db).filter((a) => a.is_cash === 1 || a.is_bank === 1);
  const accounts = moneyAccounts.map((a) => {
    const ledger = generalLedger(db, a.id, range);
    const rowsIn = ledger.rows.reduce((s, r) => s + r.debit, 0);
    const rowsOut = ledger.rows.reduce((s, r) => s + r.credit, 0);
    return {
      id: a.id,
      code: a.code,
      name: a.name_bn || a.name,
      opening: ledger.opening,
      in: rowsIn,
      out: rowsOut,
      closing: ledger.closing,
    };
  });
  return {
    accounts,
    total: {
      opening: accounts.reduce((s, a) => s + a.opening, 0),
      in: accounts.reduce((s, a) => s + a.in, 0),
      out: accounts.reduce((s, a) => s + a.out, 0),
      closing: accounts.reduce((s, a) => s + a.closing, 0),
    },
  };
}

/** Day book: every entry of one business day, in posting order. */
export function dayBook(db: Db, date: string) {
  return journalEntries(db, { from: `${date} 00:00:00`, to: `${date} 23:59:59`, limit: 500 });
}

/* ------------------------------------------------------------------ */
/* Integrity checks                                                   */
/* ------------------------------------------------------------------ */

/** Every entry must balance. Returns the offenders (should always be empty). */
export function unbalancedEntries(db: Db): { entry_id: number; entry_no: string; debit: number; credit: number }[] {
  return db
    .prepare(
      `SELECT l.entry_id, e.entry_no, SUM(l.debit_paisa) AS debit, SUM(l.credit_paisa) AS credit
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       GROUP BY l.entry_id HAVING SUM(l.debit_paisa) <> SUM(l.credit_paisa)`,
    )
    .all() as { entry_id: number; entry_no: string; debit: number; credit: number }[];
}

export interface ReconciliationResult {
  ok: boolean;
  check: string;
  ledger: number;
  operational: number;
  difference: number;
}

/**
 * Cross-check the ledger against the operational tables it derives from.
 * Used by the test suite after every workflow and by the diagnostics screen.
 */
export function reconcile(db: Db, range: { from?: string; to?: string } = {}): ReconciliationResult[] {
  const from = range.from ?? FAR_PAST;
  const to = range.to ?? FAR_FUTURE;
  const results: ReconciliationResult[] = [];
  const jeSum = db.prepare(
    'SELECT COALESCE(SUM(debit_paisa),0) AS d, COALESCE(SUM(credit_paisa),0) AS c FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.entry_date >= ? AND e.entry_date <= ?',
  );

  const push = (check: string, ledger: number, operational: number) => {
    results.push({ ok: ledger === operational, check, ledger, operational, difference: ledger - operational });
  };

  // 1. Revenue = sales subtotal (ex-VAT) inside the range, minus nothing.
  const revenue = db
    .prepare(
      `SELECT COALESCE(SUM(l.credit_paisa - l.debit_paisa),0) AS v FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
       WHERE a.code = ? AND e.entry_date >= ? AND e.entry_date <= ?`,
    )
    .get(ACCOUNT_CODES.revenue, from, to) as { v: number };
  const salesSubtotal = db
    .prepare(
      `SELECT COALESCE(SUM(subtotal_paisa),0) AS v FROM sales
        WHERE status <> 'voided' AND sale_date >= ? AND sale_date <= ?`,
    )
    .get(from, to) as { v: number };
  push('বিক্রয় আয় বনাম বিক্রয় সাবটোটাল', revenue.v, salesSubtotal.v);

  // 2. COGS = cost of goods sold on sales.
  const cogs = db
    .prepare(
      `SELECT COALESCE(SUM(l.debit_paisa - l.credit_paisa),0) AS v FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
       WHERE a.code = ? AND e.entry_date >= ? AND e.entry_date <= ?`,
    )
    .get(ACCOUNT_CODES.cogs, from, to) as { v: number };
  const cost = db
    .prepare(
      `SELECT COALESCE(SUM(cost_total_paisa),0) AS v FROM sales
        WHERE status <> 'voided' AND sale_date >= ? AND sale_date <= ?`,
    )
    .get(from, to) as { v: number };
  const returnedCost = db
    .prepare(
      `SELECT COALESCE(SUM(cost_total_paisa),0) AS v FROM returns
       WHERE kind = 'sale' AND status = 'completed' AND return_date >= ? AND return_date <= ?`,
    )
    .get(from, to) as { v: number };
  push('COGS বনাম বিক্রয়ের ক্রয়মূল্য (ফেরত বাদে)', cogs.v, cost.v - returnedCost.v);

  // 3. Receivable ledger vs customer due total.
  const ar = db
    .prepare(
      `SELECT COALESCE(SUM(l.debit_paisa - l.credit_paisa),0) AS v FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id WHERE a.code = ?`,
    )
    .get(ACCOUNT_CODES.receivable) as { v: number };
  const due = db.prepare('SELECT COALESCE(SUM(balance_paisa),0) AS v FROM customers WHERE is_walkin = 0').get() as {
    v: number;
  };
  push('কাস্টমার বাকি (লেজার বনাম ব্যালেন্স)', ar.v, due.v);

  // 4. Payable ledger vs supplier payable total.
  const ap = db
    .prepare(
      `SELECT COALESCE(SUM(l.credit_paisa - l.debit_paisa),0) AS v FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id WHERE a.code = ?`,
    )
    .get(ACCOUNT_CODES.payable) as { v: number };
  const payable = db.prepare('SELECT COALESCE(SUM(balance_paisa),0) AS v FROM suppliers').get() as { v: number };
  // Legacy credit purchases saved without a supplier still carry a real ledger
  // liability, so count them here — and flag them separately so the operator can
  // attach a supplier instead of chasing an unexplained difference forever.
  const unattributed = db
    .prepare(
      `SELECT COALESCE(SUM(due_paisa),0) AS v FROM purchases
        WHERE supplier_id IS NULL AND status <> 'voided' AND due_paisa <> 0`,
    )
    .get() as { v: number };
  push('সাপ্লায়ার পাওনা (লেজার বনাম ব্যালেন্স)', ap.v, payable.v + unattributed.v);
  if (unattributed.v !== 0) {
    results.push({
      ok: false,
      check: 'সাপ্লায়ার ছাড়া বাকি ক্রয় — পাওনা কারও খাতে নেই, ঠিক করা দরকার',
      ledger: unattributed.v,
      operational: 0,
      difference: unattributed.v,
    });
  }

  // 5. Inventory ledger value vs the live stock valuation.
  const invLedger = db
    .prepare(
      `SELECT COALESCE(SUM(l.debit_paisa - l.credit_paisa),0) AS v FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id WHERE a.code = ?`,
    )
    .get(ACCOUNT_CODES.inventory) as { v: number };
  const stockValue = db
    .prepare(
      `SELECT COALESCE(SUM((p.stock_base_milli * p.avg_cost_micro) / 1000000000),0) AS v
       FROM products p WHERE p.is_active = 1`,
    )
    .get() as { v: number };
  // Rounding of per-product values can drift by a few poisa on thousands of SKUs;
  // anything bigger than that is a real posting error (bundle assembly and
  // per-SKU rounding can move a few poisa legitimately).
  const stockValueRounded = Math.round(stockValue.v);
  results.push({
    ok: Math.abs(invLedger.v - stockValueRounded) <= 5,
    check: 'স্টক খাত বনাম স্টক মূল্যায়ন',
    ledger: invLedger.v,
    operational: stockValueRounded,
    difference: invLedger.v - stockValueRounded,
  });

  // 6. Global: total debit = total credit.
  const globals = jeSum.get(from, to) as { d: number; c: number };
  push('সামগ্রিক ডেবিট = ক্রেডিট', globals.d, globals.c);

  return results;
}

/**
 * Manual journal voucher (adjustments, opening balances, corrections).
 * The entry must balance; the voucher is never editable afterwards — mistakes
 * are corrected by posting a reversing voucher, exactly like the automatic
 * documents.
 */
export function postManualEntry(
  db: Db,
  input: {
    date?: string;
    memo: string;
    lines: { accountId?: number; code?: string; debit?: number; credit?: number; memo?: string }[];
    actor?: { id: number; username: string } | null;
  },
): JournalEntryRow {
  const memo = (input.memo ?? '').trim();
  if (!memo) throw new Error('ভাউচারের বিবরণ লিখতে হবে।');
  if (!input.lines || input.lines.length < 2) throw new Error('ভাউচারে অন্তত দুটি লাইন দরকার।');
  const entry = postEntry(db, {
    date: input.date ?? nowLocal(),
    source: 'manual',
    sourceId: nextCounter(db, 'manual_voucher'),
    memo,
    lines: input.lines.map((l) => ({ ...l, memo: l.memo ?? undefined })),
    userId: input.actor?.id ?? null,
    idempotent: false,
  });
  if (!entry) throw new Error('ভাউচারে কোনো অঙ্ক নেই।');
  audit(db, {
    userId: input.actor?.id ?? null,
    username: input.actor?.username,
    action: 'accounting.manual_voucher',
    entity: 'journal_entry',
    entityId: entry.id,
    details: { entryNo: entry.entry_no, memo, lines: input.lines.length },
  });
  return entry;
}
