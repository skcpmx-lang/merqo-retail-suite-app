# FINAL SECURITY AUDIT

Scope: the offline desktop application (renderer, Electron main, IPC boundary,
core services, SQLite file), the licensing subsystem and the packaging/CI
pipeline. Baseline: `FINAL_AUDIT_BASELINE.md`.

Automated evidence: `packages/core/test/security-audit.test.ts` (21 tests),
`scripts/audit-ui.mjs` (route/icon/class graph), `scripts/verify.mjs` (secret
scan), `scripts/verify-installer.mjs` (private-key scan of the installers).

## 1. Threat model (what this product actually defends against)

| Asset | Threat | Defence | Status |
|---|---|---|---|
| Cash, stock and dues records | A cashier edits or deletes history to hide theft | Void-only model, immutable audit log, permission-gated routes, DB never exposes delete for financial rows | PASS |
| Business data | Copy of the software runs on an unpaid machine | Ed25519 licence bound to hardware fingerprint | PASS |
| Business data | Someone with the vendor's private key leaks it | Key never enters the repo, the app bundle or the installer; CI fails the release if it does | PASS |
| Customer data | Exfiltration over the network | No network code at all; production CSP `connect-src 'none'`; no telemetry | PASS |
| Customer data | Local attacker reads `sauda.db` | **Not encrypted** — accepted risk (see §7) | ACCEPTED |
| Installer | Trojanised build | Build reproducible from source, artefacts uploaded by CI, SHA-256 list published; **not code-signed** | PARTIAL |

Out of scope: multi-user network deployments, remote access, server-side
attacks (there is no server), malware on the shop PC.

## 2. Authentication and authorisation

- Passwords: `scrypt` (N = 16384, r = 8, p = 1, 64-byte key) with a 16-byte
  random per-user salt; never stored or logged in plain text
  (`security-audit` "never stores the plain text"). Minimum length 6, maximum 128.
- Roles: `admin` (implicit all), `manager`, `cashier`; 19 discrete permissions;
  `requirePermission` is enforced **in the main process**, not in the UI, so a
  renderer compromise cannot bypass it (`security-audit` cashier test).
- Every route declares its permission; `ipc.ts` rejects unknown routes and
  unauthenticated calls with `NOT_FOUND` / `AUTH_REQUIRED`.
- Failed logins are written to `audit_logs` with the attempted username.

**Finding S-1 (LOW, accepted):** there is no login attempt throttling. A local
attacker with the machine can attempt passwords at script speed. Accepted
because file access to `sauda.db` already implies full local control, and a
lockout would create a support burden (locked-out shopkeeper at 9 p.m.). The
audit trail records every failure.

## 3. Renderer isolation

| Control | Value | Evidence |
|---|---|---|
| `contextIsolation` | `true` | `main.ts` |
| `nodeIntegration` | `false` | `main.ts` |
| Preload bridge | single `sauda.invoke` + `sauda.onEvent` | `preload.ts` |
| `sandbox` | **`false`** (preload needs `better-sqlite3` in main only; sandbox is off so the preload can load Node built-ins) | `main.ts` — documented risk |
| `webSecurity` | default (on) | — |
| Navigation | `will-navigate` blocked for any other origin; `setWindowOpenHandler` denies and hands http(s) to the OS browser | `main.ts` |
| Device permissions | camera/mic/geolocation/notifications/USB/HID **denied** via `setPermissionRequestHandler(false)` + `setPermissionCheckHandler(false)` — added during this audit | `main.ts` |
| Production CSP | `default-src 'self'; img-src 'self' data: file:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'` | rewritten by `scripts/build-app.mjs`, build fails if it cannot apply |
| Receipt preview | `<iframe srcDoc>` inherits the parent CSP (`script-src 'self'`, no inline script allowed) | `POS.tsx` |
| `dangerouslySetInnerHTML` | not used anywhere; the single `innerHTML` is a static string shown when the bridge is missing | `main.tsx` |

**Finding S-2 (MEDIUM, accepted for 1.0):** `sandbox: false`. Turning the
sandbox on requires moving the preload to a context-isolated, sandbox-safe
bridge (no `require` of Node modules) and would be a real refactor. The
compensating controls are `contextIsolation`, no `nodeIntegration`, no remote
content loading at all, and a locked-down CSP. Recorded for the 1.1 hardening
pass rather than changed days before release.

## 4. Injection surfaces

- **SQL**: all statements are prepared with positional parameters; no string
  interpolation of user input into SQL (review of 23 services). The search
  services build `LIKE` patterns but pass the term as a parameter.
  `security-audit` "treats search input as data, not SQL" proves it with
  `' OR 1=1 --`, `%`, `_`, and quote payloads.
- **Filesystem**: every path that comes from the UI (export folder, backup file,
  open-path) passes through `assertInside(root, candidate)`
  (`paths.ts`); `app.openPath` only accepts paths inside the app data or the
  user's chosen export directory.
- **CSV**: parser handles BOM, quotes, CRLF, embedded commas and Bangla digits;
  import is preview-then-commit and never partially writes.
- **HTML**: receipts/labels are built from typed values; money and names are
  escaped before insertion into the HTML template.

## 5. Licensing (security-relevant parts)

Full detail in `FINAL_LICENSE_AUDIT.md`. Summary: Ed25519 signature over a
versioned payload (`SAUDA1.<payload>.<sig>`), device binding with weighted
components (45/30/15/10, threshold 0.6), placeholder fingerprints rejected,
clock-rollback guard via `meta.license.max_seen`, and the whole business layer is
**blocked at the IPC dispatcher** when no valid licence is installed (fixed
during this audit — see F5).

## 6. Secrets and build pipeline

| Check | Result |
|---|---|
| Private key material tracked by git | none (`verify.mjs` scans every tracked filename; 0 hits) |
| Private key inside the app bundle | none — the app embeds only the Ed25519 **public** key |
| Private key inside the installers (`win-unpacked/resources`) | scanned byte-wise for `-----BEGIN`, `PRIVATE KEY-----`, the Ed25519 PKCS#8 base64 prefix and the generator's private marker; the release job **fails** if any is found — passed in run 41787673767 |
| Private key in the licence-generator EXE | the generator loads the key from a file chosen at runtime and keeps the path in a local config; nothing is embedded |
| CI secrets | only `GITHUB_TOKEN` (release publish) — no customer data, no signing key |
| Telemetry / analytics | none: no analytics dependency, no outbound HTTP, no crash reporter |

## 7. Accepted risks (documented, not hidden)

| ID | Risk | Why accepted | Mitigation available |
|---|---|---|---|
| S-1 | No login throttling | Local access already implies file access; lockout harms the shopkeeper | Add 5-attempt/60 s delay behind a setting |
| S-2 | `sandbox: false` | Sandboxed preload is a refactor; compensating controls are in place | Plan for 1.1 |
| S-3 | `sauda.db` and backups are **not encrypted** | A shop PC with full-disk encryption or a locked room is the realistic control; SQLCipher would add a native dependency and a password-recovery support burden | Optional passphrase-encrypted backup format |
| S-4 | Installers are **not code-signed** | No certificate in this environment | Buy an OV/EV certificate; then set `win.certificateFile` in `package.json` |
| S-5 | Backup files can be copied off the machine by the owner | The owner owns the data | — |

## 8. Findings summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| F5 | HIGH | Business IPC routes were reachable **without a valid licence** (only the UI hid them) — now gated in the dispatcher with a 60 s cache | FIXED |
| S-2 | MEDIUM | `sandbox: false` | ACCEPTED (documented) |
| C-5 | LOW | Production CSP allowed `ws://localhost:*` | FIXED |
| C-6 | LOW | No central denial of device permissions | FIXED |
| S-1 | LOW | No login throttling | ACCEPTED (documented) |
| S-3 | LOW | Unencrypted database/backups | ACCEPTED (documented) |
| S-4 | MEDIUM | Installers unsigned | OPEN — blocked on certificate |

No open `FAIL`. The two accepted MEDIUM items (S-2 sandbox, S-4 signing) are
commercial decisions for the owner, not code defects, and both are stated plainly
in `FINAL_COMMERCIAL_READINESS.md`.
