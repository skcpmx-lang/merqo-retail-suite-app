/**
 * D-3 — the published text is the reviewed notes file, complete and fully filled.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkReleaseNotes } from '../lib/release-notes.mjs';
import { artifactNames, releaseNotesPath, releaseVersion } from '../lib/release-version.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Derived, not hard-coded: the gate must always read the current version's notes (R-01).
const notesPath = path.join(repoRoot, releaseNotesPath());
const currentNotes = fs.readFileSync(notesPath, 'utf8');

/** The pre-build shape of the same document: the two measured values are still placeholders. */
const templateNotes = currentNotes
  .replace(/— \d{4,} B — SHA-256 `[0-9a-f]{64}`/g, '— <bytes> B — SHA-256 `<sha256>`');

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

  // The committed notes are either finalised with the measured build output, or waiting on exactly
  // the two values only the build can produce. Anything else — a leftover <hash>, <subject>, or a
  // line that was never rewritten — fails here, so the drafting state can never hide a placeholder
  // that the strict release gate would refuse.
  it('is either finalised, or waiting on exactly the two build-measured values', () => {
    const names = Object.values(artifactNames());
    const measured = /— \d{4,} B — SHA-256 `[0-9a-f]{64}`/;
    const lines = names.map((name) => {
      const line = currentNotes
        .split('\n')
        .find((text) => text.includes(name) && text.includes('SHA-256'));
      expect(line, `missing measured line for ${name}`).toBeTruthy();
      return line;
    });
    const finalised = lines.every((line) => measured.test(line));

    const { placeholders, issues } = checkReleaseNotes(currentNotes, { requireFilled: true });
    // The only tolerated issue while drafting is the unfilled build values themselves.
    expect(issues.filter((issue) => !/unfilled placeholders/.test(issue))).toEqual([]);
    if (finalised) {
      expect(placeholders).toEqual([]);
    } else {
      expect([...placeholders].sort()).toEqual(['<bytes>', '<sha256>']);
      expect(issues.join(' ')).toMatch(/unfilled placeholders/);
    }
  });

  it('names the version it documents', () => {
    expect(currentNotes).toContain(`# Sauda Retail Suite v${releaseVersion()}`);
    for (const name of Object.values(artifactNames())) expect(currentNotes).toContain(name);
  });

  it('still fails closed on a template that was never filled in', () => {
    const { placeholders, issues } = checkReleaseNotes(templateNotes, { requireFilled: true });
    expect(placeholders.length).toBeGreaterThan(0);
    expect(placeholders).toContain('<sha256>');
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
