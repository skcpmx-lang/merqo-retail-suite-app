# v1.2.0 — architecture assessment

*Phase 0 deliverable plus the conclusions of the structural reading done for v1.1.5 (A-21…A-29).
It states what the architecture is good at, where it is fragile, and which changes are safe to make
in a minor release.*

## 1. The shape as built

```
┌─────────────────────────── Main PC ───────────────────────────┐
│ Electron main (privileged)                                    │
│   ├─ ipc.ts: one channel `sauda:invoke` → permission-checked   │
│   ├─ main.ts: window, tray, server runtime, auto-backup        │
│   └─ server runtime: TLS + Ed25519 device signatures           │
│                         │                                     │
│  services/* (packages/core)  ── SQLite (WAL, FK on)           │
│   ├─ sales/purchases/returns: one transaction each            │
│   ├─ accounting: header + lines in one transaction            │
│   └─ audit(): every change writes a line in the same tx       │
└───────────────────────────────────────────────────────────────┘
        ▲  TLS, pinned, device-signed, replay-protected
        │
┌───────┴──────── Client PC ────────┐        ┌── License Generator ──┐
│ same Electron shell, no database  │        │ separate internal app │
│ every call forwarded over the API │        │ store + ledger + key  │
└───────────────────────────────────┘        └───────────────────────┘
```

## 2. What is genuinely good

1. **One writer.** Only the Main PC owns the database. There is no shared-file design to corrupt, and
   the "client cannot trade offline" limitation is the price of that guarantee — a deliberate trade.
2. **Permissions are enforced below the UI.** Every IPC route declares a permission and the dispatcher
   enforces it; the LAN RPC table uses the same strings, so desktop and network cannot disagree.
3. **Money is integer everywhere.** Paisa and milli-units; no floating point on a financial path.
4. **Transactions follow the data.** Since v1.1.5 the rule "a change and its audit line share a
   transaction" is mechanically enforced (`scripts/audit-transactions.mjs`, 82 functions checked).
5. **The two applications are separable at the artefact level.** The Generator signs; the Main App
   only verifies. A stolen Main App installer yields no signing capability.

## 3. Where it is fragile

| # | Weakness | Consequence | v1.2.0 action |
| --- | --- | --- | --- |
| W-1 | `ipc.ts` is a single ~1,400-line module with every route inline | hard to review, easy to add a route that forgets a permission | split into per-domain route files; keep one dispatcher; add a guard that every route declares a permission explicitly |
| W-2 | Renderer screens are large single files (POS, Products, Reports) | behaviour changes are risky, no component tests exist | extract hooks/components incrementally, add component tests before refactoring |
| W-3 | No end-to-end test across the two applications | a licensing-flow regression would be caught only by hand | add a scripted `.sauda-device` → sign → `.sauda` → verify round-trip test in CI (no Windows needed) |
| W-4 | Reports are computed in SQL per screen | each new report risks a different date boundary | one shared date-range/sargable helper plus a property test over boundaries |
| W-5 | Backup is file + row + reconcile (A-28) | acceptable now, but the window is documented rather than eliminated | keep reconciliation; add a startup integrity summary to the Backup screen |
| W-6 | No observability beyond a log file | a shop-side failure needs remote questions | add a "diagnostics bundle" export (logs + schema version + counts, no customer data) |
| W-7 | `main` was not the source of the v1.1.5 release | the repository's front door does not match the release | fix by fast-forward + a pre-publication gate (§4) |

## 4. Release-process architecture fix (requirement #20)

The v1.1.5 release proved that "tag from a branch" is possible. v1.2.0 must make it impossible:

1. `main` fast-forwards to the verified tip (no rewrite — it is a pure fast-forward today).
2. A new gate (`scripts/audit-release-branch.mjs`) runs before publication and refuses a tag whose
   commit is not an ancestor of `main`.
3. The final v1.2.0 tag is created **on the merged `main` commit**, and the installers are built from
   that same commit by `release.yml`.

## 5. Changes deliberately *not* proposed

- No rewrite of the service layer around an ORM: the SQL is explicit, tested and fast.
- No move to a client-side database or offline-first sync in v1.2.0: it changes the product's data
  model and its support burden, and it is not needed to meet the owner's requirements.
- No cloud services, telemetry or accounts: the owner's constraints forbid them and the product's
  selling point is that a shop's data stays in the shop.
