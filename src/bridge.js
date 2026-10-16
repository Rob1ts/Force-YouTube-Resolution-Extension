/*
 * Force YouTube Resolution — ISOLATED world bridge.
 *
 * Runs as a normal content script. It cannot touch the YouTube player API
 * (see force.js for why), so its only jobs are:
 *
 *   1. read/write the chosen resolution in extension storage
 *   2. hand that value to force.js, which runs in the page world
 *   3. relay status from force.js back to the popup
 *   4. own the durable side of YouTube's quality key: record exactly what the
 *      engine wrote and remove it again on Auto — and only while the entry
 *      still holds that exact value
 *
 * There is no script injection here: both browsers declare force.js as a
 * world:"MAIN" content script, so nothing is web-accessible and no site can
 * load our code.
 *
 * Bridge <-> engine messaging uses window.postMessage with a { fyr: 'fyr', ... }
 * envelope. Isolated and main worlds share one window, so a page script can
 * observe and forge these — that is inherent to operating in the page world,
 * not something this channel can fix. The design keeps that harmless: every
 * decision that touches durable state (what is stored, and when YouTube's
 * quality key is removed) is taken in *this* isolated world. The page world is
 * treated as untrusted input throughout.
 */

(() => {
  'use strict';

  const GUARD = Symbol('force-youtube-resolution-bridge');
  if (window[GUARD]) return;
  window[GUARD] = true;

  const API = typeof browser !== 'undefined' && browser.runtime ? browser : chrome;
  const NS = 'fyr';
  const AUTO = 'auto';
  const LS_KEY = 'yt-player-quality';
  // Same-window messages only; pin the target origin instead of '*'. Falls back
  // to '*' only where the origin is opaque (never the case on YouTube).
  const ORIGIN =
    typeof location !== 'undefined' && location.origin ? location.origin : '*';

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
  let ytWritten = null;
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
      window.postMessage(Object.assign({ fyr: NS }, msg), ORIGIN);
    } catch (_) {}
  };

  function pushSetting() {
    if (!engineReady) return;
    toEngine({ cmd: 'set', quality: forced });
  }

  /* ------------------------------------------------------------------ *
   * YouTube's quality key — owned by the isolated world
   * ------------------------------------------------------------------ */

  function lsGet() {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
    } catch (_) {
      return null;
    }
  }

  function lsRemove() {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(LS_KEY);
    } catch (_) {}
  }

  /**
   * Remove the entry the engine wrote, but only while it still holds exactly
   * that value. If YouTube (or the page) has since written its own preference,
   * the entry is left alone. The page world never deletes it, so a forged
   * "wrote" message cannot make the extension drop a key YouTube owns.
   */
  function clearStaleOverride() {
    if (!wroteLS) return;
    const current = lsGet();
    if (current !== null && current === ytWritten) lsRemove();
    wroteLS = false;
    ytWritten = null;
    store.set({ wroteLS: false, ytWritten: null });
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
      if (forced === AUTO) clearStaleOverride();
      return;
    }
    if (data.evt === 'wrote') {
      // The engine reports the exact value it persisted. Only a bounded string
      // is accepted, and it is matched against localStorage at cleanup time.
      if (typeof data.value === 'string') {
        wroteLS = true;
        ytWritten = data.value;
        store.set({ wroteLS: true, ytWritten: data.value });
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
    // Only this extension's own contexts (the popup) may drive the bridge.
    if (!sender || sender.id !== API.runtime.id) return false;
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
      if (forced === AUTO) clearStaleOverride();
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
    if (changes.wroteLS) wroteLS = changes.wroteLS.newValue === true;
    if (changes.ytWritten) {
      ytWritten = typeof changes.ytWritten.newValue === 'string' ? changes.ytWritten.newValue : null;
    }
    if (!changes.forcedQuality) return;
    forced = normalize(changes.forcedQuality.newValue);
    pushSetting();
    if (forced === AUTO) clearStaleOverride();
  });

  store.get({ forcedQuality: AUTO, wroteLS: false, ytWritten: null }).then((data) => {
    forced = normalize(data.forcedQuality);
    wroteLS = data.wroteLS === true;
    ytWritten = typeof data.ytWritten === 'string' ? data.ytWritten : null;
    pushSetting();
    // Returning to an Auto profile still removes the override the extension
    // left behind — but only while it is still the value the engine wrote.
    if (forced === AUTO) clearStaleOverride();
  });
})();
