/**
 * Embedded Ed25519 PUBLIC verification key for Sauda Retail Suite.
 *
 * The matching PRIVATE key is never present in this repository. It is only used
 * by the private License Generator on the vendor's own machine (see
 * docs/04-licensing.md and the `npm run keys:generate` script).
 *
 * To rotate the key: regenerate a key pair, replace the value below, rebuild and
 * re-release the application. Existing licences signed with the old key will be
 * rejected — planned rotation must therefore be communicated to customers.
 *
 * TRUST BOUNDARY (v1.1.3)
 * -----------------------
 * This constant is the *only* production trust root. Earlier builds also accepted
 * `SAUDA_LICENSE_PUBLIC_KEY` from the environment, which meant anyone who could
 * set an environment variable (a shortcut, a wrapper script, a launcher) could
 * substitute their own key, self-sign a licence and unlock the product. That is
 * a licensing bypass for a whole shop, so the override has been removed:
 *
 *   - production always verifies with the compiled constant below;
 *   - tests and rebinding tools inject a key explicitly through
 *     `VerifyOptions.publicKeyB64` (a function argument, never process state);
 *   - a missing or malformed constant makes verification fail closed, because
 *     `ed25519PublicKeyFromBase64()` throws and `verifyLicense()` reports
 *     `signature_invalid` instead of trusting anything.
 */
export const LICENSE_PUBLIC_KEY_SPKI_B64 = 'MCowBQYDK2VwAyEAjq1F5O68Yk7770YJo2hv9gCcva/UWP2Ke4boZXCqV7U=';

export const LICENSE_KEY_ID = '931250F377908E66';

/** Environment variables that must never influence verification (guarded by tests). */
export const LICENSE_FORBIDDEN_ENV_VARS = [
  'SAUDA_LICENSE_PUBLIC_KEY',
  'SAUDA_LICENSE_KEY',
  'SAUDA_DEV_PUBLIC_KEY',
] as const;

/**
 * The trusted vendor public key used for every real activation.
 *
 * Deliberately takes no arguments and reads no process state: the same bytes are
 * returned in a developer build, a packaged build and a test run.
 */
export function resolvePublicKeyB64(): string {
  return LICENSE_PUBLIC_KEY_SPKI_B64;
}
