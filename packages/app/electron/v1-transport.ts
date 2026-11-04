import crypto from 'node:crypto';
import {
  DeviceKeyError,
  DeviceKeyStore,
  createDeviceKeyRecord,
  createV1Client,
  openEventStreamClient,
  type EventStreamHandle,
  type Sealer,
  type V1Client,
  type V1Result,
  type V1User,
} from '@sauda/core';

/**
 * Terminal transport over `/api/v1` (Phase 3, Milestone D).
 *
 * This is the **only** way a Client PC talks to the Main PC: HTTPS with a pinned
 * certificate, an Ed25519 device signature per request, a session bound to the device,
 * and the authenticated SSE stream for updates. The legacy shared-token `/rpc`
 * tunnel is not used and cannot be reached from another PC (it binds loopback only).
 *
 * Electron-free on purpose: the DPAPI sealer is injected (`server/src` passes the
 * `safeStorage` sealer, tests pass a substitute), so the whole pairing/login/rpc/stream
 * lifecycle is testable in plain Node. Nothing here decides permissions — the host does.
 *
 * Offline rules encoded here:
 *  - a write that cannot reach the Main PC throws `OFFLINE`; it is never executed
 *    locally, and nothing is queued that could later commit without the cashier seeing
 *    it again;
 *  - every write carries an idempotency key so a retry after a reconnect cannot create
 *    a second sale/payment;
 *  - reads also fail while offline (the terminal holds no business data), and the
 *    renderer is expected to keep an unsaved cart as a draft it re-validates.
 */

export type TerminalStatus =
  | 'unpaired'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'revoked'
  | 'offline'
  | 'error';

export class OfflineError extends Error {
  code = 'OFFLINE';
  constructor(message = 'মূল কম্পিউটারের সাথে সংযোগ নেই — এই কাজটি এখন করা যাবে না।') {
    super(message);
    this.name = 'OfflineError';
  }
}

export interface TerminalTransportOptions {
  /** Sealed credential storage (DPAPI on Windows). */
  store: DeviceKeyStore;
  baseUrl: string;
  /** SHA-256 pin the client must see (from the pairing QR). */
  fingerprint: string;
  /** The server certificate PEM used as the trust anchor (from pairing/discovery). */
  serverCertPem?: string;
  deviceName?: string;
  /** How long a request may take before it is treated as unreachable. */
  timeoutMs?: number;
  logger?: (level: 'info' | 'warn' | 'error', message: string, detail?: unknown) => void;
}

export interface PairInput {
  code: string;
  licence: { license_id: string; store_id: string; capacity: number; issued_at?: string; expires_at?: string | null; payload?: unknown };
  deviceName?: string;
}

export interface PairOutcome {
  deviceId: string;
  status: 'pending' | 'approved';
}

/**
 * Codes that mean the Main PC no longer accepts this session or this device.
 *
 * They are decided by the server, never here — the client only stops pretending it is still
 * signed in, closes the event stream and asks for a fresh login (which re-opens the stream).
 */
const SESSION_LOST_CODES = new Set(['AUTH_REQUIRED', 'SESSION_EXPIRED', 'SESSION_REVOKED', 'DEVICE_REVOKED']);

/** Methods that change business data and therefore must be idempotent and online-only. */
const WRITE_PREFIXES = [
  'sale.',
  'payment.',
  'pos.',
  'purchase.',
  'inventory.',
  'stock.',
  'product.',
  'customer.',
  'supplier.',
  'expense.',
  'cash.',
  'accounting.',
  'return.',
  'settings.',
  'user.',
  'promotion.',
  'attendance.',
  'backup.restore',
  'license.activate',
];

export function isWriteMethod(method: string): boolean {
  return WRITE_PREFIXES.some((prefix) => method === prefix || method.startsWith(prefix));
}

export class V1Terminal {
  private client: V1Client | null = null;
  private stream: EventStreamHandle | null = null;
  private device: { deviceId: string; privateKeyPem: string; storeId: string } | null = null;
  private lastError: string | null = null;
  private user: V1User | null = null;

  constructor(private readonly opts: TerminalTransportOptions) {}

  get serverCert(): string | null {
    return this.opts.serverCertPem ?? null;
  }

  /** True when this PC already holds a device credential. */
  get paired(): boolean {
    return this.opts.store.exists();
  }

  get currentUser(): V1User | null {
    return this.user;
  }

  get error(): string | null {
    return this.lastError;
  }

  /** Loads the sealed credential (never creates one). */
  private loadCredential(): { deviceId: string; privateKeyPem: string; storeId: string } {
    if (this.device) return this.device;
    const record = this.opts.store.load();
    this.device = { deviceId: record.device_id, privateKeyPem: record.private_key_pem, storeId: record.store_id };
    return this.device;
  }

  private ensureClient(): V1Client {
    if (this.client) return this.client;
    const credential = this.loadCredential();
    this.client = createV1Client({
      baseUrl: this.opts.baseUrl,
      tls: { caPem: this.opts.serverCertPem ?? '', fingerprint: this.opts.fingerprint },
      deviceId: credential.deviceId,
      privateKeyPem: credential.privateKeyPem,
      timeoutMs: this.opts.timeoutMs ?? 12_000,
    });
    return this.client;
  }

  /** The server certificate is pinned by fingerprint; the PEM comes from the QR. */
  /** Supplies the server certificate after a QR scan or a saved-server load. */
  setServerCertificate(certPem: string): void {
    this.opts.serverCertPem = certPem;
    this.client = null;
  }

  /**
   * Enrols this PC with a one-time code. The device is **pending** afterwards; only an
   * administrator on the Main PC can approve it, and a valid shop licence is not
   * sufficient on its own (the host enforces that, not this client).
   */
  async pair(input: PairInput, certPem?: string): Promise<PairOutcome> {
    if (this.opts.store.exists()) {
      throw new DeviceKeyError('KEY_ALREADY_EXISTS', 'এই পিসি আগেই যুক্ত হয়েছে — নতুন করে যুক্ত করার আগে সংযোগ বিচ্ছিন্ন করুন।');
    }
    const deviceId = `DEV-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    const record = createDeviceKeyRecord({ deviceId, storeId: input.licence.store_id });
    // Store first (sealed), so a crash after enrolment cannot lose the key that the
    // server already registered.
    this.opts.store.save(record);
    const client = createV1Client({
      baseUrl: this.opts.baseUrl,
      tls: { caPem: certPem ?? this.opts.serverCertPem ?? '', fingerprint: this.opts.fingerprint },
      deviceId,
      privateKeyPem: record.private_key_pem,
      timeoutMs: this.opts.timeoutMs ?? 12_000,
    });
    const result = await client.claim({
      code: input.code,
      device_id: deviceId,
      device_name: input.deviceName ?? this.opts.deviceName ?? 'নতুন টার্মিনাল',
      public_key: record.public_key_spki_b64,
      license: {
        license_id: input.licence.license_id,
        store_id: input.licence.store_id,
        capacity: input.licence.capacity,
        issued_at: input.licence.issued_at ?? new Date().toISOString(),
        expires_at: input.licence.expires_at ?? null,
        payload: input.licence.payload ?? {},
      },
    });
    if (!result.ok) {
      // A refused claim must not leave a credential behind that pretends to be a device.
      this.opts.store.remove();
      this.lastError = result.error ?? result.code ?? 'PAIRING_FAILED';
      throw new Error(result.error ?? 'পেয়ারিং ব্যর্থ হয়েছে।');
    }
    this.device = { deviceId, privateKeyPem: record.private_key_pem, storeId: input.licence.store_id };
    this.client = client;
    return { deviceId, status: (result.data as { status: 'pending' | 'approved' }).status };
  }

  /** Asks the server whether this device is approved, pending, rejected or revoked. */
  async status(): Promise<{ status: TerminalStatus; detail?: Record<string, unknown> }> {
    if (!this.paired) return { status: 'unpaired' };
    try {
      const res = await this.ensureClient().deviceSelf();
      if (!res.ok) {
        this.lastError = res.error ?? res.code ?? null;
        const code = res.code ?? '';
        if (code === 'DEVICE_REVOKED') return { status: 'revoked' };
        if (code === 'DEVICE_PENDING') return { status: 'pending' };
        if (code === 'UNKNOWN_DEVICE') return { status: 'unpaired' };
        if (code === 'OFFLINE' || code === 'TIMEOUT' || code === 'ECONNREFUSED' || code === 'NETWORK') {
          return { status: 'offline', detail: { code } };
        }
        return { status: 'error', detail: { code } };
      }
      const data = res.data as { status?: string } | undefined;
      const raw = data?.status ?? 'pending';
      const mapped: TerminalStatus = raw === 'approved' ? 'approved' : raw === 'rejected' ? 'rejected' : raw === 'revoked' ? 'revoked' : 'pending';
      return { status: mapped, detail: data };
    } catch (err) {
      this.lastError = (err as Error).message;
      return { status: 'offline', detail: { message: (err as Error).message } };
    }
  }

  async login(username: string, password: string): Promise<V1User> {
    if (!this.paired) throw new Error('এই পিসি এখনো যুক্ত হয়নি — পেয়ারিং করুন।');
    const res = await this.ensureClient().login(username, password);
    if (!res.ok) {
      this.lastError = res.error ?? res.code ?? null;
      if (res.code === 'OFFLINE' || res.code === 'TIMEOUT') throw new OfflineError(res.error ?? undefined);
      throw new Error(res.error ?? 'লগইন ব্যর্থ হয়েছে।');
    }
    this.user = res.data!.user;
    return this.user;
  }

  /**
   * Runs a route on the Main PC. Reads and writes both require a live connection; a
   * write always carries an idempotency key so a retry cannot duplicate it.
   */
  async invoke<T = unknown>(method: string, args: unknown[] = [], opts: { idempotencyKey?: string } = {}): Promise<T> {
    if (!this.paired) throw new Error('এই পিসি এখনো যুক্ত হয়নি — পেয়ারিং করুন।');
    const client = this.ensureClient();
    if (!client.session) throw new Error('লগইন করুন।');
    const key = isWriteMethod(method) ? (opts.idempotencyKey ?? crypto.randomUUID()) : undefined;
    const res = await client.rpc<T>(method, args, { idempotencyKey: key });
    if (!res.ok) {
      this.lastError = res.error ?? res.code ?? null;
      // An expired/revoked session must not look like a transient failure: drop the session
      // (and the stream) so the UI returns to the login screen instead of retrying forever.
      if (SESSION_LOST_CODES.has(String(res.code ?? ''))) this.logout();
      if (res.code === 'OFFLINE' || res.code === 'TIMEOUT') {
        throw new OfflineError(res.error ?? undefined);
      }
      const error = new Error(res.error ?? 'অনুরোধ ব্যর্থ হয়েছে।') as Error & { code?: string; details?: unknown };
      error.code = res.code;
      // Structured conflicts (stale cart) must reach the renderer intact.
      if (res.details !== undefined) error.details = res.details;
      throw error;
    }
    return res.data as T;
  }

  /** Opens the authenticated event stream; reconnects automatically. */
  openEvents(handlers: {
    onEvent: (event: { id: number; type: string; data: unknown }) => void;
    onGap?: (from: number, toInclusive: number) => void;
    onState?: (state: 'open' | 'closed' | 'error', detail?: string) => void;
    lastEventId?: number;
  }): void {
    const client = this.ensureClient();
    if (!client.session) throw new Error('ইভেন্ট স্ট্রিমের আগে লগইন করুন।');
    this.stream?.close();
    const certPem = this.opts.serverCertPem ?? '';
    if (!certPem) throw new Error('সার্ভারের সার্টিফিকেট নেই — নতুন করে পেয়ারিং করুন।');
    this.stream = openEventStreamClient({
      baseUrl: this.opts.baseUrl,
      tls: { caPem: certPem, fingerprint: this.opts.fingerprint },
      deviceId: this.loadCredential().deviceId,
      privateKeyPem: this.loadCredential().privateKeyPem,
      session: client.session,
      lastEventId: handlers.lastEventId,
      onEvent: (event) => handlers.onEvent({ id: event.id, type: event.type, data: event.data }),
      onGap: handlers.onGap,
      onOpen: () => handlers.onState?.('open'),
      onError: (err) => {
        this.lastError = err.message;
        handlers.onState?.(err.retryable ? 'closed' : 'error', err.message);
      },
    });
  }

  get streamHandle(): EventStreamHandle | null {
    return this.stream;
  }

  logout(): void {
    this.stream?.close();
    this.stream = null;
    this.client?.logout();
    this.user = null;
  }

  /** Forgets this PC's credential (the Main PC must revoke it separately). */
  forget(): void {
    this.logout();
    this.opts.store.remove();
    this.device = null;
    this.client = null;
  }
}

/** Convenience factory used by the Electron main process. */
export function createTerminalTransport(opts: TerminalTransportOptions): V1Terminal {
  return new V1Terminal(opts);
}

export type { Sealer };
