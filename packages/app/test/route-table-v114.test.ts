/**
 * v1.1.4 — IPC route table invariants.
 *
 * `invokeRoute()` enforces a permission only when the route declares one, so a route registered
 * without a permission *and* without `public` is reachable by an unauthenticated caller. It also
 * stores routes in a plain object, so a second registration of the same name silently replaces the
 * first — the earlier handler becomes dead code that still looks live.
 *
 * These are source-level assertions because `ipc.ts` imports Electron and cannot be loaded in the
 * Linux test runner. They fail loudly if a new route is added without deciding its authorization,
 * or if a route name is registered twice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ipcPath = path.resolve(__dirname, '..', 'electron', 'ipc.ts');
const source = fs.readFileSync(ipcPath, 'utf8');

interface ParsedRoute {
  name: string;
  chunk: string;
  public: boolean;
  permission: string | null;
}

/** Split the module into one chunk per top-level `on(` registration. */
function parseRoutes(text: string): ParsedRoute[] {
  const lines = text.split('\n');
  const starts = lines.reduce<number[]>((acc, line, index) => {
    if (/^on\(/.test(line)) acc.push(index);
    return acc;
  }, []);
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]! : lines.length;
    const chunk = lines.slice(start, end).join('\n');
    const name = /^on\(\s*\n?\s*'([^']+)'/.exec(chunk)?.[1];
    if (!name) throw new Error(`unparseable route at line ${start + 1}`);
    const isPublic = /,\s*true\s*,?\s*\)/.test(chunk);
    const permission = /,\s*'(any|[a-z_]+\.[a-z_]+)'\s*,?\s*\)/.exec(chunk)?.[1] ?? null;
    return { name, chunk, public: isPublic, permission };
  });
}

const routes = parseRoutes(source);

/** Routes that must work before there is a logged-in user. Adding to this list is a decision. */
const PUBLIC_ALLOWLIST = [
  'setup.status',
  'setup.initialize',
  'license.state',
  'license.fingerprint',
  'license.activateKey',
  'license.activateFile',
  'license.pickFile',
  'auth.login',
  'auth.logout',
  'auth.bootstrap',
  'terminal.servers',
  'terminal.configure',
  'terminal.use',
  'terminal.remove',
  'terminal.status',
  'terminal.pair',
  'terminal.login',
  'terminal.logout',
  'terminal.forget',
];

describe('IPC route table', () => {
  it('parses the whole table', () => {
    expect(routes.length).toBeGreaterThan(250);
  });

  it('registers every route exactly once (a repeat silently kills the first handler)', () => {
    const seen = new Map<string, number>();
    for (const route of routes) seen.set(route.name, (seen.get(route.name) ?? 0) + 1);
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
    expect(duplicates).toEqual([]);
  });

  it('gives every non-public route an authorization decision', () => {
    const unguarded = routes
      .filter((route) => !route.public && route.permission === null)
      .map((route) => route.name);
    expect(unguarded).toEqual([]);
  });

  it('keeps the public surface to the documented pre-auth allowlist', () => {
    const publicNames = routes.filter((route) => route.public).map((route) => route.name).sort();
    expect(publicNames).toEqual([...PUBLIC_ALLOWLIST].sort());
  });

  it('never exposes a business-data route publicly', () => {
    const forbidden = /^(sales|customers|products|purchases|payments|expenses|reports|accounting|stock|users|settings|backup|devices)\./;
    const leaked = routes.filter((route) => route.public && forbidden.test(route.name)).map((route) => route.name);
    expect(leaked).toEqual([]);
  });

  it('validates the logo file type in the handler that actually runs', () => {
    const logo = routes.filter((route) => route.name === 'settings.pickLogo');
    expect(logo).toHaveLength(1);
    expect(logo[0]!.chunk).toMatch(/\[['"]png['"],\s*['"]jpg['"]/);
    expect(logo[0]!.permission).toBe('settings.manage');
  });
});
