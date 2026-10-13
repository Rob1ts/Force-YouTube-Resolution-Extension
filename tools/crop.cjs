/*
 * Crop a PNG (no dependencies). Used to trim browser screenshots for the README.
 *
 *   node tools/crop.cjs in.png out.png x y w h
 */

'use strict';

const fs = require('fs');
const zlib = require('zlib');

/* ---- PNG decode (8-bit RGBA / RGB, non-interlaced) ---- */

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

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, rgba) {
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
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(buf) {
  let p = 8;
  let w = 0, h = 0, depth = 0, colorType = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  if (depth !== 8) throw new Error('only 8-bit PNGs supported, got ' + depth);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('unsupported colour type ' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);

  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const x = line[i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error('bad filter ' + filter);
      }
      cur[i] = v & 0xff;
    }
  }
  return { w, h, bpp, channels, data: out };
}

/** Crop and normalise to RGBA. */
function crop(img, x, y, w, h) {
  const src = img.data;
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    const sy = y + row;
    for (let col = 0; col < w; col++) {
      const sx = x + col;
      const si = (sy * img.w + sx) * img.bpp;
      const di = (row * w + col) * 4;
      if (img.channels >= 3) {
        out[di] = src[si];
        out[di + 1] = src[si + 1];
        out[di + 2] = src[si + 2];
        out[di + 3] = img.channels === 4 ? src[si + 3] : 255;
      } else {
        const g = src[si];
        out[di] = out[di + 1] = out[di + 2] = g;
        out[di + 3] = img.channels === 2 ? src[si + 1] : 255;
      }
    }
  }
  return { w, h, data: out };
}

/**
 * Trim uniform borders. `tolerance` is the max per-channel deviation from the
 * corner colour still treated as background — lets us cut browser dead space
 * without knowing the device pixel ratio.
 */
function autoTrim(img, tolerance = 6) {
  const at = (x, y) => {
    const i = (y * img.w + x) * img.bpp;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const near = (a, bg) =>
    Math.abs(a[0] - bg[0]) <= tolerance &&
    Math.abs(a[1] - bg[1]) <= tolerance &&
    Math.abs(a[2] - bg[2]) <= tolerance;

  const bg = at(0, 0);
  const isBgRow = (y) => {
    for (let x = 0; x < img.w; x++) if (!near(at(x, y), bg)) return false;
    return true;
  };
  const isBgCol = (x) => {
    for (let y = 0; y < img.h; y++) if (!near(at(x, y), bg)) return false;
    return true;
  };

  let top = 0;
  while (top < img.h - 1 && isBgRow(top)) top++;
  let bottom = img.h - 1;
  while (bottom > top && isBgRow(bottom)) bottom--;
  let left = 0;
  while (left < img.w - 1 && isBgCol(left)) left++;
  let right = img.w - 1;
  while (right > left && isBgCol(right)) right--;

  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/* ---- cli ---- */

if (require.main === module) {
  const [input, output, X, Y, W, H] = process.argv.slice(2);
  if (!output) {
    console.error('usage: node tools/crop.cjs in.png out.png [x y w h]   (omit coords to auto-trim)');
    process.exit(1);
  }
  const img = decodePng(fs.readFileSync(input));

  let x, y, w, h;
  if (X === undefined || X === 'auto') {
    const r = autoTrim(img, Number(Y || 6));
    ({ x, y, w, h } = r);
  } else {
    x = Number(X);
    y = Number(Y || 0);
    w = Math.min(Number(W || img.w), img.w - x);
    h = Math.min(Number(H || img.h), img.h - y);
  }

  const out = crop(img, x, y, w, h);
  fs.mkdirSync(require('path').dirname(output), { recursive: true });
  fs.writeFileSync(output, encodePng(out.w, out.h, out.data));
  console.log(`source ${img.w}x${img.h} -> cropped at ${x},${y} ${w}x${h}  ${output}`);
}

module.exports = { decodePng, encodePng, crop, autoTrim };
