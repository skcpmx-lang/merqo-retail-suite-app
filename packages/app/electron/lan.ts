import { createRpcClient, generateLanToken, lanUrls, type RpcClient } from '@sauda/core';

/**
 * Thin Electron glue around the transport in `@sauda/core/net`.
 *
 * The host owns the only writable database. A terminal keeps no business data:
 * it forwards every route to the host, and the host re-checks the user's
 * permissions from its own user table.
 */

/* Host lifecycle moved to `server-runtime.ts` (v1.1.4). This module is now
   only the terminal-side client and the connection probe. */

let client: RpcClient | null = null;
let clientKey = '';

export function lanClient(hostUrl: string, token: string): RpcClient {
  const key = `${hostUrl}|${token}`;
  if (!client || clientKey !== key) {
    client = createRpcClient({ baseUrl: hostUrl, token });
    clientKey = key;
  }
  return client;
}

export function resetLanClient(): void {
  client?.clearSession();
  client = null;
  clientKey = '';
}

export async function testLanConnection(
  hostUrl: string,
  token: string,
): Promise<{ ok: boolean; error?: string; version?: string; business?: string; latency_ms?: number }> {
  const started = Date.now();
  const probe = createRpcClient({ baseUrl: hostUrl, token, timeoutMs: 6000 });
  const res = await probe.health();
  if (!res.ok) return { ok: false, error: res.error ?? 'সংযোগ ব্যর্থ' };
  const data = res.data as { version?: string; business?: string } | undefined;
  return { ok: true, version: data?.version, business: data?.business, latency_ms: Date.now() - started };
}

export { generateLanToken, lanUrls };
