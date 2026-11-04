/**
 * Renders the *publishable* release notes.
 *
 *   node scripts/render-release-notes.mjs \
 *     --notes docs/V1.1.4_RELEASE_NOTES.md \
 *     --sums artifacts/SHA256SUMS.txt \
 *     --dir artifacts \
 *     --out release-notes.md
 *
 * The reviewed notes file is the only accepted source of release text, but two values per
 * installer can only be known after the Windows build: the exact byte size and the SHA-256. This
 * script fills exactly those placeholders — in document order, app first then generator — from the
 * real files and the checksum file that `verify-installer.mjs` wrote from those same files.
 *
 * It refuses to produce output if:
 *  - an expected installer is missing or empty (a hash is never invented),
 *  - the checksum file has no entry for a file,
 *  - the number of build placeholders is not exactly four,
 *  - a placeholder is left over anywhere in the rendered text.
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const notesPath = arg('--notes', 'docs/V1.1.4_RELEASE_NOTES.md');
const sumsPath = arg('--sums', 'artifacts/SHA256SUMS.txt');
const dir = arg('--dir', 'artifacts');
const outPath = arg('--out', 'release-notes.md');

const APP = 'Sauda-Retail-Suite-Setup-1.1.4.exe';
const GENERATOR = 'Sauda-License-Generator-1.1.4.exe';

const fail = (message) => {
  console.error(`[render-release-notes] ${message}`);
  process.exit(1);
};

if (!fs.existsSync(notesPath)) fail(`${notesPath} does not exist`);
if (!fs.existsSync(sumsPath)) fail(`${sumsPath} does not exist — run verify-installer.mjs first`);

const notes = fs.readFileSync(notesPath, 'utf8');
const sumsText = fs.readFileSync(sumsPath, 'utf8');

/** Parse `sha256sum` output: "<hash>  <name>". */
const sums = new Map();
for (const line of sumsText.split(/\r?\n/)) {
  const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
  if (match) sums.set(path.basename(match[2].trim()), match[1].toLowerCase());
}

const files = [APP, GENERATOR].map((name) => {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) fail(`installer missing: ${file}`);
  const size = fs.statSync(file).size;
  if (!size) fail(`installer is empty: ${file}`);
  const sha = sums.get(name);
  if (!sha) fail(`no SHA-256 for ${name} in ${sumsPath}`);
  return { name, size, sha };
});

// Document order: the app appears before the generator in the reviewed notes.
let rendered = notes;
const placeholders = rendered.match(/<(bytes|sha256)>/g) ?? [];
if (placeholders.length !== 4) {
  fail(
    `expected 4 build placeholders (<bytes>/<sha256> for both installers) but found ${placeholders.length}: ` +
      [...new Set(placeholders)].join(', '),
  );
}
for (const file of files) {
  rendered = rendered.replace('<bytes>', String(file.size));
  rendered = rendered.replace('<sha256>', file.sha);
}
if (/<(bytes|sha256)>/.test(rendered)) fail('a build placeholder is still present after rendering');

// Any other `<...>` placeholder is a documentation defect, not a build value.
const leftovers = [...new Set(rendered.match(/<[A-Za-z][^<>\n]{0,60}>/g) ?? [])];
if (leftovers.length) fail(`unfilled placeholders remain: ${leftovers.join(', ')}`);

fs.writeFileSync(outPath, rendered, 'utf8');

console.log(`[render-release-notes] wrote ${outPath}`);
for (const file of files) {
  console.log(`[render-release-notes] ${file.name} — ${file.size} B — SHA-256 ${file.sha}`);
}
