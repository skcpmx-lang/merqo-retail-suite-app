# v1.1.3 — প্রকাশের প্রমাণ (Release Evidence)

তারিখ: ২০২৬-১১-০৪ · এই নথিতে শুধু **যা যাচাই করা গেছে** তা আছে; যাচাই না করা কিছু দাবি করা হয়নি।

---

## ১. কোড ও মার্জ

| বিষয় | মান |
|---|---|
| কাজের শাখা | `arena/45805452-merqo-retail-suite-app` |
| কমিট | `7c8e4cd` (মূল কাজ) + `178ed9e` (verify স্ক্যানের পরিধি ঠিক) |
| PR | **#9** “v1.1.3 — close credential leak, licence trust bypass, LAN plaintext, coupon/serial reversal” |
| মার্জ | ২০২৬-১১-০৪T১০:২২:১৮Z → `main` = **`f4dc640`** (কোড মার্জ) |
| ট্যাগ | **`v1.1.3`** → `f4dc640` (রিলিজ রান এই কমিট থেকেই) |
| এরপরের কমিট | PR **#10** → `main` = `e2d76cd` — শুধু এই প্রমাণ-নথিটি যোগ করে; **কোড অপরিবর্তিত** |

## ২. CI (PR ও push)

| রান | কমিট | ফল |
|---|---|---|
| 41813249730 (PR, প্রথম) | `7c8e4cd` | **failure** — নতুন সিক্রেট-স্ক্যান টেস্ট-ফিক্সারের `process.env.SAUDA_LICENSE_PUBLIC_KEY` ধরে ফেলে |
| 178ed9e পুশের পর | `178ed9e` | **success** (push + PR check, দুইটিই) |

প্রথম ব্যর্থতাটি লুকানো হয়নি: এটি ছিল নিজের নতুন গেটের অতিরিক্ত-প্রশস্ত পরিধি; `scripts/verify.mjs`
এখন শুধু **শিপ হওয়া কোড** স্ক্যান করে (`test/`, `docs/`, `CHANGELOG` বাদ) এবং সেই কারণেই
`docs/FINAL_SECURITY_AUDIT_V113.md` §৮-এ লেখা আছে। গেটটি দুর্বল করা হয়নি — প্রোডাকশন ট্রি পুরোপুরি স্ক্যান হয়।

## ৩. রিলিজ রান (`Release (Windows installers)`)

| বিষয় | মান |
|---|---|
| রান | **41813780258** · শাখা `v1.1.3` · ফল **success** |
| “Verify (typecheck, tests, audits, builds, secrets, audit)” | success |
| “Build both applications” | success |
| দুই NSIS প্যাকেজিং | success |
| “Verify installers (size, key material, checksums)” | success |
| “Publish GitHub Release” | success |
| রিলিজ প্রকাশ | ২০২৬-১১-০৪T১০:২৭:১৬Z |

## ৪. প্রকাশিত অ্যাসেট (GitHub API থেকে)

| ফাইল | আকার (বাইট) |
|---|---|
| `Sauda-Retail-Suite-Setup-1.1.3.exe` | 121,965,051 |
| `Sauda-License-Generator-1.1.3.exe` | 121,782,665 |
| `SHA256SUMS.txt` | 201 |

তুলনা: v1.1.2-এ ছিল 121,961,782 · 121,781,751 · 201 — আকার প্রায় অপরিবর্তিত, অর্থাৎ নতুন কোড
বান্ডলে ঢুকেছে কিন্তু কোনো বড় ডিপেন্ডেন্সি যোগ হয়নি।

## ৫. যাচাই (লোকাল, রিলিজের আগে)

```
tsc core/app/license-generator        → 0 error
vitest run                            → 282 passed / 25 files
audit-ui                              → 243 routes · 185 call sites · consistent
audit-license-generator               → 12 pages · 37 routes · 0 problems
build app + build license generator   → ok
secrets (filename+content+env)        → clean
electron trust boundary               → both guarded
npm audit --omit=dev                  → 0 high/critical
```

## ৬. যা এখনো BLOCKED (সৎভাবে)

| আইটেম | কারণ |
|---|---|
| ইনস্টলার ডাউনলোড করে SHA-256 পুনঃহিসাব | স্যান্ডবক্স থেকে `release-assets.githubusercontent.com`-এ পৌঁছানো যায় না |
| Windows-এ ইনস্টল/আপগ্রেড/UAC | Windows মেশিন নেই (CI ইনস্টলার তৈরি ও আকার/কী-স্ক্যান করেছে) |
| শারীরিক হার্ডওয়্যার (প্রিন্টার/ড্রয়ার/দ্বিতীয় মনিটর) | হার্ডওয়্যার নেই |
| দুই-পিসি LAN এনক্রিপশন | দ্বিতীয় মেশিন নেই (লুপব্যাক টেস্ট পাস) |

প্রতিটির প্রতিলিপি পদ্ধতি: `docs/FINAL_QA_CHECKLIST_V113.md`।
