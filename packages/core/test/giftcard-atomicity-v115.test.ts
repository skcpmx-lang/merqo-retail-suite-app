/**
 * A gift card's balance and its transaction history are one fact.
 *
 * `adjustGiftCard` (an owner correcting stored value from the Gift Cards screen) and
 * `refundToGiftCard` changed the balance first and wrote the history row second, with no
 * transaction. If the second write failed, the card was worth a different amount than its own
 * statement says, and nothing recorded who changed it or why — the one thing a stored-value
 * ledger exists to answer.
 */
import { describe, expect, it } from 'vitest';
import { makeTestDb } from './helpers.js';
import { adjustGiftCard, getGiftCard, issueGiftCard, refundToGiftCard } from '../src/services/promotions.js';

describe('a gift card balance and its history move together', () => {
  it('does not change the balance when the history row cannot be written', () => {
    const ctx = makeTestDb();
    const card = issueGiftCard(ctx.db, { amountPaisa: 100_000, code: 'GC-ATOMIC-1' }, ctx.actor);
    // Anything that makes the *second* statement fail: here, the history table is gone.
    ctx.db.exec('ALTER TABLE gift_card_transactions RENAME TO gift_card_transactions_gone');

    expect(() =>
      adjustGiftCard(ctx.db, { cardId: card.id, deltaPaisa: -25_000, reason: 'ভুল এন্ট্রি', userId: ctx.actor.id }),
    ).toThrow();
    expect(getGiftCard(ctx.db, card.id)!.balance_paisa).toBe(100_000);

    expect(() =>
      refundToGiftCard(ctx.db, { cardId: card.id, amountPaisa: 50_000, note: 'ফেরত', userId: ctx.actor.id }),
    ).toThrow();
    expect(getGiftCard(ctx.db, card.id)!.balance_paisa).toBe(100_000);
    ctx.cleanup();
  });

  it('records balance and history together when both writes succeed', () => {
    const ctx = makeTestDb();
    const card = issueGiftCard(ctx.db, { amountPaisa: 100_000, code: 'GC-ATOMIC-2' }, ctx.actor);
    const after = adjustGiftCard(ctx.db, {
      cardId: card.id,
      deltaPaisa: -25_000,
      reason: 'ভুল এন্ট্রি',
      userId: ctx.actor.id,
    });
    expect(after.balance_paisa).toBe(75_000);
    const row = ctx.db
      .prepare("SELECT type, amount_paisa, balance_after_paisa, note FROM gift_card_transactions WHERE gift_card_id = ? ORDER BY id DESC LIMIT 1")
      .get(card.id) as { type: string; amount_paisa: number; balance_after_paisa: number; note: string };
    expect(row).toEqual({ type: 'adjust', amount_paisa: -25_000, balance_after_paisa: 75_000, note: 'ভুল এন্ট্রি' });
    expect(ctx.db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action = 'giftcard.adjust'").get()).toEqual({ c: 1 });
    ctx.cleanup();
  });
});
