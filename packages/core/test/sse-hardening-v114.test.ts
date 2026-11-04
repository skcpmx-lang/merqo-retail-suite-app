/**
 * SSE hardening — resume edge cases, truncation, session expiry, limits, slow clients.
 *
 * Real TLS listener, real SQLite outbox, real sessions with short TTLs. Negative cases
 * come first: a stream must fail closed and say why.
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
  openDatabase,
  pruneEventsByAge,
  revokeDevice,
  revokeDeviceSession,
  signRequest,
  startLanApi,
  type LanApi,
} from '../src/index.js';
import { generateDeviceKeyPair } from '../src/net/device-auth.js';
import { closeTrackedDatabases, openTrackedDatabase, removeTempDirs } from '../../../test-setup/temp-resources.js';

vi.setConfig({ testTimeout: 60_000 });

const dirs: string[] = [];
const apis: LanApi[] = [];
const sockets: Array<{ destroy: () => void }> = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-sseh-'));
  dirs.push(dir);
  return dir;
}

type Bot = ReturnType<typeof openDatabase>;

function freshDb(dir: string): Bot {
  const db = openTrackedDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
  initializeApp(db, {
    businessName: 'হার্ডেনিং স্টোর',
    businessAddress: 'ঢাকা',
    businessPhone: '01700000000',
    adminFullName: 'মালিক',
    adminUsername: 'owner',
    adminPassword: 'owner123',
  });
  return db;
}

function addDevice(db: Bot, deviceId: string, status = 'approved') {
  const keys = generateDeviceKeyPair();
  const store = getStoreIdentity(db);
  db.prepare(
    `INSERT INTO terminals (device_id, device_name, role, store_id, license_id, status, public_key, requested_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(deviceId, deviceId, 'CLIENT_POS', store.store_id, `LIC-${deviceId}`, status, keys.publicKeySpkiB64, new Date().toISOString());
  return { ...keys, deviceId };
}

async function startApi(
  dir: string,
  db: Bot,
  opts: { maxStreams?: number; maxBufferedBytes?: number; onLog?: (message: string, detail?: unknown) => void } = {},
): Promise<{ api: LanApi; certPem: string }> {
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
    ssePollMs: 15,
    sseHeartbeatMs: 60,
    sseMaxStreams: opts.maxStreams,
    sseMaxBufferedBytes: opts.maxBufferedBytes,
    log: opts.onLog ? (level, message, detail) => opts.onLog!(message, detail) : undefined,
  });
  apis.push(api);
  return { api, certPem: identity.certPem };
}

interface StreamProbe {
  events: Array<{ id: number; type: string; data: string }>;
  closed: Promise<string>;
  destroy: () => void;
}

function openStream(
  api: LanApi,
  certPem: string,
  opts: { device: { deviceId: string; privateKeyPem: string }; session?: string; lastEventId?: string | number; signed?: boolean },
): StreamProbe {
  const events: Array<{ id: number; type: string; data: string }> = [];
  let buffer = '';
  let finish: (reason: string) => void = () => undefined;
  const closed = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (opts.signed !== false) {
    Object.assign(
      headers,
      signRequest(opts.device.privateKeyPem, { method: 'GET', path: '/api/v1/events', body: '', deviceId: opts.device.deviceId }),
    );
  }
  if (opts.session) headers['x-sauda-session'] = opts.session;
  if (opts.lastEventId !== undefined) headers['last-event-id'] = String(opts.lastEventId);

  const req = https.request(
    { host: '127.0.0.1', port: api.port, path: '/api/v1/events', method: 'GET', headers, ca: certPem },
    (res) => {
      if (res.statusCode !== 200) {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          events.push({ id: 0, type: 'http-error', data: Buffer.concat(chunks).toString('utf8') });
          finish(`http-${res.statusCode}`);
        });
        return;
      }
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
            if (data.length) {
              const payload = data.join('\n');
              if (type === 'closed') finish(`closed:${payload}`);
              else events.push({ id, type, data: payload });
            }
            id = 0;
            type = 'message';
            data = [];
            continue;
          }
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'id') id = Number(value) || 0;
          else if (field === 'event') type = value;
          else if (field === 'data') data.push(value);
        }
      });
      res.on('end', () => finish('end'));
    },
  );
  req.on('error', () => finish('error'));
  req.end();
  const handle = { events, closed, destroy: () => req.destroy() };
  sockets.push(handle);
  return handle;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await sleep(15);
  }
}

afterAll(async () => {
  for (const s of sockets) s.destroy();
  for (const api of apis) await api.stop().catch(() => undefined);
  closeTrackedDatabases();
  removeTempDirs(dirs);
});

describe('session lifecycle', () => {
  it('refuses a session that has already expired', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-H1');
    const token = createDeviceSession(db, { deviceId: device.deviceId, userId: 1, ttlMs: 50 });
    await sleep(120);
    const { api, certPem } = await startApi(dir, db);
    const stream = openStream(api, certPem, { device, session: token });
    await waitFor(() => stream.events.length > 0);
    expect(stream.events[0]!.data).toContain('AUTH_REQUIRED');
    expect(api.streamCount()).toBe(0);
  });

  it('refuses a revoked session', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-H2');
    const token = createDeviceSession(db, { deviceId: device.deviceId, userId: 1 });
    revokeDeviceSession(db, token);
    const { api, certPem } = await startApi(dir, db);
    const stream = openStream(api, certPem, { device, session: token });
    await waitFor(() => stream.events.length > 0);
    expect(stream.events[0]!.data).toContain('AUTH_REQUIRED');
    expect(api.streamCount()).toBe(0);
  });

  it('closes an active stream when the session expires mid-stream', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-H3');
    const token = createDeviceSession(db, { deviceId: device.deviceId, userId: 1, ttlMs: 400 });
    const { api, certPem } = await startApi(dir, db);
    const stream = openStream(api, certPem, { device, session: token });
    await waitFor(() => api.streamCount() === 1);

    const reason = await stream.closed;
    expect(reason).toContain('session-expired');
    expect(api.streamCount()).toBe(0);
  });

  it('closes an active stream when the session is revoked mid-stream', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-H4');
    const token = createDeviceSession(db, { deviceId: device.deviceId, userId: 1 });
    const { api, certPem } = await startApi(dir, db);
    const stream = openStream(api, certPem, { device, session: token });
    await waitFor(() => api.streamCount() === 1);
    revokeDeviceSession(db, token);
    const reason = await stream.closed;
    expect(reason).toContain('session-expired');
  });
});

describe('resume edge cases', () => {
  function seed(db: Bot, count: number, payload: (i: number) => unknown = (i) => ({ n: i })) {
    const store = getStoreIdentity(db).store_id;
    return Array.from({ length: count }, (_, i) => appendEvent(db, { storeId: store, type: 'sale.created', payload: payload(i) }));
  }

  it('rejects a malformed Last-Event-ID instead of guessing', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-H5');
    const token = createDeviceSession(db, { deviceId: device.deviceId, userId: 1 });
    seed(db, 2);
    const { api, certPem } = await startApi(dir, db);

    for (const bad of ['abc', '-1', '1.5', '99999999999999999999']) {
      const stream = openStream(api, certPem, { device, session: token, lastEventId: bad });
      await waitFor(() => stream.events.length > 0);
      expect(stream.events[0]!.data).toContain('BAD_LAST_EVENT_ID');
    }
    expect(api.streamCount()).toBe(0);
  });

  it('treats a resume point beyond the newest event as "wait for new events"', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-H6');
    const token = createDeviceSession(db, { deviceId: device.deviceId, userId: 1 });
    const seeded = seed(db, 3);
    const { api, certPem } = await startApi(dir, db);
    const stream = openStream(api, certPem, { device, session: token, lastEventId: seeded.at(-1)!.seq + 10 });
    await waitFor(() => api.streamCount() === 1);
    await sleep(120);
    expect(stream.events).toHaveLength(0);
    // Events at or below the resume point are considered already delivered …
    seed(db, 3);
    await sleep(120);
    expect(stream.events).toHaveLength(0);
    // … and delivery resumes strictly above it.
    const beyond = seed(db, 10).filter((e) => e.seq > seeded.at(-1)!.seq + 10);
    expect(beyond.length).toBeGreaterThan(0);
    await waitFor(() => stream.events.length > 0);
    expect(stream.events[0]!.id).toBe(beyond[0]!.seq);
  });

  it('declares truncated history and resumes from the retained floor', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-H7');
    const token = createDeviceSession(db, { deviceId: device.deviceId, userId: 1 });
    const seeded = seed(db, 6);
    const pruned = pruneEventsByAge(db, { olderThanMs: -1000, keepLatest: 2, now: new Date() });
    expect(pruned.deleted).toBeGreaterThan(0);
    expect(pruned.floor).toBe(seeded[3]!.seq);

    const { api, certPem } = await startApi(dir, db);
    const stream = openStream(api, certPem, { device, session: token, lastEventId: 1 });
    await waitFor(() => stream.events.length > 0);
    const resync = stream.events.find((e) => e.type === 'resync');
    expect(resync).toBeTruthy();
    expect(JSON.parse(resync!.data)).toMatchObject({ reason: 'HISTORY_TRUNCATED', from: pruned.floor });
    await waitFor(() => stream.events.filter((e) => e.type === 'sale.created').length === 2);
    const ids = stream.events.filter((e) => e.type === 'sale.created').map((e) => e.id);
    expect(ids).toEqual([pruned.floor + 1, pruned.floor + 2]);
  });

  it('never sends the same sequence twice on one stream', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-H8');
    const token = createDeviceSession(db, { deviceId: device.deviceId, userId: 1 });
    const seeded = seed(db, 2);
    const { api, certPem } = await startApi(dir, db);
    const stream = openStream(api, certPem, { device, session: token, lastEventId: seeded[0]!.seq - 1 });
    await waitFor(() => stream.events.length === 2);
    await sleep(100);
    seed(db, 1);
    await waitFor(() => stream.events.length === 3);
    const ids = stream.events.map((e) => e.id);
    expect(ids).toEqual([...new Set(ids)]);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});

describe('outbox retention', () => {
  it('never removes the newest events and records the floor', () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const store = getStoreIdentity(db).store_id;
    for (let i = 0; i < 10; i += 1) appendEvent(db, { storeId: store, type: 'sale.created', payload: { i } });

    const pruned = pruneEventsByAge(db, { olderThanMs: -1000, keepLatest: 4, now: new Date() });
    expect(pruned.deleted).toBe(6);
    expect(pruned.floor).toBe(6);
    const remaining = db.prepare('SELECT COUNT(*) AS n, MIN(seq) AS low FROM event_outbox').get() as { n: number; low: number };
    expect(remaining.n).toBe(4);
    expect(remaining.low).toBe(7);
    // A second run has nothing left to do and must not move the floor backwards.
    const again = pruneEventsByAge(db, { olderThanMs: -1000, keepLatest: 4, now: new Date() });
    expect(again.deleted).toBe(0);
    expect(again.floor).toBe(6);
  });

  it('keeps recent events even when the cap would allow removing them', () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const store = getStoreIdentity(db).store_id;
    appendEvent(db, { storeId: store, type: 'sale.created', payload: { i: 0 } });
    // Everything is newer than the retention age, so nothing is deleted.
    const pruned = pruneEventsByAge(db, { olderThanMs: 24 * 60 * 60 * 1000, keepLatest: 0 });
    expect(pruned.deleted).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM event_outbox').get()).toEqual({ n: 1 });
  });
});

describe('bounded resources', () => {
  it('enforces the concurrent stream policy', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const a = addDevice(db, 'DEV-H9');
    const b = addDevice(db, 'DEV-H10');
    const c = addDevice(db, 'DEV-H11');
    const { api, certPem } = await startApi(dir, db, { maxStreams: 2 });
    const first = openStream(api, certPem, { device: a, session: createDeviceSession(db, { deviceId: a.deviceId, userId: 1 }) });
    const second = openStream(api, certPem, { device: b, session: createDeviceSession(db, { deviceId: b.deviceId, userId: 1 }) });
    await waitFor(() => api.streamCount() === 2);

    const third = openStream(api, certPem, { device: c, session: createDeviceSession(db, { deviceId: c.deviceId, userId: 1 }) });
    await waitFor(() => third.events.length > 0);
    expect(third.events[0]!.data).toContain('STREAM_LIMIT');
    expect(api.streamCount()).toBe(2);
    void first;
    void second;
  });

  it('replaces the previous stream when the same device reconnects', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-H12');
    const token = createDeviceSession(db, { deviceId: device.deviceId, userId: 1 });
    const { api, certPem } = await startApi(dir, db);
    const first = openStream(api, certPem, { device, session: token });
    await waitFor(() => api.streamCount() === 1);
    const second = openStream(api, certPem, { device, session: token });
    await waitFor(() => api.streamCount() === 1);
    const reason = await first.closed;
    expect(reason).toContain('replaced');
    // The replacement is alive and stays registered.
    expect(second.events).toHaveLength(0);
    await sleep(60);
    expect(api.streamCount()).toBe(1);
  });

  it('drops the registration when a client disconnects', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-H13');
    const token = createDeviceSession(db, { deviceId: device.deviceId, userId: 1 });
    const { api, certPem } = await startApi(dir, db);
    const stream = openStream(api, certPem, { device, session: token });
    await waitFor(() => api.streamCount() === 1);
    stream.destroy();
    await waitFor(() => api.streamCount() === 0);
  });

  it('closes a client that cannot keep up instead of buffering without bound', async () => {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-H14');
    const token = createDeviceSession(db, { deviceId: device.deviceId, userId: 1 });
    const logs: Array<{ message: string; detail?: unknown }> = [];
    const { api, certPem } = await startApi(dir, db, {
      maxBufferedBytes: 4096,
      onLog: (message, detail) => logs.push({ message, detail }),
    });

    // A socket that never reads: the server must give up rather than grow memory.
    const { rootCertificates } = await import('node:tls');
    void rootCertificates;
    const net = await import('node:net');
    const tlsMod = await import('node:tls');
    const socket = tlsMod.connect({ host: '127.0.0.1', port: api.port, ca: certPem, servername: 'localhost' });
    sockets.push({ destroy: () => socket.destroy() });
    const headers = {
      accept: 'text/event-stream',
      'x-sauda-session': token,
      ...signRequest(device.privateKeyPem, { method: 'GET', path: '/api/v1/events', body: '', deviceId: device.deviceId }),
    };
    const request =
      `GET /api/v1/events HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n` +
      Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n') +
      '\r\n\r\n';
    socket.on('secureConnect', () => {
      socket.write(request);
      // Stop reading immediately: everything the server sends piles up in its buffer.
      socket.pause();
    });
    void net;
    await waitFor(() => api.streamCount() === 1, 8000);

    const store = getStoreIdentity(db).store_id;
    for (let i = 0; i < 250; i += 1) {
      appendEvent(db, { storeId: store, type: 'sale.created', payload: { i, blob: 'x'.repeat(4096) } });
    }
    await waitFor(() => api.streamCount() === 0, 15_000);
    // The close reason must be the slow-consumer policy, not an unrelated error.
    const closed = logs.filter((l) => l.message === 'sse closed');
    expect(JSON.stringify(closed)).toContain('slow-consumer');
  });
});
