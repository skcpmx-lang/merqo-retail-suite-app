import crypto from 'node:crypto';
import type { Db } from '../db/connection.js';
import { audit } from './audit.js';

/**
 * Device identity, enrolment, administrator approval, sessions and licensed capacity.
 *
 * Rules this service enforces (they are the heart of the v1.1.4 multi-PC model):
 *  1. The server is the only place a device becomes "approved"; a valid licence
 *     alone never grants access.
 *  2. Capacity comes from the *signed licence* of the Main PC, not from a
 *     constant in the code, and it is enforced when a device asks to enrol.
 *  3. Approval, rejection and revocation are audited with the deciding user.
 *  4. Device secrets and session tokens are stored as SHA-256 digests only.
 */

export type DeviceRole = 'SERVER_POS' | 'CLIENT_POS' | 'CLIENT_MANAGEMENT';
export type DeviceStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

export const DEVICE_ROLES: DeviceRole[] = ['SERVER_POS', 'CLIENT_POS', 'CLIENT_MANAGEMENT'];

export interface StoreIdentity {
  store_id: string;
  server_id: string;
  server_name: string;
  /** SHA-256 pin of the TLS certificate clients must expect (null until issued). */
  cert_fingerprint: string | null;
  created_at: string;
  updated_at: string;
}

export interface Terminal {
  device_id: string;
  device_name: string;
  role: DeviceRole;
  store_id: string;
  license_id: string | null;
  status: DeviceStatus;
  public_key: string | null;
  platform: string | null;
  app_version: string | null;
  fingerprint: string | null;
  requested_at: string;
  decided_at: string | null;
  decided_by: number | null;
  decision_note: string | null;
  last_seen: string | null;
  revoked_at: string | null;
}

export interface CapacitySummary {
  /** Devices the Main PC's licence allows (0 = licence not registered yet). */
  licensed: number;
  approved: number;
  pending: number;
  revoked: number;
  rejected: number;
  /** Slots that can still be approved. Never negative. */
  available: number;
}

export interface EnrolInput {
  device_id: string;
  device_name: string;
  role: DeviceRole;
  license_id: string;
  store_id: string;
  capacity?: number;
  edition?: string;
  issued_at: string;
  expires_at?: string | null;
  payload: unknown;
  platform?: string;
  app_version?: string;
  fingerprint?: string;
  public_key?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomId(prefix: string): string {
  const bytes = crypto.randomBytes(9);
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  return `${prefix}-${n.toString(36).toUpperCase().padStart(15, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Store identity                                                      */
/* ------------------------------------------------------------------ */

/** The one stable Store ID / Server ID pair that licences are bound to. */
export function getStoreIdentity(db: Db): StoreIdentity {
  const row = db.prepare('SELECT * FROM store_servers WHERE id = 1').get() as StoreIdentity | undefined;
  if (row) return row;
  const now = nowIso();
  const identity: StoreIdentity = {
    store_id: randomId('STORE'),
    server_id: randomId('SRV'),
    server_name: '',
    cert_fingerprint: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO store_servers (id, store_id, server_id, server_name, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)`,
  ).run(identity.store_id, identity.server_id, '', now, now);
  return identity;
}

export function renameServer(db: Db, name: string): StoreIdentity {
  const identity = getStoreIdentity(db);
  db.prepare('UPDATE store_servers SET server_name = ?, updated_at = ? WHERE id = 1').run(
    String(name ?? '').slice(0, 80),
    nowIso(),
  );
  return { ...identity, server_name: String(name ?? '').slice(0, 80) };
}

/** Records the TLS certificate fingerprint clients pin during pairing. */
export function setServerCertificate(db: Db, fingerprint: string): void {
  db.prepare('UPDATE store_servers SET cert_fingerprint = ?, updated_at = ? WHERE id = 1').run(
    fingerprint,
    nowIso(),
  );
}

/* ------------------------------------------------------------------ */
/* Capacity                                                            */
/* ------------------------------------------------------------------ */

/**
 * Capacity is the number on the *server's own* licence. When no licence has been
 * registered yet (a brand-new install) the answer is 0, which blocks enrolment
 * rather than silently allowing an unlimited shop.
 */
/** Hard ceiling for a licensed device count — a claim must never be able to inflate it. */
export const MAX_LICENSED_DEVICES = 100;

export function licensedCapacity(db: Db): number {
  const row = db
    .prepare(
      `SELECT capacity FROM device_licenses
        WHERE status = 'active' AND role = 'SERVER_POS'
        ORDER BY registered_at DESC, rowid DESC LIMIT 1`,
    )
    .get() as { capacity: number } | undefined;
  if (row) return Math.max(0, Number(row.capacity) || 0);
  // No SERVER_POS row yet (a freshly activated shop). The Main App's own activation row is
  // the authority then: it was written only after the licence signature verified, so its
  // capacity can be trusted. Without this fallback every client would hit NO_LICENSE.
  const activation = db
    .prepare("SELECT payload FROM activations ORDER BY rowid DESC LIMIT 1")
    .get() as { payload?: string } | undefined;
  if (!activation?.payload) return 0;
  try {
    const payload = JSON.parse(activation.payload) as { device_capacity?: unknown; max_devices?: unknown };
    const declared = Number(payload.device_capacity ?? payload.max_devices ?? 0);
    return Number.isFinite(declared) ? Math.max(0, Math.min(MAX_LICENSED_DEVICES, Math.trunc(declared))) : 0;
  } catch {
    return 0;
  }
}

/**
 * Role a remote device may claim while pairing.
 *
 * `SERVER_POS` is *not* claimable over the network: only the Main PC registers the shop's own
 * licence (locally, after activation), and the server role is what sets licensed capacity.
 * Accepting it from a LAN claim let any device with a pairing code install itself as the server
 * with an arbitrary capacity.
 */
export function validateClaimRole(raw: unknown): DeviceRole {
  const role = String(raw ?? 'CLIENT_POS');
  if (role === 'SERVER_POS') {
    throw new DeviceError('BAD_ROLE', 'সার্ভার ভূমিকা শুধু প্রধান কম্পিউটার নিজেই নিতে পারে।');
  }
  if (role !== 'CLIENT_POS' && role !== 'CLIENT_MANAGEMENT') {
    throw new DeviceError('BAD_ROLE', 'ডিভাইসের ভূমিকা সঠিক নয়।');
  }
  return role;
}

export function capacitySummary(db: Db): CapacitySummary {
  const counts = db
    .prepare('SELECT status, COUNT(*) AS n FROM terminals GROUP BY status')
    .all() as { status: DeviceStatus; n: number }[];
  const by = (status: DeviceStatus) => counts.find((c) => c.status === status)?.n ?? 0;
  const licensed = licensedCapacity(db);
  const approved = by('approved');
  const pending = by('pending');
  const revoked = by('revoked');
  const rejected = by('rejected');
  return {
    licensed,
    approved,
    pending,
    revoked,
    rejected,
    available: Math.max(0, licensed - approved - pending),
  };
}

/* ------------------------------------------------------------------ */
/* Enrolment                                                           */
/* ------------------------------------------------------------------ */

export class DeviceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'DeviceError';
  }
}

function terminalById(db: Db, deviceId: string): Terminal | null {
  return (db.prepare('SELECT * FROM terminals WHERE device_id = ?').get(deviceId) as Terminal) ?? null;
}

/**
 * A device presents a signed licence. The caller (API layer) must have verified
 * the signature already; this function enforces store binding, capacity, duplicate
 * enrolment and revocation, then creates a **pending** registration.
 *
 * Re-enrolling a revoked device does NOT quietly reset it: it stays revoked until
 * an administrator explicitly re-approves it.
 */
export function enrolDevice(db: Db, input: EnrolInput): Terminal {
  // The capacity check, the pending registration, the licence row and the audit line are one
  // state change. Written separately, a failure after the terminal row left a pending device
  // holding a seat with no licence behind it, and two enrolments racing the same "one slot left"
  // check could both be admitted. IMMEDIATE takes the write lock before the check, so the second
  // caller sees the first one's result instead of the same pre-check state.
  return db.transaction(() => enrolDeviceTx(db, input)).immediate();
}

function enrolDeviceTx(db: Db, input: EnrolInput): Terminal {
  const identity = getStoreIdentity(db);
  if (input.store_id !== identity.store_id) {
    throw new DeviceError('STORE_MISMATCH', 'এই ডিভাইসের লাইসেন্স অন্য দোকানের জন্য তৈরি।');
  }
  if (!DEVICE_ROLES.includes(input.role)) {
    throw new DeviceError('BAD_ROLE', 'ডিভাইসের ভূমিকা সঠিক নয়।');
  }
  if (!input.device_id || input.license_id === '') {
    throw new DeviceError('BAD_REQUEST', 'ডিভাইস আইডি বা লাইসেন্স আইডি নেই।');
  }

  const existing = terminalById(db, input.device_id);
  if (existing) {
    if (existing.status === 'revoked') {
      throw new DeviceError(
        'DEVICE_REVOKED',
        'এই ডিভাইসটি বাতিল করা হয়েছে — প্রশাসকের অনুমোদন ছাড়া আবার যুক্ত হবে না।',
      );
    }
    if (existing.status === 'approved') {
      // Re-registering the same device refreshes its metadata and licence.
      db.prepare(
        `UPDATE terminals SET device_name = ?, license_id = ?, app_version = ?, platform = ?,
            fingerprint = ?, public_key = COALESCE(?, public_key) WHERE device_id = ?`,
      ).run(
        input.device_name,
        input.license_id,
        input.app_version ?? null,
        input.platform ?? null,
        input.fingerprint ?? null,
        input.public_key ?? null,
        input.device_id,
      );
      registerLicense(db, input);
      return terminalById(db, input.device_id)!;
    }
    // Already pending / rejected: keep the newest metadata, stay unapproved.
    db.prepare(
      `UPDATE terminals SET device_name = ?, license_id = ?, requested_at = ?,
          app_version = ?, platform = ?, fingerprint = ? WHERE device_id = ?`,
    ).run(
      input.device_name,
      input.license_id,
      nowIso(),
      input.app_version ?? null,
      input.platform ?? null,
      input.fingerprint ?? null,
      input.device_id,
    );
    registerLicense(db, input);
    return terminalById(db, input.device_id)!;
  }

  // New device: capacity is checked *before* it becomes pending, so a full store
  // cannot accumulate unapprovable requests. The server's own licence (SERVER_POS)
  // is the one that counts as the first slot.
  const summary = capacitySummary(db);
  const isServer = input.role === 'SERVER_POS';
  // The Main PC registers the shop's own licence; every other device needs it first.
  if (summary.licensed === 0 && !isServer) {
    throw new DeviceError(
      'NO_LICENSE',
      'প্রধান কম্পিউটারের লাইসেন্স এখনো নিবন্ধিত হয়নি — ডিভাইস যুক্ত করা যাবে না।',
    );
  }
  if (!isServer && summary.approved + summary.pending >= summary.licensed) {
    throw new DeviceError(
      'CAPACITY_REACHED',
      `লাইসেন্সে ${summary.licensed}টি ডিভাইসের অনুমতি আছে — সব স্লট ব্যবহৃত।`,
    );
  }

  db.prepare(
    `INSERT INTO terminals (device_id, device_name, role, store_id, license_id, status,
        public_key, platform, app_version, fingerprint, requested_at)
     VALUES (?,?,?,?,?, 'pending', ?,?,?,?,?)`,
  ).run(
    input.device_id,
    input.device_name,
    input.role,
    input.store_id,
    input.license_id,
    input.public_key ?? null,
    input.platform ?? null,
    input.app_version ?? null,
    input.fingerprint ?? null,
    nowIso(),
  );
  registerLicense(db, input);
  audit(db, {
    action: 'device.enrol_requested',
    entity: 'terminal',
    entityId: input.device_id,
    details: { role: input.role, name: input.device_name, license_id: input.license_id },
  });
  return terminalById(db, input.device_id)!;
}

function registerLicense(db: Db, input: EnrolInput): void {
  db.prepare(
    `INSERT INTO device_licenses (license_id, store_id, device_id, role, capacity, edition,
        issued_at, expires_at, status, payload, registered_at)
     VALUES (?,?,?,?,?,?,?,?, 'active', ?, ?)
     ON CONFLICT(license_id) DO UPDATE SET
       device_id = excluded.device_id,
       role = excluded.role,
       capacity = excluded.capacity,
       expires_at = excluded.expires_at,
       payload = excluded.payload,
       status = CASE WHEN device_licenses.status = 'revoked' THEN 'revoked' ELSE 'active' END`,
  ).run(
    input.license_id,
    input.store_id,
    input.device_id,
    input.role,
    Math.max(1, Math.min(MAX_LICENSED_DEVICES, Math.trunc(Number(input.capacity) || 1))),
    input.edition ?? null,
    input.issued_at,
    input.expires_at ?? null,
    JSON.stringify(input.payload ?? {}),
    nowIso(),
  );
}

/* ------------------------------------------------------------------ */
/* Approval / rejection / revocation                                   */
/* ------------------------------------------------------------------ */

export interface Actor {
  id: number;
  username: string;
}

export function approveDevice(db: Db, deviceId: string, actor: Actor, note?: string): Terminal {
  const device = terminalById(db, deviceId);
  if (!device) throw new DeviceError('NOT_FOUND', 'ডিভাইস পাওয়া যায়নি।');
  if (device.status === 'approved') return device;
  if (device.status === 'revoked') {
    throw new DeviceError('DEVICE_REVOKED', 'বাতিল করা ডিভাইস আবার অনুমোদন করা যায় না — নতুন লাইসেন্স ইস্যু করুন।');
  }
  // Capacity check, approval and the audit line move together, under the write lock: approving two
  // pending devices into a single free slot must fail one of them, not admit both.
  const run = db.transaction((): void => {
    const summary = capacitySummary(db);
    if (summary.approved >= summary.licensed) {
      throw new DeviceError(
        'CAPACITY_REACHED',
        `লাইসেন্সে ${summary.licensed}টি ডিভাইসের অনুমতি আছে — নতুন স্লট ছাড়া অনুমোদন সম্ভব নয়।`,
      );
    }
    db.prepare(
      `UPDATE terminals SET status = 'approved', decided_at = ?, decided_by = ?, decision_note = ?
        WHERE device_id = ? AND status <> 'approved'`,
    ).run(nowIso(), actor.id, note ?? null, deviceId);
    audit(db, {
      action: 'device.approved',
      entity: 'terminal',
      entityId: deviceId,
      userId: actor.id,
      username: actor.username,
      details: { name: device.device_name, role: device.role },
    });
  });
  run.immediate();
  return terminalById(db, deviceId)!;
}

export function rejectDevice(db: Db, deviceId: string, actor: Actor, note?: string): Terminal {
  const device = terminalById(db, deviceId);
  if (!device) throw new DeviceError('NOT_FOUND', 'ডিভাইস পাওয়া যায়নি।');
  if (device.status === 'approved') {
    throw new DeviceError('ALREADY_APPROVED', 'অনুমোদিত ডিভাইস প্রত্যাখ্যান করতে হলে আগে বাতিল করুন।');
  }
  // Status and credentials change together: a device marked rejected while its secret and
  // sessions survive is a device that keeps working.
  const run = db.transaction((): void => {
    db.prepare(
      `UPDATE terminals SET status = 'rejected', decided_at = ?, decided_by = ?, decision_note = ?
        WHERE device_id = ?`,
    ).run(nowIso(), actor.id, note ?? null, deviceId);
    revokeCredentials(db, deviceId);
    audit(db, {
      action: 'device.rejected',
      entity: 'terminal',
      entityId: deviceId,
      userId: actor.id,
      username: actor.username,
      details: { name: device.device_name, note: note ?? null },
    });
  });
  run.immediate();
  return terminalById(db, deviceId)!;
}

/**
 * Revocation is immediate and permanent for that enrolment: credentials and every
 * session are destroyed, so a stolen client cannot keep talking to the server.
 */
export function revokeDevice(db: Db, deviceId: string, actor: Actor, reason: string): Terminal {
  const device = terminalById(db, deviceId);
  if (!device) throw new DeviceError('NOT_FOUND', 'ডিভাইস পাওয়া যায়নি।');
  if (!reason || !reason.trim()) throw new DeviceError('REASON_REQUIRED', 'বাতিলের কারণ লিখুন।');
  // Revocation is a security act: the status, the credential, every session and the licence row
  // must all change or none of them may. Half a revocation is a device that still authenticates.
  const run = db.transaction((): void => {
    db.prepare(
      `UPDATE terminals SET status = 'revoked', revoked_at = ?, decided_by = ?, decision_note = ?
        WHERE device_id = ?`,
    ).run(nowIso(), actor.id, reason.trim(), deviceId);
    revokeCredentials(db, deviceId);
    if (device.license_id) {
      db.prepare(
        `UPDATE device_licenses SET status = 'revoked', revoked_at = ?, revoke_reason = ?
          WHERE license_id = ?`,
      ).run(nowIso(), reason.trim(), device.license_id);
    }
    audit(db, {
      action: 'device.revoked',
      entity: 'terminal',
      entityId: deviceId,
      userId: actor.id,
      username: actor.username,
      details: { name: device.device_name, reason: reason.trim() },
    });
  });
  run.immediate();
  return terminalById(db, deviceId)!;
}

export function renameDevice(db: Db, deviceId: string, name: string, actor: Actor): Terminal {
  const device = terminalById(db, deviceId);
  if (!device) throw new DeviceError('NOT_FOUND', 'ডিভাইস পাওয়া যায়নি।');
  const clean = String(name ?? '').trim().slice(0, 60);
  if (!clean) throw new DeviceError('BAD_REQUEST', 'ডিভাইসের নাম দিন।');
  const run = db.transaction(() => {
    db.prepare('UPDATE terminals SET device_name = ? WHERE device_id = ?').run(clean, deviceId);
    audit(db, {
    action: 'device.renamed',
    entity: 'terminal',
      entityId: deviceId,
      userId: actor.id,
      username: actor.username,
      details: { from: device.device_name, to: clean },
    });
  });
  run();
  return terminalById(db, deviceId)!;
}

export function listDevices(db: Db, opts: { status?: DeviceStatus } = {}): Terminal[] {
  if (opts.status) {
    return db
      .prepare('SELECT * FROM terminals WHERE status = ? ORDER BY requested_at DESC')
      .all(opts.status) as Terminal[];
  }
  return db.prepare('SELECT * FROM terminals ORDER BY requested_at DESC').all() as Terminal[];
}

export function getDevice(db: Db, deviceId: string): Terminal | null {
  return terminalById(db, deviceId);
}

export function touchDevice(db: Db, deviceId: string): void {
  db.prepare('UPDATE terminals SET last_seen = ? WHERE device_id = ?').run(nowIso(), deviceId);
}

/* ------------------------------------------------------------------ */
/* Device credentials                                                  */
/* ------------------------------------------------------------------ */

/**
 * Issues (or rotates) the per-device API secret. The plaintext is returned to the
 * caller exactly once — only its digest is persisted.
 */
export function issueDeviceSecret(db: Db, deviceId: string): string {
  const device = terminalById(db, deviceId);
  if (!device) throw new DeviceError('NOT_FOUND', 'ডিভাইস পাওয়া যায়নি।');
  if (device.status !== 'approved') {
    throw new DeviceError('NOT_APPROVED', 'অনুমোদিত ডিভাইস ছাড়া ক্রেডেনশিয়াল দেওয়া হয় না।');
  }
  const secret = crypto.randomBytes(32).toString('hex');
  const now = nowIso();
  db.prepare(
    `INSERT INTO terminal_credentials (device_id, secret_hash, created_at)
     VALUES (?,?,?)
     ON CONFLICT(device_id) DO UPDATE SET secret_hash = excluded.secret_hash,
        rotated_at = ?, last_used = NULL`,
  ).run(deviceId, digest(secret), now, now);
  return secret;
}

/** Constant-time check of a presented device secret; also enforces approval. */
export function verifyDeviceSecret(db: Db, deviceId: string, secret: string): Terminal {
  const device = terminalById(db, deviceId);
  if (!device) throw new DeviceError('UNKNOWN_DEVICE', 'এই ডিভাইস নিবন্ধিত নয়।');
  if (device.status === 'revoked') throw new DeviceError('DEVICE_REVOKED', 'ডিভাইসটি বাতিল করা হয়েছে।');
  if (device.status !== 'approved') {
    throw new DeviceError('PENDING_APPROVAL', 'ডিভাইসটি এখনো প্রশাসকের অনুমোদনের অপেক্ষায়।');
  }
  const row = db
    .prepare('SELECT secret_hash FROM terminal_credentials WHERE device_id = ?')
    .get(deviceId) as { secret_hash: string } | undefined;
  const expected = Buffer.from(row?.secret_hash ?? '', 'utf8');
  const presented = Buffer.from(digest(String(secret ?? '')), 'utf8');
  const ok = expected.length === presented.length && crypto.timingSafeEqual(expected, presented);
  if (!ok) throw new DeviceError('BAD_CREDENTIAL', 'ডিভাইসের ক্রেডেনশিয়াল সঠিক নয়।');
  db.prepare('UPDATE terminal_credentials SET last_used = ? WHERE device_id = ?').run(nowIso(), deviceId);
  return device;
}

function revokeCredentials(db: Db, deviceId: string): void {
  db.prepare('DELETE FROM terminal_credentials WHERE device_id = ?').run(deviceId);
  db.prepare('UPDATE terminal_sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(
    nowIso(),
    deviceId,
  );
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

export interface DeviceSession {
  device_id: string;
  user_id: number;
  issued_at: string;
  last_seen: string;
  expires_at: string;
}

/** Creates a persisted session; returns the opaque token (stored as a digest). */
export function createDeviceSession(
  db: Db,
  input: { deviceId: string; userId: number; ttlMs?: number },
): string {
  const device = terminalById(db, input.deviceId);
  if (!device) throw new DeviceError('UNKNOWN_DEVICE', 'এই ডিভাইস নিবন্ধিত নয়।');
  if (device.status !== 'approved') throw new DeviceError('NOT_APPROVED', 'ডিভাইস অনুমোদিত নয়।');
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const ttl = input.ttlMs ?? 12 * 60 * 60 * 1000;
  db.prepare(
    `INSERT INTO terminal_sessions (id, device_id, user_id, issued_at, last_seen, expires_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(tokenDigest(token), input.deviceId, input.userId, now.toISOString(), now.toISOString(), new Date(now.getTime() + ttl).toISOString());
  return token;
}

export function tokenDigest(token: string): string {
  return digest(token);
}

/**
 * Validates a session token and slides its expiry. Expired or revoked sessions
 * fail closed, and a device that was revoked mid-session loses access immediately.
 */
export function validateDeviceSession(db: Db, token: string): DeviceSession & { device: Terminal } {
  const digestHex = tokenDigest(String(token ?? ''));
  const row = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get(digestHex) as
    | (DeviceSession & { id: string; revoked_at: string | null })
    | undefined;
  if (!row) throw new DeviceError('AUTH_REQUIRED', 'সেশন পাওয়া যায়নি — আবার লগইন করুন।');
  if (row.revoked_at) throw new DeviceError('SESSION_REVOKED', 'সেশন বাতিল হয়েছে — আবার লগইন করুন।');
  if (Date.parse(row.expires_at) <= Date.now()) {
    throw new DeviceError('SESSION_EXPIRED', 'সেশনের সময় শেষ — আবার লগইন করুন।');
  }
  const device = terminalById(db, row.device_id);
  if (!device || device.status !== 'approved') {
    throw new DeviceError('DEVICE_REVOKED', 'ডিভাইসটি আর অনুমোদিত নয়।');
  }
  const now = new Date();
  db.prepare('UPDATE terminal_sessions SET last_seen = ? WHERE id = ?').run(now.toISOString(), digestHex);
  db.prepare('UPDATE terminals SET last_seen = ? WHERE device_id = ?').run(now.toISOString(), device.device_id);
  return {
    device_id: row.device_id,
    user_id: row.user_id,
    issued_at: row.issued_at,
    last_seen: row.last_seen,
    expires_at: row.expires_at,
    device,
  };
}

export function revokeDeviceSession(db: Db, token: string): void {
  db.prepare('UPDATE terminal_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
    nowIso(),
    tokenDigest(token),
  );
}

export function activeSessions(db: Db): { device_id: string; user_id: number; last_seen: string }[] {
  return db
    .prepare(
      `SELECT device_id, user_id, last_seen FROM terminal_sessions
        WHERE revoked_at IS NULL AND expires_at > ? ORDER BY last_seen DESC`,
    )
    .all(nowIso()) as { device_id: string; user_id: number; last_seen: string }[];
}

export function pruneSessions(db: Db): number {
  const result = db
    .prepare('DELETE FROM terminal_sessions WHERE expires_at <= ? AND revoked_at IS NOT NULL')
    .run(nowIso());
  return result.changes;
}

/* ------------------------------------------------------------------ */
/* Pairing tokens                                                      */
/* ------------------------------------------------------------------ */

export interface PairingCode {
  /** Short human-readable code shown next to the QR. */
  code: string;
  expires_at: string;
}

/**
 * A pairing code is short-lived (2 minutes by default) and single-use. The QR only
 * carries the code + server address, never a reusable password.
 */
export function createPairingToken(
  db: Db,
  opts: { ttlMs?: number; createdBy?: number | null } = {},
): PairingCode {
  const code = crypto.randomBytes(24).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + (opts.ttlMs ?? 2 * 60 * 1000));
  db.prepare(
    'INSERT INTO pairing_tokens (token_hash, created_at, expires_at, created_by) VALUES (?,?,?,?)',
  ).run(tokenDigest(code), now.toISOString(), expires.toISOString(), opts.createdBy ?? null);
  return { code, expires_at: expires.toISOString() };
}

/** Consumes a pairing code exactly once. A replay or an expired code fails. */
export function consumePairingToken(db: Db, code: string, deviceId: string): void {
  const hash = tokenDigest(String(code ?? ''));
  const row = db.prepare('SELECT * FROM pairing_tokens WHERE token_hash = ?').get(hash) as
    | { expires_at: string; used_at: string | null }
    | undefined;
  if (!row) throw new DeviceError('PAIRING_INVALID', 'পেয়ারিং কোড সঠিক নয়।');
  if (row.used_at) throw new DeviceError('PAIRING_USED', 'এই পেয়ারিং কোড আগেই ব্যবহৃত হয়েছে।');
  if (Date.parse(row.expires_at) <= Date.now()) {
    throw new DeviceError('PAIRING_EXPIRED', 'পেয়ারিং কোডের সময় শেষ — নতুন কোড নিন।');
  }
  const result = db
    .prepare('UPDATE pairing_tokens SET used_at = ?, used_by = ? WHERE token_hash = ? AND used_at IS NULL')
    .run(new Date().toISOString(), deviceId, hash);
  if (result.changes !== 1) throw new DeviceError('PAIRING_USED', 'এই পেয়ারিং কোড আগেই ব্যবহৃত হয়েছে।');
}

export function prunePairingTokens(db: Db): number {
  return db.prepare('DELETE FROM pairing_tokens WHERE expires_at <= ?').run(nowIso()).changes;
}
