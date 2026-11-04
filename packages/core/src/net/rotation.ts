import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/connection.js';
import { fingerprintOf, generateServerCertificate } from './certificate.js';
import { loadOrCreateServerIdentity, type ServerIdentity } from './certificate-store.js';

/**
 * Authenticated, crash-safe certificate rotation (Phase 3, Priority 1).
 *
 * Replacing the server certificate is the one operation that can hand a shop to an
 * impostor, so it is deliberately hard:
 *
 *  1. **An administrator authorises it first.** `authorizeRotation()` writes a row
 *     into `cert_rotations` naming the fingerprint that is being replaced. Without
 *     that row, `beginRotation()` refuses. There is no code path that rotates a
 *     certificate silently, and none that rotates on startup.
 *  2. **The old pair is never destroyed.** It is renamed aside with a timestamp.
 *  3. **A journal makes the swap recoverable at every step.** If the process dies
 *     between the two renames, `recoverRotation()` finishes or aborts the swap and
 *     reports which happened — it never leaves the machine in a half-rotated state
 *     where the app would "helpfully" generate yet another identity.
 *  4. **Clients keep failing closed.** A paired client is pinned to the old
 *     fingerprint; it rejects the new certificate until an administrator re-pairs
 *     it. Rotation never notifies clients implicitly and there is no "trust on
 *     rotation" path.
 */

export type RotationErrorCode =
  | 'ROTATION_UNAUTHORIZED'
  | 'ROTATION_IN_PROGRESS'
  | 'ROTATION_NOT_FOUND'
  | 'ROTATION_UNRECOVERABLE'
  | 'IDENTITY_MISSING';

export class RotationError extends Error {
  code: RotationErrorCode;
  constructor(code: RotationErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'RotationError';
  }
}

export interface RotationJournal {
  version: 1;
  state: 'prepared' | 'swapped';
  old_fingerprint: string;
  new_fingerprint: string;
  started_at: string;
  reason: string;
  backup_stamp: string;
}

const JOURNAL = 'rotation.json';
const NEXT_CERT = 'server.crt.next';
const NEXT_KEY = 'server.key.next';

function journalPath(dir: string): string {
  return path.join(dir, JOURNAL);
}

function readJournal(dir: string): RotationJournal | null {
  const file = journalPath(dir);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as RotationJournal;
    if (!parsed.old_fingerprint || !parsed.new_fingerprint || !parsed.state) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeJournal(dir: string, journal: RotationJournal): void {
  const file = journalPath(dir);
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(journal, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function clearJournal(dir: string): void {
  fs.rmSync(journalPath(dir), { force: true });
}

/** True when a valid certificate/key pair exists at the given paths. */
function pairAt(certPath: string, keyPath: string): { certPem: string; keyPem: string; fingerprint: string } | null {
  try {
    const certPem = fs.readFileSync(certPath, 'utf8');
    const keyPem = fs.readFileSync(keyPath, 'utf8');
    const derived = crypto
      .createPublicKey(crypto.createPrivateKey(keyPem))
      .export({ type: 'spki', format: 'der' })
      .toString('base64');
    const embedded = Buffer.from(new crypto.X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' })).toString(
      'base64',
    );
    if (derived !== embedded) return null;
    return { certPem, keyPem, fingerprint: fingerprintOf(certPem) };
  } catch {
    return null;
  }
}

/**
 * Step 1 — an administrator approves replacing `oldFingerprint`.
 * Returns the id used by `beginRotation`/`commitRotation`.
 */
export function authorizeRotation(
  db: Db,
  opts: { oldFingerprint: string; reason: string; adminUserId?: number | null; now?: Date },
): number {
  const reason = String(opts.reason ?? '').trim();
  if (!reason) throw new RotationError('ROTATION_UNAUTHORIZED', 'সার্টিফিকেট বদলের কারণ লিখতে হবে।');
  const now = (opts.now ?? new Date()).toISOString();
  const info = db
    .prepare(
      `INSERT INTO cert_rotations (old_fingerprint, reason, authorized_by, state, started_at)
       VALUES (?,?,?,'pending',?)`,
    )
    .run(opts.oldFingerprint, reason, opts.adminUserId ?? null, now);
  return Number(info.lastInsertRowid);
}

function rotationRow(
  db: Db,
  id: number,
): { id: number; old_fingerprint: string; state: string } | undefined {
  return db
    .prepare('SELECT id, old_fingerprint, state FROM cert_rotations WHERE id = ?')
    .get(id) as { id: number; old_fingerprint: string; state: string } | undefined;
}

/**
 * Step 2 — prepare the replacement. The current identity must still be the one the
 * administrator authorised, and no rotation may already be in flight.
 */
export function beginRotation(opts: {
  dir: string;
  db: Db;
  rotationId: number;
  ips?: string[];
  reason?: string;
}): { journal: RotationJournal; newFingerprint: string } {
  const row = rotationRow(opts.db, opts.rotationId);
  if (!row || row.state !== 'pending') {
    throw new RotationError('ROTATION_UNAUTHORIZED', 'এই সার্টিফিকেট বদল প্রশাসক অনুমোদন করেননি।');
  }
  if (readJournal(opts.dir)) {
    throw new RotationError(
      'ROTATION_IN_PROGRESS',
      'একটি বদল আগেই শুরু হয়েছে — আগে সেটি সম্পন্ন বা বাতিল করতে হবে।',
    );
  }
  let current: ServerIdentity;
  try {
    current = loadOrCreateServerIdentity({ dir: opts.dir, allowCreate: false });
  } catch {
    throw new RotationError('IDENTITY_MISSING', 'বর্তমান সার্টিফিকেট পাওয়া যায়নি — বদল করা যাবে না।');
  }
  if (current.fingerprint !== row.old_fingerprint.replace(/[^0-9a-fA-F]/g, '').toUpperCase()) {
    throw new RotationError(
      'ROTATION_UNAUTHORIZED',
      'বর্তমান সার্টিফিকেট অনুমোদিত পুরোনো সার্টিফিকেটের সাথে মেলে না।',
    );
  }

  const generated = generateServerCertificate({ ips: opts.ips });
  fs.mkdirSync(opts.dir, { recursive: true });
  // Key first, then certificate, so `.next` is never a certificate without a key.
  fs.writeFileSync(path.join(opts.dir, NEXT_KEY), generated.keyPem, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(path.join(opts.dir, NEXT_KEY), 0o600);
  } catch {
    /* Windows: profile ACL applies. */
  }
  fs.writeFileSync(path.join(opts.dir, NEXT_CERT), generated.certPem, { encoding: 'utf8' });

  const journal: RotationJournal = {
    version: 1,
    state: 'prepared',
    old_fingerprint: current.fingerprint,
    new_fingerprint: generated.fingerprint,
    started_at: new Date().toISOString(),
    reason: opts.reason ?? 'administrator approved rotation',
    backup_stamp: new Date().toISOString().replace(/[:.]/g, '-'),
  };
  writeJournal(opts.dir, journal);
  return { journal, newFingerprint: generated.fingerprint };
}

/**
 * Step 3 — perform the swap. Safe to call once the journal says `prepared`.
 */
export function commitRotation(opts: { dir: string; db?: Db; rotationId?: number }): ServerIdentity {
  const journal = readJournal(opts.dir);
  if (!journal) throw new RotationError('ROTATION_NOT_FOUND', 'কোনো চলমান বদল নেই।');
  const next = pairAt(path.join(opts.dir, NEXT_CERT), path.join(opts.dir, NEXT_KEY));
  if (!next || next.fingerprint !== journal.new_fingerprint) {
    clearJournal(opts.dir);
    fs.rmSync(path.join(opts.dir, NEXT_CERT), { force: true });
    fs.rmSync(path.join(opts.dir, NEXT_KEY), { force: true });
    markRotation(opts.db, opts.rotationId, 'aborted', 'new identity was unreadable');
    throw new RotationError(
      'ROTATION_UNRECOVERABLE',
      'নতুন সার্টিফিকেট সঠিকভাবে তৈরি হয়নি — পুরোনো পরিচয় অপরিবর্তিত রাখা হয়েছে।',
    );
  }
  const certPath = path.join(opts.dir, 'server.crt');
  const keyPath = path.join(opts.dir, 'server.key');
  // Move the old pair aside *before* removing the journal, so a crash is always
  // discoverable; the old files are backups, never used for serving.
  for (const file of [certPath, keyPath]) {
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.${journal.backup_stamp}.old`);
  }
  writeJournal(opts.dir, { ...journal, state: 'swapped' });

  fs.renameSync(path.join(opts.dir, NEXT_CERT), certPath);
  fs.renameSync(path.join(opts.dir, NEXT_KEY), keyPath);

  const identity = loadOrCreateServerIdentity({ dir: opts.dir, allowCreate: false, expectedFingerprint: journal.new_fingerprint });
  clearJournal(opts.dir);
  markRotation(opts.db, opts.rotationId, 'completed', null, journal.new_fingerprint);
  return { ...identity, created: false };
}

/**
 * Called on every boot before the server starts. Finishes an interrupted rotation
 * or aborts it, and reports what happened. Never generates a new identity.
 */
export function recoverRotation(opts: { dir: string; db?: Db; rotationId?: number }): {
  state: 'none' | 'completed' | 'aborted';
  fingerprint: string | null;
} {
  const journal = readJournal(opts.dir);
  if (!journal) {
    const existing = pairAt(path.join(opts.dir, 'server.crt'), path.join(opts.dir, 'server.key'));
    return { state: 'none', fingerprint: existing?.fingerprint ?? null };
  }
  const current = pairAt(path.join(opts.dir, 'server.crt'), path.join(opts.dir, 'server.key'));
  const next = pairAt(path.join(opts.dir, NEXT_CERT), path.join(opts.dir, NEXT_KEY));

  // The swap already reached the new identity.
  if (current && current.fingerprint === journal.new_fingerprint) {
    cleanupNext(opts.dir);
    clearJournal(opts.dir);
    markRotation(opts.db, opts.rotationId, 'completed', 'recovered after interruption', journal.new_fingerprint);
    return { state: 'completed', fingerprint: current.fingerprint };
  }

  // Nothing usable to roll forward with: keep the old identity, mark the attempt aborted.
  if (!next || next.fingerprint !== journal.new_fingerprint) {
    cleanupNext(opts.dir);
    clearJournal(opts.dir);
    markRotation(opts.db, opts.rotationId, 'aborted', 'new identity missing or corrupt', null);
    return { state: 'aborted', fingerprint: current?.fingerprint ?? null };
  }

  // Roll forward: current is either still the old pair, or already moved aside.
  for (const file of ['server.crt', 'server.key']) {
    const from = path.join(opts.dir, file);
    if (fs.existsSync(from)) fs.renameSync(from, `${from}.${journal.backup_stamp}.old`);
  }
  fs.renameSync(path.join(opts.dir, NEXT_CERT), path.join(opts.dir, 'server.crt'));
  fs.renameSync(path.join(opts.dir, NEXT_KEY), path.join(opts.dir, 'server.key'));
  const identity = pairAt(path.join(opts.dir, 'server.crt'), path.join(opts.dir, 'server.key'));
  if (!identity || identity.fingerprint !== journal.new_fingerprint) {
    throw new RotationError('ROTATION_UNRECOVERABLE', 'বদল পুনরুদ্ধার করা যায়নি — প্রশাসকের হস্তক্ষেপ দরকার।');
  }
  clearJournal(opts.dir);
  markRotation(opts.db, opts.rotationId, 'completed', 'recovered after interruption', journal.new_fingerprint);
  return { state: 'completed', fingerprint: identity.fingerprint };
}

/** Journal snapshot for diagnostics (no secrets). */
export function rotationStatus(dir: string): { pending: boolean; journal: RotationJournal | null } {
  const journal = readJournal(dir);
  return { pending: Boolean(journal), journal };
}

function cleanupNext(dir: string): void {
  fs.rmSync(path.join(dir, NEXT_CERT), { force: true });
  fs.rmSync(path.join(dir, NEXT_KEY), { force: true });
}

function markRotation(
  db: Db | undefined,
  rotationId: number | undefined,
  state: 'completed' | 'aborted',
  note: string | null,
  newFingerprint?: string | null,
): void {
  if (!db || !rotationId) return;
  db.prepare(
    `UPDATE cert_rotations
        SET state = ?, completed_at = ?, note = ?, new_fingerprint = COALESCE(?, new_fingerprint)
      WHERE id = ?`,
  ).run(state, new Date().toISOString(), note, newFingerprint ?? null, rotationId);
}
