/**
 * The one place that knows the release version (R-01/R-03).
 *
 * v1.1.4 hard-coded `1.1.4` in the release workflow, the notes gate and the notes renderer. That
 * meant a `v1.1.5` tag would have built fine and then failed at "Create DRAFT release" because
 * `artifacts/Sauda-Retail-Suite-Setup-1.1.4.exe` no longer exists — or, worse, republished the
 * previous version's notes under the new tag if only part of the chain was updated.
 *
 * Everything version-dependent now derives from `packages/app/package.json`, which the crate test
 * `packages/core/test/version-v114.test.ts` already keeps in step with `PRODUCT_VERSION` and the
 * other manifests.
 *
 * CLI (used by the release workflow, which needs shell values):
 *
 *   node scripts/lib/release-version.mjs --env     # key=value lines for $GITHUB_ENV
 *   node scripts/lib/release-version.mjs --get version|app|generator|notes
 *   node scripts/lib/release-version.mjs --assert-tag v1.1.5
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Reads the release version from the Main App manifest (the artefact-name source of truth). */
export function releaseVersion(rootDir = root) {
  const manifest = path.join(rootDir, 'packages', 'app', 'package.json');
  const version = String(JSON.parse(fs.readFileSync(manifest, 'utf8')).version ?? '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`unexpected release version in ${manifest}: "${version}" (expected x.y.z)`);
  }
  return version;
}

/** The two installer file names, in release order (app first, then the internal generator). */
export function artifactNames(version = releaseVersion()) {
  return {
    app: `Sauda-Retail-Suite-Setup-${version}.exe`,
    generator: `Sauda-License-Generator-${version}.exe`,
  };
}

/** The reviewed release notes for a version. */
export function releaseNotesPath(version = releaseVersion()) {
  return `docs/V${version}_RELEASE_NOTES.md`;
}

/** `1.1.4` for `1.1.5`; the previous documented baseline used in the upgrade section. */
export function previousVersion(version = releaseVersion()) {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`cannot derive a previous version from "${version}"`);
  }
  const [major, minor, patch] = parts;
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.0`;
  if (major > 0) return `${major - 1}.0.0`;
  throw new Error(`cannot derive a previous version from "${version}"`);
}

/** Parses `1.1.5` / `v1.1.5` into comparable numbers. Returns null when it is not a version. */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
}

/** True when `a` is strictly older than `b`. */
export function isOlderVersion(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i];
  }
  return false;
}

/**
 * Fails when the pushed tag and the manifest disagree. This is the guard that stops a v1.1.5
 * release from carrying 1.1.4 installers (or the other way round).
 */
export function assertTagMatchesVersion(tag, version = releaseVersion()) {
  const normalised = String(tag ?? '').trim().replace(/^v/, '');
  if (normalised !== version) {
    throw new Error(
      `tag "${tag}" does not match the release version "${version}" from packages/app/package.json — ` +
        'bump every manifest (and PRODUCT_VERSION) or push the matching tag; refusing to build a release that would be mislabelled',
    );
  }
  return normalised;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function main(argv) {
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  if (argv.includes('--assert-tag')) {
    const tag = flag('--assert-tag');
    if (!tag) throw new Error('--assert-tag needs a tag, e.g. --assert-tag v1.1.5');
    assertTagMatchesVersion(tag);
    console.log(`[release-version] tag ${tag} matches version ${releaseVersion()}`);
    return;
  }

  const version = releaseVersion();
  const names = artifactNames(version);

  if (argv.includes('--env')) {
    // Written to $GITHUB_ENV by the workflow; no quotes so bash and the runner both read it plainly.
    for (const [key, value] of [
      ['RELEASE_VERSION', version],
      ['RELEASE_TAG', `v${version}`],
      ['RELEASE_NOTES', releaseNotesPath(version)],
      ['APP_EXE', names.app],
      ['GENERATOR_EXE', names.generator],
    ]) {
      console.log(`${key}=${value}`);
    }
    return;
  }

  const field = flag('--get');
  const values = {
    version,
    app: names.app,
    generator: names.generator,
    notes: releaseNotesPath(version),
    previous: previousVersion(version),
  };
  if (field) {
    if (!(field in values)) throw new Error(`unknown --get field "${field}" (use ${Object.keys(values).join(', ')})`);
    console.log(values[field]);
    return;
  }

  console.log(JSON.stringify(values, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[release-version] ${error.message}`);
    process.exit(1);
  }
}
