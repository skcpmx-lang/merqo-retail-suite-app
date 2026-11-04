/**
 * v1.1.4 audit — revocation, renewal and recovery in the License Generator.
 *
 * The generator is the offline source of truth for who holds a licence. These tests pin the
 * lifecycle rules that a recovery/revocation scenario depends on:
 *  - a revoked licence can never be exported again (it used to be re-serialisable, which handed
 *    the customer a working copy of a withdrawn licence);
 *  - a re-issue supersedes the previous record and is the only path back to a working file;
 *  - an expired licence is reported as expired, not as active;
 *  - a corrupt store file fails closed with an actionable message instead of looking like an
 *    empty store (which would hide that every customer record is still there);
 *  - a backup bundle round-trips, and a foreign/corrupt backup is refused.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildBackup,
  createCustomer,
  emptyStore,
  featuresForEdition,
  licenseState,
  parseBackup,
  readStore,
  recordIssuedLicense,
  revokeLicense,
  signLicense,
  toLicenseFile,
  verifyLicenseFile,
  writeStore,
  type DeviceRequest,
  type Store,
} from '../src/domain.js';
import { issueLicense, testFingerprint, verifyLicense } from '@sauda/core';

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-recovery-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pubB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privB64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

const fingerprint = testFingerprint('recovery-device');
const device: DeviceRequest = {
  kind: 'sauda-device-request',
  v: fingerprint.version,
  fingerprint: fingerprint.hash,
  components: fingerprint.components,
  platform: 'win32',
  app_version: '1.1.4',
  business_name: 'রিকভারি স্টোর',
};

function issue(privB64: string, extra: Record<string, unknown> = {}) {
  return signLicense({
    device,
    issue: {
      org: 'রিকভারি স্টোর',
      edition: 'enterprise',
      maxDevices: 3,
      features: featuresForEdition('enterprise'),
      expiresAt: extra.expiresAt as string | null ?? '2030-01-01',
      ...extra,
    },
    privateKeyB64: privB64,
    generatorVersion: '1.1.4',
  });
}

function seeded() {
  const store: Store = emptyStore();
  const customer = createCustomer(store, { name: 'রিকভারি স্টোর', owner: 'মালিক', phone: '01700000000' });
  const keys = makeKey();
  const result = issue(keys.privB64);
  const record = recordIssuedLicense(store, { result, customerId: customer.id, filePath: null });
  return { store, customer, record, keys };
}

describe('revocation', () => {
  it('marks the record revoked and keeps the reason', () => {
    const { store, record } = seeded();
    expect(licenseState(record)).toBe('active');
    revokeLicense(store, record.license_id, 'গ্রাহক টাকা দেননি');
    expect(record.revoked_at).toBeTruthy();
    expect(record.revoke_reason).toContain('টাকা');
    expect(licenseState(record)).toBe('revoked');
  });

  it('refuses to revoke twice or without a written reason', () => {
    const { store, record } = seeded();
    expect(() => revokeLicense(store, record.license_id, '')).toThrowError(/কারণ/);
    revokeLicense(store, record.license_id, 'প্রথম কারণ');
    expect(() => revokeLicense(store, record.license_id, 'আবার')).toThrowError(/আগেই/);
    expect(() => revokeLicense(store, 'LIC-DOES-NOT-EXIST', 'কারণ')).toThrowError(/রেকর্ডে নেই/);
  });

  it('cannot be exported again once revoked (the file would still activate)', () => {
    const { store, record } = seeded();
    const before = toLicenseFile(record);
    expect(JSON.parse(before).license_id).toBe(record.license_id);
    revokeLicense(store, record.license_id, 'প্রত্যাহার');
    expect(() => toLicenseFile(record)).toThrowError(/প্রত্যাহার/);
  });

  it('still verifies as revoked (signature valid, state withheld) when the id is known', () => {
    const { store, record, keys } = seeded();
    const file = toLicenseFile(record);
    revokeLicense(store, record.license_id, 'প্রত্যাহার');
    const outcome = verifyLicenseFile(file, { publicKeyB64: keys.pubB64, device, revokedIds: [record.license_id] });
    expect(outcome.revoked).toBe(true);
    expect(outcome.message).toContain('প্রত্যাহার');
  });
});

describe('renewal and recovery', () => {
  it('a re-issue supersedes the old record and produces a working file', () => {
    const { store, record, keys } = seeded();
    revokeLicense(store, record.license_id, 'হার্ডওয়্যার বদল');
    const renewed = issue(keys.privB64, { expiresAt: '2031-12-31' });
    const newRecord = recordIssuedLicense(store, {
      result: renewed,
      customerId: record.customer_id,
      filePath: null,
      replaces: record.license_id,
    });
    expect(licenseState(record)).toBe('revoked');
    expect(licenseState(newRecord)).toBe('active');
    expect(newRecord.replaces).toBe(record.license_id);
    expect(record.superseded_by).toBe(newRecord.license_id);

    const file = toLicenseFile(newRecord);
    const outcome = verifyLicenseFile(file, { publicKeyB64: keys.pubB64, device, revokedIds: [] });
    expect(outcome.ok).toBe(true);
    expect(outcome.revoked).toBe(false);
  });

  it('reports an expired licence as expired but keeps the record', () => {
    const { store, keys } = seeded();
    const record = recordIssuedLicense(store, { result: issue(keys.privB64, { expiresAt: '2030-01-01' }), customerId: null, filePath: null });
    // The generator refuses to *mint* a past-dated licence, so expiry is a function of time:
    // the same record is active today and expired once that date has passed.
    expect(licenseState(record, new Date('2029-12-31T00:00:00Z'))).toBe('active');
    expect(licenseState(record, new Date('2031-06-01T00:00:00Z'))).toBe('expired');
    // An expired file is still exportable (issuing it was legitimate), but the Main App refuses it.
    expect(() => toLicenseFile(record)).not.toThrow();
    expect(record.revoked_at).toBeNull();
  });

  it('an already-expired signature cannot be activated (core verification path)', () => {
    const { keys } = seeded();
    // Build the payload past its expiry directly: this is exactly what a customer holds once
    // time has moved on, and it is what the Main App must refuse.
    const expired = issueLicense(
      { org: 'রিকভারি স্টোর', device: fingerprint, expiresAt: '2026-01-01', maxDevices: 3 },
      keys.privB64,
    );
    const outcome = verifyLicense(expired.license, { device: fingerprint, publicKeyB64: keys.pubB64 });
    expect(outcome.activated).toBe(false);
    expect(outcome.reason).toBe('expired');
  });

  it('a device replacement needs a new fingerprint-bound licence (old one stops verifying)', () => {
    const { keys } = seeded();
    const oldLicense = issue(keys.privB64);
    const otherDevice = testFingerprint('different-hardware');
    const outcome = verifyLicenseFile(toLicenseFile({
      // The exported file of the old licence, verified against the new hardware.
      license_id: oldLicense.payload.license_id,
      license: oldLicense.license,
    } as never), { publicKeyB64: keys.pubB64, device: {
      kind: 'sauda-device-request', v: otherDevice.version, fingerprint: otherDevice.hash,
      components: otherDevice.components, platform: 'win32', app_version: '1.1.4', business_name: 'নতুন পিসি',
    } });
    expect(outcome.ok).toBe(false);
  });
});

describe('store recovery', () => {
  it('fails closed on a corrupt store file instead of looking empty', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'store.json');
    fs.writeFileSync(file, '{"customers": [', 'utf8');
    expect(() => readStore(file)).toThrowError(/নষ্ট/);
    // The damaged file must be left exactly as it was for a manual recovery.
    expect(fs.readFileSync(file, 'utf8')).toBe('{"customers": [');
  });

  it('rejects a well-formed but structurally wrong store file', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'store.json');
    fs.writeFileSync(file, '[]', 'utf8');
    expect(() => readStore(file)).toThrowError(/কাঠামো/);
  });

  it('creates an empty store only when the file genuinely does not exist', () => {
    const dir = tmpDir();
    const store = readStore(path.join(dir, 'missing.json'));
    expect(store.customers).toEqual([]);
    expect(store.licenses).toEqual([]);
  });

  it('round-trips a backup bundle', () => {
    const { store, record } = seeded();
    const bundle = buildBackup(store, [
      { id: '1', at: new Date().toISOString(), action: 'issued', license_id: record.license_id, license_key_id: 'K',
        org: record.org, note: null, file: null, replaces: null } as never,
    ]);
    const parsed = parseBackup(JSON.stringify(bundle));
    expect(parsed.store.licenses).toHaveLength(1);
    expect(parsed.store.licenses[0]!.license_id).toBe(record.license_id);
    expect(parsed.ledger).toHaveLength(1);
  });

  it('refuses a foreign or damaged backup', () => {
    expect(() => parseBackup('not json')).toThrowError(/JSON/);
    expect(() => parseBackup(JSON.stringify({ kind: 'something-else' }))).toThrowError(/ব্যাকআপ ফাইল নয়/);
    expect(() => parseBackup(JSON.stringify({ kind: 'sauda-license-admin-backup', store: { customers: [] } }))).toThrowError(
      /অসম্পূর্ণ/,
    );
  });

  it('writes the store atomically (temp file then rename)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'store.json');
    const { store } = seeded();
    writeStore(file, store);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(readStore(file).licenses).toHaveLength(1);
  });
});
