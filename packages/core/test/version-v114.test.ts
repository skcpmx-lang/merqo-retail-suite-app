/**
 * Release version consistency.
 *
 * v1.1.4 installers are named from each package manifest, while the running app reports
 * `PRODUCT_VERSION` and records it in the database on open. Those drifted once (v1.1.4 code
 * still carrying `1.1.3`), which would have shipped an installer called
 * `Sauda-Retail-Suite-Setup-1.1.3.exe` from v1.1.4 sources and written the wrong app version
 * into every shop database. This test makes that impossible.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCT_VERSION } from '../src/index.js';

const root = path.resolve(__dirname, '..', '..', '..');

function versionOf(rel: string): string {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  return (JSON.parse(text) as { version: string }).version;
}

describe('release version', () => {
  it('reports the same version in every manifest and in the app itself', () => {
    const manifests = ['package.json', 'packages/core/package.json', 'packages/app/package.json', 'packages/license-generator/package.json'];
    for (const rel of manifests) expect({ rel, version: versionOf(rel) }).toEqual({ rel, version: PRODUCT_VERSION });
  });

  it('is a plain three-part version, so the installer name and app id stay predictable', () => {
    expect(PRODUCT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is v1.1.4 or newer', () => {
    const [major, minor, patch] = PRODUCT_VERSION.split('.').map(Number) as [number, number, number];
    const atLeast = major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 4)));
    expect(atLeast).toBe(true);
  });

  it('names the installers after that version', () => {
    const app = JSON.parse(fs.readFileSync(path.join(root, 'packages/app/package.json'), 'utf8')) as {
      build?: { win?: { artifactName?: string } };
    };
    const gen = JSON.parse(fs.readFileSync(path.join(root, 'packages/license-generator/package.json'), 'utf8')) as {
      build?: { win?: { artifactName?: string } };
    };
    expect(app.build?.win?.artifactName).toBe('Sauda-Retail-Suite-Setup-${version}.${ext}');
    expect(gen.build?.win?.artifactName).toBe('Sauda-License-Generator-${version}.${ext}');
  });
});
