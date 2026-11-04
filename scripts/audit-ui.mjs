/**
 * Static UI wiring audit — catches the class of bugs that only show up when a
 * screen is opened: an icon that does not exist, a CSS class that was renamed,
 * or a renderer call with no matching IPC route.
 *
 * This is NOT a substitute for running the app; it proves the wiring, not the
 * pixels (see docs/FINAL_QA_CHECKLIST.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'packages', 'app', 'src');
const problems = [];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(tsx?|css)$/.test(entry.name) ? [full] : [];
  });
}

const files = walk(srcDir);
const read = (file) => fs.readFileSync(file, 'utf8');

/* 1. icon names ---------------------------------------------------------- */
const iconsSource = read(path.join(srcDir, 'icons.tsx'));
const iconBlock = iconsSource.slice(iconsSource.indexOf('const PATHS'), iconsSource.indexOf('export'));
const definedIcons = new Set([...iconBlock.matchAll(/^\s{2}([a-zA-Z0-9_-]+):/gm)].map((m) => m[1]));
const usedIcons = new Set();
for (const file of files.filter((f) => f.endsWith('.tsx'))) {
  const source = read(file);
  for (const m of source.matchAll(/<Icon\s+name="([a-zA-Z0-9_-]+)"/g)) usedIcons.add(m[1]);
  for (const m of source.matchAll(/\sicon="([a-zA-Z0-9_-]+)"/g)) usedIcons.add(m[1]);
}
for (const icon of usedIcons) {
  if (!definedIcons.has(icon)) problems.push(`icon "${icon}" is used but not defined in icons.tsx`);
}

/* 2. CSS classes --------------------------------------------------------- */
// Every stylesheet shipped to the renderer participates (theme.css is the
// baseline; design-v110.css layers the v1.1 design system on top of it).
const styleFiles = fs
  .readdirSync(srcDir)
  .filter((f) => f.endsWith('.css'))
  .sort();
const theme = styleFiles.map((f) => read(path.join(srcDir, f))).join('\n');
const themeClasses = new Set([...theme.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((m) => m[1]));
// classes that are intentionally data-only / provided by inline styles
const CLASS_ALLOWLIST = new Set(['span-1', 'null', 'undefined', 'low', 'high', 'ok', 'active']);
const usedClasses = new Set();
for (const file of files.filter((f) => f.endsWith('.tsx'))) {
  const source = read(file);
  for (const m of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const text = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, ' ');
    for (const token of text.split(/\s+/)) {
      if (/^[a-z][a-z0-9-]*$/.test(token)) usedClasses.add(token);
    }
  }
}
for (const cls of usedClasses) {
  if (!themeClasses.has(cls) && !CLASS_ALLOWLIST.has(cls)) {
    problems.push(`CSS class ".${cls}" is used but has no rule in theme.css`);
  }
}

/* 3. renderer → IPC routes ---------------------------------------------- */
const ipcSource = read(path.join(root, 'packages', 'app', 'electron', 'ipc.ts'));
const routes = new Set([...ipcSource.matchAll(/\bon\(\s*'([a-zA-Z0-9._]+)'/g)].map((m) => m[1]));
const called = new Set();
for (const file of files.filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))) {
  const source = read(file);
  for (const m of source.matchAll(/call(?:<[^>]*>)?\(\s*'([a-zA-Z0-9._]+)'/g)) called.add(m[1]);
  // template-literal routes, e.g. `reports.export${kind}`
  for (const m of source.matchAll(/call(?:<[^>]*>)?\(\s*`([a-zA-Z0-9._]*)\$\{[^}]+\}`/g)) {
    const prefix = m[1];
    const matches = [...routes].filter((route) => route.startsWith(prefix));
    if (!matches.length) problems.push(`no IPC route matches dynamic call "${prefix}*"`);
  }
}
for (const route of called) {
  if (!routes.has(route)) problems.push(`renderer calls "${route}" but ipc.ts has no such route`);
}

/* 4. pages referenced by the shell -------------------------------------- */
const appSource = read(path.join(srcDir, 'App.tsx'));
const pageFiles = fs
  .readdirSync(path.join(srcDir, 'pages'))
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => f.replace(/\.tsx$/, ''));
for (const page of pageFiles) {
  const imported = new RegExp(`from '\\./pages/${page}\\.js'`).test(appSource);
  if (!imported) problems.push(`page ${page}.tsx is never imported by App.tsx`);
}

console.log(
  `[audit-ui] ${files.length} renderer files · ${definedIcons.size} icons · ${themeClasses.size} css classes · ${routes.size} ipc routes · ${called.size} call sites`,
);

if (problems.length) {
  for (const problem of problems) console.error(`✖ ${problem}`);
  console.error(`\n[audit-ui] ${problems.length} wiring problem(s)`);
  process.exit(1);
}
console.log('[audit-ui] wiring is consistent');
