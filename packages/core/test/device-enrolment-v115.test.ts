/**
 * Device enrolment and approval atomicity (v1.1.5, audit finding A-21).
 *
 * A pending device holds a licensed seat, and an approved device can read the shop. Both used to be
 * written as a sequence of statements with no transaction, so a failure in the middle left states
 * that no screen shows and no report explains:
 *
 *   - a pending terminal with no `device_licenses` row (a seat spent on a licence the server does not
 *     know), or the reverse;
 *   - a device marked `rejected` or `revoked` whose secret and sessions still worked, because
 *     revocation ran as a second statement;
 *   - a pairing code consumed by a claim that then failed — so anyone on the LAN could burn the code
 *     the shop had just displayed, and pairing stopped working until someone walked to the Main PC.
 *
 * The capacity check is part of the same step: two enrolments that both read "one slot left" must
 * not both be admitted.
 *
 * Two real SQLite connections to one file are used for the concurrency cases; nothing is mocked,
 * because the property under test is what the database does.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DeviceError,
  approveDevice,
  capacitySummary,
  consumePairingToken,
  createDeviceSession,
  createPairingToken,
  enrolDevice,
  getDevice,
  getStoreIdentity,
  initializeApp,
  issueDeviceSecret,
  loadDatabase,
  rejectDevice,
  revokeDevice,
  validateDeviceSession,
  verifyDeviceSecret,
  type Db,
  type EnrolInput,
} from '../src/index.js';
import { closeTrackedDatabases, openTrackedDatabase, removeTempDirs } from '../../../test-setup/temp-resources.js';

const dirs: string[] = [];
afterAll(() => {
  closeTrackedDatabases();
  removeTempDirs(dirs);
});

/** A real store database; `capacity` is the licensed seat count the Main PC registered. */
function shop(capacity = 3): { db: Db; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-enrol-'));
  dirs.push(dir);
  const file = path.join(dir, 'shop.db');
  const db = openTrackedDatabase({ file, appVersion: '1.1.5' });
  initializeApp(db, {
    businessName: 'এনরোল দোকান',
    businessAddress: 'টাঙ্গাইল',
    businessPhone: '01700000000',
    adminFullName: 'মালিক',
    adminUsername: 'owner',
    adminPassword: 'owner123',
  });
  if (capacity > 0) registerServerLicence(db, capacity);
  return { db, file };
}

/** The Main PC's own licence: it is what sets licensed capacity. */
function registerServerLicence(db: Db, capacity: number): void {
  enrolDevice(db, {
    device_id: 'SERVER',
    device_name: 'প্রধান কম্পিউটার',
    role: 'SERVER_POS',
    license_id: 'LIC-SERVER',
    store_id: getStoreIdentity(db).store_id,
    capacity,
    issued_at: '2026-11-01T00:00:00.000Z',
    expires_at: null,
    payload: {},
  });
  approveDevice(db, 'SERVER', { id: 1, username: 'owner' });
}

const admin = { id: 1, username: 'owner' };

function client(db: Db, deviceId: string, overrides: Partial<EnrolInput> = {}) {
  return enrolDevice(db, {
    device_id: deviceId,
    device_name: `কাউন্টার ${deviceId}`,
    role: 'CLIENT_POS',
    license_id: `LIC-${deviceId}`,
    store_id: getStoreIdentity(db).store_id,
    capacity: 3,
    issued_at: '2026-11-01T00:00:00.000Z',
    expires_at: null,
    payload: {},
    ...overrides,
  });
}

const count = (db: Db, sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { c: number }).c;

/**
 * Make the *n*-th write of an operation fail, without breaking the reads that come before it.
 * A trigger aborts the insert; renaming a table aborts any access to it. Both leave the schema the
 * code under test needs to run up to that point.
 */
function failInserts(table: string) {
  return (db: Db) =>
    db.exec(
      `CREATE TRIGGER forced_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'forced failure'); END;`,
    );
}
const auditRows = (db: Db, action: string) => count(db, 'SELECT COUNT(*) c FROM audit_logs WHERE action = ?', action);
const terminals = (db: Db) => count(db, 'SELECT COUNT(*) c FROM terminals');
const licences = (db: Db) => count(db, 'SELECT COUNT(*) c FROM device_licenses');

describe('enrolment writes terminal, licence and audit as one step', () => {
  it('registers a pending device with its licence row and one audit line', () => {
    const { db } = shop();
    const terminal = client(db, 'DEV-1');

    expect(terminal.status).toBe('pending');
    expect(count(db, 'SELECT COUNT(*) c FROM device_licenses WHERE license_id = ?', 'LIC-DEV-1')).toBe(1);
    // One line for the server's own registration, one for this device.
    expect(auditRows(db, 'device.enrol_requested')).toBe(2);
    // The server licence plus the client: two seats of three are now held (one approved, one pending).
    expect(capacitySummary(db)).toMatchObject({ licensed: 3, approved: 1, pending: 1, available: 1 });
  });

  it('leaves no terminal behind when the licence row cannot be written', () => {
    const { db } = shop();
    const before = { terminals: terminals(db), licences: licences(db), audit: auditRows(db, 'device.enrol_requested') };
    // The terminal row is written first; this makes the *next* write (the licence) fail.
    failInserts('device_licenses')(db);

    expect(() => client(db, 'DEV-2')).toThrow(/forced failure/);
    db.exec('DROP TRIGGER forced_failure');

    expect(terminals(db)).toBe(before.terminals);
    expect(getDevice(db, 'DEV-2')).toBeNull();
    expect(licences(db)).toBe(before.licences);
    expect(auditRows(db, 'device.enrol_requested')).toBe(before.audit);
    // and the seat was not consumed either
    expect(capacitySummary(db).pending).toBe(0);
  });

  it('retries cleanly after an interrupted enrolment', () => {
    const { db } = shop();
    failInserts('device_licenses')(db);
    expect(() => client(db, 'DEV-3')).toThrow();
    db.exec('DROP TRIGGER forced_failure');

    const terminal = client(db, 'DEV-3');
    expect(terminal.status).toBe('pending');
    expect(terminals(db)).toBe(2); // server + this device, no ghost from the failed attempt
    expect(capacitySummary(db)).toMatchObject({ pending: 1, available: 1 });
  });

  it('is idempotent for a repeated enrolment of the same pending device', () => {
    const { db } = shop();
    client(db, 'DEV-4');
    const again = client(db, 'DEV-4');
    expect(again.status).toBe('pending');
    expect(terminals(db)).toBe(2);
    // Re-registering refreshes metadata; it does not consume a second seat.
    expect(capacitySummary(db)).toMatchObject({ pending: 1, available: 1 });
  });

  it('refuses a device from another shop without writing anything', () => {
    const { db } = shop();
    const before = { terminals: terminals(db), audit: auditRows(db, 'device.enrol_requested') };
    expect(() => client(db, 'DEV-X', { store_id: 'STORE-OTHER' })).toThrow(DeviceError);
    expect(terminals(db)).toBe(before.terminals);
    expect(auditRows(db, 'device.enrol_requested')).toBe(before.audit);
    expect(getDevice(db, 'DEV-X')).toBeNull();
  });

  it('never re-admits a revoked device by re-enrolling it', () => {
    const { db } = shop();
    client(db, 'DEV-5');
    approveDevice(db, 'DEV-5', admin);
    revokeDevice(db, 'DEV-5', admin, 'হারিয়ে গেছে');

    expect(() => client(db, 'DEV-5')).toThrow(/বাতিল/);
    expect(getDevice(db, 'DEV-5')!.status).toBe('revoked');
  });
});

describe('capacity is enforced inside the same step as the write', () => {
  it('refuses the enrolment that would exceed the licence', () => {
    const { db } = shop(2); // server + one client
    client(db, 'DEV-6');
    const before = { terminals: terminals(db), pending: capacitySummary(db).pending };

    expect(() => client(db, 'DEV-7')).toThrow(/স্লট/);

    expect(terminals(db)).toBe(before.terminals);
    expect(capacitySummary(db).pending).toBe(before.pending);
  });

  it('admits exactly one of two enrolments competing for the last seat, from two connections', () => {
    const { db, file } = shop(2); // server + one free seat
    const second = openTrackedDatabase({ file, appVersion: '1.1.5' });

    const first = client(db, 'DEV-8');
    expect(first.status).toBe('pending');
    expect(() => client(second, 'DEV-9')).toThrow(/স্লট/);

    // The second connection sees the first one's row, not its own stale pre-check picture.
    expect(capacitySummary(second)).toMatchObject({ licensed: 2, approved: 1, pending: 1, available: 0 });
    expect(terminals(db)).toBe(2);
    second.close();
  });

  it('stores a requested capacity, but the server licence still decides the ceiling', () => {
    const { db } = shop();
    // A client claiming a bigger capacity cannot raise the shop's seat count.
    client(db, 'DEV-10', { capacity: 100 });
    expect(capacitySummary(db).licensed).toBe(3);
  });
});

describe('approval moves the device and its audit line together', () => {
  it('approves once and issues a working credential', () => {
    const { db } = shop();
    client(db, 'DEV-11');
    const approved = approveDevice(db, 'DEV-11', admin);
    expect(approved.status).toBe('approved');
    expect(auditRows(db, 'device.approved')).toBe(2); // the server's own approval + this one

    const secret = issueDeviceSecret(db, 'DEV-11');
    expect(verifyDeviceSecret(db, 'DEV-11', secret).status).toBe('approved');

    // Approving again is a no-op, not a second audit line.
    approveDevice(db, 'DEV-11', admin);
    expect(auditRows(db, 'device.approved')).toBe(2);
  });

  it('does not approve when the audit line cannot be written', () => {
    const { db } = shop();
    client(db, 'DEV-23');
    db.exec('ALTER TABLE audit_logs RENAME TO audit_logs_gone');
    expect(() => approveDevice(db, 'DEV-23', admin)).toThrow();
    db.exec('ALTER TABLE audit_logs_gone RENAME TO audit_logs');

    expect(getDevice(db, 'DEV-23')!.status).toBe('pending');
    expect(capacitySummary(db).approved).toBe(1);
  });

  it('refuses approval past capacity and leaves the device pending', () => {
    const { db } = shop(3); // server + two slots
    client(db, 'DEV-12');
    client(db, 'DEV-13');
    approveDevice(db, 'DEV-12', admin);

    // A shop renewing a licence with fewer seats than it has devices: the next approval must fail
    // and the device must stay pending, not be approved into a seat that no longer exists.
    db.prepare("UPDATE device_licenses SET capacity = 2 WHERE license_id = 'LIC-SERVER'").run();

    expect(() => approveDevice(db, 'DEV-13', admin)).toThrow(/স্লট/);
    expect(getDevice(db, 'DEV-13')!.status).toBe('pending');
    expect(capacitySummary(db).approved).toBe(2);
  });
});

describe('rejection and revocation cut access in the same step', () => {
  it('rejecting a pending device removes its credential and sessions', () => {
    const { db } = shop();
    client(db, 'DEV-14');
    // A device can only hold a credential once approved, so approve, connect, then reject is not
    // possible; instead prove that rejection clears whatever exists.
    db.prepare("INSERT INTO terminal_credentials (device_id, secret_hash, created_at) VALUES (?,?,?)").run(
      'DEV-14',
      'hash',
      '2026-11-01T00:00:00.000Z',
    );
    rejectDevice(db, 'DEV-14', admin, 'ভুল ডিভাইস');

    expect(getDevice(db, 'DEV-14')!.status).toBe('rejected');
    expect(count(db, 'SELECT COUNT(*) c FROM terminal_credentials WHERE device_id = ?', 'DEV-14')).toBe(0);
  });

  it('does not mark a device rejected when its audit line cannot be written', () => {
    const { db } = shop();
    client(db, 'DEV-24');
    db.exec('ALTER TABLE audit_logs RENAME TO audit_logs_gone');
    expect(() => rejectDevice(db, 'DEV-24', admin, 'ভুল')).toThrow();
    db.exec('ALTER TABLE audit_logs_gone RENAME TO audit_logs');
    expect(getDevice(db, 'DEV-24')!.status).toBe('pending');
  });

  it('revoking an approved device kills its secret and every live session at once', () => {
    const { db } = shop();
    client(db, 'DEV-15');
    approveDevice(db, 'DEV-15', admin);
    issueDeviceSecret(db, 'DEV-15');
    const token = createDeviceSession(db, { deviceId: 'DEV-15', userId: 1 });
    expect(validateDeviceSession(db, token).device_id).toBe('DEV-15');

    revokeDevice(db, 'DEV-15', admin, 'চুরি গেছে');

    expect(getDevice(db, 'DEV-15')!.status).toBe('revoked');
    expect(count(db, 'SELECT COUNT(*) c FROM terminal_credentials WHERE device_id = ?', 'DEV-15')).toBe(0);
    expect(() => validateDeviceSession(db, token)).toThrow();
    expect(
      count(db, "SELECT COUNT(*) c FROM terminal_sessions WHERE device_id = ? AND revoked_at IS NULL", 'DEV-15'),
    ).toBe(0);
    expect(auditRows(db, 'device.revoked')).toBe(1);
  });

  it('leaves the device untouched when the revocation itself fails', () => {
    const { db } = shop();
    client(db, 'DEV-16');
    approveDevice(db, 'DEV-16', admin);
    const secret = issueDeviceSecret(db, 'DEV-16');
    // A revocation that cannot write its audit line must not half-apply.
    db.exec('ALTER TABLE audit_logs RENAME TO audit_logs_gone');
    expect(() => revokeDevice(db, 'DEV-16', admin, 'পরীক্ষা')).toThrow();
    db.exec('ALTER TABLE audit_logs_gone RENAME TO audit_logs');

    expect(getDevice(db, 'DEV-16')!.status).toBe('approved');
    expect(verifyDeviceSecret(db, 'DEV-16', secret).status).toBe('approved');
  });
});

describe('a pairing code is not spent by a claim that fails', () => {
  it('lets the same code be used again after an enrolment that could not proceed', () => {
    const { db } = shop(1); // no free seat for a client
    const { code } = createPairingToken(db);

    // The shape the LAN claim uses (api.ts): consume the code and enrol inside one transaction.
    // `pairingClaim` itself is covered end to end in api-v114.test.ts.
    const claim = () =>
      db
        .transaction(() => {
          consumePairingToken(db, code, 'DEV-17');
          client(db, 'DEV-17');
        })
        .immediate();

    expect(claim).toThrow(/স্লট/);

    // The code was not burned: the shop can still pair a device it has room for.
    expect(count(db, 'SELECT COUNT(*) c FROM pairing_tokens WHERE used_at IS NOT NULL')).toBe(0);
    expect(consumePairingToken.bind(null, db, code, 'DEV-18')).not.toThrow();
  });

  it('still refuses a genuinely replayed code', () => {
    const { db } = shop();
    const { code } = createPairingToken(db);
    consumePairingToken(db, code, 'DEV-19');
    expect(() => consumePairingToken(db, code, 'DEV-20')).toThrow(/আগেই/);
  });
});

describe('the database stays sound after every refused operation', () => {
  it('has no dangling licence or terminal rows', () => {
    const { db } = shop(2);
    client(db, 'DEV-21');
    expect(() => client(db, 'DEV-22')).toThrow();

    // Every terminal has a licence row and vice versa (the invariant the old code could break).
    expect(
      count(
        db,
        `SELECT COUNT(*) c FROM terminals t
          WHERE NOT EXISTS (SELECT 1 FROM device_licenses l WHERE l.device_id = t.device_id)`,
      ),
    ).toBe(0);
    expect(
      count(
        db,
        `SELECT COUNT(*) c FROM device_licenses l
          WHERE NOT EXISTS (SELECT 1 FROM terminals t WHERE t.device_id = l.device_id)`,
      ),
    ).toBe(0);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });
});
