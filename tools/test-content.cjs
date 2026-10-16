/*
 * Tests for the main-world engine (force.js) and the isolated-world bridge
 * (bridge.js), run in vm sandboxes with a fake YouTube player.
 *
 *   node tools/test-content.cjs
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const NS = 'fyr';

let passed = 0;
let failed = 0;

function ok(name, cond, extra) {
  if (cond) {
    passed++;
    console.log('  PASS  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `expected ${e}, got ${a}`);
}

const flush = (ms = 750) => new Promise((r) => setTimeout(r, ms));

/* ================================================================== *
 * force.js — MAIN world engine
 * ================================================================== */

function bootEngine({
  available,
  current = '',
  apiReady = true,
  onVideoPage = true,
  storage: sharedStorage = {},
}) {
  const playerListeners = new Map();
  const docListeners = new Map();
  const winListeners = new Map();
  const posted = [];
  const localStorageData = sharedStorage;

  const player = {
    isConnected: true,
    calls: [],
    dataset: {},
    _available: available,
    _current: current,
    getAvailableQualityLevels() {
      return this._available.slice();
    },
    getPlaybackQuality() {
      return this._current;
    },
    setPlaybackQuality(q) {
      this.calls.push(['setPlaybackQuality', q]);
      this._current = q;
    },
    // records the arity too: the engine must try both
    setPlaybackQualityRange(...args) {
      this.calls.push(['setPlaybackQualityRange', ...args]);
    },
    addEventListener(type, fn) {
      if (!playerListeners.has(type)) playerListeners.set(type, []);
      playerListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = playerListeners.get(type) || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    fire(type, arg) {
      for (const fn of (playerListeners.get(type) || []).slice()) fn(arg);
    },
  };

  if (!apiReady) {
    // Models the isolated world: page-defined own properties are absent.
    delete player.setPlaybackQuality;
    delete player.setPlaybackQualityRange;
    delete player.getAvailableQualityLevels;
    delete player.getPlaybackQuality;
  }

  const document = {
    visibilityState: 'visible',
    documentElement: { addEventListener() {}, removeEventListener() {} },
    getElementById(id) {
      return id === 'movie_player' ? player : null;
    },
    querySelector() {
      return null;
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
  };

  const timers = [];
  const sandbox = {
    window: {
      addEventListener(type, fn) {
        if (!winListeners.has(type)) winListeners.set(type, []);
        winListeners.get(type).push(fn);
      },
      postMessage(msg) {
        posted.push(msg);
      },
    },
    document,
    localStorage: {
      getItem: (k) => (k in localStorageData ? localStorageData[k] : null),
      setItem: (k, v) => {
        localStorageData[k] = String(v);
      },
      removeItem: (k) => {
        delete localStorageData[k];
      },
    },
    location: { pathname: onVideoPage ? '/watch' : '/' },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    setInterval(fn) {
      timers.push(fn);
      return timers.length;
    },
    clearInterval() {},
    setTimeout,
    clearTimeout,
    console,
    Promise, Object, Array, JSON, Math, Date, String, Number,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'force.js'), 'utf8'), sandbox, { filename: 'force.js' });

  const deliver = (event) => {
    for (const fn of (winListeners.get('message') || []).slice()) fn(event);
  };

  return {
    player,
    posted,
    sandboxWindow: sandbox.window,
    localStorageData,
    docListeners,
    playerListeners,
    winListeners,
    tick: () => timers.forEach((f) => f()),
    rawMessage: deliver,
    fromBridge: (cmd, quality) => {
      const data = { fyr: NS, cmd };
      if (quality !== undefined) data.quality = quality;
      deliver({ source: sandbox.window, data });
    },
    lastStatus() {
      const msgs = posted.filter((m) => m.evt === 'status');
      return msgs.length ? msgs[msgs.length - 1].status : null;
    },
  };
}

/* ================================================================== *
 * bridge.js — ISOLATED world bridge
 * ================================================================== */

function bootBridge({ forced = 'auto', isFirefox = true, wroteLS = false, ytWritten = null, localStorageData = {} } = {}) {
  const storeData = { forcedQuality: forced, wroteLS, ytWritten };
  const storageWrites = [];
  const winListeners = new Map();
  const toEngine = [];
  const messageListeners = [];
  const injected = [];
  const storageChangeListeners = [];

  const chromeMock = {
    runtime: {
      id: 'test',
      lastError: null,
      getURL: (p) => 'moz-extension://test/' + p,
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
    },
    storage: {
      local: {
        get(defaults, cb) {
          const out = {};
          for (const k of Object.keys(defaults)) out[k] = k in storeData ? storeData[k] : defaults[k];
          cb(out);
        },
        set(obj, cb) {
          const changes = {};
          for (const k of Object.keys(obj)) {
            changes[k] = { oldValue: storeData[k], newValue: obj[k] };
            storeData[k] = obj[k];
          }
          storageWrites.push({ ...obj });
          cb && cb();
          // Real storage fires onChanged; the mock must too or the bridge's
          // reactive path is never exercised.
          for (const fn of storageChangeListeners) fn(changes, 'local');
        },
      },
      onChanged: { addListener: (fn) => storageChangeListeners.push(fn) },
    },
  };

  const sandbox = {
    chrome: chromeMock,
    localStorage: {
      getItem: (k) => (k in localStorageData ? localStorageData[k] : null),
      setItem: (k, v) => {
        localStorageData[k] = String(v);
      },
      removeItem: (k) => {
        delete localStorageData[k];
      },
    },
    document: {
      documentElement: { appendChild: (el) => injected.push(el) },
      createElement: (tag) => ({ tagName: String(tag).toUpperCase(), dataset: {}, src: '' }),
      addEventListener() {},
    },
    window: {
      addEventListener(type, fn) {
        if (!winListeners.has(type)) winListeners.set(type, []);
        winListeners.get(type).push(fn);
      },
      postMessage: (msg) => toEngine.push(msg),
    },
    setTimeout,
    clearTimeout,
    console,
    Promise, Object, Array, JSON, Math, Date, String, Number, Set,
  };
  sandbox.globalThis = sandbox;
  if (isFirefox) {
    // Real Firefox exposes the full API surface on `browser` as well as `chrome`.
    sandbox.browser = {
      ...chromeMock,
      runtime: { ...chromeMock.runtime, getBrowserInfo: () => ({ name: 'Firefox' }) },
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'bridge.js'), 'utf8'), sandbox, { filename: 'bridge.js' });

  const fromEngine = (data) => {
    for (const fn of (winListeners.get('message') || []).slice()) {
      fn({ source: sandbox.window, data });
    }
  };

  return {
    sandbox,
    storeData,
    storageWrites,
    toEngine,
    injected,
    localStorageData,
    fromEngine,
    fromStorage: (value) => {
      for (const fn of storageChangeListeners) {
        fn({ forcedQuality: { oldValue: storeData.forcedQuality, newValue: value } }, 'local');
      }
    },
    ask: (msg, sender = { id: 'test' }) => {
      let out;
      let async_ = false;
      for (const fn of messageListeners) {
        const r = fn(msg, sender, (res) => {
          out = res;
        });
        if (r === true) async_ = true;
      }
      // `out` may be assigned later by an async sendResponse, so expose a getter.
      return { get out() { return out; }, async: async_ };
    },
  };
}

/* ================================================================== */

async function main() {
  /* ---------------- force.js ---------------- */
  console.log('\nforce.js — main-world engine');

  console.log('\n [1] player API is main-world only (root cause)');
  {
    const dead = bootEngine({ available: ['hd1080'], apiReady: false });
    dead.fromBridge('set', 'hd1080');
    await flush();
    eq('no calls when the API is unreachable', dead.player.calls, []);

    const live = bootEngine({ available: ['hd1080', 'hd720', 'large'], apiReady: true });
    live.fromBridge('set', 'hd1080');
    await flush();
    ok('calls happen when the API is reachable', live.player.calls.length > 0, JSON.stringify(live.player.calls));
  }

  console.log('\n [2] exact match is forced and pinned');
  {
    const h = bootEngine({ available: ['hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'] });
    h.fromBridge('set', 'hd1080');
    await flush();
    const calls = h.player.calls;
    ok('setPlaybackQuality(hd1080)', calls.some((c) => c[0] === 'setPlaybackQuality' && c[1] === 'hd1080'), JSON.stringify(calls));
    ok('setPlaybackQualityRange(target) one-arg form', calls.some((c) => c[0] === 'setPlaybackQualityRange' && c.length === 2 && c[1] === 'hd1080'));
    ok('setPlaybackQualityRange(target, target) two-arg form', calls.some((c) => c[0] === 'setPlaybackQualityRange' && c.length === 3 && c[1] === 'hd1080' && c[2] === 'hd1080'));
    eq('dataset.defaultQuality set', h.player.dataset.defaultQuality, 'hd1080');
    const ls = h.localStorageData['yt-player-quality'];
    ok('yt-player-quality written', typeof ls === 'string');
    eq('mirrors 1080', JSON.parse(JSON.parse(ls).data), { quality: 1080, previousQuality: 1080 });
  }

  console.log('\n [3] fallback behaviour');
  {
    const up = bootEngine({ available: ['hd1080', 'hd720', 'large'], });
    up.fromBridge('set', 'highres');
    await flush();
    ok('above -> best level below', up.player.calls.some((c) => c[1] === 'hd1080'), JSON.stringify(up.player.calls));

    const down = bootEngine({ available: ['hd1080', 'hd720', 'large'] });
    down.fromBridge('set', 'tiny');
    await flush();
    ok('below -> lowest available', down.player.calls.some((c) => c[1] === 'large'));

    const mid = bootEngine({ available: ['hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'] });
    mid.fromBridge('set', 'hd1440');
    await flush();
    ok('between -> the level just below', mid.player.calls.some((c) => c[1] === 'hd1080'));

    const legacy = bootEngine({ available: ['hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'] });
    legacy.fromBridge('set', 'large');
    await flush();
    ok('legacy label used directly', legacy.player.calls.some((c) => c[1] === 'large'));
    ok('never maps legacy labels to auto', !legacy.player.calls.some((c) => c[1] === 'auto'));
  }

  console.log('\n [4] never requests an unavailable label');
  {
    const h = bootEngine({ available: ['hd1080', 'hd720', 'large'] });
    h.fromBridge('set', 'highres');
    await flush();
    h.tick();
    h.tick();
    const requested = h.player.calls.filter((c) => c[0] === 'setPlaybackQuality').map((c) => c[1]);
    ok('only offered labels used', requested.every((q) => h.player._available.includes(q)), JSON.stringify(requested));
  }

  console.log('\n [5] Auto stops forcing and leaves cleanup to the bridge');
  {
    const h = bootEngine({ available: ['hd1080', 'hd720'], current: 'hd720' });
    h.fromBridge('set', 'hd1080');
    await flush();
    ok('forced first', h.player.calls.length > 0);
    h.localStorageData['yt-player-quality'] = '{"stale":true}';
    h.player.calls.length = 0;
    h.posted.length = 0;
    h.fromBridge('set', 'auto');
    await flush();
    eq('no calls in auto mode', h.player.calls, []);
    ok('the page world never removes the key itself', 'yt-player-quality' in h.localStorageData);
    ok('and emits no "cleared" event', !h.posted.some((m) => m.evt === 'cleared'));
  }

  console.log('\n [5b] re-forcing after Auto rewrites the key (gear menu stays in sync)');
  {
    const h = bootEngine({ available: ['hd1080', 'hd720'], current: 'hd720' });
    h.fromBridge('set', 'hd1080');
    await flush();
    ok('written on the first force', 'yt-player-quality' in h.localStorageData);

    // The bridge removes the entry when the user switches to Auto.
    delete h.localStorageData['yt-player-quality'];
    h.fromBridge('set', 'auto');
    await flush();
    h.posted.length = 0;

    h.fromBridge('set', 'hd1080');
    await flush();
    ok('re-forcing re-creates the key', 'yt-player-quality' in h.localStorageData);
    ok('and reports the new write to the bridge', h.posted.some((m) => m.evt === 'wrote'));
  }

  console.log('\n [6] re-asserts, and stays quiet when already correct');
  {
    const h = bootEngine({ available: ['hd1080', 'hd720', 'large'], current: 'hd1080' });
    h.fromBridge('set', 'hd720');
    await flush();
    h.player.calls.length = 0;
    h.tick(); h.tick(); h.tick();
    eq('quiet when YouTube agrees', h.player.calls, []);

    h.player._current = 'hd1080'; // YouTube overrode us
    h.tick();
    ok('re-pushes after an override', h.player.calls.some((c) => c[1] === 'hd720'));
  }

  console.log('\n [7] player events');
  {
    const h = bootEngine({ available: ['hd1080', 'hd720', 'large'] });
    h.fromBridge('set', 'hd720');
    await flush();
    h.player.calls.length = 0;
    h.player._current = 'large';
    h.player.fire('onStateChange', 1);
    await flush();
    ok('onStateChange(PLAYING) re-applies', h.player.calls.some((c) => c[1] === 'hd720'));

    h.player.calls.length = 0;
    h.player._current = 'large';
    h.player.fire('onVideoDataChange', {});
    await flush(1800);
    ok('onVideoDataChange re-applies', h.player.calls.some((c) => c[1] === 'hd720'));
  }

  console.log('\n [8] status reporting');
  {
    const h = bootEngine({ available: ['hd2160', 'hd1080', 'hd720'], current: 'hd1080' });
    h.fromBridge('set', 'hd2160');
    await flush();
    h.fromBridge('status');
    await flush(50);
    const s = h.lastStatus();
    ok('hasPlayer', s.hasPlayer === true);
    eq('available mirrors the player', s.available, ['hd2160', 'hd1080', 'hd720']);
    eq('forced', s.forced, 'hd2160');
    ok('posted a ready handshake on load', h.posted.some((m) => m.evt === 'ready'));
  }

  console.log('\n [9] rejects values outside the ladder');
  {
    const h = bootEngine({ available: ['hd1080', 'hd720'] });
    h.fromBridge('set', '9999p');
    await flush();
    eq('no calls for a custom value', h.player.calls, []);
    h.fromBridge('status');
    await flush(50);
    eq('normalised to auto', h.lastStatus().forced, 'auto');
  }

  /* ---------------- bridge.js ---------------- */
  console.log('\nbridge.js — isolated-world bridge');

  console.log('\n [10] does not forward before the engine is ready');
  {
    const b = bootBridge({ forced: 'hd720' });
    await flush(50);
    ok('nothing sent while engine is absent', b.toEngine.filter((m) => m.cmd === 'set').length === 0);
    b.fromEngine({ fyr: NS, evt: 'ready' });
    await flush(50);
    const set = b.toEngine.find((m) => m.cmd === 'set');
    ok('sends the stored setting on ready', set && set.quality === 'hd720', JSON.stringify(b.toEngine));
  }

  console.log('\n [11] relays storage changes to the engine');
  {
    const b = bootBridge({ forced: 'auto' });
    await flush(50);
    b.fromEngine({ fyr: NS, evt: 'ready' });
    b.toEngine.length = 0;
    b.fromStorage('hd1080');
    await flush(50);
    ok('setting forwarded', b.toEngine.some((m) => m.cmd === 'set' && m.quality === 'hd1080'), JSON.stringify(b.toEngine));
  }

  console.log('\n [12] popup commands');
  {
    const b = bootBridge({ forced: 'auto' });
    await flush(50);
    b.fromEngine({ fyr: NS, evt: 'ready' });
    await flush(50);

    const apply = b.ask({ fyr: NS, cmd: 'apply', quality: 'hd720' });
    eq('apply acknowledged', apply.out, { ok: true, quality: 'hd720' });
    eq('persisted', b.storeData.forcedQuality, 'hd720');
    ok('engine told', b.toEngine.some((m) => m.cmd === 'set' && m.quality === 'hd720'));

    const bogus = b.ask({ fyr: NS, cmd: 'apply', quality: '4320p-custom' });
    eq('custom value rejected -> auto', bogus.out, { ok: true, quality: 'auto' });

    b.toEngine.length = 0;
    const st = b.ask({ fyr: NS, cmd: 'status' });
    ok('status request is async', st.async === true);
    b.fromEngine({ fyr: NS, evt: 'status', status: { hasPlayer: true, available: ['hd720'], current: 'hd720', forced: 'hd720', applied: 'hd720', title: 'x', onVideoPage: true } });
    ok('status relayed to the popup', st.out && st.out.hasPlayer === true, JSON.stringify(st.out));
  }

  console.log('\n [12a] rejects messages from another extension');
  {
    const b = bootBridge({ forced: 'auto' });
    await flush(50);
    b.fromEngine({ fyr: NS, evt: 'ready' });
    const evil = b.ask({ fyr: NS, cmd: 'apply', quality: 'hd2160' }, { id: 'some-other-extension' });
    eq('no response to a foreign sender', evil.out, undefined);
    eq('stored setting unchanged', b.storeData.forcedQuality, 'auto');
    ok('engine not told to change', !b.toEngine.some((m) => m.cmd === 'set' && m.quality === 'hd2160'));
  }

  console.log('\n [13] caches a fresh status for quick popup opens');
  {
    const b = bootBridge({ forced: 'auto' });
    await flush(50);
    b.fromEngine({ fyr: NS, evt: 'ready' });
    b.fromEngine({ fyr: NS, evt: 'status', status: { hasPlayer: true, available: ['hd1080'], current: 'hd1080', forced: 'auto', applied: null, title: '', onVideoPage: true } });
    await flush(50);
    const st = b.ask({ fyr: NS, cmd: 'status' });
    eq('answered synchronously from cache', st.async, false);
    eq('cache contents', st.out.available, ['hd1080']);
  }

  console.log('\n [14] REGRESSION: injects nothing on any browser');
  {
    // MV3 world:"MAIN" replaces the injected <script src>, so no file needs to
    // be web-accessible and no site can load our code.
    for (const variant of [{ isFirefox: true }, { isFirefox: false }]) {
      const b = bootBridge(variant);
      await flush(50);
      eq(`injects nothing (isFirefox=${variant.isFirefox})`, b.injected.length, 0);
    }
  }

  console.log('\n [14b] sends the setting without any page-forgeable flag');
  {
    const b = bootBridge({ forced: 'hd720' });
    await flush(50);
    b.fromEngine({ fyr: NS, evt: 'ready' });
    await flush(50);
    const set = b.toEngine.find((m) => m.cmd === 'set');
    ok('sends the stored setting on ready', set && set.quality === 'hd720', JSON.stringify(b.toEngine));
    ok('the set command carries no "wrote" flag', set && !('wrote' in set), JSON.stringify(set));
  }

  console.log('\n [14c] records a genuine write by exact value and cleans it up');
  {
    const origin = {};
    const b = bootBridge({ forced: 'hd1080', wroteLS: false, localStorageData: origin });
    await flush(50);
    b.fromEngine({ fyr: NS, evt: 'ready' });
    origin['yt-player-quality'] = '{"quality":1080}';
    b.fromEngine({ fyr: NS, evt: 'wrote', value: '{"quality":1080}' });
    await flush(50);
    ok('wroteLS persisted to true', b.storeData.wroteLS === true, JSON.stringify(b.storeData));
    ok('the exact written value is persisted', b.storeData.ytWritten === '{"quality":1080}', JSON.stringify(b.storeData));

    b.ask({ fyr: NS, cmd: 'apply', quality: 'auto' });
    await flush(50);
    ok('a value the extension wrote is removed on Auto', !('yt-player-quality' in origin), JSON.stringify(Object.keys(origin)));
  }

  console.log('\n [15] ignores foreign postMessage traffic');
  {
    const h = bootEngine({ available: ['hd1080', 'hd720'] });
    const good = { source: h.sandboxWindow, data: { fyr: NS, cmd: 'set', quality: 'hd1080' } };
    const stray = [
      ['not this window', { source: {}, data: { fyr: NS, cmd: 'set', quality: 'tiny' } }],
      ['not a window source', { source: h.player, data: { fyr: NS, cmd: 'set', quality: 'tiny' } }],
      ['wrong namespace', { source: h.sandboxWindow, data: { evil: 1 } }],
      ['null data', { source: h.sandboxWindow, data: null }],
      ['non-object data', { source: h.sandboxWindow, data: 'set' }],
    ];
    for (const [, ev] of stray) h.rawMessage(ev);
    await flush(50);
    eq('foreign messages force nothing', h.player.calls, []);

    h.rawMessage(good);
    await flush();
    ok('the real bridge message is accepted', h.player.calls.some((c) => c[1] === 'hd1080'));
  }

  console.log('\n [16] REGRESSION: Auto clears the engine override across a reload');
  {
    // The engine writes the key and reports the exact value; the isolated
    // bridge records it. On the next load the bridge removes it from storage.
    const origin = {};
    const engine = bootEngine({ available: ['hd1080', 'hd720'], storage: origin });
    engine.fromBridge('set', 'hd1080');
    await flush();
    const wrote = engine.posted.filter((m) => m.evt === 'wrote').pop();
    ok('engine wrote yt-player-quality', 'yt-player-quality' in origin);
    ok('engine reported the exact value it wrote', !!wrote && wrote.value === origin['yt-player-quality'], JSON.stringify(wrote));
    ok('engine does not remove the key itself', 'yt-player-quality' in origin);

    // Browser restarts. The bridge knows we wrote it and holds the value.
    const b = bootBridge({ forced: 'auto', wroteLS: true, ytWritten: origin['yt-player-quality'], localStorageData: origin });
    await flush(50);
    ok('bridge removes the stale override on boot', !('yt-player-quality' in origin), JSON.stringify(Object.keys(origin)));
  }

  console.log('\n [17] REGRESSION: does not delete a key it never wrote');
  {
    const origin = { 'yt-player-quality': '{"quality":720,"previousQuality":720}' };
    const b = bootBridge({ forced: 'auto', wroteLS: false, localStorageData: origin });
    await flush(50);
    ok('YouTube\'s own preference is preserved', 'yt-player-quality' in origin, JSON.stringify(Object.keys(origin)));
  }

  console.log('\n [18] engine reports the exact value it wrote, never a cleanup');
  {
    const h = bootEngine({ available: ['hd1080', 'hd720'] });
    h.fromBridge('set', 'hd1080');
    await flush();
    const wrote = h.posted.filter((m) => m.evt === 'wrote').pop();
    ok('posted a "wrote" event after persisting', !!wrote);
    ok('the event carries the raw value it stored', !!wrote && wrote.value === h.localStorageData['yt-player-quality']);
    ok('the engine never claims to clear YouTube\'s key', !h.posted.some((m) => m.evt === 'cleared'));
  }

  console.log('\n [19] REGRESSION: no page-visible global for the load guard');
  {
    const h = bootEngine({ available: ['hd1080'] });
    const before = Object.getOwnPropertyNames(h.sandboxWindow).filter((k) => /^__/.test(k));
    h.fromBridge('status');
    await flush(50);
    const after = Object.getOwnPropertyNames(h.sandboxWindow).filter((k) => /^__/.test(k));
    eq('no __-prefixed globals left behind', after, []);
    eq('nothing new added at load', before, []);
  }

  console.log('\n [20] REGRESSION: bridge exposes no page-visible string global');
  {
    const b = bootBridge({ forced: 'auto' });
    await flush(50);
    const globals = Object.getOwnPropertyNames(b.sandbox.window).filter((k) => /^__/.test(k));
    eq('no __-prefixed globals', globals, []);
  }

  console.log('\n [21] REGRESSION: forged "wrote" cannot make the bridge drop a key it did not write');
  {
    // A page can forge evt:"wrote". The bridge only ever persists a bounded
    // string, and cleanup removes an entry only while it still holds exactly
    // that value. A forged marker therefore cannot authorise deleting
    // YouTube's real preference.
    const origin = { 'yt-player-quality': '{"quality":720,"previousQuality":720}' };
    const b = bootBridge({ forced: 'auto', wroteLS: false, localStorageData: origin });
    await flush(50);
    b.fromEngine({ fyr: NS, evt: 'ready' });
    b.fromEngine({ fyr: NS, evt: 'wrote', value: '{"forged":true}' });
    await flush(50);
    ok('the forged marker is recorded', b.storeData.wroteLS === true && b.storeData.ytWritten === '{"forged":true}');
    ok('but YouTube\'s key is untouched so far', 'yt-player-quality' in origin);

    b.ask({ fyr: NS, cmd: 'apply', quality: 'auto' });
    await flush(50);
    ok('cleanup leaves a value it did not write', 'yt-player-quality' in origin, JSON.stringify(Object.keys(origin)));

    // And a "wrote" with a non-string payload is ignored outright.
    const b2 = bootBridge({ forced: 'hd1080', wroteLS: false });
    await flush(50);
    b2.fromEngine({ fyr: NS, evt: 'wrote', value: { evil: true } });
    await flush(50);
    ok('non-string "wrote" payloads are ignored', b2.storeData.wroteLS === false, JSON.stringify(b2.storeData));
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main();
