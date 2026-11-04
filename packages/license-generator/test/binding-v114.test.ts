/**
 * v1.1.4 — multi-PC binding in the License Generator.
 *
 * `signLicense()` used to accept only the legacy fields, so `storeId` / `deviceId` /
 * `deviceRole` / `deviceCapacity` were silently dropped: a bound licence could not be produced
 * at all, even though the Main App already understood those fields. These tests pin the
 * forwarding and the validation around it.
 */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testFingerprint, verifyLicense, type SignedLicense } from '@sauda/core';
import { featuresForEdition, signLicense, type DeviceRequest } from '../src/domain.js';

function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pubB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privB64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

// A realistic device request: the fingerprint must be the hash of its own components, otherwise
// the Main App correctly reports a device mismatch.
const fingerprint = testFingerprint('generator-binding');
const device: DeviceRequest = {
  kind: 'sauda-device-request',
  v: fingerprint.version,
  fingerprint: fingerprint.hash,
  components: fingerprint.components,
  platform: 'win32',
  app_version: '1.1.4',
  business_name: 'বাইন্ডিং স্টোর',
};

const baseIssue = {
  org: 'বাইন্ডিং স্টোর',
  edition: 'enterprise' as const,
  maxDevices: 3,
  features: featuresForEdition('enterprise'),
  expiresAt: '2030-01-01',
};

const sign = (extra: Record<string, unknown>, privB64: string) =>
  signLicense({
    device,
    issue: { ...baseIssue, ...extra },
    privateKeyB64: privB64,
    generatorVersion: '1.1.4',
  });

describe('multi-PC binding fields', () => {
  const { privB64, pubB64 } = makeKey();

  it('carries store, device, role and capacity into the signed payload', () => {
    const { license } = sign(
      { storeId: 'STORE-A-001', deviceId: 'PC-TILL-2', deviceRole: 'CLIENT_POS', deviceCapacity: 4 },
      privB64,
    );
    expect(license.payload.store_id).toBe('STORE-A-001');
    expect(license.payload.device_id).toBe('PC-TILL-2');
    expect(license.payload.device_role).toBe('CLIENT_POS');
    expect(license.payload.device_capacity).toBe(4);
    // The signature still covers the whole payload.
    const check = verifyLicense(license, { device: fingerprint, publicKeyB64: pubB64 });
    expect(check.reason).toBe('ok');
    expect(check.activated).toBe(true);
  });

  it('leaves a standalone licence free of binding fields (v1 compatibility)', () => {
    const { license } = sign({}, privB64);
    expect(license.payload.store_id).toBeUndefined();
    expect(license.payload.device_id).toBeUndefined();
    expect(license.payload.device_role).toBeUndefined();
  });

  it('rejects an unknown device role', () => {
    expect(() => sign({ storeId: 'STORE-A-001', deviceRole: 'ADMIN' }, privB64)).toThrowError(/ভূমিকা/);
  });

  it('refuses a role without a store id', () => {
    expect(() => sign({ deviceRole: 'CLIENT_POS' }, privB64)).toThrowError(/Store ID/);
  });

  it('clamps capacity to the supported range', () => {
    const low = sign({ storeId: 'S', deviceCapacity: 0 }, privB64).license as SignedLicense;
    expect(low.payload.device_capacity).toBe(1);
    const high = sign({ storeId: 'S', deviceCapacity: 5000 }, privB64).license as SignedLicense;
    expect(high.payload.device_capacity).toBe(100);
  });

  it('rejects oversized identifiers', () => {
    expect(() => sign({ storeId: 'S'.repeat(65) }, privB64)).toThrowError(/Store ID/);
    expect(() => sign({ deviceId: 'D'.repeat(65) }, privB64)).toThrowError(/ডিভাইস আইডি/);
  });
});
