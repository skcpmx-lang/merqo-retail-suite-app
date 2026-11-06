/**
 * The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
 *
 * Sweeping the service layer for the A-21/A-23/A-25 shape found 43 more functions that changed data
 * and then wrote their audit line in a separate statement: created users, deleted customers, clock-in
 * records, registered serial numbers, held sales, opened cash sessions… None of them could leave the
 * *books* wrong on its own, but each could leave a change nobody could account for, which is the one
 * thing an audit trail exists to prevent.
 *
 * All of them now run inside `db.transaction(...)`. These tests take four representatives — one
 * security, one master data, one attendance, one stock — and force the audit insert to fail. The
 * change must not survive.
 *
 * The durable half of the finding is `scripts/audit-transactions.mjs`, wired into `npm run verify`:
 * it walks every service function and fails the build if a function both mutates data and writes an
 * audit line without a transaction. The last test here runs that guard so the wiring cannot rot.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  clockIn,
  createCustomer,
  createProduct,
  createUser,
  deleteCustomer,
  registerSerials,
} from '../src/index.js';
import { makeTestDb } from './helpers.js';
import { closeTrackedDatabases, removeTempDirs } from '../../../test-setup/temp-resources.js';

const ROOT = path.resolve(__dirname, '../../..');

afterAll(() => {
  closeTrackedDatabases();
  removeTempDirs([]);
});

const refuseAudit = (db: { exec(sql: string): unknown }, on: boolean) =>
  db.exec(
    on
      ? "CREATE TRIGGER refuse_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'forced failure'); END"
      : 'DROP TRIGGER refuse_audit',
  );

describe('A-26 changes that must not outlive a failed audit line', () => {
  it('does not create a user account the audit trail never saw', () => {
    const ctx = makeTestDb();
    refuseAudit(ctx.db, true);
    expect(() =>
      createUser(ctx.db, { username: 'till7', fullName: 'ক্যাশিয়ার', password: 'Strong#1234', role: 'cashier' }),
    ).toThrow(/forced failure/);
    refuseAudit(ctx.db, false);

    expect(ctx.db.prepare("SELECT COUNT(*) c FROM users WHERE username = 'till7'").get()).toEqual({ c: 0 });
    ctx.cleanup();
  });

  it('does not delete a customer when the deletion cannot be recorded', () => {
    const ctx = makeTestDb();
    const customer = createCustomer(ctx.db, { name: 'করিম uddin', phone: '01700000000' }, ctx.actor);
    refuseAudit(ctx.db, true);
    expect(() => deleteCustomer(ctx.db, customer.id, ctx.actor)).toThrow(/forced failure/);
    refuseAudit(ctx.db, false);

    const row = ctx.db.prepare('SELECT id, is_active FROM customers WHERE id = ?').get(customer.id) as
      | { id: number; is_active: number }
      | undefined;
    expect(row).toBeTruthy();
    expect(row!.is_active).toBe(1);
    ctx.cleanup();
  });

  it('does not keep a clock-in that has no audit line', () => {
    const ctx = makeTestDb();
    const user = createUser(ctx.db, { username: 'till6', fullName: 'ক্যাশিয়ার', password: 'Strong#1234', role: 'cashier' });
    refuseAudit(ctx.db, true);
    expect(() => clockIn(ctx.db, { userId: user.id, actor: ctx.actor })).toThrow(/forced failure/);
    refuseAudit(ctx.db, false);

    const count = (ctx.db.prepare('SELECT COUNT(*) c FROM attendance WHERE user_id = ?').get(user.id) as { c: number }).c;
    expect(count).toBe(0);
    ctx.cleanup();
  });

  it('does not register serial numbers when the registration cannot be recorded', () => {
    const ctx = makeTestDb();
    const product = createProduct(ctx.db, { name: 'ফ্যান', unitId: ctx.unitPieceId, salePrice: 300_000, openingStockMilli: 10_000 }, ctx.actor);
    refuseAudit(ctx.db, true);
    expect(() => registerSerials(ctx.db, { productId: product.id, serials: ['SN-1', 'SN-2'], actor: ctx.actor })).toThrow(
      /forced failure/,
    );
    refuseAudit(ctx.db, false);

    expect((ctx.db.prepare('SELECT COUNT(*) c FROM serial_numbers').get() as { c: number }).c).toBe(0);
    ctx.cleanup();
  });
});

describe('A-26 the guard that keeps it that way', () => {
  it('passes on the current tree', () => {
    const result = spawnSync(process.execPath, ['scripts/audit-transactions.mjs'], { cwd: ROOT, encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/audit-trail atomicity/);
  });
});
