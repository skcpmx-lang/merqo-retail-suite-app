/**
 * Main Server vs Client role decisions (v1.1.4 Phase 3, finding D-11).
 *
 * These rules are pure functions so they can be tested without Electron. They answer
 * three questions the app must never get wrong:
 *
 *  1. Which routes run **on this machine** and which are forwarded to the Main PC?
 *  2. Is a role change allowed, or would it turn a client's stale copy into shop data?
 *  3. Which database is authoritative here, and does it hold backups?
 */

export type AppMode = 'off' | 'host' | 'terminal';

/**
 * Routes that must execute on the machine the operator sits at: printing, app info,
 * LAN/server administration, the customer display, static permission metadata and the
 * machine fingerprint. Everything else is business data and belongs to the Main Server.
 *
 * `license.` is deliberately *not* local: a client has no authoritative licence, and the
 * Main PC re-checks the licence on every request it serves.
 */
export const LOCAL_ROUTE_PREFIXES = ['print.', 'app.', 'lan.', 'display.', 'meta.', 'license.fingerprint', 'terminal.'];

export function isLocalRoute(method: string): boolean {
  return LOCAL_ROUTE_PREFIXES.some((prefix) => method.startsWith(prefix));
}

export function decideRoute(mode: AppMode, method: string): 'local' | 'remote' {
  if (mode !== 'terminal') return 'local';
  if (method === 'auth.login' || method === 'auth.logout') return 'remote';
  return isLocalRoute(method) ? 'local' : 'remote';
}

export interface ModeChangeInput {
  from: AppMode;
  to: AppMode;
  /** A device credential exists on this PC (it is enrolled as a client). */
  paired: boolean;
  /** A trusted server is configured (address + pin). */
  hasActiveServer: boolean;
}

export interface ModeChange {
  allowed: boolean;
  code?: 'CLIENT_PROMOTION_BLOCKED' | 'NO_SERVER_CONFIGURED';
  message?: string;
  /** Changing roles re-opens the database in the new role. */
  requiresRestart: boolean;
}

/**
 * A mode change never copies, merges or migrates a database. It only decides which
 * database this process opens and whether business routes run locally.
 *
 * The one dangerous direction is *promoting a client to Main Server*: that PC's database
 * is a stale copy of the shop (or never was a shop at all). It is refused while a device
 * credential exists, so an operator cannot accidentally start serving yesterday's data.
 */
export function decideModeChange(input: ModeChangeInput): ModeChange {
  const { from, to, paired, hasActiveServer } = input;
  if (from === to) return { allowed: true, requiresRestart: false };
  if (to === 'host' && from === 'terminal' && paired) {
    return {
      allowed: false,
      code: 'CLIENT_PROMOTION_BLOCKED',
      message:
        'এই পিসি ক্লায়েন্ট হিসেবে যুক্ত — মূল কম্পিউটার বানানোর আগে ডিভাইস সংযোগ বিচ্ছিন্ন করুন, নাহলে পুরোনো/অসম্পূর্ণ ডেটা দোকানের হিসাব হিসেবে চালু হয়ে যাবে।',
      requiresRestart: true,
    };
  }
  if (to === 'terminal' && !hasActiveServer) {
    return {
      allowed: false,
      code: 'NO_SERVER_CONFIGURED',
      message: 'ক্লায়েন্ট মোডে যেতে আগে মূল কম্পিউটারের ঠিকানা ও সার্টিফিকেট সংরক্ষণ করুন।',
      requiresRestart: true,
    };
  }
  return { allowed: true, requiresRestart: true };
}

export interface DatabaseRole {
  role: 'main-server' | 'client' | 'none';
  /** Does this database get migrated and updated by this app? */
  migrated: boolean;
  /** Does this database hold shop data that must be backed up? */
  authoritative: boolean;
  backup: 'local' | 'not-local';
  label: string;
}

/**
 * Backup, restore and migration must never treat a client's local file as shop data.
 * The Main Server backs up locally; a client does not back up at all (the Main PC's
 * backup is the shop's backup).
 */
export function describeDatabaseRole(mode: AppMode): DatabaseRole {
  if (mode === 'terminal') {
    return {
      role: 'client',
      migrated: false,
      authoritative: false,
      backup: 'not-local',
      label: 'ক্লায়েন্ট পিসি — ব্যবসায়িক ডেটার মূল কপি মূল কম্পিউটারে',
    };
  }
  if (mode === 'host') {
    return {
      role: 'main-server',
      migrated: true,
      authoritative: true,
      backup: 'local',
      label: 'মূল কম্পিউটার — এই ডেটাবেজই দোকানের হিসাব',
    };
  }
  return {
    role: 'none',
    migrated: true,
    authoritative: true,
    backup: 'local',
    label: 'লোকাল মোড — একক কম্পিউটার',
  };
}
