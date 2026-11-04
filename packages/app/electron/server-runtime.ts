import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startRpcHost, type RpcHost, type RpcUser, type RpcResponse } from '@sauda/core';

/**
 * Background Main Server runtime (v1.1.4, Phase 2).
 *
 * Deliberately **electron-free**: the runtime knows nothing about BrowserWindow, so
 * the UI can be closed, hidden or destroyed without touching the server. The app's
 * main process wires Electron concerns (tray, window, auto-start) to this class.
 *
 * Guarantees implemented here:
 *  - one instance per lock file *and* per process, so a second launch cannot claim
 *    the same store while the first is alive;
 *  - an explicit state machine (`stopped`/`starting`/`running`/`stopping`/`error`)
 *    instead of a bare "is the http server up" boolean;
 *  - a clear failure for a busy port instead of an unhandled exception;
 *  - automatic restart after a crash, with exponential backoff and a cap;
 *  - a health snapshot the UI/tray can poll (state, port, clients, uptime, restarts,
 *    database check, last backup);
 *  - graceful stop: stops accepting connections, lets in-flight requests finish,
 *    then releases the lock. Nothing is written to the database by the runtime
 *    itself, so a stop can never corrupt a business transaction.
 */

export type ServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface ServerHealth {
  state: ServerState;
  port: number | null;
  addresses: string[];
  clients: number;
  started_at: string | null;
  uptime_ms: number;
  restarts: number;
  last_error: string | null;
  last_error_code: string | null;
  db_ok: boolean;
  db_detail: string | null;
  last_backup_at: string | null;
  auto_restart: boolean;
  /** True when the process owns the lock file for this store. */
  lock_held: boolean;
}

export interface ServerRuntimeDeps {
  port: number;
  token: () => string;
  version: string;
  businessName: () => string;
  authenticate: (username: string, password: string) => Promise<RpcUser>;
  invoke: (method: string, args: unknown[], user: RpcUser | null) => Promise<RpcResponse>;
  log?: (level: 'info' | 'warn' | 'error', message: string, detail?: unknown) => void;
  /** Lock file that prevents two server processes for one store. */
  lockFile: string;
  /** Database health probe (`PRAGMA quick_check`); never mutates. */
  dbCheck?: () => { ok: boolean; detail?: string | null };
  /** Last successful backup timestamp for the status panel. */
  lastBackupAt?: () => string | null;
  /** Restart backoff base; tests pass a tiny value. */
  restartDelayMs?: number;
  maxRestartAttempts?: number;
  sessionTtlMs?: number;
}

export class ServerBusyError extends Error {
  code = 'SERVER_ALREADY_RUNNING';
  constructor(message: string) {
    super(message);
    this.name = 'ServerBusyError';
  }
}

export class ServerStartError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ServerStartError';
  }
}

/** Lock files currently held by *this* process, keyed by absolute path. */
const inProcessLocks = new Set<string>();

interface LockRecord {
  pid: number;
  instance: string;
  server: string;
  started_at: string;
}

export class ServerRuntime {
  private host: RpcHost | null = null;
  private _state: ServerState = 'stopped';
  private startedAt: number | null = null;
  private lastError: string | null = null;
  private lastErrorCode: string | null = null;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  private autoRestart = true;
  private lockHeld = false;
  private readonly instanceId = crypto.randomUUID();
  private readonly listeners = new Set<(health: ServerHealth) => void>();

  constructor(private readonly deps: ServerRuntimeDeps) {}

  get state(): ServerState {
    return this._state;
  }

  get port(): number | null {
    return this.host?.port ?? null;
  }

  isRunning(): boolean {
    return this._state === 'running' && this.host !== null;
  }

  onStateChange(listener: (health: ServerHealth) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  health(): ServerHealth {
    let dbOk = true;
    let dbDetail: string | null = null;
    if (this.deps.dbCheck) {
      try {
        const check = this.deps.dbCheck();
        dbOk = check.ok;
        dbDetail = check.detail ?? null;
      } catch (err) {
        dbOk = false;
        dbDetail = (err as Error).message;
      }
    }
    let lastBackupAt: string | null = null;
    if (this.deps.lastBackupAt) {
      try {
        lastBackupAt = this.deps.lastBackupAt();
      } catch {
        lastBackupAt = null;
      }
    }
    return {
      state: this._state,
      port: this.host?.port ?? null,
      addresses: this.host?.addresses ?? [],
      clients: this.host ? this.host.sessionCount() : 0,
      started_at: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      uptime_ms: this.startedAt && this._state === 'running' ? Date.now() - this.startedAt : 0,
      restarts: this.restarts,
      last_error: this.lastError,
      last_error_code: this.lastErrorCode,
      db_ok: dbOk,
      db_detail: dbDetail,
      last_backup_at: lastBackupAt,
      auto_restart: this.autoRestart,
      lock_held: this.lockHeld,
    };
  }

  private emit(): void {
    const health = this.health();
    for (const listener of this.listeners) {
      try {
        listener(health);
      } catch {
        /* a broken listener must never break the server */
      }
    }
  }

  private setState(state: ServerState): void {
    this._state = state;
    this.emit();
  }

  /* ---------------------------------------------------------------- */
  /* Start / stop / restart                                            */
  /* ---------------------------------------------------------------- */

  async start(port?: number): Promise<ServerHealth> {
    if (this._state === 'running') return this.health();
    if (this._state === 'starting' || this._state === 'stopping') {
      throw new ServerStartError('SERVER_BUSY', 'সার্ভার এখন ব্যস্ত — একটু পরে আবার চেষ্টা করুন।');
    }
    this.setState('starting');
    this.lastError = null;
    this.lastErrorCode = null;

    try {
      this.acquireLock();
      const token = this.deps.token();
      if (!token || token.length < 32) {
        throw new ServerStartError('TOKEN_MISSING', 'সার্ভারের টোকেন তৈরি হয়নি — সেটিংসে টোকেন নবায়ন করুন।');
      }
      this.host = await startRpcHost({
        port: port ?? this.deps.port,
        token,
        version: this.deps.version,
        businessName: this.deps.businessName,
        authenticate: this.deps.authenticate,
        invoke: this.deps.invoke,
        sessionTtlMs: this.deps.sessionTtlMs,
        onLog: (level, message, detail) => this.deps.log?.(level, message, detail),
      });
      this.startedAt = Date.now();
      this.restartAttempts = 0;
      this.setState('running');
      this.deps.log?.('info', 'server runtime running', {
        port: this.host.port,
        addresses: this.host.addresses,
      });
      return this.health();
    } catch (err) {
      this.releaseLock();
      this.host = null;
      this._state = 'error';
      this.lastError = (err as Error).message;
      this.lastErrorCode = (err as { code?: string }).code ?? 'SERVER_START_FAILED';
      this.deps.log?.('error', 'server runtime failed to start', {
        code: this.lastErrorCode,
        message: this.lastError,
      });
      this.emit();
      throw err;
    }
  }

  /**
   * Graceful stop: the listener stops accepting new connections, in-flight requests
   * are allowed to settle, then the lock is released. Safe to call twice.
   */
  async stop(): Promise<ServerHealth> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const host = this.host;
    if (!host) {
      // Nothing is listening — still release a lock left behind by a failed start.
      this.releaseLock();
      this.host = null;
      this.startedAt = null;
      if (this._state !== 'stopped') this.setState('stopped');
      else this.emit();
      return this.health();
    }
    this.setState('stopping');
    this.host = null;
    try {
      await host.stop();
    } catch (err) {
      this.deps.log?.('warn', 'server stop reported an error', err);
    }
    this.releaseLock();
    this.startedAt = null;
    this._state = 'stopped';
    this.emit();
    this.deps.log?.('info', 'server runtime stopped');
    return this.health();
  }

  async restart(): Promise<ServerHealth> {
    const port = this.host?.port ?? this.deps.port;
    await this.stop();
    this.restarts += 1;
    return this.start(port);
  }

  /**
   * Called from the process-level crash handlers. Keeps the server alive when the
   * UI (or an unrelated feature) throws, with exponential backoff so a permanent
   * fault does not spin the CPU.
   */
  reportCrash(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.lastErrorCode = 'SERVER_CRASHED';
    this.deps.log?.('error', 'server crash reported', { message: this.lastError });
    if (!this.autoRestart) {
      this.setState('error');
      return;
    }
    if (this.restartAttempts >= (this.deps.maxRestartAttempts ?? 5)) {
      this.deps.log?.('error', 'server auto-restart exhausted', { attempts: this.restartAttempts });
      this.setState('error');
      return;
    }
    const delay = Math.min(30_000, (this.deps.restartDelayMs ?? 1000) * 2 ** this.restartAttempts);
    this.restartAttempts += 1;
    this.setState('error');
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.restart().catch((err) => {
        this.deps.log?.('error', 'server auto-restart failed', err);
      });
    }, delay);
  }

  /** Watchdog: if we think we are running but the listener is gone, restart it. */
  async ensureRunning(): Promise<ServerHealth> {
    if (this._state === 'running' && this.host) return this.health();
    if (this._state === 'stopped') return this.health();
    return this.restart();
  }

  setAutoRestart(enabled: boolean): void {
    this.autoRestart = enabled;
    this.emit();
  }

  /* ---------------------------------------------------------------- */
  /* Single-instance lock                                              */
  /* ---------------------------------------------------------------- */

  private acquireLock(): void {
    const file = path.resolve(this.deps.lockFile);
    if (inProcessLocks.has(file)) {
      throw new ServerBusyError(
        'এই প্রক্রিয়াতেই সার্ভার ইতিমধ্যে চলছে — দুইবার চালু করা যাবে না।',
      );
    }
    const record: LockRecord = {
      pid: process.pid,
      instance: this.instanceId,
      server: this.deps.businessName(),
      started_at: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const existing = this.readLock(file);
      if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
        throw new ServerBusyError(
          `অন্য একটি প্রক্রিয়া (PID ${existing.pid}) এই দোকানের সার্ভার চালাচ্ছে — সেটি বন্ধ করুন বা ওই অ্যাপই ব্যবহার করুন।`,
        );
      }
      fs.writeFileSync(file, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
      inProcessLocks.add(file);
      this.lockHeld = true;
    } catch (err) {
      if (err instanceof ServerBusyError) throw err;
      throw new ServerStartError(
        'LOCK_FAILED',
        `সার্ভার লক ফাইল তৈরি করা যায়নি (${(err as Error).message})।`,
      );
    }
  }

  private readLock(file: string): LockRecord | null {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as LockRecord;
      if (!parsed || typeof parsed.pid !== 'number') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private releaseLock(): void {
    const file = path.resolve(this.deps.lockFile);
    if (!inProcessLocks.has(file)) {
      this.lockHeld = false;
      return;
    }
    try {
      const existing = this.readLock(file);
      // Only delete a lock we still own.
      if (!existing || existing.instance === this.instanceId) fs.rmSync(file, { force: true });
    } catch {
      /* best effort — a stale lock is reclaimed on the next start */
    }
    inProcessLocks.delete(file);
    this.lockHeld = false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/* ------------------------------------------------------------------ */
/* Pure decisions (unit-testable, no Electron, no I/O)                 */
/* ------------------------------------------------------------------ */

export interface LifecycleSettings {
  lan_mode: 'off' | 'host' | 'terminal';
  server_autostart: 0 | 1;
}

/**
 * Should the Main Server start by itself when the app launches?
 * Only a host-role installation may run a server, and only when the operator
 * enabled it. A terminal must never accidentally become a second authority.
 */
export function shouldAutoStartServer(settings: LifecycleSettings): boolean {
  return settings.lan_mode === 'host' && settings.server_autostart === 1;
}

export type WindowCloseAction = 'hide-to-tray' | 'allow-close';

/**
 * Closing the POS window must not stop a running server. When the server is up we
 * hide the window to the tray; the operator stops the server explicitly.
 */
export function decideWindowCloseAction(input: {
  serverRunning: boolean;
  keepRunning: 0 | 1;
  quitting: boolean;
}): WindowCloseAction {
  if (input.quitting) return 'allow-close';
  if (!input.serverRunning) return 'allow-close';
  if (input.keepRunning !== 1) return 'allow-close';
  return 'hide-to-tray';
}

/** Human-readable status for the tray tooltip / settings screen. */
export function describeServerState(health: ServerHealth): string {
  switch (health.state) {
    case 'running':
      return `সার্ভার চালু · পোর্ট ${health.port} · ক্লায়েন্ট ${health.clients}`;
    case 'starting':
      return 'সার্ভার চালু হচ্ছে…';
    case 'stopping':
      return 'সার্ভার বন্ধ হচ্ছে…';
    case 'error':
      return `সার্ভার ত্রুটি${health.last_error ? `: ${health.last_error}` : ''}`;
    default:
      return 'সার্ভার বন্ধ';
  }
}
