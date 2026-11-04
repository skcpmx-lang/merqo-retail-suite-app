import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeLog } from './paths.js';

export interface PrinterInfo {
  name: string;
  displayName: string;
  description: string;
  status: number;
  isDefault: boolean;
}

export async function listPrinters(): Promise<PrinterInfo[]> {
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    const printers = await win.webContents.getPrintersAsync();
    win.destroy();
    return printers.map((p: any) => ({
      name: p.name,
      displayName: p.displayName || p.name,
      description: p.description || '',
      status: p.status ?? 0,
      isDefault: Boolean(p.isDefault),
    }));
  } catch (err) {
    writeLog('warn', 'listPrinters failed', err);
    return [];
  }
}

const MM_TO_MICRON = 1000;
const CSS_PX_PER_INCH = 96;

function tempHtmlFile(html: string): string {
  const dir = path.join(os.tmpdir(), 'sauda-print');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `receipt-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(file, html, 'utf8');
  return file;
}

export interface PrintOptions {
  widthMm: number;
  deviceName?: string;
  /** Extra feed after the content, in millimetres. */
  feedMm?: number;
  /** Force a fixed page height (label sheets) instead of measuring content. */
  pageHeightMm?: number;
}

export interface PrintResult {
  ok: boolean;
  message: string;
  printer?: string;
  heightMm?: number;
}

/**
 * Print an HTML receipt silently to a thermal printer using the standard
 * Windows printer driver. The paper height is measured from the rendered
 * content so the driver does not eject a full A4 page.
 */
export async function printHtml(html: string, opts: PrintOptions): Promise<PrintResult> {
  let win: BrowserWindow | null = null;
  const file = tempHtmlFile(html);
  try {
    win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, offscreen: true },
    });
    await win.loadFile(file);
    const heightPx = (await win.webContents.executeJavaScript(
      'Math.ceil(document.body.getBoundingClientRect().height)',
    )) as number;
    const measuredMm = Math.ceil((heightPx / CSS_PX_PER_INCH) * 25.4) + (opts.feedMm ?? 6);
    const heightMm = Math.max(20, Math.ceil(opts.pageHeightMm ?? measuredMm));

    if (opts.deviceName) {
      const available = await win.webContents.getPrintersAsync();
      if (!available.some((p: any) => p.name === opts.deviceName)) {
        return {
          ok: false,
          message: `প্রিন্টার "${opts.deviceName}" পাওয়া যায়নি। সেটিংস থেকে প্রিন্টার নির্বাচন করুন।`,
        };
      }
    }

    const result = await new Promise<{ success: boolean; reason?: string }>((resolve) => {
      win!.webContents.print(
        {
          silent: true,
          printBackground: false,
          deviceName: opts.deviceName,
          margins: { marginType: 'none' },
          pageSize: {
            width: Math.round(opts.widthMm * MM_TO_MICRON),
            height: Math.round(heightMm * MM_TO_MICRON),
          },
        },
        (success, failureReason) => resolve({ success, reason: failureReason }),
      );
    });
    if (result.success) return { ok: true, message: 'প্রিন্ট পাঠানো হয়েছে।', printer: opts.deviceName, heightMm };
    return {
      ok: false,
      message: result.reason
        ? `প্রিন্ট ব্যর্থ: ${result.reason}`
        : 'প্রিন্ট ব্যর্থ হয়েছে। প্রিন্টার সংযোগ ও ড্রাইভার পরীক্ষা করুন।',
    };
  } catch (err) {
    writeLog('error', 'printHtml failed', err);
    return { ok: false, message: `প্রিন্ট ব্যর্থ: ${(err as Error).message}` };
  } finally {
    try {
      if (win && !win.isDestroyed()) win.destroy();
      fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Render HTML to a PDF file (Chromium performs full Bangla text shaping). */
export async function htmlToPdf(html: string, target: string): Promise<string> {
  const file = tempHtmlFile(html);
  let win: BrowserWindow | null = null;
  try {
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, offscreen: true } });
    await win.loadFile(file);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      landscape: true,
      margins: { top: 0.5, bottom: 0.5, left: 0.4, right: 0.4 },
    });
    fs.writeFileSync(target, pdf);
    return target;
  } finally {
    try {
      if (win && !win.isDestroyed()) win.destroy();
      fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  }
}
