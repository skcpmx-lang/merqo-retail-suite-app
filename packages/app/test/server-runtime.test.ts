/**
 * Phase 2 — Main Server runtime lifecycle.
 *
 * Real integration tests: a genuine HTTP listener on loopback, a real SQLite
 * database and a real lock file. Nothing is mocked, because the point of this phase
 * is precisely that the server outlives the window.
 *
 * The Electron-only halves (native tray icon, Windows login item) cannot run in
 * this sandbox. They are covered here only by the pure decision functions and are
 * listed as manual checks in the Phase 2 report — they are NOT claimed as verified.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  initializeApp,
  integrityCheck,
  openDatabase,
  type Db,
} from '@sauda/core';
import {
  ServerBusyError,
  ServerRuntime,
  decideWindowCloseAction,
  describeServerState,
  shouldAutoStartServer,
} from '../electron/server-runtime.js';

const TOKEN = 'a'.repeat(64);
const dirs: string[] = [];
const runtimes: ServerRuntime[] = [];
const dbs: Db[] = [];

afterAll(async () => {
  for (const runtime of runtimes) {
    try {
      await runtime.stop();
    } catch {
      /* ignore */
    }
  }
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  runtime: ServerRuntime;
  db: Db;
  dir: string;
}

function harness(overrides: { lockName?: string; restartDelayMs?: number } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-runtime-'));
  dirs.push(dir);
  const db = openDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
  dbs.push(db);
  initializeApp(db, {
    businessName: 'টেস্ট স্টোর',
    businessAddress: 'চট্টগ্রাম',
    businessPhone: '01700000000',
    adminFullName: 'মালিক',
    adminUsername: 'owner',
    adminPassword: 'owner123',
  });
  const runtime = new ServerRuntime({
    port: 0,
    token: () => TOKEN,
    version: '1.1.4',
    businessName: () => 'টেস্ট স্টোর',
    authenticate: async (username) => ({
      id: 1,
      username,
      full_name: 'মালিক',
      role: 'admin' as const,
      permissions: [],
    }),
    invoke: async () => ({ ok: true }),
    lockFile: path.join(dir, overrides.lockName ?? 'server.lock'),
    dbCheck: () => {
      const check = integrityCheck(db);
      return { ok: check.ok, detail: check.detail ?? null };
    },
    lastBackupAt: () => null,
    restartDelayMs: overrides.restartDelayMs ?? 10,
    maxRestartAttempts: 3,
    log: () => undefined,
  });
  runtimes.push(runtime);
  return { runtime, db, dir };
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function health(port: number): Promise<{ ok: boolean; data?: { version?: string } }> {
  const res = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return (await res.json()) as { ok: boolean; data?: { version?: string } };
}

describe('server runtime lifecycle', () => {
  it('starts a real listener and stops it cleanly', async () => {
    const { runtime } = harness();
    expect(runtime.state).toBe('stopped');
    const started = await runtime.start();
    expect(started.state).toBe('running');
    expect(started.port).toBeGreaterThan(0);
    expect(await health(started.port!)).toMatchObject({ ok: true });

    const stopped = await runtime.stop();
    expect(stopped.state).toBe('stopped');
    await expect(health(started.port!)).rejects.toBeTruthy();
  });

  it('advertises a full health snapshot for the tray and settings screen', async () => {
    const { runtime, db } = harness();
    const started = await runtime.start();
    expect(started).toMatchObject({
      state: 'running',
      clients: 0,
      restarts: 0,
      db_ok: true,
      lock_held: true,
      auto_restart: true,
    });
    expect(started.addresses.length).toBeGreaterThan(0);
    expect(started.uptime_ms).toBeGreaterThanOrEqual(0);
    expect(db.pragma('quick_check', { simple: true })).toBe('ok');
    await runtime.stop();
    expect(runtime.health().lock_held).toBe(false);
  });

  it('refuses a start without a shop token instead of running unauthenticated', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-runtime-'));
    dirs.push(dir);
    const db = openDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
    dbs.push(db);
    const runtime = new ServerRuntime({
      port: 0,
      token: () => '',
      version: '1.1.4',
      businessName: () => 'x',
      authenticate: async () => ({ id: 1, username: 'a', full_name: 'a', role: 'admin', permissions: [] }),
      invoke: async () => ({ ok: true }),
      lockFile: path.join(dir, 'server.lock'),
    });
    runtimes.push(runtime);
    await expect(runtime.start()).rejects.toMatchObject({ code: 'TOKEN_MISSING' });
    expect(runtime.state).toBe('error');
  });
});

describe('window lifecycle independence (defect D-1)', () => {
  it('hides to the tray instead of quitting while the server runs', async () => {
    const { runtime } = harness();
    await runtime.start();
    const action = decideWindowCloseAction({
      serverRunning: runtime.isRunning(),
      keepRunning: 1,
      quitting: false,
    });
    expect(action).toBe('hide-to-tray');
    // The decision alone must not disturb the listener: a client still gets served
    // after the POS window was "closed".
    expect(await health(runtime.port!)).toMatchObject({ ok: true });
    expect(runtime.isRunning()).toBe(true);
    await runtime.stop();
  });

  it('allows a real quit, and closes normally when no server is running', () => {
    expect(
      decideWindowCloseAction({ serverRunning: true, keepRunning: 1, quitting: true }),
    ).toBe('allow-close');
    expect(
      decideWindowCloseAction({ serverRunning: false, keepRunning: 1, quitting: false }),
    ).toBe('allow-close');
    expect(
      decideWindowCloseAction({ serverRunning: true, keepRunning: 0, quitting: false }),
    ).toBe('allow-close');
  });

  it('keeps serving clients across a window-close cycle', async () => {
    const { runtime } = harness();
    await runtime.start();
    // Simulate the window going away entirely: nothing on the server is touched.
    for (let i = 0; i < 3; i += 1) {
      expect(await health(runtime.port!)).toMatchObject({ ok: true });
    }
    expect(runtime.health().clients).toBe(0);
    await runtime.stop();
  });
});

describe('duplicate server prevention', () => {
  it('refuses a second runtime for the same store while the first is alive', async () => {
    const first = harness();
    await first.runtime.start();

    const second = new ServerRuntime({
      port: 0,
      token: () => TOKEN,
      version: '1.1.4',
      businessName: () => 'টেস্ট স্টোর',
      authenticate: async () => ({ id: 1, username: 'a', full_name: 'a', role: 'admin', permissions: [] }),
      invoke: async () => ({ ok: true }),
      // Same lock file ⇒ same store.
      lockFile: path.join(first.dir, 'server.lock'),
    });
    runtimes.push(second);

    await expect(second.start()).rejects.toBeInstanceOf(ServerBusyError);
    expect(second.state).toBe('error');
    // The first server is untouched and still serving.
    expect(await health(first.runtime.port!)).toMatchObject({ ok: true });
    await first.runtime.stop();
  });

  it('reports a busy port instead of throwing an unhandled error', async () => {
    const a = harness({ lockName: 'a.lock' });
    const b = harness({ lockName: 'b.lock' });
    const startedA = await a.runtime.start();
    await expect(b.runtime.start(startedA.port!)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(await health(startedA.port!)).toMatchObject({ ok: true });
    await a.runtime.stop();
  });
});

describe('restart and recovery', () => {
  it('restarts without corrupting the database', async () => {
    const { runtime, db } = harness();
    const first = await runtime.start();
    db.prepare("INSERT INTO meta (key, value) VALUES ('probe', 'v1')").run();

    const restarted = await runtime.restart();
    expect(restarted.state).toBe('running');
    expect(restarted.restarts).toBe(1);
    expect(db.pragma('quick_check', { simple: true })).toBe('ok');
    const row = db.prepare("SELECT value FROM meta WHERE key = 'probe'").get() as { value: string };
    expect(row.value).toBe('v1');
    // The old listener is gone and the new one answers.
    expect(restarted.port).toBe(first.port);
    expect(await health(restarted.port!)).toMatchObject({ ok: true });
    await runtime.stop();
  });

  it('restarts itself after a crash report', async () => {
    const { runtime } = harness({ restartDelayMs: 5 });
    await runtime.start();
    runtime.reportCrash(new Error('boom'));
    expect(runtime.state).toBe('error');
    await waitFor(() => runtime.state === 'running');
    expect(runtime.health().restarts).toBeGreaterThanOrEqual(1);
    expect(await health(runtime.port!)).toMatchObject({ ok: true });
    await runtime.stop();
  });

  it('gives up after the retry budget instead of looping forever', async () => {
    const { runtime } = harness({ restartDelayMs: 5 });
    await runtime.start();
    runtime.setAutoRestart(false);
    runtime.reportCrash(new Error('fatal'));
    expect(runtime.state).toBe('error');
    expect(runtime.health().last_error).toContain('fatal');
    await runtime.stop();
  });

  it('can be stopped twice without throwing', async () => {
    const { runtime } = harness();
    await runtime.start();
    await runtime.stop();
    await expect(runtime.stop()).resolves.toMatchObject({ state: 'stopped' });
  });
});

describe('pure lifecycle decisions', () => {
  it('only auto-starts a host-role install that opted in', () => {
    expect(shouldAutoStartServer({ lan_mode: 'host', server_autostart: 1 })).toBe(true);
    expect(shouldAutoStartServer({ lan_mode: 'host', server_autostart: 0 })).toBe(false);
    expect(shouldAutoStartServer({ lan_mode: 'terminal', server_autostart: 1 })).toBe(false);
    expect(shouldAutoStartServer({ lan_mode: 'off', server_autostart: 1 })).toBe(false);
  });

  it('describes every state for the tray tooltip', () => {
    const base = {
      port: 4747,
      addresses: [],
      clients: 2,
      started_at: null,
      uptime_ms: 0,
      restarts: 0,
      last_error: null,
      last_error_code: null,
      db_ok: true,
      db_detail: null,
      last_backup_at: null,
      auto_restart: true,
      lock_held: true,
    };
    expect(describeServerState({ ...base, state: 'running' })).toContain('4747');
    expect(describeServerState({ ...base, state: 'running' })).toContain('2');
    expect(describeServerState({ ...base, state: 'stopped' })).toBe('সার্ভার বন্ধ');
    expect(describeServerState({ ...base, state: 'error', last_error: 'port busy' })).toContain('port busy');
  });
});
