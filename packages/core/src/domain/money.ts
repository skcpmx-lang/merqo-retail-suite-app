/**
 * Money & quantity arithmetic — the single source of truth for every
 * financial calculation in Sauda Retail Suite.
 *
 * Design rules (documented in docs/DATABASE_SCHEMA.md § Numeric precision):
 *  - All money is an integer number of POISA (1 BDT = 100 poisa). Never a float.
 *  - All quantities are an integer number of MILLI units (1 unit = 1000 milli),
 *    which gives exact 3-decimal quantities such as 0.25 kg or 1.5 L.
 *  - Weighted average cost is kept as MICRO poisa per BASE unit
 *    (1 poisa = 1_000_000 micro) so that sub-poisa unit costs stay exact.
 *  - Every division is an explicit half-up rounding performed on integers.
 */

export const PAISA_PER_TAKA = 100;
export const MILLI = 1000;
export const MICRO = 1_000_000;

/** Integer division with half-up rounding that is symmetric for negatives. */
const BN_TO_EN: Record<string, string> = {
  '০': '0','১': '1','২': '2','৩': '3','৪': '4','৫': '5','৬': '6','৭': '7','৮': '8','৯': '9',
};

/** Accept Bangla numerals in any numeric input field. */
export function normalizeDigits(value: string): string {
  return value.replace(/[০-৯]/g, (d) => BN_TO_EN[d] ?? d);
}

function parseNumber(value: number | string, label = 'value'): number {
  const cleaned = normalizeDigits(String(value).replace(/[,\s৳]/g, ''));
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new Error(`${label} সংখ্যাটি সঠিক নয়`);
  return n;
}

export function roundDiv(numerator: number, denominator: number): number {
  if (denominator === 0) throw new Error('roundDiv: division by zero');
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    throw new Error('roundDiv: non-finite operand');
  }
  const negative = numerator < 0 !== denominator < 0;
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  const q = Math.floor((n * 2 + d) / (d * 2));
  return negative ? -q : q;
}

export function assertSafeInt(value: number, label = 'value'): number {
  if (!Number.isFinite(value)) throw new Error(`${label} is not a finite number`);
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new Error(`${label} out of safe range`);
  return Math.trunc(value);
}

/** Convert a "rate per unit" price into the internal integer representation. */
export function toInt(value: number | string | null | undefined, label = 'value'): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s৳]/g, ''));
  if (!Number.isFinite(n)) throw new Error(`${label} সংখ্যাটি সঠিক নয়`);
  return Math.round(n);
}

/** Taka (decimal, e.g. 12.50) → poisa (1250). */
export function takaToPaisa(taka: number | string): number {
  const n = typeof taka === 'number' ? taka : parseNumber(taka, 'টাকার পরিমাণ');
  if (!Number.isFinite(n)) throw new Error('টাকার পরিমাণ সঠিক নয়');
  return Math.round(n * PAISA_PER_TAKA);
}

/** Poisa → taka as a plain number (for display only, never for arithmetic). */
export function paisaToTaka(paisa: number): number {
  return paisa / PAISA_PER_TAKA;
}

/** Quantity entered in a given unit (e.g. 0.25 kg) → milli of that unit (250). */
export function qtyToMilli(qty: number | string): number {
  const n = typeof qty === 'number' ? qty : parseNumber(qty, 'পরিমাণ');
  if (!Number.isFinite(n)) throw new Error('পরিমাণ সংখ্যাটি সঠিক নয়');
  return Math.round(n * MILLI);
}

export function milliToQty(milli: number): number {
  return milli / MILLI;
}

/** qty (milli of a unit) → base-unit milli, using the unit's milli factor. */
export function toBaseMilli(qtyMilli: number, factorMilli: number): number {
  return roundDiv(qtyMilli * factorMilli, MILLI);
}

/** base-unit milli → qty in the given unit (milli). */
export function fromBaseMilli(baseMilli: number, factorMilli: number): number {
  if (factorMilli === 0) throw new Error('fromBaseMilli: invalid unit factor');
  return roundDiv(baseMilli * MILLI, factorMilli);
}

/** Line value in poisa for qty (milli of unit) at unitPrice (poisa per unit). */
export function lineValuePaisa(qtyMilli: number, unitPricePaisa: number): number {
  return roundDiv(qtyMilli * unitPricePaisa, MILLI);
}

/** Unit price (poisa per unit) → micro poisa per BASE unit. */
export function unitPriceToCostMicro(unitPricePaisa: number, factorMilli: number): number {
  if (factorMilli <= 0) throw new Error('unitPriceToCostMicro: invalid unit factor');
  return roundDiv(unitPricePaisa * MICRO * MILLI, factorMilli);
}

/** micro poisa per base unit → poisa per given unit. */
export function costMicroToUnitPrice(costMicro: number, factorMilli: number): number {
  return roundDiv(costMicro * factorMilli, MICRO * MILLI);
}

/** Value in poisa of qty base-milli at a micro-poisa-per-base-unit cost. */
export function costValuePaisa(qtyBaseMilli: number, costMicro: number): number {
  return roundDiv(qtyBaseMilli * costMicro, MILLI * MICRO);
}

/** Weighted average of an existing stock position and an incoming lot. */
export function weightedAverageCost(
  existingQtyBaseMilli: number,
  existingCostMicro: number,
  incomingQtyBaseMilli: number,
  incomingCostMicro: number,
): number {
  if (existingQtyBaseMilli <= 0) return Math.round(incomingCostMicro);
  if (incomingQtyBaseMilli <= 0) return Math.round(existingCostMicro);
  const totalQty = existingQtyBaseMilli + incomingQtyBaseMilli;
  const totalValue = existingQtyBaseMilli * existingCostMicro + incomingQtyBaseMilli * incomingCostMicro;
  return roundDiv(totalValue, totalQty);
}

/** Apply a percentage (stored as percent × 100) to a poisa amount. */
export function percentOfPaisa(amountPaisa: number, percentX100: number): number {
  return roundDiv(amountPaisa * percentX100, 100 * 100);
}

export interface DiscountInput {
  subtotal: number;
  type: 'none' | 'percent' | 'fixed';
  value: number;
  maxPercentX100?: number;
}

/** Resolve a discount definition into a concrete poisa amount (never above subtotal). */
export function resolveDiscount(input: DiscountInput): number {
  const { subtotal, type, value } = input;
  if (subtotal <= 0) return 0;
  let amount = 0;
  if (type === 'percent') {
    amount = roundDiv(subtotal * value, 100 * 100);
  } else if (type === 'fixed') {
    amount = Math.round(value);
  }
  if (amount < 0) amount = 0;
  if (amount > subtotal) amount = subtotal;
  return amount;
}

export function clampNonNegative(n: number): number {
  return n < 0 ? 0 : n;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

export function toBengaliDigits(text: string): string {
  return text.replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]!);
}

/** 1234567 → "12,345.67" (no symbol). Thousands grouping, always 2 decimals. */
export function formatPaisa(paisa: number, opts: { negativeParen?: boolean } = {}): string {
  const negative = paisa < 0;
  const abs = Math.abs(Math.round(paisa));
  const taka = Math.floor(abs / PAISA_PER_TAKA);
  const fraction = abs % PAISA_PER_TAKA;
  const grouped = String(taka).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `${grouped}.${String(fraction).padStart(2, '0')}`;
  if (!negative) return body;
  return opts.negativeParen ? `(${body})` : `-${body}`;
}

/** Full currency text with the configured symbol, e.g. "৳ 1,250.00". */
export function formatMoney(paisa: number, symbol = '৳', bengaliDigits = false): string {
  const txt = formatPaisa(paisa);
  const final = `${symbol} ${txt}`;
  return final;
}

export function formatQty(qtyMilli: number, shortUnit?: string | null): string {
  const value = qtyMilli / MILLI;
  const decimals = Number.isInteger(value) ? 0 : Math.abs(value * 100) % 10 === 0 ? 2 : 3;
  const txt = value.toFixed(decimals);
  return shortUnit ? `${txt} ${shortUnit}` : txt;
}

export function formatPercent(percentX100: number): string {
  return `${(percentX100 / 100).toFixed(2)}%`;
}
