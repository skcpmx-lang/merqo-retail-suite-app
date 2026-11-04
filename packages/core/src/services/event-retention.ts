import type { Db } from '../db/connection.js';
import { pruneEventsByAge, retentionFloor } from './events.js';

/**
 * Scheduled outbox retention (Phase 3, Milestone D).
 *
 * Retention removes *delivery records*, never business data. The policy is explicit
 * and documented (`docs/V1.1.4_PHASE3_RETENTION.md`):
 *
 *  - events are kept for `olderThanMs` (default 7 days) **and**
 *  - at least `keepLatest` events are always kept (default 5 000), so a terminal that
 *    was offline for a day still finds its backlog,
 *  - the highest removed sequence is recorded as the retention floor, and a client
 *    resuming below it receives `resync` and refetches.
 *
 * Safety:
 *  - the delete runs inside a single transaction, so readers never see a partially
 *    pruned outbox;
 *  - `busy_timeout` waits for a writer instead of failing the timer;
 *  - if a transaction is already open on this connection (a business write in
 *    progress) the tick is skipped rather than nested;
 *  - a failed tick is logged and retried on the next interval; it can never block the
 *    server or throw into the event loop.
 */

export interface RetentionOptions {
  intervalMs?: number;
  olderThanMs?: number;
  keepLatest?: number;
  /** Called after each successful prune. */
  onPruned?: (result: { deleted: number; floor: number }) => void;
  log?: (level: 'info' | 'warn', message: string, detail?: unknown) => void;
  now?: () => Date;
}

export interface RetentionHandle {
  /** Runs one prune immediately (used by tests, the tray and manual maintenance). */
  runOnce: () => { deleted: number; floor: number };
  stop: () => void;
  readonly running: boolean;
}

export function startEventRetention(db: Db, opts: RetentionOptions = {}): RetentionHandle {
  const intervalMs = Math.max(1000, opts.intervalMs ?? 60 * 60 * 1000);
  const olderThanMs = opts.olderThanMs ?? 7 * 24 * 60 * 60 * 1000;
  const keepLatest = opts.keepLatest ?? 5000;
  const now = opts.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const runOnce = (): { deleted: number; floor: number } => {
    try {
      if (db.inTransaction) {
        // A business transaction owns the connection; skip this tick.
        return { deleted: 0, floor: retentionFloor(db) };
      }
      db.pragma('busy_timeout = 2000');
      const run = db.transaction(() => pruneEventsByAge(db, { olderThanMs, keepLatest, now: now() }));
      const result = run();
      if (result.deleted > 0) {
        opts.log?.('info', 'event retention pruned', result);
        opts.onPruned?.(result);
      }
      return result;
    } catch (err) {
      opts.log?.('warn', 'event retention tick failed', { message: (err as Error).message });
      // The database may itself be unusable (closed, locked, corrupt); the tick must
      // report a no-op rather than throw into the interval.
      let floor = 0;
      try {
        floor = retentionFloor(db);
      } catch {
        floor = 0;
      }
      return { deleted: 0, floor };
    }
  };

  const handle: RetentionHandle = {
    runOnce,
    get running() {
      return running;
    },
    stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };

  // A first pass at startup keeps a long-neglected database from growing further.
  runOnce();
  timer = setInterval(runOnce, intervalMs);
  timer.unref?.();
  running = true;
  return handle;
}
