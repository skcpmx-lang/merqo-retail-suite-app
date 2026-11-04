import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Document output for the License Generator.
 *
 * The markup always comes from the shared print layer in `@sauda/core` so a
 * licence certificate or an administrative register looks exactly as
 * professional as a customer invoice. This module only moves HTML to paper or
 * to a PDF file.
 */

function tempHtmlFile(html: string): string {
  const dir = path.join(os.tmpdir(), 'sauda-licgen-print');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `doc-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(file, html, 'utf8');
  return file;
}

export async function htmlToPdf(html: string, target: string, opts: { landscape?: boolean } = {}): Promise<string> {
  const file = tempHtmlFile(html);
  let win: BrowserWindow | null = null;
  try {
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, offscreen: true } });
    await win.loadFile(file);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      landscape: opts.landscape ?? false,
      margins: { top: 0.5, bottom: 0.5, left: 0.4, right: 0.4 },
    });
    fs.writeFileSync(target, pdf);
    return target;
  } finally {
    try {
      if (win && !win.isDestroyed()) win.destroy();
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort cleanup */
    }
  }
}

export async function openPreview(html: string): Promise<boolean> {
  const file = tempHtmlFile(html);
  const win = new BrowserWindow({ width: 900, height: 1000, autoHideMenuBar: true, title: 'প্রিভিউ' });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await win.loadFile(file);
  return true;
}

export async function printHtml(html: string): Promise<{ ok: boolean; printer?: string; message: string }> {
  const file = tempHtmlFile(html);
  let win: BrowserWindow | null = null;
  try {
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await win.loadFile(file);
    const printers = (await win.webContents.getPrintersAsync()) as { name: string; displayName?: string; isDefault?: boolean }[];
    const target = printers.find((p) => p.isDefault) ?? printers[0];
    if (!target) return { ok: false, message: 'কোনো প্রিন্টার পাওয়া যায়নি।' };
    const result = await new Promise<{ success: boolean; failureReason?: string }>((resolve) => {
      win!.webContents.print({ silent: true, deviceName: target.name, printBackground: true }, (success, failureReason) =>
        resolve({ success, failureReason }),
      );
    });
    return result.success
      ? { ok: true, printer: target.displayName || target.name, message: 'প্রিন্ট হয়েছে।' }
      : { ok: false, printer: target.displayName, message: result.failureReason ?? 'প্রিন্ট ব্যর্থ হয়েছে।' };
  } finally {
    try {
      if (win && !win.isDestroyed()) win.destroy();
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort cleanup */
    }
  }
}
