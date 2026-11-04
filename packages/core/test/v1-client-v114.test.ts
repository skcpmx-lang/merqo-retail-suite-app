/**
 * Milestone D (core part) — the `/api/v1` client and the proof that plaintext can
 * no longer reach a protected operation.
 */
import fs from 'node:fs';
import http from 'node:http';
import httpsModule from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  createV1Client,
  generateDeviceKeyPair,
  getStoreIdentity,
  initializeApp,
  loadOrCreateServerIdentity,
  openDatabase,
  startLanApi,
  type LanApi,
} from '../src/index.js';
import { closeTrackedDatabases, openTrackedDatabase, removeTempDirs } from '../../../test-setup/temp-resources.js';

vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
const apis: LanApi[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-v1c-'));
  dirs.push(dir);
  return dir;
}

type Bot = ReturnType<typeof openDatabase>;

function freshDb(dir: string): Bot {
  const db = openTrackedDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
  initializeApp(db, {
    businessName: 'ক্লায়েন্ট স্টোর',
    businessAddress: 'ঢাকা',
    businessPhone: '01700000000',
    adminFullName: 'মালিক',
    adminUsername: 'owner',
    adminPassword: 'owner123',
  });
  return db;
}

function addDevice(db: Bot, deviceId: string) {
  const keys = generateDeviceKeyPair();
  const store = getStoreIdentity(db);
  db.prepare(
    `INSERT INTO terminals (device_id, device_name, role, store_id, license_id, status, public_key, requested_at)
     VALUES (?,?,?,?,?,'approved',?,?)`,
  ).run(deviceId, deviceId, 'CLIENT_POS', store.store_id, `LIC-${deviceId}`, keys.publicKeySpkiB64, new Date().toISOString());
  return { ...keys, deviceId };
}

async function setup(counters: { invoked: number } = { invoked: 0 }) {
  const dir = tempDir();
  const db = freshDb(dir);
  const device = addDevice(db, 'DEV-C1');
  const identity = loadOrCreateServerIdentity({ dir: path.join(dir, 'tls'), allowCreate: true, ips: [] });
  const store = getStoreIdentity(db);
  const api = await startLanApi({
    port: 0,
    tls: { certPem: identity.certPem, keyPem: identity.keyPem, fingerprint: identity.fingerprint },
    db,
    version: '1.1.4',
    storeId: () => store.store_id,
    serverId: () => store.server_id,
    licensedCapacity: () => 5,
    invoke: async (method) => {
      counters.invoked += 1;
      return { ok: true, data: { method } };
    },
    authenticate: async (username, password) => {
      if (username !== 'owner' || password !== 'owner123') throw new Error('ভুল তথ্য');
      return { id: 1, username, full_name: 'মালিক', role: 'admin', permissions: ['report.view'] };
    },
    allowRemote: () => true,
  });
  apis.push(api);
  const client = createV1Client({
    baseUrl: `https://127.0.0.1:${api.port}`,
    tls: { caPem: identity.certPem, fingerprint: identity.fingerprint },
    deviceId: device.deviceId,
    privateKeyPem: device.privateKeyPem,
  });
  return { dir, db, device, identity, api, client, counters };
}

afterAll(async () => {
  for (const api of apis) await api.stop().catch(() => undefined);
  closeTrackedDatabases();
  removeTempDirs(dirs);
});

describe('/api/v1 client', () => {
  it('refuses a plaintext base URL instead of downgrading', () => {
    expect(() =>
      createV1Client({
        baseUrl: 'http://127.0.0.1:9',
        tls: { caPem: '', fingerprint: '' },
        deviceId: 'DEV-X',
        privateKeyPem: '',
      }),
    ).toThrowError(/HTTPS/);
  });

  it('reads server identity over TLS', async () => {
    const { client } = await setup();
    const res = await client.serverInfo();
    expect(res.ok).toBe(true);
    expect(res.data?.protocol).toBe(1);
    expect(res.data?.version).toBe('1.1.4');
    expect(JSON.stringify(res.data)).not.toContain('LICENSE');
  });

  it('logs in and executes a route with the device signature', async () => {
    const { client, counters } = await setup();
    const login = await client.login('owner', 'owner123');
    expect(login.ok).toBe(true);
    expect(login.data?.session).toBeTruthy();
    expect(login.data?.user.permissions).toEqual(['report.view']);

    const call = await client.rpc('products.list', []);
    expect(call.ok).toBe(true);
    expect(counters.invoked).toBe(1);
  });

  it('does not execute a route without a session', async () => {
    const { client, counters } = await setup();
    const call = await client.rpc('products.list', []);
    expect(call.ok).toBe(false);
    expect(call.code).toBe('AUTH_REQUIRED');
    expect(counters.invoked).toBe(0);
  });

  it('replays the stored answer for a repeated idempotency key', async () => {
    const { client, counters } = await setup();
    await client.login('owner', 'owner123');
    const first = await client.rpc('sale.create', [{ total: 100 }], { idempotencyKey: 'sale-1' });
    const second = await client.rpc('sale.create', [{ total: 100 }], { idempotencyKey: 'sale-1' });
    expect(first.ok).toBe(true);
    expect(second.data).toEqual(first.data);
    expect(counters.invoked).toBe(1); // the business route ran once
  });

  it('rejects a server whose certificate does not match the pin', async () => {
    const { identity } = await setup();
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-C2');
    const other = loadOrCreateServerIdentity({ dir: path.join(dir, 'tls'), allowCreate: true, ips: [] });
    const store = getStoreIdentity(db);
    const api = await startLanApi({
      port: 0,
      tls: { certPem: other.certPem, keyPem: other.keyPem, fingerprint: other.fingerprint },
      db,
      version: '1.1.4',
      storeId: () => store.store_id,
      serverId: () => store.server_id,
      licensedCapacity: () => 5,
      invoke: async () => ({ ok: true, data: 'should never run' }),
      authenticate: async (username) => ({ id: 1, username, full_name: 'x', role: 'admin', permissions: [] }),
      allowRemote: () => true,
    });
    apis.push(api);

    const pinnedToWrong = createV1Client({
      baseUrl: `https://127.0.0.1:${api.port}`,
      // Pinned to the *other* identity: the handshake must fail.
      tls: { caPem: other.certPem, fingerprint: identity.fingerprint },
      deviceId: device.deviceId,
      privateKeyPem: device.privateKeyPem,
    });
    const res = await pinnedToWrong.serverInfo();
    expect(res.ok).toBe(false);
    expect(['CERT_MISMATCH', 'OFFLINE']).toContain(res.code);
  });

  it('keeps the old pin working for the same identity across a restart', async () => {
    const { dir, db, identity } = await setup();
    const restarted = await startLanApi({
      port: 0,
      tls: { certPem: identity.certPem, keyPem: identity.keyPem, fingerprint: identity.fingerprint },
      db,
      version: '1.1.4',
      storeId: () => getStoreIdentity(db).store_id,
      serverId: () => getStoreIdentity(db).server_id,
      licensedCapacity: () => 5,
      invoke: async () => ({ ok: true, data: 'restarted' }),
      authenticate: async (username) => ({ id: 1, username, full_name: 'x', role: 'admin', permissions: [] }),
      allowRemote: () => true,
    });
    apis.push(restarted);
    void dir;
    const device = addDevice(db, 'DEV-C3');
    const client = createV1Client({
      baseUrl: `https://127.0.0.1:${restarted.port}`,
      tls: { caPem: identity.certPem, fingerprint: identity.fingerprint },
      deviceId: device.deviceId,
      privateKeyPem: device.privateKeyPem,
    });
    expect((await client.serverInfo()).ok).toBe(true);
  });
});

describe('plaintext cannot reach a protected operation', () => {
  it('answers no plaintext HTTP request on the v1 port and never invokes a route', async () => {
    const counters = { invoked: 0 };
    const { api } = await setup(counters);

    const attempt = (method: string, payload: string) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port: api.port, path: '/api/v1/rpc', method, timeout: 3000 },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(Buffer.from(c)));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
          },
        );
        req.on('error', () => resolve({ status: 0, body: 'connection-error' }));
        req.on('timeout', () => {
          req.destroy();
          resolve({ status: 0, body: 'timeout' });
        });
        if (payload) req.write(payload);
        req.end();
      });

    const legacy = await attempt('POST', JSON.stringify({ method: 'sale.create', args: [{ total: 500 }] }));
    expect(legacy.status).toBe(0);
    const legacyToken = await attempt('POST', JSON.stringify({ token: 'x', method: 'products.list' }));
    expect(legacyToken.status).toBe(0);
    expect(counters.invoked).toBe(0);
  });

  it('does not expose the legacy /rpc tunnel on the v1 port, even with a valid signature', async () => {
    const counters = { invoked: 0 };
    const { api, identity, device } = await setup(counters);
    const { signRequest } = await import('../src/net/device-auth.js');
    const body = JSON.stringify({ method: 'sale.create', args: [{ total: 500 }] });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      ...signRequest(device.privateKeyPem, { method: 'POST', path: '/rpc', body, deviceId: device.deviceId }),
    };
    const status = await new Promise<number>((resolve) => {
      const https = httpsModule;
      const req = https.request(
        { host: '127.0.0.1', port: api.port, path: '/rpc', method: 'POST', headers, ca: identity.certPem },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', () => resolve(0));
      req.write(body);
      req.end();
    });
    expect(status).toBe(404);
    expect(counters.invoked).toBe(0);
  });
});
