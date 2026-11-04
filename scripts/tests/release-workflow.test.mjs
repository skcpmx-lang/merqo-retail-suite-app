/**
 * D-1 / D-3 — the release workflow cannot publish, cannot be triggered by a tag, and cannot
 * hand over an unverified artefact.
 *
 * These are source-level assertions on purpose: the workflow itself only runs on GitHub's
 * Windows runners, so the failure modes (an automatic tag build, an automatic release, a missing
 * signing gate) are exactly the ones that must be caught before anyone pushes a tag.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');

describe('release workflow is fail-closed', () => {
  it('runs only on manual dispatch — a tag can never mint an installer', () => {
    expect(workflow).toMatch(/^on:\s*\n\s*workflow_dispatch:/m);
    expect(workflow).not.toMatch(/^\s{2}push:/m);
    expect(workflow).not.toMatch(/^\s+tags:/m);
  });

  it('cannot publish a release: read-only token and no release action', () => {
    expect(workflow).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(workflow).not.toMatch(/softprops\/action-gh-release/);
    expect(workflow).not.toMatch(/gh release create/);
    expect(workflow).not.toMatch(/contents:\s*write/);
    expect(workflow).not.toMatch(/--draft=false/);
    expect(workflow).not.toMatch(/generate_release_notes/);
  });

  it('refuses to start without signing credentials', () => {
    const preflightAt = workflow.indexOf('scripts/check-signing-env.mjs');
    const installAt = workflow.indexOf('npm ci');
    expect(preflightAt).toBeGreaterThan(-1);
    expect(installAt).toBeGreaterThan(preflightAt);
    expect(workflow).toMatch(/CSC_LINK:\s*\$\{\{\s*secrets/);
    expect(workflow).toMatch(/WINDOWS_CODE_SIGNING_SUBJECT:\s*\$\{\{\s*secrets/);
  });

  it('passes the signing environment to both packaging steps', () => {
    const appAt = workflow.indexOf('node scripts/package-app.mjs');
    const generatorAt = workflow.indexOf('node scripts/package-license-generator.mjs');
    expect(appAt).toBeGreaterThan(-1);
    expect(generatorAt).toBeGreaterThan(-1);
    const before = (index) => workflow.slice(Math.max(0, index - 900), index);
    expect(before(appAt)).toMatch(/CSC_LINK:/);
    expect(before(generatorAt)).toMatch(/CSC_LINK:/);
  });

  it('verifies signatures, version and architecture before uploading anything', () => {
    const verifyAt = workflow.indexOf('scripts/verify-installer.mjs');
    const uploadAt = workflow.indexOf('actions/upload-artifact@v4', verifyAt);
    expect(verifyAt).toBeGreaterThan(-1);
    expect(uploadAt).toBeGreaterThan(verifyAt);
  });

  it('requires the reviewed, fully filled release notes', () => {
    const notesAt = workflow.indexOf('scripts/check-release-notes.mjs');
    expect(notesAt).toBeGreaterThan(-1);
    expect(workflow.slice(notesAt, notesAt + 200)).toMatch(/--require-filled/);
    expect(workflow).toMatch(/docs\/V1\.1\.4_RELEASE_NOTES\.md/);
    const uploadAt = workflow.indexOf('actions/upload-artifact@v4', notesAt);
    expect(uploadAt).toBeGreaterThan(notesAt);
  });

  it('uploads build artefacts only, and fails when they are missing', () => {
    expect(workflow).toMatch(/if-no-files-found:\s*error/);
    expect(workflow).toMatch(/name:\s*sauda-windows-signed-installers/);
    expect(workflow).not.toMatch(/release:\s*write/);
  });
});

describe('continuous integration is unchanged in scope', () => {
  it('CI still runs the full verify gate on every push and pull request', () => {
    const ci = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toMatch(/pull_request:/);
    expect(ci).toMatch(/npm run verify/);
    expect(ci).not.toMatch(/softprops\/action-gh-release/);
  });
});
