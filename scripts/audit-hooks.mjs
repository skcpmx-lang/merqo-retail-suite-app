/**
 * Hooks audit — the renderer is not allowed to silence `react-hooks/exhaustive-deps`.
 *
 * v1.1.5 (A-10) removed the last of 31 such suppressions: every one was a `load()` defined in the
 * component body and called from an effect whose dependency array listed the filters instead of the
 * function. The arrays were right by hand; nothing kept them right. Adding a filter to a query
 * without adding it to the array would simply not reload — a silent wrong list, which for a shop
 * means "the sale is not in the list" or "the customer's due is missing".
 *
 * The correct shape is the one now used everywhere: `useCallback` over the real inputs, then an
 * effect that depends on the callback. This check keeps it that way:
 *
 *   1. no `eslint-disable` for `react-hooks` anywhere in either renderer (Main App and the License
 *      Generator — parity is a release rule, not a Main-App-only one);
 *   2. every `useEffect` / `useLayoutEffect` call site has an explicit dependency array, so a loader
 *      cannot silently run on every render;
 *   3. the only two files allowed to read a callback through a ref (where re-subscribing would be
 *      wrong) are named here, so a new one has to be argued for rather than copied in.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = [
  path.join(root, 'packages', 'app', 'src'),
  path.join(root, 'packages', 'license-generator', 'renderer-src'),
];

/** Files that deliberately hold the latest callback in a ref (documented at the call site). */
const REF_CALLBACK_ALLOWED = new Set([
  'packages/app/src/lib/use-shop-refresh.ts',
  'packages/app/src/pages/POS.tsx',
]);

const problems = [];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(tsx?)$/.test(entry.name) ? [full] : [];
  });
}

const rel = (f) => path.relative(root, f).split(path.sep).join('/');
const files = roots.filter((d) => fs.existsSync(d)).flatMap(walk);

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const name = rel(file);

  for (const m of source.matchAll(/eslint-disable[^\n]*?(react-hooks\/[a-z-]+)?/g)) {
    const line = source.slice(0, m.index).split('\n').length;
    if (/react-hooks/.test(m[0]) || /react-hooks/.test(source.slice(m.index, m.index + 120))) {
      problems.push(`${name}:${line} suppresses a react-hooks rule — fix the dependency instead`);
    }
  }

  // Every effect must state its dependencies explicitly.
  for (const m of source.matchAll(/\b(useEffect|useLayoutEffect)\(/g)) {
    const start = m.index;
    // find the closing paren of the call
    let i = start + m[0].length;
    let depth = 1;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
      i += 1;
    }
    const call = source.slice(start, i);
    const line = source.slice(0, start).split('\n').length;
    // `useEffect(() => {...}, [a, b])` and the concise `useEffect(() => setPage(1), [a])` both end
    // with `, [...]` before the closing paren.
    const closesWithDeps = /,\s*\[[^\]]*\]\s*,?\s*\)\s*;?\s*$/.test(call.trimEnd());
    if (!closesWithDeps) {
      problems.push(`${name}:${line} ${m[1]} has no explicit dependency array`);
    }
  }

  if (/latest\.current|keyHandler\.current|\.current = (e|refresh|onKey)/.test(source) && !REF_CALLBACK_ALLOWED.has(name)) {
    problems.push(
      `${name} keeps a callback in a ref; if that is intentional add the file to REF_CALLBACK_ALLOWED in scripts/audit-hooks.mjs`,
    );
  }
}

if (problems.length) {
  for (const p of problems) console.error(`✖ ${p}`);
  console.error(`✖ hooks audit failed (${problems.length} problem(s))`);
  process.exit(1);
}

console.log(`hooks audit: ${files.length} renderer files · no suppressed react-hooks rules · every effect declares its dependencies ✔`);
