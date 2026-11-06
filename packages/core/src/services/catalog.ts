import type { Db } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import { bengaliSortKey, normalizeText } from '../domain/text.js';
import type { Brand, Category, PaymentMethod, Unit } from '../domain/types.js';
import { audit } from './audit.js';

type Actor = { id: number; username: string } | null | undefined;

/* ------------------------------------------------------------------ */
/* Payment methods                                                    */
/* ------------------------------------------------------------------ */

export function listPaymentMethods(db: Db, includeInactive = false): PaymentMethod[] {
  const sql = includeInactive
    ? 'SELECT * FROM payment_methods ORDER BY sort_order, id'
    : 'SELECT * FROM payment_methods WHERE is_active = 1 ORDER BY sort_order, id';
  return db.prepare(sql).all() as PaymentMethod[];
}

export function createPaymentMethod(db: Db, name: string, isCash: boolean, actor?: Actor): PaymentMethod {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const clean = normalizeText(name);
    if (!clean) throw new Error('পেমেন্ট মেথডের নাম দিতে হবে।');
    const dup = db.prepare('SELECT id FROM payment_methods WHERE lower(name) = lower(?)').get(clean);
    if (dup) throw new Error('এই নামের পেমেন্ট মেথড আগেই আছে।');
    const sort = ((db.prepare('SELECT MAX(sort_order) m FROM payment_methods').get() as { m: number }).m ?? 0) + 1;
    const res = db
      .prepare('INSERT INTO payment_methods (name, is_cash, is_active, is_system, sort_order) VALUES (?,?,1,0,?)')
      .run(clean, isCash ? 1 : 0, sort);
    audit(db, { userId: actor?.id ?? null, username: actor?.username, action: 'payment_method.create', entity: 'payment_method', entityId: Number(res.lastInsertRowid), details: { name: clean } });
    return db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(Number(res.lastInsertRowid)) as PaymentMethod;
  })();
}

export function updatePaymentMethod(
  db: Db,
  id: number,
  patch: { name?: string; isActive?: boolean },
  actor?: Actor,
): PaymentMethod {
  // Name, account and the active flag move together.
  // Nested in the caller's transaction when there is one (better-sqlite3 uses a savepoint).
  const run = db.transaction(() => {
    const row = db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(id) as PaymentMethod | undefined;
    if (!row) throw new Error('পেমেন্ট মেথড পাওয়া যায়নি।');
    if (patch.name !== undefined) {
      const clean = normalizeText(patch.name);
      if (!clean) throw new Error('পেমেন্ট মেথডের নাম দিতে হবে।');
      db.prepare('UPDATE payment_methods SET name = ? WHERE id = ?').run(clean, id);
    }
    if (patch.isActive !== undefined) {
      db.prepare('UPDATE payment_methods SET is_active = ? WHERE id = ?').run(patch.isActive ? 1 : 0, id);
    }
    audit(db, { userId: actor?.id ?? null, username: actor?.username, action: 'payment_method.update', entity: 'payment_method', entityId: id, details: patch });
  });
  run();
  return db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(id) as PaymentMethod;
}

export function deletePaymentMethod(db: Db, id: number, actor?: Actor): void {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(id) as PaymentMethod | undefined;
    if (!row) throw new Error('পেমেন্ট মেথড পাওয়া যায়নি।');
    if (row.is_system) throw new Error('সিস্টেম পেমেন্ট মেথড ডিলিট করা যাবে না, শুধু নিষ্ক্রিয় করা যাবে।');
    const used =
      (db.prepare('SELECT COUNT(*) c FROM payments WHERE method_id = ?').get(id) as { c: number }).c +
      (db.prepare('SELECT COUNT(*) c FROM expenses WHERE method_id = ?').get(id) as { c: number }).c;
    if (used > 0) throw new Error('এই পেমেন্ট মেথড ব্যবহার হয়েছে, তাই ডিলিট করা যাবে না — নিষ্ক্রিয় করুন।');
    db.prepare('DELETE FROM payment_methods WHERE id = ?').run(id);
    audit(db, { userId: actor?.id ?? null, username: actor?.username, action: 'payment_method.delete', entity: 'payment_method', entityId: id });
  })();
}

/* ------------------------------------------------------------------ */
/* Units                                                              */
/* ------------------------------------------------------------------ */

export function listUnits(db: Db, includeInactive = false): Unit[] {
  const sql = includeInactive
    ? 'SELECT * FROM units ORDER BY base_unit_id IS NOT NULL, name'
    : 'SELECT * FROM units WHERE is_active = 1 ORDER BY base_unit_id IS NOT NULL, name';
  return db.prepare(sql).all() as Unit[];
}

export function createUnit(
  db: Db,
  input: { name: string; shortName: string; baseUnitId: number | null; factorMilli: number },
  actor?: Actor,
): Unit {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const name = normalizeText(input.name);
    const short = normalizeText(input.shortName) || name;
    if (!name) throw new Error('ইউনিটের নাম দিতে হবে।');
    if (db.prepare('SELECT id FROM units WHERE lower(name) = lower(?)').get(name))
      throw new Error('এই নামের ইউনিট আগেই আছে।');
    if (input.baseUnitId) {
      const base = db.prepare('SELECT * FROM units WHERE id = ?').get(input.baseUnitId) as Unit | undefined;
      if (!base) throw new Error('বেস ইউনিট পাওয়া যায়নি।');
      if (base.base_unit_id) throw new Error('বেস ইউনিট হিসেবে সরাসরি বেসটি বেছে নিন।');
    }
    if (!Number.isFinite(input.factorMilli) || input.factorMilli <= 0)
      throw new Error('ইউনিটের রূপান্তর ফ্যাক্টর ০ এর চেয়ে বড় হতে হবে।');
    const res = db
      .prepare('INSERT INTO units (name, short_name, base_unit_id, factor_milli, is_system, is_active) VALUES (?,?,?,?,0,1)')
      .run(name, short, input.baseUnitId ?? null, Math.round(input.factorMilli));
    audit(db, { userId: actor?.id ?? null, username: actor?.username, action: 'unit.create', entity: 'unit', entityId: Number(res.lastInsertRowid), details: { name } });
    return db.prepare('SELECT * FROM units WHERE id = ?').get(Number(res.lastInsertRowid)) as Unit;
  })();
}

export function updateUnit(
  db: Db,
  id: number,
  patch: { name?: string; shortName?: string; factorMilli?: number; isActive?: boolean },
  actor?: Actor,
): Unit {
  // A name, a factor and an active flag are one description of a unit, and the factor decides how every product is converted — half an update is a wrong quantity.
  // Nested in the caller's transaction when there is one (better-sqlite3 uses a savepoint).
  const run = db.transaction(() => {
    const row = db.prepare('SELECT * FROM units WHERE id = ?').get(id) as Unit | undefined;
    if (!row) throw new Error('ইউনিট পাওয়া যায়নি।');
    if (patch.factorMilli !== undefined && !row.base_unit_id) {
      if (patch.factorMilli !== 1000) throw new Error('বেস ইউনিটের ফ্যাক্টর সবসময় ১০০০ (১০০%) থাকে।');
    }
    if (patch.name !== undefined) {
      const name = normalizeText(patch.name);
      if (!name) throw new Error('ইউনিটের নাম দিতে হবে।');
      db.prepare('UPDATE units SET name = ? WHERE id = ?').run(name, id);
    }
    if (patch.shortName !== undefined) {
      db.prepare('UPDATE units SET short_name = ? WHERE id = ?').run(normalizeText(patch.shortName), id);
    }
    if (patch.factorMilli !== undefined && row.base_unit_id) {
      if (patch.factorMilli <= 0) throw new Error('ফ্যাক্টর ০ এর চেয়ে বড় হতে হবে।');
      db.prepare('UPDATE units SET factor_milli = ? WHERE id = ?').run(Math.round(patch.factorMilli), id);
    }
    if (patch.isActive !== undefined) {
      db.prepare('UPDATE units SET is_active = ? WHERE id = ?').run(patch.isActive ? 1 : 0, id);
    }
    audit(db, { userId: actor?.id ?? null, username: actor?.username, action: 'unit.update', entity: 'unit', entityId: id, details: patch });
  });
  run();
  return db.prepare('SELECT * FROM units WHERE id = ?').get(id) as Unit;
}

export function deleteUnit(db: Db, id: number, actor?: Actor): void {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM units WHERE id = ?').get(id) as Unit | undefined;
    if (!row) throw new Error('ইউনিট পাওয়া যায়নি।');
    if (row.is_system) throw new Error('সিস্টেম ইউনিট ডিলিট করা যাবে না।');
    const used = (db.prepare('SELECT COUNT(*) c FROM products WHERE unit_id = ? OR primary_unit_id = ?').get(id, id) as { c: number }).c;
    if (used > 0) throw new Error('এই ইউনিট প্রোডাক্টে ব্যবহৃত হচ্ছে — ডিলিট করা যাবে না।');
    const children = (db.prepare('SELECT COUNT(*) c FROM units WHERE base_unit_id = ?').get(id) as { c: number }).c;
    if (children > 0) throw new Error('এই ইউনিটের অধীনে অন্য ইউনিট আছে।');
    db.prepare('DELETE FROM units WHERE id = ?').run(id);
    audit(db, { userId: actor?.id ?? null, username: actor?.username, action: 'unit.delete', entity: 'unit', entityId: id });
  })();
}

/** Units that share the same base family (used by the POS unit selector). */
export function unitFamily(db: Db, unitId: number): Unit[] {
  const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(unitId) as Unit | undefined;
  if (!unit) return [];
  const baseId = unit.base_unit_id ?? unit.id;
  return db
    .prepare('SELECT * FROM units WHERE (id = ? OR base_unit_id = ?) AND is_active = 1 ORDER BY factor_milli')
    .all(baseId, baseId) as Unit[];
}

/** Express a quantity in `unitId` as milli of the base unit of that family. */
export function unitFactor(db: Db, unitId: number): number {
  const unit = db.prepare('SELECT factor_milli FROM units WHERE id = ?').get(unitId) as
    | { factor_milli: number }
    | undefined;
  return unit?.factor_milli ?? 1000;
}

/* ------------------------------------------------------------------ */
/* Categories                                                         */
/* ------------------------------------------------------------------ */

export function listCategories(db: Db, includeInactive = false): Category[] {
  const sql = includeInactive
    ? 'SELECT * FROM categories ORDER BY name_sort'
    : 'SELECT * FROM categories WHERE is_active = 1 ORDER BY name_sort';
  return db.prepare(sql).all() as Category[];
}

export function createCategory(db: Db, name: string, parentId: number | null, actor?: Actor): Category {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const clean = normalizeText(name);
    if (!clean) throw new Error('ক্যাটাগরির নাম দিতে হবে।');
    if (parentId) {
      const parent = db.prepare('SELECT * FROM categories WHERE id = ?').get(parentId) as Category | undefined;
      if (!parent) throw new Error('প্যারেন্ট ক্যাটাগরি পাওয়া যায়নি।');
      if (parent.parent_id) throw new Error('সাব-ক্যাটাগরির অধীনে আরেকটি সাব-ক্যাটাগরি তৈরি করা যাবে না।');
    }
    const dup = db
      .prepare('SELECT id FROM categories WHERE lower(name)=lower(?) AND (parent_id IS ? OR parent_id = ?)')
      .get(clean, parentId, parentId);
    if (dup) throw new Error('এই নামের ক্যাটাগরি আগেই আছে।');
    const res = db
      .prepare('INSERT INTO categories (name, name_sort, parent_id, is_active, created_at) VALUES (?,?,?,1,?)')
      .run(clean, bengaliSortKey(clean), parentId, nowLocal());
    audit(db, { userId: actor?.id ?? null, username: actor?.username, action: 'category.create', entity: 'category', entityId: Number(res.lastInsertRowid), details: { name: clean, parentId } });
    return db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(res.lastInsertRowid)) as Category;
  })();
}

export function updateCategory(
  db: Db,
  id: number,
  patch: { name?: string; parentId?: number | null; isActive?: boolean },
  actor?: Actor,
): Category {
  // Name, parent and the active flag move together with the audit line that says who changed them.
  // Nested in the caller's transaction when there is one (better-sqlite3 uses a savepoint).
  const run = db.transaction(() => {
    const row = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as Category | undefined;
    if (!row) throw new Error('ক্যাটাগরি পাওয়া যায়নি।');
    if (patch.name !== undefined) {
      const clean = normalizeText(patch.name);
      if (!clean) throw new Error('ক্যাটাগরির নাম দিতে হবে।');
      db.prepare('UPDATE categories SET name = ?, name_sort = ? WHERE id = ?').run(clean, bengaliSortKey(clean), id);
    }
    if (patch.parentId !== undefined) {
      if (patch.parentId === id) throw new Error('একটি ক্যাটাগরি নিজের প্যারেন্ট হতে পারবে না।');
      if (patch.parentId) {
        const children = (db.prepare('SELECT COUNT(*) c FROM categories WHERE parent_id = ?').get(id) as { c: number }).c;
        if (children > 0) throw new Error('সাব-ক্যাটাগরি থাকা অবস্থায় প্যারেন্ট পরিবর্তন করা যাবে না।');
      }
      db.prepare('UPDATE categories SET parent_id = ? WHERE id = ?').run(patch.parentId, id);
    }
    if (patch.isActive !== undefined) {
      db.prepare('UPDATE categories SET is_active = ? WHERE id = ?').run(patch.isActive ? 1 : 0, id);
    }
    audit(db, { userId: actor?.id ?? null, username: actor?.username, action: 'category.update', entity: 'category', entityId: id, details: patch });
  });
  run();
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as Category;
}

export function deleteCategory(db: Db, id: number, actor?: Actor): void {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as Category | undefined;
    if (!row) throw new Error('ক্যাটাগরি পাওয়া যায়নি।');
    const products = (
      db.prepare('SELECT COUNT(*) c FROM products WHERE category_id = ? OR subcategory_id = ?').get(id, id) as { c: number }
    ).c;
    if (products > 0)
      throw new Error(`এই ক্যাটাগরির অধীনে ${products} টি প্রোডাক্ট আছে। আগে প্রোডাক্টগুলো অন্য ক্যাটাগরিতে সরান।`);
    const children = (db.prepare('SELECT COUNT(*) c FROM categories WHERE parent_id = ?').get(id) as { c: number }).c;
    if (children > 0) throw new Error('সাব-ক্যাটাগরি থাকা অবস্থায় প্যারেন্ট ডিলিট করা যাবে না।');
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    audit(db, { userId: actor?.id ?? null, username: actor?.username, action: 'category.delete', entity: 'category', entityId: id, details: { name: row.name } });
  })();
}

/* ------------------------------------------------------------------ */
/* Brands                                                             */
/* ------------------------------------------------------------------ */

export function listBrands(db: Db): Brand[] {
  return db.prepare('SELECT * FROM brands ORDER BY name COLLATE BINARY').all() as Brand[];
}

export function createBrand(db: Db, name: string, actor?: Actor): Brand {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const clean = normalizeText(name);
    if (!clean) throw new Error('ব্র্যান্ডের নাম দিতে হবে।');
    if (db.prepare('SELECT id FROM brands WHERE lower(name)=lower(?)').get(clean))
      throw new Error('এই নামের ব্র্যান্ড আগেই আছে।');
    const res = db.prepare('INSERT INTO brands (name, is_active) VALUES (?,1)').run(clean);
    audit(db, { userId: actor?.id ?? null, username: actor?.username, action: 'brand.create', entity: 'brand', entityId: Number(res.lastInsertRowid), details: { name: clean } });
    return db.prepare('SELECT * FROM brands WHERE id = ?').get(Number(res.lastInsertRowid)) as Brand;
  })();
}

export function deleteBrand(db: Db, id: number, actor?: Actor): void {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const used = (db.prepare('SELECT COUNT(*) c FROM products WHERE brand_id = ?').get(id) as { c: number }).c;
    if (used > 0) throw new Error('এই ব্র্যান্ড প্রোডাক্টে ব্যবহৃত হচ্ছে — ডিলিট করা যাবে না।');
    db.prepare('DELETE FROM brands WHERE id = ?').run(id);
    audit(db, { userId: actor?.id ?? null, username: actor?.username, action: 'brand.delete', entity: 'brand', entityId: id });
  })();
}

/* ------------------------------------------------------------------ */
/* Expense categories                                                 */
/* ------------------------------------------------------------------ */

export function listExpenseCategories(db: Db, includeInactive = false): any[] {
  return db
    .prepare(
      `SELECT * FROM expense_categories ${includeInactive ? '' : 'WHERE is_active = 1'} ORDER BY name`,
    )
    .all();
}

export function createExpenseCategory(db: Db, name: string, actor?: Actor): any {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const clean = normalizeText(name);
    if (!clean) throw new Error('এক্সপেন্স ক্যাটাগরির নাম দিতে হবে।');
    if (db.prepare('SELECT id FROM expense_categories WHERE lower(name)=lower(?)').get(clean))
      throw new Error('এই নামের এক্সপেন্স ক্যাটাগরি আগেই আছে।');
    const res = db.prepare('INSERT INTO expense_categories (name, is_active) VALUES (?,1)').run(clean);
    audit(db, { userId: actor?.id ?? null, username: actor?.username, action: 'expense_category.create', entity: 'expense_category', entityId: Number(res.lastInsertRowid) });
    return db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(Number(res.lastInsertRowid));
  })();
}

export function deleteExpenseCategory(db: Db, id: number, actor?: Actor): void {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const used = (db.prepare('SELECT COUNT(*) c FROM expenses WHERE category_id = ?').get(id) as { c: number }).c;
    if (used > 0) throw new Error('এই ক্যাটাগরি ব্যবহার হয়েছে — ডিলিট করা যাবে না, নিষ্ক্রিয় করুন।');
    db.prepare('DELETE FROM expense_categories WHERE id = ?').run(id);
    audit(db, { userId: actor?.id ?? null, username: actor?.username, action: 'expense_category.delete', entity: 'expense_category', entityId: id });
  })();
}
