/**
 * ipad-share-sheet-2026-11-25.test.js — an iPad gets the share sheet like a phone.
 *
 * iPadOS Safari reports itself as a Mac ("Macintosh; Intel Mac OS X"), so the
 * estimate-share gates that test the user agent for /Mobi|Android/ (customer
 * page) and /Mobi|Android|iPhone|iPad/ (job templates) sent an iPad to the
 * "copy the link" path instead of the share sheet, and the homeowner portal
 * told an iPad to "open your browser menu" instead of tapping Share. A Mac
 * with touch points is an iPad.
 *
 * This suite pulls each gate's real condition out of the source and runs it
 * against five devices.
 *
 * Run: node tests/ipad-share-sheet-2026-11-25.test.js
 */
'use strict';
const vm = require('vm');
const K = require('./lib/src-kit');
const t = K.suite();

const UA = {
  ipad: ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15', 5],
  iphone: ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1', 5],
  android: ['Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36', 5],
  macDesktop: ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15', 0],
  windows: ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', 0],
};
// Evaluate a condition expression with a stubbed navigator (share always available).
function run(expr, [ua, touch], extra) {
  return !!vm.runInNewContext('(' + expr + ')', Object.assign({ navigator: { userAgent: ua, maxTouchPoints: touch, share() {} }, ua }, extra || {}));
}
// The `if (…)` condition that starts with the given text, balanced over parentheses.
function condition(src, startsWith) {
  const i = src.indexOf('if (' + startsWith);
  if (i < 0) return null;
  let j = i + 3, depth = 0;
  for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; }
  return src.slice(i + 4, j);
}

for (const [file, start, label] of [
  ['docs/pro/js/customer-bootstrap.module.js', 'navigator.share && ', 'customer page estimate share'],
  ['docs/pro/js/job-templates-ui.js', 'navigator.share && ', 'job-template estimate share'],
]) {
  t.section(label + ' (' + file.split('/').pop() + ')');
  const expr = condition(K.read(file), start);
  t.ok('control: the gate was found', !!expr);
  if (!expr) continue;
  t.ok('iPad (reports a Mac, has touch) gets the share sheet', run(expr, UA.ipad));
  t.ok('iPhone and Android get the share sheet', run(expr, UA.iphone) && run(expr, UA.android));
  t.ok('a Mac or Windows desktop does not (they copy the link)', !run(expr, UA.macDesktop) && !run(expr, UA.windows));
}

t.section('homeowner portal "Add to Home Screen" hint (portal.js)');
{
  const expr = condition(K.read('docs/pro/js/portal.js'), '/iPhone|iPad|iPod/.test(ua)');
  t.ok('control: the iOS branch was found', !!expr);
  if (expr) t.ok('an iPad is told to tap Share, like an iPhone', run(expr, UA.ipad) && run(expr, UA.iphone) && !run(expr, UA.android));
}

t.done();
