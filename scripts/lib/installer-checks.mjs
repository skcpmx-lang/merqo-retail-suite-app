/**
 * Pure checks used by `scripts/verify-installer.mjs` (D-2).
 *
 * Kept free of PowerShell and the filesystem so the failure cases — wrong version, wrong
 * architecture, missing or invalid signature, missing artefact — are unit-tested on any OS.
 * The CLI does the Windows-specific work (running PowerShell, hashing, writing SHA256SUMS.txt)
 * and calls these functions to decide pass/fail.
 */

/** x64 machine type in a PE header. arm64 is 0xAA64, i386 is 0x014C. */
export const X64_MACHINE = 0x8664;

/** Reads the PE `Machine` field; returns null when the bytes are not a PE image. */
export function peMachine(bytes) {
  if (!bytes || bytes.length < 0x40) return null;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const peOffset = view[0x3c] | (view[0x3d] << 8) | (view[0x3e] << 16) | (view[0x3f] << 24);
  if (!Number.isFinite(peOffset) || peOffset <= 0 || peOffset + 6 > view.length) return null;
  if (view[peOffset] !== 0x50 || view[peOffset + 1] !== 0x45 || view[peOffset + 2] !== 0 || view[peOffset + 3] !== 0) {
    return null;
  }
  return view[peOffset + 4] | (view[peOffset + 5] << 8);
}

/** Stable label for logs and error messages (`8664`, `AA64`, `014C`, …). */
export function machineLabel(machine) {
  if (typeof machine !== 'number' || !Number.isFinite(machine)) return 'unknown';
  return machine.toString(16).toUpperCase().padStart(4, '0');
}

/** Parses the compact JSON the CLI asks PowerShell for. Returns null on anything unexpected. */
function parseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const value = JSON.parse(text.trim());
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Parses `Get-AuthenticodeSignature … | Select-Object Status,StatusMessage,SignerSubject,
 * TimestamperSubject | ConvertTo-Json -Compress`.
 */
export function parseSignatureReport(text) {
  const raw = parseJson(text);
  if (!raw) return null;
  const asString = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    status: asString(raw.Status),
    statusMessage: asString(raw.StatusMessage),
    subject: asString(raw.SignerSubject ?? raw.Subject),
    timestamper: asString(raw.TimestamperSubject ?? raw.Timestamper),
  };
}

/**
 * Parses `(Get-Item …).VersionInfo | Select-Object ProductName,ProductVersion,FileVersion,
 * CompanyName | ConvertTo-Json -Compress`.
 */
export function parseVersionReport(text) {
  const raw = parseJson(text);
  if (!raw) return null;
  const asString = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    productName: asString(raw.ProductName),
    productVersion: asString(raw.ProductVersion),
    fileVersion: asString(raw.FileVersion),
    companyName: asString(raw.CompanyName),
  };
}

/** True when a reported version is the expected release version (or a build of it, `1.1.4.1`). */
export function versionMatches(reported, expected) {
  const value = String(reported ?? '').trim();
  const want = String(expected ?? '').trim();
  if (!value || !want) return false;
  return value === want || value.startsWith(`${want}.`);
}

/** The two artefact names a v1.1.4-style release must contain, in release order. */
export function expectedArtifacts(version) {
  return [
    `Sauda-Retail-Suite-Setup-${version}.exe`,
    `Sauda-License-Generator-${version}.exe`,
  ];
}

/** Which of the expected artefacts are missing from `names` (case-insensitive). */
export function missingArtifacts(names, version) {
  const present = new Set((names ?? []).map((n) => String(n).toLowerCase()));
  return expectedArtifacts(version).filter((name) => !present.has(name.toLowerCase()));
}

/**
 * Decides whether one installer may be published.
 *
 * @param {object} input
 * @param {string} input.name            file name
 * @param {number} input.sizeBytes       file size
 * @param {number} [input.minBytes]      smallest plausible installer
 * @param {string} [input.version]       `expected` release version, e.g. 1.1.4
 * @param {ReturnType<typeof parseVersionReport>} [input.versionInfo]
 * @param {ReturnType<typeof parseSignatureReport>} [input.signature]
 * @param {number|null} [input.machine]  PE machine type
 * @param {boolean} [input.requireTimestamp=true]
 * @returns {{failures: string[], warnings: string[]}}
 */
export function evaluateInstaller(input) {
  const failures = [];
  const warnings = [];
  const {
    name = '(unnamed)',
    sizeBytes,
    minBytes = 20 * 1024 * 1024,
    version,
    versionInfo,
    signature,
    machine,
    requireTimestamp = true,
  } = input ?? {};

  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes)) {
    failures.push(`${name}: size unknown`);
  } else if (sizeBytes < minBytes) {
    failures.push(
      `${name}: suspiciously small (${(sizeBytes / (1024 * 1024)).toFixed(1)} MB, expected ≥ ${(
        minBytes /
        (1024 * 1024)
      ).toFixed(0)} MB)`,
    );
  }

  // Signature — the hard gate. Anything other than Valid blocks publication.
  if (!signature) {
    failures.push(`${name}: Authenticode status could not be read (is signtool/PowerShell available?)`);
  } else {
    if (signature.status.toLowerCase() !== 'valid') {
      failures.push(
        `${name}: Authenticode status is "${signature.status || '(empty)'}"${
          signature.statusMessage ? ` — ${signature.statusMessage}` : ''
        }, expected "Valid"`,
      );
    }
    if (!signature.subject) {
      failures.push(`${name}: signed but no signer subject was reported`);
    }
    if (!signature.timestamper) {
      (requireTimestamp ? failures : warnings).push(
        `${name}: no RFC-3161 timestamp — the signature will expire with the certificate`,
      );
    }
  }

  // Version metadata.
  if (!versionInfo) {
    failures.push(`${name}: version metadata could not be read`);
  } else {
    if (!versionMatches(versionInfo.productVersion, version)) {
      failures.push(
        `${name}: ProductVersion "${versionInfo.productVersion || '(empty)'}" does not match ${version}`,
      );
    }
    if (!versionMatches(versionInfo.fileVersion, version)) {
      failures.push(
        `${name}: FileVersion "${versionInfo.fileVersion || '(empty)'}" does not match ${version}`,
      );
    }
  }

  // Architecture.
  if (machine !== X64_MACHINE) {
    failures.push(
      `${name}: architecture is ${machineLabel(machine)} (expected 8664 = x64)${
        machine === 0xaa64 ? ' — this is an arm64 build' : ''
      }`,
    );
  }

  return { failures, warnings };
}
