/**
 * v1.1.3 security regressions.
 *
 * Each test here exists because a real defect shipped before it:
 *   - credential columns reached the renderer through `SELECT *` + spread;
 *   - an environment variable could replace the vendor public key;
 *   - the login cool-down was written in UTC but read back as local time, so it
 *     expired six hours early on a Bangladesh clock.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LICENSE_PUBLIC_KEY_SPKI_B64,
  LOGIN_LOCKOUT_MINUTES,
  canonicalJson,
  LOGIN_MAX_FAILURES,
  assertNotLocked,
  changeOwnPassword,
  createUser,
  getUser,
  listUsers,
  login,
  parseLockedUntilUtc,
  resolvePublicKeyB64,
  updateUser,
  verifyLicense,
  type LicensePayload,
  type SignedLicense,
} from '../src/index.js';
import { makeTestDb } from './helpers.js';

const SECRET_KEYS = ['password_hash', 'password_salt', 'passwordHash', 'passwordSalt'];

/** Walks any JSON-ish value and collects every key path that looks secret. */
function findSecretKeys(value: unknown, trail = '$'): string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => findSecretKeys(item, `${trail}[${index}]`));
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.includes(key)) found.push(`${trail}.${key}`);
    found.push(...findSecretKeys(child, `${trail}.${key}`));
  }
  return found;
}

const originalPublicKeyEnv = process.env.SAUDA_LICENSE_PUBLIC_KEY;

afterEach(() => {
  if (originalPublicKeyEnv === undefined) delete process.env.SAUDA_LICENSE_PUBLIC_KEY;
  else process.env.SAUDA_LICENSE_PUBLIC_KEY = originalPublicKeyEnv;
});

describe('user objects never expose credential storage', () => {
  it('keeps hash and salt out of login, list, get, create and update results', () => {
    const ctx = makeTestDb();
    const created = createUser(
      ctx.db,
      { username: 'till9', fullName: 'ক্যাশিয়ার নয়', password: 'Strong#1234', role: 'cashier' },
      ctx.actor,
    );
    const rows = {
      login: login(ctx.db, 'till9', 'Strong#1234'),
      list: listUsers(ctx.db),
      get: getUser(ctx.db, created.id),
      create: created,
      update: updateUser(ctx.db, created.id, { fullName: 'ক্যাশিয়ার ৯' }, ctx.actor),
    };
    for (const [name, value] of Object.entries(rows)) {
      expect(findSecretKeys(value), `${name} response leaked credentials`).toEqual([]);
    }

    // The stored hash must not be reachable as a substring either (a spread would
    // have carried the raw value even under a renamed key).
    const stored = ctx.db.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').get(created.id) as {
      password_hash: string;
      password_salt: string;
    };
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(stored.password_hash);
    expect(serialised).not.toContain(stored.password_salt);
    expect(serialised).not.toContain('scrypt');
    ctx.cleanup();
  });

  it('still authenticates correctly after the DTO change', () => {
    const ctx = makeTestDb();
    const user = createUser(
      ctx.db,
      { username: 'till10', fullName: 'ক্যাশিয়ার দশ', password: 'Strong#1234', role: 'cashier' },
      ctx.actor,
    );
    expect(login(ctx.db, 'till10', 'Strong#1234').user.id).toBe(user.id);
    expect(() => login(ctx.db, 'till10', 'wrong-password')).toThrow(/ইউজারনেম বা পাসওয়ার্ড/);
    changeOwnPassword(ctx.db, user.id, 'Strong#1234', 'Another#4321');
    expect(login(ctx.db, 'till10', 'Another#4321').user.username).toBe('till10');
    ctx.cleanup();
  });
});

describe('the vendor public key cannot be replaced at runtime', () => {
  function signWith(privateKey: crypto.KeyObject, payload: LicensePayload): SignedLicense {
    const data = Buffer.from(canonicalJson(payload), 'utf8');
    const sig = crypto.sign(null, data, privateKey).toString('base64url');
    return { payload, sig, key_id: 'attacker' };
  }

  it('ignores SAUDA_LICENSE_PUBLIC_KEY and rejects a licence signed by it', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const attackerKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

    // An attacker who can set environment variables tries to swap the trust root.
    process.env.SAUDA_LICENSE_PUBLIC_KEY = attackerKey;
    expect(resolvePublicKeyB64()).toBe(LICENSE_PUBLIC_KEY_SPKI_B64);

    const payload: LicensePayload = {
      v: 1,
      license_id: 'LIC-ATTACK-1',
      org: 'নকল দোকান',
      owner: 'attacker',
      email: '',
      phone: '',
      edition: 'enterprise',
      features: ['pos', 'reports'],
      max_devices: 5,
      fingerprint: 'fake-fingerprint',
      issued_at: new Date().toISOString(),
      expires_at: null,
      note: null,
    } as LicensePayload;

    const forged = signWith(privateKey, payload);
    const state = verifyLicense(forged, { skipDevice: true, skipExpiry: true });
    expect(state.activated).toBe(false);
    expect(state.reason).toBe('signature_invalid');

    // Sanity: the same forged licence would verify under the attacker key, which is
    // exactly why the environment variable had to stop being honoured.
    expect(verifyLicense(forged, { skipDevice: true, skipExpiry: true, publicKeyB64: attackerKey }).activated).toBe(
      true,
    );
  });

  it('has a well-formed embedded key that decodes to a 32-byte Ed25519 point', () => {
    const der = Buffer.from(LICENSE_PUBLIC_KEY_SPKI_B64, 'base64');
    expect(der.length).toBe(44);
    // 12-byte SPKI header for Ed25519, then the 32-byte key.
    expect(der.subarray(0, 12).toString('hex')).toBe('302a300506032b6570032100');
    expect(der.length - 12).toBe(32);
  });
});

describe('login cool-down is stored and compared in UTC', () => {
  it('reads a stored expiry as UTC regardless of the local timezone', () => {
    expect(parseLockedUntilUtc('2026-11-04 09:00:00')).toBe(Date.parse('2026-11-04T09:00:00Z'));
    expect(parseLockedUntilUtc('2026-11-04T09:00:00Z')).toBe(Date.parse('2026-11-04T09:00:00Z'));
    expect(parseLockedUntilUtc(null)).toBeNull();
    expect(parseLockedUntilUtc('not-a-date')).toBeNull();
  });

  it('keeps a fresh lock active even on a clock six hours ahead of UTC', () => {
    const ctx = makeTestDb();
    createUser(ctx.db, { username: 'till11', fullName: 'ক্যাশিয়ার এগারো', password: 'Strong#1234', role: 'cashier' }, ctx.actor);
    const until = new Date(Date.now() + LOGIN_LOCKOUT_MINUTES * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    ctx.db
      .prepare(
        `INSERT INTO login_attempts (username, failures, first_failure_at, locked_until, updated_at)
         VALUES (?,?,?,?,?)`,
      )
      .run('till11', 0, until, until, until);
    // Under the old local-time parse this row looked hours old and let the login through.
    expect(() => assertNotLocked(ctx.db, 'till11')).toThrow(/মিনিট পর আবার চেষ্টা করুন/);
    expect(() => login(ctx.db, 'till11', 'Strong#1234')).toThrow(/মিনিট পর আবার চেষ্টা করুন/);
    ctx.cleanup();
  });

  it('lets an expired lock through and counts a fresh failure again', () => {
    const ctx = makeTestDb();
    createUser(ctx.db, { username: 'till12', fullName: 'ক্যাশিয়ার বারো', password: 'Strong#1234', role: 'cashier' }, ctx.actor);
    const past = new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' ');
    ctx.db
      .prepare(
        `INSERT INTO login_attempts (username, failures, first_failure_at, locked_until, updated_at)
         VALUES (?,?,?,?,?)`,
      )
      .run('till12', 0, past, past, past);
    expect(() => assertNotLocked(ctx.db, 'till12')).not.toThrow();
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      expect(() => login(ctx.db, 'till12', `wrong-${i}`)).toThrow();
    }
    expect(() => login(ctx.db, 'till12', 'Strong#1234')).toThrow(/মিনিট পর আবার চেষ্টা করুন/);
    ctx.cleanup();
  });
});

describe('private signing material is absent from the main application', () => {
  it('ships no private key, and the licensing module has no env override', () => {
    const root = path.resolve(__dirname, '../../..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist', 'release', 'out'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|mjs|json|html|css)$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (/BEGIN (?:ED25519 |RSA )?PRIVATE KEY/.test(text)) offenders.push(full);
          // The defect was reading the variable at runtime; a mention in docs or in
          // the explicit forbidden-list constant is fine.
          if (
            full !== __filename &&
            /process\.env[.[]\s*['"]?(SAUDA_LICENSE_PUBLIC_KEY|SAUDA_LICENSE_KEY|SAUDA_DEV_PUBLIC_KEY)/.test(text)
          ) {
            offenders.push(`${full} (runtime key override)`);
          }
        }
      }
    };
    walk(path.join(root, 'packages'));
    walk(path.join(root, 'scripts'));
    expect(offenders, `unexpected private key or env-key reference: ${offenders.join(', ')}`).toEqual([]);
    // temp dir helper kept explicit so the test fails loudly on an unreadable tree
    expect(fs.existsSync(os.tmpdir())).toBe(true);
  });
});
