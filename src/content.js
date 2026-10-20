/*
 * Force YouTube Resolution - isolated content script.
 *
 * Owns extension storage and validates every message that crosses between the
 * popup and the page. The main-world bridge never receives extension APIs and
 * the popup never receives raw page data.
 */
(function () {
    'use strict';

    const core = globalThis.YTMaxQualityCore;

    if (!core) return;

    const api = globalThis.browser && globalThis.browser.runtime
        ? globalThis.browser
        : globalThis.chrome;

    if (!api || !api.runtime || !api.storage) return;

    const MESSAGE = core.MESSAGE;
    let settings = core.sanitizeSettings(core.DEFAULT_SETTINGS);
    let settingsLoaded = false;
    let lastStatus = core.sanitizeStatus({
        state: settings.enabled ? 'waiting' : 'disabled',
        enabled: settings.enabled,
        preference: settings.maxQuality,
        targetQuality: null,
        currentQuality: null,
        availableHeights: [],
        videoId: null,
        reason: settings.enabled ? 'player-missing' : null
    }, Date.now());

    function postToPage(type, payload) {
        try {
            window.postMessage(core.createBridgeMessage(type, payload), location.origin);
        } catch (_) {
            /* Page is navigating or in an unsupported state. */
        }
    }

    function sendConfig() {
        postToPage(MESSAGE.CONFIG, { settings: settings });
    }

    function requestFreshStatus() {
        postToPage(MESSAGE.REQUEST_STATUS, {});
    }

    function publicStatus() {
        const status = Object.assign({}, lastStatus);
        status.enabled = settings.enabled;
        status.preference = settings.maxQuality;

        if (!settings.enabled) {
            status.state = 'disabled';
            status.reason = null;
            status.targetQuality = null;
            status.targetHeight = null;
        }

        return status;
    }

    function applyPageStatus(rawStatus) {
        const status = core.sanitizeStatus(rawStatus, Date.now());
        status.enabled = settings.enabled;
        status.preference = settings.maxQuality;

        /*
         * If the user switched the extension off, never display a stale active
         * state even if a message from the page was already in flight.
         */
        if (!settings.enabled) {
            status.state = 'disabled';
            status.reason = null;
            status.targetQuality = null;
            status.targetHeight = null;
        }

        lastStatus = status;
    }

    function handlePageMessage(event) {
        if (event.source !== window || event.origin !== location.origin) return;
        if (!core.isBridgeMessage(event.data)) return;

        const data = event.data;

        if (data.type === MESSAGE.PAGE_READY) {
            if (settingsLoaded) {
                sendConfig();
                requestFreshStatus();
            }
            return;
        }

        if (data.type === MESSAGE.STATUS) {
            applyPageStatus(data.status);
        }
    }

    async function loadSettings() {
        try {
            const stored = await api.storage.local.get(core.DEFAULT_SETTINGS);
            settings = core.sanitizeSettings(stored);
        } catch (_) {
            settings = core.sanitizeSettings(core.DEFAULT_SETTINGS);
        }

        lastStatus.enabled = settings.enabled;
        lastStatus.preference = settings.maxQuality;
        if (!settings.enabled) {
            lastStatus.state = 'disabled';
            lastStatus.reason = null;
            lastStatus.targetQuality = null;
            lastStatus.targetHeight = null;
        }

        settingsLoaded = true;
        sendConfig();
        requestFreshStatus();
    }

    function handleStorageChange(changes, areaName) {
        if (areaName !== 'local') return;
        if (!changes || (!changes.enabled && !changes.maxQuality)) return;

        const nextSettings = core.sanitizeSettings({
            enabled: changes.enabled ? changes.enabled.newValue : settings.enabled,
            maxQuality: changes.maxQuality ? changes.maxQuality.newValue : settings.maxQuality
        });

        const changed = nextSettings.enabled !== settings.enabled ||
            nextSettings.maxQuality !== settings.maxQuality;

        settings = nextSettings;

        if (!changed) return;

        if (!settings.enabled) {
            lastStatus.state = 'disabled';
            lastStatus.reason = null;
            lastStatus.targetQuality = null;
            lastStatus.targetHeight = null;
        } else {
            lastStatus.state = 'waiting';
            lastStatus.reason = 'player-missing';
            lastStatus.targetQuality = null;
            lastStatus.targetHeight = null;
        }

        lastStatus.enabled = settings.enabled;
        lastStatus.preference = settings.maxQuality;
        lastStatus.updatedAt = Date.now();

        sendConfig();
        requestFreshStatus();
    }

    window.addEventListener('message', handlePageMessage);

    api.runtime.onMessage.addListener(function (message, sender, sendResponse) {
        try {
            if (!message || typeof message !== 'object' || message.type !== MESSAGE.GET_STATUS) {
                return;
            }

            /* Ask the page for a fresh reading for the popup's next poll. */
            requestFreshStatus();
            sendResponse({ ok: true, status: publicStatus() });
        } catch (_) {
            try {
                sendResponse({ ok: false });
            } catch (_) { /* channel already closed */ }
        }
    });

    if (api.storage.onChanged && typeof api.storage.onChanged.addListener === 'function') {
        api.storage.onChanged.addListener(handleStorageChange);
    }

    loadSettings();
})();
