/**
 * Milestone C — authenticated server-sent events.
 *
 * Negative first: an unsigned stream, a sessionless stream, a session issued to a
 * different device, a revoked device, another store's events, and a revocation that
 * happens while the stream is open. Only then the happy paths, including resume and
 * gap detection across a real server restart.
 */
import crypto from 'node:crypto';
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
  loadOrCreateServerIdentity,
  openEventStreamClient,
  openDatabase,
  revokeDevice,
  signRequest,
  startLanApi,
  type LanApi,
} from '../src/index.js';
import { generateDeviceKeyPair } from '../src/net/device-auth.js';
import { closeTrackedDatabases, openTrackedDatabase, removeTempDirs } from '../../../test-setup/temp-resources.js';

vi.setConfig({ testTimeout: 60_000 });

const dirs: string[] = [];
const apis: LanApi[] = [];
const handles: Array<{ close: () => void }> = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-sse-'));
  dirs.push(dir);
  return dir;
}

function freshDb(dir: string) {
  const db = openTrackedDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
  initializeApp(db, {
    businessName: 'ইভেন্ট স্টোর',
    businessAddress: 'ঢাকা',
    businessPhone: '01700000000',
    adminFullName: 'মালিক',
    adminUsername: 'owner',
    adminPassword: 'owner123',
  });
  return db;
}

type Bot = ReturnType<typeof freshDb>;

function addDevice(db: Bot, deviceId: string, status = 'approved', storeId?: string) {
  const keys = generateDeviceKeyPair();
  const store = getStoreIdentity(db);
  db.prepare(
    `INSERT INTO terminals (device_id, device_name, role, store_id, license_id, status, public_key, requested_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(deviceId, deviceId, 'CLIENT_POS', storeId ?? store.store_id, `LIC-${deviceId}`, status, keys.publicKeySpkiB64, new Date().toISOString());
  return { ...keys, deviceId };
}

function session(db: Bot, deviceId: string): string {
  return createDeviceSession(db, { deviceId, userId: 1 });
}

async function startApi(dir: string, db: Bot, port = 0): Promise<{ api: LanApi; certPem: string }> {
  const identity = loadOrCreateServerIdentity({ dir: path.join(dir, 'tls'), allowCreate: true, ips: [] });
  const store = getStoreIdentity(db);
  const api = await startLanApi({
    port,
    tls: { certPem: identity.certPem, keyPem: identity.keyPem, fingerprint: identity.fingerprint },
    db,
    version: '1.1.4',
    storeId: () => store.store_id,
    serverId: () => store.server_id,
    licensedCapacity: () => 10,
    invoke: async (method) => ({ ok: true, data: method }),
    authenticate: async (username) => ({ id: 1, username, full_name: 'মালিক', role: 'admin', permissions: ['report.view'] }),
    allowRemote: () => true,
    ssePollMs: 25,
    sseHeartbeatMs: 40,
  });
  apis.push(api);
  return { api, certPem: identity.certPem };
}

/** Raw SSE consumer that records events and records how the server ended it. */
function openStream(
  api: LanApi,
  certPem: string,
  opts: { device: { deviceId: string; privateKeyPem: string }; session?: string; lastEventId?: number; unsigned?: boolean },
) {
  const events: Array<{ id: number; type: string; data: string }> = [];
  let buffer = '';
  let ended: (reason: string) => void;
  const closed = new Promise<string>((resolve) => {
    ended = resolve;
  });
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (!opts.unsigned) {
    Object.assign(
      headers,
      signRequest(opts.device.privateKeyPem, { method: 'GET', path: '/api/v1/events', body: '', deviceId: opts.device.deviceId }),
    );
  }
  if (opts.session) headers['x-sauda-session'] = opts.session;
  if (opts.lastEventId) headers['last-event-id'] = String(opts.lastEventId);

  const req = https.request(
    { host: '127.0.0.1', port: api.port, path: '/api/v1/events', method: 'GET', headers, ca: certPem },
    (res) => {
      if (res.statusCode !== 200) {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          events.push({ id: 0, type: 'http-error', data: Buffer.concat(chunks).toString('utf8') });
          ended(`http-${res.statusCode}`);
        });
        return;
      }
      res.setEncoding('utf8');
      let currentId = 0;
      let currentType = 'message';
      let data: string[] = [];
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');
          if (line === '') {
            if (data.length) {
              const payload = data.join('\n');
              if (currentType === 'closed') ended(`closed:${payload}`);
              else events.push({ id: currentId, type: currentType, data: payload });
            }
            currentId = 0;
            currentType = 'message';
            data = [];
            continue;
          }
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'id') currentId = Number(value) || 0;
          else if (field === 'event') currentType = value;
          else if (field === 'data') data.push(value);
        }
      });
      res.on('end', () => ended('end'));
    },
  );
  req.on('error', () => ended('error'));
  req.end();
  const handle = { close: () => req.destroy(), events, closed };
  handles.push(handle);
  return handle;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait budget for CI.
 *
 * These suites use real sockets, timers and a shared Windows runner, so a condition that takes
 * milliseconds on an idle machine can take seconds under load. A 4 s cap produced a flaky
 * `windows-latest` failure (PR run 41908435678, "closes every stream when the server stops") on code
 * that had just passed on the same commit. The wait is still bounded and the error still names what
 * timed out, so a genuine hang fails instead of hanging.
 */
const WAIT_BUDGET_MS = 20_000;

async function waitFor(check: () => boolean, label = 'the condition', timeoutMs = WAIT_BUDGET_MS): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for: ${label}`);
    }
    await sleep(20);
  }
}

/** Awaits a promise but fails with a clear message instead of blocking until the test timeout. */
async function within<T>(promise: Promise<T>, label: string, timeoutMs = WAIT_BUDGET_MS): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms waiting for: ${label}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer!);
  }
}

afterAll(async () => {
  for (const h of handles) h.close();
  for (const api of apis) await api.stop().catch(() => undefined);
  closeTrackedDatabases();
  removeTempDirs(dirs);
});

describe('event stream authorisation', () => {
  it('rejects a stream request with no device signature', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-S1');
    const { api, certPem } = await startApi(dir, db);
    const stream = openStream(api, certPem, { device, session: session(db, device.deviceId), unsigned: true });
    await waitFor(() => stream.events.length > 0);
    expect(stream.events[0]!.data).toContain('MISSING_SIGNATURE');
    expect(api.streamCount()).toBe(0);
  });

  it('rejects an approved device without a session', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-S2');
    const { api, certPem } = await startApi(dir, db);
    const stream = openStream(api, certPem, { device });
    await waitFor(() => stream.events.length > 0);
    expect(stream.events[0]!.data).toContain('AUTH_REQUIRED');
    expect(api.streamCount()).toBe(0);
  });

  it('rejects a session that belongs to another device', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const a = addDevice(db, 'DEV-S3');
    const b = addDevice(db, 'DEV-S4');
    const { api, certPem } = await startApi(dir, db);
    const stream = openStream(api, certPem, { device: a, session: session(db, b.deviceId) });
    await waitFor(() => stream.events.length > 0);
    expect(stream.events[0]!.data).toContain('SESSION_DEVICE_MISMATCH');
    expect(api.streamCount()).toBe(0);
  });

  it('rejects a revoked device before the stream opens', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-S5');
    const token = session(db, device.deviceId);
    revokeDevice(db, device.deviceId, { userId: 1, label: 'admin' } as never, 'test');
    const { api, certPem } = await startApi(dir, db);
    const stream = openStream(api, certPem, { device, session: token });
    await waitFor(() => stream.events.length > 0);
    expect(stream.events[0]!.data).toContain('DEVICE_REVOKED');
    expect(api.streamCount()).toBe(0);
  });
});

describe('event delivery', () => {
  it('delivers new events in order with monotonic sequence ids', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-S6');
    const token = session(db, device.deviceId);
    const { api, certPem } = await startApi(dir, db);
    const stream = openStream(api, certPem, { device, session: token });
    await waitFor(() => api.streamCount() === 1);

    const store = getStoreIdentity(db).store_id;
    const first = appendEvent(db, { storeId: store, type: 'sale.created', payload: { n: 1 } });
    const second = appendEvent(db, { storeId: store, type: 'inventory.updated', payload: { n: 2 } });
    await waitFor(() => stream.events.length >= 2);
    expect(stream.events.map((e) => e.id)).toEqual([first.seq, second.seq]);
    expect(stream.events.map((e) => e.type)).toEqual(['sale.created', 'inventory.updated']);
  });

  it('never delivers another store\'s event', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-S7');
    const token = session(db, device.deviceId);
    const { api, certPem } = await startApi(dir, db);
    const stream = openStream(api, certPem, { device, session: token });
    await waitFor(() => api.streamCount() === 1);

    appendEvent(db, { storeId: 'STORE-SOMEONE-ELSE', type: 'sale.created', payload: { secret: 'other shop' } });
    appendEvent(db, { storeId: getStoreIdentity(db).store_id, type: 'sale.created', payload: { n: 1 } });
    await waitFor(() => stream.events.length >= 1);
    await sleep(100);
    expect(stream.events.every((e) => !e.data.includes('other shop'))).toBe(true);
    expect(stream.events).toHaveLength(1);
  });

  it('resumes from Last-Event-ID without duplicates', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-S8');
    const token = session(db, device.deviceId);
    const store = getStoreIdentity(db).store_id;
    const first = appendEvent(db, { storeId: store, type: 'sale.created', payload: { n: 1 } });
    appendEvent(db, { storeId: store, type: 'sale.created', payload: { n: 2 } });
    appendEvent(db, { storeId: store, type: 'sale.created', payload: { n: 3 } });

    const { api, certPem } = await startApi(dir, db);
    const stream = openStream(api, certPem, { device, session: token, lastEventId: first.seq });
    await waitFor(() => stream.events.length >= 2);
    await sleep(80);
    expect(stream.events.map((e) => e.id)).toEqual([first.seq + 1, first.seq + 2]);
    expect(new Set(stream.events.map((e) => e.id)).size).toBe(2);
  });

  it('terminates an open stream when the device is revoked', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-S9');
    const token = session(db, device.deviceId);
    const { api, certPem } = await startApi(dir, db);
    const stream = openStream(api, certPem, { device, session: token });
    await waitFor(() => api.streamCount() === 1);

    revokeDevice(db, device.deviceId, { userId: 1, label: 'admin' } as never, 'stolen laptop');
    // The heartbeat/poll re-check closes it without any push channel.
    await waitFor(() => api.streamCount() === 0, 'the server drops the revoked stream');
    const reason = await within(stream.closed, 'the client is told the stream was revoked');
    expect(reason).toContain('revoked');
  });

  it('closes every stream when the server stops', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-S10');
    const token = session(db, device.deviceId);
    const { api, certPem } = await startApi(dir, db);
    const stream = openStream(api, certPem, { device, session: token });
    await waitFor(() => api.streamCount() === 1, 'the server sees the open stream');
    await api.stop();
    // Stopping the server must close the stream on both sides. Which side observes it first is a
    // race on a loaded runner, so wait for each with its own budget instead of assuming an order.
    const reason = await within(stream.closed, 'the client observes the closed stream');
    expect(reason).toBeTruthy();
    await waitFor(() => api.streamCount() === 0, 'the server drops the closed stream');
  });

  /**
   * R-06: `stop()` must be terminal. v1.1.4 emptied the hub with `closeAll()`, which left a window
   * in which an already-authenticated request could register a stream on the empty map — the socket
   * was destroyed, but the hub kept the stream and its two intervals. The unit contract lives in
   * `sse-shutdown-v115.test.ts`; this pins the wiring: the API really does begin a shutdown, and the
   * state it returns in is settled.
   */
  it('is settled after stop: nothing registers afterwards, and a racing second stop resolves', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-S12');
    const token = session(db, device.deviceId);
    const { api, certPem } = await startApi(dir, db);
    const stream = openStream(api, certPem, { device, session: token });
    await waitFor(() => api.streamCount() === 1, 'the server sees the open stream');

    await within(api.stop(), 'the first stop resolves');
    expect(api.streamCount()).toBe(0);
    await within(stream.closed, 'the client observes the closed stream');

    // `before-quit` can race an explicit stop; the second call must resolve rather than hang.
    await within(api.stop(), 'the second stop resolves');
    // A late request (the v1.1.4 race) must not register a stream on the stopped hub.
    const late = openStream(api, certPem, { device, session: token });
    await sleep(150);
    expect(api.streamCount()).toBe(0);
    await within(late.closed.catch(() => 'refused'), 'the late client gives up').catch(() => undefined);
  });
});

describe('event stream client', () => {
  it('refuses a non-HTTPS base URL instead of downgrading', () => {
    expect(() =>
      openEventStreamClient({
        baseUrl: 'http://127.0.0.1:9',
        tls: { caPem: '', fingerprint: '' },
        deviceId: 'DEV-X',
        privateKeyPem: '',
        session: 'x',
        onEvent: () => undefined,
      }),
    ).toThrowError(/HTTPS/);
  });

  it('resumes after a server restart and reports a gap it cannot fill', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-S11');
    const token = session(db, device.deviceId);
    const store = getStoreIdentity(db).store_id;
    const { api, certPem } = await startApi(dir, db);
    const identity = loadOrCreateServerIdentity({ dir: path.join(dir, 'tls'), allowCreate: false });

    const received: number[] = [];
    const gaps: Array<[number, number]> = [];
    const client = openEventStreamClient({
      baseUrl: `https://127.0.0.1:${api.port}`,
      tls: { caPem: certPem, fingerprint: identity.fingerprint },
      deviceId: device.deviceId,
      privateKeyPem: device.privateKeyPem,
      session: token,
      onEvent: (event) => received.push(event.id),
      onGap: (expected, got) => gaps.push([expected, got]),
      retryDelayMs: 50,
      maxRetries: 40,
    });
    handles.push(client);
    await waitFor(() => client.connected);

    const before = appendEvent(db, { storeId: store, type: 'sale.created', payload: { n: 1 } });
    await waitFor(() => received.includes(before.seq));

    // Server goes away and comes back on the same database/identity.
    await api.stop();
    appendEvent(db, { storeId: store, type: 'sale.created', payload: { n: 2 } });
    // Same port: the client reconnects to the address it was given.
    const restarted = await startApi(dir, db, api.port);

    // The client reconnects by itself and resumes from its last id — so it still
    // receives the event written while it was disconnected.
    await waitFor(() => received.length >= 2, 'two events are delivered after a reconnect', 20_000);
    expect(received[1]).toBe(before.seq + 1);
    expect(gaps).toHaveLength(0);
    await waitFor(() => restarted.api.streamCount() === 1, 'the restarted server accepts the stream', 20_000);
  }, 30_000);

  it('reports a gap when the sequence jumps', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-S12');
    const token = session(db, device.deviceId);
    const store = getStoreIdentity(db).store_id;
    const mine = appendEvent(db, { storeId: store, type: 'sale.created', payload: { n: 1 } });
    // An event that belongs to another store is never delivered to this device, so
    // the client's sequence jumps — it must be told, not left guessing.
    appendEvent(db, { storeId: 'STORE-OTHER', type: 'sale.created', payload: { other: true } });
    const after = appendEvent(db, { storeId: store, type: 'sale.created', payload: { n: 2 } });
    const { api, certPem } = await startApi(dir, db);
    const identity = loadOrCreateServerIdentity({ dir: path.join(dir, 'tls'), allowCreate: false });

    const gaps: Array<[number, number]> = [];
    const events: number[] = [];
    const client = openEventStreamClient({
      baseUrl: `https://127.0.0.1:${api.port}`,
      tls: { caPem: certPem, fingerprint: identity.fingerprint },
      deviceId: device.deviceId,
      privateKeyPem: device.privateKeyPem,
      session: token,
      lastEventId: mine.seq,
      onEvent: (event) => events.push(event.id),
      onGap: (expected, got) => gaps.push([expected, got]),
      retryDelayMs: 50,
      maxRetries: 5,
    });
    handles.push(client);
    await waitFor(() => events.length > 0);
    expect(events).toEqual([after.seq]);
    // The missing range is exactly the other store's event (seq 2).
    expect(gaps).toEqual([[mine.seq + 1, after.seq - 1]]);
  });
});
