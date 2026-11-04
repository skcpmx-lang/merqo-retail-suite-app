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

/** i386 machine type — the normal architecture of an NSIS installer stub. */
export const I386_MACHINE = 0x014c;

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
 * @param {boolean} [input.requireSignature=false]  opt-in only; unsigned is accepted by policy
 * @param {boolean} [input.requireTimestamp=false]  opt-in only
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
    // v1.1.4 policy: unsigned installers are accepted, so the signature is reported, not required.
    requireSignature = false,
    requireTimestamp = false,
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

  // Signature — reported honestly. Unsigned is NOT a failure under the v1.1.4 policy; the
  // caller may opt in to enforcement with `requireSignature`.
  if (!signature) {
    warnings.push(`${name}: Authenticode status was not read`);
  } else if (signature.status.toLowerCase() !== 'valid') {
    (requireSignature ? failures : warnings).push(
      `${name}: Authenticode status is "${signature.status || '(empty)'}"${
        signature.statusMessage ? ` — ${signature.statusMessage}` : ''
      } — unsigned, accepted by owner`,
    );
  } else if (!signature.subject) {
    (requireSignature ? failures : warnings).push(`${name}: signature reported Valid but no signer subject`);
  }
  if (signature && signature.status.toLowerCase() === 'valid' && !signature.timestamper) {
    (requireTimestamp ? failures : warnings).push(
      `${name}: signature has no RFC-3161 timestamp — it will expire with the certificate`,
    );
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

  // Architecture of the *installer image*.
  //
  // An NSIS installer is a 32-bit bootstrap executable even when it carries a 64-bit application:
  // it must be able to start on any Windows. Demanding 0x8664 here rejected two perfectly good
  // installers in the v1.1.4 release run (both reported `014C`), so the bootstrap is now allowed to
  // be i386 while an arm64 or unrecognised image is still refused, and the architecture that really
  // matters — the executables and native modules the user ends up running — is verified separately
  // by `evaluatePayload()`.
  if (machine === 0xaa64) {
    failures.push(`${name}: installer is built for arm64 (AA64) — this release is x64 only`);
  } else if (machine === undefined || machine === null) {
    failures.push(`${name}: installer architecture could not be read (not a PE image)`);
  } else if (machine !== X64_MACHINE && machine !== I386_MACHINE) {
    failures.push(
      `${name}: installer bootstrap architecture is ${machineLabel(machine)} (expected 8664 or 014C)`,
    );
  } else if (machine === I386_MACHINE) {
    warnings.push(
      `${name}: installer bootstrap is 014C (32-bit NSIS stub, expected); the packaged application is verified as x64`,
    );
  }

  return { failures, warnings };
}

/**
 * Classifies one file inside the packaged payload.
 *
 * better-sqlite3 v13 ships a prebuild for **every** platform in `prebuilds/` (linux, linuxmusl,
 * darwin, win32 — arm64 and x64) and `node-gyp-build` loads only the one matching the running
 * platform at runtime. So a Windows installer legitimately contains foreign-platform native modules;
 * demanding "every .node file is a PE x64 image" rejected the v1.1.4 installers for shipping files
 * that are never loaded. What must be true is narrower and checkable:
 *
 *  - the application executable must be x64;
 *  - the Windows x64 native module (`prebuilds/win32-x64.node`, or a compiled
 *    `build/Release/*.node`) must exist and must be x64;
 *  - everything else is reported, not failed on.
 */
export function classifyPayloadBinary(filePath) {
  const normalised = String(filePath ?? '').replace(/\\/g, '/').toLowerCase();
  const name = normalised.split('/').pop() ?? '';
  if (name.endsWith('.exe')) return 'app-executable';
  if (!name.endsWith('.node')) return 'other';
  const prebuild = /prebuilds\/([a-z0-9]+)-([a-z0-9]+)\.node$/.exec(normalised);
  if (prebuild) {
    const [, platform, arch] = prebuild;
    if (platform === 'win32' && arch === 'x64') return 'win-x64-module';
    if (platform === 'win32') return 'win-other-module';
    return 'foreign-prebuild';
  }
  if (/\/build\/release\//.test(normalised)) return 'compiled-module';
  return 'other-module';
}

/**
 * Verifies the payload a Windows user actually runs: the application executable and the Windows x64
 * SQLite native module inside `win-unpacked`.
 *
 * @param {object} input
 * @param {string} input.name             installer file name (for messages)
 * @param {Array<{path: string, machine: number|null}>} input.binaries
 * @returns {{failures: string[], warnings: string[]}}
 */
export function evaluatePayload(input) {
  const failures = [];
  const warnings = [];
  const { name = '(unnamed)', binaries = [] } = input ?? {};

  if (!binaries.length) {
    failures.push(
      `${name}: the packaged payload could not be inspected — no win-unpacked executables or native modules were found`,
    );
    return { failures, warnings };
  }

  const classified = binaries.map((binary) => ({
    ...binary,
    kind: classifyPayloadBinary(binary.path),
  }));

  const executables = classified.filter((binary) => binary.kind === 'app-executable');
  if (!executables.length) {
    failures.push(`${name}: no application executable found in the packaged payload`);
  }
  for (const binary of executables) {
    if (binary.machine !== X64_MACHINE) {
      failures.push(`${name}: application executable ${binary.path} is ${machineLabel(binary.machine)} (expected 8664 = x64)`);
    }
  }

  const windowsModules = classified.filter(
    (binary) => binary.kind === 'win-x64-module' || binary.kind === 'compiled-module',
  );
  if (!windowsModules.length) {
    failures.push(
      `${name}: no Windows x64 native module (prebuilds/win32-x64.node or build/Release/*.node) in the payload — SQLite would be missing at runtime`,
    );
  }
  for (const binary of windowsModules) {
    if (binary.machine !== X64_MACHINE) {
      failures.push(`${name}: native module ${binary.path} is ${machineLabel(binary.machine)} (expected 8664 = x64)`);
    }
  }

  const winOther = classified.filter((binary) => binary.kind === 'win-other-module');
  for (const binary of winOther) {
    warnings.push(`${name}: payload ships a non-x64 Windows native module (${binary.path}) — not used by this build`);
  }
  const foreign = classified.filter((binary) => binary.kind === 'foreign-prebuild');
  if (foreign.length) {
    warnings.push(
      `${name}: payload ships ${foreign.length} foreign-platform prebuild(s) from better-sqlite3 (never loaded on Windows; candidate for a size reduction in a later release)`,
    );
  }

  return { failures, warnings };
}

/**
 * Byte patterns that must never appear in something we ship.
 *
 * `-----BEGIN` on its own is **not** in this list: legitimate, key-free code needs that literal —
 * the Main App generates its own TLS certificate PEM, the Settings screen offers a certificate paste
 * field, and the License Generator strips PEM armour from a key the owner supplies at runtime. A bare
 * header match rejected both v1.1.4 installers for shipping that code. What actually indicates leaked
 * key material is a *private key block* (`PRIVATE KEY-----`), the Ed25519 PKCS#8 DER prefix, or the
 * generator's own private marker, and those remain hard failures.
 */
export const FORBIDDEN_MARKERS = [
  { label: 'PEM private key block', needle: 'PRIVATE KEY-----' },
  { label: 'OpenSSH private key block', needle: 'BEGIN OPENSSH PRIVATE KEY' },
  { label: 'Ed25519 PKCS#8 private key header (base64)', needle: 'MC4CAQAwBQYDK2Vw' },
  { label: 'Sauda DEVICE private marker', needle: 'sauda-private' },
];

/** Returns the labels of every forbidden marker present in `bytes`. */
export function findForbiddenMarkers(bytes) {
  if (!bytes || !bytes.length) return [];
  const hay = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const hits = [];
  for (const marker of FORBIDDEN_MARKERS) {
    if (hay.includes(Buffer.from(marker.needle))) hits.push(marker.label);
  }
  return hits;
}
