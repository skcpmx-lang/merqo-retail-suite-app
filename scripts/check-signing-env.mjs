/**
 * Preflight for the release job (D-1): refuse to start when no Authenticode method is configured.
 *
 *   node scripts/check-signing-env.mjs
 *
 * Prints which method is active — never the secret itself — and exits 1 with instructions when
 * nothing is configured. The packaging scripts repeat this check, so the guard survives someone
 * running a single packaging command by hand.
 */
import { describeSigning, signingConfig } from './lib/signing.mjs';

const config = signingConfig(process.env);
if (!config.configured) {
  console.error('[check-signing-env] no valid Authenticode signing configuration.');
  for (const problem of config.problems) console.error(`  ✖ ${problem}`);
  console.error('');
  console.error('Configure exactly one method on this machine:');
  console.error('  pfx   : CSC_LINK=<path or base64 .pfx>  CSC_KEY_PASSWORD=<password>');
  console.error('  token : WINDOWS_CODE_SIGNING_SUBJECT="<exact certificate subject>"');
  console.error('  cloud : AZURE_TRUSTED_SIGNING_ENDPOINT / _ACCOUNT / _PROFILE');
  console.error('');
  console.error('An unsigned release is not permitted — see docs/V1.1.4_WINDOWS_BUILD_SIGNING_HANDOFF.md §3.');
  process.exit(1);
}

console.log(`[check-signing-env] signing method: ${describeSigning(config)}`);
console.log('[check-signing-env] installers will still be rejected unless Authenticode reports Status: Valid.');
