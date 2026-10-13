/*
 * Force YouTube Resolution — ISOLATED world bridge.
 *
 * Runs as a normal content script. It cannot touch the YouTube player API
 * (see force.js for why), so its only jobs are:
 *
 *   1. read/write the chosen resolution in extension storage
 *   2. hand that value to force.js, which runs in the page world
 *   3. relay status from force.js back to the popup
 *   4. on Firefox, inject force.js into the page (MV2 has no MAIN world)
 *
 * Bridge <-> engine messaging uses window.postMessage with a { fyr: 'fyr', ... }
 * envelope. A page script could spoof these messages, but such a script can
 * already call movie_player.setPlaybackQuality() directly, so this grants it
 * no capability it did not already have.
 */

(() => {
  'use strict';

  if (window.__fyrBridgeLoaded) return;
  window.__fyrBridgeLoaded = true;

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

  // Firefox MV2 has no content_scripts.world, so force.js must be injected.
  const NEEDS_INJECTION =
    typeof browser !== 'undefined' &&
    !!browser.runtime &&
    typeof browser.runtime.getBrowserInfo === 'function';

  let forced = AUTO;
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
    toEngine({ cmd: 'set', quality: forced });
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
    if (data.evt === 'status') {
      lastStatus = data.status || null;
      lastStatusAt = Date.now();
      flushPendingStatus();
    }
  });

  /* ------------------------------------------------------------------ *
   * Firefox: inject the engine into the page world
   * ------------------------------------------------------------------ */

  function injectEngine() {
    const mount = document.documentElement || document.head || document.body;
    if (!mount) {
      document.addEventListener('DOMContentLoaded', injectEngine, { once: true });
      return;
    }
    try {
      const el = document.createElement('script');
      el.src = API.runtime.getURL('force.js');
      el.async = false;
      el.dataset.fyr = '';
      mount.appendChild(el);
    } catch (_) {
      /* injection blocked — nothing else we can do here */
    }
  }

  if (NEEDS_INJECTION) injectEngine();

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
        toEngine({ cmd: 'set', quality: forced });
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
    if (!changes.forcedQuality) return;
    forced = normalize(changes.forcedQuality.newValue);
    pushSetting();
  });

  store.get({ forcedQuality: AUTO }).then((data) => {
    forced = normalize(data.forcedQuality);
    pushSetting();
  });
})();
