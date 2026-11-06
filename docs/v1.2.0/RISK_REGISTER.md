# v1.2.0 — risk register

Scored as **likelihood × impact** on the shop's data and on the release itself. Severity bands:
**S1** blocks a release, **S2** must be fixed or accepted in writing, **S3** tracked.

| ID | Risk | L | I | Sev | Mitigation / status |
| --- | --- | --- | --- | --- | --- |
| R-01 | A release is published from an unmerged branch, so `main` does not match what customers download (already true for v1.1.5) | high | high | **S1** | Fast-forward `main`; new pre-publication gate `scripts/audit-release-branch.mjs`; v1.2.0 tag must be on `main` |
| R-02 | A real shop database fails to migrate | low | high | **S1** | Pre-migration safety backup (A-17); migration tests on synthetic v2…v7 databases; **real v1.1.4/v1.1.5 database upgrade is owner testing (T34/T35) — NOT TESTED** |
| R-03 | Windows-only runtime failure that Linux CI cannot see | medium | high | **S1** | `Gate — Windows (windows-latest)` runs the full suite on every push; both green on the current tip |
| R-04 | Installer ships a foreign or wrong-architecture native binary | low | high | **S2** | `scripts/audit-native.mjs` + `verify-installer.mjs`; A-11 pruned to one prebuild; measured −5.5 MiB at v1.1.5 |
| R-05 | Private signing key leaks into an installer, the repo or CI | low | high | **S1** | Secret scan in `verify`, key-material scan on packaged files in `release.yml`, key never in the Main App; **no key exists in this repository** |
| R-06 | Backup file exists but the app cannot see it (A-28 window) | low | medium | **S3** | `reconcileBackups()` on backup-list and before auto-backup; verified by 7 tests |
| R-07 | Renderer names a path that reaches a privileged operation | low | high | **S2** | A-29 `assertRestorablePath`; path allowlists on `app.openPath`; dialogs for imports; audited in `V1.1.5_SECURITY_REVIEW.md` |
| R-08 | Two terminals race a shared counter (coupon, gift card, stock, seat) | medium | medium | **S2** | Conditional `UPDATE` guards, `IMMEDIATE` where a check precedes a write, two-connection race tests (A-21, A-22) |
| R-09 | Reporting date boundary drifts between screens | medium | medium | **S3** | `date-filter-v115` tests midnight/23:59:59 boundaries; shared helper planned |
| R-10 | No automated UI/component coverage; a screen regression reaches the owner | high | medium | **S2** | Wiring audits exist; component/UI test harness is a v1.2.0 work item (W-2) |
| R-11 | Physical/VM acceptance never runs, and the release is presented as if it did | medium | high | **S1** | Owner deferred it explicitly; every doc says **NOT TESTED — OWNER TESTING DEFERRED**; no row is ever marked passed |
| R-12 | Historical installers cannot be re-verified in this environment | certain | low | **S3** | Recorded in the baseline and release-history audit; no claim of binary verification is made |

## What this register is not

It is not a claim that these are the only risks. It is the set found by reading the tree at `014d7a7`
plus the v1.1.5 audit trail. Phases 1–5 of the v1.2.0 directive are expected to add entries; when they
do, they will be added here with an ID rather than in a separate document.
