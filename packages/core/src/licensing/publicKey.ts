/**
 * Embedded Ed25519 PUBLIC verification key for Sauda Retail Suite.
 *
 * The matching PRIVATE key is never present in this repository. It is only used
 * by the private License Generator on the vendor's own machine (see
 * docs/LICENSING_ARCHITECTURE.md and the `npm run keys:generate` script).
 *
 * To rotate the key: regenerate a key pair, replace the value below, rebuild and
 * re-release the application. Existing licences signed with the old key will be
 * rejected — planned rotation must therefore be communicated to customers.
 */
export const LICENSE_PUBLIC_KEY_SPKI_B64 = 'MCowBQYDK2VwAyEAjq1F5O68Yk7770YJo2hv9gCcva/UWP2Ke4boZXCqV7U=';

export const LICENSE_KEY_ID = '931250F377908E66';

/** Build-time override (CI sets SAUDA_LICENSE_PUBLIC_KEY for private builds). */
export function resolvePublicKeyB64(): string {
  const fromEnv = typeof process !== 'undefined' ? process.env?.SAUDA_LICENSE_PUBLIC_KEY : undefined;
  return fromEnv && fromEnv.trim().length > 20 ? fromEnv.trim() : LICENSE_PUBLIC_KEY_SPKI_B64;
}
