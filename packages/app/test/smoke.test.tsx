import './env.js';
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { UIProvider } from '../src/ui.js';
import { AboutPage } from '../src/pages/About.js';
import { AccountingPage } from '../src/pages/Accounting.js';
import { ActivationPage } from '../src/pages/Activation.js';
import { BackupPage } from '../src/pages/Backup.js';
import { CashPage } from '../src/pages/Cash.js';
import { CustomerDisplayPage } from '../src/pages/CustomerDisplay.js';
import { DashboardPage } from '../src/pages/Dashboard.js';
import { ExpensesPage } from '../src/pages/Expenses.js';
import { InventoryPage } from '../src/pages/Inventory.js';
import { LoginPage } from '../src/pages/Login.js';
import { POSPage } from '../src/pages/POS.js';
import { CustomersPage, SuppliersPage } from '../src/pages/Parties.js';
import { ProductsPage } from '../src/pages/Products.js';
import { PromotionsPage } from '../src/pages/Promotions.js';
import { PurchaseOrdersPage } from '../src/pages/PurchaseOrders.js';
import { PurchasesPage } from '../src/pages/Purchases.js';
import { ReportsPage } from '../src/pages/Reports.js';
import { ReturnsPage } from '../src/pages/Returns.js';
import { SalesPage } from '../src/pages/Sales.js';
import { SettingsPage } from '../src/pages/Settings.js';
import { SetupPage } from '../src/pages/Setup.js';
import { StockOpsPage } from '../src/pages/StockOps.js';
import { TeamPage } from '../src/pages/Team.js';

const admin = {
  id: 1,
  username: 'admin',
  full_name: 'অ্যাডমিন',
  role: 'admin',
  permissions: ['*'],
  is_active: 1,
} as any;

const can = () => true;
const noop = () => undefined;
const noopAsync = async () => undefined;

const settings = {
  business_name: 'সাউদা স্টোর',
  address: 'চট্টগ্রাম',
  phone: '01700000000',
  currency_symbol: '৳',
  bengali_digits: 1,
  business_logo: null,
  pos_show_product_images: 1,
} as any;

const licenseState = {
  licensed: true,
  plan: 'pro',
  edition: 'pro',
  status: 'active',
  expires_at: null,
  days_left: null,
  machine_ok: true,
  business_name: 'সাউদা স্টোর',
} as any;

function render(node: React.ReactElement): string {
  return renderToString(<UIProvider>{node}</UIProvider>);
}

describe('renderer smoke — every screen renders without throwing', () => {
  const cases: Array<[string, () => string, RegExp?]> = [
    ['about', () => render(<AboutPage user={admin} />)],
    ['accounting', () => render(<AccountingPage can={can} />)],
    ['activation', () => render(<ActivationPage state={licenseState} onActivated={noop} />)],
    ['backup', () => render(<BackupPage can={can} />)],
    ['cash', () => render(<CashPage can={can} />)],
    ['customer display', () => render(<CustomerDisplayPage />)],
    // The dashboard's first paint is intentionally a skeleton grid while it loads.
    ['dashboard', () => render(<DashboardPage user={admin} navigate={noop} can={can} />), /class="skeleton"/],
    ['expenses', () => render(<ExpensesPage can={can} />)],
    ['inventory', () => render(<InventoryPage can={can} />)],
    ['login', () => render(<LoginPage businessName="সাউদা স্টোর" licenseOrg="Sauda" onLogin={noop} />)],
    ['pos', () => render(<POSPage settings={settings} can={can} navigate={noop} onSettingsChanged={noopAsync} />)],
    ['customers', () => render(<CustomersPage can={can} settings={settings} />)],
    ['suppliers', () => render(<SuppliersPage can={can} />)],
    ['products', () => render(<ProductsPage can={can} />)],
    ['promotions', () => render(<PromotionsPage can={can} />)],
    ['purchase orders', () => render(<PurchaseOrdersPage can={can} />)],
    ['purchases', () => render(<PurchasesPage can={can} />)],
    ['reports', () => render(<ReportsPage can={can} />)],
    ['returns', () => render(<ReturnsPage can={can} />)],
    ['sales', () => render(<SalesPage can={can} settings={settings} navigate={noop} />)],
    [
      'settings',
      () =>
        render(
          <SettingsPage user={admin} onChanged={noopAsync} onLicenseChanged={noopAsync} />,
        ),
    ],
    ['setup', () => render(<SetupPage onDone={noop} />)],
    ['stock ops', () => render(<StockOpsPage can={can} />)],
    ['team', () => render(<TeamPage can={can} user={admin} />)],
  ];

  it.each(cases)('%s renders real screen content', (_name, build, pattern) => {
    const html = build();
    expect(html.length).toBeGreaterThan(200);
    // Not just "some HTML": every screen must emit its Bengali labels (dashboard:
    // its loading skeleton), so an empty shell or swallowed render error fails.
    expect(html).toMatch(pattern ?? /[\u0980-\u09FF]/);
  });
});
