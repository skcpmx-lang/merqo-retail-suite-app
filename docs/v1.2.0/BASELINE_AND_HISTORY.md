# v1.2.0 — baseline and history

*Phase 0 deliverable. Every figure below was read from the repository or the GitHub API on
2026-11-07, from `origin/arena/622f7f30-merqo-retail-suite-app` at `014d7a7`. Nothing here is
estimated.*

## 1. The baseline the work starts from

| Fact | Value |
| --- | --- |
| Published baseline | `v1.1.5` (published 2026-11-06T19:47:37Z) |
| `v1.1.5` tag object → commit | `2d6474895d290760e93186b7e87e1cf1815b63a3` → `5ae2e947324eb14c2ce316c6dc9276916bc3cb86` |
| `origin/main` | `5d46ae6` — "Merge pull request #15" (was `fc15bf3`/v1.1.4-era before the merge; see §2) |
| Work branch | `arena/622f7f30-merqo-retail-suite-app` at `014d7a7` |
| Branch vs main | merged — `main` now contains the whole v1.1.5 tree and Phase 0 (PR #15, fast-forward merge) |
| Version in the tree | `1.1.5` in `packages/app`, `packages/core`, `packages/license-generator`, `packages/license-generator/package.json` and `PRODUCT_VERSION` |
| Node / npm used by CI | Node 22 (`actions/setup-node@v4`), `npm ci` |

## 2. Release-integrity finding — found in Phase 0, **fixed** in PR #15

**Was:** `v1.1.5` was not an ancestor of `main`. Verified at the time with
`git merge-base --is-ancestor v1.1.5 origin/main` → exit 1.

What that means, stated plainly:

- The published v1.1.5 release was built from the work branch, not from `main`.
- `main` still points at the **v1.1.4-era** tree (`fc15bf3`). Anyone who reads `main` today sees
  code that is 27 commits and ~8,500 lines behind the release they can download.
- The v1.2.0 directive requires "merge into `main` before publishing". That requirement cannot be
  satisfied by repeating the v1.1.5 procedure — it has to be fixed as an explicit first step, and it
  has to be *guarded* so it cannot silently happen again.

**Fixed on 2026-11-07** (no history rewrite, no force-push):

1. **Done** — PR #15 merged into `main` as `5d46ae68616e704647977643dee3172400f792eb`
   (https://github.com/skcpmx-lang/merqo-retail-suite-app/pull/15). `main` now contains the entire
   v1.1.5 tree that produced the published installers plus Phase 0. The gate now passes:

   ```
   $ node scripts/audit-release-branch.mjs --tag v1.1.5
   ✔ release-branch gate: v1.1.5 (5ae2e94) is on origin/main (5d46ae6) — the released tree is the
     verified main tree.
   ```

   CI on the merged commit `5d46ae6`: `Gate — Linux (ubuntu-latest)` **success**,
   `Gate — Windows (windows-latest)` **success** (run `42289557752`).
2. Add an automated pre-publication gate that refuses to publish a tag whose commit is not an
   ancestor of `main` — **done in this phase**: `scripts/audit-release-branch.mjs`, wired into
   `release.yml` immediately before the draft release is created, with 5 unit tests. Run against the
   current tree it refuses, as it should:

   ```
   $ node scripts/audit-release-branch.mjs --tag v1.1.5
   ✖ release-branch gate: v1.1.5 (5ae2e94) is not an ancestor of origin/main (fc15bf3).
     Merge the work into origin/main and tag the merged commit before publishing —
     do not publish from a development branch.
   ```

## 3. Release history available for inspection

Sizes are the published asset sizes reported by the GitHub API.

| Release | Published | Main App `.exe` | Generator `.exe` | Assets |
| --- | --- | --- | --- | --- |
| v1.0.0 | 2026-11-04T07:02:44Z | 110,895,203 B | 110,693,834 B | 3 |
| v1.0.1 | 2026-11-04T07:54:52Z | 110,925,778 B | 110,695,747 B | 3 |
| v1.1.0 | 2026-11-04T08:35:21Z | 110,961,912 B | 110,695,772 B | 3 |
| v1.1.1 | 2026-11-04T09:08:31Z | 110,961,915 B | 110,782,406 B | 3 |
| v1.1.2 | 2026-11-04T09:45:16Z | 121,961,782 B | 121,781,751 B | 3 |
| v1.1.3 | 2026-11-04T10:27:16Z | 121,965,051 B | 121,782,665 B | 3 |
| v1.1.4 | 2026-11-04T20:24:17Z | 122,010,956 B | 121,783,153 B | 3 |
| v1.1.5 | 2026-11-06T19:47:37Z | 116,251,036 B | 116,020,334 B | 3 |

Tags present in the repository: `v1.0.0-rc.1` … `v1.0.0-rc.4`, `v1.0.0`, `v1.0.1`, `v1.1.0` …
`v1.1.5`. The four `rc` tags have no GitHub release (pre-release builds only).

The 10.9 MiB step between v1.1.1 and v1.1.2 and the 5.5 MiB drop at v1.1.5 are both explained in
`RELEASE_HISTORY_AUDIT.md` §3 — one is a payload addition, the other is the A-11 prebuild pruning.

## 4. What could and could not be inspected

| Item | Inspected | How |
| --- | --- | --- |
| Source of every release | yes | `git log`, tags, diffs between tags |
| Release notes and audit reports per version | yes | `docs/*.md` in the tree at each tag |
| Installer metadata (name, size, SHA-256) | yes | GitHub API |
| Installer *contents* | **no** for historical builds | this sandbox cannot download release assets (`release-assets.githubusercontent.com` is blocked), and no historical installer is present in the tree |
| Executed historical binaries | **no** | no Windows environment here |

Consequence: the release-history audit below describes **what the shipped artefacts claim and what
their source says**, not what they did on a Windows machine. That distinction is carried through every
document in `docs/v1.2.0/`.

## 5. Test and gate baseline (v1.1.5 tree)

- `npm run verify`: **871 tests, 88 files, 0 failed, 0 skipped**; typecheck ×3; hooks audit;
  native-artifact audit; audit-trail atomicity guard (82 functions, 2 documented exceptions); UI/IPC
  audit; license-generator audit; secret scan; `npm audit --omit=dev` → 0 vulnerabilities; both
  production builds.
- CI (`ci.yml`): `Gate — Linux (ubuntu-latest)` and `Gate — Windows (windows-latest)`, both green on
  `5ae2e94` and `014d7a7`.
- Release (`release.yml`): one Windows job that re-runs the gate, packages both NSIS installers,
  verifies them, renders the notes with measured values, publishes a draft, re-downloads and
  re-verifies the assets, then promotes it.
