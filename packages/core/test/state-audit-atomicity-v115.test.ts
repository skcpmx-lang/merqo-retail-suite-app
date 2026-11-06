/**
 * State change and its audit line commit together (v1.1.5, audit findings A-24 and A-25).
 *
 * Two more places where a mutation and the record of it were separate statements:
 *
 *  - A-24 `pruneEventsByAge` deleted outbox history and then bumped the retention floor. The floor
 *    is the promise made to a device that has been offline: "everything after this is still here".
 *    Delete without raising it and the server offers events it no longer has; raise it without
 *    deleting and a client can be skipped. One transaction, one fact.
 *  - A-25 `login` cleared the failed-attempt counter, stamped `last_login_at`, wrote a session row
 *    and wrote the audit line as four statements. The failure path is deliberately *not* transactional
 *    — a wrong password must still count towards the lockout — so the test below also pins that the
 *    lockout still works after the change.
 *
 * Failures are forced with triggers, not by mocking: the real SQLite path is what matters.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { appendEvent, login, pruneEventsByAge, retentionFloor, createUser } from '../src/index.js';
import { makeTestDb } from './helpers.js';
import { closeTrackedDatabases, removeTempDirs } from '../../../test-setup/temp-resources.js';

afterAll(() => {
  closeTrackedDatabases();
  removeTempDirs([]);
});

const STORE = 'store-test';

const refuse = (db: { exec(sql: string): unknown }, table: string, on: boolean) =>
  db.exec(
    on
      ? `CREATE TRIGGER refuse_${table} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'forced failure'); END`
      : `DROP TRIGGER refuse_${table}`,
  );

describe('A-24 event retention floor', () => {
  const seed = (ctx: ReturnType<typeof makeTestDb>, n: number) => {
    for (let i = 0; i < n; i += 1) {
      appendEvent(ctx.db, { storeId: STORE, type: 'test.tick', payload: { i } });
    }
  };
  const count = (ctx: ReturnType<typeof makeTestDb>) =>
    (ctx.db.prepare('SELECT COUNT(*) c FROM event_outbox').get() as { c: number }).c;

  it('does not delete history when the floor cannot be recorded', () => {
    const ctx = makeTestDb();
    seed(ctx, 5);
    const before = count(ctx);
    const floorBefore = retentionFloor(ctx.db);

    refuse(ctx.db, 'meta', true);
    expect(() => pruneEventsByAge(ctx.db, { olderThanMs: -1000, keepLatest: 0, now: new Date() })).toThrow(/forced failure/);
    refuse(ctx.db, 'meta', false);

    expect(count(ctx)).toBe(before);
    expect(retentionFloor(ctx.db)).toBe(floorBefore);
    ctx.cleanup();
  });

  it('deletes and records the floor together when it succeeds', () => {
    const ctx = makeTestDb();
    seed(ctx, 5);
    const before = count(ctx);
    const pruned = pruneEventsByAge(ctx.db, { olderThanMs: -1000, keepLatest: 0, now: new Date() });
    expect(pruned.deleted).toBeGreaterThan(0);
    expect(count(ctx)).toBe(before - pruned.deleted);
    expect(retentionFloor(ctx.db)).toBe(pruned.floor);
    ctx.cleanup();
  });
});

describe('A-25 login session', () => {
  it('does not log a user in when the session cannot be recorded', () => {
    const ctx = makeTestDb();
    const user = createUser(ctx.db, { username: 'till9', fullName: 'ক্যাশিয়ার', password: 'Strong#1234', role: 'cashier' });
    const lastLoginBefore = (ctx.db.prepare('SELECT last_login_at FROM users WHERE id = ?').get(user.id) as { last_login_at: string | null })
      .last_login_at;
    expect(lastLoginBefore).toBeNull();

    refuse(ctx.db, 'audit_logs', true);
    expect(() => login(ctx.db, 'till9', 'Strong#1234')).toThrow(/forced failure/);
    refuse(ctx.db, 'audit_logs', false);

    expect((ctx.db.prepare('SELECT last_login_at FROM users WHERE id = ?').get(user.id) as { last_login_at: string | null }).last_login_at).toBeNull();
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM sessions_log WHERE user_id = ?').get(user.id) as { c: number }).c).toBe(0);

    // and the shop can still sign in once the audit table works again
    expect(login(ctx.db, 'till9', 'Strong#1234').user.id).toBe(user.id);
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM sessions_log WHERE user_id = ?').get(user.id) as { c: number }).c).toBe(1);
    ctx.cleanup();
  });

  it('still counts wrong passwords towards the lockout', () => {
    const ctx = makeTestDb();
    createUser(ctx.db, { username: 'till8', fullName: 'ক্যাশিয়ার', password: 'Strong#1234', role: 'cashier' });
    for (let i = 0; i < 5; i += 1) {
      expect(() => login(ctx.db, 'till8', `wrong-${i}`)).toThrow();
    }
    // the failure counter survived the throw, which is why it is not inside the new transaction
    expect(() => login(ctx.db, 'till8', 'Strong#1234')).toThrow(/মিনিট পর/);
    ctx.cleanup();
  });
});
