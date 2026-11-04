import type { Db } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';

export type Severity = 'info' | 'warning' | 'danger' | 'success';

export interface Notification {
  id: number;
  kind: string;
  severity: Severity;
  title: string;
  body: string | null;
  entity: string | null;
  entity_id: number | null;
  dedupe_key: string | null;
  is_read: number;
  created_at: string;
}

/**
 * Business alerts are *derived from the shop's own data* — never from a remote
 * push service. The notifications table only stores the read/acknowledged state
 * so an alert the owner dismissed stays dismissed.
 */
export interface BusinessAlert {
  key: string;
  severity: Severity;
  title: string;
  body: string;
  page: string;
  count?: number;
  amountPaisa?: number;
}

export function listNotifications(db: Db, opts: { unreadOnly?: boolean; limit?: number } = {}): Notification[] {
  const where = opts.unreadOnly ? 'WHERE is_read = 0' : '';
  return db
    .prepare(`SELECT * FROM notifications ${where} ORDER BY is_read ASC, id DESC LIMIT ?`)
    .all(opts.limit ?? 50) as Notification[];
}

export function unreadCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE is_read = 0').get() as { n: number }).n;
}

export function markNotificationRead(db: Db, id: number): void {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(id);
}

export function markAllNotificationsRead(db: Db): void {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE is_read = 0').run();
}

/** Store an event so it survives a restart. Duplicate keys are ignored. */
export function pushNotification(
  db: Db,
  input: {
    kind: string;
    severity?: Severity;
    title: string;
    body?: string | null;
    entity?: string | null;
    entityId?: number | null;
    dedupeKey?: string | null;
  },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO notifications (kind, severity, title, body, entity, entity_id, dedupe_key, is_read, created_at)
     VALUES (?,?,?,?,?,?,?,0,?)`,
  ).run(
    input.kind,
    input.severity ?? 'info',
    input.title,
    input.body ?? null,
    input.entity ?? null,
    input.entityId ?? null,
    input.dedupeKey ?? null,
    nowLocal(),
  );
}

/**
 * Live alerts computed on demand. Each one is actionable and links to a screen;
 * amounts are plain poisa so the UI formats them with the shop's settings.
 */
export function businessAlerts(db: Db): BusinessAlert[] {
  const alerts: BusinessAlert[] = [];
  const one = <T>(sql: string, ...params: unknown[]): T => db.prepare(sql).get(...params) as T;

  const lowStock = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM products WHERE is_active = 1 AND is_service = 0
       AND stock_base_milli > 0 AND min_stock_milli > 0 AND stock_base_milli <= min_stock_milli`,
  );
  if (lowStock.n > 0) {
    alerts.push({
      key: 'low_stock',
      severity: 'warning',
      title: `${lowStock.n}টি প্রোডাক্টের স্টক কম`,
      body: 'রিঅর্ডার লেভেলে পৌঁছেছে — স্টক অপারেশন স্ক্রিন থেকে অর্ডার করুন।',
      page: 'stockops',
      count: lowStock.n,
    });
  }

  const outOfStock = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM products WHERE is_active = 1 AND is_service = 0 AND stock_base_milli <= 0`,
  );
  if (outOfStock.n > 0) {
    alerts.push({
      key: 'out_of_stock',
      severity: 'danger',
      title: `${outOfStock.n}টি প্রোডাক্ট স্টকআউট`,
      body: 'বিক্রয় বন্ধ আছে এমন প্রোডাক্ট দ্রুত পূরণ করুন।',
      page: 'inventory',
      count: outOfStock.n,
    });
  }

  const dues = one<{ n: number; total: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(balance_paisa),0) AS total FROM customers WHERE balance_paisa > 0`,
  );
  if (dues.total > 0) {
    alerts.push({
      key: 'receivable',
      severity: 'info',
      title: `কাস্টমার বাকি ${(dues.total / 100).toLocaleString('en-US')} টাকা`,
      body: `${dues.n} জন কাস্টমারের কাছে বাকি আছে।`,
      page: 'customers',
      count: dues.n,
      amountPaisa: dues.total,
    });
  }

  const payable = one<{ n: number; total: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(balance_paisa),0) AS total FROM suppliers WHERE balance_paisa > 0`,
  );
  if (payable.total > 0) {
    alerts.push({
      key: 'payable',
      severity: 'warning',
      title: `সাপ্লায়ার পাওনা ${(payable.total / 100).toLocaleString('en-US')} টাকা`,
      body: `${payable.n} জন সাপ্লায়ারকে পরিশোধ বাকি।`,
      page: 'suppliers',
      count: payable.n,
      amountPaisa: payable.total,
    });
  }

  const overduePo = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM purchase_orders
      WHERE status IN ('open','partial') AND expected_date IS NOT NULL AND expected_date < date('now','localtime')`,
  );
  if (overduePo.n > 0) {
    alerts.push({
      key: 'po_overdue',
      severity: 'warning',
      title: `${overduePo.n}টি পারচেজ অর্ডার সময়মতো আসেনি`,
      body: 'সাপ্লায়ারের সাথে যোগাযোগ করুন বা অর্ডারটি বাতিল করুন।',
      page: 'purchaseorders',
      count: overduePo.n,
    });
  }

  const unreconciled = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM journal_entries e
      WHERE (SELECT SUM(debit_paisa) FROM journal_lines WHERE entry_id = e.id)
         <> (SELECT SUM(credit_paisa) FROM journal_lines WHERE entry_id = e.id)`,
  );
  if (unreconciled.n > 0) {
    alerts.push({
      key: 'unbalanced_journal',
      severity: 'danger',
      title: `${unreconciled.n}টি জার্নাল এন্ট্রি সমতুল্য নয়`,
      body: 'এটি কখনো ঘটার কথা নয় — হিসাব স্ক্রিন থেকে যাচাই করুন এবং ব্যাকআপ রাখুন।',
      page: 'accounting',
      count: unreconciled.n,
    });
  }

  const cashOpen = one<{ n: number }>(`SELECT COUNT(*) AS n FROM cash_sessions WHERE status = 'open'`);
  if (cashOpen.n === 0) {
    alerts.push({
      key: 'cash_closed',
      severity: 'info',
      title: 'ক্যাশ সেশন খোলা নেই',
      body: 'বিক্রয় শুরুর আগে ক্যাশ রেজিস্টারে সেশন খুলুন।',
      page: 'cash',
    });
  }

  const cards = one<{ n: number; total: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(balance_paisa),0) AS total FROM gift_cards WHERE status = 'active'`,
  );
  if (cards.total > 0) {
    alerts.push({
      key: 'gift_card_liability',
      severity: 'info',
      title: `গিফট কার্ড দায় ${(cards.total / 100).toLocaleString('en-US')} টাকা`,
      body: `${cards.n}টি সক্রিয় কার্ডের অবশিষ্ট ব্যালেন্স।`,
      page: 'promotions',
      count: cards.n,
      amountPaisa: cards.total,
    });
  }

  return alerts;
}

/** Turns the live alerts into stored notifications once per day per key. */
export function syncAlertsToNotifications(db: Db): number {
  const stamp = nowLocal().slice(0, 10);
  let written = 0;
  for (const alert of businessAlerts(db)) {
    if (alert.severity === 'info') continue;
    const key = `${alert.key}:${stamp}`;
    const before = (db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE dedupe_key = ?').get(key) as { n: number }).n;
    if (before > 0) continue;
    pushNotification(db, {
      kind: alert.key,
      severity: alert.severity,
      title: alert.title,
      body: alert.body,
      entity: 'alert',
      dedupeKey: key,
    });
    written++;
  }
  return written;
}
