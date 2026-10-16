/*
 * End-to-end probe for the hardened cleanup path.
 *
 * The page-world engine writes YouTube's quality key and reports the exact
 * value. The isolated bridge records it, and on Auto removes it again — but
 * only while the entry still holds that exact value, so a value the extension
 * did not write (including one a page forged) is never touched.
 *
 *   node tools/audit-probe.cjs
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src', 'bridge.js');
const NS = 'fyr';
const LS_KEY = 'yt-player-quality';

/** Boot bridge.js against a shared localStorage and a fake extension storage. */
function boot(sharedStorage, storeData) {
  const winListeners = new Map();
  const messageListeners = [];
  const storageChangeListeners = [];

  const chromeMock = {
    runtime: {
      id: 'probe',
      lastError: null,
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
          cb && cb();
          for (const fn of storageChangeListeners) fn(changes, 'local');
        },
      },
      onChanged: { addListener: (fn) => storageChangeListeners.push(fn) },
    },
  };

  const sandbox = {
    chrome: chromeMock,
    localStorage: {
      getItem: (k) => (k in sharedStorage ? sharedStorage[k] : null),
      setItem: (k, v) => {
        sharedStorage[k] = String(v);
      },
      removeItem: (k) => {
        delete sharedStorage[k];
      },
    },
    document: {
      documentElement: { appendChild() {} },
      createElement: () => ({ dataset: {} }),
      addEventListener() {},
    },
    window: {
      addEventListener(type, fn) {
        if (!winListeners.has(type)) winListeners.set(type, []);
        winListeners.get(type).push(fn);
      },
      postMessage() {},
    },
    setTimeout,
    clearTimeout,
    console,
    Promise,
    Object,
    Array,
    JSON,
    Math,
    Date,
    String,
    Number,
    Set,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'bridge.js' });

  const fromEngine = (data) => {
    for (const fn of (winListeners.get('message') || []).slice()) {
      fn({ source: sandbox.window, data });
    }
  };

  return {
    ready: () => fromEngine({ fyr: NS, evt: 'ready' }),
    wrote: (value) => fromEngine({ fyr: NS, evt: 'wrote', value }),
    apply: (quality) => {
      for (const fn of messageListeners) fn({ fyr: NS, cmd: 'apply', quality }, { id: 'probe' }, () => {});
    },
  };
}

const flush = (ms = 200) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('probe: the isolated bridge owns the yt-player-quality cleanup\n');

  const value = JSON.stringify({
    data: JSON.stringify({ quality: 1080, previousQuality: 1080 }),
    creation: 1,
    expiration: 2,
  });

  // Session 1: user forces 1080p. The engine writes the entry and says so.
  const origin = {};
  const s1 = { forcedQuality: 'auto', wroteLS: false, ytWritten: null };
  const b1 = boot(origin, s1);
  await flush();
  b1.ready();
  origin[LS_KEY] = value;
  b1.wrote(value);
  await flush();
  const afterForce = LS_KEY in origin && s1.wroteLS === true;
  console.log(`  session 1, forced 1080p        -> key present: ${LS_KEY in origin}, recorded: ${s1.wroteLS}`);
  if (!afterForce) {
    console.log('  (nothing recorded; probe inconclusive)');
    process.exit(1);
  }

  // Session 2: reload, the user is back on Auto. The bridge must remove it.
  const s2 = { forcedQuality: 'auto', wroteLS: true, ytWritten: value };
  boot(origin, s2);
  await flush();
  const stale = LS_KEY in origin;
  console.log(`  session 2, set back to Auto    -> key present: ${stale}`);

  // Session 3: never forced; YouTube's own preference must survive.
  const other = { [LS_KEY]: '{"quality":720,"previousQuality":720}' };
  const s3 = { forcedQuality: 'auto', wroteLS: false, ytWritten: null };
  boot(other, s3);
  await flush();
  const preserved = LS_KEY in other;
  console.log(`  untouched YouTube preference   -> key preserved: ${preserved}`);

  // Session 4: a forged "wrote" naming a value that is not the stored entry
  // must not authorise deleting YouTube's key.
  const real = { [LS_KEY]: '{"quality":720,"previousQuality":720}' };
  const s4 = { forcedQuality: 'auto', wroteLS: false, ytWritten: null };
  const b4 = boot(real, s4);
  await flush();
  b4.ready();
  b4.wrote('{"forged":true}');
  b4.apply('auto');
  await flush();
  const survived = LS_KEY in real;
  console.log(`  forged "wrote" + Auto          -> key preserved: ${survived}`);

  console.log('');
  const pass = !stale && preserved && survived;
  if (pass) {
    console.log('  RESULT: PASS');
    console.log('  Auto clears exactly the entry the extension wrote, across a reload,');
    console.log('  and never removes a value the extension did not write.');
    process.exit(0);
  }
  console.log('  RESULT: FAIL');
  process.exit(1);
}

main();
