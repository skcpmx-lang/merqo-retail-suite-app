import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Local issue ledger for the license generator. It records every licence that
 * left this machine so support can answer "who has which licence?" without a
 * server. The private key is never written here — only public identifiers.
 */
export interface LedgerEntry {
  id: string;
  license_id: string;
  org: string;
  owner: string | null;
  edition: string;
  expires_at: string | null;
  max_devices: number;
  device_hash: string | null;
  key_id: string;
  action: 'issued' | 'reissued' | 'revoked';
  replaces: string | null;
  reason: string | null;
  file: string | null;
  at: string;
}

function ledgerPath(): string {
  return path.join(app.getPath('userData'), 'issue-ledger.jsonl');
}

export function appendLedger(entry: Omit<LedgerEntry, 'id' | 'at'>): LedgerEntry {
  const full: LedgerEntry = { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString() };
  fs.appendFileSync(ledgerPath(), `${JSON.stringify(full)}\n`, 'utf8');
  return full;
}

export function listLedger(): LedgerEntry[] {
  const file = ledgerPath();
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as LedgerEntry;
      } catch {
        return null;
      }
    })
    .filter((x): x is LedgerEntry => Boolean(x))
    .reverse();
}

/** True when the licence id has a revocation entry (the newest action wins). */
export function isRevoked(licenseId: string): boolean {
  const latest = listLedger().find((e) => e.license_id === licenseId);
  return latest?.action === 'revoked';
}

/** Licence ids revoked in the ledger — used to warn before re-issuing. */
export function revokedIds(): string[] {
  const revocations = new Set<string>();
  for (const entry of listLedger()) {
    if (entry.action === 'revoked') revocations.add(entry.license_id);
    else if (entry.action === 'issued' || entry.action === 'reissued') revocations.delete(entry.license_id);
  }
  return [...revocations];
}

export function ledgerFile(): string {
  return ledgerPath();
}
