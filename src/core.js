/*
 * Force YouTube Resolution - shared core.
 *
 * This file is loaded by the popup, the isolated content script and the main
 * world player bridge. It deliberately has no DOM or browser API dependency so
 * the quality selection logic can be unit tested with plain Node.js.
 */
(function (root, factory) {
    'use strict';

    const api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.YTMaxQualityCore = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const PROTOCOL_VERSION = 1;
    const CHANNEL = 'youtube-max-quality';

    const MESSAGE = Object.freeze({
        CONFIG: 'YTMQ_CONFIG',
        PAGE_READY: 'YTMQ_PAGE_READY',
        STATUS: 'YTMQ_STATUS',
        REQUEST_STATUS: 'YTMQ_REQUEST_STATUS',
        GET_STATUS: 'YTMQ_GET_STATUS'
    });

    const DEFAULT_SETTINGS = Object.freeze({
        enabled: true,
        maxQuality: 'highest'
    });

    /*
     * YouTube's internal quality identifiers. The heights are the important
     * part: YouTube does not always report the list in a predictable order, so
     * selection always sorts by height instead of trusting the array order.
     */
    const QUALITY_LEVELS = Object.freeze([
        Object.freeze({ id: 'highres', height: 4320, label: '4320p', detail: '8K' }),
        Object.freeze({ id: 'hd2880', height: 2880, label: '2880p', detail: '5K' }),
        Object.freeze({ id: 'hd2160', height: 2160, label: '2160p', detail: '4K' }),
        Object.freeze({ id: 'hd1440', height: 1440, label: '1440p', detail: '2K' }),
        Object.freeze({ id: 'hd1080', height: 1080, label: '1080p', detail: 'Full HD' }),
        Object.freeze({ id: 'hd720', height: 720, label: '720p', detail: 'HD' }),
        Object.freeze({ id: 'large', height: 480, label: '480p', detail: '' }),
        Object.freeze({ id: 'medium', height: 360, label: '360p', detail: '' }),
        Object.freeze({ id: 'small', height: 240, label: '240p', detail: '' }),
        Object.freeze({ id: 'tiny', height: 144, label: '144p', detail: '' })
    ]);

    const QUALITY_BY_ID = new Map(QUALITY_LEVELS.map(function (level) {
        return [level.id, level];
    }));

    const QUALITY_BY_HEIGHT = new Map(QUALITY_LEVELS.map(function (level) {
        return [level.height, level];
    }));

    const PREFERENCE_HEIGHTS = Object.freeze({
        '4320': 4320,
        '2880': 2880,
        '2160': 2160,
        '1440': 1440,
        '1080': 1080,
        '720': 720,
        '480': 480,
        '360': 360,
        '240': 240,
        '144': 144
    });

    const PREFERENCES = Object.freeze(
        [
            Object.freeze({ value: 'highest', label: 'Highest available', height: null })
        ].concat(
            Object.keys(PREFERENCE_HEIGHTS).map(function (value) {
                const level = QUALITY_BY_HEIGHT.get(PREFERENCE_HEIGHTS[value]);
                return Object.freeze({
                    value: value,
                    label: level.detail ? level.label + ' (' + level.detail + ')' : level.label,
                    height: level.height
                });
            })
        )
    );

    const STATUS_STATES = Object.freeze([
        'disabled',
        'inactive',
        'waiting',
        'active',
        'fallback',
        'error'
    ]);

    const STATUS_REASONS = Object.freeze([
        'not-video',
        'player-missing',
        'metadata-missing',
        'apply-failed',
        'preference-unavailable',
        'ad',
        'no-video'
    ]);

    const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

    function isPlainObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function isPreference(value) {
        return value === 'highest' ||
            (typeof value === 'string' && Object.prototype.hasOwnProperty.call(PREFERENCE_HEIGHTS, value));
    }

    function normalizePreference(value) {
        return isPreference(value) ? value : DEFAULT_SETTINGS.maxQuality;
    }

    function getPreferenceHeight(value) {
        const preference = normalizePreference(value);
        return preference === 'highest' ? null : PREFERENCE_HEIGHTS[preference];
    }

    function getPreferenceLabel(value) {
        const preference = normalizePreference(value);
        for (let index = 0; index < PREFERENCES.length; index += 1) {
            if (PREFERENCES[index].value === preference) return PREFERENCES[index].label;
        }
        return PREFERENCES[0].label;
    }

    function getQuality(id) {
        if (typeof id !== 'string') return null;
        return QUALITY_BY_ID.get(id) || null;
    }

    function getQualityByHeight(height) {
        if (typeof height !== 'number' || !Number.isInteger(height)) return null;
        return QUALITY_BY_HEIGHT.get(height) || null;
    }

    function formatQuality(id) {
        const level = getQuality(id);
        if (!level) return null;
        return level.detail ? level.label + ' (' + level.detail + ')' : level.label;
    }

    function formatQualityShort(id) {
        const level = getQuality(id);
        return level ? level.label : null;
    }

    /*
     * Accept strings (YouTube ids), normalized level objects, or numeric
     * heights. The status payload uses heights, while the player APIs use ids,
     * so being strict about the input shape here would silently discard valid
     * data as it crosses a boundary.
     */
    function toQualityLevel(value) {
        if (typeof value === 'string') return getQuality(value);
        if (typeof value === 'number') return getQualityByHeight(value);
        if (isPlainObject(value)) {
            if (typeof value.id === 'string') return getQuality(value.id);
            if (typeof value.height === 'number') return getQualityByHeight(value.height);
        }
        return null;
    }

    /*
     * Keep only quality identifiers that YouTube actually uses. This is the
     * trust boundary for data coming from the page: unknown values are
     * discarded, never displayed or passed back into the player.
     */
    function normalizeAvailableLevels(rawLevels) {
        if (!Array.isArray(rawLevels)) return [];

        const seen = new Set();
        const levels = [];

        for (let index = 0; index < rawLevels.length; index += 1) {
            const level = toQualityLevel(rawLevels[index]);
            if (!level || seen.has(level.id)) continue;
            seen.add(level.id);
            levels.push(level);
        }

        levels.sort(function (left, right) {
            return right.height - left.height;
        });

        return levels;
    }

    /*
     * Choose the highest available quality that does not exceed the user's
     * selected ceiling. If the ceiling itself is unavailable, use the next
     * lower quality; if every offered quality is above the ceiling, use the
     * lowest one (better than not applying anything at all).
     */
    function chooseQuality(rawLevels, preferenceValue) {
        const preference = normalizePreference(preferenceValue);
        const available = normalizeAvailableLevels(rawLevels);

        if (available.length === 0) {
            return {
                preference: preference,
                limitHeight: getPreferenceHeight(preference),
                level: null,
                available: available,
                exact: false,
                aboveLimit: false
            };
        }

        if (preference === 'highest') {
            return {
                preference: preference,
                limitHeight: null,
                level: available[0],
                available: available,
                exact: true,
                aboveLimit: false
            };
        }

        const limitHeight = PREFERENCE_HEIGHTS[preference];
        let chosen = null;

        for (let index = 0; index < available.length; index += 1) {
            if (available[index].height <= limitHeight) {
                chosen = available[index];
                break;
            }
        }

        if (chosen) {
            return {
                preference: preference,
                limitHeight: limitHeight,
                level: chosen,
                available: available,
                exact: chosen.height === limitHeight,
                aboveLimit: false
            };
        }

        return {
            preference: preference,
            limitHeight: limitHeight,
            level: available[available.length - 1],
            available: available,
            exact: false,
            aboveLimit: true
        };
    }

    function sanitizeSettings(rawSettings) {
        const source = isPlainObject(rawSettings) ? rawSettings : {};
        return {
            enabled: source.enabled !== false,
            maxQuality: normalizePreference(source.maxQuality)
        };
    }

    function sanitizeVideoId(value) {
        return typeof value === 'string' && VIDEO_ID_PATTERN.test(value) ? value : null;
    }

    function sanitizeAvailableHeights(rawLevels) {
        const levels = normalizeAvailableLevels(rawLevels);
        return levels.map(function (level) {
            return level.height;
        });
    }

    /*
     * The popup never trusts the page. Every status is rebuilt field by field,
     * with values constrained to known enums / formats.
     */
    function sanitizeStatus(rawStatus, now) {
        const source = isPlainObject(rawStatus) ? rawStatus : {};
        const state = STATUS_STATES.indexOf(source.state) !== -1 ? source.state : 'waiting';
        const target = getQuality(source.targetQuality);
        const current = source.currentQuality === 'auto' ? 'auto' : getQuality(source.currentQuality);
        const reason = STATUS_REASONS.indexOf(source.reason) !== -1 ? source.reason : null;

        return {
            state: state,
            enabled: source.enabled === true,
            preference: normalizePreference(source.preference),
            targetQuality: target ? target.id : null,
            targetHeight: target ? target.height : null,
            currentQuality: current ? (current === 'auto' ? 'auto' : current.id) : null,
            currentHeight: current && current !== 'auto' ? current.height : null,
            availableHeights: sanitizeAvailableHeights(source.availableHeights),
            videoId: sanitizeVideoId(source.videoId),
            reason: reason,
            updatedAt: typeof now === 'number' ? now : Date.now()
        };
    }

    function isBridgeMessage(value) {
        try {
            return isPlainObject(value) &&
                value.channel === CHANNEL &&
                value.v === PROTOCOL_VERSION &&
                typeof value.type === 'string';
        } catch (_) {
            return false;
        }
    }

    function createBridgeMessage(type, payload) {
        const message = {
            channel: CHANNEL,
            v: PROTOCOL_VERSION,
            type: type
        };

        if (isPlainObject(payload)) {
            Object.keys(payload).forEach(function (key) {
                if (key !== 'channel' && key !== 'v' && key !== 'type' && key !== '__proto__') {
                    message[key] = payload[key];
                }
            });
        }

        return message;
    }

    return Object.freeze({
        PROTOCOL_VERSION: PROTOCOL_VERSION,
        CHANNEL: CHANNEL,
        MESSAGE: MESSAGE,
        DEFAULT_SETTINGS: DEFAULT_SETTINGS,
        QUALITY_LEVELS: QUALITY_LEVELS,
        PREFERENCES: PREFERENCES,
        STATUS_STATES: STATUS_STATES,
        STATUS_REASONS: STATUS_REASONS,
        isPreference: isPreference,
        normalizePreference: normalizePreference,
        getPreferenceHeight: getPreferenceHeight,
        getPreferenceLabel: getPreferenceLabel,
        getQuality: getQuality,
        getQualityByHeight: getQualityByHeight,
        formatQuality: formatQuality,
        formatQualityShort: formatQualityShort,
        normalizeAvailableLevels: normalizeAvailableLevels,
        chooseQuality: chooseQuality,
        sanitizeSettings: sanitizeSettings,
        sanitizeVideoId: sanitizeVideoId,
        sanitizeStatus: sanitizeStatus,
        isBridgeMessage: isBridgeMessage,
        createBridgeMessage: createBridgeMessage
    });
});
