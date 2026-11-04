/**
 * Phase A item 7 — Electron hardenening regression guards.
 *
 * The real window behaviour needs Windows and a packaged build, so it is verified in the
 * two-PC checklist (T-rows), not here. What *can* be checked on every commit is that the
 * hardening flags are still present and that nothing reintroduces a trusted renderer,
 * a webview, or an unguarded IPC dispatcher. These are source-level assertions on purpose:
 * they fail loudly if someone "temporarily" relaxes a setting.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Assembled at runtime: this file must not itself trip the secret scan.
const KEY_PATTERN = new RegExp(['BEGIN', '(RSA |EC |OPENSSH )?', 'PRIVATE', 'KEY'].join(' '));

const electronDir = path.resolve(__dirname, '..', 'electron');
const read = (name: string) => fs.readFileSync(path.join(electronDir, name), 'utf8');

describe('BrowserWindow hardening', () => {
  const main = read('main.ts');

  it('creates every window with the same hardened preferences', () => {
    const windows = main.match(/new BrowserWindow\(/g) ?? [];
    expect(windows.length).toBeGreaterThanOrEqual(2); // main window + customer display
    const boots = main.match(/webPreferences:/g) ?? [];
    expect(boots.length).toBe(windows.length);
    const sandboxed = main.match(/sandbox: true/g) ?? [];
    expect(sandboxed.length).toBe(windows.length);
    const isolated = main.match(/contextIsolation: true/g) ?? [];
    expect(isolated.length).toBe(windows.length);
    const noNode = main.match(/nodeIntegration: false/g) ?? [];
    expect(noNode.length).toBeGreaterThanOrEqual(windows.length);
  });

  it('never enables node integration, webviews or remote content', () => {
    expect(main).not.toMatch(/nodeIntegration:\s*true/);
    expect(main).not.toMatch(/nodeIntegrationInWorker:\s*true/);
    expect(main).not.toMatch(/webviewTag:\s*true/);
    expect(main).not.toMatch(/enableRemoteModule/);
    expect(main).not.toMatch(/allowRunningInsecureContent:\s*true/);
    expect(main).not.toMatch(/webSecurity:\s*false/);
    expect(main).not.toMatch(/sandbox:\s*false/);
    expect(main).not.toMatch(/contextIsolation:\s*false/);
  });

  it('denies new windows and blocks navigation away from our renderer', () => {
    const handlers = main.match(/setWindowOpenHandler\(/g) ?? [];
    const denials = main.match(/action: 'deny'/g) ?? [];
    expect(handlers.length).toBe(denials.length);
    expect(main).toMatch(/will-navigate/);
    expect(main).toMatch(/will-attach-webview/);
  });

  it('only opens known https hosts externally', () => {
    expect(main).toMatch(/isAllowedExternalLink/);
    expect(read('main.ts')).toMatch(/parsed\.protocol !== 'https:'/);
  });
});

describe('IPC trust boundary', () => {
  const main = read('main.ts');

  it('rejects a call whose sender frame is not our renderer', () => {
    expect(main).toMatch(/function isTrustedSender/);
    expect(main).toMatch(/if \(!isTrustedSender\(event\)\)/);
    expect(main).toMatch(/UNTRUSTED_SENDER/);
    // The guard runs before any route dispatch inside the handler.
    const handler = main.slice(main.indexOf("ipcMain.handle('sauda:invoke'"));
    const guardAt = handler.indexOf('isTrustedSender(event)');
    const dispatchAt = handler.indexOf('invokeRoute(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(dispatchAt).toBeGreaterThan(guardAt);
  });

  it('rejects an empty method and normalises the argument list', () => {
    expect(main).toMatch(/typeof method !== 'string'/);
    expect(main).toMatch(/Array\.isArray\(args\) \? args : \[\]/);
  });

  it('exposes a narrow bridge, never ipcRenderer itself', () => {
    const preload = read('preload.ts');
    expect(preload).toMatch(/contextBridge\.exposeInMainWorld\('sauda'/);
    expect(preload).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer\s*\)/);
    // The renderer side has no direct Electron import at all.
    const renderer = path.resolve(__dirname, '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (/from ['"]electron['"]|require\(['"]electron['"]\)/.test(text)) offenders.push(full);
      }
    };
    walk(renderer);
    expect(offenders).toEqual([]);
  });
});

describe('renderer content policy', () => {
  it('ships a CSP that forbids remote script and eval', () => {
    const html = fs.readFileSync(path.resolve(electronDir, '..', 'index.html'), 'utf8');
    expect(html).toMatch(/Content-Security-Policy/);
    expect(html).toMatch(/default-src 'self'/);
    expect(html).toMatch(/script-src 'self'/);
    expect(html).not.toMatch(/'unsafe-eval'/);
    expect(html).not.toMatch(/script-src[^;]*\*/);
  });
});

describe('secrets in the renderer bundle sources', () => {
  it('has no licence-signing or TLS private key in the app sources', () => {
    const roots = [path.resolve(__dirname, '..', 'src'), electronDir];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|js|json|pem|key|html)$/.test(entry.name)) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (KEY_PATTERN.test(text)) offenders.push(full);
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});
