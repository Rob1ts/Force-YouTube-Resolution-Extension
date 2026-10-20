/*
 * Render the real popup against a small mocked WebExtension API and save a 2x
 * screenshot for the README. The popup markup, CSS and controller are loaded
 * directly from src/, so the image cannot drift from the shipped UI.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const OUTPUT = path.join(ROOT, 'docs', 'screenshot-popup.png');
const PACKAGE = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));

const browser = await chromium.launch({ channel: 'chromium', headless: true });

try {
    const context = await browser.newContext({
        viewport: { width: 360, height: 720 },
        deviceScaleFactor: 2,
        colorScheme: 'dark'
    });
    const page = await context.newPage();

    await page.addInitScript(({ version }) => {
        const status = {
            state: 'active',
            enabled: true,
            preference: '1080',
            targetQuality: 'hd1080',
            currentQuality: 'hd1080',
            availableHeights: [2160, 1440, 1080, 720, 480],
            videoId: 'dQw4w9WgXcQ',
            reason: null
        };

        globalThis.chrome = {
            runtime: {
                getManifest() {
                    return { version };
                }
            },
            storage: {
                local: {
                    async get(defaults) {
                        return { ...defaults, enabled: true, maxQuality: '1080' };
                    },
                    async set() {}
                },
                onChanged: { addListener() {} }
            },
            tabs: {
                async query() {
                    return [{ id: 1, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }];
                },
                async sendMessage() {
                    return { ok: true, status };
                }
            }
        };
    }, { version: PACKAGE.version });

    await page.goto(pathToFileURL(path.join(SRC, 'popup.html')).href, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('statusCard').dataset.state === 'active');
    await page.waitForFunction(() => document.getElementById('version').textContent.length > 0);

    await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
    await page.locator('.app').screenshot({ path: OUTPUT });
    console.log(`Wrote ${path.relative(ROOT, OUTPUT)}`);
} finally {
    await browser.close();
}
