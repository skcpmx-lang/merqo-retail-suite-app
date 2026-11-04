# SAUDA v1.0.1 — PHASE 2/3: COMPETITIVE INTELLIGENCE & GAP MATRIX

Sources (public vendor documentation, reviewed 2026-11-04):
Loyverse pricing/features [1], uniCenta oPOS feature list [2], a Bangladeshi
offline desktop POS (RetailPro) [3], Nexchar (BD, cloud) [4], Smart POS (BD) [5].
Only public **feature concepts** were used; no code, wording, asset or
implementation was copied.

## 1. What the competitors actually sell

| Product | Business model | Standout capabilities |
|---|---|---|
| **Loyverse** | Free POS, paid add-ons ($5–25/mo) | open tickets (hold), variants & modifiers, loyalty points, stock transfers, purchase orders, stock takes, employee time cards, offline-with-sync |
| **uniCenta oPOS** | free/open-source desktop | multi-payment in one sale, layaway, **credit limits**, customer accounts, min/max stock levels, multi-warehouse + transfers, product attributes/bundles, employee check-in |
| **RetailPro (BD)** | $100 one-off, offline | hold/resume carts, batch & expiry, **serial/IMEI**, variants & bundles, credit limits on the due khata, **double-entry accounting**, shift/cash-drawer control, Mushak 6.1/6.2/6.3 registers, bKash/Nagad/Rocket, planning analytics, Bangla+English |
| **Nexchar (BD)** | cloud subscription | bKash/Nagad, loyalty, multi-shop, online store integration |
| **Smart POS (BD)** | web + app | multi-shop, barcode, accounts module, exchange/wastage returns |

**Strategic reading.** In Bangladesh the decisive purchase criteria are:
1. the **due khata** with credit control, 2. **bKash/Nagad/Rocket** accounting,
3. an **accounts module a CA will accept**, 4. **IMEI/serial** for electronics,
5. **Mushak-style VAT registers**, 6. **Bangla**, 7. **works offline**. Sauda
already wins on 5–7 and on owning the data outright; it was behind on 1–4.

## 2. Feature matrix

Legend: ✔ full · ◐ partial · ✘ absent · — not applicable

| # | Feature | Loyverse | uniCenta | RetailPro BD | Sauda 1.0.0 | Sauda 1.0.1 action |
|---|---|---|---|---|---|---|
| 1 | POS sale + barcode | ✔ | ✔ | ✔ | ✔ | keep |
| 2 | Product search without barcode | ✔ | ✔ | ✔ | ✔ | keep |
| 3 | Hold / resume sale (open ticket) | ✔ | ✔ | ✔ | ✘ | **MUST — implement** |
| 4 | Split / multi-tender payment | ◐ | ✔ | ✔ | ◐ (logic only) | **MUST — UI + tests** |
| 5 | Partial payment / credit sale | ✔ | ✔ | ✔ | ✔ | keep |
| 6 | Line/item + invoice discount, fixed & % | ✔ | ✔ | ✔ | ✔ | keep |
| 7 | Price override permission | ✔ | ✔ | ✔ | ✔ | + min-price / max-discount guard |
| 8 | Discount approval | ◐ | ✔ | ✔ | ◐ | permission + audit (keep) |
| 9 | Quick keys / favourites | ✔ | ✔ | ✔ | ✘ | **MUST — implement** |
| 10 | Receipt reprint | ✔ | ✔ | ✔ | ✔ | keep |
| 11 | Duplicate-sale prevention | ◐ | ◐ | ◐ | ✘ | **implement** (same-cart window) |
| 12 | Cash drawer / cash in-out | ✔ | ✔ | ✔ | ✔ | keep |
| 13 | Shift open/close + expected vs counted | ✔ | ✔ | ✔ | ✔ | keep |
| 14 | Exchange flow | ✔ | ✔ | ✔ | ✘ | v1.1 (return + sale) |
| 15 | Variants (size/colour/model) | ✔ | ✔ | ✔ | ✘ | **MUST — implement** |
| 16 | Bundles / composite | ✘ | ✔ | ✔ | ✘ | **implement** |
| 17 | Service / non-stock items | ✔ | ✔ | ✔ | ✘ | **implement** |
| 18 | Multiple barcodes | ✔ | ✔ | ✔ | ✔ | keep |
| 19 | Multiple units + conversion | ◐ | ✔ | ✔ | ✔ | keep |
| 20 | Wholesale / retail / special price | ◐ | ✔ | ✔ | ✔ | + minimum selling price |
| 21 | Product image | ✔ | ✔ | ✔ | ◐ (stored only) | **implement display** |
| 22 | Batch / lot + expiry | ✔ | ◐ | ✔ | ◐ | **receiving + tracking** |
| 23 | Serial / IMEI | ✘ | ✘ | ✔ | ✘ | **implement** |
| 24 | Low stock / min-max / reorder | ✔ | ✔ | ✔ | ◐ | **reorder level + suggested qty** |
| 25 | Negative stock prevention | ✔ | ✔ | ✔ | ✔ | keep |
| 26 | Stock transfer / multi-warehouse | ✔ (paid) | ✔ | ◐ | ✘ | **implement (locations)** |
| 27 | Physical stock count + variance | ✔ (paid) | ✔ | ✔ | ◐ | **count session** |
| 28 | Dead / fast / slow stock | ✔ | ✔ | ✔ | ◐ (top products only) | **implement reports** |
| 29 | Purchase order + partial receive | ✔ (paid) | ✔ | ✔ | ✘ | v1.1 (documented) |
| 30 | Supplier advance | ◐ | ✔ | ✔ | ✘ | **implement** |
| 31 | Purchase price history | ◐ | ✔ | ✔ | ◐ (table only) | **report** |
| 32 | Customer credit limit | ✘ | ✔ | ✔ | ✘ | **MUST — implement** |
| 33 | Loyalty points (earn/redeem/reverse/expire) | ✔ | ✔ | ◐ | ✘ | **MUST — implement** |
| 34 | Customer groups / tier pricing | ✘ | ✔ | ◐ | ✘ | implement groups + LTV |
| 35 | Coupons / vouchers / gift cards | ✘ | ✔ | ✘ | ✘ | v1.1 (needs promo engine) |
| 36 | Double-entry accounting | ✘ | ◐ | ✔ | ✘ | **MUST — implement** |
| 37 | Trial balance / P&L / balance sheet / ledger | ✘ | ◐ | ✔ | ✘ | **implement** |
| 38 | Bank / cash books, day book | ✘ | ◐ | ✔ | ✘ | **implement** |
| 39 | VAT register (Mushak-style) | ✘ | ◐ | ✔ | ✘ | **configurable tax register** (no legal claims) |
| 40 | Employee attendance / time clock | ✔ (paid) | ✔ | ✔ | ✘ | **implement attendance** |
| 41 | Custom roles | ◐ | ✔ | ✔ | ✘ | **role templates** |
| 42 | Login history | ✘ | ✔ | ✔ | ◐ (`sessions_log`) | **screen** |
| 43 | Offline operation | ◐ (sync needed) | ✔ | ✔ | ✔ | **advantage — protect** |
| 44 | Data ownership / portable backup | ✘ | ✔ | ◐ | ✔ | **advantage** |
| 45 | Bangla UI | ✘ | ◐ | ✔ | ✔ | **advantage** |
| 46 | Lifetime licence, no subscription | ✘ | ✔ | ✔ | ✔ | **advantage** |
| 47 | Thermal 58/80 mm | ✔ | ✔ | ✔ | ✔ | field test pending |
| 48 | Multi-store sync | ✔ | ✔ | ◐ | ✘ | v1.2 (LAN) |
| 49 | Paid API / cloud dependency | required | none | none | none | **advantage — protect** |

## 3. Decisions taken from this analysis

1. **Accounting is the single biggest commercial gap.** A shopkeeper with a CA,
   or a VAT-registered shop, cannot use a system that only shows
   `sales − purchase − expense`. v1.0.1 gets a real double-entry ledger with
   auto-posting and balanced-by-construction journals.
2. **Credit limit + loyalty + hold-sale + split payment** are table stakes in this
   market and cheap to add correctly → in v1.0.1.
3. **Serial/IMEI and variants/bundles** are what win electronics and clothing
   shops in Dhaka → in v1.0.1 (variants + serials + bundles).
4. **Multi-warehouse** is a paid tier for Loyverse but expected offline in BD:
   implement *locations* with per-location stock while keeping the existing
   global figure authoritative — a design that cannot corrupt the current ledger.
5. **Purchase orders with partial receiving** and **coupons/gift cards** are real
   but carry promo/order state machines; they are scheduled for v1.1 rather than
   rushed into a release that must not break financial data. Documented, not hidden.
6. **Nothing paid, no API, no telemetry** — the offline advantage stays intact.
7. Do not imitate Mushak forms pixel-for-pixel or claim legal compliance; provide
   a configurable VAT register and say plainly that compliance is the user's
   accountant's responsibility.
