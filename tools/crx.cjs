/*
 * CRX3 packer.
 *
 * A CRX is: "Cr24" | u32le version | u32le headerLength | CrxFileHeader | ZIP
 *
 * CrxFileHeader is a protobuf:
 *   repeated AsymmetricKeyProof sha256_with_rsa = 2;
 *   optional bytes                          signed_header_data = 10000;
 *
 * The RSA signature covers:
 *   "CRX3 SignedData\0" | u32le(len(signed_header_data)) | signed_header_data | ZIP
 *
 * signed_header_data is a CrxId whose crx_id is the first 16 bytes of the
 * SHA-256 of the ZIP payload.
 */

'use strict';

const crypto = require('crypto');

/* ---------------- protobuf ---------------- */

function varint(value) {
  const bytes = [];
  let v = value;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    bytes.push(b);
  } while (v);
  return Buffer.from(bytes);
}

function tag(field, wireType) {
  return varint((field << 3) | wireType);
}

function bytesField(field, buf) {
  return Buffer.concat([tag(field, 2), varint(buf.length), buf]);
}

/* ---------------- key handling ---------------- */

function generateKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function publicKeyFromPrivate(privateKeyPem) {
  return crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' });
}

/** Chrome's extension ID: first 16 bytes of SHA-256(pubkey DER), nibbles a-p. */
function extensionIdFromPublicKey(publicKeyDer) {
  const hash = crypto.createHash('sha256').update(publicKeyDer).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0x0f));
  }
  return id;
}

/* ---------------- CRX3 ---------------- */

function packCrx3(zipBuffer, { privateKeyPem, publicKeyDer }) {
  const key = privateKeyPem || crypto.createPublicKey(publicKeyDer);
  const pubDer = publicKeyDer || crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });

  const zipHash = crypto.createHash('sha256').update(zipBuffer).digest();
  const crxId = bytesField(1, zipHash.subarray(0, 16)); // CrxId { crx_id = 1 }

  const SIGNED_PREFIX = Buffer.from('CRX3 SignedData\0', 'latin1');
  const toSign = Buffer.concat([
    SIGNED_PREFIX,
    (() => {
      const len = Buffer.alloc(4);
      len.writeUInt32LE(crxId.length, 0);
      return len;
    })(),
    crxId,
    zipBuffer,
  ]);

  const signature = crypto.sign('sha256', toSign, key);

  // AsymmetricKeyProof { public_key = 1, signature = 2 }
  const proof = Buffer.concat([bytesField(1, pubDer), bytesField(2, signature)]);

  // CrxFileHeader { sha256_with_rsa = 2, signed_header_data = 10000 }
  const header = Buffer.concat([bytesField(2, proof), bytesField(10000, crxId)]);

  const magic = Buffer.from('Cr24', 'latin1');
  const version = Buffer.alloc(4);
  version.writeUInt32LE(3, 0);
  const headerLen = Buffer.alloc(4);
  headerLen.writeUInt32LE(header.length, 0);

  return {
    crx: Buffer.concat([magic, version, headerLen, header, zipBuffer]),
    id: extensionIdFromPublicKey(pubDer),
    signature,
  };
}

/* ---------------- self-check ---------------- */

/** Re-parse a CRX and verify the RSA signature. Used by pack.js. */
function verifyCrx3(crxBuffer) {
  if (crxBuffer.toString('latin1', 0, 4) !== 'Cr24') throw new Error('bad magic');
  const version = crxBuffer.readUInt32LE(4);
  if (version !== 3) throw new Error('expected CRX3, got version ' + version);
  const headerLen = crxBuffer.readUInt32LE(8);
  const header = crxBuffer.subarray(12, 12 + headerLen);
  const zip = crxBuffer.subarray(12 + headerLen);

  // walk the header protobuf for field 2 (proof) and field 10000 (signed data)
  let i = 0;
  let proof = null;
  let signedHeaderData = null;
  const readVarint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = header[i++];
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return result >>> 0;
  };
  while (i < header.length) {
    const t = readVarint();
    const field = t >>> 3;
    const wire = t & 7;
    if (wire !== 2) throw new Error('unexpected wire type ' + wire);
    const len = readVarint();
    const data = header.subarray(i, i + len);
    i += len;
    if (field === 2) proof = data;
    if (field === 10000) signedHeaderData = data;
  }
  if (!proof || !signedHeaderData) throw new Error('missing header fields');

  // unwrap AsymmetricKeyProof
  let j = 0;
  let publicKey = null;
  let signature = null;
  const readVarint2 = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = proof[j++];
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return result >>> 0;
  };
  while (j < proof.length) {
    const t = readVarint2();
    const field = t >>> 3;
    const len = readVarint2();
    const data = proof.subarray(j, j + len);
    j += len;
    if (field === 1) publicKey = data;
    if (field === 2) signature = data;
  }
  if (!publicKey || !signature) throw new Error('missing proof fields');

  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(signedHeaderData.length, 0);
  const toVerify = Buffer.concat([
    Buffer.from('CRX3 SignedData\0', 'latin1'),
    lenBuf,
    signedHeaderData,
    zip,
  ]);

  const publicKeyObj = crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
  const valid = crypto.verify('sha256', toVerify, publicKeyObj, signature);

  // CrxId check
  const crxIdInHeader = signedHeaderData.subarray(2); // skip tag + len (16 bytes)
  const actualId = crypto.createHash('sha256').update(zip).digest().subarray(0, 16);

  return {
    valid,
    idMatchesHash: crxIdInHeader.equals(actualId),
    id: extensionIdFromPublicKey(publicKey),
    zipLength: zip.length,
  };
}

module.exports = { packCrx3, generateKeyPair, extensionIdFromPublicKey, verifyCrx3 };
