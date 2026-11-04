/**
 * Schema v6 — restart-safe security state (v1.1.4, Phase 3 Priority 1).
 *
 * STRICTLY ADDITIVE, like v5: two new tables, no ALTER, no UPDATE, no DELETE on any
 * existing row. A v1.1.3 or v1.1.4-v5 database keeps every product, sale, journal
 * line, user and device exactly as it was, and `migrate()` still writes a
 * pre-migration copy of the file first.
 */

export const SCHEMA_V6 = /* sql */ `
/* ---------- replay protection that survives a restart ----------------- */
/* A signed request is accepted at most once. The row is written inside the
   same SQLite transaction as the acceptance decision, so two concurrent copies
   of the same request can never both succeed, and a Main Server restart does
   not hand an attacker a fresh window. Rows expire after twice the accepted
   clock skew and are pruned opportunistically. */
CREATE TABLE IF NOT EXISTS device_nonces (
  device_id  TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  seen_at    TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (device_id, nonce)
);
CREATE INDEX IF NOT EXISTS idx_device_nonces_expiry ON device_nonces(expires_at);

/* ---------- administrator-approved certificate rotation --------------- */
/* Rotation is never implicit. An administrator authorises it, which writes the
   row below; the rotation then moves through prepared -> swapped -> completed.
   A server that finds an unfinished row on boot finishes or aborts it instead of
   silently presenting a different certificate. */
CREATE TABLE IF NOT EXISTS cert_rotations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  old_fingerprint TEXT NOT NULL,
  new_fingerprint TEXT,
  reason          TEXT NOT NULL,
  authorized_by   INTEGER REFERENCES users(id),
  state           TEXT NOT NULL CHECK (state IN ('pending','swapped','completed','aborted')),
  started_at      TEXT NOT NULL,
  completed_at    TEXT,
  note            TEXT
);
CREATE INDEX IF NOT EXISTS idx_cert_rotations_state ON cert_rotations(state, started_at);
`;
