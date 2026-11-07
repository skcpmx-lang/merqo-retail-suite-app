/**
 * Sauda Retail Suite — SQLite schema (version 1).
 *
 * Conventions
 *  - Money          INTEGER, poisa (1 BDT = 100 poisa)
 *  - Quantity       INTEGER, milli units (value × 1000)
 *  - Cost           INTEGER, micro poisa per BASE unit (1 poisa = 1e6 micro)
 *  - Timestamps     TEXT, local wall clock "YYYY-MM-DD HH:mm:ss" for business
 *                   documents, UTC ISO for technical/audit records
 *  - Soft delete    `is_active` / `status` columns — financial documents are
 *                   never hard-deleted, they are voided with an audit record
 */

export const SCHEMA_VERSION = 7;

export const SCHEMA_V1 = /* sql */ `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','manager','cashier')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  permissions   TEXT NOT NULL DEFAULT '[]',
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions_log (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL,
  ended_at     TEXT,
  ip_note      TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  username   TEXT,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  details    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity, entity_id);

-- The audit trail is append-only, enforced by the database rather than by everyone remembering not to
-- write the statement (v1.2.0 security audit, SEC-02). No product code updates or deletes these rows;
-- a trigger means a future feature, a repair script or a compromised session cannot either. Rows can
-- still be removed by dropping the trigger with a direct SQLite session and the file — that is the
-- honest limit of an unencrypted local database, and it is documented in the threat model.
CREATE TRIGGER IF NOT EXISTS audit_logs_append_only_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_logs_append_only_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;

CREATE TABLE IF NOT EXISTS payment_methods (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  is_cash    INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1,
  is_system  INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS units (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  short_name   TEXT NOT NULL,
  base_unit_id INTEGER REFERENCES units(id),
  factor_milli INTEGER NOT NULL DEFAULT 1000,
  is_system    INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1,
  UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  name_sort  TEXT NOT NULL DEFAULT '',
  parent_id  INTEGER REFERENCES categories(id),
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(name, parent_id)
);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

CREATE TABLE IF NOT EXISTS brands (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id                      INTEGER PRIMARY KEY,
  name                    TEXT NOT NULL,
  name_sort               TEXT NOT NULL DEFAULT '',
  search_text             TEXT NOT NULL DEFAULT '',
  sku                     TEXT UNIQUE,
  product_code            TEXT UNIQUE,
  category_id             INTEGER REFERENCES categories(id),
  subcategory_id          INTEGER REFERENCES categories(id),
  brand_id                INTEGER REFERENCES brands(id),
  unit_id                 INTEGER NOT NULL REFERENCES units(id),
  primary_unit_id         INTEGER REFERENCES units(id),
  purchase_price          INTEGER NOT NULL DEFAULT 0,
  sale_price              INTEGER NOT NULL DEFAULT 0,
  wholesale_price         INTEGER,
  retail_price            INTEGER,
  special_price           INTEGER,
  discount_type           TEXT NOT NULL DEFAULT 'none' CHECK (discount_type IN ('none','percent','fixed')),
  discount_value          INTEGER NOT NULL DEFAULT 0,
  stock_base_milli        INTEGER NOT NULL DEFAULT 0,
  min_stock_base_milli    INTEGER NOT NULL DEFAULT 0,
  opening_stock_base_milli INTEGER NOT NULL DEFAULT 0,
  opening_cost_micro      INTEGER NOT NULL DEFAULT 0,
  avg_cost_micro          INTEGER NOT NULL DEFAULT 0,
  vat_percent_x100        INTEGER NOT NULL DEFAULT 0,
  description             TEXT,
  image_path              TEXT,
  batch_tracked           INTEGER NOT NULL DEFAULT 0,
  expiry_tracked          INTEGER NOT NULL DEFAULT 0,
  variant_parent_id       INTEGER REFERENCES products(id),
  variant_attributes      TEXT,
  is_active               INTEGER NOT NULL DEFAULT 1,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_subcategory ON products(subcategory_id);
CREATE INDEX IF NOT EXISTS idx_products_sort ON products(name_sort);
CREATE INDEX IF NOT EXISTS idx_products_search ON products(search_text);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active);
CREATE INDEX IF NOT EXISTS idx_products_parent ON products(variant_parent_id);

CREATE TABLE IF NOT EXISTS product_barcodes (
  id         INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  code       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL DEFAULT 'barcode' CHECK (kind IN ('barcode','qr')),
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_barcodes_product ON product_barcodes(product_id);

CREATE TABLE IF NOT EXISTS batches (
  id             INTEGER PRIMARY KEY,
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  batch_no       TEXT NOT NULL,
  expiry_date    TEXT,
  qty_base_milli INTEGER NOT NULL DEFAULT 0,
  cost_micro     INTEGER NOT NULL DEFAULT 0,
  purchase_id    INTEGER,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batches_product ON batches(product_id);
CREATE INDEX IF NOT EXISTS idx_batches_expiry ON batches(expiry_date);

CREATE TABLE IF NOT EXISTS stock_movements (
  id                 INTEGER PRIMARY KEY,
  product_id         INTEGER NOT NULL REFERENCES products(id),
  type               TEXT NOT NULL,
  qty_base_milli     INTEGER NOT NULL,
  balance_after_milli INTEGER NOT NULL,
  unit_label         TEXT,
  qty_input_milli     INTEGER,
  ref_type           TEXT,
  ref_id             TEXT,
  reason             TEXT,
  note               TEXT,
  user_id            INTEGER REFERENCES users(id),
  batch_id           INTEGER REFERENCES batches(id),
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mov_product ON stock_movements(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mov_created ON stock_movements(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mov_type ON stock_movements(type);

CREATE TABLE IF NOT EXISTS customers (
  id                    INTEGER PRIMARY KEY,
  name                  TEXT NOT NULL,
  name_sort             TEXT NOT NULL DEFAULT '',
  search_text           TEXT NOT NULL DEFAULT '',
  phone                 TEXT,
  address               TEXT,
  opening_balance_paisa INTEGER NOT NULL DEFAULT 0,
  balance_paisa         INTEGER NOT NULL DEFAULT 0,
  is_walkin             INTEGER NOT NULL DEFAULT 0,
  note                  TEXT,
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_search ON customers(search_text);
CREATE INDEX IF NOT EXISTS idx_customers_sort ON customers(name_sort);

CREATE TABLE IF NOT EXISTS suppliers (
  id                    INTEGER PRIMARY KEY,
  name                  TEXT NOT NULL,
  name_sort             TEXT NOT NULL DEFAULT '',
  search_text           TEXT NOT NULL DEFAULT '',
  company               TEXT,
  phone                 TEXT,
  address               TEXT,
  email                 TEXT,
  contact_person        TEXT,
  opening_balance_paisa INTEGER NOT NULL DEFAULT 0,
  balance_paisa         INTEGER NOT NULL DEFAULT 0,
  note                  TEXT,
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suppliers_phone ON suppliers(phone);
CREATE INDEX IF NOT EXISTS idx_suppliers_search ON suppliers(search_text);

CREATE TABLE IF NOT EXISTS counters (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cash_sessions (
  id                 INTEGER PRIMARY KEY,
  user_id            INTEGER REFERENCES users(id),
  opened_at          TEXT NOT NULL,
  closed_at          TEXT,
  opening_cash_paisa INTEGER NOT NULL DEFAULT 0,
  counted_cash_paisa INTEGER,
  expected_cash_paisa INTEGER,
  difference_paisa   INTEGER,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  note               TEXT
);
CREATE INDEX IF NOT EXISTS idx_cash_sessions_status ON cash_sessions(status);

CREATE TABLE IF NOT EXISTS sales (
  id               INTEGER PRIMARY KEY,
  invoice_no       TEXT NOT NULL UNIQUE,
  customer_id      INTEGER REFERENCES customers(id),
  user_id          INTEGER REFERENCES users(id),
  sale_date        TEXT NOT NULL,
  subtotal_paisa   INTEGER NOT NULL DEFAULT 0,
  discount_paisa   INTEGER NOT NULL DEFAULT 0,
  tax_paisa        INTEGER NOT NULL DEFAULT 0,
  total_paisa      INTEGER NOT NULL DEFAULT 0,
  paid_paisa       INTEGER NOT NULL DEFAULT 0,
  due_paisa        INTEGER NOT NULL DEFAULT 0,
  change_paisa     INTEGER NOT NULL DEFAULT 0,
  cost_total_paisa INTEGER NOT NULL DEFAULT 0,
  profit_paisa     INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided','returned')),
  note             TEXT,
  cash_session_id  INTEGER REFERENCES cash_sessions(id),
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);
CREATE INDEX IF NOT EXISTS idx_sales_user ON sales(user_id);

CREATE TABLE IF NOT EXISTS sale_items (
  id                INTEGER PRIMARY KEY,
  sale_id           INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id        INTEGER NOT NULL REFERENCES products(id),
  product_name      TEXT NOT NULL,
  unit_id           INTEGER REFERENCES units(id),
  unit_label        TEXT,
  qty_milli         INTEGER NOT NULL,
  factor_milli      INTEGER NOT NULL DEFAULT 1000,
  qty_base_milli    INTEGER NOT NULL,
  unit_price_paisa  INTEGER NOT NULL,
  discount_paisa    INTEGER NOT NULL DEFAULT 0,
  line_total_paisa  INTEGER NOT NULL,
  cost_micro        INTEGER NOT NULL DEFAULT 0,
  cost_total_paisa  INTEGER NOT NULL DEFAULT 0,
  returned_qty_milli INTEGER NOT NULL DEFAULT 0,
  batch_id          INTEGER REFERENCES batches(id)
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);

CREATE TABLE IF NOT EXISTS purchases (
  id                 INTEGER PRIMARY KEY,
  purchase_no        TEXT NOT NULL UNIQUE,
  supplier_id        INTEGER REFERENCES suppliers(id),
  user_id            INTEGER REFERENCES users(id),
  purchase_date      TEXT NOT NULL,
  subtotal_paisa     INTEGER NOT NULL DEFAULT 0,
  discount_paisa     INTEGER NOT NULL DEFAULT 0,
  other_cost_paisa   INTEGER NOT NULL DEFAULT 0,
  total_paisa        INTEGER NOT NULL DEFAULT 0,
  paid_paisa         INTEGER NOT NULL DEFAULT 0,
  due_paisa          INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided','returned')),
  note               TEXT,
  cash_session_id    INTEGER REFERENCES cash_sessions(id),
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchase_date);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id);

CREATE TABLE IF NOT EXISTS purchase_items (
  id                INTEGER PRIMARY KEY,
  purchase_id       INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id        INTEGER NOT NULL REFERENCES products(id),
  product_name      TEXT NOT NULL,
  unit_id           INTEGER REFERENCES units(id),
  unit_label        TEXT,
  qty_milli         INTEGER NOT NULL,
  factor_milli      INTEGER NOT NULL DEFAULT 1000,
  qty_base_milli    INTEGER NOT NULL,
  unit_price_paisa  INTEGER NOT NULL,
  discount_paisa    INTEGER NOT NULL DEFAULT 0,
  line_total_paisa  INTEGER NOT NULL,
  returned_qty_milli INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_product ON purchase_items(product_id);

CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL,
  party_type      TEXT NOT NULL DEFAULT 'none' CHECK (party_type IN ('customer','supplier','none')),
  customer_id     INTEGER REFERENCES customers(id),
  supplier_id     INTEGER REFERENCES suppliers(id),
  sale_id         INTEGER REFERENCES sales(id),
  purchase_id     INTEGER REFERENCES purchases(id),
  amount_paisa    INTEGER NOT NULL,
  method_id       INTEGER REFERENCES payment_methods(id),
  reference       TEXT,
  note            TEXT,
  user_id         INTEGER REFERENCES users(id),
  payment_date    TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('in','out')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','reversed')),
  reverses_id     INTEGER REFERENCES payments(id),
  cash_session_id INTEGER REFERENCES cash_sessions(id),
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_supplier ON payments(supplier_id);
CREATE INDEX IF NOT EXISTS idx_payments_sale ON payments(sale_id);
CREATE INDEX IF NOT EXISTS idx_payments_purchase ON payments(purchase_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

CREATE TABLE IF NOT EXISTS returns (
  id               INTEGER PRIMARY KEY,
  return_no        TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL CHECK (kind IN ('sale','purchase')),
  sale_id          INTEGER REFERENCES sales(id),
  purchase_id      INTEGER REFERENCES purchases(id),
  customer_id      INTEGER REFERENCES customers(id),
  supplier_id      INTEGER REFERENCES suppliers(id),
  user_id          INTEGER REFERENCES users(id),
  return_date      TEXT NOT NULL,
  total_paisa      INTEGER NOT NULL DEFAULT 0,
  cost_total_paisa INTEGER NOT NULL DEFAULT 0,
  refund_paisa     INTEGER NOT NULL DEFAULT 0,
  refund_method_id INTEGER REFERENCES payment_methods(id),
  restock          INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
  note             TEXT,
  cash_session_id  INTEGER REFERENCES cash_sessions(id),
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_returns_date ON returns(return_date);
CREATE INDEX IF NOT EXISTS idx_returns_kind ON returns(kind);

CREATE TABLE IF NOT EXISTS return_items (
  id               INTEGER PRIMARY KEY,
  return_id        INTEGER NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  sale_item_id     INTEGER REFERENCES sale_items(id),
  purchase_item_id INTEGER REFERENCES purchase_items(id),
  product_id       INTEGER NOT NULL REFERENCES products(id),
  product_name     TEXT NOT NULL,
  unit_label       TEXT,
  qty_milli        INTEGER NOT NULL,
  factor_milli     INTEGER NOT NULL DEFAULT 1000,
  qty_base_milli   INTEGER NOT NULL,
  unit_price_paisa INTEGER NOT NULL,
  line_total_paisa INTEGER NOT NULL,
  cost_micro       INTEGER NOT NULL DEFAULT 0,
  cost_total_paisa INTEGER NOT NULL DEFAULT 0,
  condition        TEXT NOT NULL DEFAULT 'good' CHECK (condition IN ('good','damaged','expired')),
  restocked        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_return_items_return ON return_items(return_id);

CREATE TABLE IF NOT EXISTS expense_categories (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS expenses (
  id              INTEGER PRIMARY KEY,
  category_id     INTEGER REFERENCES expense_categories(id),
  amount_paisa    INTEGER NOT NULL,
  method_id       INTEGER REFERENCES payment_methods(id),
  description     TEXT NOT NULL,
  reference       TEXT,
  note            TEXT,
  expense_date    TEXT NOT NULL,
  user_id         INTEGER REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
  cash_session_id INTEGER REFERENCES cash_sessions(id),
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);

CREATE TABLE IF NOT EXISTS cash_movements (
  id           INTEGER PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES cash_sessions(id),
  direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
  amount_paisa INTEGER NOT NULL,
  source       TEXT NOT NULL,
  source_id    INTEGER,
  note         TEXT,
  user_id      INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_mov_session ON cash_movements(session_id);

CREATE TABLE IF NOT EXISTS price_history (
  id         INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  field      TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  user_id    INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_price_history_product ON price_history(product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS backups (
  id         INTEGER PRIMARY KEY,
  file_path  TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  kind       TEXT NOT NULL,
  app_version TEXT NOT NULL,
  db_version INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'ok',
  note       TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activations (
  id           INTEGER PRIMARY KEY,
  license_id   TEXT NOT NULL,
  license_key  TEXT,
  payload      TEXT NOT NULL,
  signature    TEXT NOT NULL,
  device_hash  TEXT NOT NULL,
  org          TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  last_check_at TEXT
);

CREATE TABLE IF NOT EXISTS restore_log (
  id         INTEGER PRIMARY KEY,
  file_path  TEXT NOT NULL,
  status     TEXT NOT NULL,
  message    TEXT,
  created_at TEXT NOT NULL
);
`;

/* ------------------------------------------------------------------ */
/* Schema v2 — v1.0.1 "Advanced Retail & Business Edition"             */
/*                                                                     */
/* Additive only: new tables and new nullable/defaulted columns. The   */
/* v1 tables keep their shape so a shop can roll back by restoring the */
/* automatic pre-migration backup.                                     */
/* ------------------------------------------------------------------ */

export const SCHEMA_V2 = /* sql */ `
/* ---------- accounting (double entry) ---------- */
CREATE TABLE IF NOT EXISTS accounts (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  name_bn    TEXT NOT NULL DEFAULT '',
  type       TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  parent_id  INTEGER REFERENCES accounts(id),
  is_cash    INTEGER NOT NULL DEFAULT 0,
  is_bank    INTEGER NOT NULL DEFAULT 0,
  is_system  INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1,
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_type ON accounts(type);

CREATE TABLE IF NOT EXISTS journal_entries (
  id          INTEGER PRIMARY KEY,
  entry_no    TEXT NOT NULL UNIQUE,
  entry_date  TEXT NOT NULL,
  source      TEXT NOT NULL,
  source_id   INTEGER,
  memo        TEXT,
  status      TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  reverses_id INTEGER REFERENCES journal_entries(id),
  user_id     INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_date ON journal_entries(entry_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_source_ref ON journal_entries(source, source_id);

CREATE TABLE IF NOT EXISTS journal_lines (
  id           INTEGER PRIMARY KEY,
  entry_id     INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  debit_paisa  INTEGER NOT NULL DEFAULT 0,
  credit_paisa INTEGER NOT NULL DEFAULT 0,
  memo         TEXT,
  line_no      INTEGER NOT NULL DEFAULT 0,
  CHECK (debit_paisa >= 0 AND credit_paisa >= 0),
  CHECK ((debit_paisa = 0) <> (credit_paisa = 0))
);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id);

/* ---------- stock locations ---------- */
CREATE TABLE IF NOT EXISTS locations (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL DEFAULT 'shop' CHECK (kind IN ('shop','godown','warehouse')),
  address    TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_levels (
  product_id     INTEGER NOT NULL REFERENCES products(id),
  location_id    INTEGER NOT NULL REFERENCES locations(id),
  qty_base_milli INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_levels_location ON stock_levels(location_id);

CREATE TABLE IF NOT EXISTS stock_transfers (
  id             INTEGER PRIMARY KEY,
  transfer_no    TEXT NOT NULL UNIQUE,
  from_location  INTEGER NOT NULL REFERENCES locations(id),
  to_location    INTEGER NOT NULL REFERENCES locations(id),
  transfer_date  TEXT NOT NULL,
  note           TEXT,
  user_id        INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transfers_date ON stock_transfers(transfer_date);

CREATE TABLE IF NOT EXISTS stock_transfer_items (
  id          INTEGER PRIMARY KEY,
  transfer_id INTEGER NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  qty_base_milli INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transfer_items_transfer ON stock_transfer_items(transfer_id);

CREATE TABLE IF NOT EXISTS stock_counts (
  id          INTEGER PRIMARY KEY,
  count_no    TEXT NOT NULL UNIQUE,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled')),
  note        TEXT,
  user_id     INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL,
  posted_at   TEXT
);

CREATE TABLE IF NOT EXISTS stock_count_items (
  id             INTEGER PRIMARY KEY,
  count_id       INTEGER NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  product_id     INTEGER NOT NULL REFERENCES products(id),
  system_qty_milli INTEGER NOT NULL,
  counted_qty_milli INTEGER NOT NULL,
  UNIQUE (count_id, product_id)
);

/* ---------- POS hold / resume ---------- */
CREATE TABLE IF NOT EXISTS held_sales (
  id           INTEGER PRIMARY KEY,
  ref_no       TEXT NOT NULL UNIQUE,
  customer_id  INTEGER REFERENCES customers(id),
  lines_json   TEXT NOT NULL,
  note         TEXT,
  total_paisa  INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','resumed','cancelled')),
  user_id      INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL,
  resumed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_held_status ON held_sales(status);

/* ---------- loyalty ---------- */
CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id          INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  points      INTEGER NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('earn','redeem','reverse','expire','adjust')),
  ref_type    TEXT,
  ref_id      INTEGER,
  note        TEXT,
  user_id     INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loyalty_customer ON loyalty_ledger(customer_id, created_at);

/* ---------- serial numbers (IMEI / engine no.) ---------- */
CREATE TABLE IF NOT EXISTS serial_numbers (
  id          INTEGER PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  serial      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'in_stock'
              CHECK (status IN ('in_stock','sold','returned','damaged','transferred')),
  location_id INTEGER REFERENCES locations(id),
  purchase_id INTEGER REFERENCES purchases(id),
  sale_id     INTEGER REFERENCES sales(id),
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (product_id, serial)
);
CREATE INDEX IF NOT EXISTS idx_serials_product ON serial_numbers(product_id, status);

/* ---------- bundles / composite items ---------- */
CREATE TABLE IF NOT EXISTS product_bundles (
  parent_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  child_id       INTEGER NOT NULL REFERENCES products(id),
  qty_base_milli INTEGER NOT NULL,
  PRIMARY KEY (parent_id, child_id)
);

/* ---------- custom roles & attendance ---------- */
CREATE TABLE IF NOT EXISTS role_templates (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  base_role   TEXT NOT NULL DEFAULT 'cashier' CHECK (base_role IN ('admin','manager','cashier')),
  permissions TEXT NOT NULL DEFAULT '[]',
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  clock_in   TEXT NOT NULL,
  clock_out  TEXT,
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attendance_user ON attendance(user_id, clock_in);
`;
