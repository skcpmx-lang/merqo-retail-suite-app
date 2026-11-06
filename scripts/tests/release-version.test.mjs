/**
 * Release-version single source of truth (R-01/R-03).
 *
 * v1.1.4 hard-coded `1.1.4` in the release workflow and release tooling. A `v1.1.5` tag would have
 * built fine and then failed at "Create DRAFT release" on a file that no longer exists, or published
 * the previous version's notes under the new tag. These tests pin the replacement contract:
 *
 *  - every version-dependent name is derived from `packages/app/package.json`;
 *  - a tag that disagrees with the manifest is refused;
 *  - the notes path follows the version, so the gate can never quietly check last release's file.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  artifactNames,
  assertTagMatchesVersion,
  isOlderVersion,
  parseVersion,
  previousVersion,
  releaseNotesPath,
  releaseVersion,
} from '../lib/release-version.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(repoRoot, 'scripts', 'lib', 'release-version.mjs');
const manifestVersion = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'packages', 'app', 'package.json'), 'utf8'),
).version;

const run = (...args) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: repoRoot });

describe('version source of truth', () => {
  it('reads the version from the Main App manifest', () => {
    expect(releaseVersion()).toBe(manifestVersion);
    expect(releaseVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('derives both installer names and the notes path from that version', () => {
    const names = artifactNames('1.2.3');
    expect(names).toEqual({
      app: 'Sauda-Retail-Suite-Setup-1.2.3.exe',
      generator: 'Sauda-License-Generator-1.2.3.exe',
    });
    expect(releaseNotesPath('1.2.3')).toBe('docs/V1.2.3_RELEASE_NOTES.md');
    // The real version's names must match what electron-builder's artifactName produces.
    expect(artifactNames().app).toBe(`Sauda-Retail-Suite-Setup-${manifestVersion}.exe`);
  });

  it('knows the previous documented baseline for the upgrade section', () => {
    expect(previousVersion('1.1.5')).toBe('1.1.4');
    expect(previousVersion('2.0.0')).toBe('1.0.0');
    expect(previousVersion('1.2.0')).toBe('1.1.0');
    expect(() => previousVersion('0.0.0')).toThrow();
  });

  it('compares versions for the upgrade-section check', () => {
    expect(parseVersion('v1.1.5')).toEqual([1, 1, 5]);
    expect(parseVersion('1.1')).toBeNull();
    expect(isOlderVersion('1.1.4', '1.1.5')).toBe(true);
    expect(isOlderVersion('1.1.5', '1.1.4')).toBe(false);
    expect(isOlderVersion('nonsense', '1.1.5')).toBe(false);
  });
});

describe('tag/version guard', () => {
  it('accepts the matching tag, with or without the v prefix', () => {
    expect(assertTagMatchesVersion(`v${manifestVersion}`)).toBe(manifestVersion);
    expect(assertTagMatchesVersion(manifestVersion)).toBe(manifestVersion);
  });

  it('refuses a tag that does not match the manifests', () => {
    expect(() => assertTagMatchesVersion('v9.9.9')).toThrow(/does not match the release version/);
    expect(() => assertTagMatchesVersion('v1.1.4')).toThrow(/does not match the release version/);
    expect(() => assertTagMatchesVersion('')).toThrow(/does not match the release version/);
  });
});

describe('CLI used by the release workflow', () => {
  it('prints shell-assignable key=value lines for $GITHUB_ENV', () => {
    const result = run('--env');
    expect(result.status).toBe(0);
    const env = Object.fromEntries(
      result.stdout
        .trim()
        .split('\n')
        .map((line) => line.split('=')),
    );
    expect(env).toMatchObject({
      RELEASE_VERSION: manifestVersion,
      RELEASE_TAG: `v${manifestVersion}`,
      RELEASE_NOTES: `docs/V${manifestVersion}_RELEASE_NOTES.md`,
      APP_EXE: `Sauda-Retail-Suite-Setup-${manifestVersion}.exe`,
      GENERATOR_EXE: `Sauda-License-Generator-${manifestVersion}.exe`,
    });
  });

  it('exits non-zero for a mismatched tag so the workflow stops before packaging', () => {
    const result = run('--assert-tag', 'v9.9.9');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/does not match the release version/);
  });

  it('serves individual fields for scripts', () => {
    expect(run('--get', 'version').stdout.trim()).toBe(manifestVersion);
    expect(run('--get', 'previous').stdout.trim()).toBe(previousVersion(manifestVersion));
    expect(run('--get', 'nonsense').status).not.toBe(0);
  });
});

describe('the release notes for this version exist', () => {
  it('has a reviewed notes file at the derived path', () => {
    const notes = path.join(repoRoot, releaseNotesPath());
    expect(fs.existsSync(notes), `${releaseNotesPath()} must exist before tagging`).toBe(true);
    const text = fs.readFileSync(notes, 'utf8');
    expect(text).toContain(`# Sauda Retail Suite v${manifestVersion}`);
    // A copied previous release's notes are caught by the version in the title.
    expect(text).not.toContain('Sauda Retail Suite v1.1.4');
  });
});
