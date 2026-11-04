import type { Db } from './connection.js';
import { nowUtc } from '../domain/datetime.js';
import type { AppSettings } from '../domain/types.js';

/**
 * Reference (system) data only — never demo business data.
 * See PART 30.2 "seed-free production initialization": the shopkeeper starts
 * with a completely empty product/customer/transaction database.
 */

export const DEFAULT_SETTINGS: AppSettings = {
  business_name: '',
  business_logo: null,
  business_address: '',
  business_phone: '',
  business_email: '',
  receipt_width: 80,
  receipt_font_size: 11,
  receipt_header: '',
  receipt_footer: 'ধন্যবাদ! আবার আসবেন।',
  receipt_show_logo: 1,
  receipt_bengali: 1,
  invoice_prefix: 'INV',
  invoice_format: '{prefix}-{yy}{mm}-{seq}',
  invoice_separator: '-',
  purchase_prefix: 'PUR',
  return_prefix: 'RTN',
  default_customer_id: null,
  default_payment_method_id: null,
  default_unit_id: null,
  default_category_id: null,
  stock_alert_threshold_milli: 5000,
  allow_negative_stock: 0,
  allow_due_sale: 1,
  max_discount_percent_x100: 10000,
  vat_percent_x100: 0,
  currency_symbol: '৳',
  bengali_digits: 0,
  date_format: 'dd/mm/yyyy',
  printer_name: '',
  print_after_sale: 1,
  auto_backup_enabled: 1,
  auto_backup_interval: 'daily',
  auto_backup_dir: '',
  backup_keep_count: 14,
  scan_increment_qty: 1,
  session_timeout_minutes: 0,
  low_margin_warn_percent_x100: 500,
  // v1.0.1
  loyalty_enabled: 1,
  loyalty_points_per_100: 1,
  loyalty_redeem_value_paisa: 100,
  loyalty_min_redeem_points: 100,
  credit_limit_enforced: 1,
  theme: 'light',
  duplicate_sale_guard_seconds: 30,
  tax_register_enabled: 0,
  accounting_enabled: 1,
  // v1.1
  business_website: '',
  business_type: '',
  document_footer: '',
  language: 'bn',
  login_lock_enabled: 1,
  customer_display_enabled: 0,
  gift_card_expiry_days: 0,
  lan_mode: 'off',
  lan_port: 4747,
  lan_token: '',
  lan_host_url: '',
  server_autostart: 0,
  server_keep_running: 1,
  receipt_show_qr: 1,
};

interface UnitSeed {
  name: string;
  short_name: string;
  base?: string;
  factor_milli: number;
}

const UNITS: UnitSeed[] = [
  { name: 'পিস', short_name: 'পিস', factor_milli: 1000 },
  { name: 'গ্রাম', short_name: 'গ্রাম', factor_milli: 1000 },
  { name: 'কেজি', short_name: 'কেজি', base: 'গ্রাম', factor_milli: 1_000_000 },
  { name: 'মিলিগ্রাম', short_name: 'মি.গ্রা.', base: 'গ্রাম', factor_milli: 1 },
  { name: 'লিটার', short_name: 'লিটার', factor_milli: 1000 },
  { name: 'মিলিলিটার', short_name: 'মি.লি.', base: 'লিটার', factor_milli: 1 },
  { name: 'মিটার', short_name: 'মিটার', factor_milli: 1000 },
  { name: 'সেন্টিমিটার', short_name: 'সে.মি.', base: 'মিটার', factor_milli: 10 },
  { name: 'ডজন', short_name: 'ডজন', base: 'পিস', factor_milli: 12_000 },
  { name: 'বক্স', short_name: 'বক্স', base: 'পিস', factor_milli: 1000 },
  { name: 'প্যাকেট', short_name: 'প্যাকেট', base: 'পিস', factor_milli: 1000 },
  { name: 'বোতল', short_name: 'বোতল', base: 'পিস', factor_milli: 1000 },
  { name: 'কার্টন', short_name: 'কার্টন', base: 'পিস', factor_milli: 12_000 },
  { name: 'বান্ডেল', short_name: 'বান্ডেল', base: 'পিস', factor_milli: 1000 },
  { name: 'বস্তা', short_name: 'বস্তা', base: 'কেজি', factor_milli: 50_000_000 },
];

const PAYMENT_METHODS: { name: string; is_cash: number; sort: number }[] = [
  { name: 'ক্যাশ', is_cash: 1, sort: 1 },
  { name: 'বিকাশ', is_cash: 0, sort: 2 },
  { name: 'নগদ (Nagad)', is_cash: 0, sort: 3 },
  { name: 'রকেট', is_cash: 0, sort: 4 },
  { name: 'ব্যাংক ট্রান্সফার', is_cash: 0, sort: 5 },
  { name: 'চেক', is_cash: 0, sort: 6 },
  { name: 'কার্ড', is_cash: 0, sort: 7 },
];

const EXPENSE_CATEGORIES = [
  'দোকান ভাড়া',
  'বিদ্যুৎ বিল',
  'কর্মচারী বেতন',
  'পরিবহন খরচ',
  'মেরামত খরচ',
  'ইন্টারনেট বিল',
  'প্যাকেজিং খরচ',
  'ডেলিভারি খরচ',
];

export function seedReferenceData(db: Db): void {
  const now = nowUtc();

  const insertUnit = db.prepare(
    'INSERT OR IGNORE INTO units (name, short_name, base_unit_id, factor_milli, is_system, is_active) VALUES (?,?,?,?,?,1)',
  );
  // Two passes: base units first so that derived units can reference them.
  for (const u of UNITS.filter((x) => !x.base)) {
    insertUnit.run(u.name, u.short_name, null, u.factor_milli, 1);
  }
  for (const u of UNITS.filter((x) => x.base)) {
    const parent = db.prepare('SELECT id FROM units WHERE name = ?').get(u.base) as { id: number } | undefined;
    insertUnit.run(u.name, u.short_name, parent?.id ?? null, u.factor_milli, 1);
  }

  const insertPm = db.prepare(
    'INSERT OR IGNORE INTO payment_methods (name, is_cash, is_active, is_system, sort_order) VALUES (?,?,1,1,?)',
  );
  for (const pm of PAYMENT_METHODS) insertPm.run(pm.name, pm.is_cash, pm.sort);

  const insertEc = db.prepare('INSERT OR IGNORE INTO expense_categories (name, is_active) VALUES (?,1)');
  for (const c of EXPENSE_CATEGORIES) insertEc.run(c);

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?,?,?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insertSetting.run(key, serializeSetting(value), now);
  }
}

export function serializeSetting(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
