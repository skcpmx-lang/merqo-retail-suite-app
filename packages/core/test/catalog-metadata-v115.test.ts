/**
 * Catalog metadata edits are one step (v1.1.5, audit finding A-23).
 *
 * `updateUnit`, `updateCategory` and `updatePaymentMethod` each write two to four columns in two to
 * four separate statements, then write an audit line. A failure anywhere in that sequence — a
 * constraint, a disk error, an audit insert that cannot be written — used to leave the earlier
 * columns already changed, so a unit could end up renamed but not re-factored. The factor is not
 * cosmetic: it is what converts every quantity of that unit into the base unit, so half an update is
 * a wrong stock figure, not just an untidy row.
 *
 * The failure is forced with a trigger on `audit_logs`, which each of these functions writes last —
 * so every earlier statement has already run when the abort happens.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createCategory, createPaymentMethod, createUnit, updateCategory, updatePaymentMethod, updateUnit } from '../src/index.js';
import { makeTestDb } from './helpers.js';
import { closeTrackedDatabases, removeTempDirs } from '../../../test-setup/temp-resources.js';

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

describe('updateUnit', () => {
  it('never half-applies a rename, a factor and a deactivation', () => {
    const ctx = makeTestDb();
    const unit = createUnit(ctx.db, { name: 'হালি', shortName: 'ctn', baseUnitId: ctx.unitPieceId, factorMilli: 12_000 }, ctx.actor);
    const before = ctx.db.prepare('SELECT * FROM units WHERE id = ?').get(unit.id) as Record<string, unknown>;

    refuseAudit(ctx.db, true);
    expect(() => updateUnit(ctx.db, unit.id, { name: 'হালি বড়', shortName: 'ctnb', factorMilli: 24_000, isActive: false }, ctx.actor)).toThrow(
      /forced failure/,
    );
    refuseAudit(ctx.db, false);

    const after = ctx.db.prepare('SELECT * FROM units WHERE id = ?').get(unit.id) as Record<string, unknown>;
    expect(after).toEqual(before);
    ctx.cleanup();
  });

  it('applies all of them together when the write succeeds', () => {
    const ctx = makeTestDb();
    const unit = createUnit(ctx.db, { name: 'হালি', shortName: 'ctn', baseUnitId: ctx.unitPieceId, factorMilli: 12_000 }, ctx.actor);
    const updated = updateUnit(ctx.db, unit.id, { name: 'হালি বড়', shortName: 'ctnb', factorMilli: 24_000, isActive: false }, ctx.actor);
    expect(updated).toMatchObject({ name: 'হালি বড়', short_name: 'ctnb', factor_milli: 24_000, is_active: 0 });
    ctx.cleanup();
  });
});

describe('updateCategory', () => {
  it('never half-applies a rename, a re-parent and a deactivation', () => {
    const ctx = makeTestDb();
    const parent = createCategory(ctx.db, 'মুদি', null, ctx.actor);
    const child = createCategory(ctx.db, 'চাল', null, ctx.actor);
    const before = ctx.db.prepare('SELECT * FROM categories WHERE id = ?').get(child.id) as Record<string, unknown>;

    refuseAudit(ctx.db, true);
    expect(() => updateCategory(ctx.db, child.id, { name: 'চাল-মুদি', parentId: parent.id, isActive: false }, ctx.actor)).toThrow(
      /forced failure/,
    );
    refuseAudit(ctx.db, false);

    expect(ctx.db.prepare('SELECT * FROM categories WHERE id = ?').get(child.id) as Record<string, unknown>).toEqual(before);
    ctx.cleanup();
  });
});

describe('updatePaymentMethod', () => {
  it('never renames a method and leaves it active when the audit line cannot be written', () => {
    const ctx = makeTestDb();
    const method = createPaymentMethod(ctx.db, 'ইসলামী ব্যাংক', false, ctx.actor);
    const before = ctx.db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(method.id) as Record<string, unknown>;

    refuseAudit(ctx.db, true);
    expect(() => updatePaymentMethod(ctx.db, method.id, { name: 'ইসলামী ব্যাংক ট্রান্সফার', isActive: false }, ctx.actor)).toThrow(
      /forced failure/,
    );
    refuseAudit(ctx.db, false);

    expect(ctx.db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(method.id) as Record<string, unknown>).toEqual(before);
    ctx.cleanup();
  });

  it('renames and deactivates together when it succeeds', () => {
    const ctx = makeTestDb();
    const method = createPaymentMethod(ctx.db, 'ইসলামী ব্যাংক', false, ctx.actor);
    const updated = updatePaymentMethod(ctx.db, method.id, { name: 'ইসলামী ব্যাংক ট্রান্সফার', isActive: false }, ctx.actor);
    expect(updated).toMatchObject({ name: 'ইসলামী ব্যাংক ট্রান্সফার', is_active: 0 });
    ctx.cleanup();
  });
});
