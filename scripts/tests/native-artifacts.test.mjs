/**
 * Native artifact handling (A-11) — the packaging step must ship exactly one binary.
 *
 * These tests use synthetic files with real container headers, so the format/architecture reader is
 * exercised for what it actually does (read the header) rather than for what a file is called.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KEEP,
  describeBinary,
  inventory,
  prebuildsDirFor,
  pruneForeignPrebuilds,
  scanBinary,
  verifyProvenance,
} from '../lib/native-artifacts.mjs';

const dirs = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-native-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** `MZ` + e_lfanew + "PE\0\0" + machine, enough for the reader. */
function peBinary(machine) {
  const buf = Buffer.alloc(256);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'latin1');
  buf.writeUInt16LE(machine, 0x84);
  return buf;
}

/** ELF header with the given `e_machine`. */
function elfBinary(machine) {
  const buf = Buffer.alloc(64);
  buf[0] = 0x7f;
  buf.write('ELF', 1, 'latin1');
  buf[4] = 2; // 64-bit
  buf[5] = 1; // little endian
  buf.writeUInt16LE(machine, 18);
  return buf;
}

function machoBinary(cpu) {
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(0xfeedfacf, 0);
  buf.writeUInt32LE(cpu, 4);
  return buf;
}

const write = (dir, name, buf) => fs.writeFileSync(path.join(dir, name), buf);

describe('format and architecture come from the header, not the file name', () => {
  it('reads PE, ELF and Mach-O machines', () => {
    expect(describeBinary(peBinary(0x8664))).toEqual({ format: 'pe', arch: 'x86-64' });
    expect(describeBinary(peBinary(0xaa64))).toEqual({ format: 'pe', arch: 'arm64' });
    expect(describeBinary(elfBinary(0x3e))).toEqual({ format: 'elf', arch: 'x86-64' });
    expect(describeBinary(elfBinary(0xb7))).toEqual({ format: 'elf', arch: 'arm64' });
    expect(describeBinary(machoBinary(0x01000007))).toEqual({ format: 'macho64', arch: 'x86-64' });
    expect(describeBinary(machoBinary(0x0100000c))).toEqual({ format: 'macho64', arch: 'arm64' });
    expect(describeBinary(Buffer.from('not a binary'))).toEqual({ format: 'unknown', arch: 'unknown' });
  });
});

describe('packaging prunes everything Windows x64 cannot load', () => {
  it('keeps win32-x64 and removes the other platforms', () => {
    const dir = tmp();
    write(dir, 'win32-x64.node', peBinary(0x8664));
    write(dir, 'win32-arm64.node', peBinary(0xaa64));
    write(dir, 'linux-x64.node', elfBinary(0x3e));
    write(dir, 'darwin-arm64.node', machoBinary(0x0100000c));
    write(dir, 'README.txt', Buffer.from('not a library'));

    const result = pruneForeignPrebuilds(dir);

    expect(result.kept).toBe(KEEP);
    expect(result.removed).toEqual(['darwin-arm64.node', 'linux-x64.node', 'win32-arm64.node']);
    expect(fs.readdirSync(dir).sort()).toEqual(['README.txt', 'win32-x64.node']);
  });

  it('is idempotent, so a re-run of the packaging step is harmless', () => {
    const dir = tmp();
    write(dir, 'win32-x64.node', peBinary(0x8664));
    write(dir, 'linux-x64.node', elfBinary(0x3e));
    pruneForeignPrebuilds(dir);
    expect(pruneForeignPrebuilds(dir)).toEqual({ kept: KEEP, removed: [], dryRun: false });
  });

  it('refuses to run when the Windows binary is missing', () => {
    const dir = tmp();
    write(dir, 'linux-x64.node', elfBinary(0x3e));
    expect(() => pruneForeignPrebuilds(dir)).toThrow(/win32-x64\.node is missing/);
    // and it removed nothing while refusing
    expect(fs.readdirSync(dir)).toEqual(['linux-x64.node']);
  });

  it('a dry run reports the same set without touching the tree', () => {
    const dir = tmp();
    write(dir, 'win32-x64.node', peBinary(0x8664));
    write(dir, 'linux-x64.node', elfBinary(0x3e));
    const result = pruneForeignPrebuilds(dir, { dryRun: true });
    expect(result.removed).toEqual(['linux-x64.node']);
    expect(fs.readdirSync(dir).sort()).toEqual(['linux-x64.node', 'win32-x64.node']);
  });
});

describe('inventory and provenance', () => {
  it('marks exactly one prebuild as loadable on Windows x64 and records hashes', () => {
    const dir = tmp();
    write(dir, 'win32-x64.node', peBinary(0x8664));
    write(dir, 'linux-x64.node', elfBinary(0x3e));
    const rows = inventory(dir);
    expect(rows.map((r) => r.name)).toEqual(['linux-x64.node', 'win32-x64.node']);
    expect(rows.filter((r) => r.loadableOnWindowsX64).map((r) => r.name)).toEqual(['win32-x64.node']);
    for (const row of rows) expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns nothing for a directory that does not exist instead of throwing', () => {
    expect(inventory(path.join(tmp(), 'missing'))).toEqual([]);
  });

  it('finds private-key material inside a binary', () => {
    const dir = tmp();
    const file = path.join(dir, 'win32-x64.node');
    // Assembled, not spelled out: the repository's own security test refuses a file that contains
    // a private-key header, and this fixture is not a key.
    const keyHeader = ['-----BEGIN', ' PRIVATE KEY-----'].join('');
    fs.writeFileSync(file, Buffer.concat([peBinary(0x8664), Buffer.from(keyHeader)]));
    expect(scanBinary(file).findings.length).toBe(1);

    write(dir, 'clean.node', peBinary(0x8664));
    expect(scanBinary(path.join(dir, 'clean.node')).findings).toEqual([]);
  });

  it('ties the dependency to a registry tarball through the lock file', async () => {
    const root = path.resolve(import.meta.dirname, '..', '..');
    const provenance = verifyProvenance(root);
    expect(provenance.ok).toBe(true);
    expect(provenance.version).toBe('13.0.3');
    expect(provenance.resolved).toContain('registry.npmjs.org/better-sqlite3');
    expect(provenance.integrity).toMatch(/^sha512-/);
    expect(prebuildsDirFor(root)).toContain(path.join('node_modules', 'better-sqlite3', 'prebuilds'));
  });

  it('reports a missing lock entry rather than assuming provenance', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {} }));
    const provenance = verifyProvenance(root, 'better-sqlite3');
    expect(provenance.ok).toBe(false);
    expect(provenance.reason).toMatch(/no better-sqlite3 entry/);
  });
});
