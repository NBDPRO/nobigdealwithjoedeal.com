/**
 * ios-add-lead-selects-2026-11-25.test.js — the Add Lead dropdowns look the same on an iPhone.
 *
 * `.mfield select` gave the dropdowns a dark background but left the native
 * skin on. Chrome honours the background; Safari's engine draws its own
 * native control (light grey, faint text). With the native skin off and the
 * arrow drawn as a background image, both engines draw the same field.
 *
 * Run: node tests/ios-add-lead-selects-2026-11-25.test.js
 */
'use strict';
const K = require('./lib/src-kit');
const t = K.suite();
const rules = K.cssRules(K.read('docs/pro/css/dashboard-app.css'));

t.section('.mfield select (Add Lead and the other form modals)');
const base = K.cssRule(rules, '.mfield select:not([multiple])');
t.ok('control: the rule is found', !!base);
t.ok('the native skin is off for Safari and everyone else', !!base && base['-webkit-appearance'] === 'none' && base['appearance'] === 'none');
t.ok('the arrow is drawn (a data: SVG, allowed by img-src), placed right, never tiled', !!base && /^url\("data:image\/svg\+xml,/.test(base['background-image']) && base['background-repeat'] === 'no-repeat' && /right/.test(base['background-position']));
t.ok('the text never runs under the arrow', !!base && base['padding-right'] === '34px');
const phone = K.cssRule(rules, '.mfield select:not([multiple])', { media: '(max-width:768px)' });
t.ok('…including on phones, where the field padding is !important', !!phone && /^34px\s*!important$/.test(phone['padding-right']));
const shared = K.cssRule(rules, '.mfield select');
t.ok('control: the shared field rule still sets the dark background the arrow sits on', !!shared && /var\(--s2\)/.test(shared.background));
t.ok('the arrow rule comes after the shared rule (its background shorthand would erase the image)', !!base && rules.findIndex((r) => r.selectors.includes('.mfield select:not([multiple])')) > rules.findIndex((r) => r.selectors.includes('.mfield select')));

t.done();
