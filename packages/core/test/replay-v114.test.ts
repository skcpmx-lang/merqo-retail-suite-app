/**
 * Priority 1.2 — replay protection that survives a restart.
 *
 * The Milestone B guard was in-memory, so a captured request became reusable after
 * the Main Server restarted. These tests prove the durable guard instead: the same
 * signed request cannot be accepted twice, not even across a restart, and two
 * concurrent copies can never both win.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  getStoreIdentity,
  initializeApp,
  loadOrCreateServerIdentity,
  openDatabase,
  signRequest,
  startLanApi,
  type LanApi,
} from '../src/index.js';
import { SqliteReplayGuard } from '../src/net/replay-store.js';
import { generateDeviceKeyPair } from '../src/net/device-auth.js';

vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
const apis: LanApi[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-replay-'));
  dirs.push(dir);
  return dir;
}

function freshDb(dir: string) {
  const db = openDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
  initializeApp(db, {
    businessName: 'রিপ্লে স্টোর',
    businessAddress: 'ঢাকা',
    businessPhone: '01700000000',
    adminFullName: 'মালিক',
    adminUsername: 'owner',
    adminPassword: 'owner123',
  });
  return db;
}

function addDevice(db: ReturnType<typeof freshDb>, deviceId: string) {
  const keys = generateDeviceKeyPair();
  const store = getStoreIdentity(db);
  db.prepare(
    `INSERT INTO terminals (device_id, device_name, role, store_id, license_id, status, public_key, requested_at)
     VALUES (?,?,?,?,?,'approved',?,?)`,
  ).run(deviceId, deviceId, 'CLIENT_POS', store.store_id, `LIC-${deviceId}`, keys.publicKeySpkiB64, new Date().toISOString());
  return { ...keys, deviceId };
}

async function startApi(dir: string, db: ReturnType<typeof freshDb>): Promise<LanApi> {
  const identity = loadOrCreateServerIdentity({ dir: path.join(dir, 'tls'), allowCreate: true, ips: [] });
  const store = getStoreIdentity(db);
  const api = await startLanApi({
    port: 0,
    tls: { certPem: identity.certPem, keyPem: identity.keyPem, fingerprint: identity.fingerprint },
    db,
    version: '1.1.4',
    storeId: () => store.store_id,
    serverId: () => store.server_id,
    licensedCapacity: () => 10,
    invoke: async (method) => ({ ok: true, data: method }),
    authenticate: async (username) => ({ id: 1, username, full_name: 'মালিক', role: 'admin', permissions: ['report.view'] }),
    allowRemote: () => true,
  });
  apis.push(api);
  return api;
}

function signedCall(
  api: LanApi,
  identity: { certPem: string },
  opts: { deviceId: string; privateKeyPem: string; nonce: string; timestamp?: number; path?: string; body?: string; breakSignature?: boolean },
): Promise<{ status: number; json: { ok: boolean; code?: string; data?: unknown } }> {
  const body = opts.body ?? '';
  const headers: Record<string, string> = signRequest(opts.privateKeyPem, {
    method: 'GET',
    path: opts.path ?? '/api/v1/devices/self',
    body,
    deviceId: opts.deviceId,
    nonce: opts.nonce,
    timestamp: opts.timestamp,
  });
  if (opts.breakSignature) {
    const raw = Buffer.from(headers['x-sauda-sign']!, 'base64');
    raw[0] ^= 0xff;
    headers['x-sauda-sign'] = raw.toString('base64');
  }
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port: api.port,
        path: opts.path ?? '/api/v1/devices/self',
        method: 'GET',
        headers,
        ca: identity.certPem,
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
    req.end();
  });
}

afterAll(async () => {
  for (const api of apis) await api.stop().catch(() => undefined);
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('durable replay protection', () => {
  it('refuses a previously accepted request after a server restart', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-R1');
    const identityDir = path.join(dir, 'tls');

    const first = await startApi(dir, db);
    const identity = { certPem: loadOrCreateServerIdentity({ dir: identityDir, allowCreate: false }).certPem };
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();
    const accepted = await signedCall(first, identity, { ...device, nonce, timestamp });
    expect(accepted.status).toBe(200);
    await first.stop();

    // Same database, same identity, brand-new process-level state: the in-memory
    // guard would have forgotten the nonce here.
    const second = await startApi(dir, db);
    const replay = await signedCall(second, identity, { ...device, nonce, timestamp });
    // 409 = the request conflicts with one already accepted (never a silent 200).
    expect(replay.status).toBe(409);
    expect(replay.json.code).toBe('REPLAY');
  });

  it('accepts at most one of several concurrent identical requests', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-R2');
    const api = await startApi(dir, db);
    const identity = { certPem: loadOrCreateServerIdentity({ dir: path.join(dir, 'tls'), allowCreate: false }).certPem };
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();

    const results = await Promise.all(
      Array.from({ length: 6 }, () => signedCall(api, identity, { ...device, nonce, timestamp })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.json.code === 'REPLAY')).toHaveLength(5);
  });

  it('keeps nonces per device — one device cannot burn another device\'s nonce', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const a = addDevice(db, 'DEV-R3');
    const b = addDevice(db, 'DEV-R4');
    const api = await startApi(dir, db);
    const identity = { certPem: loadOrCreateServerIdentity({ dir: path.join(dir, 'tls'), allowCreate: false }).certPem };
    const nonce = 'n'.repeat(32);

    const first = await signedCall(api, identity, { ...a, nonce });
    const other = await signedCall(api, identity, { ...b, nonce });
    expect(first.status).toBe(200);
    expect(other.status).toBe(200);
  });

  it('does not let an unauthenticated request consume a nonce', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-R5');
    const api = await startApi(dir, db);
    const identity = { certPem: loadOrCreateServerIdentity({ dir: path.join(dir, 'tls'), allowCreate: false }).certPem };
    const nonce = crypto.randomBytes(16).toString('hex');

    const forged = await signedCall(api, identity, { ...device, nonce, breakSignature: true });
    expect(forged.status).toBe(401);
    expect(forged.json.code).toBe('BAD_SIGNATURE');

    // The honest device may still use that nonce.
    const real = await signedCall(api, identity, { ...device, nonce });
    expect(real.status).toBe(200);
  });

  it('rejects an expired timestamp without recording the nonce', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-R6');
    const api = await startApi(dir, db);
    const identity = { certPem: loadOrCreateServerIdentity({ dir: path.join(dir, 'tls'), allowCreate: false }).certPem };
    const nonce = crypto.randomBytes(16).toString('hex');

    const stale = await signedCall(api, identity, { ...device, nonce, timestamp: Date.now() - 130_000 });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('STALE_REQUEST');

    const fresh = await signedCall(api, identity, { ...device, nonce });
    expect(fresh.status).toBe(200);
  });
});

describe('SqliteReplayGuard unit behaviour', () => {
  it('remembers a nonce across guard instances and prunes expired rows', () => {
    const dir = tempDir();
    const db = openDatabase({ file: path.join(dir, 'guard.db'), appVersion: '1.1.4' });
    let now = Date.now();
    const guard = new SqliteReplayGuard(db, { now: () => now, pruneEveryMs: 0 });
    expect(guard.claim('DEV-X', 'nonce-1', now)).toBe(true);

    // A fresh guard on the same database (i.e. after a restart) still knows it.
    const restarted = new SqliteReplayGuard(db, { now: () => now, pruneEveryMs: 0 });
    expect(restarted.claim('DEV-X', 'nonce-1', now)).toBe(false);
    expect(restarted.size()).toBe(1);

    // After twice the clock skew the row expires and may be reused (the timestamp
    // window has long closed by then).
    now += 300_000;
    expect(restarted.claim('DEV-X', 'nonce-1', now)).toBe(true);
    expect(restarted.size()).toBe(1);
    db.close();
  });

  it('stores only a fingerprint of the request, never the body', () => {
    const dir = tempDir();
    const db = openDatabase({ file: path.join(dir, 'guard2.db'), appVersion: '1.1.4' });
    const guard = new SqliteReplayGuard(db);
    guard.claim('DEV-Y', 'abc1234567890abc');
    const row = db.prepare('SELECT * FROM device_nonces WHERE device_id = ?').get('DEV-Y') as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(['device_id', 'expires_at', 'nonce', 'seen_at']);
    db.close();
  });
});
