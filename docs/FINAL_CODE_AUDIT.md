# FINAL CODE AUDIT

Scope: `packages/core` (domain, db, licensing, services), `packages/app`
(Electron main/preload, React renderer), `packages/license-generator`, `scripts`,
`.github/workflows`. Baseline: `FINAL_AUDIT_BASELINE.md`.

## 1. Size and shape

| Area | Lines | Notes |
|---|---|---|
| `packages/core/src` | 9 750 | 23 services + domain + db + licensing + export |
| `packages/app/src` (renderer) | 12 179 | 17 pages, 48 icons, 187 CSS classes |
| `packages/app/electron` | 1 945 | main process, preload bridge, 131-route IPC dispatcher |
| `packages/license-generator/src` | 356 | separate vendor tool |
| `packages/core/test` | 2 238 | 99 assertions across 6 files |
| **Total first-party** | **26 468** | |

Runtime dependencies shipped inside the app: **2** (`better-sqlite3`,
`qrcode-generator`). Everything else is bundled at build time. A small
dependency surface is the single most effective security and longevity measure
for an offline product that must survive years without internet updates.

## 2. Architecture conformance

The stated rule — *all money and quantity arithmetic lives in the core; the
renderer only formats* — holds:

- `packages/app/src/**` contains no arithmetic on money fields; it calls
  `money(paisa)` / `kg(milli)` from `@sauda/core`.
- The renderer has no database access: every call goes through
  `window.sauda.invoke` → `ipc.ts` → a core service.
- `scripts/audit-ui.mjs` (added by this audit) verifies that all 105 renderer
  call sites resolve to one of the 131 registered IPC routes, that all 48 icon
  names exist and that all 187 CSS classes have rules. This automates a class of
  bug that would otherwise only appear when a screen is opened.

`AppContext = { db, user, openDb, reopenDb }` keeps the live connection owned by
the main process, so backup/restore can close and reopen it safely.

## 3. Type-safety

- `node scripts/typecheck.mjs` type-checks all three packages with `strict:
  true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` — **clean**.
- No `any` in `packages/core/src` outside three documented IPC-boundary
  casts (`args: any[]` in the dispatcher, JSON payloads).
- `packages/core/dist` is rebuilt by `scripts/build-core.mjs`; the shipped app
  bundles `core/src` through the esbuild alias, so no stale `.d.ts` can drift
  into the installer.

## 4. Error handling and transactions

- Every write path runs inside `db.transaction()`; `workflow.test.ts` proves a
  failing sale leaves zero rows behind.
- Services throw `AppError` subclasses with Bangla messages; the IPC dispatcher
  converts them to `{ ok: false, error, code }` and never leaks a stack trace to
  the renderer.
- The audit found and fixed one leak: `openDatabase` threw on a newer-schema file
  **without closing the connection**, leaving the file locked on Windows
  (`FINAL_BUG_AND_WARNING_REGISTER.md` F6).

## 5. Dead code, TODOs and placeholders

| Check | Result |
|---|---|
| `TODO` / `FIXME` / `XXX` in first-party source | 0 |
| Buttons with empty handlers | 0 (all 105 call sites resolve; review of `onClick` bodies found only real IPC calls) |
| Hardcoded statistics on screen | 0 (all numbers come from `dashboard.*`, `reports.*`) |
| Unused icon names | 0 |
| CSS classes used with no rule | 0 after this audit (5 were added, 2 allow-listed as layout-only) |

## 6. Build and packaging

| Artefact | Result |
|---|---|
| `dist/main/main.js`, `preload.js` | esbuild CJS bundles, `better-sqlite3` and `electron` external |
| `dist/renderer` | 465.58 kB JS (125.29 kB gzip), 29.94 kB CSS (6.97 kB gzip) — no code splitting needed for an offline LAN-free app |
| Production CSP | rewritten at build time to `connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`; the build **fails** if the rewrite does not apply |
| NSIS (both apps) | produced on a real Windows runner, verified by `scripts/verify-installer.mjs` (size floor, no key material, SHA-256 list) |

## 7. Findings (all fixed during this audit)

| ID | Severity | Finding | Status |
|---|---|---|---|
| C-1 | HIGH | `openDatabase` leaked a connection when migration threw (Windows file lock) | FIXED |
| C-2 | MEDIUM | 5 CSS classes referenced with no rule — Reports report picker and diagnostics log rendered unstyled | FIXED |
| C-3 | MEDIUM | No automated guard against icon/class/route drift | FIXED (`scripts/audit-ui.mjs` wired into `verify`) |
| C-4 | LOW | Code comments pointed at a non-existent `docs/LICENSING_ARCHITECTURE.md` | FIXED (→ `docs/04-licensing.md`) |
| C-5 | LOW | Production renderer kept the dev CSP allowance `connect-src ws://localhost:*` | FIXED (build-time rewrite) |
| C-6 | LOW | No central permission denial for camera/mic/geolocation/USB | FIXED (`setPermissionRequestHandler(false)`) |

No `FAIL`-level code finding remains open. See
`FINAL_BUG_AND_WARNING_REGISTER.md` for the full register including the
financial and database defects.
