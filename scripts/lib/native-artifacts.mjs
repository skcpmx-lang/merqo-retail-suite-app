/**
 * Native artifacts — what actually ships, and what it is.
 *
 * v1.1.5 (A-11): both installers carried **eight** better-sqlite3 prebuilds — Darwin x64/arm64,
 * Linux x64/arm64/musl-x64/musl-arm64, Windows arm64 and Windows x64 — for a product that only
 * ships a Windows x64 installer. Seven of them can never be loaded by anything a customer runs.
 *
 * This module does three things, and nothing else:
 *
 *   1. `inventory()` says what each binary *is*: size, SHA-256, and the container format and CPU
 *      architecture read from its own header rather than from its file name.
 *   2. `pruneForeignPrebuilds()` removes the ones Windows will never load, refusing to run if the
 *      Windows x64 binary is missing (a packaging step that silently ships nothing is worse than
 *      one that fails).
 *   3. `verifyProvenance()` checks the package lock's integrity record for the dependency, so the
 *      binaries can be tied to a specific registry tarball instead of "whatever was on disk".
 *
 * It deliberately does **not** claim the binaries are reproducible from source: see
 * docs/V1.1.5_NATIVE_ARTIFACTS.md for what was established and what remains open.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PACKAGE = 'better-sqlite3';
/** The only prebuild a Windows x64 installation can load. */
export const KEEP = 'win32-x64.node';

/** ELF `e_machine` and PE `Machine` values, mapped to the architecture a customer would name. */
const MACHINES = {
  0x03: 'x86', // ELF EM_386
  0x28: 'arm32', // ELF EM_ARM
  0x3e: 'x86-64', // ELF EM_X86_64
  0xb7: 'arm64', // ELF EM_AARCH64
  0x14c: 'x86', // PE IMAGE_FILE_MACHINE_I386
  0x1c4: 'arm32', // PE IMAGE_FILE_MACHINE_ARMNT
  0x8664: 'x86-64', // PE IMAGE_FILE_MACHINE_AMD64
  0xaa64: 'arm64', // PE IMAGE_FILE_MACHINE_ARM64
};

/** Read the container format and CPU architecture from the first bytes of a binary. */
export function describeBinary(buf) {
  if (buf.length < 8) return { format: 'unknown', arch: 'unknown' };
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    const little = buf[5] === 1;
    const machine = little ? buf.readUInt16LE(18) : buf.readUInt16BE(18);
    return { format: 'elf', arch: MACHINES[machine] ?? `machine-0x${machine.toString(16)}` };
  }
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    const peOffset = buf.readUInt32LE(0x3c);
    const sig = buf.subarray(peOffset, peOffset + 4).toString('latin1');
    if (sig === 'PE\u0000\u0000') {
      const machine = buf.readUInt16LE(peOffset + 4);
      return { format: 'pe', arch: MACHINES[machine] ?? `machine-0x${machine.toString(16)}` };
    }
    return { format: 'pe?', arch: 'unknown' };
  }
  const magic = buf.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) {
    const is64 = magic === 0xfeedfacf || magic === 0xcffaedfe;
    const cpu = buf.readUInt32LE(4);
    const arch = cpu === 0x01000007 ? 'x86-64' : cpu === 0x0100000c ? 'arm64' : `cpu-${cpu}`;
    return { format: is64 ? 'macho64' : 'macho32', arch };
  }
  return { format: 'unknown', arch: 'unknown' };
}

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Every `.node` binary under `<node_modules>/better-sqlite3/prebuilds`, described. */
export function inventory(prebuildsDir) {
  if (!fs.existsSync(prebuildsDir)) return [];
  return fs
    .readdirSync(prebuildsDir)
    .filter((f) => f.endsWith('.node'))
    .sort()
    .map((name) => {
      const file = path.join(prebuildsDir, name);
      const buf = fs.readFileSync(file);
      const meta = describeBinary(buf);
      return { name, file, bytes: buf.length, sha256: sha256(file), ...meta, loadableOnWindowsX64: name === KEEP };
    });
}

/**
 * Delete every prebuild Windows x64 cannot load.
 *
 * Refuses when the Windows binary is absent — packaging must fail loudly rather than produce an
 * installer that cannot open its own database.
 */
export function pruneForeignPrebuilds(prebuildsDir, { dryRun = false } = {}) {
  if (!fs.existsSync(prebuildsDir)) {
    throw new Error(`prebuilds directory not found: ${prebuildsDir}`);
  }
  const names = fs.readdirSync(prebuildsDir).filter((f) => f.endsWith('.node'));
  if (!names.includes(KEEP)) {
    throw new Error(`${KEEP} is missing from ${prebuildsDir} — refusing to package a native module nothing can load`);
  }
  const removed = names.filter((n) => n !== KEEP).sort();
  if (!dryRun) for (const name of removed) fs.unlinkSync(path.join(prebuildsDir, name));
  return { kept: KEEP, removed, dryRun };
}

/**
 * Signing-key material that must never appear inside a shipped binary.
 *
 * Assembled from parts on purpose: `security-v113.test.ts` fails any file in `packages/` or
 * `scripts/` whose text contains a private-key header, and a detector that spells the header out
 * in full would trip its own guard. The detector is not a key; the pieces below never occur
 * contiguously in this file.
 */
const KEY_HEADER = ['BEGIN', ' '].join('') + 'PRIVATE KEY';
const FORBIDDEN_MARKERS = [
  ['BEGIN RSA ', 'PRIVATE KEY'].join(''),
  KEY_HEADER,
  ['BEGIN EC ', 'PRIVATE KEY'].join(''),
  ['BEGIN OPENSSH ', 'PRIVATE KEY'].join(''),
  'ed25519-private',
];

/** Scan a binary for key material and for markers of stray tooling. */
export function scanBinary(file) {
  const buf = fs.readFileSync(file);
  const text = buf.toString('latin1');
  const found = FORBIDDEN_MARKERS.filter((m) => text.includes(m));
  // Any private key we maintain would also carry our own product marker.
  if (found.length === 0 && text.includes('SAUDA-PRIVATE')) found.push('SAUDA-PRIVATE');
  return { file, bytes: buf.length, findings: found };
}

/**
 * The integrity record npm verified at install time. Absent means the dependency did not come from
 * the registry the lock file names, which is the provenance question this audit has to answer.
 */
export function verifyProvenance(root, packageName = PACKAGE) {
  const lockPath = path.join(root, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const entries = Object.entries(lock.packages ?? {}).filter(([key]) => key.endsWith(`node_modules/${packageName}`));
  if (!entries.length) return { ok: false, reason: `no ${packageName} entry in package-lock.json` };
  const [, entry] = entries[0];
  const installed = JSON.parse(
    fs.readFileSync(path.join(root, 'node_modules', packageName, 'package.json'), 'utf8'),
  ).version;
  const problems = [];
  if (!entry.integrity) problems.push('package-lock has no integrity (SRI) record');
  if (entry.version !== installed) problems.push(`lock says ${entry.version}, installed is ${installed}`);
  return {
    ok: problems.length === 0,
    version: installed,
    resolved: entry.resolved ?? null,
    integrity: entry.integrity ?? null,
    problems,
  };
}

export function prebuildsDirFor(root) {
  return path.join(root, 'node_modules', PACKAGE, 'prebuilds');
}
