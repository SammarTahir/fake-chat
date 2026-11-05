'use strict';
// Generates the app icon (assets/icon.png + assets/icon.ico) with zero
// dependencies: a purple rounded square with a white chat bubble.
//   node tools/gen_icon.js

const fs = require('fs');
const path = require('path');
const { encodePNG } = require('./gen_emotes.js');

const PURPLE = [145, 71, 255];
const WHITE = [255, 255, 255];

// coverage-based shapes in unit coordinates (0..1), supersampled for anti-aliasing
function roundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function triangle(x, y, a, b, c) {
  const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const pt = [x, y];
  const d1 = s(pt, a, b), d2 = s(pt, b, c), d3 = s(pt, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
function colorAt(x, y) {
  if (!roundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)) return null;
  const bubble = roundRect(x, y, 0.18, 0.2, 0.82, 0.66, 0.12) ||
    triangle(x, y, [0.3, 0.6], [0.48, 0.6], [0.27, 0.82]);
  if (bubble) {
    for (const dx of [0.35, 0.5, 0.65]) if ((x - dx) ** 2 + (y - 0.43) ** 2 <= 0.055 ** 2) return PURPLE;
    return WHITE;
  }
  return PURPLE;
}

function render(size) {
  const SS = 4;
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = colorAt((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const i = (py * size + px) * 4;
      if (a) { rgba[i] = r / a; rgba[i + 1] = g / a; rgba[i + 2] = b / a; }
      rgba[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return encodePNG(size, size, rgba);
}

// .ico with PNG-compressed entries (supported since Windows Vista)
function encodeICO(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const e = i * 16;
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
const sizes = [16, 24, 32, 48, 64, 256].map((size) => ({ size, data: render(size) }));
fs.writeFileSync(path.join(out, 'icon.png'), sizes.find((s) => s.size === 256).data);
fs.writeFileSync(path.join(out, 'icon.ico'), encodeICO(sizes));
console.log('wrote assets/icon.png and assets/icon.ico');
