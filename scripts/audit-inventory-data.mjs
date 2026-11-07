#!/usr/bin/env node
/**
 * Read-only inventory data review (v1.2.0, Phase 2 module 2): F-INV-01 legacy stock and F-INV-02
 * duplicate barcodes.
 *
 *   node scripts/audit-inventory-data.mjs --db "C:\Users\shop\AppData\Roaming\Sauda\sauda.db"
 *   node scripts/audit-inventory-data.mjs --db sauda.db --json report.json
 *
 * It opens the database **read-only**, prints what a human needs to decide, and writes nothing —
 * no UPDATE, no DELETE, no auto-correction. A wrong guess here would silently change a shop's
 * inventory and its valuation, so the decision stays with the owner.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const dbPath = arg('--db', '');
const jsonPath = arg('--json', '');
if (!dbPath) {
  console.error('usage: node scripts/audit-inventory-data.mjs --db <path to sauda.db> [--json out.json]');
  process.exit(2);
}
if (!fs.existsSync(dbPath)) {
  console.error(`database not found: ${dbPath}`);
  process.exit(2);
}

// Opened read-only at the SQLite level: no UPDATE, no DELETE, no migration can run through this
// handle even by accident. The queries mirror `stockScaleSuspects()` in core/services/
// stock-scale-review.ts (which is the tested implementation the app uses); everything here is a
// report for a human, never a correction.
const db = new DatabaseSync(path.resolve(dbPath), { readOnly: true });

// ---- F-INV-01: stock that may have been stored on the wrong scale -------------------------------
const fixedFrom = arg('--fixed-from', '2026-11-07');
const suspectRows = db
  .prepare(
    `SELECT p.id, p.name, p.sku, p.stock_base_milli,
            COALESCE(u.name, '') AS unit_name,
            COALESCE(u.factor_milli, 1000) AS factor_milli,
            SUM(CASE WHEN m.type = 'opening' THEN 1 ELSE 0 END) AS opening_moves,
            SUM(CASE WHEN m.type IN ('purchase','purchase_return') THEN 1 ELSE 0 END) AS purchase_moves,
            SUM(CASE WHEN m.type IN ('sale','sale_return') THEN 1 ELSE 0 END) AS sale_moves,
            SUM(CASE WHEN m.type IN ('adjustment','damage','expiry','transfer') THEN 1 ELSE 0 END) AS adjust_moves
       FROM products p
       LEFT JOIN units u ON u.id = COALESCE(p.primary_unit_id, p.unit_id)
       LEFT JOIN stock_movements m ON m.product_id = p.id AND m.created_at < ?
      WHERE p.stock_base_milli > 0 AND COALESCE(u.factor_milli, 1000) <> 1000
      GROUP BY p.id
     HAVING COUNT(m.id) > 0
      ORDER BY p.stock_base_milli DESC`,
  )
  .all(fixedFrom);

const scale = {
  suspects: suspectRows.map((r) => {
    const factor = Number(r.factor_milli) || 1000;
    const opening = Number(r.opening_moves ?? 0);
    const purchases = Number(r.purchase_moves ?? 0);
    return {
      productId: Number(r.id),
      name: String(r.name),
      sku: r.sku ?? null,
      primaryUnit: String(r.unit_name),
      primaryFactorMilli: factor,
      storedBaseMilli: Number(r.stock_base_milli),
      asPrimaryMilli: Math.round((Number(r.stock_base_milli) * 1000) / factor),
      scaleRatio: factor / 1000,
      openingMovements: opening,
      purchaseMovements: purchases,
      saleMovements: Number(r.sale_moves ?? 0),
      adjustmentMovements: Number(r.adjust_moves ?? 0),
      reason:
        opening > 0 && purchases === 0
          ? 'opening stock was entered on the old form and nothing has been purchased since — the whole quantity is suspect'
          : opening > 0
            ? 'opening stock from the old form is mixed with correctly converted purchases — a human must reconcile the two'
            : 'stock predates the fix but no opening movement is recorded — check the count/adjustment history',
    };
  }),
};
console.log('\n== F-INV-01: stock entered before the fix on a non-identity unit ==');
if (!scale.suspects.length) {
  console.log('none — no positive-stock product with a non-identity primary unit has pre-fix history.');
} else {
  console.log(`${scale.suspects.length} product(s) need a human decision:`);
  for (const s of scale.suspects) {
    console.log(
      `  #${s.productId} ${s.name}${s.sku ? ` (${s.sku})` : ''} — stored ${s.storedBaseMilli} base-milli ` +
        `= ${(s.asPrimaryMilli / 1000).toFixed(3)} ${s.primaryUnit} as shown; unit factor ${s.primaryFactorMilli} (×${s.scaleRatio} vs identity)`,
    );
    console.log(`      opening ${s.openingMovements}, purchases ${s.purchaseMovements}, sales ${s.saleMovements}, adjustments ${s.adjustmentMovements}`);
    console.log(`      ${s.reason}`);
  }
  console.log('\n  NOTE: no value is changed here. Use Inventory → সমন্বয় (adjustment) to correct a');
  console.log('  quantity you have verified physically; every adjustment is reason-stamped and audited.');
}

// ---- F-INV-02: one barcode on more than one product ---------------------------------------------
const dupes = db
  .prepare(
    `SELECT code, COUNT(*) AS products, GROUP_CONCAT(product_id) AS product_ids
       FROM product_barcodes GROUP BY code HAVING COUNT(*) > 1
      ORDER BY code`,
  )
  .all();
const dupesInProducts = db
  .prepare(
    `SELECT barcode AS code, COUNT(*) AS products, GROUP_CONCAT(id) AS product_ids
       FROM products WHERE barcode IS NOT NULL AND TRIM(barcode) <> ''
      GROUP BY barcode HAVING COUNT(*) > 1`,
  )
  .all();
console.log('\n== F-INV-02: duplicate barcodes ==');
const all = [...dupes, ...dupesInProducts];
if (!all.length) {
  console.log('none — every barcode identifies exactly one product.');
} else {
  for (const d of all) {
    console.log(`  "${d.code}" is on ${d.products} products: ids ${d.product_ids}`);
  }
  console.log('\n  No barcode is deleted or rewritten by this tool. Policy to apply (owner decision):');
  console.log('  1. keep the barcode on the product that physically carries it (check the packaging);');
  console.log('  2. clear it on the others, or give them a new distinct code;');
  console.log('  3. only then can a UNIQUE index on product_barcodes.code be added.');
}

const report = { generatedAt: new Date().toISOString(), database: path.basename(dbPath), stockScale: scale, duplicateBarcodes: all };
if (jsonPath) {
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`\nreport written to ${jsonPath}`);
}
db.close();
