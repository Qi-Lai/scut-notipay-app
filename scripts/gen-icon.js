/**
 * Generate build/icon.png without any image dependencies.
 *
 * Renders a 1024x1024 scene (rounded square with an indigo→teal gradient
 * and a white lightning bolt), box-downsamples to 256x256 and writes a
 * PNG using nothing but Node's zlib.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const HI = 1024; // supersampled canvas
const OUT = 256; // final icon size
const SS = HI / OUT; // downsample factor

const img = Buffer.alloc(HI * HI * 4);

// ------------------------------------------------------------------
// Geometry helpers
// ------------------------------------------------------------------
const insideRoundedRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
};

/** Even-odd scanline polygon fill -> returns per-row [xStart, xEnd] spans */
const polygonSpans = (points) => {
  const spansByY = new Map();
  const n = points.length;
  const minY = Math.ceil(Math.min(...points.map((p) => p[1])));
  const maxY = Math.floor(Math.max(...points.map((p) => p[1])));
  for (let y = minY; y <= maxY; y++) {
    const yc = y + 0.5;
    const xs = [];
    for (let i = 0; i < n; i++) {
      const [xa, ya] = points[i];
      const [xb, yb] = points[(i + 1) % n];
      if (ya === yb) continue;
      const yMin = Math.min(ya, yb);
      const yMax = Math.max(ya, yb);
      if (yc < yMin || yc >= yMax) continue;
      xs.push(xa + ((yc - ya) * (xb - xa)) / (yb - ya));
    }
    xs.sort((a, b) => a - b);
    const spans = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      spans.push([Math.ceil(xs[i] - 0.5), Math.floor(xs[i + 1] + 0.5)]);
    }
    if (spans.length) spansByY.set(y, spans);
  }
  return spansByY;
};

// ------------------------------------------------------------------
// Scene
// ------------------------------------------------------------------
const margin = Math.round(HI * 0.04);
const radius = Math.round(HI * 0.18);

// Lightning bolt (feather "zap" polygon in a 24x24 box), scaled + centered
const zap = [
  [13, 2],
  [3, 14],
  [12, 14],
  [11, 22],
  [21, 10],
  [12, 10]
];
const boltScale = (HI * 0.72) / 24;
const boltOffset = (HI - boltScale * 24) / 2;
const boltPoints = zap.map(([x, y]) => [x * boltScale + boltOffset, y * boltScale + boltOffset]);
const boltSpans = polygonSpans(boltPoints);

// Diagonal gradient indigo → teal
const c0 = [79, 110, 247];
const c1 = [34, 184, 166];

for (let y = 0; y < HI; y++) {
  for (let x = 0; x < HI; x++) {
    const idx = (y * HI + x) * 4;
    if (!insideRoundedRect(x + 0.5, y + 0.5, margin, margin, HI - margin, HI - margin, radius)) {
      img[idx + 3] = 0; // transparent
      continue;
    }
    const t = (x + y) / (2 * HI);
    let r = Math.round(c0[0] + (c1[0] - c0[0]) * t);
    let g = Math.round(c0[1] + (c1[1] - c0[1]) * t);
    let b = Math.round(c0[2] + (c1[2] - c0[2]) * t);
    let a = 255;

    const spans = boltSpans.get(y);
    if (spans) {
      for (const [xs, xe] of spans) {
        if (x >= xs && x <= xe) {
          r = 255;
          g = 255;
          b = 255;
          break;
        }
      }
    }

    img[idx] = r;
    img[idx + 1] = g;
    img[idx + 2] = b;
    img[idx + 3] = a;
  }
}

// ------------------------------------------------------------------
// Downsample (box filter) to 256x256
// ------------------------------------------------------------------
const out = Buffer.alloc(OUT * OUT * 4);
for (let y = 0; y < OUT; y++) {
  for (let x = 0; x < OUT; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const idx = ((y * SS + dy) * HI + (x * SS + dx)) * 4;
        const alpha = img[idx + 3];
        r += img[idx] * alpha;
        g += img[idx + 1] * alpha;
        b += img[idx + 2] * alpha;
        a += alpha;
      }
    }
    const oidx = (y * OUT + x) * 4;
    if (a > 0) {
      out[oidx] = Math.round(r / a);
      out[oidx + 1] = Math.round(g / a);
      out[oidx + 2] = Math.round(b / a);
      out[oidx + 3] = Math.round(a / (SS * SS));
    } else {
      out[oidx + 3] = 0;
    }
  }
}

// ------------------------------------------------------------------
// PNG encode
// ------------------------------------------------------------------
const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT, 0);
ihdr.writeUInt32BE(OUT, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
// filter type 0 per scanline
const raw = Buffer.alloc((OUT * 4 + 1) * OUT);
for (let y = 0; y < OUT; y++) {
  raw[y * (OUT * 4 + 1)] = 0;
  out.copy(raw, y * (OUT * 4 + 1) + 1, y * OUT * 4, (y + 1) * OUT * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const dest = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, png);
console.log(`[icon] wrote ${dest} (${png.length} bytes)`);
