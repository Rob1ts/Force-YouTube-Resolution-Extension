/*
 * Create the GitHub release for the pushed tag and upload the dist assets.
 *
 * Reuses the HTTPS credential git just used (Windows Credential Manager via
 * `git credential fill`). The token is only ever held in memory — it is never
 * printed, logged, or written to disk.
 *
 *   node tools/release.js <repo> <tag>
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = process.argv[2] || 'Rob1ts/Force-YouTube-Resolution-Extension';
const TAG = process.argv[3] || 'v1.1.0';
const DIST = path.join(__dirname, '..', 'dist');
const API = 'https://api.github.com';

function getToken() {
  const input = 'protocol=https\nhost=github.com\n\n';
  const out = execFileSync('git', ['credential', 'fill'], { input, encoding: 'utf8' });
  for (const line of out.split('\n')) {
    if (line.startsWith('password=')) return line.slice(9).trim();
  }
  throw new Error('no credential found in the git credential store');
}

async function api(token, method, url, body, headers = {}) {
  const finalHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'release-tool',
    ...headers,
  };
  // With a FormData body, fetch must set Content-Type itself so it can add the
  // multipart boundary. Overriding it makes GitHub reject the upload.
  if (body instanceof FormData) delete finalHeaders['Content-Type'];
  // Raw binary bodies get an explicit length so the request is not chunked.
  if (Buffer.isBuffer(body)) finalHeaders['Content-Length'] = String(body.length);

  const absolute = !!headers.__absolute;
  delete finalHeaders.__absolute;

  const res = await fetch(absolute ? url : API + url, { method, headers: finalHeaders, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

const BODY = `Pick one resolution and hold it there.

YouTube's adaptive bitrate decides the resolution on its own, and the same video
can play at 720p one time and 2160p the next. Setting it from the gear menu
doesn't stick either — YouTube re-applies its own saved value on every video
load, every buffer underrun, and every time the ABR decides to step up.

This extension sets the level once and keeps re-asserting it.

## Downloads

| File | Browser |
|---|---|
| \`force-youtube-resolution-firefox-1.1.0.xpi\` | Firefox (unsigned) |
| \`force-youtube-resolution-chromium-ID-1.1.0.crx\` | Chrome, Edge, Brave, Opera, Vivaldi, Arc |
| \`force-youtube-resolution-chromium-1.1.0.zip\` | Chromium — unzip, then *Load unpacked* |

The \`.crx\` is self-signed with a private key. **Its extension id changed** — any
build distributed before this release must be removed before installing this one.

## Install

### Chromium

1. Open \`chrome://extensions\`
2. Turn on **Developer mode**
3. Drag the \`.crx\` onto the page — or unzip the \`.zip\` and use **Load unpacked**

### Firefox

The \`.xpi\` is **unsigned**:

- **Every Firefox** — \`about:debugging#/runtime/this-firefox\` → **Load Temporary
  Add-on…** → pick the \`.xpi\`. Removed when Firefox closes.
- **Nightly / Developer / ESR** — for a permanent install set
  \`xpinstall.signatures.required = false\` in \`about:config\`, then drag the
  \`.xpi\` onto \`about:addons\`.
- **Release Firefox** — unsigned installs are blocked; the build needs signing
  via addons.mozilla.org.

Requires Firefox **142+**.

## What it does

- **A fixed ladder, nothing else.** 144p → 4320p plus \`Auto\`. No custom values:
  a resolution outside YouTube's ladder isn't something the player can serve.
- **Shows what the video actually offers** — the popup asks the running player
  which levels it has and marks the rest.
- **Never silently overrides you.** Ask for 4320p on a 1080p video and it uses
  1080p and says so: *"4320p is not offered here · using 1080p"*.
- **The gear menu agrees with it** — the forced value is mirrored into YouTube's
  own quality menu.
- Toolbar badge shows the forced level, or nothing when set to \`Auto\`.
- Works on the watch page, Shorts, embeds and \`youtube-nocookie.com\`.

## How it works

YouTube assigns its player API onto the player element as **own properties**.
Those live in the page's JavaScript heap, which a content script's isolated world
doesn't share — so from an ordinary content script
\`typeof movie_player.setPlaybackQuality\` is \`"undefined"\`. No error, nothing in
the console. That is why most attempts at forcing YouTube quality fail silently.

\`force.js\` therefore runs in the **page** world via \`"world": "MAIN"\` on both
browsers; \`bridge.js\` stays isolated and owns extension storage. Neither build
has \`web_accessible_resources\` — no site can load our code.

Pinning is three calls:

\`\`\`js
p.setPlaybackQuality(wanted);              // choose it
p.setPlaybackQualityRange(wanted, wanted); // pin it — this is what stops
                                            // ABR upgrading later
localStorage['yt-player-quality'] = …;     // so the gear menu agrees
\`\`\`

## Privacy

\`storage\` for your one setting; host access to YouTube to read the quality list
and apply it. No network requests, no analytics, no telemetry, no remote code, no
background worker, no accounts. Setting \`Auto\` removes the entry the extension
wrote.

## Build from source

Node 18+, no npm dependencies.

\`\`\`bash
node build.js               # -> Chromium/ and Firefox/
node tools/test-content.cjs # 56 assertions
node tools/audit-probe.cjs  # end-to-end reload check
node tools/pack.js          # -> dist/
\`\`\`

## License

GPL-3.0-only. Copyleft — redistribute with the complete corresponding source.

Not affiliated with, endorsed by, or connected to Google or YouTube. "YouTube" is
a trademark of Google LLC.
`;

async function main() {
  let token;
  try {
    token = getToken();
  } catch (e) {
    console.error('could not obtain a credential:', e.message);
    process.exit(1);
  }
  console.log('credential obtained (token not displayed)');

  const who = await api(token, 'GET', '/user');
  if (who.status !== 200) {
    console.error('auth check failed:', who.status, who.text.slice(0, 200));
    process.exit(1);
  }
  console.log('authenticated as:', who.json.login);

  const assets = fs
    .readdirSync(DIST)
    .filter((f) => /\.(xpi|crx|zip)$/.test(f) && !/-firefox-.*\.zip$/.test(f))
    .sort();

  const crxName = assets.find((f) => f.endsWith('.crx')) || '';
  const idMatch = crxName.match(/chromium-([a-p]{32})-/);
  const finalBody = idMatch ? BODY.replace('chromium-ID-1.1.0.crx', crxName) : BODY;

  // delete a pre-existing release for this tag so re-runs are idempotent
  const existing = await api(token, 'GET', `/repos/${REPO}/releases/tags/${TAG}`);
  if (existing.status === 200) {
    console.log(`release for ${TAG} already exists (id ${existing.json.id}) — deleting it`);
    await api(token, 'DELETE', `/repos/${REPO}/releases/${existing.json.id}`);
  }

  const created = await api(token, 'POST', `/repos/${REPO}/releases`, JSON.stringify({
    tag_name: TAG,
    target_commitish: 'main',
    name: `${TAG} — Lock YouTube playback to a fixed resolution`,
    body: finalBody,
    draft: false,
    prerelease: false,
  }), { 'Content-Type': 'application/json' });

  if (created.status !== 201) {
    console.error('release creation failed:', created.status, created.text.slice(0, 400));
    process.exit(1);
  }
  console.log(`release created: ${created.json.html_url}`);

  for (const file of assets) {
    const data = fs.readFileSync(path.join(DIST, file));

    // Assets upload to uploads.github.com — the host in the release's
    // upload_url — not api.github.com, which 404s for this endpoint. That host
    // rejects multipart/form-data, so the body goes up as raw bytes with the
    // filename in the query string.
    const uploadBase = String(created.json.upload_url || '').split('{')[0];
    if (!uploadBase) {
      console.log(`  FAILED ${file}: release has no upload_url`);
      continue;
    }

    const up = await api(token, 'POST', uploadBase + '?name=' + encodeURIComponent(file), data, {
      __absolute: true,
      'Content-Type': 'application/octet-stream',
    });
    console.log(up.status === 201 ? `  uploaded ${file} (${data.length} bytes)` : `  FAILED ${file}: ${up.status} ${up.text.slice(0, 200)}`);
  }

  const final = await api(token, 'GET', `/repos/${REPO}/releases/tags/${TAG}`);
  console.log('');
  console.log('release:', final.json.html_url);
  console.log('assets :', final.json.assets.map((a) => `${a.name} (${a.size})`).join(', '));
}

main().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
