import {
  approveDevice,
  capacitySummary,
  createPairingToken,
  getStoreIdentity,
  listDevices,
  rejectDevice,
  renameDevice,
  revokeDevice,
  shortFingerprint,
  type Actor,
  type DeviceStatus,
  type Db,
  type Terminal,
  type User,
} from '@sauda/core';

/**
 * Device administration logic (Phase 3, Milestone E).
 *
 * Deliberately free of Electron and of the IPC registry, so it can be tested in
 * plain Node (the registry itself imports `electron`). The IPC layer only wraps
 * these functions with the `settings.manage` permission check.
 *
 * Security rules encoded here:
 *  - only a signed-in user with `settings.manage` can decide anything;
 *  - approval is explicit and capacity is enforced by the service, not the screen;
 *  - revocation also invalidates the device's sessions (done in the service);
 *  - a pairing code is single-use, expires, and the QR payload carries the address,
 *    the code and the certificate pin only — never a shop token or a password.
 */

export interface DeviceAdminCtx {
  db: Db;
  user: User | null;
}

export function deviceActor(ctx: DeviceAdminCtx): Actor {
  if (!ctx.user) throw new Error('ডিভাইস পরিচালনা করতে আগে লগইন করুন।');
  return { id: ctx.user.id, username: ctx.user.username };
}

export function listDevicesFor(ctx: DeviceAdminCtx, status?: DeviceStatus): Terminal[] {
  return listDevices(ctx.db, status ? { status } : {});
}

export function capacityFor(ctx: DeviceAdminCtx) {
  return capacitySummary(ctx.db);
}

export function identityFor(ctx: DeviceAdminCtx) {
  const identity = getStoreIdentity(ctx.db);
  return {
    ...identity,
    short_fingerprint: identity.cert_fingerprint ? shortFingerprint(identity.cert_fingerprint) : null,
  };
}

export function approveDeviceFor(ctx: DeviceAdminCtx, deviceId: string, note?: string): Terminal {
  return approveDevice(ctx.db, String(deviceId), deviceActor(ctx), note);
}

export function rejectDeviceFor(ctx: DeviceAdminCtx, deviceId: string, note?: string): Terminal {
  return rejectDevice(ctx.db, String(deviceId), deviceActor(ctx), note);
}

export function revokeDeviceFor(ctx: DeviceAdminCtx, deviceId: string, reason: string): Terminal {
  return revokeDevice(ctx.db, String(deviceId), deviceActor(ctx), String(reason ?? ''));
}

export function renameDeviceFor(ctx: DeviceAdminCtx, deviceId: string, name: string): Terminal {
  return renameDevice(ctx.db, String(deviceId), String(name ?? ''), deviceActor(ctx));
}

export interface PairingCodeForUi {
  code: string;
  expires_at: string;
  qr_payload: string;
  server_fingerprint: string | null;
}

export function pairingCodeFor(
  ctx: DeviceAdminCtx,
  opts: { ttlMs?: number; hostUrl?: string; port?: number } = {},
): PairingCodeForUi {
  const code = createPairingToken(ctx.db, { ttlMs: opts.ttlMs, createdBy: ctx.user?.id ?? null });
  const identity = getStoreIdentity(ctx.db);
  const host = (opts.hostUrl ?? '').trim();
  const port = opts.port ?? 4747;
  return {
    code: code.code,
    expires_at: code.expires_at,
    qr_payload: JSON.stringify({
      v: 1,
      host: host || `https://localhost:${port}`,
      code: code.code,
      fingerprint: identity.cert_fingerprint ?? null,
    }),
    server_fingerprint: identity.cert_fingerprint ?? null,
  };
}
