/**
 * Milestone D — the compatibility switch for the legacy tunnel.
 *
 * Default must be loopback (not reachable from the LAN). Only an explicit
 * `SAUDA_ALLOW_LEGACY_RPC=lan` re-exposes it, and that fact is reflected in the
 * policy helpers the health snapshot and logs use.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LEGACY_RPC_MODE, legacyRpcBindHost, legacyRpcExposedToNetwork } from '../electron/lan-policy.js';

const original = process.env[LEGACY_RPC_MODE.env];

afterEach(() => {
  if (original === undefined) delete process.env[LEGACY_RPC_MODE.env];
  else process.env[LEGACY_RPC_MODE.env] = original;
});

describe('legacy RPC bind policy', () => {
  it('defaults to loopback and reports no network exposure', () => {
    delete process.env[LEGACY_RPC_MODE.env];
    expect(legacyRpcBindHost()).toBe('127.0.0.1');
    expect(legacyRpcExposedToNetwork()).toBe(false);
  });

  it('ignores any other value of the switch', () => {
    process.env[LEGACY_RPC_MODE.env] = 'yes';
    expect(legacyRpcBindHost()).toBe('127.0.0.1');
    process.env[LEGACY_RPC_MODE.env] = 'true';
    expect(legacyRpcBindHost()).toBe('127.0.0.1');
  });

  it('exposes the tunnel only for the explicit, documented opt-in', () => {
    process.env[LEGACY_RPC_MODE.env] = 'lan';
    expect(legacyRpcBindHost()).toBe('0.0.0.0');
    expect(legacyRpcExposedToNetwork()).toBe(true);
  });
});
