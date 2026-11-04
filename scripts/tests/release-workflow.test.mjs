/**
 * Release workflow: builds verified installers, never publishes, never depends on Authenticode.
 *
 * Source-level assertions on purpose: the workflow only runs on GitHub's Windows runners, so the
 * failure modes (automatic publication, an unsafe publish, a hidden signing requirement, a missing
 * verification step) must be caught before a tag is pushed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');

describe('release workflow builds but never publishes', () => {
  it('can be dispatched manually and by a version tag, and that is all', () => {
    expect(workflow).toMatch(/^on:\s*\n\s*workflow_dispatch:/m);
    expect(workflow).toMatch(/^\s{2}push:\s*\n\s{4}tags:/m);
    expect(workflow).not.toMatch(/pull_request:/);
  });

  it('cannot publish a release: read-only token and no release action', () => {
    expect(workflow).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(workflow).not.toMatch(/softprops\/action-gh-release/);
    expect(workflow).not.toMatch(/gh release create/);
    expect(workflow).not.toMatch(/contents:\s*write/);
    expect(workflow).not.toMatch(/--draft=false/);
    expect(workflow).not.toMatch(/generate_release_notes/);
  });

  it('has no Authenticode dependency and no certificate secret', () => {
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow).not.toMatch(/CSC_LINK/);
    expect(workflow).not.toMatch(/csc_key_password/i);
    const reportAt = workflow.indexOf('scripts/check-signing-env.mjs');
    expect(reportAt).toBeGreaterThan(-1);
    // The status report must never be able to fail the run.
    expect(workflow.slice(Math.max(0, reportAt - 400), reportAt)).toMatch(/continue-on-error:\s*true/);
  });

  it('packages both applications without requiring a certificate', () => {
    expect(workflow).toMatch(/node scripts\/package-app\.mjs/);
    expect(workflow).toMatch(/node scripts\/package-license-generator\.mjs/);
    const appAt = workflow.indexOf('node scripts/package-app.mjs');
    const before = workflow.slice(Math.max(0, appAt - 600), appAt);
    expect(before).not.toMatch(/CSC_LINK|WINDOWS_CODE_SIGNING_SUBJECT/);
  });

  it('verifies version, architecture and integrity before uploading anything', () => {
    const verifyAt = workflow.indexOf('scripts/verify-installer.mjs');
    const uploadAt = workflow.indexOf('actions/upload-artifact@v4', verifyAt);
    expect(verifyAt).toBeGreaterThan(-1);
    expect(uploadAt).toBeGreaterThan(verifyAt);
  });

  it('requires the reviewed release notes', () => {
    const notesAt = workflow.indexOf('scripts/check-release-notes.mjs');
    expect(notesAt).toBeGreaterThan(-1);
    expect(workflow.slice(notesAt, notesAt + 400)).toMatch(/docs\/V1\.1\.4_RELEASE_NOTES\.md/);
    expect(workflow).toMatch(/docs\/V1\.1\.4_RELEASE_NOTES\.md/);
    const uploadAt = workflow.indexOf('actions/upload-artifact@v4', notesAt);
    expect(uploadAt).toBeGreaterThan(notesAt);
  });

  it('uploads build artefacts only, and fails when they are missing', () => {
    expect(workflow).toMatch(/if-no-files-found:\s*error/);
    expect(workflow).toMatch(/name:\s*sauda-windows-installers/);
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
