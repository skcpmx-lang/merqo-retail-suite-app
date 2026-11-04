# বিল্ড ও রিলিজ

## ১. প্রয়োজনীয় পরিবেশ

| জিনিস | সংস্করণ |
|---|---|
| Node.js | ২২ LTS (≥ 20.19) |
| npm | ১০+ |
| OS | Windows 10/11 x64 (প্যাকেজিংয়ের জন্য); Linux/macOS শুধু ডেভেলপমেন্ট ও টেস্টের জন্য |
| Python | ৩.১১+ (better-sqlite3 কম্পাইলের জন্য, শুধু যদি prebuilt না মেলে) |

## ২. ইনস্টল

```bash
npm ci
```

Electron ডাউনলোড না চাইলে (CI বা সীমাবদ্ধ নেটওয়ার্কে):

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
```

`better-sqlite3` prebuilt বাইনারি না পেলে সোর্স থেকে কম্পাইল হবে (`node-gyp` + Python + build tools দরকার)।

## ৩. প্রতিদিনের কমান্ড

| কমান্ড | কী করে |
|---|---|
| `npm run typecheck` | তিন প্যাকেজের টাইপচেক |
| `npm test` | ৯৯টি core টেস্ট |
| `npm run build:core` | core-এর `.d.ts` ইমিট |
| `npm run dev:app` | (ঐচ্ছিক) vite dev সার্ভার + Electron |
| `npm run build:app` | main/preload (esbuild) + renderer (vite) |
| `npm run build:license-generator` | জেনারেটর বান্ডল + রেন্ডারার কপি |
| `npm run icons` | `build/icon.png`, `icon.ico` তৈরি |
| `npm run verify` | টাইপচেক + টেস্ট + আইকন + দুই বিল্ড + সিক্রেট স্ক্যান |
| `npm run dist:app` | অ্যাপ বিল্ড + **সাইনড** NSIS ইনস্টলার (সাইনিং কনফিগ না থাকলে থেমে যায়) |
| `npm run dist:license-generator` | জেনারেটর বিল্ড + **সাইনড** NSIS ইনস্টলার |
| `npm run keys:generate` | নতুন Ed25519 স্বাক্ষর কী (`secrets/`, `--force` ছাড়া ওভাররাইট নয়) |

আউটপুট:
- `packages/app/dist/{main,renderer}`
- `packages/app/release/Sauda-Retail-Suite-Setup-<version>.exe`
- `packages/license-generator/release/Sauda-License-Generator-<version>.exe`

## ৪. প্যাকেজিং কনফিগ

`electron-builder` কনফিগ দুই `package.json`-এর `build` ফিল্ডে:

- NSIS, per-user ইনস্টল, ইনস্টল পাথ বদলানো যায়
- ডেস্কটপ ও স্টার্ট মেনু শর্টকাট (বাংলা নাম)
- `deleteAppDataOnUninstall: false` → **আনইনস্টলে ডেটা/ব্যাকআপ মুছে যায় না**
- `asarUnpack: better-sqlite3` → নেটিভ মডিউল বান্ডলের বাইরে থাকে
- আইকন `../../../build/icon.ico`

## ৫. CI

| ওয়ার্কফ্লো | ট্রিগার | কাজ |
|---|---|---|
| `.github/workflows/ci.yml` | প্রতিটি পুশ/PR | Ubuntu-তে `npm run verify` |
| `.github/workflows/release.yml` | ম্যানুয়াল (`workflow_dispatch`) অথবা `v*` ট্যাগ | Windows-এ দুইটি **আনসাইনড** ইনস্টলার → workflow artifact (কোনো Release তৈরি হয় না) |

v1.1.4 থেকে রিলিজ প্রক্রিয়া:

- **Authenticode সাইনিং প্রয়োজন নেই** — মালিক আনসাইনড ইনস্টলার গ্রহণ করেছেন। কোনো সার্টিফিকেট,
  `CSC_LINK`, `WINDOWS_CODE_SIGNING_SUBJECT` বা Azure Trusted Signing কনফিগ লাগে না; কোনো signing
  secret কোথাও রাখা হয় না। কনফিগ থাকলে সেটি স্বয়ংক্রিয়ভাবে ব্যবহার হবে, না থাকলে বিল্ড **ব্যর্থ হয় না**।
- `scripts/check-signing-env.mjs` শুধু তথ্য দেখায় — সবসময় exit 0।
- `permissions: contents: read` — workflow নিজে কোনো Release লিখতে পারে না; publish সবসময় হাতে।
- `node scripts/verify-installer.mjs --dir artifacts` — ProductVersion/FileVersion, PE `8664` (x64),
  key-material স্ক্যান এবং SHA-256; এগুলো ব্যর্থ হলে `SHA256SUMS.txt` লেখা হয় না।
  Authenticode অবস্থা শুধু **রিপোর্ট** হয় (`Unsigned — accepted by owner.`)। ভবিষ্যতে সাইনিং বাধ্যতামূলক
  করতে চাইলে `--require-signature` ব্যবহার করুন (তখন timestamp-ও দরকার হবে)।
- রিলিজ নোট হিসেবে শুধু `docs/V1.1.4_RELEASE_NOTES.md` গৃহীত।

প্রকাশ (publish) সবসময় হাতে, ধাপে ধাপে: verified `.exe` + `SHA256SUMS.txt` নিয়ে **draft** release
তৈরি → ডাউনলোড করে hash আবার যাচাই → তারপরই publish। বিস্তারিত:
`docs/V1.1.4_WINDOWS_BUILD_SIGNING_HANDOFF.md`।

## ৬. রিলিজ চেকলিস্ট

- [ ] `npm run verify` সবুজ
- [ ] `CHANGELOG.md` আপডেট
- [ ] ভার্সন তিন `package.json`-এ মিল (`core`, `app`, `license-generator`)
- [ ] `publicKey.ts`-এ সঠিক পাবলিক কী ও KEY_ID
- [ ] `artifacts/` কোথাও লাইসেন্স প্রাইভেট কী নেই (স্ক্যান পাস)
- [ ] Windows মেশিনে সত্যিকারের ইনস্টল + দুই প্রস্থের থার্মাল রিসিট + রিপোর্ট PDF পরীক্ষা
- [ ] ব্যাকআপ → আনইনস্টল → পুনরায় ইনস্টল → রিস্টোর পরীক্ষা
- [ ] দুই ইনস্টলার: ভার্সন `1.1.4`, x64, SHA-256 মিলে যায়; Authenticode **Unsigned — accepted by owner**
- [ ] `docs/V1.1.4_RELEASE_NOTES.md`-এ কোনো `<placeholder>` নেই
- [ ] draft release → ডাউনলোড করে hash পুনরায় যাচাই → publish

## ৭. সমস্যা সমাধান

| লক্ষণ | কারণ ও সমাধান |
|---|---|
| `better-sqlite3` ERR_DLOPEN / NODE_MODULE_VERSION | Electron ABI mismatch; `npm rebuild better-sqlite3 --runtime=electron` অথবা CI প্যাকেজিং ব্যবহার করুন |
| electron-builder “cannot find module” | আগে `node scripts/build-app.mjs` চালান |
| আইকন ত্রুটি | `npm run icons` |
| বিল্ডে `Cannot find module '@sauda/core'` | esbuild alias স্ক্রিপ্ট ব্যবহার করুন, `tsc` নয় |
| ইনস্টলারে SmartScreen সতর্কতা | প্রত্যাশিত — ইনস্টলার আনসাইনড; “More info → Run anyway” |
