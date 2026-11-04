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

### 2.9 License Generator v1.1.1 (নতুন — এখনো চালানো হয়নি)

এই ধাপগুলো একটি Windows মেশিনে, **আসল (বা পরীক্ষামূলক) সাইনিং কী** দিয়ে চালাতে হবে। এই স্যান্ডবক্সে
Electron/ডিসপ্লে নেই, তাই এগুলো **BLOCKED** — পাস ধরা হয়নি।

- [ ] `Sauda-License-Generator-1.1.1.exe` ইনস্টল → শর্টকাট (বাংলা নাম) কাজ করে, প্রথম উইন্ডো খোলে।
- [ ] প্রথম চালুতে "সাইনিং কী লোড হয়নি" পিল দেখা যায়; **সিকিউরিটি ও কী** পর্দায় কী লোড করা যায়।
- [ ] কী লোডের পর পিল সবুজ; কী আইডি ও **পাবলিক কী** দেখা যায় — প্রাইভেট কী কোথাও দেখা যায় না, কপি হয় না।
- [ ] ৯ ধাপের উইজার্ড: প্রতিটি ধাপে ভুল তথ্য দিলে পরের ধাপে যাওয়া আটকায় (ধাপ ১–৬)।
- [ ] ধাপ ৪-এ `.sauda-device` ইমপোর্ট ও পেস্ট — দুটোই কাজ করে; নষ্ট ফাইলে বাংলা ত্রুটি।
- [ ] ধাপ ৫-এ এডিশনের বাইরের ফিচার যোগ করা যায় না।
- [ ] ধাপ ৭-এ "অপরিবর্তনীয়" বনাম "সম্পাদনাযোগ্য" আলাদা দেখা যায়।
- [ ] ধাপ ৮: কী ছাড়া বাটন নিষ্ক্রিয়; কী থাকলে স্বাক্ষর হয় ও স্ব-যাচাই সফল দেখায়।
- [ ] ধাপ ৯: `.sauda` সংরক্ষণ (ডায়ালগ বাতিল করলেও রেকর্ড তৈরি হয়), কী কপি, সার্টিফিকেট প্রিভিউ/PDF/প্রিন্ট।
- [ ] ওই `.sauda` ফাইল সাউদা রিটেইল অ্যাপে অ্যাক্টিভেট হয়; ভিন্ন মেশিনে প্রত্যাখ্যাত হয়।
- [ ] লাইসেন্স তালিকায় সার্চ/ফিল্টার/সর্ট/পেজিনেশন; প্রোফাইল ও অ্যাক্টিভিটি দেখা যায়।
- [ ] রি-ইস্যু করলে জেনারেটরে পুরোনো `superseded`, নতুনটি সক্রিয়। (মনে রাখুন: অফলাইনে পুরোনো ফাইলটি গ্রাহকের মেশিনে প্রযুক্তিগতভাবে বৈধ থাকতে পারে — এটি নথিভুক্ত সীমা।)
- [ ] প্রত্যাহার (কারণ ছাড়া বন্ধ) → লাইসেন্স `revoked`; যাচাই পর্দায় ওই ফাইল "প্রত্যাহার" দেখায়।
- [ ] ৮টি রিপোর্ট: HTML প্রিভিউ, PDF সেভ, প্রিন্ট — সবগুলোর আউটপুটে বাংলা ঠিক দেখায়।
- [ ] ব্যাকআপ এক্সপোর্ট → ফোল্ডার বদল/মুছে ফেলা → রিস্টোর; কাস্টমার ও লাইসেন্স ফিরে আসে; আগের অবস্থা পার্কিং-এ থাকে।
- [ ] লাইট ↔ ডার্ক থিম বদল; পুনরায় চালু করলে থিম মনে থাকে।
- [ ] কীবোর্ড: Tab দিয়ে সব নিয়ন্ত্রণে পৌঁছানো যায়; Ctrl+K সার্চে ফোকাস; Esc বন্ধ করে; ডায়ালগে ফোকাস ঢোকে।
- [ ] ১০০–১২৫% Windows স্কেলিং-এ লেখা কাটে না; ছোট (১০২৪×৭২০) উইন্ডোতে স্ক্রল কাজ করে।
- [ ] আনইনস্টল করলে `%APPDATA%/Sauda License Generator/` ডেটা মুছে যায় না (রিস্টোরের জন্য থাকে)।

## Sign-off

| Gate | Result | Date | Signature |
|---|---|---|---|
| Part 1 automated | PASS | 2026-11-04 | audit (see `FINAL_AUDIT_BASELINE.md`) |
| Part 2 manual | ☐ pending | | |
| Release published | `v1.0.0`, run 41788965176, both installers + `SHA256SUMS.txt` | 2026-11-04 | `FINAL_RELEASE_VERIFICATION.md` §3 |
| Commercial verdict | **B** until Part 2 is complete | | |
