import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DeviceKeyStore, DeviceKeyError, type Sealer } from '@sauda/core';
import { OfflineError, V1Terminal, type TerminalStatus } from './v1-transport.js';

/**
 * Client-PC terminal manager (Phase 3, Milestone D).
 *
 * The renderer never talks to the Main PC itself. `main.ts` hands it this manager
 * through a few IPC routes; the manager owns
 *
 *  - the saved trusted servers (`terminal.json`): address, pinned SHA-256 fingerprint
 *    and certificate PEM — **no shared secret is stored**, the device key is the
 *    credential and it lives in the sealed device-key file (DPAPI on Windows);
 *  - the single `V1Terminal` used for every remote route;
 *  - the last event id, so a restart resumes the stream instead of replaying.
 *
 * The legacy `lan_host_url` + `lan_token` transport is deliberately absent: a client
 * can no longer be configured to send a shop-wide token over plaintext HTTP.
 */

export interface SavedServer {
  id: string;
  base_url: string;
  /** SHA-256 of the server certificate, pinned. */
  fingerprint: string;
  /** The certificate itself, used as the trust anchor. Not a secret. */
  cert_pem: string;
  store_name: string;
  store_id: string;
  added_at: string;
  last_used_at: string | null;
}

export interface TerminalConfig {
  version: 1;
  active_server_id: string | null;
  last_event_id: number;
  servers: SavedServer[];
}

export class TerminalConfigError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'TerminalConfigError';
  }
}

const EMPTY: TerminalConfig = { version: 1, active_server_id: null, last_event_id: 0, servers: [] };

export interface TerminalManagerOptions {
  dataDir: string;
  /** DPAPI-backed sealer in Electron; a substitute in tests. */
  sealer: Sealer;
  log?: (level: 'info' | 'warn' | 'error', message: string, detail?: unknown) => void;
}

export interface EventSink {
  onEvent: (event: { id: number; type: string; data: unknown }) => void;
  onState: (state: 'open' | 'closed' | 'error', detail?: string) => void;
  onResync?: (from: number) => void;
}

export class TerminalManager {
  private readonly configFile: string;
  private readonly keyStore: DeviceKeyStore;
  private config: TerminalConfig;
  private terminal: V1Terminal | null = null;
  private terminalKey = '';
  private sink: EventSink | null = null;
  private stopEvents: (() => void) | null = null;

  constructor(private readonly opts: TerminalManagerOptions) {
    this.configFile = path.join(opts.dataDir, 'terminal.json');
    this.keyStore = new DeviceKeyStore({ dir: opts.dataDir, sealer: opts.sealer });
    this.config = this.load();
  }

  private load(): TerminalConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(this.configFile, 'utf8')) as Partial<TerminalConfig>;
      return {
        version: 1,
        active_server_id: raw.active_server_id ?? null,
        last_event_id: Number(raw.last_event_id ?? 0) || 0,
        servers: Array.isArray(raw.servers)
          ? raw.servers
              .filter((s) => s && typeof s.base_url === 'string')
              .map((s) => ({
                id: String(s.id ?? crypto.randomUUID()),
                base_url: String(s.base_url),
                fingerprint: String(s.fingerprint ?? ''),
                cert_pem: String(s.cert_pem ?? ''),
                store_name: String(s.store_name ?? ''),
                store_id: String(s.store_id ?? ''),
                added_at: String(s.added_at ?? new Date().toISOString()),
                last_used_at: s.last_used_at ?? null,
              }))
          : [],
      };
    } catch {
      // A corrupt file must not invent a server: the user re-adds it explicitly.
      return { ...EMPTY, servers: [] };
    }
  }

  private save(): void {
    fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), { mode: 0o600 });
  }

  get paired(): boolean {
    return this.keyStore.exists();
  }

  get configSnapshot(): TerminalConfig {
    return structuredClone(this.config);
  }

  get activeServer(): SavedServer | null {
    return this.config.servers.find((s) => s.id === this.config.active_server_id) ?? null;
  }

  /** Adds (or refreshes) a trusted server. Only HTTPS with a pin is accepted. */
  configure(input: {
    baseUrl: string;
    fingerprint: string;
    certPem: string;
    storeName?: string;
    storeId?: string;
  }): SavedServer {
    const baseUrl = String(input.baseUrl ?? '').trim().replace(/\/+$/, '');
    const fingerprint = String(input.fingerprint ?? '').trim().toLowerCase().replace(/:/g, '');
    const certPem = String(input.certPem ?? '').trim();
    if (!/^https:\/\/[^\s/]+(:\d+)?$/i.test(baseUrl)) {
      throw new TerminalConfigError('BAD_URL', 'সার্ভারের ঠিকানা https:// দিয়ে হতে হবে (যেমন https://192.168.0.10:4747)।');
    }
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new TerminalConfigError('BAD_FINGERPRINT', 'সার্ভারের সার্টিফিকেট ফিঙ্গারপ্রিন্ট সঠিক নয়।');
    }
    if (!certPem.includes('BEGIN CERTIFICATE')) {
      throw new TerminalConfigError('BAD_CERT', 'সার্ভারের সার্টিফিকেট দেওয়া নেই।');
    }
    const now = new Date().toISOString();
    const existing = this.config.servers.find((s) => s.base_url === baseUrl);
    const server: SavedServer = {
      id: existing?.id ?? crypto.randomUUID(),
      base_url: baseUrl,
      fingerprint,
      cert_pem: certPem,
      store_name: input.storeName ?? existing?.store_name ?? '',
      store_id: input.storeId ?? existing?.store_id ?? '',
      added_at: existing?.added_at ?? now,
      last_used_at: now,
    };
    this.config.servers = existing
      ? this.config.servers.map((s) => (s.id === server.id ? server : s))
      : [...this.config.servers, server];
    this.config.active_server_id = server.id;
    this.save();
    return server;
  }

  useServer(id: string): SavedServer {
    const server = this.config.servers.find((s) => s.id === id);
    if (!server) throw new TerminalConfigError('NOT_FOUND', 'সার্ভারটি সংরক্ষিত নেই।');
    this.config.active_server_id = server.id;
    server.last_used_at = new Date().toISOString();
    this.save();
    return server;
  }

  removeServer(id: string): void {
    this.config.servers = this.config.servers.filter((s) => s.id !== id);
    if (this.config.active_server_id === id) this.config.active_server_id = null;
    this.dropTerminal();
    this.save();
  }

  private dropTerminal(): void {
    this.stopEvents?.();
    this.stopEvents = null;
    this.terminal?.logout();
    this.terminal = null;
    this.terminalKey = '';
  }

  /** The transport for the active server, created on demand. */
  getTerminal(): V1Terminal {
    const server = this.activeServer;
    if (!server) {
      throw new TerminalConfigError('NOT_CONFIGURED', 'কোনো সার্ভার নির্বাচন করা নেই — প্রথমে মূল কম্পিউটার যুক্ত করুন।');
    }
    const key = `${server.id}|${server.base_url}|${server.fingerprint}|${server.cert_pem.length}`;
    if (!this.terminal || this.terminalKey !== key) {
      if (this.terminal && this.terminalKey !== key) this.dropTerminal();
      this.terminal = new V1Terminal({
        store: this.keyStore,
        baseUrl: server.base_url,
        fingerprint: server.fingerprint,
        serverCertPem: server.cert_pem,
        logger: this.opts.log,
      });
      this.terminalKey = key;
    }
    return this.terminal;
  }

  async status(): Promise<{ status: TerminalStatus; server: SavedServer | null; paired: boolean; detail?: unknown }> {
    if (!this.activeServer) return { status: 'offline', server: null, paired: this.paired, detail: { code: 'NOT_CONFIGURED' } };
    if (!this.paired) return { status: 'unpaired', server: this.activeServer, paired: false };
    try {
      const result = await this.getTerminal().status();
      return { status: result.status, server: this.activeServer, paired: true, detail: result.detail };
    } catch (err) {
      if (err instanceof TerminalConfigError) throw err;
      return { status: 'error', server: this.activeServer, paired: true, detail: { message: (err as Error).message } };
    }
  }

  async pair(input: { code: string; licenseId: string; capacity?: number; storeId?: string; deviceName?: string }) {
    const server = this.activeServer;
    if (!server) throw new TerminalConfigError('NOT_CONFIGURED', 'প্রথমে মূল কম্পিউটার যুক্ত করুন (QR/ঠিকানা)।');
    if (!server.store_id) {
      throw new TerminalConfigError('STORE_UNKNOWN', 'সার্ভারের দোকান শনাক্ত হয়নি — QR আবার স্ক্যান করুন।');
    }
    const terminal = this.getTerminal();
    const outcome = await terminal.pair(
      {
        code: String(input.code ?? '').trim(),
        licence: {
          license_id: String(input.licenseId ?? '').trim(),
          store_id: input.storeId ?? server.store_id,
          capacity: input.capacity ?? 1,
        },
        deviceName: input.deviceName,
      },
      server.cert_pem,
    );
    this.save();
    return outcome;
  }

  async login(username: string, password: string) {
    const user = await this.getTerminal().login(username, password);
    this.startEvents();
    return user;
  }

  logout(): void {
    this.stopEvents?.();
    this.stopEvents = null;
    this.terminal?.logout();
  }

  forget(): void {
    this.dropTerminal();
    try {
      this.keyStore.load();
      this.keyStore.remove();
    } catch (err) {
      if (!(err instanceof DeviceKeyError) || err.code !== 'KEY_MISSING') throw err;
    }
    this.config.last_event_id = 0;
    this.save();
  }

  async invoke(method: string, args: unknown[] = [], opts: { idempotencyKey?: string } = {}) {
    if (!this.activeServer) {
      const err = new Error('মূল কম্পিউটারের সাথে সংযোগ নেই।') as Error & { code?: string };
      err.code = 'NOT_CONFIGURED';
      throw err;
    }
    return this.getTerminal().invoke(method, args, opts);
  }

  /** Subscribes the renderer to the authenticated stream. */
  setSink(sink: EventSink | null): void {
    this.sink = sink;
    if (sink) this.startEvents();
    else {
      this.stopEvents?.();
      this.stopEvents = null;
    }
  }

  private startEvents(): void {
    if (!this.sink) return;
    let terminal: V1Terminal;
    try {
      terminal = this.getTerminal();
    } catch {
      return;
    }
    if (!terminal.paired) return;
    try {
      terminal.openEvents({
        lastEventId: this.config.last_event_id || undefined,
        onEvent: (event) => {
          if (event.id <= this.config.last_event_id) return; // duplicate after a resume
          this.config.last_event_id = event.id;
          this.save();
          this.sink?.onEvent(event);
        },
        onGap: (from, to) => this.sink?.onResync?.(from),
        onState: (state, detail) => this.sink?.onState(state, detail),
      });
      this.stopEvents = () => terminal.streamHandle?.close();
    } catch (err) {
      this.opts.log?.('warn', 'terminal event stream not started', { message: (err as Error).message });
    }
  }
}

let manager: TerminalManager | null = null;

export function initTerminalManager(next: TerminalManager | null): void {
  manager = next;
}

export function getTerminalManager(): TerminalManager | null {
  return manager;
}

export { OfflineError };
