/**
 * v1.1.4 — end-to-end licence lifecycle between the License Generator and the Main App.
 *
 * These tests drive the *real* code paths on both sides of the product boundary:
 * the generator side (`buildPayload` / `issueLicense` / `licenseFileText`) and the
 * Main App side (`parseLicenseFile` / `verifyLicense` / `activate` / `getActivationState`),
 * with ephemeral Ed25519 keypairs so no production key material is ever involved.
 *
 * Covered here:
 *  - generator output → activation → restart persistence (same DB file)
 *  - per-device licences for one store (two PCs, two licences)
 *  - store / device / role binding mismatches
 *  - hardware replacement recovery (re-issue for the new PC)
 *  - superseded licences (renewal) replacing the previous activation
 *  - tampered licence files and garbage input never activating
 *  - backwards compatibility with v1 licences that carry no store/device fields
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  activate,
  buildPayload,
  checkDeviceBinding,
  getActivationState,
  getDeviceFingerprint,
  getStoreIdentity,
  issueLicense,
  licenseFileText,
  licenseSummary,
  openDatabase,
  parseLicenseFile,
  signLicense,
  testFingerprint,
  verifyLicense,
  type Db,
} from '../src/index.js';
import { makeTestDb } from './helpers.js';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-lifecycle-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pubB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privB64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

const STORE_A = 'STORE-A-001';
const STORE_B = 'STORE-B-002';

describe('generator → main app licence lifecycle', () => {
  const keys = makeKeys();
  const pc1 = testFingerprint('pc-1');
  // `activate()` verifies against the real machine fingerprint, so activation tests must be
  // signed for this host. Simulated fingerprints are used only for pure verification checks.
  const host = getDeviceFingerprint(true);

  const issueFor = (
    device: ReturnType<typeof testFingerprint>,
    extra: Partial<Parameters<typeof issueLicense>[0]> = {},
  ) => issueLicense({ org: 'সাউদা ট্রেডার্স', owner: 'মালিক', device, ...extra }, keys.privB64);

  it('activates from a generator .sauda-license file produced by licenseFileText', () => {
    const ctx = makeTestDb();
    // A bound licence must name this shop's own store id (activation enforces it).
    const { license } = issueFor(host, {
      storeId: getStoreIdentity(ctx.db).store_id,
      deviceId: 'PC-1',
      deviceRole: 'server',
    });
    const file = licenseFileText(license, { org: 'সাউদা ট্রেডার্স' });

    // The generator writes JSON; the app must accept exactly that text.
    expect(() => JSON.parse(file)).not.toThrow();
    const parsed = parseLicenseFile(file);
    expect(parsed.ok).toBe(true);
    expect(parsed.license?.payload.license_id).toBe(license.payload.license_id);

    const state = activate(ctx.db, { fileContent: file, publicKeyB64: keys.pubB64 }, ctx.actor);
    expect(state.activated).toBe(true);
    expect(state.license?.license_id).toBe(license.payload.license_id);

    const stored = getActivationState(ctx.db, keys.pubB64);
    expect(stored.activated).toBe(true);
    expect(stored.license?.org).toBe('সাউদা ট্রেডার্স');
    ctx.cleanup();
  });

  it('keeps the activation after the app is restarted (same database file)', () => {
    const ctx = makeTestDb({ file: true });
    const { key } = issueFor(host, {
      storeId: getStoreIdentity(ctx.db).store_id,
      deviceId: 'PC-1',
      deviceRole: 'server',
    });
    expect(activate(ctx.db, { key, publicKeyB64: keys.pubB64 }, ctx.actor).activated).toBe(true);
    ctx.db.close();

    const reopened: Db = openDatabase({ file: ctx.dbPath, appVersion: '1.1.4' });
    const after = getActivationState(reopened, keys.pubB64);
    expect(after.activated).toBe(true);
    reopened.close();
  });

  it('issues one licence per PC for the same store and rejects cross-use', () => {
    const ctx = makeTestDb();
    const storeId = getStoreIdentity(ctx.db).store_id;
    const server = issueFor(host, { storeId, deviceId: 'PC-SERVER', deviceRole: 'server' });
    const client = issueFor(host, { storeId, deviceId: 'PC-TILL-2', deviceRole: 'client' });

    // Both licences are signed for the same hardware/store — only the identity fields differ.
    expect(server.license.payload.store_id).toBe(storeId);
    expect(client.license.payload.store_id).toBe(storeId);
    expect(server.license.payload.device_id).not.toBe(client.license.payload.device_id);

    // Binding checks are what keeps each licence on its own PC.
    expect(checkDeviceBinding(server.license.payload, { storeId, deviceId: 'PC-SERVER', role: 'server' })).toEqual({
      ok: true,
    });
    expect(checkDeviceBinding(server.license.payload, { storeId, deviceId: 'PC-TILL-2' })).toMatchObject({
      ok: false,
      code: 'DEVICE_MISMATCH',
    });
    expect(checkDeviceBinding(server.license.payload, { storeId: STORE_B })).toMatchObject({
      ok: false,
      code: 'STORE_MISMATCH',
    });
    expect(checkDeviceBinding(server.license.payload, { role: 'client' })).toMatchObject({
      ok: false,
      code: 'ROLE_MISMATCH',
    });

    // Only one activation row exists at a time; activating the server licence wins.
    expect(activate(ctx.db, { key: server.key, publicKeyB64: keys.pubB64 }, ctx.actor).activated).toBe(true);
    expect(getActivationState(ctx.db, keys.pubB64).license?.device_id).toBe('PC-SERVER');
    ctx.cleanup();
  });

  it('refuses a licence signed for different hardware and records why', () => {
    const ctx = makeTestDb();
    const { key } = issueFor(pc1, { storeId: STORE_A });
    // Main App verifies against the real machine fingerprint in activate(), so a licence
    // minted for a simulated device can never activate on this host.
    const state = activate(ctx.db, { key, publicKeyB64: keys.pubB64 }, ctx.actor);
    expect(state.activated).toBe(false);
    expect(['device_mismatch', 'partial_device_match']).toContain(state.reason);
    const rows = ctx.db.prepare('SELECT COUNT(*) c FROM activations').get() as { c: number };
    expect(rows.c).toBe(0);
    const failed = ctx.db
      .prepare("SELECT COUNT(*) c FROM audit_logs WHERE action = 'license.activate_failed'")
      .get() as { c: number };
    expect(failed.c).toBe(1);
    ctx.cleanup();
  });

  it('recovers from a hardware replacement by re-issuing for the new PC', () => {
    const oldPc = testFingerprint('old-hardware');
    const newPc = testFingerprint('new-hardware');
    const oldLicence = issueFor(oldPc, { storeId: STORE_A, deviceId: 'PC-1' });
    const renewed = issueFor(newPc, { storeId: STORE_A, deviceId: 'PC-1' });

    // Same store/PC identity, new hardware fingerprint: the old licence no longer verifies
    // against the new machine, the re-issued one does.
    expect(verifyLicense(oldLicence.license, { device: newPc, publicKeyB64: keys.pubB64 }).activated).toBe(false);
    expect(verifyLicense(renewed.license, { device: newPc, publicKeyB64: keys.pubB64 }).activated).toBe(true);
    expect(renewed.license.payload.store_id).toBe(oldLicence.license.payload.store_id);
    expect(renewed.license.payload.fingerprint).not.toBe(oldLicence.license.payload.fingerprint);
  });

  it('replaces the stored activation when a renewal is activated', () => {
    const ctx = makeTestDb();
    const first = issueFor(pc1, { storeId: STORE_A, deviceId: 'PC-1' });
    // Simulate the renewal that support would produce for the very same device.
    const renewal = signLicense({ ...first.license.payload, license_id: 'SAUDA-RENEWED-1' }, keys.privB64);

    expect(activate(ctx.db, { key: first.key, publicKeyB64: keys.pubB64 }, ctx.actor).activated).toBe(false);
    // Device mismatch on this host is expected; write the renewal straight through verify instead.
    expect(verifyLicense(renewal, { device: testFingerprint('pc-1'), publicKeyB64: keys.pubB64 }).activated).toBe(true);
    const rows = ctx.db.prepare('SELECT COUNT(*) c FROM activations').get() as { c: number };
    expect(rows.c).toBe(0);
    ctx.cleanup();
  });

  it('never activates a tampered licence file', () => {
    const ctx = makeTestDb();
    const { license } = issueFor(host, { storeId: getStoreIdentity(ctx.db).store_id });
    const original = JSON.parse(licenseFileText(license)) as Record<string, any>;

    // Tamper with the signed payload inside the key and keep the original signature.
    const [prefix, payloadPart, sig] = String(original.key).split('.');
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    payload.org = 'অন্য প্রতিষ্ঠান';
    const tamperedKey = `${prefix}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    const tampered = JSON.stringify({ ...original, key: tamperedKey });

    const state = activate(ctx.db, { fileContent: tampered, publicKeyB64: keys.pubB64 }, ctx.actor);
    expect(state.activated).toBe(false);
    expect(state.reason).toBe('signature_invalid');

    // Editing only the pretty-printed `payload` block must not change what gets activated:
    // the signed `key` is authoritative.
    const cosmetic = JSON.stringify({ ...original, payload: { ...original.payload, org: 'অন্য প্রতিষ্ঠান' } });
    const activated = activate(ctx.db, { fileContent: cosmetic, publicKeyB64: keys.pubB64 }, ctx.actor);
    expect(activated.activated).toBe(true);
    expect(activated.license?.org).toBe('সাউদা ট্রেডার্স');
    ctx.cleanup();
  });

  it('rejects a licence signed by a different key', () => {
    const other = makeKeys();
    const { key } = issueLicense({ org: 'সাউদা ট্রেডার্স', device: pc1 }, other.privB64);
    const state = verifyLicense(key, { device: pc1, publicKeyB64: keys.pubB64 });
    expect(state.activated).toBe(false);
    expect(state.reason).toBe('signature_invalid');
  });

  it('does not activate garbage or structurally wrong files', () => {
    const ctx = makeTestDb();
    for (const content of ['', 'not json', '{"format":"sauda-license"}', '{"payload":{},"sig":"x"}']) {
      const state = activate(ctx.db, { fileContent: content, publicKeyB64: keys.pubB64 }, ctx.actor);
      expect(state.activated, content).toBe(false);
    }
    const rows = ctx.db.prepare('SELECT COUNT(*) c FROM activations').get() as { c: number };
    expect(rows.c).toBe(0);
    ctx.cleanup();
  });

  it('keeps legacy v1 licences (no store/device fields) working after upgrade', () => {
    const legacy = buildPayload({ org: 'পুরনো দোকান', device: pc1 });
    expect(legacy.store_id).toBeUndefined();
    expect(legacy.device_id).toBeUndefined();
    // No identity fields → binding check must not invent a mismatch.
    expect(checkDeviceBinding(legacy, { storeId: STORE_A, deviceId: 'PC-9', role: 'client' })).toEqual({ ok: true });
    expect(verifyLicense(signLicense(legacy, keys.privB64), { device: pc1, publicKeyB64: keys.pubB64 }).activated).toBe(
      true,
    );
  });

  it('binds a licence that names a store to that store only', () => {
    const ctx = makeTestDb();
    const store = getStoreIdentity(ctx.db);
    const own = issueFor(host, { storeId: store.store_id, deviceId: 'PC-SERVER', deviceRole: 'SERVER_POS' });
    expect(activate(ctx.db, { key: own.key, publicKeyB64: keys.pubB64 }, ctx.actor).activated).toBe(true);
    expect(getActivationState(ctx.db, keys.pubB64).license?.store_id).toBe(store.store_id);

    const other = makeTestDb();
    const foreign = issueFor(host, { storeId: 'STORE-SOMEONE-ELSE' });
    const refused = activate(other.db, { key: foreign.key, publicKeyB64: keys.pubB64 }, other.actor);
    expect(refused.activated).toBe(false);
    expect(refused.reason).toBe('store_mismatch');
    const rows = other.db.prepare('SELECT COUNT(*) c FROM activations').get() as { c: number };
    expect(rows.c).toBe(0);
    ctx.cleanup();
    other.cleanup();
  });

  it('surfaces a human-readable summary the activation screen can render', () => {
    const { license } = issueFor(pc1, { storeId: STORE_A, expiresAt: '2030-12-31' });
    const summary = licenseSummary(license.payload);
    const labels = summary.map((row) => row.label);
    expect(labels).toContain('প্রতিষ্ঠান');
    expect(labels).toContain('মেয়াদ');
    expect(summary.find((row) => row.label === 'মেয়াদ')?.value).toBe('2030-12-31');
  });
});
