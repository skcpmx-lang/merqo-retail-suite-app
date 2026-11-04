# FINAL QA CHECKLIST

Two parts:

- **Part 1** — everything already verified automatically (do not repeat it).
- **Part 2** — the manual, hardware and field checks that this environment could
  not perform. These are the acceptance criteria that stand between verdict
  **B** and verdict **A** (`FINAL_COMMERCIAL_READINESS.md`). Print Part 2 and
  tick it on a real Windows machine.

Machine used: ____________________  OS build: ____________  Date: ____________
Tester: ____________________  Installer SHA-256: ________________________________

## Part 1 — automated (already green, re-run with `npm run verify` / CI)

| # | Check | Where |
|---|---|---|
| 1 | Type-check all three packages (`strict`) | `scripts/typecheck.mjs` |
| 2 | 99 unit/integration tests | `vitest run` |
| 3 | Financial invariants (refund clamp, dues, cash, reports vs ledger) | `audit.test.ts` |
| 4 | Licence negatives (tamper, wrong key, expiry, device swap, rollback) | `security-audit.test.ts` |
| 5 | Schema/migration/WAL/foreign keys | `schema-audit.test.ts` |
| 6 | Permissions, destructive-op guards, SQL-injection smoke | `security-audit.test.ts` |
| 7 | Renderer wiring: icons, CSS classes, IPC routes, page imports | `scripts/audit-ui.mjs` |
| 8 | Both applications build; production CSP tightened | `scripts/build-app.mjs` |
| 9 | No key material tracked by git | `scripts/verify.mjs` |
| 10 | No key material inside either installer | `scripts/verify-installer.mjs` (release job) |
| 11 | Performance at 1 k and 50 k datasets | `scripts/bench.mjs` |

## Part 2 — manual / hardware (owner must execute)

### 2.1 Installation (Windows 10 and Windows 11, one clean machine each)

- [ ] Run `Sauda-Retail-Suite-Setup-1.0.0.exe`; UAC prompt appears once; install completes.
- [ ] First launch shows the activation screen (not the POS).
- [ ] Paste a valid licence → app opens on the dashboard; business name is correct.
- [ ] Wrong/expired licence is refused with a Bangla message and does **not** open the POS.
- [ ] Desktop and Start-menu shortcuts exist and launch the app.
- [ ] Start the app with no internet connection — everything still works.
- [ ] Uninstall keeps the data folder; reinstall finds the existing business and licence.
- [ ] Reboot during a sale session: no data is lost, no "database is locked" error.

### 2.2 Setup wizard

- [ ] Business name, address, phone, currency and receipt footer persist after restart.
- [ ] Create admin, manager and cashier users; log in as each.
- [ ] Cashier cannot open Settings, Reports, or Profit & Loss.
- [ ] Cashier cannot edit a price unless the permission is granted.
- [ ] Discount above the configured limit is refused with a clear message.

### 2.3 POS and receipts

- [ ] Scan a barcode with a real scanner → the correct product line appears (no double entry).
- [ ] Search by Bangla name, by SKU and by barcode all find the product.
- [ ] Weigh 1.5 kg of a kg-based product → stock moves by 1500 g, not 1.5.
- [ ] Cash sale: change computed exactly; receipt prints.
- [ ] 58 mm receipt: all columns aligned, Bangla text renders (no boxes), totals legible.
- [ ] 80 mm receipt: same checks.
- [ ] Duplicate copy prints identical content.
- [ ] Credit sale for a customer with due; collect part of the due later; statement matches.
- [ ] Void a sale: stock, cash and due reverse; the sale stays visible marked "বাতিল".
- [ ] Print a price label with barcode and QR; scanning the label finds the product.

### 2.4 Purchases, returns, expenses, cash

- [ ] Purchase with transport cost: unit cost reflects the allocation.
- [ ] Partial supplier payment reduces the payable correctly.
- [ ] Sale return on a credit invoice reduces the due instead of paying cash.
- [ ] Sale return larger than the invoice line is refused.
- [ ] Expense paid in cash reduces the drawer; P&L reflects it.
- [ ] Cash close: expected vs counted difference is shown, not auto-corrected.

### 2.5 Reports and exports

- [ ] Each of the 27 reports opens and shows data for a date range.
- [ ] CSV export opens in Excel with Bangla text intact (BOM present).
- [ ] XLSX export opens in Excel/WPS with correct columns.
- [ ] PDF export produces an A4 landscape PDF with readable Bangla.
- [ ] Report totals match the dashboard and the cash register.

### 2.6 Backup and restore

- [ ] Manual backup writes a file to the chosen folder; the file size is plausible.
- [ ] Restore a day-old backup: data rolls back, app stays usable without restart.
- [ ] Corrupt the backup file deliberately → restore refuses with a clear message; live data untouched.
- [ ] Automatic backup appears after restarting the app the next day.
- [ ] Backup to a USB drive works; the drive can be removed and re-inserted safely.

### 2.7 Licensing drills

- [ ] Issue a licence from the separate License Generator EXE using the vendor key.
- [ ] Activate on machine A; copy the whole data folder to machine B → activation fails as designed.
- [ ] Replace the disk on machine A (or simulate) → activation still works (≥ 60 % match).
- [ ] Set the Windows clock back a week after expiry → app still refuses.
- [ ] Deactivate + reactivate with a new licence works.

### 2.8 Two-week pilot log

| Shop | Machine | Printer | Issues found | Data loss? | Fixed in |
|---|---|---|---|---|---|
| | | | | | |
| | | | | | |

## Sign-off

| Gate | Result | Date | Signature |
|---|---|---|---|
| Part 1 automated | PASS | 2026-11-04 | audit (see `FINAL_AUDIT_BASELINE.md`) |
| Part 2 manual | ☐ pending | | |
| Commercial verdict | **B** until Part 2 is complete | | |
