import type { Permission } from '../services/auth.js';

/**
 * Which permission is required to see an event (Phase 3, Milestone D).
 *
 * A device belonging to the shop is not the same as a user allowed to see the data in
 * an event. The store filter already stops cross-store leakage; this table stops
 * *cross-role* leakage inside one store — for example a cashier terminal must not
 * learn about cost/profit/licence movements just because it is paired.
 *
 * Rules are deliberately conservative: an event type with no entry is visible to any
 * signed-in user of that store (sale, product, customer, stock and device presence),
 * and anything financial, accounting or licence related needs `report.view` or
 * `settings.manage`. Actions on event data still go through `/api/v1/rpc`, where the
 * full permission table applies — the event stream is a hint, never an authority.
 */

const REPORT: Permission = 'report.view';
const SETTINGS: Permission = 'settings.manage';

const REQUIRED: Record<string, Permission[]> = {
  'license.status_changed': [SETTINGS],
  'server.maintenance': [SETTINGS],
  'device.connected': [SETTINGS],
  'device.disconnected': [SETTINGS],
  'accounting.entry_posted': [REPORT],
  'accounting.period_closed': [REPORT],
  'sale.cost_updated': [REPORT],
  'inventory.valuation_changed': [REPORT],
};

/** Permissions that see everything (shop owner/manager). */
const FULL_VISIBILITY: Permission[] = [SETTINGS];

export function eventPermissions(type: string): Permission[] {
  if (REQUIRED[type]) return REQUIRED[type]!;
  if (type.startsWith('accounting.')) return [REPORT];
  if (type.startsWith('report.')) return [REPORT];
  if (type.startsWith('license.')) return [SETTINGS];
  return [];
}

/** True when a user with `permissions` may receive this event type. */
export function canReceiveEvent(type: string, permissions: readonly string[]): boolean {
  if (permissions.some((p) => FULL_VISIBILITY.includes(p as Permission))) return true;
  const required = eventPermissions(type);
  if (!required.length) return true;
  return required.some((p) => permissions.includes(p));
}
