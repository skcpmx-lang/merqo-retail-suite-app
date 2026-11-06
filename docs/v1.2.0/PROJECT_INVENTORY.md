# v1.2.0 — project inventory

*Phase 0 deliverable. Counts come from the tree at `014d7a7`, excluding `node_modules` and built
output.*

## 1. Shape of the repository

| Area | Contents | Size |
| --- | --- | --- |
| `packages/core` | domain, database, services, LAN API, licensing | 35 service modules, 58 test files |
| `packages/app` | Electron main + preload, 29 `.tsx` screens, 6 `.ts` modules under `src/` | 17 app tests |
| `packages/license-generator` | Electron main/preload/domain, 15 `.tsx` screens | 5 tests |
| `scripts` | build, package, verify, audits, release tooling | 7 script tests |
| `.github/workflows` | `ci.yml` (two-platform gate), `release.yml` (Windows build + publish) | 2 |
| `docs` | architecture, guides, per-version audits | 40+ documents |

Total TypeScript/TSX source files (excluding `node_modules`, `dist`): **235**.

## 2. Main App — screens present

`About, Accounting, Activation, Backup, Cash, CustomerDisplay, Dashboard, Expenses, Inventory, Login,
POS, Parties, Products, Promotions, PurchaseOrders, Purchases, Reports, Returns, Sales, Settings,
Setup, StockOps, Team` (23 page components under `packages/app/src/pages`, plus shared components).

## 3. Core services (35 modules)

`accounting, appInfo, attendance, audit, auth, backup, cash, catalog, crm, customers, dashboard,
devices, event-retention, events, expenses, idempotency, imports, inventory, invoice, notifications,
payments, pos, products, promotions, purchase-orders, purchases, reports, returns, sale-conflicts,
sales, search, settings, setup, stock-ops, suppliers`.

## 4. Database

- Schema in `packages/core/src/db/schema.ts` (+ `schema-v5.ts`), migrations `v2 … v7`.
- SQLite with WAL; foreign keys enforced (`fk_rows=0` in the benchmark harness), `integrity_check = ok`.
- Money is integer paisa; quantities are integer milli-units. No floats touch money.
- Pre-migration safety backup exists in `db/connection.ts` (A-17).

## 5. Licensing surface

| Piece | Where |
| --- | --- |
| Public verification key | `packages/core/src/licensing/*` (verification only) |
| Private signing key | License Generator only, never in the repo — enforced by `scripts/verify-installer.mjs` and the secret scan |
| Device request `.sauda-device` | Generator import → customer association |
| Licence export `.sauda` | Generator → Main App import/verification |
| Device enrolment | Main PC, admin approval, `devices.ts` (atomic since A-21) |
| Generator store + ledger | `licenses-admin.json` + `issue-ledger.jsonl` (commit together since A-27) |

## 6. Automated protection already in place

`scripts/audit-hooks.mjs` (no suppressed exhaustive-deps), `scripts/audit-native.mjs` (prebuild
provenance), `scripts/audit-transactions.mjs` (a change and its audit line share a transaction),
`scripts/audit-ui.mjs` + `scripts/audit-license-generator.mjs` (renderer/IPC wiring), `secret-scan`,
`verify-installer.mjs`, `render-release-notes.mjs`, `check-release-notes.mjs`.

## 7. Known gaps in the inventory itself

- No per-screen automated UI tests exist (the renderer is covered by wiring audits and logic tests,
  not by component tests). Building that harness is a v1.2.0 work item.
- No end-to-end test drives the two applications against each other; the pairing/licensing flows are
  covered by core integration tests and loopback sockets.
