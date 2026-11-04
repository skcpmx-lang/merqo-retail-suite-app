#!/usr/bin/env node
/**
 * License Generator — static audit.
 *
 * The generator is a separate product with its own process boundary, so it gets
 * its own checks rather than borrowing the retail app's:
 *
 *   1. every IPC route the UI calls exists in the main process (no dead buttons);
 *   2. every registered route is reachable from the UI (no orphan handlers);
 *   3. the preload bridge exposes exactly the channel the main process listens on;
 *   4. no renderer file imports Node, Electron or the core package directly;
 *   5. no private-key material is referenced in the renderer at all;
 *   6. no CSS class is defined but unused, and none is used but undefined;
 *   7. every page module is mounted in App.tsx, and every nav entry resolves;
 *   8. UI strings contain only Bengali/Latin/digit/punctuation characters.
 *
 * Exit code 1 on any failure. Warnings do not fail the build.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = path.join(root, 'packages', 'license-generator');
const srcDir = path.join(pkg, 'src');
const uiDir = path.join(pkg, 'renderer-src');
const pagesDir = path.join(uiDir, 'pages');

const problems = [];
const warnings = [];
const fail = (msg) => problems.push(msg);

function read(file) {
  return fs.readFileSync(file, 'utf8');
}
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/* ---------- 1 & 2: routes ---------- */
const mainTs = read(path.join(srcDir, 'main.ts'));
const registered = new Set();
const duplicates = [];
for (const match of mainTs.matchAll(/^\s*'([a-z][a-zA-Z]*)\.([a-zA-Z][a-zA-Z0-9]*)':/gm)) {
  const route = `${match[1]}.${match[2]}`;
  if (registered.has(route)) duplicates.push(route);
  registered.add(route);
}
for (const dup of duplicates) fail(`duplicate IPC route registered twice: ${dup}`);

const uiFiles = walk(uiDir).filter((f) => /\.(tsx?|ts)$/.test(f));
const used = new Map(); // route -> [files]
for (const file of uiFiles) {
  const text = read(file);
  for (const match of text.matchAll(/\bcall(?:<[^>(]*>)?\(\s*'([a-z][a-zA-Z]*)\.([a-zA-Z][a-zA-Z0-9]*)'/g)) {
    const route = `${match[1]}.${match[2]}`;
    const owner = used.get(route) ?? [];
    owner.push(path.relative(root, file));
    used.set(route, owner);
  }
}
for (const [route, files] of used) {
  if (!registered.has(route)) fail(`UI calls an unregistered IPC route: ${route} (${files.join(', ')})`);
}
// Routes may legitimately be invoked indirectly: a route calling another route,
// or a page passing a literal through a union-typed variable (`kind === 'reports.pdf'`).
const dynamic = new Set([...mainTs.matchAll(/routes\['([^']+)'\]/g)].map((m) => m[1]));
const literalRoutes = new Set(
  [...tsxRouteLiterals()].map((m) => m).filter((r) => registered.has(r)),
);
function tsxRouteLiterals() {
  const found = new Set();
  for (const file of uiFiles) {
    for (const match of read(file).matchAll(/'([a-z][a-zA-Z]*\.[a-zA-Z][a-zA-Z0-9]*)'/g)) found.add(match[1]);
  }
  return found;
}
for (const route of registered) {
  if (!used.has(route) && !dynamic.has(route) && !literalRoutes.has(route) && !/^(copy|window\.)/.test(route)) {
    warnings.push(`registered but never used by the UI: ${route}`);
  }
}

/* ---------- 3: preload bridge ---------- */
const preload = read(path.join(srcDir, 'preload.ts'));
const channel = /ipcRenderer\.invoke\(\s*'([^']+)'/.exec(preload)?.[1];
const mainChannel = /ipcMain\.handle\(\s*'([^']+)'/.exec(mainTs)?.[1];
if (!channel) fail('preload.ts does not invoke any IPC channel');
if (!mainChannel) fail('main.ts does not handle any IPC channel');
if (channel && mainChannel && channel !== mainChannel) {
  fail(`preload invokes "${channel}" but main handles "${mainChannel}"`);
}
if (/\bnodeIntegration\s*:\s*true/.test(mainTs)) fail('main window enables nodeIntegration');
if (/contextIsolation\s*:\s*false/.test(mainTs)) fail('main window disables contextIsolation');

/* ---------- 4 & 5: renderer boundaries ---------- */
for (const file of uiFiles) {
  const text = read(file);
  const rel = path.relative(root, file);
  if (/from\s+'(node:|electron|fs|path|crypto|@sauda\/core)/.test(text)) {
    fail(`renderer imports a privileged module: ${rel}`);
  }
  if (/require\(\s*'(node:|electron|fs|child_process)/.test(text)) {
    fail(`renderer uses require(): ${rel}`);
  }
  // The renderer may show a public key and a key id — never the private half.
  for (const match of text.matchAll(/private[\s_-]?key/gi)) {
    const line = text.slice(0, match.index).split('\n').length;
    // `privateKeyB64` is only tolerated as an IPC payload name in api wrappers.
    if (!/privateKeyB64/.test(match[0])) fail(`private key referenced in renderer: ${rel}:${line}`);
  }
}
for (const file of [path.join(srcDir, 'preload.ts')]) {
  if (/private/i.test(read(file))) fail('preload must not expose private key material');
}

/* ---------- 6: CSS classes ---------- */
const css = walk(uiDir)
  .filter((f) => f.endsWith('.css'))
  .map(read)
  .join('\n');
const definedClasses = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const tsxText = uiFiles.map(read).join('\n');
const usedClasses = new Set();
for (const match of tsxText.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
  const raw = (match[1] ?? match[2] ?? match[3] ?? '').replace(/\$\{[^}]*\}/g, ' ');
  for (const cls of raw.split(/[\s'"`+]+/)) {
    if (/^[a-zA-Z][\w-]*$/.test(cls)) usedClasses.add(cls);
  }
}
// Classes assembled from short literals inside template expressions.
for (const match of tsxText.matchAll(/'(lgen-[\w-]+)'/g)) usedClasses.add(match[1]);
// Modifier classes (`badge ${tone}`, `size={size}`) are chosen at runtime, so a
// plain word match in the TSX is the honest test for "is this class reachable".
const reaches = (cls) => usedClasses.has(cls) || new RegExp(`\\b${cls.replace(/[-]/g, '\\-')}\\b`).test(tsxText);
const generic = new Set(['jsx', 'css']);
// Classes built as `prefix-${value}` (e.g. `span-${n}`) are reachable by construction.
const dynamicPrefixes = [...tsxText.matchAll(/([a-z][\w-]*)-\$\{/g)].map((m) => `${m[1]}-`);
for (const cls of definedClasses) {
  if (reaches(cls) || generic.has(cls)) continue;
  if (dynamicPrefixes.some((prefix) => cls.startsWith(prefix))) continue;
  if (/^(html|body|is-|has-)/.test(cls)) continue;
  warnings.push(`CSS class defined but unused: .${cls}`);
}
for (const cls of usedClasses) {
  if (!definedClasses.has(cls)) fail(`UI uses an undefined CSS class: .${cls}`);
}

/* ---------- 6b: icons ---------- */
const uiTsx = read(path.join(uiDir, 'ui.tsx'));
const iconsBlock = /const ICONS[^=\n]*=\s*\{([\s\S]*?)\n\};/.exec(uiTsx)?.[1] ?? '';
const iconKeys = new Set([...iconsBlock.matchAll(/^\s{2}([a-zA-Z][\w]*):/gm)].map((m) => m[1]));
if (iconKeys.size < 20) fail(`icon set looks incomplete (${iconKeys.size} icons parsed)`);
const iconUses = new Set();
for (const match of tsxText.matchAll(/icon=(?:"([a-zA-Z][\w]*)"|\{'([a-zA-Z][\w]*)'\})/g)) iconUses.add(match[1] ?? match[2]);
for (const match of tsxText.matchAll(/icon:\s*'([a-zA-Z][\w]*)'/g)) iconUses.add(match[1]);
for (const name of iconUses) {
  if (!iconKeys.has(name)) fail(`UI uses an icon that does not exist: "${name}"`);
}

/* ---------- 7: pages and navigation ---------- */
const pageFiles = fs
  .readdirSync(pagesDir)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => f.replace(/\.tsx$/, ''));
const appTsx = read(path.join(uiDir, 'App.tsx'));
const importedPages = new Set([...appTsx.matchAll(/from '\.\/pages\/([\w-]+)\.js'/g)].map((m) => m[1]));
for (const page of pageFiles) {
  if (!importedPages.has(page)) fail(`page not mounted in App.tsx: pages/${page}.tsx`);
}
for (const page of importedPages) {
  if (!pageFiles.includes(page)) fail(`App.tsx imports a missing page: pages/${page}.tsx`);
}
const navIds = [...appTsx.matchAll(/\{\s*id:\s*'([\w-]+)',\s*label:/g)].map((m) => m[1]);
if (navIds.length < 10) fail(`App.tsx navigation looks incomplete (${navIds.length} entries)`);
const caseIds = new Set([...appTsx.matchAll(/case '([\w-]+)':/g)].map((m) => m[1]));
for (const id of navIds) {
  if (!caseIds.has(id) && !new RegExp(`page === '${id}'`).test(appTsx)) fail(`nav entry without a page: ${id}`);
}
for (const id of caseIds) {
  if (!navIds.includes(id)) warnings.push(`page rendered but not in the navigation: ${id}`);
}

/* ---------- 8: text sanity ---------- */
const ALLOWED = /[\u0980-\u09FF\u200C\u200DA-Za-z0-9\s\-–—.,:;!?'"“”‘’()\[\]{}/\\<>*+=%&|~^$#@_।॥০-৯₹৳%°×÷→←↑↓…·•✓✕⚠️]/u;
const EMOJI_OK = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
for (const file of uiFiles) {
  const rel = path.relative(root, file);
  const text = read(file);
  text.split('\n').forEach((line, index) => {
    if (!/['"`]/.test(line)) return;
    for (const chunk of line.matchAll(/[^\x00-\x7F]+/g)) {
      const value = chunk[0];
      if (EMOJI_OK.test(value)) continue;
      for (const char of value) {
        if (EMOJI_OK.test(char)) continue;
        if (!ALLOWED.test(char)) {
          fail(`unexpected character "${char}" (U+${char.codePointAt(0).toString(16).toUpperCase()}) in ${rel}:${index + 1}`);
        }
      }
    }
  });
}

/* ---------- report ---------- */
const counts = {
  routes: registered.size,
  callSites: [...used.values()].reduce((n, v) => n + v.length, 0),
  pages: pageFiles.length,
  cssClasses: definedClasses.size,
  icons: iconKeys.size,
};
if (warnings.length) {
  console.log(`⚠  ${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`   - ${w}`);
}
if (problems.length) {
  console.error(`\n✖ License Generator audit failed (${problems.length}):`);
  for (const p of problems) console.error(`   - ${p}`);
  process.exit(1);
}
console.log(
  `✓ license-generator audit: ${counts.pages} pages · ${counts.routes} IPC routes · ${counts.callSites} call sites · ${counts.cssClasses} CSS classes · ${counts.icons} icons`,
);
