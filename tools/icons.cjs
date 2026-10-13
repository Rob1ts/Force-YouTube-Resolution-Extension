/*
 * Zero-dependency PNG icon generator.
 *
 * Draws a YouTube-style rounded square with a play triangle plus three
 * ascending bars (the "resolution" cue), supersampled 4x for clean edges.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- minimal PNG encoder ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- drawing ---------------- */

const SS = 4; // supersample factor

function draw(size) {
  const S = size * SS;
  const px = Buffer.alloc(size * size * 4);

  const radius = S * 0.225;
  const inset = S * 0.055;

  // rounded-rect coverage helper (signed distance)
  const sdRoundRect = (x, y, cx, cy, hw, hh, r) => {
    const qx = Math.abs(x - cx) - (hw - r);
    const qy = Math.abs(y - cy) - (hh - r);
    const ax = Math.max(qx, 0);
    const ay = Math.max(qy, 0);
    return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
  };

  const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

  /* play triangle, pointing right (vertices in device space) */
  const tri = {
    ax: S * 0.355,
    ay: S * 0.185,
    bx: S * 0.355,
    by: S * 0.545,
    cx: S * 0.655,
    cy: S * 0.365,
  };

  const cross = (ox, oy, px, py, qx, qy) => (px - ox) * (qy - oy) - (py - oy) * (qx - ox);

  function inTriangle(x, y) {
    const d1 = cross(x, y, tri.ax, tri.ay, tri.bx, tri.by);
    const d2 = cross(x, y, tri.bx, tri.by, tri.cx, tri.cy);
    const d3 = cross(x, y, tri.cx, tri.cy, tri.ax, tri.ay);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  }

  /* three ascending quality bars along the bottom */
  const barW = S * 0.078;
  const barGap = S * 0.036;
  const barsBase = S * 0.845;
  const barsX = S * 0.335;
  const barHeights = [S * 0.075, S * 0.125, S * 0.175];

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;

      // background rounded square
      const d = sdRoundRect(cx, cy, S / 2, S / 2, S / 2 - inset, S / 2 - inset, radius);
      let a = 0;
      if (d <= 0) a = 1;
      else if (d > 1) a = 0;

      if (a <= 0) continue;

      // vertical gradient: #FF4A3D -> #B3120B
      const t = cy / S;
      let r = Math.round(255 + (179 - 255) * t);
      let g = Math.round(74 + (18 - 74) * t);
      let b = Math.round(61 + (11 - 61) * t);

      // soft top highlight
      const hl = Math.max(0, 1 - cy / (S * 0.55)) ** 2 * 0.16;
      r += (255 - r) * hl;
      g += (255 - g) * hl;
      b += (255 - b) * hl;

      let isFg = false;

      if (inTriangle(cx, cy)) isFg = true;

      if (!isFg) {
        for (let i = 0; i < barHeights.length; i++) {
          const bx0 = barsX + i * (barW + barGap);
          const bx1 = bx0 + barW;
          const by1 = barsBase;
          const by0 = barsBase - barHeights[i];
          if (inRect(cx, cy, bx0, by0, bx1, by1)) {
            isFg = true;
            break;
          }
        }
      }

      if (isFg) {
        r = 255;
        g = 255;
        b = 255;
      }

      // downsample: average the SS x SS block
      const oy = Math.floor(y / SS);
      const ox = Math.floor(x / SS);
      const idx = (oy * size + ox) * 4;
      const w = 1 / (SS * SS);
      px[idx] = Math.round(px[idx] * (1 - w) + r * w);
      px[idx + 1] = Math.round(px[idx + 1] * (1 - w) + g * w);
      px[idx + 2] = Math.round(px[idx + 2] * (1 - w) + b * w);
      px[idx + 3] = Math.round(px[idx + 3] * (1 - w) + 255 * w);
    }
  }

  return encodePng(size, size, px);
}

function writeIcons(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const sizes = [16, 32, 48, 128];
  for (const size of sizes) {
    const file = path.join(outDir, `${size}.png`);
    fs.writeFileSync(file, draw(size));
  }
  return sizes;
}

module.exports = { writeIcons };

if (require.main === module) {
  const out = process.argv[2] || path.join(__dirname, 'icons');
  const made = writeIcons(out);
  console.log('icons written:', made.join(', '), '->', out);
}
