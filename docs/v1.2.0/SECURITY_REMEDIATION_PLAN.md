# v1.2.0 — security remediation plan

Every finding from `SECURITY_AUDIT.md`, with what was done, what is planned, and what is accepted. The
rule applied here: a fix ships with a test that fails when it is reverted; a fix that cannot ship safely
ships as a plan, not as a silent change.

## 1. Remediation status

| ID | Sev | Application | Finding | Fix | Regression test | Status |
| --- | --- | --- | --- | --- | --- | --- |
| SEC-01 | S2 | Main App (`net/rpc.ts`) | Plaintext listener bound `0.0.0.0` when TLS was absent and no host was given (fail-open) | Refuse `no TLS + non-loopback` unless `allowPlaintextLan: true`; exports `isLoopbackHost()`; the deprecated LAN mode opts in explicitly | `security-hardening-v120.test.ts` — 5 tests; 2 fail on revert | **FIXED** |
| SEC-02 | S2 | Both (`db/schema.ts`) | `audit_logs` accepted UPDATE and DELETE | `BEFORE UPDATE`/`BEFORE DELETE` triggers that `RAISE(ABORT)`; created `IF NOT EXISTS` so existing shops get them on next start | same file — 3 tests; 2 fail on revert | **FIXED** |
| SEC-03 | S3 | Main App (`auth.ts`) | scrypt N=2^14 below OWASP guidance for 2026 | Needs a hash-version marker before the cost can rise; see §2 | planned with the fix | **OPEN — plan below** |
| SEC-04 | S3 | Both | Database and backups unencrypted at rest | none (deliberate) | — | **ACCEPTED LIMITATION** — key management a shop cannot operate |
| SEC-05 | S3 | Main App (`net/device-auth.ts`) | In-memory replay guard forgets on restart | LAN API already uses the durable `SqliteReplayGuard`; the class stays for lightweight callers | existing LAN tests | **ACCEPTED, documented** |

## 2. SEC-03 — the one planned change, with its risk stated

Password hashes are stored as `salt` + `hash` with no marker of the parameters used. Raising scrypt's
cost changes every hash, so a naive change would lock every user out of every shop. The plan:

1. Introduce a versioned string format `scrypt$1$N=16384,r=8,p=1$<salt>$<hash>` written alongside the
   existing columns (new column `password_algo`, nullable; existing rows read as version 1).
2. Verify using the parameters *in the row*, not from a constant.
3. On the next successful login, re-hash with N=2^17 and write version 2 in the same transaction that
   records the login.
4. Migration test over a database seeded with v1 hashes: correct password still works, wrong password
   still fails, and the row is upgraded exactly once.
5. Only after that: raise the default for new passwords.

Why it is not in this commit: it touches the authentication path of every shop, needs a schema column
(and therefore a migration with a pre-migration backup), and deserves its own review rather than riding
along with an audit. Doing it in the same change as SEC-01/SEC-02 would make a bad login bug
indistinguishable from a network fix in the same diff.

## 3. Verification executed for this phase

| Check | Command | Result |
| --- | --- | --- |
| Type check (3 projects) | `node scripts/typecheck.mjs` | pass |
| New security tests | `vitest run packages/core/test/security-hardening-v120.test.ts` | 8 passed |
| Fail-on-revert | guards and triggers removed, same file re-run | **4 failed / 4 passed** (2 network refusals, 2 audit-trail refusals) |
| Affected suites | `lan.test.ts`, `lan-bind-v114.test.ts`, `tls-v114.test.ts` | 22 passed, 14 skipped (skips are pre-existing, TLS-material dependent) |
| Full gate | `npm run verify` | see the test report for the recorded totals |
| CI | Linux + Windows gates | see `V1.2.0` Phase 4 evidence in the final report |

## 4. Standing rules for the rest of v1.2.0

- No security control is weakened to make a feature easier, and no warning is suppressed to make a gate
  green.
- A finding is closed only when its test executes and passes; a plan is never reported as a fix.
- No production private key is read, copied, moved or logged by any step of this work.
- Anything that changes licensing or commercial policy is escalated to the owner rather than decided
  here.
