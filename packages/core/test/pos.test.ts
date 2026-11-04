import { describe, expect, it } from 'vitest';
import {
  cancelHeldSale,
  createCreditNote,
  createExchange,
  createProduct,
  createSale,
  createCustomer,
  getCustomer,
  holdSale,
  listFavourites,
  listHeldSales,
  posQuickPicks,
  resumeHeldSale,
  toggleFavourite,
  cashInHandPaisa,
} from '../src/index.js';
import { makeTestDb } from './helpers.js';

function fixture() {
  const ctx = makeTestDb();
  const tea = createProduct(
    ctx.db,
    { name: 'চা', unitId: ctx.unitPieceId, salePrice: 10_000, openingStockMilli: 50_000, openingCostMicro: 6_000_000_000 },
    ctx.actor,
  );
  const sugar = createProduct(
    ctx.db, { name: 'চিনি', unitId: ctx.unitPieceId, salePrice: 12_000, openingStockMilli: 50_000, openingCostMicro: 8_000_000_000 }, ctx.actor,
  );
  const customer = createCustomer(ctx.db, { name: 'রহিম স্টোর', phone: '01711111111' }, ctx.actor);
  return { ctx, tea, sugar, customer };
}

describe('held sales', () => {
  it('parks a cart and gives it back on resume', () => {
    const { ctx, tea } = fixture();
    const held = holdSale(ctx.db, {
      lines: [{ productId: tea.id, unitId: ctx.unitPieceId, qtyMilli: 3000 }],
      note: 'কাস্টমার এটিএম-এ গেছে',
      totalPaisa: 30_000,
      actor: ctx.actor,
    });
    expect(held.ref_no).toMatch(/^HOLD-/);
    expect(held.item_count).toBe(1);
    expect(listHeldSales(ctx.db).length).toBe(1);

    const resumed = resumeHeldSale(ctx.db, held.id, ctx.actor);
    expect(resumed.status).toBe('resumed');
    expect(JSON.parse(resumed.lines_json)[0].productId).toBe(tea.id);
    expect(listHeldSales(ctx.db, 'held').length).toBe(0);
    expect(() => resumeHeldSale(ctx.db, held.id, ctx.actor)).toThrow(/হোল্ড অবস্থায় নেই/);
    ctx.cleanup();
  });

  it('requires a reason to cancel and refuses to cancel a resumed cart', () => {
    const { ctx, tea } = fixture();
    const held = holdSale(ctx.db, { lines: [{ productId: tea.id, qtyMilli: 1000 }], actor: ctx.actor });
    expect(() => cancelHeldSale(ctx.db, held.id, '  ', ctx.actor)).toThrow(/কারণ/);
    cancelHeldSale(ctx.db, held.id, 'কাস্টমার চলে গেছে', ctx.actor);
    expect(listHeldSales(ctx.db, 'cancelled').length).toBe(1);

    const again = holdSale(ctx.db, { lines: [{ productId: tea.id, qtyMilli: 1000 }], actor: ctx.actor });
    resumeHeldSale(ctx.db, again.id, ctx.actor);
    expect(() => cancelHeldSale(ctx.db, again.id, 'পরীক্ষা', ctx.actor)).toThrow(/বাতিল করা যাবে না/);
    ctx.cleanup();
  });

  it('rejects an empty cart', () => {
    const { ctx } = fixture();
    expect(() => holdSale(ctx.db, { lines: [], actor: ctx.actor })).toThrow(/অন্তত একটি পণ্য/);
    ctx.cleanup();
  });
});

describe('favourites and quick picks', () => {
  it('toggles favourites and orders quick picks by them', () => {
    const { ctx, tea, sugar } = fixture();
    const quick = posQuickPicks(ctx.db, 10);
    expect(quick.length).toBeGreaterThanOrEqual(2); // fallback list when nothing sold yet

    const on = toggleFavourite(ctx.db, sugar.id);
    expect(on.added).toBe(true);
    expect(listFavourites(ctx.db)).toEqual([sugar.id]);

    const picks = posQuickPicks(ctx.db, 10);
    expect(picks[0].id).toBe(sugar.id);
    expect(picks[0].is_favourite).toBe(true);

    const off = toggleFavourite(ctx.db, sugar.id);
    expect(off.added).toBe(false);
    expect(listFavourites(ctx.db)).toEqual([]);
    expect(() => toggleFavourite(ctx.db, 999_999)).toThrow(/পাওয়া যায়নি/);
    void tea;
    ctx.cleanup();
  });
});

describe('credit note and exchange', () => {
  it('turns a return into store credit instead of cash', () => {
    const { ctx, tea, customer } = fixture();
    const sale = createSale(ctx.db, {
      customerId: customer.id,
      lines: [{ productId: tea.id, unitId: ctx.unitPieceId, qtyMilli: 4000, unitPricePaisa: 10_000 }],
      payments: [{ methodId: ctx.cashMethodId, amount: 40_000 }],
      actor: ctx.actor,
    });
    const full = ctx.db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').get(sale.saleId) as any;

    const cashBefore = cashInHandPaisa(ctx.db);
    const note = createCreditNote(ctx.db, {
      saleId: sale.saleId,
      items: [{ lineId: full.id, qtyMilli: 2000 }],
      actor: ctx.actor,
    });
    expect(note.total).toBe(20_000);
    const cust = getCustomer(ctx.db, customer.id)!;
    expect(cust.balance_paisa).toBe(-20_000); // shop owes 200 taka in credit

    expect(cashInHandPaisa(ctx.db)).toBe(cashBefore); // no cash left the drawer
    ctx.cleanup();
  });

  it('exchanges an item and reports the balance to settle', () => {
    const { ctx, tea, sugar, customer } = fixture();
    const sale = createSale(ctx.db, {
      lines: [{ productId: tea.id, unitId: ctx.unitPieceId, qtyMilli: 1000, unitPricePaisa: 10_000 }],
      payments: [{ methodId: ctx.cashMethodId, amount: 10_000 }],
      actor: ctx.actor,
    });
    const line = ctx.db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').get(sale.saleId) as any;
    const ex = createExchange(ctx.db, {
      saleId: sale.saleId,
      returnItems: [{ lineId: line.id, qtyMilli: 1000 }],
      newLines: [{ productId: sugar.id, unitId: ctx.unitPieceId, qtyMilli: 1000, unitPricePaisa: 12_000 }],
      customerId: customer.id,
      methodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    expect(ex.returnedTotal).toBe(10_000);
    expect(ex.newTotal).toBe(12_000);
    expect(ex.differencePaisa).toBe(2000); // customer owes the extra after credit
    expect(getCustomer(ctx.db, customer.id)!.balance_paisa).toBe(2000);

    const stock = ctx.db.prepare('SELECT stock_base_milli AS q FROM products WHERE id = ?').get(tea.id) as { q: number };
    expect(stock.q).toBe(50_000); // returned item is back in stock
    ctx.cleanup();
  });

  it('refunds the returned value in cash for a walk-in exchange', () => {
    const { ctx, tea, sugar } = fixture();
    const sale = createSale(ctx.db, {
      lines: [{ productId: tea.id, unitId: ctx.unitPieceId, qtyMilli: 2000, unitPricePaisa: 10_000 }],
      payments: [{ methodId: ctx.cashMethodId, amount: 20_000 }],
      actor: ctx.actor,
    });
    const line = ctx.db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').get(sale.saleId) as any;
    const before = cashInHandPaisa(ctx.db);
    const ex = createExchange(ctx.db, {
      saleId: sale.saleId,
      returnItems: [{ lineId: line.id, qtyMilli: 2000 }],
      newLines: [{ productId: sugar.id, unitId: ctx.unitPieceId, qtyMilli: 1000, unitPricePaisa: 12_000 }],
      methodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    expect(ex.customerId).toBeNull();
    // 200 taka refunded out, 120 taka collected in → drawer down by 80 taka.
    expect(cashInHandPaisa(ctx.db)).toBe(before - 8000);
    expect(ex.differencePaisa).toBe(0); // no credit involved for a walk-in
    ctx.cleanup();
  });
});
