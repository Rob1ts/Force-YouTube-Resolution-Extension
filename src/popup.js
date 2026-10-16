/*
 * Force YouTube Resolution — popup
 *
 * Lists YouTube's fixed resolution ladder (no custom values possible) and
 * marks which levels the video in the active tab actually offers, read live
 * from the player's getAvailableQualityLevels().
 */

(() => {
  'use strict';

  const API = typeof browser !== 'undefined' && browser.runtime ? browser : chrome;

  const AUTO = 'auto';

  /* Same ladder as the content script. Kept in sync by build.js. */
  const LADDER = [
    { id: 'tiny', height: 144 },
    { id: 'small', height: 240 },
    { id: 'medium', height: 360 },
    { id: 'large', height: 480 },
    { id: 'hd720', height: 720 },
    { id: 'hd1080', height: 1080, tag: 'HD' },
    { id: 'hd1440', height: 1440, tag: 'HD' },
    { id: 'hd2160', height: 2160, tag: '4K' },
    { id: 'hd2880', height: 2880, tag: '4K' },
    { id: 'highres', height: 4320, tag: '8K' },
  ];

  const HEIGHT_OF = {};
  for (const q of LADDER) HEIGHT_OF[q.id] = q.height;

  const NS = 'fyr';

  /* ------------------------------------------------------------------ *
   * API shims — work with promise-based and callback-based flavours
   * ------------------------------------------------------------------ */

  function call(fn, ...args) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      try {
        const maybe = fn(...args, done);
        if (maybe && typeof maybe.then === 'function') {
          maybe.then(done, () => done(undefined));
        } else if (maybe !== undefined) {
          done(maybe);
        }
      } catch (_) {
        done(undefined);
      }
    });
  }

  const storageGet = (defaults) => call(API.storage.local.get.bind(API.storage.local), defaults);
  const storageSet = (obj) => call(API.storage.local.set.bind(API.storage.local), obj);
  const tabsQuery = (q) => call(API.tabs.query.bind(API.tabs), q);

  function sendToTab(tabId, msg) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      try {
        const maybe = API.tabs.sendMessage(tabId, msg, (res) => {
          void API.runtime.lastError;
          done(res);
        });
        if (maybe && typeof maybe.then === 'function') {
          maybe.then(done, () => done(undefined));
        }
      } catch (_) {
        done(undefined);
      }
    });
  }

  const t = (key, fallback, substitutions) => {
    try {
      const msg = API.i18n.getMessage(key, substitutions);
      return msg || fallback;
    } catch (_) {
      return fallback;
    }
  };

  const label = (qualityId) => {
    const h = HEIGHT_OF[qualityId];
    return h ? h + 'p' : qualityId;
  };

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  let selected = AUTO;
  let lastStatus = null;

  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------------------------ *
   * i18n
   * ------------------------------------------------------------------ */

  function localize() {
    for (const el of document.querySelectorAll('[data-i18n]')) {
      el.textContent = t(el.dataset.i18n, el.textContent);
    }
    for (const el of document.querySelectorAll('[data-i18n-title]')) {
      el.title = t(el.dataset.i18nTitle, el.title);
    }
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  function renderOptions() {
    const wrap = $('options');
    wrap.textContent = '';

    const items = [{ id: AUTO, label: t('optAuto', 'Auto'), desc: t('optAutoDesc', 'YouTube decides') }].concat(
      LADDER.map((q) => ({
        id: q.id,
        label: q.height + 'p',
        tag: q.tag || '',
      }))
    );

    for (const item of items) {
      const row = document.createElement('label');
      row.className = 'opt' + (item.id === AUTO ? ' is-auto' : '');
      row.dataset.quality = item.id;

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'quality';
      input.value = item.id;
      input.checked = item.id === selected;

      const name = document.createElement('span');
      name.className = 'opt-name';
      name.textContent = item.label;
      if (item.desc) {
        const desc = document.createElement('span');
        desc.className = 'opt-desc';
        desc.textContent = '· ' + item.desc;
        name.appendChild(desc);
      }

      row.append(input, name);

      if (item.tag) {
        const tag = document.createElement('span');
        tag.className = 'opt-tag';
        tag.textContent = item.tag;
        row.appendChild(tag);
      }
      row.appendChild(document.createElement('span')).className = 'opt-na';

      input.addEventListener('change', () => {
        if (input.checked) choose(item.id);
      });

      wrap.appendChild(row);
    }
  }

  function decorateOptions() {
    const status = lastStatus;
    const available = status && Array.isArray(status.available) ? status.available : null;
    const onVideo = !!(status && status.hasPlayer && status.onVideoPage);

    for (const row of document.querySelectorAll('.opt')) {
      const id = row.dataset.quality;
      const na = row.querySelector('.opt-na');

      row.classList.toggle('is-active', id === selected);
      row.classList.remove('is-unavailable');

      if (id === AUTO || !available || !onVideo) {
        na.textContent = '';
        continue;
      }

      const ok = available.includes(id);
      row.classList.toggle('is-unavailable', !ok);
      na.textContent = ok ? '' : t('optNotOffered', 'not offered');
    }
  }

  function renderStatus(status) {
    lastStatus = status || null;

    const titleEl = $('videoTitle');
    const currentEl = $('currentQuality');
    const forcedEl = $('forcedQuality');
    const hintEl = $('statusHint');

    if (!status || !status.hasPlayer || !status.onVideoPage) {
      titleEl.textContent = t('statusNoVideo', 'No video open');
      currentEl.textContent = '—';
      hintEl.hidden = false;
      hintEl.textContent = t('hintNoPlayer', 'Open a YouTube video to see the resolutions it offers.');
      decorateOptions();
      return;
    }

    titleEl.textContent = status.title || t('statusUntitled', 'YouTube video');

    const cur = status.current ? label(status.current) : '';
    currentEl.textContent = cur || '—';

    // The forced value comes from extension storage, which the page cannot
    // forge. Anything the engine reports is page-sourced and treated as
    // advisory only, so a spoofed status cannot misrepresent your setting.
    if (selected === AUTO) {
      forcedEl.textContent = t('optAuto', 'Auto');
    } else {
      forcedEl.textContent = label(selected);
    }

    const fellBack = selected !== AUTO && status.applied && status.applied !== selected;
    if (fellBack) {
      hintEl.hidden = false;
      hintEl.textContent = t('hintFallback', '$REQ$p is not offered here · using $USED$p', [
        String(HEIGHT_OF[selected] || selected),
        String(HEIGHT_OF[status.applied] || status.applied),
      ]);
    } else {
      hintEl.hidden = true;
    }

    decorateOptions();
  }

  async function updateBadge(quality) {
    const action = API.action || API.browserAction;
    if (!action || !action.setBadgeText) return;
    const text = quality === AUTO ? '' : String(HEIGHT_OF[quality] || '');
    try {
      await call(action.setBadgeText.bind(action), { text });
      if (action.setBadgeBackgroundColor) {
        await call(action.setBadgeBackgroundColor.bind(action), { color: '#cc0000' });
      }
    } catch (_) {
      /* badge is cosmetic */
    }
  }

  /* ------------------------------------------------------------------ *
   * Actions
   * ------------------------------------------------------------------ */

  async function activeYouTubeTab() {
    let tabs = [];
    try {
      tabs = (await tabsQuery({ active: true, currentWindow: true })) || [];
    } catch (_) {
      return null;
    }
    const tab = tabs[0];
    if (!tab || typeof tab.id !== 'number') return null;
    const url = tab.url || tab.pendingUrl || '';
    if (!/^https?:\/\/([^/]*\.)?(youtube|youtube-nocookie)\.com\//.test(url)) return null;
    return tab;
  }

  async function refreshStatus() {
    const tab = await activeYouTubeTab();
    if (!tab) {
      renderStatus(null);
      return;
    }
    const status = await sendToTab(tab.id, { fyr: NS, cmd: 'status' });
    if (!status) {
      renderStatus({ hasPlayer: false, onVideoPage: true, available: [], current: '' });
      $('statusHint').hidden = false;
      $('statusHint').textContent = t('hintReload', 'Reload that YouTube tab to activate the extension there.');
      return;
    }
    renderStatus(status);
  }

  async function choose(quality) {
    selected = quality;
    await storageSet({ forcedQuality: quality });
    await updateBadge(quality);
    decorateOptions();

    // Nudge every YouTube tab so the change is visible immediately.
    // Storage change events reach the rest on their own; this just makes the
    // tab the user is looking at react now.
    await broadcast({ fyr: NS, cmd: 'apply', quality });
    await refreshStatus();
  }

  async function broadcast(message) {
    try {
      const tabs =
        (await tabsQuery({ url: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'] })) || [];
      for (const tab of tabs) {
        if (typeof tab.id === 'number') sendToTab(tab.id, message);
      }
    } catch (_) {
      /* not critical — storage events already propagate the change */
    }
  }

  async function reapplyAll() {
    const btn = $('reapply');
    btn.classList.remove('spin');
    void btn.offsetWidth; // restart the animation
    btn.classList.add('spin');
    await broadcast({ fyr: NS, cmd: 'reapply' });
    await refreshStatus();
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  async function init() {
    localize();

    const data = await storageGet({ forcedQuality: AUTO });
    const saved = data.forcedQuality;
    selected =
      typeof saved === 'string' && Object.prototype.hasOwnProperty.call(HEIGHT_OF, saved) ? saved : AUTO;

    renderOptions();
    await updateBadge(selected);
    decorateOptions();
    await refreshStatus();

    $('reapply').addEventListener('click', reapplyAll);

    // Keep the status in sync when the user changes tabs while the popup stays open.
    if (API.tabs.onActivated) {
      API.tabs.onActivated.addListener(() => {
        refreshStatus();
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
