import type { Db } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import type { CashMovement, CashSession } from '../domain/types.js';
import { audit } from './audit.js';
import { isPostingEnabled, postCashMovement } from './accounting.js';

type Actor = { id: number; username: string } | null | undefined;

export const CASH_SOURCE_LABELS: Record<string, string> = {
  opening: 'ওপেনিং ক্যাশ',
  sale: 'ক্যাশ বিক্রয়',
  customer_payment: 'কাস্টমার পেমেন্ট',
  supplier_payment: 'সাপ্লায়ার পেমেন্ট',
  expense: 'এক্সপেন্স',
  refund: 'রিফান্ড',
  purchase: 'পারচেজ পেমেন্ট',
  manual_in: 'ম্যানুয়াল জমা',
  manual_out: 'ম্যানুয়াল উত্তোলন',
  return_refund: 'রিটার্ন রিফান্ড',
};

/** The open cash session of a user, or null. */
export function getOpenSession(db: Db, userId: number): CashSession | null {
  const row = db
    .prepare("SELECT * FROM cash_sessions WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1")
    .get(userId) as CashSession | undefined;
  return row ?? null;
}

export function openCashSession(
  db: Db,
  input: { userId: number; openingCash: number; note?: string | null; actor?: Actor },
): CashSession {
  const existing = getOpenSession(db, input.userId);
  if (existing) throw new Error('আপনার একটি ক্যাশ সেশন ইতিমধ্যে খোলা আছে। আগে সেটি ক্লোজ করুন।');
  if (input.openingCash < 0) throw new Error('ওপেনিং ক্যাশ ঋণাত্মক হতে পারবে না।');
  const now = nowLocal();
  const res = db
    .prepare(
      `INSERT INTO cash_sessions (user_id, opened_at, opening_cash_paisa, status, note)
       VALUES (?,?,?,'open',?)`,
    )
    .run(input.userId, now, Math.round(input.openingCash), input.note ?? null);
  const id = Number(res.lastInsertRowid);
  if (input.openingCash > 0) {
    db.prepare(
      `INSERT INTO cash_movements (session_id, direction, amount_paisa, source, source_id, note, user_id, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(id, 'in', Math.round(input.openingCash), 'opening', null, 'ওপেনিং ক্যাশ', input.userId, now);
  }
  audit(db, {
    userId: input.userId,
    username: input.actor?.username,
    action: 'cash.session_open',
    entity: 'cash_session',
    entityId: id,
    details: { openingCash: input.openingCash },
  });
  return db.prepare('SELECT * FROM cash_sessions WHERE id = ?').get(id) as CashSession;
}

/** Guarantee a session exists before a cash movement is recorded. */
export function ensureOpenSession(db: Db, userId: number): CashSession {
  return getOpenSession(db, userId) ?? openCashSession(db, { userId, openingCash: 0, note: 'স্বয়ংক্রিয় ওপেনিং' });
}

export function sessionTotals(
  db: Db,
  sessionId: number,
): { inflow: number; outflow: number; opening: number; expected: number; bySource: { source: string; total: number; direction: string }[] } {
  const session = db.prepare('SELECT * FROM cash_sessions WHERE id = ?').get(sessionId) as CashSession | undefined;
  if (!session) throw new Error('ক্যাশ সেশন পাওয়া যায়নি।');
  const rows = db
    .prepare(
      `SELECT source, direction, SUM(amount_paisa) total FROM cash_movements
        WHERE session_id = ? GROUP BY source, direction ORDER BY source`,
    )
    .all(sessionId) as { source: string; direction: string; total: number }[];
  let inflow = 0;
  let outflow = 0;
  for (const r of rows) {
    if (r.source === 'opening') continue;
    if (r.direction === 'in') inflow += r.total;
    else outflow += r.total;
  }
  const expected = session.opening_cash_paisa + inflow - outflow;
  return { inflow, outflow, opening: session.opening_cash_paisa, expected, bySource: rows };
}

export function addCashMovement(
  db: Db,
  input: {
    userId: number;
    direction: 'in' | 'out';
    amount: number;
    source: string;
    sourceId?: number | null;
    note?: string | null;
  },
): void {
  if (input.amount <= 0) return;
  const session = ensureOpenSession(db, input.userId);
  const res = db
    .prepare(
      `INSERT INTO cash_movements (session_id, direction, amount_paisa, source, source_id, note, user_id, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
    session.id,
    input.direction,
    Math.round(input.amount),
    input.source,
    input.sourceId ?? null,
      input.note ?? null,
      input.userId,
      nowLocal(),
    );
  if (isPostingEnabled(db) && res.lastInsertRowid) postCashMovement(db, Number(res.lastInsertRowid));
}

export function closeCashSession(
  db: Db,
  input: { userId: number; countedCash: number; note?: string | null; actor?: Actor },
): CashSession {
  const session = getOpenSession(db, input.userId);
  if (!session) throw new Error('কোনো খোলা ক্যাশ সেশন নেই।');
  if (input.countedCash < 0) throw new Error('গণনা করা ক্যাশ ঋণাত্মক হতে পারবে না।');
  const totals = sessionTotals(db, session.id);
  const difference = Math.round(input.countedCash) - totals.expected;
  db.prepare(
    `UPDATE cash_sessions SET closed_at = ?, counted_cash_paisa = ?, expected_cash_paisa = ?, difference_paisa = ?,
       status = 'closed', note = COALESCE(?, note) WHERE id = ?`,
  ).run(nowLocal(), Math.round(input.countedCash), totals.expected, difference, input.note ?? null, session.id);
  audit(db, {
    userId: input.userId,
    username: input.actor?.username,
    action: 'cash.session_close',
    entity: 'cash_session',
    entityId: session.id,
    details: { counted: input.countedCash, expected: totals.expected, difference },
  });
  return db.prepare('SELECT * FROM cash_sessions WHERE id = ?').get(session.id) as CashSession;
}

export function listSessions(
  db: Db,
  f: { from?: string; to?: string; userId?: number | null; status?: string | null; page?: number; pageSize?: number } = {},
): { rows: CashSession[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.from) {
    where.push('date(s.opened_at) >= date(?)');
    params.push(f.from);
  }
  if (f.to) {
    where.push('date(s.opened_at) <= date(?)');
    params.push(f.to);
  }
  if (f.userId) {
    where.push('s.user_id = ?');
    params.push(f.userId);
  }
  if (f.status) {
    where.push('s.status = ?');
    params.push(f.status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) c FROM cash_sessions s ${clause}`).get(...params) as { c: number }).c;
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(200, Math.max(10, f.pageSize ?? 30));
  const rows = db
    .prepare(
      `SELECT s.*, u.username FROM cash_sessions s LEFT JOIN users u ON u.id = s.user_id
       ${clause} ORDER BY s.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as CashSession[];
  return { rows, total };
}

export function sessionMovements(db: Db, sessionId: number): CashMovement[] {
  return db
    .prepare('SELECT * FROM cash_movements WHERE session_id = ? ORDER BY id').all(sessionId) as CashMovement[];
}

/** Live cash position of the shop = all cash movements ever recorded. */
export function cashInHandPaisa(db: Db): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount_paisa ELSE -amount_paisa END),0) v
         FROM cash_movements`,
    )
    .get() as { v: number };
  return row.v;
}

export function cashInHandForSession(db: Db, sessionId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount_paisa ELSE -amount_paisa END),0) v
         FROM cash_movements WHERE session_id = ?`,
    )
    .get(sessionId) as { v: number };
  return row.v;
}

/** Alias used by the IPC layer. */
export const listCashMovements = sessionMovements;
