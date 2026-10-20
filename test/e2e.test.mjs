import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = path.join(ROOT, 'dist', 'chromium');
const PROFILE_DIR = path.join(ROOT, 'test-results', 'e2e-profile');

function extensionIdFromKey(keyBase64) {
    const digest = crypto.createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest();
    const alphabet = 'abcdefghijklmnop';
    let id = '';
    for (const byte of digest.subarray(0, 16)) id += alphabet[byte >> 4] + alphabet[byte & 0x0f];
    return id;
}

async function readFixture(name) {
    return fs.readFile(path.join(ROOT, 'test', 'fixtures', name), 'utf8');
}

async function waitForStatus(page, expected, timeout = 15000) {
    await page.waitForFunction((wanted) => {
        const status = window.__ytmqLastStatus && window.__ytmqLastStatus();
        if (!status) return false;
        return Object.entries(wanted).every(([key, value]) => status[key] === value);
    }, expected, { timeout });
}

async function waitForQuality(page, quality, timeout = 15000) {
    await page.waitForFunction((wanted) => window.__ytmqQuality === wanted, quality, { timeout });
}

async function setStorage(popupPage, values) {
    await popupPage.evaluate(async (settings) => {
        await chrome.storage.local.set(settings);
    }, values);
}

test('Chromium extension: settings, forcing, ads, navigation and popup status', { timeout: 180000 }, async () => {
    await fs.rm(PROFILE_DIR, { recursive: true, force: true });

    const manifest = JSON.parse(await fs.readFile(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
    const extensionId = extensionIdFromKey(manifest.key);
    const extensionUrl = `chrome-extension://${extensionId}/popup.html`;
    const watchHtml = await readFixture('watch.html');
    const homeHtml = await readFixture('home.html');
    const pageErrors = [];

    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
        channel: 'chromium',
        headless: true,
        viewport: { width: 1280, height: 800 },
        args: [
            `--disable-extensions-except=${EXTENSION_DIR}`,
            `--load-extension=${EXTENSION_DIR}`
        ]
    });

    try {
        await context.route('https://www.youtube.com/**', async (route) => {
            const url = new URL(route.request().url());
            if (url.pathname === '/favicon.ico') {
                await route.fulfill({ status: 204, body: '' });
                return;
            }
            await route.fulfill({
                status: 200,
                contentType: 'text/html; charset=utf-8',
                body: url.pathname === '/watch' ? watchHtml : homeHtml
            });
        });

        const popupPage = await context.newPage();
        await popupPage.goto(extensionUrl, { waitUntil: 'load' });
        await setStorage(popupPage, { enabled: true, maxQuality: 'highest' });

        const page = await context.newPage();
        page.on('pageerror', (error) => pageErrors.push(String(error)));
        page.on('console', (message) => {
            if (message.type() === 'error') pageErrors.push(message.text());
        });

        await page.goto('https://www.youtube.com/watch?v=TESTVIDEO01', { waitUntil: 'domcontentloaded' });

        // The extension should force the best available quality.
        await page.waitForFunction(() => window.__ytmqRangeCalls && window.__ytmqRangeCalls('highres').length > 0, null, { timeout: 15000 });
        await waitForQuality(page, 'highres');
        await waitForStatus(page, { state: 'active', targetQuality: 'highres', preference: 'highest', videoId: 'TESTVIDEO01' });

        // A specific cap must be honored and persisted through storage.
        await setStorage(popupPage, { maxQuality: '1080' });
        await page.waitForFunction(() => window.__ytmqRangeCalls('hd1080').length > 0, null, { timeout: 15000 });
        await waitForQuality(page, 'hd1080');
        await waitForStatus(page, { state: 'active', targetQuality: 'hd1080', preference: '1080' });

        // A manual quality change must be overridden while the extension is on.
        const beforeManual = await page.evaluate(() => window.__ytmqCalls.length);
        await page.evaluate(() => window.__ytmqSetQuality('hd720'));
        await waitForQuality(page, 'hd1080');
        const afterManual = await page.evaluate(() => window.__ytmqCalls.length);
        assert.ok(afterManual > beforeManual, 'manual quality change should trigger a new player call');

        // YouTube does not always emit a quality-change event. The watchdog
        // must still restore the target after a silent manual change to auto.
        await page.evaluate(() => window.__ytmqSetQuality('auto', false));
        await waitForQuality(page, 'hd1080');
        await waitForStatus(page, { state: 'active', targetQuality: 'hd1080' });

        // Ads are not fought; quality is restored when the ad ends.
        await page.evaluate(() => {
            window.__ytmqSetAd(true);
            window.__ytmqSetQuality('large');
        });
        await page.waitForTimeout(900);
        assert.equal(await page.evaluate(() => window.__ytmqQuality), 'large');
        await waitForStatus(page, { state: 'waiting', reason: 'ad' });
        await page.evaluate(() => window.__ytmqSetAd(false));
        await waitForQuality(page, 'hd1080', 15000);
        await waitForStatus(page, { state: 'active', targetQuality: 'hd1080' });

        // A selected quality that the video does not offer falls back cleanly.
        await page.evaluate(() => window.__ytmqSetAvailable(['hd1080', 'hd720', 'large', 'medium']));
        await setStorage(popupPage, { maxQuality: '1440' });
        await page.waitForFunction(() => window.__ytmqRangeCalls('hd1080').length > 0, null, { timeout: 15000 });
        await waitForStatus(page, {
            state: 'fallback',
            targetQuality: 'hd1080',
            preference: '1440',
            reason: 'preference-unavailable'
        });

        // Restore a normal list and cap.
        await page.evaluate(() => window.__ytmqSetAvailable([
            'auto', 'highres', 'hd2160', 'hd1440', 'hd1080', 'hd720',
            'large', 'medium', 'small', 'tiny'
        ]));
        await setStorage(popupPage, { maxQuality: '1080' });
        await waitForQuality(page, 'hd1080');

        // When the YouTube tab is active, the popup must show a live active state.
        await page.bringToFront();
        await popupPage.waitForTimeout(1400);
        const popupUi = await popupPage.evaluate(() => ({
            state: document.getElementById('statusCard').dataset.state,
            title: document.getElementById('statusTitle').textContent,
            chip: document.getElementById('statusChip').textContent,
            detail: document.getElementById('statusDetail').textContent
        }));
        assert.equal(popupUi.state, 'active');
        assert.equal(popupUi.title, 'Active');
        assert.equal(popupUi.chip, '1080p');
        assert.match(popupUi.detail, /Playing at 1080p/);

        // The UI toggle turns forcing off and on.
        await popupPage.bringToFront();
        await popupPage.locator('#toggle').click();
        await setStorage(popupPage, { enabled: false });
        await page.bringToFront();
        await waitForStatus(page, { state: 'disabled', enabled: false });

        const beforeDisabledChange = await page.evaluate(() =>
            window.__ytmqCalls.filter((call) => call.type === 'range' || call.type === 'set').length);
        await page.evaluate(() => window.__ytmqSetQuality('hd720'));
        await page.waitForTimeout(1200);
        assert.equal(await page.evaluate(() => window.__ytmqQuality), 'hd720');
        assert.equal(await page.evaluate(() =>
            window.__ytmqCalls.filter((call) => call.type === 'range' || call.type === 'set').length),
        beforeDisabledChange);

        await popupPage.bringToFront();
        await popupPage.locator('#toggle').click();
        await page.bringToFront();
        await waitForQuality(page, 'hd1080', 15000);
        await waitForStatus(page, { state: 'active', enabled: true, targetQuality: 'hd1080' });

        // SPA navigation is picked up and the new video is forced again.
        await page.evaluate(() => window.__ytmqNavigate('/watch?v=SECONDVIDEO'));
        await waitForStatus(page, { videoId: 'SECONDVIDEO' });
        await waitForQuality(page, 'hd1080', 15000);

        // Leaving a video page deactivates the extension without touching the player.
        await page.evaluate(() => window.__ytmqNavigate('/'));
        await waitForStatus(page, { state: 'inactive', reason: 'not-video' });

        // Invalid stored values are normalized on both sides.
        await page.evaluate(() => window.__ytmqNavigate('/watch?v=THIRDVIDEO1'));
        await waitForQuality(page, 'hd1080', 15000);
        await popupPage.evaluate(async () => {
            await chrome.storage.local.set({ maxQuality: '"><img src=x onerror=alert(1)>' });
        });
        await page.waitForFunction(() => window.__ytmqRangeCalls('highres').length > 0, null, { timeout: 15000 });
        await waitForQuality(page, 'highres');
        await waitForStatus(page, { state: 'active', targetQuality: 'highres', preference: 'highest' });

        // A forged page status must be treated as untrusted data, never markup.
        await page.evaluate(() => {
            window.postMessage({
                channel: 'youtube-max-quality',
                v: 1,
                type: 'YTMQ_STATUS',
                status: {
                    state: 'active',
                    enabled: true,
                    preference: '1080',
                    targetQuality: 'hd1080',
                    currentQuality: '<img src=x onerror=alert(1)>',
                    availableHeights: ['hd1080'],
                    videoId: '<svg onload=alert(1)>'
                }
            }, location.origin);
        });
        await page.bringToFront();
        await popupPage.waitForTimeout(1200);
        const injectionCheck = await popupPage.evaluate(() => ({
            images: document.querySelectorAll('img[src="x"]').length,
            svgs: document.querySelectorAll('svg').length,
            bodyText: document.body.textContent
        }));
        assert.equal(injectionCheck.images, 0);
        assert.equal(injectionCheck.svgs, 0);
        assert.equal(injectionCheck.bodyText.includes('onerror'), false);

        const rendererErrors = await page.evaluate(() => window.__ytmqErrors);
        assert.deepEqual(rendererErrors, []);
        assert.deepEqual(pageErrors.filter((entry) => !/favicon|ERR_FAILED/i.test(entry)), []);
    } finally {
        await context.close();
    }
});
