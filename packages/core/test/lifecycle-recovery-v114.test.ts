/**
 * v1.1.4 audit — licence/device lifecycle on the Main App side.
 *
 * Question this suite answers: can a revoked, expired, mismatched or corrupted licence (or a
 * revoked device) regain access through a restart, an offline read, a cached state or a recovery
 * path? Every case here is adversarial — the happy paths live in the other suites.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DeviceError,
  verifyLicense,
  activate,
  approveDevice,
  capacitySummary,
  createBackup,
  createDeviceSession,
  enrolDevice,
  getActivationState,
  getDeviceFingerprint,
  getStoreIdentity,
  initializeApp,
  issueLicense,
  licensedCapacity,
  listDevices,
  openDatabase,
  rejectDevice,
  revokeDevice,
  revokeDeviceSession,
  validateBackup,
  validateDeviceSession,
  verifyActivationRecord,
  type Db,
} from '../src/index.js';

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-recovery-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pubB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privB64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

function fileDb(dir: string): Db {
  const db = openDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
  initializeApp(db, {
    businessName: 'রিকভারি মার্ট',
    businessAddress: 'ঢাকা',
    businessPhone: '01700000000',
    adminFullName: 'মালিক',
    adminUsername: 'owner',
    adminPassword: 'owner123',
  });
  return db;
}

const host = getDeviceFingerprint(true);
const verifyLicenseForTest = (
  license: Parameters<typeof verifyLicense>[0],
  device = host,
) => verifyLicense(license, { device, publicKeyB64: keys.pubB64 });
const keys = makeKeys();
const actor = { id: 1, username: 'owner' };

const issue = (extra: Record<string, unknown> = {}) =>
  issueLicense({ org: 'রিকভারি মার্ট', device: host, maxDevices: 3, ...extra }, keys.privB64);

function enrol(db: Db, deviceId: string, role: 'CLIENT_POS' | 'SERVER_POS' = 'CLIENT_POS') {
  const store = getStoreIdentity(db);
  return enrolDevice(db, {
    device_id: deviceId,
    device_name: deviceId,
    role,
    license_id: `LIC-${deviceId}`,
    store_id: store.store_id,
    capacity: 1,
    issued_at: new Date().toISOString(),
    payload: {},
  });
}

describe('restart and offline access', () => {
  it('keeps an activation and its devices across a real restart, and still enforces capacity', () => {
    const dir = tmpDir();
    const first = fileDb(dir);
    expect(activate(first, { key: issue().key, publicKeyB64: keys.pubB64 }, actor).activated).toBe(true);
    enrol(first, 'DEV-A');
    approveDevice(first, 'DEV-A', actor);
    first.close();

    const reopened = openDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
    const state = getActivationState(reopened, keys.pubB64);
    expect(state.activated).toBe(true);
    expect(licensedCapacity(reopened)).toBe(3);
    expect(listDevices(reopened, { status: 'approved' }).map((d) => d.device_id)).toEqual(['DEV-A']);
    reopened.close();
  });

  it('refuses access when the stored activation payload was corrupted', () => {
    const dir = tmpDir();
    const db = fileDb(dir);
    activate(db, { key: issue().key, publicKeyB64: keys.pubB64 }, actor);
    db.prepare("UPDATE activations SET payload = '{broken'").run();
    const state = getActivationState(db, keys.pubB64);
    expect(state.activated).toBe(false);
    expect(state.reason).toBe('schema_invalid');
    // A corrupted row must not keep granting capacity either.
    expect(licensedCapacity(db)).toBe(0);
    db.close();
  });

  it('refuses access when the stored signature was altered', () => {
    const dir = tmpDir();
    const db = fileDb(dir);
    activate(db, { key: issue().key, publicKeyB64: keys.pubB64 }, actor);
    db.prepare('UPDATE activations SET signature = ?').run('AAAA');
    const state = getActivationState(db, keys.pubB64);
    expect(state.activated).toBe(false);
    expect(['signature_invalid', 'error']).toContain(state.reason);
    db.close();
  });

  it('a licence copied to a different store does not activate there', () => {
    const dirA = tmpDir();
    const dirB = tmpDir();
    const a = fileDb(dirA);
    const b = fileDb(dirB);
    const bound = issue({ storeId: getStoreIdentity(a).store_id });
    expect(activate(a, { key: bound.key, publicKeyB64: keys.pubB64 }, actor).activated).toBe(true);
    const refused = activate(b, { key: bound.key, publicKeyB64: keys.pubB64 }, actor);
    expect(refused.activated).toBe(false);
    expect(refused.reason).toBe('store_mismatch');
    expect(getActivationState(b, keys.pubB64).activated).toBe(false);
    a.close();
    b.close();
  });

  it('survives a backup → restore cycle with activation, capacity and approvals intact', () => {
    const dir = tmpDir();
    const db = fileDb(dir);
    activate(db, { key: issue().key, publicKeyB64: keys.pubB64 }, actor);
    enrol(db, 'DEV-B');
    approveDevice(db, 'DEV-B', actor);
    const backup = createBackup(db, { dataDir: path.join(dir, 'backups'), appVersion: '1.1.4', actor });
    expect(validateBackup(backup.filePath).ok).toBe(true);

    // Simulate a machine loss: a brand-new database restored from that file.
    db.close();
    const restoreDir = tmpDir();
    const livePath = path.join(restoreDir, 'shop.db');
    fs.copyFileSync(backup.filePath, livePath);
    const restored = openDatabase({ file: livePath, appVersion: '1.1.4' });
    expect(getActivationState(restored, keys.pubB64).activated).toBe(true);
    expect(licensedCapacity(restored)).toBe(3);
    expect(listDevices(restored, { status: 'approved' })).toHaveLength(1);
    restored.close();
  });

  it('an application reinstall (empty database) still activates the same licence', () => {
    const dirOld = tmpDir();
    const oldDb = fileDb(dirOld);
    const licence = issue();
    activate(oldDb, { key: licence.key, publicKeyB64: keys.pubB64 }, actor);
    oldDb.close();

    const fresh = fileDb(tmpDir());
    expect(activate(fresh, { key: licence.key, publicKeyB64: keys.pubB64 }, actor).activated).toBe(true);
    fresh.close();
  });

  it('does not let a clock rollback revive an expired activation', () => {
    const dir = tmpDir();
    const db = fileDb(dir);
    const soon = new Date();
    soon.setDate(soon.getDate() + 2);
    activate(db, { key: issue({ expiresAt: soon.toISOString().slice(0, 10) }).key, publicKeyB64: keys.pubB64 }, actor);

    // The app records the highest clock it has seen; moving the clock back is refused.
    const future = new Date();
    future.setDate(future.getDate() + 30);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'license.max_seen'").run(String(future.getTime()));
    const state = getActivationState(db, keys.pubB64);
    expect(state.activated).toBe(false);
    expect(state.reason).toBe('clock_tamper');
    db.close();
  });
});

describe('device revocation and reactivation', () => {
  it('a revoked device cannot re-enrol, be re-approved, or reuse its session', () => {
    const db = fileDb(tmpDir());
    activate(db, { key: issue().key, publicKeyB64: keys.pubB64 }, actor);
    enrol(db, 'DEV-R');
    approveDevice(db, 'DEV-R', actor);
    const token = createDeviceSession(db, { deviceId: 'DEV-R', userId: 1 });
    expect(validateDeviceSession(db, token).device_id).toBe('DEV-R');

    revokeDevice(db, 'DEV-R', actor, 'ডিভাইস চুরি হয়েছে');

    expect(() => validateDeviceSession(db, token)).toThrowError(DeviceError);
    expect(() => createDeviceSession(db, { deviceId: 'DEV-R', userId: 1 })).toThrowError(/অনুমোদিত নয়/);
    expect(() => enrol(db, 'DEV-R')).toThrowError(/বাতিল করা হয়েছে/);
    expect(() => approveDevice(db, 'DEV-R', actor)).toThrowError(/নতুন লাইসেন্স/);
    db.close();
  });

  it('a revoked session cannot be revived by a restart', () => {
    const dir = tmpDir();
    const db = fileDb(dir);
    activate(db, { key: issue().key, publicKeyB64: keys.pubB64 }, actor);
    enrol(db, 'DEV-S');
    approveDevice(db, 'DEV-S', actor);
    const token = createDeviceSession(db, { deviceId: 'DEV-S', userId: 1 });
    revokeDeviceSession(db, token);
    db.close();

    const reopened = openDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
    expect(() => validateDeviceSession(reopened, token)).toThrowError(/বাতিল/);
    reopened.close();
  });

  it('an approved device re-enrolling does not consume a second slot', () => {
    const db = fileDb(tmpDir());
    activate(db, { key: issue().key, publicKeyB64: keys.pubB64 }, actor);
    enrol(db, 'DEV-C1');
    approveDevice(db, 'DEV-C1', actor);
    const before = capacitySummary(db);
    enrol(db, 'DEV-C1'); // same device re-registers (app restart on the client)
    const after = capacitySummary(db);
    expect(after.approved).toBe(before.approved);
    expect(after.available).toBe(before.available);
    db.close();
  });

  it('a rejected device cannot open a session', () => {
    const db = fileDb(tmpDir());
    activate(db, { key: issue().key, publicKeyB64: keys.pubB64 }, actor);
    enrol(db, 'DEV-X');
    rejectDevice(db, 'DEV-X', actor, 'অননুমোদিত পিসি');
    expect(() => createDeviceSession(db, { deviceId: 'DEV-X', userId: 1 })).toThrowError(/অনুমোদিত নয়/);
    db.close();
  });
});

describe('device limit enforcement', () => {
  it('counts pending requests against the licence and blocks beyond it', () => {
    const db = fileDb(tmpDir());
    activate(db, { key: issue({ maxDevices: 2 }).key, publicKeyB64: keys.pubB64 }, actor);
    enrol(db, 'DEV-1');
    enrol(db, 'DEV-2');
    expect(capacitySummary(db)).toMatchObject({ licensed: 2, pending: 2, approved: 0, available: 0 });
    expect(() => enrol(db, 'DEV-3')).toThrowError(/স্লট ব্যবহৃত/);
    db.close();
  });

  it('a SERVER_POS registration is allowed on an empty shop but never expands the limit', () => {
    const db = fileDb(tmpDir());
    // No activation yet: only the server role may register (it carries the shop licence).
    enrol(db, 'DEV-SRV', 'SERVER_POS');
    expect(capacitySummary(db).licensed).toBe(1);
    // A client still cannot enrol without a licensed capacity from the shop licence.
    // The shop's own slot is now the only one, so a client is refused for capacity.
    expect(capacitySummary(db)).toMatchObject({ licensed: 1, pending: 1, available: 0 });
    expect(() => enrol(db, 'DEV-CLIENT')).toThrowError(/অনুমতি আছে/);
    db.close();
  });

  it('capacity from a verified activation is not exceeded by approvals', () => {
    const db = fileDb(tmpDir());
    activate(db, { key: issue({ maxDevices: 1 }).key, publicKeyB64: keys.pubB64 }, actor);
    enrol(db, 'DEV-ONLY');
    approveDevice(db, 'DEV-ONLY', actor);
    expect(capacitySummary(db).available).toBe(0);
    db.close();
  });
});

describe('verification cannot be short-circuited', () => {
  it('a licence signed by any key other than the embedded vendor key is refused', () => {
    const db = fileDb(tmpDir());
    const licence = issue();
    activate(db, { key: licence.key, publicKeyB64: keys.pubB64 }, actor);

    // No publicKeyB64 supplied → the app falls back to the production vendor key, which did
    // not sign this test licence. A shop cannot substitute its own key.
    const state = verifyActivationRecord(licence.license, undefined, host);
    expect(state.activated).toBe(false);
    expect(state.reason).toBe('signature_invalid');

    // The same licence *does* verify once the matching vendor key is supplied — the refusal is
    // about the key, not about the hardware.
    expect(verifyLicenseForTest(licence.license).activated).toBe(true);
    db.close();
  });

  it('re-verification fails on different hardware even with a valid signature', () => {
    const licence = issue();
    expect(verifyLicenseForTest(licence.license).activated).toBe(true);
    const other = getDeviceFingerprint(true);
    const wrongMachine = verifyLicenseForTest(licence.license, { ...other, hash: 'deadbeef', components: [] });
    expect(wrongMachine.activated).toBe(false);
  });
});
