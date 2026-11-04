# FINAL COMMERCIAL READINESS

## Verdict: **B — commercially ready for a controlled pilot, not yet for an unrestricted launch**

This is a deliberate, conservative B. The product is not being graded on
ambition but on what was actually verified (see `FINAL_AUDIT_BASELINE.md` for
the levels). A) would require field evidence this environment cannot produce;
C) would be unfair, because every automated gate, the financial invariant suite
and the Windows packaging pipeline are green and the two blocking defects found
during the audit were in the money path and the durability path, not in polish.

### Why not A

| Requirement for A | Current state |
|---|---|
| Installers Authenticode-signed (no SmartScreen warning) | **No certificate.** Installers are unsigned — Windows will show "unknown publisher" |
| Verified on real Windows hardware (install → activate → print → backup → uninstall) | **BLOCKED** — no Windows machine, no printer, no scanner here |
| Thermal receipt output proven at 58 mm and 80 mm with Bangla glyphs | **BLOCKED** — no printer |
| Licence issued with the production private key and activated on a second PC | **BLOCKED** — the private key is correctly absent from this environment |
| At least one real shop trading on it for a week | Not possible in an audit |

### Why not C

| Evidence | Result |
|---|---|
| Type-check (3 packages, `strict`) | clean |
| Test suite | **99 / 99 pass** (6 files), including a 11-test financial invariant suite and 14 schema/migration tests |
| Windows packaging pipeline | both NSIS installers built and verified from a tagged commit (run 41787673767) |
| Performance | every interaction ≥ 10× inside the human-noticeable budget at 10× a first-year dataset (`FINAL_PERFORMANCE_REPORT.md`) |
| Data integrity | `integrity_check ok`, `foreign_key_check` 0 rows, refunds reconciled, WAL+FULL durability actually enabled |
| Secrets | no key material in the repo, the app, or either installer (byte-scanned) |
| Offline guarantee | no network code path at all; production CSP `connect-src 'none'` |

## What "controlled pilot" means concretely

Ship to **5–25 shops you can visit or call**, under these conditions:

1. Signed-off agreement that they are on a pilot build (`1.0.x`).
2. You (the vendor) perform the install yourself, on their machine, with the
   thermal printer attached — this converts the `BLOCKED` rows into field
   evidence (`FINAL_QA_CHECKLIST.md` §2).
3. Daily backup to a USB drive they physically keep; verify one restore during
   the pilot.
4. A weekly 10-minute call for the first month; log every complaint in the pilot
   register at the end of `FINAL_QA_CHECKLIST.md`.

## Residual risks the owner must accept before taking money

| # | Risk | Impact | Mitigation | Owner action |
|---|---|---|---|---|
| R1 | Unsigned installer triggers SmartScreen / antivirus warnings | First impression, install friction | Buy an OV code-signing certificate (≈ USD 200–400/yr) and set `win.certificateFile` | **Required before volume sales** |
| R2 | Printer-specific rendering not verified | Receipts may look wrong on a specific model | Test with the two models you sell; keep the font stack in `theme.css` configurable | Required during pilot |
| R3 | Not encrypted at rest | Anyone with the PC can read the shop's books | Recommend BitLocker/Windows device encryption in the onboarding checklist | Recommended |
| R4 | Licence rebinding needs the vendor | A dead motherboard locks the shop out until you respond | Publish a response-time promise (24 h) and keep the generator + key offline but reachable | Required |
| R5 | `sandbox: false` and no login throttling | Local attacker with the machine | Compensating controls in place; plan for 1.1 | Accept |
| R6 | Report queries scan `sales` for date filters | Slow reports at 500 k+ sales | Optimise after release (D-1), monitored by the benchmark script | Planned |
| R7 | Single-developer bus factor | Support continuity | This audit set + `docs/05-build-and-release.md` are complete enough to rebuild and release from a clean clone | Acknowledge |

## Support readiness

| Question a shopkeeper will ask | Ready? |
|---|---|
| "How do I back up?" | Yes — Settings → Backup, plus automatic backup at startup (`docs/02`) |
| "My receipt didn't print" | Yes — printer selection + test print in Settings; logs in Settings → Diagnostics |
| "The app says my licence is invalid" | Yes — device-change flow documented (`docs/04`) |
| "I deleted a sale by mistake" | Yes — void, with permission and audit trail |
| "Can I run two tills?" | **No** — single database, single machine; must be stated in sales material |

## Pricing and delivery reality check

- Delivery is a per-machine installer plus a licence key; no server, no
  subscription enforcement. Renewal is a courtesy ("expires_at" plus a new key),
  not an automatic lock — say so plainly in the offer.
- Because everything is offline, the vendor *must* keep the private key and the
  generator safe; losing the key means every future licence needs a new key pair
  and a re-release of the app.

## Gate to A

A grader can be reached without new code:

1. Sign both installers with a real certificate.
2. Complete `FINAL_QA_CHECKLIST.md` §2 on a Windows 10 and a Windows 11 machine.
3. Print on both printer widths and photograph the output.
4. Issue a real licence, activate on a second machine, request a rebind.
5. Run the pilot for two weeks with at least three shops and no data-loss report.

When those five artefacts exist, this document should be re-issued as **A** with
the evidence attached — not before.
