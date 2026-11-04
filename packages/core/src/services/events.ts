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
