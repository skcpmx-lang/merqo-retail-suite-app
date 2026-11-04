/**
 * Optional signing (v1.1.4 policy: unsigned installers are accepted).
 *
 * These tests pin two things: a configured certificate is detected correctly, and the *absence*
 * of one is a normal, reported state — never an error, and never a dependency of the release.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { describeSigning, signingConfig } from '../lib/signing.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

describe('signing configuration', () => {
  it('treats an empty environment as unsigned, not as an error', () => {
    const config = signingConfig({});
    expect(config.configured).toBe(false);
    expect(config.mode).toBeNull();
    expect(config.builderArgs).toEqual([]);
    expect(config.problems.join(' ')).toMatch(/unsigned.*accepted by owner/i);
  });

  it('ignores an incomplete PFX configuration instead of failing the build', () => {
    const linkOnly = signingConfig({ CSC_LINK: 'D:\\certs\\merqo.pfx' });
    expect(linkOnly.configured).toBe(false);
    expect(linkOnly.problems.join(' ')).toMatch(/CSC_KEY_PASSWORD/);
    const passwordOnly = signingConfig({ CSC_KEY_PASSWORD: 'secret' });
    expect(passwordOnly.configured).toBe(false);
    expect(passwordOnly.problems.join(' ')).toMatch(/CSC_LINK/);
  });

  it('accepts a complete PFX configuration', () => {
    const config = signingConfig({ CSC_LINK: 'D:\\certs\\merqo.pfx', CSC_KEY_PASSWORD: 'secret' });
    expect(config.configured).toBe(true);
    expect(config.mode).toBe('pfx');
    expect(config.builderArgs).toEqual([]);
  });

  it('accepts a hardware-token configuration and selects the certificate by subject', () => {
    const config = signingConfig({ WINDOWS_CODE_SIGNING_SUBJECT: 'MERQO' });
    expect(config.configured).toBe(true);
    expect(config.mode).toBe('token');
    expect(config.builderArgs).toContain('--config.win.certificateSubjectName=MERQO');
  });

  it('accepts a complete cloud-signing configuration', () => {
    const config = signingConfig({
      AZURE_TRUSTED_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net',
      AZURE_TRUSTED_SIGNING_ACCOUNT: 'merqo',
      AZURE_TRUSTED_SIGNING_PROFILE: 'merqo-release',
    });
    expect(config.configured).toBe(true);
    expect(config.mode).toBe('cloud');
  });

  it('reports an incomplete cloud configuration without blocking the build', () => {
    const config = signingConfig({ AZURE_TRUSTED_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net' });
    expect(config.configured).toBe(false);
    expect(config.problems.join(' ')).toMatch(/AZURE_TRUSTED_SIGNING_ACCOUNT/);
  });

  it('describes the active method without ever printing a secret', () => {
    const pfx = signingConfig({ CSC_LINK: 'D:\\certs\\merqo.pfx', CSC_KEY_PASSWORD: 'top-secret' });
    const text = describeSigning(pfx);
    expect(text).toMatch(/pfx/i);
    expect(text).not.toContain('top-secret');
    expect(describeSigning(signingConfig({}))).toMatch(/unsigned.*accepted/i);
  });
});

describe('packaging scripts allow unsigned builds and report them', () => {
  it('both entry points detect signing, never require it, and pass any signing args through', () => {
    for (const script of ['scripts/package-app.mjs', 'scripts/package-license-generator.mjs']) {
      const text = read(script);
      expect(text, `${script} must read the signing configuration`).toMatch(/signingConfig\(process\.env\)/);
      expect(text, `${script} must not block unsigned builds`).not.toMatch(/assertSigningConfigured/);
      expect(text, `${script} must report the mode`).toMatch(/describeSigning/);
      expect(text, `${script} must pass signing arguments when present`).toMatch(/signing\.builderArgs/);
      const detectAt = text.indexOf('signingConfig(process.env)');
      const builderAt = text.indexOf('spawnSync(process.execPath, args');
      expect(detectAt).toBeGreaterThan(-1);
      expect(builderAt).toBeGreaterThan(detectAt);
    }
  });
});
