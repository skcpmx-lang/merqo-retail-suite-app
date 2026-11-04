import type { Db } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import { normalizeText } from '../domain/text.js';
import type { AppSettings } from '../domain/types.js';
import { DEFAULT_SETTINGS, serializeSetting } from '../db/seed.js';
import { audit } from './audit.js';

const NULLABLE_NUMERIC = new Set([
  'default_customer_id',
  'default_payment_method_id',
  'default_unit_id',
  'default_category_id',
  'business_logo',
]);

export function getSettings(db: Db): AppSettings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const out: any = {};
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
    const raw = map.get(key);
    if (raw === undefined) {
      out[key] = def;
      continue;
    }
    if (NULLABLE_NUMERIC.has(key)) {
      if (raw === '' || raw === 'null') out[key] = null;
      else if (key === 'business_logo') out[key] = raw;
      else {
        const n = Number(raw);
        out[key] = Number.isFinite(n) ? n : null;
      }
    } else if (typeof def === 'number') {
      const n = Number(raw);
      out[key] = Number.isFinite(n) ? n : def;
    } else if (typeof def === 'string') {
      out[key] = raw;
    } else {
      out[key] = raw;
    }
  }
  return out as AppSettings;
}

export function updateSettings(
  db: Db,
  patch: Partial<AppSettings>,
  actor?: { id: number; username: string } | null,
): AppSettings {
  const current = getSettings(db);
  const next: AppSettings = { ...current, ...patch };
  validateSettings(next);
  const stmt = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const now = nowLocal();
  const run = db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      stmt.run(key, serializeSetting(value as never), now);
    }
  });
  run();
  const changed = Object.keys(patch).filter((k) => k in DEFAULT_SETTINGS);
  audit(db, {
    userId: actor?.id ?? null,
    username: actor?.username ?? 'system',
    action: 'settings.update',
    entity: 'settings',
    details: { keys: changed },
  });
  return getSettings(db);
}

export function validateSettings(s: AppSettings): void {
  const fail = (msg: string): never => {
    throw new Error(msg);
  };
  if (!normalizeText(s.business_name)) return void 0 as any; // allowed while unconfigured
  if (s.receipt_width !== 58 && s.receipt_width !== 80) fail('রিসিট প্রস্থ ৫৮ মিমি অথবা ৮০ মিমি হতে হবে।');
  if (s.receipt_font_size < 7 || s.receipt_font_size > 22) fail('রিসিট ফন্ট সাইজ ৭ থেকে ২২ এর মধ্যে হতে হবে।');
  if (!s.invoice_format.includes('{seq}')) fail('ইনভয়েস ফরম্যাটে অবশ্যই {seq} থাকতে হবে।');
  if (s.max_discount_percent_x100 < 0 || s.max_discount_percent_x100 > 10000)
    fail('সর্বোচ্চ ডিসকাউন্ট ০–১০০% এর মধ্যে হতে হবে।');
  if (s.vat_percent_x100 < 0 || s.vat_percent_x100 > 10000) fail('ভ্যাট ০–১০০% এর মধ্যে হতে হবে।');
  if (s.backup_keep_count < 1 || s.backup_keep_count > 365) fail('ব্যাকআপ রাখার সংখ্যা ১–৩৬৫ এর মধ্যে হতে হবে।');
  if (s.session_timeout_minutes < 0 || s.session_timeout_minutes > 1440)
    fail('সেশন টাইমআউট ০–১৪৪০ মিনিটের মধ্যে হতে হবে।');
  if (s.stock_alert_threshold_milli < 0) fail('স্টক অ্যালার্ট থ্রেশহোল্ড ঋণাত্মক হতে পারবে না।');
  if (!['daily', 'weekly', 'monthly', 'off'].includes(s.auto_backup_interval))
    fail('অটো ব্যাকআপ সময়সূচি সঠিক নয়।');
}

export function getSettingRaw(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSettingRaw(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, nowLocal());
}

export function isConfigured(db: Db): boolean {
  const s = getSettings(db);
  return Boolean(normalizeText(s.business_name));
}
