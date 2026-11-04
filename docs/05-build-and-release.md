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
| `npm test` | ৫৩টি core টেস্ট |
| `npm run build:core` | core-এর `.d.ts` ইমিট |
| `npm run dev:app` | (ঐচ্ছিক) vite dev সার্ভার + Electron |
| `npm run build:app` | main/preload (esbuild) + renderer (vite) |
| `npm run build:license-generator` | জেনারেটর বান্ডল + রেন্ডারার কপি |
| `npm run icons` | `build/icon.png`, `icon.ico` তৈরি |
| `npm run verify` | টাইপচেক + টেস্ট + আইকন + দুই বিল্ড + সিক্রেট স্ক্যান |
| `npm run dist:app` | অ্যাপ বিল্ড + NSIS ইনস্টলার |
| `npm run dist:license-generator` | জেনারেটর বিল্ড + NSIS ইনস্টলার |
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
| `.github/workflows/release.yml` | `v*` ট্যাগ বা ম্যানুয়াল | Windows-এ দুই ইনস্টলার → GitHub Release |

রিলিজ করতে:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Actions শেষ হলে Release-এ দুটি `.exe` যুক্ত হবে। ম্যানুয়ালি চালালে “version” ইনপুট দিয়ে ভার্সন বদলানো যায়।

## ৬. রিলিজ চেকলিস্ট

- [ ] `npm run verify` সবুজ
- [ ] `CHANGELOG.md` আপডেট
- [ ] ভার্সন তিন `package.json`-এ মিল (`core`, `app`, `license-generator`)
- [ ] `publicKey.ts`-এ সঠিক পাবলিক কী ও KEY_ID
- [ ] Windows মেশিনে সত্যিকারের ইনস্টল + দুই প্রস্থের থার্মাল রিসিট + রিপোর্ট PDF পরীক্ষা
- [ ] ব্যাকআপ → আনইনস্টল → পুনরায় ইনস্টল → রিস্টোর পরীক্ষা
- [ ] ট্যাগ পুশ → Release-এ দুই EXE যাচাই

## ৭. সমস্যা সমাধান

| লক্ষণ | কারণ ও সমাধান |
|---|---|
| `better-sqlite3` ERR_DLOPEN / NODE_MODULE_VERSION | Electron ABI mismatch; `npm rebuild better-sqlite3 --runtime=electron` অথবা CI প্যাকেজিং ব্যবহার করুন |
| electron-builder “cannot find module” | আগে `node scripts/build-app.mjs` চালান |
| আইকন ত্রুটি | `npm run icons` |
| বিল্ডে `Cannot find module '@sauda/core'` | esbuild alias স্ক্রিপ্ট ব্যবহার করুন, `tsc` নয় |
