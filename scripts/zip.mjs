import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
            value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[index] = value >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (let index = 0; index < buffer.length; index += 1) {
        crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

async function collectFiles(directory, prefix = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    const files = [];
    for (const entry of entries) {
        const absolutePath = path.join(directory, entry.name);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
            files.push(...await collectFiles(absolutePath, relativePath));
        } else if (entry.isFile()) {
            files.push({
                name: relativePath.replaceAll('\\', '/'),
                data: await fs.readFile(absolutePath)
            });
        }
    }
    return files;
}

/*
 * Small, dependency-free ZIP writer. Entries are stored with deflate
 * compression and a fixed 1980 timestamp so repeated builds are byte-stable.
 */
export function createZip(files) {
    if (!Array.isArray(files) || files.length === 0) {
        throw new Error('createZip requires at least one file');
    }

    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const file of files) {
        const name = Buffer.from(String(file.name).replaceAll('\\', '/'), 'utf8');
        const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
        const compressed = zlib.deflateRawSync(data, { level: 9 });
        const crc = crc32(data);

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);          // version needed
        localHeader.writeUInt16LE(0x0800, 6);      // UTF-8 names
        localHeader.writeUInt16LE(8, 8);           // deflate
        localHeader.writeUInt16LE(0, 10);          // time
        localHeader.writeUInt16LE(33, 12);         // 1980-01-01
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(compressed.length, 18);
        localHeader.writeUInt32LE(data.length, 22);
        localHeader.writeUInt16LE(name.length, 26);
        localHeader.writeUInt16LE(0, 28);          // extra length

        localParts.push(localHeader, name, compressed);

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(0x02014b50, 0);
        centralHeader.writeUInt16LE(0x0314, 4);    // made by Unix, version 20
        centralHeader.writeUInt16LE(20, 6);        // version needed
        centralHeader.writeUInt16LE(0x0800, 8);    // UTF-8 names
        centralHeader.writeUInt16LE(8, 10);        // deflate
        centralHeader.writeUInt16LE(0, 12);        // time
        centralHeader.writeUInt16LE(33, 14);       // 1980-01-01
        centralHeader.writeUInt32LE(crc, 16);
        centralHeader.writeUInt32LE(compressed.length, 20);
        centralHeader.writeUInt32LE(data.length, 24);
        centralHeader.writeUInt16LE(name.length, 28);
        centralHeader.writeUInt16LE(0, 30);        // extra length
        centralHeader.writeUInt16LE(0, 32);        // comment length
        centralHeader.writeUInt16LE(0, 34);        // disk number
        centralHeader.writeUInt16LE(0, 36);        // internal attributes
        centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file 0644
        centralHeader.writeUInt32LE(offset, 42);

        centralParts.push(centralHeader, name);
        offset += localHeader.length + name.length + compressed.length;
    }

    const centralDirectory = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, centralDirectory, end]);
}

export async function zipDirectory(directory) {
    const files = await collectFiles(directory);
    return createZip(files);
}

/*
 * Minimal reader used by the packaging test to prove the produced archives
 * contain exactly the expected files.
 */
export function readZip(buffer) {
    if (!Buffer.isBuffer(buffer)) throw new Error('readZip expects a Buffer');

    let endOffset = -1;
    for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65557); index -= 1) {
        if (buffer.readUInt32LE(index) === 0x06054b50) {
            endOffset = index;
            break;
        }
    }
    if (endOffset === -1) throw new Error('ZIP end-of-central-directory record not found');

    const count = buffer.readUInt16LE(endOffset + 10);
    const centralOffset = buffer.readUInt32LE(endOffset + 16);
    const files = new Map();
    let cursor = centralOffset;

    for (let index = 0; index < count; index += 1) {
        if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
            throw new Error('Invalid ZIP central directory entry');
        }

        const method = buffer.readUInt16LE(cursor + 10);
        const compressedSize = buffer.readUInt32LE(cursor + 20);
        const uncompressedSize = buffer.readUInt32LE(cursor + 24);
        const nameLength = buffer.readUInt16LE(cursor + 28);
        const extraLength = buffer.readUInt16LE(cursor + 30);
        const commentLength = buffer.readUInt16LE(cursor + 32);
        const localOffset = buffer.readUInt32LE(cursor + 42);
        const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

        if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
            throw new Error(`Invalid ZIP local header for ${name}`);
        }
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
        const data = method === 8 ? zlib.inflateRawSync(compressed) : Buffer.from(compressed);

        if (data.length !== uncompressedSize) {
            throw new Error(`ZIP size mismatch for ${name}`);
        }

        files.set(name, data);
        cursor += 46 + nameLength + extraLength + commentLength;
    }

    return files;
}
