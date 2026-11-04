/**
 * Release workflow contract (v1.1.4).
 *
 * Source-level assertions on purpose: the workflow only runs on GitHub's Windows runners, so the
 * safety properties — no hidden signing requirement, nothing published from a failed or partial
 * build, a draft that is re-downloaded and re-hashed before it is promoted, exactly two installers
 * plus a checksum file — must be provable before a tag is pushed.
 *
 * These are *contract* tests, not implementation snapshots: they assert ordering and guards that
 * make an unsafe release impossible, so they keep their value as the file evolves.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');

const at = (needle) => workflow.indexOf(needle);
const before = (a, b) => {
  expect(at(a)).toBeGreaterThan(-1);
  expect(at(b)).toBeGreaterThan(-1);
  expect(at(a)).toBeLessThan(at(b));
};

describe('release workflow: triggers', () => {
  it('runs on a manual dispatch and on a version tag, and nothing else', () => {
    expect(workflow).toMatch(/^on:\s*\n\s*workflow_dispatch:/m);
    expect(workflow).toMatch(/^\s{2}push:\s*\n\s{4}tags:/m);
    expect(workflow).not.toMatch(/pull_request:/);
    expect(workflow).toMatch(/runs-on:\s*windows-latest/);
  });

  it('never cancels a release in flight', () => {
    expect(workflow).toMatch(/cancel-in-progress:\s*false/);
  });
});

describe('release workflow: unsigned is accepted, no certificate is required', () => {
  it('uses no repository secrets at all', () => {
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow).not.toMatch(/CSC_LINK/);
    expect(workflow).not.toMatch(/csc_key_password/i);
    expect(workflow).not.toMatch(/WINDOWS_CODE_SIGNING_SUBJECT/);
  });

  it('only reports the signing status, and cannot fail on it', () => {
    const reportAt = at('scripts/check-signing-env.mjs');
    expect(reportAt).toBeGreaterThan(-1);
    expect(workflow.slice(Math.max(0, reportAt - 400), reportAt)).toMatch(/continue-on-error:\s*true/);
    // Unsigned must never be turned back into a hard gate anywhere in the pipeline.
    expect(workflow).not.toMatch(/--require-signature/);
  });

  it('the only tolerated failure is the informational signing report', () => {
    const tolerated = workflow.match(/continue-on-error:\s*true/g) ?? [];
    expect(tolerated).toHaveLength(1);
    // `if: failure()` may only be used by the diagnostics step that runs after a failure.
    const failureGuards = workflow.match(/if:\s*failure\(\)/g) ?? [];
    expect(failureGuards).toHaveLength(1);
  });
});

describe('release workflow: build and verification order', () => {
  it('runs the full gate before anything is built or packaged', () => {
    before('npm run verify', 'node scripts/package-app.mjs');
    before('npm run verify', 'node scripts/package-license-generator.mjs');
  });

  it('packages both applications, without a certificate in the way', () => {
    expect(workflow).toMatch(/node scripts\/package-app\.mjs/);
    expect(workflow).toMatch(/node scripts\/package-license-generator\.mjs/);
    const appAt = at('node scripts/package-app.mjs');
    const context = workflow.slice(Math.max(0, appAt - 600), appAt);
    expect(context).not.toMatch(/CSC_LINK|WINDOWS_CODE_SIGNING_SUBJECT/);
  });

  it('copies both installers into the artifacts directory before verifying them', () => {
    before('cp packages/app/release/*.exe artifacts/', 'scripts/verify-installer.mjs');
    before('cp packages/license-generator/release/*.exe artifacts/', 'scripts/verify-installer.mjs');
  });

  it('verifies the installers before the notes are rendered or anything is uploaded', () => {
    before('node scripts/verify-installer.mjs --dir artifacts', 'scripts/render-release-notes.mjs');
    before('node scripts/verify-installer.mjs --dir artifacts', 'name: sauda-windows-installers');
  });

  it('renders measured notes and refuses any leftover placeholder', () => {
    before('scripts/check-release-notes.mjs --file docs/V1.1.4_RELEASE_NOTES.md', 'scripts/render-release-notes.mjs');
    before('scripts/render-release-notes.mjs', 'scripts/check-release-notes.mjs --file release-notes.md --require-filled');
    expect(workflow).toMatch(/--require-filled/);
    // The publishable text is the rendered file, never the template.
    expect(workflow).toMatch(/--notes-file release-notes\.md/);
  });

  it('uploads exactly the two installers, the checksum file and the notes', () => {
    expect(workflow).toMatch(/name:\s*sauda-windows-installers/);
    expect(workflow).toMatch(/if-no-files-found:\s*error/);
    expect(workflow).toMatch(/artifacts\/Sauda-Retail-Suite-Setup-1\.1\.4\.exe/);
    expect(workflow).toMatch(/artifacts\/Sauda-License-Generator-1\.1\.4\.exe/);
    expect(workflow).toMatch(/artifacts\/SHA256SUMS\.txt/);
  });
});

describe('release workflow: publication is staged and self-verifying', () => {
  it('creates the release as a draft', () => {
    expect(workflow).toMatch(/gh release create "\$TAG"/);
    expect(workflow).toMatch(/\n\s*--draft \\/);
    expect(workflow).toContain('--draft');
  });

  it('publishes only after the draft was created and its assets re-downloaded', () => {
    before('gh release create "$TAG"', 'gh release download "$TAG"');
    before('gh release download "$TAG"', 'gh release edit "$TAG" --draft=false');
  });

  it('re-downloads and re-verifies the uploaded assets', () => {
    expect(workflow).toMatch(/gh release download "\$TAG" --dir verify-dl/);
    // The published checksum file must equal the one computed from the built files…
    expect(workflow).toMatch(/diff artifacts\/SHA256SUMS\.txt verify-dl\/published-SHA256SUMS\.txt/);
    // …the downloaded bytes must match it…
    expect(workflow).toMatch(/sha256sum -c published-SHA256SUMS\.txt/);
    // …and the installer gate must run again on the downloaded copies.
    before('gh release download "$TAG"', 'scripts/verify-installer.mjs --dir verify-dl');
    before('scripts/verify-installer.mjs --dir verify-dl', 'gh release edit "$TAG" --draft=false');
    // Recomputed sums from the downloaded bytes must agree byte for byte.
    expect(workflow).toMatch(/diff artifacts\/SHA256SUMS\.txt verify-dl\/SHA256SUMS\.txt/);
  });

  it('asserts the asset list is exactly the expected three files', () => {
    expect(workflow).toMatch(/--json assets -q '\.assets \| length'/);
    expect(workflow).toMatch(/diff verify-assets\.txt expected-assets\.txt/);
  });

  it('never overwrites a release that is already published', () => {
    expect(workflow).toMatch(/--json isDraft -q \.isDraft/);
    expect(workflow).toMatch(/already exists and is published/);
  });

  it('confirms the release is not a draft after publication', () => {
    const publishAt = at('gh release edit "$TAG" --draft=false');
    const tail = workflow.slice(publishAt);
    expect(tail).toMatch(/still a draft after publication/);
  });

  it('guards every publication step behind a version tag, so a manual run publishes nothing', () => {
    const publishSteps = [
      'Create DRAFT release with the verified assets',
      'Download the uploaded assets again and re-verify them',
      'Publish the release',
    ];
    for (const name of publishSteps) {
      const stepAt = at(name);
      expect(stepAt).toBeGreaterThan(-1);
      const stepText = workflow.slice(stepAt, stepAt + 400);
      expect(stepText).toMatch(/if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/);
    }
    // Everything before the first publication step runs unconditionally.
    const firstPublish = at('Create DRAFT release with the verified assets');
    expect(workflow.slice(0, firstPublish)).not.toMatch(/gh release create/);
  });
});

describe('release workflow: a failed build cannot publish', () => {
  it('does not swallow gate failures and does not publish from a partial build', () => {
    const gateAt = workflow.lastIndexOf('npm run verify');
    const gateText = workflow.slice(Math.max(0, gateAt - 120), gateAt + 120);
    expect(gateText).toMatch(/pipefail|set -o pipefail/);
    // Nothing in the pipeline may ignore an installer-verification failure.
    expect(workflow).not.toMatch(/verify-installer\.mjs[^\n]*\|\|\s*true/);
    expect(workflow).not.toMatch(/gh release edit[^\n]*\|\|\s*true/);
    // Checksums are only produced by a passing verification, and must exist before upload.
    before('scripts/verify-installer.mjs', 'gh release create "$TAG"');
  });

  it('keeps the diagnostics that make a Windows-only failure diagnosable', () => {
    expect(workflow).toMatch(/scripts\/ci-failure-report\.mjs/);
    expect(workflow).toMatch(/name:\s*verify-logs/);
    expect(workflow).toMatch(/if:\s*always\(\)/);
  });
});

describe('continuous integration covers both supported platforms', () => {
  const ci = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

  it('runs on every push and pull request, on Linux and on Windows', () => {
    expect(ci).toMatch(/pull_request:/);
    expect(ci).toMatch(/runs-on:\s*ubuntu-latest/);
    expect(ci).toMatch(/runs-on:\s*windows-latest/);
    const gates = ci.match(/npm run verify/g) ?? [];
    expect(gates.length).toBeGreaterThanOrEqual(2);
  });

  it('publishes nothing and fails loudly instead', () => {
    expect(ci).not.toMatch(/softprops\/action-gh-release/);
    expect(ci).not.toMatch(/gh release/);
    expect(ci).toMatch(/scripts\/ci-failure-report\.mjs/);
  });
});
