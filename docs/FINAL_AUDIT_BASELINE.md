# FINAL AUDIT BASELINE

Snapshot of exactly what was audited, on what, and with which tools. Every other
`FINAL_*.md` document in this repository cites this baseline; if the baseline
does not list a verification method, no status in this audit was inferred from
it.

| Item | Value |
|---|---|
| Repository | `skcpmx-lang/merqo-retail-suite-app` |
| Branch audited | `arena/f0a78dcd-merqo-retail-suite-app` |
| Branch point | `9ddd2399596f45d4c6ce2ef73fe996f70ca69b9f` (`main`) |
| Audit date (UTC) | 2026-11-04 |
| Product version | 1.0.0 |
| Schema version | 1 (`SCHEMA_VERSION`) |

## Verification levels used in this audit

Every status in this audit carries a level, because "it compiles" and "a
shopkeeper printed a receipt on a 58 mm thermal printer" are not the same claim.

| Level | Meaning |
|---|---|
| **L1 — static** | Type-checker, grep/search, source review, generated artefacts inspected |
| **L2 — automated** | Executed by the test suite or an audit script, result captured |
| **L3 — measured** | Timed/measured on a running system with hardware and dataset recorded |
| **L4 — packaged** | Both installers were built by the release pipeline from the audited commit |
| **L5 — field** | Executed on the customer's real Windows hardware, real printer, real scanner |

**L5 was not possible in this audit environment** (Linux container, no display,
no printer, no scanner, no Windows machine). Any requirement whose only honest
evidence would be L5 is reported as `PARTIAL` or `BLOCKED`, never `PASS`.

## Environment used for measurement

```
node    v22.22.3
cpu     Intel(R) Xeon(R) Processor @ 2.60GHz
ram     4131 MB
os      linux (container, no display server)
sqlite  better-sqlite3 13.0.3 (bundled SQLite)
```

The measured numbers in `FINAL_PERFORMANCE_REPORT.md` therefore describe a
**shared, throttled container CPU** and should be re-measured on the target
shop PC before quoting them to a customer. They are honest, not optimistic.

## Commands that produced the evidence

| Purpose | Command | Result |
|---|---|---|
| Type-check (all 3 packages) | `node scripts/typecheck.mjs` | clean |
| Test suite | `npx vitest run` | **99 / 99 pass**, 6 files |
| Renderer/IPC wiring | `node scripts/audit-ui.mjs` | 26 files, 48 icons, 187 CSS classes, 131 IPC routes, 105 call sites — consistent |
| Full local gate | `node scripts/verify.mjs` | typecheck + tests + icons + both builds + secrets scan pass |
| Performance | `node scripts/bench.mjs --products N --customers N --sales N` | see performance report |
| Windows packaging | GitHub Actions `Release (Windows installers)` run **41787673767** on tag `v1.0.0-rc.4` | every step green, both NSIS installers produced |
| Installer integrity | `scripts/verify-installer.mjs` (runs inside the release job) | size floor met, no key material, SHA-256 list written |

## Scope actually covered

- 24 230 lines of first-party TypeScript/TSX/CSS (`packages/*/src`, `packages/app/electron`)
  plus 2 238 lines of tests.
- 23 core services, 131 IPC routes, 17 renderer pages, 27 reports.
- 31 tables, 43 indexes, 56 foreign-key references, 1 schema version.
- Licensing (Ed25519), packaging (electron-builder/NSIS), CI workflows.

## Deliberately out of scope (and why)

| Area | Reason |
|---|---|
| Real thermal printing (58/80 mm), paper height, Bengali glyph rendering on printer firmware | No hardware, no Windows, no printer driver in this environment |
| Physical barcode/QR scanner input | No hardware |
| Windows install → activate → backup → uninstall → reinstall → restore walkthrough on the customer machine | No Windows machine; installers exist (L4) but were not executed (L5) |
| Licence behaviour after OS reinstall / disk replacement on real hardware | Needs two real machines and the vendor's private signing key |
| Code signing (Authenticode) of the installers | No certificate available in this environment |
| Antivirus false-positive review of the NSIS installers | Requires the packaged EXE on a Windows host with AV installed |

These gaps are also listed in `docs/09-known-limits.md` and are the reason the
commercial verdict is **B** rather than **A**.

## How to reproduce

```bash
npm ci
node scripts/verify.mjs                    # typecheck + 99 tests + builds + secrets scan
node scripts/bench.mjs --products 1000  --sales 2000
node scripts/bench.mjs --products 50000 --customers 2000 --sales 50000
git tag v1.0.0-rc.N && git push origin v1.0.0-rc.N   # pre-release tag: builds, does not publish
```
