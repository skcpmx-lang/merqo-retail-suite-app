import { app, BrowserWindow, ipcMain, Menu, shell, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
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

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let db: Db;

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
  } catch (err) {
    writeLog('warn', 'auto backup failed', err);
  }
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
      sandbox: false,
      spellcheck: false,
      devTools: isDev,
    },
  });

  const indexPath = path.join(__dirname, '../renderer/index.html');
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
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? '';
    if (new URL(url).origin !== new URL(current).origin) event.preventDefault();
  });
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
    bootstrapDatabase();
    buildMenu();
    createWindow();
    runAutoBackup();
    writeLog('info', 'app started', { version: PRODUCT_VERSION, db: appPaths().dbPath });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  ipcMain.handle('sauda:invoke', async (_event, method: string, args: unknown[]) => {
    return invokeRoute(ctx, method, Array.isArray(args) ? args : []);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
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
