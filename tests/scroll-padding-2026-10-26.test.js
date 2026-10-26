/**
 * tests/scroll-padding-2026-10-26.test.js
 *
 * Anchor jumps and keyboard focus must land clear of the fixed chrome.
 * Measured 2026-10-26 (Playwright, 1280 and 390 wide):
 *
 *   - Top: the sticky header is 60-70px tall and the page had no
 *     scroll-padding-top, so a table-of-contents link in five blog posts
 *     scrolled its target <h2> to top:0, entirely behind the header (22 of 26
 *     anchors tried). Shift+Tab up a page parks the focused control under it
 *     the same way. Fix: html{scroll-padding-top} in nbd-nav.css.
 *   - Bottom: on phones the fixed Book/Call/Text bar (.mobile-cta-strip, up to
 *     95px tall when the Book label wraps at 320-360 wide) covered the control
 *     a Tab press had just focused (WCAG 2.2 2.4.11 Focus Not Obscured).
 *     Fix: html:has(.mobile-cta-strip){scroll-padding-bottom} at <=768px.
 *
 * scroll-padding and scroll-margin ADD. .g-chapter (80px), .terms-section
 * (90px) and .cred-card (90px) had each carried a scroll-margin-top as their
 * own header compensation; with the global padding on top they landed 164-174px
 * down instead of 80-90. Those margins are gone, and this suite fails if one
 * comes back on a page that loads nbd-nav.css. (docs/pro/customer.html learned
 * the same lesson on 2026-09-25 and says so in its CSS.)
 *
 * The homepage keeps its bar CSS inline and does not link mobile-cta.css, while
 * /inspect links mobile-cta.css but not nbd-nav.css, so the bottom rule is
 * carried by BOTH stylesheets and the coverage group below proves every page
 * with a bar reaches one of them.
 *
 * The top rule is carried by TWO stylesheets, same property, same element, same
 * value, so they do not stack where a page loads both: nbd-nav.css (every site
 * page) and nbd-guide.css. /pro/playbook links nbd-guide.css but not nbd-nav.css
 * (its header is its own sticky .g-pro-head, 60-70px), so with .g-chapter's
 * scroll-margin-top gone and no padding there, every playbook chapter landed at
 * top 0 under that header. The "Coverage: top" group below fails for any page
 * that lost a scroll-margin and gets no padding from anywhere.
 *
 * Source-level only (geometry needs a browser); the rendered check is the
 * Playwright sweep described in the PR.
 *
 * Run: node tests/scroll-padding-2026-10-26.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const read = (abs) => fs.readFileSync(abs, 'utf8');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' -- ' + String(detail).slice(0, 400) : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

const decomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const compact = (css) => decomment(css).replace(/\s+/g, '');

function walk(dir, out) {
  out = out || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.html')) out.push(p);
  }
  return out;
}

/* Every stylesheet a page loads: its local <link rel=stylesheet> files plus
   its inline <style> blocks. */
function pageCss(file) {
  const html = read(file);
  const sheets = [];
  for (const m of html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)) {
    const href = (/href=["']([^"']+)["']/i.exec(m[0]) || [])[1];
    if (href && href.startsWith('/')) sheets.push(href.split(/[?#]/)[0]);
  }
  const inline = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  return { sheets, inline };
}
const sheetText = (href) => {
  const abs = path.join(DOCS, href);
  return fs.existsSync(abs) ? read(abs) : '';
};

/* Bar heights measured 2026-10-26: 59-95.3px depending on width and variant
   (the Book label wraps at 320-360). Header: 60-70px. */
const MIN_TOP = 72, MIN_BOTTOM = 96;

const navCss = compact(read(path.join(DOCS, 'assets/css/nbd-nav.css')));
const ctaCss = compact(read(path.join(DOCS, 'assets/css/mobile-cta.css')));

const BOTTOM_RULE = 'html:has(.mobile-cta-strip){scroll-padding-bottom:calc(';
const MEDIA = '@media(max-width:768px){';

/* Depth-0 rules of a compacted stylesheet (at-rules included, with their
   whole block as the body). */
function topLevelRules(css) {
  const rules = [];
  let depth = 0, start = 0, sel = '', bodyStart = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') { if (depth === 0) { sel = css.slice(start, i); bodyStart = i + 1; } depth++; }
    else if (css[i] === '}') { depth--; if (depth === 0) { rules.push({ sel, body: css.slice(bodyStart, i) }); start = i + 1; } }
  }
  return rules;
}

/* The bottom rule's pixel value, only if it sits inside a <=768px @media block
   (the bar is display:none above that, so the padding must not apply there). */
function bottomValue(css) {
  let from = 0;
  for (;;) {
    const at = css.indexOf(MEDIA, from);
    if (at < 0) return null;
    let depth = 0, end = at;
    for (let i = at + MEDIA.length - 1; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) { end = i; break; }
    }
    const block = css.slice(at, end + 1);
    const i = block.indexOf(BOTTOM_RULE);
    if (i > -1) {
      const m = /^(\d+)px\+env\(safe-area-inset-bottom,0px\)\);?\}/.exec(block.slice(i + BOTTOM_RULE.length));
      return m ? Number(m[1]) : null;
    }
    from = end + 1;
  }
}

/* The pixel value of a depth-0 `html{...scroll-padding-top:Npx...}` rule (not
   the #mobileNav one further down nbd-nav.css), or null. */
function topValue(css) {
  const rule = topLevelRules(css).find((r) => r.sel === 'html' && /scroll-padding-top:\d+px/.test(r.body));
  return rule ? Number(/scroll-padding-top:(\d+)px/.exec(rule.body)[1]) : null;
}
const guideCss = compact(read(path.join(DOCS, 'assets/css/nbd-guide.css')));

group('Top: nbd-nav.css clears the sticky header for anchors and focus', () => {
  const top = topValue(navCss);
  ok('a top-level html{scroll-padding-top:Npx} rule exists', top !== null);
  ok('...and N clears the tallest header (>= ' + MIN_TOP + 'px)', top !== null && top >= MIN_TOP, top);
  ok('...but leaves the heading visible (<= 120px)', top !== null && top <= 120, top);
});

group('Top: nbd-guide.css carries the same rule for /pro/playbook (it does not load nbd-nav.css)', () => {
  const g = topValue(guideCss);
  ok('a top-level html{scroll-padding-top:Npx} rule exists', g !== null);
  ok('...and it equals nbd-nav.css (same property, same element: no stacking, no drift)', g !== null && g === topValue(navCss), g + ' vs ' + topValue(navCss));
});

group('Bottom: the phone Book/Call/Text bar does not cover the focused control', () => {
  for (const [label, css] of [['mobile-cta.css', ctaCss], ['nbd-nav.css', navCss]]) {
    const v = bottomValue(css);
    ok(label + ' has the <=768px html:has(.mobile-cta-strip) scroll-padding-bottom rule', v !== null);
    ok('...with calc(Npx + env(safe-area-inset-bottom)) and N >= ' + MIN_BOTTOM + 'px (tallest bar 95.3px)', v !== null && v >= MIN_BOTTOM, v);
  }
  ok('both stylesheets carry the same value', bottomValue(ctaCss) === bottomValue(navCss));
});

const pages = walk(DOCS);

group('Coverage: every page with a Book/Call/Text bar loads a stylesheet that carries the bottom rule', () => {
  const carriers = new Set();
  if (bottomValue(ctaCss) !== null) carriers.add('/assets/css/mobile-cta.css');
  if (bottomValue(navCss) !== null) carriers.add('/assets/css/nbd-nav.css');
  const withBar = pages.filter((p) => /class=["'][^"']*\bmobile-cta-strip\b/.test(read(p)));
  ok('the scan found the bar pages (>= 250)', withBar.length >= 250, withBar.length);
  const uncovered = withBar.filter((p) => !pageCss(p).sheets.some((s) => carriers.has(s)));
  ok('no bar page is left without the rule', uncovered.length === 0,
    uncovered.length + ' uncovered, e.g. ' + uncovered.slice(0, 5).map(rel).join(', '));
});

group('Coverage: top: every page whose sheet lost a scroll-margin still gets the top padding', () => {
  /* Sheets whose own scroll-margin-top was removed because the padding replaces it. */
  const LOST = ['/assets/css/nbd-guide.css', '/assets/css/sms-program.css', '/assets/css/credentials.css'];
  const carriers = new Set();
  const inRange = (v) => v !== null && v >= MIN_TOP && v <= 120;
  if (inRange(topValue(navCss))) carriers.add('/assets/css/nbd-nav.css');
  if (inRange(topValue(guideCss))) carriers.add('/assets/css/nbd-guide.css');
  const affected = pages.filter((p) => pageCss(p).sheets.some((s) => LOST.includes(s)));
  ok('the scan found the affected pages (>= 10)', affected.length >= 10, affected.length);
  ok('the playbook is among them', affected.some((p) => rel(p) === 'docs/pro/playbook.html'));
  const bare = affected.filter((p) => {
    const { sheets, inline } = pageCss(p);
    return !sheets.some((s) => carriers.has(s)) && !inline.some((t) => inRange(topValue(compact(t))));
  });
  ok('no such page is left without a depth-0 html{scroll-padding-top} (chapters would land under the header)',
    bare.length === 0, bare.length + ' bare, e.g. ' + bare.slice(0, 5).map(rel).join(', '));
});

group('No stacking: a page that loads nbd-nav.css declares no scroll-margin-top of its own', () => {
  const withNav = pages.filter((p) => pageCss(p).sheets.includes('/assets/css/nbd-nav.css'));
  ok('the scan found the nav pages (>= 250)', withNav.length >= 250, withNav.length);
  const offenders = new Map();
  for (const p of withNav) {
    const { sheets, inline } = pageCss(p);
    const texts = sheets.map((s) => [s, sheetText(s)]).concat(inline.map((t) => [rel(p) + ' <style>', t]));
    for (const [name, t] of texts) {
      if (/scroll-margin(?:-top)?\s*:/.test(decomment(t))) (offenders.get(name) || offenders.set(name, []).get(name)).push(rel(p));
    }
  }
  ok('no loaded stylesheet adds scroll-margin on top of html{scroll-padding-top} (they add: 84 + 80 landed a guide chapter at 164px)',
    offenders.size === 0,
    [...offenders].map(([n, ps]) => n + ' (' + ps.length + ' pages, e.g. ' + ps[0] + ')').join('; '));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
