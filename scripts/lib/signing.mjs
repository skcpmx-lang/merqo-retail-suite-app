/**
 * Authenticode signing configuration for the release build (D-1).
 *
 * A release build fails closed: if no signing method is configured, packaging stops before
 * electron-builder runs, so an unsigned installer cannot be produced, let alone uploaded or
 * published. This module is pure (it only reads an environment object) so the failure cases are
 * unit-tested without Windows or a certificate.
 *
 * Supported methods (see docs/V1.1.4_WINDOWS_BUILD_SIGNING_HANDOFF.md §3):
 *  - `pfx`   : CSC_LINK + CSC_KEY_PASSWORD            (electron-builder signs the NSIS output)
 *  - `token` : WINDOWS_CODE_SIGNING_SUBJECT           (hardware token in the Windows cert store)
 *  - `cloud` : AZURE_TRUSTED_SIGNING_ENDPOINT/ACCOUNT/PROFILE
 *              (signed by the provider plugin; scripts/verify-installer.mjs still enforces
 *               Status: Valid, so a mis-configured cloud step cannot pass unnoticed)
 *
 * The licence-signing key is never part of this: it belongs to the licence-issuing step only.
 */

export const SIGNING_MODES = Object.freeze(['pfx', 'token', 'cloud']);

const envValue = (env, key) => (typeof env?.[key] === 'string' ? env[key].trim() : '');

/** Reads the environment and reports whether a signing method is configured, and which. */
export function signingConfig(env = {}) {
  const cscLink = envValue(env, 'CSC_LINK');
  const cscPassword = envValue(env, 'CSC_KEY_PASSWORD');
  const subject = envValue(env, 'WINDOWS_CODE_SIGNING_SUBJECT');
  const azure = {
    AZURE_TRUSTED_SIGNING_ENDPOINT: envValue(env, 'AZURE_TRUSTED_SIGNING_ENDPOINT'),
    AZURE_TRUSTED_SIGNING_ACCOUNT: envValue(env, 'AZURE_TRUSTED_SIGNING_ACCOUNT'),
    AZURE_TRUSTED_SIGNING_PROFILE: envValue(env, 'AZURE_TRUSTED_SIGNING_PROFILE'),
  };

  // A half-configured method is an error, not a reason to fall through to another one: the
  // operator asked for PFX and forgot the password, and must be told that plainly.
  if (cscLink || cscPassword) {
    if (!cscLink) {
      return failure('pfx', ['CSC_KEY_PASSWORD is set but CSC_LINK is empty']);
    }
    if (!cscPassword) {
      return failure('pfx', ['CSC_LINK is set but CSC_KEY_PASSWORD is empty']);
    }
    return { mode: 'pfx', configured: true, problems: [], builderArgs: [] };
  }

  if (subject) {
    return {
      mode: 'token',
      configured: true,
      problems: [],
      // Hardware token: electron-builder selects the certificate by subject and signtool asks
      // for the token PIN on the build host.
      builderArgs: [`--config.win.certificateSubjectName=${subject}`],
    };
  }

  const azureKeys = Object.keys(azure);
  const azureSet = azureKeys.filter((key) => azure[key]);
  if (azureSet.length) {
    const missing = azureKeys.filter((key) => !azure[key]);
    if (missing.length) {
      return failure('cloud', [`cloud signing is incomplete — missing ${missing.join(', ')}`]);
    }
    // The provider's plugin performs the signing; our own gate still requires Status: Valid.
    return { mode: 'cloud', configured: true, problems: [], builderArgs: [] };
  }

  return failure(null, [
    'no Authenticode signing configuration found — an unsigned release is not permitted',
  ]);
}

function failure(mode, problems) {
  return { mode, configured: false, problems, builderArgs: [] };
}

const HOW_TO_FIX = [
  'Configure exactly one of:',
  '  pfx   : CSC_LINK (path or base64 .pfx) + CSC_KEY_PASSWORD',
  '  token : WINDOWS_CODE_SIGNING_SUBJECT="<exact certificate subject CN>" (token PIN at build time)',
  '  cloud : AZURE_TRUSTED_SIGNING_ENDPOINT + AZURE_TRUSTED_SIGNING_ACCOUNT + AZURE_TRUSTED_SIGNING_PROFILE',
  'The certificate must be a publicly trusted code-signing certificate (EKU 1.3.6.1.5.5.7.3.3).',
  'Never put the licence-signing private key on the build host or in these variables.',
].join('\n');

/** Throws `SIGNING_REQUIRED` when the environment cannot produce a signed installer. */
export function assertSigningConfigured(env = {}, options = {}) {
  const config = signingConfig(env);
  if (config.configured) return config;
  const label = options.label ?? 'release packaging';
  const error = new Error(
    [
      `${label} refused: no valid Authenticode signing configuration.`,
      ...config.problems,
      '',
      HOW_TO_FIX,
    ].join('\n'),
  );
  error.code = 'SIGNING_REQUIRED';
  error.problems = config.problems;
  throw error;
}

/** Human-readable summary for build logs — never prints a secret, only which mode is active. */
export function describeSigning(config) {
  if (!config.configured) return 'unsigned (refused)';
  if (config.mode === 'pfx') return 'pfx (CSC_LINK)';
  if (config.mode === 'token') return 'hardware token (certificateSubjectName)';
  return 'cloud signing (provider plugin)';
}
