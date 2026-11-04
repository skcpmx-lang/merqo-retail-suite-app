import {
  createRpcClient,
  generateLanToken,
  lanUrls,
  startRpcHost,
  type Db,
  type RpcHost,
  type RpcUser,
  type RpcClient,
} from '@sauda/core';
import type { AppSettings } from '@sauda/core';
import { writeLog } from './paths.js';

/**
 * Thin Electron glue around the transport in `@sauda/core/net`.
 *
 * The host owns the only writable database. A terminal keeps no business data:
 * it forwards every route to the host, and the host re-checks the user's
 * permissions from its own user table.
 */

let host: RpcHost | null = null;
let client: RpcClient | null = null;
let clientKey = '';

export interface StartHostOptions {
  getDb: () => Db;
  port: number;
  token: string;
  authenticate: (username: string, password: string) => Promise<RpcUser>;
  invoke: (method: string, args: unknown[], user: RpcUser | null) => Promise<any>;
  version: string;
  businessName: () => string;
}

export async function startLanHost(opts: StartHostOptions): Promise<RpcHost> {
  if (host) return host;
  host = await startRpcHost({
    port: opts.port,
    token: opts.token,
    version: opts.version,
    businessName: opts.businessName,
    authenticate: opts.authenticate,
    invoke: opts.invoke,
    onLog: (level, message, detail) => writeLog(level, message, detail),
  });
  writeLog('info', 'lan host started', { port: host.port, urls: host.addresses });
  return host;
}

export async function stopLanHost(): Promise<void> {
  if (!host) return;
  await host.stop();
  host = null;
  writeLog('info', 'lan host stopped');
}

export function lanHostRunning(): boolean {
  return host !== null;
}

/** Terminal-side client, memoised per host+token pair. */
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

export function lanStatus(settings: AppSettings): {
  mode: AppSettings['lan_mode'];
  host_running: boolean;
  port: number | null;
  urls: string[];
  host_url: string;
  token: string;
  has_token: boolean;
} {
  return {
    mode: settings.lan_mode,
    host_running: hostRunning(),
    port: host?.port ?? null,
    urls: host ? host.addresses : [],
    host_url: settings.lan_host_url || '',
    token: settings.lan_token || '',
    has_token: Boolean(settings.lan_token),
  };
}

function hostRunning(): boolean {
  return host !== null;
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
