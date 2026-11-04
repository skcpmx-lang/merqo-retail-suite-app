/**
 * v1.1.4 Phase 3 — SSE-driven UI refresh (renderer layer).
 *
 * These exercise the module the renderer actually uses to decide *which screens reload*.
 * Refreshers are stand-ins for a screen's `load()`; the assertions are about refresh
 * behaviour (correct keys, no duplicates, full refresh on resync), never about payload
 * data — the UI must never render an event payload as business data.
 */
import { describe, expect, it, vi } from 'vitest';
import { ShopQueryRegistry, planForEvent } from '../src/lib/shop-events.js';

function makeRegistry() {
  const timers: Array<() => void> = [];
  const registry = new ShopQueryRegistry({
    debounceMs: 10,
    setTimeoutFn: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeoutFn: () => undefined,
  });
  return {
    registry,
    tick: () => {
      const run = timers.splice(0);
      for (const fn of run) fn();
    },
  };
}

function register(registry: ShopQueryRegistry, keys: string[]) {
  const calls: Record<string, number> = {};
  for (const key of keys) {
    calls[key] = 0;
    registry.register(key as never, () => {
      calls[key] += 1;
    });
  }
  return calls;
}

describe('event → query plan', () => {
  it('maps a sale to sales, stock, POS and reports', () => {
    const plan = planForEvent('sale.created');
    expect(plan.full).toBe(false);
    expect(plan.keys).toEqual(expect.arrayContaining(['sales', 'dashboard', 'stock', 'pos-catalog', 'reports']));
  });

  it('maps stock and price changes to the POS catalogue', () => {
    for (const type of ['stock.changed', 'stock.adjusted', 'inventory.updated']) {
      expect(planForEvent(type).keys).toEqual(expect.arrayContaining(['stock', 'products', 'pos-catalog']));
    }
    for (const type of ['product.price_changed', 'price.changed', 'product.updated']) {
      expect(planForEvent(type).keys).toEqual(expect.arrayContaining(['products', 'pos-catalog']));
    }
  });

  it('maps customer and payment changes to the ledger screens', () => {
    expect(planForEvent('customer.updated').keys).toContain('customers');
    const pay = planForEvent('payment.recorded').keys;
    expect(pay).toEqual(expect.arrayContaining(['customers', 'sales', 'cash', 'reports']));
  });

  it('maps licence and device changes to the admin screens', () => {
    expect(planForEvent('license.status_changed').keys).toEqual(expect.arrayContaining(['license', 'devices']));
    expect(planForEvent('device.revoked').keys).toEqual(expect.arrayContaining(['devices', 'license']));
    expect(planForEvent('device.approved').keys).toContain('devices');
  });

  it('maps purchases, expenses, cash and accounting to their screens', () => {
    expect(planForEvent('purchase.received').keys).toEqual(
      expect.arrayContaining(['purchases', 'stock', 'products', 'pos-catalog']),
    );
    expect(planForEvent('expense.created').keys).toEqual(expect.arrayContaining(['expenses', 'cash', 'reports']));
    expect(planForEvent('cash.closed').keys).toEqual(expect.arrayContaining(['cash', 'accounting', 'reports']));
    expect(planForEvent('accounting.entry_posted').keys).toEqual(expect.arrayContaining(['accounting', 'reports']));
    expect(planForEvent('settings.updated').keys).toEqual(expect.arrayContaining(['settings', 'pos-catalog']));
  });

  it('falls back to a full refresh for an unknown event type', () => {
    const plan = planForEvent('something.new');
    expect(plan.full).toBe(true);
    expect(plan.reason).toBe('UNKNOWN_EVENT');
  });

  it('recognises a new action inside a known family', () => {
    const plan = planForEvent('sale.parked');
    expect(plan.full).toBe(false);
    expect(plan.keys).toContain('sales');
  });
});

describe('registry behaviour', () => {
  it('refreshes only the screens the event touches', () => {
    const { registry, tick } = makeRegistry();
    const calls = register(registry, ['dashboard', 'sales', 'stock', 'pos-catalog', 'reports', 'customers', 'devices']);
    registry.handle({ kind: 'event', id: 1, type: 'sale.created' });
    tick();
    expect(calls.sales).toBe(1);
    expect(calls.stock).toBe(1);
    expect(calls.customers).toBe(0);
    expect(calls.devices).toBe(0);
  });

  it('coalesces a burst into one refresh per screen', () => {
    const { registry, tick } = makeRegistry();
    const calls = register(registry, ['dashboard', 'sales', 'stock']);
    for (let id = 1; id <= 5; id += 1) registry.handle({ kind: 'event', id, type: 'sale.created' });
    tick();
    expect(calls.sales).toBe(1);
    expect(calls.dashboard).toBe(1);
    expect(calls.stock).toBe(1);
  });

  it('ignores duplicate and out-of-order event ids', () => {
    const { registry, tick } = makeRegistry();
    const calls = register(registry, ['sales']);
    registry.handle({ kind: 'event', id: 7, type: 'sale.created' });
    tick();
    registry.handle({ kind: 'event', id: 7, type: 'sale.created' });
    registry.handle({ kind: 'event', id: 6, type: 'sale.created' });
    tick();
    expect(calls.sales).toBe(1);
    expect(registry.ignoredDuplicates).toBe(2);
    expect(registry.lastId).toBe(7);
  });

  it('refreshes everything once on resync', () => {
    const { registry, tick } = makeRegistry();
    const calls = register(registry, ['dashboard', 'sales', 'customers', 'license']);
    registry.handle({ kind: 'resync', from: 120 });
    registry.handle({ kind: 'resync', from: 121 });
    tick();
    for (const key of Object.keys(calls)) expect(calls[key]).toBe(1);
    expect(registry.appliedFullRefreshes).toBe(2);
  });

  it('refreshes only the accounting screens for a journal event', () => {
    const { registry, tick } = makeRegistry();
    const calls = register(registry, ['accounting', 'reports', 'dashboard', 'pos-catalog', 'devices']);
    registry.handle({ kind: 'event', id: 11, type: 'accounting.entry_posted' });
    tick();
    expect(calls.accounting).toBe(1);
    expect(calls.reports).toBe(1);
    expect(calls.dashboard).toBe(1);
    expect(calls['pos-catalog']).toBe(0);
    expect(calls.devices).toBe(0);
  });

  it('keeps a resync full refresh bounded to mounted screens', () => {
    const { registry, tick } = makeRegistry();
    const calls = register(registry, ['purchases', 'expenses']);
    registry.handle({ kind: 'resync', from: 300 });
    tick();
    expect(calls.purchases).toBe(1);
    expect(calls.expenses).toBe(1);
    expect(registry.registeredKeys().sort()).toEqual(['expenses', 'purchases']);
  });

  it('does not refresh on connection-state changes', () => {
    const { registry, tick } = makeRegistry();
    const calls = register(registry, ['sales']);
    registry.handle({ kind: 'state', state: 'closed' });
    registry.handle({ kind: 'state', state: 'open' });
    tick();
    expect(calls.sales).toBe(0);
  });

  it('does not queue refreshes for screens that are not mounted', () => {
    const { registry, tick } = makeRegistry();
    const calls = register(registry, ['sales']);
    // An expense does not change the sales list, so an unmounted sales screen is idle.
    registry.handle({ kind: 'event', id: 1, type: 'expense.created' });
    tick();
    expect(calls.sales).toBe(0);
  });

  it('keeps refreshing other screens when one throws', () => {
    const onError = vi.fn();
    const registry = new ShopQueryRegistry({ debounceMs: 0, onError, setTimeoutFn: (fn) => (fn(), 1) });
    const sales = vi.fn();
    const dashboard = vi.fn();
    registry.register('sales', () => {
      throw new Error('load failed');
    });
    registry.register('dashboard', dashboard);
    registry.handle({ kind: 'event', id: 1, type: 'sale.created' });
    expect(sales).not.toThrow;
    expect(onError).toHaveBeenCalledWith('sales', expect.any(Error));
    expect(dashboard).toHaveBeenCalledTimes(1);
  });

  it('stops refreshing a screen after it unregisters', () => {
    const { registry, tick } = makeRegistry();
    const calls: Record<string, number> = {};
    const off = registry.register('sales', () => {
      calls.sales = (calls.sales ?? 0) + 1;
    });
    off();
    registry.handle({ kind: 'event', id: 1, type: 'sale.created' });
    tick();
    expect(calls.sales ?? 0).toBe(0);
    expect(registry.registeredKeys()).toEqual([]);
  });

  it('never passes event payload data to a refresher', () => {
    const { registry, tick } = makeRegistry();
    const received: unknown[] = [];
    registry.register('sales', (...args: unknown[]) => {
      received.push(args);
    });
    registry.handle({
      kind: 'event',
      id: 3,
      type: 'sale.created',
      // A payload must not reach the renderer's refresh path.
      ...({ data: { total: 999_999 } } as object),
    });
    tick();
    // Called with no arguments: the screen refetches through its own route.
    expect(received).toEqual([[]]);
  });
});
