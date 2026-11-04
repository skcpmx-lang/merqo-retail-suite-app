/**
 * Synthetic load benchmark (real measurements only — no invented numbers).
 *
 *   node scripts/bench.mjs --products 1000 --sales 2000
 *
 * The database is a throw-away file in the OS temp folder. Everything is measured
 * on this machine with `performance.now()`; the report prints the hardware and
 * dataset size next to every figure so the numbers can be reproduced.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};

const PRODUCTS = arg('products', 1000);
const CUSTOMERS = arg('customers', Math.max(50, Math.round(PRODUCTS / 20)));
const SALES = arg('sales', Math.min(2000, PRODUCTS * 2));
const outDir = path.join(root, 'node_modules', '.cache');
fs.mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, `sauda-bench-${Date.now()}.mjs`);

await build({
  entryPoints: [path.join(root, 'packages/core/src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['better-sqlite3', 'node:*', 'fflate'],
  outfile,
  logLevel: 'error',
  plugins: [
    {
      name: 'core-alias',
      setup(b) {
        b.onResolve({ filter: /^@sauda\/core$/ }, () => ({ path: path.join(root, 'packages/core/src/index.ts') }));
      },
    },
  ],
});

const core = await import(outfile);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-bench-data-'));
const dbPath = path.join(dir, 'bench.db');
const rows = [];
function measure(label, fn) {
  const t0 = performance.now();
  const result = fn();
  const ms = performance.now() - t0;
  rows.push({ label, ms });
  return result;
}

const t0 = performance.now();
const db = core.openDatabase({ file: dbPath, appVersion: '1.0.0' });
core.initializeApp(db, {
  businessName: 'বেঞ্চমার্ক মার্ট',
  businessAddress: 'ঢাকা',
  businessPhone: '01700000000',
  adminFullName: 'বেঞ্চ অ্যাডমিন',
  adminUsername: 'admin',
  adminPassword: 'admin123',
});
const startupMs = performance.now() - t0;

const actor = { id: 1, username: 'admin' };
const units = core.listUnits(db);
const kg = units.find((u) => u.name === 'কেজি');
const piece = units.find((u) => u.name === 'পিস');
const methods = core.listPaymentMethods(db);
const cash = methods.find((m) => m.is_cash === 1);
const cat = core.createCategory(db, 'মুদি', null, actor);

// ---- seed products -------------------------------------------------------
const seedStart = performance.now();
const productIds = [];
const insertProduct = db.prepare(
  `INSERT INTO products (name, name_sort, search_text, sku, category_id, unit_id, primary_unit_id,
     purchase_price, sale_price, stock_base_milli, min_stock_base_milli, avg_cost_micro, is_active, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,0,5000,0,1,?,?)`,
);
const now = core.nowLocal();
db.transaction(() => {
  for (let i = 0; i < PRODUCTS; i++) {
    const name = `বেঞ্চ প্রোডাক্ট ${i} চাল ডাল`;
    const sortKey = core.bengaliSortKey(name);
    const res = insertProduct.run(
      name,
      sortKey,
      core.foldForSearch(`${name} BENCH-${i}`),
      `BENCH-${i}`,
      cat.id,
      piece.id,
      piece.id,
      5000 + (i % 40) * 100,
      7000 + (i % 40) * 150,
      now,
      now,
    );
    productIds.push(Number(res.lastInsertRowid));
  }
})();
const seedProductsMs = performance.now() - seedStart;

// ---- seed customers ------------------------------------------------------
const insertCustomer = db.prepare(
  `INSERT INTO customers (name, name_sort, search_text, phone, opening_balance_paisa, balance_paisa, is_walkin, is_active, created_at, updated_at)
   VALUES (?,?,?,?,0,0,0,1,?,?)`,
);
const customerIds = [];
db.transaction(() => {
  for (let i = 0; i < CUSTOMERS; i++) {
    const name = `কাস্টমার ${i}`;
    const res = insertCustomer.run(name, core.bengaliSortKey(name), core.foldForSearch(`${name} 0171${String(i).padStart(7, '0')}`), `0171${String(i).padStart(7, '0')}`, now, now);
    customerIds.push(Number(res.lastInsertRowid));
  }
})();

// ---- seed sales history (direct SQL, mirrors what createSale writes) -----
const seedSalesStart = performance.now();
db.transaction(() => {
  const insertSale = db.prepare(
    `INSERT INTO sales (invoice_no, customer_id, user_id, sale_date, subtotal_paisa, discount_paisa, tax_paisa,
       total_paisa, paid_paisa, due_paisa, change_paisa, cost_total_paisa, profit_paisa, status, created_at)
     VALUES (?,?,?,?,?,0,0,?,?,?,0,?,?,'completed',?)`,
  );
  const insertItem = db.prepare(
    `INSERT INTO sale_items (sale_id, product_id, product_name, unit_id, unit_label, qty_milli, factor_milli,
       qty_base_milli, unit_price_paisa, discount_paisa, line_total_paisa, cost_micro, cost_total_paisa,
       returned_qty_milli, batch_id) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,0,NULL)`,
  );
  for (let i = 0; i < SALES; i++) {
    const total = 7000 + (i % 50) * 100;
    const cost = 5000 + (i % 50) * 80;
    const day = 1 + (i % 28);
    const date = `2026-10-${String(day).padStart(2, '0')} 10:${String(i % 60).padStart(2, '0')}:00`;
    const res = insertSale.run(
      `BENCH-${String(i).padStart(6, '0')}`,
      customerIds[i % customerIds.length],
      1,
      date,
      total,
      total,
      total,
      cost,
      total - cost,
      date,
      date,
    );
    const saleId = Number(res.lastInsertRowid);
    insertItem.run(saleId, productIds[i % productIds.length], `বেঞ্চ প্রোডাক্ট ${i % productIds.length}`, piece.id, 'পিস', 1000, 1000, 1000, total, total, cost, cost);
  }
})();
const seedSalesMs = performance.now() - seedSalesStart;

// ---- measured read paths -------------------------------------------------
measure('dashboard.stats', () => core.dashboardStats(db));
measure('products.list(page 1, 50)', () => core.listProducts(db, { page: 1, pageSize: 50 }));
measure('products.list(search)', () => core.listProducts(db, { search: 'বেঞ্চ', page: 1, pageSize: 50 }));
measure('products.byCode (barcode)', () => core.findByCode(db, 'BENCH-777'));
measure('global search', () => core.searchEverything(db, 'বেঞ্চ'));
measure('sales.list(page 1)', () => core.listSales(db, { page: 1, pageSize: 50 }));
measure('customers.list(page 1)', () => core.listCustomers(db, { page: 1, pageSize: 50 }));
measure('report: sales_daily', () => core.runReport(db, 'sales_daily', { from: '2026-10-01', to: '2026-10-31' }));
measure('report: profit_loss', () => core.runReport(db, 'profit_loss', { from: '2026-10-01', to: '2026-10-31' }));
measure('report: stock_valuation', () => core.runReport(db, 'stock_valuation'));
measure('report: customer_due', () => core.runReport(db, 'customer_due'));
measure('report: product_performance', () => core.runReport(db, 'product_performance', { from: '2026-10-01', to: '2026-10-31' }));

// ---- measured write paths ------------------------------------------------
const salePerf = measure('createSale × 200 (all products pre-stocked)', () => {
  db.prepare('UPDATE products SET stock_base_milli = 100000, avg_cost_micro = 5000000').run();
  const times = [];
  for (let i = 0; i < 200; i++) {
    const t = performance.now();
    core.createSale(db, {
      customerId: customerIds[i % customerIds.length],
      lines: [{ productId: productIds[i % productIds.length], unitId: piece.id, qtyMilli: 1000 }],
      paidPaisa: 8000,
      defaultMethodId: cash.id,
      actor,
    });
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)], p95: times[Math.floor(times.length * 0.95)], max: times[times.length - 1] };
});

measure('backup.create (VACUUM INTO)', () => core.createBackup(db, { dataDir: dir, appVersion: '1.0.0' }));

// ---- query plans ---------------------------------------------------------
const plans = {
  'product search': db.prepare("EXPLAIN QUERY PLAN SELECT * FROM products WHERE is_active=1 AND search_text LIKE '%বেঞ্চ%' LIMIT 50").all(),
  'barcode lookup': db.prepare("EXPLAIN QUERY PLAN SELECT product_id FROM product_barcodes WHERE code = 'BENCH-1'").all(),
  'sales by date': db.prepare("EXPLAIN QUERY PLAN SELECT * FROM sales WHERE date(sale_date) BETWEEN date('2026-10-01') AND date('2026-10-31')").all(),
  'sale items by sale': db.prepare('EXPLAIN QUERY PLAN SELECT * FROM sale_items WHERE sale_id = 5').all(),
};

const dbSize = fs.statSync(dbPath).size;
const count = (sql) => db.prepare(sql).get().c;

console.log(`\n=== Sauda benchmark ===`);
console.log(`node ${process.version} · ${os.cpus()[0]?.model ?? 'cpu'} · ${Math.round(os.totalmem() / 1e6)} MB RAM · ${process.platform}`);
console.log(`products=${PRODUCTS} customers=${CUSTOMERS} sales=${SALES} (${(dbSize / 1e6).toFixed(1)} MB db)`);
console.log(`startup (open+migrate+seed)=${startupMs.toFixed(1)} ms  seedProducts=${seedProductsMs.toFixed(1)} ms  seedSales=${seedSalesMs.toFixed(1)} ms`);
for (const r of rows) console.log(`${r.label.padEnd(46)} ${r.ms.toFixed(1)} ms`);
console.log(
  `createSale median=${salePerf.median.toFixed(2)} ms p95=${salePerf.p95.toFixed(2)} ms max=${salePerf.max.toFixed(2)} ms`,
);
console.log('\nquery plans:');
for (const [label, plan] of Object.entries(plans)) {
  console.log(`  ${label}: ${plan.map((p) => p.detail).join(' | ')}`);
}
console.log(`\nintegrity=${db.pragma('integrity_check', { simple: true })} fk_rows=${db.pragma('foreign_key_check').length}`);
console.log(`row counts: products=${count('SELECT COUNT(*) c FROM products')} sales=${count('SELECT COUNT(*) c FROM sales')} sale_items=${count('SELECT COUNT(*) c FROM sale_items')}`);

db.close();
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(outfile, { force: true });
