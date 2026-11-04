import type { Db } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import type { AuditLog } from '../domain/types.js';

export interface AuditInput {
  userId?: number | null;
  username?: string | null;
  action: string;
  entity: string;
  entityId?: string | number | null;
  details?: unknown;
}

const SENSITIVE_KEYS = /pass(word)?|salt|token|secret|private|key_material|signature/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Append-only audit trail. Never stores credentials or licence secrets. */
export function audit(db: Db, input: AuditInput): void {
  let details: string | null = null;
  if (input.details !== undefined && input.details !== null) {
    try {
      details = JSON.stringify(scrub(input.details)).slice(0, 4000);
    } catch {
      details = '[unserialisable]';
    }
  }
  db.prepare(
    `INSERT INTO audit_logs (user_id, username, action, entity, entity_id, details, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    input.userId ?? null,
    input.username ?? null,
    input.action,
    input.entity,
    input.entityId === null || input.entityId === undefined ? null : String(input.entityId),
    details,
    nowLocal(),
  );
}

export interface AuditQuery {
  search?: string;
  entity?: string;
  action?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export function listAudit(db: Db, q: AuditQuery = {}): { rows: AuditLog[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.search) {
    where.push('(action LIKE ? OR entity LIKE ? OR username LIKE ? OR details LIKE ?)');
    const like = `%${q.search}%`;
    params.push(like, like, like, like);
  }
  if (q.entity) {
    where.push('entity = ?');
    params.push(q.entity);
  }
  if (q.action) {
    where.push('action = ?');
    params.push(q.action);
  }
  if (q.from) {
    where.push('created_at >= ?');
    params.push(`${q.from} 00:00:00`);
  }
  if (q.to) {
    where.push('created_at <= ?');
    params.push(`${q.to} 23:59:59`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) c FROM audit_logs ${clause}`).get(...params) as { c: number }).c;
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(500, Math.max(10, q.pageSize ?? 50));
  const rows = db
    .prepare(
      `SELECT * FROM audit_logs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as AuditLog[];
  return { rows, total };
}
