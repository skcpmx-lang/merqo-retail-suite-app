import type { Db } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import {
  assertSafeInt,
  formatPaisa,
  resolveDiscount,
  toBaseMilli,
  unitPriceToCostMicro,
} from '../domain/money.js';
import { bengaliSortKey, foldForSearch, normalizeText } from '../domain/text.js';
import type { DiscountType, Paged, Product, ProductWithMeta } from '../domain/types.js';
import { audit } from './audit.js';
import { applyMovement } from './inventory.js';
import { isPostingEnabled, postOpeningBalance } from './accounting.js';
import { costValuePaisa } from '../domain/money.js';

type Actor = { id: number; username: string } | null | undefined;

const SORTABLE: Record<string, string> = {
  name: 'p.name_sort',
  created: 'p.id',
  stock: 'p.stock_base_milli',
  sale_price: 'p.sale_price',
  purchase_price: 'p.purchase_price',
};

const PRODUCT_SELECT = `
  SELECT p.*,
         c.name  AS category_name,
         sc.name AS subcategory_name,
         b.name  AS brand_name,
         u.short_name  AS unit_short_name,
         u.factor_milli AS sale_unit_factor_milli,
         pu.short_name AS primary_unit_short_name,
         pu.factor_milli AS unit_factor_milli
    FROM products p
    LEFT JOIN categories c  ON c.id = p.category_id
    LEFT JOIN categories sc ON sc.id = p.subcategory_id
    LEFT JOIN brands b      ON b.id = p.brand_id
    LEFT JOIN units u       ON u.id = p.unit_id
    LEFT JOIN units pu      ON pu.id = COALESCE(p.primary_unit_id, p.unit_id)
`;

export interface ProductFilter {
  search?: string;
  categoryId?: number | null;
  subcategoryId?: number | null;
  brandId?: number | null;
  stockState?: 'all' | 'low' | 'out' | 'in';
  includeInactive?: boolean;
  page?: number;
  pageSize?: number;
  sort?: 'name' | 'created' | 'stock' | 'sale_price' | 'purchase_price';
  direction?: 'asc' | 'desc';
}

export function listProducts(db: Db, f: ProductFilter = {}): Paged<ProductWithMeta> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!f.includeInactive) where.push('p.is_active = 1');
  if (f.categoryId) {
    where.push('(p.category_id = ? OR p.subcategory_id = ?)');
    params.push(f.categoryId, f.categoryId);
  }
  if (f.subcategoryId) {
    where.push('p.subcategory_id = ?');
    params.push(f.subcategoryId);
  }
  if (f.brandId) {
    where.push('p.brand_id = ?');
    params.push(f.brandId);
  }
  if (f.search && f.search.trim()) {
    const like = `%${foldForSearch(f.search)}%`;
    where.push('(p.search_text LIKE ? OR p.sku LIKE ? OR p.product_code LIKE ?)');
    params.push(like, like, like);
  }
  if (f.stockState === 'low') where.push('p.stock_base_milli > 0 AND p.stock_base_milli <= p.min_stock_base_milli');
  if (f.stockState === 'out') where.push('p.stock_base_milli <= 0');
  if (f.stockState === 'in') where.push('p.stock_base_milli > 0');

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) c FROM products p ${clause}`).get(...params) as { c: number }).c;
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(1000, Math.max(5, f.pageSize ?? 50));
  const sortCol = SORTABLE[f.sort ?? 'name'] ?? SORTABLE.name;
  const dir = (f.direction ?? 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const rows = db
    .prepare(`${PRODUCT_SELECT} ${clause} ORDER BY ${sortCol} ${dir}, p.id ${dir} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as ProductWithMeta[];
  return { rows: rows.map(decoratePrice), total, page, page_size: pageSize };
}

/**
 * Attach the effective selling price (offer-aware) so any UI — POS tiles,
 * product lists, receipts — shows exactly what `computeSale` will charge.
 * All arithmetic stays here in the core; renderers only display it.
 */
export function decoratePrice(row: ProductWithMeta): ProductWithMeta {
  const breakdown = productPriceBreakdown(row);
  const primaryFactor = row.unit_factor_milli || 1000;
  const saleFactor = row.sale_unit_factor_milli || primaryFactor;
  const unitPrice = Math.round((breakdown.final * saleFactor) / primaryFactor);
  return {
    ...row,
    final_price_paisa: breakdown.final,
    offer_active: breakdown.discount > 0 ? 1 : 0,
    base_price_paisa: breakdown.base,
    unit_price_paisa: unitPrice,
    primary_factor_milli: primaryFactor,
  };
}

export function getProduct(db: Db, id: number): ProductWithMeta | null {
  const row = db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(id) as ProductWithMeta | undefined;
  if (!row) return null;
  const decorated = decoratePrice(row);
  decorated.barcodes = (db.prepare('SELECT code FROM product_barcodes WHERE product_id = ?').all(id) as {
    code: string;
  }[]).map((r) => r.code);
  return decorated;
}

export function findByCode(db: Db, code: string): ProductWithMeta | null {
  const clean = normalizeText(code);
  if (!clean) return null;
  // Exact hit first (uses the barcode/SKU indexes), then a case-insensitive
  // retry so a manually typed "rice-01" still finds SKU "RICE-01".
  const exact = db
    .prepare(
      `${PRODUCT_SELECT} WHERE p.is_active = 1 AND (p.sku = ? OR p.product_code = ?
        OR p.id IN (SELECT product_id FROM product_barcodes WHERE code = ?)) LIMIT 1`,
    )
    .get(clean, clean, clean) as ProductWithMeta | undefined;
  if (exact) return decoratePrice(exact);
  const loose = db
    .prepare(
      `${PRODUCT_SELECT} WHERE p.is_active = 1 AND (lower(p.sku) = lower(?) OR lower(p.product_code) = lower(?)
        OR p.id IN (SELECT product_id FROM product_barcodes WHERE lower(code) = lower(?))) LIMIT 1`,
    )
    .get(clean, clean, clean) as ProductWithMeta | undefined;
  return loose ? decoratePrice(loose) : null;
}

export interface BarcodeInput {
  code: string;
  kind?: 'barcode' | 'qr';
  isPrimary?: boolean;
}

export interface ProductInput {
  name: string;
  sku?: string | null;
  productCode?: string | null;
  categoryId?: number | null;
  subcategoryId?: number | null;
  brandId?: number | null;
  unitId?: number | null;
  primaryUnitId?: number | null;
  purchasePrice?: number;
  salePrice?: number;
  wholesalePrice?: number | null;
  retailPrice?: number | null;
  specialPrice?: number | null;
  discountType?: DiscountType;
  discountValue?: number;
  minStockMilli?: number;
  openingStockMilli?: number;
  openingCostMicro?: number;
  vatPercentX100?: number;
  description?: string | null;
  imagePath?: string | null;
  batchTracked?: boolean;
  expiryTracked?: boolean;
  variantParentId?: number | null;
  variantAttributes?: Record<string, string> | null;
  barcodes?: BarcodeInput[];
  isActive?: boolean;
}

function validateProductInput(db: Db, input: ProductInput, id?: number): void {
  if (!normalizeText(input.name)) throw new Error('প্রোডাক্টের নাম দিতে হবে।');
  const prices = [
    ['ক্রয়মূল্য', input.purchasePrice],
    ['বিক্রয়মূল্য', input.salePrice],
    ['পাইকারি মূল্য', input.wholesalePrice],
    ['খুচরা মূল্য', input.retailPrice],
    ['বিশেষ মূল্য', input.specialPrice],
  ] as const;
  for (const [label, value] of prices) {
    if (value === null || value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label} ঋণাত্মক হতে পারবে না।`);
    if (value > 1_000_000_00) throw new Error(`${label} অস্বাভাবিক বেশি (সর্বোচ্চ ১০,০০,০০০ টাকা)।`);
  }
  if ((input.discountValue ?? 0) < 0) throw new Error('ডিসকাউন্ট ঋণাত্মক হতে পারবে না।');
  if (input.discountType === 'percent' && (input.discountValue ?? 0) > 10000)
    throw new Error('ডিসকাউন্ট ১০০% এর বেশি হতে পারবে না।');
  if (input.discountType === 'fixed' && (input.discountValue ?? 0) > (input.salePrice ?? 0))
    throw new Error('ফিক্সড ডিসকাউন্ট বিক্রয়মূল্যের চেয়ে বেশি হতে পারবে না।');
  if ((input.minStockMilli ?? 0) < 0) throw new Error('সর্বনিম্ন স্টক ঋণাত্মক হতে পারবে না।');
  if ((input.openingStockMilli ?? 0) < 0) throw new Error('ওপেনিং স্টক ঋণাত্মক হতে পারবে না।');
  if (input.sku) {
    const dup = db
      .prepare('SELECT id FROM products WHERE lower(sku) = lower(?) AND id IS NOT ?')
      .get(normalizeText(input.sku), id ?? null);
    if (dup) throw new Error('এই SKU আগেই ব্যবহৃত হয়েছে।');
  }
  if (input.productCode) {
    const dup = db
      .prepare('SELECT id FROM products WHERE lower(product_code) = lower(?) AND id IS NOT ?')
      .get(normalizeText(input.productCode), id ?? null);
    if (dup) throw new Error('এই প্রোডাক্ট কোড আগেই ব্যবহৃত হয়েছে।');
  }
  for (const bc of input.barcodes ?? []) {
    const code = normalizeText(bc.code);
    if (!code) continue;
    const dup = db
      .prepare('SELECT product_id FROM product_barcodes WHERE code = ? AND product_id IS NOT ?')
      .get(code, id ?? null) as { product_id: number } | undefined;
    if (dup) throw new Error(`বারকোড "${code}" অন্য প্রোডাক্টে ব্যবহৃত হচ্ছে।`);
    if (bc.kind && bc.kind === 'qr' && !code) throw new Error('QR ডাটা খালি হতে পারবে না।');
  }
}

function buildSearchText(db: Db, input: ProductInput, barcodes: string[]): string {
  const parts: string[] = [input.name, input.sku ?? '', input.productCode ?? '', input.description ?? ''];
  if (input.categoryId) {
    const r = db.prepare('SELECT name FROM categories WHERE id = ?').get(input.categoryId) as { name: string } | undefined;
    if (r) parts.push(r.name);
  }
  if (input.subcategoryId) {
    const r = db.prepare('SELECT name FROM categories WHERE id = ?').get(input.subcategoryId) as { name: string } | undefined;
    if (r) parts.push(r.name);
  }
  if (input.brandId) {
    const r = db.prepare('SELECT name FROM brands WHERE id = ?').get(input.brandId) as { name: string } | undefined;
    if (r) parts.push(r.name);
  }
  parts.push(...barcodes);
  if (input.variantAttributes) parts.push(...Object.values(input.variantAttributes));
  return foldForSearch(parts.join(' '));
}

function saveBarcodes(db: Db, productId: number, barcodes: BarcodeInput[]): void {
  const clean = barcodes
    .map((b) => ({ code: normalizeText(b.code), kind: b.kind ?? 'barcode', isPrimary: b.isPrimary ? 1 : 0 }))
    .filter((b) => b.code);
  const seen = new Set<string>();
  for (const b of clean) {
    if (seen.has(b.code)) throw new Error(`বারকোড "${b.code}" একই প্রোডাক্টে দুইবার দেওয়া যাবে না।`);
    seen.add(b.code);
  }
  db.prepare('DELETE FROM product_barcodes WHERE product_id = ?').run(productId);
  const stmt = db.prepare(
    'INSERT INTO product_barcodes (product_id, code, kind, is_primary, created_at) VALUES (?,?,?,?,?)',
  );
  const insertMany = db.transaction(() => {
    clean.forEach((b, idx) => stmt.run(productId, b.code, b.kind, b.isPrimary || idx === 0 ? 1 : 0, nowLocal()));
  });
  insertMany();
}

export function createProduct(db: Db, input: ProductInput, actor?: Actor): ProductWithMeta {
  validateProductInput(db, input);
  const now = nowLocal();
  const unitId = input.unitId ?? null;
  if (!unitId) throw new Error('স্টক ইউনিট নির্বাচন করতে হবে।');
  const primaryUnitId = input.primaryUnitId ?? unitId;
  const search = buildSearchText(db, input, (input.barcodes ?? []).map((b) => b.code));

  const create = db.transaction(() => {
    const res = db
      .prepare(
        `INSERT INTO products
         (name, name_sort, search_text, sku, product_code, category_id, subcategory_id, brand_id, unit_id, primary_unit_id,
          purchase_price, sale_price, wholesale_price, retail_price, special_price, discount_type, discount_value,
          stock_base_milli, min_stock_base_milli, opening_stock_base_milli, opening_cost_micro, avg_cost_micro,
          vat_percent_x100, description, image_path, batch_tracked, expiry_tracked, variant_parent_id, variant_attributes,
          is_active, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      )
      .run(
        normalizeText(input.name),
        bengaliSortKey(input.name),
        search,
        input.sku ? normalizeText(input.sku) : null,
        input.productCode ? normalizeText(input.productCode) : null,
        input.categoryId ?? null,
        input.subcategoryId ?? null,
        input.brandId ?? null,
        unitId,
        primaryUnitId,
        assertSafeInt(input.purchasePrice ?? 0),
        assertSafeInt(input.salePrice ?? 0),
        input.wholesalePrice ?? null,
        input.retailPrice ?? null,
        input.specialPrice ?? null,
        input.discountType ?? 'none',
        assertSafeInt(input.discountValue ?? 0),
        assertSafeInt(input.minStockMilli ?? 0),
        assertSafeInt(input.openingStockMilli ?? 0),
        assertSafeInt(input.openingCostMicro ?? 0),
        assertSafeInt(input.openingCostMicro ?? 0),
        assertSafeInt(input.vatPercentX100 ?? 0),
        input.description ? normalizeText(input.description) : null,
        input.imagePath ?? null,
        input.batchTracked ? 1 : 0,
        input.expiryTracked ? 1 : 0,
        input.variantParentId ?? null,
        input.variantAttributes ? JSON.stringify(input.variantAttributes) : null,
        now,
        now,
      );
    const id = Number(res.lastInsertRowid);
    saveBarcodes(db, id, input.barcodes ?? []);
    if ((input.openingStockMilli ?? 0) > 0) {
      applyMovement(db, {
        productId: id,
        type: 'opening',
        qtyBaseMilli: input.openingStockMilli!,
        reason: 'ওপেনিং স্টক',
        userId: actor?.id ?? null,
        incomingCostMicro: input.openingCostMicro ?? 0,
      });
      if (isPostingEnabled(db)) {
        const value = costValuePaisa(input.openingStockMilli!, Math.max(0, input.openingCostMicro ?? 0));
        postOpeningBalance(db, {
          source: 'opening_stock',
          sourceId: id,
          amount: value,
          kind: 'asset',
          memo: `ওপেনিং স্টক: ${input.name}`,
        });
      }
    }
    return id;
  });
  const id = create();
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username,
    action: 'product.create',
    entity: 'product',
    entityId: id,
    details: { name: input.name, salePrice: input.salePrice, purchasePrice: input.purchasePrice },
  });
  return getProduct(db, id)!;
}

export function updateProduct(db: Db, id: number, input: ProductInput, actor?: Actor): ProductWithMeta {
  const existing = getProduct(db, id);
  if (!existing) throw new Error('প্রোডাক্ট পাওয়া যায়নি।');
  validateProductInput(db, input, id);
  const now = nowLocal();
  const search = buildSearchText(db, input, (input.barcodes ?? []).map((b) => b.code));
  const priceFields: { field: keyof Product; label: string }[] = [
    { field: 'purchase_price', label: 'purchase_price' },
    { field: 'sale_price', label: 'sale_price' },
    { field: 'wholesale_price', label: 'wholesale_price' },
    { field: 'retail_price', label: 'retail_price' },
    { field: 'special_price', label: 'special_price' },
  ];
  const nextValues: Record<string, unknown> = {
    purchase_price: input.purchasePrice ?? existing.purchase_price,
    sale_price: input.salePrice ?? existing.sale_price,
    wholesale_price: input.wholesalePrice ?? null,
    retail_price: input.retailPrice ?? null,
    special_price: input.specialPrice ?? null,
  };

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE products SET
         name = ?, name_sort = ?, search_text = ?, sku = ?, product_code = ?, category_id = ?, subcategory_id = ?,
         brand_id = ?, unit_id = ?, primary_unit_id = ?, purchase_price = ?, sale_price = ?, wholesale_price = ?,
         retail_price = ?, special_price = ?, discount_type = ?, discount_value = ?, min_stock_base_milli = ?,
         vat_percent_x100 = ?, description = ?, image_path = ?, batch_tracked = ?, expiry_tracked = ?,
         variant_parent_id = ?, variant_attributes = ?, is_active = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      normalizeText(input.name),
      bengaliSortKey(input.name),
      search,
      input.sku ? normalizeText(input.sku) : null,
      input.productCode ? normalizeText(input.productCode) : null,
      input.categoryId ?? null,
      input.subcategoryId ?? null,
      input.brandId ?? null,
      input.unitId ?? existing.unit_id,
      input.primaryUnitId ?? existing.primary_unit_id ?? existing.unit_id,
      nextValues.purchase_price as number,
      nextValues.sale_price as number,
      nextValues.wholesale_price as number | null,
      nextValues.retail_price as number | null,
      nextValues.special_price as number | null,
      input.discountType ?? 'none',
      input.discountValue ?? 0,
      input.minStockMilli ?? existing.min_stock_base_milli,
      input.vatPercentX100 ?? existing.vat_percent_x100,
      input.description ? normalizeText(input.description) : null,
      input.imagePath ?? null,
      input.batchTracked ? 1 : 0,
      input.expiryTracked ? 1 : 0,
      input.variantParentId ?? null,
      input.variantAttributes ? JSON.stringify(input.variantAttributes) : null,
      input.isActive === false ? 0 : 1,
      now,
      id,
    );
    if (input.barcodes) saveBarcodes(db, id, input.barcodes);
    const hist = db.prepare(
      'INSERT INTO price_history (product_id, field, old_value, new_value, user_id, created_at) VALUES (?,?,?,?,?,?)',
    );
    for (const f of priceFields) {
      const oldVal = (existing as any)[f.field];
      const newVal = nextValues[f.label];
      if (String(oldVal ?? '') !== String(newVal ?? '') && !(oldVal == null && newVal == null)) {
        hist.run(id, f.label, String(oldVal ?? ''), String(newVal ?? ''), actor?.id ?? null, now);
      }
    }
  });
  run();
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username,
    action: 'product.update',
    entity: 'product',
    entityId: id,
    details: { name: input.name },
  });
  return getProduct(db, id)!;
}

export function setProductActive(db: Db, id: number, active: boolean, actor?: Actor): void {
  db.prepare('UPDATE products SET is_active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, nowLocal(), id);
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username,
    action: active ? 'product.archive' : 'product.restore',
    entity: 'product',
    entityId: id,
  });
}

/** Hard delete is only allowed for products that never touched a document. */
export function deleteProduct(db: Db, id: number, actor?: Actor): void {
  const used =
    (db.prepare('SELECT COUNT(*) c FROM sale_items WHERE product_id = ?').get(id) as { c: number }).c +
    (db.prepare('SELECT COUNT(*) c FROM purchase_items WHERE product_id = ?').get(id) as { c: number }).c +
    (db.prepare("SELECT COUNT(*) c FROM stock_movements WHERE product_id = ? AND type <> 'opening'").get(id) as {
      c: number;
    }).c;
  if (used > 0) {
    throw new Error('এই প্রোডাক্টে লেনদেন হয়েছে — ডিলিট করা যাবে না। আর্কাইভ করুন।');
  }
  const row = db.prepare('SELECT name FROM products WHERE id = ?').get(id) as { name: string } | undefined;
  const run = db.transaction(() => {
    db.prepare('DELETE FROM product_barcodes WHERE product_id = ?').run(id);
    db.prepare('DELETE FROM stock_movements WHERE product_id = ?').run(id);
    db.prepare('DELETE FROM price_history WHERE product_id = ?').run(id);
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
  });
  run();
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username,
    action: 'product.delete',
    entity: 'product',
    entityId: id,
    details: { name: row?.name },
  });
}

export function addBarcode(db: Db, productId: number, code: string, kind: 'barcode' | 'qr' = 'barcode'): void {
  const clean = normalizeText(code);
  if (!clean) throw new Error('বারকোড খালি হতে পারবে না।');
  const dup = db.prepare('SELECT product_id FROM product_barcodes WHERE code = ?').get(clean) as
    | { product_id: number }
    | undefined;
  if (dup) throw new Error('এই বারকোড আগেই নিবন্ধিত।');
  db.prepare('INSERT INTO product_barcodes (product_id, code, kind, is_primary, created_at) VALUES (?,?,?,0,?)').run(
    productId,
    clean,
    kind,
    nowLocal(),
  );
}

export type PriceLevel = 'retail' | 'wholesale' | 'special';

export function priceLevelValue(product: Product, level: PriceLevel): number {
  if (level === 'wholesale' && product.wholesale_price) return product.wholesale_price;
  if (level === 'special' && product.special_price) return product.special_price;
  if (level === 'retail' && product.retail_price) return product.retail_price;
  return product.sale_price;
}

export interface PriceBreakdown {
  base: number;
  discount: number;
  final: number;
}

export function productPriceBreakdown(product: Product, level: PriceLevel = 'retail'): PriceBreakdown {
  const base = priceLevelValue(product, level);
  const discount = resolveDiscount({
    subtotal: base,
    type: product.discount_type ?? 'none',
    value: product.discount_value ?? 0,
  });
  return { base, discount, final: base - discount };
}

/** Suggested purchase price from the product's own stored cost / prices. */
export function suggestedCostMicro(product: Product): number {
  if (product.purchase_price > 0) {
    const factor = 1000;
    return unitPriceToCostMicro(product.purchase_price, factor);
  }
  return product.avg_cost_micro;
}

export function listPriceHistory(db: Db, productId: number, limit = 100): any[] {
  return db
    .prepare(
      `SELECT h.*, u.username FROM price_history h LEFT JOIN users u ON u.id = h.user_id
        WHERE h.product_id = ? ORDER BY h.id DESC LIMIT ?`,
    )
    .all(productId, limit);
}

export function productCounts(db: Db): { total: number; low: number; out: number; inactive: number } {
  const total = (db.prepare('SELECT COUNT(*) c FROM products WHERE is_active = 1').get() as { c: number }).c;
  const low = (
    db
      .prepare(
        'SELECT COUNT(*) c FROM products WHERE is_active = 1 AND stock_base_milli > 0 AND stock_base_milli <= min_stock_base_milli',
      )
      .get() as { c: number }
  ).c;
  const out = (db.prepare('SELECT COUNT(*) c FROM products WHERE is_active = 1 AND stock_base_milli <= 0').get() as {
    c: number;
  }).c;
  const inactive = (db.prepare('SELECT COUNT(*) c FROM products WHERE is_active = 0').get() as { c: number }).c;
  return { total, low, out, inactive };
}

export function formatProductLabel(product: Product, level: PriceLevel = 'retail'): string {
  const price = productPriceBreakdown(product, level);
  const qty = formatPaisa(price.final);
  return `${product.name} — ৳${qty}`;
}

/** Total stock in base milli for a set of products (used by the product form). */
export function baseStockOf(db: Db, productId: number, unitId: number, qtyMilli: number): number {
  const unit = db.prepare('SELECT factor_milli, base_unit_id FROM units WHERE id = ?').get(unitId) as
    | { factor_milli: number; base_unit_id: number | null }
    | undefined;
  if (!unit) throw new Error('ইউনিট পাওয়া যায়নি।');
  return toBaseMilli(qtyMilli, unit.factor_milli);
}

/** Alias kept for the IPC layer: look up a product by barcode / SKU / code. */
export const findCodeAnywhere = findByCode;

export interface ProductLabel {
  id: number;
  name: string;
  price_paisa: number;
  unit: string | null;
  code: string | null;
  qr_code: string | null;
}

/**
 * Minimal data needed to print a price/barcode label. The barcode falls back
 * through: primary barcode → SKU → product code; the QR payload is a stable
 * `SAUDA:<id>` reference so it can be re-scanned into this app.
 */
export function listProductLabels(db: Db, ids: number[]): ProductLabel[] {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.sale_price, p.retail_price, p.sku, p.product_code,
              u.short_name AS unit,
              (SELECT b.code FROM product_barcodes b WHERE b.product_id = p.id AND b.kind = 'barcode'
                ORDER BY b.is_primary DESC, b.id LIMIT 1) AS barcode,
              (SELECT b.code FROM product_barcodes b WHERE b.product_id = p.id AND b.kind = 'qr'
                ORDER BY b.is_primary DESC, b.id LIMIT 1) AS qr
         FROM products p LEFT JOIN units u ON u.id = COALESCE(p.primary_unit_id, p.unit_id)
        WHERE p.id IN (${placeholders})
        ORDER BY p.name_sort`,
    )
    .all(...ids) as any[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    price_paisa: row.retail_price ?? row.sale_price,
    unit: row.unit ?? null,
    code: row.barcode ?? row.sku ?? row.product_code ?? null,
    qr_code: row.qr ?? `SAUDA:${row.id}`,
  }));
}
