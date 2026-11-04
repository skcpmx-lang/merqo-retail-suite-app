/**
 * Installer integrity gate (v1.1.4: unsigned accepted).
 *
 * Hard failures: wrong version, wrong architecture, missing artefact, implausible size.
 * Reported but not failing: Authenticode status (unsigned is accepted by the owner), unless the
 * caller explicitly opts into `requireSignature`.
 */
import { describe, expect, it } from 'vitest';
import {
  X64_MACHINE,
  evaluateInstaller,
  machineLabel,
  missingArtifacts,
  parseSignatureReport,
  parseVersionReport,
  peMachine,
  versionMatches,
} from '../lib/installer-checks.mjs';

/** A minimal but structurally valid PE header for the given machine type. */
function peImage(machine) {
  const buf = Buffer.alloc(0x200);
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'binary');
  buf.writeUInt16LE(machine, 0x84);
  return buf;
}

const elfHeader = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(0x1fc)]);

const validInput = () => ({
  name: 'Sauda-Retail-Suite-Setup-1.1.4.exe',
  sizeBytes: 121_965_051,
  version: '1.1.4',
  versionInfo: { productName: 'Sauda Retail Suite', productVersion: '1.1.4', fileVersion: '1.1.4' },
  signature: { status: 'Valid', statusMessage: '', subject: 'CN=MERQO', timestamper: 'CN=DigiCert' },
  machine: X64_MACHINE,
});

describe('PE architecture', () => {
  it('reads the machine field of an x64 image', () => {
    expect(peMachine(peImage(0x8664))).toBe(0x8664);
    expect(machineLabel(peMachine(peImage(0x8664)))).toBe('8664');
  });

  it('recognises arm64 and i386 instead of accepting them', () => {
    expect(machineLabel(peMachine(peImage(0xaa64)))).toBe('AA64');
    expect(machineLabel(peMachine(peImage(0x014c)))).toBe('014C');
    expect(evaluateInstaller({ ...validInput(), machine: 0xaa64 }).failures.join(' ')).toMatch(
      /architecture is AA64 .*arm64/s,
    );
    expect(evaluateInstaller({ ...validInput(), machine: 0x014c }).failures.join(' ')).toMatch(
      /architecture is 014C/,
    );
  });

  it('rejects a non-PE file (a Linux binary) and a truncated header', () => {
    expect(peMachine(elfHeader)).toBeNull();
    expect(peMachine(Buffer.from([0x7f]))).toBeNull();
    expect(evaluateInstaller({ ...validInput(), machine: peMachine(elfHeader) }).failures.join(' ')).toMatch(
      /architecture is unknown/,
    );
  });
});

describe('Authenticode result', () => {
  it('parses the compact JSON report', () => {
    const parsed = parseSignatureReport(
      JSON.stringify({
        Status: 'Valid',
        StatusMessage: 'Signature verified.',
        SignerSubject: 'CN=MERQO, O=MERQO, C=BD',
        TimestamperSubject: 'CN=DigiCert Timestamp 2024',
      }),
    );
    expect(parsed.status).toBe('Valid');
    expect(parsed.subject).toMatch(/MERQO/);
    expect(parsed.timestamper).toMatch(/DigiCert/);
  });

  it('accepts a fully valid signature', () => {
    expect(evaluateInstaller(validInput()).failures).toEqual([]);
  });

  it('accepts an UNSIGNED installer (owner policy) and reports it', () => {
    for (const status of ['NotSigned', 'UnknownError', 'HashMismatch', 'NotTrusted']) {
      const { failures, warnings } = evaluateInstaller({
        ...validInput(),
        signature: { status, statusMessage: `simulated ${status}`, subject: '', timestamper: '' },
      });
      expect(failures, status).toEqual([]);
      expect(warnings.join(' '), status).toMatch(new RegExp(`Authenticode status is "${status}"`));
      expect(warnings.join(' '), status).toMatch(/accepted by owner/i);
    }
  });

  it('can still enforce signing when explicitly asked to (future policy switch)', () => {
    const { failures } = evaluateInstaller({
      ...validInput(),
      signature: { status: 'NotSigned' },
      requireSignature: true,
    });
    expect(failures.join(' ')).toMatch(/Authenticode status is "NotSigned"/);
  });

  it('treats an unread report as a warning, not a failure', () => {
    const { failures, warnings } = evaluateInstaller({ ...validInput(), signature: null });
    expect(failures).toEqual([]);
    expect(warnings.join(' ')).toMatch(/not read/i);
  });

  it('warns about a valid signature without a timestamp', () => {
    const noTimestamp = { ...validInput(), signature: { status: 'Valid', subject: 'CN=MERQO', timestamper: '' } };
    const result = evaluateInstaller(noTimestamp);
    expect(result.failures).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/no RFC-3161 timestamp/);
    const strict = evaluateInstaller({ ...noTimestamp, requireTimestamp: true });
    expect(strict.failures.join(' ')).toMatch(/no RFC-3161 timestamp/);
  });
});

describe('version metadata', () => {
  it('parses the compact JSON report', () => {
    const parsed = parseVersionReport(
      JSON.stringify({
        ProductName: 'Sauda Retail Suite',
        ProductVersion: '1.1.4',
        FileVersion: '1.1.4',
        CompanyName: 'MERQO',
      }),
    );
    expect(parsed.productVersion).toBe('1.1.4');
    expect(parsed.companyName).toBe('MERQO');
  });

  it('matches the expected version, including a build suffix', () => {
    expect(versionMatches('1.1.4', '1.1.4')).toBe(true);
    expect(versionMatches('1.1.4.1', '1.1.4')).toBe(true);
    expect(versionMatches('1.1.3', '1.1.4')).toBe(false);
    expect(versionMatches('1.1.40', '1.1.4')).toBe(false);
    expect(versionMatches('', '1.1.4')).toBe(false);
  });

  it('rejects a wrong ProductVersion and a wrong FileVersion', () => {
    const wrongProduct = evaluateInstaller({
      ...validInput(),
      versionInfo: { productVersion: '1.1.3', fileVersion: '1.1.4' },
    });
    expect(wrongProduct.failures.join(' ')).toMatch(/ProductVersion "1.1.3" does not match 1.1.4/);

    const wrongFile = evaluateInstaller({
      ...validInput(),
      versionInfo: { productVersion: '1.1.4', fileVersion: '1.1.3' },
    });
    expect(wrongFile.failures.join(' ')).toMatch(/FileVersion "1.1.3" does not match 1.1.4/);
  });

  it('rejects unreadable version metadata', () => {
    expect(evaluateInstaller({ ...validInput(), versionInfo: null }).failures.join(' ')).toMatch(
      /version metadata could not be read/,
    );
  });
});

describe('artefacts and size', () => {
  it('requires both installers', () => {
    const names = ['Sauda-Retail-Suite-Setup-1.1.4.exe'];
    expect(missingArtifacts(names, '1.1.4')).toEqual(['Sauda-License-Generator-1.1.4.exe']);
    expect(missingArtifacts([], '1.1.4')).toHaveLength(2);
    expect(
      missingArtifacts(
        ['sauda-retail-suite-setup-1.1.4.EXE', 'Sauda-License-Generator-1.1.4.exe'],
        '1.1.4',
      ),
    ).toEqual([]);
  });

  it('rejects a suspiciously small file and an unknown size', () => {
    expect(evaluateInstaller({ ...validInput(), sizeBytes: 1024 }).failures.join(' ')).toMatch(
      /suspiciously small/,
    );
    expect(evaluateInstaller({ ...validInput(), sizeBytes: undefined }).failures.join(' ')).toMatch(
      /size unknown/,
    );
  });

  it('collects every integrity failure instead of stopping at the first', () => {
    const { failures } = evaluateInstaller({
      name: 'Sauda-License-Generator-1.1.4.exe',
      sizeBytes: 10,
      version: '1.1.4',
      versionInfo: { productVersion: '1.1.3', fileVersion: '1.1.3' },
      signature: { status: 'NotSigned' },
      machine: 0xaa64,
    });
    // size + ProductVersion + FileVersion + architecture; the signature is reported separately.
    expect(failures.length).toBeGreaterThanOrEqual(4);
    expect(failures.join(' ')).not.toMatch(/Authenticode/);
  });
});
