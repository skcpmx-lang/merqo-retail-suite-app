import os from 'node:os';
import type { Db } from '../db/connection.js';
import { getMeta } from '../db/connection.js';
import type { AppInfo } from '../domain/types.js';

export const PRODUCT_NAME = 'Sauda Retail Suite';
export const PRODUCT_TAGLINE = 'অফলাইন রিটেইল POS ও ব্যবসা ব্যবস্থাপনা';
export const PRODUCT_VERSION = '1.0.0';
export const BRAND_COMPANY = 'MERQO';
export const BRAND_FOUNDER = 'Shohan Khan';
export const BRAND_EMAIL = 'merqoonline@gmail.com';
export const COPYRIGHT = `© ${new Date().getFullYear()} MERQO. সর্বস্বত্ব সংরক্ষিত।`;

export function appInfo(
  db: Db | null,
  extra: { dbPath?: string; dataDir?: string; logsDir?: string; versions?: { electron?: string; chrome?: string; node?: string } } = {},
): AppInfo {
  return {
    name: PRODUCT_NAME,
    version: PRODUCT_VERSION,
    build: (db ? getMeta(db, 'build_id') : null) ?? 'release',
    channel: 'stable',
    company: BRAND_COMPANY,
    founder: BRAND_FOUNDER,
    email: BRAND_EMAIL,
    copyright: COPYRIGHT,
    electron: extra.versions?.electron ?? '',
    chrome: extra.versions?.chrome ?? '',
    node: extra.versions?.node ?? process.versions.node,
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    db_version: db ? Number(db.pragma('user_version', { simple: true }) ?? 0) : 0,
    db_path: extra.dbPath ?? '',
    data_dir: extra.dataDir ?? '',
    logs_dir: extra.logsDir ?? '',
  };
}
