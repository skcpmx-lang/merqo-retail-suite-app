# Sauda Retail Suite 1.1.0 — Release Notes

**Release date:** 2026-11-04
**Builds:** `Sauda-Retail-Suite-Setup-1.1.0.exe`, `Sauda-License-Generator-1.1.0.exe`
**Upgrade path:** 1.0.1 → 1.1.0 in place (database migrates 3 → 4 automatically, with a safety backup).

## Highlights

### 1. Premium, bilingual interface
A second design layer (`design-v110.css`) adds a real dark theme, an explicit
4 px spacing scale, a type scale tuned for Bengali, and one consistent set of
components. The whole shell — navigation, topbar, search, shortcuts, empty
states — speaks **বাংলা and English**, switchable from the topbar without a
restart. Bengali digits can be enabled for screens *and* printed documents.

### 2. Purchase orders with partial receiving
Order from a supplier, receive what actually arrived, keep the rest open, receive
again later. Over-receipt is refused, cancelling requires a reason and is audited,
and every receipt posts supplier payable (AP) against real stock.

### 3. Coupons, vouchers and gift cards
Percentage or fixed coupons with minimum spend, maximum discount, expiry, total
and per-customer limits. Gift cards and vouchers are issued as real liabilities
(account **2150**), redeemed at the till as a tender, voided or adjusted with an
audit trail, and expire automatically. The outstanding balance on the Promotions
screen always equals the 2150 balance.

### 4. LAN multi-terminal
One PC hosts the database; other PCs on the same network work as terminals with
the same products, stock, invoices and permissions. Shop token + session tokens +
private-network-only peer filter. Terminals print on their own printer and drive
their own customer display.

### 5. Customer display
A second window shows the shopper only what they should see: item, quantity,
amount, total, change, thank-you. No cost, margin or credit information ever
reaches that screen.

### 6. Professional printed documents
A shared print layer builds receipts (58/80 mm), invoices and purchase documents
(A4/A5), statements, stock documents, licence certificates, label sheets and any
report — with A4 landscape for wide reports. `print.document` / `print.render` /
`print.print` / `print.pdf` from one API.

### 7. Security
The software lock is now **optional and chosen at setup**. When off, the app boots
straight into the admin session — permissions, audit log and licence enforcement
are untouched. Passwords are scrypt-hashed with per-user salt (never stored in
plain text), and repeated failures trigger a persistent 5-attempt / 5-minute
cool-down (`login_attempts`, schema v4). The lock is a convenience, **not** a
substitute for the Windows password or disk encryption.

## Also in this release
- Attendance (clock in/out, corrections with audit) and a Team screen.
- Business branding on the dashboard: name, logo, type, address, phone, website —
  read from settings, never hard-coded demo data.
- Alerts/notification popover driven by real stock and receivable/payable data.
- Settings gained **Appearance & language** and **Network & display** sections,
  plus business website / type / document footer fields.
- Report catalogue now 54 reports, including 8 promotion and v1.1 operational
  reports.

## Compatibility
- Database schema **4** (was 3). Downgrading is not supported; keep the automatic
  pre-migration backup.
- Licences issued for 1.0.x remain valid — the payload format did not change.
- Existing settings, users, invoices and balances are preserved.

## Known limitations (unchanged or new)
- English translation covers the shell, the v1.1 screens and printed documents;
  older screens remain Bengali-only.
- Licence revocation is offline: the seller re-issues or voids a licence; the
  installed copy does not phone home.
- Installers are not code-signed.
- Thermal/label printing, cash-drawer kick, barcode-scanner hardware, customer
  display on a real second monitor and any two-PC rehearsal are **BLOCKED** in the
  build environment and must be verified on the shop's machine using
  `docs/06-testing-and-verification.md`.

## Verification
`npm run verify` (typecheck both packages, 199 tests in 18 files, UI wiring audit,
licence/public-key checks) and a full release build are both green for this tag.
See `docs/FINAL_REPORT_V110.md` for the numbers and `docs/FINAL_RELEASE_VERIFICATION.md`
for asset hashes.
