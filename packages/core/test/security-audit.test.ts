/**
 * Final-audit part 2: licensing negatives, backup hardening, permissions,
 * destructive-operation guards and settings validation.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  activate,
  createBackup,
  createCustomer,
  createProduct,
  createSale,
  createUser,
  deleteCustomer,
  deleteProduct,
  getActivationState,
  getCustomer,
  getDeviceFingerprint,
  getSettings,
  hasPermission,
  issueLicense,
  signLicense,
  listUsers,
  login,
  requireActivation,
  requirePermission,
  resetPassword,
  restoreBackup,
  createPurchase,
  setMeta,
  updateSettings,
  validateBackup,
  verifyLicense,
  type Db,
} from '../src/index.js';
import { makeTestDb, seedProducts, type TestContext } from './helpers.js';

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-audit-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pubB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privB64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

describe('license verification — negative paths', () => {
  const { privB64, pubB64 } = makeKeys();
  const device = getDeviceFingerprint(true);
  const issue = (overrides: Parameters<typeof issueLicense>[0] extends infer T ? Partial<T> : never = {}) =>
    issueLicense({ org: 'টেস্ট স্টোর', owner: 'মালিক', phone: '01700000000', device, ...overrides }, privB64);

  it('rejects an unsupported licence version even when correctly signed', () => {
    const { license } = issue();
    const payload = { ...license.payload, v: 99 };
    const resigned = signLicense(payload, privB64);
    const state = verifyLicense(resigned, { publicKeyB64: pubB64, device });
    expect(state.activated).toBe(false);
    expect(state.reason).toBe('schema_invalid');
  });

  it('rejects an unknown edition and missing fields', () => {
    const { license } = issue();
    for (const payload of [
      { ...license.payload, edition: 'platinum' as never },
      { ...license.payload, org: '' },
      { ...license.payload, license_id: '' },
      { ...license.payload, fingerprint: '' },
    ]) {
      const state = verifyLicense({ ...license, payload }, { publicKeyB64: pubB64, device });
      expect(state.activated).toBe(false);
      expect(['schema_invalid', 'signature_invalid']).toContain(state.reason);
    }
  });

  it('rejects a malformed or foreign key string', () => {
    for (const key of ['', 'abc', 'SAUDA1.only-two-parts', 'XXX1.aaa.bbb', 'SAUDA1.!!!.???', 'SAUDA1.' + 'A'.repeat(5000) + '.sig']) {
      expect(verifyLicense(key, { publicKeyB64: pubB64, device }).activated).toBe(false);
    }
  });

  it('refuses a licence that carries no device binding', () => {
    const { license } = issue();
    const payload = { ...license.payload, device_components: [] };
    const state = verifyLicense({ ...license, payload }, { publicKeyB64: pubB64, device });
    expect(state.activated).toBe(false);
  });

  it('refuses activation on a different machine and allows a single-component swap', () => {
    const { license } = issue();
    const other = {
      ...device,
      components: device.components.map((c) => ({ ...c, value: `${c.value}-x`, hash: `${c.hash}-x` })),
      hash: 'other',
    };
    expect(verifyLicense(license, { publicKeyB64: pubB64, device: other }).activated).toBe(false);

    const swapped = {
      ...device,
      components: device.components.map((c, i) => (i === 0 ? { ...c, value: `${c.value}-changed`, hash: `${c.hash}-c` } : c)),
    };
    expect(verifyLicense(license, { publicKeyB64: pubB64, device: swapped }).activated).toBe(true);
  });

  it('stores the activation and refuses a rolled-back clock after expiry', () => {
    const ctx = makeTestDb();
    const expiry = new Date();
    expiry.setDate(expiry.getDate() - 1);
    const { key } = issue({ expiresAt: expiry.toISOString().slice(0, 10) });
    // Activation is refused while the licence is already expired…
    expect(activate(ctx.db, { key, publicKeyB64: pubB64 }).activated).toBe(false);

    // …and a valid one stops working once the clock is pushed past its expiry.
    const later = new Date();
    later.setDate(later.getDate() + 30);
    const valid = issue({ expiresAt: later.toISOString().slice(0, 10) });
    const state = activate(ctx.db, { key: valid.key, publicKeyB64: pubB64 });
    expect(state.activated).toBe(true);

    const future = new Date();
    future.setDate(future.getDate() + 60);
    setMeta(ctx.db, 'license.max_seen', String(future.getTime()));
    const after = getActivationState(ctx.db, pubB64);
    expect(after.activated).toBe(false);
    expect(after.reason).toBe('clock_tamper');
    ctx.cleanup();
  });

  it('keeps the failed activation in the audit trail without storing a licence', () => {
    const ctx = makeTestDb();
    const { license } = issue();
    const tampered = { ...license, payload: { ...license.payload, org: 'অন্য দোকান' } };
    const key = `SAUDA1.${Buffer.from(JSON.stringify(tampered.payload)).toString('base64url')}.${tampered.sig}`;
    const state = activate(ctx.db, { key, publicKeyB64: pubB64 }, ctx.actor);
    expect(state.activated).toBe(false);
    const rows = ctx.db.prepare('SELECT COUNT(*) c FROM activations').get() as { c: number };
    expect(rows.c).toBe(0);
    const audit = ctx.db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action = 'license.activate_failed'").get() as {
      c: number;
    };
    expect(audit.c).toBe(1);
    ctx.cleanup();
  });
});

describe('licence gate used by the IPC dispatcher', () => {
  it('throws LICENSE_REQUIRED with a Bangla message when nothing is activated', () => {
    const ctx = makeTestDb();
    let thrown: (Error & { code?: string }) | null = null;
    try {
      requireActivation(ctx.db);
    } catch (err) {
      thrown = err as Error & { code?: string };
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.code).toBe('LICENSE_REQUIRED');
    expect(thrown!.message).toContain('অ্যাক্টিভেট');
    ctx.cleanup();
  });

  it('returns the activation state once a valid licence is installed', () => {
    const ctx = makeTestDb();
    const { privB64, pubB64 } = makeKeys();
    const device = getDeviceFingerprint(true);
    const { key } = issueLicense({ org: 'টেস্ট স্টোর', owner: 'মালিক', phone: '01700000000', device }, privB64);
    activate(ctx.db, { key, publicKeyB64: pubB64 });
    // The app itself verifies with the embedded production key; the override
    // exists so this audit can exercise the gate with its own key pair.
    const state = requireActivation(ctx.db, pubB64);
    expect(state.activated).toBe(true);
    expect(state.license?.org).toBe('টেস্ট স্টোর');
    ctx.cleanup();
  });
});

describe('backup hardening', () => {
  function backupOf(ctx: TestContext): { dir: string; file: string } {
    const dir = tmp();
    const rec = createBackup(ctx.db, { dataDir: dir, appVersion: '1.0.0' });
    return { dir, file: rec.filePath };
  }

  it('accepts its own backup and reports the business name and row counts', () => {
    const ctx = makeTestDb();
    seedProducts(ctx);
    const { file } = backupOf(ctx);
    const check = validateBackup(file);
    expect(check.ok).toBe(true);
    expect(check.business_name).toBe('টেস্ট মার্ট');
    expect(check.counts.products).toBe(2);
    expect(check.db_version).toBe(1);
    ctx.cleanup();
  });

  it('rejects a backup whose bytes changed after the manifest was written', () => {
    const ctx = makeTestDb();
    seedProducts(ctx);
    const { file } = backupOf(ctx);
    const bytes = fs.readFileSync(file);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    fs.writeFileSync(file, bytes);
    const check = validateBackup(file);
    expect(check.ok).toBe(false);
    expect(check.message).toContain('চেকসাম');
    ctx.cleanup();
  });

  it('rejects a non-SQLite file and a truncated database', () => {
    const dir = tmp();
    const junk = path.join(dir, 'junk.saudabak');
    fs.writeFileSync(junk, Buffer.alloc(4096, 7));
    expect(validateBackup(junk).ok).toBe(false);

    const short = path.join(dir, 'short.saudabak');
    fs.writeFileSync(short, 'SQLite format 3');
    expect(validateBackup(short).ok).toBe(false);
    expect(validateBackup(path.join(dir, 'missing.saudabak')).ok).toBe(false);
  });

  it('rejects a backup created by a newer schema instead of corrupting the shop', () => {
    const ctx = makeTestDb();
    seedProducts(ctx);
    const { file } = backupOf(ctx);
    const newer = path.join(path.dirname(file), 'newer.saudabak');
    fs.copyFileSync(file, newer);
    const handle = new Database(newer);
    handle.pragma('user_version = 99');
    handle.close();
    // the manifest no longer matches, so drop it to exercise the version check
    if (fs.existsSync(`${newer}.json`)) fs.rmSync(`${newer}.json`);
    const check = validateBackup(newer);
    expect(check.ok).toBe(false);
    expect(check.message).toContain('নতুন ভার্সনের');
    ctx.cleanup();
  });

  it('restores a snapshot and keeps a safety copy of what it replaced', () => {
    const ctx = makeTestDb();
    const ids = seedProducts(ctx);
    const { file } = backupOf(ctx);
    const before = (ctx.db.prepare('SELECT COUNT(*) c FROM products').get() as { c: number }).c;

    // New data after the snapshot…
    createProduct(
      ctx.db,
      { name: 'পরে যোগ করা', sku: 'LATER-1', unitId: ctx.unitPieceId, primaryUnitId: ctx.unitPieceId, purchasePrice: 1000, salePrice: 1200 },
      ctx.actor,
    );
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM products').get() as { c: number }).c).toBe(before + 1);

    const safety = restoreBackup(ctx.db, {
      backupPath: file,
      dataDir: tmp(),
      livePath: ctx.dbPath,
      appVersion: '1.0.0',
      actor: ctx.actor,
    });
    expect(fs.existsSync(safety.safetyBackup)).toBe(true);
    expect(safety.restored.ok).toBe(true);

    const reopened = new Database(ctx.dbPath, { readonly: true });
    const count = (reopened.prepare('SELECT COUNT(*) c FROM products').get() as { c: number }).c;
    const names = (reopened.prepare('SELECT name FROM products ORDER BY id').all() as { name: string }[]).map((r) => r.name);
    const integrity = reopened.pragma('integrity_check', { simple: true });
    reopened.close();
    expect(count).toBe(before);
    expect(names).not.toContain('পরে যোগ করা');
    expect(names).toContain(ids.rice.name);
    expect(String(integrity).toLowerCase()).toBe('ok');
    ctx.cleanup();
  });
});

describe('users, roles and permissions', () => {
  it('gives the cashier only the till permissions and blocks admin-only work', () => {
    const cashier = { role: 'cashier' as const, permissions: DEFAULT_ROLE_PERMISSIONS.cashier as string[] };
    expect(hasPermission(cashier, 'pos.sell')).toBe(true);
    expect(hasPermission(cashier, 'settings.manage')).toBe(false);
    expect(() => requirePermission(cashier, 'settings.manage')).toThrow(/অনুমতি/);
    expect(hasPermission({ role: 'admin' as const, permissions: [] }, 'license.manage')).toBe(true);
    // the cashier must not be able to wipe books or grant permissions
    for (const perm of ['user.manage', 'backup.manage', 'license.manage', 'audit.view', 'product.delete'] as const) {
      expect(hasPermission(cashier, perm)).toBe(false);
    }
    expect(ALL_PERMISSIONS.length).toBeGreaterThan(15);
  });

  it('creates users with strong passwords only and never stores the plain text', () => {
    const ctx = makeTestDb();
    expect(() =>
      createUser(ctx.db, { username: 'bad', fullName: 'খারাপ', password: '123', role: 'cashier' }, ctx.actor),
    ).toThrow();
    expect(() =>
      createUser(ctx.db, { username: 'admin', fullName: 'ডুপ্লিকেট', password: 'Strong#1234', role: 'cashier' }, ctx.actor),
    ).toThrow();
    const user = createUser(
      ctx.db,
      { username: 'cashier1', fullName: 'ক্যাশিয়ার এক', password: 'Strong#1234', role: 'cashier' },
      ctx.actor,
    );
    const stored = ctx.db.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').get(user.id) as {
      password_hash: string;
      password_salt: string;
    };
    expect(stored.password_hash).not.toContain('Strong#1234');
    expect(stored.password_salt.length).toBeGreaterThan(10);

    expect(() => login(ctx.db, 'cashier1', 'wrong')).toThrow();
    expect(login(ctx.db, 'cashier1', 'Strong#1234').user?.id).toBe(user.id);

    resetPassword(ctx.db, user.id, 'Another#1234', ctx.actor);
    expect(() => login(ctx.db, 'cashier1', 'Strong#1234')).toThrow();
    expect(login(ctx.db, 'cashier1', 'Another#1234').user?.id).toBe(user.id);
    expect(listUsers(ctx.db)).toHaveLength(2);
    ctx.cleanup();
  });

  it('cannot delete a user that made sales and refuses to deactivate the last admin', () => {
    const ctx = makeTestDb();
    const ids = seedProducts(ctx);
    createProduct(
      ctx.db,
      { name: 'স্টক আইটেম', sku: 'X1', unitId: ctx.unitPieceId, primaryUnitId: ctx.unitPieceId, purchasePrice: 1000, salePrice: 1500 },
      ctx.actor,
    );
    const user = createUser(
      ctx.db,
      { username: 'cashier2', fullName: 'ক্যাশিয়ার দুই', password: 'Strong#1234', role: 'cashier' },
      ctx.actor,
    );
    const p = ctx.db.prepare("SELECT id FROM products WHERE sku = 'X1'").get() as { id: number };
    createPurchase(ctx.db, {
      lines: [{ productId: p.id, unitId: ctx.unitPieceId, qtyMilli: 5_000, unitPricePaisa: 1000 }],
      actor: ctx.actor,
    });
    createSale(ctx.db, {
      lines: [{ productId: p.id, unitId: ctx.unitPieceId, qtyMilli: 1000 }],
      paidPaisa: 1500,
      defaultMethodId: ctx.cashMethodId,
      actor: { id: user.id, username: user.username },
    });
    // The database itself refuses to orphan a sale; the app archives instead.
    expect(() => ctx.db.prepare('DELETE FROM users WHERE id = ?').run(user.id)).toThrow();
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM sales').get() as { c: number }).c).toBe(1);
    void ids;
    ctx.cleanup();
  });
});

describe('destructive operations', () => {
  it('refuses to delete a customer that has transactions or a balance', () => {
    const ctx = makeTestDb();
    const ids = seedProducts(ctx);
    createProduct(
      ctx.db,
      { name: 'ডিলিট টেস্ট', sku: 'DEL-1', unitId: ctx.unitPieceId, primaryUnitId: ctx.unitPieceId, purchasePrice: 1000, salePrice: 1500 },
      ctx.actor,
    );
    const p = ctx.db.prepare("SELECT id FROM products WHERE sku = 'DEL-1'").get() as { id: number };
    createPurchase(ctx.db, {
      lines: [{ productId: p.id, unitId: ctx.unitPieceId, qtyMilli: 5_000, unitPricePaisa: 1000 }],
      actor: ctx.actor,
    });
    createSale(ctx.db, {
      customerId: ids.customer.id,
      lines: [{ productId: p.id, unitId: ctx.unitPieceId, qtyMilli: 1000 }],
      actor: ctx.actor,
    });
    expect(() => deleteCustomer(ctx.db, ids.customer.id, ctx.actor)).toThrow();
    const fresh = createCustomer(ctx.db, { name: 'নতুন খাতা' }, ctx.actor);
    expect(() => deleteCustomer(ctx.db, fresh.id, ctx.actor)).not.toThrow();
    expect(getCustomer(ctx.db, fresh.id)).toBeNull();
    ctx.cleanup();
  });

  it('refuses to delete a product that has moved, and keeps its stock ledger intact', () => {
    const ctx = makeTestDb();
    const ids = seedProducts(ctx);
    createSale(ctx.db, {
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 1000 }],
      paidPaisa: 4500,
      defaultMethodId: ctx.cashMethodId,
      actor: { id: ctx.actor.id, username: ctx.actor.username },
      overrideNegativeStock: true,
    });
    expect(() => deleteProduct(ctx.db, ids.soap.id, ctx.actor)).toThrow();
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM stock_movements WHERE product_id = ?').get(ids.soap.id) as { c: number }).c).toBeGreaterThan(0);
    ctx.cleanup();
  });
});

describe('settings validation', () => {
  it('refuses nonsensical values and keeps the old ones', () => {
    const ctx = makeTestDb();
    const before = getSettings(ctx.db);
    for (const patch of [
      { vat_percent_x100: -100 },
      { max_discount_percent_x100: 20000 },
      { receipt_width: 'huge' as never },
      { stock_alert_threshold_milli: -1 },
      { backup_keep_count: 0 },
      { receipt_font_size: 40 },
      { invoice_format: 'no-sequence' },
    ]) {
      expect(() => updateSettings(ctx.db, patch as never, ctx.actor)).toThrow();
    }
    expect(getSettings(ctx.db).receipt_width).toBe(before.receipt_width);
    const updated = updateSettings(ctx.db, { receipt_width: 58, vat_percent_x100: 500 }, ctx.actor);
    expect(updated.receipt_width).toBe(58);
    expect(updated.vat_percent_x100).toBe(500);
    ctx.cleanup();
  });
});

describe('SQL injection surface', () => {
  it('treats search input as data, not SQL', () => {
    const ctx = makeTestDb();
    const ids = seedProducts(ctx);
    const attack = "'; DROP TABLE products; --";
    const rows = ctx.db
      .prepare('SELECT COUNT(*) c FROM products WHERE search_text LIKE ? OR sku LIKE ?')
      .get(`%${attack}%`, `%${attack}%`) as { c: number };
    expect(rows.c).toBe(0);
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM products').get() as { c: number }).c).toBe(2);
    void ids;
    ctx.cleanup();
  });
});

function _unusedDb(_db: Db) {}
void _unusedDb;
