/* Renders the generated icons side by side, upscaled, so small-size
 * legibility can be eyeballed. Debug helper only. */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC_DIR = process.argv[2] || path.join(__dirname, '..', 'Chromium', 'icons');
const OUT = process.argv[3] || path.join(__dirname, '..', 'icon-sheet.png');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};
const encodePng = (w, h, rgba) => {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

function decodePng(buf) {
  let p = 8;
  let w = 0, h = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    if (filter !== 0) throw new Error('unsupported filter ' + filter);
    line.copy(out, y * stride);
  }
  return { w, h, data: out };
}

const sizes = [16, 32, 48, 128];
const gap = 8;
const pad = 8;
const zoom = [6, 3, 2, 1];
const cells = sizes.map((s, i) => ({ s, z: zoom[i] }));
const rowH = Math.max(...cells.map((c) => c.s * c.z)) + pad * 2;
const width = cells.reduce((a, c) => a + c.s * c.z + gap, pad) + pad;
const height = rowH * 2 + gap * 2;

const canvas = Buffer.alloc(width * height * 4);
for (let i = 0; i < width * height; i++) {
  const onDark = Math.floor(i / width / rowH) === 1;
  const v = onDark ? 32 : 245;
  canvas[i * 4] = v; canvas[i * 4 + 1] = v; canvas[i * 4 + 2] = v; canvas[i * 4 + 3] = 255;
}

let x = pad;
for (const c of cells) {
  const img = decodePng(fs.readFileSync(path.join(SRC_DIR, `${c.s}.png`)));
  const dw = c.s * c.z;
  for (let row = 0; row < 2; row++) {
    const oy = pad + row * (rowH + gap);
    for (let dy = 0; dy < dw; dy++) {
      for (let dx = 0; dx < dw; dx++) {
        const si = (Math.floor(dy / c.z) * img.w + Math.floor(dx / c.z)) * 4;
        const a = img.data[si + 3] / 255;
        const di = ((oy + dy) * width + (x + dx)) * 4;
        canvas[di] = Math.round(canvas[di] * (1 - a) + img.data[si] * a);
        canvas[di + 1] = Math.round(canvas[di + 1] * (1 - a) + img.data[si + 1] * a);
        canvas[di + 2] = Math.round(canvas[di + 2] * (1 - a) + img.data[si + 2] * a);
      }
    }
  }
  x += dw + gap;
}

fs.writeFileSync(OUT, encodePng(width, height, canvas));
console.log('wrote', OUT, `${width}x${height}`);
