/**
 * Optional Authenticode signing for the Windows release build.
 *
 * RELEASE POLICY (v1.1.4): the owner accepts **unsigned** installers. Code signing is therefore
 * optional — it is used when the build host happens to have a certificate, and reported honestly
 * when it does not. It is never a requirement, never a secret the release depends on, and never a
 * reason to hold a release back.
 *
 * Supported (optional) methods:
 *  - `pfx`   : CSC_LINK + CSC_KEY_PASSWORD            (electron-builder signs the NSIS output)
 *  - `token` : WINDOWS_CODE_SIGNING_SUBJECT           (hardware token in the Windows cert store)
 *  - `cloud` : AZURE_TRUSTED_SIGNING_ENDPOINT/ACCOUNT/PROFILE
 *
 * The licence-signing key that protects Sauda's own licences is a completely different thing and
 * is never part of this: it belongs to the licence-issuing step only.
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
    // The provider's plugin performs the signing; we only detect the configuration here.
    return { mode: 'cloud', configured: true, problems: [], builderArgs: [] };
  }

  return failure(null, [
    'no Authenticode signing configuration — the installer will be unsigned (accepted by owner)',
  ]);
}

function failure(mode, problems) {
  return { mode, configured: false, problems, builderArgs: [] };
}

/** Human-readable summary for build logs — never prints a secret, only which mode is active. */
export function describeSigning(config) {
  if (!config.configured) return 'unsigned (accepted by owner)';
  if (config.mode === 'pfx') return 'pfx (CSC_LINK)';
  if (config.mode === 'token') return 'hardware token (certificateSubjectName)';
  return 'cloud signing (provider plugin)';
}
