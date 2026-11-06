/**
 * render-release-notes.mjs contract.
 *
 * The published release text must always carry the *measured* byte size and SHA-256 of the two
 * installers. Two states are legitimate and both are covered here:
 *
 *  1. the reviewed notes still contain the four `<bytes>`/`<sha256>` placeholders — they are filled
 *     from the build output (`artifacts/SHA256SUMS.txt`);
 *  2. the notes are already finalised with measured values — those values must match the files
 *     being published, so a rebuilt installer with a different hash is caught instead of being
 *     published under a stale number.
 *
 * Everything else fails: a missing or empty installer, a missing checksum, an odd placeholder count,
 * or a value in the text that does not correspond to the file on disk.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { artifactNames, releaseVersion } from '../lib/release-version.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(repoRoot, 'scripts', 'render-release-notes.mjs');
// Derived from the manifest, so this contract survives every release (R-01).
const VERSION = releaseVersion();
const { app: APP, generator: GENERATOR } = artifactNames(VERSION);

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-render-'));
  const artifacts = path.join(dir, 'artifacts');
  fs.mkdirSync(artifacts);

  const appPath = path.join(artifacts, APP);
  const generatorPath = path.join(artifacts, GENERATOR);
  fs.writeFileSync(appPath, Buffer.alloc(4096, 7));
  fs.writeFileSync(generatorPath, Buffer.alloc(2048, 9));

  const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const appSha = sha(appPath);
  const generatorSha = sha(generatorPath);
  const sums = path.join(artifacts, 'SHA256SUMS.txt');
  fs.writeFileSync(sums, `${appSha}  ${APP}\n${generatorSha}  ${GENERATOR}\n`);

  const notes = path.join(dir, 'notes.md');
  const out = path.join(dir, 'release-notes.md');
  return { dir, artifacts, appPath, generatorPath, sums, notes, out, appSha, generatorSha };
}

const tick = '`';
const line = (name, bytes, sha) => `- ${tick}${name}${tick} — ${bytes} B — SHA-256 ${tick}${sha}${tick}`;
const template = () => ['# Notes', '', line(APP, '<bytes>', '<sha256>'), line(GENERATOR, '<bytes>', '<sha256>'), ''].join('\n');

const render = (ws, extra = []) =>
  spawnSync(
    process.execPath,
    [script, '--notes', ws.notes, '--dir', ws.artifacts, '--sums', ws.sums, '--out', ws.out, ...extra],
    { encoding: 'utf8' },
  );

describe('version parameterisation', () => {
  it('expects the installer names of --version, not of the manifest default', () => {
    const ws = workspace();
    fs.writeFileSync(ws.notes, template());
    const result = render(ws, ['--version', '9.9.9']);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('Sauda-Retail-Suite-Setup-9.9.9.exe');
  });
});

describe('rendering a template with placeholders', () => {
  it('fills the measured size and hash of both installers, app first', () => {
    const ws = workspace();
    fs.writeFileSync(ws.notes, template());
    const result = render(ws);
    expect(result.status).toBe(0);

    const text = fs.readFileSync(ws.out, 'utf8');
    expect(text).toContain(line(APP, 4096, ws.appSha));
    expect(text).toContain(line(GENERATOR, 2048, ws.generatorSha));
    expect(text).not.toMatch(/<(bytes|sha256)>/);
  });

  it('refuses an odd number of placeholders', () => {
    const ws = workspace();
    fs.writeFileSync(ws.notes, `- ${APP} — <bytes> B\n- <sha256>\n- leftover <bytes>\n`);
    const result = render(ws);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/expected either 4 build placeholders/);
  });
});

describe('rendering already-finalised notes', () => {
  it('accepts values that match the files', () => {
    const ws = workspace();
    fs.writeFileSync(
      ws.notes,
      [line(APP, 4096, ws.appSha), line(GENERATOR, 2048, ws.generatorSha), ''].join('\n'),
    );
    const result = render(ws);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(ws.out, 'utf8')).toContain(ws.appSha);
  });

  it('refuses a stale hash — a rebuilt installer must not ship under an old number', () => {
    const ws = workspace();
    fs.writeFileSync(
      ws.notes,
      [line(APP, 4096, '0'.repeat(64)), line(GENERATOR, 2048, ws.generatorSha), ''].join('\n'),
    );
    const result = render(ws);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/do not contain the measured SHA-256/);
  });

  it('refuses a stale size', () => {
    const ws = workspace();
    fs.writeFileSync(
      ws.notes,
      [line(APP, 123, ws.appSha), line(GENERATOR, 2048, ws.generatorSha), ''].join('\n'),
    );
    const result = render(ws);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/do not contain the measured size/);
  });
});

describe('missing build output is never papered over', () => {
  it('fails when an installer is absent', () => {
    const ws = workspace();
    fs.writeFileSync(ws.notes, template());
    fs.rmSync(ws.generatorPath);
    const result = render(ws);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/installer missing/);
  });

  it('fails when the checksum file has no entry for an installer', () => {
    const ws = workspace();
    fs.writeFileSync(ws.notes, template());
    fs.writeFileSync(ws.sums, `${ws.appSha}  ${APP}\n`);
    const result = render(ws);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no SHA-256 for/);
  });

  it('fails when the checksum file is missing entirely', () => {
    const ws = workspace();
    fs.writeFileSync(ws.notes, template());
    fs.rmSync(ws.sums);
    const result = render(ws);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/does not exist/);
  });
});
