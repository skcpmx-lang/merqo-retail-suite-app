/**
 * Quantity scale at the renderer/core boundary (v1.2.0, Phase 2 module 2 — F-INV-01).
 *
 * The core stores every quantity in **base-unit milli** (`stock_base_milli`, `qty_base_milli`,
 * stock movements): for rice priced per কেজি the base unit is গ্রাম, so 10 kg is 10 000 000.
 * The shop, however, types quantities in its **primary unit** — the number on the product form,
 * the stock screen and the transfer dialog is "10 কেজি", not "10 gram-milli".
 *
 * Those two scales differ by the unit's `factor_milli / 1000`. For পিস, গ্রাম and লিটার the factor
 * is 1000 and the scales coincide, which is why the bug hid for so long: the whole shop could be
 * run in pieces and nothing looked wrong. For কেজি (factor 1 000 000), মিলিলিটার (1), ডজন (12 000)
 * or বস্তা (50 000 000) the value is off by 1000×, 1000×, 12× or 50×.
 *
 * Everything that converts between the two scales goes through this file, so the rule lives in one
 * place instead of being re-derived (and re-forgotten) at each screen.
 */

/** The identity factor: 1 unit = 1000 milli-units, base unit === primary unit. */
export const IDENTITY_FACTOR = 1000;

/** A usable factor: positive and finite, otherwise the identity (never divide by 0). */
export function unitFactor(factorMilli?: number | null): number {
  return typeof factorMilli === 'number' && Number.isFinite(factorMilli) && factorMilli > 0
    ? factorMilli
    : IDENTITY_FACTOR;
}

/** "10 কেজি" (milli-primary) → base-unit milli for the core (10 000 000). */
export function primaryToBaseMilli(primaryMilli: number, factorMilli?: number | null): number {
  const value = Number.isFinite(primaryMilli) ? primaryMilli : 0;
  return Math.round((value * unitFactor(factorMilli)) / IDENTITY_FACTOR);
}

/** base-unit milli from the core → the number the shop should see (milli-primary). */
export function baseToPrimaryMilli(baseMilli: number, factorMilli?: number | null): number {
  const value = Number.isFinite(baseMilli) ? baseMilli : 0;
  return Math.round((value * IDENTITY_FACTOR) / unitFactor(factorMilli));
}

/** The factor of a product's primary unit, from the units the screen already loaded. */
export function primaryFactorOf(
  units: ReadonlyArray<{ id: number; factor_milli?: number | null }> | null | undefined,
  primaryUnitId?: number | null,
  fallbackUnitId?: number | null,
): number {
  const id = primaryUnitId ?? fallbackUnitId ?? null;
  const unit = (units ?? []).find((u) => u.id === id);
  return unitFactor(unit?.factor_milli);
}
