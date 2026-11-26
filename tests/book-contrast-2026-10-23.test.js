/**
 * tests/book-contrast-2026-10-23.test.js - the Cal.com visit links clear WCAG AA (4.5:1).
 *
 * Overnight audit 2026-10-23: on the old /book hub the adjuster card's CTA was
 * #DD875F (the on-dark orange) on white (~2.7:1) and the brand-orange chips
 * were ~4.05:1 on their tint.
 *
 * 2026-11-25: /book was folded into /inspect (docs/book/index.html deleted,
 * /book 301s to /inspect#other-visits). The same guard now covers the visit
 * list there: every text colour the list uses is read from the page's CSS and
 * computed against the background it actually sits on. Also checks the /book
 * redirect and that booking_click still fires for the new links.
 *
 * Run: node tests/book-contrast-2026-10-23.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'docs/inspect.html'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}
const hex = (h) => {
  let m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(h || '').trim()); if (!m) return null;
  const s = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const n = parseInt(s, 16); return [n >> 16 & 255, n >> 8 & 255, n & 255];
};
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const WHITE = [255, 255, 255];

// Resolve a colour declared in a CSS rule, following var(--x) to :root.
const vars = {};
for (const m of html.matchAll(/--([a-z-]+):(#[0-9a-f]{6})/gi)) if (!vars[m[1]]) vars[m[1]] = m[2];
function ruleProp(selector, prop) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp('(?:^|[}\\n])' + esc + '\\{([^}]*)\\}').exec(html);
  if (!rule) return null;
  const decl = new RegExp('(?:^|;)' + prop + ':([^;]+)').exec(rule[1]);
  if (!decl) return null;
  const v = decl[1].trim();
  const ref = /^var\(--([a-z-]+)/i.exec(v);
  return ref ? vars[ref[1]] : v;
}

console.log('/inspect #other-visits contrast');
const card = ruleProp('.ins-visit', 'background');
const section = ruleProp('.ins-visits', 'background');
const pairs = [
  ['visit title (navy) on the white card', ruleProp('.ins-visit', 'color'), card],
  ['meta line on the white card', ruleProp('.ins-visit .ins-visit-meta', 'color'), card],
  ['description on the white card', ruleProp('.ins-visit .ins-visit-desc', 'color'), card],
  ['CTA on the white card', ruleProp('.ins-visit .ins-visit-cta', 'color'), card],
  ['emergency note link on the section tint', ruleProp('.ins-visits-note a', 'color'), section],
];
ok('control: every colour resolved to a hex value', pairs.every(([, fg, bg]) => hex(fg) && hex(bg)), JSON.stringify(pairs));
for (const [label, fg, bg] of pairs) {
  const r = hex(fg) && hex(bg) ? ratio(hex(fg), hex(bg)) : 0;
  ok(label + ': ' + fg + ' on ' + bg + ' = ' + r.toFixed(2) + ':1 >= 4.5', r >= 4.5);
}
ok('control: the old adjuster pair #dd875f on white is < 3 (the maths can fail)', ratio(hex('#dd875f'), WHITE) < 3);
ok('the on-dark orange #dd875f is not used for any visit-list text', ![ruleProp('.ins-visit .ins-visit-meta', 'color'), ruleProp('.ins-visit .ins-visit-cta', 'color')].some((c) => /dd875f/i.test(String(c))));

console.log('\nThe five visit types, the redirect and the click event');
const links = [...html.matchAll(/<a class="ins-visit" href="([^"]+)"/g)].map((m) => m[1]);
const slugs = links.map((h) => (/cal\.com\/nobigdeal\/([a-z-]+)/.exec(h) || [])[1]);
ok('five visit links, each a nobigdeal cal.com event',
  links.length === 5 && slugs.every(Boolean) &&
  ['roof-question-call', 'adjuster-meeting', 'estimate-walkthrough', 'gutter-siding-estimate', 'interior-repair-estimate'].every((s) => slugs.includes(s)), slugs.join(','));
const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
const redirects = [].concat(fb.hosting || []).flatMap((h) => h.redirects || []);
const to = (src) => (redirects.find((r) => r.source === src) || {});
ok('/book and /book/** 301 to /inspect#other-visits',
  to('/book').destination === '/inspect#other-visits' && to('/book').type === 301 &&
  to('/book/**').destination === '/inspect#other-visits' && to('/book/**').type === 301);
ok('the #other-visits anchor exists on /inspect', html.includes('id="other-visits"'));
ok('the old /book page file is gone', !fs.existsSync(path.join(ROOT, 'docs/book/index.html')));

// booking-clicks.js, executed: a click inside an .ins-visit link fires booking_click with the slug.
{
  const vm = require('vm');
  const events = []; let handler = null;
  const link = { getAttribute: () => 'https://cal.com/nobigdeal/adjuster-meeting', querySelector: () => ({ textContent: ' Insurance adjuster meeting ' }) };
  const target = { closest: (sel) => (/a\.ins-visit/.test(sel) ? link : null) };
  const window = { gtag: (t, n, p) => events.push({ n, p }) };
  window.window = window;
  window.document = { addEventListener: (type, fn) => { if (type === 'click') handler = fn; } };
  vm.createContext(window);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs/assets/js/booking-clicks.js'), 'utf8'), window);
  if (handler) handler({ target });
  const e = events[0];
  ok('booking_click fires for an /inspect visit link with its slug and name',
    !!e && e.n === 'booking_click' && e.p.booking_slug === 'adjuster-meeting' && e.p.booking_name === 'Insurance adjuster meeting', JSON.stringify(events));
}
ok('/inspect loads booking-clicks.js', /<script src="\/assets\/js\/booking-clicks\.js" defer><\/script>/.test(html));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
