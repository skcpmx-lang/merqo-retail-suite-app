/**
 * A cash movement and its journal entry are one fact, and so are a journal entry and its lines.
 *
 * Both are written by several statements. Before this test they were written without a
 * transaction, so a failure in the *second* statement left the first one behind — measured here:
 * a manual drawer deposit that could not be posted stayed in the drawer totals with no journal
 * entry at all, and a journal entry whose second line failed stayed on file with one line.
 *
 * Each test forces the second statement to fail and asserts that nothing at all survived.
 */
import { describe, expect, it } from 'vitest';
import { makeTestDb } from './helpers.js';
import {
  addCashMovement,
  cashInHandPaisa,
  openCashSession,
  sessionTotals,
} from '../src/services/cash.js';
import {
  ACCOUNT_CODES,
  accountIdByCode,
  postEntry,
  unbalancedEntries,
} from '../src/services/accounting.js';

/** Break the chart of accounts so the *posting* half of a write fails, not the operational half. */
function makePostingFail(ctx: ReturnType<typeof makeTestDb>) {
  ctx.db
    .prepare('UPDATE accounts SET code = ? WHERE code = ?')
    .run('1999', ACCOUNT_CODES.cash);
}

describe('a cash movement is only recorded if its journal entry is', () => {
  it('rolls the movement back when posting fails', () => {
    const ctx = makeTestDb();
    openCashSession(ctx.db, { userId: ctx.actor.id, openingCash: 100_000, actor: ctx.actor });
    const before = sessionTotals(ctx.db, 1);
    makePostingFail(ctx);

    expect(() =>
      addCashMovement(ctx.db, {
        userId: ctx.actor.id,
        direction: 'in',
        amount: 50_000,
        source: 'manual_in',
        note: 'দোকানের ক্যাশ জমা',
      }),
    ).toThrow();

    // No orphaned drawer movement: the money was never counted in, because the books refused it.
    expect(sessionTotals(ctx.db, 1)).toEqual(before);
    expect(cashInHandPaisa(ctx.db)).toBe(100_000);
    const moves = ctx.db.prepare("SELECT COUNT(*) c FROM cash_movements WHERE source = 'manual_in'").get() as {
      c: number;
    };
    expect(moves.c).toBe(0);
    ctx.cleanup();
  });

  it('still records movement and entry together when posting works', () => {
    const ctx = makeTestDb();
    openCashSession(ctx.db, { userId: ctx.actor.id, openingCash: 100_000, actor: ctx.actor });
    addCashMovement(ctx.db, {
      userId: ctx.actor.id,
      direction: 'out',
      amount: 30_000,
      source: 'manual_out',
      note: 'মালিকের উত্তোলন',
    });

    expect(cashInHandPaisa(ctx.db)).toBe(70_000);
    const entry = ctx.db
      .prepare("SELECT * FROM journal_entries WHERE source = 'cash_out'")
      .get() as { id: number } | undefined;
    expect(entry).toBeTruthy();
    const lines = ctx.db
      .prepare('SELECT COUNT(*) c, SUM(debit_paisa) d, SUM(credit_paisa) cr FROM journal_lines WHERE entry_id = ?')
      .get(entry!.id) as { c: number; d: number; cr: number };
    expect(lines).toEqual({ c: 2, d: 30_000, cr: 30_000 });
    expect(unbalancedEntries(ctx.db)).toEqual([]);
    ctx.cleanup();
  });
});

describe('a journal entry is only written with all of its lines', () => {
  it('leaves no header behind when a line is rejected', () => {
    const ctx = makeTestDb();
    const cashAccount = accountIdByCode(ctx.db, ACCOUNT_CODES.cash);
    const before = (
      ctx.db.prepare('SELECT COUNT(*) c FROM journal_entries').get() as { c: number }
    ).c;

    // A line pointing at an account that does not exist: the FK refuses it *after* the header and
    // the first line are already written.
    expect(() =>
      postEntry(ctx.db, {
        date: '2026-11-06 10:00:00',
        source: 'manual',
        sourceId: 1,
        lines: [
          { accountId: cashAccount, debit: 10_000 },
          { accountId: 999_999, credit: 10_000 },
        ],
      }),
    ).toThrow();

    expect((ctx.db.prepare('SELECT COUNT(*) c FROM journal_entries').get() as { c: number }).c).toBe(before);
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM journal_lines').get() as { c: number }).c).toBe(0);
    expect(unbalancedEntries(ctx.db)).toEqual([]);
    ctx.cleanup();
  });
});
