/**
 * tests/functions-zod-audit-pin-2026-10-23.test.js — functions/ must not ship
 * the HIGH zod advisory (GHSA-mrhx-c7xc-m3w5, zod < 4.6.6) that the
 * "Dependency audit (high and above)" CI job started failing on 2026-10-23.
 *
 * zod arrives only through puppeteer-core 25.11.0 -> chromium-bidi 17.0.2
 * (zod ^3). puppeteer-core 25.13+ moved to chromium-bidi 157.x (zod ^4.6.5),
 * but bumping puppeteer-core also moves the CDP client that renders every
 * server PDF (render-pdf.js; the sparticuz 148->149 break once failed every
 * render silently for eleven weeks), so the pin is an `overrides` entry on
 * chromium-bidi alone — the same shape as the brace-expansion/minimatch pins.
 * chromium-bidi is only exercised on puppeteer's WebDriver-BiDi path; render-pdf.js
 * launches Chrome over the default CDP, so it must never opt into BiDi
 * without re-checking this pin.
 *
 * Zero deps.  Run: node tests/functions-zod-audit-pin-2026-10-23.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'functions/package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'functions/package-lock.json'), 'utf8'));
const render = fs.readFileSync(path.join(ROOT, 'functions/render-pdf.js'), 'utf8')
  .split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const ver = (s) => String(s).split('.').map((n) => parseInt(n, 10) || 0);
const gte = (a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; } return true; };

const zod = lock.packages['node_modules/zod'];
const bidi = lock.packages['node_modules/chromium-bidi'];

ok('lockfile resolves zod at or above the patched 4.6.6', zod && gte(zod.version, '4.6.6'), zod && zod.version);
ok('chromium-bidi resolves to a build that depends on zod 4', bidi && /\^4\./.test((bidi.dependencies || {}).zod || ''), JSON.stringify(bidi && bidi.dependencies));
ok('package.json overrides pin chromium-bidi to the resolved version', pkg.overrides && pkg.overrides['chromium-bidi'] === (bidi && bidi.version), JSON.stringify(pkg.overrides));
ok('puppeteer-core stays on its tested pin (no silent CDP-client bump)', pkg.dependencies['puppeteer-core'] === '25.11.0', pkg.dependencies['puppeteer-core']);
ok('render-pdf.js launches over the default CDP (never opts into webDriverBiDi)', /puppeteer\.launch\(/.test(render) && !/webDriverBiDi/.test(render));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
