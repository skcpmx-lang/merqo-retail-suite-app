import crypto from 'node:crypto';
import type { Db } from '../db/connection.js';

/**
 * Event outbox (v1.1.4).
 *
 * The row is written **inside the same transaction as the business operation**, so
 * an event can never describe a sale that rolled back, and a committed sale can
 * never be missing its event. Delivery is a separate concern: a dispatcher reads
 * the ordered stream and a terminal resumes from the last `seq` it saw.
 */

export const EVENT_TYPES = [
  'sale.created',
  'sale.voided',
  'sale.returned',
  'inventory.updated',
  'product.updated',
  'purchase.received',
  'payment.recorded',
  'customer.updated',
  'device.connected',
  'device.disconnected',
  'license.status_changed',
  'server.maintenance',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface OutboxEvent {
  seq: number;
  event_id: string;
  store_id: string;
  type: string;
  entity_id: string | null;
  payload: string;
  schema_version: number;
  created_at: string;
}

/** Appends one event; call it inside the caller's transaction. */
export function appendEvent(
  db: Db,
  input: { storeId: string; type: EventType | string; entityId?: string | number | null; payload?: unknown },
): OutboxEvent {
  const eventId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO event_outbox (event_id, store_id, type, entity_id, payload, schema_version, created_at)
       VALUES (?,?,?,?,?,1,?)`,
    )
    .run(
      eventId,
      input.storeId,
      input.type,
      input.entityId === undefined || input.entityId === null ? null : String(input.entityId),
      JSON.stringify(input.payload ?? {}),
      createdAt,
    );
  return {
    seq: Number(info.lastInsertRowid),
    event_id: eventId,
    store_id: input.storeId,
    type: input.type,
    entity_id: input.entityId === undefined || input.entityId === null ? null : String(input.entityId),
    payload: JSON.stringify(input.payload ?? {}),
    schema_version: 1,
    created_at: createdAt,
  };
}

/** Reads events after `afterSeq` (exclusive) in store order. */
export function readEvents(db: Db, afterSeq = 0, limit = 200): OutboxEvent[] {
  return db
    .prepare('SELECT * FROM event_outbox WHERE seq > ? ORDER BY seq ASC LIMIT ?')
    .all(Math.max(0, Number(afterSeq) || 0), Math.min(1000, Math.max(1, limit))) as OutboxEvent[];
}

/**
 * Highest sequence that retention has already removed (0 when nothing was pruned).
 *
 * Stored in `meta` so a resuming client can be told "your position is older than what
 * we still have" instead of receiving a silent gap.
 */
export function retentionFloor(db: Db): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'event_retention_floor'").get() as
    | { value: string }
    | undefined;
  return Number(row?.value ?? 0) || 0;
}

/** Lowest sequence still present in the outbox (null when the outbox is empty). */
export function earliestSeq(db: Db): number | null {
  const row = db.prepare('SELECT MIN(seq) AS seq FROM event_outbox').get() as { seq: number | null };
  return row?.seq === null || row?.seq === undefined ? null : Number(row.seq);
}

/**
 * Retention: removes old events **below a floor** and records the floor.
 *
 * Design rules:
 *  - only events older than `olderThanMs` are candidates, so a terminal that was
 *    briefly offline always finds its events;
 *  - at least `keepLatest` events are kept, so retention can never empty the outbox;
 *  - the floor that is recorded is the highest deleted sequence, and a client that
 *    resumes from below it receives `event: resync` and refetches.
 *
 * Business data is never touched: `event_outbox` rows are delivery records only.
 */
export function pruneEventsByAge(
  db: Db,
  opts: { olderThanMs?: number; keepLatest?: number; now?: Date } = {},
): { deleted: number; floor: number } {
  const olderThanMs = opts.olderThanMs ?? 7 * 24 * 60 * 60 * 1000;
  const keepLatest = Math.max(0, opts.keepLatest ?? 5000);
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
  const latest = latestSeq(db);
  const floorLimit = Math.max(0, latest - keepLatest);

  const candidate = db
    .prepare('SELECT MIN(seq) AS low, MAX(seq) AS high FROM event_outbox WHERE created_at < ?')
    .get(cutoff) as { low: number | null; high: number | null } | undefined;
  if (!candidate?.low) return { deleted: 0, floor: retentionFloor(db) };

  const high = Math.min(Number(candidate.high), floorLimit);
  if (high < Number(candidate.low)) return { deleted: 0, floor: retentionFloor(db) };

  const info = db.prepare('DELETE FROM event_outbox WHERE seq <= ? AND created_at < ?').run(high, cutoff);
  if (info.changes > 0) {
    const previous = retentionFloor(db);
    const floor = Math.max(previous, high);
    db.prepare("INSERT INTO meta (key, value) VALUES ('event_retention_floor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      String(floor),
    );
    return { deleted: info.changes, floor };
  }
  return { deleted: 0, floor: retentionFloor(db) };
}

export function latestSeq(db: Db): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM event_outbox').get() as { seq: number };
  return Number(row?.seq ?? 0);
}

export function markDelivered(db: Db, seq: number):	void {
  db.prepare('UPDATE event_outbox SET delivered_at = COALESCE(delivered_at, ?) WHERE seq <= ?').run(
    new Date().toISOString(),
    seq,
  );
}

/** Housekeeping: keep the stream bounded without losing recent resume points. */
export function pruneEvents(db: Db, keep = 5000): number {
  const cutoff = latestSeq(db) - keep;
  if (cutoff <= 0) return 0;
  return db.prepare('DELETE FROM event_outbox WHERE seq <= ? AND delivered_at IS NOT NULL').run(cutoff).changes;
}
