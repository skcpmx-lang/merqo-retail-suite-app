/**
 * Sauda License Generator — domain tests.
 *
 * These cover the administration layer (customers, records, ledger, reports,
 * backup, device-request validation) without Electron. Signing itself is
 * exercised in integration.test.ts against the same core the customer app uses.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  FEATURES,
  appendLedger,
  buildBackup,
  createCustomer,
  customerById,
  daysToExpiry,
  emptyStore,
  featuresForEdition,
  isValidEmail,
  isValidFingerprint,
  isValidPhone,
  licenseState,
  listCustomers,
  listLedger,
  listLicenses,
  parseBackup,
  parseDeviceRequest,
  readStore,
  recordIssuedLicense,
  reportRows,
  revokeLicense,
  revokedIds,
  signLicense,
  summarize,
  toLicenseFile,
  updateCustomer,
  writeStore,
  type DeviceRequest,
  type Store,
} from '../src/domain.js';

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-licgen-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privB64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    pubB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

function device(overrides: Partial<DeviceRequest> = {}): DeviceRequest {
  return {
    kind: 'sauda-device-request',
    v: 1,
    fingerprint: 'a1b2c3d4e5f60718',
    components: [
      { key: 'machine', hash: 'a1b2c3d4e5f60718', weight: 40 },
      { key: 'disk', hash: '1122334455667788', weight: 35 },
      { key: 'cpu', hash: '99aabbccddeeff00', weight: 25 },
    ],
    platform: 'win32',
    app_version: '1.1.2',
    business_name: 'রহিম স্টোর',
    ...overrides,
  };
}

function issuedStore(store: Store, overrides: Parameters<typeof signLicense>[0]['issue'] extends infer T ? Partial<T> : never = {}) {
  const { privB64 } = makeKey();
  const result = signLicense({
    device: device(),
    issue: {
      org: 'রহিম স্টোর',
      owner: 'রহিম',
      phone: '01700000000',
      edition: 'enterprise',
      maxDevices: 2,
      features: featuresForEdition('enterprise'),
      expiresAt: '2030-01-01',
      ...overrides,
    },
    privateKeyB64: privB64,
    generatorVersion: '1.1.2',
  });
  const customer = createCustomer(store, { name: 'রহিম স্টোর', owner: 'রহিম', phone: '01700000000' });
  const record = recordIssuedLicense(store, { result, customerId: customer.id, filePath: '/tmp/x.sauda' });
  return { store, customer, record, result, privB64 };
}

describe('customer register', () => {
  it('assigns sequential codes and refuses duplicates', () => {
    const store = emptyStore();
    const a = createCustomer(store, { name: 'রহিম স্টোর', phone: '01700000000' });
    const b = createCustomer(store, { name: 'করিম ট্রেডার্স', email: 'karim@example.com' });
    expect(a.code).toBe('CUS-00001');
    expect(b.code).toBe('CUS-00002');
    expect(() => createCustomer(store, { name: 'রহিম স্টোর' })).toThrow(/আগেই আছে/);
    expect(listCustomers(store, { q: 'করিম' })).toHaveLength(1);
  });

  it('validates names, phones and e-mails', () => {
    const store = emptyStore();
    expect(() => createCustomer(store, { name: 'ক' })).toThrow(/কমপক্ষে ২/);
    expect(() => createCustomer(store, { name: 'দোকান', phone: '123' })).toThrow(/ফোন/);
    expect(() => createCustomer(store, { name: 'দোকান', email: 'nope' })).toThrow(/ইমেইল/);
    expect(isValidPhone('+8801700000000')).toBe(true);
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('a@b')).toBe(false);
  });

  it('updates and deactivates without touching licences', () => {
    const store = emptyStore();
    const c = createCustomer(store, { name: 'আলিফ স্টোর' });
    const updated = updateCustomer(store, c.id, { city: 'চট্টগ্রাম', is_active: 0 });
    expect(updated.city).toBe('চট্টগ্রাম');
    expect(updated.is_active).toBe(0);
    expect(listCustomers(store, { activeOnly: true })).toHaveLength(0);
    expect(customerById(store, c.id)?.name).toBe('আলিফ স্টোর');
  });
});

describe('device requests', () => {
  const valid = JSON.stringify({
    kind: 'sauda-device-request',
    v: 1,
    fingerprint: 'a1b2c3d4e5f60718',
    components: [{ key: 'machine', hash: 'a1b2c3d4e5f60718', weight: 40 }],
    platform: 'win32',
  });

  it('accepts a real request file', () => {
    const req = parseDeviceRequest(valid);
    expect(req.fingerprint).toBe('a1b2c3d4e5f60718');
    expect(req.components).toHaveLength(1);
  });

  it('rejects malformed or hostile files with clear messages', () => {
    expect(() => parseDeviceRequest('not json')).toThrow(/JSON/);
    expect(() => parseDeviceRequest(JSON.stringify({ kind: 'other' }))).toThrow(/নয়/);
    expect(() => parseDeviceRequest(JSON.stringify({ fingerprint: 'zzz', components: [] }))).toThrow(/ভালো|ব্যবহারযোগ্য/);
    expect(() => parseDeviceRequest(JSON.stringify({ components: [{ key: 'x', hash: '<script>' }] }))).toThrow();
    expect(isValidFingerprint('a1b2c3d4e5f60718')).toBe(true);
    expect(isValidFingerprint('short')).toBe(false);
  });
});

describe('signing and records', () => {
  it('signs, records and derives the right state', () => {
    const store = emptyStore();
    const { record, result } = issuedStore(store);
    expect(record.license_id).toBe(result.payload.license_id);
    expect(record.key_id).toBeTruthy();
    expect(licenseState(record)).toBe('active');
    expect(listLicenses(store, { state: 'active' })).toHaveLength(1);
    expect(daysToExpiry(record)).toBeGreaterThan(0);
  });

  it('refuses features the edition does not include', () => {
    const { privB64 } = makeKey();
    expect(() =>
      signLicense({
        device: device(),
        issue: {
          org: 'স্টোর',
          edition: 'standard',
          maxDevices: 1,
          features: ['pos', 'lan'],
          expiresAt: null,
        },
        privateKeyB64: privB64,
        generatorVersion: '1.1.2',
      }),
    ).toThrow(/এই এডিশনে অনুমোদিত নয়/);
  });

  it('refuses a past expiry and impossible device counts', () => {
    const { privB64 } = makeKey();
    const base = { org: 'স্টোর', edition: 'pro' as const, features: ['pos'], maxDevices: 1 };
    expect(() =>
      signLicense({ device: device(), issue: { ...base, expiresAt: '2000-01-01' }, privateKeyB64: privB64, generatorVersion: '1' }),
    ).toThrow(/আজকের আগে/);
    expect(() =>
      signLicense({ device: device(), issue: { ...base, expiresAt: null, maxDevices: 0 }, privateKeyB64: privB64, generatorVersion: '1' }),
    ).toThrow(/১ থেকে ১০০/);
    expect(() =>
      signLicense({ device: { ...device(), components: [] }, issue: { ...base, expiresAt: null }, privateKeyB64: privB64, generatorVersion: '1' }),
    ).toThrow(/ডিভাইস/);
  });

  it('revokes with a mandatory reason and never twice', () => {
    const store = emptyStore();
    const { record } = issuedStore(store);
    expect(() => revokeLicense(store, record.license_id, '  ')).toThrow(/কারণ/);
    revokeLicense(store, record.license_id, 'চুক্তি বাতিল');
    expect(licenseState(record)).toBe('revoked');
    expect(() => revokeLicense(store, record.license_id, 'আবার')).toThrow(/আগেই/);
  });

  it('marks the replaced licence as superseded, not revoked', () => {
    const store = emptyStore();
    const first = issuedStore(store);
    const { privB64 } = makeKey();
    const second = signLicense({
      device: device({ fingerprint: 'ffff0000ffff0000' }),
      issue: {
        org: first.record.org,
        edition: first.record.edition,
        maxDevices: first.record.max_devices,
        features: first.record.features,
        expiresAt: null,
      },
      privateKeyB64: privB64,
      generatorVersion: '1.1.2',
    });
    recordIssuedLicense(store, {
      result: second,
      customerId: first.customer.id,
      filePath: null,
      replaces: first.record.license_id,
      note: 'রি-ইস্যু: মাদারবোর্ড বদল',
    });
    expect(licenseState(first.record)).toBe('superseded');
    expect(first.record.superseded_by).toBe(second.payload.license_id);
    expect(summarize(store).licenses).toBe(2);
  });

  it('expires by date and reports lifetime separately', () => {
    const store = emptyStore();
    const { record } = issuedStore(store);
    const expired = { ...record, expires_at: '2020-01-01T00:00:00.000Z' };
    expect(licenseState(expired)).toBe('expired');
    const lifetime = { ...record, expires_at: null };
    expect(licenseState(lifetime)).toBe('active');
    expect(daysToExpiry(lifetime)).toBeNull();
    const summary = summarize({ ...store, licenses: [record, expired, lifetime] });
    expect(summary.expired).toBe(1);
    expect(summary.lifetime).toBe(1);
  });
});

describe('store, ledger, backup', () => {
  it('persists atomically and reloads', () => {
    const file = path.join(tmp(), 'store.json');
    const store = emptyStore();
    createCustomer(store, { name: 'পার্সিস্ট স্টোর' });
    writeStore(file, store);
    const reloaded = readStore(file);
    expect(reloaded.customers).toHaveLength(1);
    expect(reloaded.version).toBe(2);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    // A corrupt/foreign file falls back to an empty store rather than crashing.
    expect(readStore(path.join(tmp(), 'missing.json')).customers).toHaveLength(0);
  });

  it('keeps an append-only ledger and derives revocations', () => {
    const file = path.join(tmp(), 'ledger.jsonl');
    appendLedger(file, {
      license_id: 'L1',
      org: 'স্টোর',
      owner: null,
      edition: 'standard',
      expires_at: null,
      max_devices: 1,
      device_hash: null,
      key_id: 'K1',
      action: 'issued',
      replaces: null,
      reason: null,
      file: null,
    });
    appendLedger(file, {
      license_id: 'L1',
      org: 'স্টোর',
      owner: null,
      edition: 'standard',
      expires_at: null,
      max_devices: 1,
      device_hash: null,
      key_id: 'K1',
      action: 'revoked',
      replaces: null,
      reason: 'চুক্তি বাতিল',
      file: null,
    });
    expect(listLedger(file)).toHaveLength(2);
    expect(listLedger(file)[0].action).toBe('revoked'); // newest first
    expect(revokedIds(file)).toEqual(['L1']);
  });

  it('builds and validates an administrative backup', () => {
    const store = emptyStore();
    createCustomer(store, { name: 'ব্যাকআপ স্টোর' });
    const bundle = buildBackup(store, []);
    expect(parseBackup(JSON.stringify(bundle)).store.customers).toHaveLength(1);
    expect(() => parseBackup('{}')).toThrow(/ব্যাকআপ/);
    expect(() => parseBackup('not json')).toThrow(/JSON/);
  });
});

describe('reports and summary', () => {
  it('produces every report without throwing and keeps signed payload out of files', () => {
    const store = emptyStore();
    const { record, result } = issuedStore(store);
    const fileBody = toLicenseFile(record, { customer: 'রহিম স্টোর' });
    const parsed = JSON.parse(fileBody);
    expect(parsed.payload.license_id).toBe(result.payload.license_id);
    expect(parsed.key).toBeTruthy();
    // No private key material may ever appear in an exported licence.
    expect(fileBody).not.toMatch(/private[_-]?key/i);
    expect(fileBody).toContain(result.license.sig);

    for (const id of ['customers', 'licenses', 'lifetime', 'expiry', 'reissues', 'revocations', 'activity', 'audit']) {
      const built = reportRows(store, listLedger(path.join(tmp(), 'l.jsonl')), id);
      expect(built.definition.id).toBe(id);
      expect(Array.isArray(built.rows)).toBe(true);
    }
    const registry = reportRows(store, [], 'licenses');
    expect(registry.rows[0][0]).toBe(record.license_id);
    expect(FEATURES.length).toBeGreaterThan(8);
  });
});
