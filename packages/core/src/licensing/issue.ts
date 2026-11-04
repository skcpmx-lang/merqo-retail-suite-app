import crypto from 'node:crypto';
import type { DeviceFingerprint, LicensePayload, SignedLicense } from '../domain/types.js';
import { canonicalJson, ed25519PrivateKeyFromBase64, randomId, sha256Hex, signEd25519 } from './crypto.js';
import { LICENSE_KEY_ID } from './publicKey.js';
import { encodeLicenseKey } from './verify.js';

/** Key id derived from the public key, so the app can detect a key mismatch. */
export function keyIdForPublicKey(publicKeySpkiB64: string): string {
  return crypto.createHash('sha256').update(Buffer.from(publicKeySpkiB64, 'base64')).digest('hex').slice(0, 16).toUpperCase();
}

export interface IssueInput {
  org: string;
  owner?: string;
  phone?: string;
  email?: string;
  address?: string;
  edition?: LicensePayload['edition'];
  expiresAt?: string | null;
  maxDevices?: number;
  features?: string[];
  note?: string;
  licenseId?: string;
  issuedAt?: string;
  generator?: string;
  device: DeviceFingerprint;
  /** v1.1.4 multi-PC fields (optional; omitted for a standalone licence). */
  storeId?: string;
  deviceId?: string;
  deviceRole?: 'SERVER_POS' | 'CLIENT_POS' | 'CLIENT_MANAGEMENT';
  deviceCapacity?: number;
}

export const DEFAULT_FEATURES = [
  'pos',
  'inventory',
  'purchases',
  'customers',
  'suppliers',
  'expenses',
  'cash',
  'returns',
  'reports',
  'printing',
  'backup',
  'multi_user',
  'variants',
  'batch_expiry',
];

export function buildPayload(input: IssueInput): LicensePayload {
  if (!input.org || !input.org.trim()) throw new Error('প্রতিষ্ঠানের নাম দিতে হবে।');
  if (!input.device || !input.device.components.length)
    throw new Error('ডিভাইস ফিঙ্গারপ্রিন্ট ছাড়া লাইসেন্স তৈরি করা যাবে না।');
  const components = input.device.components
    .filter((c) => c.hash)
    .map((c) => ({ key: c.key, hash: c.hash, weight: c.weight }))
    .sort((a, b) => a.key.localeCompare(b.key));
  if (!components.length) throw new Error('ডিভাইসে কোনো ব্যবহারযোগ্য হার্ডওয়্যার তথ্য পাওয়া যায়নি।');
  const fingerprint = sha256Hex(canonicalJson(components)).slice(0, 40);
  return {
    v: 1,
    license_id: input.licenseId ?? randomId('SAUDA'),
    org: input.org.trim(),
    owner: input.owner?.trim() || undefined,
    phone: input.phone?.trim() || undefined,
    email: input.email?.trim() || undefined,
    address: input.address?.trim() || undefined,
    edition: input.edition ?? 'standard',
    issued_at: input.issuedAt ?? new Date().toISOString(),
    expires_at: input.expiresAt ?? null,
    max_devices: input.maxDevices ?? 1,
    fingerprint,
    device_components: components,
    fingerprint_version: input.device.version ?? 1,
    features: input.features ?? DEFAULT_FEATURES,
    note: input.note?.trim() || undefined,
    generator: input.generator ?? `Sauda License Generator ${LICENSE_KEY_ID}`,
    ...(input.storeId ? { store_id: input.storeId.trim() } : {}),
    ...(input.deviceId ? { device_id: input.deviceId.trim() } : {}),
    ...(input.deviceRole ? { device_role: input.deviceRole } : {}),
    ...(input.deviceCapacity !== undefined
      ? { device_capacity: Math.max(1, Math.trunc(Number(input.deviceCapacity) || 1)) }
      : {}),
  };
}

export function signLicense(payload: LicensePayload, privateKeyPkcs8B64: string): SignedLicense {
  const privateKey = ed25519PrivateKeyFromBase64(privateKeyPkcs8B64);
  const sig = signEd25519(privateKey, canonicalJson(payload));
  return { payload, sig, key_id: LICENSE_KEY_ID };
}

export function issueLicense(input: IssueInput, privateKeyPkcs8B64: string): { license: SignedLicense; key: string } {
  const payload = buildPayload(input);
  const license = signLicense(payload, privateKeyPkcs8B64);
  return { license, key: encodeLicenseKey(license) };
}

/** Pretty-printed .sauda-license file content. */
export function licenseFileText(license: SignedLicense, opts: { org?: string; note?: string } = {}): string {
  return JSON.stringify(
    {
      format: 'sauda-license',
      version: 1,
      product: 'Sauda Retail Suite',
      organization: opts.org ?? license.payload.org,
      license_id: license.payload.license_id,
      key: encodeLicenseKey(license),
      payload: license.payload,
      sig: license.sig,
      key_id: license.key_id,
      note: opts.note ?? 'এই ফাইলটি সাউদা অ্যাক্টিভেশন স্ক্রিনে লোড করুন। লাইসেন্স ফাইলটি কারও সাথে শেয়ার করবেন না।',
    },
    null,
    2,
  );
}

/** Human-readable summary used on the activation screen and in the generator. */
export function licenseSummary(payload: LicensePayload): { label: string; value: string }[] {
  return [
    { label: 'প্রতিষ্ঠান', value: payload.org },
    { label: 'লাইসেন্স আইডি', value: payload.license_id },
    { label: 'এডিশন', value: payload.edition },
    { label: 'মালিক', value: payload.owner ?? '—' },
    { label: 'মোবাইল', value: payload.phone ?? '—' },
    { label: 'ইস্যু', value: payload.issued_at.slice(0, 10) },
    { label: 'মেয়াদ', value: payload.expires_at ? payload.expires_at.slice(0, 10) : 'লাইফটাইম' },
    { label: 'ডিভাইস', value: payload.fingerprint.slice(0, 16).toUpperCase() },
  ];
}
