import crypto from 'node:crypto';
import https from 'node:https';
import { signRequest } from './device-auth.js';

/**
 * `/api/v1` client (Phase 3, Milestone D).
 *
 * This is what the Electron main process uses in terminal mode. It is deliberately
 * boring and deliberately strict:
 *
 *  - **HTTPS only.** A plaintext base URL is rejected by the constructor; there is
 *    no fallback path, so a wrong setting shows an error instead of quietly sending
 *    credentials over HTTP.
 *  - **Pinned.** The certificate fingerprint is checked during the handshake, so a
 *    different Main PC on the same address is refused even if it presents a valid
 *    self-signed certificate.
 *  - **Signed.** Every call carries an Ed25519 signature from the device key; the
 *    client never knows a shared shop token.
 *  - **No silent retry of writes.** A caller may pass an idempotency key; the client
 *    does not invent one, because guessing could duplicate a sale.
 */

export interface V1ClientOptions {
  baseUrl: string;
  tls: { caPem: string; fingerprint: string };
  deviceId: string;
  privateKeyPem: string;
  timeoutMs?: number;
}

export interface V1User {
  id: number;
  username: string;
  full_name: string;
  role: string;
  permissions: string[];
}

export interface V1Result<T = unknown> {
  ok: boolean;
  data?: T;
  code?: string;
  error?: string;
  status?: number;
}

export interface V1Client {
  readonly baseUrl: string;
  login(username: string, password: string): Promise<V1Result<{ session: string; user: V1User }>>;
  logout(): void;
  readonly session: string | null;
  rpc<T = unknown>(method: string, args?: unknown[], opts?: { idempotencyKey?: string }): Promise<V1Result<T>>;
  serverInfo(): Promise<V1Result<{ protocol: number; version: string; store_id: string; server_id: string; capacity: number }>>;
  deviceSelf(): Promise<V1Result<Record<string, unknown>>>;
  /**
   * Unauthenticated (TLS-only) pairing claim. Returns the device's status; the device
   * is `pending` until an administrator approves it on the Main PC.
   */
  claim(body: {
    code: string;
    device_id: string;
    device_name: string;
    public_key: string;
    /** The host spells this field `license`; it carries the shop licence record. */
    license: Record<string, unknown>;
  }): Promise<V1Result<{ status: 'pending' | 'approved'; device_id: string }>>;
  health(): Promise<{ ok: boolean; code?: string; error?: string }>;
}

export function createV1Client(opts: V1ClientOptions): V1Client {
  if (!/^https:\/\//i.test(opts.baseUrl)) {
    throw new Error('v1 ক্লায়েন্ট শুধু HTTPS-এ চলে — HTTP-তে নামানো যাবে না।');
  }
  const base = opts.baseUrl.replace(/\/+$/, '');
  const url = new URL(base);
  const timeoutMs = opts.timeoutMs ?? 12_000;
  let session: string | null = null;

  function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, signed = true): Promise<V1Result<T>> {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (signed) {
      Object.assign(headers, signRequest(opts.privateKeyPem, { method, path, body: payload, deviceId: opts.deviceId }));
    }
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    return new Promise((resolve) => {
      const req = https.request(
        {
          host: url.hostname,
          port: url.port ? Number(url.port) : 443,
          path,
          method,
          headers,
          ca: opts.tls.caPem,
          timeout: timeoutMs,
          checkServerIdentity: (_host, cert) => {
            const pin = crypto.createHash('sha256').update(cert.raw).digest('hex').toUpperCase();
            const expected = opts.tls.fingerprint.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
            if (pin !== expected) return new Error('সার্ভারের সার্টিফিকেট পিন মেলেনি — সংযোগ প্রত্যাখ্যাত।');
            return undefined;
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.from(c)));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: { ok?: boolean; data?: T; code?: string; message?: string; error?: string } = {};
            try {
              parsed = JSON.parse(text);
            } catch {
              resolve({ ok: false, code: 'BAD_REPLY', error: text.slice(0, 120) || 'সার্ভারের উত্তর পড়া যায়নি।', status: res.statusCode });
              return;
            }
            resolve({
              ok: Boolean(parsed.ok),
              data: parsed.data,
              code: parsed.code,
              error: parsed.message ?? parsed.error,
              status: res.statusCode,
            });
          });
        },
      );
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, code: 'TIMEOUT', error: 'সার্ভারের উত্তর দেরি করছে।' });
      });
      req.on('error', (err) => {
        const message = err.message.includes('পিন')
          ? 'সার্ভারের পরিচয় মেলেনি (পিন) — নতুন পেয়ারিং দরকার।'
          : err.message;
        resolve({ ok: false, code: err.message.includes('পিন') ? 'CERT_MISMATCH' : 'OFFLINE', error: message });
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    baseUrl: base,
    get session() {
      return session;
    },
    async login(username, password) {
      const res = await call<{ session: string; user: V1User }>('POST', '/api/v1/auth/login', { username, password });
      if (res.ok && res.data?.session) session = res.data.session;
      return res;
    },
    logout() {
      session = null;
    },
    async rpc<T>(method: string, args: unknown[] = [], rpcOpts: { idempotencyKey?: string } = {}) {
      if (!session) return { ok: false, code: 'AUTH_REQUIRED', error: 'আগে লগইন করুন।' };
      const body: Record<string, unknown> = { method, args, session };
      if (rpcOpts.idempotencyKey) body.idempotency_key = rpcOpts.idempotencyKey;
      return call<T>('POST', '/api/v1/rpc', body);
    },
    serverInfo() {
      return call('GET', '/api/v1/server/info');
    },
    claim(body) {
      // The pairing code is the credential here; the request is authenticated by TLS
      // pinning plus the single-use code itself. It grants nothing until approval.
      return call('POST', '/api/v1/pairing/claim', body, false);
    },
    deviceSelf() {
      return call('GET', '/api/v1/devices/self');
    },
    async health() {
      const res = await call('GET', '/api/v1/server/info');
      return { ok: res.ok, code: res.code, error: res.error };
    },
  };
}
