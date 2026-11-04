import { generateLanToken, lanUrls } from '@sauda/core';

/**
 * Terminal transport — **removed** (v1.1.4 Phase 3, Milestone D).
 *
 * v1.1.3 let a Client PC forward routes to the Main PC with a shop-wide shared token
 * over plain HTTP `/rpc`. That transport is gone: it sent every shop's authority over
 * the LAN in cleartext and gave any PC that copied the token full access.
 *
 * A Client now uses `V1Terminal` (`v1-transport.ts`): pinned TLS, a per-device Ed25519
 * key, a session bound to that device, and `/api/v1/rpc`. Nothing below may
 * accidentally resurrect the old path — these functions exist only so a stale call
 * fails loudly instead of silently downgrading.
 */

export class LegacyTransportRemoved extends Error {
  code = 'LEGACY_TRANSPORT_REMOVED';
  constructor() {
    super('পুরোনো টোকেন-ভিত্তিক টার্মিনাল পরিবহন বন্ধ করা হয়েছে — /api/v1 দিয়ে পেয়ারিং করুন।');
    this.name = 'LegacyTransportRemoved';
  }
}

/** @deprecated Always throws. Use `V1Terminal` from `v1-transport.ts`. */
export function lanClient(_hostUrl: string, _token: string): never {
  throw new LegacyTransportRemoved();
}

/** @deprecated Always throws. Use `terminal.status` (`TerminalManager`). */
export function resetLanClient(): void {
  // Nothing to reset: no shared-token client exists any more. Kept as a no-op so old
  // shutdown paths stay honest and harmless.
}

/** @deprecated Always rejects. Use `terminal.status`. */
export async function testLanConnection(
  _hostUrl: string,
  _token: string,
): Promise<{ ok: boolean; error?: string; version?: string; business?: string; latency_ms?: number }> {
  throw new LegacyTransportRemoved();
}

export { generateLanToken, lanUrls };
