import type { Db } from '../db/connection.js';
import { setMeta, getMeta } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import type { ActivationState, SignedLicense } from '../domain/types.js';
import { audit } from '../services/audit.js';
import { getDeviceFingerprint } from './fingerprint.js';
import { decodeLicenseKey, parseLicenseFile, verifyLicense } from './verify.js';

interface ActivationRow {
  id: number;
  license_id: string;
  license_key: string | null;
  payload: string;
  signature: string;
  device_hash: string;
  org: string;
  activated_at: string;
  last_check_at: string | null;
}

export function getActivationRow(db: Db): ActivationRow | null {
  const row = db.prepare('SELECT * FROM activations ORDER BY id DESC LIMIT 1').get() as ActivationRow | undefined;
  return row ?? null;
}

function maxSeenTime(db: Db): number {
  const raw = getMeta(db, 'license.max_seen');
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

function recordSeenTime(db: Db): number {
  const now = Date.now();
  const prev = maxSeenTime(db);
  const max = Math.max(prev, now);
  if (max !== prev) setMeta(db, 'license.max_seen', String(max));
  return max;
}

/**
 * Current activation state. Runs full offline verification every time the app
 * starts, including weighted hardware matching and a clock-rollback guard.
 */
export function getActivationState(db: Db, publicKeyB64?: string): ActivationState {
  const device = getDeviceFingerprint();
  const row = getActivationRow(db);
  if (!row) {
    return { activated: false, reason: 'not_activated', message: 'অ্যাপ্লিকেশনটি এখনো অ্যাক্টিভেট করা হয়নি।', license: null, device };
  }
  let license: SignedLicense;
  try {
    license = { payload: JSON.parse(row.payload), sig: row.signature, key_id: '' };
  } catch {
    return { activated: false, reason: 'schema_invalid', message: 'সংরক্ষিত লাইসেন্স তথ্য নষ্ট হয়েছে।', license: null, device };
  }

  const state = verifyLicense(license, { device, publicKeyB64 });
  if (!state.activated) return { ...state, activated_at: row.activated_at };

  // Clock rollback guard: if the licence is expired according to the newest
  // point in time we have ever observed, refuse even if the clock says otherwise.
  const seen = recordSeenTime(db);
  const seenDate = new Date(seen);
  const rolledBack = license.payload.expires_at
    ? verifyLicense(license, { device, now: seenDate, skipDevice: true, publicKeyB64 }).reason === 'expired'
    : false;
  if (rolledBack) {
    return {
      activated: false,
      reason: 'clock_tamper',
      message: 'সিস্টেমের তারিখ পিছিয়ে দেওয়া হয়েছে বলে মনে হচ্ছে। অনুগ্রহ করে তারিখ ও সময় ঠিক করুন।',
      license: license.payload,
      device,
      activated_at: row.activated_at,
    };
  }

  db.prepare('UPDATE activations SET last_check_at = ? WHERE id = ?').run(nowLocal(), row.id);
  return { ...state, activated_at: row.activated_at };
}

export function activate(
  db: Db,
  input: { key?: string; fileContent?: string; publicKeyB64?: string },
  actor?: { id: number; username: string } | null,
): ActivationState {
  let license: SignedLicense | null = null;
  if (input.fileContent) {
    const parsed = parseLicenseFile(input.fileContent);
    if (!parsed.ok || !parsed.license) {
      return { activated: false, reason: 'schema_invalid', message: parsed.message ?? 'লাইসেন্স ফাইল সঠিক নয়।', license: null, device: getDeviceFingerprint() };
    }
    license = parsed.license;
  } else if (input.key) {
    const parsed = decodeLicenseKey(input.key);
    if (!parsed.ok || !parsed.license) {
      return { activated: false, reason: 'schema_invalid', message: parsed.message ?? 'লাইসেন্স কী সঠিক নয়।', license: null, device: getDeviceFingerprint() };
    }
    license = parsed.license;
  } else {
    return { activated: false, reason: 'not_activated', message: 'লাইসেন্স কী দিন অথবা লাইসেন্স ফাইল লোড করুন।', license: null, device: getDeviceFingerprint() };
  }

  const device = getDeviceFingerprint(true);
  const state = verifyLicense(license, { device, publicKeyB64: input.publicKeyB64 });
  if (!state.activated) {
    audit(db, {
      userId: actor?.id ?? null,
      username: actor?.username,
      action: 'license.activate_failed',
      entity: 'license',
      details: { reason: state.reason, licenseId: license.payload?.license_id },
    });
    return state;
  }

  const run = db.transaction(() => {
    db.prepare('DELETE FROM activations').run();
    db.prepare(
      `INSERT INTO activations (license_id, license_key, payload, signature, device_hash, org, activated_at, last_check_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      license!.payload.license_id,
      input.key ?? null,
      JSON.stringify(license!.payload),
      license!.sig,
      device.hash,
      license!.payload.org,
      nowLocal(),
      nowLocal(),
    );
    setMeta(db, 'license.org', license!.payload.org);
    setMeta(db, 'license.id', license!.payload.license_id);
    setMeta(db, 'license.max_seen', String(Date.now()));
  });
  run();
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username,
    action: 'license.activate',
    entity: 'license',
    details: { licenseId: license.payload.license_id, org: license.payload.org },
  });
  return { ...state, activated_at: nowLocal() };
}

export function deactivate(db: Db, actor?: { id: number; username: string } | null): void {
  db.prepare('DELETE FROM activations').run();
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username,
    action: 'license.deactivate',
    entity: 'license',
  });
}

export function requireActivation(db: Db, publicKeyB64?: string): ActivationState {
  const state = getActivationState(db, publicKeyB64);
  if (!state.activated) {
    const err = new Error(state.message || 'লাইসেন্স সক্রিয় নয়।') as Error & { code?: string };
    err.code = 'LICENSE_REQUIRED';
    throw err;
  }
  return state;
}
