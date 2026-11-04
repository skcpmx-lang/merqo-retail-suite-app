import fs from 'node:fs';
import path from 'node:path';
import { generateServerCertificate, fingerprintOf, pemToDer } from './certificate.js';

/**
 * Persistent server identity (Phase 3, Milestone B).
 *
 * A Main PC must present the *same* certificate fingerprint across restarts,
 * otherwise every paired client silently has to re-trust the machine — which is
 * exactly the behaviour that would let an impostor take over a shop by simply
 * restarting with a new key.
 *
 * Therefore:
 *  - the certificate is created once and written to `<dir>/server.crt` + `server.key`
 *    (key file mode 0600; on Windows the file inherits the per-user profile ACL,
 *    which is the same protection the database already relies on);
 *  - a second call with the files present reuses them and returns the same pin;
 *  - a **missing** identity is only created when the caller explicitly allows it
 *    (`allowCreate`) — a boot-time load never silently mints a new authority;
 *  - a corrupt file, a key/cert mismatch or a fingerprint that disagrees with the
 *    recorded identity is an error the operator has to resolve, never a silent
 *    regeneration.
 */

export type IdentityErrorCode =
  | 'IDENTITY_MISSING'
  | 'IDENTITY_CORRUPT'
  | 'IDENTITY_MISMATCH'
  | 'IDENTITY_READ_FAILED';

export class IdentityError extends Error {
  code: IdentityErrorCode;
  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'IdentityError';
  }
}

export interface ServerIdentity {
  certPem: string;
  keyPem: string;
  fingerprint: string;
  created: boolean;
}

export interface LoadIdentityOptions {
  /** Directory that holds `server.crt` / `server.key`. */
  dir: string;
  /** Create a new identity when none exists (first run / explicit admin action). */
  allowCreate?: boolean;
  /** Certificate options forwarded to the generator. */
  commonName?: string;
  organization?: string;
  ips?: string[];
  days?: number;
  /** Fingerprint the caller expects; a mismatch is refused. */
  expectedFingerprint?: string;
}

const CERT_FILE = 'server.crt';
const KEY_FILE = 'server.key';

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new IdentityError('IDENTITY_READ_FAILED', `সার্ভার সার্টিফিকেট পড়া যায়নি: ${(err as Error).message}`);
  }
}

/** True when a certificate/key pair exists on disk (no parsing). */
export function identityExists(dir: string): boolean {
  return fs.existsSync(path.join(dir, CERT_FILE)) && fs.existsSync(path.join(dir, KEY_FILE));
}

/**
 * Loads the persisted identity, or creates it when `allowCreate` is set.
 * Never regenerates over an existing pair.
 */
export function loadOrCreateServerIdentity(opts: LoadIdentityOptions): ServerIdentity {
  const dir = opts.dir;
  const certPath = path.join(dir, CERT_FILE);
  const keyPath = path.join(dir, KEY_FILE);
  const certPem = readIfExists(certPath);
  const keyPem = readIfExists(keyPath);

  if (certPem && keyPem) {
    let fingerprint: string;
    try {
      fingerprint = fingerprintOf(certPem);
    } catch {
      throw new IdentityError(
        'IDENTITY_CORRUPT',
        'সার্ভার সার্টিফিকেট ফাইল নষ্ট — প্রশাসকের অনুমোদিত পুনরুদ্ধার বা নতুন পেয়ারিং ছাড়া ব্যবহার করা যাবে না।',
      );
    }
    // The key must belong to the certificate; otherwise TLS would fail later in a
    // far less obvious place.
    try {
      const { createPrivateKey, createPublicKey } = requireCrypto();
      const derived = createPublicKey(createPrivateKey(keyPem)).export({ type: 'spki', format: 'der' });
      const embedded = Buffer.from(
        new (requireCrypto().X509Certificate)(certPem).publicKey.export({ type: 'spki', format: 'der' }),
      );
      if (!derived.equals(embedded)) {
        throw new IdentityError(
          'IDENTITY_MISMATCH',
          'সার্ভারের সার্টিফিকেট ও প্রাইভেট কী একে অন্যের নয় — এটি নিজে থেকে ঠিক করা হবে না।',
        );
      }
    } catch (err) {
      if (err instanceof IdentityError) throw err;
      throw new IdentityError('IDENTITY_CORRUPT', `সার্ভার কী পড়া যায়নি: ${(err as Error).message}`);
    }
    if (opts.expectedFingerprint && opts.expectedFingerprint.replace(/[^0-9a-fA-F]/g, '').toUpperCase() !== fingerprint) {
      throw new IdentityError(
        'IDENTITY_MISMATCH',
        `সার্ভারের পরিচয় বদলে গেছে (প্রত্যাশিত ${opts.expectedFingerprint.slice(0, 8)}…, পাওয়া ${fingerprint.slice(0, 8)}…) — নতুন পেয়ারিং ছাড়া সংযোগ করা যাবে না।`,
      );
    }
    return { certPem, keyPem, fingerprint, created: false };
  }

  // One file without the other is a half-written state; refuse to guess.
  if (certPem || keyPem) {
    throw new IdentityError(
      'IDENTITY_CORRUPT',
      'সার্ভারের সার্টিফিকেট ও কী ফাইলের একটি অনুপস্থিত — প্রশাসকের হস্তক্ষেপ দরকার।',
    );
  }
  if (!opts.allowCreate) {
    throw new IdentityError(
      'IDENTITY_MISSING',
      'সার্ভারের কোনো পরিচয় নেই — প্রথমবার সার্ভার চালু করলে এটি তৈরি হবে।',
    );
  }

  const created = generateServerCertificate({
    commonName: opts.commonName,
    organization: opts.organization,
    ips: opts.ips,
  });
  fs.mkdirSync(dir, { recursive: true });
  // Write the key first with restrictive permissions so the certificate never
  // exists without a key and the key is never world-readable on POSIX.
  fs.writeFileSync(keyPath, created.keyPem, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    /* Windows ignores POSIX modes; the profile ACL applies instead. */
  }
  fs.writeFileSync(certPath, created.certPem, { encoding: 'utf8' });
  return { certPem: created.certPem, keyPem: created.keyPem, fingerprint: created.fingerprint, created: true };
}

/** Explicit, audited replacement: moves the old pair aside instead of deleting it. */
export function rotateServerIdentity(dir: string, options: Omit<LoadIdentityOptions, 'dir' | 'allowCreate'> = {}): ServerIdentity {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const file of [CERT_FILE, KEY_FILE]) {
    const from = path.join(dir, file);
    if (fs.existsSync(from)) fs.renameSync(from, `${from}.${stamp}.old`);
  }
  return loadOrCreateServerIdentity({ ...options, dir, allowCreate: true });
}

/** Exposed for tests: DER length of the certificate (sanity check on the parser). */
export function certificateByteLength(certPem: string): number {
  return pemToDer(certPem).length;
}

function requireCrypto(): typeof import('node:crypto') {
  // Kept in a helper so the module has a single crypto import site.
  return cryptoModule;
}

import cryptoModule from 'node:crypto';
