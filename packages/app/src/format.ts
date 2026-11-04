/** Presentation-only formatters (all arithmetic happens in the core engine). */

const BN = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

export function toBnDigits(text: string): string {
  return text.replace(/[0-9]/g, (d) => BN[Number(d)] ?? d);
}

export interface FormatPrefs {
  symbol: string;
  bengaliDigits: boolean;
}

let prefs: FormatPrefs = { symbol: '৳', bengaliDigits: false };

export function setFormatPrefs(next: Partial<FormatPrefs>): void {
  prefs = { ...prefs, ...next };
}

export function money(paisa: number | null | undefined, opts: { sign?: boolean } = {}): string {
  const value = Number(paisa ?? 0);
  const negative = value < 0;
  const abs = Math.abs(Math.round(value));
  const taka = Math.floor(abs / 100);
  const fraction = abs % 100;
  let body = `${String(taka).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(fraction).padStart(2, '0')}`;
  if (prefs.bengaliDigits) body = toBnDigits(body);
  const sign = negative ? '−' : opts.sign ? '+' : '';
  return `${sign}${prefs.symbol}${prefs.bengaliDigits ? ' ' : ' '}${body}`;
}

export function moneyPlain(paisa: number | null | undefined): string {
  const value = Number(paisa ?? 0);
  const negative = value < 0;
  const abs = Math.abs(Math.round(value));
  const taka = Math.floor(abs / 100);
  const fraction = abs % 100;
  let body = `${String(taka).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(fraction).padStart(2, '0')}`;
  if (prefs.bengaliDigits) body = toBnDigits(body);
  return `${negative ? '−' : ''}${body}`;
}

export function taka(paisa: number): string {
  return (Math.round(paisa) / 100).toFixed(2);
}

export function qty(milli: number | null | undefined, unit?: string | null): string {
  const value = Number(milli ?? 0) / 1000;
  const decimals = Number.isInteger(value) ? 0 : Math.abs(value * 100) % 10 === 0 ? 2 : 3;
  const text = value.toFixed(decimals);
  const shown = prefs.bengaliDigits ? toBnDigits(text) : text;
  return unit ? `${shown} ${unit}` : shown;
}

export function percent(x100: number): string {
  return `${(Number(x100) / 100).toFixed(2)}%`;
}

export function dateShort(value: string | null | undefined): string {
  if (!value) return '—';
  const d = value.slice(0, 10);
  const [y, m, day] = d.split('-');
  return prefs.bengaliDigits ? toBnDigits(`${day}/${m}/${y}`) : `${day}/${m}/${y}`;
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const [d, t] = value.split(' ');
  const base = dateShort(d);
  if (!t) return base;
  const hm = t.slice(0, 5);
  return `${base}, ${prefs.bengaliDigits ? toBnDigits(hm) : hm}`;
}

export function timeOnly(value: string | null | undefined): string {
  if (!value) return '—';
  const t = value.split(' ')[1] ?? '';
  const hm = t.slice(0, 5);
  return prefs.bengaliDigits ? toBnDigits(hm) : hm;
}

export function relative(value: string | null | undefined): string {
  if (!value) return '';
  const then = new Date(value.replace(' ', 'T')).getTime();
  const diff = Date.now() - then;
  if (Number.isNaN(diff)) return '';
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'এইমাত্র';
  if (mins < 60) return `${mins} মিনিট আগে`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ঘণ্টা আগে`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} দিন আগে`;
  return dateShort(value);
}

export function initials(name: string | null | undefined): string {
  const text = (name ?? '').trim();
  if (!text) return '?';
  const parts = text.split(/\s+/);
  return (parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '');
}

export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function monthStart(): string {
  return `${today().slice(0, 7)}-01`;
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const BN_MONTHS = [
  'জানুয়ারি',
  'ফেব্রুয়ারি',
  'মার্চ',
  'এপ্রিল',
  'মে',
  'জুন',
  'জুলাই',
  'আগস্ট',
  'সেপ্টেম্বর',
  'অক্টোবর',
  'নভেম্বর',
  'ডিসেম্বর',
];

export function dateLong(value: string | null | undefined): string {
  if (!value) return '—';
  const [y, m, d] = value.slice(0, 10).split('-');
  return `${Number(d)} ${BN_MONTHS[Number(m) - 1] ?? ''} ${y}`;
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'শুভ সকাল';
  if (h < 15) return 'শুভ দুপুর';
  if (h < 18) return 'শুভ বিকেল';
  return 'শুভ সন্ধ্যা';
}

export function numberText(value: number, decimals = 0): string {
  const text = Number(value ?? 0).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return prefs.bengaliDigits ? toBnDigits(text) : text;
}
