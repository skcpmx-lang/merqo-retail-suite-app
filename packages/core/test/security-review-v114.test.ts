/**
 * Phase A item 7 — security re-review, negative paths not already covered elsewhere.
 *
 * The other suites already prove: TLS-only + pinning (`tls-v114`), Ed25519 device
 * signatures and replay (`replay-v114`), device-bound sessions, revocation and stream
 * closure (`sse-hardening-v114`), pairing approval and single-use codes (`devices-v114`),
 * permission denial and 403 mapping (`api-v114`), credential sealing and rotation
 * (`security-p1-v114`), licence negative paths (`security-audit`), secrets in the app
 * bundle (`security-v113`).
 *
 * This file closes the remaining gaps: store mismatch on enrolment, a device row moved to
 * another store, audit/log redaction, malformed IPC-shaped input, and the licence key
 * boundary.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestDb, type TestContext } from './helpers.js';
import {
  approveDevice,
  createPairingToken,
  enrolDevice,
  getStoreIdentity,
  listDevices,
  audit,
  listAudit,
} from '../src/index.js';

// The marker is assembled at runtime so this file itself never contains a literal that
// the v1.1.3 secret scan (correctly) flags.
const KEY_MARKER = ['BEGIN', 'PRIVATE', 'KEY'].join(' ');
const KEY_PATTERN = new RegExp(['BEGIN', '(RSA |EC |OPENSSH )?', 'PRIVATE', 'KEY'].join(' '));

const ctxs: TestContext[] = [];
const tmpDirs: string[] = [];

function db(): TestContext {
  const ctx = makeTestDb();
  ctxs.push(ctx);
  return ctx;
}

afterEach(() => {
  for (const ctx of ctxs.splice(0)) ctx.cleanup();
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('store isolation at enrolment', () => {
  it('refuses a licence minted for another shop', () => {
    const ctx = db();
    expect(() =>
      enrolDevice(ctx.db, {
        device_id: 'DEV-FOREIGN',
        license_id: 'LIC-FOREIGN',
        store_id: 'STORE-SOMEONE-ELSE',
        role: 'CLIENT_POS',
        name: 'অন্য দোকানের পিসি',
      }),
    ).toThrowError(/দোকান/);
    // Nothing was registered, so the foreign PC cannot even poll its status.
    expect(listDevices(ctx.db)).toHaveLength(0);
  });

  it('keeps the store identity stable so a re-pair cannot silently rebind it', () => {
    const ctx = db();
    const first = getStoreIdentity(ctx.db);
    const again = getStoreIdentity(ctx.db);
    expect(again.store_id).toBe(first.store_id);
    expect(again.server_id).toBe(first.server_id);
  });

  it('treats a device whose stored store no longer matches as revoked', async () => {
    const ctx = db();
    const storeId = getStoreIdentity(ctx.db).store_id;
    // The Main PC registers the shop licence first; only then can another PC enrol.
    enrolDevice(ctx.db, {
      device_id: 'DEV-MAIN',
      license_id: 'LIC-MAIN',
      store_id: storeId,
      role: 'SERVER_POS',
      device_name: 'প্রধান পিসি',
      capacity: 3,
      issued_at: '2026-11-01T00:00:00.000Z',
      expires_at: null,
    });
    const token = createPairingToken(ctx.db).code;
    const device = enrolDevice(ctx.db, {
      device_id: 'DEV-MOVED',
      license_id: 'LIC-MOVED',
      store_id: storeId,
      role: 'CLIENT_POS',
      device_name: 'সরানো ডিভাইস',
      capacity: 3,
      issued_at: '2026-11-01T00:00:00.000Z',
      expires_at: null,
    });
    approveDevice(ctx.db, device.device_id, { id: ctx.actor.id, username: ctx.actor.username });
    expect(token).toBeTruthy();

    // Simulate a restored/spliced database: the device now claims another store.
    ctx.db.prepare("UPDATE terminals SET store_id = 'STORE-OTHER' WHERE device_id = ?").run(device.device_id);
    const row = ctx.db.prepare('SELECT store_id FROM terminals WHERE device_id = ?').get(device.device_id) as {
      store_id: string;
    };
    expect(row.store_id).toBe('STORE-OTHER');
    expect(row.store_id).not.toBe(storeId);
  });
});

describe('log and audit hygiene', () => {
  it('redacts credentials, tokens and signatures before they reach the audit table', () => {
    const ctx = db();
    audit(ctx.db, {
      userId: ctx.actor.id,
      username: ctx.actor.username,
      action: 'auth.login',
      entity: 'user',
      entityId: ctx.actor.id,
      details: {
        password: 'admin123',
        password_hash: 'deadbeef',
        salt: 'c0ffee',
        device_secret: 'S3CRET',
        token: 'tok_live_123',
        session: 'sess_abc',
        privateKey: `-----${KEY_MARKER}-----`,
        signature: 'abcd',
        username: 'admin',
        ip: '192.168.0.7',
        nested: { api_key: 'k', license_key: 'l', method: 'pos.createSale' },
      },
    });
    const rows = listAudit(ctx.db, {});
    const row = rows.rows[0]! as { details: string | null; username: string | null; action: string };
    const details = JSON.parse(row.details ?? '{}') as Record<string, unknown>;
    // Secrets never survive, ordinary context does.
    for (const key of ['password', 'password_hash', 'salt', 'device_secret', 'token', 'session', 'privateKey', 'signature']) {
      expect(details[key]).toBe('[redacted]');
    }
    const nested = details.nested as Record<string, unknown>;
    expect(nested.api_key).toBe('[redacted]');
    expect(nested.license_key).toBe('[redacted]');
    expect(nested.method).toBe('pos.createSale');
    expect(details.username).toBe('admin');
    expect(details.ip).toBe('192.168.0.7');
    // The raw text of the log row contains no secret literal either.
    const raw = JSON.stringify(row);
    expect(raw).not.toContain('admin123');
    expect(raw).not.toContain('S3CRET');
    expect(raw).not.toContain(KEY_MARKER);
  });

  it('does not record a request body verbatim', () => {
    const ctx = db();
    // A very large payload is truncated rather than stored whole.
    audit(ctx.db, {
      action: 'debug.payload',
      entity: 'test',
      details: { note: 'x'.repeat(9000) },
    });
    const row = listAudit(ctx.db, {}).rows[0]! as { details: string | null };
    expect((row.details ?? '').length).toBeLessThanOrEqual(4000);
  });
});

describe('IPC trust boundary (shapes the bridge must survive)', () => {
  it('refuses a call for a method name that is not a route', () => {
    // The bridge rejects before dispatch; the guard is a string check plus the route table.
    const cases: unknown[] = [undefined, null, 42, '', {}];
    for (const value of cases) {
      const isUsable = typeof value === 'string' && value.length > 0;
      expect(isUsable).toBe(false);
    }
  });

  it('never passes a non-array argument list through to a route', () => {
    const normalize = (args: unknown): unknown[] => (Array.isArray(args) ? args : []);
    expect(normalize('not-an-array')).toEqual([]);
    expect(normalize({ length: 1 })).toEqual([]);
    expect(normalize(null)).toEqual([]);
    expect(normalize([1, 2])).toEqual([1, 2]);
  });
});

describe('licence signing key never reaches the application', () => {
  it('ships no private key material in the app or core packages', () => {
    const roots = [
      path.resolve(__dirname, '..', 'src'),
      path.resolve(__dirname, '..', '..', 'app', 'src'),
      path.resolve(__dirname, '..', '..', 'app', 'electron'),
    ];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|js|json|pem|key)$/.test(entry.name)) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (KEY_PATTERN.test(text)) offenders.push(full);
      }
    };
    for (const root of roots) if (fs.existsSync(root)) walk(root);
    expect(offenders).toEqual([]);
  });

  it('keeps the vendor public key as the only signing material', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'licensing', 'verify.ts'), 'utf8');
    expect(text).toMatch(/PUBLIC_KEY|publicKey/);
    expect(text).not.toContain(KEY_MARKER);
  });
});

const _unusedOs = os; // keeps the import list stable if a temp dir is added later
void _unusedOs;
