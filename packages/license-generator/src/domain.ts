/**
 * Sauda License Generator — domain layer.
 *
 * Everything in this file is Electron-free and file-path driven so it can be
 * unit tested and integration tested against the same `@sauda/core` signing
 * code the customer application uses. The Electron main process is only a thin
 * shell around these functions (dialogs, clipboard, printing, windows).
 *
 * Security rules enforced here:
 *  - the private signing key is never persisted in the store, never logged and
 *    never returned to the renderer;
 *  - a licence can only be invalidated through an explicit revoke or reissue
 *    entry (signed payloads are immutable);
 *  - every state change appends to the ledger before it is reported as done.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  encodeLicenseKey,
  issueLicense,
  keyIdForPublicKey,
  parseLicenseFile,
  verifyLicense,
  type DeviceFingerprint,
  type LicensePayload,
  type SignedLicense,
} from '@sauda/core';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type Edition = 'standard' | 'pro' | 'enterprise';

export interface Customer {
  id: string;
  code: string;
  name: string;
  owner: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  notes: string;
  is_active: 0 | 1;
  created_at: string;
  updated_at: string;
}

export type LicenseState = 'active' | 'expired' | 'revoked' | 'superseded';

export interface LicenseRecord {
  id: string;
  customer_id: string | null;
  license_id: string;
  org: string;
  owner: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  edition: Edition;
  features: string[];
  max_devices: number;
  expires_at: string | null;
  fingerprint: string;
  key_id: string;
  issued_at: string;
  file_path: string | null;
  /** Set when this record replaced an older licence. */
  replaces: string | null;
  /** Set when a newer licence replaced this one. */
  superseded_by: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  note: string | null;
  /** Full signed licence so the profile screen can re-verify or re-export. */
  license: SignedLicense;
}

export interface GeneratorSettings {
  theme: 'light' | 'dark';
  admin_name: string;
  default_edition: Edition;
  default_expiry_days: number;
  company_footer: string;
}

export interface Store {
  version: 2;
  created_at: string;
  customers: Customer[];
  licenses: LicenseRecord[];
  settings: GeneratorSettings;
}

export interface LedgerEntry {
  id: string;
  license_id: string;
  org: string;
  owner: string | null;
  edition: string;
  expires_at: string | null;
  max_devices: number;
  device_hash: string | null;
  key_id: string;
  action: 'issued' | 'reissued' | 'revoked';
  replaces: string | null;
  reason: string | null;
  file: string | null;
  at: string;
  customer_id?: string | null;
}

export interface DeviceRequest {
  kind: string;
  v: number;
  fingerprint: string;
  components: { key: string; hash: string; weight: number }[];
  platform?: string;
  app_version?: string;
  business_name?: string | null;
  created_at?: string;
  file?: string;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const FEATURES: { id: string; label: string; editions: Edition[]; note: string }[] = [
  { id: 'pos', label: 'বিক্রয় ও ক্যাশ (POS)', editions: ['standard', 'pro', 'enterprise'], note: 'অপরিহার্য' },
  { id: 'inventory', label: 'ইনভেন্টরি ও স্টক', editions: ['standard', 'pro', 'enterprise'], note: 'অপরিহার্য' },
  { id: 'purchases', label: 'পারচেজ ও সাপ্লায়ার', editions: ['standard', 'pro', 'enterprise'], note: 'অপরিহার্য' },
  { id: 'accounting', label: 'ডাবল-এন্ট্রি অ্যাকাউন্টিং', editions: ['standard', 'pro', 'enterprise'], note: 'অপরিহার্য' },
  { id: 'reports', label: 'রিপোর্ট (৫৪)', editions: ['standard', 'pro', 'enterprise'], note: 'অপরিহার্য' },
  { id: 'customers', label: 'কাস্টমার ও বাকি খাতা', editions: ['standard', 'pro', 'enterprise'], note: 'অপরিহার্য' },
  { id: 'promotions', label: 'কুপন, ভাউচার ও গিফট কার্ড', editions: ['pro', 'enterprise'], note: 'v1.1' },
  { id: 'purchase_orders', label: 'পারচেজ অর্ডার ও আংশিক গ্রহণ', editions: ['pro', 'enterprise'], note: 'v1.1' },
  { id: 'lan', label: 'মাল্টি-টার্মিনাল (LAN)', editions: ['enterprise'], note: 'v1.1' },
  { id: 'customer_display', label: 'কাস্টমার ডিসপ্লে', editions: ['pro', 'enterprise'], note: 'v1.1' },
  { id: 'backup', label: 'ব্যাকআপ ও রিস্টোর', editions: ['standard', 'pro', 'enterprise'], note: 'অপরিহার্য' },
  { id: 'attendance', label: 'কর্মী হাজিরা', editions: ['pro', 'enterprise'], note: 'v1.1' },
];

export const EDITIONS: { id: Edition; label: string; note: string }[] = [
  { id: 'standard', label: 'Standard', note: 'ছোট দোকান — মূল POS ও হিসাব' },
  { id: 'pro', label: 'Pro', note: 'প্রোমোশন, পারচেজ অর্ডার, কাস্টমার ডিসপ্লে' },
  { id: 'enterprise', label: 'Enterprise', note: 'সবকিছু + LAN মাল্টি-টার্মিনাল' },
];

export function featuresForEdition(edition: Edition): string[] {
  return FEATURES.filter((f) => f.editions.includes(edition)).map((f) => f.id);
}

/** 30 days by default so a trial cannot silently become lifetime. */
export const DEFAULT_EXPIRY_DAYS = 30;
export const MAX_DEVICE_OPTIONS = [1, 2, 3, 5, 10, 25];

/* ------------------------------------------------------------------ */
/* Store persistence                                                   */
/* ------------------------------------------------------------------ */

export function emptyStore(): Store {
  return {
    version: 2,
    created_at: nowIso(),
    customers: [],
    licenses: [],
    settings: {
      theme: 'light',
      admin_name: '',
      default_edition: 'standard',
      default_expiry_days: DEFAULT_EXPIRY_DAYS,
      company_footer: 'MERQO • সাউদা রিটেইল স্যুট',
    },
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function readStore(file: string): Store {
  if (!fs.existsSync(file)) return emptyStore();
  const raw = fs.readFileSync(file, 'utf8');
  let parsed: Partial<Store>;
  try {
    parsed = JSON.parse(raw) as Partial<Store>;
  } catch {
    // Never silently start from an empty store: that would look like "all customers and
    // licences disappeared" and the operator would keep issuing into a fresh file.
    throw new Error(
      `সংরক্ষিত তথ্য ফাইলটি নষ্ট (JSON নয়): ${path.basename(file)}। ফাইলটি মুছবেন না — ব্যাকআপ থেকে পুনরুদ্ধার করুন।`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('সংরক্ষিত তথ্য ফাইলের কাঠামো সঠিক নয় — ব্যাকআপ থেকে পুনরুদ্ধার করুন।');
  }
  const base = emptyStore();
  return {
    ...base,
    ...parsed,
    version: 2,
    customers: Array.isArray(parsed.customers) ? parsed.customers : [],
    licenses: Array.isArray(parsed.licenses) ? parsed.licenses : [],
    settings: { ...base.settings, ...(parsed.settings ?? {}) },
  };
}

export function writeStore(file: string, store: Store): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, file); // atomic replace — a crash cannot truncate the file
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

export function normalizeName(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function isValidPhone(value: string): boolean {
  const digits = String(value ?? '').replace(/[^\d]/g, '');
  if (!value) return true;
  return digits.length >= 8 && digits.length <= 15;
}

export function isValidEmail(value: string): boolean {
  if (!value) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

export function isValidFingerprint(value: string): boolean {
  return /^[a-f0-9]{16,64}$/i.test(String(value ?? '').trim());
}

/* ------------------------------------------------------------------ */
/* Customers                                                           */
/* ------------------------------------------------------------------ */

export interface CustomerInput {
  name: string;
  owner?: string;
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  notes?: string;
}

function nextCustomerCode(store: Store): string {
  const max = store.customers.reduce((acc, c) => {
    const n = Number(String(c.code ?? '').replace(/\D/g, ''));
    return Number.isFinite(n) && n > acc ? n : acc;
  }, 0);
  return `CUS-${String(max + 1).padStart(5, '0')}`;
}

export function createCustomer(store: Store, input: CustomerInput): Customer {
  const name = normalizeName(input.name);
  if (name.length < 2) throw new Error('প্রতিষ্ঠানের নাম কমপক্ষে ২ অক্ষরের হতে হবে।');
  if (name.length > 120) throw new Error('প্রতিষ্ঠানের নাম ১২০ অক্ষরের বেশি হতে পারবে না।');
  if (!isValidPhone(input.phone ?? '')) throw new Error('ফোন নম্বর সঠিক নয় (৮–১৫ ডিজিট)।');
  if (!isValidEmail(input.email ?? '')) throw new Error('ইমেইল ঠিকানাটি সঠিক নয়।');
  const duplicate = store.customers.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (duplicate) throw new Error(`"${name}" নামে একটি কাস্টমার আগেই আছে (${duplicate.code})।`);
  const at = nowIso();
  const customer: Customer = {
    id: crypto.randomUUID(),
    code: nextCustomerCode(store),
    name,
    owner: normalizeName(input.owner ?? ''),
    phone: String(input.phone ?? '').trim(),
    email: String(input.email ?? '').trim(),
    address: normalizeName(input.address ?? ''),
    city: normalizeName(input.city ?? ''),
    notes: String(input.notes ?? '').trim(),
    is_active: 1,
    created_at: at,
    updated_at: at,
  };
  store.customers.push(customer);
  return customer;
}

export function updateCustomer(store: Store, id: string, input: Partial<CustomerInput> & { is_active?: 0 | 1 }): Customer {
  const customer = store.customers.find((c) => c.id === id);
  if (!customer) throw new Error('কাস্টমার পাওয়া যায়নি।');
  if (input.name !== undefined) {
    const name = normalizeName(input.name);
    if (name.length < 2) throw new Error('প্রতিষ্ঠানের নাম কমপক্ষে ২ অক্ষরের হতে হবে।');
    const dup = store.customers.find((c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase());
    if (dup) throw new Error(`"${name}" নামে আরেকটি কাস্টমার আছে (${dup.code})।`);
    customer.name = name;
  }
  if (input.phone !== undefined) {
    if (!isValidPhone(input.phone)) throw new Error('ফোন নম্বর সঠিক নয় (৮–১৫ ডিজিট)।');
    customer.phone = input.phone.trim();
  }
  if (input.email !== undefined) {
    if (!isValidEmail(input.email)) throw new Error('ইমেইল ঠিকানাটি সঠিক নয়।');
    customer.email = input.email.trim();
  }
  if (input.owner !== undefined) customer.owner = normalizeName(input.owner);
  if (input.address !== undefined) customer.address = normalizeName(input.address);
  if (input.city !== undefined) customer.city = normalizeName(input.city);
  if (input.notes !== undefined) customer.notes = String(input.notes).trim();
  if (input.is_active !== undefined) customer.is_active = input.is_active;
  customer.updated_at = nowIso();
  return customer;
}

export function listCustomers(store: Store, filter: { q?: string; activeOnly?: boolean } = {}): Customer[] {
  const q = (filter.q ?? '').trim().toLowerCase();
  return store.customers
    .filter((c) => (filter.activeOnly ? c.is_active === 1 : true))
    .filter((c) =>
      q
        ? [c.name, c.code, c.owner, c.phone, c.email, c.city].some((v) => String(v ?? '').toLowerCase().includes(q))
        : true,
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'bn'));
}

export function customerById(store: Store, id: string): Customer | null {
  return store.customers.find((c) => c.id === id) ?? null;
}

/* ------------------------------------------------------------------ */
/* Device requests                                                     */
/* ------------------------------------------------------------------ */

export function parseDeviceRequest(content: string): DeviceRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('ডিভাইস ফাইলটি বৈধ JSON নয়।');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('ডিভাইস ফাইলের গঠন সঠিক নয়।');
  const raw = parsed as Record<string, unknown>;
  if (raw.kind && raw.kind !== 'sauda-device-request') {
    throw new Error('এটি সাউদা ডিভাইস রিকোয়েস্ট ফাইল নয়।');
  }
  const componentsRaw = Array.isArray(raw.components) ? (raw.components as unknown[]) : [];
  const components = componentsRaw
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
    .map((c) => ({
      key: String(c.key ?? '').trim(),
      hash: String(c.hash ?? '').trim(),
      weight: Number(c.weight) || 0,
    }))
    .filter((c) => c.key.length > 0 && /^[a-f0-9]{8,128}$/i.test(c.hash));
  if (!components.length) throw new Error('ডিভাইস ফাইলে কোনো ব্যবহারযোগ্য হার্ডওয়্যার কম্পোনেন্ট নেই।');
  const fingerprint = String(raw.fingerprint ?? '').trim();
  if (!isValidFingerprint(fingerprint)) throw new Error('ডিভাইস ফিঙ্গারপ্রিন্টের ফরম্যাট সঠিক নয়।');
  return {
    kind: 'sauda-device-request',
    v: Number(raw.v) || 1,
    fingerprint,
    components,
    platform: typeof raw.platform === 'string' ? raw.platform : undefined,
    app_version: typeof raw.app_version === 'string' ? raw.app_version : undefined,
    business_name: typeof raw.business_name === 'string' ? raw.business_name : null,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : undefined,
  };
}

export function deviceFingerprint(request: DeviceRequest): DeviceFingerprint {
  return { version: request.v, hash: request.fingerprint, components: request.components } as DeviceFingerprint;
}

/* ------------------------------------------------------------------ */
/* Signing                                                             */
/* ------------------------------------------------------------------ */

export interface IssueInput {
  org: string;
  owner?: string;
  phone?: string;
  email?: string;
  address?: string;
  edition: Edition;
  expiresAt?: string | null;
  maxDevices: number;
  features: string[];
  note?: string | null;
  /**
   * v1.1.4 multi-PC binding. Optional: a standalone licence omits all four and keeps working
   * on any PC of the shop (the legacy v1 behaviour).
   */
  storeId?: string;
  deviceId?: string;
  deviceRole?: 'SERVER_POS' | 'CLIENT_POS' | 'CLIENT_MANAGEMENT';
  deviceCapacity?: number;
}

export interface IssueResult {
  license: SignedLicense;
  licenseKey: string;
  payload: LicensePayload;
  check: ReturnType<typeof verifyLicense>;
}

/**
 * Validates, signs and then *re-verifies* the licence with the matching public
 * key before it can be handed to the caller. A failure here means nothing is
 * exported — the wizard never reports success on an unverified signature.
 */
export function signLicense(input: {
  device: DeviceRequest;
  issue: IssueInput;
  privateKeyB64: string;
  generatorVersion: string;
}): IssueResult {
  const { device, issue } = input;
  if (!device?.components?.length) throw new Error('আগে ডিভাইস রিকোয়েস্ট ফাইল লোড করুন।');
  const org = normalizeName(issue.org);
  if (org.length < 2) throw new Error('প্রতিষ্ঠানের নাম কমপক্ষে ২ অক্ষরের হতে হবে।');
  if (!EDITIONS.some((e) => e.id === issue.edition)) throw new Error('এডিশন সঠিক নয়।');
  const maxDevices = Math.round(Number(issue.maxDevices) || 0);
  if (maxDevices < 1 || maxDevices > 100) throw new Error('ডিভাইস সংখ্যা ১ থেকে ১০০ এর মধ্যে হতে হবে।');
  const allowed = new Set(featuresForEdition(issue.edition));
  const features = (issue.features ?? []).filter((f) => FEATURES.some((x) => x.id === f));
  if (!features.length) throw new Error('অন্তত একটি ফিচার এনটাইটেলমেন্ট নির্বাচন করুন।');
  const unsupported = features.filter((f) => !allowed.has(f));
  if (unsupported.length) throw new Error(`এই এডিশনে অনুমোদিত নয়: ${unsupported.join(', ')}`);
  // Multi-PC binding: validated here so a bound licence can never be minted with an unknown
  // role or an absurd capacity.
  const storeId = String(issue.storeId ?? '').trim();
  const deviceId = String(issue.deviceId ?? '').trim();
  if (storeId && storeId.length > 64) throw new Error('Store ID অনেক বড়।');
  if (deviceId && deviceId.length > 64) throw new Error('ডিভাইস আইডি অনেক বড়।');
  if (issue.deviceRole && !['SERVER_POS', 'CLIENT_POS', 'CLIENT_MANAGEMENT'].includes(issue.deviceRole)) {
    throw new Error('ডিভাইসের ভূমিকা সঠিক নয়।');
  }
  if (issue.deviceRole && !storeId) {
    throw new Error('ডিভাইস ভূমিকা দিতে হলে Store ID দিতে হবে।');
  }
  if (issue.expiresAt) {
    const expiry = new Date(issue.expiresAt);
    if (Number.isNaN(expiry.getTime())) throw new Error('মেয়াদ শেষের তারিখ সঠিক নয়।');
    if (expiry.getTime() < Date.now()) throw new Error('মেয়াদ শেষের তারিখ আজকের আগে হতে পারে না।');
  }

  const { license, key } = issueLicense(
    {
      org,
      owner: normalizeName(issue.owner ?? '') || undefined,
      phone: String(issue.phone ?? '').trim() || undefined,
      email: String(issue.email ?? '').trim() || undefined,
      address: normalizeName(issue.address ?? '') || undefined,
      edition: issue.edition,
      expiresAt: issue.expiresAt ? new Date(`${issue.expiresAt}T23:59:59.000Z`).toISOString() : null,
      maxDevices,
      features,
      note: issue.note ? String(issue.note).slice(0, 500) : undefined,
      generator: `Sauda License Generator ${input.generatorVersion}`,
      device: deviceFingerprint(device),
      // Multi-PC binding. These used to be dropped here, so a bound licence could never be
      // produced even when the caller supplied the store/device identity.
      ...(storeId ? { storeId } : {}),
      ...(deviceId ? { deviceId } : {}),
      ...(issue.deviceRole ? { deviceRole: issue.deviceRole } : {}),
      ...(issue.deviceCapacity !== undefined
        ? { deviceCapacity: Math.max(1, Math.min(100, Math.trunc(Number(issue.deviceCapacity) || 1))) }
        : {}),
    },
    input.privateKeyB64,
  );
  const check = verifyLicense(license, {
    device: deviceFingerprint(device),
    publicKeyB64: keyIdToPublicKeyPlaceholder(input.privateKeyB64),
  });
  if (!check.activated) throw new Error(`নিজস্ব স্বাক্ষর যাচাই ব্যর্থ: ${check.message}`);
  return { license, licenseKey: key, payload: license.payload, check };
}

/**
 * Derives the SPKI public key for a PKCS#8 Ed25519 private key.
 * Kept private to the module so the private key never leaves it.
 */
export function keyIdToPublicKeyPlaceholder(privateKeyB64: string): string {
  const der = Buffer.from(privateKeyB64, 'base64');
  const keyObject = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  if (keyObject.asymmetricKeyType !== 'ed25519') {
    throw new Error(`কী ধরন ${keyObject.asymmetricKeyType} — Ed25519 প্রয়োজন।`);
  }
  return crypto.createPublicKey(keyObject).export({ type: 'spki', format: 'der' }).toString('base64');
}

export function describePrivateKey(privateKeyB64: string): { keyId: string; publicKeyB64: string } {
  const publicKeyB64 = keyIdToPublicKeyPlaceholder(privateKeyB64);
  return { keyId: keyIdForPublicKey(publicKeyB64), publicKeyB64 };
}

export interface VerifyOutcome {
  ok: boolean;
  message: string;
  payload: LicensePayload | null;
  licenseKey: string | null;
  /** True when the signature is valid but the file has been revoked here. */
  revoked: boolean;
}

export function verifyLicenseFile(
  content: string,
  opts: { publicKeyB64?: string | null; device?: DeviceRequest | null; revokedIds?: string[] },
): VerifyOutcome {
  const parsed = parseLicenseFile(content);
  if (!parsed.ok || !parsed.license) {
    return { ok: false, message: parsed.message ?? 'লাইসেন্স ফাইলটি বৈধ নয়।', payload: null, licenseKey: null, revoked: false };
  }
  const state = verifyLicense(parsed.license, {
    publicKeyB64: opts.publicKeyB64 ?? undefined,
    device: opts.device ? deviceFingerprint(opts.device) : undefined,
    skipDevice: !opts.device,
  });
  const revoked = (opts.revokedIds ?? []).includes(parsed.license.payload.license_id);
  return {
    ok: state.activated,
    message: revoked && state.activated ? 'স্বাক্ষর বৈধ, তবে এই লাইসেন্স এই মেশিন থেকে প্রত্যাহার করা হয়েছে।' : state.message,
    payload: parsed.license.payload,
    licenseKey: encodeLicenseKey(parsed.license),
    revoked,
  };
}

/* ------------------------------------------------------------------ */
/* Licence records                                                     */
/* ------------------------------------------------------------------ */

export function recordIssuedLicense(
  store: Store,
  args: { result: IssueResult; customerId: string | null; filePath: string | null; replaces?: string | null; note?: string | null },
): LicenseRecord {
  const { result } = args;
  const payload = result.payload;
  if (store.licenses.some((l) => l.license_id === payload.license_id)) {
    throw new Error('এই লাইসেন্স আইডি আগেই রেকর্ড করা হয়েছে।');
  }
  const record: LicenseRecord = {
    id: crypto.randomUUID(),
    customer_id: args.customerId,
    license_id: payload.license_id,
    org: payload.org,
    owner: payload.owner ?? null,
    phone: payload.phone ?? null,
    email: payload.email ?? null,
    address: payload.address ?? null,
    edition: payload.edition,
    features: payload.features ?? [],
    max_devices: payload.max_devices,
    expires_at: payload.expires_at,
    fingerprint: payload.fingerprint,
    key_id: fieldsKeyId(result.license),
    issued_at: payload.issued_at ?? nowIso(),
    file_path: args.filePath,
    replaces: args.replaces ?? null,
    superseded_by: null,
    revoked_at: null,
    revoke_reason: null,
    note: args.note ?? null,
    license: result.license,
  };
  if (args.replaces) {
    const previous = store.licenses.find((l) => l.license_id === args.replaces);
    if (previous) previous.superseded_by = payload.license_id;
  }
  store.licenses.push(record);
  return record;
}

function fieldsKeyId(license: SignedLicense): string {
  return license.key_id;
}

/**
 * The exact bytes written to the `.sauda` file the customer imports.
 *
 * A revoked licence must never be exportable again: re-writing the file would hand the
 * customer a working copy of a licence the operator deliberately withdrew (the file is
 * signed, so the Main App cannot tell it was revoked offline).
 */
export function toLicenseFile(record: LicenseRecord, meta: { customer?: string | null } = {}): string {
  if (record.revoked_at) {
    throw new Error(
      'এই লাইসেন্সটি প্রত্যাহার করা হয়েছে — এর ফাইল আর রপ্তানি করা যাবে না। প্রয়োজনে নতুন লাইসেন্স ইস্যু করুন।',
    );
  }
  return JSON.stringify(
    {
      format: 'sauda-license',
      v: 1,
      key: encodeLicenseKey(record.license),
      payload: record.license.payload,
      device_fingerprint: record.fingerprint,
      issued_by: 'Sauda License Generator',
      issued_at: record.issued_at,
      license_id: record.license_id,
      customer: meta.customer ?? null,
    },
    null,
    2,
  );
}

export function licenseState(record: LicenseRecord, now = new Date()): LicenseState {
  if (record.revoked_at) return 'revoked';
  if (record.superseded_by) return 'superseded';
  if (record.expires_at && new Date(record.expires_at) < now) return 'expired';
  return 'active';
}

export function daysToExpiry(record: LicenseRecord, now = new Date()): number | null {
  if (!record.expires_at) return null;
  return Math.ceil((new Date(record.expires_at).getTime() - now.getTime()) / 86_400_000);
}

export function revokeLicense(store: Store, licenseId: string, reason: string): LicenseRecord {
  const note = String(reason ?? '').trim();
  if (!note) throw new Error('প্রত্যাহারের কারণ লিখতে হবে — এটি অডিটে সংরক্ষিত হবে।');
  const record = store.licenses.find((l) => l.license_id === licenseId);
  if (!record) throw new Error('লাইসেন্সটি এই মেশিনের রেকর্ডে নেই।');
  if (record.revoked_at) throw new Error('লাইসেন্সটি আগেই প্রত্যাহার করা হয়েছে।');
  record.revoked_at = nowIso();
  record.revoke_reason = note;
  return record;
}

export function listLicenses(
  store: Store,
  filter: { q?: string; state?: LicenseState | 'all'; edition?: Edition | 'all'; customerId?: string } = {},
): LicenseRecord[] {
  const q = (filter.q ?? '').trim().toLowerCase();
  return store.licenses
    .filter((l) => (filter.state && filter.state !== 'all' ? licenseState(l) === filter.state : true))
    .filter((l) => (filter.edition && filter.edition !== 'all' ? l.edition === filter.edition : true))
    .filter((l) => (filter.customerId ? l.customer_id === filter.customerId : true))
    .filter((l) =>
      q
        ? [l.org, l.license_id, l.owner, l.phone, l.email, l.fingerprint].some((v) =>
            String(v ?? '').toLowerCase().includes(q),
          )
        : true,
    )
    .sort((a, b) => (a.issued_at < b.issued_at ? 1 : -1));
}

export function licenseById(store: Store, licenseId: string): LicenseRecord | null {
  return store.licenses.find((l) => l.license_id === licenseId) ?? null;
}

export function licensesForCustomer(store: Store, customerId: string): LicenseRecord[] {
  return listLicenses(store, { customerId });
}

/* ------------------------------------------------------------------ */
/* Dashboard + reports                                                 */
/* ------------------------------------------------------------------ */

export interface Summary {
  customers: number;
  licenses: number;
  active: number;
  expiring_soon: number;
  expired: number;
  revoked: number;
  superseded: number;
  lifetime: number;
  issued_30d: number;
  by_edition: Record<Edition, number>;
}

export function summarize(store: Store, now = new Date()): Summary {
  const by_edition: Record<Edition, number> = { standard: 0, pro: 0, enterprise: 0 };
  let active = 0;
  let expiring = 0;
  let expired = 0;
  let revoked = 0;
  let superseded = 0;
  let lifetime = 0;
  let issued30 = 0;
  for (const record of store.licenses) {
    const state = licenseState(record, now);
    by_edition[record.edition] = (by_edition[record.edition] ?? 0) + 1;
    if (state === 'active') {
      active += 1;
      if (!record.expires_at) lifetime += 1;
      const days = daysToExpiry(record, now);
      if (days !== null && days <= 30) expiring += 1;
    } else if (state === 'expired') expired += 1;
    else if (state === 'revoked') revoked += 1;
    else superseded += 1;
    if (now.getTime() - new Date(record.issued_at).getTime() <= 30 * 86_400_000) issued30 += 1;
  }
  return {
    customers: store.customers.length,
    licenses: store.licenses.length,
    active,
    expiring_soon: expiring,
    expired,
    revoked,
    superseded,
    lifetime,
    issued_30d: issued30,
    by_edition,
  };
}

export interface ReportDefinition {
  id: string;
  title: string;
  note: string;
  columns: { key: string; label: string; align?: 'left' | 'right' | 'center' }[];
}

export const REPORTS: ReportDefinition[] = [
  {
    id: 'customers',
    title: 'কাস্টমার রেজিস্টার',
    note: 'সব নিবন্ধিত কাস্টমার ও তাদের লাইসেন্স সংখ্যা',
    columns: [
      { key: 'code', label: 'কোড' },
      { key: 'name', label: 'প্রতিষ্ঠান' },
      { key: 'owner', label: 'মালিক' },
      { key: 'phone', label: 'ফোন' },
      { key: 'city', label: 'শহর' },
      { key: 'licenses', label: 'লাইসেন্স', align: 'right' },
      { key: 'active', label: 'সক্রিয়', align: 'right' },
    ],
  },
  {
    id: 'licenses',
    title: 'লাইসেন্স রেজিস্টার',
    note: 'সব ইস্যু করা লাইসেন্স ও তাদের বর্তমান অবস্থা',
    columns: [
      { key: 'license_id', label: 'লাইসেন্স আইডি' },
      { key: 'org', label: 'প্রতিষ্ঠান' },
      { key: 'edition', label: 'এডিশন' },
      { key: 'issued_at', label: 'ইস্যু' },
      { key: 'expires_at', label: 'মেয়াদ' },
      { key: 'state', label: 'অবস্থা' },
    ],
  },
  {
    id: 'lifetime',
    title: 'লাইফটাইম লাইসেন্স রেজিস্টার',
    note: 'মেয়াদহীন (লাইফটাইম) লাইসেন্স',
    columns: [
      { key: 'license_id', label: 'লাইসেন্স আইডি' },
      { key: 'org', label: 'প্রতিষ্ঠান' },
      { key: 'edition', label: 'এডিশন' },
      { key: 'max_devices', label: 'ডিভাইস', align: 'right' },
      { key: 'issued_at', label: 'ইস্যু' },
    ],
  },
  {
    id: 'expiry',
    title: 'মেয়াদ শেষের রিপোর্ট',
    note: '৬০ দিনের মধ্যে মেয়াদ শেষ হবে এমন লাইসেন্স',
    columns: [
      { key: 'license_id', label: 'লাইসেন্স আইডি' },
      { key: 'org', label: 'প্রতিষ্ঠান' },
      { key: 'expires_at', label: 'মেয়াদ শেষ' },
      { key: 'days', label: 'দিন বাকি', align: 'right' },
      { key: 'phone', label: 'ফোন' },
    ],
  },
  {
    id: 'reissues',
    title: 'রি-ইস্যু রিপোর্ট',
    note: 'কোন লাইসেন্স কোনটি প্রতিস্থাপন করেছে',
    columns: [
      { key: 'license_id', label: 'নতুন লাইসেন্স' },
      { key: 'replaces', label: 'পুরোনো লাইসেন্স' },
      { key: 'org', label: 'প্রতিষ্ঠান' },
      { key: 'issued_at', label: 'তারিখ' },
      { key: 'reason', label: 'কারণ' },
    ],
  },
  {
    id: 'revocations',
    title: 'প্রত্যাহার রেকর্ড',
    note: 'অফলাইন মডেলে প্রত্যাহার শুধু এই মেশিনের রেকর্ড ও পুনরায় ইস্যু নিয়ন্ত্রণে কাজ করে',
    columns: [
      { key: 'license_id', label: 'লাইসেন্স আইডি' },
      { key: 'org', label: 'প্রতিষ্ঠান' },
      { key: 'revoked_at', label: 'প্রত্যাহার' },
      { key: 'reason', label: 'কারণ' },
    ],
  },
  {
    id: 'activity',
    title: 'লাইসেন্স অ্যাক্টিভিটি',
    note: 'লেজার থেকে সব ঘটনা (নতুন → পুরোনো)',
    columns: [
      { key: 'at', label: 'সময়' },
      { key: 'action', label: 'কাজ' },
      { key: 'license_id', label: 'লাইসেন্স' },
      { key: 'org', label: 'প্রতিষ্ঠান' },
      { key: 'key_id', label: 'কী আইডি' },
      { key: 'reason', label: 'কারণ' },
    ],
  },
  {
    id: 'audit',
    title: 'প্রশাসনিক অডিট লগ',
    note: 'প্রতিটি স্বাক্ষরিত নথির কী আইডি ও ফাইল পাথসহ পূর্ণ তালিকা',
    columns: [
      { key: 'at', label: 'সময়' },
      { key: 'license_id', label: 'লাইসেন্স' },
      { key: 'org', label: 'প্রতিষ্ঠান' },
      { key: 'key_id', label: 'কী আইডি' },
      { key: 'device_hash', label: 'ডিভাইস' },
      { key: 'file', label: 'ফাইল' },
    ],
  },
];

export function reportRows(
  store: Store,
  ledger: LedgerEntry[],
  reportId: string,
  now = new Date(),
): { definition: ReportDefinition; rows: string[][] } {
  const definition = REPORTS.find((r) => r.id === reportId);
  if (!definition) throw new Error('রিপোর্ট পাওয়া যায়নি।');
  const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');
  const days = (iso: string | null) => (iso ? String(daysToExpiry({ expires_at: iso } as LicenseRecord, now) ?? '—') : '—');

  switch (reportId) {
    case 'customers':
      return {
        definition,
        rows: store.customers.map((c) => {
          const list = licensesForCustomer(store, c.id);
          return [
            c.code,
            c.name,
            c.owner || '—',
            c.phone || '—',
            c.city || '—',
            String(list.length),
            String(list.filter((l) => licenseState(l, now) === 'active').length),
          ];
        }),
      };
    case 'licenses':
      return {
        definition,
        rows: listLicenses(store).map((l) => [
          l.license_id,
          l.org,
          l.edition,
          fmtDate(l.issued_at),
          l.expires_at ? fmtDate(l.expires_at) : 'লাইফটাইম',
          licenseState(l, now),
        ]),
      };
    case 'lifetime':
      return {
        definition,
        rows: store.licenses
          .filter((l) => !l.expires_at)
          .map((l) => [l.license_id, l.org, l.edition, String(l.max_devices), fmtDate(l.issued_at)]),
      };
    case 'expiry':
      return {
        definition,
        rows: store.licenses
          .filter((l) => l.expires_at && !l.revoked_at && !l.superseded_by)
          .filter((l) => {
            const d = daysToExpiry(l, now);
            return d !== null && d <= 60;
          })
          .sort((a, b) => String(a.expires_at).localeCompare(String(b.expires_at)))
          .map((l) => [l.license_id, l.org, fmtDate(l.expires_at), days(l.expires_at), l.phone ?? '—']),
      };
    case 'reissues':
      return {
        definition,
        rows: store.licenses
          .filter((l) => l.replaces)
          .map((l) => [l.license_id, l.replaces ?? '—', l.org, fmtDate(l.issued_at), l.note ?? '—']),
      };
    case 'revocations':
      return {
        definition,
        rows: store.licenses
          .filter((l) => l.revoked_at)
          .map((l) => [l.license_id, l.org, fmtDate(l.revoked_at), l.revoke_reason ?? '—']),
      };
    case 'activity':
      return {
        definition,
        rows: ledger.map((e) => [e.at.slice(0, 19).replace('T', ' '), e.action, e.license_id, e.org, e.key_id, e.reason ?? '—']),
      };
    case 'audit':
      return {
        definition,
        rows: ledger.map((e) => [
          e.at.slice(0, 19).replace('T', ' '),
          e.license_id,
          e.org,
          e.key_id,
          e.device_hash ?? '—',
          e.file ?? '—',
        ]),
      };
    default:
      return { definition, rows: [] };
  }
}

/* ------------------------------------------------------------------ */
/* Ledger                                                              */
/* ------------------------------------------------------------------ */

export function appendLedger(file: string, entry: Omit<LedgerEntry, 'id' | 'at'>): LedgerEntry {
  const full: LedgerEntry = {
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: nowIso(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(full)}\n`, 'utf8');
  return full;
}

/**
 * Record ledger entries and save the licence store as one step (v1.1.5, audit finding A-27).
 *
 * The store (`licenses-admin.json`) and the ledger (`issue-ledger.jsonl`) are two records of the same
 * fact, and the ledger is what stops a revoked licence being re-issued. Writing the store first and
 * appending to the ledger afterwards — which is what this app did — meant a failure in between left
 * the store saying "revoked" and the ledger with no such line.
 *
 * `writeStore` already replaces its file atomically, so the store is never half-written; the missing
 * half was the ledger. This helper appends the entries, then saves the store, and truncates the
 * ledger back to its previous length if the save fails. A crash *between* the two renames is still
 * outside what two files can promise — that limit is documented rather than papered over.
 */
export function commitLedgerAndStore(
  ledgerFile: string,
  entries: ReadonlyArray<Omit<LedgerEntry, 'id' | 'at'>>,
  save: () => void,
): LedgerEntry[] {
  const before = fs.existsSync(ledgerFile) ? fs.statSync(ledgerFile).size : 0;
  const written: LedgerEntry[] = [];
  try {
    for (const entry of entries) written.push(appendLedger(ledgerFile, entry));
    save();
    return written;
  } catch (error) {
    try {
      if (fs.existsSync(ledgerFile)) fs.truncateSync(ledgerFile, before);
    } catch {
      // The save failed and the ledger could not be trimmed: report the original failure, which is
      // the one the owner can act on.
    }
    throw error;
  }
}

export function listLedger(file: string): LedgerEntry[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as LedgerEntry;
      } catch {
        return null;
      }
    })
    .filter((x): x is LedgerEntry => Boolean(x))
    .reverse();
}

/**
 * Licence ids whose *newest* ledger entry is a revocation.
 *
 * The ledger is read newest-first, so the first entry seen for an id is the one
 * that decides its state. (The previous implementation walked newest → oldest
 * and let an older "issued" entry cancel a newer revocation.)
 */
export function revokedIds(file: string): string[] {
  const latestAction = new Map<string, LedgerEntry['action']>();
  for (const entry of listLedger(file)) {
    if (!latestAction.has(entry.license_id)) latestAction.set(entry.license_id, entry.action);
  }
  return [...latestAction.entries()].filter(([, action]) => action === 'revoked').map(([id]) => id);
}

/* ------------------------------------------------------------------ */
/* Backup                                                              */
/* ------------------------------------------------------------------ */

export interface BackupBundle {
  kind: 'sauda-license-admin-backup';
  v: 1;
  created_at: string;
  store: Store;
  ledger: LedgerEntry[];
}

export function buildBackup(store: Store, ledger: LedgerEntry[]): BackupBundle {
  return { kind: 'sauda-license-admin-backup', v: 1, created_at: nowIso(), store, ledger };
}

export function parseBackup(content: string): BackupBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('ব্যাকআপ ফাইলটি JSON নয়।');
  }
  const bundle = parsed as BackupBundle;
  if (!bundle || bundle.kind !== 'sauda-license-admin-backup') throw new Error('এটি সাউদা প্রশাসনিক ব্যাকআপ ফাইল নয়।');
  if (!bundle.store || !Array.isArray(bundle.store.customers) || !Array.isArray(bundle.store.licenses)) {
    throw new Error('ব্যাকআপের স্টোর অংশটি অসম্পূর্ণ।');
  }
  return bundle;
}
