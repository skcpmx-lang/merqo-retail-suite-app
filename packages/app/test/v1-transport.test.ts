/**
 * Milestone D — Client terminal transport over `/api/v1` (real TLS + real SQLite).
 */
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  DeviceKeyStore,
  appendEvent,
  approveDevice,
  createDeviceSession,
  createPairingToken,
  getStoreIdentity,
  initializeApp,
  loadOrCreateServerIdentity,
  openDatabase,
  revokeDevice,
  revokeDeviceSession,
  signRequest,
  type Sealer,
  type Db,
  type LanApi,
} from '@sauda/core';
import { OfflineError, V1Terminal, isWriteMethod } from '../electron/v1-transport.js';
import { closeTrackedDatabases, openTrackedDatabase, removeTempDirs } from '../../../test-setup/temp-resources.js';

vi.setConfig({ testTimeout: 40_000 });

const dirs: string[] = [];
const apis: LanApi[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-transport-'));
  dirs.push(dir);
  return dir;
}

/** Test sealer: reversible, obviously not encryption — it only proves the envelope. */
const testSealer: Sealer = {
  kind: 'test-sealer',
  seal: (plain) => Buffer.from(plain.toString('base64')),
  unseal: (sealed) => Buffer.from(sealed.toString('utf8'), 'base64'),
};

interface Host {
  db: Db;
  dir: string;
  certPem: string;
  fingerprint: string;
  storeId: string;
  port: number;
  api: LanApi;
  invocations: string[];
  serverId: string;
}

async function startHost(opts: { dir?: string; port?: number } = {}): Promise<Host> {
  const dir = opts.dir ?? tempDir();
  const db = openTrackedDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
  initializeApp(db, {
    businessName: 'ট্রান্সপোর্ট স্টোর',
    businessAddress: 'ঢাকা',
    businessPhone: '01700000000',
    adminFullName: 'মালিক',
    adminUsername: 'owner',
    adminPassword: 'owner123',
  });
  const store = getStoreIdentity(db);
  db.prepare(
    `INSERT INTO device_licenses (license_id, store_id, device_id, role, capacity, edition, issued_at, expires_at, status, payload, registered_at)
     VALUES ('LIC-SERVER','?','DEV-SERVER','SERVER_POS',3,'standard',?,NULL,'active','{}',?)`.replace("'?'", '?'),
  ).run(store.store_id, new Date().toISOString(), new Date().toISOString());

  const identity = loadOrCreateServerIdentity({ dir: path.join(dir, 'tls'), allowCreate: true, ips: [] });
  const invocations: string[] = [];
  const api = await startApiOn(db, store, identity, opts.port ?? 0, invocations);
  return {
    db,
    dir,
    certPem: identity.certPem,
    fingerprint: identity.fingerprint,
    storeId: store.store_id,
    serverId: store.server_id,
    port: api.port,
    api,
    invocations,
  };
}

async function startApiOn(
  db: Db,
  store: { store_id: string; server_id: string },
  identity: { certPem: string; keyPem: string; fingerprint: string },
  port: number,
  invocations: string[],
): Promise<LanApi> {
  const api = await startLanApiOn(db, store, identity, port, invocations);
  apis.push(api);
  return api;
}

let startLanApiOn: (
  db: Db,
  store: { store_id: string; server_id: string },
  identity: { certPem: string; keyPem: string; fingerprint: string },
  port: number,
  invocations: string[],
) => Promise<LanApi>;

// Imported lazily so the module-level helper above stays readable.
const core = await import('@sauda/core');
startLanApiOn = async (db, store, identity, port, invocations) =>
  core.startLanApi({
    port,
    tls: { certPem: identity.certPem, keyPem: identity.keyPem, fingerprint: identity.fingerprint },
    db,
    version: '1.1.4',
    storeId: () => store.store_id,
    serverId: () => store.server_id,
    licensedCapacity: () => 3,
    allowRemote: () => true,
    invoke: async (method, args) => {
      invocations.push(method);
      return { ok: true, data: { method, args } };
    },
    authenticate: async (username, password) => {
      if (username !== 'owner' || password !== 'owner123') return null;
      return { id: 1, username: 'owner', full_name: 'মালিক', role: 'admin', permissions: ['pos.sell', 'settings.manage', 'report.view'] };
    },
    ssePollMs: 20,
    sseHeartbeatMs: 100,
  });

/** Raw signed RPC call (not through the client) to prove host-side session revocation. */
async function rawRpc(
  host: Host,
  clientDir: string,
  deviceId: string,
  session: string,
  method: string,
): Promise<{ status: number; body: { ok: boolean; code?: string } }> {
  const record = clientStore(clientDir).load();
  const body = JSON.stringify({ method, args: [] });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    'x-sauda-session': session,
    ...signRequest(record.private_key_pem, { method: 'POST', path: '/api/v1/rpc', body, deviceId }),
  };
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port: host.port, path: '/api/v1/rpc', method: 'POST', headers, ca: host.certPem },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function clientStore(dir: string): DeviceKeyStore {
  return new DeviceKeyStore({ dir, sealer: testSealer });
}

async function pairTerminal(host: Host, opts: { deviceName?: string; storeId?: string } = {}) {
  const code = createPairingToken(host.db).code;
  const clientDir = tempDir();
  const terminal = new V1Terminal({
    store: clientStore(clientDir),
    baseUrl: `https://127.0.0.1:${host.port}`,
    fingerprint: host.fingerprint,
    serverCertPem: host.certPem,
    deviceName: opts.deviceName ?? 'কাউন্টার ২',
    timeoutMs: 6000,
  });
  const outcome = await terminal.pair(
    {
      code,
      licence: { license_id: `LIC-${Math.random().toString(16).slice(2)}`, store_id: opts.storeId ?? host.storeId, capacity: 3 },
    },
    host.certPem,
  );
  return { terminal, clientDir, outcome };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterAll(async () => {
  for (const api of apis) await api.stop().catch(() => undefined);
  closeTrackedDatabases();
  removeTempDirs(dirs);
});

describe('device enrolment over /api/v1', () => {
  it('registers a pending device and needs an administrator approval', async () => {
    const host = await startHost();
    const { terminal, outcome } = await pairTerminal(host);
    expect(outcome.status).toBe('pending');

    const row = host.db.prepare('SELECT status FROM terminals WHERE device_id = ?').get(outcome.deviceId) as { status: string };
    expect(row.status).toBe('pending');

    // A valid licence is present, yet the device is still blocked until approved.
    expect((await terminal.status()).status).toBe('pending');
    await expect(terminal.login('owner', 'owner123')).rejects.toThrow();
  });

  it('works once the administrator approves it', async () => {
    const host = await startHost();
    const { terminal, outcome } = await pairTerminal(host);
    approveDevice(host.db, outcome.deviceId, { id: 1, username: 'owner' }, 'কাউন্টার ২ অনুমোদিত');

    expect((await terminal.status()).status).toBe('approved');
    const user = await terminal.login('owner', 'owner123');
    expect(user.username).toBe('owner');
    const result = await terminal.invoke<{ method: string }>('products.list', [{}]);
    expect(result.method).toBe('products.list');
    expect(host.invocations).toEqual(['products.list']);
  });

  it('refuses a pairing code with another shop licence and leaves no credential', async () => {
    const host = await startHost();
    const code = createPairingToken(host.db).code;
    const clientDir = tempDir();
    const store = clientStore(clientDir);
    const terminal = new V1Terminal({
      store,
      baseUrl: `https://127.0.0.1:${host.port}`,
      fingerprint: host.fingerprint,
      serverCertPem: host.certPem,
      timeoutMs: 6000,
    });
    await expect(
      terminal.pair(
        { code, licence: { license_id: 'LIC-OTHER', store_id: 'STORE-OTHER', capacity: 3 } },
        host.certPem,
      ),
    ).rejects.toThrow();
    expect(store.exists()).toBe(false);
    expect(host.db.prepare('SELECT COUNT(*) AS n FROM terminals').get()).toEqual({ n: 0 });
  });

  it('keeps the credential sealed on disk and reusable after a restart', async () => {
    const host = await startHost();
    const { terminal, clientDir, outcome } = await pairTerminal(host);
    approveDevice(host.db, outcome.deviceId, { id: 1, username: 'owner' });
    await terminal.login('owner', 'owner123');
    await terminal.invoke('products.list', []);

    const raw = fs.readFileSync(path.join(clientDir, 'device.key'), 'utf8');
    expect(raw).not.toContain('PRIVATE KEY');
    expect(raw).not.toContain('BEGIN');

    // A fresh process (new transport, same profile) keeps working without re-pairing.
    const restarted = new V1Terminal({
      store: clientStore(clientDir),
      baseUrl: `https://127.0.0.1:${host.port}`,
      fingerprint: host.fingerprint,
      serverCertPem: host.certPem,
      timeoutMs: 6000,
    });
    expect(restarted.paired).toBe(true);
    expect((await restarted.status()).status).toBe('approved');
    await restarted.login('owner', 'owner123');
    expect((await restarted.invoke<{ method: string }>('products.list', [])).method).toBe('products.list');
  });

  it('reports revocation and denies everything afterwards', async () => {
    const host = await startHost();
    const { terminal, outcome } = await pairTerminal(host);
    approveDevice(host.db, outcome.deviceId, { id: 1, username: 'owner' });
    await terminal.login('owner', 'owner123');
    await terminal.invoke('products.list', []);

    revokeDevice(host.db, outcome.deviceId, { id: 1, username: 'owner' }, 'হারিয়ে গেছে');

    expect((await terminal.status()).status).toBe('revoked');
    await expect(terminal.invoke('products.list', [])).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
    const before = host.invocations.length;
    await terminal.invoke('sale.create', [{}]).catch(() => undefined);
    expect(host.invocations.length).toBe(before);
  });

  it('refuses a revoked session while the device stays paired', async () => {
    const host = await startHost();
    const { terminal, clientDir, outcome } = await pairTerminal(host);
    approveDevice(host.db, outcome.deviceId, { id: 1, username: 'owner' });
    await terminal.login('owner', 'owner123');

    // A second session for the same device, then revoked while the device is approved.
    const token = createDeviceSession(host.db, { deviceId: outcome.deviceId, userId: 1 });
    revokeDeviceSession(host.db, token);

    const before = host.invocations.length;
    const res = await rawRpc(host, clientDir, outcome.deviceId, token, 'products.list');
    expect(res.status).toBe(401);
    expect(['SESSION_REVOKED', 'AUTH_REQUIRED']).toContain(res.body.code);
    // Nothing ran on the host for the revoked session.
    expect(host.invocations.length).toBe(before);
    // The device itself is still approved — only that session died.
    expect((await terminal.status()).status).not.toBe('revoked');
  });
});

describe('offline behaviour', () => {
  it('never commits a write while the Main PC is unreachable', async () => {
    const host = await startHost();
    const { terminal, outcome } = await pairTerminal(host);
    approveDevice(host.db, outcome.deviceId, { id: 1, username: 'owner' });
    await terminal.login('owner', 'owner123');
    await host.api.stop();

    const before = host.invocations.length;
    const attempt = terminal.invoke('sale.create', [{ total: 500 }]);
    await expect(attempt).rejects.toBeInstanceOf(OfflineError);
    expect(host.invocations.length).toBe(before);
    const sales = host.db.prepare("SELECT COUNT(*) AS n FROM sales").get() as { n: number };
    expect(sales.n).toBe(0);
    expect((await terminal.status()).status).toBe('offline');
  });

  it('treats every business write as a write and reads as reads', () => {
    for (const method of ['sale.create', 'payment.record', 'inventory.adjust', 'stock.transfer', 'customer.update']) {
      expect(isWriteMethod(method)).toBe(true);
    }
    for (const method of ['products.list', 'reports.salesSummary', 'device.self', 'server.info']) {
      expect(isWriteMethod(method)).toBe(false);
    }
  });
});

describe('idempotent writes', () => {
  it('replays a repeated key instead of duplicating the operation', async () => {
    const host = await startHost();
    const { terminal, outcome } = await pairTerminal(host);
    approveDevice(host.db, outcome.deviceId, { id: 1, username: 'owner' });
    await terminal.login('owner', 'owner123');

    const first = await terminal.invoke<{ method: string }>('sale.create', [{ total: 500 }], { idempotencyKey: 'K-1' });
    const second = await terminal.invoke<{ method: string }>('sale.create', [{ total: 500 }], { idempotencyKey: 'K-1' });
    expect(second).toEqual(first);
    expect(host.invocations.filter((m) => m === 'sale.create')).toHaveLength(1);

    // A different key is a different operation.
    await terminal.invoke('sale.create', [{ total: 700 }], { idempotencyKey: 'K-2' });
    expect(host.invocations.filter((m) => m === 'sale.create')).toHaveLength(2);
  });
});

describe('event stream through the transport', () => {
  it('delivers events and resumes after a server restart without duplicates', async () => {
    const host = await startHost();
    const { terminal, outcome } = await pairTerminal(host);
    approveDevice(host.db, outcome.deviceId, { id: 1, username: 'owner' });
    await terminal.login('owner', 'owner123');

    const seen: Array<{ id: number; type: string }> = [];
    terminal.openEvents({
      onEvent: (event) => seen.push({ id: event.id, type: event.type }),
      onState: () => undefined,
    });
    await vi.waitFor(() => expect(host.api.streamCount()).toBe(1), { timeout: 5000 });

    appendEvent(host.db, { storeId: host.storeId, type: 'sale.created', payload: { total: 1 } });
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5000 });
    const resumeFrom = seen[0]!.id;

    // Main PC goes down; a sale is written while the terminal is disconnected.
    await host.api.stop();
    appendEvent(host.db, { storeId: host.storeId, type: 'sale.created', payload: { total: 2 } });

    // Same host, same port, same identity: the terminal's own retry loop reconnects,
    // resumes from the last id it saw, and catches up on the sale written while down.
    await startLanApiOn(
      host.db,
      { store_id: host.storeId, server_id: host.serverId },
      {
        certPem: host.certPem,
        keyPem: fs.readFileSync(path.join(host.dir, 'tls', 'server.key'), 'utf8'),
        fingerprint: host.fingerprint,
      },
      host.port,
      host.invocations,
    );
    await vi.waitFor(() => expect(seen.length).toBe(2), { timeout: 20000 });
    await sleep(300);
    const ids = seen.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([resumeFrom, seen[1]!.id]);
  });
});
