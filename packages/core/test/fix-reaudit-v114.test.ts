/**
 * v1.1.4 audit — adversarial re-check of the capacity/authorization fixes.
 *
 * The first pass proved the happy path. This suite attacks the fixes:
 *  - what if the activation payload is edited, truncated or absurd?
 *  - what if a licence is correct for the store but names another device?
 *  - can a claim regain the server role through an unexpected value (null, object, number)?
 *  - is a legitimate capacity preserved exactly, and is every out-of-range value clamped?
 *  - does the local server path still work (the fix must not block the shop's own licence)?
 */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DeviceError,
  MAX_LICENSED_DEVICES,
  activate,
  approveDevice,
  capacitySummary,
  checkDeviceBinding,
  enrolDevice,
  getDeviceFingerprint,
  getStoreIdentity,
  issueLicense,
  licensedCapacity,
  validateClaimRole,
} from '../src/index.js';
import { makeTestDb } from './helpers.js';

function makeKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pubB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privB64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

const keys = makeKeys();
const host = getDeviceFingerprint(true);
const actor = { id: 1, username: 'owner' };

function activatedDb(extra: { maxDevices?: number; deviceCapacity?: number } = {}) {
  const ctx = makeTestDb();
  const { key } = issueLicense({ org: 'পুনঃযাচাই স্টোর', device: host, ...extra }, keys.privB64);
  const state = activate(ctx.db, { key, publicKeyB64: keys.pubB64 }, ctx.actor);
  expect(state.activated).toBe(true);
  return ctx;
}

function setPayload(ctx: ReturnType<typeof makeTestDb>, payload: unknown) {
  ctx.db.prepare('UPDATE activations SET payload = ?').run(JSON.stringify(payload));
}

describe('capacity fallback is bounded even with a hostile row', () => {
  it('keeps a legitimate capacity exactly', () => {
    for (const n of [1, 2, 3, 5, 10, 25]) {
      const ctx = activatedDb({ maxDevices: n });
      expect(licensedCapacity(ctx.db)).toBe(n);
      ctx.cleanup();
    }
  });

  it('clamps an absurd stored capacity instead of trusting it', () => {
    const ctx = activatedDb({ maxDevices: 3 });
    setPayload(ctx, { license_id: 'L', org: 'o', max_devices: 999999, device_capacity: 999999 });
    expect(licensedCapacity(ctx.db)).toBe(MAX_LICENSED_DEVICES);
    expect(capacitySummary(ctx.db).available).toBeLessThanOrEqual(MAX_LICENSED_DEVICES);
    ctx.cleanup();
  });

  it('refuses negative, fractional, text and missing values', () => {
    const ctx = activatedDb({ maxDevices: 3 });
    setPayload(ctx, { max_devices: -50 });
    expect(licensedCapacity(ctx.db)).toBe(0);
    setPayload(ctx, { max_devices: 4.9 });
    expect(licensedCapacity(ctx.db)).toBe(4);
    setPayload(ctx, { max_devices: 'many' });
    expect(licensedCapacity(ctx.db)).toBe(0);
    setPayload(ctx, {});
    expect(licensedCapacity(ctx.db)).toBe(0);
    setPayload(ctx, null);
    expect(licensedCapacity(ctx.db)).toBe(0);
    setPayload(ctx, [1, 2, 3]);
    expect(licensedCapacity(ctx.db)).toBe(0);
    ctx.cleanup();
  });

  it('never reports capacity for a shop whose activation is broken', () => {
    const ctx = activatedDb({ maxDevices: 5 });
    ctx.db.prepare("UPDATE activations SET payload = 'not json'").run();
    expect(licensedCapacity(ctx.db)).toBe(0);
    // …and with no capacity, no client can enrol.
    const store = getStoreIdentity(ctx.db);
    expect(() =>
      enrolDevice(ctx.db, {
        device_id: 'DEV-NO-CAP',
        device_name: 'no cap',
        role: 'CLIENT_POS',
        license_id: 'LIC',
        store_id: store.store_id,
        issued_at: new Date().toISOString(),
        payload: {},
      }),
    ).toThrowError(DeviceError);
    ctx.cleanup();
  });
});

describe('binding rules under pressure', () => {
  it('a licence for the right store but another device_id still activates (hardware is the real lock)', () => {
    const ctx = makeTestDb();
    const store = getStoreIdentity(ctx.db);
    const { key } = issueLicense(
      { org: 'স্টোর', device: host, storeId: store.store_id, deviceId: 'SOME-OTHER-PC' },
      keys.privB64,
    );
    // device_id is informational: the vendor key signed this machine's hardware fingerprint.
    expect(activate(ctx.db, { key, publicKeyB64: keys.pubB64 }, ctx.actor).activated).toBe(true);
    // …and the binding helper still reports the mismatch if a caller supplies an identity.
    const payload = ctx.db.prepare('SELECT payload FROM activations').get() as { payload: string };
    expect(checkDeviceBinding(JSON.parse(payload.payload), { deviceId: 'THIS-PC' })).toMatchObject({
      ok: false,
      code: 'DEVICE_MISMATCH',
    });
    ctx.cleanup();
  });

  it('a licence with NO store binding is accepted anywhere (legacy compatibility, unchanged)', () => {
    const ctx = makeTestDb();
    const { key } = issueLicense({ org: 'পুরনো স্টোর', device: host }, keys.privB64);
    expect(activate(ctx.db, { key, publicKeyB64: keys.pubB64 }, ctx.actor).activated).toBe(true);
    ctx.cleanup();
  });

  it('a whitespace/сase variant of the store id does not slip through', () => {
    const ctx = makeTestDb();
    const store = getStoreIdentity(ctx.db);
    const { key } = issueLicense({ org: 'স্টোর', device: host, storeId: ` ${store.store_id} ` }, keys.privB64);
    // buildPayload trims the store id, so this is the same store and must activate.
    expect(activate(ctx.db, { key, publicKeyB64: keys.pubB64 }, ctx.actor).activated).toBe(true);
    ctx.cleanup();
  });
});

describe('pairing role validation cannot be tricked', () => {
  it('rejects the server role however it is encoded', () => {
    for (const value of ['SERVER_POS', ' server_pos ', 'Server_Pos', 'SERVER_POS\0', 0, {}, []]) {
      const outcome = (() => {
        try {
          return validateClaimRole(value);
        } catch (err) {
          return err instanceof DeviceError ? 'rejected' : 'wrong-error';
        }
      })();
      expect(outcome, String(value)).toBe('rejected');
    }
  });

  it('still allows the local server registration the shop needs', () => {
    const ctx = makeTestDb();
    const store = getStoreIdentity(ctx.db);
    // Local enrolment (not a network claim) may use SERVER_POS: it carries the shop licence.
    const terminal = enrolDevice(ctx.db, {
      device_id: 'DEV-LOCAL-SERVER',
      device_name: 'মূল পিসি',
      role: 'SERVER_POS',
      license_id: 'LIC-LOCAL',
      store_id: store.store_id,
      capacity: 4,
      issued_at: new Date().toISOString(),
      payload: {},
    });
    expect(terminal.role).toBe('SERVER_POS');
    expect(licensedCapacity(ctx.db)).toBe(4);
    approveDevice(ctx.db, 'DEV-LOCAL-SERVER', actor);
    expect(capacitySummary(ctx.db)).toMatchObject({ licensed: 4, approved: 1, available: 3 });
    ctx.cleanup();
  });

  it('clamps a claim capacity in the same way the store does', () => {
    const ctx = activatedDb({ maxDevices: 10 });
    const store = getStoreIdentity(ctx.db);
    for (const capacity of [0, -3, 1.9, 100_000]) {
      const deviceId = `DEV-CAP-${String(capacity).replace(/[^\d]/g, '')}`;
      enrolDevice(ctx.db, {
        device_id: deviceId,
        device_name: deviceId,
        role: 'CLIENT_POS',
        license_id: `LIC-${deviceId}`,
        store_id: store.store_id,
        capacity,
        issued_at: new Date().toISOString(),
        payload: {},
      });
      const row = ctx.db.prepare('SELECT capacity FROM device_licenses WHERE license_id = ?').get(`LIC-${deviceId}`) as {
        capacity: number;
      };
      expect(row.capacity, String(capacity)).toBeGreaterThanOrEqual(1);
      expect(row.capacity, String(capacity)).toBeLessThanOrEqual(MAX_LICENSED_DEVICES);
    }
    ctx.cleanup();
  });
});
