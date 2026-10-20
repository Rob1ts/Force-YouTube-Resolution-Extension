/*
 * Force YouTube Resolution - main-world player bridge.
 *
 * This content script runs in the page's main world (manifest content_scripts
 * world: "MAIN") so it can call the methods YouTube attaches to #movie_player.
 * It does not use extension APIs; all settings and status messages travel over
 * window.postMessage and are validated by the isolated content script.
 */
(function () {
    'use strict';

    const core = globalThis.YTMaxQualityCore;

    if (!core) return;

    const SCAN_INTERVAL_MS = 350;
    const VERIFY_DELAY_MS = 500;
    const SCAN_WINDOW_MS = 30000;
    const REASSERT_WINDOW_MS = 12000;
    const MAX_APPLY_ATTEMPTS = 20;
    const URL_CHECK_INTERVAL_MS = 1000;
    const QUALITY_WATCH_INTERVAL_MS = 1000;

    const MESSAGE = core.MESSAGE;

    let settings = core.sanitizeSettings(core.DEFAULT_SETTINGS);
    let hasConfig = false;

    let scanTimer = null;
    let scanDeadline = 0;
    let applyAttempts = 0;
    let appliedForTarget = false;
    let targetQuality = null;
    let player = null;
    let playerClassObserver = null;
    let wasAdShowing = false;

    let currentVideoId = null;
    let lastPublishedSignature = '';
    let urlCheckTimer = null;
    let qualityWatchTimer = null;
    let readyRetryTimer = null;
    let readyAttempts = 0;

    function postToContent(type, payload) {
        try {
            window.postMessage(core.createBridgeMessage(type, payload), location.origin);
        } catch (_) {
            /* The page is in an unexpected state; nothing useful to do. */
        }
    }

    function announceReady() {
        if (hasConfig || readyAttempts >= 6) return;
        readyAttempts += 1;
        postToContent(MESSAGE.PAGE_READY, { url: location.href });
        readyRetryTimer = setTimeout(announceReady, Math.min(2000, 150 * readyAttempts));
    }

    function getVideoId() {
        try {
            const url = new URL(location.href);
            const fromQuery = core.sanitizeVideoId(url.searchParams.get('v'));
            if (fromQuery) return fromQuery;

            const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{1,32})(?:\/|$)/);
            return match ? core.sanitizeVideoId(match[1]) : null;
        } catch (_) {
            return null;
        }
    }

    function isYouTubeHost() {
        try {
            return /(^|\.)youtube\.com$/i.test(location.hostname);
        } catch (_) {
            return false;
        }
    }

    function isVideoPage() {
        if (!isYouTubeHost()) return false;

        try {
            const url = new URL(location.href);
            if (url.pathname === '/watch') return getVideoId() !== null;
            return /^\/(?:shorts|embed|live)\//.test(url.pathname);
        } catch (_) {
            return false;
        }
    }

    function getPlayer() {
        try {
            const element = document.getElementById('movie_player');
            if (!element) return null;
            if (typeof element.getAvailableQualityLevels !== 'function') return null;
            if (typeof element.setPlaybackQuality !== 'function' &&
                typeof element.setPlaybackQualityRange !== 'function') {
                return null;
            }
            return element;
        } catch (_) {
            return null;
        }
    }

    function readAvailableLevels(playerElement) {
        try {
            return core.normalizeAvailableLevels(playerElement.getAvailableQualityLevels());
        } catch (_) {
            return [];
        }
    }

    function readCurrentQuality(playerElement) {
        try {
            if (typeof playerElement.getPlaybackQuality !== 'function') return null;
            const quality = playerElement.getPlaybackQuality();
            if (quality === 'auto') return 'auto';
            return core.getQuality(quality) ? quality : null;
        } catch (_) {
            return null;
        }
    }

    function isAdShowing(playerElement) {
        try {
            return Boolean(playerElement && playerElement.classList &&
                playerElement.classList.contains('ad-showing'));
        } catch (_) {
            return false;
        }
    }

    function hasQualityMismatch(currentQuality, wantedQuality) {
        /*
         * "auto" is a mismatch too: YouTube can switch back to automatic
         * selection without changing the video, and the extension is expected
         * to enforce the target while it is enabled.
         */
        return Boolean(currentQuality && wantedQuality &&
            currentQuality !== wantedQuality);
    }

    function applyQuality(playerElement, quality) {
        let applied = false;

        /*
         * setPlaybackQualityRange is the current API and is what keeps YouTube
         * from drifting back to "auto". setPlaybackQuality is kept as a legacy
         * fallback for older player builds. Each call is isolated so a failure
         * of one does not prevent the other from being attempted.
         */
        if (typeof playerElement.setPlaybackQualityRange === 'function') {
            try {
                playerElement.setPlaybackQualityRange(quality, quality);
                applied = true;
            } catch (_) { /* try the legacy method */ }
        }

        if (typeof playerElement.setPlaybackQuality === 'function') {
            try {
                playerElement.setPlaybackQuality(quality);
                applied = true;
            } catch (_) { /* nothing else to try */ }
        }

        return applied;
    }

    function disconnectPlayerObserver() {
        if (playerClassObserver) {
            playerClassObserver.disconnect();
            playerClassObserver = null;
        }
    }

    function attachPlayer(playerElement) {
        if (player === playerElement) return;

        player = playerElement;
        appliedForTarget = false;
        wasAdShowing = isAdShowing(playerElement);
        disconnectPlayerObserver();

        if (!playerElement || typeof MutationObserver !== 'function') return;

        try {
            playerClassObserver = new MutationObserver(function () {
                const adShowing = isAdShowing(playerElement);
                if (wasAdShowing && !adShowing) {
                    scanDeadline = Math.max(scanDeadline, Date.now() + REASSERT_WINDOW_MS);
                    scheduleScan(150);
                }
                wasAdShowing = adShowing;
            });
            playerClassObserver.observe(playerElement, {
                attributes: true,
                attributeFilter: ['class']
            });
        } catch (_) {
            playerClassObserver = null;
        }
    }

    function stopScanning() {
        if (scanTimer !== null) {
            clearTimeout(scanTimer);
            scanTimer = null;
        }
        scanDeadline = 0;
    }

    function scheduleScan(delay) {
        if (!settings.enabled || !isVideoPage()) return;
        if (scanTimer !== null) clearTimeout(scanTimer);
        scanTimer = setTimeout(scan, delay);
    }

    function buildStatus(state, reason) {
        const playerElement = getPlayer();
        const available = playerElement && state !== 'disabled' && state !== 'inactive'
            ? readAvailableLevels(playerElement)
            : [];
        const currentQuality = playerElement && state !== 'disabled' && state !== 'inactive'
            ? readCurrentQuality(playerElement)
            : null;
        const usePlayerChoice = state !== 'disabled' && state !== 'inactive';
        const choice = usePlayerChoice
            ? core.chooseQuality(available, settings.maxQuality)
            : { level: null };
        const target = usePlayerChoice ? (choice.level ? choice.level.id : targetQuality) : null;

        return core.sanitizeStatus({
            state: state,
            enabled: settings.enabled,
            preference: settings.maxQuality,
            targetQuality: target,
            currentQuality: currentQuality,
            availableHeights: available,
            videoId: getVideoId(),
            reason: reason
        }, Date.now());
    }

    function publishStatus(state, reason, force) {
        const status = buildStatus(state, reason);
        const signature = [
            status.state,
            status.enabled ? '1' : '0',
            status.preference,
            status.targetQuality || '',
            status.currentQuality || '',
            status.availableHeights.join(','),
            status.videoId || '',
            status.reason || ''
        ].join('|');

        if (!force && signature === lastPublishedSignature) return;
        lastPublishedSignature = signature;
        postToContent(MESSAGE.STATUS, { status: status });
    }

    function publishPlayerState(force) {
        const playerElement = getPlayer();

        if (!playerElement) {
            publishStatus('waiting', 'player-missing', force);
            return;
        }

        attachPlayer(playerElement);

        const choice = core.chooseQuality(readAvailableLevels(playerElement), settings.maxQuality);
        if (!choice.level) {
            publishStatus('waiting', 'metadata-missing', force);
            return;
        }

        if (isAdShowing(playerElement)) {
            publishStatus('waiting', 'ad', force);
            return;
        }

        publishStatus(choice.exact ? 'active' : 'fallback',
            choice.exact ? null : 'preference-unavailable',
            force);
    }

    function publishDisabled() {
        stopScanning();
        targetQuality = null;
        applyAttempts = 0;
        appliedForTarget = false;
        disconnectPlayerObserver();
        player = null;
        publishStatus('disabled', null, true);
    }

    function publishInactive(reason) {
        stopScanning();
        targetQuality = null;
        applyAttempts = 0;
        appliedForTarget = false;
        disconnectPlayerObserver();
        player = null;
        publishStatus('inactive', reason || 'no-video', true);
    }

    function scan() {
        scanTimer = null;

        if (!settings.enabled) {
            publishDisabled();
            return;
        }

        if (!isVideoPage()) {
            publishInactive('no-video');
            return;
        }

        const playerElement = getPlayer();
        if (!playerElement) {
            targetQuality = null;
            appliedForTarget = false;
            publishStatus('waiting', 'player-missing', true);
            if (Date.now() < scanDeadline) scheduleScan(SCAN_INTERVAL_MS);
            return;
        }

        attachPlayer(playerElement);

        const available = readAvailableLevels(playerElement);
        const choice = core.chooseQuality(available, settings.maxQuality);

        if (!choice.level) {
            targetQuality = null;
            appliedForTarget = false;
            publishStatus('waiting', 'metadata-missing', true);
            if (Date.now() < scanDeadline) scheduleScan(SCAN_INTERVAL_MS);
            return;
        }

        if (choice.level.id !== targetQuality) {
            targetQuality = choice.level.id;
            applyAttempts = 0;
            appliedForTarget = false;
            scanDeadline = Math.max(scanDeadline, Date.now() + REASSERT_WINDOW_MS);
        }

        if (isAdShowing(playerElement)) {
            wasAdShowing = true;
            publishStatus('waiting', 'ad', true);
            /* The class observer resumes work as soon as the ad ends. */
            return;
        }

        const currentQuality = readCurrentQuality(playerElement);
        const mismatch = hasQualityMismatch(currentQuality, targetQuality);
        let didApply = false;

        /*
         * Once the target is observed, clear the burst counter. This lets a
         * long video recover from a later manual change while still preventing
         * an immediate apply/revert loop from running forever.
         */
        if (currentQuality === targetQuality && !mismatch) {
            applyAttempts = 0;
        }

        if ((mismatch || !appliedForTarget) && applyAttempts < MAX_APPLY_ATTEMPTS) {
            applyAttempts += 1;
            if (applyQuality(playerElement, targetQuality)) {
                appliedForTarget = true;
                didApply = true;
            }
            scanDeadline = Math.max(scanDeadline, Date.now() + REASSERT_WINDOW_MS);
        }

        if (!appliedForTarget && !didApply && applyAttempts >= MAX_APPLY_ATTEMPTS) {
            publishStatus('error', 'apply-failed', true);
            return;
        }

        if (mismatch && applyAttempts >= MAX_APPLY_ATTEMPTS) {
            publishStatus('error', 'apply-failed', true);
            return;
        }

        publishStatus(choice.exact ? 'active' : 'fallback',
            choice.exact ? null : 'preference-unavailable',
            false);

        /*
         * Verify shortly after a call, and keep trying for a little while if
         * the player accepted the call but still reports another quality. Once
         * the target is observed we rely on quality-change events instead of
         * polling forever.
         */
        if (Date.now() < scanDeadline && (didApply || (mismatch && applyAttempts < MAX_APPLY_ATTEMPTS))) {
            scheduleScan(didApply ? VERIFY_DELAY_MS : SCAN_INTERVAL_MS);
        }
    }

    /*
     * Current YouTube builds do not reliably dispatch quality-change events
     * when the user picks a quality from the player menu, and the initial
     * scan window is intentionally finite. A lightweight watch keeps the
     * promise made by the UI ("force quality") without polling when the
     * target is already active.
     */
    function watchQuality() {
        if (!hasConfig || !settings.enabled || !isVideoPage()) return;

        const playerElement = getPlayer();
        if (!playerElement) return;

        if (isAdShowing(playerElement)) {
            wasAdShowing = true;
            return;
        }

        const choice = core.chooseQuality(
            readAvailableLevels(playerElement),
            settings.maxQuality
        );
        if (!choice.level) return;

        const currentQuality = readCurrentQuality(playerElement);
        const targetChanged = choice.level.id !== targetQuality;
        const mismatch = hasQualityMismatch(currentQuality, choice.level.id);

        if (!targetChanged && currentQuality === choice.level.id) {
            /*
             * Keep the status honest even when the player took a while to
             * report the requested quality and the last scan timed out.
             * publishStatus de-duplicates identical signatures.
             */
            applyAttempts = 0;
            appliedForTarget = true;
            publishStatus(choice.exact ? 'active' : 'fallback',
                choice.exact ? null : 'preference-unavailable',
                false);
            return;
        }

        if (!targetChanged && (!mismatch || applyAttempts >= MAX_APPLY_ATTEMPTS)) {
            return;
        }

        /* A pending scan already has fresh metadata and will handle this. */
        if (scanTimer === null) scan();
    }

    function beginForCurrentPage(forceReset) {
        const videoId = getVideoId();

        if (!forceReset && videoId === currentVideoId) {
            if (settings.enabled && isVideoPage()) {
                scanDeadline = Math.max(scanDeadline, Date.now() + REASSERT_WINDOW_MS);
                scheduleScan(100);
            }
            return;
        }

        currentVideoId = videoId;
        targetQuality = null;
        appliedForTarget = false;
        applyAttempts = 0;
        stopScanning();
        disconnectPlayerObserver();
        player = null;

        if (!settings.enabled) {
            publishDisabled();
            return;
        }

        if (!isVideoPage()) {
            publishInactive('not-video');
            return;
        }

        scanDeadline = Date.now() + SCAN_WINDOW_MS;
        publishStatus('waiting', 'player-missing', true);
        scheduleScan(0);
    }

    function onNavigation() {
        if (!hasConfig) return;
        beginForCurrentPage(false);
    }

    function onPlayerAttached() {
        if (!hasConfig) return;

        player = null;
        appliedForTarget = false;
        if (settings.enabled && isVideoPage()) {
            scanDeadline = Math.max(scanDeadline, Date.now() + REASSERT_WINDOW_MS);
            scheduleScan(100);
        }
    }

    function onQualityChanged() {
        if (!hasConfig || !settings.enabled || !isVideoPage()) return;

        const playerElement = getPlayer();
        if (!playerElement) {
            scheduleScan(200);
            return;
        }

        attachPlayer(playerElement);

        if (isAdShowing(playerElement)) {
            wasAdShowing = true;
            publishStatus('waiting', 'ad', true);
            return;
        }

        const currentQuality = readCurrentQuality(playerElement);
        if (hasQualityMismatch(currentQuality, targetQuality)) {
            scanDeadline = Math.max(scanDeadline, Date.now() + REASSERT_WINDOW_MS);
            if (scanTimer === null) scheduleScan(200);
            return;
        }

        publishPlayerState(false);
    }

    function applyConfig(rawSettings) {
        const nextSettings = core.sanitizeSettings(rawSettings);
        const wasEnabled = settings.enabled;
        const previousPreference = settings.maxQuality;
        const firstConfig = !hasConfig;

        hasConfig = true;
        settings = nextSettings;

        if (readyRetryTimer) {
            clearTimeout(readyRetryTimer);
            readyRetryTimer = null;
        }

        if (!settings.enabled) {
            publishDisabled();
            return;
        }

        if (!isVideoPage()) {
            publishInactive('not-video');
            return;
        }

        if (firstConfig || !wasEnabled || previousPreference !== settings.maxQuality) {
            currentVideoId = getVideoId();
            targetQuality = null;
            appliedForTarget = false;
            applyAttempts = 0;
            scanDeadline = Date.now() + SCAN_WINDOW_MS;
            publishStatus('waiting', 'player-missing', true);
            scheduleScan(firstConfig ? 0 : 100);
            return;
        }

        scheduleScan(100);
    }

    function handleBridgeMessage(event) {
        if (event.source !== window || event.origin !== location.origin) return;
        if (!core.isBridgeMessage(event.data)) return;

        const data = event.data;

        if (data.type === MESSAGE.CONFIG) {
            applyConfig(data.settings);
            return;
        }

        if (data.type === MESSAGE.REQUEST_STATUS) {
            if (!hasConfig) {
                announceReady();
                return;
            }
            if (!settings.enabled) {
                publishStatus('disabled', null, true);
            } else if (!isVideoPage()) {
                publishStatus('inactive', 'not-video', true);
            } else {
                publishPlayerState(true);
            }
        }
    }

    function startUrlWatcher() {
        if (urlCheckTimer !== null) return;
        urlCheckTimer = setInterval(function () {
            if (!hasConfig) return;
            if (getVideoId() !== currentVideoId || (!isVideoPage() && currentVideoId !== null)) {
                beginForCurrentPage(true);
            }
        }, URL_CHECK_INTERVAL_MS);
    }

    function startQualityWatch() {
        if (qualityWatchTimer !== null) return;
        qualityWatchTimer = setInterval(watchQuality, QUALITY_WATCH_INTERVAL_MS);
    }

    window.addEventListener('message', handleBridgeMessage);

    document.addEventListener('yt-navigate-finish', onNavigation);
    document.addEventListener('yt-page-data-updated', onNavigation);
    document.addEventListener('yt-player-attached', onPlayerAttached);
    document.addEventListener('yt-player-quality-changed', onQualityChanged);
    window.addEventListener('popstate', onNavigation);
    window.addEventListener('hashchange', onNavigation);

    /*
     * YouTube occasionally changes the URL without dispatching a navigate
     * event (for example when a playlist auto-advances). A cheap URL check
     * covers those cases without touching the DOM.
     */
    startUrlWatcher();
    startQualityWatch();

    window.addEventListener('pagehide', function () {
        stopScanning();
        disconnectPlayerObserver();
        if (urlCheckTimer) {
            clearInterval(urlCheckTimer);
            urlCheckTimer = null;
        }
        if (qualityWatchTimer) {
            clearInterval(qualityWatchTimer);
            qualityWatchTimer = null;
        }
        if (readyRetryTimer) {
            clearTimeout(readyRetryTimer);
            readyRetryTimer = null;
        }
    });

    window.addEventListener('pageshow', function () {
        startUrlWatcher();
        startQualityWatch();
        announceReady();
    });

    announceReady();
})();
