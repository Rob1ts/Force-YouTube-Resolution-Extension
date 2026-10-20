import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY_DIR = path.join(ROOT, '.keys');
const PRIVATE_KEY_PATH = path.join(KEY_DIR, 'chromium-private.pem');

const ID_ALPHABET = 'abcdefghijklmnop';

function extensionIdFromPublicKey(publicKeyDer) {
    const digest = crypto.createHash('sha256').update(publicKeyDer).digest();
    const idBytes = digest.subarray(0, 16);
    let id = '';

    for (const byte of idBytes) {
        id += ID_ALPHABET[byte >> 4] + ID_ALPHABET[byte & 0x0f];
    }

    return id;
}

/*
 * Chrome requires a stable public key for packed CRX builds. The private key is
 * generated once and kept outside the packaged extension in .keys/ (ignored by
 * git). The public key is safe to embed in the manifest.
 */
export async function getOrCreateChromiumKey() {
    await fs.mkdir(KEY_DIR, { recursive: true, mode: 0o700 });

    let privateKeyPem;
    let created = false;

    try {
        privateKeyPem = await fs.readFile(PRIVATE_KEY_PATH, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;

        const pair = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'der' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });

        privateKeyPem = pair.privateKey;
        await fs.writeFile(PRIVATE_KEY_PATH, privateKeyPem, { mode: 0o600 });
        created = true;
    }

    const privateKey = crypto.createPrivateKey(privateKeyPem);
    const publicKeyDer = crypto.createPublicKey(privateKey).export({
        type: 'spki',
        format: 'der'
    });

    return {
        created,
        privateKey,
        privateKeyPem,
        publicKeyDer,
        publicKeyBase64: publicKeyDer.toString('base64'),
        crxId: crypto.createHash('sha256').update(publicKeyDer).digest().subarray(0, 16),
        extensionId: extensionIdFromPublicKey(publicKeyDer)
    };
}
