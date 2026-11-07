# v1.2.0 — security audit (Phase 4)

*Source-level audit of both applications and the connection between them, done by reading the code at
`5d46ae6` plus the fixes in this phase. Severity: **S1** blocks a release, **S2** fix or accept in
writing, **S3** tracked.*

## 0. Scope and method

| Area | How it was checked |
| --- | --- |
| Authentication, sessions, lockout | read `services/auth.ts`, `net/rpc.ts`; exercised by existing tests |
| Authorization / role boundaries | read the IPC dispatcher (`electron/ipc.ts`), the LAN route table, `scripts/audit-ui.mjs` |
| IPC trust boundary | read `electron/main.ts` (`isTrustedSender`, window options), preload surface |
| Input validation | adversarial probes against sale/purchase/coupon/expense/stock APIs (negative and zero values) |
| SQL injection | every `db.prepare(\`…\`)` interpolation site in `packages/core/src`, traced to its source string |
| Path traversal / file access | every route that takes a path: `app.openPath`, image import, backup restore/validate, imports |
| Cryptography | password hashing, licence signing/verification, TLS, pinning, nonce signing |
| Replay protection | `net/device-auth.ts`, `SqliteReplayGuard` |
| Network exposure | `net/rpc.ts` (legacy tunnel), `net/api.ts` (LAN server), bind addresses |
| Audit-trail integrity | every write path to `audit_logs`; mutation paths; new database triggers |
| Installer / supply chain | `scripts/verify-installer.mjs`, `scripts/audit-native.mjs`, secret scan |
| Dependencies | `npm audit --omit=dev` (0 vulnerabilities at audit time) |

**Not performed, and not claimed:** penetration testing against a live two-PC installation, an
antivirus/EDR run, Windows runtime testing, and review of historical installers (this environment
cannot download them). Those are owner-acceptance items.

## 1. Findings

### SEC-01 — a plaintext listener was one missing argument away (S2, **FIXED**)

- **Application:** Main App (core network layer), reachable by any caller of `startRpcHost`.
- **Module:** `packages/core/src/net/rpc.ts`.
- **Root cause:** `startRpcHost` chose its transport from `opts.tls` and its interface from
  `opts.host ?? '0.0.0.0'`. With no TLS *and* no host, it served **plaintext HTTP on every
  interface**. The legacy tunnel passed `127.0.0.1`, so the product was safe *by accident of its
  caller* — the library itself failed open. The first request on that listener carries the login
  credentials; the AES-GCM envelope key is derived from the shop token sent alongside it, so plaintext
  transport is the only thing standing between an eavesdropper and a password.
- **Evidence:** `startRpcHost({ port: 0, token })` succeeded and reported `bound_host: 0.0.0.0`,
  `protocol: 'http'`. Reproduced in the new test file before the fix.
- **Business impact:** on a shop LAN (shared switches, café Wi-Fi, a well-meaning technician setting
  `SAUDA_ALLOW_LEGACY_RPC=lan`), credentials and every RPC body could be captured.
- **Fix:** the combination `no TLS + non-loopback bind` is refused unless the caller passes
  `allowPlaintextLan: true`. The deprecated LAN mode passes it **only** when the operator opted in via
  `SAUDA_ALLOW_LEGACY_RPC=lan`; the loopback default is unaffected. `isLoopbackHost()` is exported and
  tested against `127.0.0.1`, `localhost`, `::1`, `[::1]`, and rejects `0.0.0.0`, `::`, LAN ranges.
- **Regression test:** `packages/core/test/security-hardening-v120.test.ts` — `SEC-01` block (5 tests).
  Removing the guard fails 2 of them.
- **Status:** **FIXED**.

### SEC-02 — the audit trail was append-only by convention only (S2, **FIXED**)

- **Application:** both (shared database layer).
- **Module:** `packages/core/src/db/schema.ts`.
- **Root cause:** nothing in the product updates or deletes `audit_logs`, but nothing prevented it
  either. Any future feature, repair script, or SQL-capable session could rewrite history — the exact
  class of change an audit trail exists to make visible.
- **Evidence:** `UPDATE audit_logs SET …` and `DELETE FROM audit_logs` both succeeded on a fresh
  database before the fix.
- **Business impact:** a tampered audit line is indistinguishable from a legitimate one, so cash, price,
  void and permission history could be altered without trace.
- **Fix:** two `BEFORE UPDATE` / `BEFORE DELETE` triggers `RAISE(ABORT, 'audit_logs is append-only')`.
  They are created with `CREATE TRIGGER IF NOT EXISTS` in the schema, so they apply to existing shops on
  next start — no migration, no data change.
- **Regression test:** same file, `SEC-02` block (3 tests). Removing the triggers fails 2 of them.
- **Status:** **FIXED**, with a stated limit: an attacker with the database file and a SQLite shell can
  `DROP TRIGGER` first. That limit belongs to an unencrypted local file (SEC-04) and is written into
  the threat model rather than glossed over.

### SEC-03 — password hashing cost is below current guidance (S3, **OPEN — planned**)

- **Application:** Main App.
- **Module:** `packages/core/src/services/auth.ts` (`SCRYPT_OPTS = { N: 16384, r: 8, p: 1 }`).
- **Root cause / evidence:** each hash is scrypt with N=2^14. Current OWASP guidance for scrypt is
  N=2^17, r=8, p=1. The stored format is `salt` + `hash` with no cost/version marker, so raising N
  makes **every existing password unverifiable** — that is why this is not silently "fixed" here.
- **Business impact:** if a shop database file leaks, offline cracking is cheaper than modern guidance
  intends. It is not remotely exploitable.
- **Recommended fix:** add a hash-version marker (`scrypt$v1$…`), verify with the stored parameters,
  and transparently re-hash to N=2^17 on the next successful login. Ship it as its own reviewed change
  with a migration test over a copy of a real password row.
- **Status:** **OPEN** — remediation planned, deliberately not bundled into this audit's fixes.

### SEC-04 — the database and its backups are not encrypted at rest (S3, **ACCEPTED LIMITATION**)

Local SQLite plus `VACUUM INTO` backup files; both readable by anyone with file access to the machine
or the backup folder. Encryption would require key management a shop cannot operate (a forgotten
passphrase is a lost business). Mitigations: OS file permissions, backup folder choice, the release's
unsigned-installer/checksum guidance. Recorded in `V1.2.0_KNOWN_LIMITATIONS.md` when that file is
written in the documentation phase.

### SEC-05 — the in-memory replay guard remains as a fallback (S3, **ACCEPTED, documented**)

`ReplayGuard` (in-memory) forgets everything on restart. The LAN API uses `SqliteReplayGuard` (durable),
and the code says so; the in-memory class survives for lightweight callers and tests. No product path
uses it for the LAN API. Status: accepted with the caveat written down.

## 2. Areas examined and found sound (no defect)

| Check | Evidence |
| --- | --- |
| Password verification | scrypt + per-user 16-byte random salt + `crypto.timingSafeEqual` with length guard (`auth.ts:99-111`) |
| Login throttling | per-remote failure counter with a window, `RATE_LIMITED` before hashing (`rpc.ts`) |
| Session handling | 32-byte random session ids, sliding TTL (default 12 h), server-side map, 401 `AUTH_REQUIRED` on expiry |
| LAN authentication | Ed25519 signature over a canonical request (method, path, body hash, timestamp, nonce), device public key looked up per device, `timingSafeEqual` for the shop token |
| Replay protection | durable nonce table for the LAN API, 2× clock-skew window |
| TLS | `minVersion: 'TLSv1.2'` on both host and client; client pins SHA-256 of the server certificate DER in `checkServerIdentity`; `rejectUnauthorized: true` |
| IPC trust | `sauda:invoke` refuses any sender frame whose URL is not the app's own `file://` index, before route lookup |
| Renderer hardening | `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`, navigation blocked, external links allowlisted to `https:` + known hosts |
| Path handling | `app.openPath` root allowlist; image import sanitises to `imagesDir`; imports go through native dialogs; `backup.restore` gated by A-29 (`assertRestorablePath`) |
| SQL injection | every `\`…${…}\`` interpolation is a table name from `sqlite_master`, an allowlisted sort column from a literal map, or a `WHERE` clause assembled from fixed fragments; values are always bound |
| Input validation | adversarial probe (zero/negative quantity, negative payment, negative price, negative expense, negative gift card, over-100 % coupon) — all refused |
| Licence verification | Ed25519 `verify` with the embedded public key only; payload schema validated before use; expiry and device binding enforced |
| Key material | no private key in the repository, the Main App, the installers, CI or logs; `.gitignore` + secret scan + `verify-installer.mjs` |
| Dependency risk | `npm audit --omit=dev` → 0 vulnerabilities |
| Installer integrity | version metadata, x64 PE, native modules, key-material scan, SHA-256; published assets re-downloaded and re-verified by the release workflow |

## 3. Result

Two confirmed defects, both fixed in this phase with tests that fail on revert. One planned hardening
(SEC-03) and two accepted limitations (SEC-04, SEC-05), each with a written reason. Nothing in the
audit was fixed by weakening an existing control, and no production key material was read, moved or
copied.
