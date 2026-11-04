/**
 * Post-packaging verification.
 *
 *   node scripts/verify-installer.mjs [--dir artifacts]
 *
 * Checks that the generated installers exist, are plausibly sized, contain no
 * private signing material and writes a SHA-256 list next to them.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dirArg = args.indexOf('--dir');
const targetDir = dirArg >= 0 ? path.resolve(args[dirArg + 1]) : path.join(root, 'artifacts');
const minBytes = 20 * 1024 * 1024; // an Electron installer is never smaller than this

/** Byte patterns that must never appear in something we ship. */
const FORBIDDEN = [
  { label: 'PEM header', needle: Buffer.from('-----BEGIN') },
  { label: 'PEM private key block', needle: Buffer.from('PRIVATE KEY-----') },
  { label: 'Ed25519 PKCS#8 header (base64)', needle: Buffer.from('MC4CAQAwBQYDK2Vw') },
  { label: 'Sauda DEVICE private marker', needle: Buffer.from('sauda-private') },
];

function scan(file) {
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
  return { size, hits: [...new Set(hits)] };
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

if (!fs.existsSync(targetDir)) {
  console.error(`[verify-installer] ${targetDir} does not exist — nothing was packaged.`);
  process.exit(1);
}

const files = fs
  .readdirSync(targetDir)
  .filter((f) => f.toLowerCase().endsWith('.exe'))
  .map((f) => path.join(targetDir, f));

if (files.length < 1) {
  console.error(`[verify-installer] no .exe files in ${targetDir}`);
  process.exit(1);
}

let failed = false;
const sums = [];
for (const file of files) {
  const { size, hits } = scan(file);
  const digest = sha256(file);
  sums.push(`${digest}  ${path.basename(file)}`);
  const mb = (size / (1024 * 1024)).toFixed(1);
  console.log(`✔ ${path.basename(file)} — ${mb} MB — sha256 ${digest}`);
  if (size < minBytes) {
    console.error(`✖ ${path.basename(file)} is suspiciously small (${mb} MB)`);
    failed = true;
  }
  if (hits.length) {
    console.error(`✖ ${path.basename(file)} contains forbidden material: ${hits.join(', ')}`);
    failed = true;
  }
}

// The unpacked application is what actually ends up installed: scan it too.
const appDir = path.join(root, 'packages', 'app', 'release', 'win-unpacked', 'resources');
if (fs.existsSync(appDir)) {
  for (const entry of fs.readdirSync(appDir)) {
    const full = path.join(appDir, entry);
    if (!fs.statSync(full).isFile()) continue;
    const { hits } = scan(full);
    if (hits.length) {
      console.error(`✖ packaged resource ${entry} contains: ${hits.join(', ')}`);
      failed = true;
    }
  }
  console.log('✔ packaged resources contain no private key material');
} else {
  console.log('· win-unpacked not present — resource scan skipped (installer scanned only)');
}

const sumsPath = path.join(targetDir, 'SHA256SUMS.txt');
fs.writeFileSync(sumsPath, sums.join('\n') + '\n', 'utf8');
console.log(`checksums written to ${path.relative(root, sumsPath)}`);

if (failed) process.exit(1);
console.log('[verify-installer] installers look complete and key-free');
