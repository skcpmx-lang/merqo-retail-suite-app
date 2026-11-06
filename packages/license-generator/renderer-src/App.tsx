import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { call } from './api.js';
import { Icon, UIProvider, useUI, type IconName } from './ui.js';
import type { Catalog, KeyStatus } from './types.js';
import { DashboardPage } from './pages/Dashboard.js';
import { CustomersPage } from './pages/Customers.js';
import { LicensesPage } from './pages/Licenses.js';
import { GeneratePage } from './pages/Generate.js';
import { VerifyPage } from './pages/Verify.js';
import { ReissuePage } from './pages/Reissue.js';
import { RevocationsPage } from './pages/Revocations.js';
import { ActivityPage } from './pages/Activity.js';
import { ReportsPage } from './pages/Reports.js';
import { SecurityPage } from './pages/Security.js';
import { BackupPage } from './pages/Backup.js';
import { SettingsPage } from './pages/Settings.js';

export type PageId =
  | 'dashboard'
  | 'customers'
  | 'licenses'
  | 'generate'
  | 'verify'
  | 'reissue'
  | 'revocations'
  | 'activity'
  | 'reports'
  | 'security'
  | 'backup'
  | 'settings';

interface NavItem {
  id: PageId;
  label: string;
  icon: IconName;
  group: string;
}

const NAV: NavItem[] = [
  { id: 'dashboard', label: 'ওভারভিউ', icon: 'dashboard', group: 'প্রধান' },
  { id: 'customers', label: 'কাস্টমার', icon: 'users', group: 'লাইসেন্সিং' },
  { id: 'licenses', label: 'লাইসেন্স তালিকা', icon: 'license', group: 'লাইসেন্সিং' },
  { id: 'generate', label: 'নতুন লাইসেন্স', icon: 'plus', group: 'লাইসেন্সিং' },
  { id: 'reissue', label: 'রি-ইস্যু', icon: 'refresh', group: 'লাইসেন্সিং' },
  { id: 'revocations', label: 'প্রত্যাহার', icon: 'alert', group: 'লাইসেন্সিং' },
  { id: 'verify', label: 'যাচাই', icon: 'check', group: 'লাইসেন্সিং' },
  { id: 'reports', label: 'রিপোর্ট', icon: 'chart', group: 'প্রশাসন' },
  { id: 'activity', label: 'অ্যাক্টিভিটি', icon: 'clock', group: 'প্রশাসন' },
  { id: 'security', label: 'সিকিউরিটি ও কী', icon: 'shield', group: 'প্রশাসন' },
  { id: 'backup', label: 'ব্যাকআপ', icon: 'database', group: 'প্রশাসন' },
  { id: 'settings', label: 'সেটিংস', icon: 'settings', group: 'প্রশাসন' },
];

export interface AppCtx {
  keyStatus: KeyStatus;
  catalog: Catalog | null;
  info: { generatorVersion: string; appVersion: string; platform: string; storePath: string; ledgerPath: string } | null;
  refreshKey: () => Promise<void>;
  refreshInfo: () => Promise<void>;
  navigate: (page: PageId, params?: Record<string, unknown>) => void;
  params: Record<string, unknown> | null;
  theme: 'light' | 'dark';
  setTheme: (theme: 'light' | 'dark') => Promise<void>;
  loading: boolean;
}

const Ctx = createContext<AppCtx | null>(null);

/** Test hook: lets the render smoke test mount a page with a fixed context. */
export const AppContext = Ctx;

/** The real host context for a signed-in operator, used by previews and tests. */
export function makeAppContext(overrides: Partial<AppCtx> = {}): AppCtx {
  return {
    keyStatus: { loaded: false },
    catalog: null,
    info: null,
    refreshKey: async () => undefined,
    refreshInfo: async () => undefined,
    navigate: () => undefined,
    params: null,
    theme: 'light',
    setTheme: async () => undefined,
    loading: false,
    ...overrides,
  };
}

export function useApp(): AppCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('App context missing');
  return ctx;
}

export default function App() {
  return (
    <UIProvider>
      <Shell />
    </UIProvider>
  );
}

function Shell() {
  const ui = useUI();
  const [page, setPage] = useState<PageId>('dashboard');
  const [params, setParams] = useState<Record<string, unknown> | null>(null);
  const [keyStatus, setKeyStatus] = useState<KeyStatus>({ loaded: false });
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [info, setInfo] = useState<AppCtx['info']>(null);
  const [theme, setThemeState] = useState<'light' | 'dark'>('light');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const refreshKey = useCallback(async () => {
    const status = await call<KeyStatus>('key.status');
    setKeyStatus(status);
  }, []);

  const refreshInfo = useCallback(async () => {
    const data = await call<NonNullable<AppCtx['info']>>('app.info');
    setInfo(data);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [status, cat, settings] = await Promise.all([
          call<KeyStatus>('key.status'),
          call<Catalog>('meta.catalog'),
          call<{ theme: 'light' | 'dark' }>('settings.get'),
        ]);
        setKeyStatus(status);
        setCatalog(cat);
        setThemeState(settings.theme === 'dark' ? 'dark' : 'light');
        await refreshInfo();
      } catch (err) {
        ui.error('শুরু করা যায়নি', (err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshInfo, ui]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const setTheme = useCallback(async (next: 'light' | 'dark') => {
    setThemeState(next);
    try {
      await call('settings.update', { theme: next });
    } catch (err) {
      ui.error('থিম সংরক্ষণ ব্যর্থ', (err as Error).message);
    }
  }, [ui]);

  const navigate = useCallback((next: PageId, nextParams?: Record<string, unknown>) => {
    setPage(next);
    setParams(nextParams ?? null);
    setSearch('');
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.getElementById('global-search')?.focus();
      }
      if (e.key === 'Escape') setSearch('');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const ctx = useMemo<AppCtx>(
    () => ({ keyStatus, catalog, info, refreshKey, refreshInfo, navigate, params, theme, setTheme, loading }),
    [keyStatus, catalog, info, refreshKey, refreshInfo, navigate, params, theme, setTheme, loading],
  );

  const groups = useMemo(() => {
    const map = new Map<string, NavItem[]>();
    for (const item of NAV) {
      if (!map.has(item.group)) map.set(item.group, []);
      map.get(item.group)!.push(item);
    }
    return [...map.entries()];
  }, []);

  const title = NAV.find((n) => n.id === page)?.label ?? 'ওভারভিউ';

  return (
    <Ctx.Provider value={ctx}>
      <div className="shell">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <div className="brand-mark">S</div>
            <div>
              <div className="brand-title">সাউদা লাইসেন্স</div>
              <div className="brand-sub">MERQO • প্রশাসনিক কনসোল</div>
            </div>
          </div>
          <nav className="nav-scroll" aria-label="প্রধান মেনু">
            {groups.map(([group, items]) => (
              <div key={group}>
                <div className="nav-group">{group}</div>
                {items.map((item) => (
                  <button
                    key={item.id}
                    className={`nav-item ${page === item.id ? 'active' : ''}`}
                    onClick={() => navigate(item.id)}
                    aria-current={page === item.id ? 'page' : undefined}
                  >
                    <Icon name={item.icon} size={16} />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="sidebar-foot">
            <div className="key-dot">
              <span className={`dot ${keyStatus.loaded ? 'ok' : ''}`} />
              {keyStatus.loaded ? `কী লোড: ${keyStatus.keyId}` : 'সাইনিং কী লোড হয়নি'}
            </div>
            <div style={{ marginTop: 4 }}>v{info?.generatorVersion ?? '1.1.3'}</div>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <div className="topbar-title">
              <strong>{title}</strong>
              <span>Sauda License Generator • অফলাইন স্বাক্ষর (Ed25519)</span>
            </div>
            <div className="grow" />
            <div className="topbar-search">
              <span className="icon">
                <Icon name="search" size={15} />
              </span>
              <input
                id="global-search"
                className="input"
                value={search}
                placeholder="কাস্টমার / লাইসেন্স খুঁজুন (Ctrl+K)"
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && search.trim()) navigate('licenses', { q: search.trim() });
                }}
              />
            </div>
            <button
              className="icon-btn"
              title={theme === 'dark' ? 'লাইট থিম' : 'ডার্ক থিম'}
              onClick={() => void setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
            </button>
            {!keyStatus.loaded ? (
              <span className="pill amber" title="লাইসেন্স ইস্যু করতে সাইনিং কী দরকার">
                কী নেই
              </span>
            ) : (
              <span className="pill green">সাইনিং প্রস্তুত</span>
            )}
          </header>

          <main className="content">
            <div className="content-inner">
              {loading || !info ? (
                <div style={{ padding: 60, textAlign: 'center' }} className="muted">
                  লোড হচ্ছে…
                </div>
              ) : (
                <>
                  {page === 'dashboard' ? <DashboardPage /> : null}
                  {page === 'customers' ? <CustomersPage initialQ={String(params?.q ?? '')} /> : null}
                  {page === 'licenses' ? (
                    <LicensesPage initialQ={String(params?.q ?? '')} initialState={(params?.state as string) ?? 'all'} />
                  ) : null}
                  {page === 'generate' ? <GeneratePage presetCustomerId={(params?.customerId as string) ?? null} /> : null}
                  {page === 'verify' ? <VerifyPage /> : null}
                  {page === 'reissue' ? <ReissuePage presetLicenseId={(params?.licenseId as string) ?? null} /> : null}
                  {page === 'revocations' ? <RevocationsPage /> : null}
                  {page === 'activity' ? <ActivityPage /> : null}
                  {page === 'reports' ? <ReportsPage /> : null}
                  {page === 'security' ? <SecurityPage /> : null}
                  {page === 'backup' ? <BackupPage /> : null}
                  {page === 'settings' ? <SettingsPage /> : null}
                </>
              )}
            </div>
          </main>
        </div>
      </div>
    </Ctx.Provider>
  );
}
