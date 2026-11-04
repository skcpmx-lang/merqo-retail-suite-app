# সাউদা রিটেইল স্যুট (Sauda Retail Suite)

বাংলাদেশের দোকান ও ছোট ব্যবসার জন্য **সম্পূর্ণ অফলাইন** রিটেইল POS ও ব্যবসা ব্যবস্থাপনা সফটওয়্যার।
একটি Windows অ্যাপ্লিকেশন, একটি SQLite ডাটাবেজ, এবং সম্পূর্ণ বাংলা ইন্টারফেস — ইন্টারনেট ছাড়াই সব কাজ।

> **MERQO** • merqoonline@gmail.com
> অবস্থা: `1.0.0` — কার্যকরী কোড, নিজস্ব টেস্ট ও বিল্ড সবুজ। Windows ইনস্টলারের স্বয়ংক্রিয় বিল্ড GitHub Actions-এ (`.github/workflows/release.yml`)।

---

## এই রিপোজিটরিতে কী আছে

| প্যাকেজ | কী | আউটপুট |
|---|---|---|
| `packages/core` | ব্যবসার সব হিসাব, ডাটাবেজ, সার্ভিস, লাইসেন্সিং | টাইপ + `@sauda/core` লাইব্রেরি |
| `packages/app` | গ্রাহকের অ্যাপ: Electron main + React 19 বাংলা UI | `Sauda Retail Suite` ইনস্টলার |
| `packages/license-generator` | MERQO-র ভেতরের লাইসেন্স তৈরির টুল | `Sauda License Generator` ইনস্টলার |
| `scripts/` | বিল্ড, আইকন, প্যাকেজিং ও যাচাই | — |
| `docs/` | আর্কিটেকচার, ব্যবহার নির্দেশিকা, লাইসেন্সিং, রিকোয়্যারমেন্ট ট্রেসেবিলিটি | — |

## বৈশিষ্ট্য (সংক্ষেপে)

- **বিক্রয় (POS)** — বারকোড স্ক্যান, নাম/এসকেইউ/বাংলা সার্চ, একাধিক ইউনিট (কেজি↔গ্রাম), লাইন ও অর্ডার ডিসকাউন্ট (অনুমতিসাপেক্ষ), বাকি বিক্রয়, ফেরত টাকার হিসাব, রিসিট প্রিভিউ।
- **প্রোডাক্ট ও ইনভেন্টরি** — ক্যাটাগরি/সাব-ক্যাটাগরি, ব্র্যান্ড, ইউনিট ফ্যামিলি, ক্রয়-বিক্রয়-পাইকারি-বিশেষ মূল্য, প্রোডাক্ট অফার, ব্যাচ/মেয়াদ, সর্বনিম্ন স্টক অ্যালার্ট, স্টক কাউন্ট ও লোকসান (নষ্ট/মেয়াদ) এন্ট্রি।
- **পারচেজ ও সাপ্লায়ার** — পারচেজ এন্ট্রি, পরিবহন খরচ বণ্টন, ওয়েটেড অ্যাভারেজ কস্ট, পাওনা, পরিশোধ, রিটার্ন।
- **কাস্টমার ও বাকি** — বাকি খাতা, আদায়, সম্পূর্ণ স্টেটমেন্ট (ডেবিট/ক্রেডিট/ব্যালেন্স)।
- **এক্সপেন্স ও ক্যাশ রেজিস্টার** — খরচের ক্যাটাগরি, ক্যাশ সেশন, নগদ মিলকরণ ও পার্থক্যের অডিট।
- **রিটার্ন** — সেলস ও পারচেজ রিটার্ন, ভালো/নষ্ট/মেয়াদোত্তীর্ণ শর্ত, রিফান্ড।
- **২৭ টি রিপোর্ট** — দৈনিক সেলস, লাভ-লোকসান, স্টক ভ্যালুয়েশন, বাকি খাতা, ক্যাশিয়ার ওয়াইজ, ক্যাশ রেজিস্টার ইত্যাদি; **CSV / Excel / PDF** এক্সপোর্ট।
- **প্রিন্টিং** — ৫৮ মিমি ও ৮০ মিমি থার্মাল রিসিট (পূর্ণ বাংলা), A4 ল্যান্ডস্কেপ রিপোর্ট PDF, প্রোডাক্ট বারকোড (CODE128) + QR লেবেল।
- **ব্যাকআপ** — `.saudabak` সম্পূর্ণ ব্যাকআপ, যাচাইসহ রিস্টোর, স্বয়ংক্রিয় সময়সূচি।
- **নিরাপত্তা ও অডিট** — রোল (admin/manager/cashier) + ১৯টি সূক্ষ্ম অনুমতি, প্রতিটি পরিবর্তনের অডিট লগ; আর্থিক ডকুমেন্ট কখনো হার্ড-ডিলিট হয় না (void/reversal)।
- **লাইসেন্স** — Ed25519 স্বাক্ষরিত, হার্ডওয়্যার-বাউন্ড, সম্পূর্ণ অফলাইন; ওয়েটেড ফিঙ্গারপ্রিন্ট (৬০% মিল)।

## দ্রুত শুরু (ডেভেলপার)

```bash
npm ci            # better-sqlite3 লোকালি কম্পাইল হয়
npm run verify    # টাইপচেক (৩ প্যাকেজ) + ৯৯ টেস্ট + দুই অ্যাপের বিল্ড + সিক্রেট স্ক্যান
npm run build     # two apps → packages/*/dist
```

Windows ইনস্টলার বানাতে (Windows মেশিন বা CI-তে):

```bash
node scripts/build-app.mjs && node scripts/package-app.mjs
node scripts/build-license-generator.mjs && node scripts/package-license-generator.mjs
```

রিলিজ: `v*` ট্যাগ পুশ করলে GitHub Actions দুই ইনস্টলার বানিয়ে Release-এ আপলোড করে।

## ডকুমেন্টেশন

- [`docs/01-architecture.md`](docs/01-architecture.md) — স্তর, ডাটা ফ্লো, নীতি
- [`docs/02-user-guide-bn.md`](docs/02-user-guide-bn.md) — দোকানদারের জন্য ধাপে ধাপে নির্দেশিকা
- [`docs/03-admin-guide-bn.md`](docs/03-admin-guide-bn.md) — ইউজার, অনুমতি, ব্যাকআপ, সমস্যা সমাধান
- [`docs/04-licensing.md`](docs/04-licensing.md) — কী ব্যবস্থাপনা, লাইসেন্স তৈরি, রিবাইন্ডিং, থ্রেট মডেল
- [`docs/05-build-and-release.md`](docs/05-build-and-release.md) — বিল্ড পাইপলাইন ও রিলিজ চেকলিস্ট
- [`docs/06-testing-and-verification.md`](docs/06-testing-and-verification.md) — কী যাচাই হয়েছে, কী বাকি
- [`docs/07-requirements-traceability.md`](docs/07-requirements-traceability.md) — প্রতিটি রিকোয়্যারমেন্ট → কোড → যাচাই
- [`docs/08-database-schema.md`](docs/08-database-schema.md) — ৩১ টেবিল, ইনডেক্স, মাইগ্রেশন
- [`docs/09-known-limits.md`](docs/09-known-limits.md) — সীমাবদ্ধতা ও পরবর্তী কাজ

### চূড়ান্ত অডিট (২০২৬-১১-০৪)

| ডকুমেন্ট | বিষয় |
|---|---|
| [`FINAL_AUDIT_BASELINE.md`](docs/FINAL_AUDIT_BASELINE.md) | কী, কোথায়, কীভাবে যাচাই হয়েছে (L1–L5) |
| [`FINAL_REQUIREMENT_AUDIT.md`](docs/FINAL_REQUIREMENT_AUDIT.md) | ৮৪টি রিকোয়্যারমেন্টের অবস্থা |
| [`FINAL_CODE_AUDIT.md`](docs/FINAL_CODE_AUDIT.md) | আর্কিটেকচার, টাইপ-সেফটি, ডেড কোড, বিল্ড |
| [`FINAL_DATABASE_AUDIT.md`](docs/FINAL_DATABASE_AUDIT.md) | ৩১ টেবিল, ৪৩ ইনডেক্স, WAL, মাইগ্রেশন, কুয়েরি প্ল্যান |
| [`FINAL_SECURITY_AUDIT.md`](docs/FINAL_SECURITY_AUDIT.md) | থ্রেট মডেল, RBAC, CSP, গৃহীত ঝুঁকি |
| [`FINAL_LICENSE_AUDIT.md`](docs/FINAL_LICENSE_AUDIT.md) | Ed25519, ফিঙ্গারপ্রিন্ট, কী আলাদা রাখা |
| [`FINAL_WORKFLOW_AUDIT.md`](docs/FINAL_WORKFLOW_AUDIT.md) | বিক্রয়/রিটার্ন/ক্রয়/ক্যাশের ইনভ্যারিয়েন্ট |
| [`FINAL_BUG_AND_WARNING_REGISTER.md`](docs/FINAL_BUG_AND_WARNING_REGISTER.md) | সব বাগ, সতর্কতা, খোলা আইটেম |
| [`FINAL_PERFORMANCE_REPORT.md`](docs/FINAL_PERFORMANCE_REPORT.md) | মাপা পারফরম্যান্স (হার্ডওয়্যারসহ) |
| [`FINAL_COMMERCIAL_READINESS.md`](docs/FINAL_COMMERCIAL_READINESS.md) | **ভার্ডিক্ট B** ও শর্ত |
| [`FINAL_RELEASE_VERIFICATION.md`](docs/FINAL_RELEASE_VERIFICATION.md) | Windows প্যাকেজিং প্রমাণ |
| [`FINAL_QA_CHECKLIST.md`](docs/FINAL_QA_CHECKLIST.md) | ম্যানুয়াল/হার্ডওয়্যার চেকলিস্ট |

## লাইসেন্স

মালিকানা সফটওয়্যার — [`LICENSE.md`](LICENSE.md) দেখুন। সাইনিং প্রাইভেট কী কখনো এই রিপোজিটরিতে থাকে না (`secrets/` git-ignored)।
