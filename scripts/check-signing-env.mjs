/**
 * Reports whether this build host can Authenticode-sign the installers.
 *
 *   node scripts/check-signing-env.mjs
 *
 * v1.1.4 policy: unsigned installers are accepted by the owner, so this step is informational
 * and always exits 0. It exists so the build log states plainly whether the artefacts are signed
 * or unsigned — never so that a release can be blocked for the lack of a certificate.
 */
import { describeSigning, signingConfig } from './lib/signing.mjs';

const config = signingConfig(process.env);
console.log(`[signing-status] ${describeSigning(config)}`);
if (!config.configured) {
  for (const problem of config.problems) console.log(`  · ${problem}`);
  console.log('  · Windows will show "Unknown publisher"/SmartScreen for these installers.');
  console.log('  · The absence of code signing is not a release failure (owner policy, v1.1.4).');
} else {
  console.log('  · the packaging step will sign the NSIS output automatically');
}
