# v1.2.0 — threat model

*Scope: both applications, the Windows host they run on, the shop LAN between a Main PC and its
clients, and the licence files that travel by hand. Written after the Phase 4 source audit; every
mitigation named here points at code that exists in this tree.*

## 1. What is worth protecting

| Asset | Why it matters | Where it lives |
| --- | --- | --- |
| Sales, purchases, payments, journals | the shop's money and its tax position | Main PC SQLite |
| Stock and serial/IMEI records | what the shop owns and what it has promised | Main PC SQLite |
| Customer balances and dues | real receivables | Main PC SQLite |
| Staff credentials and permissions | who may move money | Main PC SQLite (scrypt hashes) |
| Audit trail | the only answer to "who changed this?" | Main PC SQLite (append-only, SEC-02) |
| Shop data backups | recovery from hardware failure | files on disk, chosen by the owner |
| Licence private key | issuing capability for every customer | **License Generator only**, never in this repo |
| Device identities and approvals | who may join a shop's network | Main PC SQLite + device signatures |
| Shop token / TLS identity | LAN channel authentication | Main PC settings + certificate material |

## 2. Who might attack, and how

| Actor | Capability assumed | Motivated by |
| --- | --- | --- |
| A cashier with a valid login | can use the UI, cannot read the database directly | hiding a void, a discount, or a stock adjustment |
| A technician with file access | can copy the machine's files, run a SQLite shell | curiosity, resale of data, "fixing" history |
| Someone on the shop LAN | can sniff, replay, spoof ARP, run their own server | credentials, prices, customer data |
| A dishonest customer | can present a forged or copied licence file | free software |
| A supply-chain attacker | can publish a malicious dependency or binary | wide, quiet compromise |
| A thief with the machine | has the disk and the OS account | the data and the licence |

Out of scope, stated plainly: a fully compromised Windows account with administrator rights is treated
as game over for confidentiality on that machine (the database is unencrypted — SEC-04). The model still
claims *integrity evidence*: even then, deleting audit rows means dropping a trigger, and doing it
leaves a schema difference that `PRAGMA integrity_check` and the app's own diagnostics can surface.

## 3. Trust boundaries

```
[ renderer (untrusted-ish) ] --IPC--> [ Electron main (trusted) ] --SQL--> [ SQLite ]
                                            |  ^
                                            |  | TLS + Ed25519 device signature + nonce
                                            v  |
                                   [ shop LAN / Client PCs ]
[ License Generator (separate app, own machine) ] --file--> [ .sauda licence ] --file--> [ Main App ]
```

1. **Renderer → main.** The renderer is treated as hostile: it may be script-injected by a malicious
   import, and it can be opened by DevTools. Every call arrives on one channel, is refused unless the
   sender frame is the app's own `file://` index, carries a permission, and is validated in the service
   layer. The renderer never touches the filesystem or the database.
2. **Client PC → Main PC.** Every request carries an Ed25519 signature over a canonical string that
   binds method, path, body hash, timestamp and a durable nonce; the transport is TLS 1.2+ with a pinned
   certificate; the shop token is compared in constant time. A replayed request fails either the nonce or
   the timestamp window.
3. **Generator → Main App.** A file crossing by USB stick or email. The Main App trusts the file only
   as far as the Ed25519 signature and the payload schema allow: signature first, then schema, then
   expiry, then device binding.
4. **Operator → Generator.** The private key is the crown jewel: it lives in the operator's own store,
   is never exported by the app, and the app refuses to run a release build without a key it can load.

## 4. Threats and mitigations

| # | Threat | Mitigation in this tree | Residual |
| --- | --- | --- | --- |
| T-1 | Forged licence | Ed25519 verify with the embedded public key; schema validation | a stolen *real* licence works until expiry (policy: revoke/expiry) |
| T-2 | Licence copy onto a second PC | device binding scored against hardware; capacity enforced per licence | a determined user can spoof hardware identifiers — accepted, offline licensing |
| T-3 | Tampered database to raise licence capacity | capacity derived from the signed licence file, not from a database row; device approvals require admin | a DB edit can add *approved* device rows but not a licence seat |
| T-4 | Stolen Client PC joins a shop | pairing code + admin approval on the Main PC; revocation clears sessions | while the Main PC is off, nothing is enforced — by design |
| T-5 | LAN eavesdropping | TLS 1.2+ with pinned certificate; AES-GCM envelope on top; plaintext LAN bind now refused (SEC-01) | a wrong-but-valid pin means the client refuses to connect (fail closed) |
| T-6 | Replay of a LAN request | durable nonce, timestamp window, body hash | within the window a *unique* request can be re-sent if the attacker can suppress the original response — inherent to request signing |
| T-7 | Replay of a licence file | licence id + issuance ledger in the Generator; the Main App has no state to replay against | accepted (offline) |
| T-8 | Privilege escalation through IPC | permission checked in the dispatcher, not the UI; admin-only actions re-check the role (`backup.restore`); `audit-ui.mjs` fails the build if a route forgets its permission | a bug in a service that forgets its own guard — covered by tests, not provable |
| T-9 | Path traversal | root allowlists, dialog-only imports, `assertRestorablePath` (A-29), image basename sanitising | — |
| T-10 | SQL injection | values always bound; identifiers come from literal allowlists | — |
| T-11 | Credential theft from the database | scrypt + per-user salt, timing-safe compare | cost below current guidance (SEC-03, planned) |
| T-12 | Audit-trail rewriting | DB triggers refuse UPDATE/DELETE (SEC-02); no code path mutates rows | someone with a SQLite shell can drop the trigger — detectable, not preventable locally |
| T-13 | Malicious dependency / binary | `npm audit --omit=dev`, lockfile + SRI, native-artifact provenance audit, installer verification | no reproducible-build claim is made |
| T-14 | Key material leaking into the app or an installer | key never referenced by the Main App; secret scan; installer key-material scan | the operator's own machine is trusted for the key |
| T-15 | Backup stolen | same data as the database (SEC-04) | accepted; the owner is told to keep backups private |
| T-16 | Log-based data leak | logs carry ids, counts and messages, not passwords, tokens or full customer rows | a stack trace could contain a path or a query — reviewed, not exhaustive |

## 5. Assumptions this model depends on

1. The Main PC's Windows account is the shop's own and its disk is not shared.
2. The operator keeps the Generator's private key on a machine they control and never commits it.
3. Backups are stored on media the owner controls (the release notes say so).
4. The LAN is a shop network, not a public hotspot; TLS pinning makes an impostor fail closed.

If any assumption fails, the corresponding residual risk above becomes the live one — that is what the
table in §4 is for, and why it is written in plain language rather than as a score.

## 6. What this model does not claim

No claim of "secure", "unhackable" or "zero risk". No penetration test was executed. No antivirus or
EDR product was active during testing. Windows runtime behaviour and physical hardware remain
**NOT TESTED — OWNER TESTING DEFERRED**.
