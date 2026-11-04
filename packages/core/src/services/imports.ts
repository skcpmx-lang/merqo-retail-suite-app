import type { Db } from '../db/connection.js';
import { takaToPaisa, qtyToMilli, roundDiv } from '../domain/money.js';
import { foldForSearch, normalizeText } from '../domain/text.js';
import { parseCsv } from '../export/tabular.js';
import { audit } from './audit.js';
import { createCategory, createUnit } from './catalog.js';
import { createBrand } from './catalog.js';
import { createProduct } from './products.js';
import { createCustomer } from './customers.js';
import { createSupplier } from './suppliers.js';

export interface ImportField {
  key: string;
  label: string;
  aliases: string[];
  required?: boolean;
}

export type ImportKind = 'products' | 'customers' | 'suppliers';

export const IMPORT_FIELDS: Record<ImportKind, ImportField[]> = {
  products: [
    { key: 'name', label: 'প্রোডাক্টের নাম', aliases: ['name', 'product', 'product name', 'প্রোডাক্ট', 'নাম'], required: true },
    { key: 'sku', label: 'SKU', aliases: ['sku', 'code', 'item code'] },
    { key: 'product_code', label: 'প্রোডাক্ট কোড', aliases: ['product_code', 'product code', 'পণ্য কোড'] },
    { key: 'barcode', label: 'বারকোড', aliases: ['barcode', 'bar code', 'বারকোড'] },
    { key: 'category', label: 'ক্যাটাগরি', aliases: ['category', 'ক্যাটাগরি'] },
    { key: 'subcategory', label: 'সাব-ক্যাটাগরি', aliases: ['subcategory', 'sub category', 'সাব ক্যাটাগরি'] },
    { key: 'brand', label: 'ব্র্যান্ড', aliases: ['brand', 'ব্র্যান্ড'] },
    { key: 'unit', label: 'ইউনিট', aliases: ['unit', 'ইউনিট'] },
    { key: 'purchase_price', label: 'ক্রয়মূল্য', aliases: ['purchase_price', 'purchase price', 'buy price', 'ক্রয়মূল্য'] },
    { key: 'sale_price', label: 'বিক্রয়মূল্য', aliases: ['sale_price', 'sale price', 'price', 'বিক্রয়মূল্য', 'মূল্য'] },
    { key: 'wholesale_price', label: 'পাইকারি মূল্য', aliases: ['wholesale_price', 'wholesale', 'পাইকারি'] },
    { key: 'retail_price', label: 'খুচরা মূল্য', aliases: ['retail_price', 'retail', 'খুচরা'] },
    { key: 'opening_stock', label: 'ওপেনিং স্টক', aliases: ['opening_stock', 'stock', 'qty', 'স্টক'] },
    { key: 'min_stock', label: 'সর্বনিম্ন স্টক', aliases: ['min_stock', 'alert qty', 'সর্বনিম্ন স্টক'] },
    { key: 'description', label: 'বিবরণ', aliases: ['description', 'note', 'বিবরণ'] },
    { key: 'expiry_date', label: 'মেয়াদ', aliases: ['expiry', 'expiry_date', 'মেয়াদ'] },
  ],
  customers: [
    { key: 'name', label: 'কাস্টমারের নাম', aliases: ['name', 'customer', 'নাম'], required: true },
    { key: 'phone', label: 'মোবাইল', aliases: ['phone', 'mobile', 'মোবাইল'] },
    { key: 'address', label: 'ঠিকানা', aliases: ['address', 'ঠিকানা'] },
    { key: 'opening_balance', label: 'পূর্বের বাকি', aliases: ['opening_balance', 'due', 'বাকি'] },
    { key: 'note', label: 'নোট', aliases: ['note', 'নোট'] },
  ],
  suppliers: [
    { key: 'name', label: 'সাপ্লায়ারের নাম', aliases: ['name', 'supplier', 'নাম'], required: true },
    { key: 'company', label: 'কোম্পানি', aliases: ['company', 'কোম্পানি'] },
    { key: 'phone', label: 'মোবাইল', aliases: ['phone', 'mobile', 'মোবাইল'] },
    { key: 'email', label: 'ইমেইল', aliases: ['email', 'ইমেইল'] },
    { key: 'address', label: 'ঠিকানা', aliases: ['address', 'ঠিকানা'] },
    { key: 'contact_person', label: 'যোগাযোগ ব্যক্তি', aliases: ['contact_person', 'contact', 'যোগাযোগ'] },
    { key: 'opening_balance', label: 'পূর্বের পাওনা', aliases: ['opening_balance', 'payable', 'পাওনা'] },
  ],
};

export function autoMap(kind: ImportKind, headers: string[]): Record<string, number> {
  const mapping: Record<string, number> = {};
  const folded = headers.map((h) => foldForSearch(h));
  for (const field of IMPORT_FIELDS[kind]) {
    const idx = folded.findIndex((h) => field.aliases.some((a) => h === foldForSearch(a)));
    if (idx >= 0) {
      mapping[field.key] = idx;
      continue;
    }
    const partial = folded.findIndex((h) => field.aliases.some((a) => h.includes(foldForSearch(a))));
    if (partial >= 0) mapping[field.key] = partial;
  }
  return mapping;
}

export interface ImportPreviewRow {
  line: number;
  values: Record<string, string>;
  errors: string[];
  duplicate: boolean;
}

export interface ImportPreview {
  kind: ImportKind;
  headers: string[];
  mapping: Record<string, number>;
  fields: ImportField[];
  rows: ImportPreviewRow[];
  valid_count: number;
  error_count: number;
  duplicate_count: number;
}

function pick(row: string[], mapping: Record<string, number>, key: string): string {
  const idx = mapping[key];
  if (idx === undefined || idx < 0) return '';
  return normalizeText(row[idx] ?? '');
}

export function previewImport(db: Db, kind: ImportKind, csvText: string, mappingInput?: Record<string, number>): ImportPreview {
  const { headers, rows } = parseCsv(csvText);
  const mapping = mappingInput ?? autoMap(kind, headers);
  const missing = IMPORT_FIELDS[kind].filter((f) => f.required && mapping[f.key] === undefined);
  if (missing.length) throw new Error(`আবশ্যক কলাম মেলানো যায়নি: ${missing.map((m) => m.label).join(', ')}`);

  const seen = new Set<string>();
  const preview: ImportPreviewRow[] = [];
  for (const [i, row] of rows.entries()) {
    const values: Record<string, string> = {};
    for (const f of IMPORT_FIELDS[kind]) values[f.key] = pick(row, mapping, f.key);
    const errors: string[] = [];
    if (!values.name) errors.push('নাম খালি');
    let duplicate = false;
    if (kind === 'products') {
      const key = `${foldForSearch(values.name)}|${foldForSearch(values.sku)}`;
      if (seen.has(key)) duplicate = true;
      else if (db.prepare('SELECT 1 FROM products WHERE search_text LIKE ? LIMIT 1').get(`%${foldForSearch(values.name)}%`))
        duplicate = true;
      seen.add(key);
      for (const priceKey of ['purchase_price', 'sale_price', 'wholesale_price', 'retail_price']) {
        const v = values[priceKey];
        if (v && !Number.isFinite(Number(v))) errors.push(`${priceKey} সংখ্যা নয়`);
      }
      if (values.opening_stock && !Number.isFinite(Number(values.opening_stock))) errors.push('ওপেনিং স্টক সংখ্যা নয়');
    } else if (kind === 'customers') {
      const key = `c:${foldForSearch(values.phone || values.name)}`;
      if (values.phone && seen.has(key)) duplicate = true;
      else if (values.phone && db.prepare('SELECT 1 FROM customers WHERE phone = ? LIMIT 1').get(values.phone))
        duplicate = true;
      seen.add(key);
    } else {
      const key = `s:${foldForSearch(values.name)}`;
      if (seen.has(key)) duplicate = true;
      else if (values.name && db.prepare('SELECT 1 FROM suppliers WHERE lower(name)=lower(?) LIMIT 1').get(values.name))
        duplicate = true;
      seen.add(key);
    }
    preview.push({ line: i + 2, values, errors, duplicate });
  }
  return {
    kind,
    headers,
    mapping,
    fields: IMPORT_FIELDS[kind],
    rows: preview,
    valid_count: preview.filter((r) => r.errors.length === 0).length,
    error_count: preview.filter((r) => r.errors.length > 0).length,
    duplicate_count: preview.filter((r) => r.duplicate).length,
  };
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: { line: number; message: string }[];
}

function resolveUnitId(db: Db, name: string): number | null {
  if (!name) return null;
  const row = db.prepare('SELECT id FROM units WHERE lower(name)=lower(?) OR lower(short_name)=lower(?)').get(name, name) as
    | { id: number }
    | undefined;
  if (row) return row.id;
  const created = createUnit(db, { name, shortName: name, baseUnitId: null, factorMilli: 1000 });
  return created.id;
}

function resolveCategoryId(db: Db, name: string, parentId: number | null): number | null {
  if (!name) return null;
  const row = db
    .prepare('SELECT id FROM categories WHERE lower(name)=lower(?) AND (parent_id IS ? OR parent_id = ?)')
    .get(name, parentId, parentId) as { id: number } | undefined;
  if (row) return row.id;
  return createCategory(db, name, parentId, null).id;
}

function resolveBrandId(db: Db, name: string): number | null {
  if (!name) return null;
  const row = db.prepare('SELECT id FROM brands WHERE lower(name)=lower(?)').get(name) as { id: number } | undefined;
  if (row) return row.id;
  return createBrand(db, name, null).id;
}

export function commitImport(
  db: Db,
  kind: ImportKind,
  csvText: string,
  options: { mapping?: Record<string, number>; skipDuplicates?: boolean; createMissing?: boolean },
  actor: { id: number; username: string },
): ImportResult {
  const preview = previewImport(db, kind, csvText, options.mapping);
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] };
  const skipDuplicates = options.skipDuplicates !== false;
  const createMissing = options.createMissing !== false;
  const settings = db.prepare("SELECT value FROM settings WHERE key='default_unit_id'").get() as
    | { value: string }
    | undefined;
  const defaultUnitId = settings?.value ? Number(settings.value) : null;

  const run = db.transaction(() => {
    for (const row of preview.rows) {
      if (row.errors.length) {
        result.errors.push({ line: row.line, message: row.errors.join(', ') });
        continue;
      }
      if (row.duplicate && skipDuplicates) {
        result.skipped++;
        continue;
      }
      try {
        if (kind === 'products') {
          const v = row.values;
          const unitId = resolveUnitId(db, v.unit || '') ?? defaultUnitId;
          if (!unitId) throw new Error('ইউনিট পাওয়া যায়নি');
          const categoryId = createMissing ? resolveCategoryId(db, v.category || '', null) : null;
          const subcategoryId = createMissing && v.subcategory ? resolveCategoryId(db, v.subcategory, categoryId) : null;
          const brandId = createMissing ? resolveBrandId(db, v.brand || '') : null;
          const unitFactor = (db.prepare('SELECT factor_milli FROM units WHERE id = ?').get(unitId) as { factor_milli: number })
            .factor_milli;
          const openQtyMilli = v.opening_stock ? qtyToMilli(v.opening_stock) : 0;
          createProduct(
            db,
            {
              name: v.name,
              sku: v.sku || null,
              productCode: v.product_code || null,
              categoryId,
              subcategoryId,
              brandId,
              unitId,
              primaryUnitId: unitId,
              purchasePrice: v.purchase_price ? takaToPaisa(v.purchase_price) : 0,
              salePrice: v.sale_price ? takaToPaisa(v.sale_price) : 0,
              wholesalePrice: v.wholesale_price ? takaToPaisa(v.wholesale_price) : null,
              retailPrice: v.retail_price ? takaToPaisa(v.retail_price) : null,
              minStockMilli: v.min_stock ? qtyToMilli(v.min_stock) : 0,
              openingStockMilli: roundDiv(openQtyMilli * unitFactor, 1000),
              openingCostMicro: v.purchase_price ? Math.round((takaToPaisa(v.purchase_price) * 1_000_000 * 1000) / unitFactor) : 0,
              description: v.description || null,
              expiryTracked: Boolean(v.expiry_date),
              barcodes: v.barcode ? [{ code: v.barcode, kind: 'barcode' as const }] : [],
            },
            actor,
          );
          result.created++;
        } else if (kind === 'customers') {
          const v = row.values;
          createCustomer(
            db,
            {
              name: v.name,
              phone: v.phone || null,
              address: v.address || null,
              openingBalance: v.opening_balance ? takaToPaisa(v.opening_balance) : 0,
              note: v.note || null,
            },
            actor,
          );
          result.created++;
        } else {
          const v = row.values;
          createSupplier(
            db,
            {
              name: v.name,
              company: v.company || null,
              phone: v.phone || null,
              email: v.email || null,
              address: v.address || null,
              contactPerson: v.contact_person || null,
              openingBalance: v.opening_balance ? takaToPaisa(v.opening_balance) : 0,
            },
            actor,
          );
          result.created++;
        }
      } catch (err) {
        result.errors.push({ line: row.line, message: (err as Error).message });
      }
    }
  });
  run();
  audit(db, {
    userId: actor.id,
    username: actor.username,
    action: `import.${kind}`,
    entity: 'import',
    details: { created: result.created, skipped: result.skipped, errors: result.errors.length },
  });
  return result;
}
