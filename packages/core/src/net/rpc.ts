import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';

/**
 * LAN transport for multi-terminal shops.
 *
 * Design notes (the threat model lives in docs/17-LAN-ARCHITECTURE.md):
 *  - the *host* owns the only writable SQLite file; terminals never touch it;
 *  - every request carries a 256-bit shared secret (the shop's LAN token);
 *  - a terminal logs in through the host and receives an opaque session token,
 *    so permissions are always resolved on the host from the real user record;
 *  - only private (RFC1918 / loopback) peers are accepted;
 *  - bodies are capped, methods are allow-listed by the caller, and every reply
 *    is JSON so a terminal cannot smuggle binary content.
 */
export interface RpcUser {
  id: number;
  username: string;
  full_name: string;
  role: 'admin' | 'manager' | 'cashier';
  permissions: string[];
}

export interface RpcResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
  /** Issued by the host on a successful `auth.login`. */
  session?: string;
}

export interface RpcHostOptions {
  port: number;
  token: string;
  version: string;
  businessName: () => string;
  /** Runs a route as `user` (null = not logged in). */
  invoke: (method: string, args: unknown[], user: RpcUser | null) => Promise<RpcResponse>;
  /** Verifies credentials on the host; returns the user or throws. */
  authenticate: (username: string, password: string) => Promise<RpcUser>;
  /** Session lifetime in ms (sliding). */
  sessionTtlMs?: number;
  /** Override for tests — defaults to private-range check. */
  allowRemote?: (address: string) => boolean;
  onLog?: (level: 'info' | 'warn' | 'error', message: string, detail?: unknown) => void;
}

export interface RpcHost {
  port: number;
  addresses: string[];
  sessionCount: () => number;
  stop: () => Promise<void>;
}

const MAX_BODY = 2 * 1024 * 1024;

/** RFC1918 + loopback + link-local only. */
export function isPrivateAddress(address: string): boolean {
  if (!address) return false;
  const addr = address.replace(/^::ffff:/, '');
  if (addr === '::1' || addr === '127.0.0.1') return true;
  if (/^10\./.test(addr)) return true;
  if (/^192\.168\./.test(addr)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return true;
  if (/^169\.254\./.test(addr)) return true;
  if (/^fe80:/i.test(addr) || /^fc|^fd/i.test(addr)) return true;
  return false;
}

export function lanUrls(port: number): string[] {
  const out: string[] = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push(`http://${net.address}:${port}`);
    }
  }
  out.push(`http://127.0.0.1:${port}`);
  return out;
}

export function generateLanToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function timingSafeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
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

function send(res: http.ServerResponse, status: number, payload: RpcResponse): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export async function startRpcHost(opts: RpcHostOptions): Promise<RpcHost> {
  const ttl = opts.sessionTtlMs ?? 12 * 60 * 60 * 1000;
  const sessions = new Map<string, { user: RpcUser; seen: number }>();
  const allow = opts.allowRemote ?? isPrivateAddress;

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const remote = req.socket.remoteAddress ?? '';
        if (!allow(remote)) {
          send(res, 403, { ok: false, error: 'এই নেটওয়ার্ক থেকে সংযোগ অনুমোদিত নয়।', code: 'FORBIDDEN' });
          return;
        }
        if (req.method === 'GET' && req.url === '/health') {
          send(res, 200, {
            ok: true,
            data: { app: 'sauda', version: opts.version, business: opts.businessName(), time: new Date().toISOString() },
          });
          return;
        }
        if (req.method !== 'POST' || req.url !== '/rpc') {
          send(res, 404, { ok: false, error: 'পথ পাওয়া যায়নি।', code: 'NOT_FOUND' });
          return;
        }
        const auth = String(req.headers.authorization ?? '');
        const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (!provided || !timingSafeEquals(provided, opts.token)) {
          send(res, 401, { ok: false, error: 'LAN টোকেন সঠিক নয়। সেটিংস থেকে টোকেন মিলিয়ে নিন।', code: 'UNAUTHORIZED' });
          return;
        }
        let body: { method?: string; args?: unknown[]; session?: string | null };
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          send(res, 400, { ok: false, error: 'অনুরোধ বোঝা যায়নি।', code: 'BAD_REQUEST' });
          return;
        }
        const method = String(body.method ?? '');
        const args = Array.isArray(body.args) ? body.args : [];
        if (!method) {
          send(res, 400, { ok: false, error: 'মেথড নেই।', code: 'BAD_REQUEST' });
          return;
        }

        // Login is the only route that may run without a session.
        if (method === 'auth.login') {
          try {
            const user = await opts.authenticate(String(args[0] ?? ''), String(args[1] ?? ''));
            const session = crypto.randomBytes(32).toString('hex');
            sessions.set(session, { user, seen: Date.now() });
            send(res, 200, { ok: true, data: user, session });
          } catch (err) {
            send(res, 200, { ok: false, error: (err as Error).message, code: 'AUTH_FAILED' });
          }
          return;
        }

        const sessionId = typeof body.session === 'string' ? body.session : '';
        const entry = sessionId ? sessions.get(sessionId) : undefined;
        if (!entry || Date.now() - entry.seen > ttl) {
          if (entry) sessions.delete(sessionId);
          send(res, 401, { ok: false, error: 'সেশন শেষ হয়েছে — আবার লগইন করুন।', code: 'AUTH_REQUIRED' });
          return;
        }
        entry.seen = Date.now();

        if (method === 'auth.logout') {
          sessions.delete(sessionId);
          send(res, 200, { ok: true, data: true });
          return;
        }

        const result = await opts.invoke(method, args, entry.user);
        send(res, 200, result);
      } catch (err) {
        opts.onLog?.('error', 'lan request failed', err);
        send(res, 500, { ok: false, error: (err as Error).message || 'সার্ভার ত্রুটি', code: 'ERROR' });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '0.0.0.0', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    addresses: lanUrls(port),
    sessionCount: () => sessions.size,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export interface RpcClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

/** Terminal-side client. Holds the session token in memory only. */
export function createRpcClient(opts: RpcClientOptions) {
  let session: string | null = null;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeout = opts.timeoutMs ?? 20_000;

  async function post(path: string, body: unknown): Promise<RpcResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: RpcResponse;
      try {
        parsed = JSON.parse(text) as RpcResponse;
      } catch {
        return { ok: false, error: 'সার্ভারের উত্তর বোঝা যায়নি।', code: 'BAD_RESPONSE' };
      }
      return parsed;
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError') {
        return { ok: false, error: 'সার্ভারে সময়মতো উত্তর পাওয়া যায়নি।', code: 'TIMEOUT' };
      }
      return { ok: false, error: `সার্ভারে সংযোগ করা যাচ্ছে না: ${e.message}`, code: 'OFFLINE' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get hasSession() {
      return Boolean(session);
    },
    clearSession() {
      session = null;
    },
    async invoke(method: string, args: unknown[]): Promise<RpcResponse> {
      const res = await post('/rpc', { method, args, session });
      if (res.session) session = res.session;
      if (!res.ok && (res.code === 'AUTH_REQUIRED' || res.code === 'AUTH_FAILED')) session = null;
      return res;
    },
    async health(): Promise<RpcResponse> {
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeout) });
        return (await res.json()) as RpcResponse;
      } catch (err) {
        return { ok: false, error: (err as Error).message, code: 'OFFLINE' };
      }
    },
  };
}

export type RpcClient = ReturnType<typeof createRpcClient>;
