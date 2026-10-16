/*
 * Pack the built extensions into distributable files.
 *
 *   node tools/pack.js
 *
 * Produces in dist/:
 *   ...-firefox-<version>.xpi          plain zip, unsigned (temporary install)
 *   ...-firefox-<version>.zip          same bytes, .zip extension
 *   ...-chromium-<version>.zip         plain zip (for --load-extension)
 *   ...-chromium-<id>-<version>.crx    signed CRX3
 *
 * The Chromium signing key never lives in the repository. It is read from
 * $FYR_CRX_KEY, or generated on first run at
 *   <OS config dir>/force-youtube-resolution/crx-key.pem
 * (e.g. %APPDATA%\force-youtube-resolution on Windows). Keep it: the extension
 * id is derived from it, so reusing it keeps the id stable across rebuilds.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { createZip } = require('./zip.cjs');
const { packCrx3, generateKeyPair, verifyCrx3 } = require('./crx.cjs');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const NAME = 'force-youtube-resolution';

/**
 * Where the signing key lives. Never inside the repository: anyone holding it
 * can publish updates under this extension's id. Override with FYR_CRX_KEY.
 */
function keyPaths() {
  const fromEnv = process.env.FYR_CRX_KEY;
  const keyFile = fromEnv
    ? path.resolve(fromEnv)
    : path.join(
        process.platform === 'win32'
          ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
          : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
        NAME,
        'crx-key.pem'
      );
  return { keyFile, pubFile: keyFile.replace(/\.pem$/i, '') + '.pub.der' };
}

/** Collect a build folder into deterministic, manifest-first entries. */
function collect(dir) {
  const files = [];
  (function walk(rel) {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relPath = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(relPath);
      else files.push(relPath);
    }
  })('');

  const priority = (p) => {
    if (p === 'manifest.json') return 0;
    if (p === 'META-INF/manifest.mf') return 1;
    if (p === 'META-INF/mozilla.rsa') return 2;
    if (p === 'META-INF/mozilla.sf') return 3;
    return 4;
  };

  files.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));

  return files.map((rel) => ({
    name: rel.split(path.sep).join('/'),
    data: fs.readFileSync(path.join(dir, rel)),
  }));
}

function readVersion(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version;
}

/** Move a pre-existing key out of the tree so existing installs keep their id. */
function migrateLegacyKey(keyFile) {
  const legacy = path.join(__dirname, 'crx-key.pem');
  const legacyPub = path.join(__dirname, 'crx-key.pub.der');
  if (fs.existsSync(keyFile) || !fs.existsSync(legacy)) return false;
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  // copy + unlink rather than rename: the config dir may be on another volume.
  fs.copyFileSync(legacy, keyFile);
  try {
    fs.chmodSync(keyFile, 0o600);
  } catch (_) {}
  fs.unlinkSync(legacy);
  try {
    fs.rmSync(legacyPub, { force: true });
  } catch (_) {}
  return true;
}

function loadOrCreateKey() {
  const { keyFile, pubFile } = keyPaths();
  const migrated = migrateLegacyKey(keyFile);
  if (fs.existsSync(keyFile)) {
    const privateKeyPem = fs.readFileSync(keyFile, 'utf8');
    const publicKeyDer = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' });
    return { privateKeyPem, publicKeyDer, fresh: false, migrated, keyFile };
  }
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  const { publicKey, privateKey } = generateKeyPair();
  fs.writeFileSync(keyFile, privateKey, { mode: 0o600 });
  fs.writeFileSync(pubFile, publicKey);
  return { privateKeyPem: privateKey, publicKeyDer: publicKey, fresh: true, migrated: false, keyFile };
}

function human(bytes) {
  return bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(1) + ' KB';
}

/**
 * The complete corresponding source, as GPL-3.0 section 6 requires.
 * Also what AMO asks for if it decides the build needs reviewing.
 * Never includes the signing key.
 */
function buildSourceArchive(version) {
  const entries = [];

  const addFile = (rel) => {
    entries.push({ name: rel, data: fs.readFileSync(path.join(ROOT, rel)) });
  };
  const addTree = (dir, prefix) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) addTree(`${dir}/${entry.name}`, `${prefix}${entry.name}/`);
      else addFile(rel);
    }
  };

  addTree('src', '');
  addTree('tools', '');
  for (const f of ['build.js', 'README.md', 'LICENSE']) {
    if (fs.existsSync(path.join(ROOT, f))) addFile(f);
  }

  // Explicitly exclude anything secret even if it ever gets added to tools/.
  const safe = entries.filter((e) => !/crx-key|\.pem$|\.der$/i.test(e.name));
  const dropped = entries.length - safe.length;

  const out = path.join(DIST, `${NAME}-${version}-source.zip`);
  const buf = createZip(safe);
  fs.writeFileSync(out, buf);
  return { out, count: safe.length, dropped, bytes: buf.length };
}

function main() {
  const chromiumDir = path.join(ROOT, 'Chromium');
  const firefoxDir = path.join(ROOT, 'Firefox');

  for (const dir of [chromiumDir, firefoxDir]) {
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
      console.error('missing ' + path.join(dir, 'manifest.json') + ' — run `node build.js` first');
      process.exit(1);
    }
  }

  fs.mkdirSync(DIST, { recursive: true });

  const ffVersion = readVersion(firefoxDir);
  const crVersion = readVersion(chromiumDir);

  /* ---------------- Firefox ---------------- */

  const ffEntries = collect(firefoxDir);
  const xpi = createZip(ffEntries);
  const xpiPath = path.join(DIST, `${NAME}-firefox-${ffVersion}.xpi`);
  fs.writeFileSync(xpiPath, xpi);
  fs.writeFileSync(path.join(DIST, `${NAME}-firefox-${ffVersion}.zip`), xpi);
  console.log(`xpi   ${ffEntries.length} files  ${human(xpi.length)}  ${path.basename(xpiPath)}`);
  console.log(`      (unsigned — Firefox only installs unsigned XPIs temporarily,`);
  console.log(`       or permanently on Nightly/Developer/ESR with`);
  console.log(`       xpinstall.signatures.required=false)`);

  /* ---------------- Chromium ---------------- */

  const crEntries = collect(chromiumDir);
  const zip = createZip(crEntries);
  const zipPath = path.join(DIST, `${NAME}-chromium-${crVersion}.zip`);
  fs.writeFileSync(zipPath, zip);
  console.log(`\nzip   ${crEntries.length} files  ${human(zip.length)}  ${path.basename(zipPath)}`);

  const key = loadOrCreateKey();
  if (key.migrated) console.log(`\nmoved the signing key out of the repository -> ${key.keyFile}`);
  if (key.fresh) {
    console.log(`\ngenerated a new signing key -> ${key.keyFile}`);
    console.log('      (keep it: the extension id derives from it, and it is never written into the repo)');
  }
  console.log(`\nkey   ${key.keyFile}${process.env.FYR_CRX_KEY ? '  (from FYR_CRX_KEY)' : ''}`);

  const { crx, id } = packCrx3(zip, key);
  const crxPath = path.join(DIST, `${NAME}-chromium-${id}-${crVersion}.crx`);
  fs.writeFileSync(crxPath, crx);
  console.log(`crx   ${human(crx.length)}  ${path.basename(crxPath)}`);
  console.log(`      extension id: ${id}`);

  // self-check: parse it back and verify the signature
  const check = verifyCrx3(fs.readFileSync(crxPath));
  const ok = check.valid && check.idMatchesHash && check.id === id;
  console.log(`\nverify  signature=${check.valid ? 'valid' : 'INVALID'}  crxId=${check.idMatchesHash ? 'ok' : 'MISMATCH'}  id=${check.id === id ? 'ok' : 'MISMATCH'}`);
  if (!ok) {
    console.error('\nCRX self-check FAILED');
    process.exit(1);
  }
  console.log('CRX self-check passed.');

  /* ---------------- source ---------------- */

  const src = buildSourceArchive(ffVersion);
  console.log(`\nsource ${src.count} files  ${human(src.bytes)}  ${path.basename(src.out)}`);
  if (src.dropped) console.log(`       (${src.dropped} file(s) withheld — signing keys are never published)`);
  console.log('       complete corresponding source, as GPL-3.0 section 6 requires');

  console.log(`\ndist/`);
  for (const f of fs.readdirSync(DIST).sort()) {
    console.log('  ' + f.padEnd(52) + human(fs.statSync(path.join(DIST, f)).size));
  }
}

main();
