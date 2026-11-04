import type { Db } from '../db/connection.js';
import { MAX_CLOCK_SKEW_MS, type NonceGuard } from './device-auth.js';

/**
 * Restart-safe replay protection (Phase 3, Priority 1).
 *
 * The in-memory `ReplayGuard` was correct within a process but forgot every nonce
 * on restart, so a captured request stayed reusable for as long as its timestamp
 * remained inside the ±120 s window — and a restart is trivial to provoke (crash,
 * power loss, the operator restarting the server from the tray).
 *
 * This guard keeps the same contract but writes the decision to SQLite:
 *
 *  - `INSERT … ON CONFLICT (device_id, nonce) DO NOTHING` is a single atomic
 *    statement, so two concurrent copies of one request can never both win;
 *  - the row survives a process restart, a machine reboot and a crash;
 *  - rows expire after twice the accepted clock skew and are pruned lazily, so
 *    the table stays small (a busy shop is a few hundred rows);
 *  - it is deliberately *not* dependent on the signature check passing — the API
 *    verifies the signature first and only then claims the nonce, so an
 *    unauthenticated attacker cannot burn a device's nonce space.
 */

export interface ReplayStoreOptions {
  /** How long a nonce is remembered. Default: twice the accepted clock skew. */
  windowMs?: number;
  /** Minimum gap between lazy prunes. Default: 60 s. */
  pruneEveryMs?: number;
  now?: () => number;
}

export class SqliteReplayGuard implements NonceGuard {
  private readonly windowMs: number;
  private readonly pruneEveryMs: number;
  private readonly now: () => number;
  private lastPrune = 0;

  constructor(private readonly db: Db, opts: ReplayStoreOptions = {}) {
    this.windowMs = opts.windowMs ?? MAX_CLOCK_SKEW_MS * 2;
    this.pruneEveryMs = opts.pruneEveryMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  claim(deviceId: string, nonce: string, now = this.now()): boolean {
    if (!deviceId || !nonce) return false;
    this.prune(now);
    const seenAt = new Date(now).toISOString();
    const expiresAt = new Date(now + this.windowMs).toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO device_nonces (device_id, nonce, seen_at, expires_at)
         VALUES (?,?,?,?)
         ON CONFLICT (device_id, nonce) DO NOTHING`,
      )
      .run(deviceId, nonce, seenAt, expiresAt);
    return result.changes === 1;
  }

  /** Deletes expired nonces. Safe to call at any time. */
  prune(now = this.now()): number {
    if (now - this.lastPrune < this.pruneEveryMs) return 0;
    this.lastPrune = now;
    const result = this.db
      .prepare('DELETE FROM device_nonces WHERE expires_at <= ?')
      .run(new Date(now).toISOString());
    return result.changes;
  }

  /** Number of remembered nonces (diagnostics and tests). */
  size(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM device_nonces').get() as { n: number };
    return Number(row?.n ?? 0);
  }
}
