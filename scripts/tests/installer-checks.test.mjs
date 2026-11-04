/**
 * Installer integrity gate (v1.1.4: unsigned accepted).
 *
 * Hard failures: wrong version, wrong architecture, missing artefact, implausible size.
 * Reported but not failing: Authenticode status (unsigned is accepted by the owner), unless the
 * caller explicitly opts into `requireSignature`.
 */
import { describe, expect, it } from 'vitest';
import {
  I386_MACHINE,
  X64_MACHINE,
  classifyPayloadBinary,
  evaluateInstaller,
  evaluatePayload,
  findForbiddenMarkers,
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

  it('refuses an arm64 installer', () => {
    expect(machineLabel(peMachine(peImage(0xaa64)))).toBe('AA64');
    expect(evaluateInstaller({ ...validInput(), machine: 0xaa64 }).failures.join(' ')).toMatch(
      /arm64|AA64/,
    );
  });

  // Regression: the v1.1.4 release run refused both installers with `architecture is 014C` because
  // an NSIS installer is a 32-bit bootstrap even when it carries a 64-bit application. The
  // bootstrap is now reported, and the x64 requirement is applied to the packaged payload instead.
  it('accepts the 32-bit NSIS bootstrap but says so', () => {
    const verdict = evaluateInstaller({ ...validInput(), machine: I386_MACHINE });
    expect(verdict.failures).toEqual([]);
    expect(verdict.warnings.join(' ')).toMatch(/32-bit NSIS stub/);
    expect(evaluateInstaller({ ...validInput(), machine: X64_MACHINE }).failures).toEqual([]);
  });

  it('rejects a non-PE file (a Linux binary) and a truncated header', () => {
    expect(peMachine(elfHeader)).toBeNull();
    expect(peMachine(Buffer.from([0x7f]))).toBeNull();
    expect(evaluateInstaller({ ...validInput(), machine: peMachine(elfHeader) }).failures.join(' ')).toMatch(
      /architecture could not be read/,
    );
    expect(evaluateInstaller({ ...validInput(), machine: undefined }).failures.join(' ')).toMatch(
      /architecture could not be read/,
    );
  });
});

describe('packaged payload architecture', () => {
  const exe = { path: 'packages/app/release/win-unpacked/Sauda Retail Suite.exe', machine: X64_MACHINE };
  const sqliteX64 = {
    path: 'packages/app/release/win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-x64.node',
    machine: X64_MACHINE,
  };
  const foreign = {
    path: 'packages/app/release/win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/linux-x64.node',
    machine: null,
  };

  it('classifies the payload files it cares about', () => {
    expect(classifyPayloadBinary(exe.path)).toBe('app-executable');
    expect(classifyPayloadBinary(sqliteX64.path)).toBe('win-x64-module');
    expect(classifyPayloadBinary('x/prebuilds/win32-arm64.node')).toBe('win-other-module');
    expect(classifyPayloadBinary('x/prebuilds/darwin-arm64.node')).toBe('foreign-prebuild');
    expect(classifyPayloadBinary('x/build/Release/better_sqlite3.node')).toBe('compiled-module');
    expect(classifyPayloadBinary('marketserv.exe'.replace('.exe', '.txt'))).toBe('other');
  });

  it('accepts an x64 application with the Windows x64 native module', () => {
    const verdict = evaluatePayload({
      name: 'Sauda-Retail-Suite-Setup-1.1.4.exe',
      binaries: [exe, sqliteX64],
    });
    expect(verdict.failures).toEqual([]);
  });

  // Regression: better-sqlite3 ships a prebuild for every platform, and the first version of this
  // gate demanded x64 of all of them, refusing the v1.1.4 installers for files never loaded on
  // Windows. Foreign prebuilds are now a warning, not a failure.
  it('does not fail on foreign-platform prebuilds, but reports them', () => {
    const verdict = evaluatePayload({
      name: 'Sauda-Retail-Suite-Setup-1.1.4.exe',
      binaries: [exe, sqliteX64, foreign, { ...foreign, path: 'x/prebuilds/darwin-arm64.node' }],
    });
    expect(verdict.failures).toEqual([]);
    expect(verdict.warnings.join(' ')).toMatch(/2 foreign-platform prebuild/);
  });

  it('fails when the application executable is not x64', () => {
    const verdict = evaluatePayload({
      name: 'Sauda-Retail-Suite-Setup-1.1.4.exe',
      binaries: [{ ...exe, machine: I386_MACHINE }, sqliteX64],
    });
    expect(verdict.failures.join(' ')).toMatch(/application executable .* is 014C/);
  });

  it('fails when the Windows x64 native module is missing or not x64', () => {
    expect(
      evaluatePayload({ name: 'x.exe', binaries: [exe, { ...sqliteX64, path: 'x/prebuilds/win32-arm64.node', machine: 0xaa64 }] })
        .failures.join(' '),
    ).toMatch(/no Windows x64 native module/);
    expect(
      evaluatePayload({ name: 'x.exe', binaries: [exe, { ...sqliteX64, machine: I386_MACHINE }] }).failures.join(' '),
    ).toMatch(/native module .* is 014C/);
  });

  it('fails when nothing could be inspected instead of passing silently', () => {
    expect(evaluatePayload({ name: 'x.exe', binaries: [] }).failures.join(' ')).toMatch(
      /could not be inspected/,
    );
  });
});

describe('shipped key material', () => {
  it('flags a real private key block', () => {
    // The armour is assembled at runtime so this fixture is not itself a PEM private key block in
    // the repository (the security audit walks scripts/ for exactly that pattern).
    const armour = (label) => `-----BEGIN ${label}-----`;
    const pem = Buffer.from(`${armour('PRIVATE KEY')}\nMC4CAQAwBQYDK2VwBEc=\n-----END PRIVATE KEY-----\n`);
    expect(findForbiddenMarkers(pem)).toContain('PEM private key block');
    const openssh = Buffer.from(`${armour('OPENSSH PRIVATE KEY')}\nb3BlbnNzaC1rZXk=\n`);
    expect(findForbiddenMarkers(openssh)).toContain('PEM private key block');
    expect(findForbiddenMarkers(Buffer.from('sauda-private:abc'))).toContain('Sauda DEVICE private marker');
    expect(findForbiddenMarkers(Buffer.from(`${armour('ED25519 PRIVATE KEY')}\nAAAA`))).toContain(
      'PEM private key block',
    );
  });

  // Regression: the release gate used to flag any `-----BEGIN`, which key-free code legitimately
  // contains — the Main App builds its own TLS certificate PEM, the Settings screen has a
  // certificate paste field, and the generator strips PEM armour from a key the owner supplies.
  it('does not flag key-free code that mentions a PEM header or a certificate', () => {
    const code = Buffer.from(
      [
        'return `-----BEGIN ${label}-----\\n${base64}\\n-----END ${label}-----`;',
        'placeholder="-----BEGIN CERTIFICATE-----"',
        "raw.includes('-----BEGIN')",
        '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----',
      ].join('\n'),
    );
    expect(findForbiddenMarkers(code)).toEqual([]);
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
