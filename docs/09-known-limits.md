# সীমাবদ্ধতা, খোলা কাজ ও রিজিউম পয়েন্ট

> এই ফাইলটি সৎ অবস্থা রেকর্ড করে। “কাজ করছে” কেবল তখনই লেখা হবে যখন প্রমাণ থাকবে।

## ১. এখনই সবুজ (প্রমাণসহ)

```
npm run verify
✔ typecheck: core / app / license generator
✔ 99/99 core tests (6 files)
✔ ui wiring: 26 files · 48 icons · 187 css classes · 131 ipc routes · 105 call sites
✔ build: app (renderer 465.58 kB js / 125.29 kB gzip · 29.94 kB css, production CSP connect-src 'none')
✔ build: license generator
✔ secrets scan: no key material tracked
```

GitHub Actions: `CI` ওয়ার্কফ্লো (ubuntu-latest) সবুজ; `Release (Windows installers)` ওয়ার্কফ্লো
ট্যাগ `v1.0.0-rc.4`-এ (রান 41787673767) সম্পূর্ণ সবুজ — **দুই NSIS ইনস্টলারই তৈরি হয়েছে**,
`scripts/verify-installer.mjs` আকার যাচাই + প্রাইভেট কী স্ক্যান + SHA-256 তালিকা পাস করেছে
(আর্টিফ্যাক্ট `sauda-windows-installers`, ২২১ MB)।

## ২. যা স্যান্ডবক্সে যাচাই করা যায়নি (প্রমাণ বাকি)

| আইটেম | কেন | প্রয়োজন |
|---|---|---|
| দুই NSIS ইনস্টলার তৈরি | ✅ হয়েছে (Windows রানার, রান 41787673767) | — |
| ইনস্টলার **চালিয়ে** ইনস্টল করা | এই পরিবেশে Windows মেশিন নেই | `FINAL_QA_CHECKLIST.md` §2.1 |
| থার্মাল প্রিন্ট (৫৮/৮০ মিমি) | ফিজিক্যাল প্রিন্টার দরকার | Windows + প্রিন্টার |
| PDF এক্সপোর্টের বাংলা শেপিং | অফস্ক্রিন Chromium দরকার | Windows ম্যানুয়াল টেস্ট |
| লাইসেন্স ম্যাচিং আসল হার্ডওয়্যারে | আসল মেশিনের সিরিয়াল দরকার | ২টি ভিন্ন পিসি |
| বারকোড/QR স্ক্যান | স্ক্যানার দরকার | USB বারকোড স্ক্যানার |
| হাই-ডিপিআই ও একাধিক মনিটর | ফিজিক্যাল স্ক্রিন | Windows |

**নিয়ম:** উপরের যেকোনো একটি প্রমাণ না পাওয়া পর্যন্ত ডকুমেন্টেশনে সেটি “যাচাইকৃত” বলে দাবি করা হবে না।

## ৩. পরিচিত প্রযুক্তিগত সীমা

0. **ইনস্টলারে কোড সাইন নেই** — SmartScreen “unknown publisher” দেখাবে। সার্টিফিকেট ছাড়া এটি
   সমাধান হয় না (`FINAL_COMMERCIAL_READINESS.md` R1)।
0. **রেন্ডারার sandbox বন্ধ** (`sandbox: false`) — contextIsolation, nodeIntegration বন্ধ ও কঠোর CSP
   দিয়ে ক্ষতিপূরণ করা হয়েছে; ১.১-এ sandbox-সাপোর্টেড preload।
0. **লগইন থ্রটলিং নেই** — লোকাল মেশিনে পাসওয়ার্ড অনুমান করা সম্ভব; প্রতিটি ব্যর্থ চেষ্টা অডিট লগে যায়।
0. **রিপোর্টের তারিখ ফিল্টার `date(sale_date)` ব্যবহার করে** — `idx_sales_date` কাজে লাগে না
   (`SCAN sales`)। ২ লক্ষ বিক্রয়ে ২০.৩ ms বনাম ৫.৫৫ ms মাপা হয়েছে; ৫০ হাজারে সবচেয়ে ধীর রিপোর্ট ১০১ ms।
   পরবর্তী অপ্টিমাইজেশনের প্রথম আইটেম।

1. **ডেটা এনক্রিপ্টেড নয়** — SQLite ফাইল যে কেউ খুলতে পারে (OS লগইনের বাইরে)। ব্যবসায়িক ডেটা গোপনীয় হলে
   Windows BitLocker অথবা ভবিষ্যতে SQLCipher ব্যবহারের সুপারিশ।
2. **একক ব্যবহারকারী মেশিন** — একই ডাটাবেজ নেটওয়ার্ক শেয়ারে একসাথে দুই কম্পিউটার থেকে চালানো সমর্থিত নয়।
3. **অফলাইন লাইসেন্স** — বাতিল/রিভোক কেন্দ্রীয়ভাবে ছড়ানো যায় না; মেয়াদোত্তীর্ণ লাইসেন্সই একমাত্র দূরবর্তী নিয়ন্ত্রণ।
4. **কোড সাইনিং নেই** — Windows SmartScreen সতর্কতা দেখাবে; সার্টিফিকেট যোগ করলে সমাধান হবে।
5. **ফন্ট নির্ভরতা** — বাংলা রেন্ডারিং Windows-এর “Nirmala UI”-এর উপর; অপরিহার্য হলে ফন্ট বান্ডল করা যাবে।
6. **QR** — `qrcode-generator` (MIT) দিয়ে তৈরি; প্রোডাক্টের QR ডিফল্ট পেলোড `SAUDA:<id>`।
7. **রিপোর্ট লিমিট** — বড় ডেটাসেটে (লক্ষ সারি) রিপোর্ট মেমোরিতে আসে; ভবিষ্যতে স্ট্রিমিং দরকার হতে পারে।

## ৪. পরবর্তী কাজের তালিকা (অগ্রাধিকার অনুসারে)

1. `v1.0.0` ট্যাগ → GitHub Release (ইনস্টলার আর্টিফ্যাক্ট ইতিমধ্যেই প্রমাণিত), তারপর §২-এর ম্যানুয়াল যাচাই।
2. রিপোর্টের তারিখ ফিল্টারকে রেঞ্জ প্রিডিকেটে বদলে `idx_sales_date` কাজে লাগানো (মাপা উন্নতি ৩.৭×)।
3. আসল প্রিন্টারে রিসিট টিউনিং (মার্জিন, ফিড, ফন্ট সাইজ ডিফল্ট)।
3. স্টক ট্রান্সফার (দোকান→গুদাম) — স্কিমায় `transfer` টাইপ আছে, UI নেই।
4. ভ্যারিয়েন্ট (সাইজ/রঙ) UI — স্কিমায় `variant_parent_id` ও `variant_attributes` আছে।
5. রিপোর্ট শিডিউল/ইমেইল — অফলাইন নীতির কারণে সম্ভবত বাদ।
6. SQLCipher / BitLocker গাইড যোগ।
7. কোড সাইনিং সার্টিফিকেট ও আপডেট মেকানিজম (সম্পূর্ণ অফলাইন রাখতে ম্যানুয়াল আপডেট)।

## ৫. রিজিউম করার নিয়ম

1. `git log --oneline -5` দেখে সর্বশেষ অবস্থা বুঝুন।
2. `npm ci` (node_modules স্ন্যাপশটে থাকে না) — সীমাবদ্ধ নেটওয়ার্কে:
   `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm_config_build_from_source=true npm ci`
3. `npm run verify` চালিয়ে নিশ্চিত হন সবুজ।
4. এই ফাইলের §২ ও §৪ দেখে বাকি কাজ ধরুন।

## ৬. পরিবেশ নোট (এই রিপোতে কাজ করা ডেভেলপারদের জন্য)

- `node_modules` সংস্করণ-নিয়ন্ত্রণে নেই; প্রতিবার ইনস্টল করতে হবে।
- Electron বাইনারি ডাউনলোড ব্লকড হলে `ELECTRON_SKIP_BINARY_DOWNLOAD=1`।
- `better-sqlite3` prebuilt না পেলে `npm_config_build_from_source=true` + `node-gyp` টুলচেইন।
- `@vitejs/plugin-react` এই Vite সংস্করণে প্রয়োজন নেই; JSX `esbuild.jsx = 'automatic'` দিয়ে হ্যান্ডেল হয়।

## v1.1.0 additions

- **English translation is partial.** Shell, the four new v1.1 screens and all
  printed documents are bilingual; the pre-v1.1 screens remain Bengali-only and
  fall back to Bengali rather than showing raw keys. Tracked in docs/18.
- **Licence revocation is offline.** Voiding a licence cannot reach an installed
  copy that never goes online; the seller re-issues or blocks future activation.
  Reported as PARTIAL in the licence audit.
- **No visual regression baseline.** UI is enforced by the wiring audit and
  token-only styling, not by pixel diffs.
- **LAN is single-host.** No replication, no queued offline sales; a disconnected
  terminal refuses to sell rather than creating invoices that would conflict.

## v1.1.1 additions (License Generator)

- **The generator has no user accounts.** It runs under the Windows account that
  launches it; there is no operator list, role model or audit of "who" beyond the
  machine. Multi-operator use needs OS accounts (or a future admin PIN).
- **Private key protection is OS-level only.** The app never stores, displays or
  exports the private key — the operator points it at a file for the session — but
  it cannot stop someone with file access to that machine from reading the file.
- **Revocation stays PARTIAL.** A revoked `.sauda` still verifies
  cryptographically on an offline client; the revocation list lives in the
  generator's ledger and is surfaced on the generator's verify screen.
- **Re-issue does not invalidate the previous file.** The old record becomes
  `superseded`; the old file remains technically valid until the client replaces
  it or its device binding stops matching.
- **Renderer tests are render-only.** They are server-side render smoke tests
  (module loading, first paint, no key leakage). Click-through, focus order and
  appearance are covered only by the manual Windows checklist (§2.9).
- **Installers are not code-signed**, so SmartScreen may warn on first run.
- **Windows-only in practice.** Builds and packaging are validated on Windows in
  CI; Linux/macOS are untested for this product.
