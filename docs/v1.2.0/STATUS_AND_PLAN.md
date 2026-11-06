# v1.2.0 — status and plan

*This file exists so nobody has to guess how much of the v1.2.0 directive has actually been done.
It is updated at the end of every work unit and it lists unstarted work as unstarted.*

Last updated: 2026-11-07, tree `014d7a7` + this phase's commits.

## 1. What is complete

| Phase | Deliverable | Status |
| --- | --- | --- |
| 0 | Baseline and history | **PASS** — `BASELINE_AND_HISTORY.md` (real tag/commit/release data, the `main`-behind finding) |
| 0 | Project inventory | **PASS** — `PROJECT_INVENTORY.md` (counts, modules, screens, guards) |
| 0 | Release-history audit | **PASS with a stated limit** — `RELEASE_HISTORY_AUDIT.md`; historical installers are audited as source + metadata, never as executed binaries |
| 0 | Architecture assessment | **PASS (first pass)** — `ARCHITECTURE_ASSESSMENT.md`, 7 weaknesses named with actions |
| 0 | Risk register | **PASS (open)** — `RISK_REGISTER.md`, R-01 … R-12 |
| 14 | Release-process fix for requirement #20 | **PASS** — `scripts/audit-release-branch.mjs` + 5 tests, wired into `release.yml` before the draft release |

## 2. What is **not** complete

Nothing below has been started beyond what the table says. Listing it this way is the point: the
alternative is a document that sounds finished and is not.

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Two-application architecture audit (full) | **PARTIAL** — the structural reading is in `ARCHITECTURE_ASSESSMENT.md`; the licensing ecosystem map (`LICENSING_ECOSYSTEM_AUDIT.md`) is **not written** |
| 2 | Module-by-module functional audit (every screen, every service, every Generator page) | **NOT STARTED** |
| 3 | Database and business-logic perfection (every table, every invariant, property tests) | **PARTIAL** — invariants are enforced and tested for money/stock/coupons/gift cards/devices/ledger from the v1.1.5 work; a systematic per-table sweep is **NOT STARTED** |
| 4 | Security audit + threat model (`SECURITY_AUDIT.md`, `THREAT_MODEL.md`) | **NOT STARTED** (the v1.1.5 second pass exists as `docs/V1.1.5_SECURITY_REVIEW.md`) |
| 5 | UI/UX/theme/accessibility audit, screen by screen | **NOT STARTED** |
| 6 | Language/localization audit + terminology glossary | **NOT STARTED** |
| 7 | Performance and stability programme | **PARTIAL** — measured baselines exist (`V1.1.5_PERFORMANCE.md`, `createSale` median 1.99 ms); no systematic before/after programme |
| 8 | Product gap analysis, feature roadmap, technical-debt plan | **NOT STARTED** |
| 9 | Unified implementation plan with IDs | **NOT STARTED** (this file is the skeleton) |
| 10 | Expanded automated testing (component, e2e, property-based, installer) | **PARTIAL** — 876 tests across 89 files, plus 6 verify-time guards; component/e2e/property suites are **NOT STARTED** |
| 11 | Windows automation + owner acceptance plan (`OWNER_ACCEPTANCE_TEST_PLAN.md`, `WINDOWS_VERIFICATION.md`) | **NOT STARTED** (v1.1.5 has `V1.1.5_VM_TEST_PLAN.md`) |
| 12 | Documentation and commercial readiness | **NOT STARTED** |
| 13 | Final cross-audit and requirement traceability matrix | **NOT STARTED** |
| 14 | Merge to `main`, tag, build, publish v1.2.0 | **BLOCKED** on the phases above |

## 3. Honest statement of scale

Phases 1–13 are a multi-week programme for a team: seven new audit documents, a screen-by-screen UI and
language pass over ~38 screens in two applications, property-based tests over the financial invariants,
a component/end-to-end test harness that does not exist yet, and then a re-audit of all of it. It is not
something that can be truthfully reported as complete inside one session, and this document does not
pretend otherwise.

What has been done is real and verifiable: the baseline is measured rather than remembered, the
release-process defect that let v1.1.5 ship from an unmerged branch is fixed and guarded, and the
risk register names the work that remains.

## 4. Recommended next work unit

Ordered by risk reduction per unit of effort:

1. **Merge to `main`** (requirement #20; a pure fast-forward today) so the repository's front door
   matches what customers run. This must happen before any v1.2.0 tag.
2. **Phase 4 security audit + threat model** — the highest-value unstarted analysis, and it feeds the
   risk register directly.
3. **Phase 2 module inventory for the Main App** — a per-screen/per-service table with test coverage,
   which then drives Phases 5, 6 and 10.
4. **Component-test harness** (Phase 10 / R-10) — the largest gap in the automated protection today.
5. **Phase 5 + 6 in one pass per renderer** — a screen cannot be reviewed for language without being
   reviewed for layout, so doing them together is cheaper than doing them separately.
