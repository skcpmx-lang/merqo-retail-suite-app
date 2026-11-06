import crypto from 'node:crypto';
import type { Db } from '../db/connection.js';
import type { User, UserRole } from '../domain/types.js';
import { normalizeText } from '../domain/text.js';
import { nowLocal, nowUtc } from '../domain/datetime.js';
import { audit } from './audit.js';

export const ALL_PERMISSIONS = [
  'pos.sell',
  'pos.discount',
  'pos.price_edit',
  'product.view',
  'product.manage',
  'product.delete',
  'stock.adjust',
  'purchase.manage',
  'customer.manage',
  'supplier.manage',
  'expense.manage',
  'cash.manage',
  'return.manage',
  'report.view',
  'settings.manage',
  'user.manage',
  'backup.manage',
  'license.manage',
  'audit.view',
  'accounting.view',
  'accounting.manage',
  'stock.transfer',
  'stock.count',
  'loyalty.manage',
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  'pos.sell': 'বিক্রয় (POS)',
  'pos.discount': 'ডিসকাউন্ট প্রয়োগ',
  'pos.price_edit': 'বিক্রয়ের সময় দাম পরিবর্তন',
  'product.view': 'প্রোডাক্ট দেখা',
  'product.manage': 'প্রোডাক্ট যোগ/সম্পাদনা',
  'product.delete': 'প্রোডাক্ট ডিলিট',
  'stock.adjust': 'স্টক সমন্বয়',
  'purchase.manage': 'পারচেজ ব্যবস্থাপনা',
  'customer.manage': 'কাস্টমার ব্যবস্থাপনা',
  'supplier.manage': 'সাপ্লায়ার ব্যবস্থাপনা',
  'expense.manage': 'এক্সপেন্স ব্যবস্থাপনা',
  'cash.manage': 'ক্যাশ রেজিস্টার',
  'return.manage': 'রিটার্ন ও রিফান্ড',
  'report.view': 'রিপোর্ট দেখা',
  'settings.manage': 'সেটিংস পরিবর্তন',
  'user.manage': 'ইউজার ব্যবস্থাপনা',
  'backup.manage': 'ব্যাকআপ ও রিস্টোর',
  'license.manage': 'লাইসেন্স ব্যবস্থাপনা',
  'audit.view': 'অডিট লগ দেখা',
  'accounting.view': 'হিসাব ও রিপোর্ট দেখা (ডাবল-এন্ট্রি)',
  'accounting.manage': 'হিসাব এন্ট্রি ও কোহা পরিচালনা',
  'stock.transfer': 'স্টক ট্রান্সফার',
  'stock.count': 'স্টক গণনা (ফিজিক্যাল কাউন্ট)',
  'loyalty.manage': 'লয়্যালটি পয়েন্ট ব্যবস্থাপনা',
};

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'অ্যাডমিন',
  manager: 'ম্যানেজার',
  cashier: 'ক্যাশিয়ার',
};

export const DEFAULT_ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: [...ALL_PERMISSIONS],
  manager: [
    'pos.sell',
    'pos.discount',
    'pos.price_edit',
    'product.view',
    'product.manage',
    'stock.adjust',
    'purchase.manage',
    'customer.manage',
    'supplier.manage',
    'expense.manage',
    'cash.manage',
    'return.manage',
    'report.view',
    'backup.manage',
    'audit.view',
    'accounting.view',
    'stock.transfer',
    'stock.count',
    'loyalty.manage',
  ],
  cashier: ['pos.sell', 'pos.discount', 'product.view', 'customer.manage', 'cash.manage'],
};

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const useSalt = salt ?? crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, useSalt, SCRYPT_KEYLEN, SCRYPT_OPTS).toString('hex');
  return { hash, salt: useSalt };
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function validatePasswordStrength(password: string): void {
  if (!password || password.length < 6) throw new Error('পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।');
  if (password.length > 128) throw new Error('পাসওয়ার্ড ১২৮ অক্ষরের বেশি হতে পারবে না।');
}

/**
 * The only columns that may ever leave this module.
 *
 * v1.1.3 security fix: `SELECT *` + `{ ...row }` used to put `password_hash` and
 * `password_salt` into every login/user IPC response, the renderer state and any
 * dump of it. The public DTO is now built field by field, and the credential
 * columns are read only by the two functions that must (login + own-password
 * change), through `getCredentialRow()`.
 */
export const USER_PUBLIC_COLUMNS =
  'id, username, full_name, role, permissions, is_active, created_at, updated_at, last_login_at';

/** Internal shape that includes the credential columns — never returned publicly. */
export interface UserCredentialRow {
  id: number;
  username: string;
  full_name: string;
  role: UserRole;
  permissions: string;
  is_active: 0 | 1;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  password_hash: string;
  password_salt: string;
}

function parsePermissions(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Explicit allow-list mapping. Anything not named here cannot leak, even if a
 * future schema adds a secret column to `users`.
 */
function rowToUser(row: Record<string, unknown>): User {
  return {
    id: Number(row.id),
    username: String(row.username ?? ''),
    full_name: String(row.full_name ?? ''),
    role: row.role as UserRole,
    permissions: parsePermissions(row.permissions),
    is_active: (Number(row.is_active) === 1 ? 1 : 0) as 0 | 1,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
    last_login_at: row.last_login_at ? String(row.last_login_at) : null,
  };
}

export function userCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c;
}

export function listUsers(db: Db): User[] {
  const rows = db
    .prepare(`SELECT ${USER_PUBLIC_COLUMNS} FROM users ORDER BY role, full_name`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToUser);
}

export function getUser(db: Db, id: number): User | null {
  const row = db.prepare(`SELECT ${USER_PUBLIC_COLUMNS} FROM users WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToUser(row) : null;
}

/** Credential lookup — internal to authentication flows only. Not exported publicly. */
function getCredentialRow(db: Db, username: string): UserCredentialRow | null {
  return (
    (db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(normalizeText(username)) as
      | UserCredentialRow
      | undefined) ?? null
  );
}

function getCredentialRowById(db: Db, id: number): UserCredentialRow | null {
  return (db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserCredentialRow | undefined) ?? null;
}

/** True when a username is already taken (used by user creation and CSV import). */
export function usernameExists(db: Db, username: string): boolean {
  return getCredentialRow(db, username) !== null;
}

export interface CreateUserInput {
  username: string;
  fullName: string;
  password: string;
  role: UserRole;
  permissions?: string[];
  actor?: { id: number; username: string } | null;
}

export function createUser(db: Db, input: CreateUserInput): User {
  const username = normalizeText(input.username).toLowerCase();
  const fullName = normalizeText(input.fullName);
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw new Error('ইউজারনেম ৩–৩২ অক্ষরের ইংরেজি ছোট হাতের অক্ষর বা সংখ্যা হতে হবে (a-z, 0-9, . _ -)।');
  }
  if (!fullName) throw new Error('পুরো নাম দিতে হবে।');
  validatePasswordStrength(input.password);
  if (!['admin', 'manager', 'cashier'].includes(input.role)) throw new Error('রোল সঠিক নয়।');
  if (usernameExists(db, username)) throw new Error('এই ইউজারনেম আগেই ব্যবহৃত হয়েছে।');

  const perms = input.permissions ?? DEFAULT_ROLE_PERMISSIONS[input.role];
  const { hash, salt } = hashPassword(input.password);
  const now = nowLocal();
  const res = db
    .prepare(
      `INSERT INTO users (username, full_name, role, password_hash, password_salt, permissions, is_active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,1,?,?)`,
    )
    .run(username, fullName, input.role, hash, salt, JSON.stringify(perms), now, now);
  audit(db, {
    userId: input.actor?.id ?? null,
    username: input.actor?.username ?? 'system',
    action: 'user.create',
    entity: 'user',
    entityId: Number(res.lastInsertRowid),
    details: { username, role: input.role },
  });
  return getUser(db, Number(res.lastInsertRowid))!;
}

export function updateUser(
  db: Db,
  id: number,
  patch: { fullName?: string; role?: UserRole; permissions?: string[]; isActive?: boolean },
  actor?: { id: number; username: string } | null,
): User {
  const existing = getUser(db, id);
  if (!existing) throw new Error('ইউজার পাওয়া যায়নি।');
  const fields: string[] = [];
  const params: unknown[] = [];
  if (patch.fullName !== undefined) {
    fields.push('full_name = ?');
    params.push(normalizeText(patch.fullName));
  }
  if (patch.role !== undefined) {
    if (!['admin', 'manager', 'cashier'].includes(patch.role)) throw new Error('রোল সঠিক নয়।');
    fields.push('role = ?');
    params.push(patch.role);
  }
  if (patch.permissions !== undefined) {
    const clean = patch.permissions.filter((p) => (ALL_PERMISSIONS as readonly string[]).includes(p));
    fields.push('permissions = ?');
    params.push(JSON.stringify(clean));
  }
  if (patch.isActive !== undefined) {
    if (existing.role === 'admin' && !patch.isActive) {
      const activeAdmins = (
        db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND is_active=1 AND id <> ?").get(id) as {
          c: number;
        }
      ).c;
      if (activeAdmins === 0) throw new Error('শেষ অ্যাডমিন ইউজার নিষ্ক্রিয় করা যাবে না।');
    }
    fields.push('is_active = ?');
    params.push(patch.isActive ? 1 : 0);
  }
  if (!fields.length) return existing;
  fields.push('updated_at = ?');
  params.push(nowLocal(), id);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username ?? 'system',
    action: 'user.update',
    entity: 'user',
    entityId: id,
    details: patch,
  });
  return getUser(db, id)!;
}

export function resetPassword(
  db: Db,
  id: number,
  newPassword: string,
  actor?: { id: number; username: string } | null,
): void {
  const existing = getUser(db, id);
  if (!existing) throw new Error('ইউজার পাওয়া যায়নি।');
  validatePasswordStrength(newPassword);
  const { hash, salt } = hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?').run(
    hash,
    salt,
    nowLocal(),
    id,
  );
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username ?? 'system',
    action: 'user.password_reset',
    entity: 'user',
    entityId: id,
  });
}

export function changeOwnPassword(db: Db, id: number, oldPassword: string, newPassword: string): void {
  const row = getCredentialRowById(db, id);
  if (!row) throw new Error('ইউজার পাওয়া যায়নি।');
  if (!verifyPassword(oldPassword, row.password_salt, row.password_hash)) {
    throw new Error('বর্তমান পাসওয়ার্ড সঠিক নয়।');
  }
  validatePasswordStrength(newPassword);
  const { hash, salt } = hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?').run(
    hash,
    salt,
    nowLocal(),
    id,
  );
  audit(db, { userId: id, username: row.username, action: 'user.password_change', entity: 'user', entityId: id });
}

export interface LoginResult {
  user: User;
  loginAt: string;
}

/** Failed logins allowed before a cool-down, and how long the cool-down lasts. */
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCKOUT_MINUTES = 5;

interface AttemptRow {
  username: string;
  failures: number;
  first_failure_at: string;
  locked_until: string | null;
  updated_at: string;
}

function attemptRow(db: Db, username: string): AttemptRow | null {
  return (db.prepare('SELECT * FROM login_attempts WHERE username = ?').get(username) as AttemptRow | undefined) ?? null;
}

/**
 * Lockout expiry is stored as UTC ("YYYY-MM-DD HH:mm:ss" without a zone suffix, the
 * shape older databases already contain) and must be *read back as UTC*.
 *
 * v1.1.3 fix: the reader used `new Date("2026-11-04T09:45:16")`, which JavaScript
 * interprets in the machine's local zone. At Bangladesh Standard Time (UTC+6) a
 * five-minute cool-down therefore looked six hours old and had already "expired",
 * so the lockout could be skipped simply by waiting a second — or by restarting.
 * Everything is compared in UTC now, and legacy rows are read the same way.
 */
export function parseLockedUntilUtc(value: string | null | undefined): number | null {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const iso = text.replace(' ', 'T');
  const stamp = Date.parse(hasZone ? iso : `${iso}Z`);
  return Number.isNaN(stamp) ? null : stamp;
}

/** Local wall-clock timestamps (as written by `nowLocal()`) read back as local. */
function parseLocalStamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const stamp = Date.parse(text.replace(' ', 'T'));
  return Number.isNaN(stamp) ? null : stamp;
}

/**
 * Throws while a username is in cool-down. Deliberately does not reveal whether
 * the account exists: callers only ever see "try again in N minutes".
 */
export function assertNotLocked(db: Db, username: string): void {
  const key = normalizeText(username).toLowerCase();
  const row = attemptRow(db, key);
  if (!row?.locked_until) return;
  const until = parseLockedUntilUtc(row.locked_until);
  if (until === null || until <= Date.now()) return;
  const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  throw new Error(`অনেকবার ভুল পাসওয়ার্ড দেওয়া হয়েছে। ${minutes} মিনিট পর আবার চেষ্টা করুন।`);
}

/** Records a failed attempt; locks the username after LOGIN_MAX_FAILURES. */
export function registerLoginFailure(db: Db, username: string): void {
  const key = normalizeText(username).toLowerCase();
  if (!key) return;
  const now = nowLocal();
  const row = attemptRow(db, key);
  const firstAt = parseLocalStamp(row?.first_failure_at ?? null);
  const windowExpired = firstAt !== null ? Date.now() - firstAt > 15 * 60_000 : true;
  const failures = row && !windowExpired ? row.failures + 1 : 1;
  const first = row && !windowExpired ? row.first_failure_at! : now;
  const lockedUntil =
    failures >= LOGIN_MAX_FAILURES
      ? new Date(Date.now() + LOGIN_LOCKOUT_MINUTES * 60_000).toISOString().slice(0, 19).replace('T', ' ')
      : null;
  db.prepare(
    `INSERT INTO login_attempts (username, failures, first_failure_at, locked_until, updated_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(username) DO UPDATE SET
       failures = excluded.failures,
       first_failure_at = excluded.first_failure_at,
       locked_until = excluded.locked_until,
       updated_at = excluded.updated_at`,
  ).run(key, lockedUntil ? 0 : failures, first, lockedUntil, now);
}

/** Clears the counter after a successful login. */
export function clearLoginFailures(db: Db, username: string): void {
  db.prepare('DELETE FROM login_attempts WHERE username = ?').run(normalizeText(username).toLowerCase());
}

/**
 * A throwaway salt/hash so a login for a username that does not exist costs the
 * same scrypt work as a real one. Without this, the response time itself tells an
 * attacker which usernames are real, and failures for unknown names were never
 * counted towards the cool-down at all.
 */
const DUMMY_SALT = '00000000000000000000000000000000';
const DUMMY_HASH = hashPassword('sauda-dummy-password', DUMMY_SALT).hash;

export function login(db: Db, username: string, password: string): LoginResult {
  assertNotLocked(db, username);
  const row = getCredentialRow(db, username);
  if (!row) {
    verifyPassword(password, DUMMY_SALT, DUMMY_HASH);
    registerLoginFailure(db, username);
    audit(db, {
      userId: null,
      username: normalizeText(username).toLowerCase() || 'unknown',
      action: 'auth.login_failed',
      entity: 'user',
      entityId: null,
    });
    throw new Error('ইউজারনেম বা পাসওয়ার্ড সঠিক নয়।');
  }
  if (!row.is_active) throw new Error('এই ইউজার অ্যাকাউন্ট নিষ্ক্রিয় করা হয়েছে।');
  if (!verifyPassword(password, row.password_salt, row.password_hash)) {
    registerLoginFailure(db, row.username);
    audit(db, {
      userId: row.id,
      username: row.username,
      action: 'auth.login_failed',
      entity: 'user',
      entityId: row.id,
    });
    throw new Error('ইউজারনেম বা পাসওয়ার্ড সঠিক নয়।');
  }
  // A session is recorded or the login does not happen. The failure path above deliberately stays
  // outside any transaction, so a wrong password still counts towards the lockout (v1.1.5, A-25).
  const at = nowLocal();
  const record = db.transaction(() => {
    clearLoginFailures(db, row.username);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(at, row.id);
    db.prepare('INSERT INTO sessions_log (user_id, created_at) VALUES (?,?)').run(row.id, nowUtc());
    audit(db, { userId: row.id, username: row.username, action: 'auth.login', entity: 'user', entityId: row.id });
  });
  record();
  return { user: getUser(db, row.id)!, loginAt: at };
}

export function hasPermission(user: Pick<User, 'role' | 'permissions'> | null, perm: Permission): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return user.permissions.includes(perm);
}

export function requirePermission(
  user: Pick<User, 'role' | 'permissions'> | null,
  perm: Permission,
): void {
  if (!hasPermission(user, perm)) {
    throw new Error('এই কাজটি করার অনুমতি আপনার নেই। অনুগ্রহ করে অ্যাডমিনের সাথে কথা বলুন।');
  }
}
