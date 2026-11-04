import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildPayload,
  encodeLicenseKey,
  keyIdForPublicKey,
  issueLicense,
  parseLicenseFile,
  verifyLicense,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  type DeviceFingerprint,
  type LicensePayload,
} from '@sauda/core';
import { appendLedger, isRevoked, ledgerFile, listLedger, revokedIds } from './ledger.js';

interface AppConfig {
  keyPath: string | null;
  lastDir: string | null;
}

const configPath = () => path.join(app.getPath('userData'), 'generator-config.json');

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

/** Accepts a raw base64 PKCS#8 key, a PEM file, or a JSON wrapper {"privateKey":"..."}. */
function loadPrivateKeyB64(filePath: string): { b64: string; publicKeyB64: string; keyId: string } {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  let b64 = raw;
  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw);
    b64 = parsed.privateKey ?? parsed.private_key ?? parsed.privateKeyPkcs8Base64 ?? '';
  } else if (raw.includes('-----BEGIN')) {
    b64 = raw
      .replace(/-----BEGIN [^-]+-----/g, '')
      .replace(/-----END [^-]+-----/g, '')
      .replace(/\s+/g, '');
  }
  b64 = b64.replace(/\s+/g, '');
  if (!b64) throw new Error('ফাইলে কোনো প্রাইভেট কী পাওয়া যায়নি।');
  const der = Buffer.from(b64, 'base64');
  const keyObject = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  if (keyObject.asymmetricKeyType !== 'ed25519') {
    throw new Error(`ভুল কী ধরন: ${keyObject.asymmetricKeyType}. Ed25519 কী প্রয়োজন।`);
  }
  const publicKeyB64 = crypto
    .createPublicKey(keyObject)
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  return { b64, publicKeyB64, keyId: keyIdForPublicKey(publicKeyB64) };
}

function currentKey() {
  const config = readConfig();
  if (!config.keyPath || !fs.existsSync(config.keyPath)) return null;
  try {
    return { ...loadPrivateKeyB64(config.keyPath), path: config.keyPath };
  } catch {
    return null;
  }
}

export interface DeviceRequest {
  kind: string;
  v: number;
  fingerprint: string;
  components: { key: string; hash: string; weight: number }[];
  platform?: string;
  app_version?: string;
  business_name?: string | null;
  created_at?: string;
}

function parseDeviceRequest(content: string): DeviceRequest {
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('ডিভাইস ফাইলটি JSON নয়।');
  }
  const components = Array.isArray(parsed.components) ? parsed.components : [];
  const clean = components
    .filter((c: any) => c && typeof c.key === 'string' && typeof c.hash === 'string' && c.hash.length > 0)
    .map((c: any) => ({ key: c.key, hash: c.hash, weight: Number(c.weight) || 0 }));
  if (!clean.length) throw new Error('ডিভাইস ফাইলে কোনো ব্যবহারযোগ্য কম্পোনেন্ট নেই।');
  return {
    kind: parsed.kind ?? 'sauda-device-request',
    v: Number(parsed.v) || 1,
    fingerprint: String(parsed.fingerprint ?? ''),
    components: clean,
    platform: parsed.platform,
    app_version: parsed.app_version,
    business_name: parsed.business_name ?? null,
    created_at: parsed.created_at,
  };
}

function deviceFingerprint(request: DeviceRequest): DeviceFingerprint {
  return {
    version: request.v,
    hash: request.fingerprint,
    components: request.components,
  } as DeviceFingerprint;
}

const routes: Record<string, (...args: any[]) => any | Promise<any>> = {
  'app.info': () => ({
    product: PRODUCT_NAME,
    appVersion: PRODUCT_VERSION,
    generatorVersion: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
  }),

  'key.status': () => {
    const key = currentKey();
    if (!key) return { loaded: false };
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

  'license.build': (_e: unknown, request: DeviceRequest, input: any) => {
    if (!request?.components?.length) throw new Error('আগে ডিভাইস রিকোয়েস্ট ফাইল লোড করুন।');
    const payload = buildPayload({
      org: input.org,
      owner: input.owner || undefined,
      phone: input.phone || undefined,
      email: input.email || undefined,
      address: input.address || undefined,
      edition: input.edition,
      expiresAt: input.expiresAt ? `${input.expiresAt}T23:59:59.000Z` : null,
      maxDevices: Number(input.maxDevices) || 1,
      features: input.features,
      note: input.note || undefined,
      generator: `Sauda License Generator ${app.getVersion()}`,
      device: deviceFingerprint(request),
    });
    return payload;
  },

  'license.issue': (_e: unknown, request: DeviceRequest, input: any) => {
    const key = currentKey();
    if (!key) throw new Error('সাইনিং কী লোড করা হয়নি। আগে প্রাইভেট কী ফাইল লোড করুন।');
    if (!request?.components?.length) throw new Error('আগে ডিভাইস রিকোয়েস্ট ফাইল লোড করুন।');
    const { license, key: licenseKey } = issueLicense(
      {
        org: input.org,
        owner: input.owner || undefined,
        phone: input.phone || undefined,
        email: input.email || undefined,
        address: input.address || undefined,
        edition: input.edition,
        expiresAt: input.expiresAt ? `${input.expiresAt}T23:59:59.000Z` : null,
        maxDevices: Number(input.maxDevices) || 1,
        features: input.features,
        note: input.note || undefined,
        generator: `Sauda License Generator ${app.getVersion()}`,
        device: deviceFingerprint(request),
      },
      key.b64,
    );
    // Self-check with the public key before anything is handed to a customer.
    const check = verifyLicense(license, { device: deviceFingerprint(request), publicKeyB64: key.publicKeyB64 });
    if (!check.activated) throw new Error(`নিজস্ব যাচাই ব্যর্থ: ${check.message}`);
    return { license, key: licenseKey, payload: license.payload, check };
  },

  'license.save': async (_e: unknown, payload: LicensePayload, licenseKey: string, fingerprint: string) => {
    const config = readConfig();
    const safeOrg = String(payload.org).replace(/[^\p{L}\n0-9 _-]/gu, '').trim().slice(0, 40) || 'license';
    const res = await dialog.showSaveDialog({
      title: 'লাইসেন্স ফাইল সংরক্ষণ করুন',
      defaultPath: path.join(
        config.lastDir ?? app.getPath('documents'),
        `${safeOrg}-${payload.license_id.slice(-6)}.sauda`,
      ),
      filters: [{ name: 'Sauda License', extensions: ['sauda'] }],
    });
    if (res.canceled || !res.filePath) return null;
    const body = {
      format: 'sauda-license',
      v: 1,
      key: licenseKey,
      payload,
      device_fingerprint: fingerprint,
      issued_by: 'Sauda License Generator',
      issued_at: new Date().toISOString(),
    };
    fs.writeFileSync(res.filePath, JSON.stringify(body, null, 2), 'utf8');
    writeConfig({ lastDir: path.dirname(res.filePath) });
    appendLedger({
      license_id: payload.license_id,
      org: payload.org,
      owner: payload.owner ?? null,
      edition: payload.edition,
      expires_at: payload.expires_at ?? null,
      max_devices: payload.max_devices,
      device_hash: fingerprint || null,
      key_id: currentKey()?.keyId ?? 'unknown',
      action: 'issued',
      replaces: null,
      reason: null,
      file: res.filePath,
    });
    return res.filePath;
  },

  'license.check': async () => {
    const res = await dialog.showOpenDialog({
      title: 'যাচাই করার জন্য লাইসেন্স ফাইল খুলুন',
      filters: [{ name: 'Sauda License', extensions: ['sauda', 'license', 'json', 'txt'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const key = currentKey();
    const content = fs.readFileSync(res.filePaths[0], 'utf8');
    const parsed = parseLicenseFile(content);
    if (!parsed.ok || !parsed.license) return { ok: false, message: parsed.message ?? 'ফাইল সঠিক নয়' };
    const signature = verifyLicense(parsed.license, { skipDevice: true, publicKeyB64: key?.publicKeyB64 });
    return {
      ok: signature.activated,
      message: signature.message,
      payload: parsed.license.payload,
      keyText: parsed.license ? encodeLicenseKey(parsed.license) : null,
    };
  },

  'history.list': () => ({ entries: listLedger(), revoked: revokedIds(), file: ledgerFile() }),

  'history.reveal': async () => {
    const file = ledgerFile();
    if (!fs.existsSync(file)) throw new Error('এখনো কোনো লাইসেন্স ইস্যু হয়নি।');
    shell.showItemInFolder(file);
    return true;
  },

  'license.revoke': (_e: unknown, payload: LicensePayload, reason: string) => {
    if (!payload?.license_id) throw new Error('লাইসেন্স আইডি পাওয়া যায়নি।');
    const note = String(reason ?? '').trim();
    if (!note) throw new Error('রিভোক করার কারণ লিখতে হবে — এটা ইতিহাসে সংরক্ষিত হবে।');
    const entry = appendLedger({
      license_id: payload.license_id,
      org: payload.org,
      owner: payload.owner ?? null,
      edition: payload.edition,
      expires_at: payload.expires_at ?? null,
      max_devices: payload.max_devices,
      device_hash: null,
      key_id: currentKey()?.keyId ?? 'unknown',
      action: 'revoked',
      replaces: null,
      reason: note,
      file: null,
    });
    return { revoked: true, entry, already: isRevoked(payload.license_id) };
  },

  'license.reissue': (_e: unknown, request: DeviceRequest, previous: LicensePayload, input: any) => {
    const key = currentKey();
    if (!key) throw new Error('সাইনিং কী লোড করা হয়নি। আগে প্রাইভেট কী ফাইল লোড করুন।');
    if (!previous?.license_id) throw new Error('আগের লাইসেন্স পাওয়া যায়নি।');
    const reason = String(input?.reason ?? '').trim();
    if (!reason) throw new Error('রি-ইস্যুর কারণ লিখতে হবে।');
    // Old licence is revoked first so the ledger always shows the reason.
    appendLedger({
      license_id: previous.license_id,
      org: previous.org,
      owner: previous.owner ?? null,
      edition: previous.edition,
      expires_at: previous.expires_at ?? null,
      max_devices: previous.max_devices,
      device_hash: null,
      key_id: currentKey()?.keyId ?? 'unknown',
      action: 'revoked',
      replaces: null,
      reason: `রি-ইস্যু: ${reason}`,
      file: null,
    });
    const { license, key: licenseKey } = issueLicense(
      {
        org: previous.org,
        owner: previous.owner ?? undefined,
        phone: previous.phone ?? undefined,
        email: previous.email ?? undefined,
        address: previous.address ?? undefined,
        edition: previous.edition,
        expiresAt: previous.expires_at ?? null,
        maxDevices: previous.max_devices,
        features: previous.features,
        note: `রি-ইস্যু (${previous.license_id.slice(-6)}): ${reason}`,
        generator: `Sauda License Generator ${app.getVersion()}`,
        device: deviceFingerprint(request),
      },
      key.b64,
    );
    const check = verifyLicense(license, { device: deviceFingerprint(request), publicKeyB64: key.publicKeyB64 });
    if (!check.activated) throw new Error(`নিজস্ব যাচাই ব্যর্থ: ${check.message}`);
    return { license, key: licenseKey, payload: license.payload, check, replaces: previous.license_id };
  },

  'reveal': async (_e: unknown, target: string) => {
    shell.showItemInFolder(target);
    return true;
  },

  'copy': (_e: unknown, text: string) => {
    require('electron').clipboard.writeText(String(text ?? ''));
    return true;
  },
};

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 980,
    minHeight: 700,
    backgroundColor: '#f3f6f6',
    title: 'সাউদা লাইসেন্স জেনারেটর',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUrl = process.env.LICGEN_DEV_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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
    ipcMain.handle('licgen:invoke', async (_event, method: string, args: any[] = []) => {
      const fn = routes[method];
      if (!fn) return { ok: false, error: `অজানা অনুরোধ: ${method}` };
      try {
        const data = await (fn as any)(_event, ...args);
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
