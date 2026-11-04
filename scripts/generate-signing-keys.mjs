/**
 * Generates a fresh Ed25519 signing key pair for licensing.
 *
 * Output (git-ignored `secrets/`):
 *   ed25519-private-b64.txt  – PKCS#8 private key (base64)  ← keep offline
 *   ed25519-public-b64.txt   – SPKI public key (base64)     ← embedded in app
 *
 * After generating, copy the public key into packages/core/src/licensing/publicKey.ts
 * (or pass it through the SAUDA_PUBLIC_KEY build env var) and rebuild.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'secrets');
const force = process.argv.includes('--force');

fs.mkdirSync(dir, { recursive: true });

const privatePath = path.join(dir, 'ed25519-private-b64.txt');
const publicPath = path.join(dir, 'ed25519-public-b64.txt');
if (!force && (fs.existsSync(privatePath) || fs.existsSync(publicPath))) {
  console.error('secrets/ already contains a key pair. Re-run with --force to replace it (all issued licenses break!).');
  process.exit(1);
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const privateB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const publicB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const keyId = crypto.createHash('sha256').update(Buffer.from(publicB64, 'base64')).digest('hex').slice(0, 16).toUpperCase();

fs.writeFileSync(privatePath, `${privateB64}\n`, { encoding: 'utf8', mode: 0o600 });
fs.writeFileSync(publicPath, `${publicB64}\n`, 'utf8');

console.log('Key pair generated.');
console.log('KEY_ID       :', keyId);
console.log('PUBLIC_KEY   :', publicB64);
console.log('private key  :', path.relative(root, privatePath), '(git-ignored — store offline, never commit)');
console.log('\nNext: update packages/core/src/licensing/publicKey.ts with the public key + key id, then rebuild.');
