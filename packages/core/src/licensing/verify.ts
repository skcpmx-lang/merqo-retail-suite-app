import type { ActivationState, DeviceFingerprint, LicensePayload, SignedLicense } from '../domain/types.js';
import { daysRemaining } from '../domain/datetime.js';
import {
  base64urlDecode,
  base64urlEncode,
  canonicalJson,
  ed25519PublicKeyFromBase64,
  verifyEd25519,
} from './crypto.js';
import { compareFingerprints, getDeviceFingerprint } from './fingerprint.js';
import { LICENSE_KEY_ID, resolvePublicKeyB64 } from './publicKey.js';

export const LICENSE_PREFIX = 'SAUDA1';
export const SUPPORTED_LICENSE_VERSIONS = [1];
export const EDITIONS = ['standard', 'pro', 'enterprise'] as const;

/** Licence key text: SAUDA1.<base64url(payload)>.<base64url(signature)> */
export function encodeLicenseKey(license: SignedLicense): string {
  const payload = base64urlEncode(JSON.stringify(license.payload));
  return `${LICENSE_PREFIX}.${payload}.${license.sig}`;
}

export interface DecodeResult {
  ok: boolean;
  license?: SignedLicense;
  message?: string;
}

export function decodeLicenseKey(key: string): DecodeResult {
  const text = (key || '').trim().replace(/\s+/g, '');
  if (!text) return { ok: false, message: 'লাইসেন্স কী খালি।' };
  const parts = text.split('.');
  if (parts.length !== 3) return { ok: false, message: 'লাইসেন্স কী এর ফরম্যাট সঠিক নয়।' };
  const [prefix, payloadPart, sigPart] = parts;
  if (prefix !== LICENSE_PREFIX) return { ok: false, message: 'এটি Sauda এর লাইসেন্স কী নয়।' };
  try {
    const payloadText = base64urlDecode(payloadPart!).toString('utf8');
    const payload = JSON.parse(payloadText) as LicensePayload;
    return { ok: true, license: { payload, sig: sigPart!, key_id: LICENSE_KEY_ID } };
  } catch {
    return { ok: false, message: 'লাইসেন্স কী পড়া যাচ্ছে না (নষ্ট বা পরিবর্তিত)।' };
  }
}

export function parseLicenseFile(content: string): DecodeResult {
  let data: any;
  try {
    data = JSON.parse(content);
  } catch {
    return { ok: false, message: 'লাইসেন্স ফাইলটি বৈধ JSON নয়।' };
  }
  if (data?.key && typeof data.key === 'string') return decodeLicenseKey(data.key);
  if (data?.payload && data?.sig) {
    if (data.version && !SUPPORTED_LICENSE_VERSIONS.includes(Number(data.version))) {
      return { ok: false, message: 'লাইসেন্স ফাইলের ভার্সন সমর্থিত নয়।' };
    }
    return { ok: true, license: { payload: data.payload, sig: data.sig, key_id: data.key_id ?? LICENSE_KEY_ID } };
  }
  return { ok: false, message: 'লাইসেন্স ফাইলের কাঠামো সঠিক নয়।' };
}

export function validatePayloadSchema(payload: LicensePayload): string | null {
  if (!payload || typeof payload !== 'object') return 'লাইসেন্স ডেটা পাওয়া যায়নি।';
  if (!SUPPORTED_LICENSE_VERSIONS.includes(Number(payload.v))) return 'লাইসেন্স ভার্সন সমর্থিত নয়।';
  if (!payload.license_id || typeof payload.license_id !== 'string') return 'লাইসেন্স আইডি নেই।';
  if (!payload.org || typeof payload.org !== 'string') return 'প্রতিষ্ঠানের নাম নেই।';
  if (!EDITIONS.includes(payload.edition)) return 'লাইসেন্স এডিশন সঠিক নয়।';
  if (!payload.fingerprint || typeof payload.fingerprint !== 'string') return 'ডিভাইস ফিঙ্গারপ্রিন্ট নেই।';
  if (!Array.isArray(payload.features)) return 'লাইসেন্স ফিচার তালিকা সঠিক নয়।';
  if (!payload.issued_at) return 'ইস্যু তারিখ নেই।';
  return null;
}

/**
 * Multi-PC binding check (v1.1.4).
 *
 * A licence that carries `store_id` / `device_id` may only be used for that store
 * and that PC. A v1 licence (no such fields) stays valid for a standalone POS, so
 * existing customers are not broken by the upgrade.
 */
export interface BindingCheck {
  ok: boolean;
  code?: 'STORE_MISMATCH' | 'DEVICE_MISMATCH' | 'ROLE_MISMATCH';
  message?: string;
}

export function checkDeviceBinding(
  payload: LicensePayload,
  expected: { storeId?: string; deviceId?: string; role?: string },
): BindingCheck {
  if (payload.store_id && expected.storeId && payload.store_id !== expected.storeId) {
    return {
      ok: false,
      code: 'STORE_MISMATCH',
      message: `লাইসেন্সটি অন্য দোকানের (${payload.store_id}) — এই সার্ভারের Store ID ${expected.storeId}।`,
    };
  }
  if (payload.device_id && expected.deviceId && payload.device_id !== expected.deviceId) {
    return {
      ok: false,
      code: 'DEVICE_MISMATCH',
      message: 'লাইসেন্সটি অন্য কম্পিউটারের জন্য ইস্যু করা হয়েছে।',
    };
  }
  if (payload.device_role && expected.role && payload.device_role !== expected.role) {
    return {
      ok: false,
      code: 'ROLE_MISMATCH',
      message: `এই ডিভাইস ${expected.role} হিসেবে যোগ হচ্ছে, কিন্তু লাইসেন্সটি ${payload.device_role}।`,
    };
  }
  return { ok: true };
}

export interface VerifyOptions {
  /** Override the collected fingerprint (used by tests / rebinding flows). */
  device?: DeviceFingerprint;
  /** Inject the public key for testability. */
  publicKeyB64?: string;
  /** Ignore device binding (only for the License Generator's own verification). */
  skipDevice?: boolean;
  /** Ignore the expiry check (only for administrative inspection). */
  skipExpiry?: boolean;
  now?: Date;
}

/**
 * Full offline verification: signature → schema → expiry → device binding.
 * Order matters: nothing is trusted before the signature is verified.
 */
export function verifyLicense(
  license: SignedLicense | string,
  options: VerifyOptions = {},
): ActivationState {
  const device = options.device ?? getDeviceFingerprint();
  const base: ActivationState = { activated: false, reason: 'not_activated', message: '', license: null, device };

  let parsed: SignedLicense;
  if (typeof license === 'string') {
    const decoded = decodeLicenseKey(license);
    if (!decoded.ok || !decoded.license) {
      return { ...base, reason: 'schema_invalid', message: decoded.message ?? 'লাইসেন্স কী পড়া যায়নি।' };
    }
    parsed = decoded.license;
  } else {
    parsed = license;
  }

  // 1. Signature
  const payloadText = canonicalJson(parsed.payload);
  let publicKey;
  try {
    publicKey = ed25519PublicKeyFromBase64(options.publicKeyB64 ?? resolvePublicKeyB64());
  } catch {
    return { ...base, reason: 'error', message: 'অ্যাপ্লিকেশন ভেরিফিকেশন কী সঠিক নয়।' };
  }
  if (!verifyEd25519(publicKey, payloadText, parsed.sig)) {
    return { ...base, reason: 'signature_invalid', message: 'লাইসেন্স স্বাক্ষর সঠিক নয় — লাইসেন্সটি পরিবর্তিত।' };
  }

  // 2. Schema
  const schemaError = validatePayloadSchema(parsed.payload);
  if (schemaError) return { ...base, reason: 'schema_invalid', message: schemaError, license: parsed.payload };

  // 3. Expiry
  const now = options.now ?? new Date();
  if (parsed.payload.expires_at && !options.skipExpiry) {
    const end = new Date(`${parsed.payload.expires_at.slice(0, 10)}T23:59:59`).getTime();
    if (Number.isFinite(end) && now.getTime() > end) {
      return {
        ...base,
        reason: 'expired',
        message: `লাইসেন্সের মেয়াদ শেষ হয়েছে (${parsed.payload.expires_at.slice(0, 10)})।`,
        license: parsed.payload,
      };
    }
  }

  // 4. Device binding (weighted hardware match)
  let matchScore: number | undefined;
  if (!options.skipDevice) {
    const components = parsed.payload.device_components ?? [];
    if (!components.length) {
      return {
        ...base,
        reason: 'schema_invalid',
        message: 'লাইসেন্সে ডিভাইস বাইন্ডিং তথ্য নেই — লাইসেন্সটি পুনরায় তৈরি করুন।',
        license: parsed.payload,
      };
    }
    const licensedDevice: DeviceFingerprint = {
      version: parsed.payload.fingerprint_version ?? 1,
      hash: parsed.payload.fingerprint,
      components,
      collected_at: parsed.payload.issued_at,
      platform: 'licensed',
    };
    const match = compareFingerprints(licensedDevice, device);
    if (!match.ok) {
      return {
        ...base,
        reason: 'device_mismatch',
        message: match.message,
        license: parsed.payload,
        match_score: match.score,
      };
    }
    matchScore = match.score;
  }

  return {
    activated: true,
    reason: 'ok',
    message: 'লাইসেন্স বৈধ।',
    license: parsed.payload,
    device,
    days_left: daysRemaining(parsed.payload.expires_at),
    match_score: matchScore,
  };
}

export function verifySignatureOnly(license: SignedLicense, publicKeyB64?: string): ActivationState {
  const device = getDeviceFingerprint();
  return verifyLicense(license, { device, publicKeyB64, skipDevice: true });
}

export interface ActivationRecordInput {
  license: SignedLicense;
  device: DeviceFingerprint;
}

/** Device-bound verification used on every app start. */
export function verifyActivationRecord(
  license: SignedLicense,
  _licensedDevice?: DeviceFingerprint,
  currentDevice: DeviceFingerprint = getDeviceFingerprint(),
): ActivationState {
  return verifyLicense(license, { device: currentDevice });
}
