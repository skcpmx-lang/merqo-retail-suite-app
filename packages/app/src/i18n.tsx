import { useSyncExternalStore } from 'react';

/**
 * Two-language UI (বাংলা / English).
 *
 * Keys are grouped by surface. Missing keys fall back to Bangla (the product's
 * first language) and then to the key itself, so a gap is visible in review but
 * never breaks a screen. See docs/18-LOCALIZATION.md for the coverage table.
 */
export type Lang = 'bn' | 'en';

type Pair = readonly [bn: string, en: string];

const DICT: Record<string, Pair> = {
  /* ---------- shell ---------- */
  'app.name': ['সাউদা', 'Sauda'],
  'app.tagline': ['রিটেইল স্যুট', 'Retail Suite'],
  'nav.group.main': ['প্রধান', 'Main'],
  'nav.group.inventory': ['ইনভেন্টরি', 'Inventory'],
  'nav.group.party': ['পক্ষ', 'Parties'],
  'nav.group.account': ['হিসাব', 'Accounts'],
  'nav.group.system': ['সিস্টেম', 'System'],
  'nav.dashboard': ['ড্যাশবোর্ড', 'Dashboard'],
  'nav.pos': ['বিক্রয় (POS)', 'Point of Sale'],
  'nav.sales': ['সেলস ও ইনভয়েস', 'Sales & Invoices'],
  'nav.products': ['প্রোডাক্ট', 'Products'],
  'nav.inventory': ['স্টক ও সমন্বয়', 'Stock'],
  'nav.stockops': ['স্টক অপারেশন', 'Stock Operations'],
  'nav.purchaseorders': ['পারচেজ অর্ডার', 'Purchase Orders'],
  'nav.purchases': ['পারচেজ', 'Purchases'],
  'nav.returns': ['রিটার্ন ও রিফান্ড', 'Returns & Refunds'],
  'nav.customers': ['কাস্টমার ও বাকি', 'Customers'],
  'nav.suppliers': ['সাপ্লায়ার', 'Suppliers'],
  'nav.promotions': ['কুপন ও গিফট কার্ড', 'Coupons & Gift Cards'],
  'nav.expenses': ['এক্সপেন্স', 'Expenses'],
  'nav.cash': ['ক্যাশ রেজিস্টার', 'Cash Register'],
  'nav.accounting': ['হিসাব (ডাবল-এন্ট্রি)', 'Accounting'],
  'nav.reports': ['রিপোর্ট', 'Reports'],
  'nav.team': ['কর্মী ও হাজিরা', 'Team & Attendance'],
  'nav.settings': ['সেটিংস', 'Settings'],
  'nav.backup': ['ব্যাকআপ ও রিস্টোর', 'Backup & Restore'],
  'nav.about': ['সম্পর্কে', 'About'],

  'shell.search': ['প্রোডাক্ট, কাস্টমার, ইনভয়েস খুঁজুন…', 'Search products, customers, invoices…'],
  'shell.searchEmpty': ['কিছু পাওয়া যায়নি', 'Nothing found'],
  'shell.newSale': ['নতুন বিক্রয়', 'New sale'],
  'shell.logout': ['লগআউট', 'Sign out'],
  'shell.logoutConfirm': ['আপনি কি লগআউট করতে চান?', 'Do you want to sign out?'],
  'shell.today': ['আজ', 'Today'],
  'shell.lowStock': ['স্টক কম', 'Low stock'],
  'shell.notifications': ['নোটিফিকেশন', 'Notifications'],
  'shell.noNotifications': ['কোনো নতুন নোটিফিকেশন নেই', 'No new notifications'],
  'shell.markAllRead': ['সব পড়া হয়েছে', 'Mark all read'],
  'shell.theme': ['থিম', 'Theme'],
  'shell.theme.light': ['লাইট', 'Light'],
  'shell.theme.dark': ['ডার্ক', 'Dark'],
  'shell.theme.system': ['সিস্টেম', 'System'],
  'shell.language': ['ভাষা', 'Language'],
  'shell.admin': ['অ্যাডমিন', 'Administrator'],
  'shell.manager': ['ম্যানেজার', 'Manager'],
  'shell.cashier': ['ক্যাশিয়ার', 'Cashier'],
  'shell.terminal': ['টার্মিনাল', 'Terminal'],
  'shell.host': ['সার্ভার', 'Host'],

  /* ---------- common ---------- */
  'common.save': ['সংরক্ষণ', 'Save'],
  'common.cancel': ['বাতিল', 'Cancel'],
  'common.close': ['বন্ধ', 'Close'],
  'common.delete': ['মুছুন', 'Delete'],
  'common.edit': ['সম্পাদনা', 'Edit'],
  'common.add': ['যোগ করুন', 'Add'],
  'common.create': ['তৈরি করুন', 'Create'],
  'common.search': ['খুঁজুন', 'Search'],
  'common.filter': ['ফিল্টার', 'Filter'],
  'common.reset': ['রিসেট', 'Reset'],
  'common.refresh': ['রিফ্রেশ', 'Refresh'],
  'common.print': ['প্রিন্ট', 'Print'],
  'common.pdf': ['PDF', 'PDF'],
  'common.export': ['এক্সপোর্ট', 'Export'],
  'common.import': ['ইমপোর্ট', 'Import'],
  'common.total': ['মোট', 'Total'],
  'common.subtotal': ['সাবটোটাল', 'Subtotal'],
  'common.discount': ['ডিসকাউন্ট', 'Discount'],
  'common.paid': ['পরিশোধিত', 'Paid'],
  'common.due': ['বাকি', 'Due'],
  'common.change': ['ফেরত', 'Change'],
  'common.date': ['তারিখ', 'Date'],
  'common.status': ['অবস্থা', 'Status'],
  'common.actions': ['কার্যক্রম', 'Actions'],
  'common.name': ['নাম', 'Name'],
  'common.phone': ['ফোন', 'Phone'],
  'common.address': ['ঠিকানা', 'Address'],
  'common.amount': ['টাকা', 'Amount'],
  'common.qty': ['পরিমাণ', 'Quantity'],
  'common.price': ['দর', 'Price'],
  'common.notes': ['নোট', 'Notes'],
  'common.none': ['কোনো তথ্য নেই', 'Nothing here'],
  'common.loading': ['লোড হচ্ছে…', 'Loading…'],
  'common.confirm': ['নিশ্চিত করুন', 'Confirm'],
  'common.yes': ['হ্যাঁ', 'Yes'],
  'common.no': ['না', 'No'],
  'common.all': ['সব', 'All'],
  'common.active': ['সক্রিয়', 'Active'],
  'common.inactive': ['নিষ্ক্রিয়', 'Inactive'],
  'common.required': ['আবশ্যিক', 'Required'],
  'common.optional': ['ঐচ্ছিক', 'Optional'],
  'common.saved': ['সংরক্ষিত হয়েছে', 'Saved'],
  'common.error': ['সমস্যা হয়েছে', 'Something went wrong'],
  'common.retry': ['আবার চেষ্টা করুন', 'Try again'],
  'common.view': ['দেখুন', 'View'],
  'common.details': ['বিস্তারিত', 'Details'],
  'common.today': ['আজ', 'Today'],
  'common.yesterday': ['গতকাল', 'Yesterday'],
  'common.last7': ['গত ৭ দিন', 'Last 7 days'],
  'common.last30': ['গত ৩০ দিন', 'Last 30 days'],
  'common.thisMonth': ['এই মাস', 'This month'],
  'common.thisYear': ['এই বছর', 'This year'],
  'common.custom': ['কাস্টম', 'Custom'],

  /* ---------- dashboard ---------- */
  'dash.greeting.morning': ['শুভ সকাল', 'Good morning'],
  'dash.greeting.afternoon': ['শুভ অপরাহ্ন', 'Good afternoon'],
  'dash.greeting.evening': ['শুভ সন্ধ্যা', 'Good evening'],
  'dash.todaySales': ['আজকের বিক্রয়', "Today's sales"],
  'dash.todayProfit': ['আজকের প্রফিট', "Today's profit"],
  'dash.receivable': ['মোট বাকি (কাস্টমার)', 'Receivable'],
  'dash.payable': ['মোট দেনা (সাপ্লায়ার)', 'Payable'],
  'dash.cash': ['ক্যাশ ব্যালেন্স', 'Cash balance'],
  'dash.inventoryValue': ['স্টকের মূল্য', 'Inventory value'],
  'dash.lowStock': ['স্টক কম', 'Low stock'],
  'dash.salesChart': ['বিক্রয় ও প্রফিট', 'Sales & profit'],
  'dash.topProducts': ['সর্বাধিক বিক্রীত', 'Top products'],
  'dash.recent': ['সাম্প্রতিক লেনদেন', 'Recent transactions'],
  'dash.alerts': ['ব্যবসার অ্যালার্ট', 'Business alerts'],
  'dash.quickActions': ['দ্রুত কাজ', 'Quick actions'],
  'dash.noAlerts': ['সব ঠিক আছে — কোনো অ্যালার্ট নেই', 'All clear — no alerts'],
  'dash.export': ['ড্যাশবোর্ড এক্সপোর্ট', 'Export dashboard'],

  /* ---------- POS ---------- */
  'pos.title': ['বিক্রয় কাউন্টার', 'Sales counter'],
  'pos.cart': ['কার্ট', 'Cart'],
  'pos.emptyCart': ['স্ক্যান করুন বা প্রোডাক্ট খুঁজুন', 'Scan or search a product'],
  'pos.customer': ['কাস্টমার', 'Customer'],
  'pos.walkIn': ['ওয়াক-ইন', 'Walk-in'],
  'pos.addCustomer': ['কাস্টমার যোগ', 'Add customer'],
  'pos.coupon': ['কুপন কোড', 'Coupon code'],
  'pos.couponApplied': ['কুপন প্রয়োগ হয়েছে', 'Coupon applied'],
  'pos.couponRemove': ['কুপন সরান', 'Remove coupon'],
  'pos.giftCard': ['গিফট কার্ড / ভাউচার', 'Gift card / voucher'],
  'pos.giftCardApplied': ['কার্ড প্রয়োগ হয়েছে', 'Card applied'],
  'pos.payment': ['পেমেন্ট', 'Payment'],
  'pos.splitPayment': ['স্প্লিট পেমেন্ট', 'Split payment'],
  'pos.hold': ['হোল্ড', 'Hold'],
  'pos.resume': ['রিজিউম', 'Resume'],
  'pos.held': ['হোল্ড করা বিক্রয়', 'Held sales'],
  'pos.exchange': ['এক্সচেঞ্জ', 'Exchange'],
  'pos.return': ['রিটার্ন', 'Return'],
  'pos.checkout': ['বিক্রয় সম্পন্ন করুন', 'Complete sale'],
  'pos.favourites': ['ফেভারিট', 'Favourites'],
  'pos.quickPicks': ['দ্রুত পছন্দ', 'Quick picks'],
  'pos.discount': ['ডিসকাউন্ট', 'Discount'],
  'pos.tax': ['ভ্যাট', 'VAT'],
  'pos.receipt': ['রসিদ', 'Receipt'],
  'pos.newSale': ['নতুন বিক্রয় শুরু', 'Start new sale'],
  'pos.noCustomer': ['কাস্টমার নির্বাচন করুন', 'Select a customer'],
  'pos.payableNow': ['এখন পরিশোধযোগ্য', 'Payable now'],
  'pos.exchangeHint': ['ফেরত দেওয়া পণ্য ও নতুন পণ্য একই স্ক্রিনে', 'Returned and replacement items on one screen'],

  /* ---------- purchase orders ---------- */
  'po.title': ['পারচেজ অর্ডার', 'Purchase orders'],
  'po.new': ['নতুন অর্ডার', 'New order'],
  'po.orderDate': ['অর্ডারের তারিখ', 'Order date'],
  'po.expected': ['প্রত্যাশিত তারিখ', 'Expected date'],
  'po.receive': ['পণ্য গ্রহণ', 'Receive goods'],
  'po.received': ['গৃহীত', 'Received'],
  'po.remaining': ['বাকি', 'Remaining'],
  'po.status.open': ['খোলা', 'Open'],
  'po.status.partial': ['আংশিক', 'Partial'],
  'po.status.received': ['সম্পূর্ণ', 'Received'],
  'po.status.cancelled': ['বাতিল', 'Cancelled'],
  'po.empty': ['কোনো অর্ডার নেই', 'No purchase orders'],
  'po.cancelConfirm': ['অর্ডারটি বাতিল করবেন?', 'Cancel this order?'],

  /* ---------- promotions ---------- */
  'promo.title': ['কুপন, ভাউচার ও গিফট কার্ড', 'Coupons, vouchers & gift cards'],
  'promo.coupons': ['কুপন', 'Coupons'],
  'promo.giftCards': ['গিফট কার্ড ও ভাউচার', 'Gift cards & vouchers'],
  'promo.code': ['কোড', 'Code'],
  'promo.kind.percent': ['শতকরা', 'Percentage'],
  'promo.kind.fixed': ['নির্দিষ্ট', 'Fixed'],
  'promo.minPurchase': ['সর্বনিম্ন কেনাকাটা', 'Minimum purchase'],
  'promo.maxDiscount': ['সর্বোচ্চ ছাড়', 'Maximum discount'],
  'promo.expiry': ['মেয়াদ', 'Expiry'],
  'promo.usageLimit': ['ব্যবহারের সীমা', 'Usage limit'],
  'promo.used': ['ব্যবহৃত', 'Used'],
  'promo.issue': ['নতুন ইস্যু', 'Issue new'],
  'promo.balance': ['অবশিষ্ট', 'Balance'],
  'promo.initial': ['ইস্যু মূল্য', 'Issued value'],
  'promo.outstanding': ['মোট দায়', 'Outstanding'],
  'promo.voucher': ['ভাউচার', 'Voucher'],
  'promo.giftCard': ['গিফট কার্ড', 'Gift card'],
  'promo.void': ['বাতিল করুন', 'Void'],
  'promo.adjust': ['সমন্বয়', 'Adjust'],

  /* ---------- team ---------- */
  'team.title': ['কর্মী ও হাজিরা', 'Team & attendance'],
  'team.clockIn': ['ক্লক-ইন', 'Clock in'],
  'team.clockOut': ['ক্লক-আউট', 'Clock out'],
  'team.onFloor': ['এখন ডিউটিতে', 'On the floor'],
  'team.present': ['উপস্থিত', 'Present'],
  'team.hours': ['ঘণ্টা', 'Hours'],

  /* ---------- settings ---------- */
  'settings.branding': ['ব্যবসার পরিচিতি', 'Business branding'],
  'settings.logo': ['লোগো', 'Logo'],
  'settings.logoPick': ['লোগো নির্বাচন', 'Choose logo'],
  'settings.logoRemove': ['লোগো সরান', 'Remove logo'],
  'settings.appearance': ['রূপ ও ভাষা', 'Appearance & language'],
  'settings.language': ['ভাষা', 'Language'],
  'settings.theme': ['থিম', 'Theme'],
  'settings.security': ['সিকিউরিটি', 'Security'],
  'settings.loginLock': ['লগইন লক', 'Login lock'],
  'settings.loginLockHint': [
    'চালু থাকলে অ্যাপ খুললে ইউজারনেম ও পাসওয়ার্ড লাগবে। বন্ধ থাকলে সরাসরি ড্যাশবোর্ড খুলবে (পারমিশন ও লাইসেন্স আগের মতোই কাজ করবে)।',
    'When on, the app asks for a username and password. When off it opens straight to the dashboard (permissions and licence checks still apply).',
  ],
  'settings.lan': ['মাল্টি-টার্মিনাল (LAN)', 'Multi-terminal (LAN)'],
  'settings.lanOff': ['বন্ধ', 'Off'],
  'settings.lanHost': ['এই কম্পিউটার সার্ভার', 'This computer is the host'],
  'settings.lanTerminal': ['এই কম্পিউটার টার্মিনাল', 'This computer is a terminal'],
  'settings.display': ['কাস্টমার ডিসপ্লে', 'Customer display'],
  'settings.print': ['প্রিন্ট ও ডকুমেন্ট', 'Print & documents'],
  'settings.testPrint': ['প্রিন্টার টেস্ট', 'Test printer'],

  /* ---------- auth ---------- */
  'auth.login': ['লগইন', 'Sign in'],
  'auth.username': ['ইউজারনেম', 'Username'],
  'auth.password': ['পাসওয়ার্ড', 'Password'],
  'auth.showPassword': ['পাসওয়ার্ড দেখুন', 'Show password'],
  'auth.welcome': ['স্বাগতম', 'Welcome'],
  'auth.subtitle': ['আপনার দোকান, আপনার হিসাব', 'Your shop, your books'],
  'auth.lockDisabled': ['লগইন লক বন্ধ আছে', 'Login lock is off'],

  /* ---------- customer display ---------- */
  'display.title': ['কাস্টমার ডিসপ্লে', 'Customer display'],
  'display.waiting': ['স্বাগতম — ক্যাশিয়ার প্রস্তুত হচ্ছেন', 'Welcome — the cashier is getting ready'],
  'display.thanks': ['ধন্যবাদ! আবার আসবেন', 'Thank you! Please come again'],
};

const listeners = new Set<() => void>();
let current: Lang = 'bn';

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang !== 'bn' && lang !== 'en') return;
  if (current === lang) return;
  current = lang;
  if (typeof document !== 'undefined') document.documentElement.setAttribute('lang', lang);
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function translate(key: string, vars?: Record<string, string | number>, lang: Lang = current): string {
  const pair = DICT[key];
  let out = pair ? (lang === 'en' ? pair[1] : pair[0]) : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return out;
}

/** `t('key')` — re-renders the component when the language changes. */
export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const lang = useSyncExternalStore(subscribe, getLang, getLang);
  return (key, vars) => translate(key, vars, lang);
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

export function dictionarySize(): number {
  return Object.keys(DICT).length;
}
