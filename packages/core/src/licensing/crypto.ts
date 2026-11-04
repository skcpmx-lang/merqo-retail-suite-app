import crypto from 'node:crypto';

/**
 * Canonical JSON — deterministic key ordering & number formatting, so that the
 * bytes signed by the License Generator are byte-identical to the bytes
 * verified by the main application.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function shortHash(value: string | Buffer, length = 16): string {
  return sha256Hex(value).slice(0, length).toUpperCase();
}

export function base64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64urlDecode(text: string): Buffer {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

export function ed25519PublicKeyFromBase64(spkiBase64: string): crypto.KeyObject {
  const der = Buffer.from(spkiBase64, 'base64');
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export function ed25519PrivateKeyFromBase64(pkcs8Base64: string): crypto.KeyObject {
  const der = Buffer.from(pkcs8Base64, 'base64');
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

export function signEd25519(privateKey: crypto.KeyObject, message: string): string {
  const sig = crypto.sign(null, Buffer.from(message, 'utf8'), privateKey);
  return base64urlEncode(sig);
}

export function verifyEd25519(publicKey: crypto.KeyObject, message: string, signatureB64url: string): boolean {
  try {
    const sig = base64urlDecode(signatureB64url);
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(message, 'utf8'), publicKey, sig);
  } catch {
    return false;
  }
}

export function randomId(prefix = ''): string {
  const raw = crypto.randomBytes(9).toString('hex').toUpperCase();
  const grouped = raw.match(/.{1,6}/g)?.join('-') ?? raw;
  return prefix ? `${prefix}-${grouped}` : grouped;
}
