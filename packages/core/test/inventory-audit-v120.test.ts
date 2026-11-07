import { describe, expect, it } from 'vitest';
import { makeTestDb } from './helpers.js';
import * as core from '../src/index.js';

/**
 * Phase 2 module 2 — the checks that were left inconclusive or untested in the first pass,
 * re-run with the API shapes the application actually uses (previous attempts passed
 * `deltaMilli` / `qtyMilli`, which the services ignore, so those runs proved nothing).
 */
describe('Products & Inventory: audit checks (v1.2.0)', () => {
  it('stock adjustment sets an absolute quantity and refuses to go negative', () => {
    const t = makeTestDb();
    const p = core.createProduct(t.db, { name: 'চাল', unitId: t.unitPieceId, salePrice: 1_000, openingStockMilli: 1_000 }, t.actor);
    const res = core.adjustStock(t.db, { productId: p.id, newQtyBaseMilli: 4_000, reason: 'গণনা', actor: t.actor } as any);
    expect(res.balanceAfterMilli).toBe(4_000);
    expect((t.db.prepare('SELECT stock_base_milli q FROM products WHERE id=?').get(p.id) as any).q).toBe(4_000);
    expect(() => core.adjustStock(t.db, { productId: p.id, newQtyBaseMilli: -1, reason: 'x', actor: t.actor } as any)).toThrow();
    expect((t.db.prepare('SELECT stock_base_milli q FROM products WHERE id=?').get(p.id) as any).q).toBe(4_000);
    // the reason is mandatory: an unexplained adjustment is unauditable
    expect(() => core.adjustStock(t.db, { productId: p.id, newQtyBaseMilli: 9_000, reason: '  ', actor: t.actor } as any)).toThrow();
    t.cleanup();
  });

  it('stock transfer moves stock between locations and refuses an empty transfer', () => {
    const t = makeTestDb();
    const p = core.createProduct(t.db, { name: 'ডাল', unitId: t.unitPieceId, salePrice: 1_000, openingStockMilli: 10_000 }, t.actor);
    const from = core.defaultLocationId(t.db);
    const created = core.createLocation(t.db, { name: 'দ্বিতীয় গুদাম' } as any, t.actor) as any;
    const to = created.id ?? (core.listLocations(t.db) as any[]).find((l) => l.name === 'দ্বিতীয় গুদাম')!.id;
    expect(() => core.createTransfer(t.db, { fromLocationId: from, toLocationId: to, items: [] } as any, t.actor)).toThrow();

    core.createTransfer(t.db, { fromLocationId: from, toLocationId: to, items: [{ productId: p.id, qtyBaseMilli: 3_000 }] } as any, t.actor);
    const at = (locId: number) =>
      (t.db.prepare('SELECT qty_base_milli q FROM stock_levels WHERE product_id=? AND location_id=?').get(p.id, locId) as any)?.q;
    expect(at(to)).toBe(3_000);
    expect(at(from)).toBe(7_000);
    expect((t.db.prepare('SELECT stock_base_milli q FROM products WHERE id=?').get(p.id) as any).q).toBe(10_000);
    t.cleanup();
  });

  it('serials: registration reports what it skipped instead of silently duplicating', () => {
    const t = makeTestDb();
    const p = core.createProduct(t.db, { name: 'ফোন', unitId: t.unitPieceId, salePrice: 100_000, trackSerials: true } as any, t.actor);
    const first = core.registerSerials(t.db, { productId: p.id, serials: ['IMEI-1', 'IMEI-2'], locationId: core.defaultLocationId(t.db) } as any);
    expect(first.added).toBe(2);
    const again = core.registerSerials(t.db, { productId: p.id, serials: ['IMEI-1', 'IMEI-3'], locationId: core.defaultLocationId(t.db) } as any);
    expect(again.added).toBe(1);
    expect(again.skipped).toContain('IMEI-1');
    expect((t.db.prepare('SELECT COUNT(*) c FROM serial_numbers WHERE product_id=?').get(p.id) as any).c).toBe(3);
    t.cleanup();
  });

  it('multi-unit pricing: a গ্রাম sale of a কেজি product is priced by the unit factor', () => {
    const t = makeTestDb();
    const gram = (t.db.prepare("SELECT id FROM units WHERE name='গ্রাম'").get() as any).id;
    const p = core.createProduct(t.db, { name: 'চিনি', unitId: t.unitKgId, salePrice: 120_000, openingStockMilli: 10_000_000 }, t.actor);
    // qtyMilli is milli of the CHOSEN unit: 250 গ্রাম = 250 000 milli-gram.
    // ৳1200/kg → 250 g = ৳300 = 30 000 paisa.
    const sale: any = core.createSale(t.db, { lines: [{ productId: p.id, unitId: gram, qtyMilli: 250_000 }], payments: [{ methodId: t.cashMethodId, amount: 30_000 }], actor: t.actor } as any);
    expect(sale.computation.total).toBe(30_000);
    // a 0.25 g line is priced proportionally, not rounded to a whole unit
    const tiny: any = core.createSale(t.db, { lines: [{ productId: p.id, unitId: gram, qtyMilli: 250 }], payments: [{ methodId: t.cashMethodId, amount: 30 }], actor: t.actor } as any);
    expect(tiny.computation.total).toBe(30);
    // 1 kg in the primary unit costs ৳1200 and moves a whole 1000 g
    const saleKg: any = core.createSale(t.db, { lines: [{ productId: p.id, unitId: t.unitKgId, qtyMilli: 1_000 }], payments: [{ methodId: t.cashMethodId, amount: 120_000 }], actor: t.actor } as any);
    expect(saleKg.computation.total).toBe(120_000);
    expect((t.db.prepare('SELECT stock_base_milli q FROM products WHERE id=?').get(p.id) as any).q).toBe(10_000_000 - 250_000 - 250 - 1_000_000);
    t.cleanup();
  });

  it('FEFO: a sale consumes the earliest-expiring batch first', () => {
    const t = makeTestDb();
    const p = core.createProduct(t.db, { name: 'ওষুধ', unitId: t.unitPieceId, salePrice: 5_000, batchTracked: true, expiryTracked: true, openingStockMilli: 30_000 } as any, t.actor);
    const addBatch = (no: string, qty: number, expiry: string) =>
      t.db.prepare('INSERT INTO batches (product_id, batch_no, expiry_date, qty_base_milli, cost_micro, created_at) VALUES (?,?,?,?,0,?)')
        .run(p.id, no, expiry, qty, new Date().toISOString());
    addBatch('LATE', 10_000, '2027-12-31');
    addBatch('EARLY', 10_000, '2026-01-31');
    core.createSale(t.db, { lines: [{ productId: p.id, unitId: t.unitPieceId, qtyMilli: 12_000 }], payments: [{ methodId: t.cashMethodId, amount: 60_000 }], actor: t.actor } as any);
    const q = (no: string) => (t.db.prepare('SELECT qty_base_milli q FROM batches WHERE batch_no=?').get(no) as any)?.q;
    expect(q('EARLY')).toBe(0);
    expect(q('LATE')).toBe(8_000);
    t.cleanup();
  });

  it('import round-trip: a products CSV previews and commits with prices in taka', () => {
    const t = makeTestDb();
    const csv = 'name,sale_price,purchase_price,unit,opening_stock\nমসলা,120,90,গ্রাম,500\n';
    const preview: any = core.previewImport(t.db, 'products' as any, csv);
    expect(preview.rows.length).toBe(1);
    expect(preview.error_count).toBe(0);
    const result: any = core.commitImport(t.db, 'products' as any, csv, { mapping: preview.mapping }, t.actor);
    expect(result.created, JSON.stringify(result.errors)).toBe(1);
    const row: any = t.db.prepare('SELECT * FROM products WHERE name = ?').get('মসলা');
    expect(row).toBeTruthy();
    expect(row.sale_price).toBe(12_000);
    t.cleanup();
  });
});
