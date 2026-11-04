/**
 * Generates the application icon (PNG) with no external image tooling.
 * Draws the original Sauda mark — an abstract ledger "S" on a deep-teal tile —
 * and writes 512/256/64 px PNGs plus a Windows .ico container.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'build');
fs.mkdirSync(outDir, { recursive: true });

/* ------------------------------ PNG utils ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------- drawing ------------------------------- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Signed distance to a thick polyline (points in 0..1 space). */
function distanceToPolyline(px, py, points) {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = clamp01(t);
    const cx = x1 + t * dx;
    const cy = y1 + t * dy;
    const d = Math.hypot(px - cx, py - cy);
    if (d < best) best = d;
  }
  return best;
}

/** Samples a cubic bezier from p0 to p1 with controls c1/c2. */
function cubic(p0, c1, c2, p1, steps = 60) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x = mt * mt * mt * p0[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t * t * t * p1[0];
    const y = mt * mt * mt * p0[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t * t * t * p1[1];
    pts.push([x, y]);
  }
  return pts;
}

// Original "S" mark: a ledger stroke that starts top-right, hooks left, cuts
// back through the middle and sweeps out bottom-left.
const S_PATH = [
  ...cubic([0.715, 0.315], [0.66, 0.225], [0.375, 0.235], [0.37, 0.405]),
  ...cubic([0.37, 0.405], [0.365, 0.545], [0.635, 0.455], [0.632, 0.605]).slice(1),
  ...cubic([0.632, 0.605], [0.63, 0.75], [0.40, 0.755], [0.305, 0.715]).slice(1),
];
const STROKE = 0.058;

function shade(t) {
  // diagonal gradient #12907e → #06372f
  const from = [18, 144, 126];
  const to = [6, 55, 47];
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ];
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = 0.225; // rounded tile
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const idx = (y * size + x) * 4;

      // rounded-rect coverage
      const dx = Math.max(radius - u, u - (1 - radius), 0);
      const dy = Math.max(radius - v, v - (1 - radius), 0);
      const cornerDist = Math.hypot(dx, dy);
      const inside = cornerDist <= radius;
      const edge = clamp01((radius - cornerDist) * size + 0.5);
      if (!inside && edge <= 0) {
        rgba[idx + 3] = 0;
        continue;
      }

      const tint = shade(clamp01((u + v) / 2));
      let [r, g, b] = tint;

      // the "S" mark
      const d = distanceToPolyline(u, v, S_PATH);
      const strokeAlpha = clamp01((STROKE / 2 - d) * size + 0.5);
      if (strokeAlpha > 0) {
        r = Math.round(r + (234 - r) * strokeAlpha);
        g = Math.round(g + (250 - g) * strokeAlpha);
        b = Math.round(b + (245 - b) * strokeAlpha);
      }

      // amber accent dot
      const dot = Math.hypot(u - 0.755, v - 0.715);
      const dotAlpha = clamp01((0.045 - dot) * size + 0.5);
      if (dotAlpha > 0) {
        r = Math.round(r + (233 - r) * dotAlpha);
        g = Math.round(g + (162 - g) * dotAlpha);
        b = Math.round(b + (59 - b) * dotAlpha);
      }

      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = Math.round(255 * (edge > 0 ? edge : 1));
    }
  }
  return encodePng(size, size, rgba);
}

/* -------------------------------- ICO --------------------------------- */

function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

const sizes = [512, 256, 64, 32];
const rendered = sizes.map((size) => ({ size, data: render(size) }));
for (const { size, data } of rendered) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), data);
}
fs.writeFileSync(path.join(outDir, 'icon.png'), rendered[0].data);
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(rendered.filter((r) => r.size >= 32)));

console.log('[icons] build/icon.png, build/icon.ico and size variants generated');
