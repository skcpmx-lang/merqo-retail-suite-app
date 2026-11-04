/**
 * Release-note gate (D-3).
 *
 *   node scripts/check-release-notes.mjs [--file docs/V1.1.4_RELEASE_NOTES.md] [--require-filled]
 *
 * The release job calls this with `--require-filled` after the installers are verified: the
 * reviewed notes file must still contain every mandatory section and disclosure, and every
 * `<placeholder>` must have been replaced with a measured value. Publishing with `<hash>` or
 * `<bytes>` in the notes is refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReleaseNotes } from './lib/release-notes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const fileIndex = argv.indexOf('--file');
const file = path.resolve(root, fileIndex >= 0 ? argv[fileIndex + 1] : 'docs/V1.1.4_RELEASE_NOTES.md');
const requireFilled = argv.includes('--require-filled');

if (!fs.existsSync(file)) {
  console.error(`[check-release-notes] ${path.relative(root, file)} does not exist.`);
  console.error('[check-release-notes] a release must use the reviewed notes file, not generated text.');
  process.exit(1);
}

const text = fs.readFileSync(file, 'utf8');
const { issues, placeholders } = checkReleaseNotes(text, { requireFilled });

if (issues.length) {
  console.error(`[check-release-notes] ${path.relative(root, file)} is not publishable:`);
  for (const issue of issues) console.error(`  ✖ ${issue}`);
  if (!requireFilled && placeholders.length) {
    console.error(
      `[check-release-notes] ${placeholders.length} placeholder(s) remain — the release job uses --require-filled.`,
    );
  }
  process.exit(1);
}

console.log(`[check-release-notes] ${path.relative(root, file)} is complete`);
if (placeholders.length) {
  console.log(
    `[check-release-notes] ${placeholders.length} placeholder(s) still present (allowed here, refused with --require-filled)`,
  );
}
