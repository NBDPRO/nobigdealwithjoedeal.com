#!/usr/bin/env node
/**
 * tests/layout-offer-banner-no-transform-2026-11-19.test.js — the "Switch to
 * Field App?" banner must not center itself with a transform.
 *
 * dashboard-app.css strips `transform` from every :hover element that has no
 * inline transform (touch taps leave :hover stuck). The banner is an ANCESTOR
 * of the buttons, so tapping Switch / Not now put it in :hover, removed its
 * stylesheet `translateX(-50%)`, and it jumped half its width to the right;
 * the tap landed on empty space and a second tap was needed (owner report,
 * 2026-11-19, after #3121 fixed the timer-rebuild cause only).
 *
 * Run: node tests/layout-offer-banner-no-transform-2026-11-19.test.js
 */
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/css/layout-offer.css'), 'utf8');
const loader = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/script-loader.js'), 'utf8');

let failed = 0;
function check(name, ok) { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok) failed++; }

const rule = (css.match(/\.lo-banner\s*\{[^}]*\}/) || [''])[0];
check('.lo-banner rule found', rule.length > 0);
check('.lo-banner does not use transform (global :hover reset removes it)', !/transform/i.test(rule));
check('.lo-banner does not use translate', !/translate/i.test(rule));
check('.lo-banner centers with left/right 0 + auto margin', /left:0/.test(rule) && /right:0/.test(rule) && /margin:0 auto/.test(rule));
check('no media/override rule re-adds a transform to the banner', !/\.lo-banner[^{]*\{[^}]*transform/i.test(css));
check('the stylesheet cache-bust was bumped past v=1', /css\/layout-offer\.css\?v=([2-9]|\d{2,})'/.test(loader));

if (failed) { console.log('\n' + failed + ' failed'); process.exit(1); }
console.log('\nall passed');
