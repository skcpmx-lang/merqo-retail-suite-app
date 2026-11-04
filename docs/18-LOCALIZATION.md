# 18 — Localization (বাংলা ⇄ English)

Sauda Retail Suite ships bilingual. Bengali is the default because the shops it
serves read Bengali bills; English exists for owners, accountants and auditors
who work in English.

## 1. How it works

| Piece | File | Behaviour |
| --- | --- | --- |
| Dictionary + API | `packages/app/src/i18n.tsx` | ~210 keys, `useT()`, `useLang()`, `setLang()`, `translate()` with `{var}` interpolation |
| Persistence | `settings.language` (`'bn' \| 'en'`) | Written by the topbar toggle and by Settings → Appearance & language |
| Document-level marker | `<html data-lang>` | Lets CSS adjust typography (line-height, letter-spacing) per script |
| Numbers | `settings.bengali_digits` | `৳ ১,২৩৪.৫০` vs `৳ 1,234.50` for screens *and* printed documents |
| Print | `DocFormat.bengaliDigits` | The same switch reaches receipts, invoices and reports |

Language is chosen at first-run setup and can be changed at any time from the
topbar (`বাং / EN`) or Settings. A change takes effect immediately — no restart —
because the setting is read through a React subscription, not a module constant.

## 2. Typography rules

- Bengali: **Nirmala UI** (Windows 8+), then *Noto Sans Bengali*, then *Vrinda*,
  then a generic sans-serif. Line-height 1.55 so matras are never clipped.
- Latin: the same stack falls through to Segoe UI — mixed sentences (e.g.
  "ইনভয়েস INV-000123") keep a consistent baseline.
- Digits are never forced into Bengali for technical identifiers: invoice
  numbers, SKUs, barcodes, phone numbers, licence keys and timestamps stay in
  ASCII so they can be copied, scanned and matched.

## 3. What is translated today

| Area | Status |
| --- | --- |
| Shell: navigation, topbar, shortcuts, empty states, toasts | ✅ bn + en |
| Dashboard, Purchase orders, Promotions, Team, Customer display | ✅ bn + en |
| Settings (appearance, network, business identity) | ✅ bn + en |
| Printed documents (headings, labels, totals) | ✅ bn + en |
| Older v1.0 screens (POS, Products, Accounting, Reports …) | ⚠️ Bengali only — English strings fall back to Bengali |

The fallback is deliberate: a missing key shows the Bengali string instead of a
raw key like `pos.title`. Adding an English string is then a data change, never
a code change.

## 4. Adding a language

1. Add the column to `STRINGS` in `i18n.tsx` (order: bn, en, …).
2. Extend `Lang`.
3. Extend the segmented control in the topbar and in Settings → Appearance.
4. Add the language to `SetupInput.language` validation in `services/setup.ts`.

No business logic reads the language; it only affects presentation.

## 5. Honest limits

- **English coverage is partial** (shell + v1.1 screens + printed documents).
  The older screens remain Bengali-only in v1.1.0; this is recorded in
  `docs/09-known-limits.md` and the release notes rather than presented as
  complete.
- Bengali shaping depends on the Windows font stack. On a stripped Windows
  install without *Nirmala UI* the app still renders (Noto/Vrinda fallback) but
  kerning may differ — verify on the target machine during installation.
- No right-to-left language is supported.
