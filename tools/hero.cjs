/*
 * Builds preview/hero.html — the popup rendered at 2x inside a framed stage —
 * so the browser tool can capture a crisp, uniformly-margined screenshot for
 * the README. Uniform margins matter: tools/crop.cjs auto-trims by detecting
 * a solid border, so the frame must not touch the page corner.
 *
 *   node tools/preview.cjs && node tools/hero.cjs [scenario]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'preview');
const SCENARIO = process.argv[2] || 'normal';

const W = 316; // popup CSS width
const H = 551; // popup CSS height
const SCALE = 2;
const PAD = 26; // space inside the stage, around the popup
const MARGIN = 24; // uniform page margin, gives auto-trim a solid border

const stageW = W * SCALE + PAD * 2;
const stageH = H * SCALE + PAD * 2;

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: ${MARGIN}px; background: #0b0c0f; }
  .stage {
    width: ${stageW}px; height: ${stageH}px;
    display: grid; place-items: center;
    background: radial-gradient(120% 90% at 50% 0%, #262a33 0%, #1a1d23 55%, #121419 100%);
    border-radius: 18px;
  }
  iframe {
    width: ${W}px; height: ${H}px;
    border: 0;
    transform: scale(${SCALE});
    border-radius: 10px;
    box-shadow: 0 16px 44px rgba(0, 0, 0, .6), 0 0 0 1px rgba(255, 255, 255, .08);
  }
</style>
</head>
<body>
  <div class="stage"><iframe src="popup-preview.html?scenario=${SCENARIO}"></iframe></div>
</body>
</html>
`;

fs.writeFileSync(path.join(OUT, 'hero.html'), html);
console.log(`hero.html (${SCENARIO}) -> stage ${stageW}x${stageH}, page ${stageW + MARGIN * 2}x${stageH + MARGIN * 2}`);
