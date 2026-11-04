/**
 * Shop events → UI refresh (v1.1.4 Phase 3, Milestone D follow-up).
 *
 * The Main PC's event stream is a *hint*. It never carries data the UI renders: it says
 * "something of this kind changed", and the affected screen refetches through the normal
 * routes (which run on the Main PC and re-check permissions). That keeps a single source
 * of truth, so a withheld, duplicated or missed event can never corrupt what is shown —
 * at worst a refresh is skipped and the next one catches up.
 *
 * Rules encoded here:
 *  - every event type maps to the screens/queries it actually invalidates;
 *  - a duplicate or out-of-order id is ignored (a reconnect replays the last block);
 *  - a burst is coalesced, so ten sales in a second cost one refresh per screen;
 *  - `resync` (truncated history, server restart) refreshes everything;
 *  - an unknown event type falls back to a full refresh rather than being ignored.
 */

export type ShopQueryKey =
  | 'dashboard'
  | 'sales'
  | 'products'
  | 'pos-catalog'
  | 'customers'
  | 'suppliers'
  | 'stock'
  | 'purchases'
  | 'reports'
  | 'accounting'
  | 'cash'
  | 'expenses'
  | 'devices'
  | 'license'
  | 'settings';

export interface RefreshPlan {
  keys: ShopQueryKey[];
  /** Refresh everything (unknown event type, resync, server restart). */
  full: boolean;
  reason: string;
}

const PLAN: Record<string, ShopQueryKey[]> = {
  'sale.created': ['dashboard', 'sales', 'stock', 'pos-catalog', 'reports', 'cash'],
  'sale.updated': ['dashboard', 'sales', 'stock', 'pos-catalog', 'reports', 'cash'],
  'sale.voided': ['dashboard', 'sales', 'stock', 'pos-catalog', 'reports', 'cash', 'accounting'],
  'sale.returned': ['dashboard', 'sales', 'stock', 'pos-catalog', 'reports', 'cash', 'accounting'],
  'payment.recorded': ['dashboard', 'sales', 'customers', 'cash', 'reports', 'accounting'],
  'customer.payment': ['dashboard', 'customers', 'cash', 'reports', 'accounting'],
  'customer.created': ['customers', 'dashboard'],
  'customer.updated': ['customers', 'sales', 'dashboard'],
  'customer.deleted': ['customers', 'sales', 'dashboard'],
  'supplier.created': ['suppliers', 'dashboard'],
  'supplier.updated': ['suppliers', 'purchases', 'dashboard'],
  'purchase.created': ['purchases', 'stock', 'products', 'suppliers', 'reports', 'accounting', 'dashboard'],
  'purchase.received': ['purchases', 'stock', 'products', 'pos-catalog', 'dashboard'],
  'purchase.returned': ['purchases', 'stock', 'products', 'suppliers', 'accounting'],
  'stock.changed': ['stock', 'products', 'pos-catalog', 'dashboard', 'reports'],
  'stock.adjusted': ['stock', 'products', 'pos-catalog', 'dashboard', 'reports'],
  'stock.transferred': ['stock', 'products', 'dashboard'],
  'stock.counted': ['stock', 'products', 'pos-catalog', 'reports'],
  'inventory.updated': ['stock', 'products', 'pos-catalog', 'dashboard'],
  'inventory.valuation_changed': ['stock', 'reports', 'accounting'],
  'product.created': ['products', 'pos-catalog', 'stock'],
  'product.updated': ['products', 'pos-catalog', 'stock', 'sales'],
  'product.price_changed': ['products', 'pos-catalog', 'sales'],
  'product.deleted': ['products', 'pos-catalog', 'stock', 'sales'],
  'price.changed': ['products', 'pos-catalog', 'sales'],
  'expense.created': ['expenses', 'cash', 'reports', 'accounting', 'dashboard'],
  'expense.updated': ['expenses', 'cash', 'reports', 'accounting', 'dashboard'],
  'cash.opened': ['cash', 'dashboard', 'reports'],
  'cash.closed': ['cash', 'dashboard', 'reports', 'accounting'],
  'accounting.entry_posted': ['accounting', 'reports', 'dashboard'],
  'accounting.period_closed': ['accounting', 'reports'],
  'settings.updated': ['settings', 'pos-catalog', 'reports', 'dashboard'],
  'device.connected': ['devices', 'settings'],
  'device.disconnected': ['devices', 'settings'],
  'device.approved': ['devices', 'settings'],
  'device.revoked': ['devices', 'settings', 'license'],
  'device.pending': ['devices', 'settings'],
  'license.status_changed': ['license', 'settings', 'devices'],
  'server.maintenance': ['settings', 'devices'],
};

/** Which screens a single event must refresh. */
export function planForEvent(type: string | undefined): RefreshPlan {
  const name = (type ?? '').trim();
  if (!name) return { keys: [], full: true, reason: 'UNKNOWN_EVENT' };
  const exact = PLAN[name];
  if (exact) return { keys: [...exact], full: false, reason: name };
  // Prefix families (`sale.` covers a new sale action without a code change here).
  const family = name.split('.')[0] ?? '';
  const familyKeys = Object.entries(PLAN)
    .filter(([key]) => key.startsWith(`${family}.`))
    .flatMap(([, keys]) => keys);
  if (familyKeys.length) return { keys: [...new Set(familyKeys)], full: false, reason: `${family}.*` };
  return { keys: [], full: true, reason: 'UNKNOWN_EVENT' };
}

export interface ShopEventLike {
  kind: 'event' | 'state' | 'resync';
  id?: number;
  type?: string;
  state?: string;
  from?: number;
}

export interface RegistryOptions {
  /** Coalesce bursts within this window. */
  debounceMs?: number;
  /** Called when a refresher throws (never rethrown). */
  onError?: (key: ShopQueryKey, error: unknown) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * Holds the registered refreshers and decides when they run. Deliberately keeps no
 * event payload: refreshers are called with no arguments, so an event can never become
 * a data source for the UI.
 */
export class ShopQueryRegistry {
  private readonly refreshers = new Map<ShopQueryKey, Set<() => void>>();
  private readonly pending = new Set<ShopQueryKey>();
  private lastEventId = 0;
  private timer: unknown = null;
  private readonly debounceMs: number;
  private readonly onError?: (key: ShopQueryKey, error: unknown) => void;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (handle: unknown) => void;
  readonly applied = new Map<ShopQueryKey, number>();
  appliedFullRefreshes = 0;
  ignoredDuplicates = 0;

  constructor(opts: RegistryOptions = {}) {
    this.debounceMs = opts.debounceMs ?? 150;
    this.onError = opts.onError;
    this.setT = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
    this.clearT = opts.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Registers a screen's reload function; returns an unsubscribe. */
  register(key: ShopQueryKey, refresh: () => void): () => void {
    const set = this.refreshers.get(key) ?? new Set();
    set.add(refresh);
    this.refreshers.set(key, set);
    return () => {
      set.delete(refresh);
      if (!set.size) this.refreshers.delete(key);
    };
  }

  registeredKeys(): ShopQueryKey[] {
    return [...this.refreshers.keys()];
  }

  private schedule(keys: Iterable<ShopQueryKey>): void {
    for (const key of keys) {
      if (this.refreshers.has(key)) this.pending.add(key);
    }
    if (!this.pending.size) return;
    if (this.timer !== null) return;
    this.timer = this.setT(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
  }

  /** Runs every queued refresh exactly once. */
  flush(): void {
    const keys = [...this.pending];
    this.pending.clear();
    for (const key of keys) {
      const set = this.refreshers.get(key);
      if (!set) continue;
      for (const refresh of [...set]) {
        try {
          refresh();
        } catch (err) {
          // A failing screen must not stop the others from refreshing.
          this.onError?.(key, err);
        }
      }
      this.applied.set(key, (this.applied.get(key) ?? 0) + 1);
    }
  }

  /** Feeds one event from the stream. */
  handle(event: ShopEventLike): RefreshPlan | null {
    if (event.kind === 'state') return null; // connection state only
    if (event.kind === 'resync') {
      this.appliedFullRefreshes += 1;
      const keys = [...this.refreshers.keys()];
      this.schedule(keys);
      return { keys, full: true, reason: 'RESYNC' };
    }
    const id = Number(event.id ?? 0);
    if (id && id <= this.lastEventId) {
      this.ignoredDuplicates += 1;
      return null;
    }
    if (id) this.lastEventId = id;
    const plan = planForEvent(event.type);
    if (plan.full) {
      this.appliedFullRefreshes += 1;
      const keys = [...this.refreshers.keys()];
      this.schedule(keys);
      return { ...plan, keys };
    }
    this.schedule(plan.keys);
    return plan;
  }

  get lastId(): number {
    return this.lastEventId;
  }

  reset(): void {
    this.pending.clear();
    if (this.timer !== null) this.clearT(this.timer);
    this.timer = null;
    this.lastEventId = 0;
  }
}

/** One registry for the running renderer. */
export const shopQueries = new ShopQueryRegistry();
