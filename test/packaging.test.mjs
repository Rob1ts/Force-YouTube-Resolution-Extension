import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { verifyCrx3 } from '../scripts/crx.mjs';
import { readZip } from '../scripts/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PACKAGE = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const XPI_NAME = `force-youtube-resolution-firefox-${PACKAGE.version}.xpi`;
const ZIP_NAME = `force-youtube-resolution-chromium-${PACKAGE.version}.zip`;
const CRX_NAME = `force-youtube-resolution-chromium-${PACKAGE.version}.crx`;

async function readDistFile(...parts) {
    return fs.readFile(path.join(DIST, ...parts));
}

function extensionIdFromKey(keyBase64) {
    const digest = crypto.createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest();
    const alphabet = 'abcdefghijklmnop';
    let id = '';
    for (const byte of digest.subarray(0, 16)) {
        id += alphabet[byte >> 4] + alphabet[byte & 0x0f];
    }
    return id;
}

test('build produces both unpacked trees', async () => {
    for (const browser of ['chromium', 'firefox']) {
        const manifest = JSON.parse(await fs.readFile(path.join(DIST, browser, 'manifest.json'), 'utf8'));
        assert.equal(manifest.manifest_version, 3);
        assert.equal(manifest.name, 'Force YouTube Resolution');
        assert.equal(manifest.version, PACKAGE.version);
        assert.deepEqual(manifest.permissions, ['storage']);
        assert.deepEqual(manifest.host_permissions, ['*://*.youtube.com/*']);
        assert.equal(manifest.content_scripts.length, 2);
        assert.equal(manifest.content_scripts[0].run_at, 'document_start');
        assert.equal(manifest.content_scripts[1].world, 'MAIN');
        assert.equal(manifest.content_scripts[0].all_frames, false);

        for (const file of ['core.js', 'content.js', 'page.bundle.js', 'popup.html', 'popup.css', 'popup.js']) {
            await fs.access(path.join(DIST, browser, file));
        }
    }
});

test('chromium manifest uses a valid stable key and a Chrome 111+ feature set', async () => {
    const manifest = JSON.parse(await readDistFile('chromium', 'manifest.json'));
    assert.equal(manifest.minimum_chrome_version, '111');
    assert.ok(manifest.key);
    assert.equal(Buffer.from(manifest.key, 'base64').length > 200, true);
    assert.equal(extensionIdFromKey(manifest.key).length, 32);
    assert.equal(manifest.browser_specific_settings, undefined);
});

test('firefox manifest declares Gecko metadata and no data collection', async () => {
    const manifest = JSON.parse(await readDistFile('firefox', 'manifest.json'));
    assert.equal(manifest.browser_specific_settings.gecko.id, 'force-youtube-resolution@local');
    assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '128.0');
    assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ['none']);
    assert.equal(manifest.key, undefined);
});

test('CRX3 signature, id and zip payload are valid', async () => {
    const manifest = JSON.parse(await readDistFile('chromium', 'manifest.json'));
    const crx = await readDistFile(CRX_NAME);
    const result = verifyCrx3(crx);

    assert.equal(result.valid, true, result.error);
    assert.equal(result.extensionId, extensionIdFromKey(manifest.key));
    assert.equal(result.payload.subarray(0, 4).toString('binary'), 'PK\u0003\u0004');

    const files = readZip(result.payload);
    assert.ok(files.has('manifest.json'));
    assert.ok(files.has('page.bundle.js'));
    const packedManifest = JSON.parse(files.get('manifest.json').toString('utf8'));
    assert.equal(packedManifest.key, manifest.key);
    assert.equal(packedManifest.world, undefined);
    assert.equal(packedManifest.content_scripts[1].world, 'MAIN');
});

test('Firefox XPI is a valid archive with the expected manifest', async () => {
    const xpi = await readDistFile(XPI_NAME);
    const files = readZip(xpi);

    assert.ok(files.has('manifest.json'));
    assert.ok(files.has('core.js'));
    assert.ok(files.has('content.js'));
    assert.ok(files.has('page.bundle.js'));
    assert.ok(files.has('icons/icon128.png'));
    assert.equal(files.has('.keys/chromium-private.pem'), false);

    const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
    assert.equal(manifest.browser_specific_settings.gecko.id, 'force-youtube-resolution@local');
    assert.equal(manifest.content_scripts[1].world, 'MAIN');
});

test('Chromium ZIP is a valid unpacked build', async () => {
    const files = readZip(await readDistFile(ZIP_NAME));
    assert.ok(files.has('manifest.json'));
    assert.ok(files.has('page.bundle.js'));
    assert.equal(files.has('manifest.firefox.json'), false);
});

test('published checksums match the packaged artifacts', async () => {
    const sums = (await readDistFile('SHA256SUMS.txt')).toString('utf8').trim().split(/\r?\n/);
    const expected = new Map(sums.map((line) => {
        const [hash, name] = line.trim().split(/\s+/);
        return [name, hash];
    }));

    for (const name of [XPI_NAME, ZIP_NAME, CRX_NAME]) {
        const data = await readDistFile(name);
        const actual = crypto.createHash('sha256').update(data).digest('hex');
        assert.equal(expected.get(name), actual, `checksum mismatch for ${name}`);
    }
    assert.equal(expected.size, 3);
});

test('runtime code has no inline HTML sinks, eval, or remote code', async () => {
    const files = [];
    for (const browser of ['chromium', 'firefox']) {
        const entries = await fs.readdir(path.join(DIST, browser), { recursive: true, withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile() && /\.(?:js|html|css)$/.test(entry.name)) {
                const fullPath = path.join(entry.parentPath, entry.name);
                files.push({ name: `${browser}/${path.relative(path.join(DIST, browser), fullPath)}`, source: await fs.readFile(fullPath, 'utf8') });
            }
        }
    }

    const forbidden = [
        /\beval\s*\(/,
        /\bnew\s+Function\s*\(/,
        /\.innerHTML\b/,
        /\.outerHTML\b/,
        /insertAdjacentHTML\s*\(/,
        /document\.write\s*\(/,
        /https?:\/\//i
    ];

    for (const file of files) {
        for (const pattern of forbidden) {
            assert.equal(pattern.test(file.source), false, `${file.name} matches forbidden pattern ${pattern}`);
        }
    }

    const popup = await readDistFile('chromium', 'popup.html');
    const popupText = popup.toString('utf8');
    const scriptTags = popupText.match(/<script\b[^>]*>/gi) || [];
    assert.ok(scriptTags.length >= 2);
    for (const tag of scriptTags) {
        assert.match(tag, /\bsrc=/, 'popup must not contain inline scripts');
    }
});

test('no private key material is copied into either build', async () => {
    for (const browser of ['chromium', 'firefox']) {
        const entries = await fs.readdir(path.join(DIST, browser), { recursive: true, withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            assert.equal(/\.(?:pem|key|p12|jks)$/i.test(entry.name), false, `${browser}/${entry.name}`);
        }
    }
});
