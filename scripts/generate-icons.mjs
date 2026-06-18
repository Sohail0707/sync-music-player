// scripts/generate-icons.mjs
// Generates the branded PWA icons (SMP) as PNGs — no external image libraries.
// Run: node scripts/generate-icons.mjs   (also runs automatically on `npm run build`)
//
// Design: diagonal purple->orange brand gradient + a bold white eighth note.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = 'public/icons';
mkdirSync(OUT, { recursive: true });

const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const PURPLE = [139, 92, 246];
const ORANGE = [255, 107, 44];

function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function render(S) {
  const buf = Buffer.alloc(S * S * 4);

  // Eighth-note geometry (in pixels)
  const head = { cx: 0.43 * S, cy: 0.70 * S, rx: 0.14 * S, ry: 0.11 * S };
  const stem = { x: 0.555 * S, w: 0.058 * S, top: 0.25 * S, bot: 0.71 * S };
  const flag = [
    [stem.x + stem.w, stem.top],
    [stem.x + stem.w + 0.17 * S, stem.top + 0.11 * S],
    [stem.x + stem.w + 0.12 * S, stem.top + 0.26 * S],
    [stem.x + stem.w, stem.top + 0.17 * S]
  ];

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const t = (x + y) / (2 * S); // diagonal gradient
      let r = lerp(PURPLE[0], ORANGE[0], t);
      let g = lerp(PURPLE[1], ORANGE[1], t);
      let b = lerp(PURPLE[2], ORANGE[2], t);

      // white note glyph
      const inHead = ((x - head.cx) / head.rx) ** 2 + ((y - head.cy) / head.ry) ** 2 <= 1;
      const inStem = x >= stem.x && x <= stem.x + stem.w && y >= stem.top && y <= stem.bot;
      const inFlag = pointInPoly(x, y, flag);
      if (inHead || inStem || inFlag) {
        r = g = b = 255;
      }

      const o = (y * S + x) * 4;
      buf[o] = r;
      buf[o + 1] = g;
      buf[o + 2] = b;
      buf[o + 3] = 255;
    }
  }
  return encodePng(S, S, buf);
}

// --- minimal PNG encoder (RGBA, no filtering) ---
function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter byte: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

writeFileSync(`${OUT}/icon-192.png`, render(192));
writeFileSync(`${OUT}/icon-512.png`, render(512));
writeFileSync(`${OUT}/icon-512-maskable.png`, render(512)); // glyph sits within the safe zone
console.log('✓ Generated branded SMP icons in', OUT);
