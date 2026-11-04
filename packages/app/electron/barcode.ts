/**
 * Offline barcode & QR generation for price labels.
 *
 * CODE128-B is implemented here directly (no native/dynamic dependency) and QR
 * codes use the pure-JS `qrcode-generator` package. Both return inline SVG so
 * the same markup prints identically in a hidden BrowserWindow.
 */

/* ------------------------------ CODE128 ------------------------------ */

// Widths of the 107 Code128 symbols: each is 11 modules in six alternating bars.
const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

/** Encodes text as a Code128-B SVG. Unsupported characters are dropped. */
export function code128Svg(
  text: string,
  opts: { height?: number; moduleWidth?: number; margin?: number; showText?: boolean } = {},
): string {
  const clean = (text ?? '').replace(/[^\x20-\x7E]/g, '').slice(0, 48);
  if (!clean) return '';
  const height = opts.height ?? 42;
  const moduleWidth = opts.moduleWidth ?? 1.3;
  const margin = opts.margin ?? 4;

  const values = [104]; // Start B
  for (const ch of clean) values.push(ch.charCodeAt(0) - 32);
  // Modulo-103 checksum
  let sum = 104;
  for (let i = 0; i < clean.length; i++) sum += (clean.charCodeAt(i) - 32) * (i + 1);
  values.push(sum % 103, 106); // checksum + stop

  const bars: number[] = [];
  for (const value of values) {
    const pattern = CODE128_PATTERNS[value];
    if (!pattern) continue;
    for (const digit of pattern) bars.push(Number(digit));
  }

  const totalModules = bars.reduce((s, n) => s + n, 0);
  const width = totalModules * moduleWidth + margin * 2;
  const textHeight = opts.showText ? 12 : 0;
  const parts: string[] = [];
  let x = margin;
  let dark = true;
  for (const run of bars) {
    const w = run * moduleWidth;
    if (dark) parts.push(`<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${height}"/>`);
    x += w;
    dark = !dark;
  }
  const label = opts.showText
    ? `<text x="${width / 2}" y="${height + 10}" font-size="9" text-anchor="middle"
         font-family="ui-monospace,monospace">${escapeXml(clean)}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(2)}" height="${height + textHeight}"
     viewBox="0 0 ${width.toFixed(2)} ${height + textHeight}" shape-rendering="crispEdges">
     <g fill="#000">${parts.join('')}</g>${label}</svg>`;
}

/* -------------------------------- QR -------------------------------- */

// Pure-JS, zero-dependency QR encoder (MIT). Bundled into the main process so
// label printing never needs the network.
import qrFactory from 'qrcode-generator';

export function qrSvg(text: string, opts: { sizePx?: number; margin?: number } = {}): string {
  const value = (text ?? '').trim();
  if (!value) return '';
  try {
    const qr = qrFactory(0, 'M');
    // Pre-encode UTF-8 so Bengali payloads survive the byte-mode encoder.
    qr.addData(Buffer.from(value, 'utf8').toString('latin1'));
    qr.make();
    const count = qr.getModuleCount();
    const margin = opts.margin ?? 2;
    const total = count + margin * 2;
    const size = opts.sizePx ?? 0;
    const dimension = size > 0 ? `width="${size}" height="${size}"` : `width="100%" height="100%"`;
    let path = '';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) path += `M${col + margin} ${row + margin}h1v1h-1z`;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" ${dimension} viewBox="0 0 ${total} ${total}"
      shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/>
      <path d="${path}" fill="#000"/></svg>`;
  } catch {
    return '';
  }
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
