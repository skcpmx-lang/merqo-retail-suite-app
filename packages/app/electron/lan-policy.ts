/**
 * Which interface the legacy shop-token tunnel may bind (Phase 3, Milestone D).
 *
 * v1.1.3 exposed `/rpc` on every network interface with a shared 256-bit shop token.
 * That is exactly the "a valid licence/token is enough" model the owner required to
 * retire, so from v1.1.4 the legacy listener is **loopback only** by default: the
 * renderer's IPC path keeps working on the same machine, and no other PC can reach a
 * protected operation through it.
 *
 * A temporary compatibility mode exists for shops that still run an un-migrated
 * terminal, and it has to be switched on deliberately:
 *
 *   SAUDA_ALLOW_LEGACY_RPC=lan
 *
 * It is off unless that variable is set, it is reported in the health snapshot and it
 * logs a warning on every start. It will be removed in a later milestone.
 */

export function legacyRpcBindHost(): string {
  return process.env.SAUDA_ALLOW_LEGACY_RPC === 'lan' ? '0.0.0.0' : '127.0.0.1';
}

export function legacyRpcExposedToNetwork(): boolean {
  return legacyRpcBindHost() !== '127.0.0.1';
}

export const LEGACY_RPC_MODE = {
  /** Set this to `lan` to re-expose the old tunnel (deprecated, insecure). */
  env: 'SAUDA_ALLOW_LEGACY_RPC',
  defaultHost: '127.0.0.1',
} as const;
