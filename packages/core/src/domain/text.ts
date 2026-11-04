/**
 * Bilingual (Bangla + English) text utilities.
 *
 *  - `normalizeText` performs Unicode NFC normalisation and whitespace folding so
 *    the same visible string always produces the same storage/search value.
 *  - `bengaliSortKey` builds a deterministic collation key that follows the
 *    Bangla alphabet (অ, আ, ই … হ) followed by Latin, so that `ORDER BY name_sort`
 *    sorts Bangla names the way a Bangladeshi shopkeeper expects. SQLite has no
 *    locale-aware collation for Bangla, so the key is pre-computed and indexed.
 */

const BN_ORDER =
  'অআইঈউঊঋএঐওঔকখগঘঙচছজঝঞটঠডঢণতথদধনপফবভমযরলশষসহড়ঢ়য়ৎংঃঁ০১২৩৪৫৬৭৮৯';

const BN_INDEX = new Map<string, number>();
for (let i = 0; i < BN_ORDER.length; i++) BN_INDEX.set(BN_ORDER[i]!, i + 10);

/** Combining vowel signs are ignored for sorting (they attach to the consonant). */
const IGNORED_FOR_SORT = new Set([
  'া', 'ি', 'ী', 'ু', 'ূ', 'ৃ', 'ে', 'ৈ', 'ো', 'ৌ', '্', 'ঁ', 'ঃ', 'ং',
  '\u200c', '\u200d', '\u200b', ' ', '-', '_', '.', ',', '/', '\\', '\u09cd',
]);

export function normalizeText(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  try {
    s = s.normalize('NFC');
  } catch {
    /* keep raw text when the runtime cannot normalise */
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** Value stored in `_search` columns: NFC-normalised, lower-cased. */
export function foldForSearch(value: string | null | undefined): string {
  return normalizeText(value).toLowerCase();
}

export function bengaliSortKey(value: string | null | undefined): string {
  const text = foldForSearch(value);
  let out = '';
  for (const ch of text) {
    if (IGNORED_FOR_SORT.has(ch)) continue;
    const idx = BN_INDEX.get(ch);
    if (idx !== undefined) {
      out += String(idx).padStart(4, '0');
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 97 && code <= 122) {
      out += String(2000 + code - 97).padStart(4, '0'); // latin a-z
      continue;
    }
    out += String(5000 + (code % 4000)).padStart(4, '0');
  }
  return out || 'zzzz';
}

export function isBengali(text: string | null | undefined): boolean {
  if (!text) return false;
  return /[\u0980-\u09FF]/.test(text);
}

/** Highlight-safe snippet: keeps Bangla graphemes intact. */
export function snippet(text: string | null | undefined, max = 80): string {
  const s = normalizeText(text);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** Simple deterministic pseudo-random suffix used for invoice/return numbers. */
export function makeCode(prefix: string, seq: number, width = 5): string {
  return `${prefix}${String(seq).padStart(width, '0')}`;
}

export function escapeHtml(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Guard against CSV formula injection in exports. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}
