# FINAL BUG AND WARNING REGISTER

Every defect and every warning observed during this audit, with the evidence
that produced it and its current state. Nothing was suppressed: warnings that
remain are listed as `OPEN` with the reason they are acceptable.

**Severity:** CRITICAL (data loss / silent corruption) · HIGH (wrong money,
broken core feature, security hole) · MEDIUM (visible defect, degraded safety) ·
LOW (cosmetic, documentation, maintainability).

## Bugs

| ID | Sev | Area | Description | Evidence that found it | Fix | State | Regression test |
|---|---|---|---|---|---|---|---|
| **F5b** | CRITICAL | DB | `db.pragma('PRAGMA journal_mode = WAL')` — better-sqlite3 prepends `PRAGMA`, so **all seven pragmas were syntax errors and silently ignored**. Shipped DBs ran without WAL, with a 2 MB cache, default temp store, and `busy_timeout` 0 | Scratch test reading the pragmas back after open | `PRAGMAS` made keyword-less + post-open verification (WAL logged, `synchronous` re-applied, FKs hard-fail, `busy_timeout` restored) | **FIXED** | `schema-audit` "runs in WAL mode with foreign keys enforced…" asserts `wal`, `synchronous=2`, `foreign_keys=1`, `busy_timeout=8000`, `temp_store=2`, `cache_size=-16000` |
| **F5** | HIGH | Security | IPC dispatcher enforced permissions but **not activation**: all business routes were callable without a licence | Review of `invokeRoute` | Licence gate with 60 s `WeakMap` cache + `LICENSE_REQUIRED` handling in the renderer | **FIXED** | `security-audit` "throws LICENSE_REQUIRED … when nothing is activated" |
| **F1** | HIGH | Money | Sale/purchase return refund was not clamped to the credit the return created; credit invoices were refunded in cash with the due left standing | Financial invariant suite | Clamp + settle-due-first logic in `returns.ts` | **FIXED** | `audit.test.ts` × 4 |
| **F2** | HIGH | Backup | Restore overwrote the live database without validating the backup first (a corrupt file destroyed the shop's data) | Review of `backup.restore` | `validateBackup` (manifest + `integrity_check` + `user_version` gate) before any file swap | **FIXED** | `security-audit` "rejects a backup created by a newer schema instead of corrupting the shop" |
| **F6** | HIGH | DB | `openDatabase` threw on a newer-schema file **without closing the connection**, leaving the file locked (unremovable on Windows) | Windows CI: `fs.rmSync` → `EBUSY` in `schema-audit` cleanup, while all 99 tests passed | `try { migrate } catch { db.close(); throw }` | **FIXED** | Same test now passes on the Windows runner (release run 41787673767) |
| **F3** | MEDIUM | Backup | After a restore the shell kept a stale connection — the app looked broken until restart | Review of `backup.restore` route | `finally { ctx.reopenDb(); }` | **FIXED** | Covered by restore tests (`ctx` reopened) |
| **F-UI-1** | MEDIUM | UI | Five CSS classes were referenced with no rule, so the Reports report picker and the diagnostics log rendered unstyled | `scripts/audit-ui.mjs` (built during this audit) | Added `.report-list`, `.report-item`, `.log-view`, `.cart-line .cl-price` rules | **FIXED** | `audit-ui.mjs` fails the build if a class has no rule |
| **F-UI-2** | LOW | UI | Three Bangla strings contained characters from the wrong script | Byte inspection of JSX strings | Corrected | **FIXED** | — |
| **F-IMP-1** | LOW | Import | Duplicate rows *within a single CSV file* were not detected for customers/suppliers (each row inserted twice) | CSV import audit | `seen` set using `foldForSearch(phone \|\| name)` | **FIXED** | `schema-audit` "imports customers and suppliers with phone de-duplication" |
| **F-PRD-1** | LOW | Products | Code lookup was case-sensitive: typing `rice-01` did not find `RICE-01` | Product search audit | Exact match fast path, then `lower()` fallback across SKU/product code/barcode | **FIXED** | `schema-audit` "looks up by barcode, QR, SKU and product code" |
| **F-DOC-1** | LOW | Docs | Code comments pointed at `docs/LICENSING_ARCHITECTURE.md`, which does not exist | Doc reference sweep | Pointed at `docs/04-licensing.md` | **FIXED** | — |

## Security hardening done while auditing

| ID | Sev | Item | Fix |
|---|---|---|---|
| C-5 | LOW | Production renderer kept the dev CSP allowance `connect-src ws://localhost:*` | `scripts/build-app.mjs` rewrites the CSP after the bundle and **fails the build** if it cannot |
| C-6 | LOW | No central denial of camera/microphone/geolocation/USB requests | `setPermissionRequestHandler(false)` + `setPermissionCheckHandler(false)` |
| C-3 | MEDIUM | Icon/class/IPC-route drift had no automated guard | `scripts/audit-ui.mjs`, wired into `npm run verify` |

## Open findings (accepted, documented, with rationale)

| ID | Sev | Item | Why it is open |
|---|---|---|---|
| D-1 | MEDIUM | `date(sale_date)` in report predicates defeats `idx_sales_date` (`SCAN sales`) | Rewriting every report query days before release risks rounding changes at day boundaries; measured cost 20.3 ms vs 5.55 ms on 200 000 sales, and the slowest report is 101 ms at 50 000 sales — inside budget. Scheduled as the first post-release optimisation. |
| S-2 | MEDIUM | `sandbox: false` in `webPreferences` | Sandboxed preload is a refactor; compensating controls (context isolation, no node integration, no remote content, strict CSP) are in place |
| S-4 | MEDIUM | Installers are not Authenticode-signed | No certificate available in this environment; the owner must supply one |
| S-1 | LOW | No login throttling | Local file access already implies full control; lockout would harm the shopkeeper |
| S-3 | LOW | Database and backups are not encrypted | Accepted for an offline single-PC product; documented for the customer |
| W-1 | LOW | GitHub Actions warns that `actions/checkout@v4` and `actions/setup-node@v4` target Node 20 and are being run on Node 24 | Third-party action metadata, not our code; the jobs still pass. Will disappear when the actions publish Node 24 releases. |
| D-2 | LOW | No triggers/views (derived data maintained by services) | Deliberate design; the ledger + `integrityCheck` detect drift |

## Warnings observed and their disposition

| Where | Warning | Disposition |
|---|---|---|
| CI (release run) | `Node.js 20 is deprecated … actions/checkout@v4, actions/setup-node@v4` | W-1, informational; not a product warning |
| `vitest` | none | — |
| `tsc` (all packages) | none | — |
| `vite build` | none (chunk-size warning does not fire at 465 kB) | — |
| `electron-builder` | none in the successful run 41787673767 | — |

## Historical failures that are no longer open

| Symptom | Root cause | Resolution |
|---|---|---|
| Windows CI: `1 failed | 5 passed` test files while `99 passed` tests | `EBUSY` during cleanup — see F6 | Connection now closed on migration failure |
| Windows CI rc.1–rc.3 failed at "Verify core" | Same F6 (the log was only readable after adding an annotation-based failure summary) | Fixed; rc.4 green end-to-end |
| `ERR_MODULE_NOT_FOUND better-sqlite3` in the benchmark | esbuild bundle written to `/tmp` | Bundle under `node_modules/.cache/` |
| `RangeError: Too few parameter values` in the benchmark seeder | 12 columns, 11 parameters | Fixed |
| Migration test hit `FOREIGN KEY constraint failed` | `createCategory` writes an audit row before any user exists | Test now uses `initializeApp` |

## Summary

| Category | Count |
|---|---|
| Bugs found | 11 |
| Bugs fixed | 11 |
| Security hardenings applied | 3 |
| Open accepted findings | 7 |
| Open FAIL-level items | **0** |
