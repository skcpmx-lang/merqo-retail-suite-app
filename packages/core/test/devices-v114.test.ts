/**
 * v1.1.4 — multi-PC foundation: store identity, device enrolment, admin approval,
 * licensed capacity, device credentials, persisted sessions, pairing tokens,
 * idempotency and the event outbox.
 *
 * These tests exercise real SQLite (a temp file per suite) and real crypto; nothing
 * is mocked, because the rules being tested are exactly the ones that stop one
 * shop's terminal from reading another shop's data.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  activeSessions,
  appendEvent,
  approveDevice,
  capacitySummary,
  checkDeviceBinding,
  consumePairingToken,
  createDeviceSession,
  createPairingToken,
  enrolDevice,
  getDevice,
  getStoreIdentity,
  issueDeviceSecret,
  latestSeq,
  listDevices,
  initializeApp,
  openDatabase,
  readEvents,
  rejectDevice,
  renameDevice,
  revokeDevice,
  revokeDeviceSession,
  validateDeviceSession,
  verifyDeviceSecret,
  withIdempotency,
  IdempotencyError,
  DeviceError,
  type Db,
  type EnrolInput,
} from '../src/index.js';
import { makeTestDb, seedProducts } from './helpers.js';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A real store database with the owner account that approves devices. */
function fresh(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-devices-'));
  dirs.push(dir);
  const db = openDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
  initializeApp(db, {
    businessName: 'টেস্ট স্টোর',
    businessAddress: 'চট্টগ্রাম',
    businessPhone: '01700000000',
    adminFullName: 'দোকান মালিক',
    adminUsername: 'owner',
    adminPassword: 'owner123',
  });
  return db;
}

const admin = { id: 1, username: 'owner' };

function enrol(db: Db, overrides: Partial<EnrolInput> = {}): ReturnType<typeof enrolDevice> {
  const identity = getStoreIdentity(db);
  return enrolDevice(db, {
    device_id: overrides.device_id ?? 'DEV-A',
    device_name: overrides.device_name ?? 'Counter 1',
    role: overrides.role ?? 'SERVER_POS',
    license_id: overrides.license_id ?? 'LIC-SRV',
    store_id: overrides.store_id ?? identity.store_id,
    capacity: overrides.capacity ?? 3,
    issued_at: '2026-11-01T00:00:00.000Z',
    expires_at: null,
    payload: { note: 'test' },
    ...overrides,
  });
}

describe('store identity', () => {
  it('creates one stable store/server identity that never changes between calls', () => {
    const db = fresh();
    const first = getStoreIdentity(db);
    const second = getStoreIdentity(db);
    expect(first.store_id).toMatch(/^STORE-/);
    expect(first.server_id).toMatch(/^SRV-/);
    expect(second.store_id).toBe(first.store_id);
    expect(second.server_id).toBe(first.server_id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM store_servers').get()).toEqual({ n: 1 });
  });
});

describe('enrolment and administrator approval', () => {
  it('refuses any device until the Main PC licence is registered', () => {
    const db = fresh();
    // A client must wait for the shop's own (Main PC) licence to be registered.
    expect(() => enrol(db, { role: 'CLIENT_POS', license_id: 'LIC-C1' })).toThrow(DeviceError);
    try {
      enrol(db, { role: 'CLIENT_POS', license_id: 'LIC-C1' });
    } catch (err) {
      expect((err as DeviceError).code).toBe('NO_LICENSE');
    }
    // The Main PC itself may enrol, because it is the one presenting that licence.
    expect(enrol(db, { role: 'SERVER_POS', license_id: 'LIC-SRV' }).status).toBe('pending');
  });

  it('keeps a new client pending — a valid licence alone never grants access', () => {
    const db = fresh();
    enrol(db, { device_id: 'DEV-SRV', role: 'SERVER_POS', license_id: 'LIC-SRV', capacity: 3 });
    approveDevice(db, 'DEV-SRV', admin);
    const client = enrol(db, { device_id: 'DEV-C1', role: 'CLIENT_POS', license_id: 'LIC-C1' });
    expect(client.status).toBe('pending');
    expect(listDevices(db, { status: 'pending' })).toHaveLength(1);
    // A pending device cannot present a credential yet.
    expect(() => issueDeviceSecret(db, 'DEV-C1')).toThrow(DeviceError);
    expect(() => createDeviceSession(db, { deviceId: 'DEV-C1', userId: 1 })).toThrow(DeviceError);
  });

  it('approves, rejects and revokes with an audit trail', () => {
    const db = fresh();
    enrol(db, { device_id: 'DEV-SRV', role: 'SERVER_POS', license_id: 'LIC-SRV', capacity: 5 });
    enrol(db, { device_id: 'DEV-C1', role: 'CLIENT_POS', license_id: 'LIC-C1' });
    enrol(db, { device_id: 'DEV-C2', role: 'CLIENT_POS', license_id: 'LIC-C2' });

    const approved = approveDevice(db, 'DEV-C1', admin);
    expect(approved.status).toBe('approved');
    expect(approved.decided_by).toBe(admin.id);

    const rejected = rejectDevice(db, 'DEV-C2', admin, 'পুরোনো পিসি');
    expect(rejected.status).toBe('rejected');

    const revoked = revokeDevice(db, 'DEV-C1', admin, 'দোকান বদলেছে');
    expect(revoked.status).toBe('revoked');
    expect(getDevice(db, 'DEV-C1')!.status).toBe('revoked');

    const actions = (
      db
        .prepare(
          `SELECT action FROM audit_logs WHERE entity = 'terminal' AND action <> 'device.enrol_requested'
            ORDER BY id`,
        )
        .all() as { action: string }[]
    ).map((a) => a.action);
    expect(actions).toEqual(['device.approved', 'device.rejected', 'device.revoked']);
  });

  it('does not let a revoked device enrol itself back in', () => {
    const db = fresh();
    enrol(db, { device_id: 'DEV-SRV', role: 'SERVER_POS', license_id: 'LIC-SRV', capacity: 4 });
    enrol(db, { device_id: 'DEV-C1', role: 'CLIENT_POS', license_id: 'LIC-C1' });
    approveDevice(db, 'DEV-C1', admin);
    revokeDevice(db, 'DEV-C1', admin, 'হারিয়ে গেছে');
    expect(() => enrol(db, { device_id: 'DEV-C1', license_id: 'LIC-C1' })).toThrow(/বাতিল/);
    expect(() => approveDevice(db, 'DEV-C1', admin)).toThrow(DeviceError);
  });

  it('renames a device and records who did it', () => {
    const db = fresh();
    enrol(db, { device_id: 'DEV-SRV', role: 'SERVER_POS', license_id: 'LIC-SRV', capacity: 2 });
    const renamed = renameDevice(db, 'DEV-SRV', 'মূল কাউন্টার', admin);
    expect(renamed.device_name).toBe('মূল কাউন্টার');
    const row = db.prepare("SELECT details FROM audit_logs WHERE action = 'device.renamed'").get() as {
      details: string;
    };
    expect(row.details).toContain('মূল কাউন্টার');
  });
});

describe('licensed capacity', () => {
  it('enforces the capacity stated on the Main PC licence', () => {
    const db = fresh();
    enrol(db, { device_id: 'DEV-SRV', role: 'SERVER_POS', license_id: 'LIC-SRV', capacity: 2 });
    approveDevice(db, 'DEV-SRV', admin);
    enrol(db, { device_id: 'DEV-C1', role: 'CLIENT_POS', license_id: 'LIC-C1' });
    expect(capacitySummary(db)).toMatchObject({ licensed: 2, approved: 1, pending: 1, available: 0 });
    // The pending slot is inside the licensed capacity, so approving it is allowed…
    approveDevice(db, 'DEV-C1', admin);
    expect(capacitySummary(db)).toMatchObject({ licensed: 2, approved: 2, pending: 0, available: 0 });
    // …but a third device is refused outright instead of piling up unapprovable requests.
    expect(() => enrol(db, { device_id: 'DEV-C2', role: 'CLIENT_POS', license_id: 'LIC-C2' })).toThrow(
      /স্লট/,
    );
  });

  it('keeps devices valid when capacity grows and refuses to silently drop them when it shrinks', () => {
    const db = fresh();
    enrol(db, { device_id: 'DEV-SRV', role: 'SERVER_POS', license_id: 'LIC-SRV', capacity: 3 });
    approveDevice(db, 'DEV-SRV', admin);
    enrol(db, { device_id: 'DEV-C1', role: 'CLIENT_POS', license_id: 'LIC-C1' });
    approveDevice(db, 'DEV-C1', admin);
    expect(capacitySummary(db)).toMatchObject({ licensed: 3, approved: 2, available: 1 });

    // A re-issued server licence with a bigger capacity: nothing is invalidated.
    enrol(db, { device_id: 'DEV-SRV', role: 'SERVER_POS', license_id: 'LIC-SRV-2', capacity: 6 });
    expect(capacitySummary(db)).toMatchObject({ licensed: 6, approved: 2, available: 4 });

    // A smaller capacity does not revoke anybody — it only blocks new approvals.
    enrol(db, { device_id: 'DEV-SRV', role: 'SERVER_POS', license_id: 'LIC-SRV-3', capacity: 1 });
    expect(getDevice(db, 'DEV-C1')!.status).toBe('approved');
    expect(capacitySummary(db).available).toBe(0);
  });
});

describe('device credentials and sessions', () => {
  function approvedPair() {
    const db = fresh();
    enrol(db, { device_id: 'DEV-SRV', role: 'SERVER_POS', license_id: 'LIC-SRV', capacity: 3 });
    approveDevice(db, 'DEV-SRV', admin);
    return db;
  }

  it('issues a secret once and verifies it in constant time', () => {
    const db = approvedPair();
    const secret = issueDeviceSecret(db, 'DEV-SRV');
    expect(secret).toHaveLength(64);
    expect(verifyDeviceSecret(db, 'DEV-SRV', secret).device_id).toBe('DEV-SRV');
    expect(() => verifyDeviceSecret(db, 'DEV-SRV', 'x'.repeat(64))).toThrow(/ক্রেডেনশিয়াল/);
    // Only a digest is persisted.
    const row = db.prepare('SELECT secret_hash FROM terminal_credentials WHERE device_id = ?').get('DEV-SRV') as {
      secret_hash: string;
    };
    expect(row.secret_hash).not.toBe(secret);
    expect(row.secret_hash).toHaveLength(64);
  });

  it('persists sessions, slides their expiry and revokes them on demand', () => {
    const db = approvedPair();
    const token = createDeviceSession(db, { deviceId: 'DEV-SRV', userId: 1 });
    expect(validateDeviceSession(db, token).device.device_id).toBe('DEV-SRV');
    expect(activeSessions(db)).toHaveLength(1);

    revokeDeviceSession(db, token);
    expect(() => validateDeviceSession(db, token)).toThrow(/বাতিল/);
    expect(activeSessions(db)).toHaveLength(0);
  });

  it('kills sessions the moment the device is revoked', () => {
    const db = approvedPair();
    const token = createDeviceSession(db, { deviceId: 'DEV-SRV', userId: 1 });
    revokeDevice(db, 'DEV-SRV', admin, 'নিরাপত্তা ইস্যু');
    expect(() => validateDeviceSession(db, token)).toThrow(DeviceError);
  });
});

describe('pairing tokens', () => {
  it('accepts a code once and rejects a replay', () => {
    const db = fresh();
    const { code } = createPairingToken(db, { createdBy: admin.id });
    consumePairingToken(db, code, 'DEV-C1');
    expect(() => consumePairingToken(db, code, 'DEV-C1')).toThrow(/আগেই/);
  });

  it('rejects an expired code', () => {
    const db = fresh();
    const { code } = createPairingToken(db, { ttlMs: -1000 });
    expect(() => consumePairingToken(db, code, 'DEV-C1')).toThrow(/সময় শেষ/);
  });
});

describe('idempotency', () => {
  it('runs an operation once and replays the stored answer', () => {
    const db = fresh();
    let runs = 0;
    const body = { amount: 500, method: 'cash' };
    const first = withIdempotency(db, { key: 'k-1', method: 'payments.record', body }, () => {
      runs += 1;
      return { ok: true, id: 42 };
    });
    const second = withIdempotency(db, { key: 'k-1', method: 'payments.record', body }, () => {
      runs += 1;
      return { ok: true, id: 99 };
    });
    expect(first).toEqual({ ok: true, id: 42 });
    expect(second).toEqual({ ok: true, id: 42 });
    expect(runs).toBe(1);
  });

  it('refuses a reused key with a different body', () => {
    const db = fresh();
    withIdempotency(db, { key: 'k-2', method: 'sales.create', body: { total: 100 } }, () => 'done');
    expect(() =>
      withIdempotency(db, { key: 'k-2', method: 'sales.create', body: { total: 200 } }, () => 'other'),
    ).toThrow(IdempotencyError);
  });
});

describe('event outbox', () => {
  it('assigns a monotonic sequence and can be resumed from a point', () => {
    const db = fresh();
    const identity = getStoreIdentity(db);
    appendEvent(db, { storeId: identity.store_id, type: 'sale.created', entityId: 1 });
    appendEvent(db, { storeId: identity.store_id, type: 'inventory.updated', entityId: 7, payload: { qty: 3 } });
    appendEvent(db, { storeId: identity.store_id, type: 'sale.voided', entityId: 1 });

    const all = readEvents(db, 0);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(all.map((e) => e.type)).toEqual(['sale.created', 'inventory.updated', 'sale.voided']);
    expect(JSON.parse(all[1]!.payload)).toEqual({ qty: 3 });
    expect(readEvents(db, 2).map((e) => e.type)).toEqual(['sale.voided']);
    expect(latestSeq(db)).toBe(3);
  });
});

describe('licence payload v2 / v1 compatibility', () => {
  it('binds a v2 payload to its store and device and still accepts a v1 payload', () => {
    const v2 = {
      v: 1 as const,
      license_id: 'LIC-1',
      org: 'Test Store',
      edition: 'standard' as const,
      issued_at: '2026-11-01T00:00:00.000Z',
      expires_at: null,
      max_devices: 5,
      fingerprint: 'f'.repeat(40),
      device_components: [],
      fingerprint_version: 1,
      features: [],
      generator: 'test',
      store_id: 'STORE-A',
      device_id: 'DEV-A',
      device_role: 'CLIENT_POS' as const,
      device_capacity: 5,
    };
    expect(checkDeviceBinding(v2, { storeId: 'STORE-A', deviceId: 'DEV-A', role: 'CLIENT_POS' })).toEqual({
      ok: true,
    });
    expect(checkDeviceBinding(v2, { storeId: 'STORE-B' })).toMatchObject({ ok: false, code: 'STORE_MISMATCH' });
    expect(checkDeviceBinding(v2, { storeId: 'STORE-A', deviceId: 'DEV-B' })).toMatchObject({
      ok: false,
      code: 'DEVICE_MISMATCH',
    });
    expect(checkDeviceBinding(v2, { storeId: 'STORE-A', deviceId: 'DEV-A', role: 'SERVER_POS' })).toMatchObject({
      ok: false,
      code: 'ROLE_MISMATCH',
    });

    const v1 = { ...v2, store_id: undefined, device_id: undefined, device_role: undefined };
    expect(checkDeviceBinding(v1, { storeId: 'ANY-STORE', deviceId: 'ANY-DEV', role: 'SERVER_POS' }).ok).toBe(true);
  });

  it('does not disturb the existing retail data when the v5 migration runs', () => {
    const ctx = makeTestDb();
    try {
      const seeded = seedProducts(ctx);
      expect(seeded.rice.id).toBeGreaterThan(0);
      expect(ctx.db.pragma('user_version', { simple: true })).toBe(5);
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM products').get()).toEqual({ n: 2 });
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM store_servers').get()).toEqual({ n: 1 });
    } finally {
      ctx.cleanup();
    }
  });
});
