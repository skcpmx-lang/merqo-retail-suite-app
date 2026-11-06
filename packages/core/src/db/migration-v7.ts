import type { Database as SqliteDb } from 'better-sqlite3';

type Db = SqliteDb;

/**
 * Migration 7 — indexes for the date filters the app actually runs (v1.1.5).
 *
 * Every list and most reports filter on `date(column) BETWEEN date(?) AND date(?)`. Wrapping the
 * *column* in `date()` makes SQLite unable to use a plain index on that column, so each of these
 * queries scanned the whole table — measured with `EXPLAIN QUERY PLAN` in `scripts/bench.mjs`
 * ("sales by date: SCAN sales"). On a shop with tens of thousands of rows that is a visible pause
 * on the sales list and on the daily report.
 *
 * The fix is an **expression index** that matches the expression the queries use, rather than
 * rewriting dozens of carefully reviewed queries (and their bind parameters) in a patch release.
 * SQLite stores `date(column)` per row; reads of the same expression use the index.
 *
 * Additive only: no table, column, row or constraint is created, altered or removed, so:
 *  - a v6 database opens, gains indexes and keeps every row;
 *  - the schema that a customer's data lives in is unchanged — only lookup structures are added;
 *  - the migration runner has already written `.pre-migration-v6-to-v7-*.bak` before this runs, and
 *    runs the whole thing in one transaction with the `user_version` bump.
 *
 * `date()` is only valid on the `YYYY-MM-DD HH:MM:SS` text this application writes; the indexes are
 * created on the same columns those writes target, so a stored value that is not a date cannot make
 * a row disappear — it simply is not matched by a date filter, exactly as before.
 */
const STATEMENTS = [
  "CREATE INDEX IF NOT EXISTS idx_sales_day ON sales(date(sale_date))",
  "CREATE INDEX IF NOT EXISTS idx_purchases_day ON purchases(date(purchase_date))",
  "CREATE INDEX IF NOT EXISTS idx_payments_day ON payments(date(payment_date))",
  "CREATE INDEX IF NOT EXISTS idx_expenses_day ON expenses(date(expense_date))",
  "CREATE INDEX IF NOT EXISTS idx_returns_day ON returns(date(return_date))",
  "CREATE INDEX IF NOT EXISTS idx_cash_sessions_day ON cash_sessions(date(opened_at))",
  "CREATE INDEX IF NOT EXISTS idx_attendance_day ON attendance(date(clock_in))",
  "CREATE INDEX IF NOT EXISTS idx_journal_day ON journal_entries(date(entry_date))",
] as const;

/** The index names this migration owns, for verification and tests. */
export const V7_INDEXES = [
  'idx_sales_day',
  'idx_purchases_day',
  'idx_payments_day',
  'idx_expenses_day',
  'idx_returns_day',
  'idx_cash_sessions_day',
  'idx_attendance_day',
  'idx_journal_day',
] as const;

export function migrateToV7(db: Db, log?: (msg: string) => void): void {
  for (const statement of STATEMENTS) db.exec(statement);
  log?.(`migration 7: ${STATEMENTS.length} date indexes ready`);
}
