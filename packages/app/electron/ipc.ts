import { app, BrowserWindow, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  ALL_PERMISSIONS,
  assembleBundle,
  balanceSheet,
  bundleCapacity,
  cancelHeldSale,
  cashBook,
  createAccount,
  createCreditNote,
  createExchange,
  createLocation,
  createStockCount,
  createTransfer,
  dayBook,
  deadStock,
  generalLedger,
  getBundle,
  getHeldSale,
  holdSale,
  inventoryValuation,
  journalEntries,
  listAccounts,
  listFavourites,
  listHeldSales,
  listLocations,
  listSerials,
  listStockCounts,
  listTransfers,
  locationStock,
  markSerialsSold,
  posQuickPicks,
  profitAndLoss,
  postStockCount,
  reconcile,
  registerSerials,
  reorderSuggestions,
  resumeHeldSale,
  setBundle,
  setCountedQty,
  stockCountItems,
  toggleFavourite,
  transferItems,
  trialBalance,
  unbalancedEntries,
  updateAccount,
  updateLocation,
  voidStockCount,
  postManualEntry,
  escapeHtml,
  formatPaisa,
  activate,
  adjustStock,
  appInfo,
  changeOwnPassword,
  closeCashSession,
  commitImport,
  createBackup,
  createBrand,
  createCategory,
  createCustomer,
  createExpense,
  createExpenseCategory,
  createPaymentMethod,
  createProduct,
  createPurchase,
  createPurchaseReturn,
  computePurchase,
  listProductLabels,
  REPORT_CATALOG,
  computeSale,
  createSale,
  createSaleReturn,
  createSupplier,
  createUnit,
  createUser,
  cashInHandPaisa,
  customerStatement,
  dashboardStats,
  deactivate,
  deleteCategory,
  deletePaymentMethod,
  deleteProduct,
  deleteSupplier,
  deleteUnit,
  expenseTotal,
  findCodeAnywhere,
  getActivationState,
  getCustomer,
  getProduct,
  getPurchase,
  getSale,
  getSettings,
  getSupplier,
  getUser,
  hasPermission,
  initializeApp,
  integrityCheck,
  licenseFileText,
  listAudit,
  listBackups,
  listBrands,
  listCashMovements,
  listCategories,
  listCustomers,
  listExpenses,
  listExpenseCategories,
  listMovements,
  listPaymentMethods,
  listPayments,
  listPriceHistory,
  listProducts,
  listPurchases,
  listReturns,
  getReturn,
  listSales,
  listSessions,
  listSuppliers,
  listUnits,
  listUsers,
  login,
  lowStockProducts,
  openCashSession,
  outOfStockProducts,
  expiringBatches,
  paySupplier,
  previewImport,
  pruneBackups,
  receiveCustomerPayment,
  recentActivity,
  activityFeed,
  repairDatabase,
  requirePermission,
  resetPassword,
  restoreBackup,
  reversePayment,
  runReport,
  searchEverything,
  sessionTotals,
  presetSeries,
  setCustomerActive,
  setProductActive,
  setSupplierActive,
  setupStatus,
  shouldAutoBackup,
  stockValuePaisa,
  supplierStatement,
  trends,
  updateCategory,
  updateCustomer,
  updateExpense,
  updatePaymentMethod,
  updateProduct,
  updateSettings,
  updateSupplier,
  updateUnit,
  updateUser,
  validateBackup,
  voidExpense,
  voidPurchase,
  voidSale,
  writeOffStock,
  fingerprintForDisplay,
  getDeviceFingerprint,
  tableToCsv,
  tablesToXlsx,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  type AppSettings,
  type Db,
  type Permission,
  type ReportId,
  type User,
} from '@sauda/core';
import { appPaths, assertInside, readRecentLogs, writeLog } from './paths.js';
import { buildReceiptHtml } from './receipt.js';
import { printHtml, listPrinters, htmlToPdf } from './printing.js';
import { code128Svg, qrSvg } from './barcode.js';

export interface AppContext {
  db: Db;
  user: User | null;
  openDb: () => Db;
  reopenDb: () => Db;
}

type Handler = (ctx: AppContext, ...args: any[]) => any;

interface Route {
  fn: Handler;
  perm?: Permission | 'any';
  public?: boolean;
}

const routes: Record<string, Route> = {};

function on(name: string, fn: Handler, perm?: Permission | 'any', isPublic = false) {
  routes[name] = { fn, perm, public: isPublic };
}

/* ------------------------------------------------------------------ */
/* Setup / license / auth                                             */
/* ------------------------------------------------------------------ */

on('setup.status', (ctx) => setupStatus(ctx.db), undefined, true);
on(
  'setup.initialize',
  (ctx, input) => {
    const res = initializeApp(ctx.db, input);
    return res;
  },
  undefined,
  true,
);
on('license.state', (ctx) => getActivationState(ctx.db), undefined, true);
on('license.fingerprint', () => fingerprintForDisplay(), undefined, true);
on(
  'license.activateKey',
  (ctx, key: string) => {
    const state = activate(ctx.db, { key }, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null);
    invalidateLicenseCache(ctx.db);
    return state;
  },
  undefined,
  true,
);
on(
  'license.activateFile',
  (ctx, content: string) => {
    const state = activate(ctx.db, { fileContent: content }, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null);
    invalidateLicenseCache(ctx.db);
    return state;
  },
  undefined,
  true,
);
on(
  'license.pickFile',
  async () => {
    const res = await dialog.showOpenDialog({
      title: 'লাইসেন্স ফাইল নির্বাচন করুন',
      filters: [
        { name: 'Sauda License', extensions: ['sauda', 'license', 'json'] },
        { name: 'সব ফাইল', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return { path: res.filePaths[0], content: fs.readFileSync(res.filePaths[0], 'utf8') };
  },
  undefined,
  true,
);
on(
  'license.exportRequest',
  async (ctx) => {
    // Writes a small, key-free request file the seller imports into the
    // License Generator. Only hashed hardware values leave this machine.
    const device = getDeviceFingerprint(true);
    const settings = getSettings(ctx.db);
    const payload = {
      kind: 'sauda-device-request',
      v: device.version,
      fingerprint: device.hash,
      components: device.components,
      platform: process.platform,
      app_version: PRODUCT_VERSION,
      business_name: settings.business_name || null,
      created_at: new Date().toISOString(),
    };
    const res = await dialog.showSaveDialog({
      title: 'ডিভাইস রিকোয়েস্ট সংরক্ষণ করুন',
      defaultPath: path.join(app.getPath('documents'), `sauda-device-${device.hash.slice(0, 8)}.sauda-device`),
      filters: [{ name: 'Sauda Device Request', extensions: ['sauda-device', 'json'] }],
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return res.filePath;
  },
  'any',
);

on(
  'license.deactivate',
  (ctx) => {
    deactivate(ctx.db, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null);
    invalidateLicenseCache(ctx.db);
    return true;
  },
  'license.manage',
);

on(
  'auth.login',
  (ctx, username: string, password: string) => {
    const result = login(ctx.db, username, password);
    ctx.user = result.user;
    return result.user;
  },
  undefined,
  true,
);
on(
  'auth.logout',
  (ctx) => {
    ctx.user = null;
    return true;
  },
  'any',
  true,
);
on('auth.me', (ctx) => ctx.user, 'any');
on(
  'auth.changePassword',
  (ctx, oldPassword: string, newPassword: string) => {
    if (!ctx.user) throw new Error('লগইন করুন।');
    changeOwnPassword(ctx.db, ctx.user.id, oldPassword, newPassword);
    return true;
  },
  'any',
);

on('users.list', (ctx) => listUsers(ctx.db), 'user.manage');
on('users.permissions', () => ALL_PERMISSIONS, 'user.manage');
on('users.create', (ctx, input) => createUser(ctx.db, { ...input, actor: ctx.user! }), 'user.manage');
on(
  'users.update',
  (ctx, id: number, patch) => updateUser(ctx.db, id, patch, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'user.manage',
);
on(
  'users.resetPassword',
  (ctx, id: number, password: string) =>
    resetPassword(ctx.db, id, password, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'user.manage',
);

/* ------------------------------------------------------------------ */
/* Settings & catalog                                                 */
/* ------------------------------------------------------------------ */

on('settings.get', (ctx) => getSettings(ctx.db), 'any');
on(
  'settings.update',
  (ctx, patch) => updateSettings(ctx.db, patch, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'settings.manage',
);
on('settings.paymentMethods', (ctx, includeInactive?: boolean) => listPaymentMethods(ctx.db, includeInactive), 'any');
on('settings.units', (ctx, includeInactive?: boolean) => listUnits(ctx.db, includeInactive), 'any');
on('settings.categories', (ctx, includeInactive?: boolean) => listCategories(ctx.db, includeInactive), 'any');
on('settings.brands', (ctx) => listBrands(ctx.db), 'any');
on('settings.expenseCategories', (ctx, includeInactive?: boolean) => listExpenseCategories(ctx.db, includeInactive), 'any');

on(
  'catalog.createUnit',
  (ctx, input) => createUnit(ctx.db, input, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'settings.manage',
);
on(
  'catalog.updateUnit',
  (ctx, id, patch) => updateUnit(ctx.db, id, patch, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'settings.manage',
);
on(
  'catalog.deleteUnit',
  (ctx, id) => deleteUnit(ctx.db, id, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'settings.manage',
);
on(
  'catalog.createCategory',
  (ctx, name, parentId) => createCategory(ctx.db, name, parentId, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'product.manage',
);
on(
  'catalog.updateCategory',
  (ctx, id, patch) => updateCategory(ctx.db, id, patch, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'product.manage',
);
on(
  'catalog.deleteCategory',
  (ctx, id) => deleteCategory(ctx.db, id, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'product.manage',
);
on(
  'catalog.createBrand',
  (ctx, name) => createBrand(ctx.db, name, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'product.manage',
);
on(
  'catalog.createPaymentMethod',
  (ctx, name, isCash) =>
    createPaymentMethod(ctx.db, name, isCash, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'settings.manage',
);
on(
  'catalog.updatePaymentMethod',
  (ctx, id, patch) =>
    updatePaymentMethod(ctx.db, id, patch, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'settings.manage',
);
on(
  'catalog.deletePaymentMethod',
  (ctx, id) => deletePaymentMethod(ctx.db, id, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'settings.manage',
);
on(
  'catalog.createExpenseCategory',
  (ctx, name) => createExpenseCategory(ctx.db, name, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'expense.manage',
);

/* ------------------------------------------------------------------ */
/* Products & inventory                                               */
/* ------------------------------------------------------------------ */

on('products.list', (ctx, filter) => listProducts(ctx.db, filter), 'product.view');
on('products.get', (ctx, id: number) => getProduct(ctx.db, id), 'product.view');
on('products.byCode', (ctx, code: string) => findCodeAnywhere(ctx.db, code), 'product.view');
on('products.priceHistory', (ctx, id: number) => listPriceHistory(ctx.db, id), 'product.view');
on('products.counts', (ctx) => {
  const all = listProducts(ctx.db, { pageSize: 5 });
  const low = lowStockProducts(ctx.db, 500).length;
  const out = outOfStockProducts(ctx.db, 500).length;
  return { total: all.total, low, out };
}, 'product.view');
on(
  'products.create',
  (ctx, input) => createProduct(ctx.db, input, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'product.manage',
);
on(
  'products.update',
  (ctx, id: number, input) =>
    updateProduct(ctx.db, id, input, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'product.manage',
);
on(
  'products.archive',
  (ctx, id: number, active: boolean) =>
    setProductActive(ctx.db, id, active, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'product.manage',
);
on(
  'products.delete',
  (ctx, id: number) => deleteProduct(ctx.db, id, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'product.delete',
);
on('inventory.movements', (ctx, filter) => listMovements(ctx.db, filter), 'product.view');
on('inventory.low', (ctx, limit?: number) => lowStockProducts(ctx.db, limit ?? 50), 'product.view');
on('inventory.out', (ctx, limit?: number) => outOfStockProducts(ctx.db, limit ?? 50), 'product.view');
on('inventory.expiring', (ctx, days?: number) => expiringBatches(ctx.db, days ?? 60), 'product.view');
on('inventory.stockValue', (ctx) => stockValuePaisa(ctx.db), 'product.view');

/* ------------------------------------------------------------------ */
/* Locations, transfers, counts, valuation (v1.0.1)                   */
/* ------------------------------------------------------------------ */

on('locations.list', (ctx) => listLocations(ctx.db), 'product.view');
on(
  'locations.create',
  (ctx, input) => createLocation(ctx.db, input, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'stock.adjust',
);
on(
  'locations.update',
  (ctx, id: number, input) =>
    updateLocation(ctx.db, id, input, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'stock.adjust',
);
on('locations.stock', (ctx, productId: number) => locationStock(ctx.db, productId), 'product.view');

on('stock.transfers', (ctx, filter) => listTransfers(ctx.db, filter), 'product.view');
on('stock.transferItems', (ctx, id: number) => transferItems(ctx.db, id), 'product.view');
on(
  'stock.transfer',
  (ctx, input) =>
    createTransfer(ctx.db, { ...input, actor: ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null }),
  'stock.transfer',
);

on('stock.counts', (ctx, filter) => listStockCounts(ctx.db, filter), 'product.view');
on('stock.countItems', (ctx, id: number) => stockCountItems(ctx.db, id), 'product.view');
on(
  'stock.countCreate',
  (ctx, input) =>
    createStockCount(ctx.db, { ...input, actor: ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null }),
  'stock.count',
);
on('stock.countSetQty', (ctx, countId: number, productId: number, qty: number) => {
  setCountedQty(ctx.db, countId, productId, qty);
  return true;
}, 'stock.count');
on(
  'stock.countPost',
  (ctx, id: number) => postStockCount(ctx.db, id, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'stock.count',
);
on(
  'stock.countVoid',
  (ctx, id: number) => {
    voidStockCount(ctx.db, id, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null);
    return true;
  },
  'stock.count',
);

on('stock.reorder', (ctx, opts) => reorderSuggestions(ctx.db, opts ?? {}), 'product.view');
on('stock.valuation', (ctx, filter) => inventoryValuation(ctx.db, filter ?? {}), 'product.view');
on('stock.dead', (ctx, days?: number) => deadStock(ctx.db, days ?? 60), 'product.view');

on('serials.list', (ctx, filter) => listSerials(ctx.db, filter), 'product.view');
on(
  'serials.register',
  (ctx, input) =>
    registerSerials(ctx.db, { ...input, actor: ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null }),
  'product.manage',
);
on(
  'serials.markSold',
  (ctx, serials: string[], saleId: number) =>
    markSerialsSold(ctx.db, serials, saleId, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'pos.sell',
);

on('bundles.get', (ctx, parentId: number) => ({ lines: getBundle(ctx.db, parentId), capacity: bundleCapacity(ctx.db, parentId) }), 'product.view');
on(
  'bundles.set',
  (ctx, parentId: number, lines) =>
    setBundle(ctx.db, parentId, lines, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'product.manage',
);
on(
  'bundles.assemble',
  (ctx, input) =>
    assembleBundle(ctx.db, { ...input, actor: ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null }),
  'stock.adjust',
);

/* ------------------------------------------------------------------ */
/* Double-entry accounting (v1.0.1)                                   */
/* ------------------------------------------------------------------ */

on('accounting.accounts', (ctx, opts) => listAccounts(ctx.db, opts ?? {}), 'accounting.view');
on(
  'accounting.createAccount',
  (ctx, input) =>
    createAccount(ctx.db, input, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'accounting.manage',
);
on(
  'accounting.updateAccount',
  (ctx, id: number, input) =>
    updateAccount(ctx.db, id, input, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'accounting.manage',
);
on('accounting.trialBalance', (ctx, from?: string, to?: string) => trialBalance(ctx.db, { from, to }), 'accounting.view');
on('accounting.profitAndLoss', (ctx, from: string, to: string) => profitAndLoss(ctx.db, { from, to }), 'accounting.view');
on('accounting.balanceSheet', (ctx, asOf?: string) => balanceSheet(ctx.db, asOf ?? new Date().toISOString().slice(0, 10)), 'accounting.view');
on('accounting.ledger', (ctx, accountId: number, from?: string, to?: string) => generalLedger(ctx.db, accountId, { from, to }), 'accounting.view');
on('accounting.journal', (ctx, filter) => journalEntries(ctx.db, filter), 'accounting.view');
on('accounting.dayBook', (ctx, date?: string) => dayBook(ctx.db, date ?? new Date().toISOString().slice(0, 10)), 'accounting.view');
on('accounting.cashBook', (ctx, from: string, to: string) => cashBook(ctx.db, { from, to }), 'accounting.view');
on('accounting.reconcile', (ctx, from?: string, to?: string) => reconcile(ctx.db, { from, to }), 'accounting.view');
on('accounting.unbalanced', (ctx) => unbalancedEntries(ctx.db), 'accounting.view');
on(
  'accounting.manualEntry',
  (ctx, input) =>
    postManualEntry(ctx.db, { ...input, actor: ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null }),
  'accounting.manage',
);

/* ------------------------------------------------------------------ */
/* POS extras: hold/resume, favourites, credit note, exchange         */
/* ------------------------------------------------------------------ */

on('pos.hold', (ctx, input) => holdSale(ctx.db, { ...input, actor: { id: ctx.user!.id, username: ctx.user!.username } }), 'pos.sell');
on('pos.held', (ctx, status) => listHeldSales(ctx.db, status ?? 'held'), 'pos.sell');
on('pos.heldOne', (ctx, id: number) => getHeldSale(ctx.db, id), 'pos.sell');
on('pos.resume', (ctx, id: number) => resumeHeldSale(ctx.db, id, { id: ctx.user!.id, username: ctx.user!.username }), 'pos.sell');
on('pos.cancelHold', (ctx, id: number, reason: string) => {
  cancelHeldSale(ctx.db, id, reason, { id: ctx.user!.id, username: ctx.user!.username });
  return true;
}, 'pos.sell');
on('pos.quickPicks', (ctx, limit?: number) => posQuickPicks(ctx.db, limit ?? 24), 'pos.sell');
on('pos.favourites', (ctx) => listFavourites(ctx.db), 'pos.sell');
on('pos.toggleFavourite', (ctx, productId: number) => toggleFavourite(ctx.db, productId), 'pos.sell');
on('pos.creditNote', (ctx, input) => createCreditNote(ctx.db, { ...input, actor: { id: ctx.user!.id, username: ctx.user!.username } }), 'return.manage');
on('pos.exchange', (ctx, input) => createExchange(ctx.db, { ...input, actor: { id: ctx.user!.id, username: ctx.user!.username } }), 'return.manage');
on(
  'inventory.adjust',
  (ctx, input) =>
    adjustStock(ctx.db, { ...input, actor: ctx.user ? { id: ctx.user.id, username: ctx.user.username } : undefined }),
  'stock.adjust',
);
on(
  'inventory.writeOff',
  (ctx, input) =>
    writeOffStock(ctx.db, { ...input, actor: ctx.user ? { id: ctx.user.id, username: ctx.user.username } : undefined }),
  'stock.adjust',
);
on(
  'products.pickImage',
  async () => {
    const res = await dialog.showOpenDialog({
      title: 'প্রোডাক্ট ছবি নির্বাচন করুন',
      filters: [{ name: 'ছবি', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const src = res.filePaths[0];
    const stat = fs.statSync(src);
    if (stat.size > 3 * 1024 * 1024) throw new Error('ছবির আকার ৩ মেগাবাইটের কম হতে হবে।');
    const target = path.join(appPaths().imagesDir, `${Date.now()}-${path.basename(src).replace(/[^\w.\-]/g, '_')}`);
    fs.copyFileSync(src, target);
    return target;
  },
  'product.manage',
);

/* ------------------------------------------------------------------ */
/* POS & sales                                                        */
/* ------------------------------------------------------------------ */

on('pos.compute', (ctx, input) => requireCompute(ctx, input), 'pos.sell');
on(
  'pos.createSale',
  (ctx, input) => {
    if (input.orderDiscountValue > 0 && !hasPermission(ctx.user, 'pos.discount')) {
      throw new Error('ডিসকাউন্ট প্রয়োগের অনুমতি আপনার নেই।');
    }
    if (input.lines?.some((l: any) => l.unitPricePaisa) && !hasPermission(ctx.user, 'pos.price_edit')) {
      throw new Error('বিক্রয়ের সময় দাম পরিবর্তনের অনুমতি আপনার নেই।');
    }
    const result = createSale(ctx.db, { ...input, actor: { id: ctx.user!.id, username: ctx.user!.username } });
    return { ...result, sale: getSale(ctx.db, result.saleId) };
  },
  'pos.sell',
);
on('sales.list', (ctx, filter) => listSales(ctx.db, filter), 'report.view');
on('sales.get', (ctx, id: number) => getSale(ctx.db, id), 'report.view');
on('sales.byInvoice', (ctx, invoice: string) => {
  const row = ctx.db.prepare('SELECT id FROM sales WHERE invoice_no = ?').get(invoice) as { id: number } | undefined;
  return row ? getSale(ctx.db, row.id) : null;
}, 'report.view');
on(
  'sales.void',
  (ctx, id: number, reason: string) => {
    if (!ctx.user) throw new Error('লগইন করুন।');
    if (ctx.user.role !== 'admin') throw new Error('শুধুমাত্র অ্যাডমিন ইনভয়েস বাতিল করতে পারেন।');
    voidSale(ctx.db, id, reason, { id: ctx.user.id, username: ctx.user.username });
    return true;
  },
  'any',
);

on('print.receiptHtml', async (ctx, saleId: number, opts: { duplicate?: boolean } = {}) => {
  const sale = getSale(ctx.db, saleId);
  if (!sale) throw new Error('ইনভয়েস পাওয়া যায়নি।');
  const settings = getSettings(ctx.db);
  let logoDataUrl: string | null = null;
  if (settings.business_logo && fs.existsSync(settings.business_logo)) {
    const ext = path.extname(settings.business_logo).slice(1).toLowerCase();
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    logoDataUrl = `data:image/${mime};base64,${fs.readFileSync(settings.business_logo).toString('base64')}`;
  }
  return buildReceiptHtml({ sale, settings, logoDataUrl, duplicate: opts.duplicate });
}, 'report.view');

on('print.printers', async () => listPrinters(), 'any');
on(
  'print.print',
  async (ctx, saleId: number, opts: { deviceName?: string; duplicate?: boolean } = {}) => {
    const sale = getSale(ctx.db, saleId);
    if (!sale) throw new Error('ইনভয়েস পাওয়া যায়নি।');
    const settings = getSettings(ctx.db);
    let logoDataUrl: string | null = null;
    if (settings.business_logo && fs.existsSync(settings.business_logo)) {
      const ext = path.extname(settings.business_logo).slice(1).toLowerCase();
      logoDataUrl = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${fs.readFileSync(settings.business_logo).toString('base64')}`;
    }
    const html = buildReceiptHtml({ sale, settings, logoDataUrl, duplicate: opts.duplicate });
    const deviceName = opts.deviceName || settings.printer_name || undefined;
    const result = await printHtml(html, { widthMm: settings.receipt_width, deviceName });
    return result;
  },
  'pos.sell',
);

/* ------------------------------------------------------------------ */
/* Purchases                                                          */
/* ------------------------------------------------------------------ */

on('purchases.compute', (ctx, input) => computePurchase(ctx.db, input), 'purchase.manage');
on(
  'purchases.create',
  (ctx, input) => {
    const result = createPurchase(ctx.db, { ...input, actor: { id: ctx.user!.id, username: ctx.user!.username } });
    return { ...result, purchase: getPurchase(ctx.db, result.purchaseId) };
  },
  'purchase.manage',
);
on('purchases.list', (ctx, filter) => listPurchases(ctx.db, filter), 'purchase.manage');
on('purchases.get', (ctx, id: number) => getPurchase(ctx.db, id), 'purchase.manage');
on(
  'purchases.void',
  (ctx, id: number, reason: string) => {
    if (!ctx.user) throw new Error('লগইন করুন।');
    if (ctx.user.role !== 'admin') throw new Error('শুধুমাত্র অ্যাডমিন পারচেজ বাতিল করতে পারেন।');
    voidPurchase(ctx.db, id, reason, { id: ctx.user.id, username: ctx.user.username });
    return true;
  },
  'purchase.manage',
);

/* ------------------------------------------------------------------ */
/* Returns                                                            */
/* ------------------------------------------------------------------ */
on(
  'returns.createSaleReturn',
  (ctx, input) =>
    createSaleReturn(ctx.db, { ...input, actor: { id: ctx.user!.id, username: ctx.user!.username } }),
  'return.manage',
);
on(
  'returns.createPurchaseReturn',
  (ctx, input) =>
    createPurchaseReturn(ctx.db, { ...input, actor: { id: ctx.user!.id, username: ctx.user!.username } }),
  'return.manage',
);
on('returns.list', (ctx, filter) => listReturns(ctx.db, filter), 'return.manage');
on('returns.get', (ctx, id: number) => getReturn(ctx.db, id), 'return.manage');

/* ------------------------------------------------------------------ */
/* Customers & suppliers                                              */
/* ------------------------------------------------------------------ */

on('customers.list', (ctx, filter) => listCustomers(ctx.db, filter), 'customer.manage');
on(
  'customers.quick',
  (ctx, term: string) =>
    listCustomers(ctx.db, { search: term?.trim() || undefined, pageSize: 40, sort: 'name' }).rows.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      balance_paisa: c.balance_paisa,
      is_walkin: c.is_walkin,
    })),
  'any',
);
on('customers.get', (ctx, id: number) => getCustomer(ctx.db, id), 'customer.manage');
on('customers.statement', (ctx, id: number, from?: string, to?: string) => customerStatement(ctx.db, id, from, to), 'customer.manage');
on(
  'customers.create',
  (ctx, input) => createCustomer(ctx.db, input, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'customer.manage',
);
on(
  'customers.update',
  (ctx, id: number, input) => updateCustomer(ctx.db, id, input, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'customer.manage',
);
on(
  'customers.archive',
  (ctx, id: number, active: boolean) =>
    setCustomerActive(ctx.db, id, active, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'customer.manage',
);
on(
  'customers.receivePayment',
  (ctx, input) => receiveCustomerPayment(ctx.db, input, { id: ctx.user!.id, username: ctx.user!.username }),
  'customer.manage',
);

on('suppliers.list', (ctx, filter) => listSuppliers(ctx.db, filter), 'supplier.manage');
on('suppliers.get', (ctx, id: number) => getSupplier(ctx.db, id), 'supplier.manage');
on('suppliers.statement', (ctx, id: number, from?: string, to?: string) => supplierStatement(ctx.db, id, from, to), 'supplier.manage');
on(
  'suppliers.create',
  (ctx, input) => createSupplier(ctx.db, input, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'supplier.manage',
);
on(
  'suppliers.update',
  (ctx, id: number, input) => updateSupplier(ctx.db, id, input, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'supplier.manage',
);
on(
  'suppliers.archive',
  (ctx, id: number, active: boolean) =>
    setSupplierActive(ctx.db, id, active, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'supplier.manage',
);
on(
  'suppliers.pay',
  (ctx, input) => paySupplier(ctx.db, input, { id: ctx.user!.id, username: ctx.user!.username }),
  'supplier.manage',
);
on(
  'suppliers.delete',
  (ctx, id: number) => deleteSupplier(ctx.db, id, ctx.user ? { id: ctx.user.id, username: ctx.user.username } : null),
  'supplier.manage',
);

/* ------------------------------------------------------------------ */
/* Payments                                                           */
/* ------------------------------------------------------------------ */

on('payments.list', (ctx, filter) => listPayments(ctx.db, filter), 'report.view');
on(
  'payments.reverse',
  (ctx, id: number, reason: string) => {
    if (!ctx.user) throw new Error('লগইন করুন।');
    if (ctx.user.role !== 'admin') throw new Error('পেমেন্ট বাতিলের অনুমতি শুধু অ্যাডমিনের আছে।');
    return reversePayment(ctx.db, id, reason, { id: ctx.user.id, username: ctx.user.username });
  },
  'any',
);

/* ------------------------------------------------------------------ */
/* Expenses                                                           */
/* ------------------------------------------------------------------ */

on(
  'expenses.create',
  (ctx, input) => createExpense(ctx.db, input, { id: ctx.user!.id, username: ctx.user!.username }),
  'expense.manage',
);
on(
  'expenses.update',
  (ctx, id: number, input) => updateExpense(ctx.db, id, input, { id: ctx.user!.id, username: ctx.user!.username }),
  'expense.manage',
);
on(
  'expenses.void',
  (ctx, id: number, reason: string) => voidExpense(ctx.db, id, reason, { id: ctx.user!.id, username: ctx.user!.username }),
  'expense.manage',
);
on('expenses.list', (ctx, filter) => listExpenses(ctx.db, filter), 'expense.manage');
on('expenses.total', (ctx, from?: string, to?: string) => expenseTotal(ctx.db, from, to), 'expense.manage');

/* ------------------------------------------------------------------ */
/* Cash register                                                      */
/* ------------------------------------------------------------------ */

on(
  'cash.current',
  (ctx) => {
    if (!ctx.user) throw new Error('লগইন করুন।');
    const open = ctx.db
      .prepare("SELECT * FROM cash_sessions WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1")
      .get(ctx.user.id) as { id: number } | undefined;
    return {
      session: open ?? null,
      in_hand: cashInHandPaisa(ctx.db),
      totals: open ? sessionTotals(ctx.db, open.id) : null,
    };
  },
  'cash.manage',
);
on(
  'cash.open',
  (ctx, openingCash: number, note?: string) => {
    if (!ctx.user) throw new Error('লগইন করুন।');
    return openCashSession(ctx.db, { userId: ctx.user.id, openingCash, note, actor: { id: ctx.user.id, username: ctx.user.username } });
  },
  'cash.manage',
);
on(
  'cash.close',
  (ctx, countedCash: number, note?: string) => {
    if (!ctx.user) throw new Error('লগইন করুন।');
    return closeCashSession(ctx.db, { userId: ctx.user.id, countedCash, note, actor: { id: ctx.user.id, username: ctx.user.username } });
  },
  'cash.manage',
);
on('cash.sessions', (ctx, filter) => listSessions(ctx.db, filter), 'cash.manage');
on('cash.movements', (ctx, sessionId: number) => listCashMovements(ctx.db, sessionId), 'cash.manage');
on('cash.sessionTotals', (ctx, sessionId: number) => sessionTotals(ctx.db, sessionId), 'cash.manage');

/* ------------------------------------------------------------------ */
/* Reports & dashboard                                                */
/* ------------------------------------------------------------------ */

on('reports.run', (ctx, id: ReportId, filter) => runReport(ctx.db, id, filter), 'report.view');
on(
  'reports.exportCsv',
  async (ctx, id: ReportId, filter) => {
    const report = runReport(ctx.db, id, filter);
    const csv = tableToCsv({ name: report.title, columns: report.columns, rows: report.rows, totals: report.totals });
    const target = await saveDialog(`${report.title}-${new Date().toISOString().slice(0, 10)}.csv`, 'csv');
    if (!target) return null;
    fs.writeFileSync(target, csv, 'utf8');
    return target;
  },
  'report.view',
);
on(
  'reports.exportXlsx',
  async (ctx, id: ReportId, filter) => {
    const report = runReport(ctx.db, id, filter);
    const bytes = tablesToXlsx([{ name: report.title, columns: report.columns, rows: report.rows, totals: report.totals }]);
    const target = await saveDialog(`${report.title}-${new Date().toISOString().slice(0, 10)}.xlsx`, 'xlsx');
    if (!target) return null;
    fs.writeFileSync(target, Buffer.from(bytes));
    return target;
  },
  'report.view',
);
on(
  'reports.exportPdf',
  async (ctx, id: ReportId, filter) => {
    const report = runReport(ctx.db, id, filter);
    const settings = getSettings(ctx.db);
    const html = reportHtml(report, settings);
    const target = await saveDialog(`${report.title}-${new Date().toISOString().slice(0, 10)}.pdf`, 'pdf');
    if (!target) return null;
    await htmlToPdf(html, target);
    return target;
  },
  'report.view',
);
on('dashboard.stats', (ctx) => dashboardStats(ctx.db), 'report.view');
on('dashboard.recent', (ctx) => recentActivity(ctx.db, 8), 'report.view');
on('dashboard.activity', (ctx) => activityFeed(ctx.db, 12), 'report.view');
on('dashboard.trends', (ctx) => trends(ctx.db), 'report.view');
on('dashboard.series', (ctx, preset, from?, to?) => presetSeries(ctx.db, preset, from, to), 'report.view');
on('search.everything', (ctx, term: string) => searchEverything(ctx.db, term), 'product.view');
on('audit.list', (ctx, filter) => listAudit(ctx.db, filter), 'audit.view');

/* ------------------------------------------------------------------ */
/* Backup & maintenance                                               */
/* ------------------------------------------------------------------ */

on('backup.list', (ctx) => listBackups(ctx.db), 'backup.manage');
on(
  'backup.create',
  async (ctx) => {
    if (!ctx.user) throw new Error('লগইন করুন।');
    const settings = getSettings(ctx.db);
    let target: string | undefined;
    const choice = await dialog.showMessageBox({
      type: 'question',
      title: 'ব্যাকআপ',
      message: 'ব্যাকআপ কোথায় সংরক্ষণ করবেন?',
      buttons: ['ডিফল্ট ফোল্ডার', 'অন্য ফোল্ডার নির্বাচন', 'বাতিল'],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice.response === 2) return null;
    if (choice.response === 1) {
      const dir = await dialog.showOpenDialog({ title: 'ব্যাকআপ ফোল্ডার', properties: ['openDirectory', 'createDirectory'] });
      if (dir.canceled || !dir.filePaths[0]) return null;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      target = path.join(dir.filePaths[0], `sauda-${stamp}.saudabak`);
    }
    const result = createBackup(ctx.db, {
      dataDir: settings.auto_backup_dir || appPaths().backupsDir,
      targetPath: target,
      kind: 'manual',
      appVersion: PRODUCT_VERSION,
      actor: { id: ctx.user.id, username: ctx.user.username },
    });
    return result;
  },
  'backup.manage',
);
on(
  'backup.scan',
  async () => {
    const dir = await dialog.showOpenDialog({
      title: 'ব্যাকআপ ফাইল নির্বাচন করুন',
      filters: [{ name: 'Sauda Backup', extensions: ['saudabak', 'db', 'sqlite'] }],
      properties: ['openFile'],
    });
    if (dir.canceled || !dir.filePaths[0]) return null;
    return { path: dir.filePaths[0], validation: validateBackup(dir.filePaths[0]) };
  },
  'backup.manage',
);
on('backup.validate', (ctx, filePath: string) => validateBackup(filePath), 'backup.manage');
on(
  'backup.restore',
  async (ctx, filePath: string) => {
    if (!ctx.user) throw new Error('লগইন করুন।');
    if (ctx.user.role !== 'admin') throw new Error('শুধুমাত্র অ্যাডমিন রিস্টোর করতে পারেন।');
    const validation = validateBackup(filePath);
    if (!validation.ok) throw new Error(validation.message);
    const response = await dialog.showMessageBox({
      type: 'warning',
      title: 'রিস্টোর নিশ্চিত করুন',
      message: 'বর্তমান সব ডেটা প্রতিস্থাপিত হবে।\nরিস্টোরের আগে বর্তমান ডেটার একটি নিরাপত্তা ব্যাকআপ তৈরি হবে।',
      detail: `ব্যাকআপ: ${path.basename(filePath)}\nব্যবসা: ${validation.business_name || 'অজানা'}\nবিক্রয়: ${validation.counts.sales} টি`,
      buttons: ['রিস্টোর করুন', 'বাতিল'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response.response !== 0) return null;
    // `restoreBackup` closes the live handle, so the session must always get a
    // working connection back — even when the restore itself fails.
    try {
      return restoreBackup(ctx.db, {
        backupPath: filePath,
        dataDir: appPaths().backupsDir,
        livePath: appPaths().dbPath,
        appVersion: PRODUCT_VERSION,
        actor: { id: ctx.user.id, username: ctx.user.username },
      });
    } finally {
      ctx.reopenDb();
    }
  },
  'backup.manage',
);
on(
  'backup.autoCheck',
  (ctx) => {
    if (!shouldAutoBackup(ctx.db)) return null;
    const settings = getSettings(ctx.db);
    const result = createBackup(ctx.db, {
      dataDir: settings.auto_backup_dir || appPaths().backupsDir,
      kind: 'auto',
      appVersion: PRODUCT_VERSION,
      note: 'স্বয়ংক্রিয় ব্যাকআপ',
    });
    pruneBackups(ctx.db, settings.backup_keep_count);
    return result;
  },
  'backup.manage',
);
on(
  'settings.pickLogo',
  async () => {
    const res = await dialog.showOpenDialog({
      title: 'দোকানের লোগো নির্বাচন করুন',
      filters: [{ name: 'ছবি', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const src = res.filePaths[0];
    if (fs.statSync(src).size > 2 * 1024 * 1024) throw new Error('লোগোর আকার ২ মেগাবাইটের কম হতে হবে।');
    const target = path.join(appPaths().dataDir, `logo-${Date.now()}${path.extname(src).toLowerCase()}`);
    fs.copyFileSync(src, target);
    return target;
  },
  'settings.manage',
);

on(
  'print.test',
  async (ctx) => {
    const settings = getSettings(ctx.db);
    const html = `<!doctype html><html lang="bn"><head><meta charset="utf-8"><style>
      @page { size: ${settings.receipt_width}mm auto; margin: 2mm; }
      body { font-family: 'Nirmala UI','Noto Sans Bengali','Segoe UI',sans-serif; font-size: ${settings.receipt_font_size}px; }
      h1 { font-size: 14px; margin: 0 0 4px; text-align: center; }
      .c { text-align: center; } .r { display: flex; justify-content: space-between; }
      hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; }
    </style></head><body>
      <h1>প্রিন্টার টেস্ট</h1>
      <div class="c">${escapeHtml(settings.business_name || PRODUCT_NAME)}</div>
      <hr/>
      <div class="r"><span>তারিখ</span><span>${new Date().toLocaleString('en-GB')}</span></div>
      <div class="r"><span>রিসিট প্রস্থ</span><span>${settings.receipt_width} মিমি</span></div>
      <div class="r"><span>ফন্ট</span><span>${settings.receipt_font_size}px</span></div>
      <hr/>
      <div class="r"><span>চাল ৫ কেজি × ২</span><span>৳ ১,৩০০.০০</span></div>
      <div class="r"><span>সয়াবিন তেল ১ লি × ১</span><span>৳ ১৭৫.০০</span></div>
      <hr/>
      <div class="r"><strong>সর্বমোট</strong><strong>৳ ১,৪৭৫.০০</strong></div>
      <div class="c" style="margin-top:6px">ধন্যবাদ • আবার আসবেন</div>
      <div class="c" style="font-size:9px">${PRODUCT_NAME} v${PRODUCT_VERSION} — প্রিন্টার ঠিক আছে</div>
    </body></html>`;
    const result = await printHtml(html, {
      widthMm: settings.receipt_width,
      deviceName: settings.printer_name || undefined,
    });
    return result;
  },
  'settings.manage',
);

on('reports.catalog', () => REPORT_CATALOG, 'report.view');

on(
  'print.labels',
  async (ctx, productIds: number[], copies = 1) => {
    const ids = (productIds ?? []).filter((n) => Number.isInteger(n));
    if (!ids.length) throw new Error('লেবেল প্রিন্টের জন্য প্রোডাক্ট নির্বাচন করুন।');
    const settings = getSettings(ctx.db);
    const labels = listProductLabels(ctx.db, ids);
    if (!labels.length) throw new Error('নির্বাচিত প্রোডাক্ট পাওয়া যায়নি।');
    const perCopy = Math.min(50, Math.max(1, Math.round(copies)));
    const cards: string[] = [];
    for (const label of labels) {
      const barcodeSvg = label.code ? code128Svg(label.code, { height: 34, moduleWidth: 1.25, margin: 2 }) : '';
      const qrMarkup = label.qr_code ? qrSvg(label.qr_code, { sizePx: 74, margin: 1 }) : '';
      for (let i = 0; i < perCopy; i++) {
        cards.push(`<div class="label">
          <div class="l-name">${escapeHtml(label.name)}</div>
          <div class="l-price">${formatPaisa(label.price_paisa)}${label.unit ? ` / ${escapeHtml(label.unit)}` : ''}</div>
          <div class="l-codes">
            ${qrMarkup ? `<div class="l-qr">${qrMarkup}</div>` : ''}
            <div class="l-barcode">${barcodeSvg || `<div class="l-code">${escapeHtml(label.code ?? '')}</div>`}</div>
          </div>
        </div>`);
      }
    }
    const html = `<!doctype html><html lang="bn"><head><meta charset="utf-8"><style>
      @page { size: 50mm 30mm; margin: 0; }
      body { margin: 0; font-family: 'Nirmala UI','Noto Sans Bengali','Segoe UI',sans-serif; }
      .label { width: 50mm; height: 30mm; padding: 2mm; box-sizing: border-box; display: flex; flex-direction: column;
               align-items: center; justify-content: center; gap: 1mm; page-break-after: always; text-align: center; }
      .l-name { font-size: 9pt; font-weight: 700; line-height: 1.15; max-height: 8mm; overflow: hidden; }
      .l-price { font-size: 10.5pt; font-weight: 800; }
      .l-code { font-size: 7.5pt; letter-spacing: .5px; font-family: ui-monospace, monospace; }
      .l-codes { display: flex; align-items: center; justify-content: center; gap: 1.5mm; width: 100%; }
      .l-qr svg { width: 9mm; height: 9mm; }
      .l-barcode { flex: 1; min-width: 0; display: flex; justify-content: center; }
      .l-barcode svg { max-width: 100%; height: 7.5mm; }
    </style></head><body>${cards.join('')}</body></html>`;
    const deviceName = settings.printer_name || undefined;
    return printHtml(html, { widthMm: 50, deviceName, pageHeightMm: 30 });
  },
  'product.view',
);

on(
  'app.integrity',
  (ctx) => {
    const check = integrityCheck(ctx.db);
    const repaired = check.ok ? null : repairDatabase(ctx.db);
    return { ...check, repaired };
  },
  'settings.manage',
);
on('app.info', (ctx) =>
  appInfo(ctx.db, {
    dbPath: appPaths().dbPath,
    dataDir: appPaths().dataDir,
    logsDir: appPaths().logsDir,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
  }),
  'any',
);
on('app.logs', () => readRecentLogs(), 'settings.manage');
on(
  'app.openDataFolder',
  async () => {
    await shell.openPath(appPaths().dataDir);
    return true;
  },
  'backup.manage',
);
on(
  'app.openPath',
  async (_ctx, target: string) => {
    const resolved = path.resolve(target);
    const allowed = [appPaths().backupsDir, appPaths().exportsDir, appPaths().dataDir, app.getPath('documents')];
    if (!allowed.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
      throw new Error('অননুমোদিত পাথ।');
    }
    const err = await shell.openPath(resolved);
    if (err) throw new Error(err);
    return true;
  },
  'backup.manage',
);
on(
  'imports.preview',
  async (ctx, kind) => {
    const file = await pickCsv();
    if (!file) return null;
    return { file, preview: previewImport(ctx.db, kind, fs.readFileSync(file, 'utf8')) };
  },
  'product.manage',
);
on(
  'imports.commit',
  (ctx, kind, content: string, options) =>
    commitImport(ctx.db, kind, content, options ?? {}, { id: ctx.user!.id, username: ctx.user!.username }),
  'product.manage',
);
on(
  'imports.readFile',
  async (_ctx, filePath: string) => {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) throw new Error('ফাইল পাওয়া যায়নি।');
    const stat = fs.statSync(resolved);
    if (stat.size > 20 * 1024 * 1024) throw new Error('ফাইল ২০ মেগাবাইটের কম হতে হবে।');
    return fs.readFileSync(resolved, 'utf8');
  },
  'product.manage',
);
on(
  'imports.template',
  async (_ctx, kind) => {
    const header =
      kind === 'products'
        ? 'name,sku,category,unit,purchase_price,sale_price,opening_stock,min_stock,barcode'
        : kind === 'customers'
          ? 'name,phone,address,opening_balance'
          : 'name,company,phone,email,address,opening_balance';
    const target = await saveDialog(`${kind}-import-template.csv`, 'csv');
    if (!target) return null;
    fs.writeFileSync(target, `\uFEFF${header}\r\n`, 'utf8');
    return target;
  },
  'product.manage',
);
on('meta.permissions', () => ALL_PERMISSIONS, 'any');

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function requireCompute(ctx: AppContext, input: any) {
  return computeSale(ctx.db, {
    ...input,
    actor: { id: ctx.user?.id ?? 0, username: ctx.user?.username ?? 'system' },
  });
}

async function saveDialog(defaultName: string, ext: string): Promise<string | null> {
  const exportsDir = appPaths().exportsDir;
  if (!fs.existsSync(exportsDir)) fs.mkdirSync(exportsDir, { recursive: true });
  const res = await dialog.showSaveDialog({
    title: 'সংরক্ষণ করুন',
    defaultPath: path.join(exportsDir, defaultName),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (res.canceled || !res.filePath) return null;
  return res.filePath;
}

async function pickCsv(): Promise<string | null> {
  const res = await dialog.showOpenDialog({
    title: 'CSV ফাইল নির্বাচন করুন',
    filters: [
      { name: 'CSV', extensions: ['csv', 'txt'] },
      { name: 'সব ফাইল', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
}

function reportHtml(report: any, settings: AppSettings): string {
  const esc = (s: unknown) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const cell = (col: any, row: any) => {
    const v = row[col.key];
    if (v === null || v === undefined || v === '') return '';
    if (col.format === 'money') return formatPaisa(Number(v));
    if (col.format === 'qty') return (Number(v) / 1000).toFixed(2);
    return esc(v);
  };
  const head = report.columns.map((c: any) => `<th>${esc(c.label)}</th>`).join('');
  const body = report.rows
    .map((row: any) => `<tr>${report.columns.map((c: any) => `<td class="${c.format === 'money' || c.format === 'qty' ? 'num' : ''}">${cell(c, row)}</td>`).join('')}</tr>`)
    .join('');
  const totals = report.totals && Object.keys(report.totals).length
    ? `<tr class="total">${report.columns
        .map((c: any, i: number) => {
          const v = report.totals[c.key];
          if (i === 0 && v === undefined) return '<td>সর্বমোট</td>';
          if (v === undefined) return '<td></td>';
          return `<td class="num">${c.format === 'money' ? formatPaisa(Number(v)) : c.format === 'qty' ? (Number(v) / 1000).toFixed(2) : esc(v)}</td>`;
        })
        .join('')}</tr>`
    : '';
  return `<!doctype html><html lang="bn"><head><meta charset="utf-8"><style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: 'Nirmala UI','Noto Sans Bengali','Segoe UI',sans-serif; font-size: 10px; color:#111; }
  h1 { font-size: 16px; margin: 0 0 2px; } .sub { color:#555; margin-bottom:8px; font-size:10px; }
  .biz { font-size: 18px; font-weight: 800; margin-bottom:2px }
  table { width:100%; border-collapse: collapse; }
  th { text-align:left; background:#f1f5f9; border-bottom:1px solid #94a3b8; padding:4px 5px; font-size:9.5px }
  td { padding:3px 5px; border-bottom:1px solid #e2e8f0; vertical-align:top }
  td.num, th.num { text-align:right }
  tr.total td { font-weight:700; border-top:1px solid #475569 }
  thead { display: table-header-group }
  </style></head><body>
  <div class="biz">${esc(settings.business_name || '')}</div>
  <div class="sub">${esc(settings.business_address || '')} ${settings.business_phone ? '• ' + esc(settings.business_phone) : ''}</div>
  <h1>${esc(report.title)}</h1>
  <div class="sub">${esc(report.subtitle)} — তৈরি: ${new Date().toLocaleString('en-GB')}</div>
  <table><thead><tr>${head}</tr></thead><tbody>${body}${totals}</tbody></table>
  <p class="sub" style="margin-top:10px">${esc(PRODUCT_NAME)} v${PRODUCT_VERSION} দ্বারা তৈরি রিপোর্ট।</p>
  </body></html>`;
}

/* ------------------------------------------------------------------ */
/* Dispatcher                                                         */
/* ------------------------------------------------------------------ */

export interface InvokeResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

/**
 * Routes the shop must be able to reach before the licence is activated:
 * first-run setup, activation itself, logging in and diagnostics.
 */
const LICENSE_EXEMPT_PREFIXES = ['license.', 'setup.', 'auth.', 'app.', 'meta.'];

/** Activation state is expensive (hardware probe), so it is cached per DB handle. */
const licenseCache = new WeakMap<object, { state: ReturnType<typeof getActivationState>; at: number }>();

export function invalidateLicenseCache(db: object | null | undefined): void {
  if (db) licenseCache.delete(db);
}

function licenseGate(ctx: AppContext, method: string): void {
  if (!app.isPackaged && process.env.SAUDA_SKIP_LICENSE === '1') return;
  if (LICENSE_EXEMPT_PREFIXES.some((prefix) => method.startsWith(prefix))) return;
  if (!ctx.db) return;
  const now = Date.now();
  let entry = licenseCache.get(ctx.db);
  if (!entry || now - entry.at > 60_000) {
    entry = { state: getActivationState(ctx.db), at: now };
    licenseCache.set(ctx.db, entry);
  }
  if (!entry.state.activated) {
    const err = new Error(entry.state.message || 'লাইসেন্স সক্রিয় নয় — অ্যাক্টিভেশন স্ক্রিনে লাইসেন্স দিন।') as Error & {
      code?: string;
    };
    err.code = 'LICENSE_REQUIRED';
    throw err;
  }
}

export async function invokeRoute(ctx: AppContext, method: string, args: any[]): Promise<InvokeResult> {
  const route = routes[method];
  if (!route) return { ok: false, error: `অজানা অনুরোধ: ${method}`, code: 'NOT_FOUND' };
  try {
    if (route.perm && route.perm !== 'any' && !route.public) {
      if (!ctx.user) return { ok: false, error: 'আপনি লগইন করা নেই।', code: 'AUTH_REQUIRED' };
      requirePermission(ctx.user, route.perm);
    }
    licenseGate(ctx, method);
    const data = await route.fn(ctx, ...args);
    return { ok: true, data };
  } catch (err) {
    const e = err as Error & { code?: string };
    writeLog('error', `ipc ${method} failed: ${e.message}`, e);
    return { ok: false, error: e.message || 'অজানা ত্রুটি', code: e.code ?? 'ERROR' };
  }
}

export function routeNames(): string[] {
  return Object.keys(routes).sort();
}

export function makeWindowFocused(window: BrowserWindow | null) {
  if (window && !window.isDestroyed()) window.focus();
}
