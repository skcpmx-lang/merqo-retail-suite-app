/**
 * Sauda Retail Suite — schema version 3 (v1.1 "Final Professional Business Edition").
 *
 * Only additive structures live here: purchase orders with partial receiving,
 * the promotion engine (coupons, vouchers, gift cards) and the notification
 * feed. Every table follows the same conventions as v1/v2:
 *   money = integer poisa · quantity = integer milli · timestamps = local text
 * and financial rows are voided, never deleted.
 */
export const SCHEMA_V3 = /* sql */ `
/* ---------- purchase orders (ordered ≠ received) ---------- */
CREATE TABLE IF NOT EXISTS purchase_orders (
  id             INTEGER PRIMARY KEY,
  po_no          TEXT NOT NULL UNIQUE,
  supplier_id    INTEGER REFERENCES suppliers(id),
  location_id    INTEGER REFERENCES locations(id),
  order_date     TEXT NOT NULL,
  expected_date  TEXT,
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','partial','received','cancelled')),
  subtotal_paisa INTEGER NOT NULL DEFAULT 0,
  discount_paisa INTEGER NOT NULL DEFAULT 0,
  tax_paisa      INTEGER NOT NULL DEFAULT 0,
  total_paisa    INTEGER NOT NULL DEFAULT 0,
  note           TEXT,
  cancel_reason  TEXT,
  user_id        INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id, status);
CREATE INDEX IF NOT EXISTS idx_po_date ON purchase_orders(order_date);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id                  INTEGER PRIMARY KEY,
  po_id               INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id          INTEGER NOT NULL REFERENCES products(id),
  product_name        TEXT NOT NULL,
  unit_id             INTEGER REFERENCES units(id),
  unit_label          TEXT,
  qty_milli           INTEGER NOT NULL,
  factor_milli        INTEGER NOT NULL DEFAULT 1000,
  qty_base_milli      INTEGER NOT NULL,
  received_base_milli INTEGER NOT NULL DEFAULT 0,
  unit_cost_paisa     INTEGER NOT NULL DEFAULT 0,
  line_total_paisa    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(po_id);
CREATE INDEX IF NOT EXISTS idx_po_items_product ON purchase_order_items(product_id);

CREATE TABLE IF NOT EXISTS purchase_order_receipts (
  id           INTEGER PRIMARY KEY,
  po_id        INTEGER NOT NULL REFERENCES purchase_orders(id),
  purchase_id  INTEGER REFERENCES purchases(id),
  receipt_no   TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  user_id      INTEGER REFERENCES users(id),
  total_paisa  INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_po_receipts_po ON purchase_order_receipts(po_id);

/* ---------- promotions: coupons ---------- */
CREATE TABLE IF NOT EXISTS coupons (
  id                   INTEGER PRIMARY KEY,
  code                 TEXT NOT NULL UNIQUE,
  label                TEXT,
  kind                 TEXT NOT NULL DEFAULT 'percent' CHECK (kind IN ('percent','fixed')),
  value                INTEGER NOT NULL,
  min_purchase_paisa   INTEGER NOT NULL DEFAULT 0,
  max_discount_paisa   INTEGER NOT NULL DEFAULT 0,
  starts_at            TEXT,
  expires_at           TEXT,
  usage_limit          INTEGER NOT NULL DEFAULT 0,
  used_count           INTEGER NOT NULL DEFAULT 0,
  per_customer_limit   INTEGER NOT NULL DEFAULT 0,
  is_active            INTEGER NOT NULL DEFAULT 1,
  note                 TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id             INTEGER PRIMARY KEY,
  coupon_id      INTEGER NOT NULL REFERENCES coupons(id),
  sale_id        INTEGER NOT NULL REFERENCES sales(id),
  customer_id    INTEGER REFERENCES customers(id),
  code           TEXT NOT NULL,
  discount_paisa INTEGER NOT NULL,
  user_id        INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL,
  UNIQUE (sale_id)
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon ON coupon_redemptions(coupon_id);

/* ---------- stored value: gift cards & vouchers ---------- */
CREATE TABLE IF NOT EXISTS gift_cards (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL DEFAULT 'gift_card' CHECK (kind IN ('gift_card','voucher')),
  initial_paisa  INTEGER NOT NULL,
  balance_paisa  INTEGER NOT NULL,
  customer_id    INTEGER REFERENCES customers(id),
  issued_at      TEXT NOT NULL,
  expires_at     TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','expired','void')),
  note           TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gift_cards_status ON gift_cards(status);

CREATE TABLE IF NOT EXISTS gift_card_transactions (
  id                 INTEGER PRIMARY KEY,
  gift_card_id       INTEGER NOT NULL REFERENCES gift_cards(id),
  sale_id            INTEGER REFERENCES sales(id),
  type               TEXT NOT NULL CHECK (type IN ('issue','redeem','refund','adjust','void')),
  amount_paisa       INTEGER NOT NULL,
  balance_after_paisa INTEGER NOT NULL,
  note               TEXT,
  user_id            INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gift_tx_card ON gift_card_transactions(gift_card_id);
CREATE INDEX IF NOT EXISTS idx_gift_tx_sale ON gift_card_transactions(sale_id);

/* ---------- notifications (business alerts, no external service) ---------- */
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','danger','success')),
  title      TEXT NOT NULL,
  body       TEXT,
  entity     TEXT,
  entity_id  INTEGER,
  dedupe_key TEXT UNIQUE,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(is_read, created_at);
`;
