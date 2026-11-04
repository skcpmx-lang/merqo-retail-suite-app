/**
 * v1.1.4 — LAN configuration consistency (regression guards).
 *
 * The seeded/default LAN port is `DEFAULT_SETTINGS.lan_port` (4747) and the client transport
 * refuses anything but `https://`. Any UI copy or fallback that disagrees with that sends the
 * operator to a configuration the app then rejects — a real defect found in this audit
 * (`Settings.tsx` fell back to port 8787 when the port field was cleared, and its host-address
 * hint showed an `http://…:8787` example).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@sauda/core';

const srcDir = path.resolve(__dirname, '..', 'src');
const electronDir = path.resolve(__dirname, '..', 'electron');
const read = (dir: string, name: string) => fs.readFileSync(path.join(dir, name), 'utf8');

const settingsPage = read(srcDir, path.join('pages', 'Settings.tsx'));
const terminal = read(electronDir, 'terminal.ts');

describe('LAN configuration consistency', () => {
  it('uses the seeded default port as the fallback in the settings form', () => {
    const port = String(DEFAULT_SETTINGS.lan_port);
    expect(settingsPage).toContain(`|| ${port})`);
    // The old, wrong fallback must not come back.
    expect(settingsPage).not.toMatch(/\|\|\s*8787\b/);
  });

  it('advertises the https:// scheme in every LAN hint', () => {
    // Only the hints that actually show an example address.
    const hints = settingsPage.match(/hint="[^"]*\d+\.\d+\.\d+\.\d+[^"]*"/g) ?? [];
    expect(hints.length).toBeGreaterThan(0);
    for (const hint of hints) {
      expect(hint, hint).not.toMatch(/http:\/\//);
      expect(hint, hint).toContain('https://');
    }
  });

  it('quotes the same default port in the client-facing error message', () => {
    expect(terminal).toContain(`https://192.168.0.10:${DEFAULT_SETTINGS.lan_port}`);
  });

  it('has no other LAN port literal anywhere in the Electron main process', () => {
    const port = String(DEFAULT_SETTINGS.lan_port);
    const files = fs.readdirSync(electronDir).filter((f) => f.endsWith('.ts'));
    const offenders: string[] = [];
    for (const file of files) {
      const text = read(electronDir, file);
      // Any numeric default that looks like a LAN port must be the seeded one.
      const literals = [...text.matchAll(/(?:\?\?|\|\|)\s*(\d{4,5})\b/g)].map((m) => m[1]!);
      for (const literal of literals) {
        if (['1024', '65535', '1000', '2000', '4096', '8192'].includes(literal)) continue;
        if (literal !== port) offenders.push(`${file}: ${literal}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never advertises a plaintext address in the settings screen', () => {
    expect(settingsPage).not.toMatch(/http:\/\//);
    expect(settingsPage).not.toMatch(/8787/);
  });
});
