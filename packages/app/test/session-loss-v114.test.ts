/**
 * v1.1.4 audit — a client session that the Main PC ends must not linger.
 *
 * When the server expires a session, revokes it, or revokes the device, every later RPC fails
 * with an auth code. Before this fix the client kept its `user` object and its event stream,
 * so the UI stayed "signed in" and every action failed with AUTH_REQUIRED. The client now drops
 * the session and the stream, and a fresh login re-opens the stream — the server still decides.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  approveDevice,
  createDeviceSession,
  createPairingToken,
  getStoreIdentity,
  initializeApp,
  loadOrCreateServerIdentity,
  openDatabase,
  revokeDevice,
  revokeDeviceSession,
  startLanApi,
  type Db,
  type LanApi,
  type Sealer,
} from '@sauda/core';
import { V1Terminal } from '../electron/v1-transport.js';
import { DeviceKeyStore } from '@sauda/core';

vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
const apis: LanApi[] = [];

afterAll(async () => {
  for (const api of apis) await api.stop().catch(() => undefined);
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const sealer: Sealer = {
  kind: 'test-sealer',
  seal: (plain) => Buffer.from(plain.toString('base64')),
  unseal: (sealed) => Buffer.from(sealed.toString('utf8'), 'base64'),
};

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-session-loss-'));
  dirs.push(dir);
  return dir;
}

async function shop() {
  const dir = tempDir();
  const db: Db = openDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
  initializeApp(db, {
    businessName: 'সেশন স্টোর',
    businessAddress: 'ঢাকা',
    businessPhone: '01700000000',
    adminFullName: 'মালিক',
    adminUsername: 'owner',
    adminPassword: 'owner123',
  });
  const admin = db.prepare('SELECT id, username FROM users ORDER BY id LIMIT 1').get() as { id: number; username: string };
  const actor = { id: admin.id, username: admin.username };
  const store = getStoreIdentity(db);
  // The shop's own SERVER_POS licence (capacity 5) is what allows clients to enrol.
  db.prepare(
    `INSERT INTO device_licenses (license_id, store_id, device_id, role, capacity, edition,
        issued_at, expires_at, status, payload, registered_at)
     VALUES ('LIC-SERVER', ?, 'DEV-SERVER', 'SERVER_POS', 5, 'standard', ?, NULL, 'active', '{}', ?)`,
  ).run(store.store_id, new Date().toISOString(), new Date().toISOString());
  const identity = loadOrCreateServerIdentity({ dir: path.join(dir, 'tls'), allowCreate: true, ips: [] });
  const api = await startLanApi({
    port: 0,
    tls: { certPem: identity.certPem, keyPem: identity.keyPem, fingerprint: identity.fingerprint },
    db,
    version: '1.1.4',
    storeId: () => store.store_id,
    serverId: () => store.server_id,
    licensedCapacity: () => 5,
    allowRemote: () => true,
    invoke: async (method) => ({ ok: true, data: { method } }),
    authenticate: async (username, password) =>
      username === 'owner' && password === 'owner123'
        ? { id: actor.id, username, full_name: 'মালিক', role: 'admin', permissions: ['pos.sell'] }
        : null,
    ssePollMs: 25,
    sseHeartbeatMs: 120,
  });
  apis.push(api);
  const clientDir = tempDir();
  const terminal = new V1Terminal({
    store: new DeviceKeyStore({ dir: clientDir, sealer }),
    baseUrl: `https://127.0.0.1:${api.port}`,
    fingerprint: identity.fingerprint,
    serverCertPem: identity.certPem,
    timeoutMs: 8000,
  });
  const pending = await terminal.pair({
    code: createPairingToken(db).code,
    licence: { license_id: 'LIC-SESSION', store_id: store.store_id, capacity: 5 },
  });
  approveDevice(db, pending.deviceId, actor);
  await terminal.login('owner', 'owner123');
  return { db, api, terminal, actor, store, deviceId: pending.deviceId };
}

describe('session loss on a client PC', () => {
  it('an expired session ends the client session instead of failing silently', async () => {
    const { db, terminal } = await shop();
    // Anything the client can reach while signed in works.
    await expect(terminal.invoke('products.list')).resolves.toEqual({ method: 'products.list' });

    // The Main PC expires the session (12h TTL in production; forced here).
    const sessions = db.prepare('SELECT id FROM terminal_sessions').all() as { id: string }[];
    expect(sessions.length).toBeGreaterThan(0);
    for (const row of sessions) {
      db.prepare('UPDATE terminal_sessions SET expires_at = ? WHERE id = ?').run(
        new Date(Date.now() - 1000).toISOString(),
        row.id,
      );
    }

    await expect(terminal.invoke('products.list')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    // The session is gone locally too: the next call says "log in" *without* contacting the
    // server again (the server's own message is longer than this local one).
    await expect(terminal.invoke('products.list')).rejects.toThrowError(/^লগইন করুন।$/);
  });

  it('a revoked device ends the session and a login is refused', async () => {
    const { db, terminal, deviceId, actor } = await shop();
    revokeDevice(db, deviceId, actor, 'ডিভাইস বাতিল');
    await expect(terminal.invoke('products.list')).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
    await expect(terminal.invoke('products.list')).rejects.toThrowError(/^লগইন করুন।$/);
    await expect(terminal.login('owner', 'owner123')).rejects.toThrowError();
  });

  it('a session revoked by the server is not reusable after a reconnect', async () => {
    const { db, terminal } = await shop();
    const sessions = db.prepare('SELECT id FROM terminal_sessions').all() as { id: string }[];
    // Revoke the digest row directly (as revokeDeviceSession would via its token).
    for (const row of sessions) {
      db.prepare('UPDATE terminal_sessions SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
    }
    await expect(terminal.invoke('products.list')).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    await expect(terminal.invoke('products.list')).rejects.toThrowError(/^লগইন করুন।$/);
  });
});
