<div align="center">
  <img src="docs/logo.png" width="104" height="104" alt="Force YouTube Resolution logo">
  <h1>Force YouTube Resolution</h1>
  <p>Keep YouTube at the resolution you choose — even when YouTube changes it.</p>
</div>

<div align="center">

[![Firefox Add-on](https://img.shields.io/amo/v/force-youtube-resolution?label=Firefox%20Add-on&logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/en-US/firefox/addon/force-youtube-resolution/)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-EA4335?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Firefox MV3](https://img.shields.io/badge/Firefox-Manifest%20V3-FF7139?logo=firefox-browser&logoColor=white)](https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/manifest_version)
[![License: GPL v3](https://img.shields.io/badge/License-GPL%20v3-blue.svg)](LICENSE)
[![No dependencies](https://img.shields.io/badge/runtime%20dependencies-none-success)](https://github.com/Rob1ts/Force-YouTube-Resolution-Extension)

</div>

---

<div align="center">
  <img src="docs/screenshot-popup.png" width="380" alt="The Force YouTube Resolution popup showing an active 1080p cap">
</div>

## Why this exists

YouTube's adaptive bitrate chooses a resolution from your connection, screen,
codec support and current network conditions. The same video can start at 720p
one time and 2160p the next. Choosing a quality from YouTube's gear menu is not
reliable either: a new video, a buffer underrun, an ad or the adaptive bitrate
itself can change it back.

**Force YouTube Resolution keeps re-applying your chosen maximum resolution.**

## What it does

- **Sets a maximum, not a random target.** Choose *Highest available*, or cap
  playback at 144p, 240p, 360p, 480p, 720p, 1080p, 1440p, 2160p, 2880p or
  4320p.
- **Never exceeds your cap.** Ask for 1080p and YouTube will use 1080p when it
  is offered. If it is not, the extension picks the best lower quality instead
  of silently going higher.
- **Re-applies the target when it drifts.** The extension watches the player and
  restores the selected quality after manual changes, source changes, SPA
  navigation and YouTube's own adaptive switches.
- **Does not fight ads.** Enforcement pauses while an ad is playing and resumes
  with your chosen quality when the video returns.
- **Shows what is actually happening.** The popup reports the active resolution,
  available qualities, fallback decisions and whether the player is ready.
- **Works across YouTube.** Watch pages, Shorts, live streams and
  `youtube.com/embed` pages are supported without a page reload.

The popup has a single on/off switch and one resolution selector. Settings are
saved automatically.

### Status meanings

| Status | Meaning |
| --- | --- |
| **Active** | Your target quality is playing. |
| **Active — fallback** | Your exact cap is unavailable; the best lower quality is playing. |
| **Waiting for player** | The YouTube player is still loading or the video has not started. |
| **Ad playing** | Enforcement is paused until the ad finishes. |
| **No video detected** | The current tab is not a supported YouTube video page. |
| **Extension paused** | The toggle is off and YouTube controls quality normally. |
| **Reload this page** | The extension was installed or updated after this tab loaded. |

## Install

### Firefox

**Install the signed build from Mozilla Add-ons:**

[**Force YouTube Resolution on addons.mozilla.org**](https://addons.mozilla.org/en-US/firefox/addon/force-youtube-resolution/)

1. Open the AMO listing.
2. Click **Add to Firefox** and confirm the install.
3. Open a YouTube video and use the toolbar popup.

Mozilla signs and distributes the AMO build, so it installs permanently and
updates automatically. Requires Firefox **128 or newer**.

#### Temporary testing builds

The XPI attached to GitHub releases is **unsigned**. To test a build without
signing it:

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select `force-youtube-resolution-firefox-2.0.0.xpi`.
4. Open a YouTube video. Firefox removes temporary add-ons when it restarts.

Use the [AMO listing](https://addons.mozilla.org/en-US/firefox/addon/force-youtube-resolution/)
for permanent installation.

### Chromium / Chrome / Edge / Brave / Opera / Vivaldi

Download the latest Chromium package from the
[**Releases page**](https://github.com/Rob1ts/Force-YouTube-Resolution-Extension/releases/latest).
The unpacked ZIP is the most reliable installation method:

1. Download and unzip `force-youtube-resolution-chromium-2.0.0.zip`.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the unzipped folder.
5. Open a YouTube video and use the toolbar popup.

You can also drag the `.crx` onto the extensions page. Branded Chrome may reject
CRX files distributed outside the Chrome Web Store with
`CRX_REQUIRED_PROOF_MISSING`; that is a browser policy, not a package error. Use
the unpacked ZIP or publish the extension through the Chrome Web Store for a
store installation.

Requires Chromium **111 or newer** because the player bridge uses
`world: "MAIN"` content scripts.

### Release downloads

| Download | Use |
| --- | --- |
| `force-youtube-resolution-firefox-2.0.0.xpi` | Firefox 128+ (unsigned; use AMO instead) |
| `force-youtube-resolution-chromium-2.0.0.crx` | Chromium 111+ |
| `force-youtube-resolution-chromium-2.0.0.zip` | Chromium unpacked build |
| `force-youtube-resolution-2.0.0-source.zip` | Complete corresponding source |

### Upgrading from v1.x

Version 2 keeps the Firefox add-on ID (`force-youtube-resolution@local`), so the
AMO build updates the existing Firefox add-on in place and preserves its
settings. Firefox normally applies this update automatically.

The Chromium extension ID has changed from
`imgigdnmkglkofpdomceeenaalemkjdk` to
`donpidbdhgonhfbjfjpochojflkbjflf`. Remove the old Chromium extension before
loading v2; Chromium settings start fresh because storage is scoped to the
extension ID.

## Use

1. Open a YouTube watch, Shorts, live or embed page.
2. Click the extension icon.
3. Choose a maximum resolution. **Highest available** uses the best quality the
   video offers.
4. Switch **Force quality** off whenever you want YouTube to control playback
   again.

The setting applies as soon as the popup reports that the extension is active.
Reload a YouTube tab after installing or updating the extension if it shows
**Reload this page**.

## Privacy and permissions

- **`storage`** stores two local values: `enabled` and `maxQuality`.
- **`*://*.youtube.com/*`** is the only host permission. The extension does
  nothing on other sites.
- No analytics, telemetry, tracking, accounts, network requests or remote code.
- No `eval`, `new Function`, inline scripts, `innerHTML` or `document.write` in
  runtime code.
- Messages from the page are untrusted. Quality identifiers, video IDs, state
  names and heights are validated against fixed allowlists, and the popup renders
  values with `textContent`.
- The Chromium signing key is not part of this repository. Only its public key is
  embedded in the packaged manifest.

The extension calls YouTube's player API directly. It does not bypass DRM,
regional restrictions, ads, or the availability limits imposed by YouTube.

## How it works

YouTube attaches its player methods to the `#movie_player` element as own
properties. Those properties exist only in the page's JavaScript world, so an
ordinary isolated content script cannot see them. This extension therefore uses
two layers:

- `src/page.js` runs in the **page world** with `world: "MAIN"` and talks to the
  real player through `getAvailableQualityLevels`, `setPlaybackQualityRange` and
  `setPlaybackQuality`.
- `src/content.js` runs in the isolated extension world, owns
  `browser.storage.local`, validates messages and bridges settings and status to
  the page script.

A one-second watchdog checks the actual player quality and reasserts the target
only when it differs. It skips ads, restores the target after ads, and reacts to
player replacement and YouTube SPA navigation.

The selected resolution is always a ceiling. The fallback algorithm sorts the
levels the video actually offers, chooses the highest level at or below the cap,
and reports when the requested level was unavailable.

## Build from source

Requirements:

- Node.js 20 or newer
- npm
- Chromium/Chrome for the Playwright test
- Python 3.10+ and Selenium for the optional Firefox test

```bash
npm install
npm run build
npm test
npm run test:e2e
```

`npm run build` creates unpacked builds in `dist/chromium` and `dist/firefox`,
plus versioned XPI, ZIP, CRX and `SHA256SUMS.txt` files. `npm test` runs the unit,
packaging, signature and security checks. `npm run test:e2e` runs the Chromium
Playwright test against a mock YouTube player.

The Firefox end-to-end test is a separate Selenium script:

```bash
pip install selenium
python test/firefox-e2e.py
```

It serves the mock player through `www.youtube.com` using Firefox's
`network.dns.localDomains` preference, so the production manifest, host checks,
content-script bridge and MAIN-world injection are exercised without contacting
YouTube.

## Troubleshooting

- **Chrome says the CRX is not from the Web Store.** Use the unpacked ZIP or
  publish through the Chrome Web Store.
- **Firefox refuses the XPI permanently.** Use temporary installation through
  `about:debugging`, or sign the XPI on addons.mozilla.org.
- **AMO reports an add-on ID mismatch.** Check that you uploaded the XPI from
  this project, not a build of another extension. The Force YouTube Resolution
  ID is `force-youtube-resolution@local` and must match the AMO listing being
  updated. A listing showing `resize-yt-to-window-size@local` belongs to a
  different add-on.
- **The requested resolution is not used.** The source may not offer it, or DRM,
  device limits or the network may restrict it. The popup's **fallback** status
  and **Available** row show what the player actually offers.
- **The popup says Reload this page.** Reload the YouTube tab after installing
  or updating the extension.
- **The switch is off.** Turn on **Force quality** in the popup.

## License

Copyright (C) 2026 Rob1ts.

This project is free software licensed under the
[GNU General Public License v3.0](LICENSE) (`GPL-3.0-only`). You may
redistribute it and/or modify it under the terms of that license. There is no
warranty, to the extent permitted by law.

Not affiliated with, endorsed by, or connected to Google or YouTube. "YouTube"
is a trademark of Google LLC.
