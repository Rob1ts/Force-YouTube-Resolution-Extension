/*
 * End-to-end probe for the finding that motivated the hardening:
 * setting the extension back to "Auto" must remove the yt-player-quality
 * entry, even across a page reload.
 *
 *   node tools/audit-probe.cjs
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src', 'force.js');
const NS = 'fyr';
const LS_KEY = 'yt-player-quality';

/** Boot force.js against a fake player and a shared localStorage (simulating
 *  one youtube.com origin persisting across page loads). */
function boot(sharedStorage, forced, wrote) {
  const listeners = new Map();
  const timers = [];

  const player = {
    isConnected: true,
    dataset: {},
    _available: ['hd1080', 'hd720', 'large'],
    _current: 'hd720',
    getAvailableQualityLevels() { return this._available.slice(); },
    getPlaybackQuality() { return this._current; },
    setPlaybackQuality(q) { this._current = q; },
    setPlaybackQualityRange() {},
    addEventListener() {},
    removeEventListener() {},
  };

  const sandbox = {
    window: {
      addEventListener(t, f) { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(f); },
      postMessage() {},
    },
    document: {
      visibilityState: 'visible',
      documentElement: { addEventListener() {}, removeEventListener() {} },
      getElementById: (id) => (id === 'movie_player' ? player : null),
      querySelector: () => null,
      addEventListener() {},
    },
    localStorage: {
      getItem: (k) => (k in sharedStorage ? sharedStorage[k] : null),
      setItem: (k, v) => { sharedStorage[k] = String(v); },
      removeItem: (k) => { delete sharedStorage[k]; },
    },
    location: { pathname: '/watch' },
    MutationObserver: class { observe() {} },
    addEventListener(t, f) { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(f); },
    setInterval(fn) { timers.push(fn); return timers.length; },
    clearInterval() {},
    setTimeout, clearTimeout,
    console, Promise, Object, Array, JSON, Math, Date, String, Number, Symbol,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'force.js' });

  return {
    deliver: (cmd, quality, wroteFlag) => {
      const data = { fyr: NS, cmd, quality, wrote: wroteFlag };
      for (const f of (listeners.get('message') || []).slice()) {
        f({ source: sandbox.window, data });
      }
    },
  };
}

const flush = (ms = 800) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('probe: clearing the extension override when set back to Auto\n');

  const origin = {};

  // Session 1: user forces 1080p.
  const s1 = boot(origin, 'hd1080', false);
  s1.deliver('set', 'hd1080', false);
  await flush();
  const afterForce = LS_KEY in origin;
  console.log(`  session 1, forced 1080p        -> key present: ${afterForce}`);
  if (!afterForce) {
    console.log('  (nothing written; probe inconclusive)');
    process.exit(1);
  }

  // Session 2: reload. bridge.js seeds wrote=true from extension storage.
  const s2 = boot(origin, 'auto', true);
  s2.deliver('set', 'auto', true);
  await flush();
  const stale = LS_KEY in origin;
  console.log(`  session 2, set back to Auto    -> key present: ${stale}`);

  // Session 3: never forced in this browser profile; must NOT touch YouTube's
  // own preference key.
  const other = { [LS_KEY]: '{"quality":720,"previousQuality":720}' };
  const s3 = boot(other, 'auto', false);
  s3.deliver('set', 'auto', false);
  await flush();
  const preserved = LS_KEY in other;
  console.log(`  untouched YouTube preference   -> key preserved: ${preserved}`);

  console.log('');
  const pass = !stale && preserved;
  if (pass) {
    console.log('  RESULT: PASS');
    console.log('  Auto clears our own override after a reload, and never');
    console.log('  deletes a key the extension did not write.');
    process.exit(0);
  }
  console.log('  RESULT: FAIL');
  process.exit(1);
}

main();
