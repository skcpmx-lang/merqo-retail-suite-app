import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, session, shell, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  closeDatabase,
  detectDatabaseRole,
  getMeta,
  integrityCheck,
  openClientDatabase,
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
import {
  ServerRuntime,
  decideWindowCloseAction,
  describeServerState,
  shouldAutoStartServer,
} from './server-runtime.js';
import { initServerRuntime } from './server.js';
import { invokeRoute, type AppContext } from './ipc.js';
import { initTerminalManager, TerminalManager } from './terminal.js';
import { decideRoute } from './mode-policy.js';
import { dpapiSealer } from './device-key-storage.js';
import { OfflineError } from './v1-transport.js';

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Set while a real quit is in progress, so a window close is not turned into a hide. */
let quitting = false;
/** Read at close time; a terminal never owns a server. */
let serverRuntime: ServerRuntime | null = null;
let displayWindow: BrowserWindow | null = null;
let db: Db;

/**
 * Transport state. A *host* owns the writable database; a *terminal* keeps no
 * business data and forwards every route to the host over the LAN.
 */
const transport: {
  mode: 'off' | 'host' | 'terminal';
  /** Client transport: `/api/v1` over pinned TLS. There is no other remote path. */
  client: { invoke: (method: string, args: unknown[]) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }> } | null;
  hostUrl: string;
} = {
  mode: 'off',
  client: null,
  hostUrl: '',
};

/** Created once; owns the saved servers, the sealed device key and the event stream. */
let terminalManager: TerminalManager | null = null;

function terminalManagerFor(): TerminalManager {
  if (!terminalManager) {
    terminalManager = new TerminalManager({
      dataDir: appPaths().dataDir,
      sealer: dpapiSealer,
      log: (level, message, detail) => writeLog(level, message, detail),
    });
    initTerminalManager(terminalManager);
  }
  return terminalManager;
}

/**
 * Route selection lives in `mode-policy.ts` (electron-free, tested): business routes go
 * to the Main PC in client mode, printer/display/LAN/app routes stay here.
 */
const isLocalRoute = (method: string) => decideRoute('terminal', method) === 'local';

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
    // Reopen in the same role: a Client PC must never come back with an unguarded
    // handle just because something asked for a reopen.
    bootstrapDatabase();
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

/**
 * Decides whether this install is a Main Server or a Client **before** the database is
 * opened (D-11):
 *
 *  - a configured trusted server (terminal.json) or a database last used in terminal mode
 *    means client: the file is opened without migrations or seeding and then guarded, so
 *    a v1.1.3 install's data stays byte-for-byte as it was and can never be written to;
 *  - otherwise it is the shop database and opens normally.
 */
function isClientInstall(dbPath: string): boolean {
  try {
    if (terminalManagerFor().activeServer) return true;
    if (terminalManagerFor().paired) return true;
  } catch {
    /* no terminal config yet */
  }
  return detectDatabaseRole(dbPath) === 'client';
}

function bootstrapDatabase(): void {
  const paths = appPaths();
  const client = isClientInstall(paths.dbPath);
  if (client) {
    db = openClientDatabase({
      file: paths.dbPath,
      appVersion: PRODUCT_VERSION,
      log: (m) => writeLog('info', m),
      onBlocked: (err) => writeLog('warn', 'client database blocked a local operation', { code: err.code, table: err.table }),
    });
    ctx.db = db;
    ctx.mode = 'client';
    writeLog('info', 'client database opened (guarded, no migration)', { file: paths.dbPath });
    return;
  }
  db = openDatabase({ file: paths.dbPath, appVersion: PRODUCT_VERSION, log: (m) => writeLog('info', m) });
  ctx.db = db;
  ctx.mode = 'server';
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
    if (settings.lan_mode === 'terminal') {
      // Client mode: the device credential + pinned certificate are the only way to
      // reach the shop. Nothing falls back to a token or to plaintext HTTP.
      const manager = terminalManagerFor();
      const server = manager.activeServer;
      transport.mode = 'terminal';
      transport.hostUrl = server?.base_url ?? '';
      transport.client = {
        invoke: async (method, args) => {
          try {
            return { ok: true, data: await manager.invoke(method, args) };
          } catch (err) {
            const e = err as Error & { code?: string; details?: unknown };
            const code = err instanceof OfflineError ? 'OFFLINE' : (e.code ?? 'ERROR');
            writeLog('warn', `client route ${method} failed`, { code, message: e.message });
            return {
              ok: false,
              error: e.message,
              code,
              ...(e.details === undefined ? {} : { details: e.details }),
            };
          }
        },
      };
      // Shop events arrive over the authenticated stream and are pushed to the
      // renderer; the renderer refetches through the same routes it already uses.
      manager.setSink({
        onEvent: (event) => notifyV1Event({ kind: 'event', ...event }),
        onState: (state, detail) => notifyV1Event({ kind: 'state', state, detail }),
        onResync: (from) => notifyV1Event({ kind: 'resync', from }),
      });
      writeLog('info', 'client mode (/api/v1)', { host: server?.base_url ?? '', pinned: Boolean(server?.fingerprint) });
    } else {
      transport.mode = settings.lan_mode === 'host' ? 'host' : 'off';
      transport.client = null;
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
  // Backups belong to the shop database. A client's local file is not the shop, so it is
  // never backed up here (and the Main PC's backup is the shop's backup).
  if (ctx.mode === 'client') {
    writeLog('info', 'auto backup skipped: client mode');
    return;
  }
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

function notifyV1Event(payload: Record<string, unknown>): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sauda:v1-event', payload);
  }
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

  /**
   * v1.1.4: closing the POS window no longer kills the Main Server. While the
   * server is running (and the operator kept "keep running" on), the window hides
   * to the tray; quitting is explicit (tray → পুরোপুরি বন্ধ করুন, or the menu).
   */
  mainWindow.on('close', (event) => {
    const settings = getSettingsSafe();
    const action = decideWindowCloseAction({
      serverRunning: serverRuntime?.isRunning() ?? false,
      keepRunning: settings.server_keep_running ?? 1,
      quitting,
    });
    if (action === 'hide-to-tray') {
      event.preventDefault();
      mainWindow?.hide();
      notifyRenderer('server', 'সার্ভার চালু আছে — উইন্ডো ট্রেতে সরানো হয়েছে।');
    }
  });

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

/* ------------------------------------------------------------------ */
/* Main Server runtime (v1.1.4, Phase 2)                               */
/* ------------------------------------------------------------------ */

/**
 * Creates the process-wide server runtime. Kept separate from the window so the
 * server outlives it; `main.ts` is the only place that knows about both.
 */
function createServerRuntime(): ServerRuntime {
  const paths = appPaths();
  const runtime = new ServerRuntime({
    port: getSettingsSafe().lan_port ?? 4747,
    token: () => getSettingsSafe().lan_token ?? '',
    version: PRODUCT_VERSION,
    businessName: () => getSettingsSafe().business_name || PRODUCT_NAME,
    authenticate: async (username, password) => {
      const { login } = await import('@sauda/core');
      const result = login(ctx.openDb(), username, password);
      return {
        id: result.user.id,
        username: result.user.username,
        full_name: result.user.full_name,
        role: result.user.role,
        permissions: result.user.permissions ?? [],
      };
    },
    invoke: async (method, args, user) => {
      // A LAN request runs against a fresh context so it can never disturb the
      // operator sitting at the host machine.
      const lanCtx: AppContext = {
        ...ctx,
        user: user ? ({ ...user } as unknown as (typeof ctx)['user']) : null,
      };
      return invokeRoute(lanCtx, method, args);
    },
    log: (level, message, detail) => writeLog(level, message, detail),
    lockFile: path.join(paths.dataDir, 'server.lock'),
    dbCheck: () => {
      const check = integrityCheck(ctx.openDb());
      return { ok: check.ok, detail: check.detail ?? null };
    },
    lastBackupAt: () => {
      const row = ctx
        .openDb()
        .prepare('SELECT created_at FROM backups ORDER BY id DESC LIMIT 1')
        .get() as { created_at: string } | undefined;
      return row?.created_at ?? null;
    },
  });
  runtime.onStateChange((health) => {
    refreshTray();
    notifyRenderer('server', describeServerState(health));
  });
  return runtime;
}

/** Settings read that never throws during bootstrap. */
function getSettingsSafe() {
  try {
    return getSettings(ctx.openDb());
  } catch {
    return { lan_port: 4747, lan_token: '', lan_mode: 'off', server_autostart: 0, server_keep_running: 1, business_name: PRODUCT_NAME } as any;
  }
}

/* ------------------------------------------------------------------ */
/* System tray                                                         */
/* ------------------------------------------------------------------ */

function trayIcon(): Electron.NativeImage {
  const candidates = [
    path.join(__dirname, '../../build/icon.png'),
    path.join(__dirname, '../renderer/favicon.png'),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const image = nativeImage.createFromPath(file);
        if (!image.isEmpty()) return image.resize({ width: 16, height: 16 });
      }
    } catch {
      /* fall through to the empty image */
    }
  }
  return nativeImage.createEmpty();
}

function createTray(): void {
  if (tray) return;
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip(`${PRODUCT_NAME} ${PRODUCT_VERSION}`);
    tray.on('double-click', () => showMainWindow());
    refreshTray();
  } catch (err) {
    // A missing tray (some locked-down Windows sessions) must not stop the app.
    writeLog('warn', 'tray creation failed', err);
  }
}

/** Rebuilds the tray menu so it always shows live server state. */
function refreshTray(): void {
  if (!tray) return;
  const health = serverRuntime?.health() ?? null;
  const statusLine = health ? describeServerState(health) : 'সার্ভার বন্ধ';
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: statusLine, enabled: false },
    { label: `ক্লায়েন্ট: ${health?.clients ?? 0}`, enabled: false },
    { label: `ডেটাবেজ: ${health?.db_ok === false ? 'সমস্যা' : 'ঠিক আছে'}`, enabled: false },
    { type: 'separator' },
    { label: 'POS উইন্ডো খুলুন', click: () => showMainWindow() },
  ];
  if (health?.state === 'running') {
    items.push(
      {
        label: 'সার্ভার রিস্টার্ট',
        click: () => {
          void serverRuntime
            ?.restart()
            .catch((err) => writeLog('error', 'tray restart failed', err));
        },
      },
      {
        label: 'সার্ভার বন্ধ করুন',
        click: () => {
          void (async () => {
            const clients = serverRuntime?.health().clients ?? 0;
            if (clients > 0) {
              const answer = await dialog.showMessageBox({
                type: 'warning',
                buttons: ['বাতিল', 'বন্ধ করুন'],
                defaultId: 0,
                cancelId: 0,
                title: 'সার্ভার বন্ধ',
                message: `${clients}টি ক্লায়েন্ট সংযুক্ত আছে।`,
                detail: 'সার্ভার বন্ধ করলে সব ক্লায়েন্টের কাজ বন্ধ হয়ে যাবে। আপনি কি নিশ্চিত?',
              });
              if (answer.response !== 1) return;
            }
            await serverRuntime?.stop();
          })().catch((err) => writeLog('error', 'tray stop failed', err));
        },
      },
    );
  } else if (health?.state !== 'starting') {
    items.push({
      label: 'সার্ভার চালু করুন',
      click: () => {
        void serverRuntime?.start().catch((err) => writeLog('error', 'tray start failed', err));
      },
    });
  }
  items.push(
    { type: 'separator' },
    {
      label: 'পুরোপুরি বন্ধ করুন',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(`${PRODUCT_NAME} — ${statusLine}`);
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Starts the server at launch when the operator enabled it. A failure (busy port,
 * another process holding the store, missing token) is logged and shown in the
 * window instead of silently pretending the shop is online.
 */
async function bootstrapServerRuntime(): Promise<void> {
  // A Client PC runs no listener and owns no shop database.
  if (ctx.mode === 'client') {
    writeLog('info', 'server runtime not started: client mode');
    return;
  }
  if (serverRuntime) return;
  try {
    serverRuntime = initServerRuntime(createServerRuntime());
  } catch (err) {
    writeLog('error', 'server runtime init failed', err);
    return;
  }
  const settings = getSettingsSafe();
  // Keep Windows auto-start in sync with the operator's choice.
  try {
    app.setLoginItemSettings({ openAtLogin: settings.lan_mode === 'host' && settings.server_autostart === 1 });
  } catch (err) {
    writeLog('warn', 'login item update failed', err);
  }
  if (!shouldAutoStartServer(settings)) return;
  try {
    const health = await serverRuntime.start();
    writeLog('info', 'server auto-started', { port: health.port });
  } catch (err) {
    writeLog('error', 'server auto-start failed', err);
  }
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
    createTray();
    createWindow();
    void bootstrapServerRuntime();
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
    // v1.1.4: a running Main Server keeps the app alive in the tray even when the
    // last window is gone. Quitting is an explicit action.
    const keepServer = serverRuntime?.isRunning() && getSettingsSafe().server_keep_running === 1;
    if (keepServer) {
      refreshTray();
      return;
    }
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    quitting = true;
    stopAutoBackup();
    terminalManager?.logout();
    const runtime = serverRuntime;
    if (runtime && runtime.state !== 'stopped') {
      // Stop the listener first so no new request can arrive while the database is
      // being checkpointed and closed. A second quit proceeds normally.
      event.preventDefault();
      void runtime
        .stop()
        .catch((err) => writeLog('warn', 'server stop during quit failed', err))
        .finally(() => {
          splashSafe(() => closeDatabase(db), 'closeDatabase', undefined);
          app.quit();
        });
      return;
    }
    splashSafe(() => closeDatabase(db), 'closeDatabase', undefined);
  });
}

process.on('uncaughtException', (err) => {
  writeLog('error', 'uncaughtException', err);
  // Keep the shop's terminals alive after an unrelated fault in the UI process.
  serverRuntime?.reportCrash(err);
});
process.on('unhandledRejection', (reason) => {
  writeLog('error', 'unhandledRejection', reason as Error);
  serverRuntime?.reportCrash(reason);
});

export { getMeta, appPaths, fs };
