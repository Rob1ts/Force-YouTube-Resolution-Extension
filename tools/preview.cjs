/*
 * Builds preview/popup-preview.html — the real popup with a mocked
 * WebExtension API — so the UI can be inspected without loading the
 * extension in a browser. Debug helper only; not shipped.
 *
 *   node tools/preview.cjs
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'preview');

const MESSAGES = {
  extName: 'Force YouTube Resolution',
  nowPlaying: 'Now playing',
  currentQuality: 'Current',
  forcedQuality: 'Forced',
  forcedResolution: 'Forced resolution',
  footnote: 'Applies to every YouTube tab and video.',
  btnApplyNow: 'Apply now',
  optAuto: 'Auto',
  optAutoDesc: 'YouTube decides',
  optNotOffered: 'not offered',
  statusNoVideo: 'No video open',
  statusUntitled: 'YouTube video',
  optForcedLabel: 'Requested',
  hintFallback: '$REQ$p is not offered here · using $USED$p',
  hintNoPlayer: 'Open a YouTube video to see the resolutions it offers.',
  hintReload: 'Reload that YouTube tab to activate the extension there.',
};

const SCENARIOS = {
  // 1080p forced, video offers 1080p and below
  normal: {
    forcedQuality: 'hd1080',
    available: ['hd1080', 'hd720', 'large', 'medium'],
    current: 'hd1080',
    applied: 'hd1080',
    title: '4K60 HDR Cinematic Test Pattern — Colour Bars',
    onVideoPage: true,
    hasPlayer: true,
  },
  // 4320p requested on a 1080p-only video -> fallback hint
  fallback: {
    forcedQuality: 'highres',
    available: ['hd1080', 'hd720', 'large', 'medium'],
    current: 'hd1080',
    applied: 'hd1080',
    title: '8K footage downscaled by YouTube',
    onVideoPage: true,
    hasPlayer: true,
  },
  // Auto
  auto: {
    forcedQuality: 'auto',
    available: ['hd1080', 'hd720', 'large', 'medium'],
    current: 'hd1080',
    applied: null,
    title: 'Nothing forced, YouTube is in charge',
    onVideoPage: true,
    hasPlayer: true,
  },
  // No YouTube tab
  notab: {
    forcedQuality: 'hd720',
    available: [],
    current: '',
    applied: null,
    title: '',
    onVideoPage: false,
    hasPlayer: false,
  },
};

const mock = `
window.__SCENARIO__ = ${JSON.stringify(SCENARIOS)};
const SC = window.__SCENARIO__[(new URLSearchParams(location.search).get('scenario') || 'normal')] || window.__SCENARIO__.normal;
window.__MESSAGES__ = ${JSON.stringify(MESSAGES)};
let stored = { forcedQuality: SC.forcedQuality, wroteLS: false };
const later = (fn) => setTimeout(fn, 0);
window.chrome = {
  i18n: {
    getMessage(key, subs) {
      let msg = window.__MESSAGES__[key] || '';
      if (subs) {
        msg = msg.replace(/\\$REQ\\$/g, subs[0] || '').replace(/\\$USED\\$/g, subs[1] || '');
      }
      return msg;
    },
  },
  runtime: { lastError: null, onMessage: { addListener() {} } },
  storage: {
    local: {
      get(defaults, cb) { later(() => cb({ ...defaults, ...stored })); },
      set(obj, cb) { Object.assign(stored, obj); later(() => cb && cb()); },
    },
    onChanged: { addListener() {} },
  },
  tabs: {
    query(q, cb) {
      later(() => {
        if (q && q.active) {
          if (SC.hasPlayer || SC.onVideoPage) cb([{ id: 1, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }]);
          else cb([{ id: 9, url: 'https://example.com/' }]);
          return;
        }
        cb([{ id: 1, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }]);
      });
    },
    sendMessage(id, msg, cb) {
      later(() => {
        if (msg && msg.cmd === 'status') {
          cb({
            hasPlayer: SC.hasPlayer,
            onVideoPage: SC.onVideoPage,
            available: SC.available,
            current: SC.current,
            forced: stored.forcedQuality,
            applied: SC.applied,
            title: SC.title,
          });
        } else {
          cb({ ok: true, quality: msg && msg.quality });
        }
      });
    },
    onActivated: { addListener() {} },
  },
  action: {
    setBadgeText(_o, cb) { cb && cb(); },
    setBadgeBackgroundColor(_o, cb) { cb && cb(); },
  },
};
`;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'icons'), { recursive: true });

for (const f of ['popup.css', 'popup.js']) {
  fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
}
// Icons are generated into the build output, not src/.
const ICONS = path.join(ROOT, 'Chromium', 'icons');
for (const f of fs.readdirSync(ICONS)) {
  fs.copyFileSync(path.join(ICONS, f), path.join(OUT, 'icons', f));
}
fs.writeFileSync(path.join(OUT, 'mock-chrome.js'), mock);

const html = fs
  .readFileSync(path.join(SRC, 'popup.html'), 'utf8')
  .replace('<script src="popup.js"></script>', '<script src="mock-chrome.js"></script>\n    <script src="popup.js"></script>');
fs.writeFileSync(path.join(OUT, 'popup-preview.html'), html);

fs.writeFileSync(
  path.join(OUT, 'index.html'),
  `<!DOCTYPE html><meta charset="utf-8"><title>popup previews</title>
<style>body{margin:0;background:#0b0c0e;font:13px system-ui;color:#e8eaed}
h2{font-size:12px;color:#9aa0a6;margin:14px 0 6px 10px;letter-spacing:.5px;text-transform:uppercase}
iframe{width:316px;height:430px;border:0;background:#14161a;display:block}</style>
${Object.keys(SCENARIOS)
  .map((s) => `<h2>${s}</h2><iframe src="popup-preview.html?scenario=${s}"></iframe>`)
  .join('\n')}\n`
);

console.log('preview written to', OUT);
