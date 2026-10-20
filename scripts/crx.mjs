import crypto from 'node:crypto';

const CRX_MAGIC = Buffer.from('Cr24', 'binary');
const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\x00', 'binary');
const ID_ALPHABET = 'abcdefghijklmnop';

function encodeVarint(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error('Invalid varint value');
    }

    const bytes = [];
    let remaining = value;

    do {
        let byte = remaining & 0x7f;
        remaining = Math.floor(remaining / 128);
        if (remaining > 0) byte |= 0x80;
        bytes.push(byte);
    } while (remaining > 0);

    return Buffer.from(bytes);
}

function fieldBytes(fieldNumber, data) {
    const tag = encodeVarint((fieldNumber << 3) | 2);
    const length = encodeVarint(data.length);
    return Buffer.concat([tag, length, data]);
}

function uint32le(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value, 0);
    return buffer;
}

function readVarint(buffer, offset) {
    let value = 0;
    let shift = 0;
    let cursor = offset;

    while (cursor < buffer.length) {
        const byte = buffer[cursor];
        cursor += 1;
        value += (byte & 0x7f) * (2 ** shift);
        if ((byte & 0x80) === 0) return { value, offset: cursor };
        shift += 7;
        if (shift > 49) break;
    }

    throw new Error('Invalid protobuf varint');
}

function parseFields(buffer) {
    const fields = [];
    let cursor = 0;

    while (cursor < buffer.length) {
        const tag = readVarint(buffer, cursor);
        cursor = tag.offset;
        const fieldNumber = Math.floor(tag.value / 8);
        const wireType = tag.value & 0x07;

        if (wireType === 2) {
            const length = readVarint(buffer, cursor);
            cursor = length.offset;
            const end = cursor + length.value;
            if (end > buffer.length) throw new Error('Invalid protobuf field length');
            fields.push({ field: fieldNumber, wire: 2, value: buffer.subarray(cursor, end) });
            cursor = end;
        } else if (wireType === 0) {
            const value = readVarint(buffer, cursor);
            cursor = value.offset;
            fields.push({ field: fieldNumber, wire: 0, value: value.value });
        } else {
            throw new Error(`Unsupported protobuf wire type ${wireType}`);
        }
    }

    return fields;
}

function fieldValue(fields, fieldNumber) {
    const match = fields.find((field) => field.field === fieldNumber);
    return match ? match.value : null;
}

function extensionIdFromBytes(idBytes) {
    let id = '';
    for (const byte of idBytes) {
        id += ID_ALPHABET[byte >> 4] + ID_ALPHABET[byte & 0x0f];
    }
    return id;
}

export function packCrx3(zipBuffer, privateKey, publicKeyDer, crxId) {
    if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length === 0) {
        throw new Error('CRX payload must be a non-empty Buffer');
    }
    if (!Buffer.isBuffer(publicKeyDer)) {
        throw new Error('Public key must be a Buffer');
    }
    if (!Buffer.isBuffer(crxId) || crxId.length !== 16) {
        throw new Error('CRX id must be 16 bytes');
    }

    const signedHeaderData = fieldBytes(1, crxId);
    const signedPayload = Buffer.concat([
        SIGNATURE_CONTEXT,
        uint32le(signedHeaderData.length),
        signedHeaderData,
        zipBuffer
    ]);
    const signature = crypto.sign('sha256', signedPayload, privateKey);

    const proof = Buffer.concat([
        fieldBytes(1, publicKeyDer),
        fieldBytes(2, signature)
    ]);
    const header = Buffer.concat([
        fieldBytes(2, proof),
        fieldBytes(10000, signedHeaderData)
    ]);

    return Buffer.concat([
        CRX_MAGIC,
        uint32le(3),
        uint32le(header.length),
        header,
        zipBuffer
    ]);
}

/*
 * Structural + cryptographic verification used by the packaging test. A valid
 * result means the CRX is internally consistent; it does not imply that a
 * branded browser will accept an off-store installation.
 */
export function verifyCrx3(crxBuffer) {
    if (!Buffer.isBuffer(crxBuffer) || crxBuffer.length < 12) {
        return { valid: false, error: 'missing CRX header' };
    }
    if (!crxBuffer.subarray(0, 4).equals(CRX_MAGIC)) {
        return { valid: false, error: 'bad CRX magic' };
    }
    if (crxBuffer.readUInt32LE(4) !== 3) {
        return { valid: false, error: 'unsupported CRX version' };
    }

    const headerLength = crxBuffer.readUInt32LE(8);
    const headerEnd = 12 + headerLength;
    if (headerEnd > crxBuffer.length) {
        return { valid: false, error: 'truncated CRX header' };
    }

    const header = crxBuffer.subarray(12, headerEnd);
    const payload = crxBuffer.subarray(headerEnd);

    try {
        const headerFields = parseFields(header);
        const proofBlock = fieldValue(headerFields, 2);
        const signedHeaderData = fieldValue(headerFields, 10000);

        if (!proofBlock || !signedHeaderData) {
            return { valid: false, error: 'missing CRX proof or signed header' };
        }

        const proofFields = parseFields(proofBlock);
        const publicKeyDer = fieldValue(proofFields, 1);
        const signature = fieldValue(proofFields, 2);

        if (!publicKeyDer || !signature) {
            return { valid: false, error: 'missing public key or signature' };
        }

        const signedHeaderFields = parseFields(signedHeaderData);
        const crxId = fieldValue(signedHeaderFields, 1);
        if (!crxId || crxId.length !== 16) {
            return { valid: false, error: 'missing CRX id' };
        }

        const signedPayload = Buffer.concat([
            SIGNATURE_CONTEXT,
            uint32le(signedHeaderData.length),
            signedHeaderData,
            payload
        ]);

        const publicKey = crypto.createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
        const signatureValid = crypto.verify('sha256', signedPayload, publicKey, signature);
        if (!signatureValid) {
            return { valid: false, error: 'signature verification failed' };
        }

        const expectedId = crypto.createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);
        if (!expectedId.equals(crxId)) {
            return { valid: false, error: 'CRX id does not match public key' };
        }

        return {
            valid: true,
            extensionId: extensionIdFromBytes(crxId),
            crxIdHex: crxId.toString('hex'),
            payloadOffset: headerEnd,
            payload
        };
    } catch (error) {
        return { valid: false, error: error.message };
    }
}
