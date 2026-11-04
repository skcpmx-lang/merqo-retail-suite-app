import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Device private-key storage (Phase 3, Priority 1).
 *
 * A client PC holds the Ed25519 private key that signs every request. That key is a
 * credential: if it sits in plaintext in the profile directory, copying one file
 * turns any other PC into that device.
 *
 * Core therefore never decides *how* bytes are protected. It defines a `Sealer`
 * (seal/unseal) and an envelope format, and the Electron layer supplies a DPAPI
 * sealer backed by Electron `safeStorage` on Windows (see
 * `packages/app/electron/device-key-storage.ts`). In this sandbox the Windows
 * behaviour cannot be exercised, so it is reported as **not verified**; the
 * envelope, the failure modes and the "never regenerate" rules are tested here with
 * a substitute sealer.
 *
 * Rules encoded here (each has a test):
 *  - a missing credential is an explicit `KEY_MISSING`, never a silent new identity;
 *  - a corrupt or unsealable credential is an explicit error, never regeneration;
 *  - a credential that belongs to another device or store is refused
 *    (`KEY_DEVICE_MISMATCH`) instead of being used as "the" device;
 *  - an existing credential is never overwritten unless the caller explicitly asks
 *    to replace it (a fresh enrolment);
 *  - the private key never appears in plaintext on disk.
 */

export type DeviceKeyErrorCode =
  | 'KEY_MISSING'
  | 'KEY_CORRUPT'
  | 'KEY_INACCESSIBLE'
  | 'KEY_DEVICE_MISMATCH'
  | 'KEY_ALREADY_EXISTS'
  | 'SEALER_UNAVAILABLE';

export class DeviceKeyError extends Error {
  code: DeviceKeyErrorCode;
  constructor(code: DeviceKeyErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'DeviceKeyError';
  }
}

/**
 * Seals and unseals credential bytes. A Windows implementation must use DPAPI
 * (`safeStorage`), and must **refuse** rather than fall back to plaintext when the
 * platform cannot encrypt.
 */
export interface Sealer {
  /** Short identifier stored next to the blob, e.g. `dpapi-user`. */
  readonly kind: string;
  seal(plain: Buffer): Buffer;
  unseal(sealed: Buffer): Buffer;
}

export interface DeviceKeyRecord {
  version: 1;
  device_id: string;
  store_id: string;
  public_key_spki_b64: string;
  private_key_pem: string;
  created_at: string;
  sealer: string;
}

export interface DeviceKeyStoreOptions {
  /** Directory that holds the sealed credential (the app profile directory). */
  dir: string;
  sealer: Sealer;
  /** Override for tests; defaults to `device.key`. */
  file?: string;
}

const DEFAULT_FILE = 'device.key';
const MAGIC = 'SAUDA-DK1';

export class DeviceKeyStore {
  private readonly file: string;
  constructor(private readonly opts: DeviceKeyStoreOptions) {
    this.file = path.join(opts.dir, opts.file ?? DEFAULT_FILE);
  }

  get path(): string {
    return this.file;
  }

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  /**
   * Reads and unseals the stored credential. Never creates anything.
   */
  load(expected?: { deviceId?: string; storeId?: string }): DeviceKeyRecord {
    let raw: Buffer;
    try {
      raw = fs.readFileSync(this.file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new DeviceKeyError(
          'KEY_MISSING',
          'এই ডিভাইসের কোনো সংরক্ষিত কী নেই — নতুন পেয়ারিং প্রয়োজন, নিজে থেকে নতুন পরিচয় তৈরি হবে না।',
        );
      }
      throw new DeviceKeyError('KEY_INACCESSIBLE', `ডিভাইসের কী পড়া যায়নি: ${(err as Error).message}`);
    }

    const text = raw.toString('utf8');
    const [magic, kind, ...rest] = text.split('\n');
    if (magic !== MAGIC || !kind || rest.length === 0) {
      throw new DeviceKeyError(
        'KEY_CORRUPT',
        'ডিভাইসের কী ফাইল নষ্ট — নিজে থেকে নতুন কী তৈরি হবে না, পুনরায় পেয়ারিং করুন।',
      );
    }

    let plain: Buffer;
    try {
      if (kind !== this.opts.sealer.kind) {
        throw new DeviceKeyError(
          'KEY_INACCESSIBLE',
          'কী ফাইলটি অন্য নিরাপত্তা-প্রেক্ষাপটে (ভিন্ন Windows ব্যবহারকারী/মেশিন) তৈরি — এই ব্যবহারকারী এটি খুলতে পারবেন না।',
        );
      }
      plain = this.opts.sealer.unseal(Buffer.from(rest.join('\n'), 'base64'));
    } catch (err) {
      if (err instanceof DeviceKeyError) throw err;
      throw new DeviceKeyError(
        'KEY_INACCESSIBLE',
        `ডিভাইসের কী খোলা যায়নি: ${(err as Error).message} — নতুন পেয়ারিং প্রয়োজন।`,
      );
    }

    let record: DeviceKeyRecord;
    try {
      record = JSON.parse(plain.toString('utf8')) as DeviceKeyRecord;
    } catch {
      throw new DeviceKeyError('KEY_CORRUPT', 'ডিভাইসের কী-এর ভেতরের তথ্য পড়া যায়নি।');
    }
    if (!record || record.version !== 1 || !record.device_id || !record.private_key_pem) {
      throw new DeviceKeyError('KEY_CORRUPT', 'ডিভাইসের কী-এর ভেতরের তথ্য অসম্পূর্ণ।');
    }
    assertKeyPair(record);
    if (expected?.deviceId && expected.deviceId !== record.device_id) {
      throw new DeviceKeyError(
        'KEY_DEVICE_MISMATCH',
        'সংরক্ষিত কী অন্য ডিভাইসের — এটি এই ডিভাইস হিসেবে ব্যবহার করা যাবে না।',
      );
    }
    if (expected?.storeId && expected.storeId !== record.store_id) {
      throw new DeviceKeyError(
        'KEY_DEVICE_MISMATCH',
        'সংরক্ষিত কী অন্য স্টোরের — পুনরায় পেয়ারিং প্রয়োজন।',
      );
    }
    return record;
  }

  /**
   * Writes the credential. Refuses to overwrite an existing file unless
   * `replace` is set, so a bug can never quietly swap a working identity.
   */
  save(record: DeviceKeyRecord, options: { replace?: boolean } = {}): void {
    if (!record.device_id || !record.private_key_pem) {
      throw new DeviceKeyError('KEY_CORRUPT', 'সংরক্ষণ করার মতো কী নেই।');
    }
    assertKeyPair(record);
    if (this.exists() && !options.replace) {
      throw new DeviceKeyError('KEY_ALREADY_EXISTS', 'এই ডিভাইসের কী আগেই সংরক্ষিত আছে — প্রতিস্থাপন অনুমোদিত নয়।');
    }
    let sealed: Buffer;
    try {
      sealed = this.opts.sealer.seal(Buffer.from(JSON.stringify({ ...record, sealer: this.opts.sealer.kind }), 'utf8'));
    } catch (err) {
      throw new DeviceKeyError(
        'SEALER_UNAVAILABLE',
        `এই মেশিনে নিরাপদ সংরক্ষণ পাওয়া যাচ্ছে না: ${(err as Error).message}`,
      );
    }
    fs.mkdirSync(this.opts.dir, { recursive: true });
    const body = `${MAGIC}\n${this.opts.sealer.kind}\n${sealed.toString('base64')}\n`;
    // Write the sealed blob first, then rename: a crash cannot leave a half file.
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(temp, 0o600);
    } catch {
      /* Windows ignores POSIX modes; the profile ACL applies instead. */
    }
    fs.renameSync(temp, this.file);
  }

  remove(): void {
    try {
      fs.rmSync(this.file, { force: true });
    } catch (err) {
      throw new DeviceKeyError('KEY_INACCESSIBLE', `কী মুছে ফেলা যায়নি: ${(err as Error).message}`);
    }
  }
}

/** Builds a credential record with a locally generated Ed25519 keypair. */
export function createDeviceKeyRecord(input: {
  deviceId: string;
  storeId: string;
  keys?: { privateKeyPem: string; publicKeySpkiB64: string };
  now?: Date;
}): DeviceKeyRecord {
  const keys = input.keys ?? generateKeys();
  return {
    version: 1,
    device_id: input.deviceId,
    store_id: input.storeId,
    public_key_spki_b64: keys.publicKeySpkiB64,
    private_key_pem: keys.privateKeyPem,
    created_at: (input.now ?? new Date()).toISOString(),
    sealer: '',
  };
}

/**
 * Loads the credential, creating one **only** when the caller explicitly allows it
 * (a first-time pairing on a not-yet-approved device). A missing credential on an
 * already-approved device is an error the operator must resolve by re-pairing.
 */
export function loadOrCreateDeviceKey(
  store: DeviceKeyStore,
  opts: { deviceId: string; storeId: string; allowCreate?: boolean; replace?: boolean },
): { record: DeviceKeyRecord; created: boolean } {
  if (store.exists()) {
    return { record: store.load({ deviceId: opts.deviceId, storeId: opts.storeId }), created: false };
  }
  if (!opts.allowCreate) {
    throw new DeviceKeyError(
      'KEY_MISSING',
      'ডিভাইসের কী নেই — অনুমোদিত ডিভাইসের পরিচয় নিজে থেকে তৈরি হবে না; পুনরায় পেয়ারিং করুন।',
    );
  }
  const record = createDeviceKeyRecord({ deviceId: opts.deviceId, storeId: opts.storeId });
  store.save(record, { replace: opts.replace ?? false });
  return { record, created: true };
}

function generateKeys(): { privateKeyPem: string; publicKeySpkiB64: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeySpkiB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

/** The stored public key must actually belong to the stored private key. */
function assertKeyPair(record: DeviceKeyRecord): void {
  try {
    const privateKey = crypto.createPrivateKey(record.private_key_pem);
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new DeviceKeyError('KEY_CORRUPT', 'সংরক্ষিত কী Ed25519 নয়।');
    }
    const derived = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
    if (record.public_key_spki_b64 && derived !== record.public_key_spki_b64) {
      throw new DeviceKeyError('KEY_CORRUPT', 'সংরক্ষিত পাবলিক কী প্রাইভেট কী-এর সাথে মেলে না।');
    }
  } catch (err) {
    if (err instanceof DeviceKeyError) throw err;
    throw new DeviceKeyError('KEY_CORRUPT', `সংরক্ষিত কী সঠিক নয়: ${(err as Error).message}`);
  }
}
