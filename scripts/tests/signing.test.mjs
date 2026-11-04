/**
 * D-1 — a release build is signed or refused.
 *
 * These tests exercise the configuration reader that both packaging scripts call before
 * electron-builder runs, so "missing signing credentials" cannot silently produce an unsigned
 * installer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertSigningConfigured, describeSigning, signingConfig } from '../lib/signing.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

describe('signing configuration', () => {
  it('refuses an empty environment', () => {
    const config = signingConfig({});
    expect(config.configured).toBe(false);
    expect(config.mode).toBeNull();
    expect(config.problems.join(' ')).toMatch(/unsigned release is not permitted/i);
  });

  it('refuses a PFX path without its password', () => {
    const config = signingConfig({ CSC_LINK: 'D:\\certs\\merqo.pfx' });
    expect(config.configured).toBe(false);
    expect(config.problems.join(' ')).toMatch(/CSC_KEY_PASSWORD/);
  });

  it('refuses a password without a PFX path', () => {
    const config = signingConfig({ CSC_KEY_PASSWORD: 'secret' });
    expect(config.configured).toBe(false);
    expect(config.problems.join(' ')).toMatch(/CSC_LINK/);
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

  it('refuses an incomplete cloud-signing configuration and names what is missing', () => {
    const config = signingConfig({ AZURE_TRUSTED_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net' });
    expect(config.configured).toBe(false);
    expect(config.problems.join(' ')).toMatch(/AZURE_TRUSTED_SIGNING_ACCOUNT/);
  });

  it('throws SIGNING_REQUIRED with actionable instructions', () => {
    let error = null;
    try {
      assertSigningConfigured({}, { label: 'package-app' });
    } catch (err) {
      error = err;
    }
    expect(error).not.toBeNull();
    expect(error.code).toBe('SIGNING_REQUIRED');
    expect(error.message).toMatch(/package-app refused/);
    expect(error.message).toMatch(/CSC_LINK/);
    expect(error.message).toMatch(/licence-signing private key/i);
  });

  it('returns the configuration when signing is available', () => {
    const config = assertSigningConfigured({ WINDOWS_CODE_SIGNING_SUBJECT: 'MERQO' });
    expect(config.mode).toBe('token');
  });

  it('describes the active method without ever printing a secret', () => {
    const pfx = signingConfig({ CSC_LINK: 'D:\\certs\\merqo.pfx', CSC_KEY_PASSWORD: 'top-secret' });
    const text = describeSigning(pfx);
    expect(text).toMatch(/pfx/i);
    expect(text).not.toContain('top-secret');
    expect(describeSigning(signingConfig({}))).toMatch(/refused/i);
  });
});

describe('packaging scripts cannot build unsigned', () => {
  it('both packaging entry points call the signing guard before electron-builder', () => {
    for (const script of ['scripts/package-app.mjs', 'scripts/package-license-generator.mjs']) {
      const text = read(script);
      expect(text, `${script} must import the guard`).toMatch(/assertSigningConfigured/);
      const guardAt = text.indexOf('assertSigningConfigured(process.env');
      const builderAt = text.indexOf('spawnSync(process.execPath, args');
      expect(guardAt, `${script} must check signing`).toBeGreaterThan(-1);
      expect(builderAt, `${script} must build`).toBeGreaterThan(guardAt);
      expect(text, `${script} must pass the signing arguments`).toMatch(/signing\.builderArgs/);
    }
  });
});
