# AUDIT CODEBASE — v1.1.3

তারিখ: ২০২৬-১১-০৪ · পদ্ধতি: প্রতিটি প্যাকেজ, স্ক্রিপ্ট ও কনফিগ পঢ়া; তারপর লক্ষ্যভিত্তিক গ্রেপ ও টেস্ট।

স্টেটাস শব্দ: `PASS` · `PARTIAL` · `FAIL` · `MISSING` · `BLOCKED` · `NOT APPLICABLE`।

---

## ১. প্যাকেজ-ভিত্তিক ফল

| এলাকা | কী দেখা হলো | স্টেটাস |
|---|---|---|
| `packages/core/src/domain` | পয়সা-ভিত্তিক পূর্ণসংখ্যা, `roundDiv`, শতাংশ ×১০০, কুপন basis point ×১০০০০ | PASS |
| `packages/core/src/db` | স্কিমা v4, FK/CHECK/UNIQUE, WAL, busy timeout, integrity check | PASS |
| `packages/core/src/services` (৩০) | লেনদেন সীমা, অডিট, স্কিমা-যাচাই; নিচের ত্রুটি ছাড়া | PARTIAL → v1.1.3-এ ঠিক |
| `packages/core/src/licensing` | Ed25519, canonical JSON, ডিভাইস বাইন্ডিং; পাবলিক কী override ছিল | FAIL → ঠিক |
| `packages/core/src/net` | LAN RPC; প্লেইনটেক্সট, রেট-লিমিট নেই | FAIL → ঠিক |
| `packages/core/src/print` | থার্মাল/A4 ডকুমেন্ট বিল্ডার, একক ফরম্যাটার | PASS (হাডওয়্যার BLOCKED) |
| `packages/app/electron` | main/preload/ipc/paths/printing/lan | PARTIAL → sender যাচাই যোগ |
| `packages/app/src` (৩৫ ফাইল, ২৪ পেজ) | React 19 UI, ডিজাইন টোকেন, দ্বিভাষা শেল | PASS |
| `packages/license-generator/src` | ৯৪৫ লাইনের domain + ৭০৮ লাইনের main | PARTIAL → dev-URL ও IPC ঠিক |
| `scripts/*.mjs` | verify/audit/build/package/icons/keys | PARTIAL → গেট শক্ত করা হলো |

## ২. কোড-গন্ধ ও ঝুঁকি স্ক্যান (প্রকৃত গ্রেপ ফল)

| অনুসন্ধান | ফল | মন্তব্য |
|---|---|---|
| `TODO` / `FIXME` / `HACK` | ০ |প্রোডাকশন কোডে কোনো চিহ্নিত অসম্পূর্ণ কাজ নেই |
| `eval` / `new Function` | ০ | — |
| `dangerouslySetInnerHTML` | শুধু প্রিন্ট প্রিভিউ (নিজের তৈরি HTML) | নিয়ন্ত্রিত |
| SQL স্ট্রিং ইন্টারপোলেশন | সব `ORDER BY` হোয়াইটলিস্ট-ম্যাপড (`SORTABLE`, `sortMap`) | PASS |
| ফ্লোটিং-পয়েন্ট টাকার হিসাব | পাওয়া যায়নি; `* 100`/`/ 100` শুধু প্রদর্শন বা শতাংশ | PASS |
| `catch {}` (নীরব) | ২৯টি, সবই “best-effort” (লগ লেখা, ঐচ্ছিক আইকন, লাইসেন্স ক্যাশে) | PASS (অডিট করা) |
| `any` টাইপ | IPC-র ২৪টি রুট ও কিছু লিগ্যাসি DTO | PARTIAL (নথিভুক্ত) |
| ব্যবহার-বহির্ভূত ফাইল | `schema-v3.ts` (মাইগ্রেশন), `__probe` (v1.1.2-এ মুছে ফেলা) | PASS |
| ডুপ্লিকেট টাকার সূত্র | একক `computeSale`/`computePurchase` | PASS |

## ৩. এই অডিটে নতুন করে পাওয়া ত্রুটি (সব ঠিক করা হয়েছে)

1. **ইউজার DTO** — `rowToUser()` `{ ...row }` করত, তাই `password_hash`/`password_salt` লগইন,
   `users.list`, `users.get`, `user.create`, `user.update` উত্তরে যেত। → হোয়াইটলিস্ট-কলাম DTO,
   আলাদা `UserCredentialRow` শুধু `login`/`changeOwnPassword`-এ।
2. **পাবলিক কী override** — `process.env.SAUDA_LICENSE_PUBLIC_KEY` প্রোডাকশনেও মান বদলাত। → সরানো;
   টেস্ট/রিবাইন্ড শুধু `VerifyOptions.publicKeyB64` দিয়ে।
3. **জেনারেটর dev URL** — `LICGEN_DEV_URL` প্যাকেজড বিল্ডেও লোড হতো। → `app.isPackaged` গার্ড +
   loopback-only যাচাই।
4. **জেনারেটর IPC** — `licgen:invoke` sender ফ্রেম যাচাই করত না, navigation ব্লক ছিল না,
   `sandbox: false`। → sender যাচাই, `will-navigate`/`window-open` ব্লক, `sandbox: true`।
5. **মূল অ্যাপ IPC/nav** — sender যাচাই ছিল না; `file://` origin তুলনা ফাঁকা ছিল। → আসল ডকুমেন্ট
   পাথ তুলনা + `isTrustedSender`, external link allowlist।
6. **লগইন লকআউট টাইমজোন** — UTC লেখা, লোকাল পড়া। → `parseLockedUntilUtc()`, সব তুলনা UTC-তে।
7. **LAN ট্রান্সপ্লেন** — → AES-256-GCM v2 এনভেলপ, plaintext প্রত্যাখ্যান (426), লগইন রেট-লিমিট,
   `/health`-এ ব্যবসার নাম শুধু টোকেনধারীকে।
8. **কুপন বাতিল** — → `restoreCouponsForSale()` (সীমা ও কাস্টমার-কোটা ফেরে, একবারই)।
9. **সিরিয়াল লাইফসাইকল** — → `releaseSerialsForSale()`, `returnSerialsFromSale()`, POS-এ
   `serials.available` + সিরিয়াল পিকার (আগে UI-তেই উপায় ছিল না)।
10. **অটো-ব্যাকআপ** — → ১৫ মিনিটের টাইমার + রেন্ডারার নোটিফিকেশন + ঘড়ি পিছিয়ে গেলে “due”।
11. **ইমপোর্ট/ব্যাকআপ পাথ** — রেন্ডারার থেকে আসা পাথে এক্সটেনশন/আকার/ফাইল যাচাই।
12. **গেট** — `verify.mjs`-এ বিষয়বস্তু-ভিত্তিক সিক্রেট স্ক্যান, Electron ট্রাস্ট-বাউন্ডারি চেক,
    প্রোডাকশন ডিপেন্ডেন্সি অডিট; রিলিজ ওয়ার্কফ্লো এখন হুবহু `npm run verify` চালায়।

## ৪. যা এখনো অসম্পূর্ণ (সত্যি করে)

| বিষয় | স্টেটাস | ব্যাখ্যা |
|---|---|---|
| ইংরেজি অনুবাদ (পুরোনো রিটেইল পেজ) | PARTIAL | শেল ও নতুন পেজ দ্বিভাষিক; পুরোনো পেজ বাংলা-ভিত্তিক, `docs/18`-এ নথিভুক্ত |
| `any` টাইপের অবশিষ্ট ব্যবহার | PARTIAL | রানটাইমে যাচাই আছে; টাইপ-নিরাপত্তা ভবিষ্যৎ কাজ |
| পারফরম্যান্স রিগ্রেশন গেট | MISSING | ম্যানুয়াল পরিমাপ আছে, CI থ্রেশহোল্ড নেই |
| হার্ডওয়্যার ও Windows ইনস্টলার | BLOCKED | এই পরিবেশে Electron/Windows নেই |
| পিক্সেল-ভিত্তিক UI রিগ্রেশন | MISSING | ওয়্যারিং অডিট + SSR স্মোক আছে, ভিজুয়াল ডিফ নেই |

## ৫. যাচাই (এই অডিটের পরে)

- টাইপচেক: ৩ প্যাকেজ, ০ ত্রুটি।
- টেস্ট: **২৮২ / ২৮২**, ২৫ ফাইল (২৬৩ → ২৮২; নতুন ১৯টি রিগ্রেশন)।
- ওয়্যারিং অডিট: ২৪৩ IPC রুট, ১৮৫ কল সাইট, অসঙ্গতি নেই।
- `npm run verify`: সবুজ (টেস্ট + অডিট + দুই বিল্ড + সিক্রেট + ডিপ অডিট)।
