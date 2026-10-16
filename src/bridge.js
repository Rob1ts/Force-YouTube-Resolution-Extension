/*
 * Force YouTube Resolution — ISOLATED world bridge.
 *
 * Runs as a normal content script. It cannot touch the YouTube player API
 * (see force.js for why), so its only jobs are:
 *
 *   1. read/write the chosen resolution in extension storage
 *   2. hand that value to force.js, which runs in the page world
 *   3. relay status from force.js back to the popup
 *   4. remember, across page loads, whether force.js wrote YouTube's
 *      quality key — so switching back to Auto actually cleans up
 *
 * There is no script injection here: both browsers declare force.js as a
 * world:"MAIN" content script, so nothing is web-accessible and no site can
 * load our code.
 *
 * Bridge <-> engine messaging uses window.postMessage with a { fyr: 'fyr', ... }
 * envelope. Isolated and main worlds share one window, so a page script can
 * observe and forge these — that is inherent to operating in the page world,
 * not something this channel can fix. Nothing here is privileged: the page can
 * already call movie_player.setPlaybackQuality() itself. The forged-message
 * surface is kept to read-only (status), and the popup treats storage as the
 * authority for the forced setting.
 */

(() => {
  'use strict';

  const GUARD = Symbol('force-youtube-resolution-bridge');
  if (window[GUARD]) return;
  window[GUARD] = true;

  const API = typeof browser !== 'undefined' && browser.runtime ? browser : chrome;
  const NS = 'fyr';
  const AUTO = 'auto';

  // Only YouTube's own quality labels may ever be stored. This is what stops a
  // custom resolution from being forced: there is no way to express one.
  const VALID = new Set([
    'tiny',
    'small',
    'medium',
    'large',
    'hd720',
    'hd1080',
    'hd1440',
    'hd2160',
    'hd2880',
    'highres',
  ]);

  const normalize = (value) =>
    typeof value === 'string' && VALID.has(value) ? value : AUTO;

  let forced = AUTO;
  let wroteLS = false;
  let engineReady = false;
  let lastStatus = null;
  let lastStatusAt = 0;
  let pendingStatus = [];

  /* ------------------------------------------------------------------ *
   * Storage (works with promise- and callback-based flavours)
   * ------------------------------------------------------------------ */

  const store = {
    get(defaults) {
      return new Promise((resolve) => {
        let settled = false;
        const done = (v) => {
          if (settled) return;
          settled = true;
          resolve(v || {});
        };
        try {
          const maybe = API.storage.local.get(defaults, done);
          if (maybe && typeof maybe.then === 'function') maybe.then(done, () => done({}));
        } catch (_) {
          done({});
        }
      });
    },
    set(obj) {
      return new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        try {
          const maybe = API.storage.local.set(obj, done);
          if (maybe && typeof maybe.then === 'function') maybe.then(done, done);
          else done();
        } catch (_) {
          done();
        }
      });
    },
  };

  /* ------------------------------------------------------------------ *
   * Engine transport
   * ------------------------------------------------------------------ */

  const toEngine = (msg) => {
    try {
      window.postMessage(Object.assign({ fyr: NS }, msg), '*');
    } catch (_) {}
  };

  function pushSetting() {
    if (!engineReady) return;
    toEngine({ cmd: 'set', quality: forced, wrote: wroteLS });
  }

  function flushPendingStatus() {
    const waiters = pendingStatus;
    pendingStatus = [];
    for (const fn of waiters) {
      try {
        fn(lastStatus);
      } catch (_) {}
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.fyr !== NS) return;

    if (data.evt === 'ready') {
      engineReady = true;
      pushSetting();
      toEngine({ cmd: 'status' });
      return;
    }
    if (data.evt === 'wrote') {
      // Reported by the engine after it writes YouTube's quality key.
      if (!wroteLS) {
        wroteLS = true;
        store.set({ wroteLS: true });
      }
      return;
    }
    if (data.evt === 'cleared') {
      if (wroteLS) {
        wroteLS = false;
        store.set({ wroteLS: false });
      }
      return;
    }
    if (data.evt === 'status') {
      lastStatus = data.status || null;
      lastStatusAt = Date.now();
      flushPendingStatus();
    }
  });

  /* ------------------------------------------------------------------ *
   * Popup-facing API
   * ------------------------------------------------------------------ */

  API.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || msg.fyr !== NS) return false;

    if (msg.cmd === 'status') {
      // Fresh enough to answer straight away?
      if (lastStatus && Date.now() - lastStatusAt < 4000) {
        sendResponse(lastStatus);
        return false;
      }
      if (!engineReady) {
        sendResponse(null);
        return false;
      }
      pendingStatus.push(sendResponse);
      toEngine({ cmd: 'status' });
      setTimeout(flushPendingStatus, 800);
      return true; // async response
    }

    if (msg.cmd === 'apply') {
      forced = normalize(msg.quality);
      store.set({ forcedQuality: forced });
      if (engineReady) {
        toEngine({ cmd: 'set', quality: forced, wrote: wroteLS });
        setTimeout(() => toEngine({ cmd: 'status' }), 250);
      }
      sendResponse({ ok: true, quality: forced });
      return false;
    }

    if (msg.cmd === 'reapply') {
      if (engineReady) toEngine({ cmd: 'rebind' });
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  API.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.wroteLS) {
      wroteLS = changes.wroteLS.newValue === true;
      // Push the new flag through so the engine can clean up correctly.
      pushSetting();
      return;
    }
    if (!changes.forcedQuality) return;
    forced = normalize(changes.forcedQuality.newValue);
    pushSetting();
  });

  store.get({ forcedQuality: AUTO, wroteLS: false }).then((data) => {
    forced = normalize(data.forcedQuality);
    wroteLS = data.wroteLS === true;
    pushSetting();
  });
})();
