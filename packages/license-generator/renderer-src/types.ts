export type Edition = 'standard' | 'pro' | 'enterprise';
export type LicenseStateName = 'active' | 'expired' | 'revoked' | 'superseded';

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
  license_count?: number;
  active_count?: number;
}

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
  replaces: string | null;
  superseded_by: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  note: string | null;
  state: LicenseStateName;
}

export interface KeyStatus {
  loaded: boolean;
  keyId?: string;
  publicKeyB64?: string;
  path?: string;
}

export interface Catalog {
  editions: { id: Edition; label: string; note: string }[];
  features: { id: string; label: string; editions: Edition[]; note: string }[];
  reports: { id: string; title: string; note: string; columns: { key: string; label: string; align?: 'left' | 'right' | 'center' }[] }[];
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
}

export interface IssueDraft {
  org: string;
  owner: string;
  phone: string;
  email: string;
  address: string;
  edition: Edition;
  lifetime: boolean;
  expiresAt: string;
  maxDevices: number;
  features: string[];
  note: string;
}

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

export interface VerifyOutcome {
  ok: boolean;
  message: string;
  payload: { license_id: string; org: string; edition: string; expires_at: string | null; max_devices: number; features: string[]; fingerprint: string; issued_at: string } | null;
  licenseKey: string | null;
  revoked: boolean;
  file?: string;
  keyId?: string | null;
}

export const emptyDraft = (editionDefault: Edition = 'standard'): IssueDraft => ({
  org: '',
  owner: '',
  phone: '',
  email: '',
  address: '',
  edition: editionDefault,
  lifetime: false,
  expiresAt: '',
  maxDevices: 1,
  features: [],
  note: '',
});
