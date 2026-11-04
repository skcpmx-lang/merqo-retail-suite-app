/**
 * Milestone D hardening — role visibility, reconnect budget, scheduled retention.
 */
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  appendEvent,
  createDeviceSession,
  getStoreIdentity,
  initializeApp,
  latestSeq,
  loadOrCreateServerIdentity,
  openDatabase,
  retentionFloor,
  signRequest,
  startEventRetention,
  startLanApi,
  type LanApi,
} from '../src/index.js';
import { generateDeviceKeyPair } from '../src/net/device-auth.js';

vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
const apis: LanApi[] = [];
const sockets: Array<{ destroy: () => void }> = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-vis-'));
  dirs.push(dir);
  return dir;
}

type Bot = ReturnType<typeof openDatabase>;

function freshDb(dir: string): Bot {
  const db = openDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
  initializeApp(db, {
    businessName: 'ভিজিবিলিটি স্টোর',
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

/** Creates a user with the given permissions and returns its id. */
function addUser(db: Bot, username: string, permissions: string[]): number {
  const info = db
    .prepare(
      `INSERT INTO users (username, full_name, role, password_hash, password_salt, permissions, is_active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,1,?,?)`,
    )
    .run(
      username,
      username,
      'cashier',
      'x',
      'y',
      JSON.stringify(permissions),
      new Date().toISOString(),
      new Date().toISOString(),
    );
  return Number(info.lastInsertRowid);
}

async function startApi(dir: string, db: Bot, opts: { maxOpensPerMinute?: number } = {}) {
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
    authenticate: async (username) => ({ id: 1, username, full_name: 'x', role: 'cashier', permissions: [] }),
    allowRemote: () => true,
    ssePollMs: 15,
    sseHeartbeatMs: 60,
    sseMaxStreams: opts.maxOpensPerMinute ? 50 : undefined,
    sseMaxOpensPerMinute: opts.maxOpensPerMinute,
  });
  apis.push(api);
  return { api, certPem: identity.certPem };
}

interface Probe {
  events: Array<{ id: number; type: string; data: string }>;
  destroy: () => void;
}

function openStream(
  api: LanApi,
  certPem: string,
  opts: { device: { deviceId: string; privateKeyPem: string }; session: string; lastEventId?: number },
): Probe {
  const events: Array<{ id: number; type: string; data: string }> = [];
  let buffer = '';
  const headers: Record<string, string> = {
    accept: 'text/event-stream',
    'x-sauda-session': opts.session,
    ...signRequest(opts.device.privateKeyPem, {
      method: 'GET',
      path: '/api/v1/events',
      body: '',
      deviceId: opts.device.deviceId,
    }),
  };
  if (opts.lastEventId !== undefined) headers['last-event-id'] = String(opts.lastEventId);
  const req = https.request(
    { host: '127.0.0.1', port: api.port, path: '/api/v1/events', method: 'GET', headers, ca: certPem },
    (res) => {
      res.setEncoding('utf8');
      let id = 0;
      let type = 'message';
      let data: string[] = [];
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');
          if (line === '') {
            if (data.length && type !== 'closed') events.push({ id, type, data: data.join('\n') });
            id = 0;
            type = 'message';
            data = [];
            continue;
          }
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'id') id = Number(value) || 0;
          else if (field === 'event') type = value;
          else if (field === 'data') data.push(value);
        }
      });
    },
  );
  req.on('error', () => undefined);
  req.end();
  const handle = { events, destroy: () => req.destroy() };
  sockets.push(handle);
  return handle;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, timeoutMs = 6000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await sleep(15);
  }
}

afterAll(async () => {
  for (const s of sockets) s.destroy();
  for (const api of apis) await api.stop().catch(() => undefined);
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('role-based event visibility', () => {
  it('withholds financial and licence events from a cashier session', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-V1');
    const cashier = addUser(db, 'cashier1', ['pos.sell']);
    const token = createDeviceSession(db, { deviceId: device.deviceId, userId: cashier });
    const store = getStoreIdentity(db).store_id;
    const { api, certPem } = await startApi(dir, db);
    const probe = openStream(api, certPem, { device, session: token });
    await waitFor(() => api.streamCount() === 1);

    appendEvent(db, { storeId: store, type: 'sale.created', payload: { total: 500 } });
    appendEvent(db, { storeId: store, type: 'accounting.entry_posted', payload: { profit: 9999, cost: 4321 } });
    appendEvent(db, { storeId: store, type: 'license.status_changed', payload: { license: 'secret-payload' } });
    appendEvent(db, { storeId: store, type: 'inventory.updated', payload: { qty: 3 } });

    await waitFor(() => probe.events.length >= 2);
    await sleep(150);
    const types = probe.events.map((e) => e.type);
    expect(types).toContain('sale.created');
    expect(types).toContain('inventory.updated');
    expect(types).not.toContain('accounting.entry_posted');
    expect(types).not.toContain('license.status_changed');
    const dump = JSON.stringify(probe.events);
    expect(dump).not.toContain('9999');
    expect(dump).not.toContain('secret-payload');
  });

  it('gives a manager with settings.manage full visibility', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-V2');
    const manager = addUser(db, 'manager1', ['pos.sell', 'settings.manage']);
    const token = createDeviceSession(db, { deviceId: device.deviceId, userId: manager });
    const store = getStoreIdentity(db).store_id;
    const { api, certPem } = await startApi(dir, db);
    const probe = openStream(api, certPem, { device, session: token });
    await waitFor(() => api.streamCount() === 1);

    appendEvent(db, { storeId: store, type: 'accounting.entry_posted', payload: { profit: 1 } });
    appendEvent(db, { storeId: store, type: 'license.status_changed', payload: { ok: true } });
    await waitFor(() => probe.events.length >= 2);
    expect(probe.events.map((e) => e.type)).toEqual(['accounting.entry_posted', 'license.status_changed']);
  });
});

describe('reconnect budget', () => {
  it('refuses excessive reconnects from one device', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-V3');
    const user = addUser(db, 'cashier2', ['pos.sell']);
    const token = createDeviceSession(db, { deviceId: device.deviceId, userId: user });
    const { api, certPem } = await startApi(dir, db, { maxOpensPerMinute: 2 });

    for (let i = 0; i < 2; i += 1) {
      const probe = openStream(api, certPem, { device, session: token });
      await waitFor(() => api.streamCount() === 1);
      probe.destroy();
      await waitFor(() => api.streamCount() === 0);
    }
    // Third attempt inside the same minute is refused with 429.
    const denied = await new Promise<number>((resolve) => {
      const headers: Record<string, string> = {
        accept: 'text/event-stream',
        'x-sauda-session': token,
        ...signRequest(device.privateKeyPem, { method: 'GET', path: '/api/v1/events', body: '', deviceId: device.deviceId }),
      };
      const req = https.request(
        { host: '127.0.0.1', port: api.port, path: '/api/v1/events', method: 'GET', headers, ca: certPem },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', () => resolve(0));
      req.end();
    });
    expect(denied).toBe(429);
    expect(api.streamCount()).toBe(0);
  });

  it('keeps the budget per device', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const a = addDevice(db, 'DEV-V4');
    const b = addDevice(db, 'DEV-V5');
    const user = addUser(db, 'cashier3', ['pos.sell']);
    const tokenA = createDeviceSession(db, { deviceId: a.deviceId, userId: user });
    const tokenB = createDeviceSession(db, { deviceId: b.deviceId, userId: user });
    const { api, certPem } = await startApi(dir, db, { maxOpensPerMinute: 1 });

    openStream(api, certPem, { device: a, session: tokenA });
    await waitFor(() => api.streamCount() === 1);
    // A different PC is unaffected by the first one's churn.
    openStream(api, certPem, { device: b, session: tokenB });
    await waitFor(() => api.streamCount() === 2);
  });
});

describe('scheduled retention', () => {
  it('prunes on demand, records the floor and refuses to run inside a transaction', () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const store = getStoreIdentity(db).store_id;
    for (let i = 0; i < 8; i += 1) appendEvent(db, { storeId: store, type: 'sale.created', payload: { i } });

    // The scheduler prunes once at startup, then on its interval.
    const handle = startEventRetention(db, { intervalMs: 60_000, olderThanMs: -1000, keepLatest: 3 });
    expect(retentionFloor(db)).toBe(5);
    expect(latestSeq(db)).toBe(8);
    const again = handle.runOnce();
    expect(again.deleted).toBe(0);
    expect(again.floor).toBe(5);

    // Inside a caller transaction the tick is skipped, never nested.
    const skipped = db.transaction(() => handle.runOnce())();
    expect(skipped.deleted).toBe(0);
    expect(db.inTransaction).toBe(false);

    handle.stop();
    expect(handle.running).toBe(false);
    db.close();
  });

  it('survives a failing tick and keeps the timer alive', () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const logs: string[] = [];
    const handle = startEventRetention(db, {
      intervalMs: 60_000,
      log: (_level, message) => logs.push(message),
    });
    db.close(); // simulate a database that went away
    const result = handle.runOnce();
    expect(result.deleted).toBe(0);
    expect(logs).toContain('event retention tick failed');
    handle.stop();
  });
});
