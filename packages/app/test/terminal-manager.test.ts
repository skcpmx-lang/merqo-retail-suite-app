/**
 * Milestone D — Client terminal manager: saved servers, credential handling and the
 * event sink that feeds the renderer.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  appendEvent,
  approveDevice,
  createPairingToken,
  getStoreIdentity,
  initializeApp,
  loadOrCreateServerIdentity,
  openDatabase,
  startLanApi,
  type Db,
  type LanApi,
  type Sealer,
} from '@sauda/core';
import { TerminalManager } from '../electron/terminal.js';
import { closeTrackedDatabases, openTrackedDatabase, removeTempDirs } from '../../../test-setup/temp-resources.js';

vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
const apis: LanApi[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-manager-'));
  dirs.push(dir);
  return dir;
}

const sealer: Sealer = {
  kind: 'test-sealer',
  seal: (plain) => Buffer.from(plain.toString('base64')),
  unseal: (sealed) => Buffer.from(sealed.toString('utf8'), 'base64'),
};

const CERT_PLACEHOLDER = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

function manager(dir: string): TerminalManager {
  return new TerminalManager({ dataDir: dir, sealer });
}

afterAll(async () => {
  for (const api of apis) await api.stop().catch(() => undefined);
  closeTrackedDatabases();
  removeTempDirs(dirs);
});

describe('saved trusted servers', () => {
  it('accepts only https with a pin and a certificate', () => {
    const m = manager(tempDir());
    expect(() => m.configure({ baseUrl: 'http://192.168.0.10:4747', fingerprint: 'a'.repeat(64), certPem: CERT_PLACEHOLDER })).toThrow(/https/);
    expect(() => m.configure({ baseUrl: 'https://192.168.0.10:4747', fingerprint: 'abc', certPem: CERT_PLACEHOLDER })).toThrow();
    expect(() => m.configure({ baseUrl: 'https://192.168.0.10:4747', fingerprint: 'a'.repeat(64), certPem: '' })).toThrow();
    const saved = m.configure({
      baseUrl: 'https://192.168.0.10:4747/',
      fingerprint: 'AA:'.repeat(31) + 'AA',
      certPem: CERT_PLACEHOLDER,
      storeName: 'আমার দোকান',
      storeId: 'STORE-1',
    });
    expect(saved.base_url).toBe('https://192.168.0.10:4747');
    expect(saved.fingerprint).toBe('a'.repeat(64));
    expect(m.activeServer?.id).toBe(saved.id);
  });

  it('stores no shared secret and keeps the file owner-only', () => {
    const dir = tempDir();
    const m = manager(dir);
    m.configure({ baseUrl: 'https://10.0.0.5:4747', fingerprint: 'b'.repeat(64), certPem: CERT_PLACEHOLDER });
    const raw = fs.readFileSync(path.join(dir, 'terminal.json'), 'utf8');
    expect(raw).not.toMatch(/token/i);
    expect(raw).not.toMatch(/password/i);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dir, 'terminal.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('refreshes an existing server instead of duplicating it, and survives a restart', () => {
    const dir = tempDir();
    const first = manager(dir);
    const a = first.configure({ baseUrl: 'https://10.0.0.5:4747', fingerprint: 'c'.repeat(64), certPem: CERT_PLACEHOLDER, storeName: 'পুরোনো' });
    const again = first.configure({ baseUrl: 'https://10.0.0.5:4747', fingerprint: 'd'.repeat(64), certPem: CERT_PLACEHOLDER, storeName: 'নতুন' });
    expect(again.id).toBe(a.id);
    expect(first.configSnapshot.servers).toHaveLength(1);
    const b = first.configure({ baseUrl: 'https://10.0.0.6:4747', fingerprint: 'e'.repeat(64), certPem: CERT_PLACEHOLDER });
    expect(first.configSnapshot.servers).toHaveLength(2);

    const restarted = manager(dir);
    expect(restarted.configSnapshot.servers).toHaveLength(2);
    expect(restarted.activeServer?.id).toBe(b.id);
  });

  it('switches and removes servers', () => {
    const dir = tempDir();
    const m = manager(dir);
    const a = m.configure({ baseUrl: 'https://10.0.0.5:4747', fingerprint: 'f'.repeat(64), certPem: CERT_PLACEHOLDER });
    const b = m.configure({ baseUrl: 'https://10.0.0.6:4747', fingerprint: '1'.repeat(64), certPem: CERT_PLACEHOLDER });
    m.useServer(a.id);
    expect(m.activeServer?.id).toBe(a.id);
    m.removeServer(a.id);
    expect(m.activeServer).toBeNull();
    expect(m.configSnapshot.servers.map((s) => s.id)).toEqual([b.id]);
  });

  it('forget() is safe when nothing was ever paired', () => {
    const dir = tempDir();
    const m = manager(dir);
    m.configure({ baseUrl: 'https://10.0.0.5:4747', fingerprint: '2'.repeat(64), certPem: CERT_PLACEHOLDER });
    expect(() => m.forget()).not.toThrow();
    expect(m.paired).toBe(false);
  });
});

describe('end-to-end client flow through the manager', () => {
  it('pairs, is approved, logs in, receives events and remembers the last id', async () => {
    const hostDir = tempDir();
    const db: Db = openTrackedDatabase({ file: path.join(hostDir, 'shop.db'), appVersion: '1.1.4' });
    initializeApp(db, {
      businessName: 'ম্যানেজার স্টোর',
      businessAddress: 'ঢাকা',
      businessPhone: '01700000000',
      adminFullName: 'মালিক',
      adminUsername: 'owner',
      adminPassword: 'owner123',
    });
    const store = getStoreIdentity(db);
    db.prepare(
      `INSERT INTO device_licenses (license_id, store_id, device_id, role, capacity, edition, issued_at, expires_at, status, payload, registered_at)
       VALUES ('LIC-SERVER', ?, 'DEV-SERVER', 'SERVER_POS', 2, 'standard', ?, NULL, 'active', '{}', ?)`,
    ).run(store.store_id, new Date().toISOString(), new Date().toISOString());
    const identity = loadOrCreateServerIdentity({ dir: path.join(hostDir, 'tls'), allowCreate: true, ips: [] });
    const api = await startLanApi({
      port: 0,
      tls: { certPem: identity.certPem, keyPem: identity.keyPem, fingerprint: identity.fingerprint },
      db,
      version: '1.1.4',
      storeId: () => store.store_id,
      serverId: () => store.server_id,
      licensedCapacity: () => 2,
      allowRemote: () => true,
      invoke: async (method) => ({ ok: true, data: { method } }),
      authenticate: async (username) =>
        username === 'owner'
          ? { id: 1, username: 'owner', full_name: 'মালিক', role: 'admin', permissions: ['pos.sell', 'settings.manage'] }
          : null,
      ssePollMs: 20,
      sseHeartbeatMs: 100,
    });
    apis.push(api);

    const clientDir = tempDir();
    const m = manager(clientDir);
    m.configure({
      baseUrl: `https://127.0.0.1:${api.port}`,
      fingerprint: identity.fingerprint,
      certPem: identity.certPem,
      storeId: store.store_id,
      storeName: 'ম্যানেজার স্টোর',
    });

    const outcome = await m.pair({
      code: createPairingToken(db).code,
      licenseId: 'LIC-CLIENT-1',
      capacity: 2,
      deviceName: 'কাউন্টার ৩',
    });
    expect(outcome.status).toBe('pending');
    expect((await m.status()).status).toBe('pending');

    approveDevice(db, outcome.deviceId, { id: 1, username: 'owner' });
    expect((await m.status()).status).toBe('approved');

    const events: Array<{ id: number; type: string }> = [];
    const states: string[] = [];
    m.setSink({ onEvent: (e) => events.push({ id: e.id, type: e.type }), onState: (s) => states.push(s) });
    const user = await m.login('owner', 'owner123');
    expect(user.username).toBe('owner');
    expect((await m.invoke<{ method: string }>('products.list', [])).method).toBe('products.list');

    appendEvent(db, { storeId: store.store_id, type: 'sale.created', payload: { total: 1 } });
    await vi.waitFor(() => expect(events.length).toBe(1), { timeout: 8000 });
    const lastId = manager(clientDir).configSnapshot.last_event_id;
    expect(lastId).toBe(events[0]!.id);

    // A second event advances the stored id; a stale repeat cannot move it backwards.
    appendEvent(db, { storeId: store.store_id, type: 'inventory.updated', payload: { qty: 2 } });
    await vi.waitFor(() => expect(events.length).toBe(2), { timeout: 8000 });
    expect(manager(clientDir).configSnapshot.last_event_id).toBe(events[1]!.id);
    expect(states).toContain('open');
    m.logout();
  });
});
