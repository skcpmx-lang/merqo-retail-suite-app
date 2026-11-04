# FINAL SECURITY AUDIT — v1.1.3

তারিখ: ২০২৬-১১-০৪ · স্টেটাস শব্দ: `PASS` / `PARTIAL` / `FAIL` / `BLOCKED`

প্রতিটি ফলাফলের পাশে প্রমাণ: কোড পাথ, টেস্ট নাম বা কমান্ড। যাচাই না করা কিছু “PASS” নয়।

---

## ০. সারসংক্ষেপ

| তীব্রতা | পাওয়া | ঠিক করা | বাকি |
|---|---|---|---|
| Critical | 3 | 3 | 0 |
| High | 5 | 5 | 0 |
| Medium | 4 | 4 | 0 |
| চেক করা গেল না (পরিবেশ) | — | — | GUI/Windows/হার্ডওয়্যার |

সব ঠিক করা ত্রুটির রিগ্রেশন টেস্ট আছে: `packages/core/test/security-v113.test.ts` (৮),
`packages/core/test/integrity-v113.test.ts` (৭), `packages/core/test/lan.test.ts` (১৫, নতুন ৫)।

---

## ১. মূল অ্যাপের ইউজার ডেটা (S-1, Critical) — `PASS`

- **ত্রুটি:** `auth.ts`-এ `rowToUser()` ছিল `{ ...row, permissions }`; `listUsers`/`getUser` `SELECT *`।
  ফলে `password_hash`, `password_salt` প্রতিটি লগইন ও ইউজার-ব্যবস্থাপনা IPC উত্তরে যেত এবং
  রেন্ডারার state/DevTools-এ দৃশ্যমান হতো।
- **সমাধান:** স্পষ্ট `USER_PUBLIC_COLUMNS` তালিকা, `rowToUser()` প্রতিটি ফিল্ড হাতে ম্যাপ করে;
  ক্রেডেনশিয়াল কলাম শুধুমাত্র `getCredentialRow()`/`getCredentialRowById()` (module-private) দিয়ে
  পড়া হয়, শুধু `login()` ও `changeOwnPassword()`-এ। `getByUsername()` আর পাবলিক এক্সপোর্ট নয়
  (`usernameExists()` যোগ হয়েছে)।
- **প্রমাণ:** `security-v113.test.ts` → “keeps hash and salt out of login, list, get, create and update
  results” — রিকার্সিভভাবে সব কী-পাথ স্ক্যান করে, তারপর সংরক্ষিত হ্যাশ/সল্ট স্ট্রিং সার্চ করে।

## ২. পাবলিক কী ট্রাস্ট বাউন্ডারি (S-2, Critical) — `PASS`

- **ত্রুটি:** `resolvePublicKeyB64()` `process.env.SAUDA_LICENSE_PUBLIC_KEY` পড়ত। যে কেউ শর্টকাট/র্যাপার
  স্ক্রিপ্টে ভেরিয়েবল বসিয়ে নিজের কী দিয়ে সাইন করা লাইসেন্স দিয়ে পুরো দোকান আনলক করতে পারত।
- **সমাধান:** `publicKey.ts` এখন শুধু কম্পাইল-করা ধ্রুবক ফেরত দেয়; কোনো env পড়া হয় না।
  কী অনুপস্থিত/ভুল হলে `ed25519PublicKeyFromBase64()` ব্যর্থ → `verifyLicense()` “signature_invalid”
  → fail-closed। টেস্ট/রিবাইন্ড শুধু `VerifyOptions.publicKeyB64` (ফাংশন আর্গুমেন্ট) দিয়ে।
- **প্রমাণ:** `security-v113.test.ts` → “ignores SAUDA_LICENSE_PUBLIC_KEY and rejects a licence signed by it”;
  “has a well-formed embedded key that decodes to a 32-byte Ed25519 point” (SPKI হেডার যাচাই)।
  `verify.mjs` প্রোডাকশন কোডে `process.env[SAUDA_LICENSE_*KEY]` থাকলে বিল্ড ব্যর্থ করে।

## ৩. লাইসেন্স জেনারেটর (S-3, Critical) — `PASS`

- **ত্রুটি:** (ক) `LICGEN_DEV_URL` প্যাকেজড বিল্ডেও লোড হতো — রিমোট পেজ পেলে প্রিভিলেজড `licgen`
  ব্রিজ পেত (সাইনিং অথরিটি আক্রমণকারীর হাতে); (খ) IPC sender যাচাই ছিল না; (গ) `will-navigate` ব্লক
  ছিল না; (ঘ) `sandbox: false`।
- **সমাধান:** dev URL এখন `app.isPackaged` হলে সম্পূর্ণ উপেক্ষিত এবং loopback (`localhost`/`127.0.0.1`/`::1`)
  ছাড়া প্রত্যাখ্যাত; `trustedRendererUrl` সেট হয় লোডের সময়েই; `isTrustedSender(event)` প্রতিটি
  IPC কলে আগে চলে; `will-navigate` + `setWindowOpenHandler` + `will-attach-webview` ব্লক;
  `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `devTools` শুধু unpackaged।
- **অতিরিক্ত:** `backup.restore` পাথ এখন এক্সটেনশন/আকার/ফাইল-অস্তিত্ব যাচাই করে (`requireReadableFile`),
  `reveal` শুধু app-owned ফোল্ডারে।
- **প্রমাণ:** `scripts/audit-license-generator.mjs` (০ সমস্যা) + `verify.mjs`-এর নতুন ট্রাস্ট-বাউন্ডারি
  চেক, যা `main.ts`-এ `isTrustedSender(event)` ও `app.isPackaged` গার্ড না পেলে বিল্ড ব্যর্থ করে।

## ৪. মূল অ্যাপের IPC ও নেভিগেশন (S-4, High) — `PASS`

- **ত্রুটি:** `sauda:invoke` কোনো sender যাচাই করত না। `will-navigate`-এ `new URL(url).origin` তুলনা
  করা হতো; `file://` URL-এর origin হয় `"null"`, তাই **যেকোনো লোকাল ফাইল** নেভিগেট করে পুরো
  লাইসেন্স-গেটেড ব্রিজ উত্তরাধিকার পেত।
- **সমাধান:** `isTrustedRendererUrl()` আসল ডকুমেন্ট পাথ (`renderer/index.html`) বা dev origin মেলায়;
  `isTrustedSender(event)` প্রতিটি IPC-তে; external link শুধু allowlist-করা https হোস্ট
  (`shell.openExternal`), বাকি সব ব্লক। `sandbox: true` দুই উইন্ডোতে।
- **প্রমাণ:** কোড + `verify.mjs` ট্রাস্ট-বাউন্ডারি চেক। (Electron রানটাইম টেস্ট এখানে **BLOCKED**।)

## ৫. LAN ট্রান্সপোর্ট (S-6, High) — `PASS` (নতুন সাইফার)

- **ত্রুটি:** প্লেইন HTTP-তে `Authorization: Bearer <shop token>` এবং সব বিক্রয়/কাস্টমার JSON;
  একই নেটওয়ার্কের যে কেউ sniff করলে পুরো ব্যবসার ডেটা ও টোকেন পেত। লগইন চেষ্টায় রেট-লিমিট ছিল না।
- **সমাধান:**
  - সব `/rpc` বডি **AES-256-GCM** দিয়ে সিল হয় (`sealLanPayload`/`openLanPayload`), কী =
    `scrypt(token, 'sauda-lan-transport-v2')`; nonce প্রতি অনুরোধে ১২ বাইট, AAD `sauda-lan-transport-v2`।
  - পুরোনো plaintext অনুরোধ **426 TRANSPORT_OUTDATED** দিয়ে প্রত্যাখ্যাত — ডাউনগ্রেড আক্রমণ বন্ধ।
  - লগইন: প্রতি সোর্স-অ্যাড্রেসে ১৫ মিনিটে ১০ ব্যর্থতার পর **429 RATE_LIMITED**।
  - `/health` আর অননুমোদিত কাউকে ব্যবসার নাম দেয় না।
  - টোকেন তুলনা আগে থেকেই `timingSafeEqual`; শুধু প্রাইভেট (RFC1918/loopback) পিয়ার।
- **প্রমাণ:** `lan.test.ts` → “encrypts every request and response body”, “refuses the old plaintext
  protocol instead of downgrading”, “rejects a tampered ciphertext without running any route”,
  “rate-limits repeated bad logins from one address”, “serves a health probe but only reveals the
  business to a token holder”।
- **সীমা (সৎ):** এটি প্রি-শেয়ার্ড-কী সিমেট্রিক এনক্রিপশন, TLS নয় — কোনো ফরওয়ার্ড-সিক্রেসি নেই,
  এবং টোকেন যে মেশিনেই আছে সে ডিক্রিপ্ট করতে পারে (এটাই কাঙ্ক্ষিত)। `docs/17`-এ লেখা আছে।

## ৬. Electron কনফিগ — `PASS`

| সেটিং | মূল অ্যাপ | জেনারেটর |
|---|---|---|
| `contextIsolation` | true | true |
| `nodeIntegration` | false | false |
| `sandbox` | true (v1.1.3) | true (v1.1.3) |
| `webSecurity` | true | true |
| `allowRunningInsecureContent` | false | false |
| নতুন উইন্ডো | deny (allowlist ছাড়া) | deny |
| navigation | শুধু নিজের ডকুমেন্ট | শুধু নিজের ডকুমেন্ট |
| permission request | সব deny | (Electron ডিফল্ট, কোনো permission ব্যবহার নেই) |
| CSP | `index.html` meta (script-src 'self') | meta (script-src 'self') |
| DevTools | শুধু unpackaged | শুধু unpackaged |
| single instance | হ্যাঁ | হ্যাঁ |

## ৭. লগইন, RBAC ও অডিট — `PASS`

- scrypt (N=16384) + প্রতি ইউজার র‍্যান্ডম salt; `timingSafeEqual` তুলনা।
- ৫ ব্যর্থতায় ৫ মিনিট কুলডাউন; **UTC-তে সংরক্ষণ ও তুলনা** (S-5 ঠিক করা) — `parseLockedUntilUtc()`।
- অজানা ইউজারনেমেও কাউন্টার, অডিট ও সমান-সময় প্রতিক্রিয়া (ডামি scrypt)।
- কুলডাউন কেস-পরিবর্তন বা পুনরায় চালু করে এড়ানো যায় না (DB-তে সংরক্ষিত)।
- ২৪টি অনুমতি; প্রতিটি IPC রুটে `perm` ইন্টারফেস-স্তরেই বাধ্যতামূলক (রুট যোগ করলে `perm` ছাড়া টাইপ এরর)।
  UI-তে বাটন লুকানো কেবল অতিরিক্ত — হোস্ট নিজে `requirePermission()` চালায়।
- অডিট লগ: `scrub()` দিয়ে সংবেদনশীল ফিল্ড বাদ, ৪০০০ অক্ষরে কাটা, শুধু অ্যাড।

## ৮. সিক্রেট স্ক্যান গেট — `PASS` (শক্ত করা হলো)

`verify.mjs` এখন তিনটি স্তর চালায়:
1. ফাইলনাম প্যাটার্ন (`secrets/`, `*.pem`, `*.pfx`, `id_ed25519`)।
2. **বিষয়বস্তু** স্ক্যান: ট্র্যাক করা সব টেক্সট ফাইলে `-----BEGIN … PRIVATE KEY-----` থাকলে ব্যর্থ।
3. **রানটাইম কী override** স্ক্যান: প্রোডাকশন কোডে `process.env[...KEY]` থাকলে ব্যর্থ।

ইনস্টলার যাচাই (`scripts/verify-installer.mjs`) CI-তে আগের মতোই ইনস্টলারের ভেতরে কী-মেটেরিয়াল খোঁজে।

## ৯. ডিপেন্ডেন্সি অডিট — `PARTIAL` (স্বীকৃত সীমা)

- `npm audit --omit=dev`: **০** ভুলনারেবিলিটি; high/critical **০**। `verify.mjs` এখন প্রোডাকশন
  high/critical পেলে বিল্ড আটকায়।
- সম্পূর্ণ ট্রি-তে ১৫টি moderate — সবই `electron-builder` বিল্ড-টুলচেইন (`app-builder-lib`, `dmg-builder`,
  `ejs`, `glob`, `minimatch`, `rimraf`, `temp`, `extract-zip`)। ইনস্টলারে যায় না; আপস্ট্রিম ফিক্স নেই → `PARTIAL`।

## ১০. যা এই পরিবেশে প্রমাণ করা যায়নি (`BLOCKED`)

| দাবি | অবস্থা | কারণ |
|---|---|---|
| Electron ৪৩ রানটাইমে sender-যাচাই কার্যকর | BLOCKED | GUI/Electron বাইনারি নেই |
| জেনারেটর প্যাকেজড বিল্ডে dev URL উপেক্ষা | BLOCKED (কোডে গার্ড আছে, রানটাইমে দেখা যায়নি) | প্যাকেজিং Windows-এ |
| Windows স্মার্টস্ক্রিন/কোড সাইনিং | BLOCKED | সার্টিফিকেট নেই |
| দুই-পিসি LAN-এ এনক্রিপ্টেড ট্রান্সপোর্ট | BLOCKED | দ্বিতীয় মেশিন নেই (লুপব্যাক টেস্ট পাস) |
| ইনস্টলারে কোনো প্রাইভেট কী নেই | BLOCKED (এখানে) | CI-র `verify-installer.mjs` করে |
