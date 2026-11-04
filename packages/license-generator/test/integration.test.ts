/**
 * Ecosystem integration — the licence lifecycle.
 *
 * A licence produced by the License Generator must be accepted by the retail
 * application, and a tampered one must be rejected. Both sides are exercised
 * through their real code paths: the generator's `signLicense` / `toLicenseFile`
 * and the retail application's `verifyLicense` / `parseLicenseFile` /
 * `activate` from `@sauda/core`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activate,
  getActivationState,
  getDeviceFingerprint,
  parseLicenseFile,
  verifyLicense,
} from '@sauda/core';
import {
  createCustomer,
  emptyStore,
  featuresForEdition,
  licenseState,
  recordIssuedLicense,
  revokedIds,
  signLicense,
  summarize,
  toLicenseFile,
  verifyLicenseFile,
  writeStore,
  readStore,
  type DeviceRequest,
} from '../src/domain.js';
import { makeTestDb } from '../../core/test/helpers.js';

/* ---------------- fixtures ---------------- */

function makeKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privB64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    pubB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

/** A device request shaped exactly like the app's exported `.sauda-device` file. */
function deviceRequest(): DeviceRequest {
  const real = getDeviceFingerprint(true);
  return {
    kind: 'sauda-device-request',
    v: real.version,
    fingerprint: real.hash,
    components: real.components.map((c) => ({ key: c.key, hash: c.hash, weight: c.weight })),
    platform: process.platform,
    app_version: '1.1.2',
    business_name: 'ইন্টিগ্রেশন স্টোর',
    created_at: new Date().toISOString(),
  };
}

const publicKey = () => makeKeys();

describe('generator → retail app licence compatibility', () => {
  it('issues a licence the app accepts with the embedded public key', () => {
    const { privB64, pubB64 } = publicKey();
    const device = deviceRequest();
    const result = signLicense({
      device,
      issue: {
        org: 'ইন্টিগ্রেশন স্টোর',
        owner: 'মালিক',
        phone: '01700000000',
        edition: 'pro',
        maxDevices: 2,
        features: featuresForEdition('pro'),
        expiresAt: null,
      },
      privateKeyB64: privB64,
      generatorVersion: '1.1.2',
    });

    const appView = verifyLicense(result.license, { publicKeyB64: pubB64, device: { version: device.v, hash: device.fingerprint, components: device.components } as ReturnType<typeof getDeviceFingerprint> });
    expect(appView.activated).toBe(true);
    expect(appView.license?.org).toBe('ইন্টিগ্রেশন স্টোর');
    expect(appView.license?.edition).toBe('pro');
    expect(appView.license?.expires_at).toBeNull(); // lifetime
  });

  it('stores the licence file body in the format the app parses', () => {
    const { privB64, pubB64 } = publicKey();
    const store = emptyStore();
    const device = deviceRequest();
    const customer = createCustomer(store, { name: 'ফাইল স্টোর', phone: '01800000000' });
    const result = signLicense({
      device,
      issue: { org: 'ফাইল স্টোর', edition: 'standard', maxDevices: 1, features: featuresForEdition('standard'), expiresAt: '2030-12-31' },
      privateKeyB64: privB64,
      generatorVersion: '1.1.2',
    });
    const record = recordIssuedLicense(store, { result, customerId: customer.id, filePath: null });
    const body = toLicenseFile(record, { customer: customer.name });

    const parsed = parseLicenseFile(body);
    expect(parsed.ok).toBe(true);
    expect(parsed.license?.payload.license_id).toBe(record.license_id);

    const verified = verifyLicense(parsed.license!, { publicKeyB64: pubB64, skipDevice: true });
    expect(verified.activated).toBe(true);
  });

  it('activates inside the real retail database (end-to-end activation)', () => {
    const { privB64, pubB64 } = publicKey();
    const ctx = makeTestDb();
    const device = getDeviceFingerprint(true);
    const request: DeviceRequest = {
      kind: 'sauda-device-request',
      v: device.version,
      fingerprint: device.hash,
      components: device.components.map((c) => ({ key: c.key, hash: c.hash, weight: c.weight })),
    };
    const result = signLicense({
      device: request as unknown as DeviceRequest,
      issue: {
        org: 'অ্যাক্টিভেশন স্টোর',
        edition: 'enterprise',
        maxDevices: 1,
        features: ['pos', 'inventory', 'lan'],
        expiresAt: '2031-01-01',
      },
      privateKeyB64: privB64,
      generatorVersion: '1.1.2',
    });

    const body = toLicenseFile(recordIssuedLicense(emptyStore(), { result, customerId: null, filePath: null }));
    const state = activate(ctx.db, { fileContent: body, publicKeyB64: pubB64 });
    expect(state.activated).toBe(true);
    expect(getActivationState(ctx.db, pubB64).activated).toBe(true);
    expect(getActivationState(ctx.db, pubB64).license?.org).toBe('অ্যাক্টিভেশন স্টোর');
    ctx.cleanup();
  });

  it('rejects a payload modified after signing', () => {
    const { privB64, pubB64 } = publicKey();
    const device = deviceRequest();
    const result = signLicense({
      device,
      issue: { org: 'টেম্পার স্টোর', edition: 'standard', maxDevices: 1, features: featuresForEdition('standard'), expiresAt: null },
      privateKeyB64: privB64,
      generatorVersion: '1.1.2',
    });
    const tampered = {
      ...result.license,
      payload: { ...result.license.payload, edition: 'enterprise' as const, max_devices: 99, expires_at: null },
    };
    const check = verifyLicense(tampered, { publicKeyB64: pubB64, skipDevice: true });
    expect(check.activated).toBe(false);
    expect(check.reason).toBe('signature_invalid');
  });

  it('rejects a signature from a different key', () => {
    const { privB64 } = publicKey();
    const { pubB64: otherPublic } = makeKeys();
    const device = deviceRequest();
    const result = signLicense({
      device,
      issue: { org: 'ভুল কী স্টোর', edition: 'standard', maxDevices: 1, features: featuresForEdition('standard'), expiresAt: null },
      privateKeyB64: privB64,
      generatorVersion: '1.1.2',
    });
    const check = verifyLicense(result.license, { publicKeyB64: otherPublic, skipDevice: true });
    expect(check.activated).toBe(false);
  });

  it('rejects a licence bound to a different machine', () => {
    const { privB64, pubB64 } = publicKey();
    const device = deviceRequest();
    const result = signLicense({
      device,
      issue: { org: 'হার্ডওয়্যার স্টোর', edition: 'standard', maxDevices: 1, features: featuresForEdition('standard'), expiresAt: null },
      privateKeyB64: privB64,
      generatorVersion: '1.1.2',
    });
    const otherMachine = getDeviceFingerprint(true);
    const alien = {
      version: otherMachine.version,
      hash: 'cafebabecafebabe',
      components: [{ key: 'machine', hash: 'cafebabecafebabe', weight: 100 }],
    } as ReturnType<typeof getDeviceFingerprint>;
    const check = verifyLicense(result.license, { publicKeyB64: pubB64, device: alien });
    expect(check.activated).toBe(false);
    expect(['device_mismatch', 'fingerprint_mismatch']).toContain(check.reason);
  });

  it('flags a revoked licence in generator-side verification but keeps the signature valid', () => {
    const { privB64, pubB64 } = publicKey();
    const device = deviceRequest();
    const result = signLicense({
      device,
      issue: { org: 'রিভোক স্টোর', edition: 'standard', maxDevices: 1, features: featuresForEdition('standard'), expiresAt: null },
      privateKeyB64: privB64,
      generatorVersion: '1.1.2',
    });
    const body = toLicenseFile(recordIssuedLicense(emptyStore(), { result, customerId: null, filePath: null }));
    const outcome = verifyLicenseFile(body, { publicKeyB64: pubB64, revokedIds: [result.payload.license_id] });
    expect(outcome.ok).toBe(true); // signature is intact
    expect(outcome.revoked).toBe(true); // but it is closed out here
    expect(outcome.message).toMatch(/প্রত্যাহার/);
  });

  it('refuses an expired licence at the app boundary', () => {
    const { privB64, pubB64 } = publicKey();
    const result = signLicense({
      device: deviceRequest(),
      issue: { org: 'মেয়াদোত্তীর্ণ স্টোর', edition: 'standard', maxDevices: 1, features: ['pos'], expiresAt: '2027-06-30' },
      privateKeyB64: privB64,
      generatorVersion: '1.1.2',
    });
    // Valid today...
    expect(verifyLicense(result.license, { publicKeyB64: pubB64, skipDevice: true }).activated).toBe(true);
    // ...and refused the day after the expiry date, with no network involved.
    const later = verifyLicense(result.license, {
      publicKeyB64: pubB64,
      skipDevice: true,
      now: new Date('2027-07-01T12:00:00'),
    });
    expect(later.activated).toBe(false);
    expect(later.reason).toBe('expired');
  });

  it('reissues: the replacement is valid for the new machine and the old record is closed', () => {
    const { privB64, pubB64 } = publicKey();
    const store = emptyStore();
    const first = signLicense({
      device: deviceRequest(),
      issue: { org: 'রি-ইস্যু স্টোর', edition: 'pro', maxDevices: 1, features: featuresForEdition('pro'), expiresAt: '2030-01-01' },
      privateKeyB64: privB64,
      generatorVersion: '1.1.2',
    });
    const customer = createCustomer(store, { name: 'রি-ইস্যু স্টোর' });
    const oldRecord = recordIssuedLicense(store, { result: first, customerId: customer.id, filePath: null });

    const newMachine = deviceRequest();
    const replacement = signLicense({
      device: newMachine,
      issue: {
        org: oldRecord.org,
        edition: oldRecord.edition,
        maxDevices: oldRecord.max_devices,
        features: oldRecord.features,
        expiresAt: '2030-01-01',
      },
      privateKeyB64: privB64,
      generatorVersion: '1.1.2',
    });
    const newRecord = recordIssuedLicense(store, {
      result: replacement,
      customerId: customer.id,
      filePath: null,
      replaces: oldRecord.license_id,
      note: 'রি-ইস্যু: মাদারবোর্ড বদল',
    });

    expect(licenseState(oldRecord)).toBe('superseded');
    expect(newRecord.replaces).toBe(oldRecord.license_id);
    expect(summarize(store).superseded).toBe(1);

    const check = verifyLicense(replacement.license, { publicKeyB64: pubB64, skipDevice: true });
    expect(check.activated).toBe(true);
    expect(replacement.payload.license_id).not.toBe(first.payload.license_id);
  });

  it('survives a store round-trip: revoked state and ledger stay consistent', () => {
    const { privB64 } = publicKey();
    const store = emptyStore();
    const result = signLicense({
      device: deviceRequest(),
      issue: { org: 'রাউন্ডট্রিপ স্টোর', edition: 'standard', maxDevices: 1, features: ['pos'], expiresAt: null },
      privateKeyB64: privB64,
      generatorVersion: '1.1.2',
    });
    const record = recordIssuedLicense(store, { result, customerId: null, filePath: null });
    record.revoked_at = new Date().toISOString();
    record.revoke_reason = 'পরীক্ষা';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-int-'));
    const storeFile = path.join(dir, 'store.json');
    writeStore(storeFile, store);
    expect(readStore(storeFile).licenses[0].revoked_at).toBeTruthy();
    expect(revokedIds(path.join(dir, 'no-ledger.jsonl'))).toEqual([]);
    expect(licenseState(record)).toBe('revoked');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
