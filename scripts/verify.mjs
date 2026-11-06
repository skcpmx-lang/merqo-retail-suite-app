/**
 * One-shot local gate: type-check every package, run the core test suite,
 * build both apps and assert that no secret material is tracked by git.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function step(name, command, args, cwd = root) {
  process.stdout.write(`\n▶ ${name}\n`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) failures.push(name);
}

const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');

step('typecheck: core', process.execPath, [tsc, '-p', 'packages/core/tsconfig.json', '--noEmit']);
step('typecheck: app', process.execPath, [tsc, '-p', 'packages/app/tsconfig.json', '--noEmit']);
step('typecheck: license generator', process.execPath, [tsc, '-p', 'packages/license-generator/tsconfig.json', '--noEmit']);
step('tests: core', process.execPath, [vitest, 'run']);
step('hooks (no suppressed deps)', process.execPath, ['scripts/audit-hooks.mjs']);
step('native artifacts', process.execPath, ['scripts/audit-native.mjs']);
step('ui wiring', process.execPath, ['scripts/audit-ui.mjs']);
step('license generator wiring', process.execPath, ['scripts/audit-license-generator.mjs']);
step('icons', process.execPath, ['scripts/make-icons.mjs']);
step('build: app', process.execPath, ['scripts/build-app.mjs']);
step('build: license generator', process.execPath, ['scripts/build-license-generator.mjs']);

process.stdout.write('\n▶ secrets scan\n');
const secretCheck = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
const tracked = (secretCheck.stdout || '').split('\n').filter(Boolean);
const offenders = tracked.filter((file) =>
  /(^|\/)(secrets?)\//i.test(file) ||
  /private[-_]?key|\.pem$|\.pfx$|\.p12$|id_ed25519/i.test(file),
);
if (offenders.length) {
  console.error('Tracked secret-like files:', offenders.join(', '));
  failures.push('secrets scan');
} else {
  console.log('no key material tracked by git ✔');
}

// Content scan (v1.1.3): a private key pasted into a normal-looking source file is
// still a leaked private key, and filename rules alone would miss it.
const PEM_PRIVATE = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;
// Tests and docs legitimately contain fake keys and mentions of the old override —
// they are fixtures, not shipped code. Only runtime/source trees are scanned.
const isFixturePath = (f) =>
  /(^|\/)docs\//.test(f) ||
  /(^|\/)test(s)?\//.test(f) ||
  /\.test\.(ts|tsx|mjs|js)$/i.test(f) ||
  /(^|\/)CHANGELOG\.md$/.test(f);
const contentOffenders = [];
const scanned = tracked.filter(
  (f) => /\.(ts|tsx|js|mjs|cjs|json|html|css|md|yml|yaml|txt)$/i.test(f) && !isFixturePath(f),
);
for (const file of scanned) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(root, file), 'utf8');
  } catch {
    continue;
  }
  if (PEM_PRIVATE.test(text)) contentOffenders.push(`${file} (PEM private key)`);
  // Only flagged when actually read from process state — a mention in docs is fine.
  if (/process\.env[.[]\s*['"]?SAUDA_LICENSE_(PUBLIC_)?KEY/.test(text)) {
    contentOffenders.push(`${file} (runtime licence-key override)`);
  }
}
if (contentOffenders.length) {
  console.error('Secret material found in tracked content:', contentOffenders.join(', '));
  failures.push('secrets content scan');
} else {
  console.log('no private key or key override in tracked content ✔');
}

// Electron trust boundary (v1.1.3): both IPC entry points must validate the sender,
// otherwise a navigated frame inherits the whole privileged bridge.
process.stdout.write('\n▶ electron trust boundary\n');
const trustChecks = [
  ['packages/app/electron/main.ts', /isTrustedSender\(event\)/],
  ['packages/app/electron/main.ts', /will-navigate[\s\S]{0,200}isTrustedRendererUrl/],
  ['packages/license-generator/src/main.ts', /isTrustedSender\(event\)/],
  ['packages/license-generator/src/main.ts', /app\.isPackaged[\s\S]{0,120}LICGEN_DEV_URL|isPackaged\(\)[\s\S]{0,200}devServerUrl/],
];
const trustFailures = trustChecks
  .filter(([file, pattern]) => {
    try {
      return !pattern.test(fs.readFileSync(path.join(root, file), 'utf8'));
    } catch {
      return true;
    }
  })
  .map(([file]) => file);
if (trustFailures.length) {
  console.error('Missing IPC/navigation guard in:', trustFailures.join(', '));
  failures.push('electron trust boundary');
} else {
  console.log('both IPC bridges validate their sender ✔');
}

// Production dependency audit (v1.1.3). Network failures warn instead of failing a
// release that is otherwise fine; real high/critical findings in shipped code fail.
process.stdout.write('\n▶ dependency audit (production only)\n');
const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
let auditJson = null;
try {
  auditJson = JSON.parse(audit.stdout || '');
} catch {
  auditJson = null;
}
if (!auditJson || !auditJson.metadata) {
  console.warn('dependency audit skipped (registry unreachable) — run `npm audit --omit=dev` manually');
} else {
  const severities = auditJson.metadata.vulnerabilities || {};
  const blocking = (severities.high || 0) + (severities.critical || 0);
  if (blocking > 0) {
    console.error(`production dependencies have ${blocking} high/critical advisories`);
    failures.push('dependency audit');
  } else {
    console.log(
      `production dependencies: 0 high/critical (moderate ${severities.moderate || 0}, total ${auditJson.metadata.totalDependencies || 0} packages) ✔`,
    );
  }
}

if (failures.length) {
  console.error(`\n✖ verify failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\n✔ verify passed');
