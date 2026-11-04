import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, onEvent } from './api.js';
import { Icon, SaudaLogo, type IconName } from './icons.js';
import { setFormatPrefs, initials, money, today } from './format.js';
import { UIProvider, useUI, EmptyState, Spinner, Button, Loading } from './ui.js';
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
import { PurchasesPage } from './pages/Purchases.js';
import { SalesPage } from './pages/Sales.js';
import { ReturnsPage } from './pages/Returns.js';
import { CustomersPage, SuppliersPage } from './pages/Parties.js';
import { ExpensesPage } from './pages/Expenses.js';
import { CashPage } from './pages/Cash.js';
import { ReportsPage } from './pages/Reports.js';
import { SettingsPage } from './pages/Settings.js';
import { BackupPage } from './pages/Backup.js';
import { AboutPage } from './pages/About.js';

export type PageId =
  | 'dashboard'
  | 'pos'
  | 'products'
  | 'inventory'
  | 'stockops'
  | 'accounting'
  | 'purchases'
  | 'sales'
  | 'returns'
  | 'customers'
  | 'suppliers'
  | 'expenses'
  | 'cash'
  | 'reports'
  | 'settings'
  | 'backup'
  | 'about';

interface NavEntry {
  id: PageId;
  label: string;
  icon: IconName;
  group: string;
  perm?: string;
  shortcut?: string;
}

const NAV: NavEntry[] = [
  { id: 'dashboard', label: 'ড্যাশবোর্ড', icon: 'dashboard', group: 'প্রধান', shortcut: 'Ctrl+1' },
  { id: 'pos', label: 'বিক্রয় (POS)', icon: 'pos', group: 'প্রধান', perm: 'pos.sell', shortcut: 'F2' },
  { id: 'sales', label: 'সেলস ও ইনভয়েস', icon: 'cart', group: 'প্রধান', perm: 'report.view', shortcut: 'Ctrl+2' },
  { id: 'products', label: 'প্রোডাক্ট', icon: 'product', group: 'ইনভেন্টরি', perm: 'product.view', shortcut: 'F3' },
  { id: 'inventory', label: 'স্টক ও সমন্বয়', icon: 'stock', group: 'ইনভেন্টরি', perm: 'product.view' },
  { id: 'stockops', label: 'স্টক অপারেশন', icon: 'box', group: 'ইনভেন্টরি', perm: 'product.view' },
  { id: 'purchases', label: 'পারচেজ', icon: 'purchase', group: 'ইনভেন্টরি', perm: 'purchase.manage', shortcut: 'F4' },
  { id: 'returns', label: 'রিটার্ন ও রিফান্ড', icon: 'return', group: 'ইনভেন্টরি', perm: 'return.manage' },
  { id: 'customers', label: 'কাস্টমার ও বাকি', icon: 'users', group: 'পক্ষ', perm: 'customer.manage', shortcut: 'F5' },
  { id: 'suppliers', label: 'সাপ্লায়ার', icon: 'supplier', group: 'পক্ষ', perm: 'supplier.manage' },
  { id: 'expenses', label: 'এক্সপেন্স', icon: 'expense', group: 'হিসাব', perm: 'expense.manage' },
  { id: 'cash', label: 'ক্যাশ রেজিস্টার', icon: 'cash', group: 'হিসাব', perm: 'cash.manage' },
  { id: 'accounting', label: 'হিসাব (ডাবল-এন্ট্রি)', icon: 'shield', group: 'হিসাব', perm: 'accounting.view' },
  { id: 'reports', label: 'রিপোর্ট', icon: 'report', group: 'হিসাব', perm: 'report.view', shortcut: 'F9' },
  { id: 'settings', label: 'সেটিংস', icon: 'settings', group: 'সিস্টেম', perm: 'settings.manage' },
  { id: 'backup', label: 'ব্যাকআপ ও রিস্টোর', icon: 'backup', group: 'সিস্টেম', perm: 'backup.manage' },
  { id: 'about', label: 'সম্পর্কে', icon: 'info', group: 'সিস্টেম' },
];

const PAGE_TITLES: Record<PageId, string> = {
  dashboard: 'ড্যাশবোর্ড',
  pos: 'বিক্রয় কাউন্টার (POS)',
  products: 'প্রোডাক্ট ব্যবস্থাপনা',
  stockops: 'স্টক অপারেশন',
  accounting: 'হিসাব (ডাবল-এন্ট্রি)',
  inventory: 'স্টক ও ইনভেন্টরি',
  purchases: 'পারচেজ ব্যবস্থাপনা',
  sales: 'সেলস ও ইনভয়েস',
  returns: 'রিটার্ন ও রিফান্ড',
  customers: 'কাস্টমার ও বাকি',
  suppliers: 'সাপ্লায়ার',
  expenses: 'এক্সপেন্স',
  cash: 'ক্যাশ রেজিস্টার',
  reports: 'রিপোর্ট ও অ্যানালিটিক্স',
  settings: 'সেটিংস',
  backup: 'ব্যাকআপ ও রিস্টোর',
  about: 'সফটওয়্যার সম্পর্কে',
};

interface BootState {
  license: ActivationState | null;
  needsSetup: boolean;
  user: User | null;
  settings: AppSettings | null;
  error: string | null;
}

export default function App() {
  const [boot, setBoot] = useState<BootState>({ license: null, needsSetup: true, user: null, settings: null, error: null });
  const [page, setPage] = useState<PageId>('dashboard');
  const [posNavKey, setPosNavKey] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  const refreshBoot = useCallback(async () => {
    try {
      const license = await call<ActivationState>('license.state');
      let needsSetup = true;
      let settings: AppSettings | null = null;
      if (license.activated) {
        const status = await call<{ needs_setup: boolean }>('setup.status');
        needsSetup = status.needs_setup;
        if (!needsSetup) settings = await call<AppSettings>('settings.get');
      }
      setBoot((prev) => ({ ...prev, license, needsSetup, settings, error: null }));
      if (settings) setFormatPrefs({ symbol: settings.currency_symbol, bengaliDigits: settings.bengali_digits === 1 });
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
          <h1 style={{ marginBottom: 6 }}>সাউদা চালু করা যাচ্ছে না</h1>
          <p className="muted small">{boot.error}</p>
          <Button variant="primary" block onClick={() => setReloadKey((k) => k + 1)} icon="refresh">
            আবার চেষ্টা করুন
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
          <span className="muted small">সাউদা চালু হচ্ছে…</span>
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
        businessName={boot.settings?.business_name ?? 'সাউদা'}
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
        navigate={navigate}
        onLogout={async () => {
          await call('auth.logout');
          setBoot((prev) => ({ ...prev, user: null }));
        }}
        onSettingsChanged={async () => {
          const s = await call<AppSettings>('settings.get');
          setBoot((prev) => ({ ...prev, settings: s }));
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
  navigate,
  onLogout,
  onSettingsChanged,
  onLicenseChanged,
}: {
  user: User;
  settings: AppSettings | null;
  page: PageId;
  posNavKey: number;
  navigate: (p: PageId) => void;
  onLogout: () => Promise<void>;
  onSettingsChanged: () => Promise<void>;
  onLicenseChanged: () => Promise<void>;
}) {
  const ui = useUI();
  const [lowCount, setLowCount] = useState(0);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<any[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const permissions = useMemo(
    () => new Set(user.role === 'admin' ? ['*'] : user.permissions ?? []),
    [user],
  );
  const can = useCallback(
    (perm?: string) => !perm || permissions.has('*') || permissions.has(perm),
    [permissions],
  );

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
      if (e.key === 'Escape' && !inField) setResults(null);
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
    const t = window.setTimeout(async () => {
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
      window.clearTimeout(t);
    };
  }, [search]);

  const groups = useMemo(() => {
    const map = new Map<string, NavEntry[]>();
    for (const item of visibleNav) {
      if (!map.has(item.group)) map.set(item.group, []);
      map.get(item.group)!.push(item);
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
      case 'expenses':
        return <ExpensesPage can={can} />;
      case 'cash':
        return <CashPage can={can} />;
      case 'reports':
        return <ReportsPage can={can} />;
      case 'settings':
        return <SettingsPage user={user} onChanged={onSettingsChanged} onLicenseChanged={onLicenseChanged} />;
      case 'backup':
        return <BackupPage can={can} />;
      case 'about':
        return <AboutPage user={user} />;
      default:
        return <EmptyState title="পাতা পাওয়া যায়নি" />;
    }
  })();

  const pageMeta = NAV.find((n) => n.id === page);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-logo">
            <SaudaLogo size={26} />
          </div>
          <div className="sidebar-brand-text">
            <span className="sidebar-brand-name">Sauda</span>
            <span className="sidebar-brand-sub">রিটেইল স্যুট</span>
          </div>
        </div>
        <div className="sidebar-scroll">
          {groups.map(([group, items]) => (
            <div key={group}>
              <div className="nav-group-label">{group}</div>
              {items.map((item) => (
                <button
                  key={item.id}
                  className={`nav-item ${page === item.id ? 'active' : ''}`}
                  onClick={() => navigate(item.id)}
                  title={item.shortcut ? `${item.label} (${item.shortcut})` : item.label}
                >
                  <Icon name={item.icon} size={17} />
                  <span>{item.label}</span>
                  {item.id === 'inventory' && lowCount > 0 ? <span className="nav-badge">{lowCount}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="sidebar-footer">
          <div>{settings?.business_name || 'সাউদা রিটেইল স্যুট'}</div>
          <div style={{ marginTop: 2, opacity: 0.75 }}>MERQO • v1.0.0</div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-title">
            <strong>{PAGE_TITLES[page]}</strong>
            <span>
              {pageMeta?.shortcut ? `${pageMeta.shortcut} • ` : ''}
              আজ {today()}
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
              placeholder="প্রোডাক্ট, কাস্টমার, ইনভয়েস খুঁজুন… (Ctrl+K)"
            />
            {results && search.trim().length >= 2 ? (
              <div className="search-results">
                {searching ? (
                  <div style={{ padding: 12, textAlign: 'center' }}>
                    <Spinner size={16} />
                  </div>
                ) : results.length === 0 ? (
                  <div style={{ padding: 14, textAlign: 'center' }} className="muted small">
                    কিছু পাওয়া যায়নি
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
              নতুন বিক্রয়
            </Button>
          ) : null}
          <div className="user-chip" title={`${user.full_name} (${user.username})`}>
            <span className="avatar">{initials(user.full_name || user.username)}</span>
            <div style={{ lineHeight: 1.15, textAlign: 'left' }}>
              <div className="small bold">{user.full_name || user.username}</div>
              <div className="tiny muted">
                {user.role === 'admin' ? 'অ্যাডমিন' : user.role === 'manager' ? 'ম্যানেজার' : 'ক্যাশিয়ার'}
              </div>
            </div>
          </div>
          <button
            className="btn ghost icon"
            title="লগআউট"
            onClick={async () => {
              const res = await ui.confirm({ title: 'লগআউট', message: 'আপনি কি লগআউট করতে চান?' });
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
}

export { Loading };
