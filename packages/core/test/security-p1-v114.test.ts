/**
 * Priority 1.1 and 1.3 — device credential storage and authenticated rotation.
 *
 * The Windows DPAPI sealer itself cannot run in this sandbox (no Electron/Windows),
 * so these tests exercise the *envelope and policy* with a substitute sealer. What
 * is proven here: the plaintext key never reaches the disk, a missing/corrupt/other-
 * user/other-device credential fails closed, nothing is ever regenerated silently,
 * and a rotation can only happen when an administrator authorised it and can be
 * recovered after a crash at any step.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DeviceKeyError,
  DeviceKeyStore,
  IdentityError,
  RotationError,
  authorizeRotation,
  beginRotation,
  checkPinnedFingerprint,
  commitRotation,
  createDeviceKeyRecord,
  initializeApp,
  loadOrCreateDeviceKey,
  loadOrCreateServerIdentity,
  openDatabase,
  recoverRotation,
  rotationStatus,
  type Sealer,
} from '../src/index.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-p1-'));
  dirs.push(dir);
  return dir;
}

/** Stand-in for DPAPI: AES-256-GCM with a key held by the "user context". */
function testSealer(kind = 'test-aes-gcm', key = crypto.randomBytes(32)): Sealer {
  return {
    kind,
    seal(plain) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    unseal(sealed) {
      const iv = sealed.subarray(0, 12);
      const tag = sealed.subarray(12, 28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
    },
  };
}

function freshDb(dir: string) {
  const db = openDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
  initializeApp(db, {
    businessName: 'নিরাপত্তা স্টোর',
    businessAddress: 'ঢাকা',
    businessPhone: '01700000000',
    adminFullName: 'মালিক',
    adminUsername: 'owner',
    adminPassword: 'owner123',
  });
  return db;
}

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('device credential storage', () => {
  it('survives a restart of the application', () => {
    const dir = tempDir();
    // The same "user context" across both launches (same sealing key).
    const sealer = testSealer();
    const first = new DeviceKeyStore({ dir, sealer });
    const created = loadOrCreateDeviceKey(first, { deviceId: 'DEV-K1', storeId: 'STORE-1', allowCreate: true });
    expect(created.created).toBe(true);
    expect(created.record.private_key_pem).toContain('PRIVATE KEY');

    // A new store instance on the same directory represents the next app launch.
    const reopened = new DeviceKeyStore({ dir, sealer });
    const loaded = reopened.load({ deviceId: 'DEV-K1', storeId: 'STORE-1' });
    expect(loaded.private_key_pem).toBe(created.record.private_key_pem);
    expect(loaded.public_key_spki_b64).toBe(created.record.public_key_spki_b64);
  });

  it('never writes the private key in plaintext', () => {
    const dir = tempDir();
    const store = new DeviceKeyStore({ dir, sealer: testSealer() });
    const record = createDeviceKeyRecord({ deviceId: 'DEV-K2', storeId: 'STORE-1' });
    store.save(record);
    const raw = fs.readFileSync(store.path);
    expect(raw.toString('utf8')).not.toContain('PRIVATE KEY');
    expect(raw.toString('utf8')).not.toContain(record.private_key_pem.slice(40, 80));
    expect(raw.toString('utf8').startsWith('SAUDA-DK1')).toBe(true);
  });

  it('refuses to overwrite an existing credential without an explicit replacement', () => {
    const dir = tempDir();
    const store = new DeviceKeyStore({ dir, sealer: testSealer() });
    const first = createDeviceKeyRecord({ deviceId: 'DEV-K3', storeId: 'STORE-1' });
    store.save(first);
    expect(() => store.save(createDeviceKeyRecord({ deviceId: 'DEV-K3', storeId: 'STORE-1' }))).toThrowError(
      /আগেই সংরক্ষিত/,
    );
    try {
      store.save(createDeviceKeyRecord({ deviceId: 'DEV-K3', storeId: 'STORE-1' }));
    } catch (err) {
      expect((err as DeviceKeyError).code).toBe('KEY_ALREADY_EXISTS');
    }
    // The original is untouched.
    expect(store.load().private_key_pem).toBe(first.private_key_pem);
  });

  it('reports a missing credential and never invents a new identity for an approved device', () => {
    const dir = tempDir();
    const store = new DeviceKeyStore({ dir, sealer: testSealer() });
    try {
      loadOrCreateDeviceKey(store, { deviceId: 'DEV-K4', storeId: 'STORE-1' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as DeviceKeyError).code).toBe('KEY_MISSING');
    }
    expect(store.exists()).toBe(false);
  });

  it('reports a corrupted credential instead of regenerating it', () => {
    const dir = tempDir();
    const store = new DeviceKeyStore({ dir, sealer: testSealer() });
    store.save(createDeviceKeyRecord({ deviceId: 'DEV-K5', storeId: 'STORE-1' }));
    fs.writeFileSync(store.path, 'SAUDA-DK1\ntest-aes-gcm\nnot-valid-base64-payload\n');

    try {
      store.load({ deviceId: 'DEV-K5' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as DeviceKeyError).code).toBe('KEY_INACCESSIBLE');
    }
    // Still present: nothing was silently replaced.
    expect(store.exists()).toBe(true);
  });

  it('fails safely when the credential was sealed by another security context', () => {
    const dir = tempDir();
    const owner = new DeviceKeyStore({ dir, sealer: testSealer('dpapi-user') });
    owner.save(createDeviceKeyRecord({ deviceId: 'DEV-K6', storeId: 'STORE-1' }));

    const otherUser = new DeviceKeyStore({ dir, sealer: testSealer('dpapi-user', crypto.randomBytes(32)) });
    try {
      otherUser.load({ deviceId: 'DEV-K6' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as DeviceKeyError).code).toBe('KEY_INACCESSIBLE');
    }

    const otherMachine = new DeviceKeyStore({ dir, sealer: testSealer('dpapi-machine') });
    try {
      otherMachine.load({ deviceId: 'DEV-K6' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as DeviceKeyError).code).toBe('KEY_INACCESSIBLE');
    }
  });

  it('refuses a credential that belongs to a different device or store', () => {
    const dir = tempDir();
    const store = new DeviceKeyStore({ dir, sealer: testSealer() });
    store.save(createDeviceKeyRecord({ deviceId: 'DEV-K7', storeId: 'STORE-1' }));
    for (const expected of [{ deviceId: 'DEV-OTHER' }, { deviceId: 'DEV-K7', storeId: 'STORE-2' }]) {
      try {
        loadOrCreateDeviceKey(store, { ...expected, allowCreate: false });
        throw new Error('should have thrown');
      } catch (err) {
        expect((err as DeviceKeyError).code).toBe('KEY_DEVICE_MISMATCH');
      }
    }
  });

  it('refuses to store when the platform cannot encrypt, with no plaintext fallback', () => {
    const dir = tempDir();
    const failing: Sealer = {
      kind: 'dpapi-user',
      seal() {
        throw new Error('DPAPI unavailable');
      },
      unseal() {
        throw new Error('DPAPI unavailable');
      },
    };
    const store = new DeviceKeyStore({ dir, sealer: failing });
    try {
      store.save(createDeviceKeyRecord({ deviceId: 'DEV-K8', storeId: 'STORE-1' }));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as DeviceKeyError).code).toBe('SEALER_UNAVAILABLE');
    }
    expect(store.exists()).toBe(false);
  });

  it('rejects a credential whose keypair no longer matches', () => {
    const dir = tempDir();
    const sealer = testSealer();
    const store = new DeviceKeyStore({ dir, sealer });
    const record = createDeviceKeyRecord({ deviceId: 'DEV-K9', storeId: 'STORE-1' });
    const other = createDeviceKeyRecord({ deviceId: 'DEV-K9', storeId: 'STORE-1' });
    // Saving a mismatched pair is refused outright …
    expect(() => store.save({ ...record, private_key_pem: other.private_key_pem })).toThrowError(DeviceKeyError);
    // … and a file tampered with outside the app is refused on load.
    const envelope = `SAUDA-DK1\n${sealer.kind}\n${sealer
      .seal(Buffer.from(JSON.stringify({ ...record, private_key_pem: other.private_key_pem }), 'utf8'))
      .toString('base64')}\n`;
    fs.writeFileSync(store.path, envelope);
    try {
      store.load({ deviceId: 'DEV-K9' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as DeviceKeyError).code).toBe('KEY_CORRUPT');
    }
  });
});

describe('authenticated certificate rotation', () => {
  function setup() {
    const dir = tempDir();
    const db = freshDb(dir);
    const tlsDir = path.join(dir, 'tls');
    const identity = loadOrCreateServerIdentity({ dir: tlsDir, allowCreate: true, ips: [] });
    return { dir, db, tlsDir, identity };
  }

  it('refuses to rotate without an administrator authorisation row', () => {
    const { db, tlsDir } = setup();
    expect(() => beginRotation({ dir: tlsDir, db, rotationId: 999 })).toThrowError(RotationError);
    try {
      beginRotation({ dir: tlsDir, db, rotationId: 999 });
    } catch (err) {
      expect((err as RotationError).code).toBe('ROTATION_UNAUTHORIZED');
    }
  });

  it('rotates only when authorised, keeps the old files and records the new pin', () => {
    const { db, tlsDir, identity } = setup();
    const rotationId = authorizeRotation(db, { oldFingerprint: identity.fingerprint, reason: 'hardware replacement' });
    const begun = beginRotation({ dir: tlsDir, db, rotationId });
    expect(begun.newFingerprint).not.toBe(identity.fingerprint);
    expect(rotationStatus(tlsDir).pending).toBe(true);

    const rotated = commitRotation({ dir: tlsDir, db, rotationId });
    expect(rotated.fingerprint).toBe(begun.newFingerprint);
    expect(rotationStatus(tlsDir).pending).toBe(false);

    const backups = fs.readdirSync(tlsDir).filter((f) => f.includes('.old'));
    expect(backups.length).toBeGreaterThanOrEqual(2);
    // The old fingerprint is no longer what the server presents.
    const current = loadOrCreateServerIdentity({ dir: tlsDir, allowCreate: false });
    expect(current.fingerprint).toBe(begun.newFingerprint);

    const row = db.prepare('SELECT state, new_fingerprint, completed_at FROM cert_rotations WHERE id = ?').get(rotationId) as {
      state: string;
      new_fingerprint: string;
      completed_at: string;
    };
    expect(row.state).toBe('completed');
    expect(row.new_fingerprint).toBe(begun.newFingerprint);
    expect(row.completed_at).toBeTruthy();
  });

  it('rejects a rotation authorised for a different (older) certificate', () => {
    const { db, tlsDir, identity } = setup();
    const rotationId = authorizeRotation(db, { oldFingerprint: identity.fingerprint, reason: 'x' });
    beginRotation({ dir: tlsDir, db, rotationId });
    commitRotation({ dir: tlsDir, db, rotationId });
    // Old authorisation id reused against the *new* certificate state.
    try {
      beginRotation({ dir: tlsDir, db, rotationId });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RotationError).code).toBe('ROTATION_UNAUTHORIZED');
    }
  });

  it('finishes an interrupted rotation after a crash between prepare and swap', () => {
    const { db, tlsDir, identity } = setup();
    const rotationId = authorizeRotation(db, { oldFingerprint: identity.fingerprint, reason: 'crash test' });
    const begun = beginRotation({ dir: tlsDir, db, rotationId });

    // Crash here: journal prepared, new pair on disk, old pair still serving.
    const recovered = recoverRotation({ dir: tlsDir, db, rotationId });
    expect(recovered.state).toBe('completed');
    expect(recovered.fingerprint).toBe(begun.newFingerprint);
    expect(loadOrCreateServerIdentity({ dir: tlsDir, allowCreate: false }).fingerprint).toBe(begun.newFingerprint);
  });

  it('recovers a rotation interrupted in the middle of the swap', () => {
    const { db, tlsDir, identity } = setup();
    const rotationId = authorizeRotation(db, { oldFingerprint: identity.fingerprint, reason: 'crash mid-swap' });
    const begun = beginRotation({ dir: tlsDir, db, rotationId });

    // Simulate the crash after the certificate was moved aside but before the key was.
    fs.renameSync(path.join(tlsDir, 'server.crt'), path.join(tlsDir, 'server.crt.interrupted.old'));

    const recovered = recoverRotation({ dir: tlsDir, db, rotationId });
    expect(recovered.state).toBe('completed');
    expect(recovered.fingerprint).toBe(begun.newFingerprint);
  });

  it('completes a swap that crashed after the files were replaced but before cleanup', () => {
    const { db, tlsDir, identity } = setup();
    const rotationId = authorizeRotation(db, { oldFingerprint: identity.fingerprint, reason: 'crash after swap' });
    const begun = beginRotation({ dir: tlsDir, db, rotationId });
    fs.renameSync(path.join(tlsDir, 'server.crt'), path.join(tlsDir, 'server.crt.done.old'));
    fs.renameSync(path.join(tlsDir, 'server.key'), path.join(tlsDir, 'server.key.done.old'));
    fs.renameSync(path.join(tlsDir, 'server.crt.next'), path.join(tlsDir, 'server.crt'));
    fs.renameSync(path.join(tlsDir, 'server.key.next'), path.join(tlsDir, 'server.key'));

    const recovered = recoverRotation({ dir: tlsDir, db, rotationId });
    expect(recovered.state).toBe('completed');
    expect(recovered.fingerprint).toBe(begun.newFingerprint);
  });

  it('aborts a rotation whose new certificate is corrupt and keeps the old identity', () => {
    const { db, tlsDir, identity } = setup();
    const rotationId = authorizeRotation(db, { oldFingerprint: identity.fingerprint, reason: 'corrupt next' });
    beginRotation({ dir: tlsDir, db, rotationId });
    fs.writeFileSync(path.join(tlsDir, 'server.crt.next'), 'not a certificate');

    const recovered = recoverRotation({ dir: tlsDir, db, rotationId });
    expect(recovered.state).toBe('aborted');
    expect(recovered.fingerprint).toBe(identity.fingerprint);
    expect(loadOrCreateServerIdentity({ dir: tlsDir, allowCreate: false }).fingerprint).toBe(identity.fingerprint);
    const row = db.prepare('SELECT state FROM cert_rotations WHERE id = ?').get(rotationId) as { state: string };
    expect(row.state).toBe('aborted');
  });

  it('makes a pinned client reject the new certificate until an administrator re-pairs it', () => {
    const { db, tlsDir, identity } = setup();
    const oldPin = identity.fingerprint;
    const rotationId = authorizeRotation(db, { oldFingerprint: oldPin, reason: 'pin test' });
    beginRotation({ dir: tlsDir, db, rotationId });
    const rotated = commitRotation({ dir: tlsDir, db, rotationId });

    const check = checkPinnedFingerprint(rotated.certPem, oldPin);
    expect(check.ok).toBe(false);
    expect(check.code).toBe('CERT_MISMATCH');
    expect(check.actual).toBe(rotated.fingerprint);
  });

  it('refuses a certificate that was swapped outside the rotation process', () => {
    const { tlsDir, identity } = setup();
    const other = loadOrCreateServerIdentity({ dir: path.join(tlsDir, 'other'), allowCreate: true });
    // Attack / accident: overwrite the serving certificate with another one.
    fs.copyFileSync(path.join(tlsDir, 'other', 'server.crt'), path.join(tlsDir, 'server.crt'));
    try {
      loadOrCreateServerIdentity({ dir: tlsDir, allowCreate: false, expectedFingerprint: identity.fingerprint });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IdentityError);
      expect(['IDENTITY_MISMATCH', 'IDENTITY_CORRUPT']).toContain((err as IdentityError).code);
    }
    // The fingerprint check alone also fails closed.
    expect(checkPinnedFingerprint(other.certPem, identity.fingerprint).ok).toBe(false);
  });
});
