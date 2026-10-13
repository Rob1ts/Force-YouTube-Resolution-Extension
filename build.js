/*
 * Build script.
 *
 * Assembles the Chromium (MV3) and Firefox (MV2) unpacked extensions from the
 * shared sources in src/. Both builds ship byte-identical content.js /
 * popup.* / icons; only manifest.json differs.
 *
 *   node build.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { writeIcons } = require('./tools/icons.cjs');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');

const SHARED_FILES = ['bridge.js', 'force.js', 'popup.html', 'popup.css', 'popup.js'];

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyTree(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else copyFile(src, dst);
  }
}

/** Guard against the engine and the popup drifting apart, and make sure the
 *  Firefox manifest still exposes force.js as a web-accessible resource. */
function assertLaddersMatch() {
  const read = (file) => {
    const src = fs.readFileSync(path.join(SRC, file), 'utf8');
    const start = src.indexOf('const LADDER = [');
    if (start === -1) throw new Error(`${file}: LADDER not found`);
    const open = src.indexOf('[', start);
    const close = src.indexOf('];', open);
    return src
      .slice(open + 1, close)
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\s+/g, '');
  };
  // force.js and popup.js declare the same ladder; popup.js additionally carries
  // UI-only presentation tags (HD / 4K / 8K), so compare ids and heights only.
  const ids = (s) =>
    [...s.matchAll(/id:\s*'([a-z0-9]+)',height:\s*(\d+)/g)].map((m) => `${m[1]}=${m[2]}`).join(',');
  if (ids(read('force.js')) !== ids(read('popup.js'))) {
    console.error('LADDER id/height mismatch between force.js and popup.js');
    process.exit(1);
  }
  const ladder = ids(read('force.js'));

  // Firefox must be able to inject force.js into the page.
  const ff = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.firefox.json'), 'utf8'));
  const war = [].concat(ff.web_accessible_resources || []);
  if (!war.includes('force.js')) {
    console.error('Firefox manifest: force.js must be in web_accessible_resources');
    process.exit(1);
  }
  const cr = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.chromium.json'), 'utf8'));
  const mainScript = (cr.content_scripts || []).find((cs) => cs.world === 'MAIN');
  if (!mainScript || !(mainScript.js || []).includes('force.js')) {
    console.error('Chromium manifest: force.js must run in a MAIN world content script');
    process.exit(1);
  }
  console.log(`ladder ok (${ladder})`);
}

function build(target, manifestFile) {
  const out = path.join(ROOT, target);
  rimraf(out);
  fs.mkdirSync(out, { recursive: true });

  for (const file of SHARED_FILES) {
    copyFile(path.join(SRC, file), path.join(out, file));
  }
  copyTree(path.join(SRC, '_locales'), path.join(out, '_locales'));
  writeIcons(path.join(out, 'icons'));

  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, manifestFile), 'utf8'));
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // verify every file the manifest references actually exists
  const refs = new Set();
  JSON.stringify(manifest, (k, v) => {
    if (typeof v === 'string' && /\.(js|html|css|png|json)$/.test(v)) refs.add(v);
    return v;
  });
  for (const ref of refs) {
    if (ref.startsWith('__MSG_')) continue;
    if (!fs.existsSync(path.join(out, ref))) {
      console.error(`${target}: manifest references missing file ${ref}`);
      process.exit(1);
    }
  }

  return out;
}

/** Every locale must define exactly the keys of the default locale, and every
 *  __MSG_x__ used by the manifests/popup must exist. */
function assertLocales() {
  const dir = path.join(SRC, '_locales');
  const locales = fs.readdirSync(dir);
  const base = JSON.parse(fs.readFileSync(path.join(dir, 'en_US', 'messages.json'), 'utf8'));
  const baseKeys = Object.keys(base).sort();
  let failed = false;

  for (const loc of locales) {
    const file = path.join(dir, loc, 'messages.json');
    const msgs = JSON.parse(fs.readFileSync(file, 'utf8'));
    const keys = Object.keys(msgs).sort();
    const missing = baseKeys.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !baseKeys.includes(k));
    if (missing.length || extra.length) {
      failed = true;
      console.error(`_locales/${loc}: missing [${missing}] extra [${extra}]`);
    }
    // $1-style placeholders must line up with declared placeholders
    for (const [key, msg] of Object.entries(msgs)) {
      const used = new Set((msg.message.match(/\$\d/g) || []).map((s) => s.slice(1)));
      const declared = new Set(Object.keys(msg.placeholders || {}));
      for (const u of used) {
        if (!declared.has(u)) {
          failed = true;
          console.error(`_locales/${loc}/${key}: uses $${u} with no placeholder declaration`);
        }
      }
    }
  }

  // __MSG_ references in the shipped files
  const scan = ['manifest.chromium.json', 'manifest.firefox.json', 'popup.html'];
  for (const file of scan) {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8');
    for (const ref of text.match(/__MSG_([A-Za-z0-9_]+)__/g) || []) {
      const key = ref.slice(6, -2);
      if (!baseKeys.includes(key)) {
        failed = true;
        console.error(`${file}: unknown message key ${key}`);
      }
    }
  }
  // data-i18n / data-i18n-title keys in the popup
  const html = fs.readFileSync(path.join(SRC, 'popup.html'), 'utf8');
  const used = [...html.matchAll(/data-i18n(?:-title)?="([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
  for (const key of used) {
    if (!baseKeys.includes(key)) {
      failed = true;
      console.error(`popup.html: data-i18n key "${key}" has no message`);
    }
  }
  // t('key', ...) lookups inside popup.js
  const popupJs = fs.readFileSync(path.join(SRC, 'popup.js'), 'utf8');
  for (const m of popupJs.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) {
    if (!baseKeys.includes(m[1])) {
      failed = true;
      console.error(`popup.js: t('${m[1]}') has no message`);
    }
  }

  if (failed) process.exit(1);
  console.log(`locales ok (${locales.join(', ')}, ${baseKeys.length} keys)`);
}

assertLaddersMatch();
assertLocales();

const targets = [
  ['Chromium', 'manifest.chromium.json'],
  ['Firefox', 'manifest.firefox.json'],
];

for (const [dir, manifest] of targets) {
  const out = build(dir, manifest);
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(path.relative(out, p));
    }
  })(out);
  console.log(`built ${dir}: ${files.length} files -> ${out}`);
}
