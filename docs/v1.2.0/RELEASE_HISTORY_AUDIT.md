# v1.2.0 — release history audit

*Phase 0 deliverable. Scope limits are stated up front and apply to every row: this environment can
read the source, tags and release metadata for every version, but cannot download release assets
(`release-assets.githubusercontent.com` is blocked) and has no Windows host. So a release can be
audited as **source + metadata**, not as an executed binary. Rows below say which.*

## 1. Per-release findings

| Release | Version in tree | Source audited | Installer executed | Notes |
| --- | --- | --- | --- | --- |
| v1.0.0 / v1.0.1 | 1.0.x | yes (tags, notes) | **no** | first public builds; no audit reports retained beyond release notes |
| v1.1.0 | 1.1.0 | yes | **no** | LAN/server mode introduced per notes; installer ≈110.9 MiB |
| v1.1.1 | 1.1.1 | yes | **no** | generator grows 87 KB, app unchanged in size — consistent with generator-only changes |
| v1.1.2 | 1.1.2 | yes | **no** | **+11.0 MiB jump** in both installers (see §3) |
| v1.1.3 | 1.1.3 | yes | **no** | IPC sender trust, auto-backup scheduling, audit-pass 1 fixes |
| v1.1.4 | 1.1.4 | yes | **no** | two-PC hardening, restore safety, native artifacts |
| v1.1.5 | 1.1.5 | yes | **no** | A-01…A-29; **−5.5 MiB** from prebuild pruning |

## 2. What each release's own documentation claims

Every release from v1.1.3 onward ships a release notes file, an audit report and a test report. All of
them were read against the tree at that tag. Two classes of claim were checked and both hold:

- **Test counts** — the numbers in each report match the test files present at that tag.
- **Fix claims** — each claimed fix has a corresponding commit and, from v1.1.4 onward, a named test.

No release notes were found to describe a feature that is absent from the tagged source.

## 3. The two size discontinuities, explained

- **v1.1.1 → v1.1.2: +11.0 MiB.** The tree at v1.1.2 adds the whole-property scale work and the
  Electron runtime bump recorded in `docs/19-RELEASE-NOTES-V110.md`. Uncompressed payload growth of
  this size is consistent with a Chromium/Electron upgrade; it is *not* investigated further here
  because it is history, not a v1.2.0 regression.
- **v1.1.4 → v1.1.5: −5.5 MiB.** A-11 removed seven foreign `better-sqlite3` prebuilds (14.2 MiB
  uncompressed) before packaging. Measured and documented in `docs/V1.1.5_NATIVE_ARTIFACTS.md` §7.

## 4. Regressions introduced and later fixed (from the audit trail)

| Regressions | Introduced | Fixed |
| --- | --- | --- |
| Window server could start while a stream was being registered (A-04) | v1.1.3-era shutdown path | v1.1.5 |
| Stock moved while the ledger posting failed (A-01) | original design | v1.1.5 |
| Serial sold for the wrong product line (A-13) | original design | v1.1.5 |
| Restore could leave no database at all (A-14) | original restore | v1.1.5 |
| Two backups in one second overwrote each other (A-15) | original naming | v1.1.5 |
| Foreign prebuilds shipped in both installers (A-11) | packaging | v1.1.5 |
| Device approval / revocation could half-apply (A-21) | original design | v1.1.5 |
| Coupon counters trusted their caller (A-22) | original design | v1.1.5 (hardening) |
| 43 changes could commit without their audit line (A-26) | original design | v1.1.5 |
| Generator store and ledger could disagree (A-27) | original design | v1.1.5 |
| Backup file could exist with no row (A-28) | original design | v1.1.5 |
| Restore accepted the live database as a source (A-29) | original restore | v1.1.5 |

## 5. Migration and upgrade requirements by release

Migrations `v2 … v7` are cumulative and idempotent; `v7` is the v1.1.x reporting/index migration and
is covered by `migration-v7.test.ts` (row/column/table preservation, index presence, re-run
idempotency, query plans). Every upgrade path since v1.0.0 runs the same sequence, so an upgrade from
any published version is the same code path as the one tested.

**Not tested, and recorded as such:** a real shop database captured from a v1.0.x or v1.1.x
installation. The migration tests use synthetic databases with the same schema versions. Testing
against a copy of a real customer database is an owner-acceptance item (see
`docs/V1.2.0_OWNER_ACCEPTANCE_TEST_PLAN.md` when written).

## 6. Outdated material found during this audit

| Item | State | Action for v1.2.0 |
| --- | --- | --- |
| `docs/19-RELEASE-NOTES-V110.md` etc. | historically accurate, not maintained | keep as history, do not update |
| `docs/09-known-limits.md` | predates v1.1.x | superseded by per-release known-limitations files; consolidate in v1.2.0 |
| README | describes the product but not the two-application licence flow in one place | rewrite in the documentation phase |
| Historical installers | not verifiable here | limitation recorded, not silently ignored |
