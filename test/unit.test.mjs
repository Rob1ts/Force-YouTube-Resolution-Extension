import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const core = require('../src/core.js');

test('quality levels are ordered by height and cover YouTube identifiers', () => {
    assert.equal(core.QUALITY_LEVELS[0].id, 'highres');
    assert.equal(core.QUALITY_LEVELS.at(-1).id, 'tiny');
    assert.ok(core.QUALITY_LEVELS.some((level) => level.id === 'hd2880'));
    assert.deepEqual(
        core.QUALITY_LEVELS.map((level) => level.height),
        [...core.QUALITY_LEVELS.map((level) => level.height)].sort((a, b) => b - a)
    );
});

test('normalizeAvailableLevels filters auto, unknown ids, duplicates and sorts by height', () => {
    const levels = core.normalizeAvailableLevels([
        'auto',
        'hd720',
        'bogus',
        'hd2160',
        'hd720',
        null,
        'hd1080',
        'hd1440'
    ]);

    assert.deepEqual(levels.map((level) => level.id), ['hd2160', 'hd1440', 'hd1080', 'hd720']);
});

test('normalizeAvailableLevels accepts normalized objects and numeric heights at boundaries', () => {
    const levels = core.normalizeAvailableLevels([
        { id: 'hd2160', height: 2160 },
        'hd1440',
        1080,
        { height: 720 },
        { id: 'auto' },
        { nope: true },
        NaN
    ]);

    assert.deepEqual(levels.map((level) => level.id), ['hd2160', 'hd1440', 'hd1080', 'hd720']);
    assert.deepEqual(levels.map((level) => level.height), [2160, 1440, 1080, 720]);
});

test('sanitizeStatus can round-trip its own availableHeights output', () => {
    const first = core.sanitizeStatus({
        state: 'active',
        enabled: true,
        preference: '1080',
        targetQuality: 'hd1080',
        currentQuality: 'hd1080',
        availableHeights: ['hd2160', 'hd1440', 'hd1080'],
        videoId: 'dQw4w9WgXcQ'
    });
    const second = core.sanitizeStatus(first);

    assert.deepEqual(second.availableHeights, [2160, 1440, 1080]);
    assert.equal(second.targetQuality, 'hd1080');
});

test('highest preference selects the highest real quality regardless of array order', () => {
    const choice = core.chooseQuality(['medium', 'hd1080', 'highres', 'auto', 'hd2160'], 'highest');
    assert.equal(choice.level.id, 'highres');
    assert.equal(choice.level.height, 4320);
    assert.equal(choice.exact, true);
    assert.equal(choice.limitHeight, null);
});

test('a specific ceiling picks the exact quality when available', () => {
    const choice = core.chooseQuality(['hd2160', 'hd1440', 'hd1080', 'hd720', 'large'], '1080');
    assert.equal(choice.level.id, 'hd1080');
    assert.equal(choice.exact, true);
    assert.equal(choice.aboveLimit, false);
});

test('a missing ceiling falls back to the highest quality below it', () => {
    const choice = core.chooseQuality(['hd2160', 'hd1080', 'hd720', 'large'], '1440');
    assert.equal(choice.level.id, 'hd1080');
    assert.equal(choice.exact, false);
    assert.equal(choice.aboveLimit, false);
    assert.equal(choice.limitHeight, 1440);
});

test('a ceiling below every offered quality chooses the lowest available', () => {
    const choice = core.chooseQuality(['hd1080', 'hd720', 'large', 'medium'], '144');
    assert.equal(choice.level.id, 'medium');
    assert.equal(choice.level.height, 360);
    assert.equal(choice.exact, false);
    assert.equal(choice.aboveLimit, true);
});

test('a high ceiling above every offered quality chooses the best available', () => {
    const choice = core.chooseQuality(['hd1080', 'hd720'], '4320');
    assert.equal(choice.level.id, 'hd1080');
    assert.equal(choice.exact, false);
    assert.equal(choice.aboveLimit, false);
});

test('empty or invalid quality lists produce no target', () => {
    for (const input of [null, undefined, [], ['auto'], ['unknown'], 'hd1080', 42]) {
        const choice = core.chooseQuality(input, 'highest');
        assert.equal(choice.level, null);
    }
});

test('sanitizeSettings validates untrusted storage values', () => {
    assert.deepEqual(core.sanitizeSettings({ enabled: false, maxQuality: '720' }), {
        enabled: false,
        maxQuality: '720'
    });
    assert.deepEqual(core.sanitizeSettings({ enabled: 'false', maxQuality: '4k' }), {
        enabled: true,
        maxQuality: 'highest'
    });
    assert.deepEqual(core.sanitizeSettings(null), {
        enabled: true,
        maxQuality: 'highest'
    });
});

test('sanitizeStatus rebuilds every field and rejects injected markup', () => {
    const status = core.sanitizeStatus({
        state: 'active"><img src=x onerror=alert(1)>',
        enabled: true,
        preference: '9000',
        targetQuality: 'hd1080',
        currentQuality: '<script>alert(1)</script>',
        availableHeights: ['hd2160', 'hd1440', 'bogus', 99999999],
        videoId: '"><svg onload=alert(1)>',
        reason: 'evil',
        updatedAt: 'now'
    }, 1234567890);

    assert.deepEqual(status, {
        state: 'waiting',
        enabled: true,
        preference: 'highest',
        targetQuality: 'hd1080',
        targetHeight: 1080,
        currentQuality: null,
        currentHeight: null,
        availableHeights: [2160, 1440],
        videoId: null,
        reason: null,
        updatedAt: 1234567890
    });
});

test('sanitizeStatus accepts auto and clamps video ids', () => {
    const status = core.sanitizeStatus({
        state: 'active',
        enabled: true,
        preference: '1080',
        targetQuality: 'hd1080',
        currentQuality: 'auto',
        availableHeights: ['hd1080'],
        videoId: 'dQw4w9WgXcQ',
        reason: null
    });

    assert.equal(status.currentQuality, 'auto');
    assert.equal(status.currentHeight, null);
    assert.equal(status.videoId, 'dQw4w9WgXcQ');
    assert.equal(status.targetHeight, 1080);
    assert.ok(core.sanitizeVideoId('a'.repeat(33)) === null);
});

test('bridge messages have a fixed envelope and do not permit prototype pollution', () => {
    const payload = JSON.parse('{"__proto__":{"polluted":true},"x":1,"settings":{"enabled":false}}');
    const message = core.createBridgeMessage(core.MESSAGE.CONFIG, payload);

    assert.equal(message.channel, core.CHANNEL);
    assert.equal(message.v, core.PROTOCOL_VERSION);
    assert.equal(message.type, core.MESSAGE.CONFIG);
    assert.equal(message.x, 1);
    assert.equal(message.settings.enabled, false);
    assert.equal({}.polluted, undefined);
    assert.equal(core.isBridgeMessage(message), true);
    assert.equal(core.isBridgeMessage({ channel: core.CHANNEL, v: 99, type: 'x' }), false);
    assert.equal(core.isBridgeMessage(null), false);
});

test('preferences expose labels and heights for the popup', () => {
    assert.equal(core.PREFERENCES[0].value, 'highest');
    assert.equal(core.PREFERENCES[0].label, 'Highest available');
    assert.equal(core.getPreferenceHeight('1080'), 1080);
    assert.equal(core.getPreferenceHeight('highest'), null);
    assert.equal(core.getPreferenceLabel('2160'), '2160p (4K)');
    assert.equal(core.formatQuality('hd2160'), '2160p (4K)');
    assert.equal(core.formatQualityShort('tiny'), '144p');
});
