import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildLicenseDocumentHtml,
  buildReportHtml,
  PRODUCT_VERSION,
  verifyLicense,
  type BrandInfo,
  type LicensePayload,
} from '@sauda/core';
import {
  EDITIONS,
  FEATURES,
  REPORTS,
  appendLedger,
  buildBackup,
  createCustomer,
  customerById,
  describePrivateKey,
  licenseById,
  licenseState,
  licensesForCustomer,
  listCustomers,
  listLedger,
  listLicenses,
  parseBackup,
  parseDeviceRequest,
  readStore,
  recordIssuedLicense,
  reportRows,
  revokeLicense,
  revokedIds as ledgerRevokedIds,
  signLicense,
  summarize,
  toLicenseFile,
  updateCustomer,
  verifyLicenseFile,
  writeStore,
  type BackupBundle,
  type Customer,
  type DeviceRequest,
  type IssueInput,
  type LicenseRecord,
  type LedgerEntry,
  type Store,
} from './domain.js';
import { htmlToPdf, openPreview, printHtml } from './printing.js';

/* ------------------------------------------------------------------ */
/* Paths + config                                                      */
/* ------------------------------------------------------------------ */

interface AppConfig {
  keyPath: string | null;
  lastDir: string | null;
}

const userData = () => app.getPath('userData');
const configPath = () => path.join(userData(), 'generator-config.json');
const storePath = () => path.join(userData(), 'licenses-admin.json');
const ledgerPath = () => path.join(userData(), 'issue-ledger.jsonl');

function readConfig(): AppConfig {
  try {
    return { keyPath: null, lastDir: null, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
  } catch {
    return { keyPath: null, lastDir: null };
  }
}

function writeConfig(patch: Partial<AppConfig>): AppConfig {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function loadStore(): Store {
  return readStore(storePath());
}

function saveStore(store: Store): void {
  writeStore(storePath(), store);
}

function ledger(): LedgerEntry[] {
  return listLedger(ledgerPath());
}

function revokedIds(): string[] {
  return ledgerRevokedIds(ledgerPath());
}

/* ------------------------------------------------------------------ */
/* Signing key (never persisted, never returned in full)               */
/* ------------------------------------------------------------------ */

function loadPrivateKeyB64(filePath: string): { b64: string; publicKeyB64: string; keyId: string } {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  let b64 = raw;
  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw) as Record<string, string>;
    b64 = parsed.privateKey ?? parsed.private_key ?? parsed.privateKeyPkcs8Base64 ?? '';
  } else if (raw.includes('-----BEGIN')) {
    b64 = raw.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');
  }
  b64 = b64.replace(/\s+/g, '');
  if (!b64) throw new Error('ফাইলে কোনো প্রাইভেট কী পাওয়া যায়নি।');
  const { keyId, publicKeyB64 } = describePrivateKey(b64);
  return { b64, publicKeyB64, keyId };
}

function currentKey(): { b64: string; publicKeyB64: string; keyId: string; path: string } | null {
  const config = readConfig();
  if (!config.keyPath || !fs.existsSync(config.keyPath)) return null;
  try {
    return { ...loadPrivateKeyB64(config.keyPath), path: config.keyPath };
  } catch {
    return null;
  }
}

function requireKey() {
  const key = currentKey();
  if (!key) throw new Error('সাইনিং প্রাইভেট কী লোড করা হয়নি — সেটি লোড না করে লাইসেন্স ইস্যু করা যাবে না।');
  return key;
}

function brand(): BrandInfo {
  const store = loadStore();
  return {
    name: 'MERQO • লাইসেন্স প্রশাসন',
    address: 'Sauda Retail Suite লাইসেন্সিং',
    email: 'merqoonline@gmail.com',
    footer: store.settings.company_footer,
    documentFooter: 'এই নথিটি Sauda License Generator থেকে তৈরি — স্বাক্ষরিত লাইসেন্স পেলোড অপরিবর্তনযোগ্য।',
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function safeFileStem(value: string, fallback = 'license'): string {
  const cleaned = String(value ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} ._-]/gu, '')
    .trim()
    .slice(0, 48);
  return cleaned || fallback;
}

/**
 * Guard for every route that accepts a path from the renderer: the file must
 * exist, be a regular file, have an allowed extension and stay within a sane size.
 * This keeps a compromised renderer from turning a "restore" button into an
 * arbitrary-file reader on the operator's machine.
 */
function requireReadableFile(raw: string, extensions: string[], maxBytes = 8 * 1024 * 1024): string {
  const resolved = path.resolve(String(raw ?? ''));
  if (!raw || !fs.existsSync(resolved)) throw new Error('ফাইলটি পাওয়া যায়নি।');
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error('এটি ফাইল নয়।');
  if (stat.size > maxBytes) throw new Error('ফাইলটি অনুমোদিত আকারের চেয়ে বড়।');
  const ext = path.extname(resolved).toLowerCase();
  if (extensions.length && !extensions.includes(ext)) {
    throw new Error(`শুধু এই ধরনের ফাইল চলে: ${extensions.join(', ')}`);
  }
  return resolved;
}

function toIssueInput(input: Partial<IssueInput>): IssueInput {
  return {
    org: String(input.org ?? ''),
    owner: input.owner ? String(input.owner) : '',
    phone: input.phone ? String(input.phone) : '',
    email: input.email ? String(input.email) : '',
    address: input.address ? String(input.address) : '',
    edition: (input.edition ?? 'standard') as IssueInput['edition'],
    expiresAt: input.expiresAt ?? null,
    maxDevices: Number(input.maxDevices ?? 1),
    features: Array.isArray(input.features) ? input.features.map(String) : [],
    note: input.note ?? null,
  };
}

function ledgerEntryFor(
  record: LicenseRecord,
  action: LedgerEntry['action'],
  extra: { reason?: string | null; file?: string | null; replaces?: string | null } = {},
): LedgerEntry {
  return appendLedger(ledgerPath(), {
    license_id: record.license_id,
    org: record.org,
    owner: record.owner,
    edition: record.edition,
    expires_at: record.expires_at,
    max_devices: record.max_devices,
    device_hash: record.fingerprint || null,
    key_id: record.key_id,
    action,
    replaces: extra.replaces ?? record.replaces,
    reason: extra.reason ?? null,
    file: extra.file ?? record.file_path,
    customer_id: record.customer_id,
  });
}

async function saveLicenseDialog(defaultName: string, body: string): Promise<string | null> {
  const config = readConfig();
  const res = await dialog.showSaveDialog({
    title: 'লাইসেন্স ফাইল সংরক্ষণ করুন',
    defaultPath: path.join(config.lastDir ?? app.getPath('documents'), defaultName),
    filters: [{ name: 'Sauda License', extensions: ['sauda'] }],
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, body, 'utf8');
  writeConfig({ lastDir: path.dirname(res.filePath) });
  return res.filePath;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

type Route = (event: unknown, ...args: any[]) => unknown | Promise<unknown>;

/* ------------------------------------------------------------------ */
/* Trust boundary: which page is allowed to call privileged routes     */
/* ------------------------------------------------------------------ */

/**
 * The renderer is the only content allowed to talk to this process. In a packaged
 * build that is the bundled `renderer/index.html`; during development it is the
 * Vite server on localhost. Everything else — a remote URL, a redirect, an iframe
 * on another origin, a `data:` document — is refused before any route runs.
 */
let trustedRendererUrl = '';

function rendererFileUrl(): string {
  const file = path.join(__dirname, '..', 'renderer', 'index.html');
  return pathToFileUrl(file);
}

function pathToFileUrl(file: string): string {
  const resolved = path.resolve(file).replace(/\\/g, '/');
  return `file:///${resolved.replace(/^\//, '')}`.replace(/ /g, '%20');
}

function isTrustedSender(event: unknown): boolean {
  const frameUrl = (event as { senderFrame?: { url?: string } } | undefined)?.senderFrame?.url;
  if (!frameUrl) return false;
  if (!trustedRendererUrl) return false;
  if (frameUrl === trustedRendererUrl) return true;
  // Hash/query variants of the same document are still our own file.
  try {
    const frame = new URL(frameUrl);
    const trusted = new URL(trustedRendererUrl);
    if (trusted.protocol === 'file:') return frame.protocol === 'file:' && frame.pathname === trusted.pathname;
    return frame.origin === trusted.origin;
  } catch {
    return false;
  }
}

const routes: Record<string, Route> = {
  'app.info': () => ({
    product: 'Sauda License Generator',
    appVersion: PRODUCT_VERSION,
    generatorVersion: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    userData: userData(),
    storePath: storePath(),
    ledgerPath: ledgerPath(),
  }),

  /* ---------------- settings ---------------- */
  'settings.get': () => loadStore().settings,
  'settings.update': (_e, patch: Record<string, unknown>) => {
    const store = loadStore();
    const allowed = ['theme', 'admin_name', 'default_edition', 'default_expiry_days', 'company_footer'] as const;
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        (store.settings as unknown as Record<string, unknown>)[key] = patch[key];
      }
    }
    if (!['light', 'dark'].includes(store.settings.theme)) store.settings.theme = 'light';
    saveStore(store);
    return store.settings;
  },

  /* ---------------- key ---------------- */
  'key.status': () => {
    const key = currentKey();
    if (!key) return { loaded: false };
    // Only public material leaves the main process.
    return { loaded: true, keyId: key.keyId, publicKeyB64: key.publicKeyB64, path: key.path };
  },
  'key.load': async () => {
    const res = await dialog.showOpenDialog({
      title: 'সাইনিং প্রাইভেট কী নির্বাচন করুন',
      filters: [
        { name: 'Key', extensions: ['txt', 'pem', 'json', 'key'] },
        { name: 'সব ফাইল', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const key = loadPrivateKeyB64(res.filePaths[0]);
    writeConfig({ keyPath: res.filePaths[0], lastDir: path.dirname(res.filePaths[0]) });
    return { loaded: true, keyId: key.keyId, publicKeyB64: key.publicKeyB64, path: res.filePaths[0] };
  },
  'key.clear': () => {
    writeConfig({ keyPath: null });
    return { loaded: false };
  },
  /* ---------------- customers ---------------- */
  'customers.list': (_e, filter: { q?: string; activeOnly?: boolean } = {}) => {
    const store = loadStore();
    return listCustomers(store, filter).map((c) => {
      const list = licensesForCustomer(store, c.id);
      return {
        ...c,
        license_count: list.length,
        active_count: list.filter((l) => licenseState(l) === 'active').length,
      };
    });
  },
  'customers.get': (_e, id: string) => {
    const store = loadStore();
    const customer = customerById(store, id);
    if (!customer) throw new Error('কাস্টমার পাওয়া যায়নি।');
    return { customer, licenses: licensesForCustomer(store, id) };
  },
  'customers.create': (_e, input: Parameters<typeof createCustomer>[1]) => {
    const store = loadStore();
    const customer = createCustomer(store, input);
    saveStore(store);
    return customer;
  },
  'customers.update': (_e, id: string, input: Parameters<typeof updateCustomer>[2]) => {
    const store = loadStore();
    const customer = updateCustomer(store, id, input);
    saveStore(store);
    return customer;
  },

  /* ---------------- device request ---------------- */
  'device.import': async () => {
    const config = readConfig();
    const res = await dialog.showOpenDialog({
      title: 'ডিভাইস রিকোয়েস্ট ফাইল খুলুন',
      defaultPath: config.lastDir ?? undefined,
      filters: [
        { name: 'Sauda Device Request', extensions: ['sauda-device', 'json'] },
        { name: 'সব ফাইল', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const content = fs.readFileSync(res.filePaths[0], 'utf8');
    const request = parseDeviceRequest(content);
    writeConfig({ lastDir: path.dirname(res.filePaths[0]) });
    return { ...request, file: res.filePaths[0] };
  },
  'device.parse': (_e, content: string) => parseDeviceRequest(String(content ?? '')),

  /* ---------------- issuance ---------------- */
  'license.issue': async (
    _e,
    args: {
      device: DeviceRequest;
      customerId: string | null;
      issue: Partial<IssueInput>;
      save?: boolean;
    },
  ) => {
    const key = requireKey();
    const store = loadStore();
    if (args.customerId && !customerById(store, args.customerId)) throw new Error('কাস্টমার পাওয়া যায়নি।');
    const result = signLicense({
      device: args.device,
      issue: toIssueInput(args.issue),
      privateKeyB64: key.b64,
      generatorVersion: app.getVersion(),
    });
    const record = recordIssuedLicense(store, {
      result,
      customerId: args.customerId,
      filePath: null,
      note: args.issue.note ?? null,
    });
    let filePath: string | null = null;
    if (args.save !== false) {
      filePath = await saveLicenseDialog(
        `${safeFileStem(record.org)}-${record.license_id.slice(-6)}.sauda`,
        toLicenseFile(record, { customer: args.customerId ? customerById(store, args.customerId)?.name ?? null : null }),
      );
      record.file_path = filePath;
    }
    saveStore(store);
    ledgerEntryFor(record, 'issued', { file: filePath });
    return { record, payload: result.payload, licenseKey: result.licenseKey, filePath, check: result.check };
  },

  'license.reissue': async (
    _e,
    args: {
      device: DeviceRequest;
      previousLicenseId: string;
      issue: Partial<IssueInput>;
      reason: string;
      save?: boolean;
    },
  ) => {
    const reason = String(args.reason ?? '').trim();
    if (!reason) throw new Error('রি-ইস্যুর কারণ লিখতে হবে — এটি অডিটে সংরক্ষিত হবে।');
    const key = requireKey();
    const store = loadStore();
    const previous = licenseById(store, args.previousLicenseId);
    if (!previous) throw new Error('আগের লাইসেন্সটি রেকর্ডে নেই।');

    const result = signLicense({
      device: args.device,
      issue: toIssueInput({ ...args.issue, org: args.issue.org || previous.org }),
      privateKeyB64: key.b64,
      generatorVersion: app.getVersion(),
    });
    const record = recordIssuedLicense(store, {
      result,
      customerId: previous.customer_id,
      filePath: null,
      replaces: previous.license_id,
      note: `রি-ইস্যু (${previous.license_id.slice(-6)}): ${reason}`,
    });
    let filePath: string | null = null;
    if (args.save !== false) {
      filePath = await saveLicenseDialog(
        `${safeFileStem(record.org)}-${record.license_id.slice(-6)}.sauda`,
        toLicenseFile(record),
      );
      record.file_path = filePath;
    }
    saveStore(store);
    // The replaced licence is closed out in the ledger, with the reason kept.
    ledgerEntryFor(previous, 'revoked', { reason: `রি-ইস্যু: ${reason}` });
    ledgerEntryFor(record, 'reissued', { reason, file: filePath, replaces: previous.license_id });
    return { record, payload: result.payload, licenseKey: result.licenseKey, filePath, replaces: previous.license_id };
  },

  'license.saveFile': async (_e, licenseId: string) => {
    const store = loadStore();
    const record = licenseById(store, licenseId);
    if (!record) throw new Error('লাইসেন্সটি রেকর্ডে নেই।');
    const filePath = await saveLicenseDialog(
      `${safeFileStem(record.org)}-${record.license_id.slice(-6)}.sauda`,
      toLicenseFile(record),
    );
    if (!filePath) return null;
    record.file_path = filePath;
    saveStore(store);
    return filePath;
  },

  'license.revoke': (_e, licenseId: string, reason: string) => {
    const store = loadStore();
    const record = revokeLicense(store, licenseId, reason);
    saveStore(store);
    const entry = ledgerEntryFor(record, 'revoked', { reason: record.revoke_reason });
    return { record, entry };
  },

  'license.check': async () => {
    const config = readConfig();
    const res = await dialog.showOpenDialog({
      title: 'যাচাই করার জন্য লাইসেন্স ফাইল খুলুন',
      defaultPath: config.lastDir ?? undefined,
      filters: [{ name: 'Sauda License', extensions: ['sauda', 'license', 'json', 'txt'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const content = fs.readFileSync(res.filePaths[0], 'utf8');
    const key = currentKey();
    const outcome = verifyLicenseFile(content, { publicKeyB64: key?.publicKeyB64, revokedIds: revokedIds() });
    writeConfig({ lastDir: path.dirname(res.filePaths[0]) });
    return { ...outcome, file: res.filePaths[0], keyId: key?.keyId ?? null };
  },
  'license.checkText': (_e, content: string) => {
    const key = currentKey();
    return verifyLicenseFile(String(content ?? ''), { publicKeyB64: key?.publicKeyB64, revokedIds: revokedIds() });
  },

  /* ---------------- registers ---------------- */
  'licenses.list': (_e, filter: Parameters<typeof listLicenses>[1] = {}) => {
    const store = loadStore();
    return listLicenses(store, filter).map((l) => ({ ...l, state: licenseState(l), license: undefined }));
  },
  'licenses.get': (_e, licenseId: string) => {
    const store = loadStore();
    const record = licenseById(store, licenseId);
    if (!record) throw new Error('লাইসেন্স পাওয়া যায়নি।');
    const customer = record.customer_id ? customerById(store, record.customer_id) : null;
    return { record: { ...record, state: licenseState(record) }, customer };
  },
  'licenses.verifyRecord': (_e, licenseId: string) => {
    const key = currentKey();
    const store = loadStore();
    const record = licenseById(store, licenseId);
    if (!record) throw new Error('লাইসেন্স পাওয়া যায়নি।');
    const state = verifyLicense(record.license, { publicKeyB64: key?.publicKeyB64 ?? undefined, skipDevice: true });
    return {
      ok: state.activated,
      message: state.message,
      payload: record.license.payload,
      licenseKey: null,
      revoked: revokedIds().includes(record.license_id),
    };
  },

  /* ---------------- dashboard / metadata ---------------- */
  'dashboard.summary': () => {
    const store = loadStore();
    return {
      summary: summarize(store),
      recent: listLedger(ledgerPath()).slice(0, 8),
      storePath: storePath(),
      ledgerPath: ledgerPath(),
      keyLoaded: Boolean(currentKey()),
    };
  },
  'meta.catalog': () => ({ editions: EDITIONS, features: FEATURES, reports: REPORTS }),
  'ledger.list': (_e, limit = 200) => ledger().slice(0, Math.max(1, Number(limit) || 200)),

  /* ---------------- reports ---------------- */
  'reports.build': (_e, reportId: string) => {
    const store = loadStore();
    const { definition, rows } = reportRows(store, ledger(), reportId);
    return { definition, rows, summary: summarize(store) };
  },
  'reports.preview': async (_e, reportId: string) => {
    const store = loadStore();
    const { definition, rows } = reportRows(store, ledger(), reportId);
    const html = buildReportHtml({
      title: definition.title,
      subtitle: definition.note,
      columns: definition.columns.map((c) => ({ label: c.label, align: c.align })),
      rows,
      brand: brand(),
      landscape: rows.some((r) => r.length > 6),
    });
    return openPreview(html);
  },
  'reports.pdf': async (_e, reportId: string) => {
    const store = loadStore();
    const { definition, rows } = reportRows(store, ledger(), reportId);
    const res = await dialog.showSaveDialog({
      title: 'রিপোর্ট PDF সংরক্ষণ',
      defaultPath: path.join(app.getPath('documents'), `${reportId}-${new Date().toISOString().slice(0, 10)}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePath) return null;
    const html = buildReportHtml({
      title: definition.title,
      subtitle: definition.note,
      columns: definition.columns.map((c) => ({ label: c.label, align: c.align })),
      rows,
      brand: brand(),
      landscape: rows.some((r) => r.length > 6),
    });
    return htmlToPdf(html, res.filePath, { landscape: rows.some((r) => r.length > 6) });
  },
  'reports.print': async (_e, reportId: string) => {
    const store = loadStore();
    const { definition, rows } = reportRows(store, ledger(), reportId);
    const html = buildReportHtml({
      title: definition.title,
      subtitle: definition.note,
      columns: definition.columns.map((c) => ({ label: c.label, align: c.align })),
      rows,
      brand: brand(),
      landscape: rows.some((r) => r.length > 6),
    });
    return printHtml(html);
  },

  /* ---------------- licence certificate ---------------- */
  'license.document': (_e, licenseId: string) => {
    const store = loadStore();
    const record = licenseById(store, licenseId);
    if (!record) throw new Error('লাইসেন্স পাওয়া যায়নি।');
    const payload: LicensePayload = record.license.payload;
    return buildLicenseDocumentHtml({
      org: payload.org,
      licenseId: payload.license_id,
      edition: payload.edition,
      issuedAt: payload.issued_at,
      expiresAt: payload.expires_at,
      maxDevices: payload.max_devices,
      features: payload.features ?? [],
      fingerprint: payload.fingerprint,
      keyId: record.key_id,
      brand: brand(),
      version: PRODUCT_VERSION,
    });
  },
  'license.previewDoc': async (_e, licenseId: string) => {
    const html = routes['license.document'](null, licenseId) as string;
    return openPreview(html);
  },
  'license.pdf': async (_e, licenseId: string) => {
    const html = routes['license.document'](null, licenseId) as string;
    const store = loadStore();
    const record = licenseById(store, licenseId);
    const res = await dialog.showSaveDialog({
      title: 'লাইসেন্স সার্টিফিকেট PDF',
      defaultPath: path.join(app.getPath('documents'), `${safeFileStem(record?.org ?? 'license')}-certificate.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePath) return null;
    return htmlToPdf(html, res.filePath, { landscape: false });
  },
  'license.print': async (_e, licenseId: string) => {
    const html = routes['license.document'](null, licenseId) as string;
    return printHtml(html);
  },

  /* ---------------- backup / diagnostics ---------------- */
  'backup.export': async () => {
    const store = loadStore();
    const bundle = buildBackup(store, ledger());
    const res = await dialog.showSaveDialog({
      title: 'প্রশাসনিক ব্যাকআপ সংরক্ষণ',
      defaultPath: path.join(
        app.getPath('documents'),
        `sauda-license-admin-${new Date().toISOString().slice(0, 10)}.json`,
      ),
      filters: [{ name: 'Sauda Admin Backup', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, JSON.stringify(bundle, null, 2), 'utf8');
    return { file: res.filePath, customers: store.customers.length, licenses: store.licenses.length };
  },
  'backup.inspect': async () => {
    const res = await dialog.showOpenDialog({
      title: 'ব্যাকআপ ফাইল নির্বাচন',
      filters: [{ name: 'Sauda Admin Backup', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const bundle = parseBackup(fs.readFileSync(res.filePaths[0], 'utf8'));
    return {
      file: res.filePaths[0],
      created_at: bundle.created_at,
      customers: bundle.store.customers.length,
      licenses: bundle.store.licenses.length,
      ledger: bundle.ledger.length,
    };
  },
  'backup.restore': async (_e, file: string) => {
    const backupPath = requireReadableFile(file, ['.json', '.saudabak', '.backup'], 64 * 1024 * 1024);
    const bundle: BackupBundle = parseBackup(fs.readFileSync(backupPath, 'utf8'));
    // Never overwrite silently: current data is parked next to the store first.
    const current = loadStore();
    const parking = `${storePath()}.before-restore-${Date.now()}.json`;
    writeStore(parking, current);
    writeStore(storePath(), bundle.store);
    return { restored: { customers: bundle.store.customers.length, licenses: bundle.store.licenses.length }, previous: parking };
  },
  'backup.reveal': () => {
    if (!fs.existsSync(storePath())) throw new Error('এখনো কোনো ডেটা ফাইল তৈরি হয়নি।');
    shell.showItemInFolder(storePath());
    return true;
  },
  'diagnostics.get': () => ({
    appVersion: PRODUCT_VERSION,
    generatorVersion: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    userData: userData(),
    storePath: storePath(),
    ledgerPath: ledgerPath(),
    keyPath: readConfig().keyPath,
    storeExists: fs.existsSync(storePath()),
    ledgerExists: fs.existsSync(ledgerPath()),
    ledgerLines: ledger().length,
  }),

  'reveal': (_e, target: string) => {
    const resolved = path.resolve(String(target ?? ''));
    const roots = [userData(), app.getPath('documents'), app.getPath('downloads'), app.getPath('desktop')];
    const lastDir = readConfig().lastDir;
    if (lastDir) roots.push(path.resolve(lastDir));
    const inside = roots.some((root) => {
      const rel = path.relative(path.resolve(root), resolved);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!inside) throw new Error('এই ফোল্ডারটি দেখানোর অনুমতি নেই।');
    if (!fs.existsSync(resolved)) throw new Error('ফাইলটি আর পাওয়া যাচ্ছে না।');
    shell.showItemInFolder(resolved);
    return true;
  },
  'copy': (_e, text: string) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  },
};

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: '#0f1518',
    title: 'সাউদা লাইসেন্স জেনারেটর',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: isDevBuild(),
    },
  });

  const rendererFile = path.join(__dirname, '..', 'renderer', 'index.html');
  const devUrl = devServerUrl();
  if (devUrl) {
    trustedRendererUrl = devUrl;
    void win.loadURL(devUrl);
  } else {
    trustedRendererUrl = pathToFileUrl(rendererFile);
    void win.loadFile(rendererFile);
  }
  win.once('ready-to-show', () => win.show());

  // No new windows, ever — a signed licence file is opened by the OS, not by us.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // No navigation away from the bundled document, not even to another file.
  win.webContents.on('will-navigate', (event, url) => {
    if (!sameRendererDocument(url)) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.on('render-process-gone', () => {
    // Handled by Electron; the window is reloaded by the user rather than silently dead.
  });
}

/** Only a loopback dev server, and only in an unpackaged build. */
function devServerUrl(): string | null {
  if (app.isPackaged) return null;
  const raw = process.env.LICGEN_DEV_URL;
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
    if (!/^https?:$/.test(parsed.protocol) || !loopback) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function isDevBuild(): boolean {
  return !app.isPackaged;
}

function sameRendererDocument(url: string): boolean {
  try {
    const next = new URL(url);
    const trusted = new URL(trustedRendererUrl || rendererFileUrl());
    if (trusted.protocol === 'file:') return next.protocol === 'file:' && next.pathname === trusted.pathname;
    return next.origin === trusted.origin;
  } catch {
    return false;
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(() => {
    ipcMain.handle('licgen:invoke', async (event, method: string, args: any[] = []) => {
      // Sender check first: nothing (including the route name) is inspected on
      // behalf of an untrusted frame.
      if (!isTrustedSender(event)) {
        return { ok: false, error: 'অননুমোদিত উৎস থেকে অনুরোধ — প্রত্যাখ্যাত।' };
      }
      if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(routes, method)) {
        return { ok: false, error: `অজানা অনুরোধ: ${String(method)}` };
      }
      const fn = routes[method]!;
      try {
        const callArgs = Array.isArray(args) ? args : [];
        const data = await fn(event, ...callArgs);
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

/** Kept for consumers that only need the crypto surface in tests. */
export const __crypto = crypto;
