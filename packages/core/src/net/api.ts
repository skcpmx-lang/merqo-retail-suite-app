import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Db } from '../db/connection.js';
import {
  DeviceError,
  consumePairingToken,
  createDeviceSession,
  enrolDevice,
  getDevice,
  validateDeviceSession,
  type DeviceRole,
  type Terminal,
} from '../services/devices.js';
import { withIdempotencyAsync, IdempotencyError } from '../services/idempotency.js';
import { verifyRequest, type NonceGuard } from './device-auth.js';
import { SqliteReplayGuard } from './replay-store.js';
import { openEventStream, type SseStream } from './sse.js';
import { latestSeq } from '../services/events.js';

/**
 * `/api/v1` — device-authenticated LAN API (Phase 3, Milestone B).
 *
 * Every protected route requires a valid Ed25519 request signature from an
 * **approved** device, and — except for pairing/claim — a session that belongs to
 * that same device. The business routes themselves are the existing permission
 * checked route table; this layer never re-implements authorisation.
 *
 * TLS is mandatory: the API refuses to start without certificate material, so there
 * is no configuration in which a client could silently talk plaintext HTTP.
 */

export interface ApiUser {
  id: number;
  username: string;
  full_name: string;
  role: string;
  permissions: string[];
}

export interface LanApiOptions {
  port: number;
  tls: { certPem: string; keyPem: string; fingerprint: string };
  db: Db;
  version: string;
  storeId: () => string;
  serverId: () => string;
  licensedCapacity: () => number;
  invoke: (method: string, args: unknown[], user: ApiUser | null) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }>;
  authenticate: (username: string, password: string) => Promise<ApiUser>;
  allowRemote?: (address: string) => boolean;
  /** How often an event stream polls the outbox (tests shorten it). */
  ssePollMs?: number;
  /** Event-stream keep-alive / re-authorisation interval. */
  sseHeartbeatMs?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, detail?: unknown) => void;
}

export interface LanApi {
  port: number;
  fingerprint: string;
  /**
   * Terminates live event streams — all of them, or the ones belonging to one
   * device. Called when a device is revoked/rejected so a client cannot keep
   * receiving events through an already-open connection.
   */
  closeStreams: (deviceId?: string, reason?: string) => void;
  /** Number of open event streams (diagnostics and tests). */
  streamCount: () => number;
  stop: () => Promise<void>;
}

interface Reply {
  status: number;
  body: unknown;
}

const MAX_BODY = 1024 * 1024;

export async function startLanApi(opts: LanApiOptions): Promise<LanApi> {
  if (!opts.tls?.certPem || !opts.tls.keyPem) {
    throw new Error('TLS ছাড়া LAN API চালু করা যাবে না।');
  }
  // Durable, restart-safe replay protection: a captured request stays dead after a
  // crash or an operator restart, not just for the lifetime of this process.
  const guard: NonceGuard = new SqliteReplayGuard(opts.db);
  const streams = new Map<string, SseStream>();
  const server = https.createServer(
    { cert: opts.tls.certPem, key: opts.tls.keyPem, minVersion: 'TLSv1.2' },
    (req, res) => {
      void handle(req, res).catch((err) => {
        opts.log?.('error', 'api request failed', err);
        send(res, 500, { ok: false, code: 'ERROR', message: 'সার্ভার ত্রুটি' });
      });
    },
  );

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const address = req.socket.remoteAddress ?? '';
    if (opts.allowRemote && !opts.allowRemote(address)) {
      send(res, 403, { ok: false, code: 'FORBIDDEN', message: 'এই নেটওয়ার্ক থেকে অনুমোদিত নয়।' });
      return;
    }
    const url = new URL(req.url ?? '/', 'https://lan.local');
    if (!url.pathname.startsWith('/api/v1/')) {
      send(res, 404, { ok: false, code: 'NOT_FOUND', message: 'পথ পাওয়া যায়নি।' });
      return;
    }
    const body = await readBody(req);

    // Public (still TLS-only) endpoint: identity, no business data, no secrets.
    if (req.method === 'GET' && url.pathname === '/api/v1/server/info') {
      send(res, 200, {
        ok: true,
        data: {
          protocol: 1,
          version: opts.version,
          store_id: opts.storeId(),
          server_id: opts.serverId(),
          capacity: opts.licensedCapacity(),
        },
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/pairing/claim') {
      const reply = pairingClaim(body);
      send(res, reply.status, reply.body);
      return;
    }

    // Everything below needs a device signature. Check the envelope first so a
    // request with no signature at all is reported as such, not as "unknown device".
    for (const header of ['x-sauda-device', 'x-sauda-ts', 'x-sauda-nonce', 'x-sauda-sign']) {
      if (!req.headers[header]) {
        send(res, 401, { ok: false, code: 'MISSING_SIGNATURE', message: 'ডিভাইস সাইন ছাড়া অনুরোধ প্রত্যাখ্যাত।' });
        return;
      }
    }
    const deviceId = String(req.headers['x-sauda-device'] ?? '');
    const device = deviceId ? getDevice(opts.db, deviceId) : null;
    if (!device) {
      send(res, 401, { ok: false, code: 'UNKNOWN_DEVICE', message: 'এই ডিভাইস নিবন্ধিত নয়।' });
      return;
    }
    const verdict = verifyRequest({
      publicKeySpkiB64: device.public_key,
      headers: req.headers,
      method: req.method ?? 'GET',
      path: url.pathname,
      body,
      guard,
    });
    if (!verdict.ok) {
      auditRejection(opts.db, device, url.pathname, verdict.code ?? 'BAD_SIGNATURE');
      send(res, statusFor(verdict.code), { ok: false, code: verdict.code, message: verdict.message });
      return;
    }
    if (device.status === 'revoked') {
      send(res, 403, { ok: false, code: 'DEVICE_REVOKED', message: 'ডিভাইসটি বাতিল করা হয়েছে।' });
      return;
    }
    if (device.status !== 'approved') {
      // A pending device may only learn its own state.
      if (req.method === 'GET' && url.pathname === '/api/v1/devices/self') {
        send(res, 200, { ok: true, data: publicDevice(device) });
        return;
      }
      send(res, 403, { ok: false, code: 'DEVICE_PENDING', message: 'ডিভাইসটি এখনো অনুমোদিত হয়নি।' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/devices/self') {
      send(res, 200, { ok: true, data: publicDevice(device) });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/events') {
      // A browser EventSource cannot carry signature headers, and the stream is not
      // open to browsers: only a device that can sign (the Electron main process)
      // can subscribe.
      const token = String(req.headers['x-sauda-session'] ?? url.searchParams.get('session') ?? '');
      let session;
      try {
        session = validateDeviceSession(opts.db, token);
      } catch (err) {
        send(res, 401, { ok: false, code: 'AUTH_REQUIRED', message: (err as Error).message });
        return;
      }
      if (session.device_id !== device.device_id) {
        send(res, 403, { ok: false, code: 'SESSION_DEVICE_MISMATCH', message: 'সেশন এই ডিভাইসের নয়।' });
        return;
      }
      const lastHeader = String(req.headers['last-event-id'] ?? url.searchParams.get('last_event_id') ?? '');
      const resumeFrom = lastHeader ? Math.max(0, Math.floor(Number(lastHeader) || 0)) : latestSeq(opts.db);
      const stream = openEventStream({
        res,
        db: opts.db,
        storeId: device.store_id,
        lastEventId: resumeFrom,
        pollMs: opts.ssePollMs,
        heartbeatMs: opts.sseHeartbeatMs,
        isAuthorized: () => {
          try {
            const current = getDevice(opts.db, device.device_id);
            if (!current || current.status !== 'approved' || current.store_id !== device.store_id) return false;
            const check = validateDeviceSession(opts.db, token);
            return check.device_id === device.device_id;
          } catch {
            return false;
          }
        },
        onClose: () => streams.delete(device.device_id),
        log: opts.log,
      });
      streams.set(device.device_id, stream);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/auth/login') {
      const parsed = parseJson(body);
      if (!parsed || typeof parsed.username !== 'string' || typeof parsed.password !== 'string') {
        send(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'ইউজারনেম ও পাসওয়ার্ড দিন।' });
        return;
      }
      try {
        const user = await opts.authenticate(parsed.username, parsed.password);
        const token = createDeviceSession(opts.db, { deviceId: device.device_id, userId: user.id });
        send(res, 200, { ok: true, data: { session: token, user } });
      } catch (err) {
        send(res, 401, { ok: false, code: 'AUTH_FAILED', message: (err as Error).message });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/rpc') {
      const reply = await rpc(body, device);
      send(res, reply.status, reply.body);
      return;
    }

    send(res, 404, { ok: false, code: 'NOT_FOUND', message: 'পথ পাওয়া যায়নি।' });
  }

  function pairingClaim(raw: string): Reply {
    const parsed = parseJson(raw);
    if (!parsed) return { status: 400, body: { ok: false, code: 'BAD_REQUEST', message: 'অনুরোধ বোঝা যায়নি।' } };
    const code = String(parsed.code ?? '');
    const deviceId = String(parsed.device_id ?? '');
    const publicKey = String(parsed.public_key ?? '');
    if (!code || !deviceId || !publicKey) {
      return { status: 400, body: { ok: false, code: 'BAD_REQUEST', message: 'কোড, ডিভাইস আইডি ও পাবলিক কী দিন।' } };
    }
    // The signature must be over a key we can actually verify with.
    try {
      const { createPublicKey } = require('node:crypto');
      createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    } catch {
      return { status: 400, body: { ok: false, code: 'BAD_KEY', message: 'ডিভাইসের পাবলিক কী সঠিক নয়।' } };
    }
    try {
      consumePairingToken(opts.db, code, deviceId);
    } catch (err) {
      const codeErr = (err as DeviceError).code ?? 'PAIRING_INVALID';
      const status = codeErr === 'PAIRING_EXPIRED' || codeErr === 'PAIRING_USED' ? 410 : 400;
      return { status, body: { ok: false, code: codeErr, message: (err as Error).message } };
    }
    const licence = (parsed.license ?? {}) as Record<string, unknown>;
    try {
      const terminal = enrolDevice(opts.db, {
        device_id: deviceId,
        device_name: String(parsed.device_name ?? 'নতুন ডিভাইস'),
        role: String(parsed.role ?? 'CLIENT_POS') as DeviceRole,
        license_id: String(licence.license_id ?? ''),
        store_id: String(licence.store_id ?? ''),
        capacity: Number(licence.capacity ?? 1),
        issued_at: String(licence.issued_at ?? new Date().toISOString()),
        expires_at: (licence.expires_at as string | null) ?? null,
        payload: licence.payload ?? {},
        public_key: publicKey,
        platform: String(parsed.platform ?? ''),
        app_version: String(parsed.app_version ?? ''),
      });
      return {
        status: 202,
        body: { ok: true, data: { status: terminal.status, device_id: terminal.device_id } },
      };
    } catch (err) {
      if (err instanceof DeviceError) return { status: 409, body: { ok: false, code: err.code, message: err.message } };
      return { status: 500, body: { ok: false, code: 'ERROR', message: (err as Error).message } };
    }
  }

  async function rpc(raw: string, device: Terminal): Promise<Reply> {
    const parsed = parseJson(raw);
    if (!parsed || typeof parsed.method !== 'string') {
      return { status: 400, body: { ok: false, code: 'BAD_REQUEST', message: 'মেথড দিন।' } };
    }
    let sessionUser: ApiUser;
    try {
      const session = validateDeviceSession(opts.db, String(parsed.session ?? ''));
      if (session.device_id !== device.device_id) {
        return { status: 403, body: { ok: false, code: 'SESSION_DEVICE_MISMATCH', message: 'সেশন এই ডিভাইসের নয়।' } };
      }
      const user = opts.db.prepare('SELECT id, username, full_name, role FROM users WHERE id = ?').get(
        session.user_id,
      ) as { id: number; username: string; full_name: string; role: string } | undefined;
      if (!user) return { status: 401, body: { ok: false, code: 'AUTH_REQUIRED', message: 'ইউজার পাওয়া যায়নি।' } };
      const permissions = opts.db
        .prepare('SELECT permissions FROM users WHERE id = ?')
        .get(user.id) as { permissions: string } | undefined;
      sessionUser = { ...user, permissions: safeJsonArray(permissions?.permissions) };
    } catch (err) {
      const code = (err as DeviceError).code ?? 'AUTH_REQUIRED';
      return { status: 401, body: { ok: false, code, message: (err as Error).message } };
    }

    const args = Array.isArray(parsed.args) ? parsed.args : [];
    const key = typeof parsed.idempotency_key === 'string' ? parsed.idempotency_key : '';
    try {
      const call = () => opts.invoke(String(parsed.method), args, sessionUser);
      const resolved = key
        ? await withIdempotencyAsync(
            opts.db,
            { key, method: String(parsed.method), deviceId: device.device_id, body: args },
            call,
          )
        : await call();
      return { status: resolved.ok ? 200 : 403, body: resolved };
    } catch (err) {
      if (err instanceof IdempotencyError) {
        return { status: 409, body: { ok: false, code: err.code, message: err.message } };
      }
      return { status: 400, body: { ok: false, code: 'ERROR', message: (err as Error).message } };
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '0.0.0.0', () => resolve());
  });

  return {
    port: (server.address() as AddressInfo).port,
    fingerprint: opts.tls.fingerprint,
    closeStreams: (deviceId?: string, reason = 'revoked') => {
      for (const [id, stream] of streams) {
        if (!deviceId || id === deviceId) stream.close(reason);
      }
    },
    streamCount: () => streams.size,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const stream of streams.values()) stream.close('server-stop');
        streams.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function publicDevice(device: Terminal) {
  return {
    device_id: device.device_id,
    device_name: device.device_name,
    role: device.role,
    status: device.status,
    store_id: device.store_id,
    license_id: device.license_id,
    last_seen: device.last_seen,
  };
}

function statusFor(code?: string): number {
  switch (code) {
    case 'MISSING_SIGNATURE':
    case 'NO_DEVICE_KEY':
    case 'BAD_SIGNATURE':
      return 401;
    case 'STALE_REQUEST':
    case 'REPLAY':
      return 409;
    default:
      return 401;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('অনুরোধ অনেক বড়।'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function parseJson(text: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

function safeJsonArray(value: string | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function auditRejection(db: Db, device: Terminal, path: string, code: string): void {
  try {
    db.prepare(
      `INSERT INTO audit_logs (user_id, username, action, entity, entity_id, details, created_at)
       VALUES (NULL, ?, 'api.rejected', 'terminal', ?, ?, ?)`,
    ).run(
      `device:${device.device_id}`,
      device.device_id,
      JSON.stringify({ path, code }).slice(0, 1000),
      new Date().toISOString(),
    );
  } catch {
    /* auditing must never break request handling */
  }
}
