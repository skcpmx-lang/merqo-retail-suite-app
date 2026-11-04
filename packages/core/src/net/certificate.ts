import crypto from 'node:crypto';
import os from 'node:os';

/**
 * Self-signed TLS certificate for the Main Server (Phase 3).
 *
 * Electron ships no certificate authority and a runtime `openssl` binary is not
 * guaranteed on a Windows shop PC, so the certificate is built here with a small,
 * auditable DER encoder. The output is a normal X.509 v3 certificate that Node's
 * `https` server accepts and that clients pin by SHA-256 fingerprint.
 *
 * What the certificate guarantees: the client is talking to the machine that holds
 * the matching private key. It does NOT make the machine trustworthy on its own —
 * trust comes from the fingerprint the operator confirms at pairing time and from
 * the device credential that is verified on every request.
 */

/* ------------------------------------------------------------------ */
/* Minimal DER encoder                                                 */
/* ------------------------------------------------------------------ */

function lengthBytes(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), lengthBytes(content.length), content]);
}

const der = {
  sequence: (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts)),
  set: (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts)),
  explicit: (index: number, content: Buffer) => tlv(0xa0 + index, content),
  integer: (value: number | Buffer) => {
    if (typeof value === 'number') {
      const bytes: number[] = [];
      let v = value;
      do {
        bytes.unshift(v & 0xff);
        v = Math.floor(v / 256);
      } while (v > 0);
      if ((bytes[0]! & 0x80) !== 0) bytes.unshift(0);
      return tlv(0x02, Buffer.from(bytes));
    }
    // DER INTEGERs must be minimal: a leading 0x00 is only legal when it keeps the
    // value positive. Random serials start with 0x00 once in 256, and OpenSSL rejects
    // such a certificate with "illegal padding" (found by a load test in Milestone B).
    let start = 0;
    while (start < value.length - 1 && value[start] === 0x00) start += 1;
    const minimal = value.subarray(start);
    const body = (minimal[0]! & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), minimal]) : minimal;
    return tlv(0x02, body);
  },
  null: () => tlv(0x05, Buffer.alloc(0)),
  oid: (value: string) => {
    const parts = value.split('.').map((part) => Number(part));
    const out: number[] = [parts[0]! * 40 + parts[1]!];
    for (const part of parts.slice(2)) {
      const stack: number[] = [part & 0x7f];
      let rest = Math.floor(part / 128);
      while (rest > 0) {
        stack.unshift((rest & 0x7f) | 0x80);
        rest = Math.floor(rest / 128);
      }
      out.push(...stack);
    }
    return tlv(0x06, Buffer.from(out));
  },
  utf8: (value: string) => tlv(0x0c, Buffer.from(value, 'utf8')),
  utcTime: (date: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const text =
      pad(date.getUTCFullYear() % 100) +
      pad(date.getUTCMonth() + 1) +
      pad(date.getUTCDate()) +
      pad(date.getUTCHours()) +
      pad(date.getUTCMinutes()) +
      pad(date.getUTCSeconds()) +
      'Z';
    return tlv(0x17, Buffer.from(text, 'ascii'));
  },
  bitString: (bytes: Buffer, unusedBits = 0) =>
    tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes])),
  octetString: (bytes: Buffer) => tlv(0x04, bytes),
  boolean: (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0x00])),
};

const OID = {
  commonName: '2.5.4.3',
  organizationName: '2.5.4.10',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

function name(commonName: string, organization: string): Buffer {
  return der.sequence(
    der.set(der.sequence(der.oid(OID.organizationName), der.utf8(organization))),
    der.set(der.sequence(der.oid(OID.commonName), der.utf8(commonName))),
  );
}

interface Extension {
  oid: string;
  critical: boolean;
  value: Buffer;
}

function extensionList(extensions: Extension[]): Buffer {
  return der.explicit(
    3,
    der.sequence(
      ...extensions.map((ext) =>
        der.sequence(
          der.oid(ext.oid),
          ...(ext.critical ? [der.boolean(true)] : []),
          der.octetString(ext.value),
        ),
      ),
    ),
  );
}

/** keyUsage bits: digitalSignature(0) + keyEncipherment(2) → 0b10100000. */
const KEY_USAGE = Buffer.from([0xa0]);
/** Bit string with 5 unused bits and the encoded IP as octets. */
function ipAddressBytes(ip: string): Buffer {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
    return Buffer.from(parts);
  }
  return Buffer.alloc(0);
}

export interface ServerCertificate {
  certPem: string;
  keyPem: string;
  /** SHA-256 of the DER certificate, upper-case hex — the value clients pin. */
  fingerprint: string;
  not_after: string;
  subject: string;
  sans: string[];
}

export interface CertificateOptions {
  commonName?: string;
  organization?: string;
  ips?: string[];
  dnsNames?: string[];
  days?: number;
  /** Deterministic serial for tests; a random 16-byte value otherwise. */
  serial?: Buffer;
}

/** Best-effort list of this machine's LAN IPv4 addresses. */
export function listLocalIpv4(): string[] {
  const out: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return [...new Set(out)];
}

/**
 * Creates a fresh self-signed server certificate. Never reuses a key implicitly:
 * a caller that wants a stable identity must persist and reuse the returned pair.
 */
export function generateServerCertificate(opts: CertificateOptions = {}): ServerCertificate {
  const commonName = opts.commonName ?? 'Sauda Main Server';
  const organization = opts.organization ?? 'Sauda Retail Suite';
  const ips = [...new Set(['127.0.0.1', ...(opts.ips ?? [])])].filter((ip) => ipAddressBytes(ip).length === 4);
  const dnsNames = [...new Set(['localhost', ...(opts.dnsNames ?? [])])];
  const days = opts.days ?? 365 * 5;
  const serial = opts.serial ?? crypto.randomBytes(16);
  const notBefore = new Date(Date.now() - 60 * 60 * 1000);
  const notAfter = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  const signatureAlgorithm = der.sequence(der.oid(OID.sha256WithRsa), der.null());

  const altNames = der.sequence(
    ...dnsNames.map((dns) => tlv(0x82, Buffer.from(dns, 'ascii'))),
    ...ips.filter((ip) => ip !== '127.0.0.1' || true).map((ip) => tlv(0x87, ipAddressBytes(ip))),
  );

  const tbs = der.sequence(
    der.explicit(0, der.integer(2)),
    der.integer(serial),
    signatureAlgorithm,
    name(commonName, organization),
    der.sequence(der.utcTime(notBefore), der.utcTime(notAfter)),
    name(commonName, organization),
    spki,
    extensionList([
      { oid: OID.basicConstraints, critical: true, value: der.sequence() },
      { oid: OID.keyUsage, critical: true, value: der.bitString(KEY_USAGE, 5) },
      { oid: OID.extKeyUsage, critical: false, value: der.sequence(der.oid(OID.serverAuth)) },
      { oid: OID.subjectAltName, critical: false, value: altNames },
    ]),
  );

  const signature = crypto.sign('sha256', tbs, privateKey);
  const certificate = der.sequence(tbs, signatureAlgorithm, der.bitString(signature));

  const certPem = toPem('CERTIFICATE', certificate);
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return {
    certPem,
    keyPem,
    fingerprint: fingerprintOf(certPem),
    not_after: notAfter.toISOString(),
    subject: `CN=${commonName}, O=${organization}`,
    sans: [...dnsNames, ...ips],
  };
}

function toPem(label: string, der_: Buffer): string {
  const base64 = der_.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

/** SHA-256 (upper hex) of a DER certificate buffer. */
export function fingerprintOfDer(derBody: Buffer): string {
  return crypto.createHash('sha256').update(derBody).digest('hex').toUpperCase();
}

/** SHA-256 (upper hex) of the DER certificate — the pin value. */
export function fingerprintOf(certPem: string): string {
  return fingerprintOfDer(pemToDer(certPem));
}

export function pemToDer(certPem: string): Buffer {
  const body = certPem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return Buffer.from(body, 'base64');
}

/**
 * Constant-time pin check. Returns a reason instead of throwing so the caller can
 * show the operator both fingerprints (the design forbids a silent fallback).
 */
export function checkPinnedFingerprint(
  certPem: string,
  pinnedFingerprint: string,
): { ok: boolean; actual?: string; code?: 'CERT_MISMATCH' | 'CERT_INVALID' } {
  try {
    const actual = fingerprintOf(certPem);
    const expected = String(pinnedFingerprint ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (!expected) return { ok: false, actual, code: 'CERT_INVALID' };
    if (actual.length !== expected.length) return { ok: false, actual, code: 'CERT_MISMATCH' };
    const same = crypto.timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
    return same ? { ok: true, actual } : { ok: false, actual, code: 'CERT_MISMATCH' };
  } catch {
    return { ok: false, code: 'CERT_INVALID' };
  }
}

/** Human-comparable short form, e.g. `A1B2-C3D4-E5F6-7788`. */
export function shortFingerprint(fingerprint: string): string {
  const hex = String(fingerprint ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return (hex.match(/.{1,4}/g) ?? []).slice(0, 4).join('-');
}
