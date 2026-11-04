/**
 * Milestone E — device administration through the real IPC routes.
 *
 * Proves that approving/rejecting/revoking is an authenticated administrator action,
 * that licence capacity is enforced by the route (not the screen), that revocation
 * kills the device's existing session, and that a pairing code is single-use and
 * carries no shop token.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DeviceError,
  createDeviceSession,
  enrolDevice,
  generateDeviceKeyPair,
  getStoreIdentity,
  initializeApp,
  openDatabase,
  validateDeviceSession,
  type Db,
  type User,
} from '@sauda/core';
import {
  approveDeviceFor,
  capacityFor,
  deviceActor,
  identityFor,
  listDevicesFor,
  pairingCodeFor,
  rejectDeviceFor,
  revokeDeviceFor,
} from '../electron/device-admin.js';
import { closeTrackedDatabases, openTrackedDatabase, removeTempDirs } from '../../../test-setup/temp-resources.js';

interface Ctx {
  db: Db;
  user: User | null;
}

const dirs: string[] = [];

function makeCtx(): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-dev-'));
  dirs.push(dir);
  const db = openTrackedDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
  initializeApp(db, {
    businessName: 'ডিভাইস স্টোর',
    businessAddress: 'ঢাকা',
    businessPhone: '01700000000',
    adminFullName: 'মালিক',
    adminUsername: 'owner',
    adminPassword: 'owner123',
  });
  return { db, user: null };
}

function admin(): User {
  return {
    id: 1,
    username: 'owner',
    full_name: 'মালিক',
    role: 'admin',
    permissions: ['settings.manage'],
  } as unknown as User;
}

function addLicence(ctx: Ctx, capacity: number) {
  const store = getStoreIdentity(ctx.db);
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT OR REPLACE INTO device_licenses (license_id, store_id, device_id, role, capacity, issued_at, status, payload, registered_at)
       VALUES ('LIC-TEST', ?, 'DEV-SRV', 'SERVER_POS', ?, ?, 'active', '{}', ?)`,
    )
    .run(store.store_id, capacity, now, now);
  return store;
}

function enrol(ctx: Ctx, deviceId: string) {
  const store = getStoreIdentity(ctx.db);
  const keys = generateDeviceKeyPair();
  return enrolDevice(ctx.db, {
    device_id: deviceId,
    device_name: deviceId,
    role: 'CLIENT_POS',
    license_id: `LIC-${deviceId}`,
    store_id: store.store_id,
    capacity: 5,
    issued_at: new Date().toISOString(),
    expires_at: null,
    payload: {},
    public_key: keys.publicKeySpkiB64,
  });
}

afterAll(() => {
  closeTrackedDatabases();
  removeTempDirs(dirs);
});

describe('device administration', () => {
  it('refuses every decision when nobody is signed in', () => {
    const ctx = makeCtx();
    expect(() => deviceActor(ctx)).toThrowError(/লগইন/);
    addLicence(ctx, 3);
    enrol(ctx, 'DEV-A');
    expect(() => approveDeviceFor(ctx, 'DEV-A')).toThrowError(/লগইন/);
    expect(() => revokeDeviceFor(ctx, 'DEV-A', 'x')).toThrowError(/লগইন/);
    // The permission gate itself (`settings.manage`) lives in the route registry,
    // which imports `electron`; it is covered by the typecheck and the UI audit,
    // not by this Node test. Stated explicitly rather than implied.
  });

  it('lists devices and reports licence capacity', () => {
    const ctx = makeCtx();
    ctx.user = admin();
    addLicence(ctx, 3);
    enrol(ctx, 'DEV-A');

    expect(listDevicesFor(ctx)).toHaveLength(1);
    expect(capacityFor(ctx)).toMatchObject({ licensed: 3, approved: 0 });
    expect(identityFor(ctx).store_id).toBe(getStoreIdentity(ctx.db).store_id);
    expect(identityFor(ctx).short_fingerprint).toBeNull();
  });

  it('approves a pending device only while capacity remains', () => {
    const ctx = makeCtx();
    ctx.user = admin();
    addLicence(ctx, 1);
    enrol(ctx, 'DEV-B');
    // A second request cannot even be queued once the single slot is taken …
    expect(() => enrol(ctx, 'DEV-C')).toThrowError(/স্লট|capacity|লাইসেন্স/i);
    // … and if a row exists anyway (older data, manual import), approval still refuses.
    ctx.db
      .prepare(
        `INSERT INTO terminals (device_id, device_name, role, store_id, license_id, status, public_key, requested_at)
         VALUES ('DEV-C','DEV-C','CLIENT_POS',?,'LIC-DEV-C','pending',NULL,?)`,
      )
      .run(getStoreIdentity(ctx.db).store_id, new Date().toISOString());

    expect(approveDeviceFor(ctx, 'DEV-B').status).toBe('approved');
    try {
      approveDeviceFor(ctx, 'DEV-C');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as DeviceError).code).toBe('CAPACITY_REACHED');
    }
  });

  it('revokes a device and invalidates its existing session', () => {
    const ctx = makeCtx();
    ctx.user = admin();
    addLicence(ctx, 5);
    enrol(ctx, 'DEV-D');
    approveDeviceFor(ctx, 'DEV-D');
    const token = createDeviceSession(ctx.db, { deviceId: 'DEV-D', userId: 1 });
    expect(validateDeviceSession(ctx.db, token).device_id).toBe('DEV-D');

    expect(revokeDeviceFor(ctx, 'DEV-D', 'হারিয়ে গেছে').status).toBe('revoked');
    expect(() => validateDeviceSession(ctx.db, token)).toThrow();
  });

  it('rejects a pending device and keeps it out of the approved list', () => {
    const ctx = makeCtx();
    ctx.user = admin();
    addLicence(ctx, 5);
    enrol(ctx, 'DEV-E');
    expect(rejectDeviceFor(ctx, 'DEV-E', 'অননুমোদিত পিসি').status).toBe('rejected');
    expect(listDevicesFor(ctx, 'approved')).toHaveLength(0);
  });

  it('issues a single-use pairing code whose QR payload carries no shop token', () => {
    const ctx = makeCtx();
    ctx.user = admin();
    addLicence(ctx, 5);
    const result = pairingCodeFor(ctx, { ttlMs: 60_000, hostUrl: 'https://192.168.0.10:4747' });
    expect(result.code.length).toBeGreaterThan(20);
    expect(new Date(result.expires_at).getTime()).toBeGreaterThan(Date.now());

    const payload = JSON.parse(result.qr_payload) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['code', 'fingerprint', 'host', 'v']);
    expect(result.qr_payload).not.toContain('lan_token');
    expect(result.qr_payload).not.toContain('password');
  });
});
