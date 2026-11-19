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
const K = require('./lib/src-kit');

const css = K.read('docs/pro/css/layout-offer.css');
const rule = K.cssRule(css, '.lo-banner', { media: '*' }) || {};
const withTransform = K.cssRules(css).filter((r) => r.selectors.some((s) => /\.lo-banner/.test(s)) && ('transform' in r.decls || 'translate' in r.decls));
const bump = K.read('docs/pro/js/script-loader.js').match(/css\/layout-offer\.css\?v=(\d+)/);

let failed = 0;
function check(name, ok) { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok) failed++; }

check('.lo-banner rule found, fixed to the viewport', rule.position === 'fixed');
check('no rule on .lo-banner uses transform or translate (the global :hover reset removes it)', withTransform.length === 0);
check('it centers with left 0, right 0 and an auto margin', rule.left === '0' && rule.right === '0' && rule.margin === '0 auto');
check('the stylesheet cache-bust was bumped past v=1', !!bump && Number(bump[1]) >= 2);

if (failed) { console.log('\n' + failed + ' failed'); process.exit(1); }
console.log('\nall passed');
