/*
 * Force YouTube Resolution — MAIN world engine.
 *
 * This file MUST run in the page's JavaScript world.
 *
 * Why: YouTube assigns the player API straight onto the element as *own*
 * properties:
 *
 *   Object.getOwnPropertyNames(document.getElementById('movie_player'))
 *     -> [..., setPlaybackQuality, setPlaybackQualityRange,
 *         getAvailableQualityLevels, getPlaybackQuality, ...]
 *
 * Own properties created by page JS live in the page's JS heap. An isolated
 * content-script world gets a wrapper on the same DOM node but none of those
 * properties, so `typeof p.setPlaybackQuality === 'undefined'` there and every
 * attempt to force quality fails silently. Chrome's MAIN world content scripts
 * and Firefox's injected <script src> both reach it.
 *
 * Because this runs in the page world there is no access to chrome.* APIs;
 * settings arrive from bridge.js over window.postMessage.
 */

(() => {
  'use strict';

  // Guard against double injection. A Symbol key is invisible to
  // Object.keys / for..in / JSON.stringify, so this does not advertise
  // itself to the page the way a string-named global would.
  const GUARD = Symbol('force-youtube-resolution');
  if (window[GUARD]) return;
  window[GUARD] = true;

  const NS = 'fyr';

  /* ------------------------------------------------------------------ *
   * YouTube quality ladder (internal label -> vertical resolution)
   * ------------------------------------------------------------------ */

  const LADDER = [
    { id: 'tiny', height: 144 },
    { id: 'small', height: 240 },
    { id: 'medium', height: 360 },
    { id: 'large', height: 480 },
    { id: 'hd720', height: 720 },
    { id: 'hd1080', height: 1080 },
    { id: 'hd1440', height: 1440 },
    { id: 'hd2160', height: 2160 },
    { id: 'hd2880', height: 2880 },
    { id: 'highres', height: 4320 },
  ];

  const HEIGHT_OF = {};
  for (const q of LADDER) HEIGHT_OF[q.id] = q.height;

  const AUTO = 'auto';
  const LS_KEY = 'yt-player-quality';
  const LS_TTL = 31104000; // 8.6 h, mirrors YouTube's own preference window
  const POLL_MS = 1200;

  /* ------------------------------------------------------------------ *
   * Runtime state
   * ------------------------------------------------------------------ */

  let forced = AUTO;
  let player = null;
  let detachFns = [];
  let lastApplied = null;
  let lastPersisted = null;
  /**
   * True when this extension has written `yt-player-quality` and has not yet
   * removed it. Seeded by bridge.js from extension storage, because a page
   * reload resets every in-memory variable — without that, switching to Auto
   * after a restart would leave the override behind and YouTube would keep
   * honouring it forever.
   */
  let wroteLS = false;
  let applyTimer = null;
  let missCount = 0;

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  const safe = (fn) => {
    try {
      return fn();
    } catch (_) {
      return null;
    }
  };

  const normalize = (value) =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(HEIGHT_OF, value)
      ? value
      : AUTO;

  const post = (msg) => {
    try {
      window.postMessage(msg, '*');
    } catch (_) {}
  };

  /* ------------------------------------------------------------------ *
   * Player discovery / binding
   * ------------------------------------------------------------------ */

  function findPlayer() {
    // Same lookup the working reference userscript uses.
    const el = document.getElementById('movie_player');
    if (!el) return null;
    // Guard against a shell element that has not loaded the player API yet.
    if (typeof el.setPlaybackQuality !== 'function') return null;
    return el;
  }

  function listen(el, type, fn) {
    if (!el || typeof el.addEventListener !== 'function') return;
    try {
      el.addEventListener(type, fn);
      detachFns.push(() => el.removeEventListener(type, fn));
    } catch (_) {
      /* player does not expose this event */
    }
  }

  function unbind() {
    for (const off of detachFns) safe(off);
    detachFns = [];
    player = null;
  }

  function bind() {
    const el = findPlayer();
    if (!el) {
      unbind();
      return null;
    }
    if (el === player) return el;

    unbind();
    player = el;
    scheduleApply(200);
    listen(el, 'onVideoDataChange', onVideoDataChange);
    listen(el, 'onStateChange', onStateChange);
    return el;
  }

  /* ------------------------------------------------------------------ *
   * Player events
   * ------------------------------------------------------------------ */

  function onStateChange(state) {
    // 1 = PLAYING, 3 = BUFFERING, 5 = video cued
    if (state === 1 || state === 3 || state === 5) scheduleApply(80);
  }

  function onVideoDataChange() {
    lastApplied = null;
    missCount = 0;
    scheduleApply(1500); // let the ladder for the new video publish first
  }

  /* ------------------------------------------------------------------ *
   * Resolution forcing
   * ------------------------------------------------------------------ */

  function availableOf(el) {
    const list = safe(() => el.getAvailableQualityLevels());
    if (!Array.isArray(list)) return [];
    return list.filter((x) => typeof x === 'string');
  }

  function currentOf(el) {
    const q = safe(() => el.getPlaybackQuality());
    return typeof q === 'string' ? q : '';
  }

  /**
   * Resolve the label we can actually use: exact match, else the best level at
   * or below the request, else the lowest level available.
   */
  function resolveTarget(el, desiredId) {
    const avail = availableOf(el);
    if (!avail.length) return null;
    if (avail.includes(desiredId)) return desiredId;

    const want = HEIGHT_OF[desiredId] || 0;
    const known = avail
      .filter((id) => HEIGHT_OF[id])
      .sort((a, b) => HEIGHT_OF[a] - HEIGHT_OF[b]);
    if (!known.length) return null;

    const atOrBelow = known.filter((id) => HEIGHT_OF[id] <= want);
    return atOrBelow.length ? atOrBelow[atOrBelow.length - 1] : known[0];
  }

  function pushQuality(el, target) {
    safe(() => el.setPlaybackQuality && el.setPlaybackQuality(target));
    // Call both arities. YouTube's implementation may read only the minimum or
    // the whole range; calling one-arg then two-arg ends up correct either way
    // and cannot downgrade below the requested level.
    safe(() => el.setPlaybackQualityRange && el.setPlaybackQualityRange(target));
    safe(() => el.setPlaybackQualityRange && el.setPlaybackQualityRange(target, target));
    safe(() => {
      el.dataset.defaultQuality = target;
    });
    lastApplied = target;
  }

  function persistToYouTube(target) {
    const height = HEIGHT_OF[target];
    if (!height || lastPersisted === target) return;
    try {
      const now = Date.now();
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({
          data: JSON.stringify({ quality: height, previousQuality: height }),
          creation: now,
          expiration: now + LS_TTL,
        })
      );
      lastPersisted = target;
      wroteLS = true;
      // Tell the bridge so the fact survives a reload and a switch to Auto.
      post({ fyr: NS, evt: 'wrote' });
    } catch (_) {
      /* storage may be blocked; forcing still works for the session */
    }
  }

  function clearYouTubeOverride() {
    // `wroteLS` is the durable signal — `lastPersisted` alone is null on a
    // fresh page load and would make us skip the cleanup entirely.
    if (lastPersisted === null && !wroteLS) return;
    lastPersisted = null;
    wroteLS = false;
    try {
      localStorage.removeItem(LS_KEY);
    } catch (_) {}
    post({ fyr: NS, evt: 'cleared' });
  }

  function scheduleApply(delay) {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      applyTimer = null;
      applyNow();
    }, delay || 0);
  }

  function applyNow() {
    const el = bind();
    if (!el) return null;
    if (forced === AUTO) {
      clearYouTubeOverride();
      lastApplied = null;
      return null;
    }
    const target = resolveTarget(el, forced);
    if (!target) {
      // Ladder not published yet — keep trying for a while.
      if (++missCount < 10) scheduleApply(400);
      return null;
    }
    missCount = 0;
    if (currentOf(el) !== target) pushQuality(el, target);
    else lastApplied = target;
    persistToYouTube(target);
    return target;
  }

  /** Re-assert: YouTube re-applies its own saved quality on video switches and
   *  whenever ABR steps up, so the forced level must be pushed back. */
  function enforce() {
    if (!player || !player.isConnected) {
      if (!bind()) return;
    }
    if (forced === AUTO) return;
    const el = player;
    if (!el) return;

    const target = resolveTarget(el, forced);
    if (!target) return;

    const current = currentOf(el);
    if (current) {
      if (current !== target) pushQuality(el, target);
    } else {
      // Cannot read the current quality — re-assert periodically instead.
      if (++missCount >= 3) {
        missCount = 0;
        pushQuality(el, target);
      }
    }
    persistToYouTube(target);
  }

  function tick() {
    if (!player || !player.isConnected) bind();
    else if (forced !== AUTO) enforce();
  }

  /* ------------------------------------------------------------------ *
   * Status (reported back to the popup through the bridge)
   * ------------------------------------------------------------------ */

  function collect() {
    const el = player || bind();
    return {
      hasPlayer: !!el,
      available: el ? availableOf(el) : [],
      current: el ? currentOf(el) : '',
      forced,
      applied: lastApplied,
      title:
        safe(
          () =>
            document
              .querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.title, .ytp-title-link')
              ?.textContent
              ?.trim()
        ) || '',
      onVideoPage: /^\/(watch|shorts\/|live\/|embed\/|v\/)/.test(location.pathname),
    };
  }

  /* ------------------------------------------------------------------ *
   * Settings / commands from bridge.js
   * ------------------------------------------------------------------ */

  function setForced(value, wrote) {
    const next = normalize(value);
    const changed = next !== forced;
    if (typeof wrote === 'boolean') wroteLS = wrote;
    forced = next;
    if (forced === AUTO) {
      clearYouTubeOverride();
      lastApplied = null;
    } else if (changed) {
      missCount = 0;
      bind();
      scheduleApply(60);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.fyr !== NS) return;

    switch (data.cmd) {
      case 'set':
        setForced(data.quality, data.wrote);
        break;
      case 'status':
        post({ fyr: NS, evt: 'status', status: collect() });
        break;
      case 'rebind':
        unbind();
        bind();
        scheduleApply(60);
        break;
      case 'sync':
        post({ fyr: NS, evt: 'status', status: collect() });
        break;
    }
  });

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  document.addEventListener('yt-navigate-finish', () => {
    unbind();
    bind();
    scheduleApply(1500);
  });

  document.addEventListener('yt-navigate-start', unbind);

  // Catch the player the moment it is inserted instead of waiting for a poll.
  let moTimer = null;
  try {
    const mo = new MutationObserver(() => {
      if (moTimer || (player && player.isConnected)) return;
      moTimer = setTimeout(() => {
        moTimer = null;
        if (!player || !player.isConnected) bind();
      }, 120);
    });
    mo.observe(document.documentElement || document, { childList: true, subtree: true });
  } catch (_) {
    /* fall back to polling only */
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      bind();
      scheduleApply(100);
    }
  });

  window.addEventListener('pageshow', () => {
    bind();
    scheduleApply(100);
  });

  setInterval(tick, POLL_MS);

  post({ fyr: NS, evt: 'ready' });
})();
