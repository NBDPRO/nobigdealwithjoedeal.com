/**
 * ios-text-size-adjust-2026-11-25.test.js — iOS does not enlarge CRM text in landscape.
 *
 * iOS Safari scales text up when the phone turns sideways unless the page sets
 * -webkit-text-size-adjust. The dashboard (dashboard-app.css, max-width:768px)
 * and the customer page (customer.html, max-width:640px) set it only inside
 * phone-width media queries; a large iPhone in landscape (844-932px wide) falls
 * outside both. ui-primitives.css, which both pages load, now sets it at every
 * width.
 *
 * Run: node tests/ios-text-size-adjust-2026-11-25.test.js
 */
'use strict';
const K = require('./lib/src-kit');
const t = K.suite();

const prim = K.cssRules(K.read('docs/pro/css/ui-primitives.css'));
const html = K.cssRule(prim, 'html');
t.ok('ui-primitives.css sets -webkit-text-size-adjust: 100% on html, outside any media query', !!html && html['-webkit-text-size-adjust'] === '100%', JSON.stringify(html));

for (const page of ['docs/pro/dashboard.html', 'docs/pro/customer.html']) {
  const links = K.parseTags(K.read(page)).$$('link[rel="stylesheet"]').map((l) => String(l.attrs.href || ''));
  t.ok(page + ' loads ui-primitives.css (so the rule reaches it)', links.some((h) => /(^|\/)css\/ui-primitives\.css(\?|$)/.test(h)), links.filter((h) => /primitives/.test(h)).join(', '));
}

const control = K.cssRule(K.cssRules('@media (max-width:768px){ html { -webkit-text-size-adjust:100%; } }'), 'html');
t.ok('control: a rule inside a media query is not counted as every width', control === null);

t.done();
