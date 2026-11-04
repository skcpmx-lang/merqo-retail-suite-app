import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
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
 *    is JSON so a terminal cannot smuggle binary content;
 *  - v1.1.3: request and response bodies are encrypted with AES-256-GCM using a
 *    key derived from the LAN token, so a shop's sales and customer data are no
 *    longer readable by anyone sniffing the local network. A terminal that still
 *    speaks the old plaintext protocol is rejected (426) rather than downgraded;
 *  - v1.1.3: repeated login failures from one address are rate-limited.
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
  /**
   * Optional TLS material (v1.1.4 Phase 3). When present the listener speaks HTTPS
   * and clients pin the certificate fingerprint. The AES-GCM envelope is kept on
   * top, so the payload is protected even if a client is mis-configured.
   */
  tls?: { certPem: string; keyPem: string; fingerprint?: string };
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
  /** `https` when TLS material was supplied. */
  protocol: 'http' | 'https';
  tls_fingerprint: string | null;
  sessionCount: () => number;
  stop: () => Promise<void>;
}

const MAX_BODY = 2 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Encrypted transport (v2)                                           */
/* ------------------------------------------------------------------ */

export const LAN_TRANSPORT_VERSION = 2;
const LAN_AAD = Buffer.from('sauda-lan-transport-v2');
const keyCache = new Map<string, Buffer>();

/**
 * AES-256 key derived from the shop's 256-bit LAN token.
 *
 * The token is already high-entropy and never leaves the shop's own machines, so a
 * fixed salt is safe here; scrypt is used so that a weak, hand-typed token still
 * costs an attacker real work. The result is cached because derivation is slow.
 */
export function deriveLanKey(token: string): Buffer {
  const cached = keyCache.get(token);
  if (cached) return cached;
  const key = crypto.scryptSync(token, 'sauda-lan-transport-v2', 32);
  if (keyCache.size > 16) keyCache.clear();
  keyCache.set(token, key);
  return key;
}

/** Seals a JSON string: base64(nonce || tag || ciphertext). */
export function sealLanPayload(token: string, plaintext: string): string {
  const key = deriveLanKey(token);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(LAN_AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ciphertext]).toString('base64');
}

/** Opens a sealed payload. Throws on tampering, wrong token or bad base64. */
export function openLanPayload(token: string, sealed: string): string {
  const raw = Buffer.from(String(sealed ?? ''), 'base64');
  if (raw.length < 12 + 16 + 1) throw new Error('সিল করা অনুরোধটি অসম্পূর্ণ।');
  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const key = deriveLanKey(token);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(LAN_AAD);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Login throttling: 10 failures per address inside 15 minutes. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES_PER_ADDRESS = 10;

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

/** Sends a response whose body is sealed with the shop token (v2 transport). */
function sendSealed(res: http.ServerResponse, token: string, status: number, payload: RpcResponse): void {
  const body = JSON.stringify({ v: LAN_TRANSPORT_VERSION, enc: sealLanPayload(token, JSON.stringify(payload)) });
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
  const loginFailures = new Map<string, { failures: number; first: number }>();

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    void (async () => {
      try {
        const remote = req.socket.remoteAddress ?? '';
        if (!allow(remote)) {
          send(res, 403, { ok: false, error: 'এই নেটওয়ার্ক থেকে সংযোগ অনুমোদিত নয়।', code: 'FORBIDDEN' });
          return;
        }
        if (req.method === 'GET' && req.url === '/health') {
          // Business identity is only disclosed to a caller that already holds the
          // token (v1.1.3) — an unauthenticated probe on the LAN learns nothing.
          const bearer = String(req.headers.authorization ?? '');
          const presented = bearer.startsWith('Bearer ') ? bearer.slice(7) : '';
          const known = presented.length > 0 && timingSafeEquals(presented, opts.token);
          send(res, 200, {
            ok: true,
            data: {
              app: 'sauda',
              version: opts.version,
              transport: LAN_TRANSPORT_VERSION,
              ...(known ? { business: opts.businessName() } : {}),
              time: new Date().toISOString(),
            },
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
        const rawBody = await readBody(req);
        let envelope: { v?: number; enc?: string };
        try {
          envelope = JSON.parse(rawBody) as { v?: number; enc?: string };
        } catch {
          send(res, 400, { ok: false, error: 'অনুরোধ বোঝা যায়নি।', code: 'BAD_REQUEST' });
          return;
        }
        if (Number(envelope?.v) !== LAN_TRANSPORT_VERSION || typeof envelope.enc !== 'string') {
          // No plaintext fallback: accepting it would let an attacker force a
          // downgrade and read every sale in clear text again.
          send(res, 426, {
            ok: false,
            error: 'টার্মিনালের সংস্করণ পুরোনো — দুটি মেশিনেই নতুন সংস্করণ ইনস্টল করুন।',
            code: 'TRANSPORT_OUTDATED',
          });
          return;
        }
        try {
          body = JSON.parse(openLanPayload(opts.token, envelope.enc));
        } catch {
          send(res, 400, {
            ok: false,
            error: 'সিল করা অনুরোধ ভাঙা বা পরিবর্তিত — প্রত্যাখ্যাত।',
            code: 'TRANSPORT_CORRUPT',
          });
          return;
        }
        const method = String(body.method ?? '');
        const args = Array.isArray(body.args) ? body.args : [];
        if (!method) {
          sendSealed(res, opts.token, 400, { ok: false, error: 'মেথড নেই।', code: 'BAD_REQUEST' });
          return;
        }

        // Login is the only route that may run without a session.
        if (method === 'auth.login') {
          const bucket = loginFailures.get(remote);
          if (bucket && Date.now() - bucket.first < LOGIN_WINDOW_MS && bucket.failures >= LOGIN_MAX_FAILURES_PER_ADDRESS) {
            sendSealed(res, opts.token, 429, {
              ok: false,
              error: 'অনেকবার ভুল লগইন — কিছুক্ষণ পর আবার চেষ্টা করুন।',
              code: 'RATE_LIMITED',
            });
            return;
          }
          try {
            const user = await opts.authenticate(String(args[0] ?? ''), String(args[1] ?? ''));
            loginFailures.delete(remote);
            const session = crypto.randomBytes(32).toString('hex');
            sessions.set(session, { user, seen: Date.now() });
            sendSealed(res, opts.token, 200, { ok: true, data: user, session });
          } catch (err) {
            const previous = loginFailures.get(remote);
            const fresh = !previous || Date.now() - previous.first >= LOGIN_WINDOW_MS;
            loginFailures.set(remote, {
              failures: fresh ? 1 : previous!.failures + 1,
              first: fresh ? Date.now() : previous!.first,
            });
            sendSealed(res, opts.token, 200, { ok: false, error: (err as Error).message, code: 'AUTH_FAILED' });
          }
          return;
        }

        const sessionId = typeof body.session === 'string' ? body.session : '';
        const entry = sessionId ? sessions.get(sessionId) : undefined;
        if (!entry || Date.now() - entry.seen > ttl) {
          if (entry) sessions.delete(sessionId);
          sendSealed(res, opts.token, 401, {
            ok: false,
            error: 'সেশন শেষ হয়েছে — আবার লগইন করুন।',
            code: 'AUTH_REQUIRED',
          });
          return;
        }
        entry.seen = Date.now();

        if (method === 'auth.logout') {
          sessions.delete(sessionId);
          sendSealed(res, opts.token, 200, { ok: true, data: true });
          return;
        }

        const result = await opts.invoke(method, args, entry.user);
        sendSealed(res, opts.token, 200, result);
      } catch (err) {
        opts.onLog?.('error', 'lan request failed', err);
        send(res, 500, { ok: false, error: (err as Error).message || 'সার্ভার ত্রুটি', code: 'ERROR' });
      }
    })();
  };

  // v1.1.4 Phase 3: HTTPS when certificate material is supplied. The AES-GCM
  // envelope stays in place on top, so payload confidentiality does not depend on
  // the client validating the certificate correctly.
  const server = opts.tls
    ? https.createServer({ cert: opts.tls.certPem, key: opts.tls.keyPem, minVersion: 'TLSv1.2' }, handler)
    : http.createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '0.0.0.0', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    addresses: lanUrls(port),
    protocol: opts.tls ? 'https' : 'http',
    tls_fingerprint: opts.tls?.fingerprint ?? null,
    sessionCount: () => sessions.size,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export interface RpcClientTls {
  /** PEM of the Main PC certificate, treated as the only trusted root. */
  caPem: string;
  /** SHA-256 of the DER certificate; a mismatch aborts the request. */
  fingerprint: string;
}

export interface RpcClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  /** HTTPS + certificate pinning (v1.1.4 Phase 3). */
  tls?: RpcClientTls;
}

/** Terminal-side client. Holds the session token in memory only. */
/**
 * Minimal HTTPS request with certificate pinning.
 *
 * `fetch` cannot express "trust exactly this self-signed certificate and verify its
 * fingerprint", so the client speaks `https` directly. Both the CA (the pinned
 * certificate) and the pin itself must be supplied — a missing pin is a hard
 * failure, never a silent fallback to "trust anything on the LAN".
 */
async function httpsJson(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  opts: { caPem: string; fingerprint: string; timeoutMs: number },
): Promise<{ status: number; text: string; code?: string; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { status: number; text: string; code?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request: ReturnType<typeof https.request>;
    try {
      request = https.request(
        url,
        {
          method: init.method,
          headers: init.headers,
          ca: opts.caPem,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
          timeout: opts.timeoutMs,
        },
        (res) => {
          const socket = res.socket as import('node:tls').TLSSocket;
          const peer = typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate() : null;
          const expected = String(opts.fingerprint ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
          const actual = peer?.raw ? crypto.createHash('sha256').update(peer.raw).digest('hex').toUpperCase() : '';
          if (!expected || !actual || actual !== expected) {
            res.destroy();
            socket.destroy();
            finish({
              status: 0,
              text: '',
              code: 'CERT_MISMATCH',
              error: `সার্ভারের সার্টিফিকেট মেলেনি (প্রত্যাশিত ${expected.slice(0, 8)}…, পাওয়া ${actual.slice(0, 8) || 'কিছুই না'})।`,
            });
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () =>
            finish({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
          );
          res.on('error', (err) => finish({ status: 0, text: '', code: 'OFFLINE', error: err.message }));
        },
      );
    } catch (err) {
      finish({ status: 0, text: '', code: 'OFFLINE', error: (err as Error).message });
      return;
    }
    request.on('timeout', () => {
      request.destroy(new Error('timeout'));
    });
    request.on('error', (err: NodeJS.ErrnoException) => {
      const code = err.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'OFFLINE';
      finish({ status: 0, text: '', code, error: err.message });
    });
    if (init.body) request.write(init.body);
    request.end();
  });
}

export function createRpcClient(opts: RpcClientOptions) {
  let session: string | null = null;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeout = opts.timeoutMs ?? 20_000;

  async function post(path: string, body: unknown): Promise<RpcResponse> {
    if (opts.tls) {
      const res = await httpsJson(
        `${base}${path}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opts.token}`,
            'x-sauda-transport': String(LAN_TRANSPORT_VERSION),
          },
          body: JSON.stringify({ v: LAN_TRANSPORT_VERSION, enc: sealLanPayload(opts.token, JSON.stringify(body)) }),
        },
        { caPem: opts.tls.caPem, fingerprint: opts.tls.fingerprint, timeoutMs: timeout },
      );
      if (res.status === 0) return { ok: false, error: res.error ?? 'সংযোগ ব্যর্থ', code: res.code ?? 'OFFLINE' };
      if (res.status === 426) {
        return { ok: false, error: 'হোস্টের সংস্করণ পুরনো।', code: 'TRANSPORT_OUTDATED' };
      }
      try {
        const envelope = JSON.parse(res.text) as { enc?: string } & RpcResponse;
        if (typeof envelope?.enc === 'string') {
          return JSON.parse(openLanPayload(opts.token, envelope.enc)) as RpcResponse;
        }
        return envelope as RpcResponse;
      } catch {
        return { ok: false, error: 'সার্ভারের উত্তর বোঝা যায়নি।', code: 'BAD_RESPONSE' };
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.token}`,
          'x-sauda-transport': String(LAN_TRANSPORT_VERSION),
        },
        body: JSON.stringify({ v: LAN_TRANSPORT_VERSION, enc: sealLanPayload(opts.token, JSON.stringify(body)) }),
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: RpcResponse;
      try {
        const envelope = JSON.parse(text) as { v?: number; enc?: string } & RpcResponse;
        if (typeof envelope?.enc === 'string') {
          parsed = JSON.parse(openLanPayload(opts.token, envelope.enc)) as RpcResponse;
        } else {
          parsed = envelope as RpcResponse;
        }
      } catch {
        return { ok: false, error: 'সার্ভারের উত্তর বোঝা যায়নি।', code: 'BAD_RESPONSE' };
      }
      if (res.status === 426) {
        return { ok: false, error: parsed.error ?? 'হোস্টের সংস্করণ পুরোনো।', code: 'TRANSPORT_OUTDATED' };
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
      if (opts.tls) {
        const res = await httpsJson(
          `${base}/health`,
          { method: 'GET', headers: { authorization: `Bearer ${opts.token}` } },
          { caPem: opts.tls.caPem, fingerprint: opts.tls.fingerprint, timeoutMs: timeout },
        );
        if (res.status === 0) return { ok: false, error: res.error ?? 'সংযোগ ব্যর্থ', code: res.code ?? 'OFFLINE' };
        try {
          return JSON.parse(res.text) as RpcResponse;
        } catch {
          return { ok: false, error: 'সার্ভারের উত্তর বোঝা যায়নি।', code: 'BAD_RESPONSE' };
        }
      }
      try {
        const res = await fetch(`${base}/health`, {
          headers: { authorization: `Bearer ${opts.token}` },
          signal: AbortSignal.timeout(timeout),
        });
        return (await res.json()) as RpcResponse;
      } catch (err) {
        return { ok: false, error: (err as Error).message, code: 'OFFLINE' };
      }
    },
  };
}

export type RpcClient = ReturnType<typeof createRpcClient>;
