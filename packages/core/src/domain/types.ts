/**
 * Sauda Retail Suite — core domain model types.
 * Pure TypeScript: no Node.js or Electron imports, safe to use in the renderer.
 *
 * Money:  all monetary values are integers in POISA (1 BDT = 100 poisa).
 * Qty:    all quantities are integers in MILLI units (value * 1000).
 * Cost:   weighted average cost is stored as MICRO poisa per base unit
 *         (1 poisa = 1_000_000 micro). See domain/money.ts for the formulas.
 */

export type Id = number;
export type ISO = string;

export type UserRole = 'admin' | 'manager' | 'cashier';

export interface User {
  id: Id;
  username: string;
  full_name: string;
  role: UserRole;
  permissions: string[];
  is_active: 0 | 1;
  created_at: ISO;
  updated_at: ISO;
  last_login_at: ISO | null;
}

export interface SessionInfo {
  token: string;
  user: User;
  started_at: ISO;
}

export interface AuditLog {
  id: Id;
  user_id: Id | null;
  username: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  details: string | null;
  created_at: ISO;
}

export interface Category {
  id: Id;
  name: string;
  parent_id: Id | null;
  is_active: 0 | 1;
  created_at: ISO;
}

export interface Brand {
  id: Id;
  name: string;
  is_active: 0 | 1;
}

export interface Unit {
  id: Id;
  name: string;
  short_name: string;
  base_unit_id: Id | null;
  factor_milli: number;
  is_system: 0 | 1;
  is_active: 0 | 1;
}

export type DiscountType = 'none' | 'percent' | 'fixed';

export interface Product {
  id: Id;
  name: string;
  sku: string | null;
  product_code: string | null;
  category_id: Id | null;
  subcategory_id: Id | null;
  brand_id: Id | null;
  unit_id: Id;
  primary_unit_id: Id | null;
  purchase_price: number;
  sale_price: number;
  wholesale_price: number | null;
  retail_price: number | null;
  special_price: number | null;
  discount_type: DiscountType;
  discount_value: number;
  stock_base_milli: number;
  min_stock_base_milli: number;
  opening_stock_base_milli: number;
  avg_cost_micro: number;
  vat_percent_x100: number;
  description: string | null;
  image_path: string | null;
  batch_tracked: 0 | 1;
  expiry_tracked: 0 | 1;
  variant_parent_id: Id | null;
  variant_attributes: string | null;
  is_active: 0 | 1;
  created_at: ISO;
  updated_at: ISO;
}

export interface ProductWithMeta extends Product {
  category_name: string | null;
  subcategory_name: string | null;
  brand_name: string | null;
  unit_short_name: string | null;
  primary_unit_short_name: string | null;
  unit_factor_milli: number | null;
  /** Factor of the product's selling unit (NULL-safe in SQL). */
  sale_unit_factor_milli?: number | null;
  /** Price before any product-level offer, per primary unit (poisa). */
  base_price_paisa?: number;
  /** Effective price after the product offer, per primary unit (poisa). */
  final_price_paisa?: number;
  /** Effective price per the product's selling unit (poisa) — what POS charges. */
  unit_price_paisa?: number;
  primary_factor_milli?: number;
  offer_active?: 0 | 1;
  barcodes?: string[];
}

export interface Barcode {
  id: Id;
  product_id: Id;
  code: string;
  kind: 'barcode' | 'qr';
  is_primary: 0 | 1;
  created_at: ISO;
}

export type StockMovementType =
  | 'opening'
  | 'purchase'
  | 'sale'
  | 'sale_return'
  | 'purchase_return'
  | 'adjustment'
  | 'damage'
  | 'expiry'
  | 'transfer';

export interface StockMovement {
  id: Id;
  product_id: Id;
  type: StockMovementType;
  qty_base_milli: number;
  balance_after_milli: number;
  ref_type: string | null;
  ref_id: string | null;
  reason: string | null;
  note: string | null;
  user_id: Id | null;
  username?: string | null;
  product_name?: string;
  unit_label?: string | null;
  created_at: ISO;
}

export interface Customer {
  id: Id;
  name: string;
  phone: string | null;
  address: string | null;
  opening_balance_paisa: number;
  balance_paisa: number;
  is_walkin: 0 | 1;
  note: string | null;
  is_active: 0 | 1;
  created_at: ISO;
  updated_at: ISO;
  /** v1.0.1 fields (added by migration v2; 0 when not set). */
  credit_limit_paisa?: number;
  group_name?: string | null;
  price_level?: 'retail' | 'wholesale' | 'special';
  loyalty_points?: number;
  birthday?: string | null;
  visit_count?: number;
  total_spent_paisa?: number;
}

export interface Supplier {
  id: Id;
  name: string;
  company: string | null;
  phone: string | null;
  address: string | null;
  email: string | null;
  contact_person: string | null;
  opening_balance_paisa: number;
  balance_paisa: number;
  note: string | null;
  is_active: 0 | 1;
  created_at: ISO;
  updated_at: ISO;
}

export interface PaymentMethod {
  id: Id;
  name: string;
  is_cash: 0 | 1;
  is_active: 0 | 1;
  is_system: 0 | 1;
  sort_order: number;
}

export interface Payment {
  id: Id;
  kind: string;
  party_type: 'customer' | 'supplier' | 'none';
  customer_id: Id | null;
  supplier_id: Id | null;
  sale_id: Id | null;
  purchase_id: Id | null;
  invoice_no?: string | null;
  party_name?: string | null;
  amount_paisa: number;
  method_id: Id | null;
  method_name?: string | null;
  reference: string | null;
  note: string | null;
  user_id: Id | null;
  username?: string | null;
  payment_date: ISO;
  direction: 'in' | 'out';
  status: 'active' | 'reversed';
  reverses_id: Id | null;
  cash_session_id: Id | null;
  created_at: ISO;
}

export interface SaleItem {
  id: Id;
  sale_id: Id;
  product_id: Id;
  product_name: string;
  unit_id: Id;
  unit_short_name?: string | null;
  qty_milli: number;
  factor_milli: number;
  qty_base_milli: number;
  unit_price_paisa: number;
  discount_paisa: number;
  line_total_paisa: number;
  cost_micro: number;
  cost_total_paisa: number;
  returned_qty_milli: number;
}

export interface Sale {
  id: Id;
  invoice_no: string;
  customer_id: Id | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  user_id: Id | null;
  cashier_name?: string | null;
  sale_date: ISO;
  subtotal_paisa: number;
  discount_paisa: number;
  tax_paisa: number;
  total_paisa: number;
  paid_paisa: number;
  due_paisa: number;
  change_paisa: number;
  cost_total_paisa: number;
  profit_paisa: number;
  status: 'completed' | 'voided' | 'returned';
  note: string | null;
  cash_session_id: Id | null;
  created_at: ISO;
  items?: SaleItem[];
}

export interface PurchaseItem {
  id: Id;
  purchase_id: Id;
  product_id: Id;
  product_name: string;
  unit_id: Id;
  unit_short_name?: string | null;
  qty_milli: number;
  factor_milli: number;
  qty_base_milli: number;
  unit_price_paisa: number;
  discount_paisa: number;
  line_total_paisa: number;
  returned_qty_milli: number;
}

export interface Purchase {
  id: Id;
  purchase_no: string;
  supplier_id: Id | null;
  supplier_name?: string | null;
  user_id: Id | null;
  user_name?: string | null;
  purchase_date: ISO;
  subtotal_paisa: number;
  discount_paisa: number;
  other_cost_paisa: number;
  total_paisa: number;
  paid_paisa: number;
  due_paisa: number;
  status: 'completed' | 'voided' | 'returned';
  note: string | null;
  cash_session_id: Id | null;
  created_at: ISO;
  items?: PurchaseItem[];
}

export interface ReturnItem {
  id: Id;
  return_id: Id;
  product_id: Id;
  product_name: string;
  qty_milli: number;
  factor_milli: number;
  qty_base_milli: number;
  unit_price_paisa: number;
  line_total_paisa: number;
  condition: 'good' | 'damaged' | 'expired';
  restocked: 0 | 1;
  sale_item_id: Id | null;
  purchase_item_id: Id | null;
}

export interface ReturnDoc {
  id: Id;
  return_no: string;
  kind: 'sale' | 'purchase';
  sale_id: Id | null;
  purchase_id: Id | null;
  ref_no?: string | null;
  party_name?: string | null;
  user_id: Id | null;
  return_date: ISO;
  total_paisa: number;
  refund_paisa: number;
  refund_method_id: Id | null;
  restock: 0 | 1;
  status: 'completed' | 'voided';
  note: string | null;
  created_at: ISO;
  items?: ReturnItem[];
}

export interface ExpenseCategory {
  id: Id;
  name: string;
  is_active: 0 | 1;
}

export interface Expense {
  id: Id;
  category_id: Id | null;
  category_name?: string | null;
  amount_paisa: number;
  method_id: Id | null;
  method_name?: string | null;
  description: string;
  reference: string | null;
  note: string | null;
  expense_date: ISO;
  user_id: Id | null;
  username?: string | null;
  status: 'active' | 'voided';
  cash_session_id: Id | null;
  created_at: ISO;
}

export interface CashSession {
  id: Id;
  user_id: Id | null;
  username?: string | null;
  opened_at: ISO;
  closed_at: ISO | null;
  opening_cash_paisa: number;
  counted_cash_paisa: number | null;
  expected_cash_paisa: number | null;
  difference_paisa: number | null;
  status: 'open' | 'closed';
  note: string | null;
}

export interface CashMovement {
  id: Id;
  session_id: Id;
  direction: 'in' | 'out';
  amount_paisa: number;
  source: string;
  source_id: Id | null;
  note: string | null;
  user_id: Id | null;
  created_at: ISO;
}

export interface PriceHistory {
  id: Id;
  product_id: Id;
  field: string;
  old_value: string | null;
  new_value: string | null;
  user_id: Id | null;
  created_at: ISO;
}

export interface BackupRecord {
  id: Id;
  file_path: string;
  size_bytes: number;
  kind: 'manual' | 'auto' | 'safety' | 'pre_restore';
  app_version: string;
  db_version: number;
  status: 'ok' | 'failed';
  note: string | null;
  created_at: ISO;
}

/* ------------------------------------------------------------------ */
/* Aggregates & reports                                               */
/* ------------------------------------------------------------------ */

export interface DashboardStats {
  today_sales_paisa: number;
  today_profit_paisa: number;
  today_sales_count: number;
  total_sales_paisa: number;
  total_profit_paisa: number;
  total_due_paisa: number;
  total_payable_paisa: number;
  total_customers: number;
  total_suppliers: number;
  total_products: number;
  stock_value_paisa: number;
  total_purchases_paisa: number;
  total_expenses_paisa: number;
  cash_in_hand_paisa: number;
  low_stock_count: number;
  out_of_stock_count: number;
  today_expense_paisa: number;
  today_collection_paisa: number;
}

export interface SeriesPoint {
  label: string;
  iso: string;
  sales_paisa: number;
  profit_paisa: number;
  purchase_paisa: number;
  expense_paisa: number;
}

export interface ActivityItem {
  id: string;
  kind: string;
  title: string;
  subtitle: string;
  amount_paisa: number | null;
  at: ISO;
}

export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface ReportColumn {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  format?: 'money' | 'qty' | 'date' | 'text' | 'int' | 'percent';
  width?: number;
}

export type ReportId =
  | 'sales_daily'
  | 'sales_range'
  | 'profit_loss'
  | 'purchases'
  | 'expenses'
  | 'customer_due'
  | 'supplier_payable'
  | 'stock'
  | 'low_stock'
  | 'out_of_stock'
  | 'stock_valuation'
  | 'product_performance'
  | 'best_selling'
  | 'slow_moving'
  | 'cashier_sales'
  | 'payment_method_sales'
  | 'category_sales'
  | 'customer_sales'
  | 'supplier_purchase'
  | 'cash_register'
  | 'payment_collection'
  | 'stock_movement'
  | 'returns'
  | 'inventory_adjustment'
  | 'sales_detail'
  | 'purchase_detail'
  | 'expense_detail'
  /* v1.0.1 accounting */
  | 'trial_balance'
  | 'ledger_pl'
  | 'balance_sheet'
  | 'cash_flow'
  | 'day_book'
  | 'journal_list'
  | 'account_balances'
  /* v1.0.1 CRM */
  | 'loyalty_report'
  | 'credit_limit_report'
  | 'customer_aging'
  | 'supplier_aging'
  /* v1.0.1 stock ops */
  | 'stock_transfers'
  | 'stock_count_variance'
  | 'reorder_report'
  | 'dead_stock'
  | 'serial_register'
  /* v1.0.1 sales analytics */
  | 'hourly_sales'
  | 'discount_report'
  | 'tax_summary';

export interface ReportFilter {
  from?: string;
  to?: string;
  category_id?: number | null;
  brand_id?: number | null;
  user_id?: number | null;
  customer_id?: number | null;
  supplier_id?: number | null;
  product_id?: number | null;
  payment_method_id?: number | null;
  search?: string;
  limit?: number;
}

export interface ReportResult {
  id: ReportId;
  title: string;
  subtitle: string;
  columns: ReportColumn[];
  rows: Record<string, any>[];
  totals: Record<string, number | string>;
  chart?: SeriesPoint[];
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

export interface AppSettings {
  business_name: string;
  business_logo: string | null;
  business_address: string;
  business_phone: string;
  business_email: string;
  receipt_width: 58 | 80;
  receipt_font_size: number;
  receipt_header: string;
  receipt_footer: string;
  receipt_show_logo: 0 | 1;
  receipt_bengali: 0 | 1;
  invoice_prefix: string;
  invoice_format: string;
  invoice_separator: string;
  purchase_prefix: string;
  return_prefix: string;
  default_customer_id: number | null;
  default_payment_method_id: number | null;
  default_unit_id: number | null;
  default_category_id: number | null;
  stock_alert_threshold_milli: number;
  allow_negative_stock: 0 | 1;
  allow_due_sale: 0 | 1;
  max_discount_percent_x100: number;
  vat_percent_x100: number;
  currency_symbol: string;
  bengali_digits: 0 | 1;
  date_format: string;
  printer_name: string;
  print_after_sale: 0 | 1;
  auto_backup_enabled: 0 | 1;
  auto_backup_interval: 'daily' | 'weekly' | 'monthly' | 'off';
  auto_backup_dir: string;
  backup_keep_count: number;
  scan_increment_qty: 0 | 1;
  session_timeout_minutes: number;
  low_margin_warn_percent_x100: number;
  // v1.0.1
  loyalty_enabled: number;
  loyalty_points_per_100: number;
  loyalty_redeem_value_paisa: number;
  loyalty_min_redeem_points: number;
  credit_limit_enforced: number;
  theme: string;
  duplicate_sale_guard_seconds: number;
  tax_register_enabled: number;
  accounting_enabled: number;
  // v1.1
  business_website: string;
  business_type: string;
  document_footer: string;
  language: 'bn' | 'en';
  login_lock_enabled: 0 | 1;
  customer_display_enabled: 0 | 1;
  gift_card_expiry_days: number;
  lan_mode: 'off' | 'host' | 'terminal';
  lan_port: number;
  lan_token: string;
  lan_host_url: string;
  receipt_show_qr: 0 | 1;
}

export interface AppInfo {
  name: string;
  version: string;
  build: string;
  channel: string;
  company: string;
  founder: string;
  email: string;
  copyright: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  db_version: number;
  db_path: string;
  data_dir: string;
  logs_dir: string;
}

/* ------------------------------------------------------------------ */
/* Licensing                                                          */
/* ------------------------------------------------------------------ */

export interface LicensePayload {
  v: 1;
  license_id: string;
  org: string;
  owner?: string;
  phone?: string;
  email?: string;
  address?: string;
  edition: 'standard' | 'pro' | 'enterprise';
  issued_at: string;
  expires_at: string | null;
  max_devices: number;
  /** SHA-256 hash of the licensed device's component list. */
  fingerprint: string;
  /** Per-component hashes so weighted matching works fully offline. */
  device_components: { key: string; hash: string; weight: number }[];
  fingerprint_version: number;
  features: string[];
  note?: string;
  generator: string;
}

export interface SignedLicense {
  payload: LicensePayload;
  sig: string;
  key_id: string;
}

export interface DeviceFingerprintComponent {
  key: string;
  label: string;
  value: string;
  weight: number;
  available: boolean;
}

export interface DeviceFingerprint {
  version: number;
  hash: string;
  components: { key: string; hash: string; weight: number }[];
  collected_at: string;
  platform: string;
}

export interface ActivationState {
  activated: boolean;
  reason:
    | 'ok'
    | 'not_activated'
    | 'signature_invalid'
    | 'schema_invalid'
    | 'expired'
    | 'device_mismatch'
    | 'org_mismatch'
    | 'version_unsupported'
    | 'clock_tamper'
    | 'error';
  message: string;
  license: LicensePayload | null;
  device: DeviceFingerprint;
  match_score?: number;
  activated_at?: string | null;
  days_left?: number | null;
}
