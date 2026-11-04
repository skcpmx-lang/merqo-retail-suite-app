/**
 * Date/time helpers. Business dates are stored as LOCAL wall-clock strings
 * ("YYYY-MM-DD HH:mm:ss") so that day-based reports match what the shopkeeper
 * sees on the wall clock. Audit/technical timestamps use UTC ISO strings.
 */

const pad = (n: number, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, '0');

export function nowLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

export function nowUtc(): string {
  return new Date().toISOString();
}

export function todayLocal(): string {
  return nowLocal().slice(0, 10);
}

export function localDateOf(value: string | Date): string {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  if (!value) return todayLocal();
  return value.length >= 10 ? value.slice(0, 10) : value;
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = localDateOf(dateStr).split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export function addMonths(dateStr: string, months: number): string {
  const [y, m, d] = localDateOf(dateStr).split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1 + months, d);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export function startOfWeek(dateStr: string): string {
  const [y, m, d] = localDateOf(dateStr).split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  // Bangladesh working week starts on Saturday.
  const dow = dt.getDay(); // 0=Sun .. 6=Sat
  const back = (dow + 1) % 7;
  return addDays(dateStr, -back);
}

export function startOfMonth(dateStr: string): string {
  const d = localDateOf(dateStr);
  return `${d.slice(0, 7)}-01`;
}

export function startOfYear(dateStr: string): string {
  return `${localDateOf(dateStr).slice(0, 4)}-01-01`;
}

export function daysBetween(from: string, to: string): number {
  const a = new Date(`${localDateOf(from)}T00:00:00`).getTime();
  const b = new Date(`${localDateOf(to)}T00:00:00`).getTime();
  return Math.round((b - a) / 86_400_000);
}

export function eachDay(from: string, to: string, maxDays = 400): string[] {
  const out: string[] = [];
  let cur = localDateOf(from);
  const end = localDateOf(to);
  let guard = 0;
  while (cur <= end && guard++ < maxDays) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
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

export const BN_DAYS = ['রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার'];

export function formatDateBn(dateStr: string): string {
  if (!dateStr) return '';
  const d = localDateOf(dateStr);
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return `${day} ${BN_MONTHS[m - 1]} ${y}`;
}

export function formatDateTimeBn(dateStr: string): string {
  if (!dateStr) return '';
  const [datePart, timePart] = dateStr.split(' ');
  const base = formatDateBn(datePart ?? '');
  if (!timePart) return base;
  let [h, min] = timePart.split(':').map(Number) as [number, number];
  const ampm = h >= 12 ? 'বিকাল' : 'সকাল';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${base}, ${ampm === 'সকাল' ? '' : h >= 16 ? '' : ''}${h12}:${pad(min)} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Shot greetings used by the dashboard header. */
export function greetingBn(date = new Date()): string {
  const h = date.getHours();
  if (h < 12) return 'শুভ সকাল';
  if (h < 15) return 'শুভ দুপুর';
  if (h < 18) return 'শুভ বিকেল';
  return 'শুভ সন্ধ্যা';
}

/** Motor-accurate duration label, e.g. "৩ দিন" for licence countdowns. */
export function daysRemaining(expiresAt: string | null): number | null {
  if (!expiresAt) return null;
  const end = new Date(`${localDateOf(expiresAt)}T23:59:59`).getTime();
  return Math.ceil((end - Date.now()) / 86_400_000);
}
