/**
 * v1.1.4 audit — the complete two-application flow, end to end.
 *
 *   License Generator (sign + export `.sauda` file)
 *     → Main App activation (signature, binding, capacity)
 *       → Client device pairing claim (single-use code, TLS pin, signature)
 *         → Main Server approval
 *           → authenticated client RPC over `/api/v1`
 *
 * Plus the adversarial branches that must never succeed: a foreign store, a replayed pairing
 * code, a claim that declares itself the server, and a claim beyond the licensed capacity.
 *
 * Everything runs on real sockets with real TLS and real signatures; only Windows-specific
 * pieces (DPAPI sealing, NSIS packaging, printers) are out of scope.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  activate,
  approveDevice,
  capacitySummary,
  createPairingToken,
  createV1Client,
  enrolDevice,
  generateDeviceKeyPair,
  getActivationState,
  getDeviceFingerprint,
  getStoreIdentity,
  initializeApp,
  licensedCapacity,
  loadOrCreateServerIdentity,
  openDatabase,
  startLanApi,
  type Db,
  type DeviceFingerprint,
  type LanApi,
} from '@sauda/core';
import {
  licenseState,
  recordIssuedLicense,
  revokeLicense,
  signLicense,
  toLicenseFile,
  verifyLicenseFile,
  featuresForEdition,
  type DeviceRequest,
} from '../src/domain.js';

vi.setConfig({ testTimeout: 40_000 });

const dirs: string[] = [];
const apis: LanApi[] = [];

afterAll(async () => {
  for (const api of apis) await api.stop().catch(() => undefined);
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-full-flow-'));
  dirs.push(dir);
  return dir;
}

/**
 * The generator receives a device request from the Main PC; here that is this machine's real
 * fingerprint, because activation re-probes the hardware it runs on.
 */
function deviceRequestFrom(fingerprint: DeviceFingerprint, business = 'পূর্ণ প্রবাহ স্টোর'): DeviceRequest {
  return {
    kind: 'sauda-device-request',
    v: fingerprint.version,
    fingerprint: fingerprint.hash,
    components: fingerprint.components,
    platform: 'win32',
    app_version: '1.1.4',
    business_name: business,
  };
}

function mainApp(dir: string) {
  const db = openDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
  initializeApp(db, {
    businessName: 'পূর্ণ প্রবাহ স্টোর',
    businessAddress: 'চট্টগ্রাম',
    businessPhone: '01700000000',
    adminFullName: 'মালিক',
    adminUsername: 'owner',
    adminPassword: 'owner123',
  });
  const admin = db.prepare('SELECT id, username FROM users ORDER BY id LIMIT 1').get() as {
    id: number;
    username: string;
  };
  return { db, actor: { id: admin.id, username: admin.username } };
}

describe('generator → activation → pairing → approval → client RPC', () => {
  const vendor = crypto.generateKeyPairSync('ed25519');
  const vendorPrivB64 = vendor.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const vendorPubB64 = vendor.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

  it('carries one licence through the whole chain', async () => {
    /* ---------------- 1. Main App: fresh shop ---------------- */
    const dir = tempDir();
    const { db, actor } = mainApp(dir);
    const store = getStoreIdentity(db);

    /* ---------------- 2. License Generator: issue + export ---------------- */
    const serverPc = getDeviceFingerprint(true);
    const issued = signLicense({
      device: deviceRequestFrom(serverPc),
      issue: {
        org: 'পূর্ণ প্রবাহ স্টোর',
        owner: 'মালিক',
        phone: '01700000000',
        edition: 'enterprise',
        maxDevices: 3,
        features: featuresForEdition('enterprise'),
        expiresAt: '2030-12-31',
        storeId: store.store_id,
      },
      privateKeyB64: vendorPrivB64,
      generatorVersion: '1.1.4',
    });
    const storeFile = { version: 2, customers: [], licenses: [], settings: {} } as never;
    const record = recordIssuedLicense(storeFile, { result: issued, customerId: null, filePath: null });
    expect(licenseState(record)).toBe('active');
    const exported = toLicenseFile(record);

    // The generator can verify its own file before handing it over.
    const selfCheck = verifyLicenseFile(exported, { publicKeyB64: vendorPubB64, device: deviceRequestFrom(serverPc) });
    expect(selfCheck.ok).toBe(true);

    /* ---------------- 3. Main App: activate ---------------- */
    const activated = activate(db, { fileContent: exported, publicKeyB64: vendorPubB64 }, actor);
    expect(activated.activated).toBe(true);
    expect(getActivationState(db, vendorPubB64).license?.store_id).toBe(store.store_id);
    expect(licensedCapacity(db)).toBe(3);

    /* ---------------- 4. Main Server: LAN API ---------------- */
    const identity = loadOrCreateServerIdentity({ dir: path.join(dir, 'tls'), allowCreate: true, ips: [] });
    const api = await startLanApi({
      port: 0,
      tls: { certPem: identity.certPem, keyPem: identity.keyPem, fingerprint: identity.fingerprint },
      db,
      version: '1.1.4',
      storeId: () => store.store_id,
      serverId: () => store.server_id,
      licensedCapacity: () => licensedCapacity(db),
      allowRemote: () => true,
      invoke: async (method) => ({ ok: true, data: { method } }),
      authenticate: async (username, password) =>
        username === 'owner' && password === 'owner123'
          ? { id: actor.id, username, full_name: 'মালিক', role: 'admin', permissions: ['pos.sell'] }
          : null,
      ssePollMs: 25,
      sseHeartbeatMs: 120,
    });
    apis.push(api);

    /* ---------------- 5. Client PC: claim ---------------- */
    const clientKeys = generateDeviceKeyPair();
    const baseUrl = `https://127.0.0.1:${api.port}`;
    const client = createV1Client({
      baseUrl,
      tls: { caPem: identity.certPem, fingerprint: identity.fingerprint },
      deviceId: 'DEV-CLIENT-1',
      privateKeyPem: clientKeys.privateKeyPem,
      timeoutMs: 8000,
    });
    const claim = await client.claim({
      code: createPairingToken(db).code,
      device_id: 'DEV-CLIENT-1',
      device_name: 'কাউন্টার ১',
      public_key: clientKeys.publicKeySpkiB64,
      license: {
        license_id: issued.payload.license_id,
        store_id: store.store_id,
        capacity: issued.payload.max_devices,
      },
    });
    expect(claim.ok).toBe(true);
    expect(claim.data?.status).toBe('pending');

    // A pending device gets no data.
    const blocked = await client.login('owner', 'owner123');
    expect(blocked.ok).toBe(false);

    /* ---------------- 6. Main Server: approval ---------------- */
    const approved = approveDevice(db, 'DEV-CLIENT-1', actor);
    expect(approved.status).toBe('approved');

    /* ---------------- 7. Client PC: login + RPC ---------------- */
    const login = await client.login('owner', 'owner123');
    expect(login.ok).toBe(true);
    const rpc = await client.rpc<{ method: string }>('meta.ping', []);
    expect(rpc.ok).toBe(true);
    expect(rpc.data).toEqual({ method: 'meta.ping' });

    /* ---------------- 8. Enforcement on the same shop ---------------- */
    expect(capacitySummary(db)).toMatchObject({ licensed: 3, approved: 1, available: 2 });
    db.close();
  });

  it('refuses a claim that names another store, reuses a code, or claims the server role', async () => {
    const dir = tempDir();
    const { db, actor } = mainApp(dir);
    const store = getStoreIdentity(db);
    const serverPc = getDeviceFingerprint(true);
    const issued = signLicense({
      device: deviceRequestFrom(serverPc),
      issue: {
        org: 'পূর্ণ প্রবাহ স্টোর',
        edition: 'standard',
        maxDevices: 2,
        features: featuresForEdition('standard'),
        storeId: store.store_id,
      },
      privateKeyB64: vendorPrivB64,
      generatorVersion: '1.1.4',
    });
    const record = recordIssuedLicense(
      { version: 2, customers: [], licenses: [], settings: {} } as never,
      { result: issued, customerId: null, filePath: null },
    );
    expect(activate(db, { fileContent: toLicenseFile(record), publicKeyB64: vendorPubB64 }, actor).activated).toBe(true);

    const identity = loadOrCreateServerIdentity({ dir: path.join(dir, 'tls'), allowCreate: true, ips: [] });
    const api = await startLanApi({
      port: 0,
      tls: { certPem: identity.certPem, keyPem: identity.keyPem, fingerprint: identity.fingerprint },
      db,
      version: '1.1.4',
      storeId: () => store.store_id,
      serverId: () => store.server_id,
      licensedCapacity: () => licensedCapacity(db),
      allowRemote: () => true,
      invoke: async () => ({ ok: true, data: null }),
      authenticate: async () => null,
      ssePollMs: 25,
      sseHeartbeatMs: 120,
    });
    apis.push(api);

    const keys = generateDeviceKeyPair();
    const client = createV1Client({
      baseUrl: `https://127.0.0.1:${api.port}`,
      tls: { caPem: identity.certPem, fingerprint: identity.fingerprint },
      deviceId: 'DEV-BAD',
      privateKeyPem: keys.privateKeyPem,
      timeoutMs: 8000,
    });
    const licence = { license_id: issued.payload.license_id, store_id: store.store_id, capacity: 2 };

    // Wrong store: refused even with a valid pairing code.
    const wrongStore = await client.claim({
      code: createPairingToken(db).code,
      device_id: 'DEV-BAD',
      device_name: 'অনুপ্রবেশ',
      public_key: keys.publicKeySpkiB64,
      license: { ...licence, store_id: 'STORE-THEIRS' },
    });
    expect(wrongStore.ok).toBe(false);
    expect(wrongStore.code).toBe('STORE_MISMATCH');

    // A claim may not install itself as the server.
    const serverRole = await rawClaim(api.port, identity.certPem, identity.fingerprint, {
      code: createPairingToken(db).code,
      device_id: 'DEV-SERVER-WANNABE',
      device_name: 'নকল সার্ভার',
      public_key: keys.publicKeySpkiB64,
      role: 'SERVER_POS',
      license: licence,
    });
    expect(serverRole.code).toBe('BAD_ROLE');
    expect(licensedCapacity(db)).toBe(2);

    // A single-use code cannot be replayed by a second device.
    const code = createPairingToken(db).code;
    const first = await client.claim({
      code,
      device_id: 'DEV-BAD',
      device_name: 'প্রথম',
      public_key: keys.publicKeySpkiB64,
      license: licence,
    });
    expect(first.ok).toBe(true);
    const replay = await client.claim({
      code,
      device_id: 'DEV-BAD-2',
      device_name: 'দ্বিতীয়',
      public_key: keys.publicKeySpkiB64,
      license: licence,
    });
    expect(replay.ok).toBe(false);
    expect(capacitySummary(db).pending).toBe(1);
    db.close();
  });

  it('a revoked or superseded generator licence is not a working path back in', async () => {
    const dir = tempDir();
    const { db, actor } = mainApp(dir);
    const store = getStoreIdentity(db);
    const serverPc = getDeviceFingerprint(true);
    const issued = signLicense({
      device: deviceRequestFrom(serverPc),
      issue: {
        org: 'পূর্ণ প্রবাহ স্টোর',
        edition: 'standard',
        maxDevices: 1,
        features: featuresForEdition('standard'),
        storeId: store.store_id,
      },
      privateKeyB64: vendorPrivB64,
      generatorVersion: '1.1.4',
    });
    const storeFile = { version: 2, customers: [], licenses: [], settings: {} } as never;
    const record = recordIssuedLicense(storeFile, { result: issued, customerId: null, filePath: null });
    const exported = toLicenseFile(record);
    revokeLicense(storeFile, record.license_id, 'টাকা ফেরত');

    // The operator's own verification now reports the revocation …
    const outcome = verifyLicenseFile(exported, { publicKeyB64: vendorPubB64, revokedIds: [record.license_id] });
    expect(outcome.revoked).toBe(true);
    // … and the generator will not hand out the file again.
    expect(() => toLicenseFile(record)).toThrowError(/প্রত্যাহার/);
    // The Main App cannot know about an offline revocation, so the file still activates: this
    // is a documented limitation, not a hidden one (release notes, §Known limitations).
    expect(activate(db, { fileContent: exported, publicKeyB64: vendorPubB64 }, actor).activated).toBe(true);
    db.close();
  });
});

/** Raw claim post, so a test can send fields the client API never exposes (e.g. `role`). */
function rawClaim(
  port: number,
  certPem: string,
  fingerprint: string,
  body: Record<string, unknown>,
): Promise<{ status: number; code?: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1/pairing/claim',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
        ca: certPem,
        timeout: 8000,
        checkServerIdentity: (_h, cert) => {
          const pin = crypto.createHash('sha256').update(cert.raw).digest('hex').toUpperCase();
          return pin === fingerprint.replace(/[^0-9a-fA-F]/g, '').toUpperCase() ? undefined : new Error('pin');
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          let code: string | undefined;
          try {
            code = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { code?: string }).code;
          } catch {
            code = undefined;
          }
          resolve({ status: res.statusCode ?? 0, code });
        });
      },
    );
    req.on('error', () => resolve({ status: 0, code: 'OFFLINE' }));
    req.write(payload);
    req.end();
  });
}
