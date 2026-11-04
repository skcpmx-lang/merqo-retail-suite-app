import { app, BrowserWindow, ipcMain, Menu, session, shell, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  closeDatabase,
  getMeta,
  integrityCheck,
  openDatabase,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  repairDatabase,
  shouldAutoBackup,
  createBackup,
  getSettings,
  type Db,
} from '@sauda/core';
import { appPaths, writeLog, readRecentLogs } from './paths.js';
import { invokeRoute, type AppContext } from './ipc.js';
import { lanClient, resetLanClient, stopLanHost } from './lan.js';
import type { RpcClient } from '@sauda/core';

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let displayWindow: BrowserWindow | null = null;
let db: Db;

/**
 * Transport state. A *host* owns the writable database; a *terminal* keeps no
 * business data and forwards every route to the host over the LAN.
 */
const transport: { mode: 'off' | 'host' | 'terminal'; client: RpcClient | null; hostUrl: string } = {
  mode: 'off',
  client: null,
  hostUrl: '',
};

/** Routes that must always run on the machine the operator is sitting at. */
const LOCAL_PREFIXES = ['print.', 'app.', 'lan.', 'display.', 'meta.', 'license.fingerprint'];

function isLocalRoute(method: string): boolean {
  return LOCAL_PREFIXES.some((p) => method.startsWith(p));
}

const ctx: AppContext = {
  db: null as unknown as Db,
  user: null,
  openDb: () => db,
  reopenDb: () => {
    try {
      closeDatabase(db);
    } catch {
      /* ignore */
    }
    db = openDatabase({ file: appPaths().dbPath, appVersion: PRODUCT_VERSION });
    ctx.db = db;
    return db;
  },
};

function splashSafe<T>(fn: () => T, label: string, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    writeLog('error', `${label} failed`, err);
    return fallback;
  }
}

function bootstrapDatabase(): void {
  const paths = appPaths();
  db = openDatabase({ file: paths.dbPath, appVersion: PRODUCT_VERSION, log: (m) => writeLog('info', m) });
  ctx.db = db;
  const check = integrityCheck(db);
  if (!check.ok) {
    const repaired = repairDatabase(db);
    writeLog('warn', 'integrity check failed', { detail: check.detail, repaired });
  }
  const row = db.prepare("SELECT value FROM meta WHERE key='install_id'").get() as { value: string } | undefined;
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('install_id', ?)").run(
      `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('first_run_at', ?) ON CONFLICT(key) DO NOTHING").run(
    new Date().toISOString(),
  );
}

/** Reads the LAN configuration and prepares the terminal client if needed. */
function bootstrapTransport(): void {
  try {
    const settings = getSettings(db);
    if (settings.lan_mode === 'terminal' && settings.lan_host_url && settings.lan_token) {
      transport.mode = 'terminal';
      transport.hostUrl = settings.lan_host_url;
      transport.client = lanClient(settings.lan_host_url, settings.lan_token);
      writeLog('info', 'terminal mode', { host: settings.lan_host_url });
    } else {
      transport.mode = settings.lan_mode === 'host' ? 'host' : 'off';
    }
  } catch (err) {
    writeLog('warn', 'transport bootstrap failed', err);
  }
  // `fetch` inside route handlers always goes through the active transport.
  ctx.fetch = async (method, args = []) => {
    if (transport.mode === 'terminal' && transport.client && !isLocalRoute(method) && method !== 'auth.login') {
      return transport.client.invoke(method, args);
    }
    return invokeRoute(ctx, method, args);
  };
}

/* ------------------------------------------------------------------ */
/* Trust boundary                                                      */
/* ------------------------------------------------------------------ */

/** The only document(s) allowed to call the bridge: our own bundled renderer. */
const rendererIndexPath = path.join(__dirname, '../renderer/index.html');

function normaliseFsPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * True when `url` is the app's own renderer document (any hash/query) or the
 * loopback dev server used during development. Everything else — remote pages,
 * redirects, `data:` documents, other local files — is untrusted.
 */
function isTrustedRendererUrl(url: string): boolean {
  if (!url) return false;
  if (isDev && process.env.SAUDA_DEV_URL) {
    try {
      const dev = new URL(process.env.SAUDA_DEV_URL);
      const next = new URL(url);
      return next.origin === dev.origin;
    } catch {
      return false;
    }
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return false;
    return normaliseFsPath(fileURLToPath(parsed)) === normaliseFsPath(rendererIndexPath);
  } catch {
    return false;
  }
}

/**
 * Every IPC call must come from our renderer. Before v1.1.3 the channel trusted
 * whatever frame was attached, so any navigation (a `file://` origin compares as
 * "null" to itself) would have inherited the full, licence-gated bridge.
 */
function isTrustedSender(event: { senderFrame?: { url?: string } | null }): boolean {
  const frameUrl = event?.senderFrame?.url ?? '';
  return isTrustedRendererUrl(frameUrl);
}

/** External links open in the system browser, but only for known hosts. */
const EXTERNAL_LINK_ALLOWLIST = [
  'merqo',
  'sauda',
  'github.com/skcpmx-lang/merqo-retail-suite-app',
];

function isAllowedExternalLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return EXTERNAL_LINK_ALLOWLIST.some(
      (entry) => parsed.hostname === entry || parsed.hostname.endsWith(`.${entry}`),
    );
  } catch {
    return false;
  }
}

function openDisplayWindow(): void {
  if (displayWindow && !displayWindow.isDestroyed()) {
    displayWindow.focus();
    return;
  }
  const display = new BrowserWindow({
    width: 1024,
    height: 700,
    title: 'কাস্টমার ডিসপ্লে',
    autoHideMenuBar: true,
    backgroundColor: '#0b1220',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: isDev,
    },
  });
  const indexPath = rendererIndexPath;
  if (isDev && process.env.SAUDA_DEV_URL) {
    void display.loadURL(`${process.env.SAUDA_DEV_URL}#display`);
  } else {
    void display.loadFile(indexPath, { hash: 'display' });
  }
  display.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  display.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  display.on('closed', () => {
    displayWindow = null;
  });
  displayWindow = display;
}

function closeDisplayWindow(): void {
  if (displayWindow && !displayWindow.isDestroyed()) displayWindow.close();
  displayWindow = null;
}

/**
 * Creates a scheduled backup if one is due.
 *
 * v1.1.3: this only ever ran at startup, so a shop that leaves the till open for
 * a week never got a daily backup. `scheduleAutoBackup()` re-checks on a timer and
 * the outcome is pushed to the UI instead of dying quietly in the log file.
 */
function runAutoBackup(): void {
  try {
    if (!shouldAutoBackup(db)) return;
    const settings = getSettings(db);
    const result = createBackup(db, {
      dataDir: settings.auto_backup_dir || appPaths().backupsDir,
      kind: 'auto',
      appVersion: PRODUCT_VERSION,
      note: 'স্বয়ংক্রিয় ব্যাকআপ',
    });
    writeLog('info', 'auto backup created', { file: result.filePath });
    notifyRenderer('backup', `স্বয়ংক্রিয় ব্যাকআপ সম্পন্ন — ${path.basename(result.filePath)}`);
  } catch (err) {
    writeLog('warn', 'auto backup failed', err);
    notifyRenderer('backup', `স্বয়ংক্রিয় ব্যাকআপ ব্যর্থ — ${(err as Error).message}`);
  }
}

let autoBackupTimer: NodeJS.Timeout | null = null;

function scheduleAutoBackup(): void {
  runAutoBackup();
  // 15 minutes is frequent enough for a daily/weekly policy and cheap (one indexed
  // SELECT when nothing is due).
  autoBackupTimer = setInterval(runAutoBackup, 15 * 60 * 1000);
  autoBackupTimer.unref?.();
}

function stopAutoBackup(): void {
  if (autoBackupTimer) clearInterval(autoBackupTimer);
  autoBackupTimer = null;
}

function notifyRenderer(type: string, message: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sauda:event', { type, message });
  }
}

/**
 * The UI needs no device permissions at all (no camera, microphone, geolocation,
 * notifications, clipboard-read or USB/HID). Denying them centrally means a
 * compromised renderer cannot even ask.
 */
function lockDownPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    backgroundColor: '#f6f7fb',
    title: `${PRODUCT_NAME} ${PRODUCT_VERSION}`,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: isDev,
    },
  });

  const indexPath = rendererIndexPath;
  if (isDev && process.env.SAUDA_DEV_URL) {
    void mainWindow.loadURL(process.env.SAUDA_DEV_URL);
  } else {
    void mainWindow.loadFile(indexPath);
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Never allow navigating away from the app or opening new electron windows.
  // (v1.1.3) `file://` URLs all report origin "null", so the old origin check let
  // a local file take over the window and inherit the bridge. Compare the actual
  // document path instead, and only open allow-listed https links externally.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalLink(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    writeLog('error', 'renderer crashed', details);
  });
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'ফাইল',
      submenu: [
        {
          label: 'ডেটা ফোল্ডার খুলুন',
          click: () => void shell.openPath(appPaths().dataDir),
        },
        {
          label: 'লগ ফাইল খুলুন',
          click: () => void shell.openPath(appPaths().logsDir),
        },
        { type: 'separator' },
        { label: 'বন্ধ করুন', role: 'quit' },
      ],
    },
    {
      label: 'দেখুন',
      submenu: [
        { label: 'রিলোড', role: 'reload', visible: isDev },
        { label: 'জুম ইন', role: 'zoomIn' },
        { label: 'জুম আউট', role: 'zoomOut' },
        { label: 'স্বাভাবিক জুম', role: 'resetZoom' },
        { type: 'separator' },
        { label: 'ফুলস্ক্রিন', role: 'togglefullscreen' },
      ],
    },
    {
      label: 'সাহায্য',
      submenu: [
        {
          label: `${PRODUCT_NAME} সম্পর্কে`,
          click: () => mainWindow?.webContents.send('sauda:event', { type: 'navigate', message: 'about' }),
        },
        {
          label: 'ডায়াগনস্টিক লগ দেখুন',
          click: () => {
            const text = readRecentLogs(200);
            void dialog.showMessageBox({
              type: 'info',
              title: 'ডায়াগনস্টিক লগ',
              message: 'সর্বশেষ লগ এন্ট্রি',
              detail: text.slice(0, 4000) || 'কোনো লগ নেই।',
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    lockDownPermissions();
    bootstrapDatabase();
    bootstrapTransport();
    ctx.display = {
      open: openDisplayWindow,
      close: closeDisplayWindow,
      push: (state: unknown) => {
        if (displayWindow && !displayWindow.isDestroyed()) {
          displayWindow.webContents.send('sauda:event', { type: 'display', message: JSON.stringify(state ?? null) });
        }
      },
      isOpen: () => Boolean(displayWindow && !displayWindow.isDestroyed()),
    };
    buildMenu();
    createWindow();
    scheduleAutoBackup();
    writeLog('info', 'app started', { version: PRODUCT_VERSION, db: appPaths().dbPath });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  ipcMain.handle('sauda:invoke', async (event, method: string, args: unknown[]) => {
    if (!isTrustedSender(event)) {
      writeLog('warn', 'ipc rejected: untrusted sender', { url: event?.senderFrame?.url ?? '' });
      return { ok: false, error: 'অননুমোদিত উৎস থেকে অনুরোধ — প্রত্যাখ্যাত।', code: 'UNTRUSTED_SENDER' };
    }
    if (typeof method !== 'string' || !method) {
      return { ok: false, error: 'অজানা অনুরোধ।', code: 'NOT_FOUND' };
    }
    const callArgs = Array.isArray(args) ? args : [];
    if (transport.mode === 'terminal' && transport.client && !isLocalRoute(method)) {
      const res = await transport.client.invoke(method, callArgs);
      if (method === 'auth.login' && res.ok) {
        ctx.user = (res.data as typeof ctx.user) ?? null;
      }
      if (method === 'auth.logout') ctx.user = null;
      return res;
    }
    return invokeRoute(ctx, method, callArgs);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    stopAutoBackup();
    resetLanClient();
    void stopLanHost().catch(() => undefined);
    splashSafe(() => closeDatabase(db), 'closeDatabase', undefined);
  });
}

process.on('uncaughtException', (err) => {
  writeLog('error', 'uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  writeLog('error', 'unhandledRejection', reason as Error);
});

export { getMeta, appPaths, fs };
