// @vitest-environment jsdom
/**
 * Effect dependencies, checked as behaviour (v1.1.5, audit finding A-10).
 *
 * The audit counted 29 `react-hooks` suppressions in the renderer. They were all one shape: a
 * `load()` defined in the component body, called from an effect whose dependency array listed the
 * *filters* rather than the function. The arrays happened to be right, but nothing enforced that,
 * and the rule was switched off — so the next filter added to a query would silently not reload.
 *
 * The fix makes each loader a `useCallback` over its real inputs and lets the effect depend on it.
 * That is only safe if it does not cause a loop, so these tests assert the exact number of loads:
 *
 *  - once on mount,
 *  - once more when an input changes,
 *  - and never again for a re-render that changes nothing the query reads.
 *
 * They also cover the one place where the old dependency array hid a real bug: POS read
 * `settings.default_customer_id` inside a mount-only effect, so a shop default that arrived after
 * the screen mounted was never applied.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UIProvider } from '../src/ui.js';

const call = vi.fn();
vi.mock('../src/api.js', () => ({
  call: (...args: unknown[]) => call(...args),
}));

afterEach(() => {
  cleanup();
  call.mockReset();
});

const emptyPage = { rows: [], total: 0 };

function routes(overrides: Record<string, unknown> = {}) {
  call.mockImplementation(async (route: string) => {
    if (route in overrides) {
      const v = overrides[route];
      return typeof v === 'function' ? (v as () => unknown)() : v;
    }
    if (route === 'settings.categories' || route === 'settings.units' || route === 'settings.paymentMethods') return [];
    if (route === 'pos.quickPicks' || route === 'pos.held') return [];
    if (route === 'cash.current') return null;
    if (route.endsWith('.list')) return emptyPage;
    return null;
  });
}

const loads = (route: string) => call.mock.calls.filter(([r]) => r === route).length;

async function renderSales() {
  const { SalesPage } = await import('../src/pages/Sales.js');
  return render(
    <UIProvider>
      <SalesPage can={() => true} settings={null} navigate={() => undefined} />
    </UIProvider>,
  );
}

describe('a list screen loads once per real input change', () => {
  it('loads once on mount, again on a filter change, and not on an unrelated re-render', async () => {
    routes();
    await renderSales();

    await waitFor(() => expect(loads('sales.list')).toBe(1));
    // Give the settle (setState → re-render) a chance to trigger a loop if the deps were wrong.
    await waitFor(() => expect(loads('sales.list')).toBe(1));

    const search = screen.getByPlaceholderText('ইনভয়েস নম্বর বা কাস্টমার') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'চাল' } });
    await waitFor(() => expect(loads('sales.list')).toBe(2));

    // A second, unrelated keystroke changes state but not the query, so it must not reload.
    fireEvent.change(search, { target: { value: 'চাল' } });
    await waitFor(() => expect(loads('sales.list')).toBe(2));
  });
});

describe('POS applies the shop default customer even when settings arrive late', () => {
  it('selects the configured default customer after the settings prop is filled in', async () => {
    const customer = { id: 7, name: 'করিম সাহাব', balance_paisa: 0, is_walkin: 0 };
    const walkIn = { id: 1, name: 'সাধারণ ক্রেতা', balance_paisa: 0, is_walkin: 1 };
    routes({ 'customers.list': { rows: [walkIn, customer] } });

    const { POSPage } = await import('../src/pages/POS.js');
    const ui = (settings: any) => (
      <UIProvider>
        <POSPage settings={settings} can={() => true} navigate={() => undefined} onSettingsChanged={async () => undefined} />
      </UIProvider>
    );
    const view = render(ui(null));
    await waitFor(() => expect(loads('customers.list')).toBe(1));
    const customerSelect = () =>
      (screen.getAllByRole('combobox') as HTMLSelectElement[]).find((el) =>
        [...el.options].some((o) => o.textContent?.includes('করিম সাহাব')),
      )!;
    // With no settings, the walk-in customer is the sensible default.
    await waitFor(() => expect(customerSelect().value).toBe('1'));

    view.rerender(ui({ default_customer_id: 7 } as any));
    await waitFor(() => expect(customerSelect().value).toBe('7'));
    // The reference data was not re-fetched by the settings arriving.
    expect(loads('customers.list')).toBe(1);
  });
});

describe('POS keyboard shortcuts act on the current cart', () => {
  it('ignores F8 while the cart is empty and opens payment once it has a line', async () => {
    const product = {
      id: 3,
      name: 'মিনিকেট চাল',
      unit_id: 1,
      primary_unit_id: 1,
      sale_price_paisa: 8000,
      purchase_price_paisa: 7000,
      stock_base_milli: 100_000,
      is_active: 1,
      tracks_serials: 0,
      min_sale_price_paisa: null,
      category_id: null,
      sku: 'RICE-01',
    };
    routes({
      'customers.list': { rows: [{ id: 1, name: 'সাধারণ ক্রেতা', balance_paisa: 0, is_walkin: 1 }] },
      'products.list': { rows: [product], total: 1 },
      'loyalty.summary': { points: 0, value_paisa: 0 },
      'pos.compute': { lines: [], subtotal_paisa: 8000, discount_paisa: 0, tax_paisa: 0, total_paisa: 8000, due_paisa: 0, change_paisa: 0, profit_paisa: 1000 },
    });

    const { POSPage } = await import('../src/pages/POS.js');
    render(
      <UIProvider>
        <POSPage settings={null} can={() => true} navigate={() => undefined} onSettingsChanged={async () => undefined} />
      </UIProvider>,
    );
    await waitFor(() => expect(loads('products.list')).toBe(1));

    // Empty cart: the shortcut must do nothing at all.
    fireEvent.keyDown(window, { key: 'F8' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getAllByText('মিনিকেট চাল')[0]!);
    await waitFor(() => expect(loads('pos.compute')).toBeGreaterThan(0));
    fireEvent.keyDown(window, { key: 'F8' });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
  });
});
