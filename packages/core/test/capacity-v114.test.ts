/**
 * v1.1.4 — licensed device capacity (Main App ↔ multi-PC enrolment).
 *
 * Defects fixed and guarded here:
 *
 * 1. Nothing in production ever wrote a `SERVER_POS` row to `device_licenses`, so
 *    `licensedCapacity()` always returned 0 and every client enrolment died with NO_LICENSE —
 *    the multi-PC feature could not work for a real, activated shop. Capacity now falls back to
 *    the Main App's own *verified* activation row.
 * 2. The pairing claim used to accept `role: 'SERVER_POS'` and any `capacity` it was sent, so a
 *    LAN device with a pairing code could install itself as the server and inflate the licensed
 *    device count. The server role is no longer claimable and capacity is clamped.
 */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DeviceError,
  MAX_LICENSED_DEVICES,
  activate,
  capacitySummary,
  enrolDevice,
  getActivationState,
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

describe('licensed capacity', () => {
  const keys = makeKeys();
  const host = getDeviceFingerprint(true);
  const issue = (maxDevices: number, deviceCapacity?: number) =>
    issueLicense({ org: 'ক্যাপাসিটি স্টোর', device: host, maxDevices, deviceCapacity }, keys.privB64);

  it('is zero for a shop that has not activated a licence', () => {
    const ctx = makeTestDb();
    expect(licensedCapacity(ctx.db)).toBe(0);
    expect(capacitySummary(ctx.db).available).toBe(0);
    ctx.cleanup();
  });

  it('uses the verified activation payload once the Main App is activated', () => {
    const ctx = makeTestDb();
    const { key } = issue(3);
    expect(activate(ctx.db, { key, publicKeyB64: keys.pubB64 }, ctx.actor).activated).toBe(true);
    expect(licensedCapacity(ctx.db)).toBe(3);
    expect(capacitySummary(ctx.db).licensed).toBe(3);
    expect(capacitySummary(ctx.db).available).toBe(3);
    ctx.cleanup();
  });

  it('prefers an explicit device_capacity over max_devices', () => {
    const ctx = makeTestDb();
    const { key } = issue(2, 5);
    expect(activate(ctx.db, { key, publicKeyB64: keys.pubB64 }, ctx.actor).activated).toBe(true);
    expect(licensedCapacity(ctx.db)).toBe(5);
    ctx.cleanup();
  });

  it('prefers a registered SERVER_POS row over the activation fallback', () => {
    const ctx = makeTestDb();
    const { key } = issue(2);
    activate(ctx.db, { key, publicKeyB64: keys.pubB64 }, ctx.actor);
    const store = getStoreIdentity(ctx.db);
    ctx.db
      .prepare(
        `INSERT INTO device_licenses (license_id, store_id, device_id, role, capacity, edition,
            issued_at, expires_at, status, payload, registered_at)
         VALUES ('LIC-SRV', ?, 'DEV-SRV', 'SERVER_POS', 4, 'standard', ?, NULL, 'active', '{}', ?)`,
      )
      .run(store.store_id, new Date().toISOString(), new Date().toISOString());
    expect(licensedCapacity(ctx.db)).toBe(4);
    ctx.cleanup();
  });

  it('ignores an unreadable activation payload instead of throwing', () => {
    const ctx = makeTestDb();
    ctx.db
      .prepare(
        `INSERT INTO activations (license_id, license_key, payload, signature, device_hash, org, activated_at, last_check_at)
         VALUES ('LIC-BAD','', '{not json', '', 'h', 'org', ?, ?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString());
    expect(licensedCapacity(ctx.db)).toBe(0);
    ctx.cleanup();
  });

  it('lets exactly as many clients enrol as the licence allows', () => {
    const ctx = makeTestDb();
    const { key } = issue(2);
    expect(activate(ctx.db, { key, publicKeyB64: keys.pubB64 }, ctx.actor).activated).toBe(true);
    const store = getStoreIdentity(ctx.db);
    const enrol = (deviceId: string, capacity = 1) =>
      enrolDevice(ctx.db, {
        device_id: deviceId,
        device_name: deviceId,
        role: 'CLIENT_POS',
        license_id: 'LIC-SRV',
        store_id: store.store_id,
        capacity,
        issued_at: new Date().toISOString(),
        payload: {},
      });

    enrol('DEV-C1');
    enrol('DEV-C2');
    expect(capacitySummary(ctx.db).pending).toBe(2);
    expect(capacitySummary(ctx.db).available).toBe(0);
    expect(() => enrol('DEV-C3')).toThrowError(/স্লট ব্যবহৃত/);
    ctx.cleanup();
  });

  it('clamps a claimed capacity to the hard ceiling', () => {
    const ctx = makeTestDb();
    const { key } = issue(1);
    activate(ctx.db, { key, publicKeyB64: keys.pubB64 }, ctx.actor);
    const store = getStoreIdentity(ctx.db);
    enrolDevice(ctx.db, {
      device_id: 'DEV-HUGE',
      device_name: 'huge',
      role: 'SERVER_POS',
      license_id: 'LIC-HUGE',
      store_id: store.store_id,
      capacity: 1_000_000,
      issued_at: new Date().toISOString(),
      payload: {},
    });
    const row = ctx.db.prepare("SELECT capacity FROM device_licenses WHERE license_id = 'LIC-HUGE'").get() as {
      capacity: number;
    };
    expect(row.capacity).toBe(MAX_LICENSED_DEVICES);
    ctx.cleanup();
  });
});

describe('pairing claim role', () => {
  it('never lets a remote device claim the server role', () => {
    expect(() => validateClaimRole('SERVER_POS')).toThrowError(DeviceError);
    expect(() => validateClaimRole('SERVER_POS')).toThrowError(/প্রধান কম্পিউটার/);
  });

  it('accepts the two client roles and defaults to CLIENT_POS', () => {
    expect(validateClaimRole('CLIENT_POS')).toBe('CLIENT_POS');
    expect(validateClaimRole('CLIENT_MANAGEMENT')).toBe('CLIENT_MANAGEMENT');
    expect(validateClaimRole(undefined)).toBe('CLIENT_POS');
  });

  it('rejects anything that is not a known role', () => {
    for (const role of ['ADMIN', 'server_pos', '', 'CLIENT']) {
      expect(() => validateClaimRole(role), role).toThrowError(DeviceError);
    }
  });
});
