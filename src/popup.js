/*
 * Force YouTube Resolution - popup controller.
 *
 * All user-visible text is written with textContent. Values coming from the
 * content script are treated as untrusted and re-sanitized before display.
 */
(function () {
    'use strict';

    const core = globalThis.YTMaxQualityCore;
    const api = globalThis.browser && globalThis.browser.runtime
        ? globalThis.browser
        : globalThis.chrome;

    if (!core || !api) return;

    const MESSAGE = core.MESSAGE;
    const POLL_INTERVAL_MS = 1000;
    const REQUEST_TIMEOUT_MS = 900;
    const STATUS_CLASSES = ['is-active', 'is-fallback', 'is-waiting', 'is-paused', 'is-error'];

    const elements = {
        version: document.getElementById('version'),
        toggle: document.getElementById('toggle'),
        toggleLabel: document.getElementById('toggleLabel'),
        quality: document.getElementById('quality'),
        qualityHint: document.getElementById('qualityHint'),
        statusCard: document.getElementById('statusCard'),
        statusTitle: document.getElementById('statusTitle'),
        statusDetail: document.getElementById('statusDetail'),
        statusChip: document.getElementById('statusChip'),
        statusMeta: document.getElementById('statusMeta'),
        footer: document.querySelector('.footer'),
        footerText: document.getElementById('footerText')
    };

    let settings = core.sanitizeSettings(core.DEFAULT_SETTINGS);
    let refreshTimer = null;
    let refreshInFlight = false;
    let footerResetTimer = null;

    function setText(element, text) {
        if (element) element.textContent = text;
    }

    function setChip(text) {
        setText(elements.statusChip, text || '');
        elements.statusChip.hidden = !text;
    }

    function setStatusClass(state) {
        const classByState = {
            active: 'is-active',
            fallback: 'is-fallback',
            waiting: 'is-waiting',
            inactive: 'is-paused',
            disabled: 'is-paused',
            error: 'is-error'
        };

        elements.statusCard.classList.remove(...STATUS_CLASSES);
        elements.statusCard.classList.add(classByState[state] || 'is-waiting');
        elements.statusCard.dataset.state = state;
    }

    function setFooter(text, isError) {
        setText(elements.footerText, text);
        elements.footer.classList.toggle('is-error', Boolean(isError));

        if (footerResetTimer !== null) {
            clearTimeout(footerResetTimer);
            footerResetTimer = null;
        }

        if (isError) {
            footerResetTimer = setTimeout(function () {
                setFooter('Settings are saved automatically', false);
            }, 4000);
        }
    }

    function setMeta(lines) {
        elements.statusMeta.replaceChildren();
        elements.statusMeta.hidden = lines.length === 0;

        lines.forEach(function (line) {
            const row = document.createElement('div');
            const label = document.createElement('span');
            label.textContent = line.label + ' ';
            row.appendChild(label);

            if (line.values) {
                line.values.forEach(function (value, index) {
                    if (index > 0) {
                        const separator = document.createElement('span');
                        separator.textContent = ' · ';
                        row.appendChild(separator);
                    }
                    const item = document.createElement('strong');
                    item.textContent = value;
                    row.appendChild(item);
                });
            } else {
                const value = document.createElement('strong');
                value.textContent = line.value;
                row.appendChild(value);
            }

            elements.statusMeta.appendChild(row);
        });
    }

    function populateQualityOptions() {
        core.PREFERENCES.forEach(function (preference) {
            const option = document.createElement('option');
            option.value = preference.value;
            option.textContent = preference.label;
            elements.quality.appendChild(option);
        });
    }

    function renderSettings() {
        elements.toggle.setAttribute('aria-checked', settings.enabled ? 'true' : 'false');
        elements.quality.disabled = !settings.enabled;
        elements.quality.value = settings.maxQuality;
        elements.toggleLabel.textContent = settings.enabled ? 'Force quality' : 'Force quality (off)';

        if (!settings.enabled) {
            elements.qualityHint.textContent = 'Turn on Force quality to apply a resolution cap.';
            return;
        }

        if (settings.maxQuality === 'highest') {
            elements.qualityHint.textContent = 'Uses the highest resolution the video offers.';
        } else {
            elements.qualityHint.textContent = 'Never goes above ' +
                core.getPreferenceLabel(settings.maxQuality) +
                '. Falls back to the next best available quality.';
        }
    }

    function qualityLabel(id) {
        return core.formatQuality(id) || 'unknown quality';
    }

    function qualityShort(id) {
        return core.formatQualityShort(id) || '';
    }

    function describeActive(status) {
        const target = status.targetQuality ? qualityLabel(status.targetQuality) : null;
        const current = status.currentQuality === 'auto'
            ? 'auto'
            : (status.currentQuality ? qualityLabel(status.currentQuality) : null);

        if (target && current && current !== 'auto' && status.currentQuality !== status.targetQuality) {
            return 'Switching from ' + current + ' to ' + target + '.';
        }
        if (target && current === 'auto') {
            return 'YouTube is set to auto; enforcing ' + target + '.';
        }
        if (target) {
            return 'Playing at ' + target + '.';
        }
        return 'Forcing your selected maximum resolution.';
    }

    function describeFallback(status) {
        const target = status.targetQuality ? qualityLabel(status.targetQuality) : null;
        const selectedHeight = core.getPreferenceHeight(status.preference);
        const selectedLabel = core.getPreferenceLabel(status.preference);

        if (!target) {
            return 'Your selected resolution is not available for this video.';
        }
        if (selectedHeight !== null && status.targetHeight !== null && selectedHeight > status.targetHeight) {
            return selectedLabel + ' is not available for this video; using ' + target + '.';
        }
        if (selectedHeight !== null && status.targetHeight !== null && selectedHeight < status.targetHeight) {
            return selectedLabel + ' is not offered; using the lowest available quality, ' + target + '.';
        }
        return 'Using ' + target + ', the closest available quality.';
    }

    function renderStatus(rawStatus) {
        const status = core.sanitizeStatus(rawStatus, Date.now());

        if (!settings.enabled || status.state === 'disabled') {
            setStatusClass('disabled');
            setText(elements.statusTitle, 'Extension paused');
            setText(elements.statusDetail, 'Turn on Force quality to apply your selected resolution.');
            setChip('OFF');
            setMeta([]);
            return;
        }

        setStatusClass(status.state);

        if (status.state === 'active') {
            setText(elements.statusTitle, 'Active');
            setText(elements.statusDetail, describeActive(status));
            setChip(status.currentQuality && status.currentQuality !== 'auto'
                ? qualityShort(status.currentQuality)
                : qualityShort(status.targetQuality));
        } else if (status.state === 'fallback') {
            setText(elements.statusTitle, 'Active · fallback');
            setText(elements.statusDetail, describeFallback(status));
            setChip(qualityShort(status.targetQuality));
        } else if (status.state === 'waiting') {
            let title = 'Connecting to YouTube…';
            let detail = 'The extension is looking for the video player.';

            if (status.reason === 'ad') {
                title = 'Ad playing';
                detail = 'Your resolution will be restored when the ad ends.';
            } else if (status.reason === 'player-missing') {
                title = 'Waiting for player';
                detail = 'Start or resume the video; the extension will take over.';
            } else if (status.reason === 'metadata-missing') {
                title = 'Reading video quality…';
                detail = 'The player is still loading its quality options.';
            }

            setText(elements.statusTitle, title);
            setText(elements.statusDetail, detail);
            setChip(qualityShort(status.targetQuality));
        } else if (status.state === 'inactive') {
            setText(elements.statusTitle, 'No video detected');
            setText(elements.statusDetail, 'Open a YouTube video to activate the extension.');
            setChip('');
        } else {
            setText(elements.statusTitle, "Couldn't change quality");
            setText(elements.statusDetail, status.targetQuality
                ? 'YouTube refused ' + qualityLabel(status.targetQuality) +
                  '. Try a lower resolution or reload the video.'
                : 'Try a lower resolution or reload the video.');
            setChip(qualityShort(status.targetQuality));
        }

        const metaLines = [];
        if (status.currentQuality) {
            metaLines.push({
                label: 'Playing',
                value: status.currentQuality === 'auto' ? 'auto (not reported)' : qualityLabel(status.currentQuality)
            });
        }
        if (status.availableHeights.length > 0) {
            metaLines.push({
                label: 'Available',
                values: status.availableHeights.map(function (height) {
                    const level = core.getQualityByHeight(height);
                    return level ? level.label : null;
                }).filter(Boolean)
            });
        }

        setMeta(metaLines);
    }

    function isYouTubeUrl(url) {
        if (typeof url !== 'string' || url.length === 0) return false;
        try {
            return /(^|\.)youtube\.com$/i.test(new URL(url).hostname);
        } catch (_) {
            return false;
        }
    }

    function renderDisconnected(tab) {
        if (tab && isYouTubeUrl(tab.url)) {
            setStatusClass('error');
            setText(elements.statusTitle, 'Reload this page');
            setText(elements.statusDetail, 'The extension was installed or updated. Reload YouTube to activate it.');
            setChip('');
        } else {
            setStatusClass('inactive');
            setText(elements.statusTitle, 'Open a YouTube video');
            setText(elements.statusDetail, 'This extension only runs on youtube.com.');
            setChip('');
        }
        setMeta([]);
    }

    function withTimeout(promise, timeoutMs) {
        return new Promise(function (resolve, reject) {
            let settled = false;
            const timer = setTimeout(function () {
                if (settled) return;
                settled = true;
                reject(new Error('timeout'));
            }, timeoutMs);

            Promise.resolve(promise).then(function (value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            }, function (error) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            });
        });
    }

    async function getActiveTab() {
        try {
            const tabs = await api.tabs.query({ active: true, currentWindow: true });
            return Array.isArray(tabs) && tabs.length > 0 ? tabs[0] : null;
        } catch (_) {
            return null;
        }
    }

    async function requestStatus(tabId) {
        try {
            const response = await withTimeout(
                api.tabs.sendMessage(tabId, { type: MESSAGE.GET_STATUS }),
                REQUEST_TIMEOUT_MS
            );
            return response && response.ok && response.status ? response.status : null;
        } catch (_) {
            return null;
        }
    }

    async function refreshStatus() {
        if (refreshInFlight) return;
        refreshInFlight = true;

        try {
            const tab = await getActiveTab();
            if (!tab || typeof tab.id !== 'number') {
                renderDisconnected(null);
                return;
            }

            const status = await requestStatus(tab.id);
            if (status) {
                renderStatus(status);
            } else {
                renderDisconnected(tab);
            }
        } finally {
            refreshInFlight = false;
        }
    }

    async function loadSettings() {
        try {
            const stored = await api.storage.local.get(core.DEFAULT_SETTINGS);
            settings = core.sanitizeSettings(stored);
        } catch (_) {
            settings = core.sanitizeSettings(core.DEFAULT_SETTINGS);
            setFooter("Couldn't load saved settings", true);
        }
        renderSettings();
    }

    async function persistSettings() {
        try {
            await api.storage.local.set({
                enabled: settings.enabled,
                maxQuality: settings.maxQuality
            });
            setFooter('Settings are saved automatically', false);
        } catch (_) {
            setFooter("Couldn't save settings", true);
        }
    }

    function onToggleClick() {
        settings = core.sanitizeSettings({
            enabled: !settings.enabled,
            maxQuality: settings.maxQuality
        });
        renderSettings();
        persistSettings().then(refreshStatus);
    }

    function onQualityChange() {
        settings = core.sanitizeSettings({
            enabled: settings.enabled,
            maxQuality: elements.quality.value
        });
        renderSettings();
        persistSettings().then(refreshStatus);
    }

    function onStorageChanged(changes, areaName) {
        if (areaName !== 'local') return;
        if (!changes || (!changes.enabled && !changes.maxQuality)) return;

        settings = core.sanitizeSettings({
            enabled: changes.enabled ? changes.enabled.newValue : settings.enabled,
            maxQuality: changes.maxQuality ? changes.maxQuality.newValue : settings.maxQuality
        });
        renderSettings();
        refreshStatus();
    }

    function init() {
        populateQualityOptions();

        try {
            setText(elements.version, 'v' + api.runtime.getManifest().version);
        } catch (_) {
            setText(elements.version, '');
        }

        elements.toggle.addEventListener('click', onToggleClick);
        elements.quality.addEventListener('change', onQualityChange);

        if (api.storage.onChanged && typeof api.storage.onChanged.addListener === 'function') {
            api.storage.onChanged.addListener(onStorageChanged);
        }

        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) refreshStatus();
        });

        window.addEventListener('pagehide', function () {
            if (refreshTimer !== null) clearInterval(refreshTimer);
            if (footerResetTimer !== null) clearTimeout(footerResetTimer);
        });

        loadSettings().then(refreshStatus);
        refreshTimer = setInterval(refreshStatus, POLL_INTERVAL_MS);
    }

    init();
})();
