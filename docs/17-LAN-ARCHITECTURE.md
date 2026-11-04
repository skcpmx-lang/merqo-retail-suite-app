# 17 — LAN Architecture (host + terminals)

A shop rarely has one computer. Sauda Retail Suite v1.1 lets one PC own the
database (**host**) and any number of other PCs on the same network act as
**terminals** — same products, same stock, same invoices, same permissions.

## 1. Principles

1. **One writer.** Only the host opens the SQLite file for writing. Terminals
   never mount, copy or lock the database.
2. **No new business logic.** A terminal request lands on exactly the same IPC
   dispatcher as a local click, so validation, permissions, audit logging and
   accounting are identical by construction.
3. **Permissions are resolved on the host** from the real `users` row. A terminal
   cannot claim a role.
4. **LAN only.** Peers outside private address ranges are refused.
5. **Nothing opens an inbound port unless the owner turns the host on.**

## 2. Components

| Layer | File | Notes |
| --- | --- | --- |
| Transport (core) | `packages/core/src/net/rpc.ts` | HTTP/JSON RPC, token auth, session tokens, private-peer guard, body cap, timeouts |
| Host glue (app) | `packages/app/electron/lan.ts` | starts/stops the host, exposes status, connection test |
| Dispatcher mux | `packages/app/electron/main.ts` | `ctx.fetch` routes remote calls into the same dispatcher |
| Client | `packages/core/src/net/rpc.ts#createRpcClient` | terminal-side fetch wrapper with the shop token + session |

## 3. Request flow

```
terminal UI
  → preload bridge → ipc.invoke('sales.create', …)
  → main.ts: transport.mode === 'terminal' && route not local
  → POST http://host:8787/rpc  { method, args, session }
  → host rpc.ts: verify shop token → verify session → dispatcher(user)
  → service → SQLite (host disk) → result
  → back to the terminal → UI update
```

Routes that **stay local** on a terminal (`LOCAL_PREFIXES`): `print.*`, `app.*`,
`lan.*`, `display.*`, `meta.*`, `license.fingerprint`. Everything else forwards.
This is deliberate: a terminal prints on its own printer and shows its own
customer display, while all data comes from the host.

## 4. Security

| Control | Detail |
| --- | --- |
| Shared secret | 256-bit token generated with `crypto.randomBytes(32)`, stored in settings, regenerable from Settings → Network |
| Session | Opaque random token issued on `auth.login`, sliding TTL (default 12 h), server-side map |
| Peer filter | RFC1918 + loopback only (`isPrivateAddress`) |
| Body limit | 1 MB per request; JSON only |
| Method allow-list | Only registered IPC routes; unknown methods fail before touching a service |
| Transport encryption (v1.1.3) | Every `/rpc` body is sealed with **AES-256-GCM**. Key = `scrypt(shopToken, 'sauda-lan-transport-v2', 32)`; fresh 12-byte nonce per message; AAD `sauda-lan-transport-v2`. Wire form: `{"v":2,"enc":"base64(nonce‖tag‖ciphertext)"}` |
| Downgrade refusal (v1.1.3) | A plaintext (v1) request gets **426 TRANSPORT_OUTDATED** and never reaches a route; the client maps it to `TRANSPORT_OUTDATED` so the terminal shows “update this terminal”. A tampered body fails the GCM tag → **400 TRANSPORT_CORRUPT**, no route runs |
| Rate limit | Failed logins are counted per username (`login_attempts`) **and** per source address: 10 failures in 15 minutes → **429 RATE_LIMITED** (v1.1.3) |
| Health probe | `/health` answers without a token but reveals only that a host exists; the business name is returned only to a token holder (v1.1.3) |
| No filesystem exposure | At no point is a file path, backup file or private key sent over the wire |
| No internet | The host never performs DNS or outbound calls; it binds to the LAN interface only |

The licence check runs on the **host**; terminals inherit the host's activated
state and never see the licence key material.

## 5. Operating it

1. On the host PC: Settings → **নেটওয়ার্ক ও ডিসপ্লে** → mode **HOST**, port 8787,
   save, then *হোস্ট চালু*.
2. Note the shown address, e.g. `http://192.168.0.10:8787`.
3. On a terminal PC: mode **TERMINAL**, paste that address, save, restart.
4. Enter the same shop token (Settings → Network → *টোকেন নবায়ন* on the host
   invalidates every terminal, by design).
5. Verify with `lan.test` before the shop opens.
6. **Upgrading to v1.1.3:** the host *and* every terminal must be on 1.1.3. An older
   terminal speaks the plaintext protocol and is refused with 426 — intentional,
   because the old protocol exposed every sale and the shop token to the LAN.

### Firewall

Windows will ask once. Allow **Private networks** only. Never create an inbound
rule for Public networks, and never port-forward 8787 on the router.

## 6. Failure behaviour

| Situation | What happens |
| --- | --- |
| Host off / cable unplugged | Terminal shows a clear "host unreachable" error; **no** local sale is created, so invoices cannot diverge |
| Token changed | All terminals are rejected until they are re-linked |
| Session expired | Terminal returns to the login screen |
| Two terminals sell the last unit | Stock and invoice numbers are serialised inside the host's SQLite transaction; one sale wins, the other sees the real remaining stock |

## 7. Verification status

| Check | Status |
| --- | --- |
| Token/session/peer-guard/body-cap logic | PASS — `packages/core/test/lan.test.ts` (15 tests) |
| Sealed v2 request/response, 426 downgrade block, tamper rejection, login throttle, anonymous health | PASS — same file, 4 of the 15 |
| Envelope uses a symmetric pre-shared key (not TLS) | By design — recorded in `docs/FINAL_SECURITY_AUDIT_V113.md` §5 |
| Two-process multi-terminal run | PASS at the transport level (host launched inside the test) |
| Real two-PC shop rehearsal on Windows | **BLOCKED** — single sandbox machine |
| Windows Firewall prompts and installer rules | **BLOCKED** — needs a Windows host |

Deliberately out of scope: offline queues, WAN replication, cloud sync. A shop
that loses its network stops selling rather than creating invoices that later
conflict.
