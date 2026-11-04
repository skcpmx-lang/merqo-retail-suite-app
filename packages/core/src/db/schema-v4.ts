/**
 * Schema version 4 — v1.1 hardening.
 *
 * `login_attempts` keeps a persistent, per-username failure counter so the
 * optional software lock cannot be brute-forced. Only the username, a counter
 * and timestamps are stored — never the attempted password.
 */
export const SCHEMA_V4 = /* sql */ `
CREATE TABLE IF NOT EXISTS login_attempts (
  username         TEXT PRIMARY KEY,
  failures         INTEGER NOT NULL DEFAULT 0,
  first_failure_at TEXT NOT NULL,
  locked_until     TEXT,
  updated_at       TEXT NOT NULL
);
`;
