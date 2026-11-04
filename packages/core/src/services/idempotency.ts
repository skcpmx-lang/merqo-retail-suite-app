import crypto from 'node:crypto';
import type { Db } from '../db/connection.js';

/**
 * Idempotency for write requests (v1.1.4).
 *
 * A terminal retries on a timeout. If the first attempt committed, the retry must
 * return the *same* answer instead of creating a second invoice. The key is
 * supplied by the client; the request body is hashed so that reusing a key with a
 * different body is rejected instead of silently returning the wrong document.
 */

export interface IdempotencyOptions {
  key: string;
  method: string;
  deviceId?: string | null;
  /** Any JSON-serialisable request body. */
  body: unknown;
  /** How long a stored answer may be replayed (default 24h). */
  ttlMs?: number;
}

export class IdempotencyError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'IdempotencyError';
  }
}

function canonical(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = walk((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(walk(value ?? null));
}

export function requestHash(body: unknown): string {
  return crypto.createHash('sha256').update(canonical(body)).digest('hex');
}

/**
 * Runs `fn` at most once per key. A replay returns the stored response; a key
 * reused with a different body raises `IDEMPOTENCY_CONFLICT`.
 */
export function withIdempotency<T>(db: Db, opts: IdempotencyOptions, fn: () => T): T {
  const key = String(opts.key ?? '').trim();
  if (!key) return fn();
  if (key.length > 200) throw new IdempotencyError('BAD_KEY', 'ইডেম্পোটেন্সি কী অনেক বড়।');
  const hash = requestHash(opts.body);
  const now = new Date();
  const existing = db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get(key) as
    | { request_hash: string; response: string | null; method: string }
    | undefined;
  if (existing) {
    if (existing.request_hash !== hash || existing.method !== opts.method) {
      throw new IdempotencyError(
        'IDEMPOTENCY_CONFLICT',
        'একই কী দিয়ে ভিন্ন অনুরোধ পাঠানো হয়েছে — প্রত্যাখ্যাত।',
      );
    }
    if (existing.response) return JSON.parse(existing.response) as T;
  }

  const result = fn();
  db.prepare(
    `INSERT INTO idempotency_keys (key, device_id, method, request_hash, response, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET response = excluded.response`,
  ).run(
    key,
    opts.deviceId ?? null,
    opts.method,
    hash,
    JSON.stringify(result ?? null),
    now.toISOString(),
    new Date(now.getTime() + (opts.ttlMs ?? 24 * 60 * 60 * 1000)).toISOString(),
  );
  return result;
}

/**
 * Async variant: awaits the operation first so the **resolved** value is stored.
 * (Storing a pending Promise would replay `{}` — a bug the API tests caught.)
 */
export async function withIdempotencyAsync<T>(
  db: Db,
  opts: IdempotencyOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const key = String(opts.key ?? '').trim();
  if (!key) return fn();
  if (key.length > 200) throw new IdempotencyError('BAD_KEY', 'ইডেম্পোটেন্সি কী অনেক বড়।');
  const hash = requestHash(opts.body);
  const now = new Date();
  const existing = db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get(key) as
    | { request_hash: string; response: string | null; method: string }
    | undefined;
  if (existing) {
    if (existing.request_hash !== hash || existing.method !== opts.method) {
      throw new IdempotencyError(
        'IDEMPOTENCY_CONFLICT',
        'একই কী দিয়ে ভিন্ন অনুরোধ পাঠানো হয়েছে — প্রত্যাখ্যাত।',
      );
    }
    if (existing.response) return JSON.parse(existing.response) as T;
  }
  const result = await fn();
  db.prepare(
    `INSERT INTO idempotency_keys (key, device_id, method, request_hash, response, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET response = excluded.response`,
  ).run(
    key,
    opts.deviceId ?? null,
    opts.method,
    hash,
    JSON.stringify(result ?? null),
    now.toISOString(),
    new Date(now.getTime() + (opts.ttlMs ?? 24 * 60 * 60 * 1000)).toISOString(),
  );
  return result;
}

export function pruneIdempotencyKeys(db: Db): number {
  return db.prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?').run(new Date().toISOString()).changes;
}
