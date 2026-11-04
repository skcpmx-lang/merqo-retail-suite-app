/**
 * v1.1.4 audit — client-side SSE lifecycle hardening.
 *
 * Covers the cases the previous suite did not:
 *  - a revoked / unapproved / expired-session device must STOP reconnecting (it used to
 *    retry once more, hitting the same rejection);
 *  - a half-open connection (sleep/wake, network change) is detected by an idle watchdog
 *    instead of looking "connected" forever;
 *  - a peer that never sends a newline cannot grow the client's buffer without bound;
 *  - reconnect delays grow with each attempt and stay bounded;
 *  - duplicate ids are ignored and a sequence jump is reported as a gap, never silently
 *    applied.
 *
 * Events are hints only: the client delivers ids/types/payloads to the caller, which
 * refetches through the API. Nothing here caches business data.
 */
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  createDeviceSession,
  getStoreIdentity,
  initializeApp,
  loadOrCreateServerIdentity,
  openDatabase,
  openEventStreamClient,
  revokeDevice,
  revokeDeviceSession,
  startLanApi,
  type LanApi,
} from '../src/index.js';
import { generateDeviceKeyPair } from '../src/net/device-auth.js';
import { closeTrackedDatabases, openTrackedDatabase, removeTempDirs } from '../../../test-setup/temp-resources.js';

vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
const handles: Array<{ close: () => void }> = [];
const servers: Array<{ close: () => void }> = [];

afterAll(() => {
  for (const handle of handles) handle.close();
  for (const server of servers) server.close();
  closeTrackedDatabases();
  removeTempDirs(dirs);
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-sse-reconnect-'));
  dirs.push(dir);
  return dir;
}

function freshDb(dir: string) {
  const db = openTrackedDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
  initializeApp(db, {
    businessName: 'পুনঃসংযোগ স্টোর',
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
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(deviceId, deviceId, 'CLIENT_POS', store.store_id, `LIC-${deviceId}`, 'approved', keys.publicKeySpkiB64, new Date().toISOString());
  return { ...keys, deviceId };
}

const waitFor = async (fn: () => boolean, timeoutMs = 8000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
};

/** Minimal HTTPS peer whose behaviour each test controls. */
async function fakeServer(onRequest: (req: https.IncomingMessage, res: https.ServerResponse) => void) {
  const dir = tempDir();
  const identity = loadOrCreateServerIdentity({ dir: path.join(dir, 'tls'), allowCreate: true, ips: [] });
  let connections = 0;
  const times: number[] = [];
  const server = https.createServer({ cert: identity.certPem, key: identity.keyPem }, (req, res) => {
    connections += 1;
    times.push(Date.now());
    onRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const handle = { close: () => server.close() };
  servers.push(handle);
  return {
    baseUrl: `https://127.0.0.1:${port}`,
    certPem: identity.certPem,
    fingerprint: identity.fingerprint,
    connections: () => connections,
    times: () => times,
  };
}

function clientFor(
  peer: { baseUrl: string; certPem: string; fingerprint: string },
  opts: {
    onEvent?: (event: { id: number; type: string }) => void;
    onGap?: (from: number, to: number) => void;
    onError?: (err: { code: string; message: string; retryable: boolean }) => void;
    onOpen?: () => void;
    retryDelayMs?: number;
    maxRetries?: number;
    backoffMaxMs?: number;
    jitter?: boolean;
    idleTimeoutMs?: number;
    maxBufferBytes?: number;
    lastEventId?: number;
  } = {},
) {
  const handle = openEventStreamClient({
    baseUrl: peer.baseUrl,
    tls: { caPem: peer.certPem, fingerprint: peer.fingerprint },
    deviceId: 'DEV-CLIENT',
    privateKeyPem: generateDeviceKeyPair().privateKeyPem,
    session: 'test-session',
    retryDelayMs: opts.retryDelayMs ?? 50,
    maxRetries: opts.maxRetries ?? 10,
    jitter: opts.jitter ?? false,
    backoffMaxMs: opts.backoffMaxMs,
    idleTimeoutMs: opts.idleTimeoutMs,
    maxBufferBytes: opts.maxBufferBytes,
    lastEventId: opts.lastEventId,
    onEvent: opts.onEvent ?? (() => undefined),
    onGap: opts.onGap,
    onError: opts.onError,
    onOpen: opts.onOpen,
  });
  handles.push(handle);
  return handle;
}

describe('server-driven stream termination', () => {
  async function lanPair() {
    const dir = tempDir();
    const db = freshDb(dir);
    const device = addDevice(db, 'DEV-LIVE');
    const token = createDeviceSession(db, { deviceId: device.deviceId, userId: 1 });
    const identity = loadOrCreateServerIdentity({ dir: path.join(dir, 'tls'), allowCreate: true, ips: [] });
    const store = getStoreIdentity(db);
    const api: LanApi = await startLanApi({
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
      ssePollMs: 25,
      sseHeartbeatMs: 40,
    });
    servers.push({ close: () => void api.stop() });
    return { db, device, token, identity, api };
  }

  it('a revoked device stops reconnecting instead of retrying the same rejection', async () => {
    const { db, device, token, identity, api } = await lanPair();
    const errors: Array<{ code: string; message: string; retryable: boolean }> = [];
    const handle = openEventStreamClient({
      baseUrl: `https://127.0.0.1:${api.port}`,
      tls: { caPem: identity.certPem, fingerprint: identity.fingerprint },
      deviceId: device.deviceId,
      privateKeyPem: device.privateKeyPem,
      session: token,
      retryDelayMs: 50,
      onEvent: () => undefined,
      onError: (err) => errors.push(err),
    });
    handles.push(handle);
    await waitFor(() => handle.connected);

    revokeDevice(db, device.deviceId, { id: 1, username: 'owner' }, 'চুরি হয়েছে');
    await waitFor(() => errors.length > 0);
    const terminal = errors.find((e) => /revoked/.test(e.message));
    expect(terminal).toBeTruthy();
    expect(terminal!.retryable).toBe(false);
    expect(handle.connected).toBe(false);

    // No further connection attempts: nothing changes even after several retry windows.
    const count = errors.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(errors.length).toBe(count);
  });

  it('an expired session is terminal, not an infinite retry loop', async () => {
    const { db, device, token, identity, api } = await lanPair();
    const errors: Array<{ code: string; message: string; retryable: boolean }> = [];
    const handle = openEventStreamClient({
      baseUrl: `https://127.0.0.1:${api.port}`,
      tls: { caPem: identity.certPem, fingerprint: identity.fingerprint },
      deviceId: device.deviceId,
      privateKeyPem: device.privateKeyPem,
      session: token,
      retryDelayMs: 50,
      onEvent: () => undefined,
      onError: (err) => errors.push(err),
    });
    handles.push(handle);
    await waitFor(() => handle.connected);

    revokeDeviceSession(db, token);
    await waitFor(() => errors.length > 0);
    expect(errors[errors.length - 1]!.retryable).toBe(false);
    const count = errors.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(errors.length).toBe(count);
  });
});

describe('dead and abusive peers', () => {
  it('detects a silent (half-open) connection with the idle watchdog and reconnects', async () => {
    const peer = await fakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Flush the headers, then go completely silent: no heartbeat, no event. This is what a
      // half-open connection after sleep/wake or a network change looks like.
      res.write(': hi\n\n');
    });
    const errors: string[] = [];
    const opens: number[] = [];
    clientFor(peer, {
      idleTimeoutMs: 150,
      retryDelayMs: 40,
      maxRetries: 3,
      onOpen: () => opens.push(Date.now()),
      onError: (err) => errors.push(err.code),
    });
    await waitFor(() => errors.includes('STREAM_IDLE'));
    await waitFor(() => opens.length >= 2);
    expect(peer.connections()).toBeGreaterThanOrEqual(2);
  });

  it('refuses to buffer an endless line and reconnects', async () => {
    const peer = await fakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('x'.repeat(8192)); // no newline ever
    });
    const errors: string[] = [];
    clientFor(peer, { maxBufferBytes: 2048, retryDelayMs: 40, maxRetries: 2, onError: (err) => errors.push(err.code) });
    await waitFor(() => errors.includes('STREAM_OVERFLOW'));
  });

  it('stops after the retry limit and reports exhaustion', async () => {
    const peer = await fakeServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'BUSY', message: 'ব্যস্ত' }));
    });
    const errors: Array<{ code: string; retryable: boolean }> = [];
    clientFor(peer, { retryDelayMs: 20, maxRetries: 2, onError: (err) => errors.push(err) });
    await waitFor(() => errors.some((e) => e.code === 'STREAM_EXHAUSTED'));
    expect(peer.connections()).toBe(3); // initial attempt + 2 retries
  });

  it('grows the reconnect delay but keeps it bounded', async () => {
    const peer = await fakeServer((_req, res) => {
      res.writeHead(500, {});
      res.end('{}');
    });
    clientFor(peer, { retryDelayMs: 60, backoffMaxMs: 240, maxRetries: 6, onError: () => undefined });
    await waitFor(() => peer.connections() >= 5);
    const gaps = peer.times().slice(1).map((t, i) => t - peer.times()[i]!);
    // First gap is the base delay; later gaps are larger (or capped at the ceiling).
    expect(gaps[1]!).toBeGreaterThan(gaps[0]! - 15);
    for (const gap of gaps) expect(gap).toBeLessThan(600);
  });
});

describe('ordering guarantees', () => {
  it('ignores duplicate ids and still delivers the next one', async () => {
    const peer = await fakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('id: 7\nevent: sale.created\ndata: {"n":1}\n\n');
      res.write('id: 7\nevent: sale.created\ndata: {"n":1}\n\n'); // duplicate
      res.write('id: 8\nevent: sale.created\ndata: {"n":2}\n\n');
    });
    const seen: number[] = [];
    clientFor(peer, { onEvent: (event) => seen.push(event.id) });
    await waitFor(() => seen.includes(8));
    expect(seen).toEqual([7, 8]);
  });

  it('reports a sequence jump as a gap instead of pretending it is continuous', async () => {
    const peer = await fakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('id: 20\nevent: sale.created\ndata: {"n":1}\n\n');
      res.write('id: 25\nevent: sale.created\ndata: {"n":2}\n\n');
    });
    const gaps: Array<[number, number]> = [];
    clientFor(peer, { lastEventId: 20, onEvent: () => undefined, onGap: (from, to) => gaps.push([from, to]) });
    await waitFor(() => gaps.length > 0);
    expect(gaps[0]).toEqual([21, 24]);
  });

  it('sends Last-Event-ID on every reconnect so the server can resume', async () => {
    const resumeHeaders: Array<string | undefined> = [];
    const peer = await fakeServer((req, res) => {
      resumeHeaders.push(req.headers['last-event-id'] as string | undefined);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('id: 42\nevent: sale.created\ndata: {"n":1}\n\n');
      res.end(); // server drops the stream → client reconnects
    });
    clientFor(peer, { lastEventId: 41, retryDelayMs: 40, maxRetries: 3, onEvent: () => undefined });
    await waitFor(() => resumeHeaders.length >= 2);
    expect(resumeHeaders[0]).toBe('41');
    expect(resumeHeaders[1]).toBe('42');
  });
});
