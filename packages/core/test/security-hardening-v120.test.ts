/**
 * Security hardening from the v1.2.0 Phase 4 audit.
 *
 * SEC-01 — `startRpcHost` failed open. With no TLS material and no explicit host it bound `0.0.0.0`,
 * i.e. a plaintext listener reachable from the whole LAN, whose first request carries a login
 * password (inside the AES-GCM envelope, but the envelope key travels with the same request). A
 * missing argument should not decide whether a shop's credentials are private, so the combination is
 * now refused unless the caller says `allowPlaintextLan: true` — which only the deprecated legacy
 * tunnel does, and only when the operator opted into it.
 *
 * SEC-02 — the audit trail was append-only by convention: no code updates or deletes `audit_logs`,
 * but nothing stopped it. Two SQLite triggers now make the table refuse UPDATE and DELETE.
 */
import { describe, expect, it } from 'vitest';
import { audit, startRpcHost, isLoopbackHost, type RpcHost } from '../src/index.js';
import { makeTestDb } from './helpers.js';
import { closeTrackedDatabases, removeTempDirs } from '../../../test-setup/temp-resources.js';

const TOKEN = 'e'.repeat(64);
const started: RpcHost[] = [];

const host = (opts: { host?: string; tls?: boolean; allowPlaintextLan?: boolean } = {}) =>
  startRpcHost({
    port: 0,
    host: opts.host,
    allowPlaintextLan: opts.allowPlaintextLan,
    token: TOKEN,
    version: '1.2.0',
    businessName: () => 'টেস্ট',
    authenticate: async (username) => ({ id: 1, username, full_name: 'মালিক', role: 'admin', permissions: [] }),
    invoke: async () => ({ ok: true, data: 'x' }),
    allowRemote: () => true,
  });

describe('SEC-01 a plaintext listener must be asked for', () => {
  it('refuses the old default (0.0.0.0, no TLS)', async () => {
    await expect(host()).rejects.toThrow(/TLS ছাড়া নেটওয়ার্ক-সার্ভার/);
  });

  it('refuses an explicit wildcard bind without TLS', async () => {
    await expect(host({ host: '0.0.0.0' })).rejects.toThrow(/TLS/);
    await expect(host({ host: '192.168.0.10' })).rejects.toThrow(/TLS/);
  });

  it('still allows a loopback plaintext listener — that is a local socket, not the network', async () => {
    for (const bind of ['127.0.0.1', 'localhost', '::1']) {
      const server = await host({ host: bind });
      started.push(server);
      expect(server.bound_host).toContain(bind === 'localhost' ? '1' : bind.replace(/:\d+$/, ''));
      expect(server.protocol).toBe('http');
      await server.stop();
    }
  });

  it('allows the deprecated LAN mode only when the caller says so', async () => {
    const server = await host({ host: '0.0.0.0', allowPlaintextLan: true });
    started.push(server);
    expect(['0.0.0.0', '::']).toContain(server.bound_host);
    await server.stop();
  });

  it('classifies the addresses the guard relies on', () => {
    for (const yes of ['127.0.0.1', 'localhost', '::1', '[::1]', ' 127.0.0.1 ']) expect(isLoopbackHost(yes)).toBe(true);
    for (const no of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.1', '']) expect(isLoopbackHost(no)).toBe(false);
  });
});

describe('SEC-02 the audit trail is append-only in the database, not just by convention', () => {
  it('refuses an UPDATE of an existing audit line', () => {
    const ctx = makeTestDb();
    audit(ctx.db, { userId: null, username: 'tester', action: 'test.action', entity: 'test', entityId: 1 });
    expect(() => ctx.db.prepare("UPDATE audit_logs SET action = 'tampered'").run()).toThrow(/append-only/);
    expect((ctx.db.prepare('SELECT action FROM audit_logs ORDER BY id DESC LIMIT 1').get() as { action: string }).action).toBe(
      'test.action',
    );
    ctx.cleanup();
  });

  it('refuses a DELETE of an audit line', () => {
    const ctx = makeTestDb();
    audit(ctx.db, { userId: null, username: 'tester', action: 'test.delete_me', entity: 'test', entityId: 1 });
    const before = (ctx.db.prepare('SELECT COUNT(*) c FROM audit_logs').get() as { c: number }).c;
    expect(() => ctx.db.prepare('DELETE FROM audit_logs').run()).toThrow(/append-only/);
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM audit_logs').get() as { c: number }).c).toBe(before);
    ctx.cleanup();
  });

  it('still accepts new lines, which is the whole point', () => {
    const ctx = makeTestDb();
    const before = (ctx.db.prepare('SELECT COUNT(*) c FROM audit_logs').get() as { c: number }).c;
    audit(ctx.db, { userId: null, username: 'tester', action: 'test.append', entity: 'test', entityId: 2 });
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM audit_logs').get() as { c: number }).c).toBe(before + 1);
    ctx.cleanup();
  });
});
