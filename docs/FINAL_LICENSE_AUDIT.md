# FINAL LICENSE AUDIT

Audited subsystem: `packages/core/src/licensing/*`, the IPC licence gate in
`packages/app/electron/ipc.ts`, the separate `packages/license-generator` tool,
the build-time public-key injection and the packaging guard.
Tests: `security-audit.test.ts` (licence negative paths, activation, clock
rollback) and `core.test.ts` (sign/verify, tamper, expiry, device binding).

## 1. Model as implemented

| Element | Implementation |
|---|---|
| Algorithm | Ed25519 (`crypto.sign(null, …)`) — signature cannot be forged without the private key, and verification needs only the public key |
| Wire format | `SAUDA1.<base64url(payload)>.<base64url(64-byte signature)>` |
| Payload determinism | `canonicalJson` (sorted keys, filtered `undefined`, deterministic numbers) so the signed bytes are byte-identical on both sides |
| Payload fields | `v`, `org`, `owner`, `phone`, `email`, `address`, `edition`, `features[]`, `expires_at`, `max_devices`, `license_id`, `issued_at`, `generator`, `fingerprint` |
| Editions | free/standard/pro/enterprise (`EDITIONS`), unknown edition rejected |
| Version gate | `SUPPORTED_LICENSE_VERSIONS = [1]` — a correctly signed licence with `v: 2` is still rejected |
| Key id | `LICENSE_KEY_ID` derived from the public key, so a key rotation mismatch is reported as such instead of "invalid signature" |
| Public key in the app | `LICENSE_PUBLIC_KEY_SPKI_B64` in `publicKey.ts`, overridable at build time by `SAUDA_LICENSE_PUBLIC_KEY` |
| Private key | **never** in the repository, the bundle or the installer; entered/loaded by the vendor in the License Generator only |

## 2. Device binding

Four components with weights: motherboard UUID **45**, primary disk serial
**30**, CPU id **15**, BIOS serial **10**. `MATCH_THRESHOLD = 0.6`.

| Scenario | Weight matched | Result | Test |
|---|---|---|---|
| Same machine | 100 | activated | "activates, persists and re-verifies from the database" |
| Disk replaced | 70 | accepted (convenience for the shopkeeper) | "tolerates a single replaced component" |
| Motherboard + disk replaced | 25 | rejected | "fails when the motherboard and disk are both replaced" |
| Different machine | 0 | rejected | "rejects the license on a different computer" |
| Fingerprint all zeros / empty | — | rejected | "refuses a licence that carries no device binding" |

The 45/30 weighting is the deliberate design decision: replacing a disk or a
motherboard alone must not force a re-issue, but moving the whole installation to
another PC must fail.

## 3. Runtime enforcement

`getActivationState(db)` re-verifies the stored licence **on every call** (signature
→ version → edition → expiry → device match) and updates
`meta.license.max_seen`. `requireActivation` throws when nothing valid is
installed.

**F5 (HIGH, fixed during this audit).** The dispatcher previously enforced
permissions but not activation: every business route (`sales.create`,
`reports.*`, `backup.*`, …) was reachable from the renderer without a licence —
the activation screen was only a UI gate. Now `invokeRoute` checks activation for
all routes except the exempt prefixes (`license.*`, `app.*`, `setup.*`,
`auth.*`), caches the result for 60 s in a `WeakMap` keyed by the connection
(so a restore/reopen invalidates it), and returns
`{ ok: false, code: 'LICENSE_REQUIRED' }` with a Bangla message. The renderer
shows the activation screen when it sees that code.

## 4. Clock manipulation

`meta.license.max_seen` stores the highest wall-clock time ever observed. If the
current clock is materially earlier than `max_seen`, expiry is evaluated against
`max_seen`. Test: "stores the activation and refuses a rolled-back clock after
expiry".

## 5. Separate generator EXE

- `packages/license-generator` is its own Electron app with its own
  `electron-builder` configuration and its own NSIS target; the release workflow
  produces `Sauda-License-Generator-*.exe` separately from
  `Sauda-Retail-Suite-Setup-*.exe` (release run 41787673767).
- The generator loads the private key from a file the operator selects; the path
  is remembered in a per-user config, never in the shared data folder.
- `npm run keys:generate` (`scripts/generate-signing-keys.mjs`) creates a fresh
  key pair for a new vendor; the public half goes into `publicKey.ts`, the private
  half must be stored offline.

## 6. Key-material containment (verified, not asserted)

Three independent checks run before an installer can be published:

1. `scripts/verify.mjs` — no tracked file name looks like a key
   (`private-key`, `.pem`, `.pfx`, `.p12`, `id_ed25519`, `secrets/`).
2. `scripts/verify-installer.mjs` — byte-scans **every `.exe`** and every file in
   `win-unpacked/resources` for `-----BEGIN`, `PRIVATE KEY-----`, the Ed25519
   PKCS#8 base64 prefix `MC4CAQAwBQYDK2Vw` and the generator's private marker;
   the release job fails on a hit.
3. The CI never receives the private key: the workflow only sets
   `SAUDA_LICENSE_PUBLIC_KEY` (optional) and `GITHUB_TOKEN`.

Result of the last release run: **no key material found in either installer**
(`Verify installers … ✔ packaged resources contain no private key material`).

## 7. What is NOT proven (honest gaps)

| Item | Status | Why |
|---|---|---|
| Issuing a licence with the production private key and activating on a real PC | `BLOCKED` | The private key is (correctly) not available in this environment |
| Reinstall/OS-reinstall behaviour with an existing licence | `BLOCKED` | Needs a Windows host; the activation row lives in `sauda.db`, which survives an app reinstall but not a fresh OS |
| Rebinding after a hardware failure | `PARTIAL` | Process documented in `docs/04-licensing.md`; the two-machine drill was not executed |
| Replay of a licence on a cloned disk image | `PARTIAL` | Fingerprint degrades gracefully (≥ 60 % match), so a byte-identical clone with the same board/disk ids *will* activate — accepted: an offline product cannot distinguish a clone from the original without a server |

## 8. Verdict

`PASS` for the licensing implementation and for key containment; `PARTIAL` only
for the field drills listed in §7. The subsystem is genuinely offline, genuinely
signed, and the business layer now actually stops when the licence does.
