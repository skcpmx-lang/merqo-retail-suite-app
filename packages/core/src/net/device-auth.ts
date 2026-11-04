import crypto from 'node:crypto';

/**
 * Device request signing (Phase 3, Milestone B).
 *
 * Each enrolled device holds an Ed25519 keypair generated on the device. The public
 * key is registered at pairing time and stored in `terminals.public_key`; the
 * private key never leaves the device. Every protected request carries a signature
 * over a canonical string that binds the HTTP method, path, timestamp, nonce and a
 * digest of the exact body.
 *
 * Why signatures rather than a shared HMAC secret: the server then stores no
 * verifier that could be replayed as a credential, and a stolen database row cannot
 * be used to impersonate a device. It also means "credential theft from the server"
 * is not a path to device impersonation at all.
 */

export const MAX_CLOCK_SKEW_MS = 120_000;

export interface SignedHeaders {
  'x-sauda-device': string;
  'x-sauda-ts': string;
  'x-sauda-nonce': string;
  'x-sauda-sign': string;
}

export function canonicalRequest(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: string;
}): string {
  const bodyHash = crypto.createHash('sha256').update(input.body ?? '', 'utf8').digest('hex');
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    bodyHash,
  ].join('\n');
}

/** Sign on the device. `privateKeyPem` is a PKCS#8 Ed25519 key. */
export function signRequest(
  privateKeyPem: string,
  input: { method: string; path: string; body?: string; deviceId: string; nonce?: string; timestamp?: number },
): SignedHeaders {
  const timestamp = String(input.timestamp ?? Date.now());
  const nonce = input.nonce ?? crypto.randomBytes(16).toString('hex');
  const body = input.body ?? '';
  const signature = crypto
    .sign(null, Buffer.from(canonicalRequest({ ...input, body, timestamp, nonce }), 'utf8'), privateKeyPem)
    .toString('base64');
  return {
    'x-sauda-device': input.deviceId,
    'x-sauda-ts': timestamp,
    'x-sauda-nonce': nonce,
    'x-sauda-sign': signature,
  };
}

export function generateDeviceKeyPair(): { publicKeyPem: string; privateKeyPem: string; publicKeySpkiB64: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  // Store the compact SPKI base64 form in the database.
  const publicKeySpkiB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { publicKeyPem, privateKeyPem, publicKeySpkiB64 };
}

export type VerifyFailure =
  | 'MISSING_SIGNATURE'
  | 'STALE_REQUEST'
  | 'REPLAY'
  | 'BAD_SIGNATURE'
  | 'NO_DEVICE_KEY';

export interface VerifyResult {
  ok: boolean;
  code?: VerifyFailure;
  message?: string;
  deviceId?: string;
}

/**
 * In-memory replay window. A nonce is remembered for twice the clock skew, so a
 * replay inside the accepted window is rejected even if the timestamp is still
 * "fresh". A host restart empties the cache, which is safe because the window is
 * bounded and the signature still has to verify.
 */
export class ReplayGuard {
  private seen = new Map<string, number>();
  constructor(private readonly windowMs = MAX_CLOCK_SKEW_MS * 2) {}

  /** Returns false when this nonce was already used by this device. */
  claim(deviceId: string, nonce: string, now = Date.now()): boolean {
    this.sweep(now);
    const key = `${deviceId}:${nonce}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, now + this.windowMs);
    return true;
  }

  sweep(now = Date.now()): void {
    for (const [key, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(key);
    }
  }

  size(): number {
    return this.seen.size;
  }
}

/** Verify on the server against the public key registered for that device. */
export function verifyRequest(input: {
  publicKeySpkiB64: string | null | undefined;
  headers: Partial<Record<string, string | string[] | undefined>>;
  method: string;
  path: string;
  body: string;
  guard: ReplayGuard;
  now?: number;
  maxSkewMs?: number;
}): VerifyResult {
  const deviceId = headerValue(input.headers['x-sauda-device']);
  const timestamp = headerValue(input.headers['x-sauda-ts']);
  const nonce = headerValue(input.headers['x-sauda-nonce']);
  const signature = headerValue(input.headers['x-sauda-sign']);
  if (!deviceId || !timestamp || !nonce || !signature) {
    return { ok: false, code: 'MISSING_SIGNATURE', message: 'ডিভাইস সাইন ছাড়া অনুরোধ প্রত্যাখ্যাত।' };
  }
  const now = input.now ?? Date.now();
  const skew = input.maxSkewMs ?? MAX_CLOCK_SKEW_MS;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > skew) {
    return { ok: false, code: 'STALE_REQUEST', message: 'অনুরোধের সময়সীমা শেষ বা ঘড়ি মেলেনি।', deviceId };
  }
  if (!nonce || nonce.length < 16) {
    return { ok: false, code: 'MISSING_SIGNATURE', message: 'ননস সঠিক নয়।', deviceId };
  }
  if (!input.publicKeySpkiB64) {
    return { ok: false, code: 'NO_DEVICE_KEY', message: 'এই ডিভাইসের কোনো নিবন্ধিত কী নেই।', deviceId };
  }
  if (!input.guard.claim(deviceId, nonce, now)) {
    return { ok: false, code: 'REPLAY', message: 'একই অনুরোধ দুইবার পাঠানো হয়েছে — প্রত্যাখ্যাত।', deviceId };
  }
  let verified = false;
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(input.publicKeySpkiB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    verified = crypto.verify(
      null,
      Buffer.from(
        canonicalRequest({
          method: input.method,
          path: input.path,
          timestamp,
          nonce,
          body: input.body ?? '',
        }),
        'utf8',
      ),
      publicKey,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    return { ok: false, code: 'BAD_SIGNATURE', message: 'ডিভাইসের স্বাক্ষর মেলেনি — অনুরোধ প্রত্যাখ্যাত।', deviceId };
  }
  return { ok: true, deviceId };
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return String(value[0] ?? '');
  return String(value ?? '');
}
