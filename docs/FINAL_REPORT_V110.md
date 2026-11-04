# FINAL Report — Sauda Retail Suite 1.1.0

Prepared at the end of the v1.1.0 release command (audit → repair → UI/UX →
release). Every number below was produced by running the tool named next to it in
this working session; nothing is copied from an earlier release.

## 1. Numbers

| Metric | 1.0.1 | 1.1.0 |
| --- | --- | --- |
| Automated tests | 164 in 16 files | **199 in 18 files** (`npx vitest run`) |
| Typecheck | 0 errors | **0 errors** in core, app and license-generator (`npm run verify`) |
| IPC routes registered | 191 | **242** (`scripts/audit-ui.mjs`) |
| Renderer files audited | 28 | **35** (same audit) |
| CSS classes enforced | 188 | **240** across two stylesheets |
| Call sites checked | 151 | **184** |
| Reports | 46 | **54** |
| Services | 27 | **30** |
| Screens (pages + gates) | 19 | **23 files / 24 screens** |
| DB schema version | 3 | **4** |
| Migrations | 3 | **4** (append-only) |
| Documents in `docs/` | 28 | **33** |
| UI strings translated (bn+en) | 0 | **210 keys** |

## 2. What was found and fixed in this cycle

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 1 | Critical | Gift-card portion of a sale was credited twice in the cash fallback → unbalanced journal entry | fallback now `paid − giftCardApplied`; regression test in `v110-core` |
| 2 | Critical | No login attempt protection on the optional lock | `login_attempts` table (schema v4) + persistent 5/5-minute cool-down, 3 tests |
| 3 | High | Print layer hard-coded a thermal width, so page documents printed as a 80 mm strip | `widthMm` optional + `landscape` support; A4 path added |
| 4 | High | Duplicate exported type names (`Actor`, `StatementRow`, `escapeHtml`) broke the barrel build | renamed print exports, single source per type |
| 5 | High | Purchase receiving could be over-received | remaining-quantity validation + test |
| 6 | Medium | Topbar theme toggle did nothing on a fresh install | writes the setting, rolls back on failure |
| 7 | Medium | Language toggle applied but the shell did not re-read settings | re-fetch after write |
| 8 | Medium | Sidebar overflowed with long business names | ellipsis + `title` |
| 9 | Medium | Customer-display window would have hit the licence gate | dedicated `#display` route in the renderer |
| 10 | Medium | `audit-ui` only knew `theme.css`, so new components were invisible to it | audit scans every stylesheet |
| 11 | Low | Obsolete `receipt.ts` duplicated receipt markup | deleted (superseded by core print layer) |
| 12 | Low | Dead v1.0 display CSS selectors | replaced with the classes the window actually renders |
| 13 | Low | `docs/16–19` referenced by code did not exist | written |

No Critical or High issue remains open at release.

## 3. Feature count (v1.1 scope)

| Group | Count |
| --- | --- |
| New backend services | 3 (purchase orders, promotions, attendance) + notifications |
| New IPC surface | 51 routes |
| New screens | 4 (purchase orders, promotions, team, customer display) |
| New printed document kinds | 10 through one `print.document` API |
| New reports | 8 (promotion + v1.1 operational) |
| New settings | 10 (language, theme, lock, display, expiry, LAN ×4, website/type/footer) |

## 4. Verification evidence

```
npm run verify
  typecheck: core / app / license generator   → 0 errors
  tests: core                                 → 199 passed (18 files)
  audit-ui                                    → 35 files · 48 icons · 240 classes · 242 routes · 184 call sites · consistent
  secrets scan                                → no key material tracked by git ✔
  build:app / build:license-generator         → ok
```

Release assets are verified through the GitHub API after the tag is pushed (the
sandbox cannot download release attachments): see
`docs/FINAL_RELEASE_VERIFICATION.md`.

## 5. Environment limits (reported, not hidden)

| Area | Status |
| --- | --- |
| Thermal/label printer, cash drawer, barcode scanner | **BLOCKED** — no hardware |
| Real PDF/print pixel verification | **BLOCKED** — no Chromium print pipeline in CI |
| Customer display on a second monitor | **BLOCKED** — single virtual display |
| Two-PC LAN rehearsal on Windows | **BLOCKED** — one machine |
| Windows installer run, UAC, SmartScreen | **BLOCKED** — Linux build host |
| Code-signed installers | **BLOCKED** — no certificate |
| Live-shop pilot | **BLOCKED** — needs a real shop |

## 6. Release decision

Released as **v1.1.0** because: functional, code, wiring and design audits are
complete; 199 tests and all typechecks pass; no Critical/High issue is open;
every claimed hardware behaviour is marked BLOCKED; the private signing key is
not in the repository, the installers or the release assets (verified by the
secrets scan and by inspecting the built artefacts).
