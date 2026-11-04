import path from 'node:path';
import { safeStorage } from 'electron';
import { DeviceKeyStore, type Sealer } from '@sauda/core';

/**
 * Windows credential sealing for the device private key (Phase 3, Priority 1).
 *
 * Electron `safeStorage` is DPAPI-backed on Windows: the ciphertext is bound to the
 * logged-in Windows user (the same boundary that already protects the shop
 * database). Core owns the envelope and the failure policy
 * (`packages/core/src/net/device-keys.ts`); this file only supplies the seal.
 *
 * Deliberate decisions:
 *  - `isEncryptionAvailable() === false` throws. There is **no** plaintext
 *    fallback, and no "temporary" file that is encrypted later.
 *  - The `kind` string records the platform and scope, so a credential copied to
 *    another machine or another Windows user is reported as inaccessible instead
 *    of being used.
 *  - Machine-scope DPAPI is **not** supported: it would let any local user on the
 *    PC sign requests as this device. See docs/V1.1.4_PHASE3_CREDENTIAL_STORAGE.md.
 *
 * NOT VERIFIED in this sandbox: no Windows, no Electron runtime, no DPAPI. Only the
 * envelope and the failure policy are covered by automated tests (with a substitute
 * sealer). The Windows behaviour needs the manual procedure in the docs.
 */

function scopeKind(): string {
  // On Windows, safeStorage is DPAPI in the current user's scope.
  if (process.platform === 'win32') return 'dpapi-user';
  return `safe-storage-${process.platform}`;
}

function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'এই মেশিনে নিরাপদ কী সংরক্ষণ পাওয়া যাচ্ছে না (DPAPI/safeStorage unavailable) — ডিভাইস কী ফাইলে লেখা হবে না।',
    );
  }
}

export const dpapiSealer: Sealer = {
  get kind() {
    return scopeKind();
  },
  seal(plain: Buffer): Buffer {
    requireEncryption();
    return safeStorage.encryptString(plain.toString('utf8'));
  },
  unseal(sealed: Buffer): Buffer {
    requireEncryption();
    return Buffer.from(safeStorage.decryptString(sealed), 'utf8');
  },
};

/** Device credential store inside the app profile directory. */
export function deviceKeyStore(profileDir: string): DeviceKeyStore {
  return new DeviceKeyStore({ dir: path.join(profileDir, 'device'), sealer: dpapiSealer });
}

/** True when this machine can protect a device credential at all. */
export function canStoreDeviceKey(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}
