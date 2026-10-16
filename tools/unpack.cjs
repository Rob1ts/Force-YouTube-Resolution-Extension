/*
 * Unpack a browser extension package for inspection.
 *
 * Handles plain .zip/.xpi archives and Chrome .crx (v2 and v3) wrappers.
 *
 *   node tools/unpack.cjs <package.xpi|crx|zip> [outDir]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function readZip(buf, dest) {
  fs.mkdirSync(dest, { recursive: true });

  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('end of central directory not found — not a zip');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  let written = 0;

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory at ' + off);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    if (!name.endsWith('/')) {
      const lnameLen = buf.readUInt16LE(lho + 26);
      const lextraLen = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + lnameLen + lextraLen;
      const data = buf.subarray(start, start + csize);
      const target = path.join(dest, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, method === 0 ? data : zlib.inflateRawSync(data));
      written++;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return written;
}

/** Strip a Chrome CRX header if present, returning just the zip payload. */
function stripCrx(buf) {
  if (buf.toString('latin1', 0, 4) !== 'Cr24') return buf;
  const version = buf.readUInt32LE(4);
  if (version === 3) {
    return buf.subarray(12 + buf.readUInt32LE(8));
  }
  if (version === 2) {
    const pubLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    return buf.subarray(16 + buf.readUInt32LE(16) + pubLen + sigLen);
  }
  throw new Error('unsupported CRX version ' + version);
}

const input = process.argv[2];
const dest = process.argv[3] || path.join('unpacked', path.basename(input || '', path.extname(input || '')) || 'out');

if (!input) {
  console.error('usage: node tools/unpack.cjs <package.xpi|crx|zip> [outDir]');
  process.exit(1);
}

const buf = fs.readFileSync(input);
const n = readZip(stripCrx(buf), dest);
console.log(`wrote ${n} files from ${path.basename(input)} -> ${dest}`);
