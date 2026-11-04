/**
 * D-3 — the published text is the reviewed notes file, complete and fully filled.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkReleaseNotes } from '../lib/release-notes.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const notesPath = path.join(repoRoot, 'docs', 'V1.1.4_RELEASE_NOTES.md');
const currentNotes = fs.readFileSync(notesPath, 'utf8');

const filledNotes = `# Sauda Retail Suite v1.1.4

## What’s new
Server / Client model.

## Installation
Run the installer.

## Upgrading from v1.1.3
Back up, install, re-pair.

## Backup
Shop → Backup.

## Rollback
Restore the pre-upgrade backup.

## Verification status
Automated tests completed. Two-PC testing still pending, hardware pending.
Windows build and signature verified. SmartScreen reputation is not claimed.

## Known limitations
No offline trading on clients.

## Verify your download
Compare with SHA256SUMS.txt.
`;

describe('reviewed release notes', () => {
  it('the committed file contains every mandatory section and disclosure', () => {
    const { issues } = checkReleaseNotes(currentNotes);
    expect(issues).toEqual([]);
  });

  it('still has placeholders, so it is not yet publishable (fail closed)', () => {
    const { placeholders, issues } = checkReleaseNotes(currentNotes, { requireFilled: true });
    expect(placeholders.length).toBeGreaterThan(0);
    expect(placeholders).toContain('<hash>');
    expect(issues.join(' ')).toMatch(/unfilled placeholders/);
  });

  it('a fully filled version of the same structure passes the strict gate', () => {
    const { issues, placeholders } = checkReleaseNotes(filledNotes, { requireFilled: true });
    expect(placeholders).toEqual([]);
    expect(issues).toEqual([]);
  });

  it('an empty or missing body is refused', () => {
    expect(checkReleaseNotes('').issues.join(' ')).toMatch(/empty/);
    expect(checkReleaseNotes(undefined).issues.join(' ')).toMatch(/empty/);
  });

  it('a note without the verification disclosure is refused', () => {
    const stripped = filledNotes.replace(/## Verification status[\s\S]*?## Known limitations/, '## Known limitations');
    expect(checkReleaseNotes(stripped).issues.join(' ')).toMatch(/verification status/);
  });

  it('a note without rollback instructions is refused', () => {
    const stripped = filledNotes.replace(/## Rollback[\s\S]*?## Verification status/, '## Verification status');
    expect(checkReleaseNotes(stripped).issues.join(' ')).toMatch(/rollback/);
  });

  it('a note that drops the SmartScreen caveat or the checksum instructions is refused', () => {
    const noSmartScreen = filledNotes.replace(/Smartscreen/gi, 'trust');
    expect(checkReleaseNotes(noSmartScreen).issues.join(' ')).toMatch(/SmartScreen/);
    const noSums = filledNotes.replace(/SHA256SUMS\.txt/g, 'the hashes');
    expect(checkReleaseNotes(noSums).issues.join(' ')).toMatch(/checksum/);
  });

  it('a note claiming everything is verified but leaving <hash> in place is refused', () => {
    const withPlaceholder = filledNotes.replace(
      'Windows build and signature verified.',
      'Windows build and signature verified. SHA-256: <hash>',
    );
    expect(checkReleaseNotes(withPlaceholder, { requireFilled: true }).issues.join(' ')).toMatch(
      /unfilled placeholders/,
    );
  });
});
