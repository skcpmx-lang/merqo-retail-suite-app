/**
 * Milestone D — the shared-token terminal transport must be unreachable.
 */
import { describe, expect, it } from 'vitest';
import { LegacyTransportRemoved, lanClient, testLanConnection } from '../electron/lan.js';

describe('legacy terminal transport', () => {
  it('cannot create a token client', () => {
    expect(() => lanClient('http://192.168.0.10:4747', 'x'.repeat(32))).toThrow(LegacyTransportRemoved);
  });

  it('cannot probe over a shared token', async () => {
    await expect(testLanConnection('http://192.168.0.10:4747', 'x'.repeat(32))).rejects.toBeInstanceOf(LegacyTransportRemoved);
  });
});
