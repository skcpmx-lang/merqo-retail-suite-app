# ডাটাবেজ স্কিমা

**SQLite 3** (WAL মোড), `SCHEMA_VERSION = 1`, ৩০ টেবিল, ৪৩ ইনডেক্স।
স্কিমা: `packages/core/src/db/schema.ts`; খোলা/মাইগ্রেশন/লেনদেন: `connection.ts`।

## একক নিয়ম

| বিষয় | নিয়ম |
|---|---|
| টাকা | `INTEGER` poisa |
| পরিমাণ | `INTEGER` milli (base unit) |
| কস্ট | `INTEGER` micro poisa / base unit |
| ব্যবসার সময় | `TEXT` `YYYY-MM-DD HH:mm:ss` (লোকাল) |
| টেকনিক্যাল সময় | `TEXT` ISO-8601 UTC |
| ডিলিট | নেই — `is_active` বা `status IN ('completed','voided')` |
| অডিট | প্রতিটি পরিবর্তন `audit_logs`-এ |

## টেবিল তালিকা

### কোর ও সেটিংস

| টেবিল | মূল কলাম | নোট |
|---|---|---|
| `meta` | key/value | install_id, first_run_at, license.max_seen, initialized_at |
| `settings` | key/value/updated_at | সব কনফিগ (রিসিট, ইনভয়েস, ভ্যাট, ব্যাকআপ…) |
| `users` | username UNIQUE, role CHECK, password_hash/salt, permissions JSON | RBAC |
| `sessions_log` | user_id, created_at, ended_at | লগইন ইতিহাস |
| `audit_logs` | action, entity, entity_id, details JSON, created_at | ইন্ডেক্স: created DESC, (entity, entity_id) |
| `counters` | name, value | ইনভয়েস/পারচেজ/রিটার্ন সিরিজ |

### ক্যাটালগ

| টেবিল | নোট |
|---|---|
| `payment_methods` | is_cash, is_system, sort_order |
| `units` | base_unit_id + factor_milli (কেজি→গ্রাম ১০০০০০০) |
| `categories` | parent_id (এক স্তর সাব) |
| `brands` | name |
| `products` | ২৫+ কলাম: মূল্য স্তর, ডিসকাউন্ট, `stock_base_milli`, `avg_cost_micro`, `min_stock_base_milli`, `vat_percent_x100`, `batch_tracked`, `expiry_tracked` |
| `product_barcodes` | code UNIQUE, kind ('barcode'/'qr'), is_primary |
| `batches` | batch_no, expiry_date, qty |
| `price_history` | field, old_value, new_value, user_id |

### লেনদেন

| টেবিল | নোট |
|---|---|
| `sales` | invoice_no UNIQUE, subtotal/discount/tax/total/paid/due/change, `cost_total_paisa`, `profit_paisa`, status |
| `sale_items` | qty_milli + factor_milli + qty_base_milli, unit_price, discount, line_total, `cost_micro`, `cost_total_paisa`, `returned_qty_milli` |
| `purchases` | purchase_no UNIQUE, other_cost_paisa, due |
| `purchase_items` | ল্যান্ডেড কস্ট সহ |
| `returns` | kind ('sale'/'purchase'), ref, refund_paisa, restock |
| `return_items` | condition ('good'/'damaged'/'expired'), restocked |
| `payments` | kind, party_type, amount, direction, status ('active'/'reversed'), reverses_id, cash_session_id |
| `expenses` | amount, method, status ('active'/'voided') |
| `expense_categories` | name |

### ইনভেন্টরি ও ক্যাশ

| টেবিল | নোট |
|---|---|
| `stock_movements` | type (opening/purchase/sale/sale_return/purchase_return/adjustment/damage/expiry/transfer), qty_base_milli (signed), balance_after_milli, ref_type/ref_id, reason, user_id |
| `cash_sessions` | opening_cash, expected_cash, counted_cash, difference, status |
| `cash_movements` | session_id, direction ('in'/'out'), source, amount |

### সিস্টেম

| টেবিল | নোট |
|---|---|
| `backups` | file_path, size, kind (manual/auto/safety/pre_restore), db_version, status |
| `activations` | license_id, payload JSON, signature, device_hash, activated_at, last_check_at |
| `restore_log` | রিস্টোর ইতিহাস |

## গুরুত্বপূর্ণ ইনডেক্স

```sql
audit_logs(created_at DESC), audit_logs(entity, entity_id)
products(name_sort), products(sku), products(category_id), products(barcode search)
product_barcodes(code) UNIQUE
sales(invoice_no) UNIQUE, sales(sale_date), sales(customer_id), sales(user_id)
sale_items(sale_id), sale_items(product_id)
purchases(purchase_no) UNIQUE, purchases(purchase_date)
payments(payment_date), payments(customer_id), payments(supplier_id)
stock_movements(product_id, created_at), stock_movements(ref_type, ref_id)
customers(phone), customers(search_text)
expenses(expense_date)
```

## লেনদেনের সীমানা

একটি বিক্রয় = একটি `db.transaction()`:
`sales` + `sale_items` + `stock_movements` + `products` (স্টক/কস্ট) + `payments` +
`customers.balance_paisa` + `cash_movements` + `audit_logs`। মাঝপথে ব্যর্থ হলে সব বাতিল।

## ব্যাকআপ ফরম্যাট

`.saudabak` = `VACUUM INTO` করা সম্পূর্ণ ডাটাবেজ কপি।
সাথে `<name>.json` ম্যানিফেস্ট:

```json
{
  "format": "sauda-backup",
  "v": 1,
  "db_version": 1,
  "app_version": "1.0.0",
  "business_name": "করিম জেনারেল স্টোর",
  "sha256": "…",
  "size_bytes": 123456,
  "counts": { "sales": 1520, "products": 320, "customers": 88 },
  "created_at": "2026-02-01T10:00:00.000Z"
}
```

রিস্টোর: যাচাই (হেডার + sha256 + টেবিল কাউন্ট) → `pre_restore` কপি → `closeDatabase` → ফাইল প্রতিস্থাপন →
`openDatabase` + `integrityCheck` → `restore_log`।

## মাইগ্রেশন নীতি

1. `SCHEMA_VERSION` বাড়ান, নতুন `SCHEMA_Vn` ব্লক যোগ করুন।
2. `migrate()` শুধু সামনের দিকে চলে; প্রতিটি ধাপ idempotent (`IF NOT EXISTS` / কলাম চেক)।
3. পুরোনো ডেটা হারাবে না এমন ডিফল্ট দিন (`ALTER TABLE … DEFAULT` অথবা নতুন টেবিল + ব্যাকফিল)।
4. রিলিজের আগে: পুরোনো `.saudabak` ফাইল দিয়ে রিস্টোর করে নতুন কোডে চালানোর টেস্ট।
