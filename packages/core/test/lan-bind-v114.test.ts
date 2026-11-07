/**
 * Milestone D — the legacy shop-token tunnel can no longer listen on the network by
 * default. These tests pin the binding itself, because a regression here would
 * silently re-expose the v1.1.3 plaintext surface.
 */
import { describe, expect, it } from 'vitest';
import { startRpcHost, type RpcHost } from '../src/net/rpc.js';

const TOKEN = 'd'.repeat(64);
const hosts: RpcHost[] = [];

async function host(bindHost?: string, allowPlaintextLan = true): Promise<RpcHost> {
  const started = await startRpcHost({
    port: 0,
    host: bindHost,
    allowPlaintextLan,
    token: TOKEN,
    version: '1.1.4',
    businessName: () => 'টেস্ট',
    authenticate: async (username) => ({ id: 1, username, full_name: 'মালিক', role: 'admin', permissions: [] }),
    invoke: async () => ({ ok: true, data: 'x' }),
    allowRemote: () => true,
  });
  hosts.push(started);
  return started;
}

describe('legacy listener binding', () => {
  it('binds loopback only when asked to', async () => {
    const server = await host('127.0.0.1');
    expect(server.bound_host).toBe('127.0.0.1');
    expect(server.protocol).toBe('http');
    await server.stop();
  });

  it('can still bind all interfaces when the deprecated mode is enabled', async () => {
    const server = await host('0.0.0.0');
    expect(['0.0.0.0', '::']).toContain(server.bound_host);
    await server.stop();
  });

  // SEC-01 (v1.2.0): the historical default bound 0.0.0.0 without TLS. That default was the defect —
  // it turned a missing argument into an open, plaintext listener. The default now refuses, and the
  // deprecated LAN mode has to ask for it explicitly.
  it('refuses the old default: no host and no TLS is not a network listener any more', async () => {
    await expect(host(undefined, false)).rejects.toThrow(/TLS ছাড়া নেটওয়ার্ক-সার্ভার/);
  });

  it('still allows the deprecated LAN bind when it is asked for explicitly', async () => {
    const server = await host(undefined, true);
    expect(['0.0.0.0', '::']).toContain(server.bound_host);
    await server.stop();
  });
});
