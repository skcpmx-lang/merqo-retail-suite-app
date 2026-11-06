#!/usr/bin/env node
/**
 * Guard: a state change and the audit line that records it belong to one transaction.
 *
 * This is the structural half of v1.1.5 findings A-21, A-23, A-25 and A-26. Those were all the same
 * shape — write something, then write the record of it, in two statements — and they were found by
 * reading, one at a time. A rule that runs on every `npm run verify` is worth more than another
 * afternoon of reading.
 *
 * The rule: in `packages/core/src/services`, a function that both mutates data (`INSERT`/`UPDATE`/
 * `DELETE`) and writes an audit line (`audit(db, …)`) must run inside `db.transaction(...)` or
 * `.immediate()`. Nested in a caller's transaction these become savepoints, so wrapping is always
 * safe; the opposite (an unguarded audit line) is the defect.
 *
 * Functions that are *meant* to run inside a caller's transaction are listed in ALLOW below, each with
 * the reason. The list is small on purpose: if it grows, the reason has to be written down.
 *
 *   node scripts/audit-transactions.mjs          # check
 *   node scripts/audit-transactions.mjs --list   # print every mutation+audit function found
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVICES = path.join(ROOT, 'packages/core/src/services');

const ALLOW = new Map([
  [
    'devices.enrolDeviceTx',
    'the Tx half of enrolDevice: it is called only from inside the enrolment transaction, and the pair is covered by device-enrolment-v115.test.ts',
  ],
  [
    'stock-ops.markSerialsSold',
    'called from createSale inside the sale transaction, where the serial rows and the invoice must commit together',
  ],
]);

/** Brace matching from an opening `{` (or `(`) — good enough for these source files, and it fails loudly. */
function match(src, from) {
  const open = src[from];
  const close = open === '{' ? '}' : ')';
  let depth = 0;
  for (let i = from; i < src.length; i += 1) {
    if (src[i] === open) depth += 1;
    else if (src[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced ${open} at ${from}`);
}

function bodyOf(src, nameStart) {
  let k = src.indexOf('(', nameStart);
  k = match(src, k);
  let b = src.indexOf('{', k);
  // `): { a: number } {` — skip a return-type literal before the body
  const colon = src.indexOf(':', k + 1);
  if (colon !== -1 && colon < b && src.slice(colon + 1, b).trim() === '') {
    b = src.indexOf('{', match(src, b) + 1);
  }
  return [b, match(src, b)];
}

const findings = [];
const listed = [];
for (const file of fs.readdirSync(SERVICES).sort()) {
  if (!file.endsWith('.ts')) continue;
  const src = fs.readFileSync(path.join(SERVICES, file), 'utf8');
  const re = /\n(?:\/\/[^\n]*\n)*(?:export )?(?:async )?function (\w+)/g;
  for (const m of src.match(re) ?? []) {
    const name = /function (\w+)/.exec(m)[1];
    const at = src.indexOf(m);
    const [open, close] = bodyOf(src, at + m.length - name.length);
    const body = src.slice(open, close);
    const mutates = /\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b/.test(body);
    const audits = /audit\(db/.test(body);
    if (!mutates || !audits) continue;
    const wrapped = /db\.transaction\(/.test(body) || /\.immediate\(\)/.test(body);
    const id = `${file.replace(/\.ts$/, '')}.${name}`;
    listed.push(`${id}${wrapped ? ' (transactional)' : ''}`);
    if (wrapped) continue;
    if (ALLOW.has(id)) continue;
    findings.push({ id, line: src.slice(0, at).split('\n').length });
  }
}

if (process.argv.includes('--list')) {
  console.log(listed.join('\n'));
  process.exit(0);
}

if (findings.length) {
  console.error('✖ audit-trail atomicity: a change and its audit line are in separate statements');
  for (const f of findings) console.error(`  packages/core/src/services/${f.id.replace('.', '.ts:')} (line ${f.line})`);
  console.error('  Wrap the function body in db.transaction(...) — or add it to ALLOW in scripts/audit-transactions.mjs with a reason.');
  process.exit(1);
}

console.log(
  `✔ audit-trail atomicity: every service function that changes data and writes an audit line does both in one transaction (${listed.length} checked, ${ALLOW.size} documented exceptions)`,
);
