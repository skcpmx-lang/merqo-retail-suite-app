import type { Db } from '../db/connection.js';
import type { AppSettings } from '../domain/types.js';
import { getSettings } from './settings.js';
import { computeSale, type SaleComputation, type SaleInput } from './sales.js';

/**
 * Stale-cart protection (v1.1.4 final hardening).
 *
 * A cashier can hold a cart for minutes. Prices, product status and stock move in that
 * time — often because another PC sold the last unit. The old behaviour silently charged
 * the *new* price and failed with a generic "not enough stock" message, so the cashier
 * could not see what changed.
 *
 * The POS therefore sends what it showed the customer (`expected`). The Main Server
 * compares it with the authoritative database inside the same commit and, if anything
 * moved, refuses with a structured `SaleConflictError` (`code: 'SALE_CONFLICT'`) listing
 * every affected line. Nothing is substituted, nothing is removed, nothing is charged.
 */

export type SaleConflictKind =
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_INACTIVE'
  | 'PRICE_CHANGED'
  | 'STOCK_CHANGED'
  | 'TOTAL_CHANGED'
  | 'LINE_MISMATCH'
  | 'CART_INVALID';

export interface SaleConflict {
  kind: SaleConflictKind;
  /** Index into `input.lines` (‑1 for whole-cart conflicts). */
  lineIndex: number;
  productId: number | null;
  productName: string;
  expectedPaisa?: number;
  currentPaisa?: number;
  requiredBaseMilli?: number;
  availableBaseMilli?: number;
  message: string;
}

export class SaleConflictError extends Error {
  readonly code = 'SALE_CONFLICT';
  readonly conflicts: SaleConflict[];
  /** Serialised into the IPC/HTTP error so the POS can mark the exact lines. */
  readonly details: { conflicts: SaleConflict[] };
  constructor(conflicts: SaleConflict[]) {
    super(
      conflicts.length
        ? `কার্টে ${conflicts.length}টি পরিবর্তন হয়েছে — কাস্টমারের সাথে যাচাই করে আবার চেষ্টা করুন।`
        : 'কার্ট যাচাই করা যায়নি।',
    );
    this.name = 'SaleConflictError';
    this.conflicts = conflicts;
    this.details = { conflicts };
  }
}

export interface SaleExpectationLine {
  productId?: number;
  /** Price the cashier showed the customer, in paisa. */
  unitPricePaisa?: number;
  /** Quantity in base units (milli), used for stock revalidation only. */
  qtyBaseMilli?: number;
}

export interface SaleExpectation {
  /**
   * Index-aligned with `input.lines`. A `null` entry means "no expectation for this
   * line" (used by non-POS callers such as imports and tests).
   */
  lines?: Array<SaleExpectationLine | null>;
  /** The total the cashier saw for this cart, in paisa. */
  totalPaisa?: number;
}

/** Products a cart line refers to, with their authoritative state. */
function loadProduct(db: Db, productId: number | undefined) {
  if (!productId) return undefined;
  return db.prepare('SELECT id, name, is_active, is_service, stock_base_milli FROM products WHERE id = ?').get(productId) as
    | { id: number; name: string; is_active: number; is_service: number; stock_base_milli: number }
    | undefined;
}

/**
 * Every way the cart no longer matches the shop. Read-only: safe to call from a review
 * screen as often as the UI likes.
 */
export function collectSaleConflicts(
  db: Db,
  input: SaleInput,
  computation: SaleComputation,
  settings: AppSettings,
): SaleConflict[] {
  const conflicts: SaleConflict[] = [];
  const expected = input.expected;
  if (!expected) return conflicts;

  for (let i = 0; i < input.lines.length; i += 1) {
    const want = expected.lines?.[i];
    if (!want) continue;
    const line = computation.lines[i];
    const product = loadProduct(db, want.productId ?? line?.productId);

    if (!product) {
      conflicts.push({
        kind: 'PRODUCT_NOT_FOUND',
        lineIndex: i,
        productId: want.productId ?? line?.productId ?? null,
        productName: line?.productName ?? '',
        message: 'প্রোডাক্টটি আর পাওয়া যাচ্ছে না — কার্ট থেকে সরিয়ে দিন।',
      });
      continue;
    }
    if (product.is_active !== 1) {
      conflicts.push({
        kind: 'PRODUCT_INACTIVE',
        lineIndex: i,
        productId: product.id,
        productName: product.name,
        message: `"${product.name}" এখন নিষ্ক্রিয় — এই আইটেম বিক্রি করা যাবে না।`,
      });
      continue;
    }
    if (want.productId && line && line.productId !== want.productId) {
      conflicts.push({
        kind: 'LINE_MISMATCH',
        lineIndex: i,
        productId: product.id,
        productName: product.name,
        message: 'কার্টের আইটেম মিলছে না — কার্ট আবার যাচাই করুন।',
      });
      continue;
    }
    if (want.unitPricePaisa != null && line && line.unitPrice !== want.unitPricePaisa) {
      conflicts.push({
        kind: 'PRICE_CHANGED',
        lineIndex: i,
        productId: product.id,
        productName: product.name,
        expectedPaisa: want.unitPricePaisa,
        currentPaisa: line.unitPrice,
        message: `"${product.name}" এর দাম বদলেছে — আগে ${formatPaisa(want.unitPricePaisa)}, এখন ${formatPaisa(line.unitPrice)}।`,
      });
    }
  }

  // Stock is checked per product, not per line, so two lines of the same product are
  // added together before comparing with what is actually on the shelf.
  if (settings.allow_negative_stock !== 1 && !input.overrideNegativeStock) {
    const required = new Map<number, number>();
    for (const line of computation.lines) required.set(line.productId, (required.get(line.productId) ?? 0) + line.qtyBaseMilli);
    for (const [productId, qty] of required) {
      const product = loadProduct(db, productId);
      if (!product || product.is_service === 1) continue;
      if (qty > product.stock_base_milli) {
        conflicts.push({
          kind: 'STOCK_CHANGED',
          lineIndex: computation.lines.findIndex((l) => l.productId === productId),
          productId,
          productName: product.name,
          requiredBaseMilli: qty,
          availableBaseMilli: product.stock_base_milli,
          message: `"${product.name}" এর স্টক যথেষ্ট নয় — দরকার ${formatQty(qty)}, আছে ${formatQty(product.stock_base_milli)}।`,
        });
      }
    }
  }

  if (expected.totalPaisa != null && expected.totalPaisa !== computation.total) {
    conflicts.push({
      kind: 'TOTAL_CHANGED',
      lineIndex: -1,
      productId: null,
      productName: '',
      expectedPaisa: expected.totalPaisa,
      currentPaisa: computation.total,
      message: `মোট বদলেছে — কাস্টমারকে দেখানো ${formatPaisa(expected.totalPaisa)}, এখন ${formatPaisa(computation.total)}।`,
    });
  }

  return conflicts;
}

/** Throws when the cart no longer matches the shop. Called by `createSale`. */
export function assertSaleExpectations(
  db: Db,
  input: SaleInput,
  computation: SaleComputation,
  settings: AppSettings,
): void {
  const conflicts = collectSaleConflicts(db, input, computation, settings);
  if (conflicts.length) throw new SaleConflictError(conflicts);
}

export interface CartValidation {
  ok: boolean;
  totalPaisa: number;
  conflicts: SaleConflict[];
  lines: Array<{
    productId: number;
    productName: string;
    unitPricePaisa: number;
    qtyBaseMilli: number;
    availableBaseMilli: number;
    isActive: boolean;
  }>;
}

/**
 * Read-only cart check used by the POS when an event says prices or stock moved.
 * Returns the authoritative state *and* the conflicts, without committing anything.
 */
export function validateCart(db: Db, input: SaleInput): CartValidation {
  const settings = requireSettings(db);
  let computation: SaleComputation;
  try {
    computation = computeSale(db, input, settings);
  } catch (err) {
    return {
      ok: false,
      totalPaisa: 0,
      conflicts: [
        {
          kind: 'CART_INVALID',
          lineIndex: -1,
          productId: null,
          productName: '',
          message: (err as Error).message,
        },
      ],
      lines: [],
    };
  }
  const conflicts = collectSaleConflicts(db, input, computation, settings);
  return {
    ok: conflicts.length === 0,
    totalPaisa: computation.total,
    conflicts,
    lines: computation.lines.map((line) => {
      const product = loadProduct(db, line.productId);
      return {
        productId: line.productId,
        productName: line.productName,
        unitPricePaisa: line.unitPrice,
        qtyBaseMilli: line.qtyBaseMilli,
        availableBaseMilli: product?.stock_base_milli ?? 0,
        isActive: product?.is_active === 1,
      };
    }),
  };
}

function requireSettings(db: Db): AppSettings {
  return getSettings(db);
}

function formatPaisa(paisa: number): string {
  return `৳${(paisa / 100).toFixed(2)}`;
}

function formatQty(baseMilli: number): string {
  return (baseMilli / 1000).toFixed(3);
}
