# FINAL RELEASE VERIFICATION

What was verified before the release, what the release pipeline produces, and
what remains unverifiable in this environment.

## 1. Pre-release gates (all green on the audited commit)

| Gate | Command / workflow | Result |
|---|---|---|
| Type-check, 3 packages | `node scripts/typecheck.mjs` | clean |
| Test suite | `npx vitest run` | **99 / 99** pass, 6 files |
| UI/route wiring | `node scripts/audit-ui.mjs` | consistent (26 files, 48 icons, 187 classes, 131 routes, 105 call sites) |
| Full local gate | `node scripts/verify.mjs` | typecheck + tests + icons + both builds + secrets scan ✔ |
| CI (ubuntu) | `.github/workflows/ci.yml` run 41786685237 | success, 39 s |
| Performance | `node scripts/bench.mjs` (2 datasets) | see `FINAL_PERFORMANCE_REPORT.md` |

## 2. Packaging verification on a real Windows runner

Seven pre-release tags were used to prove the pipeline without publishing a
customer-facing release (`-rc` tags skip the publish step by design).

| Tag | Run | Outcome |
|---|---|---|
| `v1.0.0-rc.1` | 41786681680 | FAILED at "Verify core" — the Windows failure evidence was not yet readable |
| `v1.0.0-rc.2` | 41786994448 | FAILED at the same step (log artefact added, not yet retrievable in this environment) |
| `v1.0.0-rc.3` | 41787325552 | FAILED, and now diagnosable: 99/99 tests passed but the file cleanup threw `EBUSY` on a database handle left open by a failed migration (defect **F6**) |
| `v1.0.0-rc.4` | 41787673767 | **SUCCESS — every step green** |

`v1.0.0-rc.4` step results (Windows runner, `windows-latest`):

```
Install dependencies                        success
Typecheck core                              success
Run core tests                              success   (99 passed)
Generate icons                              success
Build both applications                     success
Package Sauda Retail Suite (NSIS)           success
Package Sauda License Generator (NSIS)      success
Collect installers                          success
Verify installers (size, key material, …)   success
Upload workflow artifacts                    success
```

Artefact `sauda-windows-installers`: **221 595 443 bytes** (both installers plus
`SHA256SUMS.txt`).

This proves, at level **L4**:

- both packages build from a tagged commit on a clean Windows machine,
- electron-builder produces both NSIS installers (app + separate licence
  generator),
- the installers are large enough to be real applications (≥ 20 MB floor),
- **neither installer nor the unpacked resources contain any private key
  material** (byte scan for PEM markers, the Ed25519 PKCS#8 prefix and the
  generator's private marker),
- a SHA-256 manifest is generated for the published files.

## 3. Production release — executed and verified (2026-11-04)

| Item | Value |
|---|---|
| Merge | PR #1 merged into `main` (`--merge`, history preserved), merge commit `da5e10cd157701239bc7a8d7b1befe8b36e9624b` |
| Release tag | `v1.0.0` (annotated) on the merge commit |
| Workflow run | **41788965176** — `Release (Windows installers)` — **success**, including the `Publish GitHub Release` step |
| Release page | https://github.com/skcpmx-lang/merqo-retail-suite-app/releases/tag/v1.0.0 |

Published assets (sizes and digests as reported by the GitHub API):

| Asset | Size | SHA-256 |
|---|---|---|
| `Sauda-Retail-Suite-Setup-1.0.0.exe` | 110 895 203 bytes (105.8 MiB) | `1149782cce4a967b81e63b066e6a1991cd66314f018543566d95e878c6dc2877` |
| `Sauda-License-Generator-1.0.0.exe` | 110 693 834 bytes (105.6 MiB) | `a62f588f8f3865bb917506b1423033a20c34929e35754e83fe32ffcee4b7d48a` |
| `SHA256SUMS.txt` | 201 bytes | `37f1a065dba4ba36bee57d8b4f186b79bd0b7b70cfaf5693f23af3c1e8bf0101` |

The release job ran every gate again on the released commit (typecheck, 99 tests,
both builds, installer verification incl. the private-key byte scan) and only
then published. The two artefacts are separate installers, as required — the
customer never receives the licence generator.

## 4. Release checklist executed by the owner

1. `git tag -a v1.0.0 -m "Sauda Retail Suite 1.0.0"` on the reviewed merge commit.
2. `git push origin v1.0.0`.
3. The `Release (Windows installers)` workflow re-runs every gate above and, for a
   non-`-rc` tag, publishes a GitHub Release with:
   - `Sauda-Retail-Suite-Setup-1.0.0.exe`
   - `Sauda-License-Generator-Setup-1.0.0.exe`
   - `SHA256SUMS.txt`
4. Download both files, compare the SHA-256 against `SHA256SUMS.txt`, and record
   the hashes in the customer-facing release note.
5. Install on a clean Windows machine and complete `FINAL_QA_CHECKLIST.md` §2.

## 5. What this document cannot certify

| Item | Status | Reason |
|---|---|---|
| Installer executes correctly on Windows | `BLOCKED` (L5) | No Windows machine in the audit environment; the pipeline proves the artefacts exist and are key-free, not that the installer runs |
| Printer output, scanner input | `BLOCKED` | No hardware |
| Code signature / SmartScreen behaviour | `NOT DONE` | No certificate |
| Licence issue → activation with the production key | `BLOCKED` | Private key correctly absent |
| Antivirus false positives | `NOT DONE` | Requires a Windows host with AV |

Each of these is an explicit acceptance gate in
`FINAL_COMMERCIAL_READINESS.md` and a tick-box in `FINAL_QA_CHECKLIST.md`.

## 6. Post-release install verification (owner, on a Windows machine)

| Step | Expected result | Done |
|---|---|---|
| Download the setup from the release page | 110 895 203 bytes, hash matches the table above | ☐ |
| Verify SHA-256 against `SHA256SUMS.txt` | Identical | ☐ |
| Install on clean Windows 10 | Completes, shortcut created | ☐ |
| First launch | Activation screen, no crash | ☐ |
| Activate with a real licence | Dashboard opens | ☐ |
| Create one sale, print one receipt | Numbers and Bangla text correct | ☐ |
| Back up, uninstall, reinstall, restore | Data intact | ☐ |
| Install on Windows 11 | Same results | ☐ |
