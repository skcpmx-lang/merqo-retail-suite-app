/**
 * Phase 3, Milestone B — `/api/v1` device authentication, pairing, idempotency and
 * certificate persistence.
 *
 * Real TLS listener, real SQLite database, real Ed25519 signatures. Every test here
 * is an attack or a failure mode first; the happy path exists only to prove the
 * negative tests fail for the right reason.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  IdentityError,
  approveDevice,
  createPairingToken,
  generateDeviceKeyPair,
  getStoreIdentity,
  initializeApp,
  integrityCheck,
  loadOrCreateServerIdentity,
  openDatabase,
  rotateServerIdentity,
  signRequest,
  startLanApi,
  type Db,
  type LanApi,
} from '../src/index.js';
import { generateServerCertificate } from '../src/net/certificate.js';

// These are integration tests: each one builds an RSA identity, opens a real SQLite
// file and negotiates TLS, so the 5 s default is too tight on a loaded machine.
vi.setConfig({ testTimeout: 20_000 });

const dirs: string[] = [];
const servers: LanApi[] = [];
const dbs: Db[] = [];
const admin = { id: 1, username: 'owner' };

afterAll(async () => {
  for (const server of servers) await server.stop().catch(() => undefined);
  for (const db of dbs) db.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  db: Db;
  dir: string;
  server: LanApi;
  cert: { certPem: string; keyPem: string; fingerprint: string };
  call: (opts: {
    method?: string;
    path: string;
    body?: unknown;
    keys?: { publicKeySpkiB64: string; privateKeyPem: string; deviceId: string };
    headers?: Record<string, string>;
    signedBody?: string;
    timestamp?: number;
    nonce?: string;
  }) => Promise<{ status: number; json: any }>;
}

async function harness(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-api-'));
  dirs.push(dir);
  const db = openDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
  dbs.push(db);
  initializeApp(db, {
    businessName: 'টেস্ট স্টোর',
    businessAddress: 'চট্টগ্রাম',
    businessPhone: '01700000000',
    adminFullName: 'মালিক',
    adminUsername: 'owner',
    adminPassword: 'owner123',
  });

  const identity = loadOrCreateServerIdentity({ dir: path.join(dir, 'tls'), allowCreate: true, ips: [] });
  const cert = { certPem: identity.certPem, keyPem: identity.keyPem, fingerprint: identity.fingerprint };
  const store = getStoreIdentity(db);

  const server = await startLanApi({
    port: 0,
    tls: cert,
    db,
    version: '1.1.4',
    storeId: () => store.store_id,
    serverId: () => store.server_id,
    licensedCapacity: () => 10,
    invoke: async (method, args, user) => {
      if (method === 'products.list') return { ok: true, data: ['a'] };
      if (method === 'reports.profit') {
        // A permission the cashier role does not have.
        if (!user?.permissions.includes('report.view')) {
          return { ok: false, code: 'FORBIDDEN', error: 'অনুমতি নেই।' };
        }
        return { ok: true, data: { profit: 100 } };
      }
      if (method === 'pos.createSale') {
        // A cart whose price or stock moved since the cashier scanned it.
        return {
          ok: false,
          code: 'SALE_CONFLICT',
          error: 'কার্টের তথ্য বদলে গেছে।',
          details: {
            conflicts: [
              { kind: 'PRICE_CHANGED', lineIndex: 0, productId: 3, expectedPaisa: 15000, currentPaisa: 17000 },
              { kind: 'STOCK_CHANGED', lineIndex: 1, productId: 4, requiredBaseMilli: 2_000_000, availableBaseMilli: 500_000 },
            ],
          },
        };
      }
      if (method === 'counter.bump') {
        const n = (db.prepare("SELECT value FROM meta WHERE key='counter'").get() as { value: string } | undefined)
          ?.value;
        db.prepare("INSERT INTO meta (key, value) VALUES ('counter', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run();
        return { ok: true, data: Number(n ?? 0) + 1 };
      }
      return { ok: true, data: { method, args } };
    },
    authenticate: async (username, password) => {
      if (username !== 'owner' || password !== 'owner123') throw new Error('ভুল তথ্য');
      return {
        id: admin.id,
        username,
        full_name: 'মালিক',
        role: 'admin',
        permissions: ['report.view'],
      };
    },
    allowRemote: () => true,
  });
  servers.push(server);

  const call: Harness['call'] = async (opts) => {
    const body = opts.signedBody ?? JSON.stringify(opts.body ?? {});
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      ...(opts.headers ?? {}),
    };
    if (opts.keys) {
      const signed = signRequest(opts.keys.privateKeyPem, {
        method: opts.method ?? 'POST',
        path: opts.path,
        body,
        deviceId: opts.keys.deviceId,
        nonce: opts.nonce,
        timestamp: opts.timestamp,
      });
      Object.assign(headers, signed);
    }
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: opts.path,
          method: opts.method ?? 'POST',
          headers,
          ca: cert.certPem,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.from(c)));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            try {
              resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) });
            } catch {
              reject(new Error(`non-JSON reply: ${text.slice(0, 120)}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  };

  return { db, dir, server, cert, call };
}

/** Enrols a device and returns its key material (approved unless stated). */
function enrol(
  h: Harness,
  opts: { deviceId: string; role?: 'SERVER_POS' | 'CLIENT_POS'; approve?: boolean; key?: ReturnType<typeof generateDeviceKeyPair> },
): { deviceId: string; privateKeyPem: string; publicKeySpkiB64: string } {
  const keys = opts.key ?? generateDeviceKeyPair();
  const store = getStoreIdentity(h.db);
  const terminal = h.db
    .prepare(
      `INSERT INTO terminals (device_id, device_name, role, store_id, license_id, status, public_key, requested_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      opts.deviceId,
      opts.deviceId,
      opts.role ?? 'CLIENT_POS',
      store.store_id,
      `LIC-${opts.deviceId}`,
      opts.approve === false ? 'pending' : 'approved',
      keys.publicKeySpkiB64,
      new Date().toISOString(),
    );
  void terminal;
  return { deviceId: opts.deviceId, privateKeyPem: keys.privateKeyPem, publicKeySpkiB64: keys.publicKeySpkiB64 };
}

describe('server info over TLS', () => {
  it('serves identity without any secret or licence payload', async () => {
    const h = await harness();
    const res = await h.call({ method: 'GET', path: '/api/v1/server/info' });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ protocol: 1, version: '1.1.4', capacity: 10 });
    expect(JSON.stringify(res.json)).not.toMatch(/LIC-|private|secret/i);
  });

  it('refuses to start without TLS material', async () => {
    await expect(
      startLanApi({
        port: 0,
        tls: { certPem: '', keyPem: '', fingerprint: '' },
        db: {} as Db,
        version: '1.1.4',
        storeId: () => 'S',
        serverId: () => 'V',
        licensedCapacity: () => 1,
        invoke: async () => ({ ok: true }),
        authenticate: async () => ({ id: 1, username: 'a', full_name: 'a', role: 'admin', permissions: [] }),
      }),
    ).rejects.toThrow(/TLS/);
  });
});

describe('device authentication', () => {
  it('rejects an unknown device before any route runs', async () => {
    const h = await harness();
    const keys = generateDeviceKeyPair();
    const res = await h.call({
      path: '/api/v1/rpc',
      body: { method: 'products.list', args: [] },
      keys: { ...keys, deviceId: 'DEV-GHOST' },
    });
    expect(res.status).toBe(401);
    expect(res.json.code).toBe('UNKNOWN_DEVICE');
  });

  it('rejects a missing signature', async () => {
    const h = await harness();
    const device = enrol(h, { deviceId: 'DEV-1' });
    const res = await h.call({ path: '/api/v1/rpc', body: { method: 'products.list' }, keys: undefined });
    expect(res.status).toBe(401);
    expect(res.json.code).toBe('MISSING_SIGNATURE');
    void device;
  });

  it('rejects a tampered body (signature covers the body digest)', async () => {
    const h = await harness();
    const device = enrol(h, { deviceId: 'DEV-2' });
    const signed = JSON.stringify({ method: 'products.list', args: [] });
    const tampered = JSON.stringify({ method: 'sales.void', args: [1] });
    const res = await h.call({
      path: '/api/v1/rpc',
      signedBody: tampered,
      headers: signRequest(device.privateKeyPem, {
        method: 'POST',
        path: '/api/v1/rpc',
        body: signed,
        deviceId: device.deviceId,
      }),
    });
    expect(res.status).toBe(401);
    expect(res.json.code).toBe('BAD_SIGNATURE');
  });

  it('rejects a stale timestamp and a replayed nonce', async () => {
    const h = await harness();
    const device = enrol(h, { deviceId: 'DEV-3' });
    const stale = await h.call({
      path: '/api/v1/rpc',
      body: { method: 'products.list' },
      keys: device,
      timestamp: Date.now() - 10 * 60 * 1000,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('STALE_REQUEST');

    const nonce = 'f'.repeat(32);
    const first = await h.call({ method: 'GET', path: '/api/v1/devices/self', keys: device, nonce, signedBody: '' });
    expect(first.status).toBe(200);
    const replay = await h.call({ method: 'GET', path: '/api/v1/devices/self', keys: device, nonce, signedBody: '' });
    expect(replay.status).toBe(409);
    expect(replay.json.code).toBe('REPLAY');
  });

  it('rejects a pending device but lets it read its own status', async () => {
    const h = await harness();
    const device = enrol(h, { deviceId: 'DEV-4', approve: false });
    const self = await h.call({ method: 'GET', path: '/api/v1/devices/self', keys: device });
    expect(self.status).toBe(200);
    expect(self.json.data.status).toBe('pending');
    const rpc = await h.call({ path: '/api/v1/rpc', body: { method: 'products.list' }, keys: device });
    expect(rpc.status).toBe(403);
    expect(rpc.json.code).toBe('DEVICE_PENDING');
  });

  it('rejects a revoked device even with a valid signature', async () => {
    const h = await harness();
    const device = enrol(h, { deviceId: 'DEV-5' });
    const store = getStoreIdentity(h.db);
    h.db
      .prepare("UPDATE terminals SET status = 'revoked', revoked_at = ? WHERE device_id = ?")
      .run(new Date().toISOString(), device.deviceId);
    const res = await h.call({ path: '/api/v1/rpc', body: { method: 'products.list' }, keys: device });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe('DEVICE_REVOKED');
    void store;
  });

  it('rejects a device whose signing key does not match the registered key', async () => {
    const h = await harness();
    const registered = enrol(h, { deviceId: 'DEV-6' });
    const impostor = generateDeviceKeyPair();
    const res = await h.call({
      path: '/api/v1/rpc',
      body: { method: 'products.list' },
      keys: { ...impostor, deviceId: registered.deviceId },
    });
    expect(res.status).toBe(401);
    expect(res.json.code).toBe('BAD_SIGNATURE');
  });
});

describe('sessions and authorisation', () => {
  it('logs in, binds the session to the device, and enforces route permissions', async () => {
    const h = await harness();
    const device = enrol(h, { deviceId: 'DEV-7' });
    const login = await h.call({
      path: '/api/v1/auth/login',
      body: { username: 'owner', password: 'owner123' },
      keys: device,
    });
    expect(login.status).toBe(200);
    const session = login.json.data.session as string;
    expect(session).toBeTruthy();

    const allowed = await h.call({
      path: '/api/v1/rpc',
      body: { method: 'reports.profit', args: [], session },
      keys: device,
    });
    expect(allowed.status).toBe(200);
    expect(allowed.json.data).toMatchObject({ profit: 100 });

    // The same session presented by a different device is refused.
    const other = enrol(h, { deviceId: 'DEV-8' });
    const stolen = await h.call({
      path: '/api/v1/rpc',
      body: { method: 'reports.profit', args: [], session },
      keys: other,
    });
    expect(stolen.status).toBe(403);
    expect(stolen.json.code).toBe('SESSION_DEVICE_MISMATCH');
  });

  it('refuses a route the user has no permission for', async () => {
    const h = await harness();
    const device = enrol(h, { deviceId: 'DEV-9' });
    const login = await h.call({ path: '/api/v1/auth/login', body: { username: 'owner', password: 'owner123' }, keys: device });
    const session = login.json.data.session as string;
    // Drop the permission the route needs.
    h.db.prepare("UPDATE users SET permissions = '[]' WHERE id = 1").run();
    const denied = await h.call({ path: '/api/v1/rpc', body: { method: 'reports.profit', args: [], session }, keys: device });
    expect(denied.json.ok).toBe(false);
    expect(denied.json.code).toBe('FORBIDDEN');
  });

  it('answers a stale cart with 409 and the per-line conflicts', async () => {
    const h = await harness();
    const device = enrol(h, { deviceId: 'DEV-11' });
    const login = await h.call({ path: '/api/v1/auth/login', body: { username: 'owner', password: 'owner123' }, keys: device });
    const session = login.json.data.session as string;
    const res = await h.call({
      path: '/api/v1/rpc',
      body: { method: 'pos.createSale', args: [{ lines: [] }], session },
      keys: device,
    });
    // Not an authorisation failure: the cashier must be able to see and fix the cart.
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('SALE_CONFLICT');
    expect(res.json.details.conflicts).toHaveLength(2);
    expect(res.json.details.conflicts[0].kind).toBe('PRICE_CHANGED');
  });

  it('requires a session for /rpc', async () => {
    const h = await harness();
    const device = enrol(h, { deviceId: 'DEV-10' });
    const res = await h.call({ path: '/api/v1/rpc', body: { method: 'products.list', args: [] }, keys: device });
    expect(res.status).toBe(401);
    expect(res.json.code).toBe('AUTH_REQUIRED');
  });
});

describe('pairing', () => {
  it('accepts a code once, creates a pending device, and rejects the replay', async () => {
    const h = await harness();
    const store = getStoreIdentity(h.db);
    // The Main PC's own licence has to exist before clients may enrol.
    h.db
      .prepare(
        `INSERT INTO device_licenses (license_id, store_id, device_id, role, capacity, issued_at, status, payload, registered_at)
         VALUES ('LIC-SRV', ?, 'DEV-SRV', 'SERVER_POS', 4, ?, 'active', '{}', ?)`,
      )
      .run(store.store_id, new Date().toISOString(), new Date().toISOString());
    const { code } = createPairingToken(h.db, { createdBy: admin.id });
    const keys = generateDeviceKeyPair();
    const claim = {
      code,
      device_id: 'DEV-P1',
      device_name: 'কাউন্টার ২',
      role: 'CLIENT_POS',
      public_key: keys.publicKeySpkiB64,
      license: { license_id: 'LIC-P1', store_id: store.store_id, issued_at: new Date().toISOString(), capacity: 4, payload: {} },
    };
    const first = await h.call({ path: '/api/v1/pairing/claim', body: claim });
    expect(first.status).toBe(202);
    expect(first.json.data.status).toBe('pending');

    const replay = await h.call({ path: '/api/v1/pairing/claim', body: claim });
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(['PAIRING_USED', 'PAIRING_INVALID']).toContain(replay.json.code);
  });

  it('rejects a licence from another store', async () => {
    const h = await harness();
    const store = getStoreIdentity(h.db);
    h.db
      .prepare(
        `INSERT INTO device_licenses (license_id, store_id, device_id, role, capacity, issued_at, status, payload, registered_at)
         VALUES ('LIC-SRV', ?, 'DEV-SRV', 'SERVER_POS', 4, ?, 'active', '{}', ?)`,
      )
      .run(store.store_id, new Date().toISOString(), new Date().toISOString());
    const { code } = createPairingToken(h.db, {});
    const keys = generateDeviceKeyPair();
    const res = await h.call({
      path: '/api/v1/pairing/claim',
      body: {
        code,
        device_id: 'DEV-P2',
        role: 'CLIENT_POS',
        public_key: keys.publicKeySpkiB64,
        license: { license_id: 'LIC-X', store_id: 'STORE-OTHER', issued_at: new Date().toISOString(), capacity: 4 },
      },
    });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('STORE_MISMATCH');
  });

  it('rejects an expired pairing code', async () => {
    const h = await harness();
    const { code } = createPairingToken(h.db, { ttlMs: -1000 });
    const keys = generateDeviceKeyPair();
    const res = await h.call({
      path: '/api/v1/pairing/claim',
      body: { code, device_id: 'DEV-P3', role: 'CLIENT_POS', public_key: keys.publicKeySpkiB64, license: { license_id: 'L', store_id: 'S' } },
    });
    expect(res.status).toBe(410);
    expect(res.json.code).toBe('PAIRING_EXPIRED');
  });

  it('rejects a malformed public key', async () => {
    const h = await harness();
    const { code } = createPairingToken(h.db, {});
    const res = await h.call({
      path: '/api/v1/pairing/claim',
      body: { code, device_id: 'DEV-P4', role: 'CLIENT_POS', public_key: 'bm90LWEta2V5', license: { license_id: 'L', store_id: 'S' } },
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('BAD_KEY');
  });
});

describe('idempotency and concurrency', () => {
  async function readyToSell(h: Harness, deviceId: string) {
    const device = enrol(h, { deviceId });
    const login = await h.call({ path: '/api/v1/auth/login', body: { username: 'owner', password: 'owner123' }, keys: device });
    return { device, session: login.json.data.session as string };
  }

  it('returns the first answer for a repeated key and conflicts on a different body', async () => {
    const h = await harness();
    const { device, session } = await readyToSell(h, 'DEV-I1');
    const body = { method: 'counter.bump', args: [], session, idempotency_key: 'key-1' };
    const first = await h.call({ path: '/api/v1/rpc', body, keys: device });
    const second = await h.call({ path: '/api/v1/rpc', body, keys: device });
    expect(first.json.data).toBe(1);
    expect(second.json.data).toBe(1);

    const conflicting = await h.call({
      path: '/api/v1/rpc',
      body: { method: 'counter.bump', args: ['different'], session, idempotency_key: 'key-1' },
      keys: device,
    });
    expect(conflicting.status).toBe(409);
    expect(conflicting.json.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('serialises concurrent writes without duplicating or losing a counter', async () => {
    const h = await harness();
    const a = await readyToSell(h, 'DEV-C1');
    const b = await readyToSell(h, 'DEV-C2');
    const calls = Array.from({ length: 8 }, (_, i) =>
      h.call({
        path: '/api/v1/rpc',
        body: { method: 'counter.bump', args: [], session: (i % 2 ? a : b).session, idempotency_key: `k-${i}` },
        keys: i % 2 ? a.device : b.device,
      }),
    );
    const results = await Promise.all(calls);
    const values = results.map((r) => r.json.data).sort((x, y) => x - y);
    expect(values).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const row = h.db.prepare("SELECT value FROM meta WHERE key='counter'").get() as { value: string };
    expect(Number(row.value)).toBe(8);
  });
});

describe('certificate persistence and recovery', () => {
  it('keeps the same fingerprint across restarts and reuses the files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-id-'));
    dirs.push(dir);
    const first = loadOrCreateServerIdentity({ dir, allowCreate: true });
    expect(first.created).toBe(true);
    const second = loadOrCreateServerIdentity({ dir });
    expect(second.created).toBe(false);
    expect(second.fingerprint).toBe(first.fingerprint);
    // The key file is not world-readable where the OS supports POSIX modes.
    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(dir, 'server.key')).mode & 0o777;
      expect(mode & 0o077).toBe(0);
    }
  });

  it('refuses to invent an identity when it is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-id-'));
    dirs.push(dir);
    expect(() => loadOrCreateServerIdentity({ dir })).toThrow(IdentityError);
    try {
      loadOrCreateServerIdentity({ dir });
    } catch (err) {
      expect((err as IdentityError).code).toBe('IDENTITY_MISSING');
    }
  });

  it('reports a corrupt certificate instead of regenerating it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-id-'));
    dirs.push(dir);
    const identity = loadOrCreateServerIdentity({ dir, allowCreate: true });
    fs.writeFileSync(path.join(dir, 'server.crt'), 'obviously not a certificate');
    expect(() => loadOrCreateServerIdentity({ dir })).toThrow(IdentityError);
    // The bad file is still on disk — nothing was silently replaced.
    expect(fs.readFileSync(path.join(dir, 'server.crt'), 'utf8')).toBe('obviously not a certificate');
    void identity;
  });

  it('refuses a half-written identity (certificate without key)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-id-'));
    dirs.push(dir);
    loadOrCreateServerIdentity({ dir, allowCreate: true });
    fs.rmSync(path.join(dir, 'server.key'));
    try {
      loadOrCreateServerIdentity({ dir });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as IdentityError).code).toBe('IDENTITY_CORRUPT');
    }
  });

  it('detects a replaced certificate (different fingerprint) and refuses it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-id-'));
    dirs.push(dir);
    const original = loadOrCreateServerIdentity({ dir, allowCreate: true });
    const other = generateServerCertificate();
    fs.writeFileSync(path.join(dir, 'server.crt'), other.certPem);
    fs.writeFileSync(path.join(dir, 'server.key'), other.keyPem);
    try {
      loadOrCreateServerIdentity({ dir, expectedFingerprint: original.fingerprint });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as IdentityError).code).toBe('IDENTITY_MISMATCH');
    }
  });

  it('detects a mismatched certificate/key pair', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-id-'));
    dirs.push(dir);
    loadOrCreateServerIdentity({ dir, allowCreate: true });
    const other = generateServerCertificate();
    fs.writeFileSync(path.join(dir, 'server.key'), other.keyPem);
    try {
      loadOrCreateServerIdentity({ dir });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as IdentityError).code).toBe('IDENTITY_MISMATCH');
    }
  });

  it('rotates explicitly, keeps the old files, and changes the pin', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-id-'));
    dirs.push(dir);
    const original = loadOrCreateServerIdentity({ dir, allowCreate: true });
    const rotated = rotateServerIdentity(dir);
    expect(rotated.fingerprint).not.toBe(original.fingerprint);
    const backups = fs.readdirSync(dir).filter((f) => f.endsWith('.old'));
    expect(backups.length).toBe(2);
    // Reloading now returns the rotated identity and never the old pin.
    expect(loadOrCreateServerIdentity({ dir }).fingerprint).toBe(rotated.fingerprint);
  });
});

describe('database integrity after the API suite', () => {
  it('leaves the shop database healthy', async () => {
    const h = await harness();
    await h.call({ method: 'GET', path: '/api/v1/server/info' });
    expect(integrityCheck(h.db).ok).toBe(true);
  });
});

describe('approved device lifecycle through the API', () => {
  it('becomes usable only after administrator approval', async () => {
    const h = await harness();
    const store = getStoreIdentity(h.db);
    const serverKeys = generateDeviceKeyPair();
    h.db
      .prepare(
        `INSERT INTO terminals (device_id, device_name, role, store_id, license_id, status, public_key, requested_at)
         VALUES ('DEV-SRV','মূল কাউন্টার','SERVER_POS',?,'LIC-SRV','approved',?,?)`,
      )
      .run(store.store_id, serverKeys.publicKeySpkiB64, new Date().toISOString());
    h.db
      .prepare(
        `INSERT INTO device_licenses (license_id, store_id, device_id, role, capacity, issued_at, status, payload, registered_at)
         VALUES ('LIC-SRV', ?, 'DEV-SRV', 'SERVER_POS', 5, ?, 'active', '{}', ?)`,
      )
      .run(store.store_id, new Date().toISOString(), new Date().toISOString());
    const device = enrol(h, { deviceId: 'DEV-A1', approve: false });
    const before = await h.call({ path: '/api/v1/rpc', body: { method: 'products.list', session: 'x' }, keys: device });
    expect(before.json.code).toBe('DEVICE_PENDING');
    approveDevice(h.db, 'DEV-A1', admin);
    const login = await h.call({ path: '/api/v1/auth/login', body: { username: 'owner', password: 'owner123' }, keys: device });
    expect(login.status).toBe(200);
    const after = await h.call({
      path: '/api/v1/rpc',
      body: { method: 'products.list', args: [], session: login.json.data.session },
      keys: device,
    });
    expect(after.status).toBe(200);
    expect(after.json.data).toEqual(['a']);
    void crypto;
  });
});
