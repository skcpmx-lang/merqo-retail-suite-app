/**
 * POS / Sales audit evidence (v1.2.0, Phase 2 module 1) — the sixteen checks from
 * `docs/v1.2.0/PHASE2_POS_SALES_AUDIT.md`, run against a real database instead of being
 * described. Each check states its own name so a failure says which business rule broke:
 * payments, oversell, invoice numbering (including a second live connection), discounts and the
 * price floor, void/restock, returns, and the accounting integrity that must survive all of them.
 */
import { expect, it } from 'vitest';
import { makeTestDb } from './helpers.js';
import * as core from '../src/index.js';

const results: string[] = [];
const check = (n: number, name: string, pass: boolean, detail: string) => {
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${String(n).padStart(2)}. ${name} — ${detail}`);
  expect(pass, `${name} (${detail})`).toBe(true);
};
const refused = (fn: () => unknown): string => {
  try { fn(); return ''; } catch (e: any) { return String(e.message); }
};

it('16 POS probes', () => {
  const ctx = makeTestDb();
  const p = core.createProduct(ctx.db, { name: 'চাল', unitId: ctx.unitPieceId, salePrice: 10_000, costPrice: 8_000, openingStockMilli: 100_000 }, ctx.actor);
  const L = (extra: Record<string, unknown> = {}) => [{ productId: p.id, unitId: ctx.unitPieceId, qtyMilli: 1_000, ...extra }];
  const stock = () => (ctx.db.prepare('SELECT qty_base_milli q FROM stock_levels WHERE product_id = ?').get(p.id) as any)?.q;
  const unbalanced = () => (ctx.db.prepare('SELECT COUNT(*) c FROM (SELECT entry_id FROM journal_lines GROUP BY entry_id HAVING SUM(debit_paisa) <> SUM(credit_paisa))').get() as any).c;
  const negatives = () => (ctx.db.prepare('SELECT COUNT(*) c FROM sales WHERE total_paisa < 0').get() as any).c;

  // 1 split payment
  const split: any = core.createSale(ctx.db, { lines: L(), payments: [{ methodId: ctx.cashMethodId, amount: 5_000 }, { methodId: ctx.cashMethodId, amount: 5_000 }], actor: ctx.actor });
  check(1, 'split payment 50%+50%', split.computation.total === 10_000 && split.computation.due === 0, `total ${split.computation.total}, due ${split.computation.due}`);

  // 2 overpayment -> change
  const over: any = core.createSale(ctx.db, { lines: L(), payments: [{ methodId: ctx.cashMethodId, amount: 15_000 }], actor: ctx.actor });
  check(2, 'overpayment yields change, no due', over.computation.change === 5_000 && over.computation.due === 0, `change ${over.computation.change}, due ${over.computation.due}`);

  // 3 credit without customer
  const credit = refused(() => core.createSale(ctx.db, { lines: L(), payments: [{ methodId: ctx.cashMethodId, amount: 5_000 }], actor: ctx.actor }));
  check(3, 'credit sale without customer refused', credit.includes('কাস্টমার'), `"${credit.slice(0, 40)}"`);

  // 4 oversell
  const s0 = stock();
  const over2 = refused(() => core.createSale(ctx.db, { lines: [{ productId: p.id, unitId: ctx.unitPieceId, qtyMilli: s0 + 1_000 }], payments: [{ methodId: ctx.cashMethodId, amount: 999_000 }], actor: ctx.actor }));
  check(4, 'oversell refused, stock untouched', over2.includes('স্টক') && stock() === s0, `"${over2.slice(0, 30)}", stock ${stock()}`);

  // 5/6 zero and negative qty
  const zero = refused(() => core.createSale(ctx.db, { lines: L({ qtyMilli: 0 }), payments: [{ methodId: ctx.cashMethodId, amount: 0 }], actor: ctx.actor }));
  const neg = refused(() => core.createSale(ctx.db, { lines: L({ qtyMilli: -1_000 }), payments: [{ methodId: ctx.cashMethodId, amount: -10_000 }], actor: ctx.actor }));
  check(5, 'zero qty refused', zero.includes('পরিমাণ'), `"${zero.slice(0, 26)}"`);
  check(6, 'negative qty refused', neg.includes('পরিমাণ'), `"${neg.slice(0, 26)}"`);

  // 7/8 invoice numbering, including a second live connection
  const t2 = makeTestDb({ file: true });
  const p2 = core.createProduct(t2.db, { name: 'ডাল', unitId: t2.unitPieceId, salePrice: 5_000, openingStockMilli: 100_000 }, t2.actor);
  const other = core.openDatabase({ file: t2.dbPath, appVersion: '1.2.0' });
  const nos: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    nos.push((core.createSale(t2.db, { lines: [{ productId: p2.id, unitId: t2.unitPieceId, qtyMilli: 1_000 }], payments: [{ methodId: t2.cashMethodId, amount: 5_000 }], actor: t2.actor }) as any).invoiceNo);
  }
  const rOther: any = core.createSale(other, { lines: [{ productId: p2.id, unitId: t2.unitPieceId, qtyMilli: 1_000 }], payments: [{ methodId: t2.cashMethodId, amount: 5_000 }], actor: t2.actor });
  const dupes = (t2.db.prepare('SELECT COUNT(*) c FROM (SELECT invoice_no FROM sales GROUP BY invoice_no HAVING COUNT(*) > 1)').get() as any).c;
  check(7, 'invoice numbers sequential', nos.join(',') === 'INV-2611-0001,INV-2611-0002,INV-2611-0003', nos.join(','));
  check(8, 'second connection gets the next number, no duplicates', rOther.invoiceNo === 'INV-2611-0004' && dupes === 0, `${rOther.invoiceNo}, duplicates ${dupes}`);

  // 9 excessive line discount clamps, 10 price floor
  const bigDisc: any = core.createSale(ctx.db, { lines: L({ discountPaisa: 99_999 }), payments: [{ methodId: ctx.cashMethodId, amount: 0 }], actor: ctx.actor });
  check(9, 'line discount larger than the line clamps at 0', bigDisc.computation.total === 0, `total ${bigDisc.computation.total}`);
  const floorP = core.createProduct(ctx.db, { name: 'তেল', unitId: ctx.unitPieceId, salePrice: 10_000, minSalePricePaisa: 9_000, openingStockMilli: 10_000 }, ctx.actor);
  const below = refused(() => core.createSale(ctx.db, { lines: [{ productId: floorP.id, unitId: ctx.unitPieceId, qtyMilli: 1_000, unitPricePaisa: 5_000 }], payments: [{ methodId: ctx.cashMethodId, amount: 5_000 }], actor: ctx.actor }));
  check(10, 'price floor refuses below floor without override', below.includes('সর্বনিম্ন'), `"${below.slice(0, 34)}"`);

  // 11-13 void
  const sale: any = core.createSale(ctx.db, { lines: L(), payments: [{ methodId: ctx.cashMethodId, amount: 10_000 }], actor: ctx.actor });
  const beforeVoid = stock();
  core.voidSale(ctx.db, sale.saleId, 'পরীক্ষা', ctx.actor);
  check(11, 'void restores stock exactly once', stock() === beforeVoid + 1_000, `${beforeVoid} -> ${stock()}`);
  const dbl = refused(() => core.voidSale(ctx.db, sale.saleId, 'আবার', ctx.actor));
  check(12, 'duplicate void refused', dbl.includes('আগেই বাতিল'), `"${dbl.slice(0, 34)}"`);

  // 14/15 returns
  const s3: any = core.createSale(ctx.db, { lines: L(), payments: [{ methodId: ctx.cashMethodId, amount: 10_000 }], actor: ctx.actor });
  const line = ctx.db.prepare('SELECT id FROM sale_items WHERE sale_id = ?').get(s3.saleId) as any;
  const overRet = refused(() => core.createSaleReturn(ctx.db, { saleId: s3.saleId, items: [{ lineId: line.id, qtyMilli: 2_000 }], refundMethodId: ctx.cashMethodId, actor: ctx.actor }));
  check(14, 'over-return refused', overRet.includes('সর্বোচ্চ'), `"${overRet.slice(0, 40)}"`);
  const sBeforeRet = stock();
  const partial: any = core.createSaleReturn(ctx.db, { saleId: s3.saleId, items: [{ lineId: line.id, qtyMilli: 400 }], refundMethodId: ctx.cashMethodId, actor: ctx.actor });
  const rest: any = core.createSaleReturn(ctx.db, { saleId: s3.saleId, items: [{ lineId: line.id, qtyMilli: 600 }], refundMethodId: ctx.cashMethodId, actor: ctx.actor });
  const third = refused(() => core.createSaleReturn(ctx.db, { saleId: s3.saleId, items: [{ lineId: line.id, qtyMilli: 100 }], refundMethodId: ctx.cashMethodId, actor: ctx.actor }));
  check(15, 'partial returns accumulate, third refused', partial.refund === 4_000 && rest.refund === 6_000 && third.includes('সর্বোচ্চ') && stock() === sBeforeRet + 1_000, `${partial.refund}+${rest.refund}, stock ${sBeforeRet}->${stock()}`);

  // 13 void after return
  const voidAfter = refused(() => core.voidSale(ctx.db, s3.saleId, 'দেরিতে', ctx.actor));
  check(13, 'void after a return refused (no double restock)', voidAfter.includes('রিটার্ন'), `"${voidAfter.slice(0, 40)}"`);

  // 16 integrity
  check(16, 'journal balanced, no negative sale totals', unbalanced() === 0 && negatives() === 0, `unbalanced ${unbalanced()}, negative ${negatives()}`);

  expect(results.filter((r) => r.startsWith('PASS'))).toHaveLength(16);
  ctx.cleanup(); t2.cleanup(); other.close();
});
