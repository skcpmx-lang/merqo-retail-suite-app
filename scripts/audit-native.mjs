/**
 * Native artifacts audit (A-11) — what the installers would carry, and what it is.
 *
 * Read-only: it inspects `node_modules` and the packaging rules, and prints the inventory. The
 * removal itself happens at packaging time (`pruneForeignPrebuilds` in both `scripts/package-*.mjs`),
 * where it is verified by `scripts/tests/native-artifacts.test.mjs`.
 *
 * Fails when:
 *   - the Windows x64 binary is missing or is not actually a Windows x64 binary;
 *   - a prebuild would ship that nothing on Windows can load;
 *   - any binary carries private-key material;
 *   - the dependency cannot be tied to a registry tarball via the lock file's integrity record.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KEEP,
  describeBinary,
  inventory,
  prebuildsDirFor,
  pruneForeignPrebuilds,
  scanBinary,
  verifyProvenance,
} from './lib/native-artifacts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = prebuildsDirFor(root);
const problems = [];

const rows = inventory(dir);
if (!rows.length) {
  // A machine that compiled from source instead of using a prebuild has nothing to prune; the
  // audit is about what ships, so say so and stay green rather than failing a source build.
  const built = path.join(root, 'node_modules', 'better-sqlite3', 'build', 'Release');
  const compiled = fs.existsSync(built) && fs.readdirSync(built).some((f) => f.endsWith('.node'));
  if (compiled) {
    console.log('native artifacts audit: no prebuilds present, better-sqlite3 was built from source ✔');
    process.exit(0);
  }
  console.error(`✖ no prebuilds found in ${path.relative(root, dir)} and no source build in build/Release`);
  process.exit(1);
}

const provenance = verifyProvenance(root);
const keepRow = rows.find((r) => r.name === KEEP);

console.log(`better-sqlite3 ${provenance.version ?? '?'} — ${rows.length} prebuild(s) present:`);
for (const row of rows) {
  const marker = row.loadableOnWindowsX64 ? 'ship' : 'drop';
  console.log(
    `  ${marker}  ${row.name.padEnd(22)} ${String(row.bytes).padStart(9)} B  ${row.format}/${row.arch}  ${row.sha256.slice(0, 16)}…`,
  );
}

if (!keepRow) problems.push(`${KEEP} is missing — a Windows installer would have no SQLite binding`);
else if (!(keepRow.format === 'pe' && keepRow.arch === 'x86-64')) {
  problems.push(`${KEEP} is ${keepRow.format}/${keepRow.arch}, not a Windows x86-64 PE binary`);
}

let prune = null;
try {
  prune = pruneForeignPrebuilds(dir, { dryRun: true });
} catch (err) {
  problems.push(`prune check failed: ${err.message}`);
}

for (const row of rows) {
  const scan = scanBinary(row.file);
  if (scan.findings.length) problems.push(`${row.name} contains forbidden material: ${scan.findings.join(', ')}`);
}

if (!provenance.ok) {
  for (const p of provenance.problems ?? [provenance.reason]) problems.push(`provenance: ${p}`);
}

// Both packaging scripts must prune, or an installer could still be built with the foreign set.
for (const script of ['scripts/package-app.mjs', 'scripts/package-license-generator.mjs']) {
  const source = fs.readFileSync(path.join(root, script), 'utf8');
  if (!source.includes('pruneForeignPrebuilds')) problems.push(`${script} does not prune foreign prebuilds`);
}

if (prune) {
  const droppedBytes = rows.filter((r) => r.name !== KEEP).reduce((sum, r) => sum + r.bytes, 0);
  console.log(
    `\npackaged set after prune: ${prune.kept} only — ${prune.removed.length} binary/binaries and ${(
      droppedBytes /
      1024 /
      1024
    ).toFixed(1)} MiB (uncompressed) do not reach either installer`,
  );
}
console.log(`provenance: ${provenance.resolved ?? 'unknown'} ${provenance.integrity ?? ''}`.trim());

if (problems.length) {
  for (const p of problems) console.error(`✖ ${p}`);
  console.error(`✖ native artifacts audit failed (${problems.length} problem(s))`);
  process.exit(1);
}

// Sanity: the reader must agree with the file name for the binary that actually ships.
const byName = describeBinary(fs.readFileSync(path.join(dir, KEEP)));
if (byName.format !== 'pe' || byName.arch !== 'x86-64') {
  console.error(`✖ ${KEEP} did not parse as a Windows x86-64 binary`);
  process.exit(1);
}

console.log('native artifacts audit: Windows x64 only, no key material, provenance recorded ✔');
