import type { Db } from '../db/connection.js';
import { setMeta } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import { normalizeText } from '../domain/text.js';
import { userCount, createUser } from './auth.js';
import { ensureWalkInCustomer } from './customers.js';
import { getSettings, updateSettings } from './settings.js';
import { audit } from './audit.js';

export interface SetupStatus {
  needs_setup: boolean;
  has_users: boolean;
  has_business: boolean;
  initialized_at: string | null;
}

export function setupStatus(db: Db): SetupStatus {
  const s = getSettings(db);
  const users = userCount(db);
  return {
    needs_setup: users === 0 || !normalizeText(s.business_name),
    has_users: users > 0,
    has_business: Boolean(normalizeText(s.business_name)),
    initialized_at: db.prepare("SELECT value FROM meta WHERE key='initialized_at'").get() as any as string | null,
  };
}

export interface SetupInput {
  businessName: string;
  businessAddress?: string;
  businessPhone?: string;
  businessEmail?: string;
  adminFullName: string;
  adminUsername: string;
  adminPassword: string;
  receiptWidth?: 58 | 80;
  invoicePrefix?: string;
  currencySymbol?: string;
  /** Optional software lock — the owner can run a single-user till without it. */
  loginLockEnabled?: boolean;
  language?: 'bn' | 'en';
}

/** First-run wizard: creates the admin account and the shop profile. */
export function initializeApp(db: Db, input: SetupInput): { userId: number } {
  const businessName = normalizeText(input.businessName);
  if (!businessName) throw new Error('দোকান/প্রতিষ্ঠানের নাম দিতে হবে।');
  if (userCount(db) > 0) throw new Error('অ্যাপ্লিকেশন ইতিমধ্যে সেটআপ করা হয়েছে।');

  const run = db.transaction(() => {
    const user = createUser(db, {
      username: input.adminUsername,
      fullName: input.adminFullName,
      password: input.adminPassword,
      role: 'admin',
    });
    ensureWalkInCustomer(db);
    const settings = getSettings(db);
    const cash = db.prepare("SELECT id FROM payment_methods WHERE is_cash = 1 ORDER BY sort_order LIMIT 1").get() as
      | { id: number }
      | undefined;
    const piece = db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number } | undefined;
    updateSettings(
      db,
      {
        business_name: businessName,
        business_address: normalizeText(input.businessAddress ?? ''),
        business_phone: normalizeText(input.businessPhone ?? ''),
        business_email: normalizeText(input.businessEmail ?? ''),
        receipt_width: input.receiptWidth ?? settings.receipt_width,
        invoice_prefix: input.invoicePrefix?.trim() || settings.invoice_prefix,
        currency_symbol: input.currencySymbol || settings.currency_symbol,
        default_payment_method_id: cash?.id ?? null,
        default_unit_id: piece?.id ?? null,
        login_lock_enabled: input.loginLockEnabled === false ? 0 : 1,
        language: input.language === 'en' ? 'en' : 'bn',
      },
      { id: user.id, username: user.username },
    );
    setMeta(db, 'initialized_at', nowLocal());
    audit(db, {
      userId: user.id,
      username: user.username,
      action: 'app.initialize',
      entity: 'app',
      details: { businessName },
    });
    return { userId: user.id };
  });
  return run();
}
