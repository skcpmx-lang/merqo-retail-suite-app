/**
 * v1.1.4 Phase 3 — client mode end to end over a real socket.
 *
 * One shop database on the "Main PC", one guarded client database on the "Client PC".
 * A sale is committed through the transport and must land **only** on the Main PC; the
 * client's local file must stay untouched and must not answer business queries.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  ClientIsolationError,
  adjustStock,
  approveDevice,
  createCategory,
  createDeviceSession,
  createPairingToken,
  createProduct,
  createSale,
  validateCart,
  getStoreIdentity,
  initializeApp,
  listUnits,
  loadOrCreateServerIdentity,
  openClientDatabase,
  openDatabase,
  startLanApi,
  type Db,
  type LanApi,
  type Sealer,
} from '@sauda/core';
import { V1Terminal } from '../electron/v1-transport.js';

vi.setConfig({ testTimeout: 40_000 });

const dirs: string[] = [];
const apis: LanApi[] = [];

const sealer: Sealer = {
  kind: 'test-sealer',
  seal: (plain) => Buffer.from(plain.toString('base64')),
  unseal: (sealed) => Buffer.from(sealed.toString('utf8'), 'base64'),
};

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-client-e2e-'));
  dirs.push(dir);
  return dir;
}

function countSales(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number }).n;
}

afterAll(async () => {
  for (const api of apis) await api.stop().catch(() => undefined);
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('client mode end to end', () => {
  it('commits a sale on the Main PC and never on the client', async () => {
    /* ---------------- Main PC ---------------- */
    const hostDir = tempDir();
    const db = openDatabase({ file: path.join(hostDir, 'shop.db'), appVersion: '1.1.4' });
    initializeApp(db, {
      businessName: 'ই২ই স্টোর',
      businessAddress: 'ঢাকা',
      businessPhone: '01700000000',
      adminFullName: 'মালিক',
      adminUsername: 'owner',
      adminPassword: 'owner123',
    });
    const store = getStoreIdentity(db);
    const admin = db.prepare('SELECT id, username FROM users ORDER BY id LIMIT 1').get() as { id: number; username: string };
    const actor = { id: admin.id, username: admin.username };
    const units = listUnits(db);
    const kg = units.find((u) => u.name === 'কেজি') ?? units[0]!;
    const cash = (db.prepare('SELECT id FROM payment_methods WHERE is_cash = 1 LIMIT 1').get() as { id: number }).id;
    const category = createCategory(db, 'মুদি', null, actor);
    const product = createProduct(db, {
      name: 'মিনিকেট চাল',
      sku: 'RICE-E2E',
      categoryId: category.id,
      unitId: kg.id,
      primaryUnitId: kg.id,
      purchasePrice: 7000,
      salePrice: 8000,
      minStockMilli: 0,
      barcodes: [],
    } as never);
    adjustStock(db, { productId: product.id, newQtyBaseMilli: 5_000_000, reason: 'প্রারম্ভিক স্টক', actor });
    db.prepare('INSERT INTO device_licenses (license_id, store_id, device_id, role, capacity, edition, issued_at, expires_at, status, payload, registered_at) VALUES (?,?,?,?,?,?,?,NULL,?,?,?)').run(
      'LIC-SERVER',
      store.store_id,
      'DEV-SERVER',
      'SERVER_POS',
      2,
      'standard',
      new Date().toISOString(),
      'active',
      '{}',
      new Date().toISOString(),
    );

    const identity = loadOrCreateServerIdentity({ dir: path.join(hostDir, 'tls'), allowCreate: true, ips: [] });
    const api = await startLanApi({
      port: 0,
      tls: { certPem: identity.certPem, keyPem: identity.keyPem, fingerprint: identity.fingerprint },
      db,
      version: '1.1.4',
      storeId: () => store.store_id,
      serverId: () => store.server_id,
      licensedCapacity: () => 2,
      allowRemote: () => true,
      invoke: async (method, args) => {
        if (method === 'sale.create') {
          // The real service, on the real shop database; conflicts travel as data.
          try {
            const result = createSale(db, args[0] as never);
            return { ok: true, data: result };
          } catch (err) {
            const e = err as Error & { code?: string; details?: unknown };
            if (e.code === 'SALE_CONFLICT') return { ok: false, code: e.code, error: e.message, details: e.details };
            return { ok: false, code: e.code ?? 'ERROR', error: e.message };
          }
        }
        if (method === 'sales.validateCart') {
          return { ok: true, data: validateCart(db, args[0] as never) };
        }
        if (method === 'products.list') {
          return { ok: true, data: { rows: db.prepare('SELECT id, name FROM products').all(), total: 1 } };
        }
        return { ok: true, data: null };
      },
      authenticate: async (username, password) =>
        username === 'owner' && password === 'owner123'
          ? { id: actor.id, username, full_name: 'মালিক', role: 'admin', permissions: ['pos.sell', 'settings.manage', 'report.view'] }
          : null,
      ssePollMs: 25,
      sseHeartbeatMs: 120,
    });
    apis.push(api);

    /* ---------------- Client PC ---------------- */
    const clientDir = tempDir();
    const clientDb = openClientDatabase({ file: path.join(clientDir, 'sauda.db'), appVersion: '1.1.4' });
    const terminal = new V1Terminal({
      store: new (await import('@sauda/core')).DeviceKeyStore({ dir: clientDir, sealer }),
      baseUrl: `https://127.0.0.1:${api.port}`,
      fingerprint: identity.fingerprint,
      serverCertPem: identity.certPem,
      timeoutMs: 8000,
    });
    const pending = await terminal.pair({
      code: createPairingToken(db).code,
      licence: { license_id: 'LIC-CLIENT-E2E', store_id: store.store_id, capacity: 2 },
    });
    expect(pending.status).toBe('pending');
    // Pending devices are refused before approval.
    await expect(terminal.login('owner', 'owner123')).rejects.toThrow();

    approveDevice(db, pending.deviceId, actor);
    await terminal.login('owner', 'owner123');

    const sale = await terminal.invoke<{ saleId: number }>('sale.create', [
      {
        lines: [{ productId: product.id, unitId: kg.id, qtyMilli: 2000 }],
        paidPaisa: 20_000,
        defaultMethodId: cash,
        actor,
      },
    ]);
    expect(sale.saleId).toBeGreaterThan(0);

    // The shop has the sale …
    expect(countSales(db)).toBe(1);
    // … and the client's own database has nothing, and cannot answer shop queries.
    const rawClient = openDatabase({ file: path.join(clientDir, 'sauda.db'), readonly: true });
    try {
      expect(countSales(rawClient)).toBe(0);
    } finally {
      rawClient.close();
    }
    expect(() => clientDb.prepare('SELECT COUNT(*) AS n FROM sales').get()).toThrow(ClientIsolationError);
    expect(() =>
      createSale(clientDb, {
        lines: [{ productId: product.id, unitId: kg.id, qtyMilli: 1000 }],
        paidPaisa: 8000,
        defaultMethodId: cash,
        actor,
      }),
    ).toThrow(ClientIsolationError);

    // A cart the cashier scanned before a price change must be refused, not silently
    // re-priced: the host answers with structured conflicts and the cart stays put.
    db.prepare('UPDATE products SET sale_price = sale_price + 1000 WHERE id = ?').run(product.id);
    const staleError = await terminal
      .invoke('sale.create', [
        {
          lines: [{ productId: product.id, unitId: kg.id, qtyMilli: 1000 }],
          paidPaisa: 10_000,
          defaultMethodId: cash,
          actor,
          expected: { lines: [{ productId: product.id, unitPricePaisa: 10_000, qtyBaseMilli: 1_000_000 }] },
        },
      ])
      .then(() => null)
      .catch((err: Error & { code?: string; details?: { conflicts?: Array<{ kind: string }> } }) => err);
    expect(staleError?.code).toBe('SALE_CONFLICT');
    expect(staleError?.details?.conflicts?.[0]?.kind).toBe('PRICE_CHANGED');
    // Nothing was sold, nothing was written.
    expect(countSales(db)).toBe(1);
    // A read-only preview shows the same conflict, so the cashier can review the cart.
    const preview = await terminal.invoke<{ ok: boolean; conflicts: Array<{ kind: string; currentPaisa?: number }> }>(
      'sales.validateCart',
      [
        {
          lines: [{ productId: product.id, unitId: kg.id, qtyMilli: 1000 }],
          expected: { lines: [{ productId: product.id, unitPricePaisa: 10_000, qtyBaseMilli: 1_000_000 }] },
        },
      ],
    );
    expect(preview.ok).toBe(false);
    const currentPrice = (db.prepare('SELECT sale_price FROM products WHERE id = ?').get(product.id) as { sale_price: number })
      .sale_price;
    expect(preview.conflicts[0]?.currentPaisa).toBe(currentPrice);
    expect(preview.conflicts[0]?.currentPaisa).not.toBe(10_000);

    // The client sees the product list through the host, not from its own file.
    const products = await terminal.invoke<{ rows: Array<{ name: string }> }>('products.list', []);
    expect(products.rows[0]!.name).toBe('মিনিকেট চাল');
    clientDb.close();
  });
});
