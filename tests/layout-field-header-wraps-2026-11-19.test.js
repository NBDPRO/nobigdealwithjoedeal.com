#!/usr/bin/env node
/**
 * tests/layout-field-header-wraps-2026-11-19.test.js — the Field App header
 * (date + "+ Lead" / "Search" / "Sun") must wrap, not run past the right edge.
 *
 * Phone sweep 2026-11-19 (documentation/qa/phone-layout-sweep-2026-11-19):
 * at 393 px the three buttons plus the date did not fit on one non-wrapping
 * flex row, so the last chip was clipped.
 *
 * Run: node tests/layout-field-header-wraps-2026-11-19.test.js
 */
const K = require('./lib/src-kit');

const css = K.read('docs/pro/css/layouts/field.css');
const top = K.cssRule(css, 'html[data-layout="field"] .fa-top') || {};
const end = K.cssRule(css, 'html[data-layout="field"] .fa-top-end') || {};

let failed = 0;
function check(name, ok) { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok) failed++; }

check('.fa-top is a flex row that wraps', top.display === 'flex' && top['flex-wrap'] === 'wrap');
check('.fa-top-end (the three buttons) wraps and hugs the right edge', end['flex-wrap'] === 'wrap' && end['margin-left'] === 'auto');

if (failed) { console.log('\n' + failed + ' failed'); process.exit(1); }
console.log('\nall passed');
