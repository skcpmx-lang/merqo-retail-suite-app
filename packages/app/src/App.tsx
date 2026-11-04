import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, onEvent, onV1Event } from './api.js';
import { shopQueries } from './lib/shop-events.js';
import { Icon, SaudaLogo, type IconName } from './icons.js';
import { setFormatPrefs, initials, money, today } from './format.js';
import { UIProvider, useUI, EmptyState, Spinner, Button, Loading } from './ui.js';
import { useT, useLang, setLang, type Lang } from './i18n.js';
import { applyTheme, type ThemePref } from './theme.js';
import type { ActivationState, AppSettings, User } from './types.js';
import { ActivationPage } from './pages/Activation.js';
import { SetupPage } from './pages/Setup.js';
import { LoginPage } from './pages/Login.js';
import { DashboardPage } from './pages/Dashboard.js';
import { POSPage } from './pages/POS.js';
import { ProductsPage } from './pages/Products.js';
import { InventoryPage } from './pages/Inventory.js';
import { StockOpsPage } from './pages/StockOps.js';
import { AccountingPage } from './pages/Accounting.js';
import { PurchaseOrdersPage } from './pages/PurchaseOrders.js';
import { PurchasesPage } from './pages/Purchases.js';
import { SalesPage } from './pages/Sales.js';
import { ReturnsPage } from './pages/Returns.js';
import { CustomersPage, SuppliersPage } from './pages/Parties.js';
import { PromotionsPage } from './pages/Promotions.js';
import { ExpensesPage } from './pages/Expenses.js';
import { CashPage } from './pages/Cash.js';
import { ReportsPage } from './pages/Reports.js';
import { TeamPage } from './pages/Team.js';
import { SettingsPage } from './pages/Settings.js';
import { BackupPage } from './pages/Backup.js';
import { AboutPage } from './pages/About.js';
import { CustomerDisplayPage } from './pages/CustomerDisplay.js';

export type PageId =
  | 'dashboard'
  | 'pos'
  | 'products'
  | 'inventory'
  | 'stockops'
  | 'purchaseorders'
  | 'purchases'
  | 'sales'
  | 'returns'
  | 'customers'
  | 'suppliers'
  | 'promotions'
  | 'expenses'
  | 'cash'
  | 'accounting'
  | 'reports'
  | 'team'
  | 'settings'
  | 'backup'
  | 'about';

interface NavEntry {
  id: PageId;
  labelKey: string;
  icon: IconName;
  groupKey: string;
  perm?: string;
  shortcut?: string;
}

const NAV: NavEntry[] = [
  { id: 'dashboard', labelKey: 'nav.dashboard', icon: 'dashboard', groupKey: 'nav.group.main', shortcut: 'Ctrl+1' },
  { id: 'pos', labelKey: 'nav.pos', icon: 'pos', groupKey: 'nav.group.main', perm: 'pos.sell', shortcut: 'F2' },
  { id: 'sales', labelKey: 'nav.sales', icon: 'cart', groupKey: 'nav.group.main', perm: 'report.view', shortcut: 'Ctrl+2' },
  { id: 'products', labelKey: 'nav.products', icon: 'product', groupKey: 'nav.group.inventory', perm: 'product.view', shortcut: 'F3' },
  { id: 'inventory', labelKey: 'nav.inventory', icon: 'stock', groupKey: 'nav.group.inventory', perm: 'product.view' },
  { id: 'stockops', labelKey: 'nav.stockops', icon: 'box', groupKey: 'nav.group.inventory', perm: 'product.view' },
  { id: 'purchaseorders', labelKey: 'nav.purchaseorders', icon: 'file', groupKey: 'nav.group.inventory', perm: 'purchase.manage' },
  { id: 'purchases', labelKey: 'nav.purchases', icon: 'purchase', groupKey: 'nav.group.inventory', perm: 'purchase.manage', shortcut: 'F4' },
  { id: 'returns', labelKey: 'nav.returns', icon: 'return', groupKey: 'nav.group.inventory', perm: 'return.manage' },
  { id: 'customers', labelKey: 'nav.customers', icon: 'users', groupKey: 'nav.group.party', perm: 'customer.manage', shortcut: 'F5' },
  { id: 'suppliers', labelKey: 'nav.suppliers', icon: 'supplier', groupKey: 'nav.group.party', perm: 'supplier.manage' },
  { id: 'promotions', labelKey: 'nav.promotions', icon: 'tag', groupKey: 'nav.group.party', perm: 'pos.discount' },
  { id: 'expenses', labelKey: 'nav.expenses', icon: 'expense', groupKey: 'nav.group.account', perm: 'expense.manage' },
  { id: 'cash', labelKey: 'nav.cash', icon: 'cash', groupKey: 'nav.group.account', perm: 'cash.manage' },
  { id: 'accounting', labelKey: 'nav.accounting', icon: 'shield', groupKey: 'nav.group.account', perm: 'accounting.view' },
  { id: 'reports', labelKey: 'nav.reports', icon: 'report', groupKey: 'nav.group.account', perm: 'report.view', shortcut: 'F9' },
  { id: 'team', labelKey: 'nav.team', icon: 'clock', groupKey: 'nav.group.system', perm: 'report.view' },
  { id: 'settings', labelKey: 'nav.settings', icon: 'settings', groupKey: 'nav.group.system', perm: 'settings.manage' },
  { id: 'backup', labelKey: 'nav.backup', icon: 'backup', groupKey: 'nav.group.system', perm: 'backup.manage' },
  { id: 'about', labelKey: 'nav.about', icon: 'info', groupKey: 'nav.group.system' },
];

const PAGE_TITLE_KEYS: Record<PageId, string> = {
  dashboard: 'nav.dashboard',
  pos: 'pos.title',
  products: 'nav.products',
  stockops: 'nav.stockops',
  purchaseorders: 'po.title',
  accounting: 'nav.accounting',
  inventory: 'nav.inventory',
  purchases: 'nav.purchases',
  sales: 'nav.sales',
  returns: 'nav.returns',
  customers: 'nav.customers',
  suppliers: 'nav.suppliers',
  promotions: 'promo.title',
  expenses: 'nav.expenses',
  cash: 'nav.cash',
  reports: 'nav.reports',
  team: 'team.title',
  settings: 'nav.settings',
  backup: 'nav.backup',
  about: 'nav.about',
};

interface BootState {
  license: ActivationState | null;
  needsSetup: boolean;
  user: User | null;
  settings: AppSettings | null;
  error: string | null;
}

const isDisplayWindow = typeof window !== 'undefined' && window.location.hash.replace('#', '') === 'display';

export default function App() {
  // The customer-facing second screen is a separate BrowserWindow that loads
  // this same bundle with #display — it must not hit the licence/login gate.
  if (isDisplayWindow) return <CustomerDisplayPage />;
  return <MainApp />;
}

function MainApp() {
  const [boot, setBoot] = useState<BootState>({ license: null, needsSetup: true, user: null, settings: null, error: null });
  const [page, setPage] = useState<PageId>('dashboard');
  const [posNavKey, setPosNavKey] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const t = useT();
  const lang = useLang();

  const refreshBoot = useCallback(async () => {
    try {
      const license = await call<ActivationState>('license.state');
      let needsSetup = true;
      let settings: AppSettings | null = null;
      let user: User | null = null;
      if (license.activated) {
        const status = await call<{ needs_setup: boolean }>('setup.status');
        needsSetup = status.needs_setup;
        if (!needsSetup) {
          settings = await call<AppSettings>('settings.get');
          // The software lock can be switched off by the owner: in that case
          // the shell signs in the primary admin directly (permissions and the
          // licence gate still apply exactly as before).
          user = await call<User | null>('auth.bootstrap');
        }
      }
      setBoot((prev) => ({ ...prev, license, needsSetup, settings, user: user ?? prev.user, error: null }));
      if (settings) {
        setFormatPrefs({ symbol: settings.currency_symbol, bengaliDigits: settings.bengali_digits === 1 });
        applyTheme((settings.theme as ThemePref) ?? 'light');
        setLang((settings.language as Lang) ?? 'bn');
      }
    } catch (err) {
      setBoot((prev) => ({ ...prev, error: (err as Error).message }));
    }
  }, []);

  useEffect(() => {
    void refreshBoot();
  }, [refreshBoot, reloadKey]);

  useEffect(() => {
    const handler = () => void refreshBoot();
    window.addEventListener('sauda:license-required', handler);
    return () => window.removeEventListener('sauda:license-required', handler);
  }, [refreshBoot]);

  useEffect(() => {
    return onEvent((evt) => {
      if (evt.type === 'navigate' && evt.message) setPage(evt.message as PageId);
    });
  }, []);

  /**
   * Client mode: shop events from the Main PC. They are forwarded as a window event so
   * a page can refetch its own data (no page holds business logic of its own), and a
   * truncation/resync re-runs the boot check so licence/session state is revalidated.
   */
  useEffect(() => {
    return onV1Event((evt) => {
      // The registry decides which mounted screens reload; event payloads are never
      // rendered, every screen refetches through its own route.
      shopQueries.handle(evt);
      window.dispatchEvent(new CustomEvent('sauda:shop-event', { detail: evt }));
      if (evt.kind === 'resync' || (evt.kind === 'state' && evt.state === 'error')) void refreshBoot();
    });
  }, [refreshBoot]);

  const navigate = useCallback((next: PageId) => {
    setPage(next);
    if (next === 'pos') setPosNavKey((k) => k + 1);
  }, []);

  if (boot.error) {
    return (
      <div className="gate-wrap">
        <div className="login-card">
          <div className="brand-mark">
            <SaudaLogo size={44} />
          </div>
          <h1 style={{ marginBottom: 6 }}>{t('common.error')}</h1>
          <p className="muted small">{boot.error}</p>
          <Button variant="primary" block onClick={() => setReloadKey((k) => k + 1)} icon="refresh">
            {t('common.retry')}
          </Button>
        </div>
      </div>
    );
  }

  if (!boot.license) {
    return (
      <div className="gate-wrap">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <SaudaLogo size={54} />
          <Spinner size={22} />
          <span className="muted small">{t('common.loading')}</span>
        </div>
      </div>
    );
  }

  if (!boot.license.activated) {
    return <ActivationPage state={boot.license} onActivated={refreshBoot} />;
  }

  if (boot.needsSetup) {
    return <SetupPage onDone={refreshBoot} />;
  }

  if (!boot.user) {
    return (
      <LoginPage
        businessName={boot.settings?.business_name ?? t('app.name')}
        licenseOrg={boot.license.license?.org ?? ''}
        onLogin={(user) => setBoot((prev) => ({ ...prev, user }))}
      />
    );
  }

  return (
    <UIProvider>
      <AppShell
        user={boot.user}
        settings={boot.settings}
        page={page}
        posNavKey={posNavKey}
        lang={lang}
        navigate={navigate}
        onLogout={async () => {
          await call('auth.logout');
          setBoot((prev) => ({ ...prev, user: null }));
        }}
        onSettingsChanged={async () => {
          const s = await call<AppSettings>('settings.get');
          setBoot((prev) => ({ ...prev, settings: s }));
          applyTheme((s.theme as ThemePref) ?? 'light');
          setLang((s.language as Lang) ?? 'bn');
        }}
        onLicenseChanged={refreshBoot}
      />
    </UIProvider>
  );
}

function AppShell({
  user,
  settings,
  page,
  posNavKey,
  lang,
  navigate,
  onLogout,
  onSettingsChanged,
  onLicenseChanged,
}: {
  user: User;
  settings: AppSettings | null;
  page: PageId;
  posNavKey: number;
  lang: Lang;
  navigate: (p: PageId) => void;
  onLogout: () => Promise<void>;
  onSettingsChanged: () => Promise<void>;
  onLicenseChanged: () => Promise<void>;
}) {
  const ui = useUI();
  const t = useT();
  // The main process reports automatic-backup outcomes (v1.1.3). Before this,
  // a failed nightly backup was only a line in a log file nobody opens.
  useEffect(() => {
    return onEvent((evt) => {
      if (evt.type === 'backup' && evt.message) ui.toast('info', evt.message);
    });
  }, [ui]);
  const [lowCount, setLowCount] = useState(0);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<any[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState('1.1.4');
  const [navOpen, setNavOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const permissions = useMemo(() => new Set(user.role === 'admin' ? ['*'] : user.permissions ?? []), [user]);
  const can = useCallback((perm?: string) => !perm || permissions.has('*') || permissions.has(perm), [permissions]);

  const visibleNav = useMemo(() => NAV.filter((n) => can(n.perm)), [can]);
  useEffect(() => {
    if (!visibleNav.some((n) => n.id === page)) navigate(visibleNav[0]?.id ?? 'dashboard');
  }, [visibleNav, page, navigate]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const counts = await call<{ low: number; out: number }>('products.counts');
        if (alive) setLowCount((counts.low ?? 0) + (counts.out ?? 0));
      } catch {
        /* ignore */
      }
    };
    void load();
    const timer = window.setInterval(load, 120_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [page]);

  // Business alerts (data-derived, never a remote push).
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!can('report.view')) return;
      try {
        const list = await call<any[]>('notifications.alerts');
        if (alive) setAlerts(list ?? []);
      } catch {
        /* ignore */
      }
    };
    void load();
    const timer = window.setInterval(load, 180_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [can, page]);

  useEffect(() => {
    void call<{ version: string }>('app.info')
      .then((info) => setAppVersion(info?.version ?? '1.1.4'))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let alive = true;
    void call<string | null>('settings.logoDataUrl')
      .then((url) => {
        if (alive) setLogoUrl(url);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [settings?.business_logo]);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName ?? '');
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'F2' && can('pos.sell')) {
        e.preventDefault();
        navigate('pos');
        return;
      }
      if (e.key === 'F3' && can('product.view')) {
        e.preventDefault();
        navigate('products');
        return;
      }
      if (e.key === 'F4' && can('purchase.manage')) {
        e.preventDefault();
        navigate('purchases');
        return;
      }
      if (e.key === 'F5' && can('customer.manage')) {
        e.preventDefault();
        navigate('customers');
        return;
      }
      if (e.key === 'F9' && can('report.view')) {
        e.preventDefault();
        navigate('reports');
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '1') {
        e.preventDefault();
        navigate('dashboard');
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '2' && can('report.view')) {
        e.preventDefault();
        navigate('sales');
      }
      if (e.key === 'Escape' && !inField) {
        setResults(null);
        setAlertsOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, can]);

  useEffect(() => {
    if (search.trim().length < 2) {
      setResults(null);
      return;
    }
    let alive = true;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const hits = await call<any[]>('search.everything', search.trim());
        if (alive) setResults(hits);
      } catch {
        if (alive) setResults([]);
      } finally {
        if (alive) setSearching(false);
      }
    }, 260);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [search]);

  const groups = useMemo(() => {
    const map = new Map<string, NavEntry[]>();
    for (const item of visibleNav) {
      if (!map.has(item.groupKey)) map.set(item.groupKey, []);
      map.get(item.groupKey)!.push(item);
    }
    return [...map.entries()];
  }, [visibleNav]);

  const openHit = (hit: any) => {
    setSearch('');
    setResults(null);
    if (hit.kind === 'product') navigate('products');
    else if (hit.kind === 'customer') navigate('customers');
    else if (hit.kind === 'supplier') navigate('suppliers');
    else if (hit.kind === 'sale') navigate('sales');
    else if (hit.kind === 'purchase') navigate('purchases');
    else navigate('dashboard');
  };

  const pageNode = (() => {
    switch (page) {
      case 'dashboard':
        return <DashboardPage user={user} navigate={navigate} can={can} />;
      case 'pos':
        return <POSPage key={posNavKey} settings={settings} can={can} navigate={navigate} onSettingsChanged={onSettingsChanged} />;
      case 'products':
        return <ProductsPage can={can} />;
      case 'inventory':
        return <InventoryPage can={can} />;
      case 'stockops':
        return <StockOpsPage can={can} />;
      case 'purchaseorders':
        return <PurchaseOrdersPage can={can} />;
      case 'accounting':
        return <AccountingPage can={can} />;
      case 'purchases':
        return <PurchasesPage can={can} />;
      case 'sales':
        return <SalesPage can={can} settings={settings} navigate={navigate} />;
      case 'returns':
        return <ReturnsPage can={can} />;
      case 'customers':
        return <CustomersPage can={can} settings={settings} />;
      case 'suppliers':
        return <SuppliersPage can={can} />;
      case 'promotions':
        return <PromotionsPage can={can} />;
      case 'expenses':
        return <ExpensesPage can={can} />;
      case 'cash':
        return <CashPage can={can} />;
      case 'reports':
        return <ReportsPage can={can} />;
      case 'team':
        return <TeamPage can={can} user={user} />;
      case 'settings':
        return (
          <SettingsPage user={user} onChanged={onSettingsChanged} onLicenseChanged={onLicenseChanged} />
        );
      case 'backup':
        return <BackupPage can={can} />;
      case 'about':
        return <AboutPage user={user} />;
      default:
        return <EmptyState title={t('common.none')} />;
    }
  })();

  const pageMeta = NAV.find((n) => n.id === page);
  const alertCount = alerts.filter((a) => a.severity !== 'info').length;
  const businessName = settings?.business_name || t('app.tagline');

  return (
    <div className="shell">
      <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
        <div className="sidebar-brand">
          <div className="sidebar-logo">
            {logoUrl ? <img src={logoUrl} alt="" className="brand-img" /> : <SaudaLogo size={26} />}
          </div>
          <div className="sidebar-brand-text">
            <span className="sidebar-brand-name" title={businessName}>
              {businessName}
            </span>
            <span className="sidebar-brand-sub">{t('app.tagline')}</span>
          </div>
        </div>
        <div className="sidebar-scroll">
          {groups.map(([groupKey, items]) => (
            <div key={groupKey}>
              <div className="nav-group-label">{t(groupKey)}</div>
              {items.map((item) => (
                <button
                  key={item.id}
                  className={`nav-item ${page === item.id ? 'active' : ''}`}
                  onClick={() => {
                    navigate(item.id);
                    setNavOpen(false);
                  }}
                  title={item.shortcut ? `${t(item.labelKey)} (${item.shortcut})` : t(item.labelKey)}
                  aria-current={page === item.id ? 'page' : undefined}
                >
                  <Icon name={item.icon} size={17} />
                  <span>{t(item.labelKey)}</span>
                  {item.id === 'inventory' && lowCount > 0 ? <span className="nav-badge">{lowCount}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="sidebar-footer">
          <div className="small bold">{businessName}</div>
          <div className="tiny" style={{ marginTop: 2, opacity: 0.75 }}>
            MERQO • v{appVersion}
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="icon-btn nav-toggle" title="Menu" onClick={() => setNavOpen((v) => !v)}>
            <Icon name="list" size={17} />
          </button>
          <div className="topbar-title">
            <strong>{t(PAGE_TITLE_KEYS[page])}</strong>
            <span>
              {pageMeta?.shortcut ? `${pageMeta.shortcut} • ` : ''}
              {t('shell.today')} {today()}
            </span>
          </div>
          <div className="global-search">
            <span className="search-icon">
              <Icon name="search" size={16} />
            </span>
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`${t('shell.search')} (Ctrl+K)`}
              aria-label={t('common.search')}
            />
            {results && search.trim().length >= 2 ? (
              <div className="search-results">
                {searching ? (
                  <div style={{ padding: 12, textAlign: 'center' }}>
                    <Spinner size={16} />
                  </div>
                ) : results.length === 0 ? (
                  <div style={{ padding: 14, textAlign: 'center' }} className="muted small">
                    {t('shell.searchEmpty')}
                  </div>
                ) : (
                  results.map((hit) => (
                    <div key={`${hit.kind}-${hit.id}`} className="search-result" onClick={() => openHit(hit)}>
                      <span className="kind">
                        {hit.kind === 'product'
                          ? 'প্রোডাক্ট'
                          : hit.kind === 'customer'
                            ? 'কাস্টমার'
                            : hit.kind === 'supplier'
                              ? 'সাপ্লায়ার'
                              : hit.kind === 'sale'
                                ? 'ইনভয়েস'
                                : 'পারচেজ'}
                      </span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="bold small nowrap" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {hit.title}
                        </div>
                        <div className="tiny muted nowrap" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {hit.subtitle}
                        </div>
                      </div>
                      {hit.amount_paisa !== null && hit.amount_paisa !== undefined ? (
                        <span className="num small bold">{money(hit.amount_paisa)}</span>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>
          <div className="grow" />
          {can('pos.sell') ? (
            <Button variant="primary" icon="pos" onClick={() => navigate('pos')}>
              {t('shell.newSale')}
            </Button>
          ) : null}

          {can('report.view') ? (
            <div style={{ position: 'relative' }}>
              <button
                className={`icon-btn ${alertsOpen ? 'active' : ''}`}
                title={t('shell.notifications')}
                aria-label={t('shell.notifications')}
                onClick={() => setAlertsOpen((v) => !v)}
              >
                <Icon name="warning" size={17} />
                {alerts.length > 0 ? <span className="dot">{alerts.length}</span> : null}
              </button>
              {alertsOpen ? (
                <div className="popover" role="dialog" aria-label={t('dash.alerts')}>
                  <div className="popover-head">
                    <strong className="small">{t('dash.alerts')}</strong>
                    <span className="tiny muted">{alerts.length}</span>
                  </div>
                  {alerts.length === 0 ? (
                    <div className="empty-state" style={{ padding: '24px 8px' }}>
                      <div className="es-title small">{t('dash.noAlerts')}</div>
                    </div>
                  ) : (
                    alerts.map((a) => (
                      <div
                        key={a.key}
                        className={`alert-item ${a.severity}`}
                        onClick={() => {
                          navigate(a.page as PageId);
                          setAlertsOpen(false);
                        }}
                      >
                        <span className="bar" />
                        <div style={{ minWidth: 0 }}>
                          <div className="t">{a.title}</div>
                          <div className="b">{a.body}</div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="seg-toggle" title={t('shell.language')}>
            <button className={lang === 'bn' ? 'on' : ''} onClick={() => void switchLang('bn')}>
              বাং
            </button>
            <button className={lang === 'en' ? 'on' : ''} onClick={() => void switchLang('en')}>
              EN
            </button>
          </div>

          <button
            className="icon-btn"
            title={`${t('shell.theme')}: ${settings?.theme === 'dark' ? t('shell.theme.dark') : t('shell.theme.light')}`}
            onClick={async () => {
              const next = settings?.theme === 'dark' ? 'light' : 'dark';
              applyTheme(next as ThemePref);
              try {
                await call('settings.update', { theme: next });
                await onSettingsChanged();
              } catch {
                applyTheme((settings?.theme as ThemePref) ?? 'light');
              }
            }}
          >
            <Icon name={settings?.theme === 'dark' ? 'eye' : 'lock'} size={16} />
          </button>

          <div className="user-chip" title={`${user.full_name} (${user.username})`}>
            <span className="avatar">{initials(user.full_name || user.username)}</span>
            <div style={{ lineHeight: 1.15, textAlign: 'left' }}>
              <div className="small bold">{user.full_name || user.username}</div>
              <div className="tiny muted">
                {user.role === 'admin' ? t('shell.admin') : user.role === 'manager' ? t('shell.manager') : t('shell.cashier')}
              </div>
            </div>
          </div>
          <button
            className="icon-btn"
            title={t('shell.logout')}
            aria-label={t('shell.logout')}
            onClick={async () => {
              const res = await ui.confirm({ title: t('shell.logout'), message: t('shell.logoutConfirm') });
              if (res.ok) await onLogout();
            }}
          >
            <Icon name="logout" size={17} />
          </button>
        </header>
        <main className="content">
          <div className="content-inner">{pageNode}</div>
        </main>
      </div>
    </div>
  );

  async function switchLang(next: Lang) {
    setLang(next);
    try {
      await call('settings.update', { language: next });
      await onSettingsChanged();
    } catch {
      /* the toggle still works for this session */
    }
  }
}

export { Loading };
