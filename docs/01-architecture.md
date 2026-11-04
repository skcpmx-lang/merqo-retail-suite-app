# আর্কিটেকচার

## এক নজরে

```
┌──────────────────────────────────────────────────────────────┐
│  Electron (packages/app)                                     │
│                                                              │
│  ┌────────────────────────┐      ┌─────────────────────────┐ │
│  │ Renderer (React 19)    │      │ Main process            │ │
│  │ বাংলা UI, কোন হিসাব নয়│─────▶│ IPC রাউটার (১৩৫+)      │ │
│  │ শুধু display + input   │◀─────│ permission guard        │ │
│  └────────────────────────┘      │ printing / dialogs      │ │
│            ▲                     └───────────┬─────────────┘ │
│            │ contextBridge                    │               │
│      window.sauda.{invoke,onEvent}             │               │
└────────────────────────────────────────────────┼──────────────┘
                                                 │
                                    ┌────────────▼─────────────┐
                                    │ @sauda/core              │
                                    │ domain (money/datetime)  │
                                    │ db (schema/migrate/tx)   │
                                    │ services (২২টি)          │
                                    │ licensing / export       │
                                    └────────────┬─────────────┘
                                                 │ better-sqlite3 (sync, ACID)
                                    ┌────────────▼─────────────┐
                                    │ sauda.db (SQLite, WAL)   │
                                    └──────────────────────────┘
```

**মূল নিয়ম:** সব আর্থিক ও পরিমাণগত গণনা `@sauda/core`-এ। রেন্ডারার কখনো টাকার যোগ-বিয়োগ করে না — সে শুধু
`money(paisa)` দিয়ে ফরম্যাট করে দেখায়। এতে UI আর রসিদ/রিপোর্ট কখনো আলাদা সংখ্যা দেখাতে পারে না।

## স্তর

### ১. `domain/` — বিশুদ্ধ টাইপ ও ফর্মুলা

| ফাইল | দায়িত্ব |
|---|---|
| `money.ts` | poisa ↔ taka, `roundDiv` (half-up), ডিসকাউন্ট, VAT, WAC কস্ট, বাংলা অঙ্ক (`normalizeDigits`) |
| `datetime.ts` | লোকাল তারিখ/সময়, দিন-মাস-বছর রেঞ্জ |
| `text.ts` | বাংলা+ইংরেজি সার্চ ফোল্ডিং (`foldForSearch`), বাংলা সর্ট কী |
| `types.ts` | সব ডোমেইন টাইপ (money = int poisa, qty = int milli) |

সংখ্যার একক:

| ধরন | একক | উদাহরণ |
|---|---|---|
| টাকা | poisa (int) | ৳ ১২.৫০ = `1250` |
| পরিমাণ | milli of base unit | ১ কেজি = `1000000` (বেস গ্রাম) |
| কস্ট | micro poisa / base unit | ৳ ১/গ্রাম = `100000000` |

### ২. `db/` — স্কিমা, মাইগ্রেশন, লেনদেন

- `schema.ts` — ৩০ টেবিল, ৪৩ ইনডেক্স, সব `IF NOT EXISTS` (idempotent)।
- `connection.ts` — `openDatabase()` (WAL, `foreign_keys=ON`, busy timeout), `migrate()` (versioned),
  `tx()` helper, `nextCounter()` (ইনভয়েস নম্বর), `integrityCheck()`, `repairDatabase()` (REINDEX+VACUUM)।
- `seed.ts` — ডিফল্ট সেটিংস, ইউনিট (পিস/কেজি/গ্রাম/লিটার/মিলি/ডজন), পেমেন্ট মাধ্যম (নগদ, bKash, Nagad, কার্ড, বাকি)।

টাকা-সংক্রান্ত সব পরিবর্তন `db.transaction()`-এ চলে: হয় পুরোটা হবে, নয় কিছুই হবে না।

### ৩. `services/` — ব্যবসার নিয়ম

| সার্ভিস | কী করে |
|---|---|
| `products` | CRUD, SKU/বারকোড, অফার-সহ কার্যকর দাম (`decoratePrice`), লেবেল ডেটা |
| `inventory` | স্টক মুভমেন্ট (opening/purchase/sale/adjustment/damage/expiry), WAC আপডেট, স্টক কাউন্ট |
| `sales` | `computeSale` (একক সত্য), `createSale`, void, রিটার্নযোগ্য পরিমাণ |
| `purchases` | ল্যান্ডেড কস্ট বণ্টনসহ পারচেজ, পাওনা, void |
| `returns` | সেলস/পারচেজ রিটার্ন, restock সিদ্ধান্ত, রিফান্ড/সমন্বয় |
| `customers` / `suppliers` | লেজার, স্টেটমেন্ট, আদায়/পরিশোধ |
| `payments` | সব পেমেন্টের কেন্দ্রীয় রেকর্ড, reversal |
| `expenses` | খরচ, void |
| `cash` | সেশন খোলা/বন্ধ, মুভমেন্ট, প্রত্যাশিত নগদ |
| `reports` | ২৭টি রিপোর্ট + ড্যাশবোর্ড সিরিজ |
| `dashboard` | KPI, সাম্প্রতিক কার্যক্রম, ট্রেন্ড |
| `backup` | `VACUUM INTO`, ম্যানিফেস্ট, যাচাই, রিস্টোর (pre_restore কপি সহ) |
| `imports` | CSV প্রিভিউ/ম্যাপিং/কমিট (প্রোডাক্ট, কাস্টমার, সাপ্লায়ার) |
| `search` | গ্লোবাল সার্চ (প্রোডাক্ট, কাস্টমার, সাপ্লায়ার, ইনভয়েস, পারচেজ) |
| `auth` / `users` | পাসওয়ার্ড হ্যাশ (scrypt), রোল ও অনুমতি |
| `audit` | অডিট লগ (সেনসিটিভ কী scrub হয়) |
| `setup` | প্রথম চালুর উইজার্ড |

### ৪. `electron/` — ডেস্কটপ খোলস

| ফাইল | দায়িত্ব |
|---|---|
| `main.ts` | single-instance lock, DB bootstrap + integrity, বাংলা মেনু, উইন্ডো হার্ডেনিং, auto backup, `before-quit` |
| `ipc.ts` | `invokeRoute()` — ১৩৫+ রুট, প্রতিটিতে `perm`, ব্যর্থতা লগ + বাংলা মেসেজ, নেটিভ ডায়ালগ |
| `printing.ts` | নির্জন `BrowserWindow` → `getPrintersAsync`, `print({silent:true, pageSize: microns})`, `printToPDF` |
| `receipt.ts` | ৫৮/৮০ মিমি রিসিট HTML (প্রিভিউ ও প্রিন্ট একই HTML) |
| `barcode.ts` | CODE128-B (নিজস্ব, নির্ভরতা-মুক্ত) ও QR (qrcode-generator) SVG |
| `paths.ts` | userData/secured ডিরেক্টরি, JSON-line লগ, `assertInside` (পাথ এসকেপ ঠেকাতে) |
| `preload.ts` | `window.sauda = { invoke, onEvent, platform, versions }` — এর বেশি কিছু নয় |

### ৫. `src/` — বাংলা রেন্ডারার

- `theme.css` — একমাত্র ডিজাইন সিস্টেম (light mode, brand teal, বাংলা ফন্ট স্ট্যাক)
- `api.ts` — `call<T>(method, ...args)` → `window.sauda.invoke`, `ApiError`
- `format.ts` — `money`, `qty`, `dateTime`, বাংলা অঙ্ক, অভিবাদन
- `ui.tsx` — Toast/Confirm, Button, Card, Table, Modal, Field, Tabs, Pagination…
- `charts.tsx` — নির্ভরতা-মুক্ত SVG লাইন/বার/ডোনাট
- `pages/*` — ১৭টি স্ক্রিন (নিচে তালিকা)

স্ক্রিন: Activation, Setup, Login, Dashboard, POS, Products, Inventory, Purchases, Sales, Returns,
Customers, Suppliers, Expenses, Cash, Reports, Settings, Backup, About।

## সুরক্ষা নীতি

1. `contextIsolation: true`, `nodeIntegration: false`; রেন্ডারারের কাছে Node নেই।
2. সব IPC অনুরোধ একটি হোয়াইটলিস্ট রাউট টেবিলের ভেতর দিয়েই যায়; নাম না থাকলে `NOT_FOUND`।
3. প্রতিটি রুটে অনুমতি (`Permission | 'any'`); admin bypass শুধু `role === 'admin'`-এ।
4. সেলস/পারচেজ void ও পেমেন্ট reversal — অতিরিক্তভাবে শুধু অ্যাডমিন।
5. ডিসকাউন্ট ও দাম পরিবর্তন আলাদা অনুমতিতে (`pos.discount`, `pos.price_edit`), IPC-তেও আবার যাচাই।
6. ফাইল ডায়ালগ ও পাথ সব `assertInside(allowedRoots)` দিয়ে যাচাই।
7. কোনো টেলিমেট্রি, কোনো নেটওয়ার্ক কল, কোনো CDN — সব অ্যাসেট বান্ডলে।
8. আর্থিক ডকুমেন্ট ডিলিট হয় না; reversal/void + অডিট এন্ট্রি থাকে।

## ডেটা ফ্লো উদাহরণ: একটি বিক্রয়

```
POS → products.list / products.byCode (স্ক্যান)
    → pos.compute (প্রতি পরিবর্তনে)  ……… server-side হিসাব
    → pos.createSale
          ├─ computeSale()  → subtotal, discount, tax, total, cost, profit, due
          ├─ tx:
          │    ├─ sales / sale_items
          │    ├─ stock_movements + products.stock_base_milli
          │    ├─ payments (নগদ/bKash/বাকি)
          │    ├─ customers.balance_paisa (বাকি হলে)
          │    └─ cash_movements (সেশন খোলা থাকলে)
          └─ audit: sale.create
    → print.receiptHtml → print.print (থার্মাল)
```

## বিল্ড টপোলজি

- Main/preload → **esbuild** (CJS bundle, `electron` ও `better-sqlite3` external)।
- Renderer → **vite** (React 19, jsx automatic, কোনো CDN নয়)।
- দুই অ্যাপ আলাদা `electron-builder` কনফিগ, আলাদা NSIS ইনস্টলার।
- `better-sqlite3` native — CI-তে Windows-এ electron ABI-র জন্য রিবিল্ড হয়।
