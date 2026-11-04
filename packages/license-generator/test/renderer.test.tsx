/**
 * Renderer smoke test — the License Generator's React shell must render.
 *
 * This is server-side rendering: no Electron, no DOM, no display. It proves that
 * every page module loads, receives the props/context it declares, and paints its
 * initial state without throwing. Effects do not run here, so it is not a
 * substitute for the Windows installer test — it is the cheap gate that catches a
 * broken import, a missing icon or a component that explodes on first paint.
 */
import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

/* The renderer reads `window.licgen` at module scope to detect the host. */
beforeAll(() => {
  const bridge = {
    invoke: async () => ({}),
    platform: 'win32',
    versions: { electron: '38.8.6', node: '22.19.0' },
  };
  const globals = globalThis as unknown as {
    window?: Record<string, unknown>;
    document?: Record<string, unknown>;
  };
  globals.window = {
    licgen: bridge,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    location: { search: '' },
  };
  globals.document = {
    documentElement: { setAttribute: () => undefined, style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getElementById: () => null,
  };
});

async function renderPage(element: ReactElement) {
  const { AppContext, makeAppContext } = await import('../renderer-src/App.js');
  const { UIProvider } = await import('../renderer-src/ui.js');
  return renderToString(
    <UIProvider>
      <AppContext.Provider value={makeAppContext()}>{element}</AppContext.Provider>
    </UIProvider>,
  );
}

const KEY_STATUS = { loaded: true, keyId: 'K-TEST', publicKeyB64: 'AAAA', path: 'C:/keys/private.pem' };

describe('license generator renderer', () => {
  it('renders the application shell with its navigation, search and key pill', async () => {
    const { default: App } = await import('../renderer-src/App.js');
    const html = renderToString(<App />);
    expect(html).toContain('class="shell"');
    for (const label of ['ওভারভিউ', 'কাস্টমার', 'লাইসেন্স তালিকা', 'রিপোর্ট', 'সিকিউরিটি', 'ব্যাকআপ', 'সেটিংস']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('aria-label="প্রধান মেনু"');
    expect(html).toContain('id="global-search"'); // Ctrl+K target exists
    // No key loaded in a fresh shell — the pill must say so instead of pretending.
    expect(html).toContain('কী নেই');
  });

  it('loads all twelve page modules', async () => {
    const pages = await Promise.all([
      import('../renderer-src/pages/Dashboard.js'),
      import('../renderer-src/pages/Customers.js'),
      import('../renderer-src/pages/Licenses.js'),
      import('../renderer-src/pages/Generate.js'),
      import('../renderer-src/pages/Verify.js'),
      import('../renderer-src/pages/Reissue.js'),
      import('../renderer-src/pages/Revocations.js'),
      import('../renderer-src/pages/Activity.js'),
      import('../renderer-src/pages/Reports.js'),
      import('../renderer-src/pages/Security.js'),
      import('../renderer-src/pages/Backup.js'),
      import('../renderer-src/pages/Settings.js'),
    ]);
    expect(pages).toHaveLength(12);
    for (const mod of pages) {
      expect(Object.values(mod).some((value) => typeof value === 'function')).toBe(true);
    }
  });

  it('paints every page without throwing', async () => {
    const mods = {
      Dashboard: (await import('../renderer-src/pages/Dashboard.js')).DashboardPage,
      Customers: (await import('../renderer-src/pages/Customers.js')).CustomersPage,
      Licenses: (await import('../renderer-src/pages/Licenses.js')).LicensesPage,
      Generate: (await import('../renderer-src/pages/Generate.js')).GeneratePage,
      Verify: (await import('../renderer-src/pages/Verify.js')).VerifyPage,
      Reissue: (await import('../renderer-src/pages/Reissue.js')).ReissuePage,
      Revocations: (await import('../renderer-src/pages/Revocations.js')).RevocationsPage,
      Activity: (await import('../renderer-src/pages/Activity.js')).ActivityPage,
      Reports: (await import('../renderer-src/pages/Reports.js')).ReportsPage,
      Security: (await import('../renderer-src/pages/Security.js')).SecurityPage,
      Backup: (await import('../renderer-src/pages/Backup.js')).BackupPage,
      Settings: (await import('../renderer-src/pages/Settings.js')).SettingsPage,
    };
    for (const [name, Page] of Object.entries(mods)) {
      const html = await renderPage(<Page />);
      expect(html.length, `${name} rendered nothing`).toBeGreaterThan(50);
      expect(html, `${name} leaked a raw error string`).not.toContain('App context missing');
    }
  });

  it('never renders private-key material in the security screen', async () => {
    const { SecurityPage } = await import('../renderer-src/pages/Security.js');
    const html = await renderPage(<SecurityPage />);
    expect(html).not.toMatch(/BEGIN (RSA |)PRIVATE KEY/);
    expect(html).not.toMatch(/pkcs8/i);
    // With a key loaded it shows the *public* half and the key id only.
    const { AppContext, makeAppContext } = await import('../renderer-src/App.js');
    const { UIProvider } = await import('../renderer-src/ui.js');
    const loaded = renderToString(
      <UIProvider>
        <AppContext.Provider value={makeAppContext({ keyStatus: KEY_STATUS as never })}>
          <SecurityPage />
        </AppContext.Provider>
      </UIProvider>,
    );
    expect(loaded).toContain('K-TEST');
    expect(loaded).not.toMatch(/BEGIN .*PRIVATE KEY/);
  });

  it('unlocks the wizard only when a signing key is loaded', async () => {
    const { GeneratePage } = await import('../renderer-src/pages/Generate.js');
    const locked = await renderPage(<GeneratePage />);
    expect(locked).toContain('সাইনিং কী লোড নেই');
    expect(locked).toContain('ধাপ ১ —');
    const { AppContext, makeAppContext } = await import('../renderer-src/App.js');
    const { UIProvider } = await import('../renderer-src/ui.js');
    const unlocked = renderToString(
      <UIProvider>
        <AppContext.Provider value={makeAppContext({ keyStatus: KEY_STATUS as never })}>
          <GeneratePage />
        </AppContext.Provider>
      </UIProvider>,
    );
    expect(unlocked).toContain('ধাপ ১ —'); // step tracker visible
    expect(unlocked).not.toContain('সাইনিং কী লোড নেই');
  });
});
