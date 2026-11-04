import type { Db } from '../db/connection.js';
import { nextCounter } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import type { AppSettings } from '../domain/types.js';

export type DocumentKind = 'sale' | 'purchase' | 'return' | 'return_purchase' | 'po';

export interface NumberContext {
  prefix: string;
  format: string;
  table: string;
  column: string;
}

function contextFor(settings: AppSettings, kind: DocumentKind): NumberContext {
  switch (kind) {
    case 'sale':
      return { prefix: settings.invoice_prefix || 'INV', format: settings.invoice_format, table: 'sales', column: 'invoice_no' };
    case 'purchase':
      return {
        prefix: settings.purchase_prefix || 'PUR',
        format: settings.invoice_format,
        table: 'purchases',
        column: 'purchase_no',
      };
    case 'return':
      return {
        prefix: `${settings.return_prefix || 'RTN'}-S`,
        format: settings.invoice_format,
        table: 'returns',
        column: 'return_no',
      };
    case 'return_purchase':
      return {
        prefix: `${settings.return_prefix || 'RTN'}-P`,
        format: settings.invoice_format,
        table: 'returns',
        column: 'return_no',
      };
    case 'po':
      return {
        prefix: `${settings.purchase_prefix || 'PUR'}-PO`,
        format: settings.invoice_format,
        table: 'purchase_orders',
        column: 'po_no',
      };
  }
}

/**
 * Build the next document number from the configured format.
 * Tokens: {prefix} {yyyy} {yy} {mm} {dd} {seq}
 * Uniqueness is verified against the target column before returning, so a
 * duplicate invoice number can never be issued.
 */
export function nextDocumentNumber(db: Db, settings: AppSettings, kind: DocumentKind): string {
  const ctx = contextFor(settings, kind);
  const now = nowLocal();
  const yyyy = now.slice(0, 4);
  const mm = now.slice(5, 7);
  const dd = now.slice(8, 10);
  const format = ctx.format && ctx.format.includes('{seq}') ? ctx.format : '{prefix}-{yy}{mm}-{seq}';
  const counterKey = `doc:${ctx.prefix}:${format.replace('{seq}', '')}:${yyyy}${mm}`;

  const exists = db.prepare(`SELECT 1 FROM ${ctx.table} WHERE ${ctx.column} = ?`);
  for (let attempt = 0; attempt < 200; attempt++) {
    const seq = nextCounter(db, counterKey);
    const candidate = format
      .replace(/\{prefix\}/g, ctx.prefix)
      .replace(/\{yyyy\}/g, yyyy)
      .replace(/\{yy\}/g, yyyy.slice(2))
      .replace(/\{mm\}/g, mm)
      .replace(/\{dd\}/g, dd)
      .replace(/\{seq\}/g, String(seq).padStart(4, '0'));
    if (!exists.get(candidate)) return candidate;
  }
  throw new Error('ইনভয়েস নম্বর তৈরি করা সম্ভব হয়নি — অনুগ্রহ করে ইনভয়েস ফরম্যাট পরিবর্তন করুন।');
}

export function previewDocumentNumber(settings: AppSettings, kind: DocumentKind, seq = 1): string {
  const ctx = contextFor(settings, kind);
  const now = nowLocal();
  return ctx.format
    .replace(/\{prefix\}/g, ctx.prefix)
    .replace(/\{yyyy\}/g, now.slice(0, 4))
    .replace(/\{yy\}/g, now.slice(2, 4))
    .replace(/\{mm\}/g, now.slice(5, 7))
    .replace(/\{dd\}/g, now.slice(8, 10))
    .replace(/\{seq\}/g, String(seq).padStart(4, '0'));
}
