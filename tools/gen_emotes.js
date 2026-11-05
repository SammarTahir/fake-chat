'use strict';
// Generates the placeholder emote set (PNG + animated GIF) with zero dependencies.
// Run directly (`node tools/gen_emotes.js`) or let server.js call ensurePlaceholderEmotes()
// when the emotes/ folder is empty.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- CRC32 (for PNG)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- PNG encoder (RGBA)
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy ? rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
              : Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- GIF encoder (indexed, animated)
// Uses the "clear-code flood" LZW trick: emit every pixel as a literal 9-bit code and
// reset the dictionary before it grows, so no real compression logic is needed.
class BitWriter {
  constructor() { this.bytes = []; this.cur = 0; this.nbits = 0; }
  write(code, width) {
    this.cur |= code << this.nbits;
    this.nbits += width;
    while (this.nbits >= 8) {
      this.bytes.push(this.cur & 0xff);
      this.cur >>>= 8;
      this.nbits -= 8;
    }
  }
  end() { if (this.nbits > 0) this.bytes.push(this.cur & 0xff); return Buffer.from(this.bytes); }
}
function lzwEncode(pixels) {
  const bw = new BitWriter();
  const CLEAR = 256, EOI = 257;
  bw.write(CLEAR, 9);
  let count = 0;
  for (const p of pixels) {
    bw.write(p, 9);
    if (++count === 253) { bw.write(CLEAR, 9); count = 0; } // keep code width at 9 bits
  }
  bw.write(EOI, 9);
  return bw.end();
}
function subBlocks(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i += 255) {
    const chunk = buf.subarray(i, i + 255);
    out.push(Buffer.from([chunk.length]), chunk);
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}
// frames: [{ pixels: Uint8Array of palette indices, delayCs }], palette: [[r,g,b],...] (index 0 = transparent)
function encodeGIF(w, h, frames, palette) {
  const parts = [];
  parts.push(Buffer.from('GIF89a', 'ascii'));
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(w, 0);
  lsd.writeUInt16LE(h, 2);
  lsd[4] = 0xf7; // global color table, 256 entries
  parts.push(lsd);
  const gct = Buffer.alloc(256 * 3);
  for (let i = 0; i < Math.min(palette.length, 256); i++) {
    gct[i * 3] = palette[i][0];
    gct[i * 3 + 1] = palette[i][1];
    gct[i * 3 + 2] = palette[i][2];
  }
  parts.push(gct);
  // NETSCAPE loop-forever extension
  parts.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'ascii'),
    Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]));
  for (const f of frames) {
    const gce = Buffer.from([0x21, 0xf9, 0x04, 0x09, 0, 0, 0x00, 0x00]); // disposal=2, transparent idx 0
    gce.writeUInt16LE(f.delayCs, 4);
    parts.push(gce);
    const idesc = Buffer.alloc(10);
    idesc[0] = 0x2c;
    idesc.writeUInt16LE(w, 5);
    idesc.writeUInt16LE(h, 7);
    parts.push(idesc);
    parts.push(Buffer.from([8])); // LZW min code size
    parts.push(subBlocks(lzwEncode(f.pixels)));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- tiny raster helpers
const SIZE = 56;
function img() { return { w: SIZE, h: SIZE, d: new Uint8Array(SIZE * SIZE * 4) }; }
function px(im, x, y, c) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= im.w || y >= im.h) return;
  const i = (y * im.w + x) * 4;
  im.d[i] = c[0]; im.d[i + 1] = c[1]; im.d[i + 2] = c[2]; im.d[i + 3] = c.length > 3 ? c[3] : 255;
}
function circle(im, cx, cy, r, c) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++)
    for (let x = Math.floor(cx - r); x <= cx + r; x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) px(im, x, y, c);
}
function ellipse(im, cx, cy, rx, ry, c) {
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++)
    for (let x = Math.floor(cx - rx); x <= cx + rx; x++)
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) px(im, x, y, c);
}
function rect(im, x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(im, x, y, c);
}
function hsv(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

const INK = [24, 18, 20];
const WHITE = [250, 250, 250];

function faceBase(im, color, cy = 28, rx = 24, ry = 24) {
  ellipse(im, 28, cy, rx + 1.5, ry + 1.5, [0, 0, 0, 90]); // soft outline
  ellipse(im, 28, cy, rx, ry, color);
}
function crescentEye(im, cx, cy, faceColor) { // happy closed eye ∪
  ellipse(im, cx, cy, 5, 3.4, INK);
  ellipse(im, cx, cy - 2.6, 5.6, 3.4, faceColor);
}

// ---------------------------------------------------------------- the emote set
function drawPog() {
  const im = img(), C = [255, 138, 76];
  faceBase(im, C);
  circle(im, 19, 22, 5.5, WHITE); circle(im, 37, 22, 5.5, WHITE);
  circle(im, 19.5, 22.5, 2.6, INK); circle(im, 37.5, 22.5, 2.6, INK);
  ellipse(im, 28, 39, 8.5, 10, [96, 40, 24]);
  ellipse(im, 28, 42, 6, 6, [60, 22, 14]);
  return im;
}
function drawKEKW() {
  const im = img(), C = [255, 204, 58];
  faceBase(im, C);
  crescentEye(im, 19, 20, C); crescentEye(im, 37, 20, C);
  ellipse(im, 28, 37, 12, 9, INK);
  ellipse(im, 28, 41, 7, 4.4, [214, 76, 88]);
  return im;
}
function drawLULW() {
  const im = img(), C = [255, 172, 96];
  faceBase(im, C);
  crescentEye(im, 18, 19, C); crescentEye(im, 38, 19, C);
  ellipse(im, 28, 38, 13.5, 10, INK);
  rect(im, 18, 33, 20, 3, WHITE); // teeth
  ellipse(im, 28, 43, 7, 4, [214, 76, 88]);
  return im;
}
function drawSadge() {
  const im = img(), C = [142, 164, 193];
  faceBase(im, C);
  circle(im, 19, 25, 3, INK); circle(im, 37, 25, 3, INK);
  rect(im, 14, 18, 9, 2, [70, 84, 104]); rect(im, 33, 18, 9, 2, [70, 84, 104]); // droopy brows
  ellipse(im, 28, 43, 8, 4.5, INK);
  ellipse(im, 28, 46, 9.5, 4.5, C); // frown
  circle(im, 16, 32, 2.2, [120, 190, 255]); // tear
  return im;
}
function drawEZ() {
  const im = img(), C = [96, 190, 120];
  faceBase(im, C);
  rect(im, 11, 19, 34, 8, INK); // shades
  rect(im, 12, 20, 14, 5, [50, 50, 60]); rect(im, 30, 20, 14, 5, [50, 50, 60]);
  rect(im, 22, 40, 12, 3, INK); rect(im, 32, 38, 4, 3, INK); // smirk
  return im;
}
function drawMonkaS() {
  const im = img(), C = [216, 224, 228];
  faceBase(im, C);
  circle(im, 19, 24, 7, WHITE); circle(im, 37, 24, 7, WHITE);
  circle(im, 21, 25.5, 3, INK); circle(im, 35, 25.5, 3, INK);
  rect(im, 24, 41, 8, 2.5, INK);
  circle(im, 46, 15, 3.4, [110, 190, 255]); // sweat
  ellipse(im, 46, 10, 1.8, 3.4, [110, 190, 255]);
  return im;
}
function draw5Head() {
  const im = img(), C = [255, 204, 58];
  faceBase(im, C, 30, 21, 26); // tall dome
  circle(im, 21, 40, 2.6, INK); circle(im, 35, 40, 2.6, INK);
  rect(im, 24, 48, 8, 2, INK);
  return im;
}
function drawWICKED() {
  const im = img(), C = [186, 104, 255];
  faceBase(im, C);
  // angry slanted brows + eyes
  for (let i = 0; i < 9; i++) { rect(im, 13 + i, 17 + (i >> 1), 1, 2.5, INK); rect(im, 42 - i, 17 + (i >> 1), 1, 2.5, INK); }
  circle(im, 19, 26, 3, INK); circle(im, 37, 26, 3, INK);
  ellipse(im, 28, 39, 11, 5, INK);
  rect(im, 18, 36, 20, 3, WHITE); // grin teeth
  return im;
}

// animated -------------------------------------------------------
function catJamFrames() {
  const frames = [];
  const bob = [0, -2, -4, -5, -4, -2];
  for (const dy of bob) {
    const im = img(), C = [128, 128, 134];
    faceBase(im, C, 30 + dy, 23, 21);
    // ears
    circle(im, 12, 12 + dy, 5, C); circle(im, 44, 12 + dy, 5, C);
    // headphones band + cups
    for (let x = 12; x <= 44; x++) px(im, x, 9 + dy + Math.round(((x - 28) ** 2) / 60), [40, 40, 46]);
    ellipse(im, 8, 28 + dy, 4, 7, [40, 40, 46]); ellipse(im, 48, 28 + dy, 4, 7, [40, 40, 46]);
    crescentEye(im, 20, 26 + dy, C); crescentEye(im, 36, 26 + dy, C);
    ellipse(im, 28, 38 + dy, 5, 2.6, INK);
    frames.push(im);
  }
  return { frames, delayCs: 7 };
}
function partyBlobFrames() {
  const frames = [];
  for (let i = 0; i < 8; i++) {
    const im = img(), C = hsv(i * 45, 0.72, 0.95);
    const squish = i % 2 === 0 ? 0 : 2;
    faceBase(im, C, 30 + squish / 2, 23, 22 - squish);
    crescentEye(im, 19, 24 + squish, C); crescentEye(im, 37, 24 + squish, C);
    ellipse(im, 28, 36 + squish, 8, 5, INK);
    ellipse(im, 28, 34 + squish, 9, 4, C);
    frames.push(im);
  }
  return { frames, delayCs: 9 };
}
function petFrames() {
  const frames = [];
  const handY = [4, 9, 13, 9];
  for (const hy of handY) {
    const im = img(), C = [98, 174, 90];
    faceBase(im, C, 32, 23, 20);
    circle(im, 20, 28, 4.5, WHITE); circle(im, 36, 28, 4.5, WHITE);
    circle(im, 21, 29, 2, INK); circle(im, 37, 29, 2, INK);
    rect(im, 21, 40, 14, 2.5, [50, 90, 46]);
    // pale hand
    ellipse(im, 28, hy + 4, 13, 5, [255, 219, 172]);
    rect(im, 16, hy, 24, 5, [255, 219, 172]);
    for (let f = 0; f < 4; f++) rect(im, 18 + f * 6, hy - 3, 4, 5, [255, 219, 172]);
    frames.push(im);
  }
  return { frames, delayCs: 10 };
}

// RGBA frames -> shared indexed palette (index 0 transparent)
function quantize(frames) {
  const palette = [[0, 0, 0]];
  const map = new Map();
  const indexed = frames.map((im) => {
    const out = new Uint8Array(im.w * im.h);
    for (let i = 0; i < im.w * im.h; i++) {
      const a = im.d[i * 4 + 3];
      if (a < 100) { out[i] = 0; continue; }
      const key = (im.d[i * 4] << 16) | (im.d[i * 4 + 1] << 8) | im.d[i * 4 + 2];
      let idx = map.get(key);
      if (idx === undefined) {
        idx = palette.length;
        if (idx > 255) idx = 1; // palette overflow guard (flat art never hits this)
        else palette.push([im.d[i * 4], im.d[i * 4 + 1], im.d[i * 4 + 2]]);
        map.set(key, idx);
      }
      out[i] = idx;
    }
    return out;
  });
  return { indexed, palette };
}

function ensurePlaceholderEmotes(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.readdirSync(dir).filter((f) => /\.(png|gif|webp)$/i.test(f));
  if (existing.length > 0) return [];

  const statics = {
    'Pog.png': drawPog, 'KEKW.png': drawKEKW, 'LULW.png': drawLULW, 'Sadge.png': drawSadge,
    'EZ.png': drawEZ, 'monkaS.png': drawMonkaS, '5Head.png': draw5Head, 'WICKED.png': drawWICKED,
  };
  const written = [];
  for (const [name, fn] of Object.entries(statics)) {
    const im = fn();
    fs.writeFileSync(path.join(dir, name), encodePNG(im.w, im.h, Buffer.from(im.d)));
    written.push(name);
  }
  const anims = { 'catJAM.gif': catJamFrames, 'PartyBlob.gif': partyBlobFrames, 'PETTHEPET.gif': petFrames };
  for (const [name, fn] of Object.entries(anims)) {
    const { frames, delayCs } = fn();
    const { indexed, palette } = quantize(frames);
    const gif = encodeGIF(SIZE, SIZE, indexed.map((pixels) => ({ pixels, delayCs })), palette);
    fs.writeFileSync(path.join(dir, name), gif);
    written.push(name);
  }
  return written;
}

module.exports = { ensurePlaceholderEmotes };

if (require.main === module) {
  const dir = path.join(__dirname, '..', 'emotes');
  const written = ensurePlaceholderEmotes(dir);
  console.log(written.length ? `wrote ${written.length} placeholder emotes to ${dir}` : `emotes/ not empty, nothing written`);
}
