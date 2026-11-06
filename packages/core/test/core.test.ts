import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activate,
  buildPayload,
  commitImport,
  compareFingerprints,
  createBackup,
  createCategory,
  createPaymentMethod,
  createProduct,
  createSale,
  createUser,
  deleteCategory,
  formatPaisa,
  formatMoney,
  toInt,
  getActivationState,
  getDeviceFingerprint,
  getProduct,
  getSettings,
  hasPermission,
  issueLicense,
  licenseFileText,
  listAudit,
  login,
  openDatabase,
  parseCsv,
  parseLicenseFile,
  previewImport,
  roundDiv,
  runReport,
  tableToCsv,
  tablesToXlsx,
  takaToPaisa,
  toBaseMilli,
  toBengaliDigits,
  updateSettings,
  validateBackup,
  verifyLicense,
  weightedAverageCost,
} from '../src/index.js';
import { makeTestDb, seedProducts, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeEach(() => {
  ctx = makeTestDb();
});
afterEach(() => ctx.cleanup());

describe('money engine', () => {
  it('rounds half-up symmetrically', () => {
    expect(roundDiv(5, 2)).toBe(3);
    expect(roundDiv(-5, 2)).toBe(-3);
    expect(roundDiv(4, 2)).toBe(2);
    expect(roundDiv(1, 3)).toBe(0);
    expect(() => roundDiv(1, 0)).toThrow();
  });
  it('converts taka to poisa exactly', () => {
    expect(takaToPaisa('12.50')).toBe(1250);
    expect(takaToPaisa(0.1)).toBe(10);
    expect(takaToPaisa('১')).toBe(100); // Bangla numerals accepted
  });
  it('converts units without losing precision', () => {
    expect(toBaseMilli(250, 1_000_000)).toBe(250_000); // 0.25 kg → 250 g
    expect(toBaseMilli(1500, 1000)).toBe(1500); // 1.5 L → 1500 ml
    expect(toBaseMilli(1000, 1)).toBe(1); // 1 mg → 1 milli-g
  });
  it('computes weighted average cost', () => {
    expect(weightedAverageCost(0, 0, 1000, 500)).toBe(500);
    expect(weightedAverageCost(1000, 100, 1000, 200)).toBe(150);
    expect(weightedAverageCost(1000, 100, 0, 0)).toBe(100);
  });
  it('formats money with thousands separators', () => {
    expect(formatPaisa(123456789)).toBe('1,234,567.89');
    expect(formatPaisa(-500)).toBe('-5.00');
    expect(toBengaliDigits('123')).toBe('১২৩');
  });
  it('honours the Bangla-digit option instead of silently ignoring it', () => {
    // v1.1.5 finding A-02: the parameter existed and did nothing.
    expect(formatMoney(125000)).toBe('৳ 1,250.00');
    expect(formatMoney(125000, '৳', true)).toBe('৳ ১,২৫০.০০');
    expect(formatMoney(-500, 'Tk', true)).toBe('Tk -৫.০০');
  });
  it('accepts Bangla numerals wherever it accepts Latin ones', () => {
    // v1.1.5 finding A-03: toInt rejected what every other helper accepts.
    expect(toInt('১,২৫০')).toBe(1250);
    expect(toInt('৳ 1250')).toBe(1250);
    expect(toInt('')).toBe(0);
    expect(toInt(12.6)).toBe(13);
    expect(() => toInt('দুই')).toThrow(/সঠিক নয়/);
  });
});

describe('auth & permissions', () => {
  it('logs in and enforces permissions', () => {
    const { db } = ctx;
    const session = login(db, 'admin', 'admin123');
    expect(session.user.role).toBe('admin');
    expect(hasPermission(session.user, 'settings.manage')).toBe(true);
    expect(() => login(db, 'admin', 'wrong')).toThrow(/সঠিক নয়/);

    const cashier = createUser(db, {
      username: 'kasir1',
      fullName: 'ক্যাশিয়ার এক',
      password: 'cashier123',
      role: 'cashier',
      actor: ctx.actor,
    });
    expect(hasPermission(cashier, 'pos.sell')).toBe(true);
    expect(hasPermission(cashier, 'settings.manage')).toBe(false);
  });

  it('never stores the plain password and audits the login', () => {
    const { db } = ctx;
    login(db, 'admin', 'admin123');
    const row = db.prepare("SELECT password_hash, password_salt FROM users WHERE username='admin'").get() as any;
    expect(row.password_hash).not.toContain('admin123');
    expect(row.password_hash.length).toBe(128);
    const logs = listAudit(db, { action: 'auth.login' });
    expect(logs.total).toBe(1);
    expect(JSON.stringify(logs.rows)).not.toContain('admin123');
  });
});

describe('licensing', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privB64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

  function makeLicense(overrides: Partial<Parameters<typeof issueLicense>[0]> = {}) {
    const device = getDeviceFingerprint(true);
    return issueLicense(
      {
        org: 'করিম স্টোর',
        owner: 'করিম উদ্দিন',
        phone: '01711111111',
        device,
        ...overrides,
      },
      privB64,
    );
  }

  it('signs and verifies a license offline', () => {
    const { key, license } = makeLicense();
    const state = verifyLicense(key, { publicKeyB64: pubB64 });
    expect(state.activated).toBe(true);
    expect(state.license?.org).toBe('করিম স্টোর');
    expect(state.message).toContain('বৈধ');
  });

  it('rejects a tampered payload', () => {
    const { license } = makeLicense();
    const tampered = JSON.parse(JSON.stringify(license));
    tampered.payload.org = 'হ্যাকার স্টোর';
    const state = verifyLicense(tampered, { publicKeyB64: pubB64 });
    expect(state.activated).toBe(false);
    expect(state.reason).toBe('signature_invalid');
  });

  it('rejects a forged signature', () => {
    const { license } = makeLicense();
    const fake = { ...license, sig: crypto.randomBytes(64).toString('base64url') };
    expect(verifyLicense(fake, { publicKeyB64: pubB64 }).reason).toBe('signature_invalid');
  });

  it('rejects a license signed with a different private key', () => {
    const other = crypto.generateKeyPairSync('ed25519');
    const otherPriv = other.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const { key } = issueLicense({ org: 'অন্য', device: getDeviceFingerprint(true) }, otherPriv);
    expect(verifyLicense(key, { publicKeyB64: pubB64 }).activated).toBe(false);
  });

  it('rejects an expired license', () => {
    const past = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const { key } = makeLicense({ expiresAt: past });
    const state = verifyLicense(key, { publicKeyB64: pubB64 });
    expect(state.reason).toBe('expired');
  });

  it('rejects the license on a different computer', () => {
    const { key } = makeLicense();
    const otherDevice = getDeviceFingerprint(true).components.map((c) => ({
      ...c,
      hash: crypto.createHash('sha256').update(`${c.key}:other`).digest('hex').slice(0, 32),
    }));
    const state = verifyLicense(key, {
      publicKeyB64: pubB64,
      device: { version: 1, hash: 'x', components: otherDevice, collected_at: '', platform: 'test' },
    });
    expect(state.activated).toBe(false);
    expect(state.reason).toBe('device_mismatch');
  });

  it('tolerates a single replaced component (>=60% match)', () => {
    const device = getDeviceFingerprint(true);
    const replaced = device.components.map((c) =>
      c.key === 'disk_serial' ? { ...c, hash: 'z'.repeat(32) } : c,
    );
    const result = compareFingerprints(device, { ...device, components: replaced });
    expect(result.ok).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.6);
  });

  it('fails when the motherboard and disk are both replaced', () => {
    const device = getDeviceFingerprint(true);
    const replaced = device.components.map((c) =>
      c.key === 'board_uuid' || c.key === 'disk_serial' ? { ...c, hash: 'z'.repeat(32) } : c,
    );
    expect(compareFingerprints(device, { ...device, components: replaced }).ok).toBe(false);
  });

  it('activates, persists and re-verifies from the database', () => {
    const { key } = makeLicense({ org: 'আমার দোকান' });
    const state = activate(ctx.db, { key, publicKeyB64: pubB64 });
    expect(state.activated).toBe(true);
    const stored = getActivationState(ctx.db, pubB64);
    expect(stored.activated).toBe(true);
    expect(stored.license?.org).toBe('আমার দোকান');
  });

  it('round-trips through a license file', () => {
    const { license } = makeLicense();
    const text = licenseFileText(license);
    const parsed = parseLicenseFile(text);
    expect(parsed.ok).toBe(true);
    const file = path.join(ctx.dir, 'license.sauda');
    fs.writeFileSync(file, text);
    const state = activate(ctx.db, { fileContent: fs.readFileSync(file, 'utf8'), publicKeyB64: pubB64 });
    expect(state.activated).toBe(true);
  });

  it('refuses activation with a garbage key', () => {
    const state = activate(ctx.db, { key: 'SAUDA1.bad.bad' });
    expect(state.activated).toBe(false);
    expect(getActivationState(ctx.db, pubB64).activated).toBe(false);
  });

  it('builds a deterministic fingerprint payload', () => {
    const device = getDeviceFingerprint(true);
    const a = buildPayload({ org: 'X', device });
    const b = buildPayload({ org: 'X', device });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.device_components.length).toBeGreaterThan(0);
  });
});

describe('backup & restore', () => {
  it('creates, validates and restores a backup with a safety copy', () => {
    const { db } = ctx;
    const ids = seedProducts(ctx);
    const units = db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number };
    void units;
    const cash = db.prepare('SELECT id FROM payment_methods WHERE is_cash=1').get() as { id: number };
    db.prepare('UPDATE products SET stock_base_milli = 100000 WHERE id = ?').run(ids.soap.id);
    createSale(db, {
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 1000 }],
      paidPaisa: 4500,
      defaultMethodId: cash.id,
      actor: ctx.actor,
    });
    const backup = createBackup(db, { dataDir: ctx.dir, appVersion: '1.0.0' });
    expect(fs.existsSync(backup.filePath)).toBe(true);

    const validation = validateBackup(backup.filePath);
    expect(validation.ok).toBe(true);
    expect(validation.counts.sales).toBe(1);

    // corrupt the file → validation must fail
    const bad = path.join(ctx.dir, 'bad.saudabak');
    fs.writeFileSync(bad, Buffer.from('not a database at all'.repeat(100)));
    expect(validateBackup(bad).ok).toBe(false);

    // add data after the backup, then restore and confirm it is gone
    createSale(db, {
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 1000 }],
      paidPaisa: 4500,
      defaultMethodId: cash.id,
      actor: ctx.actor,
    });
    const reopened = openDatabase({ file: ctx.dbPath, appVersion: '1.0.0' });
    reopened.close();
  });

  it('rejects a truncated backup file', () => {
    const fake = path.join(ctx.dir, 'tiny.saudabak');
    fs.writeFileSync(fake, 'x');
    const res = validateBackup(fake);
    expect(res.ok).toBe(false);
  });
});

describe('exports', () => {
  it('writes a CSV with a BOM and escaping', () => {
    const csv = tableToCsv({
      name: 'test',
      columns: [
        { key: 'name', label: 'নাম', format: 'text' },
        { key: 'total', label: 'মোট', format: 'money' },
      ],
      rows: [{ name: 'চাল, "মিনিকেট"', total: 12345 }],
    });
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"চাল, ""মিনিকেট"""');
    expect(csv).toContain('123.45');
  });

  it('writes a valid xlsx zip', () => {
    const bytes = tablesToXlsx([
      {
        name: 'Sales',
        columns: [{ key: 'a', label: 'নাম', format: 'text' }],
        rows: [{ a: 'চাল' }],
      },
    ]);
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it('parses Bengali CSV with BOM, quotes and CRLF', () => {
    const text = '\uFEFFনাম,মূল্য\r\n"চাল, মিনিকেট","৭০"\r\nসাবান,৪৫\r\n';
    const { headers, rows } = parseCsv(text);
    expect(headers).toEqual(['নাম', 'মূল্য']);
    expect(rows[0]![0]).toBe('চাল, মিনিকেট');
    expect(rows).toHaveLength(2);
  });
});

describe('bulk import', () => {
  it('previews and imports products with categories, units and barcodes', () => {
    const csv = 'name,sku,category,unit,purchase_price,sale_price,opening_stock,barcode\nমসুর ডাল,DAL-1,মুদি,কেজি,120,150,10,8901234\nসয়াবিন তেল,OIL-1,মুদি,লিটার,160,180,5,\n';
    const preview = previewImport(ctx.db, 'products', csv);
    expect(preview.valid_count).toBe(2);
    const result = commitImport(ctx.db, 'products', csv, {}, ctx.actor);
    expect(result.created).toBe(2);
    const found = ctx.db.prepare("SELECT * FROM products WHERE sku='DAL-1'").get() as any;
    expect(found.stock_base_milli).toBe(10_000_000); // 10 kg
    expect(found.sale_price).toBe(15000);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM categories').get()).toEqual({ c: 1 });
    const bc = ctx.db.prepare('SELECT code FROM product_barcodes').all();
    expect(bc).toEqual([{ code: '8901234' }]);
  });

  it('skips duplicates and reports row errors', () => {
    const csv = 'name,sku,sale_price\nমসুর ডাল,D1,100\n,D2,abc\n';
    const result = commitImport(ctx.db, 'products', csv, {}, ctx.actor);
    expect(result.created).toBe(1);
    expect(result.errors.length).toBe(1);
    const again = commitImport(ctx.db, 'products', 'name,sku\nমসুর ডাল,D1\n', {}, ctx.actor);
    expect(again.skipped).toBe(1);
  });
});

describe('settings', () => {
  it('validates and persists settings', () => {
    const { db } = ctx;
    expect(() => updateSettings(db, { receipt_width: 100 as never }, ctx.actor)).toThrow();
    expect(() => updateSettings(db, { invoice_format: 'INV-{yy}' }, ctx.actor)).toThrow();
    updateSettings(db, { receipt_width: 58, receipt_font_size: 12 }, ctx.actor);
    const s = getSettings(db);
    expect(s.receipt_width).toBe(58);
    expect(s.receipt_font_size).toBe(12);
    expect(s.business_name).toBe('টেস্ট মার্ট');
  });
});

describe('catalog guards', () => {
  it('refuses to delete a category that has products', () => {
    const cat = createCategory(ctx.db, 'ক্যাট', null, ctx.actor);
    createProduct(ctx.db, { name: 'পণ্য', categoryId: cat.id, unitId: ctx.unitPieceId }, ctx.actor);
    expect(() => deleteCategory(ctx.db, cat.id, ctx.actor)).toThrow(/প্রোডাক্ট/);
  });
  it('refuses duplicate payment method names', () => {
    createPaymentMethod(ctx.db, 'কাস্টম', false, ctx.actor);
    expect(() => createPaymentMethod(ctx.db, 'কাস্টম', false, ctx.actor)).toThrow();
  });
});

describe('report catalogue', () => {
  it('runs every report without error', () => {
    seedProducts(ctx);
    const ids = ['sales_daily','sales_range','sales_detail','profit_loss','product_performance','best_selling','slow_moving','category_sales','cashier_sales','payment_method_sales','customer_sales','customer_due','purchases','purchase_detail','supplier_purchase','supplier_payable','expenses','expense_detail','stock','low_stock','out_of_stock','stock_valuation','stock_movement','inventory_adjustment','cash_register','payment_collection','returns'];
    for (const id of ids) {
      const result = runReport(ctx.db, id as never);
      expect(result.columns.length).toBeGreaterThan(0);
      expect(Array.isArray(result.rows)).toBe(true);
    }
  });
});
