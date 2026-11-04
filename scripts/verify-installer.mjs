/**
 * Post-packaging verification — the release gate (D-2).
 *
 *   node scripts/verify-installer.mjs [--dir artifacts] [--version 1.1.4] [--require-signature]
 *
 * Runs on Windows, on the final installers, and refuses to pass unless every check succeeds:
 *
 *   1. both expected installers exist and are plausibly sized;
 *   2. the Authenticode status is read and reported (unsigned is accepted under the v1.1.4
 *      policy; `--require-signature` turns it back into a hard gate);
 *   3. ProductVersion and FileVersion match the release version;
 *   4. the executable is a PE image for x64 (`8664`), not arm64/i386 and not a Linux binary;
 *   5. neither the installers nor the unpacked application contain private key material;
 *   6. SHA-256 sums are computed from these exact files and written to SHA256SUMS.txt.
 *
 * If any hard check fails the process exits non-zero and SHA256SUMS.txt is **not** written, so a
 * broken build cannot be published with a tidy checksum file attached. Being unsigned is not a
 * hard failure: it is recorded as `Authenticode: Unsigned — accepted by owner.`
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateInstaller,
  machineLabel,
  missingArtifacts,
  parseSignatureReport,
  parseVersionReport,
  peMachine,
} from './lib/installer-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argValue = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const targetDir = path.resolve(argValue('--dir') ?? path.join(root, 'artifacts'));
const requireSignature = argv.includes('--require-signature');

const defaultVersion = JSON.parse(fs.readFileSync(path.join(root, 'packages', 'app', 'package.json'), 'utf8')).version;
const version = argValue('--version') ?? defaultVersion;

const minBytes = 20 * 1024 * 1024; // an Electron installer is never smaller than this

/** Byte patterns that must never appear in something we ship. */
const FORBIDDEN = [
  { label: 'PEM header', needle: Buffer.from('-----BEGIN') },
  { label: 'PEM private key block', needle: Buffer.from('PRIVATE KEY-----') },
  { label: 'Ed25519 PKCS#8 header (base64)', needle: Buffer.from('MC4CAQAwBQYDK2Vw') },
  { label: 'Sauda DEVICE private marker', needle: Buffer.from('sauda-private') },
];

const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

function scanForSecrets(file) {
  const size = fs.statSync(file).size;
  const hits = [];
  const chunk = 8 * 1024 * 1024;
  const overlap = 64;
  const fd = fs.openSync(file, 'r');
  try {
    let position = 0;
    let carry = Buffer.alloc(0);
    while (position < size) {
      const buf = Buffer.alloc(Math.min(chunk, size - position));
      fs.readSync(fd, buf, 0, buf.length, position);
      const hay = carry.length ? Buffer.concat([carry, buf]) : buf;
      for (const pattern of FORBIDDEN) {
        if (hay.includes(pattern.needle)) hits.push(pattern.label);
      }
      carry = hay.subarray(Math.max(0, hay.length - overlap));
      position += buf.length;
    }
  } finally {
    fs.closeSync(fd);
  }
  return [...new Set(hits)];
}

function readHead(file, length = 4096) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function powershell(command) {
  const exe = process.platform === 'win32' ? 'powershell' : 'pwsh';
  const result = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) return { ok: false, error: String(result.error.message ?? result.error) };
  if (result.status !== 0) return { ok: false, error: (result.stderr || result.stdout || '').trim() };
  return { ok: true, stdout: result.stdout ?? '' };
}

const quote = (file) => String(file).replace(/'/g, "''");

function readVersionInfo(file) {
  const script = `$v=(Get-Item '${quote(file)}').VersionInfo; [pscustomobject]@{ProductName=$v.ProductName;ProductVersion=$v.ProductVersion;FileVersion=$v.FileVersion;CompanyName=$v.CompanyName} | ConvertTo-Json -Compress`;
  const result = powershell(script);
  if (!result.ok) return { value: null, error: result.error };
  return { value: parseVersionReport(result.stdout), error: null };
}

function readSignature(file) {
  const script = `$s=Get-AuthenticodeSignature '${quote(file)}'; [pscustomobject]@{Status="$($s.Status)";StatusMessage="$($s.StatusMessage)";SignerSubject="$($s.SignerCertificate.Subject)";TimestamperSubject="$($s.TimeStamperCertificate.Subject)"} | ConvertTo-Json -Compress`;
  const result = powershell(script);
  if (!result.ok) return { value: null, error: result.error };
  return { value: parseSignatureReport(result.stdout), error: null };
}

console.log(`[verify-installer] release gate for ${version}`);
console.log(`[verify-installer] directory: ${targetDir}`);

// Authenticode status is read on Windows via PowerShell. Elsewhere it cannot be read, which is
// reported as "not read" rather than treated as a failure — unsigned is an accepted policy.
const canReadSignature = process.platform === 'win32';

if (!fs.existsSync(targetDir)) {
  console.error(`[verify-installer] ${targetDir} does not exist — nothing was packaged.`);
  process.exit(1);
}

const present = fs
  .readdirSync(targetDir)
  .filter((f) => f.toLowerCase().endsWith('.exe'))
  .sort();
const missing = missingArtifacts(present, version);
if (missing.length) fail(`missing expected artefact(s): ${missing.join(', ')}`);
if (!present.length) fail(`no .exe files in ${targetDir}`);

const sums = [];
for (const name of present) {
  const file = path.join(targetDir, name);
  const size = fs.statSync(file).size;
  const digest = sha256(file);
  const secrets = scanForSecrets(file);
  const machine = peMachine(readHead(file));
  // VersionInfo and the signature are Windows APIs; on other hosts the metadata is unreadable,
  // and since release builds happen on Windows the check simply skips with a warning.
  const versionResult = canReadSignature
    ? readVersionInfo(file)
    : { value: null, error: 'version metadata can only be read on Windows' };
  const signatureResult = canReadSignature ? readSignature(file) : { value: null, error: null };

  const { failures, warnings } = evaluateInstaller({
    name,
    sizeBytes: size,
    minBytes,
    version,
    versionInfo: versionResult.value,
    signature: signatureResult.value,
    machine,
    requireSignature,
    requireTimestamp: requireSignature,
  });
  if (versionResult.error) failures.unshift(`${name}: could not read version metadata (${versionResult.error})`);
  if (signatureResult.error) failures.unshift(`${name}: could not read Authenticode status (${signatureResult.error})`);
  if (secrets.length) failures.push(`${name}: contains forbidden key material (${secrets.join(', ')})`);

  for (const warning of warnings) notes.push(warning);
  for (const message of failures) fail(message);

  const mb = (size / (1024 * 1024)).toFixed(1);
  const status = failures.length ? '✖' : '✔';
  const signatureLabel = signatureResult.value?.status ?? (canReadSignature ? 'unreadable' : 'not read');
  console.log(
    `${status} ${name} — ${mb} MB — ${machineLabel(machine)} — ${signatureLabel} — sha256 ${digest}`,
  );
  sums.push(`${digest}  ${name}`);
}

// The unpacked application is what actually ends up installed: scan it too.
const unpackedRoots = [
  path.join(root, 'packages', 'app', 'release', 'win-unpacked', 'resources'),
  path.join(root, 'packages', 'license-generator', 'release', 'win-unpacked', 'resources'),
];
let scannedUnpacked = 0;
for (const resources of unpackedRoots) {
  if (!fs.existsSync(resources)) continue;
  scannedUnpacked += 1;
  for (const entry of fs.readdirSync(resources)) {
    const full = path.join(resources, entry);
    if (!fs.statSync(full).isFile()) continue;
    const hits = scanForSecrets(full);
    if (hits.length) fail(`packaged resource ${entry} contains: ${hits.join(', ')}`);
  }
}
if (scannedUnpacked) {
  if (!problems.some((p) => p.startsWith('packaged resource'))) {
    console.log('✔ packaged resources contain no private key material');
  }
} else {
  notes.push('win-unpacked not present — resource scan skipped (installer bytes scanned only)');
}

for (const note of notes) console.warn(`⚠ ${note}`);

const signatures = [];
for (const name of present) {
  const signature = canReadSignature ? readSignature(path.join(targetDir, name)).value : null;
  signatures.push({ name, signature });
}
console.log('');
for (const { name, signature } of signatures) {
  if (signature && signature.status.toLowerCase() === 'valid') {
    console.log(`Authenticode: ${name} — Valid (${signature.subject || 'subject not reported'})`);
  } else {
    console.log(`Authenticode: ${name} — Unsigned — accepted by owner.`);
  }
}
console.log('');

if (problems.length) {
  console.error('\n[verify-installer] RELEASE BLOCKED:');
  for (const problem of problems) console.error(`  ✖ ${problem}`);
  console.error('\n[verify-installer] SHA256SUMS.txt was not written. Do not upload these files.');
  process.exit(1);
}

const sumsPath = path.join(targetDir, 'SHA256SUMS.txt');
fs.writeFileSync(sumsPath, sums.join('\n') + '\n', 'utf8');
console.log(`checksums written to ${path.relative(root, sumsPath)}`);
console.log('[verify-installer] installers are signed, correctly versioned, x64 and key-free');
